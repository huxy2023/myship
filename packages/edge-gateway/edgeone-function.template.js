/**
 * MyShip CAS Edge Router v2.0 — 腾讯云 EdgeOne 标准站点边缘函数模板
 *
 * 核心性能优化 (v2.0):
 *   1. 三级边缘内存缓存 (V8 Isolate Memory Cache):
 *      - MANIFEST_CACHE: 不可变 manifests/<dpl_id>.json 永久驻留边缘内存 (0ms 读取)
 *      - BLOB_CACHE: 常用中小型静态块 (< 1MB) 基于 SHA-256 驻留边缘内存 (跨区域/海外节点 0ms 响应)
 *      - ALIAS_CACHE: 域名指针采用 Micro-TTL (2s) + SWR 后台异步刷新 (event.waitUntil)，兼顾 0ms 首屏与秒级切流
 *   2. 原生支持 ETag (304 Not Modified) 与 HTTP 206 Partial Content (Range 视频流分片秒开)
 */

const COS_ORIGIN = '__MYSHIP_COS_ORIGIN__';

// V8 Isolate 级全局内存缓存池
const ALIAS_CACHE = new Map();    // subdomain -> { deploymentId, ts }
const MANIFEST_CACHE = new Map(); // deploymentId -> manifestObject
const BLOB_CACHE = new Map();     // sha256 -> { bytes: ArrayBuffer, contentType: string, size: number }
const MAX_BLOB_CACHE_ITEMS = 48;
const MAX_CACHEABLE_BLOB_BYTES = 900 * 1024; // 900 KB 以下的热点文件直接驻留边缘节点内存

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
    // 2.5秒内完全新鲜，直接 0ms 返回；2.5s ~ 60s 内立即返回缓存并在后台异步刷新 (SWR)
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
  if (manifest && manifest.files) {
    if (MANIFEST_CACHE.size >= 64) {
      const oldestKey = MANIFEST_CACHE.keys().next().value;
      MANIFEST_CACHE.delete(oldestKey);
    }
    MANIFEST_CACHE.set(deploymentId, manifest);
  }
  return manifest;
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
          'X-MyShip-Subdomain': subdomain,
        },
      }
    );
  }

  // 2. 读取不可变 Manifest 清单 (命中边缘内存则 0ms)
  const manifestHit = MANIFEST_CACHE.has(deploymentId);
  const manifest = await resolveManifest(deploymentId);
  if (!manifest || !manifest.files) {
    return new Response(`Deployment Manifest Not Found: ${deploymentId}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
    });
  }

  // 3. 匹配文件路径（支持目录自动补全 index.html 与 SPA History Fallback）
  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath.endsWith('/')) reqPath += 'index.html';

  let fileEntry = manifest.files[reqPath];
  if (!fileEntry && !reqPath.includes('.')) {
    fileEntry = manifest.files[`${reqPath}/index.html`];
  }
  if (!fileEntry && manifest.spaFallback) {
    fileEntry = manifest.files[manifest.spaFallback];
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

  // 4. 支持 ETag 条件请求 (304 Not Modified 零流量毫秒响应)
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0',
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Cache': 'HIT-304',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      },
    });
  }

  const rangeHeader = request.headers.get('range');

  // 5. 若无 Range 分片请求且已驻留边缘节点内存，直接 0ms 从内存返回
  if (!rangeHeader && BLOB_CACHE.has(sha256)) {
    const cachedBlob = BLOB_CACHE.get(sha256);
    return new Response(cachedBlob.bytes.slice(0), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(cachedBlob.size),
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0',
        'X-MyShip-Subdomain': subdomain,
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Blob-Sha256': sha256,
        'X-MyShip-Cache': `HIT-MEM (manifest:${manifestHit ? 'HIT' : 'MISS'})`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      },
    });
  }

  // 6. 从 COS CAS 池读取真实文件块 blobs/<sha256> (透传 Range 请求头支持视频 206 分片流)
  const blobUrl = `${COS_ORIGIN}/blobs/${sha256}`;
  const fetchHeaders = {};
  if (rangeHeader) {
    fetchHeaders['Range'] = rangeHeader;
  }

  const blobRes = await fetch(blobUrl, { headers: fetchHeaders });
  if (!blobRes.ok && blobRes.status !== 206) {
    return new Response(`502 CAS Blob Missing: ${sha256}`, { status: 502 });
  }

  // 对中小型非分片资源 (< 900 KB) 写入边缘节点内存缓存，后续跨洋/跨区访问 0ms 直出
  if (!rangeHeader && (fileEntry.size || 0) > 0 && fileEntry.size <= MAX_CACHEABLE_BLOB_BYTES) {
    const arrBuf = await blobRes.arrayBuffer();
    if (BLOB_CACHE.size >= MAX_BLOB_CACHE_ITEMS) {
      const oldest = BLOB_CACHE.keys().next().value;
      BLOB_CACHE.delete(oldest);
    }
    BLOB_CACHE.set(sha256, { bytes: arrBuf, contentType, size: arrBuf.byteLength });
    return new Response(arrBuf.slice(0), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(arrBuf.byteLength),
        ETag: etag,
        'Accept-Ranges': 'bytes',
        'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0',
        'X-MyShip-Subdomain': subdomain,
        'X-MyShip-Deployment-Id': deploymentId,
        'X-MyShip-Blob-Sha256': sha256,
        'X-MyShip-Cache': `MISS->MEM (manifest:${manifestHit ? 'HIT' : 'MISS'})`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400',
      },
    });
  }

  // 大文件或 206 Range 视频流分片响应：直接流式透传并保留 Content-Range / Content-Length
  const respHeaders = {
    'Content-Type': contentType,
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/2.0',
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
  event.respondWith(handleRequest(event.request, event));
});
