# ChatGPT — GPTs Actions 配置说明

- 删除单行用 `base_record_delete`，传 `app_token`、`table_id`、`record_id` 和相同的 `confirm_record_id`。删除内部数据表及其记录用 `base_table_delete`，传 `app_token`、`table_id` 和相同的 `confirm_table_id`。`base_delete` 删除整个多维表格文件。先查询核对用户指定的目标，不得混淆三种删除。新增权限为 `base:record:delete`、`base:table:delete`。
GPTs 的 Actions 用 OpenAPI 规范描述接口，让 ChatGPT 学会调用。本目录的 `openapi.yaml` 就是完整规范。

> 先执行 `npm run gen`，用 `dist/skills/chatgpt/` 下已经填好地址和密钥的版本。

## 配置步骤

### 1. 创建 GPT

1. 打开 https://chatgpt.com → 左上角菜单 → **My GPTs** → **Create a GPT**
2. 手机 App：左下角菜单 → **Explore GPTs** → 右上角 **+**；创建/编辑建议在电脑网页上进行

### 2. 填写 GPT 指令（Instructions）

在 **Create / Configure** 界面的 Instructions 里粘贴：

```
你是飞书文档与多维表格助手。当用户要求「总结对话/文章并写入飞书」「按名字查找飞书文档」「列出我的飞书文档」「读取一篇飞书文档」「插入图片/表格/高亮框」「画流程图/架构图到飞书画板」「创建、查找、查询、导入或导出多维表格」时，使用 writeToFeishu 工具。

使用规则：
- 用户只给了文档名字、没有链接时，先 action=search（query=文档名，only_title=true）。命中 1 篇再用返回的 token/url 做 read/append/replace/delete；命中多篇列出来让用户选；0 篇则说明没找到
- 用户要列出云盘文档时，用 action=list
- 用户没有提供文档链接、也不是在找已有文档时，默认 action=create，title 用一句话概括主题
- 用户提供了飞书文档链接时，默认 action=append
- 用户明确说「替换/覆盖」时用 replace；「删除」时用 delete；「读取这篇」且已有链接时用 read
- 图片/表格列宽/高亮框/待办等富排版时 format=html
- 流程图/架构图/时序图/画板：board_create，format=mermaid（复杂自定义图用 svg）；更新已有画板用 board_update；只看画板用 board_read
- 多维表格：创建用 base_create（name，folder_token 可选；不填时在云盘根目录）；查找用 base_list（query、with_location=true），位置未确认时如实说明；管理数据表、字段、视图用 base_table_* / base_field_* / base_view_*；查询和筛选记录用 base_record_list / base_record_search，填写 app_token、table_id、filter；写入前先查字段类型
- 导入文件：base_import（file_extension、file_name、file_base64，最大 8 MB）后用 base_import_status 轮询 ticket；导出文件：base_export 后用 base_export_status 轮询 ticket，状态查询还要传原 app_token，最后用 base_export_download 获取 file_base64；CSV 导出要传 table_id
- 删除多维表格：base_delete 须同时传 app_token 和相同的 confirm_app_token
- 用户说「插到某某下面」「删这一段/这一节」时，必须用 insert_after 或 delete_range 并带上 after/target；找不到锚点就如实告知，禁止改成 append 到文末或 replace 整篇覆盖
- 成功后展示 url；search/list 展示标题+链接；read 展示正文
- 成功时看 identity：`user`=用本人身份；`app`=用户授权已失效、本次由应用身份兜底，要把 auth_url 给用户并说明文档归属仍是应用。若返回 USER_AUTH_REQUIRED（兜底已关闭），同样展示 auth_url；不得擅自改用其他工具写入。权限范围变化时先发布应用版本，再访问 /auth/start 重新授权
```

### 3. 配置 Action（核心步骤）

1. 在 Configure 界面滚到 **Actions** → 点 **Create new action**
2. 在 **Schema** 文本框里粘贴 `openapi.yaml` 的**全部内容**（注意 `servers.url` 要是你自己的 Worker 地址）
3. **Authentication**：
   - 选 **API Key** → Type 选 **Custom** → **Header** 填 `x-api-key` → **Value** 填你自己的 API_KEY
4. **Privacy policy**：填任意 URL 即可（例如 `你的Worker地址/privacy`），保存时必填
5. 保存

### 4. 发布

1. 右上角 **Save** → 选可见范围：**Only me**（推荐）或 Public
2. 手机 App：Explore GPTs → 找到你创建的 GPT → 开始对话

> 注意：Worker 是你个人的，API_KEY 也是你个人的。如果把 GPT 设成 Public，别人用它写入的是**你的**飞书云盘。建议保持 Only me。

## 使用效果

- 「把这次对话总结成 Markdown，新建一篇飞书文档」→ create
- 「找一篇叫 Q3 复盘 的飞书文档」→ search
- 「列出我云盘里的文档」→ list
- 「总结追加到这篇文档：https://xxx.feishu.cn/docx/Abc123」→ append
- 「用这个总结替换这篇文档的内容」→ replace
- 「删除这篇文档」→ delete
- 「读取这篇文档的内容」→ read
- 「把这张图插进文档，做个带表格/高亮框的富内容文档」→ format=html
- 「在这篇文档里画一张流程图」→ board_create + mermaid
