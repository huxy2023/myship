/**
 * local-gateway.mjs — 本地 4100 端口泛域名动态 Host 模拟边缘路由网关 (Phase 2 全栈版)
 *
 * 无需任何云端账号，本地即可通过 http://<subdomain>.ship.localhost:4100
 * 体验静态资源 + 约定式云函数 (api/*.js) 的同版本原子切流与 0 秒回滚。
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STORAGE_DIR,
  compileServerlessModule,
  invokeServerlessModule,
} from '../cli/myship.mjs';

const LOCAL_FN_CACHE = new Map(); // sha256 -> compiled module exports

export function createLocalStorageAdapter(storageDir = DEFAULT_STORAGE_DIR) {
  return {
    getAlias(subdomain) {
      const p = resolve(storageDir, 'aliases', `${subdomain}.json`);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    getManifest(deploymentId) {
      const p = resolve(storageDir, 'manifests', `${deploymentId}.json`);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    },
    getBlob(sha256) {
      const p = resolve(storageDir, 'blobs', sha256);
      return existsSync(p) ? readFileSync(p) : null;
    },
  };
}

export async function handleEdgeRequest(request, adapter = createLocalStorageAdapter()) {
  const url = new URL(request.url);
  const hostHeader =
    request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const subdomain = hostHeader.split('.')[0].split(':')[0];

  const aliasRecord = await adapter.getAlias(subdomain);
  const deploymentId =
    aliasRecord?.deploymentId ||
    (subdomain.startsWith('dpl-') ? subdomain.replace('dpl-', 'dpl_') : null);

  if (!deploymentId) {
    return new Response(
      `[MyShip Edge Gateway] 404 Not Found: 未找到子域名 "${subdomain}" 绑定的部署版本`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=UTF-8' } }
    );
  }

  const manifest = await adapter.getManifest(deploymentId);
  if (!manifest) {
    return new Response(
      `[MyShip Edge Gateway] 500 Manifest Missing: 找不到版本清单 ${deploymentId}`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8' } }
    );
  }

  // 1. 优先匹配 Phase 2 约定式 Serverless 云函数路由 (manifest.functions)
  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  const fnMeta = manifest.functions && manifest.functions[normalizedRoute];
  if (fnMeta && fnMeta.sha256) {
    let modExports = LOCAL_FN_CACHE.get(fnMeta.sha256);
    if (!modExports) {
      const fnBlob = await adapter.getBlob(fnMeta.sha256);
      if (!fnBlob) {
        return new Response(
          JSON.stringify({
            error: `500 Function Blob Missing: ${fnMeta.sha256}`,
            deploymentId,
          }),
          { status: 500, headers: { 'content-type': 'application/json; charset=UTF-8' } }
        );
      }
      modExports = compileServerlessModule(
        fnBlob.toString('utf8'),
        fnMeta.source || normalizedRoute
      );
      LOCAL_FN_CACHE.set(fnMeta.sha256, modExports);
    }

    const context = {
      deploymentId,
      subdomain,
      project: manifest.project || 'default',
      route: normalizedRoute,
      sha256: fnMeta.sha256,
      url,
      query: Object.fromEntries(url.searchParams),
    };
    return await invokeServerlessModule(modExports, request, context);
  }

  // 2. 匹配静态文件路由 (manifest.files) 与 SPA History Fallback
  let reqPath = rawPathname === '/' ? '/index.html' : rawPathname;
  if (reqPath.endsWith('/')) reqPath += 'index.html';

  let fileMeta = manifest.files[reqPath];
  if (!fileMeta && !reqPath.includes('.')) {
    fileMeta = manifest.files[`${reqPath}/index.html`];
  }
  if (!fileMeta && manifest.spaFallback && !reqPath.includes('.') && !reqPath.startsWith('/api/')) {
    reqPath = manifest.spaFallback;
    fileMeta = manifest.files[reqPath];
  }

  if (!fileMeta) {
    return new Response(
      `[MyShip Edge Gateway] 404 File Not Found: ${url.pathname} (Deployment: ${deploymentId})`,
      {
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'x-deployment-id': deploymentId,
        },
      }
    );
  }

  const blobBuffer = await adapter.getBlob(fileMeta.sha256);
  if (!blobBuffer) {
    return new Response(`[MyShip Edge Gateway] 500 Blob Missing: ${fileMeta.sha256}`, {
      status: 500,
    });
  }

  const isHtml = fileMeta.contentType.startsWith('text/html');
  return new Response(blobBuffer, {
    status: 200,
    headers: {
      'content-type': fileMeta.contentType,
      'content-length': String(fileMeta.size),
      etag: `"${fileMeta.sha256}"`,
      'x-deployment-id': deploymentId,
      'x-subdomain-alias': subdomain,
      'cache-control': isHtml
        ? 'public, max-age=0, must-revalidate'
        : 'public, max-age=31536000, immutable',
    },
  });
}

export function startLocalEdgeGateway({ port = 4100, storageDir = DEFAULT_STORAGE_DIR } = {}) {
  const adapter = createLocalStorageAdapter(storageDir);
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || `localhost:${port}`;
    const method = (req.method || 'GET').toUpperCase();
    let bodyBuf = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      if (chunks.length > 0) {
        bodyBuf = Buffer.concat(chunks);
      }
    }
    const webReq = new Request(`http://${host}${req.url}`, {
      method,
      headers: req.headers,
      body: bodyBuf,
    });
    const webRes = await handleEdgeRequest(webReq, adapter);
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  });

  return new Promise((resolvePromise) => {
    server.listen(port, () => {
      console.log(`🌐 本地泛域名全栈边缘网关已启动: http://*.ship.localhost:${port}`);
      resolvePromise(server);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4100);
  startLocalEdgeGateway({ port });
}
