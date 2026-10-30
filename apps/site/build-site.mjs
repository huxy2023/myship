#!/usr/bin/env node
/**
 * apps/site/build-site.mjs — MyShip 开源版零依赖门户与 Clarify 风格文档站构建器
 *
 * 设计原则：
 * 1. Single Source of Truth：直接读取仓库内 docs/*.md 文档生成全站
 * 2. Zero Dependency Bloat：纯 Node.js 原生构建，0.1 秒生成全套静态产物至 ./dist
 * 3. Clarify.pub 级交互体验：
 *    - 门户首页 (Hero 交互式终端演示 + 核心指标 + 架构拓扑 + 快速开始)
 *    - 三栏文档阅读器 (左侧章节树 + 中间排版正文 + 右侧实时滚动高亮 TOC)
 *    - Mermaid 交互式画布 (支持鼠标滚轮缩放、拖拽平移、放大/缩小/100%复位、全屏预览、深浅色自适应)
 *    - 右上角 Clarify 同款 AI 操作下拉菜单：
 *      [复制页面] | [以 Markdown 格式查看 ↗] | [复制 Markdown 链接] | [复制 llms.txt] | [复制 MCP 配置]
 *    - ⌘K 全文瞬时搜索弹窗 + 深浅色主题切换
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const DIST_DIR = resolve(__dirname, 'dist');
const RAW_DIR = resolve(DIST_DIR, 'raw');

const DOC_SOURCES = [
  {
    id: 'quickstart',
    category: '快速上手 · Quickstart',
    title: '5 分钟快速上手与 CLI 命令全解',
    shortTitle: '5 分钟快速上手',
    badge: 'Quickstart',
    description:
      '涵盖免云账号本地沙盒体验、全局安装、myship login、.myship/project.json 多项目命名空间隔离、myship ls 与 0 秒回滚。',
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
      '一步步指导你在 10 分钟内用自己的腾讯云 COS、DNSPod 与 EdgeOne 标准站点搭建专属部署平台，含泛域名免费 HTTPS 证书避坑指南。',
    filePath: resolve(ROOT_DIR, 'docs/02-self-hosting-guide.md'),
    rawPath: '/raw/02-self-hosting-guide.md',
  },
  {
    id: 'architecture',
    category: '架构深度 · Architecture',
    title: 'CAS 三级指针架构原理与成本拆解',
    shortTitle: 'CAS 架构原理拆解',
    badge: 'Architecture',
    description:
      '深度对比传统目录覆盖模型与 CAS 内容寻址 + 动态指针模型，剖析 blobs / manifests / aliases 如何实现无限版本保留与 0 秒切流。',
    filePath: resolve(ROOT_DIR, 'docs/03-architecture.md'),
    rawPath: '/raw/03-architecture.md',
  },
  {
    id: 'roadmap',
    category: '产品规划 · Vision & Roadmap',
    title: '产品愿景与极致 DX 演进路线图',
    shortTitle: '愿景与演进路线图',
    badge: 'Roadmap',
    description:
      '定义 MyShip 的三大 DX 黄金准则，以及约定式 Serverless 云函数 (api/*.js)、前后端原子切换与 CAS 垃圾回收演进规划。',
    filePath: resolve(ROOT_DIR, 'docs/04-roadmap.md'),
    rawPath: '/raw/04-roadmap.md',
  },
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~()[\]{}<>#!?:;,.\\/|+$^&=@"']/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function renderInlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/\$\\rightarrow\$/g, '→');
  out = out.replace(/\$\\times\$/g, '×');
  const codeTokens = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code class="inline-code">${code}</code>`);
    return `@@INLINE_CODE_${idx}@@`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const isExternal = url.startsWith('http');
    const target = isExternal ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${url}" class="doc-link"${target}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/@@INLINE_CODE_(\d+)@@/g, (_, idx) => codeTokens[Number(idx)]);
  return out;
}

function parseMarkdownDocument(rawMd, docId) {
  const lines = rawMd.replace(/\r\n/g, '\n').split('\n');
  const toc = [];
  const searchChunks = [];
  let html = '';
  let i = 0;
  let currentHeading = '概览';
  let mermaidCounter = 0;
  let codeCounter = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Fenced code block
    const fenceMatch = line.match(/^(\s*)```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = (fenceMatch[2] || 'text').toLowerCase();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].match(/^(\s*)```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const rawCode = codeLines.join('\n');

      if (lang === 'mermaid') {
        mermaidCounter++;
        const chartId = `mermaid-${docId}-${mermaidCounter}`;
        html += `
<div class="mermaid-card" data-mermaid-wrapper="${chartId}">
  <div class="mermaid-toolbar">
    <div class="mermaid-toolbar-left">
      <span class="mermaid-badge">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        架构视图 · 支持滚轮缩放与拖拽平移
      </span>
    </div>
    <div class="mermaid-toolbar-actions">
      <button type="button" class="m-btn" data-m-action="zoom-out" title="缩小 (Zoom Out)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <span class="m-zoom-level" data-m-scale>100%</span>
      <button type="button" class="m-btn" data-m-action="zoom-in" title="放大 (Zoom In)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      </button>
      <button type="button" class="m-btn" data-m-action="reset" title="重置视图 (100%)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
      </button>
      <button type="button" class="m-btn" data-m-action="fullscreen" title="全屏查看图表">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </div>
  </div>
  <div class="mermaid-viewport" data-m-viewport>
    <div class="mermaid-canvas" data-m-canvas>
      <pre class="mermaid-source" id="${chartId}">${escapeHtml(rawCode)}</pre>
    </div>
  </div>
</div>`;
      } else {
        codeCounter++;
        const codeId = `code-${docId}-${codeCounter}`;
        html += `
<div class="code-card">
  <div class="code-card-header">
    <span class="code-lang">${escapeHtml(lang)}</span>
    <button type="button" class="copy-code-btn" data-copy-target="${codeId}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>复制代码</span>
    </button>
  </div>
  <pre class="code-pre"><code id="${codeId}" class="lang-${escapeHtml(lang)}">${escapeHtml(rawCode)}</code></pre>
</div>`;
      }
      continue;
    }

    if (line.match(/^---+\s*$/)) {
      html += '<hr class="doc-hr" />\n';
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawTitle = headingMatch[2].trim();
      const plainTitle = rawTitle
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1');
      const slug = `${docId}-${slugify(plainTitle) || `sec-${i}`}`;
      currentHeading = plainTitle;

      if (level === 2 || level === 3) {
        toc.push({ level, title: plainTitle, id: slug });
      }
      html += `<h${level} id="${slug}" class="doc-h${level}"><a href="#${slug}" class="heading-anchor">#</a>${renderInlineMarkdown(rawTitle)}</h${level}>\n`;
      i++;
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('---')) {
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      html += '<div class="table-wrapper"><table class="doc-table"><thead><tr>';
      for (const h of headers) {
        html += `<th>${renderInlineMarkdown(h)}</th>`;
      }
      html += '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>';
        for (let c = 0; c < headers.length; c++) {
          html += `<td>${renderInlineMarkdown(r[c] || '')}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>\n';
      searchChunks.push({
        heading: currentHeading,
        text: rows.map((r) => r.join(' ')).join(' '),
      });
      continue;
    }

    if (line.trim().startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      html += `<div class="doc-callout"><div class="doc-callout-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></div><div class="doc-callout-body">${quoteLines.map((l) => `<p>${renderInlineMarkdown(l)}</p>`).join('')}</div></div>\n`;
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const isOrdered = /\d+\./.test(listMatch[2]);
      const tag = isOrdered ? 'ol' : 'ul';
      html += `<${tag} class="doc-list">`;
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
        if (!m) break;
        let itemHtml = renderInlineMarkdown(m[3]);
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== '' &&
          !lines[i].match(/^(\s*)([-*]|\d+\.)\s+/) &&
          !lines[i].match(/^#{1,4}\s+/) &&
          !lines[i].match(/^(\s*)```/) &&
          lines[i].startsWith('  ')
        ) {
          itemHtml += `<br/><span class="list-subline">${renderInlineMarkdown(lines[i].trim())}</span>`;
          i++;
        }
        html += `<li>${itemHtml}</li>`;
        searchChunks.push({ heading: currentHeading, text: m[3] });
      }
      html += `</${tag}>\n`;
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].match(/^#{1,4}\s+/) &&
      !lines[i].match(/^(\s*)```/) &&
      !lines[i].match(/^---+\s*$/) &&
      !lines[i].trim().startsWith('|') &&
      !lines[i].trim().startsWith('>') &&
      !lines[i].match(/^(\s*)([-*]|\d+\.)\s+/)
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    const paraText = paraLines.join(' ');
    html += `<p class="doc-p">${renderInlineMarkdown(paraText)}</p>\n`;
    searchChunks.push({ heading: currentHeading, text: paraText });
  }

  return { html, toc, searchChunks };
}

function buildAll() {
  mkdirSync(DIST_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });

  const parsedDocs = [];
  const allSearchEntries = [];

  for (const doc of DOC_SOURCES) {
    const rawMd = readFileSync(doc.filePath, 'utf-8');
    writeFileSync(resolve(DIST_DIR, doc.rawPath.slice(1)), rawMd, 'utf-8');

    const { html, toc, searchChunks } = parseMarkdownDocument(rawMd, doc.id);
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
          text: cleanText.slice(0, 220),
        });
      }
    }
  }

  const llmsTxt = `# MyShip — 基于自有云设施 (BYOC) 的高 DX 部署与泛域名路由引擎

> MyShip 是融合 surge.sh（极简 CLI）与 Vercel（不可变多版本预览、项目级命名空间隔离、0 秒原子回滚）的开源 BYOC 部署引擎。基于腾讯云 EdgeOne 标准站点（泛域名 *.ship.example.com + 边缘函数）与 COS 内容寻址存储（CAS）构建。

## 核心文档索引 (Documentation)

${parsedDocs.map((d) => `- [${d.title}](https://myship.ship.onehub.top${d.rawPath}): ${d.description}`).join('\n')}

## 快速命令速查 (Quick CLI Reference)

- 全局安装: \`npm i -g @myship/cli\`
- 交互式登录与绑定自有云底座 (含 CAM 最小权限指引 / tccli 扫码 + 自动探测网关): \`myship login\`
- 一键生成并自动上传全局 EdgeOne 边缘函数代码 (~/.myship/edgeone-function.dist.js): \`myship setup-edge\`
- 零参数智能发布 (自动识别 .myship/project.json): \`myship\`
- 发布指定子环境: \`myship -d v2\` 或 \`myship ./dist v2\`
- 查看当前项目版本与域名: \`myship ls\` (全局按项目分组: \`myship ls --all\`)
- 0 秒一键回滚主域名: \`myship rollback\`
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

  // 生成 Phase 2 约定式 Serverless 云函数 (api/hello.js 与 api/status.js)
  const apiDir = resolve(DIST_DIR, 'api');
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

  console.log(`✅ MyShip 开源版门户与 Clarify 风格文档站构建完成！输出目录: ${DIST_DIR}`);
  console.log(`   - 页面文档数: ${parsedDocs.length} 篇 (${parsedDocs.map((d) => d.shortTitle).join(' / ')})`);
  console.log(`   - AI 原始文档: ${parsedDocs.map((d) => d.rawPath).join(', ')}`);
  console.log(`   - 边缘云函数:  /api/hello (约定式 api/hello.js)`);
  console.log(`   - LLM 索引:    /llms.txt, /llms-full.txt, /mcp.json`);
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

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MyShip — 基于自有云设施 (BYOC) 的高 DX 部署与泛域名路由引擎</title>
  <meta name="description" content="融合 surge.sh 极简 CLI 与 Vercel 不可变多版本预览。基于自有 EdgeOne 泛域名边缘函数与腾讯云 COS 内容寻址存储 (CAS)，实现无限版本保留与 0 秒原子回滚。" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" />
  <script>
    (function() {
      try {
        var saved = localStorage.getItem('myship-theme') || 'light';
        var isDark = saved === 'dark' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.classList.toggle('dark', isDark);
      } catch (e) {}
    })();
  </script>
  <style>
    :root {
      --bg: #ffffff;
      --bg-subtle: #f8fafc;
      --bg-muted: #f1f5f9;
      --bg-elevated: #ffffff;
      --bg-glass: rgba(255, 255, 255, 0.86);
      --text-strong: #0f172a;
      --text-body: #334155;
      --text-soft: #64748b;
      --text-faint: #94a3b8;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --accent: #0284c7;
      --accent-soft: rgba(2, 132, 199, 0.08);
      --accent-border: rgba(2, 132, 199, 0.25);
      --code-bg: #f8fafc;
      --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
      --shadow-md: 0 10px 30px -5px rgba(15, 23, 42, 0.08), 0 4px 12px -2px rgba(15, 23, 42, 0.04);
      --shadow-pop: 0 16px 40px -4px rgba(15, 23, 42, 0.12), 0 4px 12px -2px rgba(15, 23, 42, 0.06);
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --nav-h: 60px;
    }
    html.dark {
      --bg: #090d16;
      --bg-subtle: #0f1623;
      --bg-muted: #162032;
      --bg-elevated: #111827;
      --bg-glass: rgba(9, 13, 22, 0.84);
      --text-strong: #f8fafc;
      --text-body: #cbd5e1;
      --text-soft: #94a3b8;
      --text-faint: #64748b;
      --border: #1e293b;
      --border-strong: #334155;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.12);
      --accent-border: rgba(56, 189, 248, 0.3);
      --code-bg: #0d131f;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
      --shadow-md: 0 10px 30px -5px rgba(0, 0, 0, 0.5);
      --shadow-pop: 0 20px 45px -5px rgba(0, 0, 0, 0.65);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; scroll-padding-top: 84px; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: var(--bg);
      color: var(--text-body);
      line-height: 1.65;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .navbar {
      position: sticky;
      top: 0;
      z-index: 50;
      height: var(--nav-h);
      background: var(--bg-glass);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
    }
    .navbar-inner {
      max-width: 1400px;
      margin: 0 auto;
      height: 100%;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--text-strong);
      font-family: 'Familjen Grotesk', sans-serif;
      font-weight: 700;
      font-size: 1.2rem;
      letter-spacing: -0.02em;
      cursor: pointer;
    }
    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35);
    }
    .brand-badge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      border: 1px solid var(--accent-border);
    }
    .nav-tabs { display: flex; align-items: center; gap: 4px; }
    .nav-tab {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--text-soft);
      font-size: 0.86rem;
      font-weight: 500;
      padding: 7px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .nav-tab:hover { color: var(--text-strong); background: var(--bg-subtle); }
    .nav-tab.active { color: var(--accent); background: var(--accent-soft); font-weight: 600; }
    .nav-right { display: flex; align-items: center; gap: 10px; }
    .search-trigger {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      height: 36px;
      padding: 0 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-subtle);
      color: var(--text-soft);
      font-size: 0.84rem;
      cursor: pointer;
    }
    .search-kbd {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.72rem;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-faint);
    }
    .icon-btn {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text-body);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      text-decoration: none;
    }
    .view-section { display: none; }
    .view-section.active { display: block; }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 68px 24px 56px;
      border-bottom: 1px solid var(--border);
      background: radial-gradient(800px 380px at 50% -80px, var(--accent-soft), transparent 70%);
    }
    .hero-grid {
      max-width: 1260px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 1.08fr 0.92fr;
      gap: 48px;
      align-items: center;
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid var(--accent-border);
      margin-bottom: 20px;
    }
    .hero-title {
      font-family: 'Familjen Grotesk', 'Inter', sans-serif;
      font-size: clamp(2.2rem, 4vw, 3.3rem);
      line-height: 1.12;
      letter-spacing: -0.03em;
      color: var(--text-strong);
      font-weight: 700;
      margin-bottom: 20px;
    }
    .hero-title span {
      background: linear-gradient(135deg, #0284c7 0%, #4f46e5 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    html.dark .hero-title span {
      background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .hero-desc { font-size: 1.04rem; color: var(--text-soft); margin-bottom: 28px; max-width: 580px; }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 28px; }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 11px 20px;
      border-radius: var(--radius-sm);
      background: var(--text-strong);
      color: var(--bg);
      font-weight: 600;
      font-size: 0.92rem;
      border: none;
      cursor: pointer;
    }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 11px 18px;
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--text-strong);
      font-weight: 500;
      font-size: 0.92rem;
      border: 1px solid var(--border-strong);
      cursor: pointer;
    }
    .quick-install-bar {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      border-radius: var(--radius-sm);
      background: var(--code-bg);
      border: 1px solid var(--border);
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.83rem;
      color: var(--text-strong);
    }
    .quick-install-bar button { border: none; background: transparent; color: var(--text-soft); cursor: pointer; }
    .terminal-card {
      background: #0b101b;
      border: 1px solid #1e293b;
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      overflow: hidden;
      color: #e2e8f0;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }
    .terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: #111827;
      border-bottom: 1px solid #1e293b;
    }
    .terminal-dots { display: flex; gap: 6px; }
    .terminal-dots span { width: 10px; height: 10px; border-radius: 50%; }
    .terminal-tabs { display: flex; gap: 4px; }
    .term-tab {
      border: none;
      background: transparent;
      color: #94a3b8;
      font-family: inherit;
      font-size: 0.74rem;
      padding: 4px 9px;
      border-radius: 6px;
      cursor: pointer;
    }
    .term-tab.active { background: rgba(56, 189, 248, 0.16); color: #38bdf8; font-weight: 600; }
    .terminal-body { padding: 18px; min-height: 270px; line-height: 1.6; white-space: pre-wrap; }
    .t-cmd { color: #38bdf8; font-weight: 600; }
    .t-dim { color: #64748b; }
    .t-ok { color: #34d399; }
    .t-url { color: #a78bfa; text-decoration: underline; }
    .portal-container { max-width: 1260px; margin: 0 auto; padding: 56px 24px 80px; }
    .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; margin-bottom: 56px; }
    .stat-card { padding: 22px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg-subtle); }
    .stat-val { font-family: 'Familjen Grotesk', sans-serif; font-size: 2rem; font-weight: 700; color: var(--text-strong); margin-bottom: 4px; }
    .stat-label { font-size: 0.86rem; color: var(--text-soft); }
    .section-head { margin-bottom: 28px; }
    .section-head h2 { font-family: 'Familjen Grotesk', sans-serif; font-size: 1.75rem; color: var(--text-strong); margin-bottom: 6px; }
    .section-head p { color: var(--text-soft); font-size: 0.96rem; }
    .feature-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px; }
    .feature-card { padding: 22px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--bg); cursor: pointer; transition: border-color 0.15s; }
    .feature-card:hover { border-color: var(--accent); }
    .feature-card h3 { font-size: 1rem; color: var(--text-strong); margin-bottom: 8px; }
    .feature-card p { font-size: 0.85rem; color: var(--text-soft); }
    .docs-layout {
      max-width: 1420px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 268px minmax(0, 1fr) 248px;
      gap: 36px;
      padding: 0 24px;
      align-items: start;
    }
    .docs-sidebar-left {
      position: sticky;
      top: var(--nav-h);
      height: calc(100vh - var(--nav-h));
      overflow-y: auto;
      padding: 28px 12px 40px 0;
      border-right: 1px solid var(--border);
    }
    .sidebar-group { margin-bottom: 22px; }
    .sidebar-group-title { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); padding: 0 10px; margin-bottom: 6px; }
    .sidebar-item {
      display: flex;
      align-items: center;
      width: 100%;
      text-align: left;
      border: none;
      background: transparent;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      font-size: 0.88rem;
      color: var(--text-body);
      cursor: pointer;
    }
    .sidebar-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .sidebar-sublist { margin-top: 4px; margin-left: 12px; padding-left: 10px; border-left: 1px solid var(--border); display: flex; flex-direction: column; gap: 2px; }
    .sidebar-sublink { display: block; padding: 5px 8px; font-size: 0.8rem; color: var(--text-soft); text-decoration: none; border-radius: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .docs-main { padding: 32px 0 88px; min-width: 0; }
    .doc-topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid var(--border); }
    .doc-eyebrow { font-size: 0.8rem; font-weight: 600; color: var(--accent); margin-bottom: 6px; }
    .doc-desc-banner { font-size: 0.94rem; color: var(--text-soft); }
    .clarify-page-actions { position: relative; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .clarify-copy-main-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 38px;
      padding: 0 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-strong);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      white-space: nowrap;
    }
    .clarify-dropdown-trigger {
      width: 38px;
      height: 38px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text-body);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
    }
    .clarify-dropdown-menu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      width: 320px;
      padding: 8px;
      border-radius: 16px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      box-shadow: var(--shadow-pop);
      z-index: 60;
      display: none;
    }
    .clarify-dropdown-menu.open { display: block; }
    .clarify-menu-item {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 10px 12px;
      border-radius: 12px;
      border: none;
      background: transparent;
      text-align: left;
      text-decoration: none;
      cursor: pointer;
    }
    .clarify-menu-item:hover { background: var(--bg-subtle); }
    .clarify-menu-icon {
      width: 36px;
      height: 36px;
      border-radius: 9px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text-body);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .clarify-menu-title { font-size: 0.9rem; font-weight: 600; color: var(--text-strong); display: flex; align-items: center; gap: 5px; }
    .clarify-menu-desc { font-size: 0.78rem; color: var(--text-soft); margin-top: 2px; }
    .doc-h1 { font-family: 'Familjen Grotesk', sans-serif; font-size: 2rem; color: var(--text-strong); margin: 8px 0 18px; }
    .doc-h2 { font-family: 'Familjen Grotesk', sans-serif; font-size: 1.42rem; color: var(--text-strong); margin: 40px 0 14px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .doc-h3 { font-size: 1.12rem; color: var(--text-strong); margin: 28px 0 10px; }
    .doc-h4 { font-size: 0.98rem; color: var(--text-strong); margin: 20px 0 8px; }
    .heading-anchor { color: var(--text-faint); text-decoration: none; margin-right: 8px; opacity: 0; }
    .doc-h2:hover .heading-anchor, .doc-h3:hover .heading-anchor { opacity: 1; }
    .doc-p { margin: 12px 0; color: var(--text-body); font-size: 0.95rem; }
    .doc-list { margin: 10px 0 16px 22px; color: var(--text-body); font-size: 0.95rem; }
    .doc-list li { margin: 6px 0; }
    .doc-hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
    .inline-code { font-family: 'JetBrains Mono', monospace; font-size: 0.83em; padding: 2px 6px; border-radius: 5px; background: var(--bg-muted); color: var(--text-strong); border: 1px solid var(--border); }
    .doc-link { color: var(--accent); text-decoration: none; border-bottom: 1px dashed var(--accent-border); }
    .doc-callout { display: flex; gap: 12px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--accent-soft); border: 1px solid var(--accent-border); margin: 16px 0; }
    .table-wrapper { overflow-x: auto; margin: 18px 0; border: 1px solid var(--border); border-radius: var(--radius-md); }
    .doc-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    .doc-table th { background: var(--bg-subtle); color: var(--text-strong); font-weight: 600; text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); }
    .doc-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--text-body); }
    .code-card { margin: 16px 0; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--code-bg); overflow: hidden; }
    .code-card-header { display: flex; align-items: center; justify-content: space-between; padding: 7px 14px; border-bottom: 1px solid var(--border); background: var(--bg-subtle); }
    .code-lang { font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; font-weight: 600; text-transform: uppercase; color: var(--text-soft); }
    .copy-code-btn { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border); background: var(--bg); color: var(--text-soft); font-size: 0.76rem; padding: 3px 9px; border-radius: 6px; cursor: pointer; }
    .code-pre { padding: 14px 16px; overflow-x: auto; font-family: 'JetBrains Mono', monospace; font-size: 0.83rem; line-height: 1.6; color: var(--text-strong); }
    .mermaid-card { margin: 20px 0; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-subtle); overflow: hidden; }
    .mermaid-card.fullscreen { position: fixed; inset: 20px; margin: 0; z-index: 100; display: flex; flex-direction: column; background: var(--bg); box-shadow: var(--shadow-pop); }
    .mermaid-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: var(--bg); border-bottom: 1px solid var(--border); }
    .mermaid-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-soft); }
    .mermaid-toolbar-actions { display: flex; align-items: center; gap: 4px; }
    .m-btn { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text-body); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
    .m-zoom-level { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: var(--text-soft); min-width: 46px; text-align: center; }
    .mermaid-viewport { position: relative; height: 360px; overflow: hidden; cursor: grab; user-select: none; display: flex; align-items: center; justify-content: center; background-image: radial-gradient(var(--border-strong) 1px, transparent 1px); background-size: 18px 18px; }
    .mermaid-card.fullscreen .mermaid-viewport { flex: 1; height: auto; }
    .mermaid-viewport.grabbing { cursor: grabbing; }
    .mermaid-canvas { transform-origin: center center; transition: transform 0.06s ease-out; padding: 20px; }
    .docs-sidebar-right { position: sticky; top: var(--nav-h); height: calc(100vh - var(--nav-h)); overflow-y: auto; padding: 28px 0 40px 12px; }
    .toc-title { font-size: 0.76rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-strong); margin-bottom: 12px; display: flex; align-items: center; gap: 6px; }
    .toc-list { list-style: none; border-left: 1px solid var(--border); }
    .toc-link { display: block; padding: 5px 0 5px 14px; font-size: 0.81rem; color: var(--text-soft); text-decoration: none; border-left: 2px solid transparent; margin-left: -1px; }
    .toc-link.level-3 { padding-left: 26px; font-size: 0.78rem; }
    .toc-link.active { color: var(--accent); border-left-color: var(--accent); font-weight: 600; }
    .search-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55); backdrop-filter: blur(4px); z-index: 90; display: none; align-items: flex-start; justify-content: center; padding-top: 90px; }
    .search-backdrop.open { display: flex; }
    .search-modal { width: 100%; max-width: 620px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 16px; box-shadow: var(--shadow-pop); overflow: hidden; }
    .search-input-bar { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
    .search-input-bar input { flex: 1; border: none; background: transparent; color: var(--text-strong); font-size: 0.98rem; outline: none; }
    .search-results { max-height: 380px; overflow-y: auto; padding: 8px; }
    .search-result-item { display: block; width: 100%; text-align: left; padding: 10px 14px; border-radius: 10px; border: none; background: transparent; cursor: pointer; }
    .search-result-item:hover { background: var(--bg-subtle); }
    .search-result-meta { font-size: 0.75rem; font-weight: 600; color: var(--accent); margin-bottom: 2px; }
    .search-result-snippet { font-size: 0.85rem; color: var(--text-body); }
    .toast { position: fixed; bottom: 24px; right: 24px; padding: 10px 16px; border-radius: 10px; background: var(--text-strong); color: var(--bg); font-size: 0.85rem; font-weight: 500; box-shadow: var(--shadow-md); z-index: 120; opacity: 0; transform: translateY(10px); pointer-events: none; transition: all 0.2s ease; }
    .toast.show { opacity: 1; transform: translateY(0); }
    @media (max-width: 1080px) {
      .hero-grid, .feature-grid { grid-template-columns: 1fr; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .docs-layout { grid-template-columns: 1fr; }
      .docs-sidebar-left, .docs-sidebar-right { display: none; }
    }
  </style>
</head>
<body>
  <header class="navbar">
    <div class="navbar-inner">
      <div style="display:flex;align-items:center;gap:20px;">
        <a class="brand" data-switch-view="portal">
          <span class="brand-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </span>
          <span>MyShip</span>
          <span class="brand-badge">Open-Source BYOC</span>
        </a>
        <nav class="nav-tabs">
          <button type="button" class="nav-tab active" data-switch-view="portal">🏠 产品门户</button>
          <button type="button" class="nav-tab" data-switch-doc="quickstart">📘 5分钟快速上手</button>
          <button type="button" class="nav-tab" data-switch-doc="self-hosting">🛠️ 自建云底座指南</button>
          <button type="button" class="nav-tab" data-switch-doc="architecture">🏗️ CAS 架构原理</button>
          <button type="button" class="nav-tab" data-switch-doc="roadmap">🧭 演进路线图</button>
        </nav>
      </div>
      <div class="nav-right">
        <button type="button" class="search-trigger" id="open-search-btn">
          <span>🔍 搜索文档...</span>
          <span class="search-kbd">⌘K</span>
        </button>
        <a href="/llms.txt" target="_blank" class="icon-btn" title="查看 AI Ready /llms.txt">
          <span style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:700;">AI</span>
        </a>
        <button type="button" class="icon-btn" id="theme-toggle-btn" title="切换深色 / 浅色模式">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <a href="https://github.com/huxy2023/myship" target="_blank" rel="noopener" class="icon-btn" title="GitHub 仓库">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/></svg>
        </a>
      </div>
    </div>
  </header>

  <main id="view-portal" class="view-section active">
    <section class="hero">
      <div class="hero-grid">
        <div>
          <div class="eyebrow">
            <span>⚡ BYOC 自有云设施 · EdgeOne 泛域名网关 + 腾讯云 COS 内容寻址</span>
          </div>
          <h1 class="hero-title">
            用你自己的云设施，<br/>
            <span>10 分钟搭一套私人 Vercel + Surge。</span>
          </h1>
          <p class="hero-desc">
            <strong>MyShip</strong> 是零外部依赖的开源 CAS 部署引擎。通过 <code>.myship/project.json</code> 自动隔离多项目命名空间，支持无限历史版本保留、SHA-256 块级去重与 0 秒原子回滚。
          </p>
          <div class="hero-actions">
            <button type="button" class="btn-primary" data-switch-doc="self-hosting">
              <span>10 分钟自建云底座指南 →</span>
            </button>
            <button type="button" class="btn-secondary" data-switch-doc="quickstart">
              <span>5 分钟 CLI 快速上手</span>
            </button>
          </div>
          <div class="quick-install-bar">
            <span>$ npm i -g @myship/cli &amp;&amp; myship login</span>
            <button type="button" id="hero-copy-cmd" title="复制安装命令">📋</button>
          </div>
        </div>

        <div class="terminal-card">
          <div class="terminal-header">
            <div class="terminal-dots">
              <span style="background:#ef4444;"></span>
              <span style="background:#f59e0b;"></span>
              <span style="background:#10b981;"></span>
            </div>
            <div class="terminal-tabs">
              <button type="button" class="term-tab active" data-term-tab="deploy">1. 零参数发布</button>
              <button type="button" class="term-tab" data-term-tab="serverless">2. 全栈云函数</button>
              <button type="button" class="term-tab" data-term-tab="namespace">3. 命名空间</button>
              <button type="button" class="term-tab" data-term-tab="rollback">4. 0秒原子回滚</button>
            </div>
          </div>
          <div class="terminal-body" id="terminal-screen"></div>
        </div>
      </div>
    </section>

    <div class="portal-container">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-val">0 ms</div>
          <div class="stat-label">域名指针原子切流与一键回滚（仅改写 80B JSON）</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">SHA-256</div>
          <div class="stat-label">跨版本、跨项目全局内容寻址去重存储池</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">∞ 版本</div>
          <div class="stat-label">突破标准 Pages 10 个版本上限，所有构建永久可访问</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">0 依赖</div>
          <div class="stat-label">纯 Node.js 原生实现，100% 掌控在自己的云账号下</div>
        </div>
      </div>

      <div class="section-head" style="margin-top: 12px;">
        <h2>⚡ 在线实测：Phase 2 约定式边缘 Serverless 云函数 (<code>api/hello.js</code>)</h2>
        <p>本门户站已内置 <code>api/hello.js</code> 并随静态构建一同封入当前 <code>dpl_&lt;id&gt;</code> 快照。点击下方按钮直接向当前泛域名边缘网关发起真实请求：</p>
      </div>

      <div style="margin: 18px 0 48px; padding: 20px 24px; border-radius: var(--radius-md); border: 1px solid var(--accent-border); background: var(--bg-subtle); display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; color: var(--text-strong);">
            <span style="padding: 3px 8px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-weight: 700; margin-right: 8px;">GET</span>
            <code>/api/hello?name=EdgeDeveloper</code>
          </div>
          <div style="display: flex; gap: 10px;">
            <button type="button" class="btn-primary" id="btn-test-api-hello" style="padding: 8px 16px; font-size: 0.85rem;">
              <span>⚡ 立即调用边缘函数 (/api/hello)</span>
            </button>
            <a href="/api/hello?name=BrowserVisitor" target="_blank" rel="noopener" class="btn-secondary" style="padding: 8px 14px; font-size: 0.85rem; text-decoration: none;">
              <span>新窗口打开 JSON ↗</span>
            </a>
          </div>
        </div>
        <pre id="api-hello-output" style="padding: 14px 16px; border-radius: 8px; background: #0b101b; color: #34d399; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; overflow-x: auto; line-height: 1.55; border: 1px solid #1e293b;">// 点击上方「立即调用边缘函数」查看实时返回的 JSON 与 X-MyShip-Function-Sha256 诊断头...</pre>
      </div>

      <div class="section-head" style="margin-top: 48px;">
        <h2>🎬 MyShip 2026 产品发布与全景愿景大片 (Keynote Video)</h2>
        <p>由 Remotion 编程级动态图形引擎 + 神经网络中文配音 + 120 BPM 原创电子合成器配乐打造，全景呈现 Phase 0/1 核心架构与 Phase 2/3 远期蓝图。</p>
      </div>

      <div style="margin: 24px 0 56px; border-radius: 22px; overflow: hidden; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(7, 11, 22, 0.9); box-shadow: 0 28px 70px rgba(0, 0, 0, 0.55), 0 0 40px rgba(56, 189, 248, 0.14);">
        <video
          controls
          preload="none"
          poster="/keynote-poster.jpg"
          src="/myship-promo.mp4"
          style="width: 100%; display: block; aspect-ratio: 16 / 9; background: #050811;"
        ></video>
      </div>

      <div class="section-head">
        <h2>探索开源文档中心</h2>
        <p>所有文档均位于仓库 <code>docs/*.md</code>，支持右上角一键复制 Markdown 给 LLM 或在线缩放拖拽架构图。</p>
      </div>

      <div class="feature-grid">
        <div class="feature-card" data-switch-doc="quickstart">
          <h3>📘 5 分钟快速上手</h3>
          <p>免云账号本地沙盒体验、全局安装、.myship 项目命名空间隔离与日常极简命令。</p>
        </div>
        <div class="feature-card" data-switch-doc="self-hosting">
          <h3>🛠️ 自建云端底座指南</h3>
          <p>10 分钟完成 COS、DNSPod 与 EdgeOne 配置，含泛域名免费 HTTPS 证书避坑指南。</p>
        </div>
        <div class="feature-card" data-switch-doc="architecture">
          <h3>🏗️ CAS 架构原理拆解</h3>
          <p>深入剖析 blobs / manifests / aliases 三级解耦寻址流程与 SPA History 路由支持。</p>
        </div>
        <div class="feature-card" data-switch-doc="roadmap">
          <h3>🧭 愿景与演进路线图</h3>
          <p>三大 DX 黄金准则、约定式 Serverless 云函数 (api/*.js) 与前后端原子切流规划。</p>
        </div>
      </div>
    </div>
  </main>

  <div id="view-docs" class="view-section">
    <div class="docs-layout">
      <aside class="docs-sidebar-left">
        ${parsedDocs
          .map(
            (doc) => `
        <div class="sidebar-group">
          <div class="sidebar-group-title">${escapeHtml(doc.category)}</div>
          <button type="button" class="sidebar-item" data-doc-nav="${doc.id}">
            <span>${escapeHtml(doc.shortTitle)}</span>
          </button>
          <div class="sidebar-sublist" data-doc-sublist="${doc.id}">
            ${doc.toc
              .filter((t) => t.level === 2)
              .map(
                (t) =>
                  `<a href="#${t.id}" class="sidebar-sublink" data-jump-doc="${doc.id}">${escapeHtml(t.title)}</a>`
              )
              .join('')}
          </div>
        </div>`
          )
          .join('')}
      </aside>

      <article class="docs-main">
        <div class="doc-topbar">
          <div>
            <div class="doc-eyebrow" id="active-doc-eyebrow"></div>
            <p class="doc-desc-banner" id="active-doc-desc"></p>
          </div>

          <div class="clarify-page-actions">
            <button type="button" class="clarify-copy-main-btn" id="btn-copy-page-main">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>复制页面</span>
            </button>
            <button type="button" class="clarify-dropdown-trigger" id="btn-clarify-menu-toggle" aria-label="更多页面操作">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </button>

            <div class="clarify-dropdown-menu" id="clarify-dropdown-menu">
              <button type="button" class="clarify-menu-item" data-clarify-action="copy-md">
                <div class="clarify-menu-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </div>
                <div>
                  <div class="clarify-menu-title">复制页面</div>
                  <div class="clarify-menu-desc">将页面以 Markdown 格式复制给 LLMs</div>
                </div>
              </button>

              <a href="/raw/01-quickstart.md" target="_blank" rel="noopener" class="clarify-menu-item" id="menu-view-raw-md">
                <div class="clarify-menu-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div>
                  <div class="clarify-menu-title">
                    <span>以 Markdown 格式查看</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </div>
                  <div class="clarify-menu-desc">以纯文本查看此页面</div>
                </div>
              </a>

              <button type="button" class="clarify-menu-item" data-clarify-action="copy-md-url">
                <div class="clarify-menu-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                </div>
                <div>
                  <div class="clarify-menu-title">复制 Markdown 链接</div>
                  <div class="clarify-menu-desc">复制当前页面的 Markdown 原始内容链接</div>
                </div>
              </button>

              <button type="button" class="clarify-menu-item" data-clarify-action="copy-llms-url">
                <div class="clarify-menu-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                </div>
                <div>
                  <div class="clarify-menu-title">复制 llms.txt</div>
                  <div class="clarify-menu-desc">复制此站点的 llms.txt 链接</div>
                </div>
              </button>

              <button type="button" class="clarify-menu-item" data-clarify-action="copy-mcp">
                <div class="clarify-menu-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                </div>
                <div>
                  <div class="clarify-menu-title">复制 MCP 配置</div>
                  <div class="clarify-menu-desc">复制站点的 MCP server 配置</div>
                </div>
              </button>
            </div>
          </div>
        </div>

        ${parsedDocs
          .map(
            (doc, idx) => `
        <div class="doc-pane" id="doc-pane-${doc.id}" style="display:${idx === 0 ? 'block' : 'none'};">
          ${doc.html}
        </div>`
          )
          .join('')}
      </article>

      <aside class="docs-sidebar-right">
        <div class="toc-title"><span>本页目录 · On this page</span></div>
        <ul class="toc-list" id="active-toc-list"></ul>
      </aside>
    </div>
  </div>

  <div class="search-backdrop" id="search-modal">
    <div class="search-modal">
      <div class="search-input-bar">
        <input type="text" id="search-input" placeholder="输入关键词搜索命令、架构原理、自建云底座避坑指南..." autocomplete="off" />
        <span class="search-kbd">ESC</span>
      </div>
      <div class="search-results" id="search-results"></div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';

    const DOCS_DATA = ${JSON.stringify(clientDocsPayload)};
    const SEARCH_INDEX = ${JSON.stringify(searchEntries)};
    const MCP_CONFIG = ${JSON.stringify(mcpConfig, null, 2)};

    let currentView = 'portal';
    let currentDocId = 'quickstart';

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.remove('show'), 2400);
    }

    async function copyText(text, successMsg) {
      try {
        await navigator.clipboard.writeText(text);
        showToast(successMsg);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast(successMsg);
      }
    }

    const TERM_SCENES = {
      deploy: \`<span class="t-dim"># 在任意全栈项目中直接输入 6 个字母 (自动扫描静态产物 + api/*.js):</span>
<span class="t-cmd">$ myship</span>
📁 已自动读取项目命名空间配置: .myship/project.json [项目: app1]
☁️  正在向腾讯云 COS 执行 CAS 去重部署... [项目命名空间: app1]
  ⚡ [COS CAS 命中跳过] /assets/vendor.js (sha256: 6f3ffee9d9...)
  ⬆️ [COS 新块上传]     /index.html -> blobs/5adc23fa1d... (2,194 B)
  ⚡ [Serverless 新函数上传] /api/hello <- api/hello.js (sha256: 36908c5530...)

<span class="t-ok">✅ 云端部署完成! [项目: app1] Deployment ID: dpl_6e46ed99</span>
   🌐 构建快照域名: <span class="t-url">https://app1-6e46ed99.ship.example.com</span>
   🌐 项目默认主域: <span class="t-url">https://app1.ship.example.com</span>
   ⚡ 边缘函数路由: <span class="t-url">https://app1.ship.example.com/api/hello</span>\`,
      serverless: \`<span class="t-dim"># 编写 api/hello.js 自动映射为 /api/hello，与前端页面绑定同一 dpl_&lt;id&gt; 快照:</span>
<span class="t-cmd">$ curl -i https://app1.ship.example.com/api/hello</span>
HTTP/2 200 
content-type: application/json; charset=UTF-8
x-myship-deployment-id: dpl_6e46ed99
x-myship-function-route: /api/hello
x-myship-function-sha256: 36908c5530bc8c08d80172b5f351835b79aa273b...
x-myship-function-mode: PRECOMPILED-V8

<span class="t-ok">{"ok":true,"version":"v1","deploymentId":"dpl_6e46ed99","route":"/api/hello"}</span>\`,
      namespace: \`<span class="t-dim"># 在 app1 目录下执行 myship ls，默认仅展示当前项目的版本与域名:</span>
<span class="t-cmd">$ myship ls</span>
=== 📦 当前项目命名空间: [app1] (云端全局 CAS 唯一块: 6 个) ===

=== 🌐 [app1] 线上子域名路由映射表 (3 个) ===
  - <span class="t-url">https://app1.ship.example.com</span>          -->  dpl_6e46ed99
  - <span class="t-url">https://app1-v2.ship.example.com</span>       -->  dpl_4f788e9d
  - <span class="t-url">https://app1-6e46ed99.ship.example.com</span> -->  dpl_6e46ed99\`,
      rollback: \`<span class="t-dim"># 线上发现问题？无需重新构建，0 秒把项目主域名回退到上一版:</span>
<span class="t-cmd">$ myship rollback</span>
⏪ 正在将 https://app1.ship.example.com 从 dpl_4f788e9d 回滚至上一版本 dpl_6e46ed99...
<span class="t-ok">🔗 云端域名别名已切换: https://app1.ship.example.com -> dpl_6e46ed99 (全球边缘 0 秒生效)</span>\`
    };

    const termScreen = document.getElementById('terminal-screen');
    termScreen.innerHTML = TERM_SCENES.deploy;
    document.querySelectorAll('[data-term-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-term-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        termScreen.innerHTML = TERM_SCENES[btn.dataset.termTab];
      });
    });

    function switchView(view, docId) {
      currentView = view;
      document.getElementById('view-portal').classList.toggle('active', view === 'portal');
      document.getElementById('view-docs').classList.toggle('active', view === 'docs');

      document.querySelectorAll('.nav-tab').forEach(tab => {
        if (view === 'portal' && tab.dataset.switchView === 'portal') {
          tab.classList.add('active');
        } else if (view === 'docs' && tab.dataset.switchDoc === docId) {
          tab.classList.add('active');
        } else {
          tab.classList.remove('active');
        }
      });

      if (view === 'docs' && docId) {
        selectDoc(docId);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function selectDoc(docId) {
      currentDocId = docId;
      const doc = DOCS_DATA.find(d => d.id === docId) || DOCS_DATA[0];

      document.getElementById('active-doc-eyebrow').textContent = doc.category;
      document.getElementById('active-doc-desc').textContent = doc.description;
      document.getElementById('menu-view-raw-md').href = doc.rawPath;

      document.querySelectorAll('.doc-pane').forEach(p => {
        p.style.display = p.id === \`doc-pane-\${doc.id}\` ? 'block' : 'none';
      });

      document.querySelectorAll('[data-doc-nav]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.docNav === doc.id);
      });

      const tocList = document.getElementById('active-toc-list');
      tocList.innerHTML = doc.toc.map(item => \`
        <li>
          <a href="#\${item.id}" class="toc-link level-\${item.level}" data-toc-id="\${item.id}">\${item.title}</a>
        </li>
      \`).join('');

      renderMermaidDiagrams();
    }

    document.querySelectorAll('[data-switch-view]').forEach(el => {
      el.addEventListener('click', () => switchView('portal'));
    });
    document.querySelectorAll('[data-switch-doc]').forEach(el => {
      el.addEventListener('click', () => switchView('docs', el.dataset.switchDoc));
    });
    document.querySelectorAll('[data-doc-nav]').forEach(el => {
      el.addEventListener('click', () => switchView('docs', el.dataset.docNav));
    });
    document.querySelectorAll('[data-jump-doc]').forEach(el => {
      el.addEventListener('click', () => {
        const targetDoc = el.dataset.jumpDoc;
        if (currentDocId !== targetDoc || currentView !== 'docs') {
          switchView('docs', targetDoc);
        }
      });
    });

    const menuToggle = document.getElementById('btn-clarify-menu-toggle');
    const dropdownMenu = document.getElementById('clarify-dropdown-menu');

    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdownMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => dropdownMenu.classList.remove('open'));

    function getActiveDoc() {
      return DOCS_DATA.find(d => d.id === currentDocId) || DOCS_DATA[0];
    }

    document.getElementById('btn-copy-page-main').addEventListener('click', () => {
      const doc = getActiveDoc();
      copyText(doc.rawMd, \`✅ 已将《\${doc.shortTitle}》完整 Markdown 复制到剪贴板\`);
    });

    document.querySelectorAll('[data-clarify-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.clarifyAction;
        const doc = getActiveDoc();
        const origin = window.location.origin;

        if (action === 'copy-md') {
          copyText(doc.rawMd, \`✅ 已复制《\${doc.shortTitle}》Markdown 内容\`);
        } else if (action === 'copy-md-url') {
          copyText(\`\${origin}\${doc.rawPath}\`, \`✅ 已复制 Markdown 链接: \${origin}\${doc.rawPath}\`);
        } else if (action === 'copy-llms-url') {
          copyText(\`\${origin}/llms.txt\`, \`✅ 已复制站点 llms.txt 链接: \${origin}/llms.txt\`);
        } else if (action === 'copy-mcp') {
          copyText(MCP_CONFIG, '✅ 已复制站点 MCP Server 配置 JSON');
        }
        dropdownMenu.classList.remove('open');
      });
    });

    document.getElementById('hero-copy-cmd').addEventListener('click', () => {
      copyText('npm i -g @myship/cli && myship login', '✅ 已复制安装与登录命令');
    });

    const btnTestApi = document.getElementById('btn-test-api-hello');
    const apiOutput = document.getElementById('api-hello-output');
    if (btnTestApi && apiOutput) {
      btnTestApi.addEventListener('click', async () => {
        apiOutput.textContent = '⏳ 正在请求边缘云函数 GET /api/hello?name=EdgeDeveloper ...';
        const t0 = performance.now();
        try {
          const res = await fetch('/api/hello?name=EdgeDeveloper');
          const elapsed = Math.round(performance.now() - t0);
          const data = await res.json();
          const headersInfo = [
            \`// HTTP \${res.status} (\${elapsed} ms)\`,
            \`// X-MyShip-Deployment-Id: \${res.headers.get('x-myship-deployment-id') || '-'}\`,
            \`// X-MyShip-Function-Sha256: \${res.headers.get('x-myship-function-sha256') || '-'}\`,
            \`// X-MyShip-Function-Mode: \${res.headers.get('x-myship-function-mode') || '-'}\`,
          ].join('\\n');
          apiOutput.textContent = headersInfo + '\\n' + JSON.stringify(data, null, 2);
        } catch (err) {
          apiOutput.textContent = '// 请求失败: ' + err.message;
        }
      });
    }

    document.querySelectorAll('[data-copy-target]').forEach(btn => {
      btn.addEventListener('click', () => {
        const codeEl = document.getElementById(btn.dataset.copyTarget);
        if (codeEl) copyText(codeEl.textContent, '✅ 代码已复制到剪贴板');
      });
    });

    const mermaidRawStore = new Map();
    document.querySelectorAll('.mermaid-source').forEach(pre => {
      mermaidRawStore.set(pre.id, pre.textContent);
    });

    async function renderMermaidDiagrams() {
      const isDark = document.documentElement.classList.contains('dark');
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'neutral',
        fontFamily: 'Inter, sans-serif',
        securityLevel: 'loose',
      });

      for (const [id, rawCode] of mermaidRawStore.entries()) {
        const container = document.querySelector(\`[data-mermaid-wrapper="\${id}"] [data-m-canvas]\`);
        if (!container) continue;
        try {
          const renderId = \`\${id}-svg-\${Date.now()}-\${Math.random().toString(36).slice(2, 6)}\`;
          const { svg } = await mermaid.render(renderId, rawCode);
          container.innerHTML = svg;
        } catch (err) {
          console.warn('Mermaid render error:', err);
        }
      }
    }

    document.querySelectorAll('.mermaid-card').forEach(card => {
      const viewport = card.querySelector('[data-m-viewport]');
      const canvas = card.querySelector('[data-m-canvas]');
      const scaleBadge = card.querySelector('[data-m-scale]');

      let scale = 1, panX = 0, panY = 0, isDragging = false, startX = 0, startY = 0;

      function applyTransform() {
        canvas.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
        scaleBadge.textContent = \`\${Math.round(scale * 100)}%\`;
      }
      function zoomBy(delta) {
        scale = Math.min(3.2, Math.max(0.4, +(scale + delta).toFixed(2)));
        applyTransform();
      }

      card.querySelectorAll('[data-m-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.mAction;
          if (act === 'zoom-in') zoomBy(0.2);
          else if (act === 'zoom-out') zoomBy(-0.2);
          else if (act === 'reset') { scale = 1; panX = 0; panY = 0; applyTransform(); }
          else if (act === 'fullscreen') card.classList.toggle('fullscreen');
        });
      });

      viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomBy(e.deltaY < 0 ? 0.12 : -0.12);
      }, { passive: false });

      viewport.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX - panX;
        startY = e.clientY - panY;
        viewport.classList.add('grabbing');
      });
      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panX = e.clientX - startX;
        panY = e.clientY - startY;
        applyTransform();
      });
      window.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; viewport.classList.remove('grabbing'); }
      });
    });

    document.getElementById('theme-toggle-btn').addEventListener('click', () => {
      const isDark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('myship-theme', isDark ? 'dark' : 'light');
      renderMermaidDiagrams();
    });

    window.addEventListener('scroll', () => {
      if (currentView !== 'docs') return;
      const doc = getActiveDoc();
      let currentId = doc.toc[0]?.id;
      for (const item of doc.toc) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= 120) currentId = item.id;
      }
      document.querySelectorAll('.toc-link').forEach(link => {
        link.classList.toggle('active', link.dataset.tocId === currentId);
      });
    }, { passive: true });

    const searchModal = document.getElementById('search-modal');
    const searchInput = document.getElementById('search-input');
    const searchResults = document.getElementById('search-results');

    function openSearch() {
      searchModal.classList.add('open');
      searchInput.value = '';
      renderSearchResults('');
      setTimeout(() => searchInput.focus(), 40);
    }
    function closeSearch() { searchModal.classList.remove('open'); }

    document.getElementById('open-search-btn').addEventListener('click', openSearch);
    searchModal.addEventListener('click', (e) => { if (e.target === searchModal) closeSearch(); });
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); }
      else if (e.key === 'Escape') {
        closeSearch();
        document.querySelectorAll('.mermaid-card.fullscreen').forEach(c => c.classList.remove('fullscreen'));
      }
    });

    function renderSearchResults(query) {
      const q = query.trim().toLowerCase();
      const matched = q
        ? SEARCH_INDEX.filter(item => item.heading.toLowerCase().includes(q) || item.text.toLowerCase().includes(q)).slice(0, 12)
        : SEARCH_INDEX.slice(0, 8);

      if (matched.length === 0) {
        searchResults.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-soft);">未找到匹配的章节内容</div>';
        return;
      }
      searchResults.innerHTML = matched.map((item, idx) => \`
        <button type="button" class="search-result-item" data-search-hit="\${idx}">
          <div class="search-result-meta">\${item.docTitle} · \${item.heading}</div>
          <div class="search-result-snippet">\${item.text}</div>
        </button>
      \`).join('');
      searchResults.querySelectorAll('[data-search-hit]').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
          closeSearch();
          switchView('docs', matched[idx].docId);
        });
      });
    }
    searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));

    selectDoc('quickstart');
  </script>
</body>
</html>`;
}

buildAll();
