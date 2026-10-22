/**
 * worker.js 冒烟测试（本地 mock 飞书接口，不真正调用飞书）
 * 运行：node test-smoke.mjs
 */
import worker from '../worker/worker.js';

// ---- 记录飞书 API 调用 ----
const calls = [];
let failRefresh = false;
let throwRefresh = false;
const tableBlockWithMergeInfo = {
  block_id: 'b_table',
  block_type: 31,
  parent_id: 'doc_root',
  table: { property: {}, merge_info: { x: 1 }, cells: [] },
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---- 模拟 fetch ----
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method || 'GET';
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
  const headers = init.headers || {};
  calls.push({ u, method, body, headers });

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  if (u.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
    return json({ code: 0, tenant_access_token: 't_123', expire: 7200 });
  }
  if (u.endsWith('/open-apis/docx/v1/documents/blocks/convert')) {
    // format=html 时：返回含占位符文本块 + 图片块 + 表格块的产物（模拟 convert 对标准 HTML 的产出）
    if (body && body.content_type === 'html') {
      return json({
        code: 0,
        data: {
          blocks: [
            { block_id: 'b_h1', block_type: 3, parent_id: 'doc_root', heading1: { elements: [{ text_run: { content: '标题' } }] } },
            { block_id: 'b_ext', block_type: 2, parent_id: 'doc_root', text: { elements: [{ text_run: { content: '[[EXT_0]]' } }] } },
            { block_id: 'b_img', block_type: 24, parent_id: 'doc_root', image: { url: 'https://example.com/a.png', token: '', width: 100, height: 100 } },
            { block_id: 'b_tbl', block_type: 31, parent_id: 'doc_root', table: { property: {} } },
          ],
          first_level_block_ids: ['b_h1', 'b_ext', 'b_img', 'b_tbl'],
        },
      });
    }
    // 默认 markdown
    return json({
      code: 0,
      data: {
        // 注意：blocks 数组故意乱序（模拟飞书 convert 无序返回），顺序由 first_level_block_ids 决定
        blocks: [
          { block_id: 'child1', block_type: 12, parent_id: '', bullet: { elements: [{ text_run: { content: '子项1' } }] } },
          { block_id: 'b3', block_type: 4, parent_id: 'doc_root', heading2: {} },
          { block_id: 'parent1', block_type: 13, parent_id: 'doc_root', ordered: { elements: [{ text_run: { content: '父列表' } }] }, children: ['child1', 'child2'] },
          { block_id: 'b1', block_type: 2, parent_id: 'doc_root', text: { elements: [{ text_run: { content: 'hello' } }] } },
          tableBlockWithMergeInfo,
          { block_id: 'child2', block_type: 12, parent_id: '', bullet: { elements: [{ text_run: { content: '子项2' } }] } },
          { block_id: 'b4', block_type: 22, parent_id: 'doc_root', divider: {} },
        ],
        first_level_block_ids: ['b1', 'parent1', 'b3', 'b_table', 'b4'],
      },
    });
  }
  // ---- html 富内容：图片下载（src 指向的远程 URL）----
  if (u.startsWith('https://example.com/') && method === 'GET') {
    return new Response('fakeimage', { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
  // ---- html 富内容：素材上传（multipart -> file_token）----
  if (u.endsWith('/open-apis/drive/v1/medias/upload_all') && method === 'POST') {
    return json({ code: 0, data: { file_token: 'tok_img_1' } });
  }
  if (u.endsWith('/open-apis/docx/v1/documents') && method === 'POST') {
    return json({ code: 0, data: { document: { document_id: 'doc_new', revision_id: 1, title: body.title, url: 'https://t.feishu.cn/docx/doc_new' } } });
  }
  const getDoc = u.match(/\/open-apis\/docx\/v1\/documents\/([^/]+)$/);
  if (getDoc && method === 'GET') {
    return json({ code: 0, data: { document: { document_id: getDoc[1], title: '读取测试文档', url: `https://t.feishu.cn/docx/${getDoc[1]}` } } });
  }
  // ---- create(html) 后：插入后 fetch 文档块，返回「占位图片块（token 空）」以便补 token（真实 block_id）----
  if (u.includes('/documents/doc_new/blocks') && u.includes('/blocks?page_size=500')) {
    return json({
      code: 0,
      data: {
        items: [
          { block_id: 'b_h1', block_type: 3, parent_id: 'doc_root', heading1: { elements: [{ text_run: { content: '标题' } }] } },
          { block_id: 'b_img', block_type: 27, parent_id: 'doc_root', image: { token: '', url: '', width: 100, height: 100 } },
        ],
        has_more: false,
        page_token: '',
      },
    });
  }
  // ---- 定点编辑：固定文档树 ----
  if (u.includes('/documents/doc_precise/')) {
    const preciseItems = [
      { block_id: 'doc_precise', block_type: 1, parent_id: '', children: ['ph1', 'pp1', 'ph2', 'pp2', 'ph3', 'pp3'] },
      { block_id: 'ph1', block_type: 3, parent_id: 'doc_precise', heading1: { elements: [{ text_run: { content: '第一章' } }] } },
      { block_id: 'pp1', block_type: 2, parent_id: 'doc_precise', text: { elements: [{ text_run: { content: '第一章正文' } }] } },
      { block_id: 'ph2', block_type: 4, parent_id: 'doc_precise', heading2: { elements: [{ text_run: { content: '第二章' } }] } },
      { block_id: 'pp2', block_type: 2, parent_id: 'doc_precise', text: { elements: [{ text_run: { content: '第二章正文' } }] } },
      { block_id: 'ph3', block_type: 3, parent_id: 'doc_precise', heading1: { elements: [{ text_run: { content: '第三章' } }] } },
      { block_id: 'pp3', block_type: 2, parent_id: 'doc_precise', text: { elements: [{ text_run: { content: '第三章正文' } }] } },
    ];
    if (u.includes('/descendant') && method === 'POST') {
      return json({ code: 0, data: {} });
    }
    if (u.includes('/children/batch_delete') && method === 'DELETE') {
      return json({ code: 0, data: {} });
    }
    if (u.includes('/children') && method === 'GET') {
      return json({
        code: 0,
        data: {
          items: ['ph1', 'pp1', 'ph2', 'pp2', 'ph3', 'pp3'].map((block_id) => ({ block_id })),
          has_more: false,
        },
      });
    }
    if (method === 'GET' && u.includes('/blocks')) {
      return json({ code: 0, data: { items: preciseItems, has_more: false, page_token: '' } });
    }
  }
  // ---- board_read：指定文档内的画板块 ----
  if (u.includes('/documents/doc_board/blocks')) {
    return json({
      code: 0,
      data: {
        items: [{
          block_id: 'bd1',
          block_type: 43,
          token: 'wb_token_1',
          board: { token: 'wb_token_1', width: 800, height: 450 },
        }],
        has_more: false,
        page_token: '',
      },
    });
  }
  // ---- read：文档全部块（分页，含各类型）----
  if (u.includes('/blocks?page_size=500') && !u.includes('/blocks/')) {
    return json({
      code: 0,
      data: {
        items: [
          { block_id: 't_h1', block_type: 3, parent_id: 'doc_root', heading1: { elements: [{ text_run: { content: '读取标题' } }] } },
          { block_id: 't_b1', block_type: 2, parent_id: 'doc_root', text: { elements: [{ text_run: { content: '读取正文' } }] } },
          { block_id: 't_li', block_type: 12, parent_id: 'doc_root', bullet: { elements: [{ text_run: { content: '读取列表' } }] } },
          { block_id: 't_div', block_type: 22, parent_id: 'doc_root', divider: {} },
          { block_id: 't_img', block_type: 24, parent_id: 'doc_root', image: { token: 'img' } },
        ],
        has_more: false,
        page_token: '',
      },
    });
  }
  // ---- read：根块 children（顶级顺序）---- 仅匹配 doc_read，避免与写入路径的 children 查询冲突
  if (u.includes('/documents/doc_read/') && u.includes('/children?page_size=500')) {
    return json({
      code: 0,
      data: { items: [{ block_id: 't_h1' }, { block_id: 't_b1' }, { block_id: 't_li' }, { block_id: 't_div' }, { block_id: 't_img' }], has_more: false },
    });
  }
  const children = u.match(/\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/children$/);
  if (children && method === 'POST') {
    if (body && Array.isArray(body.children) && body.children[0] && body.children[0].block_type === 43) {
      return json({
        code: 0,
        data: {
          children: [{
            block_id: 'blk_board',
            block_type: 43,
            token: 'wb_new_1',
            board: { token: 'wb_new_1', width: 800, height: 450 },
          }],
        },
      });
    }
    return json({ code: 0, data: {} });
  }
  if (u.includes('/open-apis/search/v2/doc_wiki/search') && method === 'POST') {
    const isWiki = !!(body && body.wiki_filter);
    return json({
      code: 0,
      data: {
        total: 1,
        has_more: false,
        page_token: '',
        res_units: [{
          title_highlighted: isWiki ? '<h>知识库周报</h>' : '<h>Q3 复盘</h>',
          summary_highlighted: '摘要',
          entity_type: isWiki ? 'WIKI' : 'DOC',
          result_meta: {
            doc_types: isWiki ? 'WIKI' : 'DOCX',
            url: isWiki ? 'https://feishu.cn/wiki/wk_1' : 'https://feishu.cn/docx/doc_q3',
            token: isWiki ? 'wk_1' : 'doc_q3',
            owner_name: '张三',
            update_time: 1700000000,
          },
        }],
      },
    });
  }
  if (u.includes('/open-apis/suite/docs-api/search/object') && method === 'POST') {
    return json({
      code: 0,
      data: {
        docs_entities: [{ docs_token: 'doc_old', docs_type: 'doc', title: '旧搜索命中', owner_id: 'ou_1' }],
        has_more: false,
        total: 1,
      },
    });
  }
  if (u.includes('/open-apis/drive/v1/files') && method === 'GET' && !u.includes('/files/') ) {
    return json({
      code: 0,
      data: {
        files: [
          { name: '周报', token: 'doc_list_1', type: 'docx', url: 'https://feishu.cn/docx/doc_list_1' },
          { name: '资料', token: 'fld_1', type: 'folder', url: 'https://feishu.cn/drive/folder/fld_1' },
        ],
        has_more: false,
        next_page_token: '',
      },
    });
  }
  if (u.includes('/nodes/plantuml') && method === 'POST') {
    return json({ code: 0, data: { node_id: 't1:1' } });
  }
  if (u.includes('/nodes/batch_delete') && method === 'DELETE') {
    return json({ code: 0, data: { client_token: 'c1' } });
  }
  const wbNodes = u.match(/\/open-apis\/board\/v1\/whiteboards\/([^/]+)\/nodes$/);
  if (wbNodes && method === 'GET') {
    return json({
      code: 0,
      data: { nodes: [{ id: 'o1:1', type: 'composite_shape', parent_id: '', text: { text: '开始' } }] },
    });
  }
  if (wbNodes && method === 'POST') {
    return json({ code: 0, data: { ids: ['svg1'] } });
  }
  // 创建后代块（descendant）mock
  const descendant = u.match(/\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/([^/]+)\/descendant/);
  if (descendant && method === 'POST') {
    return json({ code: 0, data: {} });
  }
  if (u.includes('/children?page_size=500')) {
    return json({ code: 0, data: { items: [{ block_id: 'x1' }, { block_id: 'x2' }], has_more: false } });
  }
  if (u.includes('/children/batch_delete') && method === 'DELETE') {
    return json({ code: 0, data: {} });
  }
  // 删除文档 mock
  const delFile = u.match(/\/open-apis\/drive\/v1\/files\/([^?]+)\?type=docx/);
  if (delFile && method === 'DELETE') {
    return json({ code: 0, data: {} });
  }
  // 协作者权限 mock（兜底给用户加可管理）
  if (u.includes('/open-apis/drive/v1/permissions/') && u.includes('/members') && method === 'POST') {
    return json({ code: 0, data: { member: { member_id: body && body.member_id, perm: body && body.perm } } });
  }
  // ---- OAuth mock ----
  if (u.endsWith('/open-apis/auth/v3/app_access_token/internal')) {
    return json({ code: 0, app_access_token: 'app_tok_1', expire: 7200 });
  }
  if (u.includes('/open-apis/authen/v1/oidc/access_token')) {
    return json({ code: 0, data: { access_token: 'user_tok_1', refresh_token: 'refresh_1', expires_in: 7200, refresh_token_expires_in: 2592000, scope: 'docx:document docx:document.block:convert drive:drive' } });
  }
  if (u.includes('/open-apis/authen/v1/oidc/refresh_access_token')) {
    if (throwRefresh) throw new Error('network unavailable');
    if (failRefresh) return json({ code: 99991663, msg: 'refresh failed' }, 401);
    return json({ code: 0, data: { access_token: 'user_tok_2', refresh_token: 'refresh_2', expires_in: 7200, refresh_token_expires_in: 2592000 } });
  }
  return json({ code: 999999, msg: 'unexpected url ' + u }, 400);
};

// 内存版 KV mock
function makeKV(store) {
  return {
    get: async (k, type) => {
      const v = store[k] ?? null;
      if (v === null) return null;
      return type === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : v;
    },
    put: async (k, v) => { store[k] = typeof v === 'string' ? v : JSON.stringify(v); },
    delete: async (k) => { delete store[k]; },
  };
}

// 模拟 Worker 运行时对象（带 KV）
const kvStore = { user_token: JSON.stringify({
  access_token: 'user_tok_1', refresh_token: 'refresh_1',
  expires_at: Math.floor(Date.now() / 1000) + 7200,
  refresh_expires_at: Math.floor(Date.now() / 1000) + 2592000,
}) };
const env = { FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'secret', FEISHU_USER_TOKEN: makeKV(kvStore) };

function makeRequest(method, url, { headers = {}, body } = {}) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---- 测试用例 ----
console.log('1) create：新建文档 + Markdown 转块写入');
{
  const res = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', title: '测试', content: '# 标题\n\n正文' } }), env);
  const data = await res.json();
  check('返回 success', data.success === true);
  check('返回 document_id 与 url', data.document_id === 'doc_new' && data.url === 'https://feishu.cn/docx/doc_new');
  check('block_count=7（保留 divider 和嵌套结构）', data.block_count === 7);
  const createDocCall = calls.find((c) => c.u.endsWith('/open-apis/docx/v1/documents') && c.method === 'POST');
  check('调用创建文档接口', !!createDocCall && createDocCall.body.title === '测试');
  const descCall = calls.find((c) => c.method === 'POST' && c.u.includes('/descendant'));
  check('调用创建后代块接口', !!descCall);
  check('children_id 按 first_level 顺序排列', descCall && JSON.stringify(descCall.body.children_id) === JSON.stringify(['b1', 'parent1', 'b3', 'b_table', 'b4']));
  check('descendant 含全部块（含子块）', descCall && Array.isArray(descCall.body.descendants) && descCall.body.descendants.length === 7);
  check('嵌套结构保持 ID 引用', descCall && descCall.body.descendants.find((b) => b.block_id === 'parent1') && Array.isArray(descCall.body.descendants.find((b) => b.block_id === 'parent1').children));
  const tableBlock = descCall ? descCall.body.descendants.find((b) => b.block_type === 31) : null;
  check('表格块的 merge_info 已被清理', tableBlock && tableBlock.table && tableBlock.table.merge_info === undefined);
}

console.log('2) append：缺少 document_id 应报错');
{
  const res = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'append', content: 'xxx' } }), env);
  const data = await res.json();
  check('返回失败且提示 document_id', data.success === false && data.message.includes('document_id'));
}

console.log('3) replace：先清空再写入');
{
  calls.length = 0;
  const res = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'replace', content: '# 替换', document_id: 'doc_exist' } }), env);
  const data = await res.json();
  check('返回 success', data.success === true);
  check('先拉取子块列表', calls.some((c) => c.u.includes('/children?page_size=500')));
  check('调用批量删除', calls.some((c) => c.method === 'DELETE' && c.u.includes('batch_delete')));
  check('删除区间为 [0,2)', calls.some((c) => c.method === 'DELETE' && c.body.start_index === 0 && c.body.end_index === 2));
  check('再写入新块', calls.some((c) => c.method === 'POST' && (c.u.includes('/descendant') || c.u.includes('/children'))));
  check('回填真实 url', data.url.includes('doc_exist'));
}

console.log('4) 鉴权：设置 API_KEY 后不带请求头应 401');
{
  const res = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: 'x' } }), { ...env, API_KEY: 'k1' });
  check('返回 401', res.status === 401);
  const ok = await worker.fetch(makeRequest('POST', 'https://test/', { headers: { 'x-api-key': 'k1' }, body: { action: 'create', content: 'x' } }), { ...env, API_KEY: 'k1' });
  check('带正确密钥返回 200', ok.status === 200);
}

console.log('5) 参数校验：action 非法 / content 为空');
{
  const r1 = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'delete', content: 'x' } }), env);
  check('非法 action 报错', (await r1.json()).success === false);
  const r2 = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: '   ' } }), env);
  check('空 content 报错', (await r2.json()).success === false);
}

console.log('6) 文档调用只使用用户身份');
{
  calls.length = 0;
  await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: 'x' } }), env);
  await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: 'y' } }), env);
  check('没有获取应用文档令牌', !calls.some((c) => c.u.includes('tenant_access_token')));
  check('内容转换使用用户令牌', calls.filter((c) => c.u.includes('/blocks/convert')).every((c) => c.headers.Authorization === 'Bearer user_tok_1'));
}

console.log('7) CORS：OPTIONS 预检返回 204 与跨域头');
{
  const res = await worker.fetch(new Request('https://test/', { method: 'OPTIONS' }), env);
  check('返回 204', res.status === 204);
  check('带 Access-Control-Allow-Origin', res.headers.get('Access-Control-Allow-Origin') === '*');
}

console.log('8) document_id 支持直接传完整链接（无需手动提取）');
{
  calls.length = 0;
  const res = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'append', content: 'x', document_id: 'https://t.feishu.cn/docx/doc_link_1?from=test' } }), env);
  const data = await res.json();
  check('从链接提取出 document_id', data.success === true && data.document_id === 'doc_link_1');
  check('返回拼接的文档链接', data.url === 'https://feishu.cn/docx/doc_link_1');
  check('写入目标为提取出的 ID', calls.some((c) => c.method === 'POST' && c.u.includes('/documents/doc_link_1/blocks')));
  const r2 = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'replace', content: 'x', document_id: 'doc_pure_id' } }), env);
  const d2 = await r2.json();
  check('纯 ID 也兼容', d2.success === true && d2.document_id === 'doc_pure_id');
}

console.log('9) OAuth：授权后 create 使用用户身份，文档落用户云盘');
{
  delete kvStore['user_token'];
  // 授权前状态
  const s0 = await worker.fetch(new Request('https://test/auth/status'), env);
  const d0 = await s0.json();
  check('授权前 authorized=false', d0.authorized === false);

  // /auth/start 应 302 跳转飞书授权页
  const r1 = await worker.fetch(new Request('https://test/auth/start'), env);
  check('auth/start 返回 302 跳转', r1.status === 302 && r1.headers.get('location').includes('open-apis/authen/v1/authorize'));

  // /auth/callback 用 code 换 token 并存储
  const r2 = await worker.fetch(new Request('https://test/auth/callback?code=abc123'), env);
  check('auth/callback 授权成功', r2.status === 200);
  const d2 = await worker.fetch(new Request('https://test/auth/status'), env).then((r) => r.json());
  check('授权后 authorized=true', d2.authorized === true);

  // create 应使用用户身份（携带 user token）
  calls.length = 0;
  const r3 = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', title: '用户文档', content: '# x' } }), env);
  const d3 = await r3.json();
  check('create 返回 identity=user', d3.success === true && d3.identity === 'user');
  const createCall = calls.find((c) => c.u.endsWith('/open-apis/docx/v1/documents') && c.method === 'POST');
  check('创建请求使用用户 token', createCall && createCall.headers && createCall.headers.Authorization === 'Bearer user_tok_1');
  const noKvCallback = await worker.fetch(new Request('https://test/auth/callback?code=no_kv'), { ...env, FEISHU_USER_TOKEN: undefined });
  check('缺少用户令牌存储时不能谎报授权成功', noKvCallback.status === 500);
}

console.log('10) OAuth：refresh_token 过期后自动刷新');
{
  // 模拟 access_token 过期
  kvStore['user_token'] = JSON.stringify({
    access_token: 'expired_tok',
    refresh_token: 'refresh_1',
    expires_at: Math.floor(Date.now() / 1000) - 100,
    refresh_expires_at: Math.floor(Date.now() / 1000) + 999999,
  });
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: '# x' } }), env);
  const d = await r.json();
  check('刷新后仍成功写入', d.success === true);
  check('调用过刷新接口', calls.some((c) => c.u.includes('refresh_access_token')));
  const createCall = calls.find((c) => c.u.endsWith('/open-apis/docx/v1/documents') && c.method === 'POST');
  check('使用刷新后的新 token', createCall && createCall.headers && createCall.headers.Authorization === 'Bearer user_tok_2');
  check('刷新令牌有效期随刷新结果更新', JSON.parse(kvStore['user_token']).refresh_expires_at > Math.floor(Date.now() / 1000) + 2500000);
  // 还原
  delete kvStore['user_token'];
}

console.log('11) 用户授权失效：严格模式拒绝，兜底模式用应用身份并给用户可管理');
{
  delete kvStore['user_token'];
  const envStrict = { ...env, ALLOW_APP_FALLBACK: 'false' };

  // ---- 严格模式（ALLOW_APP_FALLBACK=false）：直接拒绝，一字不写 ----
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: '# x' } }), envStrict);
  const d = await r.json();
  check('严格模式：未授权 create 返回 401 和授权地址', r.status === 401 && d.code === 'USER_AUTH_REQUIRED' && d.auth_url === 'https://test/auth/start');
  check('严格模式：未授权时不调用文档接口', calls.length === 0);

  const protectedActions = [
    { action: 'append', document_id: 'doc_exist', content: 'x' },
    { action: 'replace', document_id: 'doc_exist', content: 'x' },
    { action: 'delete', document_id: 'doc_exist' },
    { action: 'read', document_id: 'doc_exist' },
    { action: 'search', query: '测试' },
    { action: 'list' },
    { action: 'board_create', document_id: 'doc_exist', format: 'mermaid', content: 'graph TD; A-->B;' },
    { action: 'board_update', whiteboard_id: 'wb_token_1', format: 'mermaid', content: 'graph TD; A-->B;' },
    { action: 'board_read', whiteboard_id: 'wb_token_1' },
    { action: 'insert_after', document_id: 'doc_exist', after: '标题', content: 'x' },
    { action: 'delete_range', document_id: 'doc_exist', target: '标题' },
  ];
  for (const body of protectedActions) {
    calls.length = 0;
    const response = await worker.fetch(makeRequest('POST', 'https://test/', { body }), envStrict);
    const result = await response.json();
    check(`严格模式：未授权 ${body.action} 拒绝且不调用飞书`, response.status === 401 && result.code === 'USER_AUTH_REQUIRED' && result.auth_url === 'https://test/auth/start' && calls.length === 0);
  }

  kvStore['user_token'] = JSON.stringify({ access_token: 'expired', refresh_token: 'expired', expires_at: 1, refresh_expires_at: 1 });
  calls.length = 0;
  const expired = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'append', document_id: 'doc_exist', content: 'x' } }), envStrict);
  check('严格模式：刷新授权过期时拒绝追加', expired.status === 401 && (await expired.json()).code === 'USER_AUTH_REQUIRED');
  check('严格模式：刷新授权过期时不调用文档接口', calls.length === 0);

  kvStore['user_token'] = JSON.stringify({ access_token: 'expired', refresh_token: 'bad', expires_at: 1, refresh_expires_at: Math.floor(Date.now() / 1000) + 300 });
  failRefresh = true;
  calls.length = 0;
  const failed = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'board_create', title: '画板' } }), envStrict);
  check('严格模式：刷新失败时拒绝新建画板', failed.status === 401 && (await failed.json()).code === 'USER_AUTH_REQUIRED');
  check('严格模式：刷新失败时没有调用文档接口', !calls.some((c) => c.u.includes('/docx/') || c.u.includes('/board/')));
  failRefresh = false;
  throwRefresh = true;
  calls.length = 0;
  const offline = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', content: 'x' } }), envStrict);
  check('严格模式：刷新网络异常时仍返回重新授权提示', offline.status === 401 && (await offline.json()).code === 'USER_AUTH_REQUIRED');
  check('严格模式：刷新网络异常时不创建文档', !calls.some((c) => c.u.includes('/docx/')));
  throwRefresh = false;
  delete kvStore['user_token'];

  // ---- 兜底模式（默认开启）：用应用身份，但必须给用户可管理并明确标记身份 ----
  calls.length = 0;
  const fb = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', title: '兜底', content: '正文' } }), env);
  const fbd = await fb.json();
  check('兜底：create 仍然成功（服务不掉线）', fb.status === 200 && fbd.success === true);
  check('兜底：响应标记 identity=app 且 fallback=true', fbd.identity === 'app' && fbd.fallback === true);
  check('兜底：响应给出重新授权地址', fbd.auth_url === 'https://test/auth/start');
  check('兜底：自动给用户加可管理（permission_granted）', fbd.permission_granted === true && typeof fbd.identity_warning === 'string');
  const fbCreate = calls.find((c) => c.method === 'POST' && c.u.endsWith('/open-apis/docx/v1/documents'));
  check('兜底：创建文档使用应用令牌', !!fbCreate && fbCreate.headers.Authorization === 'Bearer t_123');
  const grant = calls.find((c) => c.method === 'POST' && c.u.includes('/open-apis/drive/v1/permissions/'));
  check('兜底：把 OWNER_OPEN_ID 加成 full_access', !!grant && grant.body.perm === 'full_access' && grant.body.member_id === 'ou_e9c4837f3984a02f28efae559baa9824' && grant.body.member_type === 'openid');

  calls.length = 0;
  const fbRead = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'read', document_id: 'doc_exist' } }), env);
  const fbrd = await fbRead.json();
  check('兜底：其他动作同样标记应用身份并给出授权地址', fbrd.success === true && fbrd.identity === 'app' && fbrd.fallback === true && typeof fbrd.auth_url === 'string');

  calls.length = 0;
  const envOwner = { ...env, OWNER_OPEN_ID: 'ou_custom_owner' };
  await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', title: 'X', content: 'y' } }), envOwner);
  const grantCustom = calls.find((c) => c.method === 'POST' && c.u.includes('/open-apis/drive/v1/permissions/'));
  check('兜底：OWNER_OPEN_ID 可覆盖默认值', !!grantCustom && grantCustom.body.member_id === 'ou_custom_owner');

  // 状态接口要能看出兜底开没开
  kvStore['user_token'] = JSON.stringify({ access_token: 'user_tok_1', refresh_token: 'refresh_1', expires_at: Math.floor(Date.now() / 1000) + 7200, refresh_expires_at: Math.floor(Date.now() / 1000) + 2592000 });
  const st = await worker.fetch(new Request('https://test/auth/status'), env).then((x) => x.json());
  check('状态接口显示兜底已开启', st.app_fallback_enabled === true);
  const stStrict = await worker.fetch(new Request('https://test/auth/status'), envStrict).then((x) => x.json());
  check('状态接口显示严格模式已关闭兜底', stStrict.app_fallback_enabled === false);
  delete kvStore['user_token'];
}

console.log('12) OAuth：/auth/reset 清除授权');
{
  // 先确保有授权
  await worker.fetch(new Request('https://test/auth/callback?code=reset_test'), env);
  const before = await worker.fetch(new Request('https://test/auth/status'), env).then((r) => r.json());
  check('reset 前已授权', before.authorized === true);
  const unsafeGet = await worker.fetch(new Request('https://test/auth/reset'), { ...env, API_KEY: 'k1' });
  check('GET 不能清除授权', unsafeGet.status === 405 && (await worker.fetch(new Request('https://test/auth/status'), env).then((x) => x.json())).authorized === true);
  const unauthorizedPost = await worker.fetch(new Request('https://test/auth/reset', { method: 'POST' }), { ...env, API_KEY: 'k1' });
  check('未带密钥的 POST 不能清除授权', unauthorizedPost.status === 401 && (await worker.fetch(new Request('https://test/auth/status'), env).then((x) => x.json())).authorized === true);
  const rr = await worker.fetch(makeRequest('POST', 'https://test/auth/reset', { headers: { 'x-api-key': 'k1' } }), { ...env, API_KEY: 'k1' });
  const dr = await rr.json();
  check('reset 返回成功', dr.success === true);
  const after = await worker.fetch(new Request('https://test/auth/status'), env).then((r) => r.json());
  check('reset 后未授权', after.authorized === false);
}

console.log('13) delete：用用户身份删除文档');
{
  // 先授权
  await worker.fetch(new Request('https://test/auth/callback?code=del_test'), env);
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'delete', document_id: 'https://t.feishu.cn/docx/doc_to_del' } }), env);
  const d = await r.json();
  check('delete 返回成功', d.success === true && d.action === 'delete');
  check('delete 使用用户身份', d.identity === 'user');
  check('调用删除接口且用 user token', calls.some((c) => c.method === 'DELETE' && c.u.includes('/drive/v1/files/doc_to_del') && c.headers.Authorization === 'Bearer user_tok_1'));
  check('缺少 document_id 报错', (await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'delete' } }), env)).json().then((j) => j.success === false));
}

console.log('14) read：读取文档内容为 Markdown');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'read', document_id: 'doc_read' } }), env);
  const d = await r.json();
  check('read 返回 success', d.success === true && d.action === 'read');
  check('read 返回 Markdown 正文', typeof d.content === 'string' && d.content.includes('# 读取标题'));
  check('read 正文含正文/列表/分割线', d.content.includes('读取正文') && d.content.includes('- 读取列表') && d.content.includes('---'));
  check('read 图片以占位符标注', d.content.includes('[图片]'));
  check('read 返回 document_id', d.document_id === 'doc_read');
  check('read 缺 document_id 报错', (await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'read' } }), env)).json().then((j) => j.success === false));
}

console.log('15) format=html：图片上传 + 表格列宽 + 扩展块注入');
{
  calls.length = 0;
  const html = '<div>你好</div>' +
    '<callout background-color="yellow" emoji="💡">重点：<b>加粗</b></callout>' +
    '<img src="https://example.com/a.png"/>' +
    '<table><colgroup><col width="100"><col width="200"></colgroup><tr><td>A</td><td>B</td></tr></table>';
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', format: 'html', title: '富内容', content: html } }), env);
  const d = await r.json();
  check('format=html create 返回 success', d.success === true);
  check('convert 以 html 调用（content_type=html）', calls.some((c) => c.u.includes('/blocks/convert') && c.body && c.body.content_type === 'html'));
  check('触发图片下载', calls.some((c) => c.u === 'https://example.com/a.png'));
  check('触发素材上传拿 token', calls.some((c) => c.u.endsWith('/open-apis/drive/v1/medias/upload_all') && c.method === 'POST'));

  const descCall = calls.find((c) => c.method === 'POST' && c.u.includes('/descendant'));
  const blk = (bid) => descCall.body.descendants.find((b) => b.block_id === bid);
  check('写入后代块接口被调用', !!descCall);
  check('图片块插入时无 token（走先建块后补token流程）', blk('b_img') && blk('b_img').image && !blk('b_img').image.token);
  check('插入后经 replace_image PATCH 设 token', calls.some((c) => c.method === 'PATCH' && c.u.includes('/blocks/b_img') && c.body && c.body.replace_image && c.body.replace_image.token === 'tok_img_1'));
  check('表格列宽已应用', blk('b_tbl') && Array.isArray(blk('b_tbl').table.property.column_width) && JSON.stringify(blk('b_tbl').table.property.column_width) === JSON.stringify([100, 200]));
  check('扩展块(高亮框)已注入为 callout', blk('b_ext') && blk('b_ext').block_type === 19 && blk('b_ext').callout && blk('b_ext').callout.style && blk('b_ext').callout.style.background_color === 3);
}

console.log('16) format=html：格式非法应报错');
{
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'create', format: 'txt', content: 'x' } }), env);
  const d = await r.json();
  check('非法 format 报错（默认 markdown 不受影响）', d.success === false && d.message.includes('format'));
}

console.log('17) search：按名字查找文档');
{
  await worker.fetch(new Request('https://test/auth/callback?code=search_test'), env);
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'search', query: 'Q3 复盘' } }), env);
  const d = await r.json();
  check('search 返回 success', d.success === true && d.action === 'search');
  check('search 命中标题含查询词', Array.isArray(d.items) && d.items.some((it) => it.title.includes('Q3 复盘') || it.title.includes('知识库周报')));
  check('search 返回 token 与 url', d.items[0] && d.items[0].token && d.items[0].url);
  check('调用了 search v2 接口', calls.some((c) => c.u.includes('/search/v2/doc_wiki/search') && c.method === 'POST'));
  check('query 写入请求体', calls.some((c) => c.body && c.body.query === 'Q3 复盘'));
  const empty = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'search' } }), env).then((x) => x.json());
  check('search 允许空 query（浏览）', empty.success === true);
}

console.log('18) list：列出云盘文件');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'list' } }), env);
  const d = await r.json();
  check('list 返回 success', d.success === true && d.action === 'list');
  check('list 返回文件项', d.count >= 2 && d.items.some((it) => it.name === '周报'));
  check('调用 drive files list', calls.some((c) => c.method === 'GET' && c.u.includes('/open-apis/drive/v1/files')));
}

console.log('19) board_create：插入画板并写入 Mermaid');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: {
      action: 'board_create',
      document_id: 'doc_exist',
      format: 'mermaid',
      content: 'graph TD; A-->B;',
    },
  }), env);
  const d = await r.json();
  check('board_create 返回 success', d.success === true && d.action === 'board_create');
  check('返回 whiteboard_id', d.whiteboard_id === 'wb_new_1');
  check('插入了 block_type 43 画板块', calls.some((c) => c.method === 'POST' && c.u.includes('/children') && c.body && c.body.children && c.body.children[0].block_type === 43));
  check('调用 plantuml/mermaid 写入', calls.some((c) => c.u.includes('/nodes/plantuml') && c.body && c.body.syntax_type === 2));
}

console.log('20) board_read：读取画板节点 / 列出文档内画板');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'board_read', whiteboard_id: 'wb_token_1' } }), env);
  const d = await r.json();
  check('board_read 返回 success', d.success === true && d.action === 'board_read');
  check('board_read 返回节点', d.node_count === 1 && Array.isArray(d.nodes));
  const r2 = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'board_read', document_id: 'doc_board' } }), env);
  const d2 = await r2.json();
  check('board_read 可从文档定位画板', d2.success === true && (d2.whiteboard_id === 'wb_token_1' || (d2.boards && d2.boards[0] && d2.boards[0].whiteboard_id === 'wb_token_1')));
  const miss = await worker.fetch(makeRequest('POST', 'https://test/', { body: { action: 'board_read' } }), env).then((x) => x.json());
  check('board_read 缺参数报错', miss.success === false);
}

console.log('21) board_update：覆盖写入 SVG');
{
  calls.length = 0;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>';
  const r = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'board_update', whiteboard_id: 'wb_token_1', format: 'svg', content: svg },
  }), env);
  const d = await r.json();
  check('board_update 返回 success', d.success === true && d.action === 'board_update');
  check('覆盖前删除旧节点', calls.some((c) => c.method === 'DELETE' && c.u.includes('/nodes/batch_delete')));
  check('写入 svg 节点', calls.some((c) => c.method === 'POST' && /\/whiteboards\/[^/]+\/nodes$/.test(c.u) && c.body && c.body.nodes && c.body.nodes[0].type === 'svg'));
}

console.log('22) insert_after：插到指定标题下方，找不到锚点则拒绝');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', document_id: 'doc_precise', after: '第一章', content: '插入块' },
  }), env);
  const d = await r.json();
  check('insert_after 返回 success', d.success === true && d.action === 'insert_after');
  const desc = calls.filter((c) => c.method === 'POST' && c.u.includes('/descendant'));
  check('descendant 插在第一章后面（index=1）', desc.some((c) => c.body && c.body.index === 1));
  check('父块是文档根，不是另开一篇', desc.some((c) => c.u.includes('/documents/doc_precise/blocks/doc_precise/descendant')));
  check('响应声明插在第一章下方', d.after && d.after.text === '第一章');

  const miss = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', document_id: 'doc_precise', after: '不存在的锚点xyz', content: 'x' },
  }), env).then((x) => x.json());
  check('找不到锚点则失败', miss.success === false && String(miss.message).includes('找不到'));

  calls.length = 0;
  await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', document_id: 'doc_precise', after: '不存在的锚点xyz', content: 'x' },
  }), env);
  check('找不到锚点时不写 descendant', !calls.some((c) => c.u.includes('/descendant')));

  const noAfter = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', document_id: 'doc_precise', content: 'x' },
  }), env).then((x) => x.json());
  check('缺 after 报错', noAfter.success === false);

  const noDoc = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', after: '第一章', content: 'x' },
  }), env).then((x) => x.json());
  check('缺 document_id 报错', noDoc.success === false);

  const multi = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'insert_after', document_id: 'doc_precise', after: '正文', content: 'x' },
  }), env).then((x) => x.json());
  check('多处匹配则拒绝猜测', multi.success === false && Array.isArray(multi.matches) && multi.matches.length >= 2);
}

console.log('23) delete_range：只删指定段/节，其余不动');
{
  calls.length = 0;
  const r = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'delete_range', document_id: 'doc_precise', target: '第二章正文' },
  }), env);
  const d = await r.json();
  check('delete_range 单段返回 success', d.success === true && d.action === 'delete_range');
  check('只删一个块', d.deleted_count === 1);
  check('删除区间为 [3,4)', calls.some((c) => c.method === 'DELETE' && c.u.includes('batch_delete') && c.body.start_index === 3 && c.body.end_index === 4));

  calls.length = 0;
  const r2 = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'delete_range', document_id: 'doc_precise', target: '第二章' },
  }), env);
  const d2 = await r2.json();
  check('删标题时按节删除（标题+正文）', d2.success === true && d2.deleted_count === 2);
  check('节删除区间为 [2,4)', calls.some((c) => c.method === 'DELETE' && c.body.start_index === 2 && c.body.end_index === 4));

  const miss = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'delete_range', document_id: 'doc_precise', target: '没有这段' },
  }), env).then((x) => x.json());
  check('找不到目标则失败且不删', miss.success === false);

  const noTarget = await worker.fetch(makeRequest('POST', 'https://test/', {
    body: { action: 'delete_range', document_id: 'doc_precise' },
  }), env).then((x) => x.json());
  check('缺 target 报错', noTarget.success === false);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
