import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const calls = [];
const now = Math.floor(Date.now() / 1000);
const env = {
  API_KEY: 'test-key',
  FEISHU_APP_ID: 'test-app',
  FEISHU_USER_TOKEN: {
    async get() { return { access_token: 'user-token', expires_at: now + 3600, refresh_token: 'refresh-token', refresh_expires_at: now + 86400 }; },
  },
};
const reply = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  const method = init.method || 'GET';
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  calls.push({ address, method, body, headers: init.headers || {} });
  if (method === 'DELETE' && address.endsWith('/tables/tbl123/records/rec123')) return reply({ record_id: 'rec123', deleted: true });
  if (method === 'DELETE' && address.endsWith('/tables/tbl123')) return reply({ table_id: 'tbl123', deleted: true });
  if (address.endsWith('/bitable/v1/apps') && method === 'POST') return reply({ app: { app_token: 'bascn123', name: body.name, url: 'https://feishu.cn/base/bascn123' } });
  if (address.endsWith('/search/v2/doc_wiki/search')) return reply({ res_units: [
    { title: '测试台账', result_meta: { token: 'bascn123', doc_types: 'BITABLE' } },
    { title: '共享台账', result_meta: { token: 'bascn999', doc_types: 'BITABLE' } },
  ], has_more: false });
  if (address.includes('/drive/v1/files?')) return reply({ files: [{ name: '测试台账', token: 'bascn123', type: 'bitable', parent_token: 'folder123' }], has_more: false });
  if (address.endsWith('/bitable/v1/apps/bascn123/tables') && method === 'POST') return reply({ table_id: 'tbl123', default_view_id: 'vew123' });
  if (address.endsWith('/bitable/v1/apps/bascn123/tables') && method === 'GET') return reply({ items: [{ table_id: 'tbl123', name: '客户' }], has_more: false });
  if (address.endsWith('/tables/tbl123/fields') && method === 'POST') return reply({ field: { field_id: 'fld123', field_name: body.field_name } });
  if (address.endsWith('/tables/tbl123/views') && method === 'POST') return reply({ view: { view_id: 'vew123' } });
  if (address.endsWith('/tables/tbl123/records/search') && method === 'POST') return reply({ items: [{ record_id: 'rec123', fields: { 客户: '甲' } }], has_more: false });
  if (address.endsWith('/tables/tbl123/records') && method === 'POST') return reply({ record: { record_id: 'rec123', fields: body.fields } });
  if (address.endsWith('/drive/v1/medias/upload_all')) return reply({ file_token: 'media123' });
  if (address.endsWith('/drive/v1/import_tasks') && method === 'POST') return reply({ ticket: 'ticket123' });
  if (address.endsWith('/drive/v1/import_tasks/ticket123')) return reply({ result: { job_status: 0, token: 'bascn123', url: 'https://feishu.cn/base/bascn123' } });
  if (address.endsWith('/drive/v1/export_tasks') && method === 'POST') return reply({ ticket: 'ticket456' });
  if (address.endsWith('/drive/v1/export_tasks/ticket456?token=bascn123')) return reply({ result: { job_status: 0, file_token: 'file123', file_size: 4 } });
  if (address.endsWith('/drive/v1/export_tasks/file/file123/download')) return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'application/octet-stream' } });
  if (address.endsWith('/drive/v1/files/bascn123?type=bitable') && method === 'DELETE') return reply({});
  return reply({});
};

async function request(action, data = {}, key = 'test-key') {
  const response = await worker.fetch(new Request('https://test.example/', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ action, ...data }),
  }), env);
  return { status: response.status, data: await response.json() };
}

let checks = 0;
function verify(condition, message) { assert.ok(condition, message); checks++; }

let out = await request('base_create', { name: '测试台账', folder_token: 'folder123' });
verify(out.data.success && out.data.app_token === 'bascn123', '创建 Base 返回标识');
verify(out.data.location.folder_token === 'folder123', '创建位置可见');
verify(calls.at(-1).body.folder_token === 'folder123', '创建请求传入文件夹');
verify(calls.at(-1).headers.Authorization === 'Bearer user-token', '用户身份优先');

out = await request('base_list', { with_location: true });
verify(out.data.items.length === 2 && out.data.items[0].token === 'bascn123', '查找已有 Base');
verify(out.data.items[0].location.parent_token === 'folder123', '查询结果包含文件夹位置');
verify(out.data.items[1].location_status === 'unresolved' && out.data.location_warning, '无法定位的表格明确标记');

out = await request('base_table_create', { app_token: 'bascn123', name: '客户', fields: [{ field_name: '客户', type: 1 }] });
verify(out.data.table_id === 'tbl123', '创建数据表');
verify(calls.at(-1).body.table.fields[0].field_name === '客户', '创建数据表携带字段');

out = await request('base_field_create', { app_token: 'bascn123', table_id: 'tbl123', field: { field_name: '金额', type: 2 } });
verify(out.data.field.field_id === 'fld123', '创建字段');

out = await request('base_view_create', { app_token: 'bascn123', table_id: 'tbl123', name: '全部客户' });
verify(out.data.view.view_id === 'vew123', '创建视图');

out = await request('base_record_create', { app_token: 'bascn123', table_id: 'tbl123', fields: { 客户: '甲' } });
verify(out.data.record.record_id === 'rec123', '新增记录');

out = await request('base_record_search', { app_token: 'bascn123', table_id: 'tbl123', filter: { conjunction: 'and', conditions: [] } });
verify(out.data.items[0].record_id === 'rec123', '筛选记录');
verify(calls.at(-1).body.filter.conjunction === 'and', '筛选条件传给飞书');

const csv = btoa('name\nAlice\n');
out = await request('base_import', { file_extension: 'csv', file_name: 'customers.csv', file_base64: csv, folder_token: 'folder123' });
verify(out.data.ticket === 'ticket123', '导入任务创建');
verify(calls.at(-1).body.point.mount_key === 'folder123', '导入指定位置');
verify(calls.some((item) => item.address.endsWith('/medias/upload_all') && item.body instanceof FormData), '源文件已上传');
out = await request('base_import_status', { ticket: 'ticket123' });
verify(out.data.ready && out.data.app_token === 'bascn123', '导入结果查询');

out = await request('base_export', { app_token: 'bascn123', file_extension: 'csv', table_id: 'tbl123' });
verify(out.data.ticket === 'ticket456', '导出任务创建');
verify(calls.at(-1).body.sub_id === 'tbl123', 'CSV 导出指定数据表');
out = await request('base_export_status', { ticket: 'ticket456', app_token: 'bascn123' });
verify(out.data.ready && out.data.file_token === 'file123', '导出结果查询');
out = await request('base_export_download', { file_token: 'file123' });
verify(out.data.file_base64 === 'AQIDBA==' && out.data.size === 4, '导出文件可下载');

out = await request('base_export', { app_token: 'bascn123', file_extension: 'csv' });
verify(!out.data.success && out.data.message.includes('table_id'), 'CSV 缺表标识时拒绝');
out = await request('base_import', { file_extension: 'exe', file_base64: csv });
verify(!out.data.success, '拒绝不支持的文件格式');
out = await request('base_get', { app_token: 'bad/token' });
verify(!out.data.success, '拒绝非法标识');
out = await request('base_delete', { app_token: 'bascn123' });
verify(!out.data.success, '删除前必须明确确认标识');
out = await request('base_create', { name: '未授权' }, 'wrong');
verify(out.status === 401, 'API_KEY 鉴权继续生效');

let countBefore = calls.length;
out = await request('base_record_delete', { app_token: 'bascn123', table_id: 'tbl123', record_id: 'rec123' });
verify(!out.data.success && calls.length === countBefore, '缺少确认标识时不发送删除记录请求');
out = await request('base_table_delete', { app_token: 'bascn123', table_id: 'tbl123', confirm_table_id: 'tbl999' });
verify(!out.data.success && calls.length === countBefore, '确认标识不匹配时不发送删除数据表请求');
out = await request('base_record_delete', { app_token: 'bascn123', table_id: 'tbl123', record_id: 'bad/id', confirm_record_id: 'bad/id' });
verify(!out.data.success && calls.length === countBefore, '非法记录标识不触发请求');
out = await request('base_record_delete', { app_token: 'bascn123', table_id: 'tbl123', record_id: 'rec123', confirm_record_id: 'rec123' });
verify(out.data.success && out.data.deleted && out.data.record_id === 'rec123', '删除单行成功');
verify(calls.at(-1).method === 'DELETE' && calls.at(-1).address.endsWith('/tables/tbl123/records/rec123'), '只向指定记录发出 DELETE');
out = await request('base_table_delete', { app_token: 'bascn123', table_id: 'tbl123', confirm_table_id: 'tbl123' });
verify(out.data.success && out.data.deleted && out.data.table_id === 'tbl123', '删除内部数据表成功');
verify(calls.at(-1).method === 'DELETE' && calls.at(-1).address.endsWith('/tables/tbl123'), '数据表删除不调用整份文件删除接口');
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ code: 99991679, msg: 'permission denied' }));
out = await request('base_record_delete', { app_token: 'bascn123', table_id: 'tbl123', record_id: 'rec123', confirm_record_id: 'rec123' });
verify(!out.data.success, '飞书拒绝删除时不能返回成功');
globalThis.fetch = previousFetch;
console.log(`多维表格测试：${checks} 项通过`);
