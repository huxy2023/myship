/**
 * apps/site/src/views/portal-view.mjs
 * MyShip 现代化门户视图组件 (Hero + 包管理器切换 + 交互式 0ms 指针沙盘 + Bento Grid 架构画廊 + 在线云函数实测)
 */

export function renderPortalView() {
  return `
  <main id="view-portal" class="view-section active">
    <section class="hero">
      <div class="hero-grid">
        <div>
          <div class="eyebrow">
            <span>⚓ 自有云海，一令启航 · Your Cloud. Your Fleet. One Command to Ship.</span>
          </div>
          <h1 class="hero-title">
            自有云海，一令启航。<br/>
            <span>10 分钟搭一套私人全栈云平台。</span>
          </h1>
          <p class="hero-desc">
            <strong>MyShip</strong> 是开源 BYOC 全栈部署与资源编排引擎。通过 <code>.myship/project.json</code> 自动隔离多项目命名空间，支持 SHA-256 块级去重、边缘与 SCF 双引擎后端、<code>myship use</code> 一键接入五大数据库及 0 秒原子回滚。
          </p>
          <div class="hero-actions">
            <button type="button" class="btn-primary" data-switch-doc="self-hosting">
              <span>10 分钟自建云底座指南 →</span>
            </button>
            <button type="button" class="btn-secondary" data-switch-doc="quickstart">
              <span>5 分钟 CLI 快速上手</span>
            </button>
            <a href="https://fullstack-starter.ship.onehub.top" target="_blank" rel="noopener" class="btn-secondary">
              <span>🌐 全栈在线样板间 ↗</span>
            </a>
          </div>

          <div class="pm-install-box">
            <div class="pm-tabs">
              <button type="button" class="pm-tab active" data-pm-cmd="npm i -g @myship/cli && myship login">npm (全局)</button>
              <button type="button" class="pm-tab" data-pm-cmd="pnpm add -g @myship/cli && myship login">pnpm</button>
              <button type="button" class="pm-tab" data-pm-cmd="npx @myship/cli login">npx (免安装)</button>
            </div>
            <div class="pm-cmd-row">
              <code><span class="tok-prompt">$</span> <span id="hero-pm-cmd-text">npm i -g @myship/cli &amp;&amp; myship login</span></code>
              <button type="button" class="pm-copy-btn" id="hero-copy-cmd" title="复制安装与登录命令">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                <span>复制</span>
              </button>
            </div>
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
              <button type="button" class="term-tab" data-term-tab="use">2. 声明式数据库</button>
              <button type="button" class="term-tab" data-term-tab="serverless">3. 全栈云函数</button>
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
          <div class="stat-label">前后端同帧原子切流与一键回滚（仅改写 80B JSON）</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">SHA-256</div>
          <div class="stat-label">跨版本、跨项目全局内容寻址去重存储池</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">5 大数据库</div>
          <div class="stat-label">myship use 交互式开通 CloudBase PG / Neon / Turso / D1 / MySQL</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">100% BYOC</div>
          <div class="stat-label">零平台固定月租，域名、存储、函数与数据库完全归属自己</div>
        </div>
      </div>

      <!-- Bento Grid 全栈架构画廊 -->
      <div class="section-head">
        <h2>🏗️ 核心工程支柱 (Architecture Bento Grid)</h2>
        <p>为什么一套运行在你自己腾讯云账号下的轻量化工具，能同时实现不可变多版本预览、0 秒原子回滚与全栈资源编排？</p>
      </div>

      <div class="bento-grid">
        <div class="bento-card bento-span-2">
          <div>
            <span class="bento-badge">PILLAR 01 · CAS SIX-NAMESPACE ENGINE</span>
            <h3>COS 六大正交命名空间与 SHA-256 全局块级去重</h3>
            <p>
              彻底摒弃传统按目录覆盖上传的做法。MyShip 将单个对象存储桶划分为 6 个严格隔离的正交命名空间：每次发布如果只改了 1 行 HTML，其余 99% 的 JS/CSS/字体资产直接零网络上传跳过。
            </p>
          </div>
          <div class="bento-visual">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;">
              <div><span class="tok-cmd">blobs/&lt;sha256&gt;</span> <span class="tok-cmt"># 全局去重静态块池</span></div>
              <div><span class="tok-cmd">manifests/dpl_*.json</span> <span class="tok-cmt"># 不可变构建快照树</span></div>
              <div><span class="tok-cmd">aliases/&lt;sub&gt;.json</span> <span class="tok-cmt"># 80B 毫秒级域名指针</span></div>
              <div><span class="tok-prop">envs/&lt;project&gt;.json</span> <span class="tok-cmt"># 私有环境变量密文</span></div>
              <div><span class="tok-fn">data/&lt;project&gt;/*</span> <span class="tok-cmt"># context.storage JSON/Blob</span></div>
              <div><span class="tok-fn">files/&lt;project&gt;/*</span> <span class="tok-cmt"># context.files 预签名直传</span></div>
            </div>
          </div>
        </div>

        <div class="bento-card">
          <div>
            <span class="bento-badge">PILLAR 02 · DUAL SERVERLESS</span>
            <h3>边缘 V8 + SCF 全栈双引擎</h3>
            <p>
              轻量接口直接放入 <code>api/*.js</code> 在全球 EdgeOne 边缘节点毫秒级响应；重度全栈后端放入 <code>server/</code>，自动通过 esbuild 打包并发布为腾讯云 SCF Web 函数<strong>不可变锁定版本（Version Locking）</strong>。
            </p>
          </div>
          <div class="bento-visual">
            <div><span class="tok-kw">Edge V8</span>: <code>api/hello.js</code> → <code>0ms Cold Start</code></div>
            <div style="margin-top:4px;"><span class="tok-fn">SCF Node20</span>: <code>server/index.mjs</code> → <code>$Version: 2</code></div>
          </div>
        </div>

        <div class="bento-card">
          <div>
            <span class="bento-badge">PILLAR 03 · DECLARATIVE RESOURCES</span>
            <h3><code>myship use</code> 五大数据库编排</h3>
            <p>
              一行命令自动完成建库/Schema 隔离与凭证下发。业务代码无需安装任何重型驱动，直接通过 <code>await context.db.query(sql, params)</code> 操作云端关系型数据库。
            </p>
          </div>
          <div class="bento-visual">
            <div>🐘 CloudBase PG · 🐘 Neon PG</div>
            <div style="margin-top:4px;">⚡ Turso libSQL · ☁️ CF D1 · 🐬 MySQL</div>
          </div>
        </div>

        <div class="bento-card bento-span-2">
          <div>
            <span class="bento-badge">PILLAR 04 · 100% LOCAL-CLOUD ISOMORPHISM</span>
            <h3><code>myship dev</code> 本地零配置 SQLite 与云端生产环境 100% 同构</h3>
            <p>
              本地执行 <code>myship dev</code> 时，即使断网或尚未配置云端数据库，MyShip 也会自动使用 Node.js 22+ 内置 <code>node:sqlite</code> 与本地目录模拟完整的 <code>context.db</code>、<code>context.storage</code> 与 <code>context.files</code>。代码一行不改，<code>myship</code> 直接上线。
            </p>
          </div>
          <div class="bento-visual">
            <code><span class="tok-kw">const</span> { rows } = <span class="tok-kw">await</span> context.db.<span class="tok-fn">query</span>(<span class="tok-str">'SELECT * FROM guestbook LIMIT 20'</span>); <span class="tok-cmt">// 本地 SQLite ↔ 云端 Turso/Neon/PG 同构运行</span></code>
          </div>
        </div>

        <div class="bento-card bento-span-2">
          <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div style="flex:1;min-width:260px;">
              <span class="bento-badge">PILLAR 05 · AI VIBECODING SKILL (myship-skill)</span>
              <h3>内置 AI 编程代理专属技能包：<code>myship skill install -g</code></h3>
              <p>
                面向 Google Antigravity、Claude Code、Cursor 等 AI 编程代理，随 CLI 内置渐进式披露 <code>SKILL.md</code> 与全栈参考手册（涵盖 <code>context.db</code> 跨引擎 SQL 占位符、<code>context.files.presignUrl</code> 预签名直传红线与 SCF 不可变快照规范），让 AI 在任意工程中零失误一次跑通全栈开发与上线。
              </p>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <a href="/skill/SKILL.md" target="_blank" class="btn-secondary" style="padding:7px 13px;font-size:0.8rem;text-decoration:none;">
                <span>📄 查看 SKILL.md ↗</span>
              </a>
              <a href="/llms.txt" target="_blank" class="btn-secondary" style="padding:7px 13px;font-size:0.8rem;text-decoration:none;">
                <span>🤖 查看 llms.txt ↗</span>
              </a>
            </div>
          </div>
          <div class="bento-visual">
            <code><span class="tok-prompt">$</span> myship skill install -g <span class="tok-cmt"># 一键注入 ~/.gemini/config/skills/myship-skill &amp; ~/.agents/skills/myship-skill</span></code>
          </div>
        </div>
      </div>

      <!-- 交互式 0ms 原子切流与全栈回滚沙盘 -->
      <div class="pointer-sandbox">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <span class="bento-badge" style="margin-bottom:6px;">INTERACTIVE SANDBOX · 0MS ATOMIC POINTER SWITCHING</span>
            <h2 style="font-family:'Familjen Grotesk',sans-serif;font-size:1.45rem;color:var(--text-strong);">
              🎛️ 亲手体验：为什么 MyShip 切流与回滚只需 0 毫秒？
            </h2>
            <p style="font-size:0.9rem;color:var(--text-soft);margin-top:4px;">
              点击下方任意历史构建快照或「模拟一键回滚」，观察右侧云端 80 字节指针 <code>aliases/app1.json</code> 如何同帧切换静态资产、边缘函数与 SCF 后端版本：
            </p>
          </div>
          <button type="button" class="btn-primary" id="btn-sim-rollback" style="padding:9px 16px;font-size:0.84rem;">
            <span>⏪ 模拟执行 myship rollback</span>
          </button>
        </div>

        <div class="pointer-sandbox-grid">
          <div class="dpl-selector-list" id="sandbox-dpl-list">
            <button type="button" class="dpl-option-btn active" data-sim-dpl="dpl_a09cea14">
              <div>
                <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:0.88rem;color:var(--text-strong);">
                  dpl_a09cea14 <span style="font-weight:400;color:var(--text-soft);font-size:0.78rem;">(最新全栈版 · 刚刚)</span>
                </div>
                <div style="font-size:0.79rem;color:var(--text-soft);margin-top:3px;">
                  📦 14 静态块 · 🏭 SCF <code>myship-app1@v2</code> · 🗄️ Turso DB + COS Files
                </div>
              </div>
              <span class="dpl-live-pill" data-sim-pill="dpl_a09cea14">LIVE 生产指针</span>
            </button>

            <button type="button" class="dpl-option-btn" data-sim-dpl="dpl_6e46ed99">
              <div>
                <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:0.88rem;color:var(--text-strong);">
                  dpl_6e46ed99 <span style="font-weight:400;color:var(--text-soft);font-size:0.78rem;">(上一稳定版 · 2 小时前)</span>
                </div>
                <div style="font-size:0.79rem;color:var(--text-soft);margin-top:3px;">
                  📦 12 静态块 · 🏭 SCF <code>myship-app1@v1</code> · 🗄️ Turso DB
                </div>
              </div>
              <span class="dpl-live-pill" data-sim-pill="dpl_6e46ed99" style="display:none;">LIVE 生产指针</span>
            </button>

            <button type="button" class="dpl-option-btn" data-sim-dpl="dpl_19c4b02f">
              <div>
                <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:0.88rem;color:var(--text-strong);">
                  dpl_19c4b02f <span style="font-weight:400;color:var(--text-soft);font-size:0.78rem;">(初始边缘版 · 昨天)</span>
                </div>
                <div style="font-size:0.79rem;color:var(--text-soft);margin-top:3px;">
                  📦 9 静态块 · ⚡ Edge V8 <code>api/hello.js</code> · 无重型后端
                </div>
              </div>
              <span class="dpl-live-pill" data-sim-pill="dpl_19c4b02f" style="display:none;">LIVE 生产指针</span>
            </button>
          </div>

          <div class="pointer-inspector" id="sandbox-pointer-inspector"></div>
        </div>
      </div>

      <!-- 在线实测：约定式边缘云函数 -->
      <div class="section-head" style="margin-top: 12px;">
        <h2>⚡ 在线实测：约定式边缘 Serverless 云函数 (<code>api/*.js</code>)</h2>
        <p>本门户站已内置 2 个真实运行在 EdgeOne 边缘节点的云函数（<code>api/hello.js</code> 与 <code>api/inspect.js</code>），点击下方按钮直接发起真实边缘请求：</p>
      </div>

      <div style="margin: 18px 0 56px; padding: 20px 24px; border-radius: var(--radius-md); border: 1px solid var(--accent-border); background: var(--bg-subtle); display: flex; flex-direction: column; gap: 14px;">
        <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="font-family: 'JetBrains Mono', monospace; font-size: 0.84rem; color: var(--text-strong); display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
            <span><span style="padding: 3px 8px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-weight: 700; margin-right: 6px;">FN 1</span><code>/api/hello</code></span>
            <span style="color: var(--text-faint);">|</span>
            <span><span style="padding: 3px 8px; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-weight: 700; margin-right: 6px;">FN 2</span><code>/api/inspect</code></span>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 10px;">
            <button type="button" class="btn-primary" id="btn-test-api-hello" style="padding: 8px 15px; font-size: 0.84rem;">
              <span>⚡ 调用 /api/hello</span>
            </button>
            <button type="button" class="btn-primary" id="btn-test-api-inspect" style="padding: 8px 15px; font-size: 0.84rem; background: var(--accent); color: #fff;">
              <span>🔍 调用 /api/inspect (EdgeOne 探针 + WebCrypto)</span>
            </button>
            <a href="/api/inspect?seed=live-check" target="_blank" rel="noopener" class="btn-secondary" style="padding: 8px 14px; font-size: 0.84rem; text-decoration: none;">
              <span>新窗口打开 JSON ↗</span>
            </a>
          </div>
        </div>
        <pre id="api-hello-output" style="padding: 14px 16px; border-radius: 8px; background: #080c15; color: #34d399; font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; overflow-x: auto; line-height: 1.55; border: 1px solid #1e293b;">// 点击上方「调用 /api/hello」或「调用 /api/inspect」查看实时返回的 JSON 与 X-MyShip-Function-Sha256 诊断头...</pre>
      </div>

      <!-- Keynote Video -->
      <div class="section-head" style="margin-top: 48px;">
        <h2>🎬 MyShip 产品发布与全景架构大片 (Keynote Video)</h2>
        <p>由 Remotion 编程级动态图形引擎 + 神经网络中文配音 + 120 BPM 原创电子合成器配乐打造，全景呈现 CAS 内容寻址、泛域名路由与全栈 Serverless 架构。</p>
      </div>

      <div style="margin: 24px 0 60px; border-radius: 22px; overflow: hidden; border: 1px solid rgba(56, 189, 248, 0.35); background: rgba(7, 11, 22, 0.9); box-shadow: 0 28px 70px rgba(0, 0, 0, 0.55), 0 0 40px rgba(56, 189, 248, 0.14);">
        <video
          controls
          preload="none"
          poster="/keynote-poster.jpg"
          src="/myship-promo.mp4"
          style="width: 100%; display: block; aspect-ratio: 16 / 9; background: #050811;"
        ></video>
      </div>

      <!-- 探索开源文档中心 -->
      <div class="section-head">
        <h2>📚 探索开源文档中心 (Documentation)</h2>
        <p>所有文档均支持 URL 深度链接（刷新保持位置）、语法高亮、交互式架构图缩放以及右上角一键复制 Markdown 给 LLM。</p>
      </div>

      <div class="feature-grid">
        <div class="feature-card" data-switch-doc="quickstart">
          <div>
            <span class="bento-badge">01 · QUICKSTART</span>
            <h3>📘 5 分钟快速上手</h3>
            <p>涵盖全局安装、多项目命名空间隔离、边缘与 SCF 全栈后端、myship use 声明式数据库与 0 秒回滚。</p>
          </div>
          <span style="font-size:0.8rem;font-weight:600;color:var(--accent);">阅读章节 →</span>
        </div>
        <div class="feature-card" data-switch-doc="self-hosting">
          <div>
            <span class="bento-badge">02 · BYOC GUIDE</span>
            <h3>🛠️ 自建云端底座指南</h3>
            <p>10 分钟完成 COS、DNSPod、EdgeOne 与 Serverless 数据库配置，含泛域名免费 HTTPS 证书避坑指南。</p>
          </div>
          <span style="font-size:0.8rem;font-weight:600;color:var(--accent);">阅读章节 →</span>
        </div>
        <div class="feature-card" data-switch-doc="architecture">
          <div>
            <span class="bento-badge">03 · ARCHITECTURE</span>
            <h3>🏗️ CAS 与全栈架构原理</h3>
            <p>深入剖析六大 COS 命名空间、SCF 不可变版本绑定以及本地与云端 100% 同构的数据库运行时。</p>
          </div>
          <span style="font-size:0.8rem;font-weight:600;color:var(--accent);">阅读章节 →</span>
        </div>
        <div class="feature-card" data-switch-doc="roadmap">
          <div>
            <span class="bento-badge">04 · BLUEPRINT</span>
            <h3>🧭 愿景与演进蓝图</h3>
            <p>三大 DX 黄金准则与五大工程支柱：CAS 去重、边缘 V8、SCF 全栈 Node.js 与声明式云资源编排。</p>
          </div>
          <span style="font-size:0.8rem;font-weight:600;color:var(--accent);">阅读章节 →</span>
        </div>
      </div>

      <section class="bento-card brand-story" aria-labelledby="mascot-title">
        <div>
          <span class="bento-badge">MEET SKIPPER</span>
          <h3 id="mascot-title">戴上纸船帽，一起出发。</h3>
          <p>这是 MyShip 的小海豹 Skipper。奶油色的身体、一顶小小的珊瑚橘纸船帽，陪你把做好的作品带到自己的云上。</p>
        </div>
        <img src="/mascot-skipper.png" alt="Skipper：戴着珊瑚橘纸船帽、微笑的小海豹" width="260" height="260" loading="lazy" />
      </section>
    </div>
  </main>`;
}
