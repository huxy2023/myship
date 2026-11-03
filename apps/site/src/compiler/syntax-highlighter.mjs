/**
 * apps/site/src/compiler/syntax-highlighter.mjs
 * 构建期零依赖词法着色器 (Build-Time Zero-Dependency Lexical Syntax Highlighter)
 *
 * 在构建静态站点时直接将代码块编译为语义化 Token (<span class="tok-*">)，
 * 配合 CSS 变量自动适配浅色与深色模式，浏览器端零运行时体积开销。
 */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const JS_KEYWORDS = new Set([
  'import', 'export', 'from', 'default', 'async', 'await', 'function',
  'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally',
  'throw', 'new', 'typeof', 'instanceof', 'in', 'of', 'class', 'extends',
  'true', 'false', 'null', 'undefined', 'void', 'delete',
]);

const JS_BUILTINS = new Set([
  'Response', 'Request', 'URL', 'Headers', 'TextEncoder', 'TextDecoder',
  'crypto', 'console', 'process', 'Buffer', 'JSON', 'Math', 'Date',
  'Promise', 'Map', 'Set', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'fetch', 'caches', 'context',
]);

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
  'DELETE', 'CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS', 'PRIMARY', 'KEY',
  'SERIAL', 'INTEGER', 'TEXT', 'VARCHAR', 'TIMESTAMPTZ', 'TIMESTAMP',
  'DEFAULT', 'NOW', 'CURRENT_TIMESTAMP', 'ORDER', 'BY', 'DESC', 'ASC',
  'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'INNER', 'ON', 'AS', 'AND', 'OR',
  'NULL', 'AUTOINCREMENT', 'AUTO_INCREMENT', 'RETURNING', 'DROP', 'ALTER',
  'INDEX', 'UNIQUE', 'SCHEMA',
]);

const BASH_COMMANDS = new Set([
  'myship', 'npm', 'npx', 'pnpm', 'node', 'curl', 'git', 'cd', 'mkdir',
  'cat', 'echo', 'export', 'cp', 'mv', 'rm', 'ls', 'tccli', 'wrangler',
  'turso', 'neonctl', 'psql', 'sqlite3',
]);

/**
 * 为单行 Bash / Shell 脚本进行词法高亮
 */
function highlightBashLine(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) {
    return `<span class="tok-cmt">${escapeHtml(line)}</span>`;
  }

  // 识别行首提示符 $ 或 >
  let prefixHtml = '';
  let rest = line;
  const promptMatch = line.match(/^(\s*)([$❯>])\s+(.*)$/);
  if (promptMatch) {
    prefixHtml = `${escapeHtml(promptMatch[1])}<span class="tok-prompt">${escapeHtml(promptMatch[2])}</span> `;
    rest = promptMatch[3];
  }

  // 分离行尾注释 (不在引号内的 #)
  let codePart = rest;
  let commentPart = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(rest[i - 1]))) {
      codePart = rest.slice(0, i);
      commentPart = rest.slice(i);
      break;
    }
  }

  // Tokenize codePart
  const tokenRegex = /("[^"]*"|'[^']*'|`[^`]*`|\$\{?[a-zA-Z0-9_]+\}?|--?[a-zA-Z0-9_-]+|https?:\/\/[^\s"']+|&&|\|\||\|>|>>?|[a-zA-Z0-9_./:@=-]+|\s+|.)/g;
  const rawTokens = codePart.match(tokenRegex) || [];
  let expectCommand = true;

  const colored = rawTokens
    .map((tok) => {
      if (/^\s+$/.test(tok)) return tok;
      if (tok === '&&' || tok === '||' || tok === '|' || tok === '>' || tok === '>>') {
        expectCommand = true;
        return `<span class="tok-op">${escapeHtml(tok)}</span>`;
      }
      if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
        expectCommand = false;
        return `<span class="tok-str">${escapeHtml(tok)}</span>`;
      }
      if (tok.startsWith('$')) {
        expectCommand = false;
        return `<span class="tok-var">${escapeHtml(tok)}</span>`;
      }
      if (tok.startsWith('-')) {
        expectCommand = false;
        return `<span class="tok-flag">${escapeHtml(tok)}</span>`;
      }
      if (/^https?:\/\//.test(tok)) {
        expectCommand = false;
        return `<span class="tok-url">${escapeHtml(tok)}</span>`;
      }
      if (/^[A-Z_][A-Z0-9_]*=/.test(tok)) {
        const eqIdx = tok.indexOf('=');
        const k = tok.slice(0, eqIdx);
        const v = tok.slice(eqIdx + 1);
        return `<span class="tok-prop">${escapeHtml(k)}</span>=<span class="tok-str">${escapeHtml(v)}</span>`;
      }
      if (expectCommand || BASH_COMMANDS.has(tok)) {
        expectCommand = false;
        if (BASH_COMMANDS.has(tok)) {
          return `<span class="tok-cmd">${escapeHtml(tok)}</span>`;
        }
        return `<span class="tok-fn">${escapeHtml(tok)}</span>`;
      }
      if (/^\d+(\.\d+)?$/.test(tok)) {
        return `<span class="tok-num">${escapeHtml(tok)}</span>`;
      }
      return escapeHtml(tok);
    })
    .join('');

  const commentHtml = commentPart ? `<span class="tok-cmt">${escapeHtml(commentPart)}</span>` : '';
  return prefixHtml + colored + commentHtml;
}

/**
 * 为 JSON 代码进行词法高亮
 */
function highlightJson(code) {
  const tokenRegex = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let lastIdx = 0;
  let out = '';
  let match;
  while ((match = tokenRegex.exec(code)) !== null) {
    out += escapeHtml(code.slice(lastIdx, match.index));
    const [full, strTok, colonPart, boolOrNull] = match;
    if (strTok) {
      if (colonPart) {
        out += `<span class="tok-prop">${escapeHtml(strTok)}</span>${escapeHtml(colonPart)}`;
      } else {
        out += `<span class="tok-str">${escapeHtml(strTok)}</span>`;
      }
    } else if (boolOrNull) {
      out += `<span class="tok-kw">${escapeHtml(boolOrNull)}</span>`;
    } else {
      out += `<span class="tok-num">${escapeHtml(full)}</span>`;
    }
    lastIdx = tokenRegex.lastIndex;
  }
  out += escapeHtml(code.slice(lastIdx));
  return out;
}

/**
 * 为 JS / TS / MJS / SQL 代码进行词法高亮
 */
function highlightJsOrSql(code, isSql = false) {
  const tokenRegex = isSql
    ? /(--[^\n]*|'[^']*'|"[^"]*"|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_][a-zA-Z0-9_]*\b)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_$][a-zA-Z0-9_$]*\b)/g;

  let lastIdx = 0;
  let out = '';
  let match;
  while ((match = tokenRegex.exec(code)) !== null) {
    out += escapeHtml(code.slice(lastIdx, match.index));
    const tok = match[0];

    if (tok.startsWith('//') || tok.startsWith('/*') || tok.startsWith('--')) {
      out += `<span class="tok-cmt">${escapeHtml(tok)}</span>`;
    } else if (tok.startsWith("'") || tok.startsWith('"') || tok.startsWith('`')) {
      out += `<span class="tok-str">${escapeHtml(tok)}</span>`;
    } else if (/^\d/.test(tok)) {
      out += `<span class="tok-num">${escapeHtml(tok)}</span>`;
    } else if (isSql) {
      if (SQL_KEYWORDS.has(tok.toUpperCase())) {
        out += `<span class="tok-kw">${escapeHtml(tok)}</span>`;
      } else {
        out += escapeHtml(tok);
      }
    } else {
      const nextChar = code[tokenRegex.lastIndex] || '';
      if (JS_KEYWORDS.has(tok)) {
        out += `<span class="tok-kw">${escapeHtml(tok)}</span>`;
      } else if (JS_BUILTINS.has(tok)) {
        out += `<span class="tok-builtin">${escapeHtml(tok)}</span>`;
      } else if (nextChar === '(') {
        out += `<span class="tok-fn">${escapeHtml(tok)}</span>`;
      } else {
        out += escapeHtml(tok);
      }
    }
    lastIdx = tokenRegex.lastIndex;
  }
  out += escapeHtml(code.slice(lastIdx));
  return out;
}

export function highlightCode(rawCode, lang = 'text') {
  const normalizedLang = (lang || 'text').toLowerCase().trim();
  if (['bash', 'sh', 'shell', 'zsh', 'console'].includes(normalizedLang)) {
    return rawCode
      .split('\n')
      .map((line) => highlightBashLine(line))
      .join('\n');
  }
  if (['json', 'jsonc'].includes(normalizedLang)) {
    return highlightJson(rawCode);
  }
  if (['js', 'javascript', 'mjs', 'cjs', 'ts', 'typescript'].includes(normalizedLang)) {
    return highlightJsOrSql(rawCode, false);
  }
  if (['sql', 'postgresql', 'sqlite', 'mysql'].includes(normalizedLang)) {
    return highlightJsOrSql(rawCode, true);
  }
  return escapeHtml(rawCode);
}

export function formatLanguageLabel(lang = 'text') {
  const map = {
    bash: 'Terminal · Bash',
    sh: 'Terminal · Shell',
    shell: 'Terminal · Shell',
    js: 'JavaScript (ESM)',
    javascript: 'JavaScript (ESM)',
    mjs: 'Node.js / ESM (.mjs)',
    ts: 'TypeScript',
    json: 'JSON Configuration',
    sql: 'SQL Schema / Query',
    html: 'HTML5',
    yaml: 'YAML Workflow',
    yml: 'YAML Workflow',
    text: 'Plaintext / Architecture',
  };
  const key = (lang || 'text').toLowerCase().trim();
  return map[key] || key.toUpperCase();
}
