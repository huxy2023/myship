let appState = null;
let selectedProject = typeof __MYSHIP_DEFAULT_PROJECT__ !== 'undefined' ? __MYSHIP_DEFAULT_PROJECT__ : 'default';
let activeView = 'releases';
let activeDataSubtab = 'db';
let openDrawerDplId = null;
let requestEpoch = 0;

// 环境变量与数据页缓存状态
let currentEnvVarsMap = {};
let revealedEnvKeys = new Set();
let editingEnvKey = null;
let currentResourcesData = null;
let selectedDbTable = null;
let selectedKvKey = null;
let lastGcDryRunPlan = null;

function el(id) {
  const node = document.getElementById(id) || {
    value: '',
    checked: false,
    disabled: false,
    style: {},
    innerHTML: '',
    textContent: '',
  };
  if (!node.style) node.style = {};
  if (!node.classList) {
    node.classList = {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    };
  }
  return node;
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  const pad = (v) => String(v).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

// 1. 主题管理 (默认浅色 Light-First)
function initTheme() {
  try {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem('myship-console-theme') : null;
    const isDark = saved === 'dark';
    if (document.documentElement && document.documentElement.classList) {
      document.documentElement.classList.toggle('dark', isDark);
    }
    el('themeToggleLabel').textContent = isDark ? '浅色' : '深色';
  } catch {}
}

function toggleTheme() {
  try {
    const root = document.documentElement;
    const isDark = root && root.classList ? !root.classList.contains('dark') : false;
    if (root && root.classList) {
      root.classList.toggle('dark', isDark);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('myship-console-theme', isDark ? 'dark' : 'light');
    }
    el('themeToggleLabel').textContent = isDark ? '浅色' : '深色';
  } catch {}
}

// 2. URL Hash 路由状态同步
function restoreFromUrlHash() {
  try {
    if (typeof window === 'undefined' || !window.location || !window.location.hash) return;
    const raw = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const p = params.get('project');
    const v = params.get('view');
    const dpl = params.get('dpl');
    if (p) selectedProject = p;
    if (v && ['releases', 'logs', 'data', 'settings', 'gc'].includes(v)) {
      activeView = v;
    }
    if (dpl) openDrawerDplId = dpl;
  } catch {}
}

function syncUrlHash() {
  try {
    if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
    const params = new URLSearchParams();
    if (selectedProject) params.set('project', selectedProject);
    if (activeView && activeView !== 'releases') params.set('view', activeView);
    if (openDrawerDplId) params.set('dpl', openDrawerDplId);
    const hashStr = params.toString();
    window.history.replaceState(null, '', hashStr ? '#' + hashStr : window.location.pathname);
  } catch {}
}

function showToast(msg, isError = false) {
  const t = el('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.background = isError ? 'var(--red)' : 'var(--text)';
  t.style.color = isError ? '#ffffff' : 'var(--panel)';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    t.style.display = 'none';
  }, 3600);
}

async function copyText(text, label = '内容') {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      showToast('已复制' + label);
    }
  } catch (err) {
    showToast('复制失败: ' + err.message, true);
  }
}

// 3. 统一交互弹窗（支持内联加载态与错误展示，不提前关闭）
let currentModalConfirmHandler = null;
function openModal({
  title = '确认操作',
  descHtml = '',
  formHtml = '',
  confirmText = '确认执行',
  confirmClass = 'btn btn-primary',
  onConfirm = null,
}) {
  el('modalTitle').textContent = title;
  el('modalDesc').innerHTML = descHtml;
  el('modalFormArea').innerHTML = formHtml;
  const errBox = el('modalErrorBox');
  errBox.style.display = 'none';
  errBox.textContent = '';

  const confirmBtn = el('modalConfirmBtn');
  const cancelBtn = el('modalCancelBtn');
  confirmBtn.textContent = confirmText;
  confirmBtn.className = confirmClass;
  confirmBtn.disabled = false;
  cancelBtn.disabled = false;

  currentModalConfirmHandler = async () => {
    if (!onConfirm) {
      closeModal();
      return;
    }
    errBox.style.display = 'none';
    const prevText = confirmBtn.textContent;
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = '执行中...';
    try {
      const shouldClose = await onConfirm();
      if (shouldClose !== false) {
        closeModal();
      }
    } catch (err) {
      errBox.textContent = err.message || String(err);
      errBox.style.display = 'block';
    } finally {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = prevText;
    }
  };
  confirmBtn.onclick = currentModalConfirmHandler;
  el('confirmModal').classList.add('open');
}

function closeModal() {
  el('confirmModal').classList.remove('open');
  currentModalConfirmHandler = null;
}

async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
    headers['X-MyShip-Console'] = '1';
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || '请求失败 (' + res.status + ')');
  }
  return data;
}

// 4. 精准解析项目与主域名访问状态、回滚候选版本
function getSelectedProjectGroup() {
  if (!appState || !Array.isArray(appState.projects)) return null;
  return appState.projects.find((p) => p.name === selectedProject) || appState.projects[0] || null;
}

function resolveProjectAccessState(proj) {
  if (!proj) {
    return {
      code: 'empty',
      label: '无项目',
      dot: 'idle',
      badgeClass: 'badge-muted',
      reason: null,
      at: null,
      primaryAlias: null,
      activeManifest: null,
      latestManifest: null,
    };
  }
  const primaryAlias = (proj.aliases || []).find((a) => a.subdomain === proj.name) || null;
  const activeManifest = primaryAlias
    ? (proj.manifests || []).find((m) => m.id === primaryAlias.deploymentId) || null
    : null;
  const latestManifest = (proj.manifests || [])[0] || null;

  if (proj.projectDisabled === true) {
    return {
      code: 'project-paused',
      label: '项目维护暂停',
      dot: 'paused',
      badgeClass: 'badge-amber',
      reason: proj.projectDisabledReason || '该项目当前处于维护暂停状态，所有域名均返回 503 维护页',
      at: proj.projectDisabledAt || null,
      primaryAlias,
      activeManifest,
      latestManifest,
    };
  }
  if (primaryAlias && primaryAlias.disabled === true) {
    return {
      code: 'domain-paused',
      label: '主域名已暂停',
      dot: 'paused',
      badgeClass: 'badge-amber',
      reason: primaryAlias.disabledReason || '生产主域名当前已暂停对外访问',
      at: primaryAlias.disabledAt || null,
      primaryAlias,
      activeManifest,
      latestManifest,
    };
  }
  if (primaryAlias && activeManifest && activeManifest.disabled === true) {
    return {
      code: 'version-disabled',
      label: '生产指向版本已禁用',
      dot: 'disabled',
      badgeClass: 'badge-red',
      reason:
        activeManifest.disabledReason ||
        '生产主域名指向的版本 (' + activeManifest.id + ') 已被禁用，访客将收到 503',
      at: activeManifest.disabledAt || null,
      primaryAlias,
      activeManifest,
      latestManifest,
    };
  }
  if (!primaryAlias) {
    return {
      code: 'unbound',
      label: '主域名未绑定',
      dot: 'idle',
      badgeClass: 'badge-muted',
      reason: null,
      at: null,
      primaryAlias: null,
      activeManifest: null,
      latestManifest,
    };
  }
  return {
    code: 'online',
    label: '允许访问',
    dot: 'online',
    badgeClass: 'badge-green',
    reason: null,
    at: null,
    primaryAlias,
    activeManifest,
    latestManifest,
  };
}

function resolveRollbackCandidate(proj, alias) {
  if (!proj || !alias || !Array.isArray(proj.manifests)) return null;
  const manifests = proj.manifests;
  if (alias.previousDeploymentId && alias.previousDeploymentId !== alias.deploymentId) {
    const prevM = manifests.find((m) => m.id === alias.previousDeploymentId);
    if (prevM && prevM.disabled !== true) {
      return { id: prevM.id, source: 'previousDeploymentId', manifest: prevM };
    }
  }
  const currIdx = manifests.findIndex((m) => m.id === alias.deploymentId);
  const olderPool = currIdx >= 0 ? manifests.slice(currIdx + 1) : manifests;
  const fallback = olderPool.find((m) => m.id !== alias.deploymentId && m.disabled !== true);
  if (fallback) {
    return { id: fallback.id, source: 'history', manifest: fallback };
  }
  return null;
}

function describeManifestCompute(m) {
  if (!m) return { badgeHtml: '<span class="badge badge-muted">-</span>', detail: '-' };
  const fnCount = Object.keys(m.functions || {}).length;
  const fileCount = Object.keys(m.files || {}).length;
  const b = m.backend;
  if (b && b.mode === 'scf-web') {
    const ver = b.version || b.scfVersion || '$LATEST';
    return {
      badgeHtml: '<span class="badge badge-purple">SCF Web v' + esc(ver) + '</span>',
      detail: fileCount + ' 静态文件 · ' + esc(b.prefix || '/api') + '/* 转发',
    };
  }
  if (fnCount > 0) {
    return {
      badgeHtml: '<span class="badge badge-blue">Edge Worker (' + fnCount + ')</span>',
      detail: fileCount + ' 静态文件 · ' + fnCount + ' 边缘路由',
    };
  }
  return {
    badgeHtml: '<span class="badge badge-muted">Static</span>',
    detail: fileCount + ' 静态文件',
  };
}

// 5. 全局状态加载与项目切换
async function refreshAll() {
  try {
    requestEpoch++;
    const state = await apiFetch('/api/console/state');
    appState = state;
    el('modeBadge').textContent = state.modeLabel;
    el('domainBadge').textContent = '*.' + state.domainSuffix;
    el('statProjects').textContent = state.projects.length;
    el('statManifests').textContent = state.manifestsCount;
    el('statBlobs').textContent = state.blobsCount;

    if (!state.projects.some((p) => p.name === selectedProject)) {
      selectedProject = state.defaultProject || state.projects[0]?.name || 'default';
    }

    renderSidebarProjects();
    updateNavActiveState();
    renderActiveWorkspace();

    if (openDrawerDplId) {
      openDeploymentDrawer(openDrawerDplId, true);
    }
  } catch (err) {
    showToast('同步状态失败: ' + err.message, true);
  }
}

function renderSidebarProjects() {
  if (!appState) return;
  const q = String(el('projectSearchInput').value || '').trim().toLowerCase();
  const filtered = appState.projects.filter((p) => !q || p.name.toLowerCase().includes(q));
  el('sidebarProjectsCount').textContent = appState.projects.length;

  if (filtered.length === 0) {
    el('projectList').innerHTML =
      '<div style="padding:8px;font-size:12px;color:var(--muted);">无匹配项目</div>';
    return;
  }

  el('projectList').innerHTML = filtered
    .map((p) => {
      const st = resolveProjectAccessState(p);
      const isActive = activeView !== 'gc' && p.name === selectedProject;
      return (
        '<div class="project-item ' +
        (isActive ? 'active' : '') +
        '" onclick="selectProject(\'' +
        esc(p.name) +
        '\')">' +
        '<div class="project-item-left">' +
        '<span class="status-dot ' +
        st.dot +
        '" title="' +
        esc(st.label) +
        '"></span>' +
        '<span class="project-item-name mono">' +
        esc(p.name) +
        '</span>' +
        '</div>' +
        '<span class="project-item-count">' +
        p.manifests.length +
        '</span>' +
        '</div>'
      );
    })
    .join('');
}

function onProjectSearchInput() {
  renderSidebarProjects();
}

function selectProject(projName) {
  if (selectedProject !== projName) {
    selectedProject = projName;
    requestEpoch++;
    revealedEnvKeys = new Set();
    cancelEditEnv();
    selectedDbTable = null;
    selectedKvKey = null;
    openDrawerDplId = null;
    closeDeploymentDrawer(true);
  }
  if (activeView === 'gc') {
    activeView = 'releases';
  }
  syncUrlHash();
  renderSidebarProjects();
  updateNavActiveState();
  renderActiveWorkspace();
}

function switchView(viewName) {
  activeView = viewName;
  syncUrlHash();
  renderSidebarProjects();
  updateNavActiveState();
  renderActiveWorkspace();
}

function updateNavActiveState() {
  const views = ['releases', 'logs', 'data', 'settings', 'gc'];
  for (const v of views) {
    const navBtn = el('nav-' + v);
    if (navBtn && navBtn.classList) {
      navBtn.classList.toggle('active', activeView === v);
    }
    const panel = el('view-' + v);
    if (panel && panel.classList) {
      panel.classList.toggle('active', activeView === v);
    }
  }
  el('projectHeaderCard').style.display = activeView === 'gc' ? 'none' : 'flex';
}

function renderActiveWorkspace() {
  const proj = getSelectedProjectGroup();
  if (!proj) return;

  el('navCountReleases').textContent = proj.manifests.length;
  renderProjectHeader(proj);
  renderBackendOverviewCard(proj);

  if (activeView === 'releases') {
    renderReleasesView(proj);
  } else if (activeView === 'logs') {
    loadLogs();
  } else if (activeView === 'data') {
    loadResources(false);
  } else if (activeView === 'settings') {
    loadEnvVars();
  }
}

// 6. 紧凑项目页头渲染
function renderProjectHeader(proj) {
  const st = resolveProjectAccessState(proj);
  el('currentProjectTitle').textContent = proj.name;
  el('projectHealthBadge').innerHTML =
    '<span class="badge ' +
    st.badgeClass +
    '"><span class="status-dot ' +
    st.dot +
    '"></span>' +
    esc(st.label) +
    '</span>';

  if (st.primaryAlias) {
    const url = appState.protocol + '://' + st.primaryAlias.subdomain + '.' + appState.domainSuffix;
    el('primaryDomainLink').innerHTML =
      '<a href="' +
      esc(url) +
      '" target="_blank" class="mono" style="font-size:12.5px;font-weight:500;">' +
      esc(url) +
      ' ↗</a>';
  } else {
    el('primaryDomainLink').innerHTML =
      '<span style="font-size:12px;color:var(--muted);">未绑定生产主域名 (' +
      esc(proj.name + '.' + appState.domainSuffix) +
      ')</span>';
  }

  // 顶部右侧操作区
  let headerActionsHtml = '';
  if (proj.projectDisabled) {
    headerActionsHtml +=
      '<button class="btn btn-green" onclick="promptToggleProjectAvailability(\'online\')">恢复项目上线</button>';
  } else {
    headerActionsHtml +=
      '<button class="btn btn-amber" onclick="promptToggleProjectAvailability(\'offline\')">暂停项目访问...</button>';
  }
  el('projectHeaderActions').innerHTML = headerActionsHtml;

  // 紧凑元数据行
  const activeId = st.activeManifest ? st.activeManifest.id : null;
  const latestId = st.latestManifest ? st.latestManifest.id : null;
  const computeInfo = describeManifestCompute(st.activeManifest || st.latestManifest);
  const metaParts = [];
  if (activeId) {
    metaParts.push(
      '<span class="project-meta-item">生产版本: <button class="dpl-link mono" onclick="openDeploymentDrawer(\'' +
        esc(activeId) +
        '\')">' +
        esc(activeId) +
        '</button></span>'
    );
  } else {
    metaParts.push(
      '<span class="project-meta-item">生产版本: <span style="color:var(--muted);">未绑定</span></span>'
    );
  }
  if (latestId && latestId !== activeId) {
    metaParts.push(
      '<span class="project-meta-item">最新构建: <button class="dpl-link mono" onclick="openDeploymentDrawer(\'' +
        esc(latestId) +
        '\')">' +
        esc(latestId) +
        '</button> <span class="badge badge-amber">与生产不同步</span></span>'
    );
  }
  metaParts.push('<span class="project-meta-item">计算形态: ' + computeInfo.badgeHtml + '</span>');
  metaParts.push(
    '<span class="project-meta-item">域名入口: <strong>' +
      proj.aliases.length +
      '</strong> 个 · 历史快照: <strong>' +
      proj.manifests.length +
      '</strong> 个</span>'
  );
  el('projectMetaRow').innerHTML = metaParts.join('');

  // 维护或禁用告警横幅
  const alertBanner = el('projectAlertBanner');
  if (st.code === 'project-paused') {
    alertBanner.style.display = 'flex';
    alertBanner.className = 'project-alert-banner';
    alertBanner.innerHTML =
      '<div><strong>项目维护暂停中：</strong>' +
      esc(st.reason) +
      (st.at ? ' <span style="opacity:0.8;">(' + esc(formatTime(st.at)) + ')</span>' : '') +
      '</div>' +
      '<button class="btn btn-sm btn-green" onclick="promptToggleProjectAvailability(\'online\')">立即恢复上线</button>';
  } else if (st.code === 'domain-paused') {
    alertBanner.style.display = 'flex';
    alertBanner.className = 'project-alert-banner';
    alertBanner.innerHTML =
      '<div><strong>生产主域名已暂停：</strong>' +
      esc(st.reason) +
      (st.at ? ' <span style="opacity:0.8;">(' + esc(formatTime(st.at)) + ')</span>' : '') +
      '</div>' +
      '<button class="btn btn-sm btn-green" onclick="promptToggleAliasAvailability(\'' +
      esc(st.primaryAlias.subdomain) +
      '\', \'online\')">恢复主域名</button>';
  } else if (st.code === 'version-disabled') {
    alertBanner.style.display = 'flex';
    alertBanner.className = 'project-alert-banner danger';
    alertBanner.innerHTML =
      '<div><strong>生产流量阻断：</strong>' +
      esc(st.reason) +
      '</div>' +
      '<div class="row-actions">' +
      '<button class="btn btn-sm btn-green" onclick="promptToggleDeploymentAvailability(\'' +
      esc(st.activeManifest.id) +
      '\', \'online\')">解封该版本</button>' +
      '</div>';
  } else {
    alertBanner.style.display = 'none';
    alertBanner.innerHTML = '';
  }
}

// 7. 「发布与域名 (Releases)」视图渲染
function renderReleasesView(proj) {
  el('deploymentsCountBadge').textContent = proj.manifests.length;

  // (a) 填充新增子域名下拉框（仅允许绑定未禁用的健康版本）
  const healthyManifests = proj.manifests.filter((m) => m.disabled !== true);
  const healthyOptionsHtml = healthyManifests
    .map(
      (m, idx) =>
        '<option value="' + esc(m.id) + '">' + esc(m.id) + (idx === 0 ? ' (最新)' : '') + '</option>'
    )
    .join('');
  el('newAliasDplSelect').innerHTML =
    healthyOptionsHtml || '<option value="">无可用健康版本</option>';
  onAliasInputPreview();

  // (b) 填充 Diff 下拉框（包含全部版本，含已禁用故障版本以便排查对比！）
  const primaryAlias = proj.aliases.find((a) => a.subdomain === proj.name) || null;
  const prodDplId = primaryAlias ? primaryAlias.deploymentId : null;
  const allDiffOptionsHtml = proj.manifests
    .map((m, idx) => {
      const tags = [];
      if (m.id === prodDplId) tags.push('当前生产');
      if (idx === 0) tags.push('最新');
      if (m.disabled === true) tags.push('已禁用');
      const suffix = tags.length > 0 ? ' (' + tags.join(' · ') + ')' : '';
      return '<option value="' + esc(m.id) + '">' + esc(m.id + suffix) + '</option>';
    })
    .join('');

  const baseSelect = el('diffBaseSelect');
  const targetSelect = el('diffTargetSelect');
  const prevBase = baseSelect.value;
  const prevTarget = targetSelect.value;
  baseSelect.innerHTML = allDiffOptionsHtml;
  targetSelect.innerHTML = allDiffOptionsHtml;

  if (proj.manifests.some((m) => m.id === prevBase)) {
    baseSelect.value = prevBase;
  } else if (prodDplId && proj.manifests.some((m) => m.id === prodDplId)) {
    baseSelect.value = prodDplId;
  } else if (proj.manifests.length > 1) {
    baseSelect.value = proj.manifests[1].id;
  } else if (proj.manifests.length === 1) {
    baseSelect.value = proj.manifests[0].id;
  }

  if (proj.manifests.some((m) => m.id === prevTarget)) {
    targetSelect.value = prevTarget;
  } else if (proj.manifests.length > 0) {
    targetSelect.value = proj.manifests[0].id;
  }

  // (c) 渲染「访问入口 (Domains)」表
  renderDomainsTable(proj, healthyManifests);

  // (d) 渲染「部署历史 (Deployments)」表
  renderDeploymentsTable(proj);
}

function onAliasInputPreview() {
  const proj = getSelectedProjectGroup();
  const hintEl = el('aliasPreviewHint');
  if (!proj || !appState) {
    hintEl.textContent = '';
    return;
  }
  const raw = String(el('newAliasSub').value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  if (!raw) {
    hintEl.textContent =
      '输入 env 前缀将绑定至 ' + proj.name + '-<env>.' + appState.domainSuffix;
    return;
  }
  const fullSub =
    raw === proj.name || raw.startsWith(proj.name + '-') ? raw : proj.name + '-' + raw;
  const existing = proj.aliases.find((a) => a.subdomain === fullSub);
  const url = appState.protocol + '://' + fullSub + '.' + appState.domainSuffix;
  hintEl.innerHTML =
    '预览地址: <strong>' +
    esc(url) +
    '</strong>' +
    (existing
      ? ' <span class="badge badge-amber">已指向 ' +
        esc(existing.deploymentId) +
        '，提交将覆盖切流</span>'
      : ' <span class="badge badge-blue">新增入口</span>');
}

function renderDomainsTable(proj, healthyManifests) {
  const aliases = [...proj.aliases].sort((a, b) => {
    if (a.subdomain === proj.name) return -1;
    if (b.subdomain === proj.name) return 1;
    return a.subdomain.localeCompare(b.subdomain);
  });

  const rows = [];
  const hasPrimary = aliases.some((a) => a.subdomain === proj.name);
  if (!hasPrimary) {
    const primaryUrl = appState.protocol + '://' + proj.name + '.' + appState.domainSuffix;
    const latestHealthy = healthyManifests[0] || null;
    rows.push(
      '<tr>' +
        '<td><span class="mono" style="color:var(--muted);">' +
        esc(primaryUrl) +
        '</span> <span class="badge badge-muted">生产主域</span></td>' +
        '<td style="color:var(--muted);">未绑定</td>' +
        '<td><span class="badge badge-muted"><span class="status-dot idle"></span>未绑定版本</span></td>' +
        '<td>' +
        (latestHealthy
          ? '<button class="btn btn-sm btn-primary" onclick="quickSwitchAlias(\'' +
            esc(proj.name) +
            '\', \'' +
            esc(latestHealthy.id) +
            '\')">绑定至最新 (' +
            esc(latestHealthy.id) +
            ')</button>'
          : '<span style="color:var(--muted);font-size:12px;">无可绑定健康版本</span>') +
        '</td>' +
        '</tr>'
    );
  }

  for (const a of aliases) {
    const isPrimary = a.subdomain === proj.name;
    const fullUrl = appState.protocol + '://' + a.subdomain + '.' + appState.domainSuffix;
    const pointedM = proj.manifests.find((m) => m.id === a.deploymentId) || null;
    const rollbackTarget = resolveRollbackCandidate(proj, a);

    // 判断该域名真实可访问状态
    let statusHtml = '';
    if (proj.projectDisabled) {
      statusHtml =
        '<span class="badge badge-amber"><span class="status-dot paused"></span>随项目暂停</span>';
    } else if (a.disabled) {
      statusHtml =
        '<span class="badge badge-amber"><span class="status-dot paused"></span>域名已暂停</span>' +
        (a.disabledReason
          ? '<div style="font-size:11px;color:var(--amber);margin-top:2px;">原因: ' +
            esc(a.disabledReason) +
            '</div>'
          : '');
    } else if (pointedM && pointedM.disabled) {
      statusHtml =
        '<span class="badge badge-red"><span class="status-dot disabled"></span>目标版本已禁用</span>' +
        (pointedM.disabledReason
          ? '<div style="font-size:11px;color:var(--red);margin-top:2px;">原因: ' +
            esc(pointedM.disabledReason) +
            '</div>'
          : '');
    } else {
      statusHtml =
        '<span class="badge badge-green"><span class="status-dot online"></span>正常服务</span>';
    }

    const selectOptions = healthyManifests
      .map(
        (m) =>
          '<option value="' +
          esc(m.id) +
          '" ' +
          (m.id === a.deploymentId ? 'selected' : '') +
          '>' +
          esc(m.id) +
          '</option>'
      )
      .join('');

    const rollbackBtnHtml = rollbackTarget
      ? '<button class="btn btn-sm" onclick="promptRollback(\'' +
        esc(a.subdomain) +
        '\', \'' +
        esc(a.deploymentId) +
        '\', \'' +
        esc(rollbackTarget.id) +
        '\')" title="回滚至 ' +
        esc(rollbackTarget.id) +
        '">回滚至 ' +
        esc(rollbackTarget.id) +
        '</button>'
      : '<button class="btn btn-sm" disabled title="没有可回滚的历史健康版本">无可回滚版本</button>';

    const toggleAliasBtn = a.disabled
      ? '<button class="btn btn-sm btn-green" onclick="promptToggleAliasAvailability(\'' +
        esc(a.subdomain) +
        '\', \'online\')">恢复</button>'
      : '<button class="btn btn-sm btn-amber" onclick="promptToggleAliasAvailability(\'' +
        esc(a.subdomain) +
        '\', \'offline\')">暂停</button>';

    rows.push(
      '<tr>' +
        '<td>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<a href="' +
        esc(fullUrl) +
        '" target="_blank" class="mono" style="font-weight:600;">' +
        esc(fullUrl) +
        ' ↗</a>' +
        (isPrimary
          ? '<span class="badge badge-blue">生产主域</span>'
          : '<span class="badge badge-muted">子域名</span>') +
        '</div>' +
        '</td>' +
        '<td>' +
        '<button class="dpl-link mono" onclick="openDeploymentDrawer(\'' +
        esc(a.deploymentId) +
        '\')">' +
        esc(a.deploymentId) +
        '</button>' +
        (pointedM
          ? '<div style="font-size:11px;color:var(--muted);">' +
            esc(formatTime(pointedM.createdAt)) +
            '</div>'
          : '') +
        '</td>' +
        '<td>' +
        statusHtml +
        '</td>' +
        '<td>' +
        '<div class="row-actions">' +
        '<select class="select mono" id="sel-' +
        esc(a.subdomain) +
        '" style="height:26px;font-size:11.5px;min-width:140px;">' +
        selectOptions +
        '</select>' +
        '<button class="btn btn-sm btn-primary" onclick="switchAliasFromSelect(\'' +
        esc(a.subdomain) +
        '\')">切流</button>' +
        rollbackBtnHtml +
        toggleAliasBtn +
        '<button class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="promptRemoveAlias(\'' +
        esc(a.subdomain) +
        '\')">解绑</button>' +
        '</div>' +
        '</td>' +
        '</tr>'
    );
  }

  el('aliasesTableBody').innerHTML =
    rows.join('') || '<tr><td colspan="4" class="empty-state">暂无绑定的访问域名</td></tr>';
}

function renderDeploymentsTable(proj) {
  const dplToAliases = new Map();
  for (const a of proj.aliases) {
    if (!dplToAliases.has(a.deploymentId)) dplToAliases.set(a.deploymentId, []);
    dplToAliases.get(a.deploymentId).push(a);
  }

  const primaryAlias = proj.aliases.find((a) => a.subdomain === proj.name) || null;
  const prodDplId = primaryAlias ? primaryAlias.deploymentId : null;

  if (proj.manifests.length === 0) {
    el('deploymentsTableBody').innerHTML =
      '<tr><td colspan="6" class="empty-state">该项目尚无部署记录</td></tr>';
    return;
  }

  el('deploymentsTableBody').innerHTML = proj.manifests
    .map((m, idx) => {
      const boundAliases = dplToAliases.get(m.id) || [];
      const isProd = m.id === prodDplId;
      const isDisabled = m.disabled === true;
      const compute = describeManifestCompute(m);
      const immSub = m.immutableSubdomain || m.id.replace(/^dpl_/, 'dpl-');
      const immUrl = appState.protocol + '://' + immSub + '.' + appState.domainSuffix;

      const aliasChipsHtml =
        boundAliases.length > 0
          ? boundAliases
              .map((a) => {
                const isMain = a.subdomain === proj.name;
                return (
                  '<span class="badge ' +
                  (isMain ? 'badge-blue' : 'badge-muted') +
                  ' mono">' +
                  esc(a.subdomain) +
                  '</span>'
                );
              })
              .join(' ')
          : '<span style="color:var(--muted);font-size:11.5px;">未绑定域名</span>';

      let statusCellHtml = '';
      if (isDisabled) {
        statusCellHtml =
          '<span class="badge badge-red"><span class="status-dot disabled"></span>版本已禁用</span>' +
          (m.disabledReason
            ? '<div style="font-size:11px;color:var(--red);margin-top:2px;">原因: ' +
              esc(m.disabledReason) +
              '</div>'
            : '');
      } else if (isProd) {
        statusCellHtml =
          '<span class="badge badge-green"><span class="status-dot online"></span>生产服役中</span>';
      } else {
        statusCellHtml = '<span class="badge badge-muted">历史就绪</span>';
      }

      return (
        '<tr>' +
        '<td>' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<button class="dpl-link mono" onclick="openDeploymentDrawer(\'' +
        esc(m.id) +
        '\')">' +
        esc(m.id) +
        '</button>' +
        (idx === 0 ? '<span class="badge badge-blue">最新</span>' : '') +
        '</div>' +
        '<div style="margin-top:2px;">' +
        '<a href="' +
        esc(immUrl) +
        '" target="_blank" class="mono" style="font-size:11px;color:var(--muted);">' +
        esc(immSub) +
        ' ↗</a>' +
        '</div>' +
        '</td>' +
        '<td><div style="display:flex;gap:4px;flex-wrap:wrap;">' +
        aliasChipsHtml +
        '</div></td>' +
        '<td>' +
        compute.badgeHtml +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px;">' +
        compute.detail +
        '</div>' +
        '</td>' +
        '<td class="mono" style="font-size:12px;color:var(--text-secondary);">' +
        esc(formatTime(m.createdAt)) +
        '</td>' +
        '<td>' +
        statusCellHtml +
        '</td>' +
        '<td>' +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" onclick="openDeploymentDrawer(\'' +
        esc(m.id) +
        '\')">详情</button>' +
        (!isProd && !isDisabled
          ? '<button class="btn btn-sm btn-primary" onclick="quickSwitchAlias(\'' +
            esc(proj.name) +
            '\', \'' +
            esc(m.id) +
            '\')">切至生产</button>'
          : '') +
        (prodDplId && prodDplId !== m.id
          ? '<button class="btn btn-sm" onclick="diffWithProduction(\'' +
            esc(prodDplId) +
            '\', \'' +
            esc(m.id) +
            '\')">对比生产</button>'
          : '') +
        (isDisabled
          ? '<button class="btn btn-sm btn-green" onclick="promptToggleDeploymentAvailability(\'' +
            esc(m.id) +
            '\', \'online\')">解封</button>'
          : '<button class="btn btn-sm btn-amber" onclick="promptToggleDeploymentAvailability(\'' +
            esc(m.id) +
            '\', \'offline\')">禁用</button>') +
        '<button class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="promptRemoveDeployment(\'' +
        esc(m.id) +
        '\', ' +
        (boundAliases.length > 0 ? 'true' : 'false') +
        ')">删除</button>' +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
}

// 8. 切流、回滚、上下线与版本禁用弹窗操作
async function bindNewAlias() {
  const sub = String(el('newAliasSub').value || '').trim();
  const dplId = el('newAliasDplSelect').value;
  if (!sub || !dplId) {
    showToast('请输入子域名前缀并选择目标构建版本', true);
    return;
  }
  try {
    await apiFetch('/api/console/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: selectedProject,
        subdomain: sub,
        deploymentId: dplId,
        raw: false,
      }),
    });
    el('newAliasSub').value = '';
    onAliasInputPreview();
    showToast('子域名绑定成功');
    await refreshAll();
  } catch (err) {
    showToast(err.message, true);
  }
}

async function switchAliasFromSelect(subdomain) {
  const sel = document.getElementById('sel-' + subdomain);
  if (!sel || !sel.value) return;
  await quickSwitchAlias(subdomain, sel.value);
}

async function quickSwitchAlias(subdomain, deploymentId) {
  try {
    await apiFetch('/api/console/alias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: selectedProject,
        subdomain,
        deploymentId,
        raw: true,
      }),
    });
    showToast('已将 ' + subdomain + ' 切流至 ' + deploymentId);
    await refreshAll();
  } catch (err) {
    showToast(err.message, true);
  }
}

function promptRollback(subdomain, currentDplId, targetDplId) {
  openModal({
    title: '确认回滚访问入口',
    descHtml:
      '即将把域名 <code>' +
      esc(subdomain + '.' + appState.domainSuffix) +
      '</code> 从当前版本 <code>' +
      esc(currentDplId) +
      '</code> 回滚至历史健康版本 <strong><code>' +
      esc(targetDplId) +
      '</code></strong>。',
    confirmText: '确认回滚至 ' + targetDplId,
    confirmClass: 'btn btn-primary',
    onConfirm: async () => {
      const data = await apiFetch('/api/console/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject,
          subdomain,
          targetDeploymentId: targetDplId,
        }),
      });
      showToast('已回滚至 ' + data.alias.deploymentId);
      await refreshAll();
    },
  });
}

function promptToggleProjectAvailability(action) {
  const isOnline = action === 'online';
  openModal({
    title: isOnline ? '恢复项目上线' : '暂停项目对外访问',
    descHtml: isOnline
      ? '确认将项目 <code>' +
        esc(selectedProject) +
        '</code> 恢复上线吗？<br/><span style="font-size:11.5px;color:var(--muted);">注：此前被单独标记为禁用的故障构建版本仍将保持禁用状态。</span>'
      : '暂停后，项目 <code>' +
        esc(selectedProject) +
        '</code> 下的所有生产主域名、预览子域名及快照预览地址将返回 503 维护页（边缘层直接拦截，不穿透后端）。',
    formHtml: isOnline
      ? ''
      : '<div style="margin-top:6px;">' +
        '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">维护说明（可选，将展示在访客 503 页面上）</label>' +
        '<input type="text" class="input" id="modalReasonInput" style="width:100%;" placeholder="如：系统升级维护中，预计 10 分钟后恢复" />' +
        '</div>',
    confirmText: isOnline ? '确认恢复上线' : '确认暂停项目',
    confirmClass: isOnline ? 'btn btn-green' : 'btn btn-amber',
    onConfirm: async () => {
      const reason = isOnline ? null : String(el('modalReasonInput').value || '').trim() || null;
      await apiFetch('/api/console/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          project: selectedProject,
          reason,
        }),
      });
      showToast(isOnline ? '项目已恢复上线' : '项目已进入维护暂停状态');
      await refreshAll();
    },
  });
}

function promptToggleAliasAvailability(subdomain, action) {
  const isOnline = action === 'online';
  const proj = getSelectedProjectGroup();
  const aliasObj = proj?.aliases.find((a) => a.subdomain === subdomain);
  const pointedM = aliasObj ? proj?.manifests.find((m) => m.id === aliasObj.deploymentId) : null;

  let extraNotice = '';
  if (isOnline && pointedM && pointedM.disabled) {
    extraNotice =
      '<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--amber-soft);border:1px solid var(--amber-border);color:var(--amber);font-size:12px;">' +
      '注意：该域名当前指向的版本 <code>' +
      esc(pointedM.id) +
      '</code> 自身仍处于「已禁用」状态。恢复域名后，您还需将该域名切流至其他健康版本或解封 <code>' +
      esc(pointedM.id) +
      '</code> 方可正常访问。</div>';
  }

  openModal({
    title: isOnline ? '恢复域名访问' : '暂停域名访问',
    descHtml:
      (isOnline
        ? '确认恢复域名 <code>' + esc(subdomain + '.' + appState.domainSuffix) + '</code> 的对外访问吗？'
        : '暂停后，访问 <code>' +
          esc(subdomain + '.' + appState.domainSuffix) +
          '</code> 将返回 503 维护页，不影响项目下其他正常域名。') + extraNotice,
    formHtml: isOnline
      ? ''
      : '<div style="margin-top:6px;">' +
        '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">暂停原因（可选，展示在 503 页面上）</label>' +
        '<input type="text" class="input" id="modalReasonInput" style="width:100%;" placeholder="如：预发环境联调维护中" />' +
        '</div>',
    confirmText: isOnline ? '确认恢复域名' : '确认暂停域名',
    confirmClass: isOnline ? 'btn btn-green' : 'btn btn-amber',
    onConfirm: async () => {
      const reason = isOnline ? null : String(el('modalReasonInput').value || '').trim() || null;
      await apiFetch('/api/console/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          project: selectedProject,
          subdomain,
          raw: true,
          reason,
        }),
      });
      showToast(isOnline ? '域名 ' + subdomain + ' 已恢复' : '域名 ' + subdomain + ' 已暂停');
      await refreshAll();
    },
  });
}

function promptToggleDeploymentAvailability(deploymentId, action) {
  const isOnline = action === 'online';
  const proj = getSelectedProjectGroup();
  const boundAliases = (proj?.aliases || []).filter((a) => a.deploymentId === deploymentId);

  let activeWarnHtml = '';
  if (!isOnline && boundAliases.length > 0) {
    activeWarnHtml =
      '<div style="margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--red-soft);border:1px solid var(--red-border);color:var(--red);font-size:12px;">' +
      '<strong>高危提醒：</strong>当前有 ' +
      boundAliases.length +
      ' 个域名（' +
      boundAliases.map((a) => '<code>' + esc(a.subdomain) + '</code>').join('、') +
      '）正在指向该版本！禁用后这些域名将立即返回 503。</div>';
  }

  openModal({
    title: isOnline ? '解封构建版本' : '禁用构建版本',
    descHtml:
      (isOnline
        ? '确认解除版本 <code>' +
          esc(deploymentId) +
          '</code> 的禁用状态吗？解封后其预览地址将恢复访问，且允许域名重新切流或回滚至该版本。'
        : '禁用版本 <code>' +
          esc(deploymentId) +
          '</code> 后，其不可变预览地址将返回 503，且系统将阻止任何域名切流或自动回滚到该版本。') +
      activeWarnHtml,
    formHtml: isOnline
      ? ''
      : '<div style="margin-top:6px;">' +
        '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">禁用原因（可选）</label>' +
        '<input type="text" class="input" id="modalReasonInput" style="width:100%;" placeholder="如：包含配置错误或线上缺陷，禁止回滚至此版本" />' +
        '</div>',
    confirmText: isOnline ? '确认解封版本' : '确认禁用版本',
    confirmClass: isOnline ? 'btn btn-green' : 'btn btn-amber',
    onConfirm: async () => {
      const reason = isOnline ? null : String(el('modalReasonInput').value || '').trim() || null;
      await apiFetch('/api/console/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          project: selectedProject,
          deploymentId,
          reason,
        }),
      });
      showToast(isOnline ? '版本 ' + deploymentId + ' 已解封' : '版本 ' + deploymentId + ' 已禁用');
      await refreshAll();
    },
  });
}

function promptRemoveAlias(subdomain) {
  openModal({
    title: '解绑访问域名',
    descHtml:
      '确定要解绑域名 <code>' +
      esc(subdomain + '.' + appState.domainSuffix) +
      '</code> 吗？解绑后该域名将不再解析，但底层构建版本快照仍会保留。',
    confirmText: '确认解绑',
    confirmClass: 'btn btn-danger',
    onConfirm: async () => {
      await apiFetch('/api/console/rm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'alias',
          project: selectedProject,
          subdomain,
          raw: true,
        }),
      });
      showToast('已解绑域名 ' + subdomain);
      await refreshAll();
    },
  });
}

function promptRemoveDeployment(deploymentId, isActive) {
  openModal({
    title: isActive ? '强制删除线上服役版本' : '删除历史构建快照',
    descHtml: isActive
      ? '版本 <code>' +
        esc(deploymentId) +
        '</code> 当前仍有域名绑定！强制删除将同时移除该快照及不再被其他版本引用的孤儿文件块。确定继续吗？'
      : '确定要永久删除历史构建快照 <code>' +
        esc(deploymentId) +
        '</code> 吗？删除后将自动回收其独占的底层 CAS 文件块。',
    confirmText: isActive ? '强制删除' : '确认删除',
    confirmClass: 'btn btn-danger',
    onConfirm: async () => {
      await apiFetch('/api/console/rm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'deployment',
          project: selectedProject,
          deploymentId,
          force: isActive,
        }),
      });
      if (openDrawerDplId === deploymentId) closeDeploymentDrawer();
      showToast('已删除版本 ' + deploymentId);
      await refreshAll();
    },
  });
}

// 9. 版本比较器 (Diff) 与版本详情抽屉
function toggleDiffPanel(forceOpen) {
  const panel = el('diffPanel');
  const isOpen = forceOpen !== undefined ? forceOpen : !panel.classList.contains('open');
  panel.classList.toggle('open', isOpen);
}

function swapDiffSelection() {
  const b = el('diffBaseSelect');
  const t = el('diffTargetSelect');
  const tmp = b.value;
  b.value = t.value;
  t.value = tmp;
}

function diffWithProduction(prodId, targetId) {
  toggleDiffPanel(true);
  el('diffBaseSelect').value = prodId;
  el('diffTargetSelect').value = targetId;
  runDiffCompare();
}

async function runDiffCompare() {
  const baseId = el('diffBaseSelect').value;
  const targetId = el('diffTargetSelect').value;
  const box = el('diffResultArea');
  if (!baseId || !targetId) {
    box.innerHTML = '<div style="color:var(--muted);font-size:12px;">请选择两个版本进行对比</div>';
    return;
  }
  box.innerHTML = '<div style="color:var(--muted);font-size:12px;">正在计算版本差异...</div>';
  try {
    const data = await apiFetch(
      '/api/console/diff?base=' +
        encodeURIComponent(baseId) +
        '&target=' +
        encodeURIComponent(targetId)
    );
    const d = data.diff;
    const fAdd = d.files.added.length;
    const fMod = d.files.modified.length;
    const fDel = d.files.deleted.length;
    const fnAdd = d.functions.added.length;
    const fnMod = d.functions.modified.length;
    const fnDel = d.functions.deleted.length;

    const fileItems = [
      ...d.files.added.map(
        (f) =>
          '<div class="diff-item"><span class="mono"><span class="badge badge-green">+ 新增</span> ' +
          esc(f.path) +
          '</span><span class="mono" style="color:var(--muted);">' +
          formatBytes(f.size) +
          '</span></div>'
      ),
      ...d.files.modified.map((f) => {
        const sign = f.deltaBytes > 0 ? '+' : '';
        return (
          '<div class="diff-item"><span class="mono"><span class="badge badge-amber">~ 修改</span> ' +
          esc(f.path) +
          '</span><span class="mono" style="color:var(--muted);">' +
          formatBytes(f.afterSize) +
          ' (' +
          sign +
          f.deltaBytes +
          ' B)</span></div>'
        );
      }),
      ...d.files.deleted.map(
        (f) =>
          '<div class="diff-item"><span class="mono"><span class="badge badge-red">- 删除</span> ' +
          esc(f.path) +
          '</span><span class="mono" style="color:var(--muted);">' +
          formatBytes(f.size) +
          '</span></div>'
      ),
    ];

    const fnItems = [
      ...d.functions.added.map(
        (fn) =>
          '<div class="diff-item"><span class="mono"><span class="badge badge-green">+ 新增</span> ' +
          esc(fn.route) +
          '</span><span class="mono" style="color:var(--muted);">' +
          esc(fn.runtime) +
          '</span></div>'
      ),
      ...d.functions.modified.map(
        (fn) =>
          '<div class="diff-item"><span class="mono"><span class="badge badge-amber">~ 修改</span> ' +
          esc(fn.route) +
          '</span><span class="mono" style="color:var(--muted);">' +
          esc((fn.beforeSha256 || '').slice(0, 7)) +
          ' → ' +
          esc((fn.afterSha256 || '').slice(0, 7)) +
          '</span></div>'
      ),
      ...d.functions.deleted.map(
        (fn) =>
          '<div class="diff-item"><span class="mono"><span class="badge badge-red">- 删除</span> ' +
          esc(fn.route) +
          '</span><span class="mono" style="color:var(--muted);">已移除</span></div>'
      ),
    ];

    if (d.backend && d.backend.changed) {
      const bVer = d.backend.before?.version || d.backend.before?.scfVersion || '无';
      const aVer = d.backend.after?.version || d.backend.after?.scfVersion || '无';
      fnItems.unshift(
        '<div class="diff-item"><span class="mono"><span class="badge badge-purple">SCF 后端</span> 实例版本变更</span><span class="mono">v' +
          esc(bVer) +
          ' → v' +
          esc(aVer) +
          '</span></div>'
      );
    }

    box.innerHTML =
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
      '<span class="badge badge-green">新增 ' +
      (fAdd + fnAdd) +
      '</span>' +
      '<span class="badge badge-amber">修改 ' +
      (fMod + fnMod) +
      '</span>' +
      '<span class="badge badge-red">删除 ' +
      (fDel + fnDel) +
      '</span>' +
      '<span class="badge badge-muted">未变文件 ' +
      d.files.unchangedCount +
      ' · 未变函数 ' +
      d.functions.unchangedCount +
      '</span>' +
      '</div>' +
      '<div class="diff-grid">' +
      '<div class="diff-list-box">' +
      '<div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">静态产物变更 (' +
      fileItems.length +
      ')</div>' +
      (fileItems.join('') || '<div style="color:var(--muted);font-size:12px;">静态文件无变化</div>') +
      '</div>' +
      '<div class="diff-list-box">' +
      '<div style="font-size:11.5px;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">API 与后端变更 (' +
      fnItems.length +
      ')</div>' +
      (fnItems.join('') || '<div style="color:var(--muted);font-size:12px;">API 与后端无变化</div>') +
      '</div>' +
      '</div>';
  } catch (err) {
    box.innerHTML =
      '<div style="color:var(--red);font-size:12px;">对比失败: ' + esc(err.message) + '</div>';
  }
}

function openDeploymentDrawer(dplId, skipHashSync = false) {
  const proj = getSelectedProjectGroup();
  if (!proj) return;
  const m = proj.manifests.find((item) => item.id === dplId);
  if (!m) return;

  openDrawerDplId = dplId;
  if (!skipHashSync) syncUrlHash();

  const immSub = m.immutableSubdomain || m.id.replace(/^dpl_/, 'dpl-');
  const immUrl = appState.protocol + '://' + immSub + '.' + appState.domainSuffix;
  const boundAliases = proj.aliases.filter((a) => a.deploymentId === m.id);
  const filesEntries = Object.entries(m.files || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const fnEntries = Object.entries(m.functions || {}).sort((a, b) => a[0].localeCompare(b[0]));

  el('deploymentDrawerTitle').textContent = m.id;
  el('deploymentDrawerSubtitle').textContent = '发布于 ' + formatTime(m.createdAt);

  let statusBanner = '';
  if (m.disabled) {
    statusBanner =
      '<div class="project-alert-banner danger">' +
      '<div><strong>该版本已被禁用：</strong>' +
      esc(m.disabledReason || '禁止访问与切流') +
      (m.disabledAt ? ' (' + esc(formatTime(m.disabledAt)) + ')' : '') +
      '</div>' +
      '<button class="btn btn-sm btn-green" onclick="promptToggleDeploymentAvailability(\'' +
      esc(m.id) +
      '\', \'online\')">解封版本</button>' +
      '</div>';
  }

  const backendHtml = m.backend
    ? '<div class="card" style="box-shadow:none;">' +
      '<div class="card-header"><span class="card-title" style="font-size:12.5px;">SCF 后端绑定信息</span></div>' +
      '<div class="card-body mono" style="font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
      '<div>函数名: <strong>' +
      esc(m.backend.functionName || '-') +
      '</strong></div>' +
      '<div>锁定版本: <strong>v' +
      esc(m.backend.version || m.backend.scfVersion || '$LATEST') +
      '</strong></div>' +
      '<div>地域: ' +
      esc(m.backend.region || '-') +
      '</div>' +
      '<div>路由前缀: ' +
      esc(m.backend.prefix || '/api') +
      '/*</div>' +
      '</div></div>'
    : '';

  const fnSectionHtml =
    fnEntries.length > 0
      ? '<div class="card" style="box-shadow:none;">' +
        '<div class="card-header"><span class="card-title" style="font-size:12.5px;">边缘函数与代理路由 (' +
        fnEntries.length +
        ')</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>路由</th><th>运行时</th><th>哈希</th></tr></thead><tbody>' +
        fnEntries
          .map(
            ([route, info]) =>
              '<tr><td class="mono">' +
              esc(route) +
              '</td><td><span class="badge badge-blue">' +
              esc(info.runtime || 'edge-js') +
              '</span></td><td class="mono" style="color:var(--muted);">' +
              esc((info.sha256 || '').slice(0, 10)) +
              '</td></tr>'
          )
          .join('') +
        '</tbody></table></div></div>'
      : '';

  const filesSectionHtml =
    '<div class="card" style="box-shadow:none;">' +
    '<div class="card-header"><span class="card-title" style="font-size:12.5px;">静态产物清单 (' +
    filesEntries.length +
    ' 个文件)</span></div>' +
    '<div class="table-wrap" style="max-height:320px;overflow-y:auto;"><table><thead><tr><th>文件路径</th><th>大小</th><th>SHA-256</th></tr></thead><tbody>' +
    (filesEntries
      .map(
        ([path, info]) =>
          '<tr><td class="mono">' +
          esc(path) +
          '</td><td class="mono" style="color:var(--text-secondary);">' +
          formatBytes(info.size) +
          '</td><td class="mono" style="color:var(--muted);">' +
          esc((info.sha256 || '').slice(0, 12)) +
          '</td></tr>'
      )
      .join('') || '<tr><td colspan="3" class="empty-state">无静态文件</td></tr>') +
    '</tbody></table></div></div>';

  el('deploymentDrawerBody').innerHTML =
    statusBanner +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 12px;background:var(--panel-subtle);border:1px solid var(--border);border-radius:6px;">' +
    '<div>' +
    '<div style="font-size:11px;color:var(--muted);">永久快照预览地址</div>' +
    '<a href="' +
    esc(immUrl) +
    '" target="_blank" class="mono" style="font-weight:600;">' +
    esc(immUrl) +
    ' ↗</a>' +
    '</div>' +
    '<div class="row-actions">' +
    (!m.disabled
      ? '<button class="btn btn-sm btn-primary" onclick="quickSwitchAlias(\'' +
        esc(proj.name) +
        '\', \'' +
        esc(m.id) +
        '\')">切至生产主域</button>'
      : '') +
    (m.disabled
      ? '<button class="btn btn-sm btn-green" onclick="promptToggleDeploymentAvailability(\'' +
        esc(m.id) +
        '\', \'online\')">解封版本</button>'
      : '<button class="btn btn-sm btn-amber" onclick="promptToggleDeploymentAvailability(\'' +
        esc(m.id) +
        '\', \'offline\')">禁用该版本</button>') +
    '</div>' +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-secondary);">当前绑定域名: ' +
    (boundAliases.length > 0
      ? boundAliases.map((a) => '<code class="mono">' + esc(a.subdomain) + '</code>').join('、')
      : '无') +
    '</div>' +
    backendHtml +
    fnSectionHtml +
    filesSectionHtml;

  el('deploymentDrawerOverlay').classList.add('open');
}

function closeDeploymentDrawer(skipHashSync = false) {
  openDrawerDplId = null;
  el('deploymentDrawerOverlay').classList.remove('open');
  if (!skipHashSync) syncUrlHash();
}

// 10. 「日志 (Logs)」视图与 SCF 运行时概览
function renderBackendOverviewCard(proj) {
  const box = el('backendStatusSummary');
  if (!proj) return;
  const primaryAlias =
    (proj.aliases || []).find((a) => a.subdomain === proj.name) || (proj.aliases || [])[0] || null;
  const activeM =
    (primaryAlias && (proj.manifests || []).find((m) => m.id === primaryAlias.deploymentId)) ||
    (proj.manifests || [])[0] ||
    null;
  const latestWithB =
    (proj.manifests || []).find((m) => m.backend && m.backend.mode === 'scf-web') || null;
  const activeB = activeM?.backend?.mode === 'scf-web' ? activeM.backend : null;
  const b = activeB || latestWithB?.backend || null;

  if (!b) {
    box.innerHTML =
      '<div style="color:var(--muted);font-size:12.5px;">当前项目未启用腾讯云 SCF 全栈后端（纯静态或 Edge 函数模式）。如需启用可在项目目录执行 <code>myship backend enable</code>。</div>';
    return;
  }

  const activeVerLabel = activeB
    ? 'Version ' + esc(activeB.version || activeB.scfVersion || '$LATEST') + ' (' + esc(activeM.id) + ')'
    : '当前生产快照 (' + esc(activeM?.id || '-') + ') 未绑定 SCF';
  const latestVerLabel = latestWithB
    ? 'Version ' +
      esc(latestWithB.backend.version || latestWithB.backend.scfVersion || '$LATEST') +
      ' (' +
      esc(latestWithB.id) +
      ')'
    : activeVerLabel;
  const isRolledBack = Boolean(latestWithB && activeM && latestWithB.id !== activeM.id);
  const runtimeLabel = esc(b.runtime || 'Nodejs20.19');

  box.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;">' +
    '<div><div style="font-size:11px;color:var(--muted);">SCF 函数名</div><div class="mono" style="font-weight:600;">' +
    esc(b.functionName || 'myship-' + proj.name) +
    '</div></div>' +
    '<div><div style="font-size:11px;color:var(--muted);">当前生产生效版本</div><div class="mono" style="font-weight:600;color:var(--green);">' +
    activeVerLabel +
    (isRolledBack ? ' <span class="badge badge-amber">已回滚偏离</span>' : '') +
    '</div></div>' +
    '<div><div style="font-size:11px;color:var(--muted);">最新构建对应版本</div><div class="mono">' +
    latestVerLabel +
    '</div></div>' +
    '<div><div style="font-size:11px;color:var(--muted);">地域 / 运行时 / 转发前缀</div><div class="mono">' +
    esc(b.region || 'ap-guangzhou') +
    ' · ' +
    runtimeLabel +
    ' · ' +
    esc(b.prefix || '/api') +
    '/*</div></div>' +
    '</div>';
}

async function loadLogs() {
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  const limit = el('logsLimitSelect').value || '50';
  const errorsOnly = el('logsErrorsOnlyCheck').checked ? '1' : '0';
  const container = el('logsContainer');
  const summary = el('logsSummaryText');

  summary.textContent = '正在拉取日志...';
  container.innerHTML =
    '<div class="empty-state">正在读取 ' + esc(myProj) + ' 的运行日志...</div>';

  try {
    const data = await apiFetch(
      '/api/console/logs?project=' +
        encodeURIComponent(myProj) +
        '&limit=' +
        encodeURIComponent(limit) +
        '&errorsOnly=' +
        errorsOnly
    );
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;

    const logs = data.logs || [];
    const nowStr = formatTime(new Date().toISOString()).split(' ')[1] || '';
    summary.textContent =
      '函数 ' +
      (data.functionName || '-') +
      ' · 显示最近 ' +
      logs.length +
      ' 条 · 更新于 ' +
      nowStr;

    if (logs.length === 0) {
      container.innerHTML =
        '<div class="empty-state">' +
        (errorsOnly === '1' ? '最近无错误日志记录' : '暂无请求或云函数日志记录') +
        '</div>';
      return;
    }

    container.innerHTML = logs
      .map((item) => {
        const isErr =
          item.level === 'ERROR' ||
          (item.status && item.status >= 400) ||
          Boolean(item.error) ||
          (item.retCode !== undefined && item.retCode !== 0);
        const badgeHtml = isErr
          ? '<span class="badge badge-red">ERROR' +
            (item.status ? ' ' + esc(item.status) : '') +
            '</span>'
          : '<span class="badge badge-green">' +
            esc(item.level || 'OK') +
            (item.status ? ' ' + esc(item.status) : '') +
            '</span>';
        const routeTitle =
          item.method || item.path
            ? (item.method ? item.method + ' ' : '') + (item.path || '/')
            : item.source || item.requestId || 'request';
        const lineText = Array.isArray(item.lines)
          ? item.lines
              .map((l) => (l && typeof l === 'object' ? '[' + (l.level || 'LOG') + '] ' + (l.text ?? '') : String(l)))
              .join('\n')
          : item.message || '';
        const bodyText = [item.error ? '错误: ' + item.error : '', lineText]
          .filter(Boolean)
          .join('\n');
        return (
          '<div class="log-entry">' +
          '<div class="log-entry-head">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          badgeHtml +
          '<span class="mono" style="font-weight:600;">' +
          esc(routeTitle) +
          '</span>' +
          (item.durationMs !== undefined
            ? '<span class="mono" style="color:var(--muted);">' + esc(item.durationMs) + ' ms</span>'
            : '') +
          (item.scfVersion
            ? '<span class="badge badge-muted mono">v' + esc(item.scfVersion) + '</span>'
            : '') +
          (item.requestId
            ? '<span class="mono" style="color:var(--muted);font-size:11px;">ReqId: ' +
              esc(item.requestId) +
              '</span>'
            : '') +
          '</div>' +
          '<span class="mono" style="color:var(--muted);font-size:11.5px;">' +
          esc(formatTime(item.timestamp || item.startTime || '')) +
          '</span>' +
          '</div>' +
          (bodyText ? '<div class="log-msg mono">' + esc(bodyText) + '</div>' : '') +
          (item.stack
            ? '<details style="margin-top:6px;"><summary style="cursor:pointer;color:var(--red);font-size:11.5px;">展开错误堆栈 (SourceMap 已映射)</summary><pre class="code-viewer mono" style="margin-top:6px;color:var(--red);">' +
              esc(item.stack) +
              '</pre></details>'
            : '') +
          '</div>'
        );
      })
      .join('');
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    summary.textContent = '拉取失败';
    container.innerHTML =
      '<div class="empty-state" style="color:var(--red);">日志读取失败: ' +
      esc(err.message) +
      '</div>';
  }
}

// 11. 「数据与存储 (Data)」视图：数据库表预览 / KV JSON 查看器 / 对象文件
function switchDataSubtab(tab) {
  activeDataSubtab = tab;
  el('dataSubtabDb').classList.toggle('active', tab === 'db');
  el('dataSubtabKv').classList.toggle('active', tab === 'kv');
  el('dataSubtabFiles').classList.toggle('active', tab === 'files');
  el('dataPanelDb').style.display = tab === 'db' ? 'block' : 'none';
  el('dataPanelKv').style.display = tab === 'kv' ? 'block' : 'none';
  el('dataPanelFiles').style.display = tab === 'files' ? 'block' : 'none';
}

async function loadResources() {
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  try {
    const data = await apiFetch('/api/console/resources?project=' + encodeURIComponent(myProj));
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    currentResourcesData = data;

    const kvCount = (data.storage?.dataKeys || []).length;
    const fileCount = (data.storage?.fileKeys || []).length;
    el('navCountData').textContent = kvCount + fileCount;

    const dbLabel = data.db?.provider
      ? data.db.provider + ' (' + (data.db.targetSummary || '') + ')'
      : '未绑定云数据库';
    el('resourcesMetaBar').textContent =
      '引擎: ' + dbLabel + ' · KV 键: ' + kvCount + ' · 文件: ' + fileCount;
    el('filesPrefixLabel').textContent = '存储前缀: ' + (data.storage?.filesPrefix || '');

    renderKvKeysList();
    renderFilesTable();
    await loadDbPreview(selectedDbTable);
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    showToast('加载数据资源失败: ' + err.message, true);
  }
}

async function loadDbPreview(tableName = null) {
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  const listEl = el('dbTablesList');
  const mainEl = el('dbPreviewMain');

  try {
    let url = '/api/console/db-preview?project=' + encodeURIComponent(myProj) + '&limit=50';
    if (tableName) url += '&table=' + encodeURIComponent(tableName);
    const data = await apiFetch(url);
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;

    const tables = data.tables || [];
    selectedDbTable = data.selectedTable || null;
    el('dbTablesCount').textContent = tables.length;

    if (!data.configured) {
      listEl.innerHTML =
        '<div style="padding:10px;font-size:12px;color:var(--muted);">未配置数据库</div>';
      mainEl.innerHTML =
        '<div class="empty-state">' +
        '<div style="font-weight:600;color:var(--text);margin-bottom:6px;">当前项目尚未配置云端数据库</div>' +
        '<div>可在终端执行 <code>myship use db --provider &lt;turso|d1|neon|pg|mysql&gt;</code> 绑定数据库后在此预览表与记录。</div>' +
        '</div>';
      return;
    }

    if (tables.length === 0) {
      listEl.innerHTML =
        '<div style="padding:10px;font-size:12px;color:var(--muted);">暂无数据表</div>';
      mainEl.innerHTML =
        '<div class="empty-state">当前数据库 (' +
        esc(data.provider) +
        ') 中尚无已创建的表。</div>';
      return;
    }

    listEl.innerHTML = tables
      .map(
        (t) =>
          '<div class="explorer-item mono ' +
          (t === selectedDbTable ? 'active' : '') +
          '" onclick="loadDbPreview(\'' +
          esc(t) +
          '\')">' +
          '<span>' +
          esc(t) +
          '</span>' +
          '</div>'
      )
      .join('');

    const cols = data.columns || [];
    const rows = data.rows || [];
    mainEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
      '<div><strong class="mono" style="font-size:13.5px;">' +
      esc(selectedDbTable) +
      '</strong> <span class="badge badge-blue">' +
      esc(data.provider) +
      '</span> <span style="font-size:12px;color:var(--muted);">显示前 ' +
      rows.length +
      ' 行 (只读预览)</span></div>' +
      '<button class="btn btn-sm" onclick="loadDbPreview(\'' +
      esc(selectedDbTable) +
      '\')">刷新表数据</button>' +
      '</div>' +
      (cols.length === 0
        ? '<div class="empty-state">表中暂无数据记录</div>'
        : '<div class="table-wrap" style="border:1px solid var(--border);border-radius:6px;"><table><thead><tr>' +
          cols.map((c) => '<th class="mono">' + esc(c) + '</th>').join('') +
          '</tr></thead><tbody>' +
          (rows.length > 0
            ? rows
                .map(
                  (r) =>
                    '<tr>' +
                    cols
                      .map((c) => {
                        const val = r[c];
                        const disp =
                          val === null || val === undefined
                            ? '<span style="color:var(--muted);">NULL</span>'
                            : typeof val === 'object'
                            ? esc(JSON.stringify(val))
                            : esc(String(val));
                        return (
                          '<td class="mono" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                          disp +
                          '</td>'
                        );
                      })
                      .join('') +
                    '</tr>'
                )
                .join('')
            : '<tr><td colspan="' +
              cols.length +
              '" class="empty-state">表中共有 0 行记录</td></tr>') +
          '</tbody></table></div>');
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    mainEl.innerHTML =
      '<div class="empty-state" style="color:var(--red);">读取数据库预览失败: ' +
      esc(err.message) +
      '</div>';
  }
}

function renderKvKeysList() {
  const allKeys = currentResourcesData?.storage?.dataKeys || [];
  const q = String(el('kvSearchInput').value || '').trim().toLowerCase();
  const filtered = allKeys.filter((k) => !q || k.toLowerCase().includes(q));
  const listEl = el('kvKeysList');

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--muted);">无 KV 键</div>';
    if (allKeys.length === 0) {
      el('kvPreviewMain').innerHTML =
        '<div class="empty-state">当前项目暂无 context.storage 键值数据</div>';
    }
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (k) =>
        '<div class="explorer-item mono ' +
        (k === selectedKvKey ? 'active' : '') +
        '" onclick="loadKvValue(\'' +
        esc(k) +
        '\')">' +
        '<span>' +
        esc(k) +
        '</span>' +
        '</div>'
    )
    .join('');

  if (!selectedKvKey || !allKeys.includes(selectedKvKey)) {
    loadKvValue(filtered[0]);
  }
}

async function loadKvValue(key) {
  if (!key) return;
  selectedKvKey = key;
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  const mainEl = el('kvPreviewMain');
  renderKvKeysList();
  mainEl.innerHTML = '<div class="empty-state">正在读取 ' + esc(key) + '...</div>';

  try {
    const data = await apiFetch(
      '/api/console/kv?project=' + encodeURIComponent(myProj) + '&key=' + encodeURIComponent(key)
    );
    if (myEpoch !== requestEpoch || myProj !== selectedProject || selectedKvKey !== key) return;

    mainEl.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:8px;flex-wrap:wrap;">' +
      '<div>' +
      '<strong class="mono" style="font-size:13.5px;">' +
      esc(data.key) +
      '.json</strong> ' +
      '<span class="badge badge-muted">' +
      formatBytes(data.rawSize) +
      '</span>' +
      (data.updatedAt
        ? ' <span style="font-size:11.5px;color:var(--muted);">更新于 ' +
          esc(formatTime(data.updatedAt)) +
          '</span>'
        : '') +
      (data.truncated ? ' <span class="badge badge-amber">已截断预览 (256 KB)</span>' : '') +
      '</div>' +
      '<button class="btn btn-sm" onclick="copyCurrentKvFormatted()">复制 JSON</button>' +
      '</div>' +
      '<pre class="code-viewer mono" id="kvFormattedPre">' +
      esc(data.formatted) +
      '</pre>';
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    mainEl.innerHTML =
      '<div class="empty-state" style="color:var(--red);">读取 KV 失败: ' +
      esc(err.message) +
      '</div>';
  }
}

function copyCurrentKvFormatted() {
  const pre = document.getElementById('kvFormattedPre');
  if (pre) copyText(pre.textContent || '', ' JSON 内容');
}

function renderFilesTable() {
  const allFiles = currentResourcesData?.storage?.fileKeys || [];
  const q = String(el('filesSearchInput').value || '').trim().toLowerCase();
  const filtered = allFiles.filter((k) => !q || k.toLowerCase().includes(q));
  const tbody = el('filesTableBody');

  if (filtered.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="2" class="empty-state">' +
      (allFiles.length === 0 ? '当前项目暂无 context.files 对象存储文件' : '无匹配文件') +
      '</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(
      (k) =>
        '<tr>' +
        '<td class="mono">' +
        esc(k) +
        '</td>' +
        '<td>' +
        '<div class="row-actions">' +
        '<button class="btn btn-sm" onclick="presignFile(\'' +
        esc(k) +
        '\', true)">新窗口预览 ↗</button>' +
        '<button class="btn btn-sm" onclick="presignFile(\'' +
        esc(k) +
        '\', false)">复制临时链接</button>' +
        '</div>' +
        '</td>' +
        '</tr>'
    )
    .join('');
}

async function presignFile(key, openNewTab = false) {
  try {
    const data = await apiFetch(
      '/api/console/file-presign?project=' +
        encodeURIComponent(selectedProject) +
        '&key=' +
        encodeURIComponent(key)
    );
    if (openNewTab && typeof window !== 'undefined' && window.open) {
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } else {
      await copyText(data.url, ' 15 分钟有效期的文件链接');
    }
  } catch (err) {
    showToast('生成文件链接失败: ' + err.message, true);
  }
}

// 12. 「环境变量与设置 (Settings)」视图
async function loadEnvVars() {
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  const revealAll = el('envRevealCheck').checked;
  const tbody = el('envTableBody');

  try {
    const data = await apiFetch(
      '/api/console/env?project=' + encodeURIComponent(myProj) + (revealAll ? '&reveal=1' : '')
    );
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;

    currentEnvVarsMap = data.vars || {};
    const keys = Object.keys(currentEnvVarsMap);
    el('envCountBadge').textContent = keys.length;
    el('navCountEnv').textContent = keys.length;

    renderEnvTable();
    previewBatchEnv();
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    tbody.innerHTML =
      '<tr><td colspan="3" class="empty-state" style="color:var(--red);">读取环境变量失败: ' +
      esc(err.message) +
      '</td></tr>';
  }
}

function renderEnvTable() {
  const keys = Object.keys(currentEnvVarsMap).sort();
  const revealAll = el('envRevealCheck').checked;
  const tbody = el('envTableBody');

  if (keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">当前项目尚未配置环境变量</td></tr>';
    return;
  }

  tbody.innerHTML = keys
    .map((k) => {
      const isRevealed = revealAll || revealedEnvKeys.has(k);
      const val = currentEnvVarsMap[k];
      return (
        '<tr>' +
        '<td class="mono" style="font-weight:600;">' +
        esc(k) +
        '</td>' +
        '<td class="mono" style="word-break:break-all;color:' +
        (isRevealed ? 'var(--text)' : 'var(--muted)') +
        ';">' +
        esc(val) +
        '</td>' +
        '<td>' +
        '<div class="row-actions">' +
        (!revealAll
          ? '<button class="btn btn-sm" onclick="toggleSingleEnvReveal(\'' +
            esc(k) +
            '\')">' +
            (isRevealed ? '隐藏' : '显示') +
            '</button>'
          : '') +
        '<button class="btn btn-sm" onclick="startEditEnv(\'' +
        esc(k) +
        '\')">编辑</button>' +
        '<button class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="promptDeleteEnv(\'' +
        esc(k) +
        '\')">删除</button>' +
        '</div>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
}

async function toggleSingleEnvReveal(key) {
  if (revealedEnvKeys.has(key)) {
    revealedEnvKeys.delete(key);
    await loadEnvVars();
    return;
  }
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  try {
    const data = await apiFetch(
      '/api/console/env?project=' +
        encodeURIComponent(myProj) +
        '&key=' +
        encodeURIComponent(key) +
        '&reveal=1'
    );
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    if (data.exists) {
      revealedEnvKeys.add(key);
      currentEnvVarsMap[key] = data.value;
      renderEnvTable();
    }
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    showToast('读取变量明文失败: ' + err.message, true);
  }
}

async function startEditEnv(key) {
  const myEpoch = requestEpoch;
  const myProj = selectedProject;
  try {
    const data = await apiFetch(
      '/api/console/env?project=' +
        encodeURIComponent(myProj) +
        '&key=' +
        encodeURIComponent(key) +
        '&reveal=1'
    );
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    editingEnvKey = key;
    el('envFormModeLabel').textContent = '正在编辑变量:';
    const keyInput = el('envKeyInput');
    keyInput.value = key;
    keyInput.disabled = true;
    const valInput = el('envValInput');
    valInput.value = data.value ?? '';
    if (valInput.focus) valInput.focus();
    el('envSaveBtn').textContent = '保存修改';
    el('envCancelEditBtn').style.display = 'inline-flex';
  } catch (err) {
    if (myEpoch !== requestEpoch || myProj !== selectedProject) return;
    showToast('加载变量值失败: ' + err.message, true);
  }
}

function cancelEditEnv() {
  editingEnvKey = null;
  el('envFormModeLabel').textContent = '新增或更新:';
  const keyInput = el('envKeyInput');
  keyInput.value = '';
  keyInput.disabled = false;
  el('envValInput').value = '';
  el('envSaveBtn').textContent = '保存变量';
  el('envCancelEditBtn').style.display = 'none';
}

async function saveSingleEnv() {
  const key = String(el('envKeyInput').value || '').trim();
  const value = String(el('envValInput').value ?? '');
  if (!key) {
    showToast('请输入变量名 KEY', true);
    return;
  }
  try {
    const data = await apiFetch('/api/console/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: selectedProject,
        action: 'set',
        key,
        value,
      }),
    });
    cancelEditEnv();
    showToast('已保存变量 ' + key + '（当前共 ' + (data.totalCount ?? data.count) + ' 项）');
    await loadEnvVars();
  } catch (err) {
    showToast(err.message, true);
  }
}

function toggleBatchEnvBox(forceState) {
  const box = el('batchEnvBox');
  const next = forceState !== undefined ? forceState : box.style.display === 'none';
  box.style.display = next ? 'block' : 'none';
  if (next) previewBatchEnv();
}

function previewBatchEnv() {
  const raw = String(el('envBatchTextarea').value || '');
  const summaryEl = el('envBatchPreviewSummary');
  if (!raw.trim()) {
    summaryEl.textContent = '';
    return;
  }
  const lines = raw.split(/\r?\n/);
  let addCount = 0;
  let updateCount = 0;
  const seen = new Set();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) {
      const k = m[1];
      if (seen.has(k)) continue;
      seen.add(k);
      if (Object.prototype.hasOwnProperty.call(currentEnvVarsMap, k)) {
        updateCount++;
      } else {
        addCount++;
      }
    }
  }
  summaryEl.innerHTML =
    '预检结果: <span class="badge badge-green">新增 ' +
    addCount +
    ' 项</span> <span class="badge badge-amber">覆盖 ' +
    updateCount +
    ' 项</span>';
}

async function saveBatchEnv() {
  const rawContent = String(el('envBatchTextarea').value || '').trim();
  if (!rawContent) {
    showToast('请粘贴要导入的 .env 内容', true);
    return;
  }
  try {
    const data = await apiFetch('/api/console/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: selectedProject,
        action: 'set-batch',
        rawContent,
      }),
    });
    el('envBatchTextarea').value = '';
    toggleBatchEnvBox(false);
    showToast(
      '成功导入 ' +
        (data.importedCount ?? 0) +
        ' 项变量（项目当前共 ' +
        (data.totalCount ?? data.count) +
        ' 项）'
    );
    await loadEnvVars();
  } catch (err) {
    showToast(err.message, true);
  }
}

function promptDeleteEnv(key) {
  openModal({
    title: '删除环境变量',
    descHtml:
      '确定要从项目 <code>' +
      esc(selectedProject) +
      '</code> 中删除环境变量 <code>' +
      esc(key) +
      '</code> 吗？',
    confirmText: '确认删除',
    confirmClass: 'btn btn-danger',
    onConfirm: async () => {
      await apiFetch('/api/console/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject,
          action: 'rm',
          key,
        }),
      });
      revealedEnvKeys.delete(key);
      if (editingEnvKey === key) cancelEditEnv();
      showToast('已删除环境变量 ' + key);
      await loadEnvVars();
    },
  });
}

// 13. 项目销毁 (Dry-Run 预检 + 输入项目名二次确认)
async function openPurgeProjectModal() {
  const projName = selectedProject;
  try {
    const dryData = await apiFetch('/api/console/rm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'project',
        project: projName,
        dryRun: true,
      }),
    });
    const r = dryData.result || {};
    openModal({
      title: '彻底销毁项目 ' + projName,
      descHtml:
        '<div style="margin-bottom:8px;">此操作不可撤销！预检扫描将清理以下资源：</div>' +
        '<ul style="padding-left:18px;font-size:12px;color:var(--text-secondary);line-height:1.7;">' +
        '<li>解绑并移除域名入口: <strong>' +
        (r.removedAliases?.length || 0) +
        '</strong> 个</li>' +
        '<li>删除构建版本快照: <strong>' +
        (r.removedManifests?.length || 0) +
        '</strong> 个</li>' +
        '<li>回收独占 CAS 文件块: <strong>' +
        (r.removedBlobsCount || 0) +
        '</strong> 个</li>' +
        '<li>清空项目环境变量配置: <strong>' +
        (r.removedEnv ? '是' : '无') +
        '</strong></li>' +
        '</ul>',
      formHtml:
        '<div style="margin-top:8px;">' +
        '<label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;">请输入项目名 <code>' +
        esc(projName) +
        '</code> 以确认销毁：</label>' +
        '<input type="text" class="input mono" id="purgeConfirmInput" style="width:100%;" placeholder="' +
        esc(projName) +
        '" />' +
        '</div>',
      confirmText: '确认彻底销毁项目',
      confirmClass: 'btn btn-danger',
      onConfirm: async () => {
        const typed = String(el('purgeConfirmInput').value || '').trim();
        if (typed !== projName) {
          throw new Error('输入的项目名称不匹配，请输入 ' + projName);
        }
        await apiFetch('/api/console/rm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'project',
            project: projName,
            dryRun: false,
          }),
        });
        showToast('项目 ' + projName + ' 已彻底销毁');
        await refreshAll();
      },
    });
  } catch (err) {
    showToast('销毁预检失败: ' + err.message, true);
  }
}

// 14. 全局存储清理 (Global GC)
function onGcOlderThanChange() {
  const olderThan = document.getElementById('gcOlderThanSelect').value;
  const keepInput = document.getElementById('gcKeepInput');
  if (olderThan) {
    keepInput.disabled = true;
    keepInput.style.opacity = '0.5';
    keepInput.title = '按时间清理模式下不限制保留条数（仅清理早于指定时间的非活跃快照）';
  } else {
    keepInput.disabled = false;
    keepInput.style.opacity = '1';
    keepInput.title = '';
  }
}

async function runGc(dryRun = true) {
  const olderThan = document.getElementById('gcOlderThanSelect').value || null;
      const keepCount = olderThan
        ? 'all'
        : Number.parseInt(document.getElementById('gcKeepInput').value, 10) || 10;
  const box = document.getElementById('gcResultBox');
  box.textContent = dryRun ? '正在扫描全局可回收资源...' : '正在执行垃圾回收...';

  try {
    const res = await fetch('/api/console/gc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MyShip-Console': '1',
      },
      body: JSON.stringify({ keepCount, olderThan, dryRun }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'GC 失败');

    const p = data.plan;
    lastGcDryRunPlan = p;
    const expiredList = p.expiredManifests || [];

    box.innerHTML =
      '<div style="padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg);">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">' +
      '<span style="font-weight:600;">' +
      (dryRun ? '预检扫描完成（尚未实际删除）' : '全局垃圾回收执行完毕') +
      '</span>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      '<span class="badge badge-amber">待回收快照: ' +
      p.expiredManifestsCount +
      '</span>' +
      '<span class="badge badge-blue">孤儿文件块: ' +
      p.orphanBlobsCount +
      '</span>' +
      '<span class="badge badge-purple">孤儿函数包: ' +
      p.orphanFnsCount +
      '</span>' +
      '<span class="badge badge-green">受保护线上路由: ' +
      (p.activeRoutes || []).length +
      '</span>' +
      '</div>' +
      '</div>' +
      (expiredList.length > 0
        ? '<div class="table-wrap" style="max-height:220px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:6px;">' +
          '<table><thead><tr><th>构建版本 ID</th><th>所属项目</th><th>发布时间</th></tr></thead><tbody>' +
          expiredList
            .map(
              (item) =>
                '<tr><td class="mono">' +
                esc(item.id) +
                '</td><td class="mono">' +
                esc(item.project || '-') +
                '</td><td class="mono" style="color:var(--muted);">' +
                esc(formatTime(item.createdAt)) +
                '</td></tr>'
            )
            .join('') +
          '</tbody></table></div>'
        : '<div style="font-size:12px;color:var(--muted);">当前没有符合条件的过期快照需要清理。</div>') +
      '</div>';

    showToast(dryRun ? 'GC 预检扫描完成' : 'GC 清理完成');
    if (!dryRun) await refreshAll();
  } catch (err) {
    box.textContent = 'GC 错误: ' + err.message;
    showToast(err.message, true);
  }
}

function confirmExecuteGc() {
  const countInfo = lastGcDryRunPlan
    ? '（预计清理 <strong>' +
      lastGcDryRunPlan.expiredManifestsCount +
      '</strong> 个过期快照与 <strong>' +
      lastGcDryRunPlan.orphanBlobsCount +
      '</strong> 个孤儿文件块）'
    : '';
  openModal({
    title: '确认执行全局存储清理 (GC)',
    descHtml:
      '即将对全局所有项目执行存储垃圾回收' +
      countInfo +
      '。所有当前被域名指向的版本及上一回滚候选版本均受保护不会被删除。确认继续吗？',
    confirmText: '确认执行清理',
    confirmClass: 'btn btn-danger',
    onConfirm: async () => {
      await runGc(false);
    },
  });
}

// 初始化启动
initTheme();
restoreFromUrlHash();
refreshAll();
