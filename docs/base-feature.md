# 多维表格功能说明与验收标准

## 功能与创建位置

本项目现有的文档写入接口增加了多维表格操作。调用方式仍是向 Worker 地址发送 `POST /`，请求体是 JSON，继续使用原有的 `x-api-key`。正常情况下以已授权的用户身份操作，因此新建的多维表格归该用户所有。用户授权失效且允许应用身份兜底时，返回 `identity=app`，并尝试把配置的用户加入为可管理成员；应检查 `permission_granted`。

`base_create` 的 `folder_token` 不填时在调用身份的云盘根目录创建；填写时在指定云盘文件夹创建。响应的 `location` 明确显示位置。`base_list` 查找当前身份可见的多维表格；传 `with_location:true` 时附加云盘路径和上级文件夹标识。位置扫描最多遍历 1500 项、6 层、20 次接口调用。扫描仍不能定位的表格标记 `location_status=unresolved`，并返回 `location_warning`；知识库或共享资源可能没有可用的个人云盘路径，不能把“位置未查到”当成“表格不存在”。列表采用分页，`has_more=true` 时继续传 `page_token`。

## 飞书多维表格通常能做什么

多维表格可以在一个文件中放多张数据表；每张表由字段（列）和记录（行）组成。字段可表示文字、数字、日期、选项、人员、附件或表间关联。视图让同一批记录以不同筛选和展示方式呈现；飞书还提供表单收集、公式计算、统计图表、自动化流程和成员权限等能力。以上是飞书产品能力，并不表示本 Worker 已实现了每一项。本次 Worker 接入的是下面列出的核心操作；表单、仪表盘、自动化和高级权限仍使用飞书网页或其他专门工具。

## 支持的操作

| 目标 | action | 主要参数 |
|---|---|---|
| 创建多维表格 | `base_create` | `name`、可选 `folder_token` |
| 查找、查看多维表格 | `base_list`、`base_get` | `query`、`with_location`；查看时传 `app_token` |
| 删除多维表格 | `base_delete` | `app_token` 和完全相同的 `confirm_app_token`；删除后进入飞书回收站 |
| 列出或创建数据表 | `base_table_list`、`base_table_create` | `app_token`；创建时传 `name`，可选 `fields` |
| 列出或创建字段 | `base_field_list`、`base_field_create` | `app_token`、`table_id`；创建时传 `field` |
| 列出或创建视图 | `base_view_list`、`base_view_create` | `app_token`、`table_id`；创建时传 `name` |
| 列出、筛选、新增、修改记录 | `base_record_list`、`base_record_search`、`base_record_create`、`base_record_update` | `app_token`、`table_id`；筛选用 `filter`，写入用 `fields` |
| 导入文件 | `base_import`、`base_import_status` | `file_extension`、`file_name`、`file_base64`；查询时传 `ticket` |
| 导出文件 | `base_export`、`base_export_status`、`base_export_download` | `app_token`、`file_extension`；查询时同时传 `ticket` 和 `app_token`，下载时传 `file_token` |

`app_token` 可传多维表格链接，也可传链接中的标识。表、字段、视图和记录的返回值保留飞书接口原有字段。创建记录前，先查询实际字段及其类型；日期、人员、附件等字段须按飞书要求填写，不能一律当作普通文字。

### 创建与查询示例

以下示例仅展示请求体。请求头仍须带项目现有的 `x-api-key`。

```json
{"action":"base_create","name":"客户台账","folder_token":"fldxxxxxxxx"}
```

```json
{"action":"base_list","query":"客户","with_location":true,"page_size":20}
```

```json
{"action":"base_table_create","app_token":"bascnxxxxxxxx","name":"客户","fields":[{"field_name":"客户名称","type":1}]}
```

```json
{"action":"base_record_search","app_token":"bascnxxxxxxxx","table_id":"tblxxxxxxxx","filter":{"conjunction":"and","conditions":[{"field_name":"客户名称","operator":"is","value":["张三"]}]}}
```

### 导入与导出

导入支持 `.xlsx`、`.csv`、`.base`。把文件内容编码为 Base64，放在 `file_base64`；`file_extension` 与 `file_name` 后缀须一致。不传 `app_token` 时新建多维表格，可用 `folder_token` 指定位置；传 `app_token` 时把数据导入已有多维表格。Worker 当前使用飞书的单次上传接口，文件上限为 8 MB。导入是异步任务：先取得 `ticket`，再调用 `base_import_status`，直到 `ready=true`。同一位置的多个导入任务应串行提交。

```json
{"action":"base_import","file_extension":"csv","file_name":"customers.csv","name":"客户台账","file_base64":"<文件的 Base64 内容>"}
```

导出支持 `xlsx`、`csv`、`base`。CSV 只导出一张数据表，必须传 `table_id`；`.base` 可用 `only_schema:true` 只导出结构。先通过 `base_export` 取得 `ticket`，再把 `ticket` 和原 `app_token` 一起传给 `base_export_status`，取得完成后的 `file_token`，最后用 `base_export_download` 下载。下载响应的 `file_base64` 需要解码并保存成文件；在线下载上限为 8 MB，较大文件请在飞书网页中导出。

```json
{"action":"base_export","app_token":"bascnxxxxxxxx","file_extension":"csv","table_id":"tblxxxxxxxx"}
```

## 授权与上线步骤

1. 在飞书开发者后台找到此 Worker 使用的自建应用。将 [`permissions.json`](permissions.json) 中新增的多维表格、导入和导出权限开通给用户与应用身份。申请开通后发布新版本；如需管理员审核，等审核通过。
2. 打开 Worker 的 `/auth/status`，检查 `has_base_create_scope`、`has_base_read_scope`、`has_base_record_search_scope`、`has_import_scope`、`has_export_scope`。已有长期用户授权并不等于新权限自动进入旧令牌。新增权限生效后，用户打开 `/auth/start` 授权页面并同意。
3. 运行本地测试：在 `GitHub发布` 目录执行 `node test/test-smoke.mjs` 与 `node test/test-base.mjs`。从项目根目录执行 `node_modules/.bin/wrangler.cmd deploy --dry-run`，确认打包成功。
4. 将 `GitHub发布` 内的改动提交并推送到 GitHub。根目录的 `worker.js` 与发布目录版本仅导入路径不同；根目录部署配置使用真实 Cloudflare KV 标识，发布目录配置是模板。
5. 从项目根目录运行 `node_modules/.bin/wrangler.cmd deploy`。上线后先检查 `GET /` 和 `/auth/status`，再在飞书中创建临时测试 Base，验证创建位置、字段、记录、查询、导出和导入。清理临时资源前核对归属和用途。

## 验收标准

| 检验项目 | 通过标准 |
|---|---|
| 原有文档功能 | 129 项既有测试全部通过；线上原有操作仍可调用 |
| 多维表格接口 | 27 项本地测试全部通过；非法标识、格式及缺少参数时明确拒绝 |
| 身份与权限 | 正常创建返回 `identity=user`；若走应用兜底，返回 `identity=app` 和用户管理权限授予结果；错误不会被伪装成成功 |
| 创建与位置 | 指定文件夹创建后返回该文件夹标识；根目录创建明确返回“云盘根目录”；在飞书网页能实际找到 |
| 查询 | 能找到已有多维表格；分页继续查询；能按字段条件筛选记录；不把未读取的页算入全量结果 |
| 导入 | CSV 或 XLSX 文件上传、任务完成并在飞书网页出现对应记录；失败时返回任务错误 |
| 导出 | XLSX、CSV 或 `.base` 任务完成后可下载并打开；CSV 需指定数据表 |
| 安全 | 不带正确 `x-api-key` 的请求被拒绝；令牌不写入日志或响应；用户身份和应用身份清楚标记 |

本地测试使用模拟的飞书响应，只能证明请求格式与流程。真正的权限、导入转换、文件可打开性和创建位置，需要在飞书应用授权生效后做线上验收。

## 本次实际验证记录（2026-10-27）

- 本地：原有文档功能 129 项测试通过；新增多维表格 27 项测试通过；Cloudflare 打包检查通过。
- 发布：GitHub 主分支已推送多维表格代码及位置查询修正；Cloudflare Worker 已部署，当前版本 `fb1a171d-921b-417a-96d6-67fe06d96934`。
- 线上已通过：以用户身份查找可见多维表格；在云盘根目录创建测试多维表格；创建数据表、字段、视图和记录；导出 XLSX 并下载得到有效的压缩格式文件（最近一次 8123 字节）；导入 CSV 并取得新多维表格。每次测试产生的两份临时表格均已调用删除接口清理。
- 位置查询实测：当前身份能搜到 2 个多维表格，其中 1 个可确认云盘路径；另 1 个不在当前身份可列出的云盘目录内。接口已改为明确标记其位置未确认，不猜测文件夹。
- 线上待复验：按字段条件筛选记录。首次调用得到飞书 `99991679`，明确缺少用户权限 `base:record:retrieve`。用户已报告在开发者后台开通权限；截至此记录写入时，`/auth/status` 仍显示 `has_base_record_search_scope=false`。需完成 `/auth/start` 用户重新授权后复测。
- 排查修复：导出任务首次创建成功，但状态查询返回 `99992402 field validation failed`。依据飞书官方 CLI 源码，状态查询还须带原多维表格标识；修正后线上导出和下载通过。

## 依据

- [飞书官方：创建多维表格](https://open.feishu.cn/document/introduction-2?lang=zh-CN)
- [飞书官方：新增记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create)
- [飞书官方 CLI：导入格式、任务与位置](https://github.com/larksuite/cli/blob/main/skills/lark-drive/references/lark-drive-import.md)
- [飞书官方 CLI：导出格式与任务](https://github.com/larksuite/cli/blob/main/skills/lark-drive/references/lark-drive-export.md)
- [飞书官方 CLI 源码：导出任务状态查询参数](https://github.com/larksuite/cli/blob/main/shortcuts/drive/drive_export_common.go)
