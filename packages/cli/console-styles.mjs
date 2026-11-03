/**
 * packages/cli/console-styles.mjs
 * MyShip Console 现代化双主题设计系统与工作区样式 (Workspace Tabs / Slide-Over Inspector / Modals / Terminal Logs)
 */

export const CONSOLE_STYLES = `
  :root {
    --bg: #070a12;
    --bg-subtle: #0d1320;
    --panel: #0f1726;
    --panel-alt: #162033;
    --panel-elevated: #131d31;
    --border: #1e293b;
    --border-strong: #334155;
    --specular: rgba(255, 255, 255, 0.06);
    --text: #f8fafc;
    --text-body: #cbd5e1;
    --muted: #94a3b8;
    --faint: #64748b;
    --accent: #38bdf8;
    --accent-soft: rgba(56, 189, 248, 0.12);
    --accent-border: rgba(56, 189, 248, 0.32);
    --success: #10b981;
    --success-soft: rgba(16, 185, 129, 0.12);
    --warn: #f59e0b;
    --warn-soft: rgba(245, 158, 11, 0.12);
    --danger: #ef4444;
    --danger-soft: rgba(239, 68, 68, 0.12);
    --purple: #a78bfa;
    --purple-soft: rgba(167, 139, 250, 0.14);
    --code-bg: #050811;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
    --shadow-md: 0 12px 32px -6px rgba(0, 0, 0, 0.55);
    --shadow-pop: 0 24px 52px -6px rgba(0, 0, 0, 0.75);
    --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: "Inter", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
  }

  html.light {
    --bg: #f8fafc;
    --bg-subtle: #f1f5f9;
    --panel: #ffffff;
    --panel-alt: #f1f5f9;
    --panel-elevated: #ffffff;
    --border: #e2e8f0;
    --border-strong: #cbd5e1;
    --specular: rgba(255, 255, 255, 0.9);
    --text: #090d16;
    --text-body: #334155;
    --muted: #64748b;
    --faint: #94a3b8;
    --accent: #0284c7;
    --accent-soft: rgba(2, 132, 199, 0.09);
    --accent-border: rgba(2, 132, 199, 0.28);
    --code-bg: #0b101b;
    --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
    --shadow-md: 0 10px 28px -6px rgba(15, 23, 42, 0.08);
    --shadow-pop: 0 20px 44px -6px rgba(15, 23, 42, 0.16);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 13.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Top Header */
  .top-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    height: 58px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 40;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.01em;
  }
  .brand-logo {
    width: 32px;
    height: 32px;
    border-radius: 8px;
    display: block;
    flex-shrink: 0;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    background: var(--panel-alt);
    color: var(--accent);
    border: 1px solid var(--border);
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
  }
  .badge.success { color: var(--success); background: var(--success-soft); border-color: rgba(16, 185, 129, 0.32); }
  .badge.warn { color: var(--warn); background: var(--warn-soft); border-color: rgba(245, 158, 11, 0.32); }
  .badge.danger { color: var(--danger); background: var(--danger-soft); border-color: rgba(239, 68, 68, 0.32); }
  .badge.purple { color: var(--purple); background: var(--purple-soft); border-color: rgba(167, 139, 250, 0.32); }

  /* Main 2-Column App Shell */
  .layout {
    display: grid;
    grid-template-columns: 260px minmax(0, 1fr);
    min-height: calc(100vh - 58px);
  }
  aside {
    border-right: 1px solid var(--border);
    background: var(--panel);
    padding: 18px 14px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 20px;
  }
  .side-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 4px 6px 8px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .proj-list {
    list-style: none;
    padding: 0;
    margin: 0 0 14px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .proj-btn {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-body);
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    transition: all 0.14s ease;
  }
  .proj-btn:hover { background: var(--panel-alt); color: var(--text); }
  .proj-btn.active {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--accent);
    font-weight: 600;
  }

  /* Main Workspace Content */
  main {
    padding: 22px 28px 56px;
    max-width: 1420px;
    width: 100%;
    margin: 0 auto;
  }

  /* Situational Awareness Banner */
  .project-hero-banner {
    background: linear-gradient(135deg, var(--panel) 0%, var(--bg-subtle) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 18px 22px;
    margin-bottom: 18px;
    box-shadow: var(--shadow-sm), inset 0 1px 0 var(--specular);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .project-hero-title {
    font-size: 19px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .project-hero-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    font-size: 12.5px;
    color: var(--muted);
  }

  /* Stats Grid */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 13px 16px;
    box-shadow: var(--shadow-sm);
  }
  .stat-label { color: var(--muted); font-size: 11.5px; font-weight: 500; }
  .stat-val { font-size: 20px; font-weight: 700; margin-top: 4px; font-family: var(--mono); font-variant-numeric: tabular-nums; }

  /* Workspace Navigation Tabs */
  .workspace-tabs {
    display: flex;
    align-items: center;
    gap: 6px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    padding-bottom: 10px;
    overflow-x: auto;
  }
  .ws-tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--muted);
    padding: 7px 14px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    white-space: nowrap;
    transition: all 0.15s ease;
  }
  .ws-tab:hover { color: var(--text); background: var(--panel-alt); }
  .ws-tab.active {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    color: var(--accent);
    font-weight: 600;
  }
  .ws-pane { display: none; }
  .ws-pane.active { display: block; }

  /* Cards & Tables */
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 18px 20px;
    margin-bottom: 18px;
    box-shadow: var(--shadow-sm);
  }
  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .card-title { font-size: 14.5px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg-subtle); }
  tbody tr:hover { background: var(--bg-subtle); }
  code, .mono {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-subtle);
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  /* Controls & Buttons */
  button, .btn {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.14s ease;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary {
    background: var(--accent);
    color: #062238;
    border-color: var(--accent);
    font-weight: 600;
  }
  button.primary:hover { opacity: 0.92; color: #062238; }
  button.danger {
    border-color: rgba(239, 68, 68, 0.4);
    color: #f87171;
    background: var(--danger-soft);
  }
  button.danger:hover { border-color: var(--danger); background: rgba(239, 68, 68, 0.22); }

  input, select, textarea {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 6px 10px;
    font-size: 12.5px;
    font-family: inherit;
    outline: none;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent);
  }
  .row-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

  /* Terminal Log Viewer */
  .log-terminal {
    background: var(--code-bg);
    border: 1px solid #1e293b;
    border-radius: var(--radius-md);
    padding: 14px 16px;
    font-family: var(--mono);
    font-size: 12px;
    color: #e2e8f0;
    max-height: 460px;
    overflow-y: auto;
    line-height: 1.6;
  }
  .log-entry {
    padding: 8px 10px;
    border-bottom: 1px dashed rgba(51, 65, 85, 0.5);
    border-radius: 6px;
  }
  .log-entry:hover { background: rgba(255, 255, 255, 0.03); }
  .log-entry.error { background: rgba(239, 68, 68, 0.08); border-left: 3px solid #ef4444; }
  .log-stack {
    margin-top: 6px;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 6px;
    color: #fca5a5;
    white-space: pre-wrap;
    font-size: 11.5px;
  }

  /* Diff Grid */
  .diff-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
  }
  .diff-list {
    max-height: 280px;
    overflow-y: auto;
    background: var(--bg-subtle);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--mono);
    font-size: 12px;
  }
  .diff-item { padding: 5px 0; border-bottom: 1px dashed var(--border); }
  .diff-item:last-child { border-bottom: none; }
  .c-add { color: #34d399; }
  .c-mod { color: #fbbf24; }
  .c-del { color: #f87171; }

  /* Right Slide-Over Snapshot Inspector Drawer */
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(7, 10, 18, 0.6);
    backdrop-filter: blur(3px);
    z-index: 80;
    display: none;
  }
  .drawer-backdrop.open { display: block; }
  .slide-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(560px, 92vw);
    background: var(--panel);
    border-left: 1px solid var(--border-strong);
    box-shadow: var(--shadow-pop);
    z-index: 85;
    transform: translateX(102%);
    transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    display: flex;
    flex-direction: column;
  }
  .slide-drawer.open { transform: translateX(0); }
  .drawer-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .drawer-body {
    padding: 18px 20px;
    overflow-y: auto;
    flex: 1;
  }

  /* Custom Confirmation & Command Modals */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(7, 10, 18, 0.65);
    backdrop-filter: blur(4px);
    z-index: 100;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .modal-backdrop.open { display: flex; }
  .modal-box {
    width: 100%;
    max-width: 480px;
    background: var(--panel);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    padding: 22px;
    box-shadow: var(--shadow-pop);
  }
  .modal-title { font-size: 16px; font-weight: 700; margin-bottom: 8px; }
  .modal-desc { font-size: 13px; color: var(--text-body); margin-bottom: 18px; line-height: 1.6; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 10px; }

  .toast {
    position: fixed;
    bottom: 22px;
    right: 24px;
    background: var(--panel-elevated);
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 10px 16px;
    border-radius: 10px;
    box-shadow: var(--shadow-pop);
    display: none;
    z-index: 150;
    max-width: 460px;
    font-weight: 500;
  }

  @media (max-width: 960px) {
    .layout { grid-template-columns: 1fr; }
    aside { border-right: none; border-bottom: 1px solid var(--border); }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .diff-grid { grid-template-columns: 1fr; }
  }
`;
