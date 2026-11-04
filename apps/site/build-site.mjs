#!/usr/bin/env node
/**
 * apps/site/build-site.mjs — MyShip 模块化门户与技术文档站构建编排器
 *
 * 工程化模块结构：
 * - src/compiler/syntax-highlighter.mjs : 构建期零依赖词法语法高亮器 (Bash / JS / SQL / JSON)
 * - src/compiler/markdown-compiler.mjs  : 增强型 Markdown 编译器 (语义化 Callout / 章节分页 / 深度锚点)
 * - src/styles/{tokens,layout,prose-and-code}.css : 现代双主题设计系统与响应式样式
 * - src/views/{portal-view,docs-view}.mjs : 门户视图 (Bento Grid + 0ms 指针沙盘) 与三栏文档阅读器视图
 * - src/client/app-client.js            : 客户端路由 (Hash/History 同步)、⌘K 键盘导航、Mermaid 画布与抽屉交互
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdownDocument } from './src/compiler/markdown-compiler.mjs';
import { renderPortalView } from './src/views/portal-view.mjs';
import { renderDocsView } from './src/views/docs-view.mjs';
import { MASCOT_SVG, LOGO_SVG, FAVICON_SVG } from '../../packages/cli/brand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const ROOT_PKG = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf-8'));
const PUBLIC_DIR = resolve(__dirname, 'public');
const SKILL_SRC_DIR = resolve(ROOT_DIR, 'skills/myship-skill');
const DIST_DIR = resolve(__dirname, 'dist');
const RAW_DIR = resolve(DIST_DIR, 'raw');
const SKILL_DIST_DIR = resolve(DIST_DIR, 'skill');

const DOC_SOURCES = [
  {
    id: 'quickstart',
    category: '快速上手 · Quickstart',
    title: '5 分钟快速上手与 CLI 命令全解',
    shortTitle: '5 分钟快速上手',
    badge: 'Quickstart',
    description:
      '涵盖全局安装、myship login、多项目命名空间隔离、边缘与 SCF 全栈后端、myship use 声明式数据库与文件存储、0 秒回滚。',
    filePath: resolve(ROOT_DIR, 'docs/01-quickstart.md'),
    rawPath: '/raw/01-quickstart.md',
  },
  {
    id: 'self-hosting',
    category: '私有部署 · Self-Hosting',
    title: '从 0 到 1 自建云端底座保姆级指南',
    shortTitle: '自建云端底座指南',
    badge: 'BYOC Guide',
    description:
      '一步步指导你在 10 分钟内用自己的腾讯云 COS、DNSPod、EdgeOne 标准站点与 Serverless 数据库搭建专属全栈平台。',
    filePath: resolve(ROOT_DIR, 'docs/02-self-hosting-guide.md'),
    rawPath: '/raw/02-self-hosting-guide.md',
  },
  {
    id: 'architecture',
    category: '架构深度 · Architecture',
    title: 'CAS 三级指针架构与全栈运行时原理',
    shortTitle: 'CAS 与全栈架构原理',
    badge: 'Architecture',
    description:
      '深度剖析 blobs / manifests / aliases / data / files 六大命名空间、SCF 不可变版本绑定以及本地与云端 100% 同构的数据库运行时。',
    filePath: resolve(ROOT_DIR, 'docs/03-architecture.md'),
    rawPath: '/raw/03-architecture.md',
  },
  {
    id: 'roadmap',
    category: '产品规划 · Vision & Architecture',
    title: '产品愿景与极致 DX 演进蓝图',
    shortTitle: '愿景与演进蓝图',
    badge: 'Blueprint',
    description:
      '定义 MyShip 的三大 DX 黄金准则与五大工程支柱：CAS 去重、边缘 V8、SCF 全栈 Node.js、myship use 云资源编排与权限演进。',
    filePath: resolve(ROOT_DIR, 'docs/04-roadmap.md'),
    rawPath: '/raw/04-roadmap.md',
  },
];

function loadBundledStyles() {
  const styleFiles = [
    resolve(__dirname, 'src/styles/tokens.css'),
    resolve(__dirname, 'src/styles/layout.css'),
    resolve(__dirname, 'src/styles/prose-and-code.css'),
  ];
  return styleFiles.map((f) => readFileSync(f, 'utf-8')).join('\n\n');
}

function generateSiteHtml(parsedDocs, searchEntries, mcpConfig) {
  const clientDocsPayload = parsedDocs.map((d) => ({
    id: d.id,
    category: d.category,
    title: d.title,
    shortTitle: d.shortTitle,
    badge: d.badge,
    description: d.description,
    rawPath: d.rawPath,
    rawMd: d.rawMd,
    toc: d.toc,
  }));

  const bundledCss = loadBundledStyles();
  const clientJs = readFileSync(resolve(__dirname, 'src/client/app-client.js'), 'utf-8');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyShip — 自有云海，一令启航 | 基于自有云设施 (BYOC) 的全栈部署与云资源编排引擎</title>
  <meta name="description" content="MyShip（自有云海，一令启航 · Your Cloud. Your Fleet. One Command to Ship.）— 开源 BYOC 全栈部署与云资源编排引擎。基于自有 EdgeOne 泛域名边缘函数、腾讯云 COS 内容寻址存储 (CAS)、SCF 全栈后端与五大 Serverless 数据库，实现无限版本保留与 0 秒原子回滚。" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="MyShip — 自有云海，一令启航 (Your Cloud. Your Fleet. One Command to Ship.)" />
  <meta property="og:description" content="用你自己的云设施，10 分钟搭一套私人全栈云平台。支持 SHA-256 块级去重、边缘与 SCF 双擎后端、五大 Serverless 数据库与 0 秒原子回滚。" />
  <meta property="og:image" content="https://myship.ship.onehub.top/og-banner.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="MyShip 与戴纸船帽的小海豹 Skipper" />
  <meta name="twitter:image:alt" content="MyShip 与戴纸船帽的小海豹 Skipper" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="MyShip — 自有云海，一令启航" />
  <meta name="twitter:image" content="https://myship.ship.onehub.top/og-banner.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" media="print" onload="this.media='all'" />
  <script>
    (function() {
      try {
        if ('scrollRestoration' in history) {
          history.scrollRestoration = 'manual';
        }
        var saved = localStorage.getItem('myship-theme') || 'dark';
        var isDark = saved === 'dark' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', isDark);
      } catch (e) {}
    })();
  </script>
  <style>
${bundledCss}
  </style>
</head>
<body>
  <header class="navbar">
    <div class="navbar-inner">
      <div style="display:flex;align-items:center;gap:20px;min-width:0;">
        <a class="brand" href="#/portal" data-switch-view="portal" title="MyShip — 自有云海，一令启航 (Your Cloud. Your Fleet. One Command to Ship.)">
          <img class="brand-icon" src="/logo.svg" alt="" width="32" height="32" />
          <span>MyShip</span>
          <span class="brand-badge">v${ROOT_PKG.version} · BYOC</span>
        </a>
        <nav class="nav-tabs">
          <button type="button" class="nav-tab active" data-switch-view="portal">🏠 产品门户</button>
          <button type="button" class="nav-tab" data-switch-doc="quickstart">📘 5分钟快速上手</button>
          <button type="button" class="nav-tab" data-switch-doc="self-hosting">🛠️ 自建云底座指南</button>
          <button type="button" class="nav-tab" data-switch-doc="architecture">🏗️ CAS 与全栈原理</button>
          <button type="button" class="nav-tab" data-switch-doc="roadmap">🧭 愿景与蓝图</button>
        </nav>
      </div>
      <div class="nav-right">
        <button type="button" class="search-trigger" id="open-search-btn">
          <span>🔍 搜索文档与命令...</span>
          <span class="search-kbd">⌘K</span>
        </button>
        <a href="/llms.txt" target="_blank" class="icon-btn" title="查看 AI Ready /llms.txt">
          <span style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:700;">AI</span>
        </a>
        <button type="button" class="icon-btn" id="theme-toggle-btn" title="切换深色 / 浅色模式">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <a href="https://github.com/huxy2023/myship" target="_blank" rel="noopener" class="icon-btn" title="GitHub 开源仓库">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        </a>
      </div>
    </div>
  </header>

  ${renderPortalView()}
  ${renderDocsView(parsedDocs)}

  <footer class="site-footer">
    <div class="site-footer-inner">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <img src="/logo.svg" alt="MyShip Logo" width="26" height="26" style="border-radius:6px;display:block;" />
        <div>
          <strong>MyShip</strong> · <span style="color:var(--accent);font-weight:600;">自有云海，一令启航。</span>
          <span style="opacity:0.8;">(Your Cloud. Your Fleet. One Command to Ship. · MIT License)</span>
        </div>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
        <a href="https://github.com/huxy2023/myship" target="_blank" rel="noopener" class="doc-link">GitHub</a>
        <a href="https://www.npmjs.com/package/@myship/cli" target="_blank" rel="noopener" class="doc-link">NPM (@myship/cli)</a>
        <a href="https://fullstack-starter.ship.onehub.top" target="_blank" rel="noopener" class="doc-link">Full-Stack Starter</a>
        <a href="/skill/SKILL.md" target="_blank" class="doc-link">AI Skill (SKILL.md)</a>
        <a href="/mascot-skipper.svg" target="_blank" class="doc-link">吉祥物 Skipper</a>
        <a href="/llms.txt" target="_blank" class="doc-link">llms.txt</a>
        <a href="/llms-full.txt" target="_blank" class="doc-link">llms-full.txt</a>
      </div>
    </div>
  </footer>

  <div class="search-backdrop" id="search-modal">
    <div class="search-modal">
      <div class="search-input-bar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-soft);"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="search-input" placeholder="输入关键词搜索命令 (myship use)、架构原理、自建云底座避坑指南..." autocomplete="off" />
        <span class="search-kbd">ESC</span>
      </div>
      <div class="search-results" id="search-results"></div>
      <div class="search-footer-hint">
        <span><kbd class="search-kbd">↑</kbd> <kbd class="search-kbd">↓</kbd> 选择章节 · <kbd class="search-kbd">Enter</kbd> 精准定位跳转</span>
        <span>支持全文与命令检索</span>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    window.__MYSHIP_SITE_DATA__ = {
      DOCS_DATA: ${JSON.stringify(clientDocsPayload)},
      SEARCH_INDEX: ${JSON.stringify(searchEntries)},
      MCP_CONFIG: ${JSON.stringify(JSON.stringify(mcpConfig, null, 2))}
    };
  </script>
  <script type="module">
${clientJs}
  </script>
</body>
</html>`;
}

function buildEdgeFunctions(apiDir) {
  mkdirSync(apiDir, { recursive: true });
  const apiHelloSource = `/**
 * api/hello.js — MyShip Phase 2 约定式边缘 Serverless 云函数在线示例
 * 自动映射路由: GET / POST https://<subdomain>/api/hello
 */
export async function GET(request, context) {
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || 'MyShip Pioneer';

  return {
    ok: true,
    phase: 'Phase 2 · Convention-Based Serverless Functions (api/*.js)',
    message: \`⚡ Hello, \${name}! Executed at Edge V8 Isolate with 0ms atomic version binding.\`,
    runtime: 'EdgeOne-CAS-Gateway/2.0 (V8 Isolate)',
    project: context.project,
    subdomain: context.subdomain,
    deploymentId: context.deploymentId,
    route: context.route,
    functionSha256: context.functionSha256,
    clientIp: context.clientIp || undefined,
    geo: context.geo && Object.keys(context.geo).length > 0 ? context.geo : undefined,
    timestamp: new Date().toISOString(),
  };
}

export async function POST(request, context) {
  let body = {};
  try {
    body = await request.json();
  } catch {}
  return {
    ok: true,
    method: 'POST',
    received: body,
    deploymentId: context.deploymentId,
    functionSha256: context.functionSha256,
    timestamp: new Date().toISOString(),
  };
}
`;
  writeFileSync(resolve(apiDir, 'hello.js'), apiHelloSource, 'utf-8');

  const apiInspectSource = `/**
 * api/inspect.js — MyShip Phase 2 边缘环境探针与 Web Crypto 签名实测函数
 * 采用腾讯云 EdgeOne 官方推荐的 onRequestGet(context) / onRequestPost(context) 签名
 * 自动映射路由: GET / POST https://<subdomain>/api/inspect
 */
export async function onRequestGet(context) {
  const { request, query, clientIp, geo, deploymentId, subdomain, project, route, functionSha256 } = context;
  const payloadText = \`\${project}:\${subdomain}:\${deploymentId}:\${clientIp}:\${ query.seed || 'edgeone-v8' }\`;

  const encoded = new TextEncoder().encode(payloadText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const edgeSignature = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

  return Response.json({
    ok: true,
    functionName: 'api/inspect.js',
    signatureStyle: 'EdgeOne Official onRequestGet(context)',
    route,
    deployment: {
      project,
      subdomain,
      deploymentId,
      functionSha256,
    },
    edgeWebCrypto: {
      algorithm: 'SHA-256 (crypto.subtle.digest)',
      inputSeed: payloadText,
      digestHex: edgeSignature,
    },
    v8Capabilities: {
      webCryptoSubtle: typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined',
      responseJsonShim: typeof Response.json === 'function',
      cachesApi: typeof caches !== 'undefined',
      textEncoder: typeof TextEncoder !== 'undefined',
    },
    clientNetwork: {
      clientIp: clientIp || 'unknown',
      userAgent: request.headers.get('user-agent') || '',
      acceptLanguage: request.headers.get('accept-language') || '',
      geo: geo && Object.keys(geo).length > 0 ? geo : undefined,
    },
    timestamp: new Date().toISOString(),
  });
}

export async function onRequestPost(context) {
  let body = {};
  try {
    body = await context.request.json();
  } catch {}
  return Response.json({
    ok: true,
    functionName: 'api/inspect.js',
    signatureStyle: 'EdgeOne Official onRequestPost(context)',
    receivedBody: body,
    deploymentId: context.deploymentId,
    functionSha256: context.functionSha256,
    timestamp: new Date().toISOString(),
  });
}
`;
  writeFileSync(resolve(apiDir, 'inspect.js'), apiInspectSource, 'utf-8');
}

function renderBrandBanner() {
  const innerMascot = MASCOT_SVG
    .replace(/^<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="banner-title">
  <title id="banner-title">MyShip — 自有云海，一令启航。</title>
  <rect width="1200" height="630" fill="#FFF9F1"/>
  <rect x="690" y="72" width="450" height="486" rx="64" fill="#EDF5FA"/>
  <g fill="#243B4E" font-family="Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif">
    <text x="72" y="122" font-size="46" font-weight="700" letter-spacing="-1.5">MyShip</text>
    <text x="74" y="164" font-size="15" letter-spacing="3" fill="#587E99">OPEN SOURCE · YOUR CLOUD</text>
    <text x="68" y="278" font-size="64" font-weight="600">自有云海，</text>
    <text x="68" y="360" font-size="64" font-weight="600">一令启航。</text>
    <text x="74" y="422" font-size="24" fill="#4D687B">把作品部署到你自己的云上。</text>
    <text x="74" y="486" font-size="19" fill="#4D687B">Your Cloud. Your Fleet. One Command to Ship.</text>
    <text x="74" y="558" font-size="17" fill="#587E99">myship.ship.onehub.top</text>
  </g>
  <svg x="705" y="95" width="420" height="420" viewBox="0 0 512 512">
    ${innerMascot}
  </svg>
</svg>`;
}

function buildAll() {
  mkdirSync(DIST_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(SKILL_DIST_DIR, { recursive: true });

  mkdirSync(PUBLIC_DIR, { recursive: true });

  // Export the same vector artwork used by the offline CLI console.
  writeFileSync(resolve(PUBLIC_DIR, 'mascot-skipper.svg'), MASCOT_SVG + '\n');
  writeFileSync(resolve(PUBLIC_DIR, 'logo.svg'), LOGO_SVG + '\n');
  writeFileSync(resolve(PUBLIC_DIR, 'favicon.svg'), FAVICON_SVG + '\n');
  writeFileSync(resolve(PUBLIC_DIR, 'og-banner.svg'), renderBrandBanner() + '\n');

  if (existsSync(PUBLIC_DIR)) {
    for (const file of readdirSync(PUBLIC_DIR)) {
      copyFileSync(resolve(PUBLIC_DIR, file), resolve(DIST_DIR, file));
    }
  }

  if (existsSync(SKILL_SRC_DIR)) {
    copyFileSync(resolve(SKILL_SRC_DIR, 'SKILL.md'), resolve(SKILL_DIST_DIR, 'SKILL.md'));
    const refSrcDir = resolve(SKILL_SRC_DIR, 'references');
    const refDistDir = resolve(SKILL_DIST_DIR, 'references');
    if (existsSync(refSrcDir)) {
      mkdirSync(refDistDir, { recursive: true });
      for (const refFile of readdirSync(refSrcDir)) {
        copyFileSync(resolve(refSrcDir, refFile), resolve(refDistDir, refFile));
      }
    }
  }

  const parsedDocs = [];
  const allSearchEntries = [];

  for (let idx = 0; idx < DOC_SOURCES.length; idx++) {
    const doc = DOC_SOURCES[idx];
    const prevDoc = idx > 0 ? DOC_SOURCES[idx - 1] : null;
    const nextDoc = idx < DOC_SOURCES.length - 1 ? DOC_SOURCES[idx + 1] : null;

    const rawMd = readFileSync(doc.filePath, 'utf-8');
    writeFileSync(resolve(DIST_DIR, doc.rawPath.slice(1)), rawMd, 'utf-8');

    const { html, toc, searchChunks } = parseMarkdownDocument(rawMd, doc.id, prevDoc, nextDoc);
    parsedDocs.push({
      ...doc,
      rawMd,
      html,
      toc,
    });

    for (const chunk of searchChunks) {
      const cleanText = chunk.text
        .replace(/[`*_~[\]()]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (cleanText.length > 8) {
        allSearchEntries.push({
          docId: doc.id,
          docTitle: doc.shortTitle,
          heading: chunk.heading,
          headingId: chunk.headingId || '',
          text: cleanText.slice(0, 220),
        });
      }
    }
  }

  const llmsTxt = `# MyShip — 基于自有云设施 (BYOC) 的高 DX 全栈部署、泛域名路由与云资源编排引擎

> MyShip 是面向独立开发者的开源 BYOC 全栈部署与云资源编排引擎，集零参数 CLI 极简发布、SHA-256 不可变多版本预览、项目级命名空间隔离、边缘与 SCF 全栈后端、声明式数据库与文件存储、0 秒原子回滚于一体。基于腾讯云 EdgeOne 标准站点（泛域名 *.ship.example.com + 边缘函数）、COS 内容寻址存储（CAS）、SCF Web 函数与五大 Serverless 数据库（CloudBase PG / Neon / Turso / D1 / MySQL）构建。

## 核心文档索引 (Documentation)

${parsedDocs.map((d) => `- [${d.title}](https://myship.ship.onehub.top${d.rawPath}): ${d.description}`).join('\n')}
- [MyShip AI Vibecoding Skill (SKILL.md)](https://myship.ship.onehub.top/skill/SKILL.md): 面向 Antigravity / Claude Code / Cursor 的全栈开发技能指令与 6 大防踩坑铁律（本机可通过 \`myship skill install -g\` 一键安装）
  - [Full-Stack Runtime Reference](https://myship.ship.onehub.top/skill/references/fullstack-runtime.md)
  - [CLI Automation & Troubleshooting Runbook](https://myship.ship.onehub.top/skill/references/cli-and-ops.md)

## 快速命令速查 (Quick CLI Reference)

- 全局安装: \`npm i -g @myship/cli\`
- 一键安装 AI Vibecoding 技能包 (Antigravity / Claude Code / Workspace): \`myship skill install -g\` 或 \`myship skill install\`
- 交互式登录与绑定自有云底座 (含 CAM 最小权限指引 / tccli 扫码 + 自动探测网关): \`myship login\`
- 一键同步全局 EdgeOne 边缘函数代码 (~/.myship/edgeone-function.dist.js): \`myship setup-edge\`
- 本地全栈即时开发服务器 (热重载静态页、api/*.js、SCF 后端与本地 node:sqlite): \`myship dev\`
- 零参数智能发布 (自动识别 .myship/project.json): \`myship\`
- 发布指定子环境: \`myship -d v2\` 或 \`myship ./dist v2\`
- 交互式声明并注入对象文件存储与五大数据库 (PG / Neon / Turso / D1 / MySQL): \`myship use\`
- 开启腾讯云 SCF Node.js 全栈后端 (esbuild 内联 SourceMap + 不可变版本冻结): \`myship backend enable\`
- 查询云端全栈运行日志与真实源码报错行号: \`myship logs [--error]\`
- 管理项目私有环境变量 (COS 私有存储，边缘 api/*.js 自动热更新，SCF 全栈后端需重新执行 myship 发布新版本生效): \`myship env <set|ls|rm|import|pull>\`
- 查看当前项目版本与域名: \`myship ls\` (全局按项目分组: \`myship ls --all\`)
- 0 秒一键回滚主域名 (前后端同帧回退，自动跳过已禁用版本): \`myship rollback\`
- 可逆上下线维护与漏洞版本封禁 (保留云资源与数据，边缘秒级拦截 503): \`myship offline [dpl_id | --alias <sub>] [--reason "维护中"]\` / \`myship online [dpl_id | --alias <sub>]\`
- CAS 垃圾回收与精确资源销毁: \`myship gc [--keep N | --older-than 7d]\` / \`myship rm <dpl_id | --alias | --project>\`
- 启动本机 127.0.0.1:4200 可视化 Web 管控台: \`myship console\`
`;
  writeFileSync(resolve(DIST_DIR, 'llms.txt'), llmsTxt, 'utf-8');

  const llmsFullTxt = parsedDocs
    .map(
      (d) =>
        `# ==========================================\n# DOC: ${d.title}\n# SOURCE: ${d.rawPath}\n# ==========================================\n\n${d.rawMd}`
    )
    .join('\n\n');
  writeFileSync(resolve(DIST_DIR, 'llms-full.txt'), llmsFullTxt, 'utf-8');

  const mcpConfig = {
    mcpServers: {
      'myship-docs': {
        url: 'https://myship.ship.onehub.top/llms.txt',
        description: 'MyShip BYOC CAS Deployment Engine Documentation & Self-Hosting Guide',
      },
    },
  };
  writeFileSync(resolve(DIST_DIR, 'mcp.json'), JSON.stringify(mcpConfig, null, 2), 'utf-8');

  const indexHtml = generateSiteHtml(parsedDocs, allSearchEntries, mcpConfig);
  writeFileSync(resolve(DIST_DIR, 'index.html'), indexHtml, 'utf-8');

  buildEdgeFunctions(resolve(DIST_DIR, 'api'));

  console.log(`✅ MyShip 现代化门户与文档站构建完成！输出目录: ${DIST_DIR}`);
  console.log(`   - 页面文档数: ${parsedDocs.length} 篇 (${parsedDocs.map((d) => d.shortTitle).join(' / ')})`);
  console.log(`   - 搜索索引条: ${allSearchEntries.length} 条 (支持章节锚点直达)`);
  console.log(`   - AI 原始文档: ${parsedDocs.map((d) => d.rawPath).join(', ')}`);
  console.log(`   - 边缘云函数:  /api/hello (api/hello.js), /api/inspect (api/inspect.js)`);
}

buildAll();
