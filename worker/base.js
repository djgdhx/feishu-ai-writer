// 飞书多维表格（Base）接口。所有操作沿用主 Worker 的身份选择与 API_KEY 鉴权。
export const BASE_ACTIONS = [
  'base_create', 'base_list', 'base_get', 'base_delete',
  'base_table_list', 'base_table_create', 'base_table_delete',
  'base_field_list', 'base_field_create',
  'base_view_list', 'base_view_create',
  'base_record_list', 'base_record_search', 'base_record_create', 'base_record_update', 'base_record_delete',
  'base_import', 'base_import_status',
  'base_export', 'base_export_status', 'base_export_download',
];

const MAX_INLINE_FILE = 8 * 1024 * 1024;
const tokenPart = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) {
    throw new Error(`${label} 必须是有效的飞书标识；请传标识，不要传完整链接`);
  }
  return encodeURIComponent(value);
};
const baseToken = (input) => {
  if (typeof input !== 'string') return '';
  const match = input.match(/\/base\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : input.trim();
};
const qs = (params) => {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') out.set(key, String(value));
  }
  return out.size ? `?${out}` : '';
};
const pageSize = (value, max = 100) => Math.max(1, Math.min(max, Number(value) || 50));
const root = (token) => `/open-apis/bitable/v1/apps/${tokenPart(token, 'app_token')}`;
const tableRoot = (token, table) => `${root(token)}/tables/${tokenPart(table, 'table_id')}`;
const result = (action, identity, data) => ({ success: true, action, identity, ...data });
const invalid = (message) => ({ success: false, message });

function fileBytes(input, extension) {
  if (typeof input !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 !== 0) {
    throw new Error('file_base64 必须是合法的 Base64 文件内容');
  }
  if (input.length > Math.ceil(MAX_INLINE_FILE / 3) * 4) throw new Error('单次导入文件不能超过 8 MB');
  const binary = atob(input);
  if (!binary.length || binary.length > MAX_INLINE_FILE) throw new Error('导入文件必须在 1 字节到 8 MB 之间');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (extension === 'xlsx' && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error('xlsx 文件内容不是有效的 ZIP 格式');
  return bytes;
}

function bytesToBase64(bytes) {
  let output = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    output += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(output);
}

async function uploadImportFile(env, token, bytes, filename, extension) {
  const form = new FormData();
  form.set('file_name', filename);
  form.set('parent_type', 'ccm_import_open');
  form.set('size', String(bytes.byteLength));
  form.set('extra', JSON.stringify({ obj_type: 'bitable', file_extension: extension }));
  form.set('file', new Blob([bytes]), filename);
  const response = await fetch(`${env.FEISHU_BASE_URL || 'https://open.feishu.cn'}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const data = await response.json().catch(() => ({}));
  if (data.code !== 0 || !data.data?.file_token) throw new Error(`导入文件上传失败：code=${data.code} msg=${data.msg}`);
  return data.data.file_token;
}

async function downloadExport(env, token, fileToken) {
  const response = await fetch(`${env.FEISHU_BASE_URL || 'https://open.feishu.cn'}/open-apis/drive/v1/export_tasks/file/${tokenPart(fileToken, 'file_token')}/download`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`下载导出文件失败：HTTP ${response.status}`);
  const size = Number(response.headers.get('content-length')) || 0;
  if (size > MAX_INLINE_FILE) throw new Error('导出文件超过 8 MB；请改用飞书网页下载');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_INLINE_FILE) throw new Error('导出文件超过 8 MB；请改用飞书网页下载');
  return { file_base64: bytesToBase64(bytes), size: bytes.length, content_type: response.headers.get('content-type') || 'application/octet-stream' };
}

export async function handleBaseAction(env, body, deps) {
  const { action } = body;
  const { token, identity, api, search, list, grant } = deps;
  try {
    if (action === 'base_list') {
      // 搜索覆盖可见的云盘及知识库 Base；文件夹路径只对当前身份可列出的云盘项给出。
      const found = await search({ query: body.query || '', doc_types: ['BITABLE'], include_wiki: body.include_wiki !== false, page_size: pageSize(body.page_size, 20), page_token: body.page_token || '' });
      const items = (found.items || []).filter((item) => ['bitable', 'base'].includes(item.type));
      let locationWarning = '';
      if (body.with_location) {
        try {
          const drive = await list({ recursive: true, page_size: 200, folder_token: body.folder_token || '', max_calls: 20, max_items: 1500, max_depth: 6 });
          const paths = new Map((drive.items || []).map((item) => [item.token, item]));
          let unresolved = 0;
          for (const item of items) {
            const match = paths.get(item.token);
            if (match) {
              item.location = { path: match.path, parent_token: match.parent_token, source: 'drive' };
              item.location_status = 'found';
            } else {
              item.location_status = 'unresolved';
              unresolved += 1;
            }
          }
          if (drive.has_more) locationWarning = '云盘目录扫描达到上限，部分位置未确认；可传 folder_token 缩小范围';
          else if (unresolved) locationWarning = `${unresolved} 个表格不在当前身份可列出的云盘目录中，可能位于知识库或共享空间；位置未确认`;
        } catch (error) { locationWarning = `部分文件夹位置无法读取：${error.message}`; }
      }
      return result(action, identity, { items, count: items.length, has_more: found.has_more, page_token: found.page_token, location_warning: locationWarning || undefined });
    }

    if (action === 'base_create') {
      const name = String(body.name || '').trim();
      if (!name) return invalid('name（多维表格名称）不能为空');
      const folder = body.folder_token ? tokenPart(body.folder_token, 'folder_token') : '';
      const response = await api('/open-apis/bitable/v1/apps', { method: 'POST', body: { name, folder_token: folder }, token });
      const app = response.data?.app || response.data || {};
      const appToken = app.app_token || app.token;
      if (!appToken) throw new Error('飞书创建成功，但未返回 app_token');
      const permission = identity === 'app' ? await grant(appToken, 'bitable') : undefined;
      return result(action, identity, {
        app_token: appToken, name: app.name || name, url: app.url || `https://feishu.cn/base/${appToken}`,
        location: { folder_token: folder, label: folder ? '指定云盘文件夹' : '云盘根目录' },
        permission_granted: permission?.ok, permission_error: permission?.error,
      });
    }

    const appToken = baseToken(body.app_token || body.base_token || '');
    if (action === 'base_import') {
      const extension = String(body.file_extension || '').replace(/^\./, '').toLowerCase();
      if (!['xlsx', 'csv', 'base'].includes(extension)) return invalid('file_extension 只支持 xlsx、csv、base');
      const filename = String(body.file_name || `import.${extension}`).trim();
      if (!filename.toLowerCase().endsWith(`.${extension}`)) return invalid('file_name 后缀必须与 file_extension 一致');
      const bytes = fileBytes(body.file_base64, extension);
      const fileToken = await uploadImportFile(env, token, bytes, filename, extension);
      const payload = {
        file_extension: extension, file_token: fileToken, type: 'bitable',
        file_name: String(body.name || filename.slice(0, -(extension.length + 1))),
        point: { mount_type: 1, mount_key: body.folder_token ? tokenPart(body.folder_token, 'folder_token') : '' },
      };
      if (appToken) payload.token = tokenPart(appToken, 'app_token');
      const response = await api('/open-apis/drive/v1/import_tasks', { method: 'POST', body: payload, token });
      return result(action, identity, { ticket: response.data?.ticket, ready: false, target_app_token: appToken || undefined, location: { folder_token: payload.point.mount_key, label: payload.point.mount_key ? '指定云盘文件夹' : '云盘根目录' } });
    }
    if (action === 'base_import_status' || action === 'base_export_status') {
      const ticket = tokenPart(body.ticket, 'ticket');
      const scenario = action === 'base_import_status' ? 'import' : 'export';
      const taskPath = scenario === 'export'
        ? `/open-apis/drive/v1/export_tasks/${ticket}${qs({ token: tokenPart(baseToken(body.app_token || ''), 'app_token') })}`
        : `/open-apis/drive/v1/import_tasks/${ticket}`;
      const response = await api(taskPath, { token });
      const state = response.data?.result || {};
      const fileToken = scenario === 'export' ? state.file_token : state.token;
      const ready = state.job_status === 0 && !!fileToken;
      const permission = ready && scenario === 'import' && identity === 'app' ? await grant(state.token, 'bitable') : undefined;
      return result(action, identity, { ticket, ready, job_status: state.job_status, job_error_msg: state.job_error_msg || '', app_token: scenario === 'import' ? state.token : undefined, url: state.url, file_token: scenario === 'export' ? fileToken : undefined, file_name: state.file_name, file_size: state.file_size, permission_granted: permission?.ok, permission_error: permission?.error });
    }
    if (action === 'base_export_download') {
      const file = await downloadExport(env, token, body.file_token);
      return result(action, identity, { file_token: body.file_token, ...file });
    }
    if (!appToken) return invalid(`${action} 需要 app_token 或多维表格链接`);
    const app = root(appToken);
    if (action === 'base_delete') {
      if (body.confirm_app_token !== appToken) return invalid('删除多维表格前，confirm_app_token 必须与 app_token 完全一致');
      const response = await api(`/open-apis/drive/v1/files/${tokenPart(appToken, 'app_token')}?type=bitable`, { method: 'DELETE', token });
      return result(action, identity, { app_token: appToken, ...response.data });
    }
    if (action === 'base_export') {
      const extension = String(body.file_extension || 'xlsx').replace(/^\./, '').toLowerCase();
      if (!['xlsx', 'csv', 'base'].includes(extension)) return invalid('file_extension 只支持 xlsx、csv、base');
      if (extension === 'csv' && !body.table_id) return invalid('导出 CSV 必须提供 table_id');
      if (body.only_schema && extension !== 'base') return invalid('only_schema 仅适用于 base 格式');
      const payload = { token: appToken, type: 'bitable', file_extension: extension };
      if (extension === 'csv') payload.sub_id = tokenPart(body.table_id, 'table_id');
      if (body.only_schema) payload.only_schema = true;
      const response = await api('/open-apis/drive/v1/export_tasks', { method: 'POST', body: payload, token });
      return result(action, identity, { ticket: response.data?.ticket, ready: false, app_token: appToken, file_extension: extension });
    }
    if (action === 'base_get') {
      const response = await api(app, { token });
      return result(action, identity, { app: response.data?.app || response.data, url: `https://feishu.cn/base/${appToken}` });
    }

    const tableId = body.table_id;
    if (action === 'base_table_list') {
      const response = await api(`${app}/tables${qs({ page_size: pageSize(body.page_size), page_token: body.page_token })}`, { token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_table_create') {
      if (!body.name) return invalid('name（数据表名称）不能为空');
      const payload = { table: { name: body.name } };
      if (body.default_view_name) payload.table.default_view_name = body.default_view_name;
      if (body.fields) payload.table.fields = body.fields;
      const response = await api(`${app}/tables`, { method: 'POST', body: payload, token });
      return result(action, identity, { ...response.data });
    }
    if (!tableId) return invalid(`${action} 需要 table_id`);
    const table = tableRoot(appToken, tableId);
    if (action === 'base_table_delete') {
      if (body.confirm_table_id !== tableId) return invalid('删除数据表前，confirm_table_id 必须与 table_id 完全一致');
      const response = await api(table, { method: 'DELETE', token });
      return result(action, identity, { ...response.data, app_token: appToken, table_id: tableId });
    }
    if (action === 'base_record_delete') {
      const recordId = tokenPart(body.record_id, 'record_id');
      if (body.confirm_record_id !== body.record_id) return invalid('删除记录前，confirm_record_id 必须与 record_id 完全一致');
      const response = await api(`${table}/records/${recordId}`, { method: 'DELETE', token });
      return result(action, identity, { ...response.data, app_token: appToken, table_id: tableId, record_id: body.record_id });
    }
    if (action === 'base_field_list' || action === 'base_view_list' || action === 'base_record_list') {
      const segment = action === 'base_field_list' ? 'fields' : action === 'base_view_list' ? 'views' : 'records';
      const response = await api(`${table}/${segment}${qs({ page_size: pageSize(body.page_size, action === 'base_record_list' ? 500 : 100), page_token: body.page_token, view_id: action === 'base_record_list' ? body.view_id : undefined })}`, { token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_field_create') {
      if (!body.field || typeof body.field !== 'object' || !body.field.field_name || !Number.isInteger(body.field.type)) return invalid('field 需包含 field_name 和数字 type');
      const response = await api(`${table}/fields`, { method: 'POST', body: body.field, token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_view_create') {
      if (!body.name) return invalid('name（视图名称）不能为空');
      const response = await api(`${table}/views`, { method: 'POST', body: { view_name: body.name, view_type: body.view_type || 'grid' }, token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_record_search') {
      const query = { page_size: pageSize(body.page_size, 500), page_token: body.page_token, view_id: body.view_id, filter: body.filter, sort: body.sort, field_names: body.field_names, automatic_fields: body.automatic_fields };
      const response = await api(`${table}/records/search`, { method: 'POST', body: query, token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_record_create') {
      if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) return invalid('fields 必须是按字段名填写的对象');
      const response = await api(`${table}/records`, { method: 'POST', body: { fields: body.fields }, token });
      return result(action, identity, { ...response.data });
    }
    if (action === 'base_record_update') {
      if (!body.record_id || !body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields)) return invalid('record_id 和 fields 都必须提供');
      const response = await api(`${table}/records/${tokenPart(body.record_id, 'record_id')}`, { method: 'PUT', body: { fields: body.fields }, token });
      return result(action, identity, { ...response.data });
    }
    return invalid(`不支持的多维表格操作：${action}`);
  } catch (error) {
    return invalid(error.message || String(error));
  }
}
