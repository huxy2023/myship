/**
 * packages/cli/console-ui.mjs — MyShip Web 可视化全栈管控台 (Zero-Dependency Modular Console UI)
 *
 * 模块职责划分：
 * - `./console-styles.mjs`: 双主题 CSS 设计系统 (Workspace Tabs / Slide-over Drawer / Terminal Logs / Poka-Yoke Modal)
 * - `./console-client.mjs`: 客户端状态机与交互控制器 (5 大正交工作区 Tab、SCF 日志流、云资源浏览器、3-Way Diff)
 * - `./console-ui.mjs`:     HTML 应用骨架组装器 (`renderConsoleHtml`)
 */
import { CONSOLE_STYLES } from './console-styles.mjs';
import { buildConsoleClientScript } from './console-client.mjs';
import { LOGO_SVG, FAVICON_SVG } from './brand.mjs';

export function renderConsoleHtml({
  modeLabel = '腾讯云 COS + EdgeOne',
  defaultProject = 'default',
} = {}) {
  const safeMode = String(modeLabel).replace(/[<>&"]/g, '');
  const safeProj = String(defaultProject).replace(/[<>&"]/g, '');
  const clientScript = buildConsoleClientScript(safeProj);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyShip Console — 自有云海，一令启航 | 全栈可视化部署、切流与云资源管控台</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}" />
  <style>${CONSOLE_STYLES}</style>
</head>
<body>
  <header class="top-header">
    <div class="brand" title="MyShip — 自有云海，一令启航 (Your Cloud. Your Fleet. One Command to Ship.)">
      <img class="brand-logo" src="data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}" alt="" width="32" height="32" />
      <span>MyShip Console</span>
      <span class="badge" id="modeBadge">${safeMode}</span>
      <span class="badge success" id="domainBadge">加载中...</span>
    </div>
    <div class="row-actions">
      <button onclick="toggleConsoleTheme()" title="切换深色 / 浅色外观">🌓 外观主题</button>
      <button class="primary" onclick="refreshAll()">🔄 刷新状态</button>
    </div>
  </header>

  <div class="layout">
    <aside>
      <div>
        <div class="side-title">
          <span>项目命名空间 (Projects)</span>
        </div>
        <ul class="proj-list" id="projectList"></ul>
        <div style="margin-bottom: 18px;">
          <button class="danger" style="width:100%;justify-content:center;" onclick="purgeCurrentProject()">
            🗑️ 彻底销毁当前选中项目
          </button>
        </div>
      </div>

      <div style="padding-top:14px;border-top:1px solid var(--border);">
        <div class="side-title">全局 CAS 垃圾回收 (GC)</div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <label style="font-size:12px; color:var(--muted); display:flex; justify-content:space-between; align-items:center;">
            <span>每项目保留版本数:</span>
            <input type="number" id="gcKeepInput" value="10" min="2" style="width:68px;" />
          </label>
          <label style="font-size:12px; color:var(--muted); display:flex; justify-content:space-between; align-items:center;">
            <span>按时间淘汰旧版:</span>
            <select id="gcOlderThanSelect" style="width:112px;" onchange="onGcOlderThanChange()">
              <option value="">不限时间</option>
              <option value="1d">1 天前 (1d)</option>
              <option value="7d">7 天前 (7d)</option>
              <option value="30d">30 天前 (30d)</option>
            </select>
          </label>
          <button style="justify-content:center;" onclick="runGc(true)">🔍 GC 扫描预检 (Dry-Run)</button>
          <button class="danger" style="justify-content:center;" onclick="runGc(false)">🧹 立即清理过期块与释放配额</button>
          <div id="gcResultBox" style="font-size:11.5px; color:var(--muted); line-height:1.5;"></div>
        </div>
      </div>
    </aside>

    <main>
      <!-- 项目态势感知横幅 -->
      <div class="project-hero-banner">
        <div>
          <div class="project-hero-title">
            <span>📦 项目工作区: <code id="statProject" style="font-size:16px;padding:3px 9px;">${safeProj}</code></span>
            <span class="badge" id="heroRuntimeBadge">检测中...</span>
          </div>
          <div class="project-hero-meta">
            <span>生产主域: <strong id="heroPrimaryUrl">-</strong></span>
            <span>·</span>
            <span>当前生效快照: <code id="heroLiveDpl">-</code></span>
          </div>
        </div>
        <div class="row-actions">
          <button onclick="switchWorkspaceTab('backend')">📋 查看云端日志</button>
          <button onclick="switchWorkspaceTab('resources')">🗄️ 浏览数据库与存储</button>
        </div>
      </div>

      <!-- 核心指标统计栏 -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">项目历史构建快照</div>
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
        <div class="stat-card">
          <div class="stat-label">原子切流与回滚延迟</div>
          <div class="stat-val" style="color:var(--success);">0 ms</div>
        </div>
      </div>

      <!-- 5 大正交工作区导航 Tab -->
      <div class="workspace-tabs">
        <button class="ws-tab active" data-ws-tab="deployments" onclick="switchWorkspaceTab('deployments')">
          🚀 部署快照与时间轴 (Deployments)
        </button>
        <button class="ws-tab" data-ws-tab="domains" onclick="switchWorkspaceTab('domains')">
          🌐 域名路由与切流 (Domains)
        </button>
        <button class="ws-tab" data-ws-tab="backend" onclick="switchWorkspaceTab('backend')">
          🏭 全栈后端与云端日志 (Backend &amp; Logs)
        </button>
        <button class="ws-tab" data-ws-tab="resources" onclick="switchWorkspaceTab('resources')">
          🗄️ 云资源与数据浏览 (Resources)
        </button>
        <button class="ws-tab" data-ws-tab="envs" onclick="switchWorkspaceTab('envs')">
          🔐 环境变量与版本对比 (Envs &amp; Diff)
        </button>
      </div>

      <!-- Tab 1: 部署快照与时间轴 -->
      <section class="ws-pane active" data-ws-pane="deployments">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">📦 历史构建版本快照时间轴 (manifests/*.json)</h2>
            <span style="font-size:12px; color:var(--muted);">点击「🔍 详情抽屉」可滑出查看快照文件树、边缘函数与 SCF 锁版本配置</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>版本 ID</th>
                <th>不可变快照预览域名</th>
                <th>静态文件 / 体积</th>
                <th>全栈计算模型</th>
                <th>构建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="manifestsTableBody"></tbody>
          </table>
        </div>
      </section>

      <!-- Tab 2: 域名路由与切流 -->
      <section class="ws-pane" data-ws-pane="domains">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">🌐 活跃子域名路由指针 (aliases/*.json)</h2>
            <div class="row-actions">
              <input type="text" id="customSubInput" placeholder="环境后缀 (如 staging / v2)" style="width:180px;" />
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
      </section>

      <!-- Tab 3: Phase 4 全栈后端与云端日志 -->
      <section class="ws-pane" data-ws-pane="backend">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">🏭 Phase 4 · 腾讯云 SCF 全栈 Node.js 后端态势</h2>
            <span class="badge purple">Immutable Version Locking</span>
          </div>
          <div id="backendStatusSummary"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">📋 云端实时运行日志与 SourceMap 源码堆栈还原 (myship logs)</h2>
            <div class="row-actions">
              <button id="btnToggleErrorLogs" onclick="toggleLogsErrorFilter()">🔍 仅看报错 (--error)</button>
              <button class="primary" onclick="loadProjectLogs()">🔄 刷新日志</button>
            </div>
          </div>
          <div class="log-terminal" id="logsTerminalBox"></div>
        </div>
      </section>

      <!-- Tab 4: Phase 5 云资源与数据浏览 -->
      <section class="ws-pane" data-ws-pane="resources">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">🗄️ Phase 5 · 声明式关系型数据库绑定 (myship use -> context.db)</h2>
            <button onclick="loadProjectResources()">🔄 刷新资源状态</button>
          </div>
          <div id="resourceDbSummary"></div>
        </div>

        <div class="diff-grid">
          <div class="card">
            <div class="card-header">
              <h2 class="card-title">📄 持久化 JSON 数据存储 (context.storage · data/&lt;project&gt;/*)</h2>
            </div>
            <div class="diff-list" id="resourceDataKeysList"></div>
          </div>

          <div class="card">
            <div class="card-header">
              <h2 class="card-title">🗂️ 二进制文件对象存储 (context.files · files/&lt;project&gt;/*)</h2>
            </div>
            <div class="diff-list" id="resourceFileKeysList"></div>
          </div>
        </div>
      </section>

      <!-- Tab 5: 环境变量与版本对比 -->
      <section class="ws-pane" data-ws-pane="envs">
        <div class="card">
          <div class="card-header">
            <div>
              <h2 class="card-title">🔐 项目私有环境变量管理 (envs/&lt;project&gt;.json)</h2>
              <div style="font-size:12px;color:var(--muted);margin-top:3px;">
                提示：边缘云函数 (<code>api/*.js</code>) 修改后立即生效；若项目使用 SCF 全栈后端，修改环境变量后请重新执行 <code>myship</code> 以冻结至新版本。
              </div>
            </div>
            <div class="row-actions">
              <input type="text" id="envKeyInput" placeholder="KEY (如 API_SECRET)" style="width:160px;" />
              <input type="text" id="envValInput" placeholder="VALUE" style="width:190px;" />
              <button class="primary" onclick="saveEnvKey()">💾 保存变量</button>
              <button onclick="document.getElementById('batchEnvBox').style.display = document.getElementById('batchEnvBox').style.display === 'none' ? 'block' : 'none'">📋 批量粘贴 .env</button>
              <button id="envRevealBtn" onclick="toggleEnvReveal()">👁️ 显示明文</button>
            </div>
          </div>

          <div id="batchEnvBox" style="display:none;margin-bottom:14px;padding:12px;background:var(--bg-subtle);border:1px solid var(--border);border-radius:8px;">
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">支持直接粘贴多行 <code>KEY=VALUE</code> 格式内容（自动忽略 # 注释行）：</div>
            <textarea id="batchEnvTextarea" rows="4" style="width:100%;font-family:var(--mono);margin-bottom:8px;" placeholder="DATABASE_URL=postgres://...\nJWT_SECRET=my_secret"></textarea>
            <div class="row-actions">
              <button class="primary" onclick="importBatchEnvText()">⚡ 批量导入并同步</button>
              <button onclick="document.getElementById('batchEnvBox').style.display='none'">取消</button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th>变量名 (Key)</th>
                <th>当前值 (默认掩码保护)</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="envTableBody"></tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-header">
            <h2 class="card-title">🔍 双版本全栈 Diff 对比器 (静态文件 + 边缘函数 + SCF 版本)</h2>
            <div class="row-actions">
              <span style="font-size:12px;color:var(--muted);">基准版本 (Base):</span>
              <select id="diffBaseSelect"></select>
              <span style="font-size:12px;color:var(--muted);">目标版本 (Target):</span>
              <select id="diffTargetSelect"></select>
              <button class="primary" onclick="runDiff()">⚖️ 对比版本差异</button>
            </div>
          </div>
          <div id="diffResultArea" class="diff-grid" style="display:none;"></div>
        </div>
      </section>
    </main>
  </div>

  <!-- 右侧滑出式构建快照详情抽屉 (Slide-over Inspector) -->
  <div class="drawer-backdrop" id="drawerBackdrop" onclick="closeSnapshotDrawer()"></div>
  <aside class="slide-drawer" id="snapshotDrawer">
    <div class="drawer-header">
      <div id="drawerTitle" style="font-weight:700;font-size:15px;">🔎 快照详情检查器</div>
      <button onclick="closeSnapshotDrawer()">✕ 关闭</button>
    </div>
    <div class="drawer-body" id="drawerBody"></div>
  </aside>

  <!-- 自定义防呆确认模态框 (Custom Confirmation Modal) -->
  <div class="modal-backdrop" id="confirmModal">
    <div class="modal-box">
      <div class="modal-title" id="confirmModalTitle">确认操作</div>
      <div class="modal-desc" id="confirmModalDesc"></div>
      <div class="modal-actions">
        <button onclick="closeConfirmModal()">取消</button>
        <button class="primary" id="confirmModalOkBtn" onclick="executeConfirmModal()">确认</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>${clientScript}</script>
</body>
</html>`;
}
