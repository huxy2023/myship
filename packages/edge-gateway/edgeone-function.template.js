/**
 * MyShip CAS Edge Router v2.1 (Pure Static CAS + Scheme C Proxy Edition) — 腾讯云 EdgeOne 全局静态路由模板
 *
 * 核心职责 (前后端职责 100% 解耦):
 *   1. 纯净静态 CAS 路由 (`myship-cas-router`):
 *      - 零业务代码内联！所有项目的 `api/*.js` 均解耦至各自独立的 EdgeOne 函数 (`myship-api-<project>`)。
 *      - 三级边缘内存缓存 (V8 Isolate Memory Cache): MANIFEST_CACHE / BLOB_CACHE (8MB 硬上限) / ALIAS_CACHE (SWR)。
 *      - 原生支持 ETag (304 Not Modified) 与 HTTP 206 Partial Content (Range 视频流分片秒开)。
 *   2. 远期重算力扩展槽 (Phase 3+ 方案 C —— 腾讯云 SCF 函数 URL 反向代理):
 *      - 若 `manifest.functions[route]` 配置了 `upstreamUrl` (如 `https://xxx.ap-guangzhou.tencentscf.com`)，
 *        自动在边缘侧执行零跨域反向代理并注入 `X-MyShip-Deployment-Id` 上下文请求头。
 */

const COS_ORIGIN = '__MYSHIP_COS_ORIGIN__';

// V8 Isolate 级全局内存缓存池 (严格遵循腾讯云 EdgeOne 128MB 内存配额红线)
const ALIAS_CACHE = new Map();    // subdomain -> { deploymentId, ts }
const MANIFEST_CACHE = new Map(); // deploymentId -> manifestObject
const BLOB_CACHE = new Map();     // sha256 -> { view: Uint8Array, contentType: string, size: number }
let blobCacheTotalBytes = 0;
const MAX_BLOB_CACHE_ITEMS = 32;
const MAX_CACHEABLE_BLOB_BYTES = 256 * 1024;       // 单文件最大缓存 256 KB (大文件走流式直传与边缘节点 Cache)
const MAX_BLOB_CACHE_TOTAL_BYTES = 8 * 1024 * 1024; // 内存池总容量硬上限 8 MB (远低于 EdgeOne 128 MB 限制)

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
  if (manifest && (manifest.files || manifest.functions || manifest.backend)) {
    if (MANIFEST_CACHE.size >= 64) {
      const oldestKey = MANIFEST_CACHE.keys().next().value;
      MANIFEST_CACHE.delete(oldestKey);
    }
    MANIFEST_CACHE.set(deploymentId, manifest);
  }
  return manifest;
}

/**
 * 方案 C / 全栈 SCF 业务后端反向代理：腾讯云 SCF「函数 URL」边缘网关转发
 */
async function proxyToUpstreamFunctionUrl(upstreamUrl, request, meta) {
  const method = (request.method || 'GET').toUpperCase();
  const baseHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.2-SCF-Backend',
    'X-MyShip-Proxy-Mode': 'SCF-Function-URL',
    'X-MyShip-Project': meta.project || 'default',
    'X-MyShip-Subdomain': meta.subdomain || '',
    'X-MyShip-Deployment-Id': meta.deploymentId || '',
    'X-MyShip-Function-Route': meta.route || '',
  };
  if (meta.scfVersion) {
    baseHeaders['X-MyShip-Backend-Version'] = String(meta.scfVersion);
  }

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  try {
    const targetUrl = new URL(upstreamUrl);
    if (meta.pathname && (targetUrl.pathname === '/' || targetUrl.pathname === '')) {
      targetUrl.pathname = meta.pathname;
    }
    if (meta.search) {
      targetUrl.search = meta.search;
    }

    const upstreamReqHeaders = extractPlainHeaders(request.headers);
    delete upstreamReqHeaders['host'];
    delete upstreamReqHeaders['Host'];
    upstreamReqHeaders['X-MyShip-Project'] = meta.project || 'default';
    upstreamReqHeaders['X-MyShip-Subdomain'] = meta.subdomain || '';
    upstreamReqHeaders['X-MyShip-Deployment-Id'] = meta.deploymentId || '';
    upstreamReqHeaders['X-MyShip-Function-Route'] = meta.route || '';
    if (meta.scfVersion) {
      upstreamReqHeaders['X-MyShip-Backend-Version'] = String(meta.scfVersion);
    }
    if (meta.gatewayToken) {
      upstreamReqHeaders['X-MyShip-Gateway-Token'] = meta.gatewayToken;
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
        route: meta.route,
        deploymentId: meta.deploymentId,
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
          'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
          'X-MyShip-Subdomain': subdomain,
        },
      }
    );
  }

  // 2. 读取不可变 Manifest 清单 (命中边缘内存则 0ms)
  const manifestHit = MANIFEST_CACHE.has(deploymentId);
  const manifest = await resolveManifest(deploymentId);
  if (!manifest || (!manifest.files && !manifest.functions && !manifest.backend)) {
    return new Response(`Deployment Manifest Not Found: ${deploymentId}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  // 3. 检查是否命中项目级全栈 SCF 业务后端 (manifest.backend 前缀通配转发，无路由条数限制)
  const backendCfg = manifest.backend;
  if (backendCfg && backendCfg.upstreamUrl) {
    const prefix = backendCfg.prefix || '/api';
    if (
      prefix === '/' ||
      rawPathname === prefix ||
      rawPathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
    ) {
      return await proxyToUpstreamFunctionUrl(backendCfg.upstreamUrl, request, {
        project: manifest.project || 'default',
        subdomain,
        deploymentId,
        route: rawPathname,
        pathname: rawPathname,
        search: url.search,
        gatewayToken: backendCfg.gatewayToken || '',
        scfVersion: backendCfg.scfVersion || '',
      });
    }
  }

  // 4. 检查是否命中单路由【方案 C：SCF 函数 URL 反向代理扩展槽】
  const fnEntry = manifest.functions && manifest.functions[normalizedRoute];
  if (fnEntry && fnEntry.upstreamUrl) {
    return await proxyToUpstreamFunctionUrl(fnEntry.upstreamUrl, request, {
      project: manifest.project || 'default',
      subdomain,
      deploymentId,
      route: normalizedRoute,
      pathname: rawPathname,
      search: url.search,
    });
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
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
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
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
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
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
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
    'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
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
            'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.1-PureStatic',
          },
        }
      );
    })
  );
});
