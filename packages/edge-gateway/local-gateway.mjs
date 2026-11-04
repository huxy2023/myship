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
    getProjectEnv(project) {
      const p = resolve(storageDir, 'envs', `${project || 'default'}.json`);
      if (!existsSync(p)) return {};
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        return (parsed && parsed.vars) || {};
      } catch {
        return {};
      }
    },
  };
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildLocalUnavailableResponse(request, info) {
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
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'retry-after': '120',
    'x-myship-engine': 'EdgeOne-Local-Gateway/2.2-SCF-Backend',
    'x-myship-status': 'offline',
    'x-myship-offline-scope': info.scope || 'project',
    'x-myship-project': info.project || 'default',
    'x-myship-subdomain': info.subdomain || '',
    'x-myship-deployment-id': info.deploymentId || '',
  };
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: commonHeaders });
  const reasonText = info.reason || '站点维护中 / 管理员已暂停访问';
  if (isBackendPath || accept.includes('application/json')) {
    return new Response(
      JSON.stringify({
        ok: false, status: 503, error: 'SERVICE_UNAVAILABLE', message: reasonText,
        scope: info.scope || 'project', reason: reasonText, project: info.project || 'default',
        subdomain: info.subdomain || '', deploymentId: info.deploymentId || '',
      }),
      { status: 503, headers: { ...commonHeaders, 'content-type': 'application/json; charset=UTF-8' } }
    );
  }
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>503 站点已下线维护 - MyShip</title></head><body><h1>503 · ${escapeHtml(reasonText)}</h1><p>Project: ${escapeHtml(info.project || 'default')} (${escapeHtml(info.subdomain || '')})</p></body></html>`,
    { status: 503, headers: { ...commonHeaders, 'content-type': 'text/html; charset=UTF-8' } }
  );
}

export async function handleEdgeRequest(request, adapter = createLocalStorageAdapter()) {
  const url = new URL(request.url);
  const hostHeader =
    request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  const subdomain = hostHeader.split('.')[0].split(':')[0];

  const aliasRecord = await adapter.getAlias(subdomain);
  const immMatch = subdomain.match(/-([0-9a-f]{8})$/);
  const deploymentId =
    aliasRecord?.deploymentId ||
    (subdomain.startsWith('dpl-')
      ? subdomain.replace('dpl-', 'dpl_')
      : immMatch
      ? `dpl_${immMatch[1]}`
      : null);

  if (!deploymentId) {
    return new Response(
      `[MyShip Edge Gateway] 404 Not Found: 未找到子域名 "${subdomain}" 绑定的部署版本`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=UTF-8' } }
    );
  }

  if (aliasRecord && (aliasRecord.disabled === true || aliasRecord.projectDisabled === true)) {
    const isAliasDisabled = aliasRecord.disabled === true;
    return buildLocalUnavailableResponse(request, {
      subdomain,
      deploymentId,
      project: aliasRecord.project || 'default',
      scope: isAliasDisabled ? 'alias' : 'project',
      reason:
        (isAliasDisabled ? aliasRecord.disabledReason : aliasRecord.projectDisabledReason) ||
        '站点维护中 / 管理员已暂停访问',
    });
  }

  const manifest = await adapter.getManifest(deploymentId);
  if (!manifest) {
    return new Response(
      `[MyShip Edge Gateway] 500 Manifest Missing: 找不到版本清单 ${deploymentId}`,
      { status: 500, headers: { 'content-type': 'text/plain; charset=UTF-8' } }
    );
  }

  if (manifest.disabled === true || manifest.projectDisabled === true) {
    const isDplDisabled = manifest.disabled === true;
    return buildLocalUnavailableResponse(request, {
      subdomain,
      deploymentId,
      project: manifest.project || aliasRecord?.project || 'default',
      scope: isDplDisabled ? 'deployment' : 'project',
      reason:
        (isDplDisabled ? manifest.disabledReason : manifest.projectDisabledReason) ||
        (isDplDisabled ? '当前部署版本已被管理员禁用' : '站点维护中 / 管理员已暂停访问'),
      backendPrefix: manifest.backend?.prefix || '/api',
    });
  }

  // 1. 优先匹配项目级全栈 SCF 后端 (manifest.backend) 或约定式 Serverless 路由 (manifest.functions)
  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  const backendCfg = manifest.backend;
  const prefix = (backendCfg && backendCfg.prefix) || '/api';
  const matchesBackendPrefix =
    backendCfg &&
    backendCfg.upstreamUrl &&
    (prefix === '/' ||
      rawPathname === prefix ||
      rawPathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));

  const fnMeta = matchesBackendPrefix
    ? {
        upstreamUrl: backendCfg.upstreamUrl,
        gatewayToken: backendCfg.gatewayToken || '',
        scfVersion: backendCfg.scfVersion || '',
        preservePath: true,
      }
    : manifest.functions && manifest.functions[normalizedRoute];
  if (fnMeta) {
    // 方案 C / 全栈 SCF 业务后端: 若配置了腾讯云 SCF 函数 URL (upstreamUrl)，执行边缘反向代理
    if (fnMeta.upstreamUrl) {
      const method = (request.method || 'GET').toUpperCase();
      const baseProxyHeaders = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-myship-engine': 'EdgeOne-Local-Gateway/2.2-SCF-Backend',
        'x-myship-proxy-mode': 'SCF-Function-URL',
        'x-myship-project': manifest.project || 'default',
        'x-myship-subdomain': subdomain,
        'x-deployment-id': deploymentId,
        'x-myship-deployment-id': deploymentId,
        'x-myship-function-route': rawPathname,
      };
      if (fnMeta.scfVersion) {
        baseProxyHeaders['x-myship-backend-version'] = String(fnMeta.scfVersion);
      }
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: baseProxyHeaders });
      }
      try {
        const targetUrl = new URL(fnMeta.upstreamUrl);
        if (targetUrl.pathname === '/' || targetUrl.pathname === '') {
          targetUrl.pathname = rawPathname;
        }
        if (url.search) targetUrl.search = url.search;
        const forwardHeaders = {};
        request.headers.forEach((v, k) => {
          if (k.toLowerCase() !== 'host') forwardHeaders[k] = v;
        });
        forwardHeaders['x-myship-project'] = manifest.project || 'default';
        forwardHeaders['x-myship-subdomain'] = subdomain;
        forwardHeaders['x-myship-deployment-id'] = deploymentId;
        forwardHeaders['x-myship-function-route'] = rawPathname;
        if (fnMeta.scfVersion) {
          forwardHeaders['x-myship-backend-version'] = String(fnMeta.scfVersion);
        }
        if (fnMeta.gatewayToken) {
          forwardHeaders['x-myship-gateway-token'] = fnMeta.gatewayToken;
        }

        const upstreamRes = await fetch(targetUrl.toString(), {
          method,
          headers: forwardHeaders,
          body: method !== 'GET' && method !== 'HEAD' ? request.body : undefined,
          duplex: method !== 'GET' && method !== 'HEAD' ? 'half' : undefined,
        });
        const mergedHeaders = { ...baseProxyHeaders };
        upstreamRes.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (
            lower === 'content-disposition' &&
            String(v).toLowerCase().trim() === 'attachment'
          ) {
            return;
          }
          if (
            lower !== 'content-encoding' &&
            lower !== 'content-length' &&
            lower !== 'transfer-encoding' &&
            lower !== 'connection'
          ) {
            mergedHeaders[k] = v;
          }
        });
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: mergedHeaders,
        });
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: 'SCF Function URL Upstream Proxy Failed',
            message: err?.message || String(err),
            route: normalizedRoute,
            deploymentId,
          }),
          {
            status: 502,
            headers: { ...baseProxyHeaders, 'content-type': 'application/json; charset=UTF-8' },
          }
        );
      }
    }

    if (fnMeta.sha256) {
      const resolvedProject = manifest.project || 'default';
      const projectEnv =
        typeof adapter.getProjectEnv === 'function'
          ? { ...(await adapter.getProjectEnv(resolvedProject)) }
          : {};
      const cacheKey = `${resolvedProject}:${fnMeta.sha256}:${JSON.stringify(projectEnv)}`;
      let modExports = LOCAL_FN_CACHE.get(cacheKey);
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
          fnMeta.source || normalizedRoute,
          projectEnv
        );
        LOCAL_FN_CACHE.set(cacheKey, modExports);
      }

      const context = {
        deploymentId,
        subdomain,
        project: resolvedProject,
        route: normalizedRoute,
        sha256: fnMeta.sha256,
        url,
        query: Object.fromEntries(url.searchParams),
        env: projectEnv,
      };
      return await invokeServerlessModule(modExports, request, context);
    }
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
