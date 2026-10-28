---
name: feishu-doc-writer
description: 调用 HTTP API 操作飞书在线文档与画板：新建/追加/替换/删除/读取文档，按名字搜索或列出云盘文档，以及创建/更新/读取画板（Mermaid/PlantUML/SVG）。当用户要把内容写入飞书、按文档名查找、列出云盘文件、读取文档，或画流程图/架构图画板时使用。这是工具技能，必须实际发送 HTTP 请求。
---

## 删除记录与内部数据表

删除单行用 `base_record_delete`，传 `app_token`、`table_id`、`record_id` 和相同的 `confirm_record_id`。删除内部数据表及其记录用 `base_table_delete`，传 `app_token`、`table_id` 和相同的 `confirm_table_id`。`base_delete` 删除整个多维表格文件。先查询核对用户指定的目标，不得混淆三种删除。新增权限为 `base:record:delete`、`base:table:delete`。

# 飞书文档写入技能（HTTP 工具）

本技能是一个 **HTTP 工具技能**：当用户要求操作飞书文档或画板时，**必须实际调用下面的接口**，不要只输出说明文字。

## 触发场景

用户说「写入飞书」「保存到飞书」「查找飞书文档」「找叫某某的文档」「列出我的飞书文档」「读取这篇文档」「往这篇追加」「画流程图/架构图到飞书画板」「更新画板」「看看画板」等。

## 接口信息（唯一入口）

- 地址：`{{WORKER_URL}}/`
- 方法：`POST`
- 请求头：
  - `Content-Type: application/json`
  - `x-api-key: {{API_KEY}}`（必填，缺少或错误返回 401）

### 请求体字段

- `action`（必填）：
  - 文档：`create` / `append` / `replace` / `delete` / `read`
  - 定点：`insert_after`（插到指定位置下方）/ `delete_range`（删除指定段或节）
  - 查找：`search`（按名字/关键词找文档）/ `list`（列出云盘文件）
  - 画板：`board_create` / `board_update` / `board_read`
- `after`：`insert_after` 的锚点原文（标题或段落全文）；也可用于 `delete_range`
- `target`：`delete_range` 要删的标题/段落原文
- `block_id` / `after_block_id`：已知块 ID 时直接定位
- `occurrence`：原文出现多次时取第几处（从 1 起）；不传则多处匹配会失败，不会猜
- `mode`：`delete_range` 用 `block`（只删这一块）/ `section`（从标题删到下一同级标题前）；默认标题按节、段落按块
- `format`（可选）：
  - 文档写入：`markdown`（默认）/ `html`
  - 画板写入：`mermaid`（默认）/ `plantuml` / `svg` / `raw`
- `content`：文档正文，或画板的 Mermaid/PlantUML/SVG 源码。`delete` / `read` / `search` / `list` / `board_read` 不需要；`board_create` 可省略（空白画板）
- `title`：新建文档标题（`create` / 无 `document_id` 的 `board_create`）
- `document_id`：文档 ID 或完整链接（`append` / `replace` / `delete` / `read` 必填；画板操作可用来定位文档内画板）
- `query`：`search` 的名字/关键词（可空=浏览；最长 30 字）
- `only_title`：`search` 是否只搜标题，默认 `true`（按文档名查找时保持 true）
- `doc_types`：可选，如 `docx,sheet,bitable,wiki`
- `folder_token`：`list` / `search` 限定文件夹；空=云盘根目录
- `page_size` / `page_token`：分页
- `recursive`：`list` 时是否有限递归子文件夹（默认 false）
- `whiteboard_id`：画板 token（`board_update` / `board_read`；也可只给 `document_id` 自动定位）
- `overwrite`：`board_update` 是否先清空再写，默认 true
- `width` / `height`：`board_create` 画板尺寸，默认 800×450

## 身份原则

默认使用飞书用户身份：成功响应里 `identity` 为 `user`，文档落在用户自己的云盘。

用户授权失效时，服务端可能改用应用身份兜底，响应会带 `identity=app` 和 `fallback=true`，`permission_granted` 表示是否已把用户加成「可管理」。遇到 `identity=app` 时：
- 文档所有者是应用，不是用户本人；
- 必须把响应里的 `auth_url` 交给用户，请他重新授权，之后新建的文档才会归他本人；
- 不得擅自改用飞书 CLI 或其他写入工具重试。

若返回 `code=USER_AUTH_REQUIRED`（说明服务端关闭了兜底），把 `auth_url` 交给用户，等他授权后再重试。

## 使用规则

1. 用户**只给了文档名字、没给链接**（「追加到《周报》」「读一下方案文档」）→ 先 `action=search`，`query` 用文档名，`only_title=true`。
   - 命中 1 篇：用返回的 `token`/`url` 作为 `document_id` 继续 `read` / `append` / `replace` / `delete`
   - 命中多篇：把标题 + 链接列给用户选，不要猜
   - 0 篇：说明没找到，问要不要新建
2. 用户说「列出我的飞书文档 / 看看云盘里有什么」→ `action=list`（根目录）或 `action=search` 且不传 query
3. 用户没有提供文档链接、也不是在找已有文档 → 默认 `action=create`
4. 用户提供了飞书文档链接 → 默认 `action=append`
5. 用户明确说「替换/覆盖」→ `replace`；「删除」→ `delete`；「读取/看看这篇」且已有链接 → `read`
6. 图片/表格列宽/高亮框/待办等富排版 → 文档 `format=html`
7. 用户要流程图、架构图、时序图、组织图、画板 → `board_create`（无文档则自动新建一篇），`format=mermaid`（思维导图/时序/流程图优先 Mermaid；复杂自定义图用 `svg`）
8. 更新已有画板 → `board_update`；只看画板 → `board_read`（可只传文档链接，接口会列出文档内画板）
9. 调用成功后展示 `url`；`search`/`list` 展示标题+链接；`read` 展示正文；`board_read` 说明节点数量
10. 失败时把 `message` 原样转达。`code=USER_AUTH_REQUIRED` 表示用户授权缺失或失效且兜底已关闭，向用户提供响应中的 `auth_url`；若响应出现 `identity=app`，说明本次由应用身份代建，要把 `auth_url` 交给用户并说明文档归属仍是应用。权限范围变化时先发布飞书应用版本，再访问该地址重新授权。不要访问旧的 GET `/auth/reset` 链接。
11. 用户说「插到某某下面 / 写到那个位置 / 删这一段 / 删这一节」→ 必须用 `insert_after` 或 `delete_range`，带上 `after`/`target`（或 `block_id`）。**禁止**因为插不准就 `append` 到文末，**禁止**因为插不准就 `replace` 整篇覆盖。找不到锚点就把 `message` 原样告诉用户，停止写入。

## 调用示例

### 按名字查找文档

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"search","query":"Q3 复盘","only_title":true}'
```

### 列出云盘根目录

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"list","page_size":50}'
```

### 新建文档（markdown）

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"create","title":"会议总结","content":"# 会议总结\n\n- 讨论了方案A\n- 决定下周上线"}'
```

### 读取

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"read","document_id":"https://xxx.feishu.cn/docx/Abc123"}'
```

### 插到指定标题下方

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"insert_after","document_id":"https://xxx.feishu.cn/docx/Abc123","after":"第一章","content":"插在第一章下面的内容"}'
```

### 删除指定段落

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"delete_range","document_id":"https://xxx.feishu.cn/docx/Abc123","target":"要删的这一段"}'
```

### 在文档中创建流程图画板

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"board_create","document_id":"https://xxx.feishu.cn/docx/Abc123","format":"mermaid","content":"graph TD; A[开始]-->B{判断}; B-->C[处理]"}'
```

### 读取画板

```bash
curl -X POST "{{WORKER_URL}}/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: {{API_KEY}}" \
  -d '{"action":"board_read","document_id":"https://xxx.feishu.cn/docx/Abc123"}'
```

## 成功响应要点

- `search` / `list`：`items[]` 含 `title`、`type`、`token`、`url`；把这些展示给用户，后续读写用 `token` 或 `url` 当 `document_id`
- `board_create` / `board_update`：返回 `whiteboard_id` 和文档 `url`
- `board_read`：一张画板时返回 `nodes`；文档内多张时返回 `boards[]`，再按 `whiteboard_id` 读一次
- `read` 遇到文档内画板时，正文里会出现 `[画板 whiteboard_id=xxx]`，可接着 `board_read`

## HTML 富内容（文档 `format=html`）

- **图片**：`<img src="data:image/png;base64,xxx" width="300"/>` 或 `<img src="https://...png" width="300"/>`
- **表格（可拖列宽）**：`<table><colgroup><col width="120"/><col width="300"/></colgroup>...`
- **字饰**：`<b>` `<em>` `<u>` `<del>` `<span text-color="red">` `<span background-color="light-yellow">`
- **分割线**：`<hr/>`
- **高亮框**：`<callout background-color="light-yellow" border-color="yellow" emoji="💡"><p>内容</p></callout>`
- **待办**：`<checkbox done="false">未完成</checkbox>`

颜色：文字 `red/orange/yellow/green/blue/purple/gray`；背景另支持 `light-{色}`、`medium-gray`、`light-gray`。书签/分栏暂以文本呈现。

## 错误处理

- HTTP 401：可能是 `x-api-key` 缺失或错误；若响应 `code=USER_AUTH_REQUIRED`，则是飞书用户授权失效且兜底关闭，按 `auth_url` 重新授权；`identity=app` 表示本次由应用身份兜底代写
- `99991672`：权限不足/文档未分享给应用
- `99991679`：用户授权缺权限——发布应用版本后访问 `{{WORKER_URL}}/auth/start` 重新授权
- `content` 超 100000 字符：精简或分段 append
- `search` 的 `query` 超过 30 字会被截断，只传核心文档名
