/**
 * apps/site/src/compiler/markdown-compiler.mjs
 * 增强型技术文档 Markdown 编译器 (支持构建期词法高亮、多类型语义 Callout、深层锚点检索与章节分页导览)
 */
import { escapeHtml, highlightCode, formatLanguageLabel } from './syntax-highlighter.mjs';

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~()[\]{}<>#!?:;,.\\/|+$^&=@"']/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function renderInlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/\$\\rightarrow\$/g, '→');
  out = out.replace(/\$\\times\$/g, '×');
  out = out.replace(/\$\\leftrightarrow\$/g, '↔');
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

function classifyCallout(quoteLines) {
  const firstLine = (quoteLines[0] || '').trim();
  const joined = quoteLines.join(' ');

  const gfmMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
  if (gfmMatch) {
    const rawType = gfmMatch[1].toUpperCase();
    const restFirst = gfmMatch[2];
    const bodyLines = restFirst ? [restFirst, ...quoteLines.slice(1)] : quoteLines.slice(1);
    if (rawType === 'TIP') return { variant: 'tip', label: '最佳实践 · TIP', bodyLines };
    if (rawType === 'IMPORTANT') return { variant: 'important', label: '核心设计 · IMPORTANT', bodyLines };
    if (rawType === 'WARNING' || rawType === 'CAUTION') return { variant: 'warning', label: '避坑提示 · WARNING', bodyLines };
    return { variant: 'note', label: '架构说明 · NOTE', bodyLines };
  }

  if (/⚠️|警告|切勿|严禁|避坑|注意：|破坏性/.test(joined)) {
    return { variant: 'warning', label: '关键注意 · Caveat', bodyLines: quoteLines };
  }
  if (/💡|提示|推荐|零配置|优势|黄金准则/.test(joined)) {
    return { variant: 'tip', label: '工程实践 · Pro Tip', bodyLines: quoteLines };
  }
  if (/核心法则|架构哲学|设计理念|重要/.test(joined)) {
    return { variant: 'important', label: '核心架构原则 · Key Principle', bodyLines: quoteLines };
  }
  return { variant: 'note', label: '说明 · Note', bodyLines: quoteLines };
}

function getCalloutIconSvg(variant) {
  if (variant === 'warning') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
  }
  if (variant === 'tip') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg>`;
  }
  if (variant === 'important') {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;
}

export function parseMarkdownDocument(rawMd, docId, prevDoc = null, nextDoc = null) {
  const lines = rawMd.replace(/\r\n/g, '\n').split('\n');
  const toc = [];
  const searchChunks = [];
  let html = '';
  let i = 0;
  let currentHeading = '概览';
  let currentHeadingId = '';
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
        交互式架构蓝图 · 支持滚轮缩放与拖拽平移
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
        const highlightedHtml = highlightCode(rawCode, lang);
        const langLabel = formatLanguageLabel(lang);
        const lineCount = codeLines.length;
        html += `
<div class="code-card">
  <div class="code-card-header">
    <div class="code-card-meta">
      <span class="code-lang-dot" data-lang="${escapeHtml(lang)}"></span>
      <span class="code-lang">${escapeHtml(langLabel)}</span>
      <span class="code-lines-badge">${lineCount} ${lineCount === 1 ? 'line' : 'lines'}</span>
    </div>
    <button type="button" class="copy-code-btn" data-copy-target="${codeId}">
      <svg class="copy-icon-default" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <svg class="copy-icon-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="display:none;color:#10b981;"><polyline points="20 6 9 17 4 12"/></svg>
      <span>复制代码</span>
    </button>
  </div>
  <pre class="code-pre"><code id="${codeId}" class="lang-${escapeHtml(lang)}">${highlightedHtml}</code></pre>
</div>`;
        searchChunks.push({
          heading: currentHeading,
          headingId: currentHeadingId,
          text: rawCode.slice(0, 200),
        });
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
      currentHeadingId = slug;

      if (level === 2 || level === 3) {
        toc.push({ level, title: plainTitle, id: slug });
      }
      html += `<h${level} id="${slug}" class="doc-h${level}"><a href="#/docs/${docId}#${slug}" class="heading-anchor" data-anchor-link="${slug}" title="点击复制本节永久链接">#</a><span>${renderInlineMarkdown(rawTitle)}</span></h${level}>\n`;
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
        headingId: currentHeadingId,
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
      const { variant, label, bodyLines } = classifyCallout(quoteLines);
      const iconSvg = getCalloutIconSvg(variant);
      html += `<div class="doc-callout callout-${variant}">
        <div class="doc-callout-icon">${iconSvg}</div>
        <div class="doc-callout-body">
          <div class="doc-callout-title">${escapeHtml(label)}</div>
          ${bodyLines.map((l) => `<p>${renderInlineMarkdown(l)}</p>`).join('')}
        </div>
      </div>\n`;
      searchChunks.push({
        heading: currentHeading,
        headingId: currentHeadingId,
        text: bodyLines.join(' '),
      });
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
        searchChunks.push({
          heading: currentHeading,
          headingId: currentHeadingId,
          text: m[3],
        });
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
    searchChunks.push({
      heading: currentHeading,
      headingId: currentHeadingId,
      text: paraText,
    });
  }

  // Append Prev / Next Chapter Pagination Footer
  if (prevDoc || nextDoc) {
    html += `<div class="doc-pager-grid">`;
    if (prevDoc) {
      html += `
      <button type="button" class="doc-pager-card prev" data-switch-doc="${prevDoc.id}">
        <span class="doc-pager-hint">← 上一章节 · Previous</span>
        <span class="doc-pager-title">${escapeHtml(prevDoc.title)}</span>
        <span class="doc-pager-cat">${escapeHtml(prevDoc.category)}</span>
      </button>`;
    } else {
      html += `<div class="doc-pager-spacer"></div>`;
    }
    if (nextDoc) {
      html += `
      <button type="button" class="doc-pager-card next" data-switch-doc="${nextDoc.id}">
        <span class="doc-pager-hint">下一章节 · Next →</span>
        <span class="doc-pager-title">${escapeHtml(nextDoc.title)}</span>
        <span class="doc-pager-cat">${escapeHtml(nextDoc.category)}</span>
      </button>`;
    }
    html += `</div>\n`;
  }

  return { html, toc, searchChunks };
}
