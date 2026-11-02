import http from 'node:http';
import { readFileSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_STORAGE_DIR,
  MIME_MAP,
  BLOCKED_DIRS,
  isSensitiveEntry,
  sha256Hex,
  normalizeDomainToken,
  detectProjectContext,
  hasBackendEnabledAtRoot,
} from './project-context.mjs';
import { loadDevProjectEnv } from './env-manager.mjs';
import {
  resolveApiDir,
  scanApiFunctions,
  validateEdgeFunctionCompliance,
  compileServerlessModule,
  invokeServerlessModule,
} from './serverless.mjs';
import {
  resolveBackendEntry,
  bundleScfBackend,
  createLocalPersistentStorage,
  dispatchFullStackModule,
} from './scf-bundler.mjs';

function resolveSafeStaticFile(staticRoot, reqPath) {
  if (!staticRoot || !existsSync(staticRoot)) return null;
  let decodedPath = reqPath;
  try {
    decodedPath = decodeURIComponent(reqPath);
  } catch {
    return null;
  }
  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return null;
  }
  const normalizedRel = decodedPath.replace(/^\/+/, '');
  const segments = normalizedRel.split('/').filter(Boolean);
  for (const seg of segments) {
    if (seg === '.' || seg === '..' || BLOCKED_DIRS.has(seg) || isSensitiveEntry(seg)) {
      return null;
    }
  }
  const hasBackendRoot = hasBackendEnabledAtRoot(staticRoot);
  const isProjectRoot =
    hasBackendRoot ||
    existsSync(resolve(staticRoot, 'api')) ||
    existsSync(resolve(staticRoot, 'package.json')) ||
    existsSync(resolve(staticRoot, '.myship', 'project.json'));

  if (
    normalizedRel.startsWith('server/') ||
    normalizedRel === 'server' ||
    normalizedRel.startsWith('backend/') ||
    normalizedRel === 'backend' ||
    (hasBackendRoot && (normalizedRel.startsWith('lib/') || normalizedRel === 'lib')) ||
    (isProjectRoot &&
      (normalizedRel === 'package.json' ||
        normalizedRel === 'package-lock.json' ||
        normalizedRel === 'pnpm-lock.yaml' ||
        normalizedRel === 'yarn.lock' ||
        normalizedRel === 'tsconfig.json'))
  ) {
    return null;
  }
  if (
    (normalizedRel.startsWith('api/') || normalizedRel === 'api') &&
    (normalizedRel.endsWith('.js') ||
      normalizedRel.endsWith('.mjs') ||
      normalizedRel.endsWith('.cjs') ||
      normalizedRel.endsWith('.ts') ||
      normalizedRel === 'api/upstreams.json')
  ) {
    return null;
  }
  const fullPath = resolve(staticRoot, normalizedRel);
  if (
    fullPath !== staticRoot &&
    !fullPath.startsWith(`${staticRoot}/`) &&
    !fullPath.startsWith(`${staticRoot}\\`)
  ) {
    return null;
  }
  if (!existsSync(fullPath)) return null;
  const st = statSync(fullPath);
  if (!st.isFile()) return null;
  return { fullPath, size: st.size };
}

export function createDevRequestHandler({
  staticDir,
  cwd = process.cwd(),
  project = 'default',
  storageDir = DEFAULT_STORAGE_DIR,
  apiDir = null,
} = {}) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const resolvedStaticRoot = resolve(cwd, staticDir || '.');

  return async function handleDevRequest(request) {
    const url = new URL(request.url);
    let rawPathname = url.pathname;
    try {
      rawPathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('400 Bad Request: Malformed URI', { status: 400 });
    }

    const normalizedRoute =
      rawPathname.length > 1 && rawPathname.endsWith('/')
        ? rawPathname.slice(0, -1)
        : rawPathname;

    const projCtx = detectProjectContext(cwd, cleanProj);
    const scfBackendEnabled = Boolean(projCtx.backend && projCtx.backend.enabled);
    const serverEntry = resolveBackendEntry(
      cwd,
      resolvedStaticRoot,
      projCtx.backend?.entry || null
    );
    const backendPrefix = projCtx.backend?.prefix || '/api';
    const isBackendRoute =
      rawPathname === backendPrefix ||
      rawPathname.startsWith(backendPrefix.endsWith('/') ? backendPrefix : `${backendPrefix}/`);

    // 模式 1：当项目开启了 SCF 后端开关 (backend.enabled) 或存在 server/index.mjs 时，与云端 SCF Web 函数同源执行
    if (
      isBackendRoute &&
      serverEntry &&
      (scfBackendEnabled || serverEntry.mode === 'entry')
    ) {
      const method = (request.method || 'GET').toUpperCase();
      const baseHeaders = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-myship-engine': 'MyShip-Dev-Server/2.2-SCF-Node',
        'x-myship-project': cleanProj,
        'x-myship-deployment-id': 'dpl_dev_live',
        'x-myship-backend-version': 'dev-local',
      };
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: baseHeaders });
      }

      const projectEnv = loadDevProjectEnv(cleanProj, cwd, storageDir);
      Object.assign(process.env, projectEnv);
      const storage = createLocalPersistentStorage(cwd, cleanProj);
      globalThis.myshipStorage = storage;
      if (typeof process.setSourceMapsEnabled === 'function') {
        process.setSourceMapsEnabled(true);
      }

      try {
        const bundled = await bundleScfBackend({
          cwd,
          targetDir: resolvedStaticRoot,
          explicitEntry: projCtx.backend?.entry || null,
        });
        const entryDir =
          serverEntry.mode === 'entry' ? dirname(serverEntry.entryPath) : serverEntry.apiDir;
        const tmpBundleFile = resolve(
          entryDir,
          `.myship-dev-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`
        );
        let modExports;
        try {
          writeFileSync(tmpBundleFile, bundled.appBundleCode, 'utf8');
          modExports = await import(pathToFileURL(tmpBundleFile).href);
        } finally {
          rmSync(tmpBundleFile, { force: true });
        }

        const context = {
          request,
          deploymentId: 'dpl_dev_live',
          subdomain: cleanProj,
          project: cleanProj,
          scfVersion: 'dev-local',
          route: normalizedRoute,
          pathname: rawPathname,
          url,
          query: Object.fromEntries(url.searchParams),
          env: { ...process.env, ...projectEnv },
          storage,
          clientIp: request.headers.get('x-forwarded-for') || '127.0.0.1',
        };

        const result = await dispatchFullStackModule(modExports, request, context);
        const mergedHeaders = { ...baseHeaders };
        result.headers.forEach((v, k) => {
          mergedHeaders[k] = v;
        });
        return new Response(result.body, {
          status: result.status || 200,
          headers: mergedHeaders,
        });
      } catch (err) {
        const errStack = err?.stack || String(err);
        try {
          const existing = (await storage.get('__myship_logs', [])) || [];
          const entry = {
            timestamp: new Date().toISOString(),
            requestId: `dev_${Math.random().toString(36).slice(2, 8)}`,
            project: cleanProj,
            scfVersion: 'dev-local',
            deploymentId: 'dpl_dev_live',
            subdomain: cleanProj,
            method,
            path: rawPathname,
            status: 500,
            durationMs: 0,
            level: 'ERROR',
            error: err?.message || String(err),
            stack: errStack,
            lines: [],
          };
          await storage.set('__myship_logs', [entry, ...(Array.isArray(existing) ? existing : [])].slice(0, 80));
        } catch {
          // ignore local log write error
        }
        return new Response(
          JSON.stringify({
            error: err?.message || String(err),
            route: normalizedRoute,
            mode: 'myship-dev-scf',
          }),
          {
            status: 500,
            headers: { ...baseHeaders, 'content-type': 'application/json; charset=UTF-8' },
          }
        );
      }
    }

    const resolvedApiDir = resolveApiDir(resolvedStaticRoot, cwd, apiDir);
    const apiFunctions = scanApiFunctions(resolvedApiDir);
    const fnMeta = apiFunctions.find((f) => f.route === normalizedRoute);

    if (fnMeta) {
      const projectEnv = loadDevProjectEnv(cleanProj, cwd, storageDir);
      const fnHash = sha256Hex(Buffer.from(fnMeta.sourceCode, 'utf8'));

      if (fnMeta.upstreamUrl) {
        const method = (request.method || 'GET').toUpperCase();
        const baseProxyHeaders = {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
          'cache-control': 'no-store, no-cache, must-revalidate',
          'x-myship-engine': 'MyShip-Dev-Server/2.1-SchemeC-SCF-Proxy',
          'x-myship-project': cleanProj,
          'x-myship-deployment-id': 'dpl_dev_live',
          'x-myship-function-route': normalizedRoute,
        };
        if (method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: baseProxyHeaders });
        }
        try {
          const targetUrl = new URL(fnMeta.upstreamUrl);
          if (url.search) targetUrl.search = url.search;
          const forwardHeaders = {};
          request.headers.forEach((v, k) => {
            if (k.toLowerCase() !== 'host') forwardHeaders[k] = v;
          });
          forwardHeaders['x-myship-project'] = cleanProj;
          forwardHeaders['x-myship-subdomain'] = cleanProj;
          forwardHeaders['x-myship-deployment-id'] = 'dpl_dev_live';
          forwardHeaders['x-myship-function-route'] = normalizedRoute;

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
              lower !== 'content-encoding' &&
              lower !== 'content-length' &&
              lower !== 'transfer-encoding'
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
              mode: 'myship-dev',
            }),
            {
              status: 502,
              headers: { ...baseProxyHeaders, 'content-type': 'application/json; charset=UTF-8' },
            }
          );
        }
      }

      let modExports;
      try {
        validateEdgeFunctionCompliance(fnMeta.sourceCode, fnMeta.relSource, fnMeta.size);
        modExports = compileServerlessModule(fnMeta.sourceCode, fnMeta.relSource, projectEnv);
      } catch (compileErr) {
        return new Response(
          JSON.stringify({
            error: compileErr?.message || String(compileErr),
            route: normalizedRoute,
            source: fnMeta.relSource,
            mode: 'myship-dev',
          }),
          {
            status: 500,
            headers: {
              'content-type': 'application/json; charset=UTF-8',
              'access-control-allow-origin': '*',
              'cache-control': 'no-store, no-cache, must-revalidate',
            },
          }
        );
      }

      const defaultGeo = {
        countryName: 'China',
        countryCodeAlpha2: 'CN',
        regionName: 'LocalDev',
        cityName: 'Localhost',
        cisp: 'MyShip-Dev-Simulator',
      };
      const context = {
        deploymentId: 'dpl_dev_live',
        subdomain: cleanProj,
        project: cleanProj,
        route: normalizedRoute,
        sha256: fnHash,
        url,
        query: Object.fromEntries(url.searchParams),
        env: projectEnv,
        geo: (request && request.eo && request.eo.geo) || defaultGeo,
        clientIp: request.headers.get('x-forwarded-for') || '127.0.0.1',
      };
      return await invokeServerlessModule(modExports, request, context);
    }

    let reqPath = rawPathname === '/' ? '/index.html' : rawPathname;
    if (reqPath.endsWith('/')) reqPath += 'index.html';

    let matchedFile = resolveSafeStaticFile(resolvedStaticRoot, reqPath);
    if (!matchedFile && !reqPath.includes('.')) {
      matchedFile = resolveSafeStaticFile(resolvedStaticRoot, `${reqPath}/index.html`);
    }
    if (!matchedFile && !reqPath.includes('.') && !reqPath.startsWith('/api/')) {
      matchedFile =
        resolveSafeStaticFile(resolvedStaticRoot, '/200.html') ||
        resolveSafeStaticFile(resolvedStaticRoot, '/index.html');
    }

    if (!matchedFile) {
      return new Response(
        `[MyShip Dev Server] 404 File Not Found: ${url.pathname}`,
        {
          status: 404,
          headers: {
            'content-type': 'text/plain; charset=UTF-8',
            'cache-control': 'no-store',
          },
        }
      );
    }

    const content = readFileSync(matchedFile.fullPath);
    const ext = extname(matchedFile.fullPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    return new Response(content, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(matchedFile.size),
        'cache-control': 'no-store, no-cache, must-revalidate',
        'x-myship-engine': 'MyShip-Dev-Server/2.1-Live',
        'x-myship-project': cleanProj,
      },
    });
  };
}

export function startDevServer({
  staticDir,
  cwd = process.cwd(),
  project = 'default',
  port = 3000,
  storageDir = DEFAULT_STORAGE_DIR,
  apiDir = null,
} = {}) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const resolvedStaticRoot = resolve(cwd, staticDir || '.');
  const handler = createDevRequestHandler({
    staticDir: resolvedStaticRoot,
    cwd,
    project: cleanProj,
    storageDir,
    apiDir,
  });

  const server = http.createServer(async (req, res) => {
    const startMs = Date.now();
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
    const webRes = await handler(webReq);
    res.statusCode = webRes.status;
    webRes.headers.forEach((v, k) => res.setHeader(k, v));
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
    const elapsed = Date.now() - startMs;
    console.log(`  [${new Date().toLocaleTimeString()}] ${method} ${req.url} -> ${webRes.status} (${elapsed}ms)`);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.on('error', rejectPromise);
    server.listen(port, () => {
      const resolvedApi = resolveApiDir(resolvedStaticRoot, cwd, apiDir);
      const apiFns = scanApiFunctions(resolvedApi);
      const envVars = loadDevProjectEnv(cleanProj, cwd, storageDir);
      console.log('==============================================================');
      console.log(`⚡ MyShip Dev — 本地全栈即时开发服务器已启动 (免打包实时热加载)`);
      console.log(`   🏷️  当前项目: [${cleanProj}]`);
      console.log(`   📁 静态目录: ${resolvedStaticRoot}`);
      console.log(
        `   ⚡ API 路由: ${
          apiFns.length > 0 ? apiFns.map((f) => f.route).join(', ') : '(尚未检测到 api/*.js)'
        }`
      );
      console.log(`   🔐 环境变量: 已加载 ${Object.keys(envVars).length} 项 (.env / myship env)`);
      console.log(`   🌐 本地访问: http://localhost:${port}`);
      console.log('==============================================================');
      resolvePromise(server);
    });
  });
}
