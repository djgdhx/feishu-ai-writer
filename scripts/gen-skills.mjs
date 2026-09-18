#!/usr/bin/env node
// 读取 .env，把 skills/ 模板里的 {{WORKER_URL}} / {{API_KEY}} 替换成你自己的值，
// 输出到 dist/skills/，直接复制安装即可。

import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

if (!existsSync(envPath)) {
  console.error('找不到 .env\n请先执行：cp .env.example .env  然后填入 WORKER_URL 和 API_KEY');
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const workerUrl = (env.WORKER_URL || '').replace(/\/+$/, '');
const apiKey = env.API_KEY || '';

if (!workerUrl || workerUrl.includes('你的子域')) {
  console.error('.env 里的 WORKER_URL 还没填成你自己的地址');
  process.exit(1);
}
if (!apiKey || apiKey === '你的密钥') {
  console.error('.env 里的 API_KEY 还没填');
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const srcDir = join(root, 'skills');
const outDir = join(root, 'dist', 'skills');
let count = 0;

for (const file of walk(srcDir)) {
  const rel = file.slice(srcDir.length + 1);
  const out = join(outDir, rel);
  mkdirSync(dirname(out), { recursive: true });
  const text = readFileSync(file, 'utf8')
    .replaceAll('{{WORKER_URL}}', workerUrl)
    .replaceAll('{{API_KEY}}', apiKey);
  writeFileSync(out, text);
  count++;
}

console.log(`已生成 ${count} 个文件到 dist/skills/`);
console.log(`Worker 地址：${workerUrl}`);
console.log('\n安装位置：');
console.log('  Claude Code  →  ~/.claude/skills/feishu-doc-writer/SKILL.md');
console.log('  Codex        →  ~/.codex/skills/feishu-doc-writer/SKILL.md');
console.log('  Grok         →  Grok App 内「创建技能」上传 skills/grok/SKILL.md');
console.log('  ChatGPT      →  GPTs Actions 粘贴 skills/chatgpt/openapi.yaml');
