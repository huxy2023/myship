/**
 * MyShip Dedicated Project API Worker v2.1 — 腾讯云 EdgeOne 独立项目云函数模板 (方案 A + 方案 C)
 *
 * 架构职责:
 *   1. 【方案 A · 默认主力】作为项目专属的独立 EdgeOne 边缘函数 (`myship-api-<project>`) 运行，
 *      与全局静态路由器 (`myship-cas-router`) 100% 解耦，在腾讯云 EdgeOne 控制台独立可见、独立触发。
 *   2. 根据当前请求子域名绑定的 `manifests/<dpl_id>.json` 动态解析 `manifest.functions[route]`，
 *      执行对应 SHA-256 版本的预编译 V8 函数，确保 `myship rollback` 时前后端同版本 0 秒原子切换。
 *   3. 【方案 C · Phase 3+ 重算力扩展槽】当 `manifest.functions[route].upstreamUrl` 配置了腾讯云 SCF
 *      「函数 URL」(如 `https://xxx.ap-guangzhou.tencentscf.com`) 时，自动在边缘侧执行零跨域反向代理，
 *      并注入 `X-MyShip-Deployment-Id` 等全套上下文请求头。
 */

const COS_ORIGIN = '__MYSHIP_COS_ORIGIN__';
const PROJECT_NAME = '__MYSHIP_PROJECT_NAME__';

// EdgeOne V8 运行时安全垫片 (兼容 Response.json 与 process.env 访问，防止 ReferenceError / TypeError)
if (typeof Response !== 'undefined' && typeof Response.json !== 'function') {
  Response.json = function (data, init) {
    const opts = init || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json; charset=UTF-8' },
      opts.headers || {}
    );
    return new Response(JSON.stringify(data), Object.assign({}, opts, { headers }));
  };
}
if (typeof globalThis !== 'undefined' && typeof globalThis.process === 'undefined') {
  globalThis.process = { env: {} };
}

// 按项目命名空间隔离的环境变量注册表 (源自 COS 私有 envs/<project>.json)
const PROJECT_ENV_REGISTRY = {
/* __MYSHIP_PROJECT_ENVS__ */
};

// SHA-256 预编译云函数注册表 (支持按项目命名空间惰性实例化与 process.env 注入)
const PRECOMPILED_FN_REGISTRY = {
/* __MYSHIP_PRECOMPILED_FUNCTIONS__ */
};

const FN_INSTANCE_CACHE = new Map(); // "${project}:${sha256}" -> modExports
const ALIAS_CACHE = new Map();       // subdomain -> { record, ts }
const MANIFEST_CACHE = new Map();    // deploymentId -> { record, ts }
const MAX_EDGEONE_BODY_BYTES = 1024 * 1024; // EdgeOne 边缘函数客户端请求 Body 硬上限 1 MB

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildUnavailableResponse(request, info) {
  const rawPathname = decodeURIComponent(new URL(request.url).pathname);
  const method = (request.method || 'GET').toUpperCase();
  const prefix = info.backendPrefix || '/api';
  const isBackendPath =
    prefix === '/' ||
    rawPathname === prefix ||
    rawPathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`) ||
    rawPathname.startsWith('/api/');
  const accept = (request.headers && request.headers.get && request.headers.get('accept')) || '';
  const commonHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Retry-After': '120',
    'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
    'X-MyShip-Function-Worker': `myship-api-${info.project || PROJECT_NAME}`,
    'X-MyShip-Status': 'offline',
    'X-MyShip-Offline-Scope': info.scope || 'project',
    'X-MyShip-Project': info.project || PROJECT_NAME || 'default',
    'X-MyShip-Subdomain': info.subdomain || '',
    'X-MyShip-Deployment-Id': info.deploymentId || '',
  };
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: commonHeaders });
  const reasonText = info.reason || '站点维护中 / 管理员已暂停访问';
  if (isBackendPath || accept.includes('application/json')) {
    return new Response(
      JSON.stringify({
        ok: false, status: 503, error: 'SERVICE_UNAVAILABLE', message: reasonText,
        scope: info.scope || 'project', reason: reasonText, project: info.project || PROJECT_NAME || 'default',
        subdomain: info.subdomain || '', deploymentId: info.deploymentId || '',
      }),
      { status: 503, headers: Object.assign({}, commonHeaders, { 'Content-Type': 'application/json; charset=UTF-8' }) }
    );
  }
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>503 站点已下线维护 - MyShip</title></head><body><h1>503 · ${escapeHtml(reasonText)}</h1><p>Project: ${escapeHtml(info.project || PROJECT_NAME || 'default')} (${escapeHtml(info.subdomain || '')})</p></body></html>`,
    { status: 503, headers: Object.assign({}, commonHeaders, { 'Content-Type': 'text/html; charset=UTF-8' }) }
  );
}

function extractSubdomain(hostHeader) {
  if (!hostHeader) return PROJECT_NAME || 'prod';
  const hostname = hostHeader.split(':')[0].toLowerCase();
  const parts = hostname.split('.');
  if (parts.length >= 4) {
    return parts[0];
  }
  return parts[0] || PROJECT_NAME || 'prod';
}

async function fetchCosJson(key, cacheTtl = 0) {
  const url = `${COS_ORIGIN}/${key}${cacheTtl === 0 ? `?_t=${Date.now()}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'Cache-Control': cacheTtl === 0 ? 'no-cache, no-store' : `max-age=${cacheTtl}`,
    },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function resolveAliasRecord(subdomain, event) {
  if (subdomain === '_myship_probe') {
    return null;
  }
  if (subdomain.startsWith('dpl-')) {
    return { deploymentId: subdomain.replace(/^dpl-/, 'dpl_'), isImmutableUrl: true };
  }
  const immMatch = subdomain.match(/-([0-9a-f]{8})$/);
  if (immMatch) {
    return { deploymentId: `dpl_${immMatch[1]}`, isImmutableUrl: true };
  }

  const now = Date.now();
  const cached = ALIAS_CACHE.get(subdomain);

  const refreshTask = async () => {
    const aliasData = await fetchCosJson(`aliases/${subdomain}.json`, 0);
    if (aliasData && aliasData.deploymentId) {
      ALIAS_CACHE.set(subdomain, { record: aliasData, ts: Date.now() });
      return aliasData;
    }
    ALIAS_CACHE.delete(subdomain);
    return null;
  };

  if (cached) {
    const age = now - cached.ts;
    if (age < 2500) {
      return cached.record;
    }
    if (age < 60000) {
      if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(refreshTask());
      } else {
        refreshTask();
      }
      return cached.record;
    }
  }

  return await refreshTask();
}

async function resolveManifest(deploymentId, event) {
  const now = Date.now();
  const cached = MANIFEST_CACHE.get(deploymentId);

  const refreshTask = async () => {
    const manifest = await fetchCosJson(`manifests/${deploymentId}.json`, 0);
    if (manifest && (manifest.files || manifest.functions || manifest.backend)) {
      if (!MANIFEST_CACHE.has(deploymentId) && MANIFEST_CACHE.size >= 64) {
        const oldestKey = MANIFEST_CACHE.keys().next().value;
        MANIFEST_CACHE.delete(oldestKey);
      }
      MANIFEST_CACHE.set(deploymentId, { record: manifest, ts: Date.now() });
      return manifest;
    }
    MANIFEST_CACHE.delete(deploymentId);
    return null;
  };

  if (cached) {
    const age = now - cached.ts;
    if (age < 2500) {
      return cached.record;
    }
    if (age < 60000) {
      if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(refreshTask());
      } else {
        refreshTask();
      }
      return cached.record;
    }
  }

  return await refreshTask();
}

function extractPlainHeaders(headersInput) {
  const out = {};
  if (!headersInput) return out;
  if (typeof headersInput.forEach === 'function') {
    headersInput.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (typeof headersInput === 'object') {
    for (const [k, v] of Object.entries(headersInput)) {
      if (v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

function parseQuerySafe(searchStr) {
  const query = {};
  try {
    if (searchStr && searchStr.length > 1) {
      const pairs = searchStr.slice(1).split('&');
      for (let i = 0; i < pairs.length; i++) {
        const idx = pairs[i].indexOf('=');
        if (idx === -1) {
          query[decodeURIComponent(pairs[i])] = '';
        } else {
          query[decodeURIComponent(pairs[i].slice(0, idx))] = decodeURIComponent(
            pairs[i].slice(idx + 1)
          );
        }
      }
    }
  } catch {}
  return query;
}

/**
 * 方案 C (Phase 3+ 重算力扩展槽)：腾讯云 SCF「函数 URL」边缘反向代理执行器
 * 将请求透明转发至 `fnEntry.upstreamUrl` (如 https://xxx.ap-guangzhou.tencentscf.com)，
 * 自动注入 MyShip 部署版本与客户端边缘上下文头。
 */
async function proxyToUpstreamFunctionUrl(fnEntry, request, context) {
  const method = (request.method || 'GET').toUpperCase();
  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeC-SCF-Proxy',
    'X-MyShip-Function-Worker': `myship-api-${context.project || PROJECT_NAME}`,
    'X-MyShip-Proxy-Mode': 'SCF-Function-URL',
    'X-MyShip-Project': context.project || PROJECT_NAME,
    'X-MyShip-Subdomain': context.subdomain || '',
    'X-MyShip-Deployment-Id': context.deploymentId || '',
    'X-MyShip-Function-Route': context.route || '',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  try {
    const targetUrl = new URL(fnEntry.upstreamUrl);
    if (context.pathname && (targetUrl.pathname === '/' || targetUrl.pathname === '')) {
      targetUrl.pathname = context.pathname;
    }
    if (context.url && context.url.search) {
      targetUrl.search = context.url.search;
    }

    const upstreamReqHeaders = extractPlainHeaders(request.headers);
    delete upstreamReqHeaders['host'];
    delete upstreamReqHeaders['Host'];
    upstreamReqHeaders['X-MyShip-Project'] = context.project || PROJECT_NAME;
    upstreamReqHeaders['X-MyShip-Subdomain'] = context.subdomain || '';
    upstreamReqHeaders['X-MyShip-Deployment-Id'] = context.deploymentId || '';
    upstreamReqHeaders['X-MyShip-Function-Route'] = context.route || '';
    if (context.scfVersion) {
      upstreamReqHeaders['X-MyShip-Backend-Version'] = String(context.scfVersion);
      baseHeaders['X-MyShip-Backend-Version'] = String(context.scfVersion);
    }
    if (context.gatewayToken) {
      upstreamReqHeaders['X-MyShip-Gateway-Token'] = context.gatewayToken;
    }
    if (context.clientIp) {
      upstreamReqHeaders['X-MyShip-Client-Ip'] = context.clientIp;
    }

    const fetchInit = {
      method,
      headers: upstreamReqHeaders,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      fetchInit.body = request.body;
    }

    const upstreamRes = await fetch(targetUrl.toString(), fetchInit);
    const upstreamPlain = extractPlainHeaders(upstreamRes.headers);
    for (const k of Object.keys(upstreamPlain)) {
      const lower = k.toLowerCase();
      if (
        lower === 'content-disposition' &&
        String(upstreamPlain[k]).toLowerCase().trim() === 'attachment'
      ) {
        delete upstreamPlain[k];
      } else if (
        lower === 'content-encoding' ||
        lower === 'content-length' ||
        lower === 'transfer-encoding' ||
        lower === 'connection'
      ) {
        delete upstreamPlain[k];
      }
    }
    const respHeaders = Object.assign({}, upstreamPlain, baseHeaders);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: respHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'SCF Function URL Upstream Proxy Failed',
        message: err && err.message ? err.message : String(err),
        route: context.route,
        deploymentId: context.deploymentId,
      }),
      {
        status: 502,
        headers: Object.assign({}, baseHeaders, {
          'Content-Type': 'application/json; charset=UTF-8',
        }),
      }
    );
  }
}

/**
 * 方案 A (默认主力)：EdgeOne 边缘 V8 原生 0ms 执行器
 */
async function invokeEdgeFunction(modExports, execMode, request, context) {
  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoMethodKey = `onRequest${methodTitle}`;

  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
    'X-MyShip-Function-Worker': `myship-api-${context.project || PROJECT_NAME}`,
    'X-MyShip-Project': context.project || PROJECT_NAME,
    'X-MyShip-Subdomain': context.subdomain || '',
    'X-MyShip-Deployment-Id': context.deploymentId || '',
    'X-MyShip-Function-Route': context.route || '',
    'X-MyShip-Function-Sha256': (context.sha256 || '').slice(0, 8),
    'X-MyShip-Function-Mode': execMode,
  };

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_EDGEONE_BODY_BYTES) {
    return new Response(
      JSON.stringify({
        error: 'Payload Too Large: EdgeOne Edge Functions limit request body to 1 MB (1,048,576 bytes).',
        contentLength,
        limitBytes: MAX_EDGEONE_BODY_BYTES,
        route: context.route,
      }),
      {
        status: 413,
        headers: Object.assign({}, baseHeaders, {
          'Content-Type': 'application/json; charset=UTF-8',
        }),
      }
    );
  }

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
        error: `Method ${method} Not Allowed`,
        route: context.route,
        deploymentId: context.deploymentId,
      }),
      {
        status: 405,
        headers: Object.assign({}, baseHeaders, {
          'Content-Type': 'application/json; charset=UTF-8',
        }),
      }
    );
  }

  try {
    if (typeof globalThis !== 'undefined') {
      if (!globalThis.process) globalThis.process = { env: {} };
      globalThis.process.env = Object.assign({}, context.env || {});
    }
    const result = isEdgeOneContextFirst
      ? await handler(context, request)
      : await handler(request, context);

    if (
      result &&
      typeof result === 'object' &&
      typeof result.arrayBuffer === 'function' &&
      result.headers
    ) {
      const customHeaders = extractPlainHeaders(result.headers);
      const mergedPlain = Object.assign({}, baseHeaders, customHeaders);
      return new Response(result.body, {
        status: result.status || 200,
        headers: mergedPlain,
      });
    }
    if (typeof result === 'string') {
      return new Response(result, {
        status: 200,
        headers: Object.assign({}, baseHeaders, {
          'Content-Type': 'text/plain; charset=UTF-8',
        }),
      });
    }
    return new Response(JSON.stringify(result ?? { ok: true }), {
      status: 200,
      headers: Object.assign({}, baseHeaders, {
        'Content-Type': 'application/json; charset=UTF-8',
      }),
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: err && err.message ? err.message : 'Internal Serverless Function Error',
        route: context.route,
        deploymentId: context.deploymentId,
      }),
      {
        status: 500,
        headers: Object.assign({}, baseHeaders, {
          'Content-Type': 'application/json; charset=UTF-8',
        }),
      }
    );
  }
}

async function handleApiRequest(request, event) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  const subdomain = extractSubdomain(host);

  const aliasRecord = await resolveAliasRecord(subdomain, event);
  const deploymentId = aliasRecord && aliasRecord.deploymentId;
  if (!deploymentId) {
    return new Response(
      JSON.stringify({
        error: `Subdomain Alias Not Found: ${subdomain}`,
        worker: `myship-api-${PROJECT_NAME}`,
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
          'X-MyShip-Function-Worker': `myship-api-${PROJECT_NAME}`,
        },
      }
    );
  }

  if (aliasRecord.disabled || aliasRecord.projectDisabled) {
    return buildUnavailableResponse(request, {
      scope: aliasRecord.projectDisabled ? 'project' : 'alias',
      reason:
        aliasRecord.projectDisabledReason ||
        aliasRecord.disabledReason ||
        '当前子域名或项目已暂停访问',
      project: aliasRecord.project || PROJECT_NAME || subdomain,
      subdomain,
      deploymentId,
    });
  }

  const manifest = await resolveManifest(deploymentId, event);
  if (!manifest || (!manifest.functions && !manifest.backend)) {
    return new Response(
      JSON.stringify({
        error: `No Serverless Functions Found in Deployment: ${deploymentId}`,
        worker: `myship-api-${PROJECT_NAME}`,
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
          'X-MyShip-Deployment-Id': deploymentId,
        },
      }
    );
  }

  if (manifest.disabled || manifest.projectDisabled) {
    return buildUnavailableResponse(request, {
      scope: manifest.projectDisabled ? 'project' : 'deployment',
      reason:
        manifest.projectDisabledReason ||
        manifest.disabledReason ||
        '当前构建版本已被管理员禁用',
      project: manifest.project || aliasRecord.project || PROJECT_NAME || subdomain,
      subdomain,
      deploymentId,
      backendPrefix: manifest.backend && manifest.backend.prefix,
    });
  }

  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  if (manifest.backend && manifest.backend.upstreamUrl) {
    const eoMeta = (request && request.eo) || {};
    return await proxyToUpstreamFunctionUrl(
      { upstreamUrl: manifest.backend.upstreamUrl },
      request,
      {
        project: manifest.project || PROJECT_NAME || 'default',
        subdomain,
        deploymentId,
        route: rawPathname,
        pathname: rawPathname,
        url,
        gatewayToken: manifest.backend.gatewayToken || '',
        scfVersion: manifest.backend.scfVersion || '',
        clientIp: eoMeta.clientIp || request.headers.get('x-forwarded-for') || '',
      }
    );
  }

  const fnEntry = manifest.functions && manifest.functions[normalizedRoute];
  if (!fnEntry) {
    return new Response(
      JSON.stringify({
        error: `API Route Not Found: ${normalizedRoute}`,
        availableRoutes: Object.keys(manifest.functions),
        deploymentId,
        worker: `myship-api-${PROJECT_NAME}`,
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
          'X-MyShip-Deployment-Id': deploymentId,
        },
      }
    );
  }

  const query = parseQuerySafe(url.search);
  const eoMeta = (request && request.eo) || {};
  const resolvedProject = manifest.project || PROJECT_NAME || 'default';
  const projectEnv = Object.assign({}, PROJECT_ENV_REGISTRY[resolvedProject] || {});
  if (typeof globalThis !== 'undefined') {
    if (!globalThis.process) globalThis.process = { env: {} };
    globalThis.process.env = Object.assign({}, projectEnv);
  }
  const context = {
    request,
    deploymentId,
    subdomain,
    project: resolvedProject,
    route: normalizedRoute,
    sha256: fnEntry.sha256 || '',
    functionSha256: fnEntry.sha256 || '',
    url,
    query,
    params: {},
    env: projectEnv,
    eo: eoMeta,
    geo: eoMeta.geo || {},
    clientIp: eoMeta.clientIp || request.headers.get('x-forwarded-for') || '',
    waitUntil:
      event && typeof event.waitUntil === 'function' ? event.waitUntil.bind(event) : function () {},
  };

  // 1. 优先检查是否配置了【方案 C：腾讯云 SCF 函数 URL 反向代理扩展槽】
  if (fnEntry.upstreamUrl) {
    return await proxyToUpstreamFunctionUrl(fnEntry, request, context);
  }

  // 2. 默认执行【方案 A：EdgeOne 边缘 V8 0ms 原生函数】
  let mod = null;
  if (fnEntry.sha256) {
    const cacheKey = `${resolvedProject}:${fnEntry.sha256}`;
    mod = FN_INSTANCE_CACHE.get(cacheKey);
    if (!mod) {
      const regEntry = PRECOMPILED_FN_REGISTRY[fnEntry.sha256];
      if (typeof regEntry === 'function') {
        mod = regEntry(projectEnv);
      } else if (regEntry && typeof regEntry === 'object') {
        mod = regEntry;
      }
      if (mod) {
        FN_INSTANCE_CACHE.set(cacheKey, mod);
      }
    }
  }
  if (!mod) {
    return new Response(
      JSON.stringify({
        error: `Function Blob Not Found in Project Worker (sha256: ${fnEntry.sha256})`,
        route: normalizedRoute,
        deploymentId,
        worker: `myship-api-${PROJECT_NAME}`,
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
          'X-MyShip-Deployment-Id': deploymentId,
        },
      }
    );
  }

  return await invokeEdgeFunction(mod, 'PRECOMPILED-V8-DEDICATED', request, context);
}

addEventListener('fetch', (event) => {
  event.respondWith(
    handleApiRequest(event.request, event).catch((err) => {
      return new Response(
        JSON.stringify({
          error: 'Edge API Worker Uncaught Exception',
          message: err && err.message ? err.message : String(err),
          worker: `myship-api-${PROJECT_NAME}`,
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-MyShip-Engine': 'EdgeOne-API-Worker/2.1-SchemeA',
          },
        }
      );
    })
  );
});
