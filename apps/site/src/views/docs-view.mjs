/**
 * apps/site/src/views/docs-view.mjs
 * MyShip 三栏技术文档阅读器视图组件 (含移动端抽屉菜单、Clarify AI 下拉操作与右侧实时滚动高亮 TOC)
 */
import { escapeHtml } from '../compiler/syntax-highlighter.mjs';

export function renderDocsView(parsedDocs) {
  return `
  <div id="view-docs" class="view-section">
    <!-- 移动端/窄屏专属顶部导航条 -->
    <div class="docs-mobile-bar">
      <button type="button" class="mobile-drawer-btn" id="btn-open-mobile-drawer">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <span>文档目录</span>
      </button>
      <span id="mobile-active-doc-label" style="font-size:0.82rem;font-weight:600;color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
      <button type="button" class="mobile-drawer-btn" data-switch-view="portal">
        <span>🏠 首页</span>
      </button>
    </div>

    <div class="mobile-drawer-backdrop" id="mobile-drawer-backdrop"></div>

    <div class="docs-layout">
      <aside class="docs-sidebar-left" id="docs-sidebar-left">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:0 10px 14px;margin-bottom:14px;border-bottom:1px solid var(--border);">
          <span style="font-size:0.78rem;font-weight:700;color:var(--text-strong);">📚 文档导航 · Docs</span>
          <button type="button" id="btn-close-mobile-drawer" style="border:none;background:transparent;color:var(--text-soft);cursor:pointer;font-size:0.8rem;padding:2px 6px;">✕</button>
        </div>
        ${parsedDocs
          .map(
            (doc) => `
        <div class="sidebar-group">
          <div class="sidebar-group-title">${escapeHtml(doc.category)}</div>
          <button type="button" class="sidebar-item" data-doc-nav="${doc.id}">
            <span>${escapeHtml(doc.shortTitle)}</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:0.68rem;opacity:0.75;">${escapeHtml(doc.badge)}</span>
          </button>
          <div class="sidebar-sublist" data-doc-sublist="${doc.id}">
            ${doc.toc
              .filter((t) => t.level === 2)
              .map(
                (t) =>
                  `<a href="#/docs/${doc.id}#${t.id}" class="sidebar-sublink" data-jump-doc="${doc.id}" data-jump-sec="${t.id}">${escapeHtml(t.title)}</a>`
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
        <div class="toc-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          <span>本页大纲 · On this page</span>
        </div>
        <ul class="toc-list" id="active-toc-list"></ul>
      </aside>
    </div>
  </div>`;
}
