import {
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  cosPutObject,
  cosGetJson,
  cosListKeys,
  getEffectiveEndpoints,
  assertCloudEndpointsConfigured,
  MYSHIP_CONFIG_PATH,
  MYSHIP_GLOBAL_EDGE_FN_PATH,
  deployEdgeFunctionToTeo,
  deployProjectApiFunctionToTeo,
} from './cos-client.mjs';
import {
  DEFAULT_STORAGE_DIR,
  ensureMyShipGitignore,
  walkFiles,
  normalizeDomainToken,
  detectProjectContext,
} from './project-context.mjs';
import {
  loadLocalEnvsPool,
  saveLocalEnvsPool,
  assertValidEnvKey,
  maskEnvValue,
  parseDotEnv,
  formatDotEnv,
  getLocalProjectEnv,
  saveLocalProjectEnv,
  buildProjectEnvsBlock,
  syncCloudEnvsPool,
  getRemoteProjectEnv,
} from './env-manager.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MYSHIP_FUNCTIONS_POOL_PATH = resolve(
  dirname(MYSHIP_CONFIG_PATH),
  'functions-pool.json'
);

const MAX_SINGLE_API_FN_BYTES = 512 * 1024; // 单文件最大 512 KB (保障远低于 EdgeOne 5MB 总包上限)
const MAX_PRECOMPILED_POOL_BYTES = Math.floor(3.5 * 1024 * 1024); // 预编译函数池总预算 3.5 MB (EdgeOne 边缘函数硬限制为 5 MB)

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

export function extractDeclaredUpstreamUrl(sourceCode) {
  if (!sourceCode) return null;
  const match = String(sourceCode).match(
    /export\s+(?:const|let|var)\s+(?:upstreamUrl|scfUrl|proxyUrl)\s*=\s*['"`](https?:\/\/[^'"`\s]+)['"`]/
  );
  return match ? match[1].trim() : null;
}

export function scanApiFunctions(apiDir) {
  if (!apiDir || !existsSync(apiDir) || !statSync(apiDir).isDirectory()) {
    return [];
  }
  const upstreamsMap = {};
  const upstreamsJsonPath = resolve(apiDir, 'upstreams.json');
  if (existsSync(upstreamsJsonPath)) {
    try {
      const rawUpstreams = JSON.parse(readFileSync(upstreamsJsonPath, 'utf8'));
      if (rawUpstreams && typeof rawUpstreams === 'object') {
        for (const [k, v] of Object.entries(rawUpstreams)) {
          const normRoute = normalizeApiRoute(k);
          const urlVal = typeof v === 'string' ? v : v && v.upstreamUrl ? v.upstreamUrl : null;
          if (urlVal && /^https?:\/\//i.test(urlVal)) {
            upstreamsMap[normRoute] = urlVal.trim();
          }
        }
      }
    } catch {
      // ignore invalid upstreams.json
    }
  }

  const rawFiles = walkFiles(apiDir, apiDir, { excludeApiJs: false }).filter(
    (f) => f.relPath.endsWith('.js') || f.relPath.endsWith('.mjs')
  );
  const byRoute = new Map();
  for (const f of rawFiles) {
    const relSource = `api${f.relPath}`;
    const route = normalizeApiRoute(f.relPath);
    const sourceCode = readFileSync(f.fullPath, 'utf8');
    const upstreamUrl = extractDeclaredUpstreamUrl(sourceCode) || upstreamsMap[route] || null;
    byRoute.set(route, {
      fullPath: f.fullPath,
      relSource,
      route,
      size: f.size,
      sourceCode,
      upstreamUrl,
    });
  }

  // 支持仅在 api/upstreams.json 中声明的纯 SCF 函数 URL 代理路由 (方案 C)
  for (const [route, upstreamUrl] of Object.entries(upstreamsMap)) {
    if (!byRoute.has(route)) {
      const stubCode = `export const upstreamUrl = ${JSON.stringify(upstreamUrl)};\n`;
      byRoute.set(route, {
        fullPath: upstreamsJsonPath,
        relSource: 'api/upstreams.json',
        route,
        size: Buffer.byteLength(stubCode, 'utf8'),
        sourceCode: stubCode,
        upstreamUrl,
      });
    }
  }

  return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
}

export function validateEdgeFunctionCompliance(sourceCode, label = 'api-fn', sizeBytes = 0) {
  const code = String(sourceCode || '');
  const actualBytes = sizeBytes || Buffer.byteLength(code, 'utf8');
  if (actualBytes > MAX_SINGLE_API_FN_BYTES) {
    throw new Error(
      `[EdgeOne 规范拦截] 云函数文件过大 (${label}: ${(actualBytes / 1024).toFixed(1)} KB > 512 KB)。腾讯云 EdgeOne 边缘函数单包上限为 5MB，请精简函数体积。`
    );
  }

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
      `检测到 process.env (MyShip 网关已自动按项目命名空间同步注入 process.env 与 context.env)`
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

  const factoryExpr = `(function(__myship_env, process = { env: Object.assign({}, __myship_env || (typeof globalThis !== 'undefined' && globalThis.process && globalThis.process.env) || {}) }) {\nconst __exports = {};\n${transformed}\nreturn __exports;\n})`;
  try {
    new Function(`return ${factoryExpr};`);
  } catch (err) {
    throw new Error(`云函数语法解析失败 (${label}): ${err.message}`);
  }
  return factoryExpr;
}

export function compileServerlessModule(sourceCode, label = 'api-fn', env = null) {
  const factoryExpr = transformEsmToFactorySource(sourceCode, label);
  const factory = new Function(`return ${factoryExpr};`)();
  const injectedEnv = env && typeof env === 'object' ? { ...env } : {};
  return factory(injectedEnv);
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
    'x-myship-function-sha256': (context.sha256 || '').slice(0, 8),
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

  const injectedEnv =
    context && context.env && typeof context.env === 'object' ? { ...context.env } : {};
  const enrichedContext = {
    request,
    params: {},
    eo: (request && request.eo) || {},
    geo: (request && request.eo && request.eo.geo) || {},
    clientIp: '127.0.0.1',
    waitUntil: () => {},
    functionSha256: context.sha256 || '',
    ...context,
    env: injectedEnv,
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

function buildPrecompiledFunctionsBlock(functionsPool = {}) {
  const entries = [];
  let usedBytes = 0;

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
      const line = `  "${sha256}": ${factoryExpr},`;
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

export async function syncCloudFunctionsPool() {
  const localPool = loadLocalFunctionsPool();
  const fnKeys = await cosListKeys('functions/');
  for (const key of fnKeys) {
    if (!key.endsWith('.json')) continue;
    const hash = basename(key, '.json');
    if (!localPool[hash]) {
      const remoteItem = await cosGetJson(key);
      if (!remoteItem || !remoteItem.code) {
        throw new Error(
          `同步云端函数归档失败 (${key}): 无法读取函数内容，已中止发布以防覆盖丢失其他项目的 API 函数。`
        );
      }
      localPool[hash] = remoteItem;
    }
  }
  saveLocalFunctionsPool(localPool);
  return localPool;
}

export function generateProjectApiWorkerCode({
  project = 'default',
  cosOrigin,
  outputPath,
  silent = false,
  functionsPool = null,
  envsPool = null,
} = {}) {
  const effective = getEffectiveEndpoints();
  const targetCosOrigin = (cosOrigin || effective.cosOrigin || '').replace(/\/$/, '');
  if (!targetCosOrigin) {
    throw new Error('尚未配置 COS_ORIGIN！请先运行 `myship login`。');
  }

  const cleanProj = normalizeDomainToken(project) || 'default';
  const pool = functionsPool || loadLocalFunctionsPool();
  const resolvedEnvsPool = envsPool || loadLocalEnvsPool();
  const precompiledBlock = buildPrecompiledFunctionsBlock(pool);
  const projectEnvsBlock = buildProjectEnvsBlock(resolvedEnvsPool);
  const allRoutes = Array.from(
    new Set(
      Object.values(pool)
        .map((item) => item && item.route)
        .filter(Boolean)
    )
  );

  const templatePath = resolve(__dirname, '../edge-gateway/edgeone-api-worker.template.js');
  const templateContent = readFileSync(templatePath, 'utf8');
  const rendered = templateContent
    .replace(/__MYSHIP_COS_ORIGIN__/g, () => targetCosOrigin)
    .replace(/__MYSHIP_PROJECT_NAME__/g, () => cleanProj)
    .replace('/* __MYSHIP_PROJECT_ENVS__ */', () => projectEnvsBlock)
    .replace('/* __MYSHIP_PRECOMPILED_FUNCTIONS__ */', () => precompiledBlock);

  const defaultOut = resolve(
    dirname(MYSHIP_CONFIG_PATH),
    `edgeone-api-${cleanProj}.dist.js`
  );
  const outFile = outputPath ? resolve(outputPath) : defaultOut;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, rendered, 'utf8');

  if (!silent) {
    console.log(`✅ 已生成 API 边缘函数代码 (含多项目 SHA-256 路由隔离池):`);
    console.log(`   📄 产物路径: ${outFile}`);
  }
  return { outFile, targetCosOrigin, project: cleanProj, code: rendered, allRoutes };
}

export async function syncProjectApiFunctionsAndGenerateWorkerCode({
  project = 'default',
  cosOrigin,
  outputPath,
  silent = false,
} = {}) {
  const [localPool, envsPool] = await Promise.all([
    syncCloudFunctionsPool(),
    syncCloudEnvsPool(),
  ]);
  return generateProjectApiWorkerCode({
    project,
    cosOrigin,
    outputPath,
    silent,
    functionsPool: localPool,
    envsPool,
  });
}

export function generateEdgeFunctionCode({
  cosOrigin,
  outputPath,
  silent = false,
} = {}) {
  const effective = getEffectiveEndpoints();
  const targetCosOrigin = (cosOrigin || effective.cosOrigin || '').replace(/\/$/, '');
  if (!targetCosOrigin) {
    throw new Error(
      '尚未配置 COS_ORIGIN！请先运行 `myship login` 或通过环境变量 COS_ORIGIN="https://myship-1250000000.cos.ap-guangzhou.myqcloud.com" 指定。'
    );
  }

  const templatePath = resolve(__dirname, '../edge-gateway/edgeone-function.template.js');
  const templateContent = readFileSync(templatePath, 'utf8');
  const rendered = templateContent.replace(/__MYSHIP_COS_ORIGIN__/g, targetCosOrigin);

  const outFile = outputPath ? resolve(outputPath) : MYSHIP_GLOBAL_EDGE_FN_PATH;
  mkdirSync(dirname(outFile), { recursive: true });
  if (basename(dirname(outFile)) === '.myship' && dirname(outFile) !== dirname(MYSHIP_CONFIG_PATH)) {
    ensureMyShipGitignore(dirname(outFile));
  }
  writeFileSync(outFile, rendered, 'utf8');

  if (!silent) {
    console.log(`✅ 已生成 100% 纯净版全局静态 CAS 边缘路由代码 (myship-cas-router，零业务代码污染):`);
    console.log(`   📄 全局路径: ${outFile}`);
    console.log(`   ☁️  绑定 COS: ${targetCosOrigin}`);
  }
  return { outFile, targetCosOrigin, code: rendered };
}

export async function syncCloudFunctionsPoolAndGenerateEdgeCode({
  cosOrigin,
  outputPath,
  silent = false,
} = {}) {
  return generateEdgeFunctionCode({ cosOrigin, outputPath, silent });
}

export async function saveRemoteProjectEnvAndSyncWorker(
  project = 'default',
  vars = {},
  { hotReload = true } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanProj = normalizeDomainToken(project) || 'default';
  const envKey = `envs/${cleanProj}.json`;
  const payload = {
    project: cleanProj,
    updatedAt: new Date().toISOString(),
    vars,
  };

  const envsPool = await syncCloudEnvsPool();
  envsPool[cleanProj] = vars;

  let fnPool = null;
  if (hotReload) {
    fnPool = await syncCloudFunctionsPool();
  }

  await cosPutObject(
    envKey,
    JSON.stringify(payload, null, 2),
    'application/json; charset=UTF-8',
    undefined,
    { acl: 'private' }
  );
  saveLocalEnvsPool(envsPool);

  let syncedWorker = false;
  if (hotReload && fnPool && Object.keys(fnPool).length > 0) {
    const { code, allRoutes } = generateProjectApiWorkerCode({
      project: cleanProj,
      silent: true,
      functionsPool: fnPool,
      envsPool,
    });
    if (allRoutes.length > 0) {
      const teoRes = await deployProjectApiFunctionToTeo({
        project: cleanProj,
        code,
        routes: allRoutes,
        remoteDomain,
      });
      syncedWorker = true;
      console.log(
        `  ⚡ [EdgeOne 热更新] 已将项目 [${cleanProj}] 的最新环境变量同步至边缘 API 函数: ${teoRes.functionName} (${teoRes.functionId})`
      );
    }
  }
  return { payload, envKey, syncedWorker };
}

export async function runEnvCommand({
  subcommand = 'ls',
  args = [],
  project = 'default',
  isLocal = false,
  reveal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  cwd = process.cwd(),
} = {}) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const action = String(subcommand || 'ls').toLowerCase();

  if (action === 'ls' || action === 'list') {
    const vars = isLocal
      ? getLocalProjectEnv(cleanProj, storageDir)
      : await getRemoteProjectEnv(cleanProj);
    const keys = Object.keys(vars).sort();
    const storeDesc = isLocal
      ? `本地沙盒 (.cas-storage/envs/${cleanProj}.json)`
      : `腾讯云 COS 私有存储 (envs/${cleanProj}.json, ACL: private)`;
    console.log(`=== 🔐 项目 [${cleanProj}] 环境变量列表 (${keys.length} 项) ===`);
    console.log(`  📦 存储位置: ${storeDesc}`);
    if (keys.length === 0) {
      console.log(`  (当前项目尚无环境变量；可执行 \`myship env set KEY=VALUE\` 添加)`);
      return vars;
    }
    for (const k of keys) {
      const displayVal = reveal ? vars[k] : maskEnvValue(vars[k]);
      console.log(`  • ${k} = ${displayVal}`);
    }
    if (!reveal) {
      console.log(`\n💡 提示: 默认已脱敏显示；如需查看完整明文请加 \`--reveal\`。`);
    }
    return vars;
  }

  if (action === 'set' || action === 'add') {
    const pairs = {};
    if (args.length === 2 && !args[0].includes('=')) {
      const k = assertValidEnvKey(args[0]);
      pairs[k] = String(args[1]);
    } else {
      for (const token of args) {
        const eqIdx = token.indexOf('=');
        if (eqIdx <= 0) {
          throw new Error(
            `用法错误: \`myship env set KEY=VALUE [KEY2=VALUE2 ...]\` (收到无效参数: ${token})`
          );
        }
        const k = assertValidEnvKey(token.slice(0, eqIdx));
        const v = token.slice(eqIdx + 1);
        pairs[k] = v;
      }
    }
    const updatedKeys = Object.keys(pairs);
    if (updatedKeys.length === 0) {
      throw new Error('用法: myship env set KEY=VALUE [KEY2=VALUE2 ...]');
    }

    const currentVars = isLocal
      ? getLocalProjectEnv(cleanProj, storageDir)
      : await getRemoteProjectEnv(cleanProj);
    const nextVars = { ...currentVars, ...pairs };

    // 当用户通过 `myship env set` 更新 DATABASE_URL / NEON_DATABASE_URL / MYSQL_URL 时，自动同步派生的拆解变量，防止新 URL 与旧 PGHOST/PGPASSWORD 混用
    const newPgUrl = pairs.DATABASE_URL || pairs.NEON_DATABASE_URL || '';
    if (/^postgres(ql)?:\/\//i.test(newPgUrl)) {
      try {
        const parsed = new URL(newPgUrl);
        if (!('PGHOST' in pairs)) nextVars.PGHOST = parsed.hostname;
        if (!('PGPORT' in pairs)) nextVars.PGPORT = parsed.port || '5432';
        if (!('PGDATABASE' in pairs)) {
          nextVars.PGDATABASE = (parsed.pathname || '').replace(/^\/+/, '') || 'postgres';
        }
        if (!('PGUSER' in pairs)) nextVars.PGUSER = decodeURIComponent(parsed.username || '');
        if (!('PGPASSWORD' in pairs)) {
          nextVars.PGPASSWORD = decodeURIComponent(parsed.password || '');
        }
        if (pairs.DATABASE_URL && currentVars.NEON_DATABASE_URL && !('NEON_DATABASE_URL' in pairs)) {
          nextVars.NEON_DATABASE_URL = pairs.DATABASE_URL;
        }
        if (pairs.NEON_DATABASE_URL && currentVars.DATABASE_URL && !('DATABASE_URL' in pairs)) {
          nextVars.DATABASE_URL = pairs.NEON_DATABASE_URL;
        }
      } catch {
        // ignore invalid URL
      }
    }
    const newMysqlUrl = pairs.MYSQL_URL || pairs.DATABASE_URL || '';
    if (/^mysql:\/\//i.test(newMysqlUrl)) {
      try {
        const parsed = new URL(newMysqlUrl);
        const dbName = (parsed.pathname || '').replace(/^\/+/, '');
        if (dbName && !('MYSQL_DATABASE' in pairs)) nextVars.MYSQL_DATABASE = dbName;
        if (pairs.DATABASE_URL && currentVars.MYSQL_URL && !('MYSQL_URL' in pairs)) {
          nextVars.MYSQL_URL = pairs.DATABASE_URL;
        }
        if (pairs.MYSQL_URL && currentVars.DATABASE_URL && !('DATABASE_URL' in pairs)) {
          nextVars.DATABASE_URL = pairs.MYSQL_URL;
        }
      } catch {
        // ignore invalid URL
      }
    }

    if (isLocal) {
      saveLocalProjectEnv(cleanProj, nextVars, storageDir);
      console.log(
        `✅ [本地沙盒] 已更新项目 [${cleanProj}] 环境变量 (${updatedKeys.join(', ')})`
      );
    } else {
      await saveRemoteProjectEnvAndSyncWorker(cleanProj, nextVars);
      console.log(
        `✅ [云端私有存储] 已私有保存项目 [${cleanProj}] 环境变量 (${updatedKeys.join(
          ', '
        )}) -> envs/${cleanProj}.json (ACL: private)`
      );
    }
    return nextVars;
  }

  if (action === 'rm' || action === 'unset' || action === 'del' || action === 'delete') {
    if (args.length === 0) {
      throw new Error('用法: myship env rm KEY [KEY2 ...]');
    }
    const currentVars = isLocal
      ? getLocalProjectEnv(cleanProj, storageDir)
      : await getRemoteProjectEnv(cleanProj);
    const nextVars = { ...currentVars };
    const removed = [];
    for (const rawKey of args) {
      const k = assertValidEnvKey(rawKey);
      if (Object.prototype.hasOwnProperty.call(nextVars, k)) {
        delete nextVars[k];
        removed.push(k);
      }
    }

    if (isLocal) {
      saveLocalProjectEnv(cleanProj, nextVars, storageDir);
      console.log(
        `✅ [本地沙盒] 已从项目 [${cleanProj}] 移除环境变量: ${
          removed.length > 0 ? removed.join(', ') : '(无匹配项)'
        }`
      );
    } else {
      await saveRemoteProjectEnvAndSyncWorker(cleanProj, nextVars);
      console.log(
        `✅ [云端私有存储] 已从项目 [${cleanProj}] 移除环境变量: ${
          removed.length > 0 ? removed.join(', ') : '(无匹配项)'
        }`
      );
    }
    return nextVars;
  }

  if (action === 'import') {
    const targetFile = resolve(cwd, args[0] || '.env');
    if (!existsSync(targetFile)) {
      throw new Error(`未找到要导入的环境变量文件: ${targetFile}`);
    }
    const imported = parseDotEnv(readFileSync(targetFile, 'utf8'));
    const importedKeys = Object.keys(imported);
    if (importedKeys.length === 0) {
      console.log(`⚠️  文件 ${targetFile} 中未解析到有效的 KEY=VALUE 环境变量。`);
      return {};
    }
    const currentVars = isLocal
      ? getLocalProjectEnv(cleanProj, storageDir)
      : await getRemoteProjectEnv(cleanProj);
    const nextVars = { ...currentVars, ...imported };
    if (isLocal) {
      saveLocalProjectEnv(cleanProj, nextVars, storageDir);
      console.log(
        `✅ [本地沙盒] 已从 ${basename(targetFile)} 导入 ${importedKeys.length} 项环境变量至项目 [${cleanProj}] (${importedKeys.join(', ')})`
      );
    } else {
      await saveRemoteProjectEnvAndSyncWorker(cleanProj, nextVars);
      console.log(
        `✅ [云端私有存储] 已从 ${basename(targetFile)} 导入 ${
          importedKeys.length
        } 项环境变量至项目 [${cleanProj}] (${importedKeys.join(', ')})`
      );
    }
    return nextVars;
  }

  if (action === 'pull') {
    const outFile = resolve(cwd, args[0] || '.env.local');
    const vars = isLocal
      ? getLocalProjectEnv(cleanProj, storageDir)
      : await getRemoteProjectEnv(cleanProj);
    writeFileSync(outFile, formatDotEnv(vars), { encoding: 'utf8', mode: 0o600 });
    console.log(
      `✅ 已将项目 [${cleanProj}] 的 ${Object.keys(vars).length} 项环境变量导出至: ${outFile} (权限 0600)`
    );
    return vars;
  }

  throw new Error(
    `未知的 env 子命令: ${subcommand}。支持: myship env <set|ls|rm|import|pull>`
  );
}

export async function promptAndDeployEdgeFunction({ cosOrigin, remoteDomain, rlExternal = null } = {}) {
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
      console.log('☁️  正在通过腾讯云 EdgeOne API 自动同步纯净版全局静态路由函数 (myship-cas-router)...');
      const res = await deployEdgeFunctionToTeo({ code, remoteDomain: domain });
      console.log(
        `🎉 纯净版全局静态路由函数部署成功！[${res.actionTaken === 'created' ? '新建' : '更新'}] 站点: ${
          res.zoneName
        } (${res.zoneId}) -> 函数 ID: ${res.functionId}`
      );

      const ctx = detectProjectContext(process.cwd());
      const resolvedApiDir = resolveApiDir(resolve(process.cwd(), ctx.buildDir), process.cwd());
      const apiFns = scanApiFunctions(resolvedApiDir);
      if (apiFns.length > 0) {
        const { code: apiCode } = await syncProjectApiFunctionsAndGenerateWorkerCode({
          project: ctx.project,
          cosOrigin,
          silent: true,
        });
        const apiRes = await deployProjectApiFunctionToTeo({
          project: ctx.project,
          code: apiCode,
          routes: apiFns.map((f) => f.route),
          remoteDomain: domain,
        });
        console.log(
          `🎉 项目 [${ctx.project}] 独立 API 边缘函数部署成功！[${
            apiRes.actionTaken === 'created' ? '新建' : '更新'
          }] -> 函数名: ${apiRes.functionName} (${apiRes.functionId})`
        );
      }
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
