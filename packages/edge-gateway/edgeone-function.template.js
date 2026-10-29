/**
 * MyShip CAS Edge Router — 腾讯云 EdgeOne 标准站点边缘函数模板
 *
 * 使用说明：
 * 运行 `myship build-edge-fn` (或在 `myship login` 后) 会自动将下方的 `__MYSHIP_COS_ORIGIN__`
 * 替换为你自己的腾讯云 COS 存储桶域名，并输出到 `.myship/edgeone-function.dist.js`。
 *
 * 工作流：
 *   1. 从 Host 请求头提取子域名前缀 (例如 app1-v2.ship.example.com -> app1-v2)
 *   2. 实时从 COS 读取 aliases/<subdomain>.json 获取 deploymentId
 *   3. 从 COS 读取 manifests/<deploymentId>.json，按请求路径匹配文件（支持 SPA 路由回退 /index.html）
 *   4. 从 COS 读取 blobs/<sha256> 内容块并返回，注入 X-MyShip-* 诊断响应头
 */

const COS_ORIGIN = '__MYSHIP_COS_ORIGIN__';

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

async function handleRequest(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  const subdomain = extractSubdomain(host);

  // 1. 解析子域名对应的 Deployment ID
  const aliasData = await fetchCosJson(`aliases/${subdomain}.json`, 0);
  const deploymentId =
    aliasData && aliasData.deploymentId
      ? aliasData.deploymentId
      : subdomain.startsWith('dpl-')
      ? subdomain.replace(/^dpl-/, 'dpl_')
      : null;

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

  // 2. 读取不可变 Manifest 清单
  const manifest = await fetchCosJson(`manifests/${deploymentId}.json`, 3600);
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

  // 4. 从 COS CAS 池读取真实文件块 blobs/<sha256>
  const blobUrl = `${COS_ORIGIN}/blobs/${fileEntry.sha256}`;
  const blobRes = await fetch(blobUrl);
  if (!blobRes.ok) {
    return new Response(`502 CAS Blob Missing: ${fileEntry.sha256}`, { status: 502 });
  }

  const isHtml = (fileEntry.contentType || '').includes('text/html');
  return new Response(blobRes.body, {
    status: 200,
    headers: {
      'Content-Type': fileEntry.contentType || 'application/octet-stream',
      'X-MyShip-Engine': 'EdgeOne-CAS-Gateway/1.0',
      'X-MyShip-Subdomain': subdomain,
      'X-MyShip-Deployment-Id': deploymentId,
      'X-MyShip-Blob-Sha256': fileEntry.sha256,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': isHtml
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=3600',
    },
  });
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});
