/**
 * apps/site/src/client/app-client.js
 * MyShip Portal & Docs Client Runtime (URL Router, Interactive Sandbox, ⌘K Palette, Mobile Drawer, Mermaid)
 */
const { DOCS_DATA, SEARCH_INDEX, MCP_CONFIG } = window.__MYSHIP_SITE_DATA__;

let currentView = 'portal';
let currentDocId = 'quickstart';

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
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

// ============================================================================
// 1. 首屏包管理器切换与终端多场景演示
// ============================================================================
let activePmCmd = 'npm i -g @myship/cli && myship login';
document.querySelectorAll('[data-pm-cmd]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-pm-cmd]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activePmCmd = tab.dataset.pmCmd;
    const textEl = document.getElementById('hero-pm-cmd-text');
    if (textEl) textEl.textContent = activePmCmd;
  });
});

const heroCopyBtn = document.getElementById('hero-copy-cmd');
if (heroCopyBtn) {
  heroCopyBtn.addEventListener('click', () => {
    copyText(activePmCmd, `✅ 已复制命令: ${activePmCmd}`);
  });
}

const TERM_SCENES = {
  deploy: `<span class="t-dim"># 在任意全栈项目中直接输入 6 个字母 (自动扫描静态产物 + api/*.js / SCF 后端):</span>
<span class="t-cmd">$ myship</span>
📁 已自动读取项目命名空间配置: .myship/project.json [项目: app1]
☁️  正在向腾讯云 COS 执行 CAS 去重部署... [项目命名空间: app1]
  ⚡ [COS CAS 命中跳过] /assets/vendor.js (sha256: 6f3ffee9d9...)
  ⬆️ [COS 新块上传]     /index.html -> blobs/5adc23fa1d... (2,194 B)
  🏭 [SCF 全栈后端]     已打包 server/index.mjs 并冻结不可变版本: myship-app1@v2

<span class="t-ok">✅ 云端部署完成! [项目: app1] Deployment ID: dpl_a09cea14</span>
   🌐 不可变快照域: <span class="t-url">https://app1-a09cea14.ship.example.com</span>
   🌐 项目默认主域: <span class="t-url">https://app1.ship.example.com</span>`,
  use: `<span class="t-dim"># 交互式一行命令为项目开通并注入云数据库 (CloudBase PG / Neon / Turso / D1 / MySQL):</span>
<span class="t-cmd">$ myship use</span>
✔ 请选择要为项目 [app1] 接入的云资源类型: 🗄️  数据库 (Database -> context.db)
✔ 请选择数据库引擎: ⚡ Turso (Serverless SQLite / libSQL · 全球边缘超低延迟)
<span class="t-ok">✅ 已通过 Turso HTTP SQL 实连校验并注入 context.db / context.storage / context.files</span>
<span class="t-ok">✅ 本地 myship dev 自动降级 node:sqlite，代码 0 修改直通云端生产环境</span>`,
  serverless: `<span class="t-dim"># 边缘 V8 与 SCF 全栈后端按子域名快照精确寻址，前后端版本严格锁死:</span>
<span class="t-cmd">$ curl -i https://app1.ship.example.com/api/guestbook</span>
HTTP/2 200 
content-type: application/json; charset=UTF-8
x-myship-engine: EdgeOne-API-Worker/2.2-FullStack
x-myship-deployment-id: dpl_a09cea14
x-myship-scf-version: 2

<span class="t-ok">{"ok":true,"deploymentId":"dpl_a09cea14","dbEngine":"turso-http","rows":3}</span>`,
  rollback: `<span class="t-dim"># 线上发现问题？无需重新构建，0 秒把项目主域名前后端同帧回退到上一版:</span>
<span class="t-cmd">$ myship rollback</span>
⏪ 正在将 https://app1.ship.example.com 从 dpl_a09cea14 回滚至上一版本 dpl_6e46ed99...
<span class="t-ok">🔗 云端域名别名已切换: https://app1.ship.example.com -> dpl_6e46ed99 (SCF v2 -> v1 同帧回退)</span>`,
};

const termScreen = document.getElementById('terminal-screen');
if (termScreen) {
  termScreen.innerHTML = TERM_SCENES.deploy;
  document.querySelectorAll('[data-term-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-term-tab]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      termScreen.innerHTML = TERM_SCENES[btn.dataset.termTab];
    });
  });
}

// ============================================================================
// 2. 交互式 0ms 原子指针切流沙盘 (Interactive Pointer Switcher Sandbox)
// ============================================================================
const SANDBOX_DPL_SPECS = {
  dpl_a09cea14: {
    id: 'dpl_a09cea14',
    updatedAt: '2026-11-03T11:20:00Z',
    staticFiles: '14 files (12 CAS hits, 2 uploaded)',
    computeMode: 'SCF Web Function (Locked Version: v2)',
    upstream: 'https://139482-ap-guangzhou.apigateway.myqcloud.com/release/myship-app1/v2',
    resources: 'Turso libSQL (myship-app1) + COS data/app1/ & files/app1/',
  },
  dpl_6e46ed99: {
    id: 'dpl_6e46ed99',
    updatedAt: '2026-11-03T09:15:00Z',
    staticFiles: '12 files (10 CAS hits, 2 uploaded)',
    computeMode: 'SCF Web Function (Locked Version: v1)',
    upstream: 'https://139482-ap-guangzhou.apigateway.myqcloud.com/release/myship-app1/v1',
    resources: 'Turso libSQL (myship-app1)',
  },
  dpl_19c4b02f: {
    id: 'dpl_19c4b02f',
    updatedAt: '2026-11-02T18:30:00Z',
    staticFiles: '9 files (Pure Static + Edge API)',
    computeMode: 'EdgeOne V8 Isolate (api/hello.js)',
    upstream: 'Edge In-Memory Isolate (0ms Cold Start)',
    resources: 'None (Stateless Edge)',
  },
};

let activeSimDpl = 'dpl_a09cea14';
let previousSimDpl = 'dpl_6e46ed99';

function renderPointerSandbox(dplId, actionLabel = '当前生效指针') {
  const spec = SANDBOX_DPL_SPECS[dplId] || SANDBOX_DPL_SPECS.dpl_a09cea14;
  const inspector = document.getElementById('sandbox-pointer-inspector');
  if (!inspector) return;

  document.querySelectorAll('[data-sim-dpl]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.simDpl === dplId);
  });
  document.querySelectorAll('[data-sim-pill]').forEach((pill) => {
    pill.style.display = pill.dataset.simPill === dplId ? 'inline-flex' : 'none';
  });

  inspector.innerHTML = `
    <div>
      <div style="display:flex;align-items:center;justify-content:space-between;color:#94a3b8;font-size:0.73rem;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #1e293b;">
        <span>COS Pointer Object: <strong style="color:#38bdf8;">aliases/app1.json</strong> (82 Bytes)</span>
        <span style="color:#34d399;font-weight:600;">⚡ ${actionLabel} · 耗时 0ms</span>
      </div>
      <pre style="color:#f8fafc;line-height:1.55;">{
  <span class="tok-prop">"subdomain"</span>: <span class="tok-str">"app1"</span>,
  <span class="tok-prop">"project"</span>: <span class="tok-str">"app1"</span>,
  <span class="tok-prop">"deploymentId"</span>: <span class="tok-str">"${spec.id}"</span>,
  <span class="tok-prop">"previousDeploymentId"</span>: <span class="tok-str">"${previousSimDpl}"</span>,
  <span class="tok-prop">"updatedAt"</span>: <span class="tok-str">"${new Date().toISOString()}"</span>
}</pre>
    </div>
    <div style="padding-top:10px;border-top:1px dashed #1e293b;font-size:0.74rem;line-height:1.65;color:#cbd5e1;">
      <div>🌐 <strong>生产域名路由</strong>: <code>https://app1.ship.example.com</code> → <code>manifests/${spec.id}.json</code></div>
      <div>🏭 <strong>绑定计算引擎</strong>: <span style="color:#38bdf8;">${spec.computeMode}</span></div>
      <div>🗄️ <strong>挂载云端资源</strong>: <span style="color:#a78bfa;">${spec.resources}</span></div>
    </div>
  `;
}

document.querySelectorAll('[data-sim-dpl]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.simDpl;
    if (target !== activeSimDpl) {
      previousSimDpl = activeSimDpl;
      activeSimDpl = target;
    }
    renderPointerSandbox(activeSimDpl, `已原子切流至 ${activeSimDpl}`);
    showToast(`⚡ 已模拟 0ms 指针切流: aliases/app1.json -> ${activeSimDpl}`);
  });
});

const btnSimRollback = document.getElementById('btn-sim-rollback');
if (btnSimRollback) {
  btnSimRollback.addEventListener('click', () => {
    const swap = previousSimDpl;
    previousSimDpl = activeSimDpl;
    activeSimDpl = swap;
    renderPointerSandbox(activeSimDpl, `已同帧回滚至 ${activeSimDpl}`);
    showToast(`⏪ 已模拟 0ms 原子回滚: ${previousSimDpl} -> ${activeSimDpl}`);
  });
}
renderPointerSandbox(activeSimDpl);

// ============================================================================
// 3. 真实 URL Hash / History 路由同步 (解决刷新丢失位置与前进后退失效痛点)
// ============================================================================
const mobileSidebar = document.getElementById('docs-sidebar-left');
const mobileBackdrop = document.getElementById('mobile-drawer-backdrop');

function closeMobileDrawer() {
  if (mobileSidebar) mobileSidebar.classList.remove('drawer-open');
  if (mobileBackdrop) mobileBackdrop.classList.remove('open');
}

function openMobileDrawer() {
  if (mobileSidebar) mobileSidebar.classList.add('drawer-open');
  if (mobileBackdrop) mobileBackdrop.classList.add('open');
}

const btnOpenDrawer = document.getElementById('btn-open-mobile-drawer');
const btnCloseDrawer = document.getElementById('btn-close-mobile-drawer');
if (btnOpenDrawer) btnOpenDrawer.addEventListener('click', openMobileDrawer);
if (btnCloseDrawer) btnCloseDrawer.addEventListener('click', closeMobileDrawer);
if (mobileBackdrop) mobileBackdrop.addEventListener('click', closeMobileDrawer);

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

function safeDecodeUri(val) {
  if (!val) return val;
  try {
    return decodeURIComponent(val);
  } catch {
    return val;
  }
}

function resolveDocId(rawId) {
  if (!rawId) return 'quickstart';
  const clean = safeDecodeUri(String(rawId).trim()).toLowerCase();
  const exact = DOCS_DATA.find((d) => d.id === clean);
  if (exact) return exact.id;
  const byFile = DOCS_DATA.find(
    (d) =>
      d.rawPath.toLowerCase().includes(clean) ||
      clean.endsWith(`-${d.id}`) ||
      d.id.startsWith(clean.replace(/^\d+-/, ''))
  );
  return byFile ? byFile.id : 'quickstart';
}

function resolveSectionElement(docId, sectionId) {
  if (!sectionId) return null;
  const decoded = safeDecodeUri(sectionId).replace(/^#/, '');
  return (
    document.getElementById(decoded) ||
    (docId ? document.getElementById(`${docId}-${decoded}`) : null)
  );
}

function parseLocationRoute() {
  const rawHash = safeDecodeUri(window.location.hash.replace(/^#/, ''));
  if (!rawHash || rawHash === '/' || rawHash === '/portal' || rawHash === 'portal') {
    return { view: 'portal', docId: null, sectionId: null };
  }

  // Format 1: #/docs/quickstart#quickstart-xxx, #/docs/quickstart, #docs/01-quickstart/1-xxx
  const docsMatch = rawHash.match(/^\/?docs\/([a-z0-9-]+)(?:[#/](.+))?$/i);
  if (docsMatch) {
    return {
      view: 'docs',
      docId: resolveDocId(docsMatch[1]),
      sectionId: safeDecodeUri(docsMatch[2] || '') || null,
    };
  }

  // Format 2: direct heading slug like #quickstart-xxx or #architecture-xxx
  for (const doc of DOCS_DATA) {
    if (rawHash === doc.id) {
      return { view: 'docs', docId: doc.id, sectionId: null };
    }
    if (rawHash.startsWith(`${doc.id}-`)) {
      return { view: 'docs', docId: doc.id, sectionId: rawHash };
    }
  }

  return { view: 'portal', docId: null, sectionId: null };
}

let currentNavSeq = 0;
let isScrollTrackingEnabled = false;

function buildRouteUrl({ view, docId, sectionId }) {
  if (view === 'docs') {
    const resolvedDocId = resolveDocId(docId || currentDocId);
    return sectionId ? `#/docs/${resolvedDocId}#${sectionId}` : `#/docs/${resolvedDocId}`;
  }
  return window.location.pathname + window.location.search;
}

function saveCurrentHistoryScroll() {
  try {
    const prevState = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState(
      {
        ...prevState,
        view: currentView,
        docId: currentView === 'docs' ? currentDocId : null,
        scrollY: Math.round(window.scrollY),
      },
      ''
    );
  } catch {}
}

function updateTocHighlight() {
  if (currentView !== 'docs') return;
  const doc = getActiveDoc();
  let currentId = doc.toc[0]?.id;
  for (const item of doc.toc) {
    const el = document.getElementById(item.id);
    if (el && el.getBoundingClientRect().top <= 130) currentId = item.id;
  }
  document.querySelectorAll('.toc-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.tocId === currentId);
  });
}

/**
 * 唯一负责设置页面滚动位置的函数：
 * - mode === 'restore' 且当前历史记录存有数值 scrollY（后退、前进、刷新）：优先恢复该历史记录保存的 scrollY
 * - 否则若有章节锚点（新导航至章节，或首次打开分享链接）：定位到对应章节
 * - 否则：滚回顶部 (0)
 */
function applyRouteScroll({ mode, docId, sectionId, savedScrollY }) {
  if (mode === 'restore' && typeof savedScrollY === 'number') {
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  } else if (sectionId) {
    const targetEl = resolveSectionElement(docId, sectionId);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'instant', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  saveCurrentHistoryScroll();
  updateTocHighlight();
  isScrollTrackingEnabled = true;
}

function selectDocDom(docId) {
  currentDocId = docId;
  const doc = DOCS_DATA.find((d) => d.id === docId) || DOCS_DATA[0];

  const eyebrowEl = document.getElementById('active-doc-eyebrow');
  const descEl = document.getElementById('active-doc-desc');
  const rawLinkEl = document.getElementById('menu-view-raw-md');
  const mobileLabelEl = document.getElementById('mobile-active-doc-label');

  if (eyebrowEl) eyebrowEl.textContent = doc.category;
  if (descEl) descEl.textContent = doc.description;
  if (rawLinkEl) rawLinkEl.href = doc.rawPath;
  if (mobileLabelEl) mobileLabelEl.textContent = doc.shortTitle;

  let activePane = null;
  document.querySelectorAll('.doc-pane').forEach((p) => {
    const isCurrent = p.id === `doc-pane-${doc.id}`;
    p.style.display = isCurrent ? 'block' : 'none';
    if (isCurrent) activePane = p;
  });

  document.querySelectorAll('[data-doc-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.docNav === doc.id);
  });

  const tocList = document.getElementById('active-toc-list');
  if (tocList) {
    tocList.innerHTML = doc.toc
      .map(
        (item, idx) => `
      <li>
        <a href="#/docs/${doc.id}#${item.id}" class="toc-link level-${item.level}${idx === 0 ? ' active' : ''}" data-toc-id="${item.id}" data-toc-doc="${doc.id}">${item.title}</a>
      </li>
    `
      )
      .join('');

    tocList.querySelectorAll('[data-toc-id]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        navigateToRoute({
          view: 'docs',
          docId: link.dataset.tocDoc,
          sectionId: link.dataset.tocId,
        });
      });
    });
  }

  return activePane;
}

async function renderRoute(
  { view, docId, sectionId },
  { mode = 'new', savedScrollY = null } = {}
) {
  const seq = ++currentNavSeq;
  isScrollTrackingEnabled = false;
  currentView = view;

  const portalEl = document.getElementById('view-portal');
  const docsEl = document.getElementById('view-docs');
  if (portalEl) portalEl.classList.toggle('active', view === 'portal');
  if (docsEl) docsEl.classList.toggle('active', view === 'docs');

  const resolvedDocId = resolveDocId(docId || currentDocId || 'quickstart');

  document.querySelectorAll('.nav-tab').forEach((tab) => {
    if (view === 'portal' && tab.dataset.switchView === 'portal') {
      tab.classList.add('active');
    } else if (view === 'docs' && tab.dataset.switchDoc === resolvedDocId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  closeMobileDrawer();

  if (view === 'docs') {
    const activePane = selectDocDom(resolvedDocId);
    await renderMermaidDiagrams(activePane, seq);
    if (seq !== currentNavSeq) return;
    applyRouteScroll({ mode, docId: resolvedDocId, sectionId, savedScrollY });
  } else {
    await renderMermaidDiagrams(portalEl, seq);
    if (seq !== currentNavSeq) return;
    applyRouteScroll({ mode, docId: null, sectionId: null, savedScrollY });
  }
}

function navigateToRoute({ view, docId, sectionId = null }) {
  // 主动导航前：在隐藏/切换当前文档之前，先将当前历史记录的真实滚动位置写入 history.state
  if (isScrollTrackingEnabled) {
    saveCurrentHistoryScroll();
  }
  isScrollTrackingEnabled = false;

  const resolvedDocId = view === 'docs' ? resolveDocId(docId || currentDocId) : null;
  const nextUrl = buildRouteUrl({ view, docId: resolvedDocId, sectionId });

  history.pushState(
    {
      view,
      docId: resolvedDocId,
      sectionId: sectionId || null,
      scrollY: null,
    },
    '',
    nextUrl
  );

  renderRoute({ view, docId: resolvedDocId, sectionId }, { mode: 'new', savedScrollY: null });
}

// 绑定全局导航点击事件
document.querySelectorAll('[data-switch-view]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToRoute({ view: 'portal', docId: null, sectionId: null });
  });
});

document.querySelectorAll('[data-switch-doc]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToRoute({ view: 'docs', docId: el.dataset.switchDoc, sectionId: null });
  });
});

document.querySelectorAll('[data-doc-nav]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToRoute({ view: 'docs', docId: el.dataset.docNav, sectionId: null });
  });
});

document.querySelectorAll('[data-jump-doc]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigateToRoute({
      view: 'docs',
      docId: el.dataset.jumpDoc,
      sectionId: el.dataset.jumpSec || null,
    });
  });
});

// 章节标题 # 锚点点击复制永久链接
document.querySelectorAll('[data-anchor-link]').forEach((anchor) => {
  anchor.addEventListener('click', (e) => {
    e.preventDefault();
    const secId = anchor.dataset.anchorLink;
    navigateToRoute({ view: 'docs', docId: currentDocId, sectionId: secId });
    const fullUrl = `${window.location.origin}${window.location.pathname}#/docs/${currentDocId}#${secId}`;
    copyText(fullUrl, '🔗 已复制当前章节永久链接');
  });
});

// 监听浏览器前进/后退或地址栏 Hash 变化
window.addEventListener('popstate', (e) => {
  isScrollTrackingEnabled = false;
  const route = parseLocationRoute();
  const savedScrollY =
    e.state && typeof e.state.scrollY === 'number'
      ? e.state.scrollY
      : history.state && typeof history.state.scrollY === 'number'
      ? history.state.scrollY
      : null;
  renderRoute(route, { mode: 'restore', savedScrollY });
});

// ============================================================================
// 4. Clarify AI 下拉操作菜单与代码块微交互复制
// ============================================================================
const menuToggle = document.getElementById('btn-clarify-menu-toggle');
const dropdownMenu = document.getElementById('clarify-dropdown-menu');

if (menuToggle && dropdownMenu) {
  menuToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownMenu.classList.toggle('open');
  });
  document.addEventListener('click', () => dropdownMenu.classList.remove('open'));
}

function getActiveDoc() {
  return DOCS_DATA.find((d) => d.id === currentDocId) || DOCS_DATA[0];
}

const btnCopyPageMain = document.getElementById('btn-copy-page-main');
if (btnCopyPageMain) {
  btnCopyPageMain.addEventListener('click', () => {
    const doc = getActiveDoc();
    copyText(doc.rawMd, `✅ 已将《${doc.shortTitle}》完整 Markdown 复制到剪贴板`);
  });
}

document.querySelectorAll('[data-clarify-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.clarifyAction;
    const doc = getActiveDoc();
    const origin = window.location.origin;

    if (action === 'copy-md') {
      copyText(doc.rawMd, `✅ 已复制《${doc.shortTitle}》Markdown 内容`);
    } else if (action === 'copy-md-url') {
      copyText(`${origin}${doc.rawPath}`, `✅ 已复制 Markdown 链接: ${origin}${doc.rawPath}`);
    } else if (action === 'copy-llms-url') {
      copyText(`${origin}/llms.txt`, `✅ 已复制站点 llms.txt 链接: ${origin}/llms.txt`);
    } else if (action === 'copy-mcp') {
      copyText(MCP_CONFIG, '✅ 已复制站点 MCP Server 配置 JSON');
    }
    if (dropdownMenu) dropdownMenu.classList.remove('open');
  });
});

document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const codeEl = document.getElementById(btn.dataset.copyTarget);
    if (!codeEl) return;
    copyText(codeEl.textContent, '✅ 代码已复制到剪贴板');
    const iconDefault = btn.querySelector('.copy-icon-default');
    const iconCheck = btn.querySelector('.copy-icon-check');
    const labelSpan = btn.querySelector('span');
    if (iconDefault && iconCheck && labelSpan) {
      iconDefault.style.display = 'none';
      iconCheck.style.display = 'inline';
      labelSpan.textContent = '已复制';
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        iconDefault.style.display = 'inline';
        iconCheck.style.display = 'none';
        labelSpan.textContent = '复制代码';
      }, 1800);
    }
  });
});

// ============================================================================
// 5. 在线实测边缘云函数 (/api/hello & /api/inspect)
// ============================================================================
const btnTestApi = document.getElementById('btn-test-api-hello');
const btnTestInspect = document.getElementById('btn-test-api-inspect');
const apiOutput = document.getElementById('api-hello-output');

async function runLiveApiTest(endpoint) {
  if (!apiOutput) return;
  apiOutput.textContent = `⏳ 正在请求边缘云函数 GET ${endpoint} ...`;
  const t0 = performance.now();
  try {
    const res = await fetch(endpoint);
    const elapsed = Math.round(performance.now() - t0);
    const data = await res.json();
    const headersInfo = [
      `// HTTP ${res.status} (${elapsed} ms) | Endpoint: ${endpoint}`,
      `// X-MyShip-Engine:          ${res.headers.get('x-myship-engine') || '-'}`,
      `// X-MyShip-Function-Worker: ${res.headers.get('x-myship-function-worker') || '-'}`,
      `// X-MyShip-Deployment-Id:   ${res.headers.get('x-myship-deployment-id') || '-'}`,
      `// X-MyShip-Function-Route:  ${res.headers.get('x-myship-function-route') || '-'}`,
      `// X-MyShip-Function-Sha256: ${res.headers.get('x-myship-function-sha256') || '-'}`,
      `// X-MyShip-Function-Mode:   ${res.headers.get('x-myship-function-mode') || '-'}`,
    ].join('\n');
    apiOutput.textContent = headersInfo + '\n' + JSON.stringify(data, null, 2);
  } catch (err) {
    apiOutput.textContent = '// 请求失败: ' + err.message;
  }
}

if (btnTestApi) {
  btnTestApi.addEventListener('click', () => runLiveApiTest('/api/hello?name=EdgeDeveloper'));
}
if (btnTestInspect) {
  btnTestInspect.addEventListener('click', () => runLiveApiTest('/api/inspect?seed=portal-live'));
}

// ============================================================================
// 6. Mermaid 交互式缩放拖拽架构画布
// ============================================================================
const mermaidRawStore = new Map();
document.querySelectorAll('.mermaid-source').forEach((pre) => {
  mermaidRawStore.set(pre.id, pre.textContent);
});

let mermaidModPromise = null;
function loadMermaid() {
  if (!mermaidModPromise) {
    mermaidModPromise = import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
      .then((m) => m.default || m)
      .catch((err) => {
        mermaidModPromise = null;
        throw err;
      });
  }
  return mermaidModPromise;
}

async function renderMermaidDiagrams(scopeRoot = document, navSeq = currentNavSeq) {
  if (!scopeRoot) return;
  const isDark = document.documentElement.classList.contains('dark');
  const targetTheme = isDark ? 'dark' : 'neutral';
  const wrappers = scopeRoot.querySelectorAll('[data-mermaid-wrapper]');
  if (wrappers.length === 0) return;

  const unrendered = Array.from(wrappers).filter((wrap) => {
    const container = wrap.querySelector('[data-m-canvas]');
    return container && (container.dataset.renderedTheme !== targetTheme || !container.innerHTML.trim());
  });
  if (unrendered.length === 0) return;

  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    console.warn('Mermaid load skipped:', err);
    return;
  }
  if (navSeq !== currentNavSeq) return;

  mermaid.initialize({
    startOnLoad: false,
    theme: targetTheme,
    fontFamily: 'Inter, sans-serif',
    securityLevel: 'loose',
  });

  for (const wrap of unrendered) {
    if (navSeq !== currentNavSeq) return;
    const id = wrap.dataset.mermaidWrapper;
    const rawCode = mermaidRawStore.get(id);
    if (!rawCode) continue;
    const container = wrap.querySelector('[data-m-canvas]');
    if (!container) continue;
    try {
      const renderId = `${id}-svg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const { svg } = await mermaid.render(renderId, rawCode);
      if (navSeq !== currentNavSeq) return;
      container.innerHTML = svg;
      container.dataset.renderedTheme = targetTheme;
    } catch (err) {
      console.warn('Mermaid render error:', err);
    }
  }
}

document.querySelectorAll('.mermaid-card').forEach((card) => {
  const viewport = card.querySelector('[data-m-viewport]');
  const canvas = card.querySelector('[data-m-canvas]');
  const scaleBadge = card.querySelector('[data-m-scale]');

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;

  function applyTransform() {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    scaleBadge.textContent = `${Math.round(scale * 100)}%`;
  }
  function zoomBy(delta) {
    scale = Math.min(3.2, Math.max(0.4, +(scale + delta).toFixed(2)));
    applyTransform();
  }

  card.querySelectorAll('[data-m-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.mAction;
      if (act === 'zoom-in') zoomBy(0.2);
      else if (act === 'zoom-out') zoomBy(-0.2);
      else if (act === 'reset') {
        scale = 1;
        panX = 0;
        panY = 0;
        applyTransform();
      } else if (act === 'fullscreen') card.classList.toggle('fullscreen');
    });
  });

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.12 : -0.12);
    },
    { passive: false }
  );

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
    if (isDragging) {
      isDragging = false;
      viewport.classList.remove('grabbing');
    }
  });
});

// 深浅色主题切换
const themeBtn = document.getElementById('theme-toggle-btn');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('myship-theme', isDark ? 'dark' : 'light');
    const activeScope =
      currentView === 'docs'
        ? document.getElementById(`doc-pane-${currentDocId}`)
        : document.getElementById('view-portal');
    renderMermaidDiagrams(activeScope || document, currentNavSeq);
  });
}

window.addEventListener('pagehide', () => {
  if (isScrollTrackingEnabled) {
    saveCurrentHistoryScroll();
  }
});

// 右侧 TOC 实时滚动高亮 (Scroll-Spy) 与当前历史记录滚动位置保存
window.addEventListener(
  'scroll',
  () => {
    if (isScrollTrackingEnabled) {
      saveCurrentHistoryScroll();
    }
    updateTocHighlight();
  },
  { passive: true }
);

// ============================================================================
// 7. 键盘优先 ⌘K 全文搜索与命令面板 (支持 ↑ / ↓ / Enter 方向键导航)
// ============================================================================
const searchModal = document.getElementById('search-modal');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let activeSearchMatches = [];
let selectedSearchIndex = 0;

function openSearch() {
  if (!searchModal || !searchInput) return;
  searchModal.classList.add('open');
  searchInput.value = '';
  selectedSearchIndex = 0;
  renderSearchResults('');
  setTimeout(() => searchInput.focus(), 30);
}

function closeSearch() {
  if (searchModal) searchModal.classList.remove('open');
}

const openSearchBtn = document.getElementById('open-search-btn');
if (openSearchBtn) openSearchBtn.addEventListener('click', openSearch);
if (searchModal) {
  searchModal.addEventListener('click', (e) => {
    if (e.target === searchModal) closeSearch();
  });
}

function executeSearchSelection(item) {
  if (!item) return;
  closeSearch();
  navigateToRoute({
    view: 'docs',
    docId: item.docId,
    sectionId: item.headingId || null,
  });
}

function updateSearchSelectionHighlight() {
  if (!searchResults) return;
  const items = searchResults.querySelectorAll('.search-result-item');
  items.forEach((el, idx) => {
    el.classList.toggle('selected', idx === selectedSearchIndex);
    if (idx === selectedSearchIndex) {
      el.scrollIntoView({ block: 'nearest' });
    }
  });
}

window.addEventListener('keydown', (e) => {
  const isSearchOpen = searchModal && searchModal.classList.contains('open');

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (isSearchOpen) closeSearch();
    else openSearch();
    return;
  }

  if (isSearchOpen) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (activeSearchMatches.length > 0) {
        selectedSearchIndex = (selectedSearchIndex + 1) % activeSearchMatches.length;
        updateSearchSelectionHighlight();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (activeSearchMatches.length > 0) {
        selectedSearchIndex =
          (selectedSearchIndex - 1 + activeSearchMatches.length) % activeSearchMatches.length;
        updateSearchSelectionHighlight();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeSearchMatches[selectedSearchIndex]) {
        executeSearchSelection(activeSearchMatches[selectedSearchIndex]);
      }
    }
    return;
  }

  if (e.key === 'Escape') {
    closeMobileDrawer();
    document.querySelectorAll('.mermaid-card.fullscreen').forEach((c) => c.classList.remove('fullscreen'));
  }
});

function renderSearchResults(query) {
  if (!searchResults) return;
  const q = query.trim().toLowerCase();
  activeSearchMatches = q
    ? SEARCH_INDEX.filter(
        (item) =>
          item.heading.toLowerCase().includes(q) ||
          item.text.toLowerCase().includes(q) ||
          item.docTitle.toLowerCase().includes(q)
      ).slice(0, 12)
    : SEARCH_INDEX.slice(0, 8);

  selectedSearchIndex = 0;

  if (activeSearchMatches.length === 0) {
    searchResults.innerHTML =
      '<div style="padding:28px;text-align:center;color:var(--text-soft);">未找到匹配的章节内容，试试搜索 <code>myship use</code>、<code>SCF</code> 或 <code>rollback</code></div>';
    return;
  }

  searchResults.innerHTML = activeSearchMatches
    .map(
      (item, idx) => `
    <button type="button" class="search-result-item${idx === 0 ? ' selected' : ''}" data-search-hit="${idx}">
      <div class="search-result-meta">📘 ${item.docTitle} · # ${item.heading}</div>
      <div class="search-result-snippet">${item.text}</div>
    </button>
  `
    )
    .join('');

  searchResults.querySelectorAll('[data-search-hit]').forEach((btn, idx) => {
    btn.addEventListener('click', () => executeSearchSelection(activeSearchMatches[idx]));
  });
}

if (searchInput) {
  searchInput.addEventListener('input', (e) => renderSearchResults(e.target.value));
}

// 初始化路由状态：若当前历史记录已存有 scrollY（刷新/后退/前进），优先恢复该位置；首次打开分享链接时按锚点定位
const initialRoute = parseLocationRoute();
const initialSavedScrollY =
  history.state && typeof history.state.scrollY === 'number' ? history.state.scrollY : null;
renderRoute(initialRoute, { mode: 'restore', savedScrollY: initialSavedScrollY });
