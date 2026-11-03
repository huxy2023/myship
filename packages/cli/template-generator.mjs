/**
 * template-generator.mjs — MyShip 零摩擦全栈工程脚手架生成器 (`myship init --template` / `myship create`)
 *
 * 支持三套渐进式标准样板：
 * 1. `static`    : 纯静态极速站点 (`index.html` + `.myship/project.json`)
 * 2. `edge`      : 边缘 Serverless 站点 (`index.html` + `api/hello.js` + `context.storage` 状态计数)
 * 3. `fullstack` : 全栈 Node.js 黄金样板 (`public/index.html` + `server/index.mjs` + `context.db` + `context.files` + `context.storage`)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import {
  detectProjectContext,
  ensureProjectConfig,
  inferCosRegion,
  normalizeDomainToken,
} from './project-context.mjs';
import {
  getEffectiveEndpoints,
  getGlobalDbProvidersConfig,
} from './cos-client.mjs';
import { promptSelect } from './tui-prompts.mjs';

export const TEMPLATE_DEFINITIONS = {
  static: {
    id: 'static',
    title: 'Static 极速静态站 (index.html + CAS 全球分发)',
    dir: '.',
    description: '零配置静态页面骨架，支持秒级增量发布与 0 秒版本回滚',
  },
  edge: {
    id: 'edge',
    title: 'Edge 边缘全栈站 (index.html + api/hello.js + context.storage)',
    dir: '.',
    description: '包含前端页面与约定式 EdgeOne 边缘云函数 (api/*.js)，内置私有 KV 状态计数演示',
  },
  fullstack: {
    id: 'fullstack',
    title: 'Full-Stack 全栈黄金样板 (public/ + server/index.mjs + DB + Files + Storage)',
    dir: './public',
    description:
      '完整串联静态前端 + 腾讯云 SCF Node.js 后端 + context.db 多引擎 SQL + context.files 预签名直传',
  },
};

export function normalizeTemplateName(raw) {
  const clean = String(raw || '')
    .trim()
    .toLowerCase();
  if (!clean) return null;
  if (clean === 'static' || clean === 'spa' || clean === 'html' || clean === 'web') {
    return 'static';
  }
  if (clean === 'edge' || clean === 'api' || clean === 'serverless' || clean === 'edge-fn') {
    return 'edge';
  }
  if (
    clean === 'fullstack' ||
    clean === 'full-stack' ||
    clean === 'scf' ||
    clean === 'backend' ||
    clean === 'starter' ||
    clean === 'node'
  ) {
    return 'fullstack';
  }
  return null;
}

function buildGitignoreContent() {
  return [
    'node_modules/',
    '.DS_Store',
    '.env',
    '.env.*',
    '!.env.example',
    '.myship/*',
    '!.myship/project.json',
    '!.myship/.gitignore',
    '',
  ].join('\n');
}

function buildStaticFiles(project) {
  return {
    '.gitignore': buildGitignoreContent(),
    'index.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project} — Powered by MyShip</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b1220; color: #f8fafc; padding: 24px; box-sizing: border-box;
    }
    .card {
      max-width: 600px; width: 100%; background: #111c33;
      border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 18px;
      padding: 32px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 999px;
      background: rgba(56, 189, 248, 0.15); color: #38bdf8;
      font-size: 12px; font-weight: 600; letter-spacing: 0.04em;
    }
    h1 { margin: 14px 0 10px; font-size: 26px; }
    p { color: #94a3b8; line-height: 1.65; margin: 0 0 20px; }
    pre {
      background: #070d19; border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 10px; padding: 14px 16px; color: #e2e8f0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
      overflow-x: auto; margin: 0;
    }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">⚓ MyShip Static Starter</span>
    <h1>Hello from <code>${project}</code>!</h1>
    <p>当前项目已就绪。你可以在本地启动即时预览服务器，或直接敲 6 个字母一键发布至自有云底座：</p>
    <pre># 1. 本地开发预览
myship dev

# 2. 一键增量发布上线
myship</pre>
  </main>
</body>
</html>
`,
  };
}

function buildEdgeFiles(project) {
  return {
    '.gitignore': buildGitignoreContent(),
    'api/hello.js': `/**
 * api/hello.js — MyShip 约定式边缘 Serverless 云函数
 *
 * 自动映射路由: /api/hello
 * 内置能力: context.storage (COS 私有 JSON KV 持久化存储)
 */
export async function GET(request, context) {
  const record = (await context.storage.get('edge-counter')) || { count: 0, updatedAt: null };
  return Response.json({
    ok: true,
    mode: 'edge-function',
    project: context.project || '${project}',
    subdomain: context.subdomain || null,
    deploymentId: context.deploymentId || 'dev',
    counter: record,
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request, context) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  const delta = Number(body.delta ?? 1) || 1;
  const prev = (await context.storage.get('edge-counter')) || { count: 0 };
  const next = {
    count: Number(prev.count || 0) + delta,
    updatedAt: new Date().toISOString(),
  };
  await context.storage.set('edge-counter', next);
  return Response.json({
    ok: true,
    mode: 'edge-function',
    project: context.project || '${project}',
    counter: next,
  });
}
`,
    'index.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project} — MyShip Edge Starter</title>
  <style>
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b1220; color: #f8fafc; padding: 24px; box-sizing: border-box;
    }
    .card {
      max-width: 640px; width: 100%; background: #111c33;
      border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 18px;
      padding: 32px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
    }
    .badge {
      display: inline-block; padding: 4px 12px; border-radius: 999px;
      background: rgba(56, 189, 248, 0.15); color: #38bdf8;
      font-size: 12px; font-weight: 600;
    }
    h1 { margin: 14px 0 8px; font-size: 25px; }
    p { color: #94a3b8; line-height: 1.6; margin: 0 0 18px; }
    button {
      background: #38bdf8; color: #0b1220; border: none; border-radius: 8px;
      padding: 10px 18px; font-weight: 700; cursor: pointer; font-size: 14px;
    }
    pre {
      margin-top: 16px; background: #070d19; border-radius: 10px; padding: 14px;
      color: #a5f3fc; font-size: 12.5px; overflow-x: auto;
      border: 1px solid rgba(56, 189, 248, 0.2);
    }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">⚡ MyShip Edge Serverless Starter</span>
    <h1>${project} · 边缘函数与 KV 状态演示</h1>
    <p>点击下方按钮调用 <code>/api/hello</code>，验证边缘函数与 <code>context.storage</code> 持久化计数：</p>
    <button id="btn">⚡ 累加边缘计数器 (POST /api/hello)</button>
    <pre id="out">正在读取 /api/hello ...</pre>
  </main>
  <script>
    const out = document.getElementById('out');
    async function refresh(method = 'GET') {
      const res = await fetch('/api/hello', {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify({ delta: 1 }) : undefined,
      });
      const data = await res.json();
      out.textContent = JSON.stringify(data, null, 2);
    }
    document.getElementById('btn').addEventListener('click', () => refresh('POST'));
    refresh('GET');
  </script>
</body>
</html>
`,
  };
}

function buildFullstackFiles(project) {
  return {
    '.gitignore': buildGitignoreContent(),
    'package.json': `${JSON.stringify(
      {
        name: project,
        version: '0.1.0',
        private: true,
        type: 'module',
        description: `${project} — MyShip Full-Stack App (Static + SCF Node.js + context.db + context.files + context.storage)`,
        scripts: {
          dev: 'myship dev',
          ship: 'myship',
        },
      },
      null,
      2
    )}\n`,
    'server/templates/banner.txt': `MyShip Full-Stack Runtime :: ${project} (Static + SCF + DB + Files + Storage)\n`,
    'server/index.mjs': `/**
 * server/index.mjs — ${project} 全栈业务后端 (Node.js SCF Web 函数)
 *
 * 完整串联 MyShip 三大持久化原语：
 * 1. context.storage : 私有 JSON KV 状态存储 (COS data/${project}/<key>.json)
 * 2. context.db      : 多引擎 SQL 数据库读写 (PostgreSQL / Neon / Turso / D1 / MySQL / 本地 node:sqlite)
 * 3. context.files   : 二进制对象存储与预签名直传 URL (COS files/${project}/<key>)
 */
import { readFileSync } from 'node:fs';

const BANNER_TEXT = readFileSync(new URL('./templates/banner.txt', import.meta.url), 'utf-8').trim();
let schemaInitializedForProvider = null;

async function ensureNotesTable(db) {
  if (!db) throw new Error('context.db 未初始化');
  const provider = String(db.provider || 'sqlite').toLowerCase();
  if (schemaInitializedForProvider === provider) return provider;

  if (
    provider === 'pg' ||
    provider === 'cloudbase-pg' ||
    provider === 'neon' ||
    provider === 'postgres'
  ) {
    await db.execute(\`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    \`);
  } else if (provider === 'mysql') {
    await db.execute(\`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        created_at VARCHAR(64) NOT NULL
      )
    \`);
  } else {
    await db.execute(\`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    \`);
  }

  schemaInitializedForProvider = provider;
  return provider;
}

export async function fetch(request, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health' && method === 'GET') {
    const dbReady = Boolean(context.db && context.db.provider !== 'unconfigured');
    return Response.json({
      ok: true,
      banner: BANNER_TEXT,
      project: context.project,
      subdomain: context.subdomain,
      deploymentId: context.deploymentId,
      nodeVersion: process.version,
      dbProvider: context.db?.provider || 'unconfigured',
      capabilities: {
        storage: Boolean(context.storage),
        files: Boolean(context.files),
        db: dbReady,
      },
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/api/state') {
    if (method === 'GET') {
      const state = (await context.storage.get('counter')) || { count: 0, updatedAt: null };
      return Response.json({ ok: true, state });
    }
    if (method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const delta = Number(body.delta ?? 1) || 1;
      const prev = (await context.storage.get('counter')) || { count: 0 };
      const next = {
        count: Number(prev.count || 0) + delta,
        updatedAt: new Date().toISOString(),
        lastDeploymentId: context.deploymentId,
      };
      await context.storage.set('counter', next);
      return Response.json({ ok: true, state: next });
    }
  }

  if (path === '/api/notes') {
    if (!context.db || context.db.provider === 'unconfigured') {
      return Response.json(
        {
          ok: false,
          needsSetup: true,
          provider: 'unconfigured',
          setupCommand: 'myship use db',
          error:
            '当前项目尚未绑定云端数据库。请在项目根目录执行 "myship use db" 一键开通并注入数据库凭证后再执行 "myship" 发布。',
          notes: [],
        },
        { status: 503 }
      );
    }
    const provider = await ensureNotesTable(context.db);
    const isPg =
      provider === 'pg' ||
      provider === 'cloudbase-pg' ||
      provider === 'neon' ||
      provider === 'postgres';

    if (method === 'GET') {
      const { rows } = await context.db.query(
        'SELECT id, title, created_at FROM starter_notes ORDER BY id DESC LIMIT 20'
      );
      return Response.json({ ok: true, provider, notes: rows });
    }

    if (method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const title = String(body.title || '').trim();
      if (!title) {
        return Response.json({ ok: false, error: 'title 不能为空' }, { status: 400 });
      }
      const createdAt = new Date().toISOString();
      const insertSql = isPg
        ? 'INSERT INTO starter_notes (title, created_at) VALUES ($1, $2)'
        : 'INSERT INTO starter_notes (title, created_at) VALUES (?, ?)';
      await context.db.execute(insertSql, [title, createdAt]);
      const { rows } = await context.db.query(
        'SELECT id, title, created_at FROM starter_notes ORDER BY id DESC LIMIT 20'
      );
      return Response.json({ ok: true, provider, notes: rows });
    }

    if (method === 'DELETE') {
      await context.db.execute('DELETE FROM starter_notes');
      return Response.json({ ok: true, provider, notes: [] });
    }
  }

  if (path === '/api/files' && method === 'GET') {
    const keys = await context.files.list('');
    return Response.json({ ok: true, files: keys });
  }

  if (path === '/api/files' && method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const key = String(body.key || 'hello.txt').replace(/^\\/+/, '');
    const content = String(
      body.content || \`Saved by \${context.project} at \${new Date().toISOString()}\`
    );
    await context.files.put(key, content, { contentType: 'text/plain; charset=utf-8' });
    const readBack = await context.files.get(key, { type: 'text' });
    const keys = await context.files.list('');
    return Response.json({ ok: true, key, content: readBack, files: keys });
  }

  if (path === '/api/files/presign' && method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const key = String(body.key || 'demo/hello.txt').replace(/^\\/+/, '');
    const reqMethod = String(body.method || 'GET').toUpperCase();
    if (reqMethod === 'GET' && key === 'demo/hello.txt') {
      const existing = await context.files.get(key);
      if (!existing) {
        await context.files.put(
          key,
          \`Hello from ${project}! (\${new Date().toISOString()})\`,
          { contentType: 'text/plain; charset=utf-8' }
        );
      }
    }
    const presignedUrl = await context.files.presignUrl(key, {
      method: reqMethod,
      expiresIn: 600,
    });
    return Response.json({
      ok: true,
      key,
      method: reqMethod,
      presignedUrl,
    });
  }

  return Response.json({ ok: false, error: \`Route not found: \${method} \${path}\` }, { status: 404 });
}
`,
    'public/index.html': `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${project} — MyShip Full-Stack Starter</title>
  <style>
    :root {
      --bg: #0b1020; --card: #131c33; --border: rgba(148, 163, 184, 0.18);
      --text: #f8fafc; --muted: #94a3b8; --accent: #38bdf8; --emerald: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg); color: var(--text); padding: 28px 18px 60px;
    }
    .wrap { max-width: 960px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; margin-top: 18px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
    h1 { margin: 8px 0; font-size: 24px; }
    h2 { margin: 0 0 8px; font-size: 16px; }
    p { margin: 0 0 12px; color: var(--muted); font-size: 13px; line-height: 1.55; }
    .row { display: flex; gap: 8px; margin-bottom: 10px; }
    input {
      flex: 1; background: #090e1a; border: 1px solid var(--border); color: var(--text);
      padding: 8px 10px; border-radius: 8px; font-size: 13px;
    }
    button {
      background: var(--accent); color: #090e1a; border: none; font-weight: 600;
      padding: 8px 13px; border-radius: 8px; cursor: pointer; font-size: 13px;
    }
    pre {
      margin: 0; padding: 10px; background: #080d18; border-radius: 8px;
      font-size: 12px; color: #cbd5e1; overflow-x: auto; max-height: 180px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>⚓ ${project} · MyShip 全栈样板控制台</h1>
    <p>包含静态前端 + <code>server/index.mjs</code> (SCF) + <code>context.db</code> + <code>context.storage</code> + <code>context.files</code>。</p>
    <div class="grid">
      <div class="card">
        <h2>1. context.storage (JSON KV)</h2>
        <div class="row">
          <button onclick="bumpCounter()">+1 累加计数</button>
        </div>
        <pre id="state-out">加载中...</pre>
      </div>
      <div class="card">
        <h2>2. context.db (SQL 笔记表)</h2>
        <div class="row">
          <input id="note-input" placeholder="输入笔记内容..." value="Ship with MyShip!" />
          <button onclick="addNote()">写入</button>
        </div>
        <pre id="notes-out">加载中...</pre>
      </div>
      <div class="card">
        <h2>3. context.files (对象存储与预签名)</h2>
        <div class="row">
          <button onclick="saveFile()">写入示例文件</button>
          <button onclick="presignFile()">生成预签名 URL</button>
        </div>
        <pre id="files-out">加载中...</pre>
      </div>
    </div>
  </div>
  <script>
    async function loadAll() {
      const [s, n, f] = await Promise.all([
        fetch('/api/state').then(r => r.json()),
        fetch('/api/notes').then(r => r.json()),
        fetch('/api/files').then(r => r.json()),
      ]);
      document.getElementById('state-out').textContent = JSON.stringify(s, null, 2);
      document.getElementById('notes-out').textContent = JSON.stringify(n, null, 2);
      document.getElementById('files-out').textContent = JSON.stringify(f, null, 2);
    }
    async function bumpCounter() {
      const res = await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta: 1 }) });
      document.getElementById('state-out').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function addNote() {
      const title = document.getElementById('note-input').value.trim();
      const res = await fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      document.getElementById('notes-out').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function saveFile() {
      const res = await fetch('/api/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'demo/hello.txt' }) });
      document.getElementById('files-out').textContent = JSON.stringify(await res.json(), null, 2);
    }
    async function presignFile() {
      const res = await fetch('/api/files/presign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'demo/hello.txt', method: 'GET' }) });
      document.getElementById('files-out').textContent = JSON.stringify(await res.json(), null, 2);
    }
    loadAll();
  </script>
</body>
</html>
`,
  };
}

export async function scaffoldProjectTemplate(
  targetDir = process.cwd(),
  {
    template = null,
    project = null,
    overwrite = false,
    interactive = false,
    promptAnswers = null,
  } = {}
) {
  const absDir = resolve(targetDir);
  mkdirSync(absDir, { recursive: true });

  let resolvedTemplate = normalizeTemplateName(template);
  if (!resolvedTemplate && (interactive || template === 'prompt')) {
    const normalizedAnswers = Array.isArray(promptAnswers)
      ? promptAnswers
      : promptAnswers?.template
      ? [promptAnswers.template]
      : null;
    resolvedTemplate = await promptSelect({
      title: '🚀 请选择要生成的 MyShip 工程脚手架模板 (上下方向键或数字键选择)',
      items: [
        {
          value: 'fullstack',
          label: 'Full-Stack 全栈黄金样板 (推荐)',
          hint: 'public/ + server/index.mjs (SCF) + context.db + context.files + context.storage',
        },
        {
          value: 'edge',
          label: 'Edge 边缘 Serverless 站点',
          hint: 'index.html + api/hello.js (EdgeOne V8) + context.storage',
        },
        {
          value: 'static',
          label: 'Static 纯静态极速站点',
          hint: 'index.html + .myship/project.json',
        },
      ],
      defaultIndex: 0,
      promptAnswers: normalizedAnswers,
    });
  }

  if (!resolvedTemplate) {
    throw new Error(
      `未知或未指定的脚手架模板 (${template || 'empty'})。可选值: --template static | edge | fullstack`
    );
  }

  const ctx = detectProjectContext(absDir, project);
  const finalProject = normalizeDomainToken(project || ctx.project || basename(absDir)) || 'app';

  const fileMap =
    resolvedTemplate === 'static'
      ? buildStaticFiles(finalProject)
      : resolvedTemplate === 'edge'
      ? buildEdgeFiles(finalProject)
      : buildFullstackFiles(finalProject);

  const createdFiles = [];
  const skippedFiles = [];

  for (const [relFile, content] of Object.entries(fileMap)) {
    const fullPath = resolve(absDir, relFile);
    if (existsSync(fullPath) && !overwrite) {
      skippedFiles.push(relFile);
      continue;
    }
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
    createdFiles.push(relFile);
  }

  const region = inferCosRegion();
  const templateDef = TEMPLATE_DEFINITIONS[resolvedTemplate];

  let savedCfg;
  if (ctx.hasSavedConfig && !overwrite) {
    skippedFiles.push('.myship/project.json');
    if (project) {
      savedCfg = ensureProjectConfig(absDir, {
        project: finalProject,
        dir: ctx.buildDir,
        prodDomain: ctx.prodDomain,
        backend: ctx.backend || undefined,
        resources: ctx.resources || undefined,
      });
    } else {
      savedCfg = {
        ...ctx,
        project: finalProject,
        dir: ctx.buildDir,
      };
    }
  } else {
    const overrides = {
      project: finalProject,
      dir: templateDef.dir,
    };

    if (resolvedTemplate === 'edge') {
      overrides.resources = {
        ...(ctx.resources || {}),
        storage: {
          enabled: true,
          provider: 'cos',
          env: 'prod',
          isolation: 'shared',
          dataPrefix: `data/${finalProject}/`,
          filesPrefix: `files/${finalProject}/`,
          updatedAt: new Date().toISOString(),
        },
      };
    } else if (resolvedTemplate === 'fullstack') {
      overrides.backend = {
        ...(ctx.backend || {}),
        enabled: true,
        provider: ctx.backend?.provider || 'scf',
        region: ctx.backend?.region || region,
        entry: 'server/index.mjs',
        prefix: ctx.backend?.prefix || '/api',
        functionName: ctx.backend?.functionName || `myship-${finalProject}`.slice(0, 56),
        runtime: ctx.backend?.runtime || 'Nodejs20.19',
      };
      overrides.resources = {
        ...(ctx.resources || {}),
        storage: {
          enabled: true,
          provider: 'cos',
          env: 'prod',
          isolation: 'shared',
          dataPrefix: `data/${finalProject}/`,
          filesPrefix: `files/${finalProject}/`,
          updatedAt: new Date().toISOString(),
        },
        ...(ctx.resources?.db?.enabled ? { db: ctx.resources.db } : {}),
      };
    }

    savedCfg = ensureProjectConfig(absDir, overrides);
  }

  const { remoteDomain } = getEffectiveEndpoints();
  const suffix = remoteDomain || 'ship.example.com';
  const relDirDisplay = relative(process.cwd(), absDir) || '.';

  console.log('==============================================================');
  console.log(`🚀 MyShip 工程脚手架已生成: [${templateDef.title}]`);
  console.log(`   🏷️  项目命名空间: ${savedCfg.project}`);
  console.log(`   📁 工程目录:     ${absDir}`);
  console.log(`   📦 静态构建目录: ${savedCfg.dir}`);
  console.log(`   🌐 默认主域名:   https://${savedCfg.prodDomain}.${suffix}`);
  if (createdFiles.length > 0) {
    console.log(`   ✨ 新增文件 (${createdFiles.length}): ${createdFiles.join(', ')}`);
  }
  if (skippedFiles.length > 0) {
    console.log(
      `   ⚡ 保留已有文件 (${skippedFiles.length}): ${skippedFiles.join(', ')} (加 --force 可覆盖)`
    );
  }
  console.log('--------------------------------------------------------------');
  console.log('💡 下一步极简闭环命令：');
  if (relDirDisplay !== '.') {
    console.log(`   cd ${relDirDisplay}`);
  }
  console.log('   myship dev       # 本地即时预览 (自动挂载本地沙盒存储与 SQLite)');
  if (resolvedTemplate === 'fullstack') {
    console.log('   myship use db    # 上线前一键开通并绑定云端数据库 (CloudBase PG / Neon / Turso / D1)');
  }
  console.log('   myship           # 6 个字母一键发布上线');
  console.log('==============================================================');

  return {
    project: savedCfg.project,
    template: resolvedTemplate,
    targetDir: absDir,
    dir: savedCfg.dir,
    prodDomain: savedCfg.prodDomain,
    projectJsonPath: savedCfg.projectJsonPath,
    createdFiles,
    skippedFiles,
  };
}
