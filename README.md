# feishu-ai-writer

让 **Claude Code / Codex / ChatGPT / Grok** 直接读写你的飞书云文档和画板。

一句话说清：部署一个 Cloudflare Worker 当桥，装一份技能文件给 AI，然后你就可以说「把这次对话总结成文档发我飞书」「找一篇叫 Q3 复盘 的文档读出来」「在这篇文档里画个流程图」。

```
你的 AI  ──POST──▶  Cloudflare Worker  ──▶  飞书开放平台 API
(技能文件)            (本仓库 worker/)         (文档 / 画板 / 云盘)
```

## 能做什么

| 分类 | action | 说明 |
|---|---|---|
| 文档 | `create` / `append` / `replace` / `delete` / `read` | 新建、追加、覆盖、删除、读回 Markdown |
| 定点编辑 | `insert_after` / `delete_range` | 插到指定标题下方、删某段或某节。**找不到锚点会拒绝**，不会悄悄改成文末追加或整篇覆盖 |
| 查找 | `search` / `list` | 按文档名搜索、列出云盘文件 |
| 画板 | `board_create` / `board_update` / `board_read` | 用 Mermaid / PlantUML / SVG 画流程图、架构图、时序图 |

排版支持 Markdown（标题 1-9 级、列表、代码块、引用、待办、表格），以及 `format=html` 的富内容：图片（base64 或网络图自动上传）、可拖列宽的表格、文字颜色/背景色、高亮框、分割线、待办框。

授权后以**你的身份**操作，文档落进你自己的云盘。

## 快速开始

### 前置

- Node.js 18+
- Cloudflare 账号（免费版够用）
- 飞书账号，能创建企业自建应用

### 1. 配置飞书应用

按 [`docs/feishu-setup.md`](docs/feishu-setup.md) 走一遍：创建应用 → 用 [`docs/permissions.json`](docs/permissions.json) **批量导入权限** → 发布版本。拿到 **App ID** 和 **App Secret**。

> 权限那一步别省，`docx:document.block:convert` 漏了必报 `99991679`。

### 2. 部署 Worker

```bash
git clone https://github.com/djgdhx/feishu-ai-writer.git
cd feishu-ai-writer/worker
npm install

npx wrangler login

# 创建 KV，把输出里的 id 粘进 wrangler.toml 的 kv_namespaces.id
npx wrangler kv namespace create FEISHU_USER_TOKEN

# 先部署一次，把 Worker 创建出来（此时还没密钥，调用会报错，正常）
npx wrangler deploy
```

部署成功会输出你的 Worker 地址，形如 `https://ai-feishu-writer.你的子域.workers.dev`。**记下它，后面好几步都要用。**

```bash
# 再写入密钥（逐条执行，按提示粘贴后回车）
npx wrangler secret put FEISHU_APP_ID
npx wrangler secret put FEISHU_APP_SECRET
npx wrangler secret put API_KEY        # 自己生成一串随机字符串，见下方安全说明
npx wrangler secret put DOC_URL_PREFIX # 见下面「让返回的链接能点开」
```

> 顺序别调换：`wrangler secret put` 要求 Worker 已经存在，先部署再写密钥最顺。密钥写完即时生效，不用再 deploy 一次。

#### 让返回的链接能点开（容易踩的坑）

接口返回的文档链接默认拼成 `https://feishu.cn/docx/<id>`，这个地址**打不开**。要换成你自己租户的域名：随便打开一篇你的飞书文档，看浏览器地址栏，形如 `https://abc123xyz.feishu.cn/docx/xxxxx`，取前半截设进去：

```bash
npx wrangler secret put DOC_URL_PREFIX
# 输入：https://abc123xyz.feishu.cn/docx/
```

不设也能用，只是每次返回的链接要自己手动改域名才能打开。

#### 完成授权

回到飞书后台，把 `https://你的Worker域名/auth/callback` 填进 **安全设置 → 重定向 URL**（末尾不要斜杠），然后浏览器打开 `https://你的Worker域名/auth/start` 完成授权。访问 `/auth/status` 确认 `authorized: true`。

### 3. 生成你的技能文件

仓库里的 `skills/` 是模板，地址和密钥是 `{{WORKER_URL}}` / `{{API_KEY}}` 占位符。填好 `.env` 后一条命令生成可直接用的版本：

```bash
cd ..            # 回到仓库根目录
cp .env.example .env
# 编辑 .env，填入你的 WORKER_URL 和 API_KEY
npm run gen
```

生成到 `dist/skills/`。

### 4. 安装技能

| 平台 | 安装方式 |
|---|---|
| **Claude Code** | 复制 `dist/skills/claude/SKILL.md` 到 `~/.claude/skills/feishu-doc-writer/SKILL.md` |
| **Codex** | 复制 `dist/skills/codex/SKILL.md` 到 `~/.codex/skills/feishu-doc-writer/SKILL.md`，并在 `~/.codex/config.toml` 开启 `[features]` `skills = true` |
| **Grok** | Grok App →「创建技能」→ 上传 `dist/skills/grok/SKILL.md` |
| **ChatGPT** | GPTs → Create a GPT → Actions → 粘贴 `dist/skills/chatgpt/openapi.yaml`，鉴权选 API Key / Custom / Header `x-api-key`。详见 [`skills/chatgpt/instructions.md`](skills/chatgpt/instructions.md) |

### 5. 试一下

对你的 AI 说：

- 「把这次对话总结成 Markdown，新建一篇飞书文档」
- 「找一篇叫 Q3 复盘 的飞书文档，读出来」
- 「列出我云盘里的文档」
- 「总结追加到这篇文档：https://xxx.feishu.cn/docx/Abc123」
- 「在第二章下面插一段说明」
- 「在这篇文档里画一张流程图」

## 安全说明

**这个 Worker 是你私人的。** 任何拿到你 Worker 地址 + API_KEY 的人，都能对你的飞书云盘增删改查。

- **一定要设 `API_KEY`**，不设的话接口裸奔。生成一串随机值：
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **不要把填好的技能文件（`dist/`）提交到任何公开仓库**。`.gitignore` 已经把 `dist/` 和 `.env` 排除了。
- ChatGPT 的 GPT 建议设成 **Only me**；设成 Public 等于把你的云盘写权限公开。
- 换密钥：`npx wrangler secret put API_KEY` → `npx wrangler deploy` → 改 `.env` → `npm run gen` → 重装技能。

## 仓库结构

```
├── worker/
│   ├── worker.js          Worker 全部实现（单文件，无运行时依赖）
│   ├── wrangler.toml      部署配置，KV id 需自己填
│   └── package.json
├── skills/                技能模板（含占位符）
│   ├── claude/SKILL.md
│   ├── codex/SKILL.md
│   ├── grok/SKILL.md
│   └── chatgpt/           SKILL.md + openapi.yaml + instructions.md
├── scripts/gen-skills.mjs 读 .env 生成 dist/skills/
├── docs/
│   ├── feishu-setup.md    飞书应用配置全流程
│   └── permissions.json   权限批量导入 JSON
├── test/test-smoke.mjs    本地冒烟测试（mock 飞书，不真调）
└── .env.example
```

## 接口

`POST /`，请求头 `Content-Type: application/json` + `x-api-key: 你的密钥`。

```bash
curl -X POST "https://你的Worker域名/" \
  -H "Content-Type: application/json" \
  -H "x-api-key: 你的密钥" \
  -d '{"action":"create","title":"会议总结","content":"# 会议总结\n\n- 讨论了方案A"}'
```

返回：

```json
{
  "success": true,
  "action": "create",
  "document_id": "Vbxxxxxxxxxxxxxxxxxxxx",
  "url": "https://feishu.cn/docx/Vbxxxxxxxxxxxxxxxxxxxx",
  "block_count": 12,
  "identity": "user",
  "message": "已创建并写入文档「会议总结」"
}
```

`identity` 为 `user` 表示用你的身份（文档落你云盘），`tenant` 表示未授权、回退到应用身份。

完整字段说明见任一 [`skills/*/SKILL.md`](skills/claude/SKILL.md)——技能文件本身就是最全的接口文档。

## 常见问题

**`99991679`** — 用户授权缺权限。飞书后台补权限 → **发布版本** → `/auth/reset` → `/auth/start` 重新授权。

**`99991672`** — 应用权限不足，或文档没分享给应用。

**HTTP 401** — `x-api-key` 和 Worker 里设的对不上。

**返回的文档链接点不开** — 没设 `DOC_URL_PREFIX`，默认的 `https://feishu.cn/docx/` 打不开。设成你自己租户的域名，见上面「让返回的链接能点开」。

**`wrangler secret put` 报找不到 Worker** — 先 `npx wrangler deploy` 把 Worker 创建出来，再写密钥。

**`npm install` 报 `ECONNREFUSED 127.0.0.1:10808`** — npm 配了代理但代理软件没开。打开代理，或 `npm install --proxy= --https-proxy=`。

**Lark 国际版** — 额外设置 `npx wrangler secret put FEISHU_BASE_URL`，值 `https://open.larksuite.com`。

## License

MIT
