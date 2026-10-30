#!/usr/bin/env node
/**
 * myship.mjs — 个人级极致 DX 部署与泛域名路由 CLI (BYOC 开源版)
 *
 * 核心特性：
 * 1. 项目级命名空间隔离 (.myship/project.json)：
 *    - 自动将不同项目 (如 app1、app2) 隔离到各自的域名前缀：
 *      app1 -> https://app1.ship.example.com, https://app1-v1.ship.example.com, https://app1-<hash>.ship.example.com
 *      app2 -> https://app2.ship.example.com, https://app2-v1.ship.example.com, https://app2-<hash>.ship.example.com
 *    - 在项目目录下执行 `myship ls` 默认只展示当前项目的版本与域名；加 `--all` 按项目分组展示全局总览。
 * 2. 极简命令语法：支持 `myship` (零参数自动部署)、`myship ./dist v1`、`myship rollback` (零参数回滚当前项目主域名)
 * 3. BYOC 自带云底座辅助：支持 `myship login`、`myship whoami` 与 `myship build-edge-fn` (一键生成注入个人 COS 地址的边缘函数)
 * 4. CAS 内容寻址去重 + 永久不可变快照 + 0 秒原子切流与回滚
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, extname, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  cosHeadObject,
  cosPutObject,
  cosGetJson,
  cosListKeys,
  getEffectiveEndpoints,
  assertCloudEndpointsConfigured,
  getAuthStatus,
  saveMyShipFileConfig,
  loadTencentCredentials,
  MYSHIP_CONFIG_PATH,
  MYSHIP_GLOBAL_EDGE_FN_PATH,
  probeEdgeGateway,
  deployEdgeFunctionToTeo,
} from './cos-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORAGE_DIR = resolve(__dirname, '.cas-storage');
const BASE_DOMAIN = process.env.SHIP_BASE_DOMAIN || 'ship.localhost:4100';

const MIME_MAP = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.md': 'text/plain; charset=UTF-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml; charset=UTF-8',
};

const BLOCKED_DIRS = new Set([
  '.git',
  '.myship',
  '.vercel',
  '.edgeone',
  '.ssh',
  '.tccli',
  'node_modules',
  '.cas-storage',
]);

function isSensitiveEntry(entryName) {
  const lower = entryName.toLowerCase();
  if (lower === '.ds_store' || lower === '.npmrc' || lower === '.netrc') return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.endsWith('.credential') ||
    lower.endsWith('.p12') ||
    lower.endsWith('.pfx')
  ) {
    return true;
  }
  if (lower === 'id_rsa' || lower === 'id_ed25519') return true;
  return false;
}

export function ensureMyShipGitignore(myshipDir) {
  mkdirSync(myshipDir, { recursive: true });
  const gitignorePath = resolve(myshipDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      '# Automatically created by MyShip CLI to prevent accidental leaks\n*\n!project.json\n!.gitignore\n',
      'utf8'
    );
  }
}

function ensureStorageDirs(storageDir) {
  mkdirSync(resolve(storageDir, 'blobs'), { recursive: true });
  mkdirSync(resolve(storageDir, 'manifests'), { recursive: true });
  mkdirSync(resolve(storageDir, 'aliases'), { recursive: true });
}

function walkFiles(dir, baseDir = dir, { excludeApiJs = true } = {}) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (BLOCKED_DIRS.has(entry)) {
      continue;
    }
    if (isSensitiveEntry(entry)) {
      if (entry !== '.DS_Store') {
        console.warn(`  🛡️  [安全防泄漏] 已自动拦截并跳过敏感文件: ${entry}`);
      }
      continue;
    }
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkFiles(full, baseDir, { excludeApiJs }));
    } else if (stat.isFile()) {
      const relPath = '/' + relative(baseDir, full).split('\\').join('/');
      if (
        excludeApiJs &&
        (relPath.startsWith('/api/') || relPath === '/api') &&
        (relPath.endsWith('.js') || relPath.endsWith('.mjs'))
      ) {
        continue;
      }
      results.push({ fullPath: full, relPath, size: stat.size });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ============================================================================
// Phase 2: 约定式 Serverless 云函数 (`api/*.js`) 扫描器与 ESM 编译器
// ============================================================================
export const MYSHIP_FUNCTIONS_POOL_PATH = resolve(
  dirname(MYSHIP_CONFIG_PATH),
  'functions-pool.json'
);

export function normalizeApiRoute(relApiFile) {
  let clean = String(relApiFile)
    .split('\\')
    .join('/')
    .replace(/^\/+/, '')
    .replace(/^api\/+/, '')
    .replace(/\.(mjs|js)$/i, '');
  if (clean === 'index' || clean === '') {
    return '/api';
  }
  if (clean.endsWith('/index')) {
    clean = clean.slice(0, -'/index'.length);
  }
  return `/api/${clean}`;
}

export function resolveApiDir(targetDir, cwd = process.cwd(), explicitApiDir = null) {
  if (explicitApiDir) {
    const absExplicit = resolve(cwd, explicitApiDir);
    if (existsSync(absExplicit) && statSync(absExplicit).isDirectory()) {
      return absExplicit;
    }
  }
  const inTarget = resolve(targetDir, 'api');
  if (existsSync(inTarget) && statSync(inTarget).isDirectory()) {
    return inTarget;
  }
  const inCwd = resolve(cwd, 'api');
  if (existsSync(inCwd) && statSync(inCwd).isDirectory()) {
    return inCwd;
  }
  return null;
}

export function scanApiFunctions(apiDir) {
  if (!apiDir || !existsSync(apiDir) || !statSync(apiDir).isDirectory()) {
    return [];
  }
  const rawFiles = walkFiles(apiDir, apiDir, { excludeApiJs: false }).filter(
    (f) => f.relPath.endsWith('.js') || f.relPath.endsWith('.mjs')
  );
  return rawFiles
    .map((f) => {
      const relSource = `api${f.relPath}`;
      const route = normalizeApiRoute(f.relPath);
      const sourceCode = readFileSync(f.fullPath, 'utf8');
      return {
        fullPath: f.fullPath,
        relSource,
        route,
        size: f.size,
        sourceCode,
      };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

const MAX_SINGLE_API_FN_BYTES = 512 * 1024; // 单文件最大 512 KB (保障远低于 EdgeOne 5MB 总包上限)
const MAX_PRECOMPILED_POOL_BYTES = Math.floor(3.5 * 1024 * 1024); // 预编译函数池总预算 3.5 MB (EdgeOne 边缘函数硬限制为 5 MB)

export function validateEdgeFunctionCompliance(sourceCode, label = 'api-fn', sizeBytes = 0) {
  const code = String(sourceCode || '');
  const actualBytes = sizeBytes || Buffer.byteLength(code, 'utf8');
  if (actualBytes > MAX_SINGLE_API_FN_BYTES) {
    throw new Error(
      `[EdgeOne 规范拦截] 云函数文件过大 (${label}: ${(actualBytes / 1024).toFixed(1)} KB > 512 KB)。腾讯云 EdgeOne 边缘函数单包上限为 5MB，请精简函数体积。`
    );
  }

  // 拦截 EdgeOne V8 运行时不支持的 Node.js 原生内置模块
  const nodeBuiltinMatch =
    code.match(/from\s+['"](?:node:[^'"]+|fs|path|http|https|net|tls|child_process|os|dgram|cluster)['"]/) ||
    code.match(/\brequire\s*\(\s*['"][^'"]+['"]\s*\)/) ||
    code.match(/\bfs\.(?:readFile|writeFile|readFileSync|writeFileSync|existsSync)\b/);

  if (nodeBuiltinMatch) {
    throw new Error(
      `[EdgeOne V8 规范拦截] 云函数 (${label}) 包含不支持的 Node.js API (${nodeBuiltinMatch[0].trim()})。腾讯云 EdgeOne 边缘函数运行在纯 V8 沙盒 (非 Node.js)，请改用 Web 标准 API (fetch / crypto.subtle / TextEncoder)。`
    );
  }

  const warnings = [];
  if (/\bprocess\.env\b/.test(code)) {
    warnings.push(
      `检测到 process.env (EdgeOne V8 推荐使用 context.env，网关已自动注入空 process.env 防崩垫片)`
    );
  }
  if (/\b(?:eval|new\s+Function)\s*\(/.test(code)) {
    warnings.push(`检测到 eval/new Function (EdgeOne V8 沙盒严格限制动态代码求值，建议移除)`);
  }
  if (/\bResponse\.json\s*\(/.test(code)) {
    warnings.push(`检测到 Response.json() (EdgeOne 原生 V8 未内置该方法，MyShip 网关已自动注入兼容 Polyfill)`);
  }
  return { ok: true, warnings };
}

export function transformEsmToFactorySource(sourceCode, label = 'api-fn', validate = false) {
  if (validate) {
    const { warnings } = validateEdgeFunctionCompliance(sourceCode, label);
    for (const w of warnings) {
      console.log(`  ⚠️  [EdgeOne 规范提示 · ${label}] ${w}`);
    }
  }
  const transformed = String(sourceCode)
    .replace(/export\s+default\s+async\s+function/g, '__exports.default = async function')
    .replace(/export\s+default\s+function/g, '__exports.default = function')
    .replace(/export\s+default\s+/g, '__exports.default = ')
    .replace(
      /export\s+async\s+function\s+([A-Za-z0-9_$]+)/g,
      '__exports.$1 = async function $1'
    )
    .replace(/export\s+function\s+([A-Za-z0-9_$]+)/g, '__exports.$1 = function $1')
    .replace(
      /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g,
      'const $1 = __exports.$1 ='
    );

  const factoryExpr = `(function() {\nconst __exports = {};\n${transformed}\nreturn __exports;\n})`;
  try {
    // 构建期静态语法校验，提前拦截函数语法错误
    new Function(`return ${factoryExpr};`);
  } catch (err) {
    throw new Error(`云函数语法解析失败 (${label}): ${err.message}`);
  }
  return factoryExpr;
}

export function compileServerlessModule(sourceCode, label = 'api-fn') {
  const factoryExpr = transformEsmToFactorySource(sourceCode, label);
  const factory = new Function(`return ${factoryExpr}();`);
  return factory();
}

export async function invokeServerlessModule(modExports, request, context = {}) {
  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoMethodKey = `onRequest${methodTitle}`;

  const baseHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-myship-engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
    'x-deployment-id': context.deploymentId || '',
    'x-myship-deployment-id': context.deploymentId || '',
    'x-subdomain-alias': context.subdomain || '',
    'x-myship-subdomain': context.subdomain || '',
    'x-myship-function-route': context.route || '',
    'x-myship-function-sha256': context.sha256 || '',
  };

  if (
    method === 'OPTIONS' &&
    typeof modExports?.OPTIONS !== 'function' &&
    typeof modExports?.onRequestOptions !== 'function'
  ) {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  let handler = null;
  let isEdgeOneContextFirst = false;

  if (modExports && typeof modExports[eoMethodKey] === 'function') {
    handler = modExports[eoMethodKey];
    isEdgeOneContextFirst = true;
  } else if (modExports && typeof modExports[method] === 'function') {
    handler = modExports[method];
  } else if (modExports && typeof modExports.onRequest === 'function') {
    handler = modExports.onRequest;
    isEdgeOneContextFirst = true;
  } else if (modExports && typeof modExports.default === 'function') {
    handler = modExports.default;
    if (handler.name && handler.name.startsWith('onRequest')) {
      isEdgeOneContextFirst = true;
    }
  } else if (modExports && typeof modExports.handler === 'function') {
    handler = modExports.handler;
  } else if (typeof modExports === 'function') {
    handler = modExports;
  }

  if (!handler) {
    return new Response(
      JSON.stringify({
        error: `Method ${method} Not Allowed or no default handler exported`,
        route: context.route,
        deploymentId: context.deploymentId,
      }),
      {
        status: 405,
        headers: { ...baseHeaders, 'content-type': 'application/json; charset=UTF-8' },
      }
    );
  }

  const enrichedContext = {
    request,
    params: {},
    env: {},
    eo: (request && request.eo) || {},
    geo: (request && request.eo && request.eo.geo) || {},
    clientIp: '127.0.0.1',
    waitUntil: () => {},
    functionSha256: context.sha256 || '',
    ...context,
  };

  try {
    const result = isEdgeOneContextFirst
      ? await handler(enrichedContext, request)
      : await handler(request, enrichedContext);
    if (result && typeof result === 'object' && typeof result.arrayBuffer === 'function' && result.headers) {
      const mergedHeaders = { ...baseHeaders };
      if (typeof result.headers.forEach === 'function') {
        result.headers.forEach((v, k) => {
          mergedHeaders[k] = v;
        });
      } else if (typeof result.headers === 'object') {
        Object.assign(mergedHeaders, result.headers);
      }
      return new Response(result.body, {
        status: result.status || 200,
        headers: mergedHeaders,
      });
    }
    if (typeof result === 'string') {
      return new Response(result, {
        status: 200,
        headers: { ...baseHeaders, 'content-type': 'text/plain; charset=UTF-8' },
      });
    }
    return new Response(JSON.stringify(result ?? { ok: true }), {
      status: 200,
      headers: { ...baseHeaders, 'content-type': 'application/json; charset=UTF-8' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err?.message || 'Internal Serverless Function Error',
        route: context.route,
        deploymentId: context.deploymentId,
      }),
      {
        status: 500,
        headers: { ...baseHeaders, 'content-type': 'application/json; charset=UTF-8' },
      }
    );
  }
}

export function loadLocalFunctionsPool() {
  try {
    if (existsSync(MYSHIP_FUNCTIONS_POOL_PATH)) {
      return JSON.parse(readFileSync(MYSHIP_FUNCTIONS_POOL_PATH, 'utf8')) || {};
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveLocalFunctionsPool(pool) {
  mkdirSync(dirname(MYSHIP_FUNCTIONS_POOL_PATH), { recursive: true });
  writeFileSync(MYSHIP_FUNCTIONS_POOL_PATH, JSON.stringify(pool, null, 2), 'utf8');
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function normalizeDomainToken(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeSubdomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const { remoteDomain } = getEffectiveEndpoints();
  if (remoteDomain && s.endsWith(`.${remoteDomain}`)) {
    s = s.slice(0, -(remoteDomain.length + 1));
  }
  if (s.endsWith(`.${BASE_DOMAIN}`)) {
    s = s.slice(0, -(BASE_DOMAIN.length + 1));
  }
  return s.split('.')[0];
}

// ============================================================================
// 项目级命名空间与配置探测器 (.myship/project.json)
// ============================================================================
export function detectProjectContext(cwd = process.cwd(), explicitProject = null) {
  const myshipDir = resolve(cwd, '.myship');
  const projectJsonPath = resolve(myshipDir, 'project.json');
  const legacyMyshipJson = resolve(cwd, '.myship.json');
  const pkgJsonPath = resolve(cwd, 'package.json');

  let savedCfg = null;
  let configSource = null;

  if (existsSync(projectJsonPath)) {
    try {
      savedCfg = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      configSource = '.myship/project.json';
    } catch {
      // ignore
    }
  } else if (existsSync(legacyMyshipJson)) {
    try {
      savedCfg = JSON.parse(readFileSync(legacyMyshipJson, 'utf8'));
      configSource = '.myship.json';
    } catch {
      // ignore
    }
  }

  let inferredName = explicitProject || savedCfg?.project || savedCfg?.domain || '';
  if (!inferredName && existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name) inferredName = pkg.name;
    } catch {
      // ignore
    }
  }
  if (!inferredName) {
    inferredName = basename(cwd);
  }
  const project = normalizeDomainToken(inferredName) || 'app';

  let buildDir = savedCfg?.dir || null;
  if (!buildDir) {
    const candidates = ['./dist', './build', './out', './public'];
    for (const c of candidates) {
      const abs = resolve(cwd, c);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        buildDir = c;
        break;
      }
    }
  }

  const prodDomain = normalizeDomainToken(savedCfg?.prodDomain || project) || project;

  return {
    project,
    buildDir: buildDir || './dist',
    prodDomain,
    hasSavedConfig: Boolean(savedCfg),
    configSource: configSource || '自动推断 (package.json / 目录名)',
    projectJsonPath,
    myshipDir,
  };
}

export function ensureProjectConfig(cwd = process.cwd(), overrides = {}) {
  const ctx = detectProjectContext(cwd, overrides.project);
  ensureMyShipGitignore(ctx.myshipDir);
  const payload = {
    project: overrides.project ? normalizeDomainToken(overrides.project) : ctx.project,
    dir: overrides.dir || ctx.buildDir || './dist',
    prodDomain: overrides.prodDomain
      ? normalizeDomainToken(overrides.prodDomain)
      : overrides.project
      ? normalizeDomainToken(overrides.project)
      : ctx.prodDomain,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(ctx.projectJsonPath, JSON.stringify(payload, null, 2), 'utf8');
  return { ...ctx, ...payload, hasSavedConfig: true, configSource: '.myship/project.json' };
}

function appendLocalProjectHistory(cwd, entry) {
  try {
    const myshipDir = resolve(cwd, '.myship');
    ensureMyShipGitignore(myshipDir);
    const historyPath = resolve(myshipDir, 'history.json');
    let list = [];
    if (existsSync(historyPath)) {
      list = JSON.parse(readFileSync(historyPath, 'utf8'));
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(entry);
    writeFileSync(historyPath, JSON.stringify(list.slice(0, 50), null, 2), 'utf8');
  } catch {
    // ignore non-critical local history write error
  }
}

export function resolveNamespacedSubdomain(rawSub, project, isRaw = false) {
  const cleanSub = normalizeSubdomain(rawSub);
  if (!cleanSub) return project || 'prod';
  if (isRaw || !project || project === 'default') return cleanSub;
  if (cleanSub === 'prod' || cleanSub === project) return project;
  if (cleanSub.startsWith(`${project}-`)) return cleanSub;
  return `${project}-${cleanSub}`;
}

export function inferProjectFromRecord(item, fallback = 'default') {
  if (item?.project) return item.project;
  const sub = item?.subdomain || item?.immutableSubdomain || '';
  if (sub && !sub.startsWith('dpl-') && sub.includes('-')) {
    return sub.split('-')[0];
  }
  return fallback;
}

// ============================================================================
// 1. 本地模式 CAS 引擎 (离线沙盒验证，含 Phase 2 api/*.js 全栈支持)
// ============================================================================
export function deployDirectory(
  targetDir,
  {
    storageDir = DEFAULT_STORAGE_DIR,
    aliases = [],
    project = 'default',
    cwd = process.cwd(),
    apiDir = null,
  } = {}
) {
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }
  ensureStorageDirs(storageDir);

  const files = walkFiles(absTarget);
  const resolvedApiDir = resolveApiDir(absTarget, cwd, apiDir);
  const apiFunctions = scanApiFunctions(resolvedApiDir);

  if (files.length === 0 && apiFunctions.length === 0) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};
  const manifestFunctions = {};

  for (const file of files) {
    const content = readFileSync(file.fullPath);
    const hash = sha256Hex(content);
    const blobPath = resolve(storageDir, 'blobs', hash);

    if (existsSync(blobPath)) {
      reusedBlobs++;
      console.log(`  ⚡ [CAS 命中跳过] ${file.relPath} (sha256: ${hash.slice(0, 10)}...)`);
    } else {
      writeFileSync(blobPath, content);
      uploadedBlobs++;
      console.log(`  ⬆️ [新块增量上传] ${file.relPath} -> blobs/${hash.slice(0, 10)}... (${file.size} B)`);
    }

    const ext = extname(file.relPath).toLowerCase();
    manifestFiles[file.relPath] = {
      sha256: hash,
      size: file.size,
      contentType: MIME_MAP[ext] || 'application/octet-stream',
    };
  }

  for (const fn of apiFunctions) {
    // 静态语法检查 + EdgeOne V8 规范校验 + ESM 转换验证
    transformEsmToFactorySource(fn.sourceCode, fn.relSource, true);
    const content = Buffer.from(fn.sourceCode, 'utf8');
    const hash = sha256Hex(content);
    const blobPath = resolve(storageDir, 'blobs', hash);

    if (existsSync(blobPath)) {
      reusedBlobs++;
      console.log(
        `  ⚡ [API 函数 CAS 复用] ${fn.route} (${fn.relSource}) (sha256: ${hash.slice(0, 10)}...)`
      );
    } else {
      writeFileSync(blobPath, content);
      uploadedBlobs++;
      console.log(
        `  ⚡ [API 函数新块写入] ${fn.route} (${fn.relSource}) -> blobs/${hash.slice(0, 10)}... (${fn.size} B)`
      );
    }

    manifestFunctions[fn.route] = {
      sha256: hash,
      entryBlob: hash,
      runtime: 'edge-js',
      size: fn.size,
      source: fn.relSource,
    };
  }

  const treeSignature = JSON.stringify({
    project,
    files: manifestFiles,
    functions: manifestFunctions,
    ts: Date.now(),
  });
  const shortHash = sha256Hex(Buffer.from(treeSignature)).slice(0, 8);
  const deploymentId = `dpl_${shortHash}`;
  const immutableSubdomain =
    project && project !== 'default' ? `${project}-${shortHash}` : `dpl-${shortHash}`;

  const manifest = {
    id: deploymentId,
    project,
    immutableSubdomain,
    createdAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      totalFunctions: apiFunctions.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
    functions: manifestFunctions,
  };

  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const boundUrls = [];
  const allSubdomains = new Set([immutableSubdomain, ...aliases.map(normalizeSubdomain)]);
  if (immutableSubdomain !== `dpl-${shortHash}`) {
    setAlias(`dpl-${shortHash}`, deploymentId, { storageDir, silent: true, project });
  }
  for (const sub of allSubdomains) {
    if (!sub) continue;
    setAlias(sub, deploymentId, { storageDir, silent: true, project });
    boundUrls.push(`http://${sub}.${BASE_DOMAIN}`);
  }

  console.log(`\n✅ 部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   资源统计: 静态文件 ${files.length} 个, 云函数 ${apiFunctions.length} 个 (新增块 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 访问地址: ${u}`);
  }
  for (const route of Object.keys(manifestFunctions)) {
    console.log(`   ⚡ 云函数路由: ${boundUrls[0] || ''}${route}`);
  }

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export function setAlias(
  subdomain,
  deploymentId,
  { storageDir = DEFAULT_STORAGE_DIR, silent = false, project = null } = {}
) {
  const cleanSub = normalizeSubdomain(subdomain);
  ensureStorageDirs(storageDir);
  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`目标部署版本不存在: ${deploymentId}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const effectiveProject = project || manifest.project || 'default';

  const aliasData = {
    subdomain: cleanSub,
    project: effectiveProject,
    deploymentId,
    updatedAt: new Date().toISOString(),
  };
  const aliasPath = resolve(storageDir, 'aliases', `${cleanSub}.json`);
  writeFileSync(aliasPath, JSON.stringify(aliasData, null, 2), 'utf8');

  if (!silent) {
    console.log(`🔗 域名别名已切换: http://${cleanSub}.${BASE_DOMAIN} -> ${deploymentId} (0 秒生效)`);
  }
  return aliasData;
}

export function listState({
  storageDir = DEFAULT_STORAGE_DIR,
  projectFilter = null,
  showAll = false,
} = {}) {
  ensureStorageDirs(storageDir);
  const blobs = readdirSync(resolve(storageDir, 'blobs'));
  const allManifests = readdirSync(resolve(storageDir, 'manifests'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'manifests', f), 'utf8')))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const allAliases = readdirSync(resolve(storageDir, 'aliases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'aliases', f), 'utf8')))
    .sort((a, b) => a.subdomain.localeCompare(b.subdomain));

  printFormattedState({
    modeLabel: '本地沙盒',
    domainSuffix: BASE_DOMAIN,
    protocol: 'http',
    blobsCount: blobs.length,
    allManifests,
    allAliases,
    projectFilter,
    showAll,
  });

  return { blobsCount: blobs.length, manifests: allManifests, aliases: allAliases };
}

// ============================================================================
// 2. 腾讯云 COS + EdgeOne 云端模式 (默认生产模式，含 Phase 2 api/*.js 全栈支持)
// ============================================================================
export async function deployRemoteDirectory(
  targetDir,
  { aliases = [], project = 'default', cwd = process.cwd(), apiDir = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }

  const files = walkFiles(absTarget);
  const resolvedApiDir = resolveApiDir(absTarget, cwd, apiDir);
  const apiFunctions = scanApiFunctions(resolvedApiDir);

  if (files.length === 0 && apiFunctions.length === 0) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  console.log(`☁️  正在向腾讯云 COS 执行 CAS 去重部署... [项目命名空间: ${project}]`);
  console.log(
    `📂 目标目录: ${absTarget} (静态文件: ${files.length} 个${
      apiFunctions.length > 0 ? `, Serverless 云函数: ${apiFunctions.length} 个` : ''
    })`
  );

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};
  const manifestFunctions = {};

  for (const file of files) {
    const content = readFileSync(file.fullPath);
    const hash = sha256Hex(content);
    const blobKey = `blobs/${hash}`;
    const ext = extname(file.relPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    const exists = await cosHeadObject(blobKey);
    if (exists) {
      reusedBlobs++;
      console.log(`  ⚡ [COS CAS 命中跳过] ${file.relPath} (sha256: ${hash.slice(0, 10)}...)`);
    } else {
      await cosPutObject(blobKey, content, contentType);
      uploadedBlobs++;
      console.log(`  ⬆️ [COS 新块上传] ${file.relPath} -> ${blobKey.slice(0, 16)}... (${file.size} B)`);
    }

    manifestFiles[file.relPath] = {
      sha256: hash,
      size: file.size,
      contentType,
    };
  }

  const localPool = loadLocalFunctionsPool();
  let newFunctionAdded = false;

  for (const fn of apiFunctions) {
    transformEsmToFactorySource(fn.sourceCode, fn.relSource, true);
    const content = Buffer.from(fn.sourceCode, 'utf8');
    const hash = sha256Hex(content);
    const blobKey = `blobs/${hash}`;
    const fnPoolKey = `functions/${hash}.json`;

    const exists = await cosHeadObject(blobKey);
    if (exists) {
      reusedBlobs++;
      console.log(
        `  ⚡ [COS 云函数 CAS 复用] ${fn.route} (${fn.relSource}) (sha256: ${hash.slice(0, 10)}...)`
      );
    } else {
      await cosPutObject(blobKey, content, 'application/javascript; charset=UTF-8');
      uploadedBlobs++;
      newFunctionAdded = true;
      console.log(
        `  ⬆️ [COS 云函数新块上传] ${fn.route} (${fn.relSource}) -> ${blobKey.slice(0, 16)}... (${fn.size} B)`
      );
    }

    if (!localPool[hash]) {
      newFunctionAdded = true;
      const fnRecord = {
        sha256: hash,
        project,
        route: fn.route,
        source: fn.relSource,
        code: fn.sourceCode,
        updatedAt: new Date().toISOString(),
      };
      localPool[hash] = fnRecord;
      await cosPutObject(fnPoolKey, JSON.stringify(fnRecord, null, 2), 'application/json; charset=UTF-8');
    }

    manifestFunctions[fn.route] = {
      sha256: hash,
      entryBlob: hash,
      runtime: 'edge-js',
      size: fn.size,
      source: fn.relSource,
    };
  }

  if (apiFunctions.length > 0) {
    saveLocalFunctionsPool(localPool);
  }

  const treeSignature = JSON.stringify({
    project,
    files: manifestFiles,
    functions: manifestFunctions,
    ts: Date.now(),
  });
  const shortHash = sha256Hex(Buffer.from(treeSignature)).slice(0, 8);
  const deploymentId = `dpl_${shortHash}`;
  const immutableSubdomain =
    project && project !== 'default' ? `${project}-${shortHash}` : `dpl-${shortHash}`;

  const manifest = {
    id: deploymentId,
    project,
    immutableSubdomain,
    createdAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      totalFunctions: apiFunctions.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
    functions: manifestFunctions,
  };

  await cosPutObject(
    `manifests/${deploymentId}.json`,
    JSON.stringify(manifest, null, 2),
    'application/json; charset=UTF-8'
  );

  // 若本次部署包含新的 Serverless 云函数块，自动重新构建全局边缘函数并热更新至 EdgeOne
  if (apiFunctions.length > 0 && newFunctionAdded) {
    try {
      const { code } = await syncCloudFunctionsPoolAndGenerateEdgeCode({ silent: true });
      const teoRes = await deployEdgeFunctionToTeo({ code, remoteDomain });
      console.log(
        `  ⚡ [EdgeOne 全栈同步] 已将云函数版本池 (${Object.keys(manifestFunctions).join(', ')}) 自动编译同步至边缘节点 (${teoRes.functionId})`
      );
    } catch (err) {
      console.log(
        `  ℹ️  [云函数提示] 已将云函数写入 COS CAS 池 (blobs/<sha256>)；如需同步预编译池至 EdgeOne 可运行 \`myship setup-edge\` (${err.message})`
      );
    }
  }

  const boundUrls = [];
  const allSubdomains = new Set([immutableSubdomain, ...aliases.map(normalizeSubdomain)]);
  for (const sub of allSubdomains) {
    if (!sub) continue;
    await setRemoteAlias(sub, deploymentId, { silent: true, skipVerify: true, project });
    boundUrls.push(`https://${sub}.${remoteDomain}`);
  }

  appendLocalProjectHistory(cwd, {
    id: deploymentId,
    project,
    immutableSubdomain,
    aliases: [...allSubdomains],
    urls: boundUrls,
    functions: Object.keys(manifestFunctions),
    createdAt: manifest.createdAt,
  });

  console.log(`\n✅ 云端部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   资源统计: 静态文件 ${files.length} 个, 云函数 ${apiFunctions.length} 个 (COS 新增上传 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 线上访问地址: ${u}`);
  }
  for (const route of Object.keys(manifestFunctions)) {
    const primaryUrl = boundUrls[boundUrls.length - 1] || boundUrls[0] || '';
    console.log(`   ⚡ 云函数接口:   ${primaryUrl}${route}`);
  }

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export async function setRemoteAlias(
  subdomain,
  deploymentId,
  { silent = false, skipVerify = false, project = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanSub = normalizeSubdomain(subdomain);
  let inferredProject = project;

  if (!skipVerify) {
    const manifest = await cosGetJson(`manifests/${deploymentId}.json`);
    if (!manifest) {
      throw new Error(`云端 COS 中不存在目标部署版本: ${deploymentId}`);
    }
    inferredProject = inferredProject || manifest.project || 'default';
  }

  const aliasData = {
    subdomain: cleanSub,
    project: inferredProject || inferProjectFromRecord({ subdomain: cleanSub }),
    deploymentId,
    updatedAt: new Date().toISOString(),
  };

  await cosPutObject(
    `aliases/${cleanSub}.json`,
    JSON.stringify(aliasData, null, 2),
    'application/json; charset=UTF-8'
  );

  if (!silent) {
    console.log(
      `🔗 云端域名别名已切换: https://${cleanSub}.${remoteDomain} -> ${deploymentId} (全球边缘 0 秒生效)`
    );
  }
  return aliasData;
}

export async function rollbackRemoteAlias(
  subdomain,
  targetDeploymentId = null,
  { project = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanSub = normalizeSubdomain(subdomain);
  const currentAlias = await cosGetJson(`aliases/${cleanSub}.json`);
  if (!currentAlias) {
    throw new Error(`未找到子域名 https://${cleanSub}.${remoteDomain} 的现有绑定记录`);
  }

  const currentDplId = currentAlias.deploymentId;
  const effectiveProject = project || currentAlias.project || null;

  if (targetDeploymentId) {
    if (targetDeploymentId === currentDplId) {
      console.log(`ℹ️  https://${cleanSub}.${remoteDomain} 当前已经指向 ${targetDeploymentId}`);
      return currentAlias;
    }
    console.log(
      `⏪ 正在将 https://${cleanSub}.${remoteDomain} 从 ${currentDplId} 回滚至指定版本 ${targetDeploymentId}...`
    );
    return setRemoteAlias(cleanSub, targetDeploymentId, { project: effectiveProject });
  }

  const manifestKeys = await cosListKeys('manifests/');
  const manifests = (
    await Promise.all(manifestKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const projectManifests = effectiveProject
    ? manifests.filter((m) => inferProjectFromRecord(m) === effectiveProject)
    : manifests;
  const pool = projectManifests.length >= 2 ? projectManifests : manifests;

  const currentIdx = pool.findIndex((m) => m.id === currentDplId);
  const previousManifest =
    currentIdx >= 0 && currentIdx + 1 < pool.length
      ? pool[currentIdx + 1]
      : pool.find((m) => m.id !== currentDplId);

  if (!previousManifest) {
    throw new Error(
      `当前仅有 1 个部署版本 (${currentDplId})，没有更早的历史版本可供回滚。`
    );
  }

  console.log(
    `⏪ 正在将 https://${cleanSub}.${remoteDomain} 从 ${currentDplId} 回滚至上一版本 ${previousManifest.id} (${previousManifest.createdAt})...`
  );
  return setRemoteAlias(cleanSub, previousManifest.id, { project: effectiveProject });
}

function printFormattedState({
  modeLabel,
  domainSuffix,
  protocol,
  blobsCount,
  allManifests,
  allAliases,
  projectFilter,
  showAll,
}) {
  if (!showAll && projectFilter) {
    const projManifests = allManifests.filter(
      (m) => inferProjectFromRecord(m) === projectFilter
    );
    const projDplIds = new Set(projManifests.map((m) => m.id));
    const projAliases = allAliases.filter(
      (a) =>
        a.project === projectFilter ||
        a.subdomain === projectFilter ||
        a.subdomain.startsWith(`${projectFilter}-`) ||
        projDplIds.has(a.deploymentId)
    );

    console.log(
      `=== 📦 当前项目命名空间: [${projectFilter}] (${modeLabel}全局 CAS 唯一块: ${blobsCount} 个) ===`
    );
    console.log(`\n=== 🚀 [${projectFilter}] 历史构建部署列表 (${projManifests.length} 个) ===`);
    if (projManifests.length === 0) {
      console.log(`  (当前项目 [${projectFilter}] 尚无部署记录，直接运行 \`myship\` 即可发布第一版)`);
    } else {
      for (const m of projManifests) {
        const fnRoutes = m.functions ? Object.keys(m.functions) : [];
        const fnSummary =
          fnRoutes.length > 0 ? ` | 云函数:${fnRoutes.length} (${fnRoutes.join(', ')})` : '';
        console.log(
          `  - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles}${fnSummary} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
        );
      }
    }

    console.log(`\n=== 🌐 [${projectFilter}] 线上子域名路由映射表 (${projAliases.length} 个) ===`);
    if (projAliases.length === 0) {
      console.log(`  (当前项目 [${projectFilter}] 尚无子域名映射)`);
    } else {
      for (const a of projAliases) {
        console.log(`  - ${protocol}://${a.subdomain}.${domainSuffix}  -->  ${a.deploymentId}`);
      }
    }
    console.log(
      `\n💡 提示: 默认仅展示当前项目 [${projectFilter}] 的记录；如需查看所有项目汇总，请执行 \`myship ls --all\`。`
    );
    return;
  }

  console.log(`=== ☁️  ${modeLabel} CAS 存储池 (全局唯一文件块: ${blobsCount} 个) ===`);
  const projects = new Map();

  function ensureBucket(proj) {
    if (!projects.has(proj)) {
      projects.set(proj, { manifests: [], aliases: [] });
    }
    return projects.get(proj);
  }

  const dplToProject = new Map();
  for (const m of allManifests) {
    const p = inferProjectFromRecord(m, 'default');
    dplToProject.set(m.id, p);
    ensureBucket(p).manifests.push(m);
  }
  for (const a of allAliases) {
    const p = a.project || dplToProject.get(a.deploymentId) || inferProjectFromRecord(a, 'default');
    ensureBucket(p).aliases.push(a);
  }

  const sortedProjectNames = [...projects.keys()].sort((a, b) => {
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return a.localeCompare(b);
  });

  for (const proj of sortedProjectNames) {
    const group = projects.get(proj);
    const title = proj === 'default' ? '未分类 / 全局部署 (default)' : `项目命名空间: [${proj}]`;
    console.log(`\n📦 ${title}`);
    console.log(`  🚀 历史构建版本 (${group.manifests.length} 个):`);
    for (const m of group.manifests) {
      const fnRoutes = m.functions ? Object.keys(m.functions) : [];
      const fnSummary =
        fnRoutes.length > 0 ? ` | 云函数:${fnRoutes.length} (${fnRoutes.join(', ')})` : '';
      console.log(
        `     - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles}${fnSummary} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
      );
    }
    console.log(`  🌐 绑定域名列表 (${group.aliases.length} 个):`);
    for (const a of group.aliases) {
      console.log(`     - ${protocol}://${a.subdomain}.${domainSuffix}  -->  ${a.deploymentId}`);
    }
  }
}

export async function listRemoteState({ projectFilter = null, showAll = false } = {}) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const [blobKeys, manifestKeys, aliasKeys] = await Promise.all([
    cosListKeys('blobs/'),
    cosListKeys('manifests/'),
    cosListKeys('aliases/'),
  ]);

  const allManifests = (
    await Promise.all(manifestKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const allAliases = (
    await Promise.all(aliasKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => a.subdomain.localeCompare(b.subdomain));

  printFormattedState({
    modeLabel: '腾讯云 COS',
    domainSuffix: remoteDomain,
    protocol: 'https',
    blobsCount: blobKeys.length,
    allManifests,
    allAliases,
    projectFilter,
    showAll,
  });

  return { blobsCount: blobKeys.length, manifests: allManifests, aliases: allAliases };
}

// ============================================================================
// 3. 边缘函数代码生成器 (`myship build-edge-fn`) 与交互式登录 (`myship login`)
// ============================================================================
function buildPrecompiledFunctionsBlock(functionsPool = {}) {
  const entries = [];
  let usedBytes = 0;

  // 按更新时间倒序排列，优先保障最新活跃版本的云函数驻留，严格限制总体积不超过 3.5 MB (EdgeOne 单函数硬上限 5 MB)
  const sortedItems = Object.entries(functionsPool).sort(([, a], [, b]) => {
    const ta = a && a.updatedAt ? String(a.updatedAt) : '';
    const tb = b && b.updatedAt ? String(b.updatedAt) : '';
    return tb.localeCompare(ta);
  });

  for (const [sha256, item] of sortedItems) {
    if (!item || !item.code) continue;
    try {
      const factoryExpr = transformEsmToFactorySource(
        item.code,
        item.source || item.route || sha256.slice(0, 8),
        false
      );
      const line = `  "${sha256}": ${factoryExpr}(),`;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (usedBytes + lineBytes > MAX_PRECOMPILED_POOL_BYTES) {
        console.warn(
          `  ⚠️  [EdgeOne 5MB 容量水位线保护] 预编译云函数池已达 3.5MB 安全阈值，自动跳过早期历史版本块 (${sha256.slice(0, 8)}...)`
        );
        continue;
      }
      entries.push(line);
      usedBytes += lineBytes;
    } catch {
      // ignore invalid legacy pool item
    }
  }
  return entries.join('\n');
}

export async function syncCloudFunctionsPoolAndGenerateEdgeCode({
  cosOrigin,
  outputPath,
  silent = false,
} = {}) {
  const localPool = loadLocalFunctionsPool();
  try {
    const fnKeys = await cosListKeys('functions/');
    for (const key of fnKeys) {
      if (!key.endsWith('.json')) continue;
      const hash = basename(key, '.json');
      if (!localPool[hash]) {
        const remoteItem = await cosGetJson(key);
        if (remoteItem && remoteItem.code) {
          localPool[hash] = remoteItem;
        }
      }
    }
    saveLocalFunctionsPool(localPool);
  } catch {
    // 若离线或无权限列出 functions/，直接使用本地缓存池
  }
  return generateEdgeFunctionCode({ cosOrigin, outputPath, silent, functionsPool: localPool });
}

export function generateEdgeFunctionCode({
  cosOrigin,
  outputPath,
  silent = false,
  functionsPool = null,
} = {}) {
  const effective = getEffectiveEndpoints();
  const targetCosOrigin = (cosOrigin || effective.cosOrigin || '').replace(/\/$/, '');
  if (!targetCosOrigin) {
    throw new Error(
      '尚未配置 COS_ORIGIN！请先运行 `myship login` 或通过环境变量 COS_ORIGIN="https://myship-1250000000.cos.ap-guangzhou.myqcloud.com" 指定。'
    );
  }

  const pool = functionsPool || loadLocalFunctionsPool();
  const precompiledBlock = buildPrecompiledFunctionsBlock(pool);

  const templatePath = resolve(__dirname, '../edge-gateway/edgeone-function.template.js');
  const templateContent = readFileSync(templatePath, 'utf8');
  const rendered = templateContent
    .replace(/__MYSHIP_COS_ORIGIN__/g, targetCosOrigin)
    .replace('/* __MYSHIP_PRECOMPILED_FUNCTIONS__ */', precompiledBlock);

  // 全局边缘函数属于用户云底座全局设施（1 个云函数服务全部项目），默认存放在 ~/.myship/edgeone-function.dist.js，绝不污染具体业务项目目录
  const outFile = outputPath ? resolve(outputPath) : MYSHIP_GLOBAL_EDGE_FN_PATH;
  mkdirSync(dirname(outFile), { recursive: true });
  if (basename(dirname(outFile)) === '.myship' && dirname(outFile) !== dirname(MYSHIP_CONFIG_PATH)) {
    ensureMyShipGitignore(dirname(outFile));
  }
  writeFileSync(outFile, rendered, 'utf8');

  if (!silent) {
    const fnCount = Object.keys(pool).length;
    console.log(`✅ 已生成全局 EdgeOne 边缘函数代码 (全账号仅需 1 个函数，所有项目共享):`);
    console.log(`   📄 全局路径: ${outFile}`);
    console.log(`   ☁️  绑定 COS: ${targetCosOrigin}`);
    if (fnCount > 0) {
      console.log(`   ⚡ 内置预编译云函数版本块: ${fnCount} 个 (0ms 原生 V8 执行)`);
    }
  }
  return { outFile, targetCosOrigin, code: rendered };
}

async function promptAndDeployEdgeFunction({ cosOrigin, remoteDomain, rlExternal = null } = {}) {
  const { outFile, code } = await syncCloudFunctionsPoolAndGenerateEdgeCode({
    cosOrigin,
    silent: false,
  });
  const effective = getEffectiveEndpoints();
  const domain = remoteDomain || effective.remoteDomain || 'ship.example.com';

  const rl = rlExternal || createInterface({ input: process.stdin, output: process.stdout });
  const ans = (
    await rl.question(
      `\n👉 是否现在直接将该全局边缘函数自动上传并部署到腾讯云 EdgeOne？[Y/n (直接回车立即上传)]: `
    )
  )
    .trim()
    .toLowerCase();
  if (!rlExternal) {
    rl.close();
  }

  if (!ans || ans === 'y' || ans === 'yes') {
    try {
      console.log('☁️  正在通过腾讯云 EdgeOne API 自动匹配站点并上传边缘函数...');
      const res = await deployEdgeFunctionToTeo({ code, remoteDomain: domain });
      console.log(
        `🎉 全局边缘函数自动部署成功！[${res.actionTaken === 'created' ? '新建' : '更新'}] 站点: ${
          res.zoneName
        } (${res.zoneId}) -> 函数 ID: ${res.functionId}`
      );
      return res;
    } catch (err) {
      console.log(`\n⚠️  自动上传边缘函数未完成: ${err.message}`);
      console.log(`   💡 提示：若你当前使用的是仅含 COS 最小权限的子账号密钥，可任选以下方式完成首次边缘函数部署：`);
      console.log(`   • 方式 A (控制台粘贴 1 次即可)：复制 ${outFile} 内容粘贴至 EdgeOne 控制台【边缘函数】`);
      console.log(`   • 方式 B (临时用 tccli 扫码权限上传)：运行 tccli auth login 后再次执行 myship setup-edge`);
      return null;
    }
  } else {
    console.log(`\n💡 你随时可以运行 \`myship setup-edge\` 自动上传，或手动将 ${outFile} 粘贴至 EdgeOne 控制台。`);
    return null;
  }
}

async function interactiveLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const currentEndpoints = getEffectiveEndpoints();
  const status = getAuthStatus();

  console.log('==============================================================');
  console.log('🔐 MyShip 跨设备认证与自有云底座 (BYOC) 配置向导');
  console.log('   配置文件将安全保存在 ~/.myship/config.json (权限 0600)');
  console.log('==============================================================');

  let secretId = '';
  let secretKey = '';
  let reuseExistingCred = false;

  if (status.authenticated) {
    console.log(`\n✅ 检测到本机已有可用凭证: ${status.maskedSecretId}`);
    console.log(`   🔑 凭证来源: ${status.source}`);
    const reuseAns = (
      await rl.question('👉 是否直接复用该凭证（跳过密钥输入）？[Y/n]: ')
    )
      .trim()
      .toLowerCase();
    if (!reuseAns || reuseAns === 'y' || reuseAns === 'yes') {
      reuseExistingCred = true;
    }
  }

  if (!reuseExistingCred) {
    console.log('\n--------------------------------------------------------------');
    console.log('🔑 请选择腾讯云认证方式（二选一）：\n');
    console.log('  [1] 方式一：使用 CAM 子账号 API 密钥 (跨电脑零依赖，推荐)');
    console.log('      🛡️  最小权限安全指引：');
    console.log('         • MyShip 日常发包/切流/回滚【仅读写 COS 对象存储】，不触碰其他云资源');
    console.log('         • 前往腾讯云控制台【访问管理 CAM -> 用户 -> 新建子用户】：');
    console.log('           https://console.cloud.tencent.com/cam/user');
    console.log('         • 勾选“编程访问”，日常部署仅需授予 1 项最小权限策略：');
    console.log('           👉 QcloudCOSDataFullControl (对象存储 COS 数据读写权限)\n');
    console.log('  [2] 方式二：使用腾讯云官方 tccli 浏览器扫码登录 (免建静态密钥，自动续期)');
    console.log('      💡 适合已安装 tccli (pip install tccli) 的电脑，扫码后 MyShip 自动复用');
    console.log('--------------------------------------------------------------');

    const modeAns = (await rl.question('请选择认证方式 [1/2，直接回车默认 1]: ')).trim();

    if (modeAns === '2') {
      const checkTccli = spawnSync('tccli', ['--version'], { stdio: 'ignore' });
      if (checkTccli.status === 0) {
        console.log('\n🌐 正在唤起 `tccli auth login` 浏览器扫码授权...');
        rl.pause();
        const loginRes = spawnSync('tccli', ['auth', 'login'], { stdio: 'inherit' });
        rl.resume();
        if (loginRes.status !== 0) {
          rl.close();
          throw new Error('tccli auth login 未完成，请重试或改选方式 [1] 输入密钥。');
        }
        console.log('✅ tccli 扫码登录成功！MyShip 将自动复用 ~/.tccli/default.credential。');
      } else {
        console.log('\n⚠️  未在本机检测到 `tccli` 命令。');
        console.log('   • 如需使用扫码登录，请先执行: pip install tccli && tccli auth login');
        console.log('   • 或现在直接切换为【方式 1】输入 CAM 子账号 SecretId / SecretKey：\n');
        secretId = (await rl.question('1. 请输入腾讯云 SecretId: ')).trim();
        secretKey = (await rl.question('2. 请输入腾讯云 SecretKey: ')).trim();
      }
    } else {
      secretId = (
        await rl.question('\n1. 请输入腾讯云 SecretId (仅需 QcloudCOSDataFullControl 权限): ')
      ).trim();
      secretKey = (await rl.question('2. 请输入腾讯云 SecretKey: ')).trim();
    }
  }

  console.log('\n--------------------------------------------------------------');
  console.log('☁️  配置你的自有云底座地址 (可在已配置电脑上运行 `myship whoami` 查看)');
  console.log('--------------------------------------------------------------');
  const cosDefault =
    currentEndpoints.cosOrigin || 'https://myship-1250000000.cos.ap-guangzhou.myqcloud.com';
  const cosOriginInput = (
    await rl.question(`3. 你的 COS 存储桶地址 [默认: ${cosDefault}]: `)
  ).trim();
  const domainDefault = currentEndpoints.remoteDomain || 'ship.example.com';
  const remoteDomainInput = (
    await rl.question(`4. 你的泛域名后缀 [默认: ${domainDefault}]: `)
  ).trim();

  const patch = {
    cosOrigin: (cosOriginInput || cosDefault).replace(/\/$/, ''),
    remoteDomain: (remoteDomainInput || domainDefault).replace(/^\*\./, ''),
  };
  if (secretId && secretKey) {
    patch.secretId = secretId;
    patch.secretKey = secretKey;
  }

  saveMyShipFileConfig(patch);
  loadTencentCredentials();
  await cosListKeys('manifests/');
  console.log(`\n✅ COS 认证与连通性校验成功！全局配置已写入: ${MYSHIP_CONFIG_PATH}`);

  // 自动生成全局备份至 ~/.myship/edgeone-function.dist.js（绝不写入当前业务项目目录）
  generateEdgeFunctionCode({ cosOrigin: patch.cosOrigin, silent: true });

  // 自动探测云端全局 EdgeOne 泛域名网关是否已在线运行
  const probe = await probeEdgeGateway(patch.remoteDomain);
  if (probe.online) {
    rl.close();
    console.log(`🌐 云端全局边缘网关检测通过: https://*.${patch.remoteDomain} 已在线运行！`);
    console.log(`   (全局边缘函数全账号仅需部署 1 次，所有项目共享，当前电脑无需重复操作边缘函数)`);
    console.log(`🚀 配置全部完成！现在在任意前端项目下直接输入 \`myship\` 即可秒级发布！`);
  } else {
    console.log(`\n💡 尚未在 https://*.${patch.remoteDomain} 探测到边缘网关响应（若是首次从 0 搭建云底座，需部署 1 次全局边缘函数）。`);
    await promptAndDeployEdgeFunction({
      cosOrigin: patch.cosOrigin,
      remoteDomain: patch.remoteDomain,
      rlExternal: rl,
    });
    rl.close();
  }
}

function printWhoami() {
  const status = getAuthStatus();
  const proj = detectProjectContext();
  console.log('=== 👤 MyShip 当前身份与自有云底座 (BYOC) 配置 ===');
  if (status.authenticated) {
    console.log(`  ✅ 认证状态: 已就绪`);
    console.log(`  🔑 凭证来源: ${status.source}`);
    console.log(`  🆔 SecretId: ${status.maskedSecretId}`);
  } else {
    console.log(`  ❌ 认证状态: 未配置 (${status.error})`);
  }
  console.log(`  ☁️  COS 存储桶: ${status.cosOrigin || '(未配置，请运行 myship login)'}`);
  console.log(
    `  🌐 泛域名后缀: ${
      status.remoteDomain ? `*.${status.remoteDomain}` : '(未配置，请运行 myship login)'
    }`
  );

  const suffix = status.remoteDomain || 'ship.example.com';
  console.log('\n=== 📦 当前项目命名空间上下文 (.myship/project.json) ===');
  console.log(`  🏷️  项目名称 (project):  ${proj.project}`);
  console.log(`  📁 默认构建目录 (dir):  ${proj.buildDir}`);
  console.log(`  🌐 项目主域名:          https://${proj.prodDomain}.${suffix}`);
  console.log(`  🌐 构建指纹域名格式:    https://${proj.project}-<hash>.${suffix}`);
  console.log(`  📄 配置来源:            ${proj.configSource}`);
}

function printHelp() {
  console.log(`
🚀 MyShip CLI — 基于自有云设施 (BYOC) 的高 DX 部署与泛域名路由工具

极简日常用法 (自动关联 .myship/project.json 项目命名空间):
  myship                                       零参数部署：自动生成 <project>-<hash> 并更新 <project>.ship.<domain>
  myship <目录> <环境后缀>                     项目内带后缀部署：如在 app1 下执行 myship ./dist v2 -> https://app1-v2.ship.<domain>
  myship -d <环境后缀> [-p <项目名>]           部署并自动拼接当前项目命名空间前缀 (加 --raw 可不加项目前缀)

项目管理与切流回滚命令:
  myship init [项目名]                         初始化或更新当前目录下的 .myship/project.json
  myship ls [--all | -A]                       默认仅列出【当前项目】的历史构建与域名；加 --all 按项目分组列出全局所有记录
  myship rollback [环境后缀] [目标dpl_id]      一键秒级回滚（不传参数默认回滚当前项目主域名 <project>.ship.<domain>）
  myship alias <环境后缀> <dpl_id>             0 秒将指定子域名切换到目标版本

跨设备认证与自有云底座初始化:
  myship login                                 交互式配置腾讯云密钥、COS 地址与泛域名后缀 (~/.myship/config.json)
  myship build-edge-fn [输出路径]              根据当前 COS 配置一键生成专属 EdgeOne 边缘函数代码 (.myship/edgeone-function.dist.js)
  myship whoami                                查看当前生效的认证状态与项目命名空间配置

可选参数:
  -p, --project <name>                         显式指定本次操作的项目命名空间
  --raw                                        自定义子域名不自动拼接 <project>- 前缀
  --preview                                    仅生成本次构建快照域名 (<project>-<hash>)，不更新项目主域名
  --local, -l                                  使用本地离线沙盒模式 (.cas-storage + ship.localhost:4100)
`);
}

// ============================================================================
// CLI 主入口解析
// ============================================================================
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMainModule) {
  const rawArgs = process.argv.slice(2);
  const isLocal = rawArgs.includes('--local') || rawArgs.includes('-l');
  const isAll = rawArgs.includes('--all') || rawArgs.includes('-A');
  const isRawDomain = rawArgs.includes('--raw');
  const isPreviewOnly = rawArgs.includes('--preview');

  const domains = [];
  let explicitProject = null;
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--domain' || arg === '-d') {
      if (rawArgs[i + 1]) domains.push(rawArgs[++i]);
    } else if (arg === '--project' || arg === '-p') {
      if (rawArgs[i + 1]) explicitProject = rawArgs[++i];
    } else if (
      [
        '--local',
        '-l',
        '--remote',
        '-r',
        '--all',
        '-A',
        '--raw',
        '--preview',
        '--save',
        '-s',
      ].includes(arg)
    ) {
      // flag handled
    } else if (arg === '--help' || arg === '-h') {
      positional.push('help');
    } else if (arg === '--version' || arg === '-v') {
      positional.push('version');
    } else {
      positional.push(arg);
    }
  }

  const first = positional[0];

  (async () => {
    if (first === 'version') {
      try {
        const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
        console.log(`myship v${rootPkg.version}`);
      } catch {
        console.log('myship v0.1.0');
      }
      return;
    }
    if (first === 'help') {
      printHelp();
      return;
    }
    if (first === 'login') {
      await interactiveLogin();
      return;
    }
    if (first === 'whoami') {
      printWhoami();
      return;
    }
    if (first === 'build-edge-fn' || first === 'setup-edge') {
      if (first === 'setup-edge' || (process.stdin.isTTY && !positional[1])) {
        await promptAndDeployEdgeFunction();
      } else {
        generateEdgeFunctionCode({ outputPath: positional[1] });
      }
      return;
    }
    if (first === 'init') {
      const cfg = ensureProjectConfig(process.cwd(), {
        project: positional[1] || explicitProject,
      });
      const { remoteDomain } = getEffectiveEndpoints();
      const suffix = remoteDomain || 'ship.example.com';
      console.log(`✅ 项目命名空间已初始化: ${cfg.projectJsonPath}`);
      console.log(`   🏷️  项目名称: ${cfg.project}`);
      console.log(`   📁 构建目录: ${cfg.dir}`);
      console.log(`   🌐 默认主域名: https://${cfg.prodDomain}.${suffix}`);
      return;
    }
    if (first === 'ls' || first === 'list') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const projectFilter = explicitProject ? normalizeDomainToken(explicitProject) : ctx.project;
      if (isLocal) {
        listState({ projectFilter, showAll: isAll });
      } else {
        await listRemoteState({ projectFilter, showAll: isAll });
      }
      return;
    }
    if (first === 'alias') {
      const [, rawSub, dplId] = positional;
      if (!rawSub || !dplId) {
        console.error('用法: myship alias <subdomain> <deployment_id>');
        process.exit(1);
      }
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const finalSub = resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain);
      if (isLocal) {
        setAlias(finalSub, dplId, { project: ctx.project });
      } else {
        await setRemoteAlias(finalSub, dplId, { project: ctx.project });
      }
      return;
    }
    if (first === 'rollback') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      let rawSub = positional[1];
      let targetDplId = positional[2] || null;
      if (rawSub && rawSub.startsWith('dpl_')) {
        targetDplId = rawSub;
        rawSub = null;
      }
      const finalSub = rawSub
        ? resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain)
        : ctx.prodDomain;
      await rollbackRemoteAlias(finalSub, targetDplId, { project: ctx.project });
      return;
    }

    // 默认行为：deploy
    let targetDir = null;
    if (first === 'deploy') {
      targetDir = positional[1] || null;
      if (positional[2]) domains.push(positional[2]);
    } else {
      targetDir = positional[0] || null;
      if (positional[1]) domains.push(positional[1]);
    }

    const ctx = detectProjectContext(process.cwd(), explicitProject);
    const finalDir = targetDir || ctx.buildDir;
    if (!finalDir || !existsSync(resolve(finalDir))) {
      console.error(
        `❌ 未找到构建产物目录 (${finalDir || './dist'})。请先执行构建 (如 npm run build) 或指定目录: myship ./dist`
      );
      process.exit(1);
    }

    if (!ctx.hasSavedConfig || explicitProject) {
      ensureProjectConfig(process.cwd(), {
        project: ctx.project,
        dir: finalDir,
      });
      console.log(`📁 已自动创建项目命名空间配置: .myship/project.json [项目: ${ctx.project}]`);
    }

    const resolvedAliases = domains.map((d) =>
      resolveNamespacedSubdomain(d, ctx.project, isRawDomain)
    );
    if (resolvedAliases.length === 0 && !isPreviewOnly) {
      resolvedAliases.push(ctx.prodDomain);
    }

    if (isLocal) {
      deployDirectory(finalDir, { aliases: resolvedAliases, project: ctx.project });
    } else {
      await deployRemoteDirectory(finalDir, {
        aliases: resolvedAliases,
        project: ctx.project,
        cwd: process.cwd(),
      });
    }
  })().catch((err) => {
    console.error(`❌ 执行失败: ${err.message}`);
    process.exit(1);
  });
}
