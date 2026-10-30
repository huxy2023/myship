/**
 * MyShip CAS Edge Router v2.0 (Full-Stack Edition) — 腾讯云 EdgeOne 标准站点边缘函数模板
 *
 * 核心特性:
 *   1. Phase 2 约定式 Serverless 云函数 (`api/*.js`) 与前后端同版本原子切换:
 *      - 根据当前子域名绑定的 manifests/<dpl_id>.json 动态匹配 `manifest.functions[route]`
 *      - 通过 `PRECOMPILED_FN_REGISTRY[sha256]` (0ms 原生 V8 执行) + `DYNAMIC_FN_CACHE` 双引擎驱动
 *      - 当执行 `myship rollback` 时，前端静态资源与 `/api/*` 后端接口在同一毫秒内原子切换
 *   2. 三级边缘内存缓存 (V8 Isolate Memory Cache):
 *      - MANIFEST_CACHE / BLOB_CACHE / ALIAS_CACHE (SWR 后台异步刷新)
 *   3. 原生支持 ETag (304 Not Modified) 与 HTTP 206 Partial Content (Range 视频流分片秒开)
 */

const COS_ORIGIN = '__MYSHIP_COS_ORIGIN__';

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

// Phase 2: 基于 SHA-256 内容寻址的预编译云函数注册表 (100% 原生 V8 AST、零 eval/new Function 风险)
const PRECOMPILED_FN_REGISTRY = {
/* __MYSHIP_PRECOMPILED_FUNCTIONS__ */
};

// V8 Isolate 级全局内存缓存池 (严格遵循腾讯云 EdgeOne 128MB 内存配额红线)
const ALIAS_CACHE = new Map();    // subdomain -> { deploymentId, ts }
const MANIFEST_CACHE = new Map(); // deploymentId -> manifestObject
const BLOB_CACHE = new Map();     // sha256 -> { view: Uint8Array, contentType: string, size: number }
let blobCacheTotalBytes = 0;
const MAX_BLOB_CACHE_ITEMS = 32;
const MAX_CACHEABLE_BLOB_BYTES = 256 * 1024;       // 单文件最大缓存 256 KB (大文件走流式直传与边缘节点 Cache)
const MAX_BLOB_CACHE_TOTAL_BYTES = 8 * 1024 * 1024; // 内存池总容量硬上限 8 MB (远低于 EdgeOne 128 MB 限制)
const MAX_EDGEONE_BODY_BYTES = 1024 * 1024;         // EdgeOne 边缘函数客户端请求 Body 硬上限 1 MB

const EXT_MIME_FALLBACK = {
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
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.md': 'text/plain; charset=UTF-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.tgz': 'application/gzip',
};

function resolveMimeType(reqPath, manifestContentType) {
  if (manifestContentType && manifestContentType !== 'application/octet-stream') {
    return manifestContentType;
  }
  const dotIdx = reqPath.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = reqPath.slice(dotIdx).toLowerCase();
    if (EXT_MIME_FALLBACK[ext]) return EXT_MIME_FALLBACK[ext];
  }
  return manifestContentType || 'application/octet-stream';
}

function extractSubdomain(hostHeader) {
  if (!hostHeader) return 'prod';
  const hostname = hostHeader.split(':')[0].toLowerCase();
  const parts = hostname.split('.');
  if (parts.length >= 4) {
    return parts[0];
  }
  return parts[0] || 'prod';
}

async function fetchCosJson(key, cacheTtl = 0) {
  const url = `${COS_ORIGIN}/${key}${cacheTtl === 0 ? `?t=${Date.now()}` : ''}`;
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

async function resolveDeploymentId(subdomain, event) {
  if (subdomain === '_myship_probe') {
    return null;
  }
  // 若子域名本身就是不可变快照域名 (如 dpl-xxxx 或 myship-e3e50726)，直接零网络开销解析出 dpl_<hash>
  if (subdomain.startsWith('dpl-')) {
    return subdomain.replace(/^dpl-/, 'dpl_');
  }
  const immMatch = subdomain.match(/-([0-9a-f]{8})$/);
  if (immMatch) {
    return `dpl_${immMatch[1]}`;
  }

  const now = Date.now();
  const cached = ALIAS_CACHE.get(subdomain);

  const refreshTask = async () => {
    const aliasData = await fetchCosJson(`aliases/${subdomain}.json`, 0);
    if (aliasData && aliasData.deploymentId) {
      ALIAS_CACHE.set(subdomain, { deploymentId: aliasData.deploymentId, ts: Date.now() });
      return aliasData.deploymentId;
    }
    return null;
  };

  if (cached) {
    const age = now - cached.ts;
    if (age < 2500) {
      return cached.deploymentId;
    }
    if (age < 60000) {
      if (event && typeof event.waitUntil === 'function') {
        event.waitUntil(refreshTask());
      } else {
        refreshTask();
      }
      return cached.deploymentId;
    }
  }

  return await refreshTask();
}

async function resolveManifest(deploymentId) {
  if (MANIFEST_CACHE.has(deploymentId)) {
    return MANIFEST_CACHE.get(deploymentId);
  }
  const manifest = await fetchCosJson(`manifests/${deploymentId}.json`, 31536000);
  if (manifest && (manifest.files || manifest.functions)) {
    if (MANIFEST_CACHE.size >= 64) {
      const oldestKey = MANIFEST_CACHE.keys().next().value;
      MANIFEST_CACHE.delete(oldestKey);
    }
    MANIFEST_CACHE.set(deploymentId, manifest);
  }
  return manifest;
}

function resolveServerlessModule(sha256) {
  if (PRECOMPILED_FN_REGISTRY[sha256]) {
    return { mod: PRECOMPILED_FN_REGISTRY[sha256], mode: 'PRECOMPILED-V8' };
  }
  return null;
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

async function invokeEdgeFunction(modExports, execMode, request, context) {
  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoMethodKey = `onRequest${methodTitle}`; // 兼容 EdgeOne 官方 onRequestGet / onRequestPost 规范

  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
    'X-MyShip-Subdomain': context.subdomain || '',
    'X-MyShip-Deployment-Id': context.deploymentId || '',
    'X-MyShip-Function-Route': context.route || '',
    'X-MyShip-Function-Sha256': context.sha256 || '',
    'X-MyShip-Function-Mode': execMode,
  };

  // EdgeOne 边缘函数规范: 请求 Body 最大限制 1 MB
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
    const result = isEdgeOneContextFirst
      ? await handler(context, request)
      : await handler(request, context);

    if (
      result &&
      typeof result === 'object' &&
      typeof result.arrayBuffer === 'function' &&
      result.headers
    ) {
      // 遵循 EdgeOne V8 规范: 使用纯对象 Headers 而非 new Headers()
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

async function handleRequest(request, event) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  const subdomain = extractSubdomain(host);

  // 1. 解析子域名对应的 Deployment ID (支持内存 SWR 秒级响应)
  const deploymentId = await resolveDeploymentId(subdomain, event);

  if (!deploymentId) {
    return new Response(
      `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>404 Subdomain Not Found - MyShip</title></head>
      <body style="font-family:system-ui;background:#0f172a;color:#f8fafc;padding:48px;text-align:center;">
        <h1>404 — 未找到子域名绑定: <code>${subdomain}</code></h1>
        <p style="color:#94a3b8;">Host: ${host} | 尚未在 COS aliases/${subdomain}.json 中注册部署指针。</p>
      </body></html>`,
      {
        status: 404,
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
          'X-MyShip-Subdomain': subdomain,
        },
      }
    );
  }

  // 2. 读取不可变 Manifest 清单 (命中边缘内存则 0ms)
  const manifestHit = MANIFEST_CACHE.has(deploymentId);
  const manifest = await resolveManifest(deploymentId);
  if (!manifest || (!manifest.files && !manifest.functions)) {
    return new Response(`Deployment Manifest Not Found: ${deploymentId}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  // 3. 优先匹配 Phase 2 约定式 Serverless 云函数 (`manifest.functions`)
  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  const fnEntry = manifest.functions && manifest.functions[normalizedRoute];
  if (fnEntry && fnEntry.sha256) {
    const resolvedFn = resolveServerlessModule(fnEntry.sha256);
    if (!resolvedFn || !resolvedFn.mod) {
      return new Response(
        JSON.stringify({
          error: `Serverless Function Blob Not Precompiled: ${fnEntry.sha256} (run 'myship setup-edge' to sync)`,
          route: normalizedRoute,
          deploymentId,
        }),
        {
          status: 502,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
            'X-MyShip-Deployment-Id': deploymentId,
          },
        }
      );
    }

    const query = {};
    try {
      if (url.search && url.search.length > 1) {
        const pairs = url.search.slice(1).split('&');
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

    // 完整透传腾讯云 EdgeOne 原生扩展属性 (request.eo.geo / request.eo.clientIp / event.waitUntil)
    const eoMeta = (request && request.eo) || {};
    const context = {
      request,
      deploymentId,
      subdomain,
      project: manifest.project || 'default',
      route: normalizedRoute,
      sha256: fnEntry.sha256,
      functionSha256: fnEntry.sha256,
      url,
      query,
      params: {},
      env: {},
      eo: eoMeta,
      geo: eoMeta.geo || {},
      clientIp: eoMeta.clientIp || request.headers.get('x-forwarded-for') || '',
      waitUntil:
        event && typeof event.waitUntil === 'function' ? event.waitUntil.bind(event) : function () {},
    };
    return await invokeEdgeFunction(resolvedFn.mod, resolvedFn.mode, request, context);
  }

  // 4. 匹配静态文件路径（支持目录自动补全 index.html 与 SPA History Fallback）
  let reqPath = rawPathname;
  if (reqPath.endsWith('/')) reqPath += 'index.html';

  const filesMap = manifest.files || {};
  let fileEntry = filesMap[reqPath];
  if (!fileEntry && !reqPath.includes('.')) {
    fileEntry = filesMap[`${reqPath}/index.html`];
  }
  if (!fileEntry && manifest.spaFallback && !reqPath.startsWith('/api/')) {
    fileEntry = filesMap[manifest.spaFallback];
  }

  if (!fileEntry) {
    return new Response(`404 File Not Found: ${url.pathname} (in ${deploymentId})`, {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=UTF-8',
        'X-MyShip-Deployment-Id': deploymentId,
      },
    });
  }

  const sha256 = fileEntry.sha256;
  const contentType = resolveMimeType(reqPath, fileEntry.contentType);
  const isHtml = contentType.includes('text/html');
  const etag = `"${sha256}"`;

  // 5. 支持 ETag 条件请求 (304 Not Modified 零流量毫秒响应)
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Cache': 'HIT-304',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      },
    });
  }

  const rangeHeader = request.headers.get('range');

  // 6. 若无 Range 分片请求且已驻留边缘节点内存，直接 0ms 从内存返回 (零拷贝 Uint8Array 视图)
  if (!rangeHeader && BLOB_CACHE.has(sha256)) {
    const cachedBlob = BLOB_CACHE.get(sha256);
    return new Response(cachedBlob.view, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(cachedBlob.size),
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
        'X-MyShip-Subdomain': subdomain,
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Blob-Sha256': sha256,
        'X-MyShip-Cache': `HIT-MEM (manifest:${manifestHit ? 'HIT' : 'MISS'})`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      },
    });
  }

  // 7. 从 COS CAS 池读取真实文件块 blobs/<sha256> (透传 Range 请求头支持视频 206 分片流)
  const blobUrl = `${COS_ORIGIN}/blobs/${sha256}`;
  const fetchHeaders = {};
  if (rangeHeader) {
    fetchHeaders['Range'] = rangeHeader;
  }

  const blobRes = await fetch(blobUrl, { headers: fetchHeaders });
  if (!blobRes.ok && blobRes.status !== 206) {
    return new Response(`502 CAS Blob Missing: ${sha256}`, { status: 502 });
  }

  if (!rangeHeader && (fileEntry.size || 0) > 0 && fileEntry.size <= MAX_CACHEABLE_BLOB_BYTES) {
    const arrBuf = await blobRes.arrayBuffer();
    const view = new Uint8Array(arrBuf);
    const byteLen = view.byteLength;
    if (byteLen <= MAX_BLOB_CACHE_TOTAL_BYTES) {
      while (
        BLOB_CACHE.size >= MAX_BLOB_CACHE_ITEMS ||
        blobCacheTotalBytes + byteLen > MAX_BLOB_CACHE_TOTAL_BYTES
      ) {
        const oldestKey = BLOB_CACHE.keys().next().value;
        if (!oldestKey) break;
        const oldestVal = BLOB_CACHE.get(oldestKey);
        blobCacheTotalBytes -= oldestVal ? oldestVal.size : 0;
        BLOB_CACHE.delete(oldestKey);
      }
      BLOB_CACHE.set(sha256, { view, contentType, size: byteLen });
      blobCacheTotalBytes += byteLen;
    }
    return new Response(view, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(byteLen),
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
        'X-MyShip-Subdomain': subdomain,
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Blob-Sha256': sha256,
        'X-MyShip-Cache': `MISS->MEM (manifest:${manifestHit ? 'HIT' : 'MISS'})`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      },
    });
  }

  const respHeaders = {
    'Content-Type': contentType,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
    'X-MyShip-Subdomain': subdomain,
    'X-MyShip-Deployment-Id': deploymentId,
    'X-MyShip-Blob-Sha256': sha256,
    'X-MyShip-Cache': rangeHeader ? 'STREAM-RANGE-206' : 'STREAM-DIRECT',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  const contentRange = blobRes.headers.get('content-range');
  if (contentRange) respHeaders['Content-Range'] = contentRange;
  const contentLength = blobRes.headers.get('content-length');
  if (contentLength) respHeaders['Content-Length'] = contentLength;

  return new Response(blobRes.body, {
    status: blobRes.status,
    headers: respHeaders,
  });
}

addEventListener('fetch', (event) => {
  event.respondWith(
    handleRequest(event.request, event).catch((err) => {
      return new Response(
        JSON.stringify({
          error: 'Edge Gateway Uncaught Exception',
          message: err && err.message ? err.message : String(err),
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0-FullStack',
          },
        }
      );
    })
  );
});
