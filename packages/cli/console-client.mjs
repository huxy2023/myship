/**
 * packages/cli/console-client.mjs
 * MyShip Console 现代化客户端状态与交互控制器
 */

export function buildConsoleClientScript(safeProj = 'default') {
  return `
    (function() {
      try {
        if (typeof localStorage !== 'undefined' && document.documentElement && document.documentElement.classList) {
          var saved = localStorage.getItem('myship-console-theme');
          if (saved === 'light') document.documentElement.classList.add('light');
        }
      } catch (e) {}
    })();

    const S = {
      data: null,
      selectedProject: ${JSON.stringify(safeProj)},
      activeTab: 'deployments',
      revealEnv: false,
      logsErrorOnly: false,
      logsLoading: false,
      logsData: [],
      resourcesData: null,
      confirmCallback: null,
    };

    function esc(s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function showToast(msg, isErr = false) {
      const el = document.getElementById('toast');
      if (!el) return;
      el.textContent = msg;
      el.style.borderColor = isErr ? 'var(--danger)' : 'var(--accent)';
      el.style.display = 'block';
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.style.display = 'none'; }, 3400);
    }

    async function api(path, opts = {}) {
      const headers = Object.assign(
        { 'Content-Type': 'application/json', 'X-MyShip-Console': '1' },
        opts.headers || {}
      );
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      const json = await res.json();
      if (!res.ok || !json.ok) {
        throw new Error(json.error || ('HTTP ' + res.status));
      }
      return json;
    }

    function fmtBytes(n) {
      const b = Number(n || 0);
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      return (b / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function getActiveProjectObj() {
      if (!S.data || !Array.isArray(S.data.projects)) {
        return { name: S.selectedProject, manifests: [], aliases: [] };
      }
      return (
        S.data.projects.find((p) => p.name === S.selectedProject) ||
        S.data.projects[0] || { name: S.selectedProject, manifests: [], aliases: [] }
      );
    }

    // ============================================================================
    // 1. 自定义防呆确认模态框 (Custom Poka-Yoke Confirmation Modal)
    // ============================================================================
    function askConfirmation({ title, desc, confirmLabel = '确认执行', danger = false, onConfirm }) {
      const modal = document.getElementById('confirmModal');
      if (!modal || !modal.classList) {
        if (typeof confirm === 'function') {
          if (confirm(title + '\\n\\n' + desc)) onConfirm();
        } else {
          onConfirm();
        }
        return;
      }
      document.getElementById('confirmModalTitle').textContent = title;
      document.getElementById('confirmModalDesc').innerHTML = desc;
      const okBtn = document.getElementById('confirmModalOkBtn');
      okBtn.textContent = confirmLabel;
      okBtn.className = danger ? 'danger' : 'primary';
      S.confirmCallback = onConfirm;
      modal.classList.add('open');
    }

    function closeConfirmModal() {
      const modal = document.getElementById('confirmModal');
      if (modal && modal.classList) modal.classList.remove('open');
      S.confirmCallback = null;
    }

    function executeConfirmModal() {
      const cb = S.confirmCallback;
      closeConfirmModal();
      if (typeof cb === 'function') cb();
    }

    // ============================================================================
    // 2. 工作区 Tab 导航与 URL Hash 同步
    // ============================================================================
    function switchWorkspaceTab(tabId) {
      S.activeTab = tabId;
      if (document.querySelectorAll) {
        document.querySelectorAll('[data-ws-tab]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.wsTab === tabId);
        });
        document.querySelectorAll('[data-ws-pane]').forEach((pane) => {
          pane.classList.toggle('active', pane.dataset.wsPane === tabId);
        });
      }
      if (tabId === 'backend') {
        loadProjectLogs();
      } else if (tabId === 'resources') {
        loadProjectResources();
      }
    }

    function selectProject(projName) {
      S.selectedProject = projName;
      renderAll();
      loadEnv();
      if (S.activeTab === 'backend') loadProjectLogs();
      if (S.activeTab === 'resources') loadProjectResources();
    }

    // ============================================================================
    // 3. 主状态加载与多维视图渲染
    // ============================================================================
    async function refreshAll() {
      try {
        const state = await api('/api/console/state');
        S.data = state;
        if (
          !S.selectedProject ||
          !state.projects.some((p) => p.name === S.selectedProject)
        ) {
          S.selectedProject =
            state.defaultProject ||
            (state.projects[0] && state.projects[0].name) ||
            'default';
        }
        renderAll();
        await loadEnv();
        if (S.activeTab === 'backend') await loadProjectLogs();
        if (S.activeTab === 'resources') await loadProjectResources();
      } catch (err) {
        showToast('加载状态失败: ' + err.message, true);
      }
    }

    function renderAll() {
      const d = S.data;
      if (!d) return;

      const modeBadge = document.getElementById('modeBadge');
      if (modeBadge) modeBadge.textContent = d.modeLabel;
      const domainBadge = document.getElementById('domainBadge');
      if (domainBadge) domainBadge.textContent = '*.' + d.domainSuffix;

      const proj = getActiveProjectObj();
      S.selectedProject = proj.name;

      // 渲染左侧项目列表
      const ul = document.getElementById('projectList');
      if (ul) {
        ul.innerHTML = d.projects
          .map((p) => {
            const active = p.name === proj.name ? 'active' : '';
            const latestM = p.manifests && p.manifests[0];
            const hasScf =
              latestM &&
              latestM.backend &&
              (latestM.backend.mode === 'scf-web' || latestM.backend.provider === 'scf');
            const isPaused = Boolean(p.projectDisabled);
            const tagHtml = isPaused
              ? '<span class="badge warn" style="font-size:10px;padding:1px 6px;">⏸️ 下线</span>'
              : hasScf
              ? '<span class="badge purple" style="font-size:10px;padding:1px 6px;">SCF</span>'
              : '<span class="badge" style="font-size:10px;padding:1px 6px;">' + p.manifests.length + '</span>';
            return (
              '<li><button class="proj-btn ' +
              active +
              '" onclick="selectProject(\\'' +
              esc(p.name) +
              '\\')"><span>📁 ' +
              esc(p.name) +
              '</span>' +
              tagHtml +
              '</button></li>'
            );
          })
          .join('');
      }

      // 顶部统计卡片
      document.getElementById('statProject').textContent = proj.name;
      document.getElementById('statManifests').textContent = String(proj.manifests.length);
      document.getElementById('statAliases').textContent = String(proj.aliases.length);
      document.getElementById('statBlobs').textContent = String(d.blobsCount);

      // 态势感知横幅 (Project Hero Banner)
      const primaryAlias =
        proj.aliases.find((a) => a.subdomain === proj.name) || proj.aliases[0] || null;
      const latestManifest = proj.manifests[0] || null;
      const activeManifest =
        (primaryAlias &&
          proj.manifests.find((m) => m.id === primaryAlias.deploymentId)) ||
        latestManifest;

      const heroUrlEl = document.getElementById('heroPrimaryUrl');
      if (heroUrlEl) {
        if (primaryAlias) {
          const fullUrl = d.protocol + '://' + primaryAlias.subdomain + '.' + d.domainSuffix;
          heroUrlEl.innerHTML =
            '<a href="' +
            esc(fullUrl) +
            '" target="_blank" rel="noopener">🌐 ' +
            esc(fullUrl) +
            ' ↗</a>';
        } else {
          heroUrlEl.innerHTML = '<span style="color:var(--muted);">暂未绑定活跃主域名</span>';
        }
      }

      const heroRuntimeBadge = document.getElementById('heroRuntimeBadge');
      if (heroRuntimeBadge) {
        if (activeManifest && activeManifest.backend && activeManifest.backend.mode === 'scf-web') {
          heroRuntimeBadge.className = 'badge purple';
          heroRuntimeBadge.textContent =
            '🏭 SCF 全栈后端 @v' + (activeManifest.backend.version || '$LATEST');
        } else if (
          activeManifest &&
          activeManifest.functions &&
          Object.keys(activeManifest.functions).length > 0
        ) {
          heroRuntimeBadge.className = 'badge success';
          heroRuntimeBadge.textContent =
            '⚡ Edge V8 云函数 (' + Object.keys(activeManifest.functions).length + ')';
        } else {
          heroRuntimeBadge.className = 'badge';
          heroRuntimeBadge.textContent = '📦 纯静态 SPA / 站点';
        }
      }

      const heroLiveDplEl = document.getElementById('heroLiveDpl');
      if (heroLiveDplEl) {
        heroLiveDplEl.textContent = primaryAlias
          ? primaryAlias.deploymentId
          : latestManifest
          ? latestManifest.id
          : '-';
      }

      const isProjOffline = Boolean(
        proj.projectDisabled ||
          proj.aliases.some((a) => a.projectDisabled === true) ||
          proj.manifests.some((m) => m.projectDisabled === true)
      );
      const heroAvailBadge = document.getElementById('heroAvailabilityBadge');
      if (heroAvailBadge) {
        heroAvailBadge.className = isProjOffline ? 'badge warn' : 'badge success';
        heroAvailBadge.textContent = isProjOffline ? '⏸️ 已下线暂停' : '🟢 在线运行';
      }
      const heroToggleBtn = document.getElementById('heroToggleAvailabilityBtn');
      if (heroToggleBtn) {
        heroToggleBtn.className = isProjOffline ? 'primary' : '';
        heroToggleBtn.textContent = isProjOffline ? '🟢 恢复全站上线' : '⏸️ 暂停全站访问';
      }

      // 1. 填充自定义域名绑定下拉框与域名路由表
      const dplOptionsHtml = proj.manifests
        .filter((m) => m.disabled !== true)
        .map(
          (m) =>
            '<option value="' +
            esc(m.id) +
            '">' +
            esc(m.id) +
            ' (' +
            esc((m.createdAt || '').slice(0, 19).replace('T', ' ')) +
            ')</option>'
        )
        .join('');
      const customDplSelect = document.getElementById('customDplSelect');
      if (customDplSelect) customDplSelect.innerHTML = dplOptionsHtml;

      const aliasesBody = document.getElementById('aliasesTableBody');
      if (aliasesBody) {
        if (proj.aliases.length === 0) {
          aliasesBody.innerHTML =
            '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:24px;">当前项目暂无活跃子域名指针</td></tr>';
        } else {
          aliasesBody.innerHTML = proj.aliases
            .map((a) => {
              const url = d.protocol + '://' + a.subdomain + '.' + d.domainSuffix;
              const isPrimary = a.subdomain === proj.name;
              const badgeHtml = isPrimary
                ? ' <span class="badge success">主域名</span>'
                : ' <span class="badge">环境别名</span>';
              const targetM = proj.manifests.find((m) => m.id === a.deploymentId);
              const isAliasPaused = Boolean(a.disabled === true);
              const isTargetDisabled = Boolean(targetM && targetM.disabled === true);
              const statusTag = isProjOffline
                ? ' <span class="badge warn">⏸️ 项目下线</span>'
                : isAliasPaused
                ? ' <span class="badge danger">⏸️ 已下线</span>'
                : isTargetDisabled
                ? ' <span class="badge danger">🚫 指向禁用版本</span>'
                : '';
              const scfTag =
                targetM &&
                targetM.backend &&
                (targetM.backend.version || targetM.backend.scfVersion)
                  ? ' <span class="badge purple">SCF v' +
                    esc(targetM.backend.version || targetM.backend.scfVersion) +
                    '</span>'
                  : '';
              return (
                '<tr>' +
                '<td><a href="' +
                esc(url) +
                '" target="_blank" rel="noopener"><strong>' +
                esc(url) +
                '</strong> ↗</a>' +
                badgeHtml +
                statusTag +
                '</td>' +
                '<td><code>' +
                esc(a.deploymentId) +
                '</code>' +
                scfTag +
                '</td>' +
                '<td style="color:var(--muted);">' +
                esc((a.updatedAt || '-').replace('T', ' ').slice(0, 19)) +
                '</td>' +
                '<td class="row-actions">' +
                '<button onclick="toggleAliasAvailability(\\'' +
                esc(a.subdomain) +
                '\\', ' +
                (isAliasPaused ? 'true' : 'false') +
                ')">' +
                (isAliasPaused ? '🟢 恢复上线' : '⏸️ 暂停访问') +
                '</button>' +
                '<button onclick="rollbackSubdomain(\\'' +
                esc(a.subdomain) +
                '\\', \\'' +
                esc(a.deploymentId) +
                '\\')">⏪ 0秒回滚上一版</button>' +
                '<button class="danger" onclick="removeAlias(\\'' +
                esc(a.subdomain) +
                '\\')">🗑️ 解绑</button>' +
                '</td>' +
                '</tr>'
              );
            })
            .join('');
        }
      }

      // 2. 渲染历史构建版本表 (Deployments Timeline)
      const manifestsBody = document.getElementById('manifestsTableBody');
      if (manifestsBody) {
        if (proj.manifests.length === 0) {
          manifestsBody.innerHTML =
            '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px;">当前项目暂无构建快照</td></tr>';
        } else {
          manifestsBody.innerHTML = proj.manifests
            .map((m, idx) => {
              const immSub = m.immutableSubdomain || m.id.replace(/^dpl_/, 'dpl-');
              const immUrl = d.protocol + '://' + immSub + '.' + d.domainSuffix;
              const filesCount = Object.keys(m.files || {}).length;
              const fnsRoutes = Object.keys(m.functions || {});
              const isLiveProd = primaryAlias && primaryAlias.deploymentId === m.id;
              const isDplDisabled = Boolean(m.disabled === true);

              let computeBadges = '';
              if (
                m.backend &&
                (m.backend.mode === 'scf-web' || m.backend.provider === 'scf')
              ) {
                computeBadges +=
                  '<span class="badge purple">🏭 SCF @v' +
                  esc(m.backend.version || m.backend.scfVersion || '$LATEST') +
                  '</span> ';
              }
              if (fnsRoutes.length > 0) {
                computeBadges +=
                  '<span class="badge warn">⚡ Edge (' + fnsRoutes.length + ')</span>';
              }
              if (!computeBadges) {
                computeBadges = '<span style="color:var(--muted);">纯静态</span>';
              }

              return (
                '<tr>' +
                '<td><code>' +
                esc(m.id) +
                '</code> ' +
                (idx === 0 ? '<span class="badge">最新</span> ' : '') +
                (isLiveProd ? '<span class="badge success">LIVE 生产</span> ' : '') +
                (isDplDisabled ? '<span class="badge danger">🚫 已禁用</span>' : '') +
                '</td>' +
                '<td><a href="' +
                esc(immUrl) +
                '" target="_blank" rel="noopener">' +
                esc(immSub + '.' + d.domainSuffix) +
                ' ↗</a></td>' +
                '<td>' +
                filesCount +
                ' 个文件 (' +
                fmtBytes(m.stats && m.stats.totalBytes) +
                ')</td>' +
                '<td>' +
                computeBadges +
                '</td>' +
                '<td style="color:var(--muted);">' +
                esc((m.createdAt || '-').replace('T', ' ').slice(0, 19)) +
                '</td>' +
                '<td class="row-actions">' +
                '<button onclick="openSnapshotDrawer(\\'' +
                esc(m.id) +
                '\\')">🔍 详情抽屉</button>' +
                (isDplDisabled
                  ? ''
                  : '<button class="primary" onclick="promoteToPrimary(\\'' +
                    esc(m.id) +
                    '\\')">⚡ 切流到主域名</button>') +
                '<button onclick="toggleDeploymentAvailability(\\'' +
                esc(m.id) +
                '\\', ' +
                (isDplDisabled ? 'true' : 'false') +
                ')">' +
                (isDplDisabled ? '🟢 解除禁用' : '🚫 禁用版本') +
                '</button>' +
                '<button class="danger" onclick="deleteSnapshot(\\'' +
                esc(m.id) +
                '\\')">🗑️</button>' +
                '</td>' +
                '</tr>'
              );
            })
            .join('');
        }
      }

      // 3. 更新 Backend 概览面板信息
      renderBackendOverviewCard(proj);

      // 4. 更新双版本 Diff 下拉框
      const diffBaseSel = document.getElementById('diffBaseSelect');
      const diffTargetSel = document.getElementById('diffTargetSelect');
      if (diffBaseSel && diffTargetSel) {
        diffBaseSel.innerHTML = dplOptionsHtml;
        diffTargetSel.innerHTML = dplOptionsHtml;
        if (proj.manifests.length >= 2) {
          diffBaseSel.value = proj.manifests[1].id;
          diffTargetSel.value = proj.manifests[0].id;
        }
      }
    }

    // ============================================================================
    // 4. 右侧滑出式构建快照详情抽屉 (Slide-Over Snapshot Inspector Drawer)
    // ============================================================================
    function openSnapshotDrawer(dplId) {
      const proj = getActiveProjectObj();
      const m = proj.manifests.find((x) => x.id === dplId);
      if (!m) return;
      const d = S.data;
      const immSub = m.immutableSubdomain || m.id.replace(/^dpl_/, 'dpl-');
      const immUrl = d.protocol + '://' + immSub + '.' + d.domainSuffix;

      const titleEl = document.getElementById('drawerTitle');
      const bodyEl = document.getElementById('drawerBody');
      if (!titleEl || !bodyEl) return;

      titleEl.innerHTML = '🔎 快照详情检查器 · <code>' + esc(m.id) + '</code>';

      const filesEntries = Object.entries(m.files || {}).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      const fnEntries = Object.entries(m.functions || {}).sort((a, b) =>
        a[0].localeCompare(b[0])
      );

      let backendHtml = '';
      if (m.backend && m.backend.mode === 'scf-web') {
        backendHtml =
          '<div class="card" style="margin-bottom:14px;background:var(--bg-subtle);">' +
          '<div style="font-weight:700;margin-bottom:6px;color:var(--purple);">🏭 Phase 4 · SCF 全栈 Node.js 后端绑定</div>' +
          '<div style="font-size:12.5px;line-height:1.7;">' +
          '<div>函数名称: <code>' + esc(m.backend.functionName || '-') + '</code> (' + esc(m.backend.region || 'ap-guangzhou') + ')</div>' +
          '<div>锁定版本: <span class="badge purple">v' + esc(m.backend.version || '$LATEST') + '</span></div>' +
          '<div>Bundle SHA-256: <code>' + esc((m.backend.sha256 || '-').slice(0, 16)) + '...</code></div>' +
          '<div>Upstream 地址: <code style="word-break:break-all;">' + esc(m.backend.upstreamUrl || '-') + '</code></div>' +
          '</div></div>';
      }

      let fnsHtml = '';
      if (fnEntries.length > 0) {
        fnsHtml =
          '<div style="font-weight:600;margin:14px 0 8px;">⚡ Serverless 路由表 (' +
          fnEntries.length +
          ')</div>' +
          '<table><thead><tr><th>路由</th><th>运行时</th><th>入口</th><th>SHA-256</th></tr></thead><tbody>' +
          fnEntries
            .map(
              ([route, meta]) =>
                '<tr><td><code>' +
                esc(route) +
                '</code></td><td><span class="badge">' +
                esc(meta.runtime || 'edge-js') +
                '</span></td><td><code>' +
                esc(meta.source || '-') +
                '</code></td><td><code>' +
                esc((meta.sha256 || '').slice(0, 12)) +
                '</code></td></tr>'
            )
            .join('') +
          '</tbody></table>';
      }

      const filesHtml =
        '<div style="font-weight:600;margin:16px 0 8px;">📄 静态文件清单 (' +
        filesEntries.length +
        ' 个文件)</div>' +
        '<table><thead><tr><th>路径</th><th>类型</th><th>大小</th><th>SHA-256</th></tr></thead><tbody>' +
        filesEntries
          .map(
            ([p, meta]) =>
              '<tr><td><a href="' +
              esc(immUrl + p) +
              '" target="_blank" rel="noopener"><code>' +
              esc(p) +
              '</code> ↗</a></td><td style="color:var(--muted);">' +
              esc(meta.contentType || '-') +
              '</td><td>' +
              fmtBytes(meta.size) +
              '</td><td><code>' +
              esc((meta.sha256 || '').slice(0, 10)) +
              '</code></td></tr>'
          )
          .join('') +
        '</tbody></table>';

      bodyEl.innerHTML =
        '<div style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">' +
        '<div><div style="color:var(--muted);font-size:12px;">不可变快照预览地址</div>' +
        '<a href="' + esc(immUrl) + '" target="_blank" rel="noopener" style="font-weight:600;">' + esc(immUrl) + ' ↗</a></div>' +
        '<button class="primary" onclick="promoteToPrimary(\\'' + esc(m.id) + '\\')">⚡ 将主域名切流至此版本</button>' +
        '</div>' +
        backendHtml +
        fnsHtml +
        filesHtml;

      document.getElementById('drawerBackdrop').classList.add('open');
      document.getElementById('snapshotDrawer').classList.add('open');
    }

    function closeSnapshotDrawer() {
      const bd = document.getElementById('drawerBackdrop');
      const dr = document.getElementById('snapshotDrawer');
      if (bd && bd.classList) bd.classList.remove('open');
      if (dr && dr.classList) dr.classList.remove('open');
    }

    // ============================================================================
    // 5. Phase 4 全栈后端与云端实时日志查看器 (Backend & Cloud Logs Viewer)
    // ============================================================================
    function renderBackendOverviewCard(proj) {
      const box = document.getElementById('backendStatusSummary');
      if (!box) return;
      const primaryAlias =
        proj.aliases.find((a) => a.subdomain === proj.name) || proj.aliases[0] || null;
      const activeManifest =
        (primaryAlias && proj.manifests.find((m) => m.id === primaryAlias.deploymentId)) ||
        proj.manifests[0] ||
        null;
      const latestWithBackend = proj.manifests.find(
        (m) => m.backend && m.backend.mode === 'scf-web'
      );
      if (!latestWithBackend && (!activeManifest || !activeManifest.backend)) {
        box.innerHTML =
          '<div style="color:var(--muted);padding:8px 0;">当前项目尚未开启 SCF 全栈 Node.js 后端（可在终端执行 <code>myship backend enable</code> 开启，或直接创建 <code>server/index.mjs</code> 后执行 <code>myship</code> 自动打包上云）。</div>';
        return;
      }
      const activeB =
        activeManifest && activeManifest.backend && activeManifest.backend.mode === 'scf-web'
          ? activeManifest.backend
          : null;
      const latestB = latestWithBackend ? latestWithBackend.backend : activeB;
      const refB = activeB || latestB;
      const runtimeLabel = refB.runtime || 'SCF Web Function';
      const activeVerLabel = activeB
        ? 'Version ' + esc(activeB.version || '$LATEST') + ' (' + esc(activeManifest.id) + ')'
        : '无 SCF 后端 (' + esc(activeManifest ? activeManifest.id : '未绑定') + ')';
      const latestVerLabel = latestWithBackend
        ? 'Version ' +
          esc(latestB.version || '$LATEST') +
          ' (' +
          esc(latestWithBackend.id) +
          ')'
        : '-';
      const isRolledBackDiff =
        activeManifest &&
        latestWithBackend &&
        activeManifest.id !== latestWithBackend.id;

      box.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">' +
        '<div class="stat-card"><div class="stat-label">SCF 云函数名称</div><div class="stat-val" style="font-size:15px;">' +
        esc(refB.functionName || 'myship-' + proj.name) +
        '</div></div>' +
        '<div class="stat-card"><div class="stat-label">当前生产生效版本 (Live)</div><div class="stat-val" style="font-size:14.5px;color:var(--success);">' +
        activeVerLabel +
        '</div></div>' +
        '<div class="stat-card"><div class="stat-label">最新构建发布版本 (Latest)</div><div class="stat-val" style="font-size:14.5px;color:var(--purple);">' +
        latestVerLabel +
        (isRolledBackDiff ? ' <span class="badge warn">已回滚偏离</span>' : '') +
        '</div></div>' +
        '<div class="stat-card"><div class="stat-label">部署地域 & 运行时</div><div class="stat-val" style="font-size:15px;">' +
        esc(refB.region || 'ap-guangzhou') +
        ' · ' +
        esc(runtimeLabel) +
        '</div></div>' +
        '</div>';
    }

    async function loadProjectLogs() {
      const box = document.getElementById('logsTerminalBox');
      if (!box) return;
      box.innerHTML = '<div style="color:var(--muted);">⏳ 正在拉取项目 [' + esc(S.selectedProject) + '] 的后端运行与 SourceMap 错误日志...</div>';
      try {
        const res = await api(
          '/api/console/logs?project=' +
            encodeURIComponent(S.selectedProject) +
            '&limit=40&errorsOnly=' +
            (S.logsErrorOnly ? '1' : '0')
        );
        S.logsData = res.logs || [];
        if (S.logsData.length === 0) {
          box.innerHTML =
            '<div style="color:var(--muted);padding:20px;text-align:center;">✨ 暂无匹配的后端日志记录（当 SCF Web 函数处理请求或抛出异常时，将自动归档至私有 COS 并在此展示还原后的真实源码堆栈）</div>';
          return;
        }
        box.innerHTML = S.logsData
          .map((item) => {
            const isErr = item.level === 'ERROR' || (item.status && item.status >= 500) || item.error;
            const statusBadge = isErr
              ? '<span class="badge danger">ERROR ' + esc(item.status || 500) + '</span>'
              : '<span class="badge success">' + esc(item.status || 200) + ' OK</span>';
            const stackHtml = item.stack
              ? '<div class="log-stack">' + esc(item.stack) + '</div>'
              : item.error
              ? '<div class="log-stack">' + esc(item.error) + '</div>'
              : '';
            const consoleLinesHtml =
              Array.isArray(item.lines) && item.lines.length > 0
                ? '<div style="margin-top:4px;color:#94a3b8;">' +
                  item.lines.map((l) => '<div>[' + esc(l.level || 'LOG') + '] ' + esc(l.text) + '</div>').join('') +
                  '</div>'
                : '';
            return (
              '<div class="log-entry' +
              (isErr ? ' error' : '') +
              '">' +
              '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
              '<div>' +
              statusBadge +
              ' <strong>' +
              esc(item.method || 'GET') +
              ' ' +
              esc(item.path || '/') +
              '</strong> <span style="color:var(--muted);">(' +
              esc(item.durationMs ?? 0) +
              ' ms · SCF v' +
              esc(item.scfVersion || '$LATEST') +
              ')</span></div>' +
              '<div style="color:var(--muted);font-size:11px;">' +
              esc((item.timestamp || '').replace('T', ' ').slice(0, 19)) +
              ' · ReqId: ' +
              esc((item.requestId || '-').slice(0, 12)) +
              '</div></div>' +
              stackHtml +
              consoleLinesHtml +
              '</div>'
            );
          })
          .join('');
      } catch (err) {
        box.innerHTML = '<div style="color:var(--danger);">读取日志失败: ' + esc(err.message) + '</div>';
      }
    }

    function toggleLogsErrorFilter() {
      S.logsErrorOnly = !S.logsErrorOnly;
      const btn = document.getElementById('btnToggleErrorLogs');
      if (btn) {
        btn.className = S.logsErrorOnly ? 'danger' : '';
        btn.textContent = S.logsErrorOnly ? '🚨 仅看报错 (--error 已开启)' : '🔍 仅看报错 (--error)';
      }
      loadProjectLogs();
    }

    // ============================================================================
    // 6. Phase 5 声明式云资源与存储对象浏览器 (Resources: DB & Storage)
    // ============================================================================
    async function loadProjectResources() {
      const dbCard = document.getElementById('resourceDbSummary');
      const dataList = document.getElementById('resourceDataKeysList');
      const filesList = document.getElementById('resourceFileKeysList');
      if (!dbCard) return;

      try {
        const res = await api('/api/console/resources?project=' + encodeURIComponent(S.selectedProject));
        S.resourcesData = res;
        const db = res.db || {};
        const st = res.storage || {};

        const providerLabels = {
          turso: '⚡ Turso (Serverless SQLite / libSQL)',
          neon: '🐘 Neon (Serverless PostgreSQL)',
          pg: '🐘 腾讯云 CloudBase / PostgreSQL',
          d1: '☁️ Cloudflare D1 (SQLite)',
          mysql: '🐬 腾讯云 MySQL / TDSQL-C',
          'sqlite-local': '💻 本地零配置 node:sqlite (.myship/data/local.sqlite)',
        };

        dbCard.innerHTML =
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">' +
          '<div class="stat-card"><div class="stat-label">数据库引擎 (context.db)</div><div class="stat-val" style="font-size:14.5px;">' +
          esc(providerLabels[db.provider] || db.provider || '未配置') +
          '</div></div>' +
          '<div class="stat-card"><div class="stat-label">多租户隔离粒度</div><div class="stat-val" style="font-size:14.5px;">' +
          esc(db.isolation || 'project') +
          '</div></div>' +
          '<div class="stat-card"><div class="stat-label">连接目标摘要 (脱敏)</div><div class="stat-val" style="font-size:13.5px;color:var(--accent);">' +
          esc(db.targetSummary || '-') +
          '</div></div>' +
          '</div>';

        if (dataList) {
          const dKeys = st.dataKeys || [];
          dataList.innerHTML =
            dKeys.length === 0
              ? '<div style="color:var(--muted);">暂无 JSON KV 数据键 (可通过 <code>await context.storage.set(key, val)</code> 写入)</div>'
              : dKeys
                  .map(
                    (k) =>
                      '<div class="diff-item" style="display:flex;justify-content:space-between;align-items:center;">' +
                      '<span>📄 <code>' +
                      esc(st.dataPrefix + k + '.json') +
                      '</code></span>' +
                      '<span class="badge">JSON</span></div>'
                  )
                  .join('');
        }

        if (filesList) {
          const fKeys = st.fileKeys || [];
          filesList.innerHTML =
            fKeys.length === 0
              ? '<div style="color:var(--muted);">暂无二进制对象文件 (可通过 <code>await context.files.put(key, buf)</code> 写入)</div>'
              : fKeys
                  .map(
                    (k) =>
                      '<div class="diff-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
                      '<span>🗂️ <code>' +
                      esc(st.filesPrefix + k) +
                      '</code></span>' +
                      '<button onclick="openFilePresignPreview(\\'' +
                      esc(k) +
                      '\\')">🔗 GET 预签名预览 ↗</button></div>'
                  )
                  .join('');
        }
      } catch (err) {
        const errHtml =
          '<div style="color:var(--danger);">读取云资源状态失败: ' + esc(err.message) + '</div>';
        dbCard.innerHTML = errHtml;
        if (dataList) dataList.innerHTML = errHtml;
        if (filesList) filesList.innerHTML = errHtml;
        showToast('读取云资源状态失败: ' + err.message, true);
      }
    }

    async function openFilePresignPreview(fileKey) {
      try {
        const res = await api(
          '/api/console/file-presign?project=' +
            encodeURIComponent(S.selectedProject) +
            '&key=' +
            encodeURIComponent(fileKey)
        );
        if (res.url) {
          window.open(res.url, '_blank', 'noopener');
          showToast('🔗 已在新窗口打开私有文件 GET 预签名链接 (15分钟有效)');
        }
      } catch (err) {
        showToast('生成预签名链接失败: ' + err.message, true);
      }
    }

    // ============================================================================
    // 7. 切流、回滚、环境变量、Diff 与 GC 操作
    // ============================================================================
    async function switchAlias(subdomain, deploymentId, raw = true) {
      try {
        await api('/api/console/alias', {
          method: 'POST',
          body: JSON.stringify({
            project: S.selectedProject,
            subdomain,
            deploymentId,
            raw,
          }),
        });
        showToast('⚡ 0 秒切流完成: ' + subdomain + ' -> ' + deploymentId);
        closeSnapshotDrawer();
        await refreshAll();
      } catch (err) {
        showToast('切流失败: ' + err.message, true);
      }
    }

    function promoteToPrimary(deploymentId) {
      const proj = getActiveProjectObj();
      const primaryAlias = proj.aliases.find((a) => a.subdomain === proj.name);
      const currentDpl = primaryAlias ? primaryAlias.deploymentId : '未绑定';
      askConfirmation({
        title: '⚡ 确认切换生产主域名流量？',
        desc:
          '即将把项目主域名 <code>' +
          esc(proj.name + '.' + (S.data ? S.data.domainSuffix : '')) +
          '</code> 的云端指针从 <code>' +
          esc(currentDpl) +
          '</code> 原子切换至 <code>' +
          esc(deploymentId) +
          '</code>（全球边缘 0 秒生效）。',
        confirmLabel: '⚡ 立即 0ms 切流',
        danger: false,
        onConfirm: () => switchAlias(proj.name, deploymentId, true),
      });
    }

    async function bindCustomAlias() {
      const sub = document.getElementById('customSubInput').value.trim();
      const dpl = document.getElementById('customDplSelect').value;
      if (!sub || !dpl) {
        showToast('请填写环境后缀并选择目标构建快照', true);
        return;
      }
      await switchAlias(sub, dpl, false);
      document.getElementById('customSubInput').value = '';
    }

    function rollbackSubdomain(subdomain, currentDplId) {
      askConfirmation({
        title: '⏪ 确认执行 0 秒原子回滚？',
        desc:
          '即将把子域名 <code>' +
          esc(subdomain) +
          '</code> 从当前版本 <code>' +
          esc(currentDplId || '-') +
          '</code> 同帧回退至上一历史版本（包含静态资产与绑定的 SCF 后端版本）。',
        confirmLabel: '⏪ 确认 0ms 回滚',
        danger: false,
        onConfirm: async () => {
          try {
            const res = await api('/api/console/rollback', {
              method: 'POST',
              body: JSON.stringify({
                project: S.selectedProject,
                subdomain,
              }),
            });
            showToast('⏪ 已回滚 ' + subdomain + ' -> ' + res.alias.deploymentId);
            await refreshAll();
          } catch (err) {
            showToast('回滚失败: ' + err.message, true);
          }
        },
      });
    }

    function removeAlias(subdomain) {
      askConfirmation({
        title: '🗑️ 确认解绑子域名路由指针？',
        desc:
          '确定要解绑子域名指针 <code>' +
          esc(subdomain) +
          '</code> 吗？（底层的构建快照与 CAS 文件块仍会安全保留）',
        confirmLabel: '🗑️ 确认解绑',
        danger: true,
        onConfirm: async () => {
          try {
            await api('/api/console/rm', {
              method: 'POST',
              body: JSON.stringify({
                type: 'alias',
                project: S.selectedProject,
                subdomain,
                raw: true,
              }),
            });
            showToast('🗑️ 已解绑子域名: ' + subdomain);
            await refreshAll();
          } catch (err) {
            showToast('解绑失败: ' + err.message, true);
          }
        },
      });
    }

    function deleteSnapshot(dplId) {
      askConfirmation({
        title: '🗑️ 确认销毁构建版本快照？',
        desc:
          '确定要删除构建快照 <code>' +
          esc(dplId) +
          '</code> 吗？如果该快照正被活跃域名引用，系统将自动拦截保护。',
        confirmLabel: '🗑️ 确认删除快照',
        danger: true,
        onConfirm: async () => {
          try {
            await api('/api/console/rm', {
              method: 'POST',
              body: JSON.stringify({
                type: 'deployment',
                project: S.selectedProject,
                deploymentId: dplId,
                force: false,
              }),
            });
            showToast('🗑️ 已删除构建版本: ' + dplId);
            await refreshAll();
          } catch (err) {
            showToast('删除拦截: ' + err.message, true);
          }
        },
      });
    }

    function confirmAvailabilityToggle({ isOffline, title, desc, confirmLabel, payload, toastMsg }) {
      askConfirmation({
        title,
        desc,
        confirmLabel,
        danger: !isOffline,
        onConfirm: async () => {
          try {
            await api('/api/console/availability', {
              method: 'POST',
              body: JSON.stringify(payload),
            });
            showToast(toastMsg);
            await refreshAll();
          } catch (err) {
            showToast('操作失败: ' + err.message, true);
          }
        },
      });
    }

    function toggleProjectAvailability() {
      const proj = getActiveProjectObj();
      const isOff = Boolean(
        proj.projectDisabled ||
          proj.aliases.some((a) => a.projectDisabled === true) ||
          proj.manifests.some((m) => m.projectDisabled === true)
      );
      confirmAvailabilityToggle({
        isOffline: isOff,
        title: (isOff ? '🟢 确认恢复项目 [' : '⏸️ 确认暂停项目 [') + proj.name + '] 访问？',
        desc: isOff
          ? '即将恢复项目 <code>' + esc(proj.name) + '</code> 的对外访问（此前单独封禁的版本仍保持禁用）。'
          : '即将暂停项目 <code>' + esc(proj.name) + '</code> 下所有子域名与预览地址服务（返回 503，保留云资源与数据，可随时一键恢复）。',
        confirmLabel: isOff ? '🟢 立即恢复上线' : '⏸️ 立即暂停访问',
        payload: { action: isOff ? 'online' : 'offline', project: proj.name },
        toastMsg: (isOff ? '🟢 项目 [' : '⏸️ 项目 [') + proj.name + (isOff ? '] 已恢复上线' : '] 已暂停全站访问'),
      });
    }

    function toggleAliasAvailability(subdomain, isOff) {
      confirmAvailabilityToggle({
        isOffline: isOff,
        title: (isOff ? '🟢 确认恢复子域名 [' : '⏸️ 确认暂停子域名 [') + subdomain + '] 访问？',
        desc: '子域名 <code>' + esc(subdomain) + '</code> ' + (isOff ? '将恢复正常访问。' : '将暂停访问并返回 503（保留绑定指针，可随时恢复）。'),
        confirmLabel: isOff ? '🟢 恢复上线' : '⏸️ 暂停访问',
        payload: { action: isOff ? 'online' : 'offline', project: S.selectedProject, subdomain, raw: true },
        toastMsg: (isOff ? '🟢 已恢复子域名: ' : '⏸️ 已暂停子域名: ') + subdomain,
      });
    }

    function toggleDeploymentAvailability(dplId, isOff) {
      confirmAvailabilityToggle({
        isOffline: isOff,
        title: (isOff ? '🟢 确认解除版本 [' : '🚫 确认禁用构建版本 [') + dplId + ']？',
        desc: '构建版本 <code>' + esc(dplId) + '</code> ' + (isOff ? '将解除禁用。' : '禁用后其预览地址及指向它的子域名均返回 503，且回滚时自动跳过。'),
        confirmLabel: isOff ? '🟢 解除禁用' : '🚫 确认禁用版本',
        payload: { action: isOff ? 'online' : 'offline', project: S.selectedProject, deploymentId: dplId },
        toastMsg: (isOff ? '🟢 已解除禁用: ' : '🚫 已禁用构建版本: ') + dplId,
      });
    }

    function purgeCurrentProject() {
      const p = S.selectedProject;
      askConfirmation({
        title: '⚠️ 高危操作：彻底销毁项目 [' + p + ']',
        desc:
          '即将彻底销毁项目 <code>' +
          esc(p) +
          '</code> 下的<strong>所有子域名路由、历史版本快照、私有环境变量与独享 CAS 静态块</strong>。此操作不可逆！',
        confirmLabel: '🗑️ 彻底销毁项目',
        danger: true,
        onConfirm: async () => {
          try {
            await api('/api/console/rm', {
              method: 'POST',
              body: JSON.stringify({ type: 'project', project: p }),
            });
            showToast('🗑️ 已彻底销毁项目: ' + p);
            S.selectedProject = '';
            await refreshAll();
          } catch (err) {
            showToast('销毁项目失败: ' + err.message, true);
          }
        },
      });
    }

    async function loadEnv() {
      try {
        const res = await api(
          '/api/console/env?project=' +
            encodeURIComponent(S.selectedProject) +
            '&reveal=' +
            (S.revealEnv ? '1' : '0')
        );
        const tbody = document.getElementById('envTableBody');
        if (!tbody) return;
        const keys = Object.keys(res.vars || {});
        if (keys.length === 0) {
          tbody.innerHTML =
            '<tr><td colspan="3" style="color:var(--muted);text-align:center;padding:18px;">当前项目暂未配置私有环境变量 (envs/' +
            esc(S.selectedProject) +
            '.json)</td></tr>';
          return;
        }
        tbody.innerHTML = keys
          .map(
            (k) =>
              '<tr>' +
              '<td><code>' +
              esc(k) +
              '</code></td>' +
              '<td><code>' +
              esc(res.vars[k]) +
              '</code></td>' +
              '<td><button class="danger" onclick="deleteEnvKey(\\'' +
              esc(k) +
              '\\')">删除</button></td>' +
              '</tr>'
          )
          .join('');
      } catch (err) {
        showToast('读取环境变量失败: ' + err.message, true);
      }
    }

    function toggleEnvReveal() {
      S.revealEnv = !S.revealEnv;
      const btn = document.getElementById('envRevealBtn');
      if (btn) btn.textContent = S.revealEnv ? '🙈 隐藏明文' : '👁️ 显示明文';
      loadEnv();
    }

    async function saveEnvKey() {
      const key = document.getElementById('envKeyInput').value.trim();
      const value = document.getElementById('envValInput').value;
      if (!key) {
        showToast('请填写环境变量名 KEY', true);
        return;
      }
      try {
        await api('/api/console/env', {
          method: 'POST',
          body: JSON.stringify({
            project: S.selectedProject,
            action: 'set',
            key,
            value,
          }),
        });
        document.getElementById('envKeyInput').value = '';
        document.getElementById('envValInput').value = '';
        showToast('✅ 已保存环境变量 ' + key);
        await loadEnv();
      } catch (err) {
        showToast('保存环境变量失败: ' + err.message, true);
      }
    }

    async function importBatchEnvText() {
      const box = document.getElementById('batchEnvTextarea');
      if (!box) return;
      const rawContent = box.value;
      if (!rawContent || !rawContent.trim()) {
        showToast('请粘贴至少一行 KEY=VALUE 内容', true);
        return;
      }
      try {
        const res = await api('/api/console/env', {
          method: 'POST',
          body: JSON.stringify({
            project: S.selectedProject,
            action: 'set-batch',
            rawContent,
          }),
        });
        box.value = '';
        document.getElementById('batchEnvBox').style.display = 'none';
        showToast('✅ 已批量导入并同步环境变量 (共 ' + res.count + ' 项)');
        await loadEnv();
      } catch (err) {
        showToast('批量导入失败: ' + err.message, true);
      }
    }

    async function deleteEnvKey(key) {
      try {
        await api('/api/console/env', {
          method: 'POST',
          body: JSON.stringify({
            project: S.selectedProject,
            action: 'rm',
            key,
          }),
        });
        showToast('🗑️ 已删除环境变量 ' + key);
        await loadEnv();
      } catch (err) {
        showToast('删除环境变量失败: ' + err.message, true);
      }
    }

    async function runDiff() {
      const base = document.getElementById('diffBaseSelect').value;
      const target = document.getElementById('diffTargetSelect').value;
      if (!base || !target) return;
      try {
        const res = await api(
          '/api/console/diff?base=' +
            encodeURIComponent(base) +
            '&target=' +
            encodeURIComponent(target)
        );
        const df = res.diff;
        const fLines = [];
        df.files.added.forEach((f) =>
          fLines.push('<div class="diff-item c-add">+ [新增] ' + esc(f.path) + ' (' + fmtBytes(f.size) + ')</div>')
        );
        df.files.modified.forEach((f) => {
          const sign = f.deltaBytes >= 0 ? '+' : '';
          fLines.push(
            '<div class="diff-item c-mod">~ [修改] ' +
              esc(f.path) +
              ' (' +
              sign +
              f.deltaBytes +
              ' B)</div>'
          );
        });
        df.files.deleted.forEach((f) =>
          fLines.push('<div class="diff-item c-del">- [删除] ' + esc(f.path) + '</div>')
        );
        fLines.push(
          '<div class="diff-item" style="color:var(--muted);">= 未变更复用块: ' +
            df.files.unchangedCount +
            ' 个文件</div>'
        );

        const fnLines = [];
        if (df.backend && df.backend.changed) {
          const bVer = df.backend.before ? 'SCF @v' + (df.backend.before.version || '$LATEST') : '无 SCF 后端';
          const aVer = df.backend.after ? 'SCF @v' + (df.backend.after.version || '$LATEST') : '无 SCF 后端';
          fnLines.push(
            '<div class="diff-item c-mod">🏭 [全栈后端变更] ' +
              esc(bVer) +
              ' → ' +
              esc(aVer) +
              '</div>'
          );
        }
        df.functions.added.forEach((fn) =>
          fnLines.push('<div class="diff-item c-add">+ [新增函数] ' + esc(fn.route) + ' [' + esc(fn.runtime) + ']</div>')
        );
        df.functions.modified.forEach((fn) =>
          fnLines.push('<div class="diff-item c-mod">~ [修改函数] ' + esc(fn.route) + ' (' + esc(fn.beforeRuntime) + ' -> ' + esc(fn.afterRuntime) + ')</div>')
        );
        df.functions.deleted.forEach((fn) =>
          fnLines.push('<div class="diff-item c-del">- [删除函数] ' + esc(fn.route) + '</div>')
        );
        fnLines.push(
          '<div class="diff-item" style="color:var(--muted);">= 未变更函数: ' +
            df.functions.unchangedCount +
            ' 个路由</div>'
        );

        const out = document.getElementById('diffResultArea');
        out.style.display = 'grid';
        out.innerHTML =
          '<div><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">静态文件变更 (' +
          esc(df.baseId) +
          ' → ' +
          esc(df.targetId) +
          ')</div><div class="diff-list">' +
          fLines.join('') +
          '</div></div>' +
          '<div><div style="font-size:12px;color:var(--muted);margin-bottom:6px;">全栈 SCF 后端 & 云函数路由变更</div><div class="diff-list">' +
          fnLines.join('') +
          '</div></div>';
      } catch (err) {
        showToast('Diff 对比失败: ' + err.message, true);
      }
    }

    function onGcOlderThanChange() {
      const olderThan = document.getElementById('gcOlderThanSelect').value;
      const keepInput = document.getElementById('gcKeepInput');
      if (olderThan) {
        keepInput.disabled = true;
        keepInput.style.opacity = '0.45';
        keepInput.title = '已启用按时间淘汰策略，将保留所有未过期的构建快照';
      } else {
        keepInput.disabled = false;
        keepInput.style.opacity = '1';
        keepInput.title = '';
      }
    }

    async function executeGcRequest(keepCount, olderThan, dryRun) {
      const box = document.getElementById('gcResultBox');
      box.textContent = '⏳ 正在扫描全局引用计数...';
      try {
        const res = await api('/api/console/gc', {
          method: 'POST',
          body: JSON.stringify({
            keepCount,
            olderThan: olderThan || null,
            dryRun,
          }),
        });
        const p = res.plan;
        box.innerHTML =
          (dryRun ? '<strong>[预检结果]</strong> ' : '<strong>[清理完成]</strong> ') +
          '过期快照: ' +
          p.expiredManifestsCount +
          ' 个 | 孤立块: ' +
          p.orphanBlobsCount +
          ' 个 | 孤立函数: ' +
          p.orphanFnsCount +
          ' 个';
        showToast(dryRun ? '🔍 GC 预检扫描完成' : '🧹 GC 垃圾回收已完成');
        if (!dryRun) await refreshAll();
      } catch (err) {
        box.textContent = 'GC 失败: ' + err.message;
        showToast('GC 失败: ' + err.message, true);
      }
    }

    async function runGc(dryRun) {
      const olderThan = document.getElementById('gcOlderThanSelect').value;
      const keepCount = olderThan
        ? 'all'
        : Number(document.getElementById('gcKeepInput').value || 10);

      if (dryRun) {
        await executeGcRequest(keepCount, olderThan, true);
        return;
      }

      askConfirmation({
        title: '🧹 确认执行全局 CAS 垃圾回收？',
        desc: '系统将自动保护所有活跃子域名正在指向的快照及其上一回滚版本，仅物理清理无任何引用的孤立文件块与过期快照。',
        confirmLabel: '🧹 立即清理释放配额',
        danger: true,
        onConfirm: () => executeGcRequest(keepCount, olderThan, false),
      });
    }

    // 主题切换 (Dark / Light)
    function toggleConsoleTheme() {
      if (!document.documentElement || !document.documentElement.classList) return;
      const isLight = document.documentElement.classList.toggle('light');
      try {
        localStorage.setItem('myship-console-theme', isLight ? 'light' : 'dark');
      } catch {}
    }

    // 键盘快捷键 (⌘K 快速跳转 / Escape 关闭抽屉或弹窗)
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeSnapshotDrawer();
          closeConfirmModal();
        }
      });
    }

    refreshAll();
  `;
}
