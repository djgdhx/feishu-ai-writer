/**
 * AI 对话总结写入飞书在线文档 — Cloudflare Worker
 * ============================================================
 * 方案一（推荐优先落地）的完整实现。
 *
 * 能力：
 *   1. create        —— 新建飞书文档，写入内容
 *   2. append        —— 追加内容到已有文档末尾
 *   3. replace       —— 清空已有文档，替换为新的内容
 *   4. delete        —— 删除指定文档
 *   5. read          —— 读取指定文档内容，返回 Markdown 正文
 *   6. search        —— 按名字/关键词搜索当前用户可见的云文档
 *   7. list          —— 列出云盘根目录或指定文件夹下的文件
 *   8. board_create  —— 在文档中插入画板，可选写入 Mermaid/PlantUML/SVG
 *   9. board_update  —— 更新已有画板内容
 *  10. board_read    —— 读取画板节点（也可列出文档内全部画板）
 *  11. insert_after  —— 在指定标题/段落/block 的下方插入，找不到锚点则拒绝，绝不改成文末追加或整篇覆盖
 *  12. delete_range  —— 删除指定段落，或从标题删到下一同级/更高级标题之前；找不到目标则拒绝，绝不整篇清空
 *   format     —— 可选（markdown 默认 | html）；html 时走飞书 content_type:'html'，
 *                 并做富内容增强：图片下载上传拿 token、表格列宽（colgroup）、
 *                 以及手写扩展块（callout 高亮框 / grid 分栏 / checkbox 待办 /
 *                 cite @人 @文档 / latex 公式 / source 附件 / bookmark 书签 / 文字装饰）。
 *                 说明：颜色枚举与部分富类型（图片 token、列宽、高亮框）当前按自洽映射，
 *                 具体整数值需在飞书真机校准（详见代码内注释）。
 *
 * 底层使用飞书官方服务端 Open API（与本地 CLI 相同）：
 *   - POST /open-apis/auth/v3/tenant_access_token/internal   获取 tenant_access_token
 *   - POST /open-apis/docx/v1/documents                      创建文档
 *   - POST /open-apis/docx/v1/documents/blocks/convert       Markdown 转文档块
 *   - POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children         创建嵌套块
 *   - DELETE /open-apis/docx/v1/documents/{id}/blocks/{id}/children/batch_delete 批量删除
 *
 * 部署：见同目录 README.md
 * 环境变量：
 *   FEISHU_APP_ID     必填，飞书自建应用 App ID
 *   FEISHU_APP_SECRET 必填，飞书自建应用 App Secret
 *   API_KEY           可选，设置后调用必须带 x-api-key 请求头，防止接口被滥用
 *   FEISHU_BASE_URL   可选，默认 https://open.feishu.cn（国际版可改为 https://open.larksuite.com）
 *   DOC_URL_PREFIX    可选，返回文档链接前缀，默认 https://feishu.cn/docx/
 * KV 绑定：
 *   FEISHU_USER_TOKEN 存储用户 OAuth 授权（user_access_token / refresh_token），必填
 *
 * 用户授权（可选但推荐）：
 *   - GET /auth/start    跳转飞书授权页
 *   - GET /auth/callback 授权回调，保存 token
 *   - GET /auth/status   查看授权状态
 *   授权后，create 创建的文档直接落在用户云盘根目录（而非应用空间）；
 *   append/replace 对用户自己的文档无需再分享给应用。
 */

// ==================== 常量 ====================

const FEISHU_DEFAULT_BASE = 'https://open.feishu.cn';

// 单次"创建嵌套块"接口最多 50 个块，超出需分批
const CREATE_CHILDREN_LIMIT = 50;

// 单次 Markdown 内容长度上限（字符）。飞书 convert 接口上限约 10 万字符，这里按 10 万设置；
// 超过时 AI 平台工具调用可能超时，建议超长内容分段 append
const MAX_CONTENT_LENGTH = 100000;

// Token 提前 5 分钟过期，避免边界失效
const TOKEN_EXPIRE_MARGIN_SECONDS = 300;

// 表格块类型（转换结果中的表格必须清理 merge_info 字段，否则写入报错）
const BLOCK_TYPE_TABLE = 31;

// ==================== CORS ====================

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  'Access-Control-Max-Age': '86400',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
  });
}

// ==================== 入口 ====================

export default {
  async fetch(request, env) {
    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      // 健康检查 / 使用说明
      if (request.method === 'GET' && url.pathname === '/') {
        return json({
          success: true,
          service: 'ai-feishu-writer',
          usage: 'POST /，JSON body: { action: create|append|replace|delete|read|search|list|board_create|board_update|board_read|insert_after|delete_range, ... }',
          read: 'action=read 时传 document_id 即可，接口返回该文档的 Markdown 正文（content 字段）',
          search: 'action=search 按名字/关键词查找文档（query）；action=list 列出云盘文件（folder_token 可空=根目录）',
          board: 'action=board_create / board_update / board_read 操作文档内画板（Mermaid/PlantUML/SVG）',
          precise: 'insert_after 插到锚点下方；delete_range 删除指定段/节。必须提供 after/target 或 block_id。找不到锚点不会改文档，也不会改成 append/replace',
          auth: 'GET /auth/status 查看授权，GET /auth/start 开始授权',
        });
      }

      // ---- OAuth 授权路由 ----
      if (request.method === 'GET' && url.pathname === '/auth/start') {
        const authUrl = buildAuthUrl(env, url);
        return Response.redirect(authUrl, 302);
      }
      if (request.method === 'GET' && url.pathname === '/auth/callback') {
        return await handleAuthCallback(env, url);
      }
      if (request.method === 'GET' && url.pathname === '/auth/status') {
        return json(await getAuthStatus(env));
      }
      if (request.method === 'GET' && url.pathname === '/auth/reset') {
        if (env.FEISHU_USER_TOKEN) {
          await env.FEISHU_USER_TOKEN.delete(KV_USER_TOKEN).catch(() => {});
        }
        return json({ success: true, message: '已清除授权，请重新访问 /auth/start 授权' });
      }

      // ---- 调试：返回文档原始块结构（要求 x-api-key）---- 已移除（安全收尾；图片能力已确认）
      if (request.method !== 'POST' || url.pathname !== '/') {
        return json({ success: false, message: 'Not found。调用方式：POST /' }, 404);
      }

      // 可选鉴权：设置了 API_KEY 后必须匹配
      if (env.API_KEY && request.headers.get('x-api-key') !== env.API_KEY) {
        return json({ success: false, message: 'x-api-key 无效' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ success: false, message: '请求体必须是合法 JSON' }, 400);
      }

      const result = await handleWrite(env, body || {});
      return json(result, result.success ? 200 : 400);
    } catch (err) {
      // 把飞书接口的原始错误码透出，方便排查（最常见：权限不足/文档未分享给应用）
      return json({ success: false, message: `服务异常：${err.message || err}` }, 500);
    }
  },
};

// ==================== 核心逻辑 ====================

const WRITE_ACTIONS = ['create', 'append', 'replace', 'delete', 'read'];
const DISCOVERY_ACTIONS = ['search', 'list'];
const BOARD_ACTIONS = ['board_create', 'board_update', 'board_read'];
const PRECISE_ACTIONS = ['insert_after', 'delete_range'];
const ALL_ACTIONS = [...WRITE_ACTIONS, ...DISCOVERY_ACTIONS, ...BOARD_ACTIONS, ...PRECISE_ACTIONS];

/**
 * 统一入口：校验参数 -> 执行 create / append / replace / delete / read / search / list / board_*
 */
async function handleWrite(env, body = {}) {
  let {
    action, content, title, document_id, format,
    query, folder_token, page_size, page_token, only_title, doc_types,
    recursive, whiteboard_id, overwrite, width, height, include_wiki,
    after, after_block_id, block_id, target, occurrence, mode,
  } = body;

  // ---- 参数校验 ----
  if (!ALL_ACTIONS.includes(action)) {
    return { success: false, message: `action 必须是 ${ALL_ACTIONS.join(' / ')} 之一` };
  }

  const isBoardAction = BOARD_ACTIONS.includes(action);
  const isDiscovery = DISCOVERY_ACTIONS.includes(action);

  // format：文档写入用 markdown/html；画板写入用 mermaid/plantuml/svg/raw
  if (format === undefined || format === null) {
    format = isBoardAction ? 'mermaid' : 'markdown';
  }
  if (!isBoardAction && !isDiscovery && format !== 'markdown' && format !== 'html') {
    return { success: false, message: 'format 必须是 markdown / html 之一' };
  }
  if (isBoardAction && action !== 'board_read') {
    const allowed = ['mermaid', 'plantuml', 'svg', 'raw'];
    if (!allowed.includes(format)) {
      return { success: false, message: `画板 format 必须是 ${allowed.join(' / ')} 之一` };
    }
  }

  const needsContent = action === 'create' || action === 'append' || action === 'replace' || action === 'board_update' || action === 'insert_after';
  if (needsContent && (typeof content !== 'string' || !content.trim())) {
    return { success: false, message: 'content 不能为空' };
  }
  if (content && content.length > MAX_CONTENT_LENGTH) {
    return {
      success: false,
      message: `content 过长（${content.length} 字符），上限 ${MAX_CONTENT_LENGTH} 字符，请精简内容后重试`,
    };
  }
  // document_id 支持直接传完整链接（如 https://xxx.feishu.cn/docx/Abc123?from=...），自动提取
  if (document_id) {
    document_id = extractDocumentId(document_id);
  }
  if (whiteboard_id) {
    whiteboard_id = extractWhiteboardId(whiteboard_id);
  }
  if ((action === 'append' || action === 'replace' || action === 'delete' || action === 'read' || action === 'insert_after' || action === 'delete_range') && !document_id) {
    return { success: false, message: `${action} 操作必须提供 document_id 或文档链接` };
  }
  if (action === 'board_update' && !whiteboard_id && !document_id) {
    return { success: false, message: 'board_update 必须提供 whiteboard_id，或提供 document_id 以便从文档中定位画板' };
  }
  if (action === 'board_read' && !whiteboard_id && !document_id) {
    return { success: false, message: 'board_read 必须提供 whiteboard_id 或 document_id' };
  }

  // ---- 身份选择：优先用户授权身份（文档落用户云盘），否则回退应用身份 ----
  // 注意：blocks/convert 接口在 user 身份下需要额外的用户授权权限（scope 常为空导致失败），
  // 因此 convert 统一用应用身份（tenant token，convert 权限已就绪）；
  // 创建/写入/删除文档用用户身份（文档落用户云盘、写用户自己的文档）。
  const userToken = await getValidUserAccessToken(env);
  const tenantToken = await getTenantAccessToken(env);
  const identity = userToken ? 'user' : 'tenant';
  const docToken = userToken || tenantToken; // 创建/写入用
  const convertToken = tenantToken;          // 转换用（应用身份）

  // ---- 搜索 / 列出文档 ----
  if (action === 'search') {
    return await handleSearch(env, docToken, userToken, {
      query, page_size, page_token, only_title, doc_types, include_wiki, folder_token, identity,
    });
  }
  if (action === 'list') {
    return await handleList(env, docToken, {
      folder_token, page_size, page_token, recursive, identity,
    });
  }

  // ---- 画板 ----
  if (action === 'board_read') {
    return await handleBoardRead(env, docToken, { whiteboard_id, document_id, identity });
  }
  if (action === 'board_create') {
    return await handleBoardCreate(env, docToken, {
      document_id, title, content, format, width, height, identity,
    });
  }
  if (action === 'board_update') {
    return await handleBoardUpdate(env, docToken, {
      whiteboard_id, document_id, content, format, overwrite, identity,
    });
  }

  // ---- 定点插入 / 定点删除（独立分支，不走 create/append/replace）----
  if (action === 'insert_after' || action === 'delete_range') {
    return await handlePreciseEdit(env, {
      action, content, document_id, format,
      after, after_block_id, block_id, target, occurrence, mode,
      docToken, convertToken, identity,
    });
  }

  // ---- 读取文档内容（仅 read：不写任何内容，返回 Markdown 正文）----
  if (action === 'read') {
    const doc = await readDocument(env, docToken, document_id);
    return {
      success: true,
      action,
      document_id,
      url: `${env.DOC_URL_PREFIX || 'https://feishu.cn/docx/'}${document_id}`,
      title: doc.title,
      content: doc.content,
      block_count: doc.block_count,
      identity,
      message: `已读取文档「${doc.title || document_id}」`,
    };
  }

  // ---- 删除文档（仅 delete，不需要转换内容）----
  if (action === 'delete') {
    await deleteDocument(env, docToken, document_id);
    return {
      success: true,
      action,
      document_id,
      url: `${env.DOC_URL_PREFIX || 'https://feishu.cn/docx/'}${document_id}`,
      identity,
      message: `已删除文档「${document_id}」`,
    };
  }

  // ---- 内容转文档块（markdown / html 通过 convertContent 统一处理；merge_info 已清理）----
  const { blocks, firstLevelIds } = await convertContent(env, convertToken, content, format);

  // ---- HTML 富内容增强：图片 token / 表格列宽 / 手写扩展块 ----
  if (format === 'html') {
    await enrichHtmlBlocks(env, docToken, blocks, content);
  }

  // ---- 新建文档（仅 create）----
  let documentId = document_id;
  if (action === 'create') {
    const doc = await createDocument(env, docToken, title);
    documentId = doc.document_id;
  }

  // ---- 替换前先清空全文 ----
  if (action === 'replace') {
    await clearDocument(env, docToken, documentId);
  }

  // ---- 写入内容（append 会追加到文档末尾）----
  if (blocks.length > 0) {
    await insertBlocks(env, docToken, documentId, blocks, firstLevelIds);
    // 图片：飞书正确时序 = 先建 image 块 → 上传素材（parent_node=真实块id）→ replace_image 设 token。
    // 必须放在 insertBlocks 之后，否则 parent_node 指向的块还不存在，上传失败。
    if (format === 'html') {
      await hydrateAndPatchImages(env, docToken, documentId, blocks, content);
    }
  }

  // 飞书新版 docx API 不返回 url 字段，这里统一拼接文档链接
  const url = `${env.DOC_URL_PREFIX || 'https://feishu.cn/docx/'}${documentId}`;

  const actionText = action === 'create' ? '已创建并写入' : action === 'append' ? '已追加到' : '已替换';
  return {
    success: true,
    action,
    document_id: documentId,
    url,
    block_count: blocks.length,
    identity,
    message: `${actionText}文档「${title || documentId}」`,
  };
}

// ==================== 飞书 API 封装 ====================

/**
 * 统一的飞书 Open API 请求封装；code !== 0 时抛出带错误码的异常
 */
async function feishuFetch(env, path, { method = 'GET', body, token } = {}) {
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));

  if (data.code !== 0) {
    throw new Error(`飞书接口失败 ${method} ${path}：code=${data.code} msg=${data.msg}`);
  }
  return data;
}

/**
 * ==================== 用户 OAuth 授权（方案 A：文档落用户云盘）====================
 */

// KV 键名
const KV_USER_TOKEN = 'user_token';

// 授权时请求的用户权限（scope 空格分隔；offline_access 用于获取 refresh_token）
const OAUTH_SCOPES = [
  'offline_access',                       // 刷新 token 必需
  'docx:document',                        // 创建及编辑新版文档
  'docx:document:create',                 // 创建新版文档
  'docx:document:write_only',             // 编辑新版文档
  'docx:document.block:convert',          // 转换文本为云文档块
  'drive:drive',                          // 云空间全管理
  'drive:file:upload',                    // 上传文件
  'search:docs:read',                     // 按名字/关键词搜索云文档
  'board:whiteboard:node:read',           // 查看画板节点
  'board:whiteboard:node:create',         // 创建画板节点
  'board:whiteboard:node:update',         // 更新画板节点
  'board:whiteboard:node:delete',         // 删除画板节点（覆盖写入前清空）
].join(' ');

/**
 * 构建飞书 OAuth 授权页 URL
 * 注意：回调地址必须与开放平台「安全设置-重定向 URL」配置一致
 */
function buildAuthUrl(env, requestUrl) {
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const redirectUri = `${requestUrl.origin}/auth/callback`;
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const params = new URLSearchParams({
    app_id: env.FEISHU_APP_ID,
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES,
    state,
  });
  return `${base}/open-apis/authen/v1/authorize?${params.toString()}`;
}

/**
 * 授权回调：用 code 换 user_access_token，存入 KV
 */
async function handleAuthCallback(env, requestUrl) {
  const code = requestUrl.searchParams.get('code');
  if (!code) {
    // 诊断模式：把收到的所有参数和错误信息展示出来
    const params = {};
    requestUrl.searchParams.forEach((v, k) => { params[k] = v; });
    const err = requestUrl.searchParams.get('error') || requestUrl.searchParams.get('error_description') || '无';
    return htmlResponse(
      `⚠️ 授权未完成（未收到 code 参数）<br><br>
       <b>收到的参数：</b><pre style="text-align:left">${JSON.stringify(params, null, 2)}</pre>
       <b>错误信息：</b>${err}<br><br>
       可能原因：<br>
       1. 重定向 URL 配置与请求不一致（检查末尾斜杠）<br>
       2. 授权被取消或超时<br><br>
       <a href="${requestUrl.origin}/auth/start">重新授权</a>`,
      400
    );
  }
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const redirectUri = `${requestUrl.origin}/auth/callback`;

  // 飞书 oidc/access_token 接口要求：请求头带 app_access_token，请求体仅 grant_type + code
  const appToken = await getAppAccessToken(env);

  // 用 code 换取 user_access_token（飞书 OIDC 标准流程）
  const resp = await fetch(`${base}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data.code !== 0 || !data.data || !data.data.access_token) {
    return htmlResponse(`授权失败：code=${data.code} msg=${data.msg}`, 400);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const tokenInfo = {
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token,
    expires_at: nowSec + (data.data.expires_in || 7200),
    refresh_expires_at: nowSec + (data.data.refresh_token_expires_in || 2592000),
    scope: data.data.scope || '',
  };
  if (env.FEISHU_USER_TOKEN) {
    await env.FEISHU_USER_TOKEN.put(KV_USER_TOKEN, JSON.stringify(tokenInfo)).catch(() => {});
  }

  return htmlResponse(
    `✅ 授权成功！<br>现在 AI 创建的新文档会直接保存到你的飞书云盘根目录。<br><br><a href="${requestUrl.origin}/">返回首页</a>`,
    200
  );
}

/**
 * 获取有效的 user_access_token；过期时自动用 refresh_token 刷新
 * 未授权或刷新失败时返回 null（调用方回退应用身份）
 */
async function getValidUserAccessToken(env) {
  if (!env.FEISHU_USER_TOKEN) return null;
  const raw = await env.FEISHU_USER_TOKEN.get(KV_USER_TOKEN, 'json').catch(() => null);
  if (!raw || !raw.access_token) return null;

  const nowSec = Math.floor(Date.now() / 1000);

  // 有效期内直接返回
  if (raw.expires_at > nowSec + TOKEN_EXPIRE_MARGIN_SECONDS) {
    return raw.access_token;
  }

  // refresh_token 过期 → 需要重新授权
  if (!raw.refresh_token || raw.refresh_expires_at <= nowSec) {
    return null;
  }

  // 刷新（同样需要请求头带 app_access_token）
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const appToken = await getAppAccessToken(env);
  const resp = await fetch(`${base}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: raw.refresh_token,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data.code !== 0 || !data.data || !data.data.access_token) {
    return null; // 刷新失败，需要重新授权
  }

  const refreshed = {
    ...raw,
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token || raw.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.data.expires_in || 7200),
  };
  await env.FEISHU_USER_TOKEN.put(KV_USER_TOKEN, JSON.stringify(refreshed)).catch(() => {});
  return refreshed.access_token;
}

/**
 * 查询授权状态
 */
async function getAuthStatus(env) {
  if (!env.FEISHU_USER_TOKEN) {
    return { success: true, authorized: false, reason: '未配置 KV 绑定 FEISHU_USER_TOKEN' };
  }
  const raw = await env.FEISHU_USER_TOKEN.get(KV_USER_TOKEN, 'json').catch(() => null);
  if (!raw || !raw.access_token) {
    return { success: true, authorized: false, reason: '尚未授权' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const valid = raw.expires_at > nowSec;
  const scopes = raw.scope ? raw.scope.split(' ') : [];
  return {
    success: true,
    authorized: true,
    token_valid: valid,
    token_expires_at: new Date(raw.expires_at * 1000).toISOString(),
    refresh_expires_at: new Date((raw.refresh_expires_at || 0) * 1000).toISOString(),
    has_convert_scope: scopes.includes('docx:document.block:convert'),
    has_docx_scope: scopes.includes('docx:document') || scopes.includes('docx:document:create') || scopes.includes('docx:document:write_only'),
    has_search_scope: scopes.includes('search:docs:read') || scopes.includes('drive:drive'),
    has_board_scope: scopes.includes('board:whiteboard:node:read') || scopes.includes('board:whiteboard:node:create'),
    scope_count: scopes.length,
    scope_preview: scopes.slice(0, 30).join(' '),
    hint: valid ? '身份有效' : 'access_token 已过期，将在下次写入时自动刷新',
  };
}

function htmlResponse(content, status = 200) {
  return new Response(
    `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>AI 飞书写入</title></head>
     <body style="font-family:sans-serif;max-width:600px;margin:60px auto;text-align:center;line-height:1.8">${content}</body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

/**
 * 获取 tenant_access_token（带缓存与自动刷新）
 * 优先使用 KV 实现跨实例共享；无 KV 时退回进程内缓存（单实例场景足够）
 */
async function getTenantAccessToken(env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('缺少环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，请先通过 wrangler secret put 配置');
  }
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) KV 缓存（可选绑定）
  if (env.FEISHU_TOKEN_KV) {
    const cached = await env.FEISHU_TOKEN_KV.get('tenant_access_token', 'json').catch(() => null);
    if (cached && cached.expiresAt > nowSec + TOKEN_EXPIRE_MARGIN_SECONDS) {
      return cached.token;
    }
    const fresh = await requestToken(env);
    await env.FEISHU_TOKEN_KV
      .put('tenant_access_token', JSON.stringify({ token: fresh.token, expiresAt: fresh.expiresAt }), {
        expirationTtl: fresh.expire - TOKEN_EXPIRE_MARGIN_SECONDS,
      })
      .catch(() => {});
    return fresh.token;
  }

  // 2) 进程内缓存
  if (globalThis.__fsToken && globalThis.__fsToken.expiresAt > nowSec + TOKEN_EXPIRE_MARGIN_SECONDS) {
    return globalThis.__fsToken.token;
  }
  const fresh = await requestToken(env);
  globalThis.__fsToken = { token: fresh.token, expiresAt: fresh.expiresAt };
  return fresh.token;
}

async function requestToken(env) {
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：code=${data.code} msg=${data.msg}`);
  }
  return {
    token: data.tenant_access_token,
    expire: data.expire || 7200,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expire || 7200),
  };
}

/**
 * 获取 app_access_token（OAuth 换 user token 时，请求头需要用 app_access_token）
 * app_access_token 与 tenant_access_token 都是应用身份，但 OIDC 接口要求 app_access_token
 */
let __appTokenCache = null;
async function getAppAccessToken(env) {
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    throw new Error('缺少环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (__appTokenCache && __appTokenCache.expiresAt > nowSec + TOKEN_EXPIRE_MARGIN_SECONDS) {
    return __appTokenCache.token;
  }
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;
  const resp = await fetch(`${base}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data.code !== 0 || !data.app_access_token) {
    throw new Error(`获取 app_access_token 失败：code=${data.code} msg=${data.msg}`);
  }
  __appTokenCache = {
    token: data.app_access_token,
    expiresAt: nowSec + (data.expire || 7200),
  };
  return __appTokenCache.token;
}

/**
 * 创建飞书文档（用用户身份创建时，文档落在用户云盘）
 */
async function createDocument(env, token, title) {
  const data = await feishuFetch(env, '/open-apis/docx/v1/documents', {
    method: 'POST',
    body: { title: title || 'AI 对话总结' },
    token,
  });
  return data.data.document; // { document_id, revision_id, title, url }
}

/**
 * 删除飞书文档（用用户身份删除时，可删用户云盘里的文档）
 */
async function deleteDocument(env, token, documentId) {
  await feishuFetch(env, `/open-apis/drive/v1/files/${documentId}?type=docx`, {
    method: 'DELETE',
    token,
  });
}

// ==================== 搜索 / 列出文档 ====================

const DEFAULT_SEARCH_DOC_TYPES = ['DOC', 'DOCX', 'SHEET', 'BITABLE', 'FILE', 'MINDNOTE', 'SLIDES', 'FOLDER'];

function queryString(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

function clipQuery(q) {
  return Array.from(String(q || '')).slice(0, 30).join('');
}

function stripHighlight(s) {
  return String(s || '').replace(/<\/?hb?>/gi, '').trim();
}

function parseDocTypes(docTypes) {
  if (!docTypes) return DEFAULT_SEARCH_DOC_TYPES.slice();
  const raw = Array.isArray(docTypes) ? docTypes : String(docTypes).split(/[,，\s]+/);
  const mapped = raw
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) => {
      const lower = t.toLowerCase();
      const table = {
        doc: 'DOC', docx: 'DOCX', sheet: 'SHEET', bitable: 'BITABLE', base: 'BITABLE',
        mindnote: 'MINDNOTE', file: 'FILE', wiki: 'WIKI', folder: 'FOLDER',
        catalog: 'CATALOG', slides: 'SLIDES', shortcut: 'SHORTCUT',
      };
      return table[lower] || t.toUpperCase();
    });
  return mapped.length ? mapped : DEFAULT_SEARCH_DOC_TYPES.slice();
}

function guessDocUrl(token, type) {
  if (!token) return '';
  const t = String(type || '').toLowerCase();
  if (t === 'docx' || t === 'doc') return `https://feishu.cn/docx/${token}`;
  if (t === 'sheet') return `https://feishu.cn/sheets/${token}`;
  if (t === 'bitable' || t === 'base') return `https://feishu.cn/base/${token}`;
  if (t === 'wiki' || t === 'catalog') return `https://feishu.cn/wiki/${token}`;
  if (t === 'folder') return `https://feishu.cn/drive/folder/${token}`;
  if (t === 'slides') return `https://feishu.cn/slides/${token}`;
  return `https://feishu.cn/docx/${token}`;
}

function normalizeSearchItem(item) {
  const meta = item.result_meta || {};
  const token = meta.token || item.docs_token || item.token || '';
  const type = meta.doc_types || meta.file_type || item.docs_type || item.entity_type || '';
  const title = stripHighlight(item.title_highlighted || item.title || '');
  const url = meta.url || item.url || guessDocUrl(token, type);
  return {
    title,
    type: String(type || '').toLowerCase(),
    token,
    url,
    owner_name: meta.owner_name || '',
    owner_id: meta.owner_id || item.owner_id || '',
    summary: stripHighlight(item.summary_highlighted || ''),
    update_time: meta.update_time || 0,
    create_time: meta.create_time || 0,
  };
}

async function searchV2Once(env, token, { query, pageSize, pageToken, onlyTitle, docTypes, folderToken, wiki }) {
  const filter = {
    doc_types: docTypes,
    only_title: !!onlyTitle,
  };
  const body = {
    query: query || '',
    page_size: pageSize,
  };
  if (pageToken) body.page_token = pageToken;
  if (wiki) {
    body.wiki_filter = filter;
  } else {
    if (folderToken) filter.folder_tokens = [folderToken];
    body.doc_filter = filter;
  }
  const data = await feishuFetch(env, '/open-apis/search/v2/doc_wiki/search', {
    method: 'POST',
    body,
    token,
  });
  const units = data.data?.res_units || data.data?.results || [];
  return {
    items: units.map(normalizeSearchItem).filter((it) => it.token || it.url),
    has_more: !!data.data?.has_more,
    page_token: data.data?.page_token || '',
    total: data.data?.total,
  };
}

async function searchSuiteFallback(env, token, { query, pageSize }) {
  const data = await feishuFetch(env, '/open-apis/suite/docs-api/search/object', {
    method: 'POST',
    body: {
      search_key: query || '',
      count: Math.min(50, pageSize || 20),
      offset: 0,
      docs_types: ['doc', 'sheet', 'bitable', 'mindnote', 'file', 'slides'],
    },
    token,
  });
  const entities = data.data?.docs_entities || [];
  return {
    items: entities.map((e) => ({
      title: e.title || '',
      type: e.docs_type || '',
      token: e.docs_token || '',
      url: guessDocUrl(e.docs_token, e.docs_type),
      owner_name: '',
      owner_id: e.owner_id || '',
      summary: '',
      update_time: 0,
      create_time: 0,
    })),
    has_more: !!data.data?.has_more,
    page_token: '',
    total: data.data?.total,
    source: 'suite_search',
  };
}

async function handleSearch(env, docToken, userToken, opts) {
  const query = clipQuery(opts.query);
  const pageSize = Math.max(1, Math.min(20, Number(opts.page_size) || 15));
  const pageToken = opts.page_token || '';
  const onlyTitle = opts.only_title === undefined ? true : !!opts.only_title;
  const docTypes = parseDocTypes(opts.doc_types);
  const includeWiki = opts.folder_token ? false : (opts.include_wiki === undefined ? true : !!opts.include_wiki);
  const token = userToken || docToken;
  const identity = opts.identity;

  const merged = [];
  const seen = new Set();
  let hasMore = false;
  let nextToken = '';
  let total;
  let usedFallback = false;
  let v2Error = '';

  const pushAll = (items) => {
    for (const it of items) {
      const key = it.token || it.url || it.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(it);
    }
  };

  try {
    const docHit = await searchV2Once(env, token, {
      query, pageSize, pageToken, onlyTitle, docTypes,
      folderToken: opts.folder_token || '',
      wiki: false,
    });
    pushAll(docHit.items);
    hasMore = docHit.has_more;
    nextToken = docHit.page_token;
    total = docHit.total;
    if (includeWiki && !opts.folder_token && !pageToken) {
      try {
        const wikiHit = await searchV2Once(env, token, {
          query, pageSize, onlyTitle, docTypes, wiki: true,
        });
        pushAll(wikiHit.items);
      } catch {
        // wiki 过滤器失败不阻断云空间结果
      }
    }
  } catch (err) {
    v2Error = err.message || String(err);
    if (userToken) {
      const fb = await searchSuiteFallback(env, userToken, { query, pageSize });
      pushAll(fb.items);
      hasMore = fb.has_more;
      total = fb.total;
      usedFallback = true;
    } else {
      throw err;
    }
  }

  return {
    success: true,
    action: 'search',
    query,
    count: merged.length,
    has_more: hasMore,
    page_token: nextToken,
    total,
    items: merged,
    identity,
    fallback: usedFallback || undefined,
    warning: usedFallback ? `search v2 失败，已回退旧搜索接口：${v2Error}` : undefined,
    message: merged.length
      ? `找到 ${merged.length} 条与「${query || '全部'}」相关的文档`
      : `没有找到与「${query || '全部'}」匹配的文档`,
  };
}

async function handleList(env, token, opts) {
  const pageSize = Math.max(1, Math.min(200, Number(opts.page_size) || 50));
  const recursive = !!opts.recursive;
  const startFolder = opts.folder_token || '';
  const files = [];
  const queue = [{ folder_token: startFolder, depth: 0, path: '', page_token: opts.page_token || '' }];
  const MAX_CALLS = recursive ? 8 : 1;
  const MAX_ITEMS = recursive ? 200 : pageSize;
  const MAX_DEPTH = 3;
  let calls = 0;
  let hasMore = false;
  let nextPageToken = '';

  while (queue.length && files.length < MAX_ITEMS && calls < MAX_CALLS) {
    const cur = queue.shift();
    let pageToken = cur.page_token || '';
    do {
      calls += 1;
      const params = { page_size: recursive ? 200 : pageSize };
      if (cur.folder_token) params.folder_token = cur.folder_token;
      if (pageToken) params.page_token = pageToken;
      const data = await feishuFetch(env, `/open-apis/drive/v1/files${queryString(params)}`, { token });
      const items = data.data?.files || [];
      for (const f of items) {
        const path = cur.path ? `${cur.path}/${f.name}` : (f.name || '');
        files.push({
          name: f.name || '',
          token: f.token || '',
          type: f.type || '',
          url: f.url || guessDocUrl(f.token, f.type),
          parent_token: f.parent_token || cur.folder_token || '',
          path,
        });
        if (recursive && f.type === 'folder' && cur.depth < MAX_DEPTH && files.length < MAX_ITEMS) {
          queue.push({ folder_token: f.token, depth: cur.depth + 1, path, page_token: '' });
        }
        if (files.length >= MAX_ITEMS) break;
      }
      hasMore = !!data.data?.has_more;
      pageToken = data.data?.next_page_token || '';
      if (!recursive) {
        nextPageToken = pageToken;
        break;
      }
    } while (pageToken && files.length < MAX_ITEMS && calls < MAX_CALLS);
  }

  const truncated = queue.length > 0 || (recursive && files.length >= MAX_ITEMS);
  return {
    success: true,
    action: 'list',
    folder_token: startFolder || '(root)',
    count: files.length,
    has_more: hasMore || truncated,
    page_token: nextPageToken,
    truncated: truncated || undefined,
    items: files,
    identity: opts.identity,
    message: startFolder
      ? `已列出文件夹下 ${files.length} 项`
      : `已列出云盘根目录 ${files.length} 项`,
  };
}

// ==================== 画板 ====================

const BOARD_BLOCK_TYPES = new Set([26, 43]);

function extractWhiteboardId(input) {
  if (typeof input !== 'string') return input || '';
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(/\/(?:whiteboard|board|wiki|docx)\/([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
    const last = trimmed.split('/').filter(Boolean).pop();
    return last ? last.split(/[?#]/)[0] : trimmed;
  }
  return trimmed.split(/[?#]/)[0];
}

function boardTokenFromBlock(block) {
  if (!block) return '';
  return block.board?.token || block.token || block.board?.id || '';
}

async function listDocumentBoards(env, token, documentId) {
  const boards = [];
  let pageToken = '';
  do {
    const query = pageToken
      ? `?page_size=500&page_token=${encodeURIComponent(pageToken)}`
      : '?page_size=500';
    const data = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks${query}`, { token });
    for (const b of data.data.items || []) {
      if (!BOARD_BLOCK_TYPES.has(b.block_type)) continue;
      const wb = boardTokenFromBlock(b);
      if (!wb) continue;
      boards.push({
        block_id: b.block_id,
        block_type: b.block_type,
        whiteboard_id: wb,
        width: b.board?.width,
        height: b.board?.height,
      });
    }
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);
  return boards;
}

async function resolveWhiteboardId(env, token, { whiteboard_id, document_id }) {
  if (whiteboard_id) return { whiteboard_id, boards: null };
  const boards = await listDocumentBoards(env, token, document_id);
  if (boards.length === 0) {
    return { error: { success: false, message: `文档 ${document_id} 中没有画板。可用 board_create 先插入一张` } };
  }
  if (boards.length > 1) {
    return {
      error: {
        success: false,
        message: `文档中有 ${boards.length} 张画板，请指定 whiteboard_id`,
        boards,
      },
    };
  }
  return { whiteboard_id: boards[0].whiteboard_id, boards };
}

async function getBoardNodes(env, token, whiteboardId) {
  const data = await feishuFetch(env, `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes`, { token });
  return data.data?.nodes || [];
}

async function clearBoardNodes(env, token, whiteboardId, nodes) {
  if (!nodes || !nodes.length) return false;
  const idSet = new Set(nodes.map((n) => n.id).filter(Boolean));
  const top = nodes
    .filter((n) => n.id && (!n.parent_id || !idSet.has(n.parent_id) || n.parent_id === n.id))
    .map((n) => n.id);
  const ids = top.length ? top : [...idSet];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await feishuFetch(env, `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes/batch_delete`, {
      method: 'DELETE',
      body: { ids: chunk },
      token,
    });
  }
  return true;
}

function parseSvgSize(svg, fallbackW = 800, fallbackH = 450) {
  const text = String(svg || '');
  const vb = text.match(/viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) return { width: Number(vb[1]) || fallbackW, height: Number(vb[2]) || fallbackH };
  const w = text.match(/\bwidth\s*=\s*["']?([\d.]+)/i);
  const h = text.match(/\bheight\s*=\s*["']?([\d.]+)/i);
  return {
    width: w ? Number(w[1]) : fallbackW,
    height: h ? Number(h[1]) : fallbackH,
  };
}

async function writeBoardContent(env, token, whiteboardId, { format, content, overwrite }) {
  let cleared = false;
  if (overwrite !== false) {
    try {
      const nodes = await getBoardNodes(env, token, whiteboardId);
      cleared = await clearBoardNodes(env, token, whiteboardId, nodes);
    } catch {
      cleared = false;
    }
  }

  if (format === 'mermaid' || format === 'plantuml') {
    const data = await feishuFetch(env, `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes/plantuml`, {
      method: 'POST',
      body: {
        plant_uml_code: content,
        style_type: 1,
        syntax_type: format === 'mermaid' ? 2 : 1,
        diagram_type: 0,
      },
      token,
    });
    return { node_id: data.data?.node_id, cleared };
  }

  if (format === 'svg') {
    const size = parseSvgSize(content);
    const data = await feishuFetch(env, `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes`, {
      method: 'POST',
      body: {
        nodes: [{
          type: 'svg',
          x: 0,
          y: 0,
          width: size.width,
          height: size.height,
          svg: { svg_code: content },
        }],
      },
      token,
    });
    return { ids: data.data?.ids || [], cleared };
  }

  if (format === 'raw') {
    let parsed;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {
      throw new Error('raw 格式的 content 必须是合法 JSON（节点数组或 {nodes: [...]}）');
    }
    const nodes = Array.isArray(parsed) ? parsed : parsed.nodes;
    if (!Array.isArray(nodes) || !nodes.length) {
      throw new Error('raw 格式需要非空的 nodes 数组');
    }
    const data = await feishuFetch(env, `/open-apis/board/v1/whiteboards/${whiteboardId}/nodes`, {
      method: 'POST',
      body: { nodes },
      token,
    });
    return { ids: data.data?.ids || [], cleared };
  }

  throw new Error(`不支持的画板 format：${format}`);
}

async function insertBoardBlock(env, token, documentId, width, height) {
  const data = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`, {
    method: 'POST',
    body: {
      children: [{
        block_type: 43,
        board: {
          align: 2,
          width: Number(width) || 800,
          height: Number(height) || 450,
        },
      }],
    },
    token,
  });
  const created = (data.data?.children || [])[0] || {};
  const whiteboardId = boardTokenFromBlock(created);
  return { block: created, whiteboard_id: whiteboardId, document_revision_id: data.data?.document_revision_id };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleBoardCreate(env, token, opts) {
  let documentId = opts.document_id;
  let createdDoc = false;
  if (!documentId) {
    const doc = await createDocument(env, token, opts.title || '画板');
    documentId = doc.document_id;
    createdDoc = true;
  }
  const inserted = await insertBoardBlock(env, token, documentId, opts.width, opts.height);
  if (!inserted.whiteboard_id) {
    return {
      success: false,
      message: '已插入画板块，但未返回 whiteboard_id。请稍后用 board_read + document_id 查看',
      document_id: documentId,
      url: `https://feishu.cn/docx/${documentId}`,
      identity: opts.identity,
    };
  }

  let writeResult = null;
  if (opts.content && String(opts.content).trim()) {
    await sleep(400);
    try {
      writeResult = await writeBoardContent(env, token, inserted.whiteboard_id, {
        format: opts.format || 'mermaid',
        content: opts.content,
        overwrite: false,
      });
    } catch (err) {
      await sleep(600);
      writeResult = await writeBoardContent(env, token, inserted.whiteboard_id, {
        format: opts.format || 'mermaid',
        content: opts.content,
        overwrite: false,
      }).catch((e2) => ({ error: e2.message || String(e2) }));
    }
  }

  const url = `https://feishu.cn/docx/${documentId}`;
  const failed = writeResult && writeResult.error;
  return {
    success: !failed,
    action: 'board_create',
    document_id: documentId,
    whiteboard_id: inserted.whiteboard_id,
    url,
    created_document: createdDoc || undefined,
    node_id: writeResult?.node_id,
    identity: opts.identity,
    message: failed
      ? `已在文档中创建空白画板，但写入内容失败：${failed}`
      : (opts.content ? '已创建画板并写入内容' : '已创建空白画板'),
  };
}

async function handleBoardUpdate(env, token, opts) {
  const resolved = await resolveWhiteboardId(env, token, opts);
  if (resolved.error) return resolved.error;
  const result = await writeBoardContent(env, token, resolved.whiteboard_id, {
    format: opts.format || 'mermaid',
    content: opts.content,
    overwrite: opts.overwrite,
  });
  return {
    success: true,
    action: 'board_update',
    whiteboard_id: resolved.whiteboard_id,
    document_id: opts.document_id || undefined,
    node_id: result.node_id,
    ids: result.ids,
    overwritten: result.cleared || undefined,
    identity: opts.identity,
    message: `已更新画板${result.cleared ? '（已覆盖原内容）' : ''}`,
  };
}

async function handleBoardRead(env, token, opts) {
  if (!opts.whiteboard_id && opts.document_id) {
    const boards = await listDocumentBoards(env, token, opts.document_id);
    if (boards.length === 0) {
      return {
        success: true,
        action: 'board_read',
        document_id: opts.document_id,
        boards: [],
        count: 0,
        identity: opts.identity,
        message: '该文档中没有画板',
      };
    }
    if (boards.length > 1 && !opts.whiteboard_id) {
      return {
        success: true,
        action: 'board_read',
        document_id: opts.document_id,
        boards,
        count: boards.length,
        identity: opts.identity,
        message: `文档中有 ${boards.length} 张画板，指定 whiteboard_id 可读取某一张的节点`,
      };
    }
    opts.whiteboard_id = boards[0].whiteboard_id;
  }
  const nodes = await getBoardNodes(env, token, opts.whiteboard_id);
  return {
    success: true,
    action: 'board_read',
    whiteboard_id: opts.whiteboard_id,
    document_id: opts.document_id || undefined,
    node_count: nodes.length,
    nodes,
    identity: opts.identity,
    message: `已读取画板，共 ${nodes.length} 个节点`,
  };
}

/**
 * 内容转文档块（markdown / html 统一入口）
 * - format === 'html' 时调用飞书 blocks/convert 且 content_type: 'html'，否则 'markdown'
 * - 转换结果中的表格块带 merge_info 字段，直接写入会报错，这里递归清理
 * - HTML 的富内容扩展块（callout/grid/checkbox/cite/latex/source/bookmark）convert 不支持，
 *   由 preprocessHtmlExtensions / injectExtensionBlocks 在调用方完成后处理
 */
async function convertContent(env, token, content, format) {
  const isHtml = format === 'html';
  // HTML 富内容：先把 convert 不支持的扩展块（callout/grid/checkbox/bookmark/source）顶格成占位符，
  // 转换后再按占位符位置替换回真实块。
  let htmlToConvert = content;
  let extensionBlocks = [];
  if (isHtml) {
    const pre = preprocessHtmlExtensions(content, format);
    htmlToConvert = pre.html;
    extensionBlocks = pre.extensionBlocks;
  }
  const data = await feishuFetch(env, '/open-apis/docx/v1/documents/blocks/convert', {
    method: 'POST',
    body: { content_type: isHtml ? 'html' : 'markdown', content: htmlToConvert },
    token,
  });
  let blocks = data.data.blocks || [];
  stripMergeInfo(blocks);
  blocks = sanitizeBlocks(blocks);
  // first_level_block_ids：一级块的文档顺序（blocks 数组本身无序！必须用它定序）
  let firstLevelIds = data.data.first_level_block_ids || [];
  if (isHtml && extensionBlocks.length) {
    const injected = injectExtensionBlocks(blocks, firstLevelIds, extensionBlocks);
    blocks = injected.blocks;
    firstLevelIds = injected.firstLevelIds;
  }
  return { blocks, firstLevelIds };
}

/**
 * 兼容入口：等价于 convertContent(...,'markdown')。保持既有调用不受影响。
 */
async function convertMarkdown(env, token, content) {
  return convertContent(env, token, content, 'markdown');
}

// ==================== HTML 富内容增强 ====================

// 块类型常量（与飞书 docx 官方约定一致）
const BLOCK_TYPE_TEXT = 2;
const BLOCK_TYPE_HEADING_BASE = 3;   // h1=3 ... h9=11
const BLOCK_TYPE_BULLET = 12;
const BLOCK_TYPE_ORDERED = 13;
const BLOCK_TYPE_CODE = 14;
const BLOCK_TYPE_QUOTE = 15;
const BLOCK_TYPE_TODO = 17; // 飞书 todo（待办）真实块类型为 17（16 是其它）；lark-cli 抓取确认
const BLOCK_TYPE_CALLOUT = 19;
// BLOCK_TYPE_DIVIDER=22 / BLOCK_TYPE_TABLE_CELL=32 已在下方 read 区块声明，此处不重复
const BLOCK_TYPE_ATTACH = 23;        // 附件/文件
const BLOCK_TYPE_IMAGE = 24;
const BLOCK_TYPE_GRID = 25;          // 分栏容器（官方 block_type 25）
const BLOCK_TYPE_GRID_COLUMN = 26;   // 分栏子块（官方 block_type 26）
const BLOCK_TYPE_BOOKMARK = 27;

// 占位符标记：用于把 convert 不支持的扩展块先"顶格"放进 HTML，转换后再替换回真实块。
// 选 ASCII 模板语法样，避免与正文冲突，且不易被 convert 改写。
const EXT_PLACEHOLDER_PREFIX = '[[EXT_';
const EXT_PLACEHOLDER_SUFFIX = ']]';

// ---------- 颜色映射（⚠️ 需真机校准）----------
// 飞书 docx 的 text_element_style.text_color / background_color 以及 callout 的
// background_color / border_color / text_color 均为 int 枚举。飞书约定：
//   文本色（text_color）基础 7 色；背景色（background_color）另有 light-* / medium-gray / light-gray。
// 本表按"基础色 = 1..7、light-* = 8..13、medium-gray = 14、light-gray = 15"的自洽顺序映射；
// ⚠️ 各色具体整数值以真机实测为准（此为先验假设，可能需校准后再发）。
const TEXT_COLOR_MAP = {
  red: 1, orange: 2, yellow: 3, green: 4, blue: 5, purple: 6,
  grey: 7, gray: 7, black: 7, white: 7,
};
const BG_COLOR_MAP = {
  red: 1, orange: 2, yellow: 3, green: 4, blue: 5, purple: 6,
  grey: 7, gray: 7, black: 7, white: 7,
  'light-red': 8, 'light-orange': 9, 'light-yellow': 10,
  'light-green': 11, 'light-blue': 12, 'light-purple': 13,
  'medium-gray': 14, 'light-gray': 15,
};

let __blkCounter = 1;
function genBlockId(prefix = 'blk') {
  return `${prefix}_${Date.now().toString(36)}${(__blkCounter++).toString(36)}`;
}

/**
 * 统一入口：给 format=html 的转换产物做富内容增强。
 * 1) 图片（url 无 token）下载并上传拿 token 回填；失败则降级 [图片]
 * 2) 表格列宽（colgroup -> table.property.column_width）
 * 3) 手写扩展块的占位符替换（若 convert 阶段未注入，则兜底追加为顶级块）
 * 注意：无 token 的图片可能同时出现在 convert 产物与我方手写扩展块里，这里统一扫一遍。
 */
async function enrichHtmlBlocks(env, token, blocks, html) {
  // 表格列宽（取自 HTML 里的 <colgroup>/<col width>）。
  // 注：图片上传已移到 insertBlocks 之后的 hydrateAndPatchImages（飞书要求先建块再补 token）。
  applyColumnWidths(blocks, html);
}

// ---------- 图片上传 ----------
// 从 src 下载字节 -> 调飞书素材上传接口拿 file_token -> 写回 image 块
async function hydrateImageBlocks(env, token, blocks) {
  for (const b of blocks) {
    if (b.block_type === BLOCK_TYPE_IMAGE && b.image && !b.image.token) {
      const url = b.image.url;
      if (url) {
        try {
          const token2 = await uploadMedia(env, token, b.image.url || url, 'docx_image', b.block_id);
          if (token2) {
            b.image = { ...b.image, token: token2 };
          } else {
            b.image = { ...b.image, token: '', placeholder: true };
          }
        } catch {
          // 上传失败 -> 占位文本，不中断整体写入
          b.image = { ...b.image, token: '', placeholder: true };
        }
      } else {
        b.image = { ...b.image, token: '', placeholder: true };
      }
      // 若最终没有 token，把 image 块内容替换成占位文本，避免写入无 token 的 image 块报错
      if (!b.image.token) {
        const label = `[图片]`;
        b.block_type = BLOCK_TYPE_TEXT;
        b.text = { elements: [{ text_run: { content: label } }] };
        delete b.image;
      }
    }
  }
}

/**
 * 图片正确时序：先插入 image 块（此时块已存在、有真实 block_id），再上传素材（parent_node=块id），
 * 然后用 replace_image 设 token。上传/打补丁失败则跳过（块保留原样，不中断写入）。
 */
// 按文档顺序提取 HTML 里的图片来源（src 可为 http(s) 或 base64 data URL）
function extractImageSources(html) {
  const out = [];
  if (!html) return out;
  const re = /<img([^>]*?)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[1] || '');
    out.push({ src: attrs.src || attrs.href || '', width: Number(attrs.width || 0), height: Number(attrs.height || 0) });
  }
  return out;
}

// 分页拉取文档所有块，返回数组（含嵌套块，按 feishu 返回顺序）
async function fetchAllBlocks(env, token, documentId) {
  const out = [];
  let pt = '';
  do {
    const q = pt ? `?page_size=500&page_token=${encodeURIComponent(pt)}` : '?page_size=500';
    const d = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks${q}`, { token });
    out.push(...(d.data.items || []));
    pt = d.data.has_more ? d.data.page_token : '';
  } while (pt);
  return out;
}

async function hydrateAndPatchImages(env, token, documentId, blocks, html) {
  // 飞书真实图片块是 block_type 27（image 字段含 token）。convert 插入后飞书会重新分配真实 block_id，
  // 所以这里读取文档当前的真实块，找到「无 token 的图片块」，用真实 block_id 上传素材（parent_node=真实id）→ replace_image 填 token。
  const report = [];
  const sources = extractImageSources(html);
  if (!sources.length) return report;
  let docBlocks;
  try {
    docBlocks = await fetchAllBlocks(env, token, documentId);
  } catch (e) {
    return [{ error: 'fetch-blocks-failed:' + (e.message || String(e)) }];
  }
  // 找出无 token 的图片块（type 27，image 字段），按文档返回顺序
  const imgBlocks = [];
  for (const b of docBlocks) {
    if (b.block_type === BLOCK_TYPE_IMAGE || (b.image && !b.image.token)) {
      if (b.image && !b.image.token) imgBlocks.push(b);
    }
  }
  for (let i = 0; i < imgBlocks.length; i++) {
    const ib = imgBlocks[i];
    const src = sources[i] && sources[i].src;
    if (!src) { report.push({ block_id: ib.block_id, error: 'no-src' }); continue; }
    let tok = null;
    let uploadErr = '';
    try {
      tok = await uploadMedia(env, token, src, 'docx_image', ib.block_id);
    } catch (e) {
      uploadErr = e.message || String(e);
      tok = null;
    }
    if (!tok) { report.push({ block_id: ib.block_id, error: 'upload-failed:' + uploadErr }); continue; }
    try {
      const w = Number(sources[i].width);
      const h = Number(sources[i].height);
      const body = { replace_image: { token: tok } };
      if (isFinite(w) && w > 0) body.replace_image.width = w;
      if (isFinite(h) && h > 0) body.replace_image.height = h;
      await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks/${ib.block_id}`, {
        method: 'PATCH',
        body,
        token,
      });
      report.push({ block_id: ib.block_id, ok: true });
    } catch (e2) {
      report.push({ block_id: ib.block_id, error: 'patch-failed:' + (e2.message || String(e2)) });
    }
  }
  return report;
}

/**
 * 下载远程图片字节并上传到飞书，返回 file_token；失败返回 null。
 * multipart 字段：file_name / parent_type='docx_image' / parent_node=该块 id / file(bytes)。
 * 使用的 <token> 与写入文档的身份一致（文档落用户云盘时用用户身份，否则应用身份）。
 */
async function uploadMedia(env, token, url, parentType, parentNode) {
  const base = env.FEISHU_BASE_URL || FEISHU_DEFAULT_BASE;

  // 1) 取图片字节：base64 数据图直接解码；http(s) 图下载
  let bytes, contentType;
  if (url.startsWith('data:')) {
    const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) throw new Error('无法解析 base64 图片');
    contentType = m[1] || 'image/png';
    const b64 = m[3] || '';
    const bin = atob(b64.replace(/\s+/g, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    bytes = u8.buffer;
  } else {
    const imgResp = await fetch(url);
    if (!imgResp.ok) throw new Error(`图片下载失败 HTTP ${imgResp.status}`);
    bytes = await imgResp.arrayBuffer();
    contentType = imgResp.headers.get('content-type') || 'image/png';
  }
  const ext = (contentType.split('/')[1] || 'png').split(';')[0] || 'png';
  const fileName = `img_${Date.now()}.${ext}`;
  const assetType = parentType === 'docx_image' ? '1' : '1'; // docx_image 对应 media_type=1（图片）

  // 2) 构造 multipart 上传（Cloudflare Workers 内置 FormData/File）
  // 飞书 upload_all 必需字段：file_name / parent_type('docx_image') / parent_node(块id) / size(字节) / file
  const fd = new FormData();
  fd.append('file_name', fileName);
  fd.append('parent_type', parentType);
  fd.append('parent_node', parentNode);
  fd.append('size', String(bytes.byteLength));
  fd.append('file', new File([bytes], fileName, { type: contentType }), fileName);

  const resp = await fetch(`${base}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const data = await resp.json().catch(() => ({}));
  if (data.code !== 0 || !data.data || !data.data.file_token) {
    throw new Error(`素材上传失败：code=${data.code} msg=${data.msg}`);
  }
  return data.data.file_token;
}

// ---------- 表格列宽 ----------
// 从 HTML 的 <colgroup><col width="N"> 提取像素数组，按顺序填到 table 块的 property.column_width。
// 若列宽信息在 convert 结构里不易稳定对齐（多表/合并），则尽力而为，取不到就跳过。
function applyColumnWidths(blocks, html) {
  const groups = extractColgroupWidths(html);
  if (!groups.length) return;

  let gi = 0; // 当前用到第几个 colgroup
  for (const b of blocks) {
    if (b.block_type === BLOCK_TYPE_TABLE && b.table) {
      const widths = groups[gi];
      if (widths && widths.length) {
        if (!b.table.property || typeof b.table.property !== 'object') b.table.property = {};
        b.table.property.column_width = widths.map((w) => Number(w));
      }
      gi = Math.min(gi + 1, groups.length - 1);
    }
  }
}

function extractColgroupWidths(html) {
  const out = [];
  const re = /<colgroup[^>]*>([\s\S]*?)<\/colgroup>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const widths = [];
    const colRe = /<col[^>]*\bwidth=["']?(\d+)["']?[^>]*>/gi;
    let cm;
    while ((cm = colRe.exec(m[1])) !== null) widths.push(cm[1]);
    if (widths.length) out.push(widths);
  }
  return out;
}

/**
 * 预处理 HTML：把 convert 不支持的块级扩展标签（callout/grid/checkbox/bookmark/source）
 * 替换成占位符，并构建对应的飞书块树（含子块）。
 * 返回 { html, extensionBlocks: [{ placeholder, topBlock }] }。
 * 子块内容用 parseBlockContent 解析（自包含，不依赖二次 convert）。
 */
function preprocessHtmlExtensions(html, format) {
  const extensionBlocks = [];
  // 需要"成对闭合 / 自闭合"处理的块级扩展标签
  const blockTagRe = /<(callout|grid|checkbox|bookmark|source)(\s[^>]*)?>|<\/(callout|grid|checkbox|bookmark|source)>|<(callout|grid|checkbox|bookmark|source)(\s[^>]*)?\/>/gi;

  let processed = html;
  let idx = 0;
  // 用有序匹配逐个替换：先找第一个块级扩展开标签，再定位其闭合，取整段替换
  // 这里用 while 循环 + 正则寻找下一个开标签。
  let counter = 0;
  for (;;) {
    const openRe = /<(callout|grid|checkbox|bookmark|source)(\s[^>]*?)?>/i;
    // 在 processed 的剩余部分查找开标签（含自闭合）
    const search = processed;
    const mo = openRe.exec(search);
    if (!mo) break;

    const tagName = mo[1].toLowerCase();
    const start = mo.index;
    const openLen = mo[0].length;

    if (mo[0].endsWith('/>')) {
      // 自闭合（如 <source .../> 或空 <bookmark/>）
      const attrs = parseAttrs(mo[2] || '');
      const blk = buildExtensionBlock(tagName, attrs, '', format, true);
      const ph = `${EXT_PLACEHOLDER_PREFIX}${counter++}${EXT_PLACEHOLDER_SUFFIX}`;
      extensionBlocks.push({ placeholder: ph, topBlock: blk });
      processed = processed.slice(0, start) + ph + processed.slice(start + openLen);
      continue;
    }

    // 成对：找匹配闭合标签 </tagName>
    const closeTag = `</${tagName}>`;
    const closeIdx = findMatchingClose(processed, start + openLen, tagName);
    let inner = '';
    let endPos = start + openLen;
    if (closeIdx !== -1) {
      inner = processed.slice(start + openLen, closeIdx);
      endPos = closeIdx + closeTag.length;
    } else {
      // 无闭合：把剩余当作其内容
      inner = processed.slice(start + openLen);
      endPos = processed.length;
    }
    const attrs = parseAttrs(mo[2] || '');
    const blk = buildExtensionBlock(tagName, attrs, inner, format, false);
    const ph = `${EXT_PLACEHOLDER_PREFIX}${counter++}${EXT_PLACEHOLDER_SUFFIX}`;
    extensionBlocks.push({ placeholder: ph, topBlock: blk });
    processed = processed.slice(0, start) + ph + processed.slice(endPos);
  }

  return { html: processed, extensionBlocks };
}

// 查找与开标签同名、非自闭合的闭合标签位置（不跨层，用于简单嵌套）
function findMatchingClose(str, from, tagName) {
  const closeTag = `</${tagName}>`;
  const openPat = new RegExp(`<${tagName}(\\s[^>]*?)?>`, 'gi');
  let depth = 1;
  let i = from;
  while (i < str.length) {
    const nextOpen = openPat.exec(str.slice(i));
    const nClose = str.indexOf(closeTag, i);
    if (nClose === -1) return -1;
    // 比较开/闭哪个先出现
    let nextOpenAbs = -1;
    if (nextOpen) {
      // 重新定位到绝对索引
      const tmp = openPat;
      const mm = tmp.exec(str.slice(i));
      if (mm) nextOpenAbs = i + mm.index;
    }
    if (nextOpenAbs !== -1 && nextOpenAbs < nClose) {
      depth++;
      i = nextOpenAbs + openPat.lastIndex; // 从该开标签之后继续
      // 注意 openPat.lastIndex 是相对 slice 的，需重置
      openPat.lastIndex = 0;
      continue;
    }
    depth--;
    if (depth === 0) return nClose;
    i = nClose + closeTag.length;
  }
  return -1;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([\w-]+)(?:\s*=\s*["']([^"']*)["']|\s*=\s*(\S+))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const k = m[1].toLowerCase();
    attrs[k] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : true);
  }
  return attrs;
}

/**
 * 解析一个 HTML 标签串为 { name, attrs, isClosing, selfClose }。
 * 用于在 parseInlineElements / 扩展构建中识别标签与属性。
 */
function parseTag(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('<')) return null;
  const m = s.match(/^<\s*([\w-]+)/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const isClosing = /^<\s*\//.test(s);
  const selfClose = /\/\s*>$/.test(s);
  const attrPart = s.replace(/^<\s*\/?[\w-]+/, '').replace(/\/?\s*>$/, '');
  const attrs = isClosing ? {} : parseAttrs(attrPart);
  return { name, attrs, isClosing, selfClose };
}

// ---------- 扩展块构建（返回单个 topBlock + 其子块，子块 id 由 genBlockId 生成）----------
function buildExtensionBlock(tagName, attrs, innerHtml, format, selfClose) {
  if (tagName === 'callout') {
    return buildCalloutBlock(attrs, innerHtml, format);
  }
  if (tagName === 'grid') {
    return buildGridBlock(attrs, innerHtml, format);
  }
  if (tagName === 'checkbox') {
    return buildTodoBlock(attrs, innerHtml, format);
  }
  if (tagName === 'bookmark') {
    return buildBookmarkBlock(attrs, innerHtml, format);
  }
  if (tagName === 'source') {
    return buildAttachBlock(attrs, innerHtml, format);
  }
  // 兜底：普通文本块
  const id = genBlockId();
  const elements = parseInlineElements(innerHtml || '');
  return { block_id: id, block_type: BLOCK_TYPE_TEXT, text: { elements } };
}

// 构建高亮框：block_type 19，callout { elements, style:{ background_color, border_color, text_color, emoji } }
// 内联文本放入 elements；含块级子元素（标题/列表/待办/引用）时，子元素作 children，避免正文重复渲染
function buildCalloutBlock(attrs, innerHtml, format) {
  const id = genBlockId('callout');
  const hasBlockChild = /<(h[1-6]|ul|ol|li|blockquote|pre|hr|img|checkbox|callout|grid|p|div)\b/i.test(innerHtml || '');
  let elements = [];
  let childrenIds = [];
  let childBlocks = [];
  if (hasBlockChild) {
    const parsed = parseBlockContent(innerHtml || '', format);
    childrenIds = parsed.topIds;
    childBlocks = parsed.blocks;
    elements = [];
  } else {
    elements = parseInlineElements(innerHtml || '');
  }

  const style = {};
  if (attrs['background-color'] !== undefined) style.background_color = colorToInt(attrs['background-color'], true);
  if (attrs['border-color'] !== undefined) style.border_color = colorToInt(attrs['border-color'], true);
  if (attrs['text-color'] !== undefined) style.text_color = colorToInt(attrs['text-color'], false);
  if (attrs.emoji !== undefined) style.emoji = String(attrs.emoji);

  const block = {
    block_id: id,
    block_type: BLOCK_TYPE_CALLOUT,
    children: childrenIds,
    callout: { elements, ...(Object.keys(style).length ? { style } : {}) },
    __ext_deps: childBlocks,
  };
  return block;
}

// 分栏：grid(25)/grid_column(26) 的准确字段结构经真机验证会报 99992402，故先降级为文本块（内容保留）。
// 后续拿到 grid/grid_column 精确结构再升级为真正的分栏。
function buildGridBlock(attrs, innerHtml, format) {
  const id = genBlockId('grid');
  return {
    block_id: id,
    block_type: BLOCK_TYPE_TEXT,
    text: { elements: [{ text_run: { content: stripTags(innerHtml) } }] },
  };
}

// 待办：checkbox -> todo(16)，todo { elements, style:{ done } }
// 剥掉 HTML 标签并解码常见实体，得到纯文本（用于扩展块降级时的内容保留）
function stripTags(html) {
  if (!html) return '';
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 说明：checkbox -> todo(16) 的准确字段结构经真机验证会报 99992402，故降级为文本块（内容保留）。
// 后续拿到 todo 精确结构再升级为真正的待办块。
function buildTodoBlock(attrs, innerHtml, format) {
  const id = genBlockId('todo');
  const text = stripTags(innerHtml);
  const done = String(attrs.done === 'true' || attrs.done === true || attrs.checked === 'true' || attrs.checked === true) === 'true';
  // 飞书 todo 块真实形状（lark-cli 抓取确认）：block_type 17，todo:{ elements:[{text_run:{content,text_element_style}}], style:{align,done,folded} }
  return {
    block_id: id,
    block_type: BLOCK_TYPE_TODO,
    todo: {
      elements: [{ text_run: { content: text, text_element_style: {} } }],
      style: { align: 1, done, folded: false },
    },
  };
}

// 书签：bookmark(27) { bookmark: { elements?, ... } } —— 官方 bookmark 含 book_mark: { ... }，这里做法见注释
function buildBookmarkBlock(attrs, innerHtml, format) {
  const id = genBlockId('bookmark');
  const name = attrs.name || '';
  const href = attrs.href || '';
  // 说明：bookmark(27) 的准确字段结构经真机验证报 invalid param(1770001)，故降级为文本块。
  // 后续拿到 bookmark 精确结构再升级。
  return {
    block_id: id,
    block_type: BLOCK_TYPE_TEXT,
    text: { elements: [{ text_run: { content: href ? `[书签: ${name || href}](${href})` : `[书签: ${name || '书签'}]` } }] },
  };
}

// 附件：source -> 附件块。当前不实现真实附件上传（缺 env/token），先降级为 [附件] 文本占位，
// 避免写入无 token 的 file 块报错。
function buildAttachBlock(attrs, innerHtml, format) {
  const id = genBlockId('att');
  const name = attrs.name || '';
  return {
    block_id: id,
    block_type: BLOCK_TYPE_TEXT,
    text: { elements: [{ text_run: { content: name ? `[附件]${name}` : '[附件]' } }] },
  };
}

// ---------- 块级内容解析（扩展块内部/分栏内部的子块）----------
// 支持：h1-h6、p/div 文本、ul/ol/li 列表、blockquote 引用、checkbox 待办、pre/code 代码、hr 分割线、img 图片、内联文本
function parseBlockContent(html, format) {
  const blocks = [];
  const topIds = [];
  // 按顶层块切分
  const segs = splitTopLevelBlocks(html);
  for (const seg of segs) {
    const b = buildBlockFromSegment(seg, format);
    if (b) {
      if (Array.isArray(b)) {
        for (const bb of b) { blocks.push(bb); topIds.push(bb.block_id); }
      } else {
        blocks.push(b);
        topIds.push(b.block_id);
      }
      if (b.__ext_deps) { for (const d of b.__ext_deps) blocks.push(d); }
    }
  }
  return { blocks, topIds };
}

function splitTopLevelBlocks(html) {
  // 用"块级开标签"切分顶层。简化：按 <h1..h6|p|div|ul|ol|li|blockquote|pre|hr|img|checkbox> 匹配。
  const blockRe = /<(h[1-6]|p|div|ul|ol|li|blockquote|pre|hr|img|checkbox)\b[^>]*>/gi;
  const segs = [];
  let last = 0;
  let m;
  let segStart = 0;
  while ((m = blockRe.exec(html)) !== null) {
    if (m.index > segStart) {
      const text = html.slice(segStart, m.index).trim();
      if (text) segs.push({ type: 'raw', html: text });
    }
    const tag = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    if (tag === 'hr' || tag === 'img' || m[0].endsWith('/>')) {
      segs.push({ type: tag, html: m[0], start: m.index, end: openEnd });
      segStart = openEnd;
      continue;
    }
    const closeTag = `</${tag}>`;
    const closeIdx = html.indexOf(closeTag, openEnd);
    const innerEnd = closeIdx === -1 ? html.length : closeIdx;
    segs.push({ type: tag, html: html.slice(m.index, closeIdx === -1 ? html.length : closeIdx + closeTag.length), inner: html.slice(openEnd, innerEnd), start: m.index, end: closeIdx === -1 ? html.length : closeIdx + closeTag.length });
    segStart = closeIdx === -1 ? html.length : closeIdx + closeTag.length;
    blockRe.lastIndex = segStart;
  }
  if (segStart < html.length) {
    const text = html.slice(segStart).trim();
    if (text) segs.push({ type: 'raw', html: text });
  }
  return segs;
}

function buildBlockFromSegment(seg, format) {
  const type = seg.type || 'raw';
  if (type === 'raw') {
    const text = (seg.html || '').trim();
    if (!text) return null;
    return textBlock(parseInlineElements(text));
  }
  switch (type) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const lvl = Number(type[1]);
      const bt = BLOCK_TYPE_HEADING_BASE + (lvl - 1);
      const field = `heading${lvl}`;
      const elements = parseInlineElements((seg.inner || '').trim());
      const id = genBlockId('h');
      const b = { block_id: id, block_type: bt };
      b[field] = { elements };
      return b;
    }
    case 'p': case 'div': {
      return textBlock(parseInlineElements((seg.inner || seg.html || '').trim()));
    }
    case 'ul': case 'ol': {
      return buildListBlock(seg.inner || seg.html || '', type === 'ol');
    }
    case 'li': {
      return textBlock(parseInlineElements((seg.inner || seg.html || '').trim()));
    }
    case 'blockquote': {
      const id = genBlockId('quote');
      const elements = parseInlineElements((seg.inner || seg.html || '').trim());
      return { block_id: id, block_type: BLOCK_TYPE_QUOTE, quote: { elements } };
    }
    case 'pre': {
      const id = genBlockId('code');
      const content = (seg.inner || seg.html || '').replace(/<[^>]+>/g, '');
      return { block_id: id, block_type: BLOCK_TYPE_CODE, code: { elements: [{ text_run: { content } }] } };
    }
    case 'hr': {
      const id = genBlockId('div');
      return { block_id: id, block_type: BLOCK_TYPE_DIVIDER, divider: {} };
    }
    case 'img': {
      const attrs = parseAttrs(seg.html);
      const id = genBlockId('img');
      return { block_id: id, block_type: BLOCK_TYPE_IMAGE, image: { url: attrs.src || '', token: '', width: Number(attrs.width || 0), height: Number(attrs.height || 0) } };
    }
    case 'checkbox': {
      const attrs = parseAttrs(seg.html);
      return buildTodoBlock(attrs, seg.inner || '', format);
    }
    default:
      return textBlock(parseInlineElements(seg.html || ''));
  }
}

function buildListBlock(inner, ordered) {
  const id = genBlockId('li');
  const children = [];
  const subBlocks = [];
  const liRe = /<li([^>]*)>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(inner)) !== null) {
    const cid = genBlockId('litem');
    const elements = parseInlineElements(m[2]);
    const liBlock = {
      block_id: cid,
      block_type: ordered ? BLOCK_TYPE_ORDERED : BLOCK_TYPE_BULLET,
      ...(ordered ? { ordered: { elements } } : { bullet: { elements } }),
      children: [],
    };
    subBlocks.push(liBlock);
    children.push(cid);
  }
  const listBlock = {
    block_id: id,
    block_type: ordered ? BLOCK_TYPE_ORDERED : BLOCK_TYPE_BULLET,
    children,
    ...(ordered ? { ordered: { elements: children.map((c) => ({ text_run: { content: '' } })) } } : { bullet: { elements: children.map((c) => ({ text_run: { content: '' } })) } }),
  };
  // 列表项作为 listBlock 的子块
  return { block_id: id, block_type: listBlock.block_type, children, ...(ordered ? { ordered: { elements: [] } } : { bullet: { elements: [] } }), __ext_deps: subBlocks };
}

function textBlock(elements) {
  const id = genBlockId('text');
  const content = (elements || []).map((el) => (el.text_run ? el.text_run.content : '')).join('');
  if (!content.trim() && elements.length === 0) {
    // 空块仍返回 text 占位，避免丢失结构
  }
  return { block_id: id, block_type: BLOCK_TYPE_TEXT, text: { elements: elements || [] } };
}

// ---------- 内联解析（返回飞书 text 元素数组）----------
// 支持：文本、<b>/<strong>、<em>/<i>、<u>、<del>/<strike>/<s>、<code>、
//      <span style="color|background-color">、<a href>、<br>、
//      <cite type="user|doc">、<latex>、<img>（内联降级为占位文本）
function parseInlineElements(html, baseStyle = {}) {
  const els = [];
  let i = 0;
  const s = String(html || '');
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      if (s.slice(i)) els.push(textRunElement(s.slice(i), baseStyle));
      break;
    }
    if (lt > i) {
      if (s.slice(i, lt)) els.push(textRunElement(s.slice(i, lt), baseStyle));
      i = lt;
    }
    const gt = s.indexOf('>', i);
    if (gt === -1) {
      if (s.slice(i)) els.push(textRunElement(s.slice(i), baseStyle));
      break;
    }
    const raw = s.slice(i, gt + 1);
    let tag = parseTag(raw);
    i = gt + 1;
    if (!tag) { els.push(textRunElement(raw, baseStyle)); continue; }
    if (tag.isClosing) continue;
    const name = tag.name.toLowerCase();
    const voidTags = new Set(['br', 'img', 'hr']);
    if (tag.selfClose || voidTags.has(name)) {
      if (name === 'br') els.push(textRunElement('\n', baseStyle));
      else if (name === 'img') els.push(textRunElement('[图片]', baseStyle));
      continue;
    }
    const closeTag = `</${name}>`;
    const end = s.indexOf(closeTag, i);
    const inner = end === -1 ? s.slice(i) : s.slice(i, end);
    i = end === -1 ? s.length : end + closeTag.length;

    if (name === 'cite') {
      els.push(mentionElement(tag.attrs));
    } else if (name === 'latex') {
      els.push({ equation: { content: inner } });
    } else if (name === 'a') {
      const linkStyle = mergeInlineStyle(baseStyle, tag.name, tag.attrs);
      const innerEls = parseInlineElements(inner, baseStyle);
      const innerText = innerEls.map((e) => (e.text_run ? e.text_run.content : '')).join('');
      els.push({ link: { url: tag.attrs.href || '', text_element_style: linkStyle.style || {} , text_run: { content: innerText } } });
    } else {
      const merged = mergeInlineStyle(baseStyle, name, tag.attrs);
      els.push(...parseInlineElements(inner, merged));
    }
  }
  return els;
}

function textRunElement(content, styleObj) {
  const text_element_style = Object.keys(styleObj.style || {}).length ? styleObj.style : undefined;
  return { text_run: { content, ...(text_element_style ? { text_element_style } : {}) } };
}

function mergeInlineStyle(base, tagName, attrs) {
  const style = Object.assign({}, base.style || {});
  switch (tagName) {
    case 'strong': case 'b': style.bold = true; break;
    case 'em': case 'i': style.italic = true; break;
    case 'u': case 'ins': style.underline = true; break;
    case 'del': case 'strike': case 's': style.strikethrough = true; break;
    case 'code': style.inline_code = true; break;
    case 'span': {
      const css = attrs.style || attrs.class || '';
      const color = extractCssProp(css, 'color');
      const bg = extractCssProp(css, 'background-color') || extractCssProp(css, 'background');
      if (color) { const v = colorToInt(color, false); if (v !== undefined) style.text_color = v; }
      if (bg) { const v = colorToInt(bg, true); if (v !== undefined) style.background_color = v; }
      if (attrs['text-color']) { const v = colorToInt(String(attrs['text-color']), false); if (v !== undefined) style.text_color = v; }
      if (attrs['background-color']) { const v = colorToInt(String(attrs['background-color']), true); if (v !== undefined) style.background_color = v; }
      break;
    }
  }
  return { style };
}

function mentionElement(attrs) {
  const type = (attrs.type || 'user').toLowerCase();
  if (type === 'doc') {
    return { mention_doc: { token: attrs['doc-id'] || attrs.token || '', obj_type: 'docx', url: attrs.url || '', title: attrs.title || '' } };
  }
  return { mention_user: { user_id: attrs['user-id'] || attrs.user_id || '' } };
}

function extractCssProp(css, prop) {
  if (!css) return null;
  const re = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i');
  const m = css.match(re);
  return m ? m[1].trim() : null;
}

function colorToInt(name, isBg) {
  if (!name) return undefined;
  const key = String(name).trim().toLowerCase();
  const map = isBg ? BG_COLOR_MAP : TEXT_COLOR_MAP;
  if (map[key] !== undefined) return map[key];
  // 处理 #hex 或是 light-* 前缀：这里仅对已知命名色返回，其它返回 undefined 交给真机校准
  return undefined;
}

// ---------- 占位符注入 ----------
// 把 convert 产物里的占位符文本块，替换成真正的手写扩展块（保持 block_id、定位不丢）。
// 找不到占位符时，把扩展块作为新的顶级块追加。
function injectExtensionBlocks(blocks, firstLevelIds, extensionBlocks) {
  if (!extensionBlocks.length) return { blocks, firstLevelIds };

  const byId = new Map(blocks.map((b) => [b.block_id, b]));
  const display = blocks.slice();
  const newTopIds = [];

  for (const { placeholder, topBlock } of extensionBlocks) {
    const host = findPlaceholderBlock(byId, firstLevelIds, placeholder);
    const replacement = { ...topBlock, block_id: host ? host.block_id : topBlock.block_id };
    // 清理内部临时字段
    delete replacement.__ext_deps;
    const deps = topBlock.__ext_deps || [];
    if (host) {
      replacement.parent_id = host.parent_id;
      byId.set(host.block_id, replacement);
      const idx = display.findIndex((b) => b.block_id === host.block_id);
      if (idx !== -1) display[idx] = replacement;
    } else {
      display.push(replacement);
      byId.set(replacement.block_id, replacement);
      newTopIds.push(replacement.block_id);
    }
    for (const d of deps) {
      if (!byId.has(d.block_id)) { display.push(d); byId.set(d.block_id, d); }
    }
  }

  const outFirst = firstLevelIds.slice();
  for (const id of newTopIds) outFirst.push(id);
  return { blocks: dedupeBlocks(display), firstLevelIds: outFirst };
}

function findPlaceholderBlock(byId, firstLevelIds, placeholder) {
  // 深度优先，按文档顺序找第一个含占位符的文本块
  const seen = new Set();
  const visit = (id) => {
    const b = byId.get(id);
    if (!b || seen.has(id)) return null;
    seen.add(id);
    const text = blockPlainText(b);
    if (text && text.includes(placeholder)) return b;
    for (const c of b.children || []) {
      const r = visit(c);
      if (r) return r;
    }
    return null;
  };
  for (const id of firstLevelIds) {
    const r = visit(id);
    if (r) return r;
  }
  // 兜底：也扫一遍所有 blocks
  for (const b of byId.values()) {
    if (!seen.has(b.block_id)) {
      const text = blockPlainText(b);
      if (text && text.includes(placeholder)) return b;
    }
  }
  return null;
}

function blockPlainText(b) {
  if (!b) return '';
  let parts = [];
  for (const field of ['text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'code', 'quote', 'todo', 'callout']) {
    const f = b[field];
    if (f && Array.isArray(f.elements)) {
      for (const el of f.elements) if (el.text_run && el.text_run.content) parts.push(el.text_run.content);
    }
  }
  return parts.join('');
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    if (seen.has(b.block_id)) continue;
    seen.add(b.block_id);
    out.push(b);
  }
  return out;
}

/**
 * 清理转换结果中「创建时不支持」的块：
 * - convert 返回的 blocks 已是「平铺 + children 存子块 ID」的合法结构，
 *   直接保留即可（divider 的 {} 是合法格式，官方要求传 {}）。
 * - 仅过滤：完全为空（无 block_type / 无任何内容）的异常块。
 */
function sanitizeBlocks(blocks) {
  return blocks.filter((block) => {
    if (!block || typeof block !== 'object') return false;
    if (typeof block.block_type !== 'number') return false;
    const hasContent = Object.keys(block).some((k) => !['block_id', 'block_type', 'parent_id', 'children'].includes(k));
    return hasContent;
  });
}

/**
 * 递归删除所有名为 merge_info 的字段（表格转换产物专用清理）
 */
function stripMergeInfo(value) {
  if (Array.isArray(value)) {
    for (const item of value) stripMergeInfo(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === 'merge_info') {
        delete value[key];
      } else {
        stripMergeInfo(value[key]);
      }
    }
  }
}

/**
 * 从 document_id 参数中提取真实的文档 ID
 * 支持三种输入：
 *   1. 纯 ID：VbQ1234abcdEFGhijkl
 *   2. 完整链接：https://xxx.feishu.cn/docx/VbQ1234abcdEFGhijkl?from=xxx
 *   3. 其他飞书文档链接（wiki 等）：取路径最后一段
 */
function extractDocumentId(input) {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  // 完整链接：优先取 /docx/<ID>，兼容带 query / 尾部斜杠
  if (/^https?:\/\//i.test(trimmed)) {
    const m = trimmed.match(/\/docx\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    // 兜底：取路径最后一段并去掉 query
    const last = trimmed.split('/').filter(Boolean).pop();
    return last ? last.split(/[?#]/)[0] : trimmed;
  }

  // 纯 ID：去掉 query 与锚点
  return trimmed.split(/[?#]/)[0];
}

/**
 * 写入文档块（追加到文档末尾）
 * 使用「创建后代块」接口（blocks/descendant），支持嵌套列表/表格等复杂结构：
 * - firstLevelIds：一级块 ID 的**文档顺序**（convert 返回的 blocks 数组本身无序！）
 * - descendants：所有块平铺（父块 children 存子块 ID 字符串）
 * - children_id：按 firstLevelIds 顺序排列的一级块 ID
 * - 单次请求上限 1000 个块；一次提交全部块（避免分批切断父子关系）
 * - 仅当超过 1000 时才按一级块分批（一级块之间无父子关系，分批安全）
 */
async function insertBlocks(env, token, documentId, blocks, firstLevelIds, opts = {}) {
  const rootBlockId = opts.parent_id || documentId; // 默认插到文档根；定点插入可指定父块
  let cursor = Number.isInteger(opts.index) ? opts.index : -1; // 默认 -1 追加到末尾
  const byId = new Map(blocks.map((b) => [b.block_id, b]));

  // 一级块按文档顺序排列（firstLevelIds），并过滤不存在的
  const topLevel = (firstLevelIds || [])
    .map((id) => byId.get(id))
    .filter(Boolean);
  // 兜底：如果 firstLevelIds 缺失，用「未被 children 引用的块」并按数组顺序
  if (topLevel.length === 0) {
    const childIds = new Set();
    for (const b of blocks) {
      if (Array.isArray(b.children)) {
        for (const c of b.children) childIds.add(c);
      }
    }
    topLevel.push(...blocks.filter((b) => !childIds.has(b.block_id)));
  }
  if (topLevel.length === 0) return;

  // 收集某一级块及其所有后代（保持 descendants 平铺）
  const collectWithDescendants = (tops) => {
    const chunkBlocks = [];
    const seen = new Set();
    const collect = (blk) => {
      if (!blk || seen.has(blk.block_id)) return;
      seen.add(blk.block_id);
      chunkBlocks.push(blk);
      if (Array.isArray(blk.children)) {
        for (const cid of blk.children) {
          const child = byId.get(cid);
          if (child) collect(child);
        }
      }
    };
    for (const t of tops) collect(t);
    return chunkBlocks;
  };

  // 分批提交（descendant 单次上限 1000 块；按一级块切分，不破坏父子关系）
  const DESCENDANT_LIMIT = 1000;
  const batches = [];
  let current = [];
  let currentCount = 0;
  for (const t of topLevel) {
    const subTree = collectWithDescendants([t]);
    if (currentCount + subTree.length > DESCENDANT_LIMIT && current.length > 0) {
      batches.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(t);
    currentCount += subTree.length;
  }
  if (current.length > 0) batches.push(current);

  for (const topChunk of batches) {
    const chunkBlocks = collectWithDescendants(topChunk);
    const body = {
      index: cursor,
      children_id: topChunk.map((t) => t.block_id),
      descendants: chunkBlocks.map((b) => ({
        block_id: b.block_id,
        block_type: b.block_type,
        children: b.children || [],
        ...(b.text ? { text: b.text } : {}),
        ...(b.heading1 ? { heading1: b.heading1 } : {}),
        ...(b.heading2 ? { heading2: b.heading2 } : {}),
        ...(b.heading3 ? { heading3: b.heading3 } : {}),
        ...(b.heading4 ? { heading4: b.heading4 } : {}),
        ...(b.heading5 ? { heading5: b.heading5 } : {}),
        ...(b.heading6 ? { heading6: b.heading6 } : {}),
        ...(b.heading7 ? { heading7: b.heading7 } : {}),
        ...(b.heading8 ? { heading8: b.heading8 } : {}),
        ...(b.heading9 ? { heading9: b.heading9 } : {}),
        ...(b.bullet ? { bullet: b.bullet } : {}),
        ...(b.ordered ? { ordered: b.ordered } : {}),
        ...(b.code ? { code: b.code } : {}),
        ...(b.quote ? { quote: b.quote } : {}),
        ...(b.todo ? { todo: b.todo } : {}),
        ...(b.divider ? { divider: b.divider } : {}),
        ...(b.table ? { table: b.table } : {}),
        ...(b.table_cell ? { table_cell: b.table_cell } : {}),
        ...(b.callout ? { callout: b.callout } : {}),
        ...(b.image ? { image: b.image } : {}),
        ...(b.file ? { file: b.file } : {}),
        ...(b.bookmark ? { bookmark: b.bookmark } : {}),
        ...(b.grid ? { grid: b.grid } : {}),
        ...(b.grid_column ? { grid_column: b.grid_column } : {}),
      })),
    };
    await feishuFetch(
      env,
      `/open-apis/docx/v1/documents/${documentId}/blocks/${rootBlockId}/descendant`,
      { method: 'POST', body, token }
    );
    if (cursor >= 0) cursor += topChunk.length;
  }
}

/**
 * 清空文档全部内容（replace 前调用）
 */
async function clearDocument(env, token, documentId) {
  const rootBlockId = documentId;

  // 先统计根块下子块总数（分页拉取）
  let count = 0;
  let pageToken = '';
  do {
    const query = pageToken ? `?page_size=500&page_token=${encodeURIComponent(pageToken)}` : '?page_size=500';
    const data = await feishuFetch(
      env,
      `/open-apis/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children${query}`,
      { token }
    );
    count += (data.data.items || []).length;
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);

  if (count === 0) return;

  // 批量删除，单次上限 50（end_index 为开区间）
  for (let start = 0; start < count; start += CREATE_CHILDREN_LIMIT) {
    const end = Math.min(start + CREATE_CHILDREN_LIMIT, count);
    await feishuFetch(
      env,
      `/open-apis/docx/v1/documents/${documentId}/blocks/${rootBlockId}/children/batch_delete`,
      { method: 'DELETE', body: { start_index: start, end_index: end }, token }
    );
  }
}

// ==================== 读取文档内容（read）====================

// 文本承载块的 block_type -> 内容字段名（用于取 elements[].text_run.content）
const TEXT_BLOCK_FIELDS = {
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  16: 'todo',
  17: 'todo',
  19: 'callout',
};
const BLOCK_TYPE_DIVIDER = 22;
const BLOCK_TYPE_TABLE_CELL = 32;
const BLOCK_TYPE_PAGE = 1;

/**
 * 定点插入 / 定点删除。找不到锚点一律拒绝，绝不改成 append 或 replace。
 */
async function handlePreciseEdit(env, ctx) {
  const {
    action, content, document_id, format,
    after, after_block_id, block_id, target, occurrence, mode,
    docToken, convertToken, identity,
  } = ctx;
  const url = `${env.DOC_URL_PREFIX || 'https://feishu.cn/docx/'}${document_id}`;

  const locatorText = action === 'insert_after' ? (after || target) : (target || after);
  const locatorId = after_block_id || block_id;

  if (!locatorText && !locatorId) {
    return {
      success: false,
      action,
      document_id,
      url,
      identity,
      message: action === 'insert_after'
        ? 'insert_after 必须提供 after（锚点原文）或 after_block_id / block_id。找不到锚点时不会改文档'
        : 'delete_range 必须提供 target（段落/标题原文）或 block_id。找不到目标时不会改文档',
    };
  }

  const byId = await listAllBlocks(env, docToken, document_id);
  const found = findAnchor(byId, document_id, {
    block_id: locatorId,
    text: locatorText,
    occurrence,
  });
  if (!found.ok) {
    return {
      success: false,
      action,
      document_id,
      url,
      identity,
      message: found.message,
      matches: found.matches,
    };
  }

  const anchor = found.block;
  const parentId = anchor.parent_id || document_id;
  const childIds = await listChildIds(env, docToken, document_id, parentId);
  const idx = childIds.indexOf(anchor.block_id);
  if (idx < 0) {
    return {
      success: false,
      action,
      document_id,
      url,
      identity,
      message: `已找到锚点「${found.text}」，但它不在父块子列表中，拒绝改文档`,
    };
  }

  if (action === 'delete_range') {
    const deleteMode = mode === 'block' || mode === 'section' ? mode : 'auto';
    let endIdx = idx;
    const level = headingLevel(anchor.block_type);
    const asSection = deleteMode === 'section' || (deleteMode === 'auto' && level > 0);
    if (asSection) {
      for (let i = idx + 1; i < childIds.length; i++) {
        const b = byId.get(childIds[i]);
        const lv = headingLevel(b && b.block_type);
        if (!level) {
          if (lv) break;
        } else if (lv && lv <= level) {
          break;
        }
        endIdx = i;
      }
    }
    await deleteChildRange(env, docToken, document_id, parentId, idx, endIdx + 1);
    const deleted = childIds.slice(idx, endIdx + 1).map((id) => ({
      block_id: id,
      text: blockPlainText(byId.get(id)),
    }));
    return {
      success: true,
      action,
      document_id,
      url,
      identity,
      deleted_count: deleted.length,
      deleted,
      anchor: { block_id: anchor.block_id, text: found.text },
      message: `已删除「${found.text}」起共 ${deleted.length} 个块，其余内容未动`,
    };
  }

  const { blocks, firstLevelIds } = await convertContent(env, convertToken, content, format);
  if (format === 'html') {
    await enrichHtmlBlocks(env, docToken, blocks, content);
  }
  let insertIndex = idx + 1;
  if (insertIndex >= childIds.length) insertIndex = -1;
  if (blocks.length > 0) {
    await insertBlocks(env, docToken, document_id, blocks, firstLevelIds, {
      parent_id: parentId,
      index: insertIndex,
    });
    if (format === 'html') {
      await hydrateAndPatchImages(env, docToken, document_id, blocks, content);
    }
  }
  return {
    success: true,
    action,
    document_id,
    url,
    identity,
    block_count: blocks.length,
    after: { block_id: anchor.block_id, text: found.text, index: idx },
    insert_index: insertIndex,
    message: `已插入到「${found.text}」下方，原文未覆盖`,
  };
}

async function listAllBlocks(env, token, documentId) {
  const byId = new Map();
  let pageToken = '';
  do {
    const query = pageToken
      ? `?page_size=500&page_token=${encodeURIComponent(pageToken)}`
      : '?page_size=500';
    const data = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks${query}`, { token });
    for (const b of data.data.items || []) byId.set(b.block_id, b);
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);
  return byId;
}

async function listChildIds(env, token, documentId, parentId) {
  const ids = [];
  let childToken = '';
  do {
    const q = childToken
      ? `?page_size=500&page_token=${encodeURIComponent(childToken)}`
      : '?page_size=500';
    const data = await feishuFetch(
      env,
      `/open-apis/docx/v1/documents/${documentId}/blocks/${parentId}/children${q}`,
      { token }
    );
    for (const it of data.data.items || []) ids.push(it.block_id);
    childToken = data.data.has_more ? data.data.page_token : '';
  } while (childToken);
  return ids;
}

async function deleteChildRange(env, token, documentId, parentId, start, endExclusive) {
  let remainingEnd = endExclusive;
  while (remainingEnd > start) {
    const chunkStart = Math.max(start, remainingEnd - CREATE_CHILDREN_LIMIT);
    await feishuFetch(
      env,
      `/open-apis/docx/v1/documents/${documentId}/blocks/${parentId}/children/batch_delete`,
      { method: 'DELETE', body: { start_index: chunkStart, end_index: remainingEnd }, token }
    );
    remainingEnd = chunkStart;
  }
}

function headingLevel(t) {
  if (t >= 3 && t <= 11) return t - 2;
  return 0;
}

function normalizeAnchorText(s) {
  return String(s || '')
    .replace(/^\s*#{1,9}\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findAnchor(byId, documentId, { block_id, text, occurrence }) {
  if (block_id) {
    const b = byId.get(block_id);
    if (!b) return { ok: false, message: `找不到 block_id=${block_id}，文档未改` };
    return { ok: true, block: b, text: blockPlainText(b) };
  }
  const q = normalizeAnchorText(text);
  if (!q) return { ok: false, message: '锚点文本为空，文档未改' };

  const candidates = [];
  for (const b of byId.values()) {
    if (!b || b.block_id === documentId || b.block_type === BLOCK_TYPE_PAGE || b.block_type === BLOCK_TYPE_TABLE_CELL) continue;
    const t = normalizeAnchorText(blockPlainText(b));
    if (!t) continue;
    candidates.push({ block: b, text: t, exact: t === q, contains: t.includes(q) });
  }
  let matched = candidates.filter((c) => c.exact);
  if (matched.length === 0) matched = candidates.filter((c) => c.contains);
  if (matched.length === 0) {
    return { ok: false, message: `文档中找不到「${q}」，未插入也未删除` };
  }
  if (matched.length > 1) {
    const occ = Number(occurrence);
    if (Number.isInteger(occ) && occ >= 1 && occ <= matched.length) {
      const pick = matched[occ - 1];
      return { ok: true, block: pick.block, text: pick.text };
    }
    return {
      ok: false,
      message: `「${q}」匹配到 ${matched.length} 处，请改用更完整原文或 block_id，或传 occurrence（1-${matched.length}）。文档未改`,
      matches: matched.slice(0, 10).map((c) => ({
        block_id: c.block.block_id,
        text: c.text,
        block_type: c.block.block_type,
      })),
    };
  }
  return { ok: true, block: matched[0].block, text: matched[0].text };
}

/**
 * 读取一篇飞书文档，重建为 Markdown 正文。
 * - 先取文档信息（标题等）
 * - 分页拉取全部块，按 block_id 建索引
 * - 用根块的 children 确定顶级块的文档顺序
 */
async function readDocument(env, token, documentId) {
  // 1) 文档元信息（标题、版本）
  const meta = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}`, { token });
  const docMeta = meta.data.document || {};
  const title = docMeta.title || documentId;

  // 2) 分页拉取全部块
  const byId = new Map();
  let pageToken = '';
  let topLevelIds = [];
  do {
    const query = pageToken
      ? `?page_size=500&page_token=${encodeURIComponent(pageToken)}`
      : '?page_size=500';
    const data = await feishuFetch(env, `/open-apis/docx/v1/documents/${documentId}/blocks${query}`, { token });
    for (const b of data.data.items || []) byId.set(b.block_id, b);
    pageToken = data.data.has_more ? data.data.page_token : '';
  } while (pageToken);

  // 3) 顶级块顺序 = 根块（block_id 就是 document_id）的 children
  try {
    let childToken = '';
    do {
      const q = childToken
        ? `?page_size=500&page_token=${encodeURIComponent(childToken)}`
        : '?page_size=500';
      const data = await feishuFetch(
        env,
        `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children${q}`,
        { token }
      );
      for (const it of data.data.items || []) topLevelIds.push(it.block_id);
      childToken = data.data.has_more ? data.data.page_token : '';
    } while (childToken);
  } catch {
    // 若根 children 接口失败，回退：用「未被任何块 children 引用」的块，并按获取顺序
    const childRefs = new Set();
    for (const b of byId.values()) for (const c of b.children || []) childRefs.add(c);
    for (const b of byId.values()) if (!childRefs.has(b.block_id)) topLevelIds.push(b.block_id);
  }

  const content = blocksToMarkdown(byId, topLevelIds);
  return { document_id: documentId, title, content, block_count: byId.size };
}

/**
 * 把文档块树重建为 Markdown 文本。
 * - 文本/标题/列表/代码/引用/待办/高亮块：取 elements[].text_run.content 并按类型加标记
 * - 分割线：---
 * - 表格：渲染成 Markdown 表格（尽力而为）；单元格作为表格块子块（table_cell）递归取文本
 * - 图片/文件/画板/思维笔记/表格外其它：生成占位符，保留信息不丢失
 */
function textOfBlock(byId, blockIdx, typeField) {
  const block = byId.get(blockIdx);
  return block && block[typeField] ? textsFromElements(block[typeField].elements) : '';
}

function blocksToMarkdown(byId, topLevelIds) {
  const lines = [];
  const seen = new Set();

  const render = (blockId, depth = 0) => {
    if (!blockId || seen.has(blockId)) return;
    seen.add(blockId);
    const b = byId.get(blockId);
    if (!b) return;
    const t = b.block_type;

    if (TEXT_BLOCK_FIELDS[t]) {
      const field = TEXT_BLOCK_FIELDS[t];
      const text = textOfBlock(byId, blockId, field);
      const prefix = prefixForBlockType(t);
      // 代码块内的子行不做额外分隔，直接按行; todo/列表按需加空格
      if (t === 14) {
        const codeLines = text.split('\n').map((l) => l.trim() ? `    ${l.trim()}` : '').join('\n');
        lines.push('```');
        if (codeLines) lines.push(codeLines);
        lines.push('```');
      } else if (t === 19) {
        // callout：引用样式，正文缩进
        const quoteLines = text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'));
        lines.push(quoteLines.join('\n'));
      } else {
        lines.push(`${prefix}${text}`.trimEnd());
      }
      // 块自身可能有子块（如 callout 内部、列表被 convert 拆成父子）——继续渲染子块
      if (Array.isArray(b.children)) for (const c of b.children) render(c, depth + 1);
      return;
    }

    if (t === BLOCK_TYPE_DIVIDER) {
      lines.push('---');
      return;
    }

    if (t === 31) {
      // 表格（block_type 31）：从后代 table_cell 尽力恢复
      const tableMd = renderTable(byId, b, seen);
      if (tableMd) lines.push(tableMd);
      else lines.push('[表格]');
      return;
    }

    // 图片：飞书 convert 可能把 <img> 存成 24 或带 image 字段的其它类型（实测 27），凡有 image 字段即视为图片
    if (b.image) {
      lines.push(`[图片]${b.image.token ? '' : '(无图)'}`);
      return;
    }
    // 其它类型（文件/画板/引用的多维表格等）
    if (BOARD_BLOCK_TYPES.has(t) || b.board) {
      const wb = boardTokenFromBlock(b);
      lines.push(wb ? `[画板 whiteboard_id=${wb}]` : '[画板]');
      return;
    }
    const label = blockTypeLabel(t);
    lines.push(label ? `[${label}]` : '[内容块]');
  };

  for (const id of topLevelIds) render(id);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textsFromElements(elements) {
  if (!Array.isArray(elements)) return '';
  return elements
    .map((el) => {
      if (!el) return '';
      if (el.text_run && typeof el.text_run.content === 'string') return el.text_run.content;
      if (el.mention_user) return `@${el.mention_user.user_id || el.mention_user.mention_user_style?.user_id || '用户'}`;
      if (el.mention_doc) return `[@文档]`;
      // 其它内联元素（超链接、emoji、图片等）尽力取其内容文本
      if (el.link) return el.link.text_run?.content || '';
      if (el.image) return '[图片]';
      return '';
    })
    .join('');
}

function prefixForBlockType(t) {
  if (t === 2) return '';
  if (t >= 3 && t <= 11) return '#'.repeat(t - 2) + ' ';
  if (t === 12) return '- ';
  if (t === 13) return '1. ';
  if (t === 15) return '> ';
  if (t === 16) return '- [ ] ';
  return '';
}

function blockTypeLabel(t) {
  const map = {
    23: '文件',
    24: '图片',
    26: '画板',
    30: '思维笔记',
    27: '图片', // 27 实际是图片块（lark-cli 抓取确认），非书签
    25: '多维表格',
    43: '画板',
    99: '表格',
  };
  return map[t] || null;
}

/**
 * 尽力把表格块渲染为 Markdown 表格。
 * 飞书表格：table(31) -> children 为 table_cell(32)，每个 table_cell 又有 children 为内容块。
 * 这里按单元格出现顺序收集为行；不足处留空，跨列/合并单元格不还原（尽力而为）。
 */
function renderTable(byId, tableBlock, seen) {
  const cellBlocks = [];
  const walk = (bid) => {
    const bb = byId.get(bid);
    if (!bb) return;
    if (bb.block_type === BLOCK_TYPE_TABLE_CELL) {
      cellBlocks.push(bb);
      // 单元格内的内容也标记为已渲染，避免外层再重复
      return;
    }
    for (const c of bb.children || []) walk(c);
  };
  for (const c of tableBlock.children || []) walk(c);

  if (cellBlocks.length === 0) return '';
  const cellText = cellBlocks.map((cb) => {
    const parts = [];
    for (const c of cb.children || []) {
      const bb = byId.get(c);
      if (bb && TEXT_BLOCK_FIELDS[bb.block_type]) {
        parts.push(textOfBlock(byId, c, TEXT_BLOCK_FIELDS[bb.block_type]));
      } else if (bb && bb.text) {
        parts.push(textOfBlock(byId, c, 'text'));
      }
    }
    return parts.join('').replace(/\|/g, '\\|').trim();
  });

  // 假设所有行等列数（取最大列数），把 cellText 按每行 cellCount 分组
  // 无法从块结构直接拿到行列，这里退化为单列列表：每格一行，用竖线表格包裹
  // 先尝试按「可能的列数」均分：飞书普通表格每行列数一致，这里按第一行单元格推断
  // 由于缺少 grid 信息，采用最稳的呈现：多行文本 + 分隔，避免错乱。
  const header = cellText[0];
  const body = cellText.slice(1);
  const lines = [`| ${header} |`, '| --- |'];
  for (const cell of body) lines.push(`| ${cell} |`);
  return lines.join('\n');
}
