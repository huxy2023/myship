// ============================================================================
// MyShip Web 可视化管控台单页应用 (Zero-Dependency Single-Page Console UI)
// 仅运行于本机 127.0.0.1，通过同源 JSON API (带 X-MyShip-Console 防 CSRF 头) 管控云端/沙盒
// ============================================================================

export function renderConsoleHtml({ modeLabel = '腾讯云 COS + EdgeOne', defaultProject = 'default' } = {}) {
  const safeMode = String(modeLabel).replace(/[<>&"]/g, '');
  const safeProj = String(defaultProject).replace(/[<>&"]/g, '');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyShip Console — 可视化部署与切流管控台</title>
  <style>
    :root {
      --bg: #0b0f19;
      --panel: #111827;
      --panel-alt: #1e293b;
      --border: #26334d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 24px;
      background: rgba(17, 24, 39, 0.92);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 20;
      backdrop-filter: blur(8px);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 700;
      font-size: 16px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: var(--panel-alt);
      color: var(--accent);
      border: 1px solid var(--border);
    }
    .badge.success { color: var(--success); border-color: rgba(16, 185, 129, 0.35); }
    .badge.warn { color: var(--warn); border-color: rgba(245, 158, 11, 0.35); }
    .badge.danger { color: var(--danger); border-color: rgba(239, 68, 68, 0.35); }
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: calc(100vh - 57px);
    }
    aside {
      border-right: 1px solid var(--border);
      background: var(--panel);
      padding: 16px;
    }
    .side-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 4px 0 10px;
      font-weight: 600;
    }
    .proj-list {
      list-style: none;
      padding: 0;
      margin: 0 0 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .proj-btn {
      width: 100%;
      text-align: left;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text);
      padding: 8px 10px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
    }
    .proj-btn:hover { background: rgba(56, 189, 248, 0.08); }
    .proj-btn.active {
      background: rgba(56, 189, 248, 0.14);
      border-color: rgba(56, 189, 248, 0.45);
      color: #fff;
      font-weight: 600;
    }
    main {
      padding: 20px 28px 48px;
      max-width: 1360px;
      width: 100%;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .stat-label { color: var(--muted); font-size: 12px; }
    .stat-val { font-size: 22px; font-weight: 700; margin-top: 4px; font-family: var(--mono); }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      margin-bottom: 18px;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .card-title { font-size: 15px; font-weight: 600; margin: 0; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 10px 10px;
      border-bottom: 1px solid rgba(38, 51, 77, 0.65);
      vertical-align: middle;
    }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    code, .mono {
      font-family: var(--mono);
      font-size: 12px;
      background: rgba(15, 23, 42, 0.75);
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid rgba(51, 65, 85, 0.6);
    }
    button, .btn {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: 0.15s;
    }
    button:hover { border-color: var(--accent); color: #fff; }
    button.primary {
      background: var(--accent);
      color: #082f49;
      border-color: var(--accent);
      font-weight: 600;
    }
    button.primary:hover { background: #7dd3fc; }
    button.danger {
      border-color: rgba(239, 68, 68, 0.45);
      color: #fca5a5;
    }
    button.danger:hover { background: rgba(239, 68, 68, 0.15); }
    input, select {
      background: #0f172a;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 13px;
    }
    .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 24px;
      background: #0f172a;
      border: 1px solid var(--accent);
      color: var(--text);
      padding: 10px 16px;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.45);
      display: none;
      z-index: 100;
      max-width: 460px;
    }
    .diff-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }
    .diff-list {
      max-height: 280px;
      overflow-y: auto;
      background: #090d16;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 12px;
    }
    .diff-item { padding: 4px 0; border-bottom: 1px dashed rgba(38, 51, 77, 0.5); }
    .diff-item:last-child { border-bottom: none; }
    .c-add { color: #34d399; }
    .c-mod { color: #fbbf24; }
    .c-del { color: #f87171; }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      aside { border-right: none; border-bottom: 1px solid var(--border); }
      .diff-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>🚀 MyShip Console</span>
      <span class="badge" id="modeBadge">${safeMode}</span>
      <span class="badge success" id="domainBadge">加载中...</span>
    </div>
    <div class="row-actions">
      <button onclick="refreshAll()">🔄 刷新实时状态</button>
    </div>
  </header>

  <div class="layout">
    <aside>
      <div class="side-title">项目命名空间 (Projects)</div>
      <ul class="proj-list" id="projectList"></ul>
      <div style="margin-bottom: 20px;">
        <button class="danger" style="width:100%;" onclick="purgeCurrentProject()">🗑️ 彻底销毁当前选中项目</button>
      </div>

      <div class="side-title">全局 CAS 垃圾回收 (GC)</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        <label style="font-size:12px; color:var(--muted); display:flex; justify-content:space-between; align-items:center;">
          <span>每项目保留版本数:</span>
          <input type="number" id="gcKeepInput" value="10" min="2" style="width:68px;" />
        </label>
        <label style="font-size:12px; color:var(--muted); display:flex; justify-content:space-between; align-items:center;">
          <span>按时间淘汰旧版:</span>
          <select id="gcOlderThanSelect" style="width:110px;" onchange="onGcOlderThanChange()">
            <option value="">不限时间</option>
            <option value="1d">1 天前 (1d)</option>
            <option value="7d">7 天前 (7d)</option>
            <option value="30d">30 天前 (30d)</option>
          </select>
        </label>
        <button onclick="runGc(true)">🔍 GC 扫描预检 (Dry-Run)</button>
        <button class="danger" onclick="runGc(false)">🧹 立即清理过期块与释放配额</button>
        <div id="gcResultBox" style="font-size:12px; color:var(--muted);"></div>
      </div>
    </aside>

    <main>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">当前选中项目</div>
          <div class="stat-val" id="statProject">${safeProj}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">项目历史构建数</div>
          <div class="stat-val" id="statManifests">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">项目活跃子域名指针</div>
          <div class="stat-val" id="statAliases">-</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">全局 CAS 唯一静态块</div>
          <div class="stat-val" id="statBlobs">-</div>
        </div>
      </div>

      <!-- 1. 活跃域名路由指针 (Aliases) -->
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">🌐 活跃子域名路由指针 (aliases/*.json)</h2>
          <div class="row-actions">
            <input type="text" id="customSubInput" placeholder="环境后缀 (如 staging / prod)" style="width:180px;" />
            <select id="customDplSelect"></select>
            <button class="primary" onclick="bindCustomAlias()">⚡ 0 秒绑定/切流</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>子域名访问地址</th>
              <th>当前指向快照 (Deployment)</th>
              <th>最后更新时间</th>
              <th>快捷操作</th>
            </tr>
          </thead>
          <tbody id="aliasesTableBody"></tbody>
        </table>
      </div>

      <!-- 2. 历史构建快照列表 (Manifests) -->
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">📦 历史构建版本快照 (manifests/*.json)</h2>
          <span style="font-size:12px; color:var(--muted);">点击「切流到主域名」可 0 秒将项目主域名切向任意版本</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>版本 ID</th>
              <th>不可变快照预览域名</th>
              <th>静态文件 / CAS 复用</th>
              <th>Serverless 云函数路由</th>
              <th>构建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="manifestsTableBody"></tbody>
        </table>
      </div>

      <!-- 3. 双版本可视化对比 (Manifest Diff) -->
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">🔍 两版本文件与云函数差异对比 (Snapshot Diff)</h2>
          <div class="row-actions">
            <label style="font-size:12px; color:var(--muted);">基准版本 (Base):</label>
            <select id="diffBaseSelect"></select>
            <label style="font-size:12px; color:var(--muted);">对比目标 (Target):</label>
            <select id="diffTargetSelect"></select>
            <button class="primary" onclick="compareSelectedManifests()">对比差异</button>
          </div>
        </div>
        <div id="diffSummaryBar" style="font-size:13px; color:var(--muted);">请选择两个版本进行对比。</div>
        <div class="diff-grid" id="diffGrid" style="display:none;">
          <div>
            <div style="font-weight:600; margin-bottom:6px;">📄 静态文件变更 (Files Diff)</div>
            <div class="diff-list" id="diffFilesList"></div>
          </div>
          <div>
            <div style="font-weight:600; margin-bottom:6px;">⚡ Serverless 云函数变更 (Functions Diff)</div>
            <div class="diff-list" id="diffFnsList"></div>
          </div>
        </div>
      </div>

      <!-- 4. 项目环境变量管理 (Project Envs) -->
      <div class="card">
        <div class="card-header">
          <h2 class="card-title">🔐 项目云函数环境变量 (envs/&lt;project&gt;.json)</h2>
          <div class="row-actions">
            <button id="toggleRevealBtn" onclick="toggleEnvReveal()">👁️ 显示明文</button>
            <input type="text" id="envKeyInput" placeholder="KEY (如 API_SECRET)" style="width:160px;" />
            <input type="text" id="envValInput" placeholder="VALUE" style="width:200px;" />
            <button class="primary" onclick="saveEnvPair()">➕ 保存并热更新边缘函数</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>变量名 (Key)</th>
              <th>变量值 (Value)</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="envTableBody"></tbody>
        </table>
      </div>
    </main>
  </div>

  <div class="toast" id="toastBox"></div>

  <script>
    let globalState = null;
    let currentProject = ${JSON.stringify(safeProj)};
    let envReveal = false;
    let envReqSeq = 0;
    let diffReqSeq = 0;

    function showToast(msg, isError = false) {
      const el = document.getElementById('toastBox');
      el.textContent = msg;
      el.style.borderColor = isError ? 'var(--danger)' : 'var(--accent)';
      el.style.display = 'block';
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
    }

    function escapeHtml(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    async function apiFetch(path, options = {}) {
      const headers = Object.assign({ 'X-MyShip-Console': '1' }, options.headers || {});
      if (options.body && typeof options.body === 'object') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }
      const res = await fetch(path, Object.assign({}, options, { headers }));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || ('HTTP ' + res.status));
      }
      return data;
    }

    async function refreshAll() {
      try {
        const data = await apiFetch('/api/console/state');
        globalState = data;
        document.getElementById('modeBadge').textContent = data.modeLabel;
        document.getElementById('domainBadge').textContent = '*.' + data.domainSuffix;
        document.getElementById('statBlobs').textContent = data.blobsCount;

        const projects = data.projects || [];
        if (projects.length > 0 && !projects.some((p) => p.name === currentProject)) {
          currentProject = data.defaultProject && projects.some((p) => p.name === data.defaultProject)
            ? data.defaultProject
            : projects[0].name;
        }
        renderSidebar();
        renderProjectMain();
        await loadProjectEnvs();
      } catch (err) {
        showToast('加载状态失败: ' + err.message, true);
      }
    }

    function selectProject(proj) {
      currentProject = proj;
      document.getElementById('envTableBody').innerHTML =
        '<tr><td colspan="3" style="color:var(--muted);">正在加载环境变量...</td></tr>';
      renderSidebar();
      renderProjectMain();
      loadProjectEnvs();
    }

    function renderSidebar() {
      const ul = document.getElementById('projectList');
      const projects = (globalState && globalState.projects) || [];
      if (projects.length === 0) {
        ul.innerHTML = '<li style="color:var(--muted);font-size:12px;">暂无已发布项目</li>';
        return;
      }
      ul.innerHTML = projects.map((p) => {
        const active = p.name === currentProject ? 'active' : '';
        return '<li><button class="proj-btn ' + active + '" onclick="selectProject(' + JSON.stringify(p.name).replace(/"/g, '&quot;') + ')">' +
          '<span>📦 ' + escapeHtml(p.name) + '</span>' +
          '<span class="badge">' + p.manifests.length + '</span>' +
          '</button></li>';
      }).join('');
    }

    function renderProjectMain() {
      const projects = (globalState && globalState.projects) || [];
      const group = projects.find((p) => p.name === currentProject) || { name: currentProject, manifests: [], aliases: [] };
      const protocol = globalState ? globalState.protocol : 'https';
      const suffix = globalState ? globalState.domainSuffix : 'ship.example.com';

      document.getElementById('statProject').textContent = group.name;
      document.getElementById('statManifests').textContent = group.manifests.length;
      document.getElementById('statAliases').textContent = group.aliases.length;

      // 填充下拉选择框
      const dplOptions = group.manifests.map((m) =>
        '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.id) + ' (' + escapeHtml((m.createdAt || '').slice(0, 19).replace('T', ' ')) + ')</option>'
      ).join('');
      document.getElementById('customDplSelect').innerHTML = dplOptions || '<option value="">无可用版本</option>';
      document.getElementById('diffBaseSelect').innerHTML = dplOptions;
      document.getElementById('diffTargetSelect').innerHTML = dplOptions;
      if (group.manifests.length >= 2) {
        document.getElementById('diffTargetSelect').value = group.manifests[0].id;
        document.getElementById('diffBaseSelect').value = group.manifests[1].id;
      }

      // 渲染 Aliases 表格
      const aliasesBody = document.getElementById('aliasesTableBody');
      if (group.aliases.length === 0) {
        aliasesBody.innerHTML = '<tr><td colspan="4" style="color:var(--muted);">当前项目暂无可变子域名映射</td></tr>';
      } else {
        aliasesBody.innerHTML = group.aliases.map((a) => {
          const fullUrl = protocol + '://' + a.subdomain + '.' + suffix;
          return '<tr>' +
            '<td><a href="' + escapeHtml(fullUrl) + '" target="_blank" rel="noopener">' + escapeHtml(fullUrl) + ' ↗</a></td>' +
            '<td><code>' + escapeHtml(a.deploymentId) + '</code></td>' +
            '<td style="color:var(--muted);">' + escapeHtml((a.updatedAt || '').slice(0, 19).replace('T', ' ')) + '</td>' +
            '<td><div class="row-actions">' +
              '<button onclick="rollbackSubdomain(' + JSON.stringify(a.subdomain).replace(/"/g, '&quot;') + ', ' + JSON.stringify(group.name).replace(/"/g, '&quot;') + ')">⏪ 回滚上一版</button>' +
              '<button class="danger" onclick="unbindSubdomain(' + JSON.stringify(a.subdomain).replace(/"/g, '&quot;') + ', ' + JSON.stringify(group.name).replace(/"/g, '&quot;') + ')">🔌 解绑</button>' +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      // 渲染 Manifests 表格
      const manifestsBody = document.getElementById('manifestsTableBody');
      if (group.manifests.length === 0) {
        manifestsBody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);">当前项目尚无构建快照</td></tr>';
      } else {
        const prodAlias = group.aliases.find((a) => a.subdomain === group.name);
        const boundDplSet = new Set(group.aliases.map((a) => a.deploymentId));
        manifestsBody.innerHTML = group.manifests.map((m) => {
          const snapSub = m.immutableSubdomain || m.id.replace(/^dpl_/, 'dpl-');
          const snapUrl = protocol + '://' + snapSub + '.' + suffix;
          const isProd = prodAlias && prodAlias.deploymentId === m.id;
          const isBound = boundDplSet.has(m.id);
          const stats = m.stats || {};
          const fnEntries = Object.entries(m.functions || {});
          const fnBadges = fnEntries.length === 0
            ? '<span style="color:var(--muted);">纯静态</span>'
            : fnEntries.map(([r, info]) =>
                '<code>' + escapeHtml(r) + (info.runtime === 'scf-url' ? ' [SCF]' : '') + '</code>'
              ).join(' ');

          const delBtnHtml = isBound
            ? '<button disabled style="opacity:0.45;cursor:not-allowed;" title="该版本当前正绑定在活跃子域名上，请先切流或解绑子域名后再删除">🔒 线上服役中</button>'
            : '<button class="danger" onclick="deleteDeployment(' + JSON.stringify(m.id).replace(/"/g, '&quot;') + ', ' + JSON.stringify(group.name).replace(/"/g, '&quot;') + ')">🗑️ 删除</button>';

          return '<tr>' +
            '<td><code>' + escapeHtml(m.id) + '</code> ' + (isProd ? '<span class="badge success">生产主域当前版本</span>' : '') + '</td>' +
            '<td><a href="' + escapeHtml(snapUrl) + '" target="_blank" rel="noopener">' + escapeHtml(snapSub) + ' ↗</a></td>' +
            '<td>' + escapeHtml(stats.totalFiles ?? 0) + ' 个文件 <span style="color:var(--muted);">(新增 ' + escapeHtml(stats.uploadedBlobs ?? 0) + ', 复用 ' + escapeHtml(stats.reusedBlobs ?? 0) + ')</span></td>' +
            '<td>' + fnBadges + '</td>' +
            '<td style="color:var(--muted);">' + escapeHtml((m.createdAt || '').slice(0, 19).replace('T', ' ')) + '</td>' +
            '<td><div class="row-actions">' +
              '<button class="primary" onclick="promoteToProd(' + JSON.stringify(m.id).replace(/"/g, '&quot;') + ', ' + JSON.stringify(group.name).replace(/"/g, '&quot;') + ')">⚡ 切流到主域 (' + escapeHtml(group.name) + ')</button>' +
              delBtnHtml +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      if (group.manifests.length >= 2) {
        compareSelectedManifests();
      } else {
        document.getElementById('diffGrid').style.display = 'none';
        document.getElementById('diffSummaryBar').textContent = '当前项目版本不足 2 个，部署新版本后即可对比差异。';
      }
    }

    async function promoteToProd(deploymentId, targetProj = currentProject) {
      try {
        await apiFetch('/api/console/alias', {
          method: 'POST',
          body: { project: targetProj, subdomain: targetProj, deploymentId, raw: true },
        });
        showToast('✅ 已 0 秒将主域名 [' + targetProj + '] 切换至 ' + deploymentId);
        await refreshAll();
      } catch (err) {
        showToast('切流失败: ' + err.message, true);
      }
    }

    async function bindCustomAlias() {
      const subInput = document.getElementById('customSubInput').value.trim() || 'prod';
      const dplId = document.getElementById('customDplSelect').value;
      const targetProj = currentProject;
      if (!dplId) return showToast('请先选择目标版本', true);
      try {
        const res = await apiFetch('/api/console/alias', {
          method: 'POST',
          body: { project: targetProj, subdomain: subInput, deploymentId: dplId, raw: false },
        });
        showToast('✅ 子域名 [' + res.alias.subdomain + '] 已 0 秒指向 ' + dplId);
        document.getElementById('customSubInput').value = '';
        await refreshAll();
      } catch (err) {
        showToast('绑定失败: ' + err.message, true);
      }
    }

    async function rollbackSubdomain(subdomain, targetProj = currentProject) {
      try {
        const res = await apiFetch('/api/console/rollback', {
          method: 'POST',
          body: { project: targetProj, subdomain },
        });
        showToast('⏪ 已将 [' + subdomain + '] 秒级回滚至 ' + res.alias.deploymentId);
        await refreshAll();
      } catch (err) {
        showToast('回滚失败: ' + err.message, true);
      }
    }

    async function unbindSubdomain(subdomain, targetProj = currentProject) {
      if (!window.confirm('确认解绑并下线子域名 [' + subdomain + '] 吗？（底层历史构建快照仍会保留）')) return;
      try {
        await apiFetch('/api/console/rm', {
          method: 'POST',
          body: { type: 'alias', project: targetProj, subdomain, raw: true },
        });
        showToast('🔌 已解绑并移除子域名 [' + subdomain + ']');
        await refreshAll();
      } catch (err) {
        showToast('解绑失败: ' + err.message, true);
      }
    }

    async function deleteDeployment(deploymentId, targetProj = currentProject) {
      if (!window.confirm('确认永久删除构建版本 [' + deploymentId + '] 并回收其独占数据块吗？')) return;
      try {
        const res = await apiFetch('/api/console/rm', {
          method: 'POST',
          body: { type: 'deployment', project: targetProj, deploymentId },
        });
        showToast('🗑️ 已删除版本 [' + deploymentId + '] (回收 ' + res.result.orphanBlobsCount + ' 个独占静态块)');
        await refreshAll();
      } catch (err) {
        showToast('删除版本失败: ' + err.message, true);
      }
    }

    async function purgeCurrentProject() {
      const targetProj = currentProject;
      if (!targetProj) return;
      if (!window.confirm('⚠️ 高危操作确认：确定要彻底销毁项目 [' + targetProj + '] 吗？\\n这将删除该项目下所有子域名指针、所有历史构建版本、环境变量，并物理回收其独占存储块！')) return;
      try {
        const res = await apiFetch('/api/console/rm', {
          method: 'POST',
          body: { type: 'project', project: targetProj },
        });
        showToast('🗑️ 已彻底销毁项目 [' + targetProj + '] (清理 ' + res.result.removedManifests.length + ' 个快照, ' + res.result.removedAliases.length + ' 个域名)');
        await refreshAll();
      } catch (err) {
        showToast('销毁项目失败: ' + err.message, true);
      }
    }

    async function compareSelectedManifests() {
      const baseId = document.getElementById('diffBaseSelect').value;
      const targetId = document.getElementById('diffTargetSelect').value;
      if (!baseId || !targetId) return;
      const reqProj = currentProject;
      const reqSeq = ++diffReqSeq;
      try {
        const res = await apiFetch('/api/console/diff?base=' + encodeURIComponent(baseId) + '&target=' + encodeURIComponent(targetId));
        if (reqProj !== currentProject || reqSeq !== diffReqSeq) return;
        const d = res.diff;
        document.getElementById('diffSummaryBar').innerHTML =
          '对比基准 <code>' + escapeHtml(baseId) + '</code> ➜ 目标 <code>' + escapeHtml(targetId) + '</code>：' +
          '静态文件 [ <span class="c-add">+' + d.files.added.length + ' 新增</span> / ' +
          '<span class="c-mod">~' + d.files.modified.length + ' 修改</span> / ' +
          '<span class="c-del">-' + d.files.deleted.length + ' 删除</span> / ' +
          d.files.unchangedCount + ' 未变 ]，' +
          '云函数 [ <span class="c-add">+' + d.functions.added.length + '</span> / ' +
          '<span class="c-mod">~' + d.functions.modified.length + '</span> / ' +
          '<span class="c-del">-' + d.functions.deleted.length + '</span> / ' +
          d.functions.unchangedCount + ' 未变 ]';

        const fileRows = [
          ...d.files.added.map((f) => '<div class="diff-item c-add">+ [新增] ' + escapeHtml(f.path) + ' (' + f.size + ' B, sha256:' + escapeHtml(f.sha256.slice(0, 8)) + ')</div>'),
          ...d.files.modified.map((f) => '<div class="diff-item c-mod">~ [修改] ' + escapeHtml(f.path) + ' (' + escapeHtml(f.beforeSha256.slice(0, 8)) + ' -> ' + escapeHtml(f.afterSha256.slice(0, 8)) + ', ' + (f.deltaBytes >= 0 ? '+' : '') + f.deltaBytes + ' B)</div>'),
          ...d.files.deleted.map((f) => '<div class="diff-item c-del">- [删除] ' + escapeHtml(f.path) + ' (' + f.size + ' B)</div>'),
        ];
        document.getElementById('diffFilesList').innerHTML = fileRows.length > 0
          ? fileRows.join('')
          : '<div style="color:var(--muted);">两版本静态文件完全一致 (0 差异)</div>';

        const fnRows = [
          ...d.functions.added.map((f) => '<div class="diff-item c-add">+ [新增函数] ' + escapeHtml(f.route) + ' [' + escapeHtml(f.runtime) + '] (' + escapeHtml(f.sha256.slice(0, 8)) + ')</div>'),
          ...d.functions.modified.map((f) => '<div class="diff-item c-mod">~ [修改函数] ' + escapeHtml(f.route) + ' (' + escapeHtml(f.beforeSha256.slice(0, 8)) + ' -> ' + escapeHtml(f.afterSha256.slice(0, 8)) + ')</div>'),
          ...d.functions.deleted.map((f) => '<div class="diff-item c-del">- [删除函数] ' + escapeHtml(f.route) + '</div>'),
        ];
        document.getElementById('diffFnsList').innerHTML = fnRows.length > 0
          ? fnRows.join('')
          : '<div style="color:var(--muted);">两版本 Serverless 云函数完全一致 (0 差异)</div>';

        document.getElementById('diffGrid').style.display = 'grid';
      } catch (err) {
        if (reqProj !== currentProject || reqSeq !== diffReqSeq) return;
        showToast('对比失败: ' + err.message, true);
      }
    }

    async function loadProjectEnvs() {
      const reqProj = currentProject;
      const reqReveal = envReveal;
      const reqSeq = ++envReqSeq;
      try {
        const res = await apiFetch('/api/console/env?project=' + encodeURIComponent(reqProj) + '&reveal=' + (reqReveal ? '1' : '0'));
        if (reqProj !== currentProject || reqSeq !== envReqSeq) return;
        const entries = Object.entries(res.vars || {});
        const tbody = document.getElementById('envTableBody');
        if (entries.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" style="color:var(--muted);">当前项目尚无环境变量配置</td></tr>';
          return;
        }
        tbody.innerHTML = entries.map(([k, v]) =>
          '<tr>' +
            '<td><code>' + escapeHtml(k) + '</code></td>' +
            '<td><code>' + escapeHtml(v) + '</code></td>' +
            '<td><button class="danger" onclick="removeEnvKey(' + JSON.stringify(k).replace(/"/g, '&quot;') + ', ' + JSON.stringify(reqProj).replace(/"/g, '&quot;') + ')">删除</button></td>' +
          '</tr>'
        ).join('');
      } catch (err) {
        if (reqProj !== currentProject || reqSeq !== envReqSeq) return;
        showToast('读取环境变量失败: ' + err.message, true);
      }
    }

    function toggleEnvReveal() {
      envReveal = !envReveal;
      document.getElementById('toggleRevealBtn').textContent = envReveal ? '🙈 隐藏明文' : '👁️ 显示明文';
      loadProjectEnvs();
    }

    async function saveEnvPair() {
      const key = document.getElementById('envKeyInput').value.trim();
      const value = document.getElementById('envValInput').value;
      if (!key) return showToast('请输入环境变量名 KEY', true);
      const targetProj = currentProject;
      try {
        await apiFetch('/api/console/env', {
          method: 'POST',
          body: { project: targetProj, action: 'set', key, value },
        });
        document.getElementById('envKeyInput').value = '';
        document.getElementById('envValInput').value = '';
        showToast('✅ 已保存环境变量 [' + key + '] 并同步边缘函数');
        if (targetProj === currentProject) await loadProjectEnvs();
      } catch (err) {
        showToast('保存环境变量失败: ' + err.message, true);
      }
    }

    async function removeEnvKey(key, targetProj = currentProject) {
      try {
        await apiFetch('/api/console/env', {
          method: 'POST',
          body: { project: targetProj, action: 'rm', key },
        });
        showToast('✅ 已移除环境变量 [' + key + ']');
        if (targetProj === currentProject) await loadProjectEnvs();
      } catch (err) {
        showToast('删除失败: ' + err.message, true);
      }
    }

    function onGcOlderThanChange() {
      const olderThan = document.getElementById('gcOlderThanSelect').value || '';
      const keepInput = document.getElementById('gcKeepInput');
      if (keepInput) {
        keepInput.disabled = Boolean(olderThan);
        keepInput.style.opacity = olderThan ? '0.45' : '1';
        keepInput.title = olderThan ? '已选择按时间淘汰，将仅清理早于该时间的快照（不限制保留个数）' : '';
      }
    }

    async function runGc(dryRun) {
      const olderThan = document.getElementById('gcOlderThanSelect').value || null;
      const keepCount = olderThan
        ? 'all'
        : Number.parseInt(document.getElementById('gcKeepInput').value, 10) || 10;
      const box = document.getElementById('gcResultBox');
      box.textContent = dryRun ? '正在扫描预检...' : '正在执行 GC 回收并同步配额...';
      try {
        const res = await apiFetch('/api/console/gc', {
          method: 'POST',
          body: { keepCount, olderThan, dryRun },
        });
        const p = res.plan;
        box.innerHTML =
          (dryRun ? '🔍 <b>[预检结果]</b> ' : '✅ <b>[已清理]</b> ') +
          '过期快照: <b>' + p.expiredManifestsCount + '</b> 个，' +
          '孤儿静态块: <b>' + p.orphanBlobsCount + '</b> 个，' +
          '废弃函数: <b>' + p.orphanFnsCount + '</b> 个，' +
          '活跃 API 路由: <b>' + p.activeRoutes.length + '/15</b>';
        showToast(dryRun ? '🔍 GC 预检完成' : '🧹 GC 垃圾回收已完成');
        if (!dryRun) await refreshAll();
      } catch (err) {
        box.textContent = 'GC 失败: ' + err.message;
        showToast('GC 失败: ' + err.message, true);
      }
    }

    refreshAll();
  </script>
</body>
</html>`;
}
