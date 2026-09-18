# 飞书侧配置（一次性，约 10 分钟）

## 1. 创建自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**
2. 填名称、图标 → 创建
3. 进入应用 → **凭证与基础信息** → 记下 **App ID** 和 **App Secret**（部署 Worker 时要用）

> Lark 国际版在 https://open.larksuite.com ，同时要给 Worker 设 `FEISHU_BASE_URL=https://open.larksuite.com`。

## 2. 批量导入权限

这一步是**关键**，漏权限会直接报错。

打开应用 → **开发配置 → 权限管理 → 批量导入/导出权限 → 导入**，把 [`permissions.json`](./permissions.json) 的全部内容粘进去 → **申请开通**（已有的会自动跳过）。

权限清单及用途：

| 权限 | 用途 |
|---|---|
| `docx:document` / `:create` / `:write_only` | 创建及编辑新版文档 |
| `docx:document.block:convert` | Markdown 转文档块 — **缺它必报 99991679** |
| `drive:drive` | 云空间管理：删除文档、列出文件 |
| `drive:file:upload` | 上传图片等素材（`format=html` 插图用） |
| `search:docs:read` | 按名字搜索文档 |
| `board:whiteboard:node:read` / `create` / `update` / `delete` | 画板读写与覆盖 |
| `offline_access`（user） | 拿 refresh_token，免得天天重新授权 |

## 3. 配置重定向 URL

左侧 **开发配置 → 安全设置 → 重定向 URL** → 添加（**末尾不要斜杠**）：

```
https://你的Worker域名/auth/callback
```

Worker 域名在 `npx wrangler deploy` 成功后终端会输出，形如 `https://ai-feishu-writer.你的子域.workers.dev`。

> 顺序上可以先部署 Worker 拿到域名，再回来填这一项。

## 4. 发布版本（权限生效的前提）

1. 左侧 **应用发布 → 版本管理与发布** → **创建版本**
2. 填版本号（如 1.0.0）→ **申请发布** → 在审批里同意

**每次改权限或配置后都必须重新发布版本**，否则不生效。

## 5. 用户授权（让文档落进你自己的云盘）

部署完 Worker 后，浏览器打开：

```
https://你的Worker域名/auth/start
```

跳转飞书授权页 → 同意 → 回调自动存 token 到 KV。

验证：打开 `https://你的Worker域名/auth/status`，期望看到

```json
{
  "authorized": true,
  "has_convert_scope": true,
  "has_search_scope": true,
  "has_board_scope": true
}
```

> `scope_preview` 只显示前 30 个权限名，里面看不到 search/board **不代表**没开，以 `has_*_scope` 为准。

不授权也能用，但走的是**应用身份**，文档会落在应用空间而不是你的云盘。

## 6. 授权相关接口

| 路径 | 作用 |
|---|---|
| `/auth/start` | 跳转飞书授权页 |
| `/auth/callback` | 授权回调（自动，无需手动访问） |
| `/auth/status` | 查看授权状态 + scope 检查 |
| `/auth/reset` | 清除授权 |

**改过权限后必须先 `/auth/reset` 再 `/auth/start`**，否则拿到的还是旧 scope 的 token。

## 常见错误码

| 错误码 | 原因 | 处理 |
|---|---|---|
| `99991672` | 应用权限不足，或文档没分享给应用 | 补权限 → 发布版本 |
| `99991679` | 用户授权缺权限（最常见是少了 `docx:document.block:convert`） | 补权限 → 发布版本 → `/auth/reset` → `/auth/start` |
| HTTP 401 | `x-api-key` 缺失或错误 | 检查技能里的 key 和 `wrangler secret put API_KEY` 设的是否一致 |
