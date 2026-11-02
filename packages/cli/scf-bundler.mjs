/**
 * scf-bundler.mjs — MyShip 全栈业务后端 (腾讯云 SCF Web 函数) 构建与打包引擎
 *
 * 设计契约（克制、强约定）：
 * 1. 统一支持现代 ESM + Web Standard Fetch 契约 (`export async function fetch(request, context)` 或 Hono `export default app`)。
 * 2. 使用 `esbuild` 标准打包 (`bundle: true, format: 'esm', platform: 'node', sourcemap: 'inline'`)
 *    配合 `node --enable-source-maps` 与 `process.setSourceMapsEnabled(true)`，无需手写 AST/正则改写源码或拆包重编 `node_modules`，
 *    即可 100% 兼容 TypeScript、无后缀相对引用、pnpm 软链接与第三方 npm 依赖，并精确还原真实源码文件名与行号堆栈。
 * 3. 递归保留后端目录下的非代码静态模板/数据文件 (`server/**` `.txt`, `.json`, `.sql` 等)，使本地 `myship dev` 与云端 SCF 产物完全一致。
 */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { walkFiles, normalizeDomainToken } from './project-context.mjs';
import { normalizeApiRoute, resolveApiDir, invokeServerlessModule as dispatchEdgeModule } from './serverless.mjs';

function parsePackageNameFromNodeModulesPath(relPath) {
  const norm = relPath.split('\\').join('/');
  const idx = norm.lastIndexOf('node_modules/');
  if (idx === -1) return null;
  const rest = norm.slice(idx + 'node_modules/'.length);
  const parts = rest.split('/');
  if (parts[0].startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || null;
}

async function loadEsbuild(cwd = process.cwd()) {
  try {
    return await import('esbuild');
  } catch {
    try {
      const reqFromCwd = createRequire(resolve(cwd, 'package.json'));
      return reqFromCwd('esbuild');
    } catch {
      throw new Error(
        '未找到 `esbuild` 打包器依赖。请在项目或 CLI 目录下执行 `npm install esbuild` 或 `pnpm add -D esbuild`。'
      );
    }
  }
}

const SERVER_ENTRY_CANDIDATES = [
  'server/index.mjs',
  'server/index.js',
  'server/index.ts',
  'server/app.mjs',
  'server/app.js',
  'server/app.ts',
  'backend/index.mjs',
  'backend/index.js',
  'backend/index.ts',
];

export function resolveBackendEntry(cwd = process.cwd(), targetDir = null, explicitEntry = null) {
  if (explicitEntry) {
    const absExplicit = resolve(cwd, explicitEntry);
    if (existsSync(absExplicit)) {
      const st = statSync(absExplicit);
      if (st.isFile()) {
        return {
          mode: 'entry',
          entryPath: absExplicit,
          relEntry: relative(cwd, absExplicit).split('\\').join('/'),
        };
      }
      if (st.isDirectory()) {
        const rawFiles = walkFiles(absExplicit, absExplicit, { excludeApiJs: false }).filter(
          (f) =>
            f.relPath.endsWith('.js') ||
            f.relPath.endsWith('.mjs') ||
            f.relPath.endsWith('.ts')
        );
        if (rawFiles.length > 0) {
          return {
            mode: 'api-dir',
            apiDir: absExplicit,
            relEntry: relative(cwd, absExplicit).split('\\').join('/') || 'api',
            files: rawFiles.map((f) => ({
              ...f,
              route: normalizeApiRoute(f.relPath),
            })),
          };
        }
      }
    }
    throw new Error(`指定的后端入口文件不存在: ${explicitEntry} (${absExplicit})`);
  }

  for (const candidate of SERVER_ENTRY_CANDIDATES) {
    const abs = resolve(cwd, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) {
      return {
        mode: 'entry',
        entryPath: abs,
        relEntry: candidate,
      };
    }
  }

  const absTarget = targetDir ? resolve(cwd, targetDir) : cwd;
  const apiDir = resolveApiDir(absTarget, cwd);
  if (apiDir) {
    const rawFiles = walkFiles(apiDir, apiDir, { excludeApiJs: false }).filter(
      (f) =>
        f.relPath.endsWith('.js') ||
        f.relPath.endsWith('.mjs') ||
        f.relPath.endsWith('.ts')
    );
    if (rawFiles.length > 0) {
      return {
        mode: 'api-dir',
        apiDir,
        relEntry: relative(cwd, apiDir).split('\\').join('/') || 'api',
        files: rawFiles.map((f) => ({
          ...f,
          route: normalizeApiRoute(f.relPath),
        })),
      };
    }
  }

  return null;
}

/**
 * 本地开发模式 (myship dev / --local) 下的持久化数据存储实现
 * 落盘在 <cwd>/.myship/data/<project>/<key>.json，与代码版本解耦
 */
export function createLocalPersistentStorage(cwd = process.cwd(), project = 'default') {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const baseDir = resolve(cwd, '.myship', 'data', cleanProj);

  function sanitizeKey(key) {
    const clean = String(key || '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.json$/i, '')
      .replace(/[^a-zA-Z0-9/_-]/g, '_');
    if (!clean || clean.includes('..')) {
      throw new Error(`无效的存储 Key: ${key}`);
    }
    return clean;
  }

  return {
    async get(key, defaultValue = null) {
      const safe = sanitizeKey(key);
      const filePath = resolve(baseDir, `${safe}.json`);
      if (!existsSync(filePath)) return defaultValue;
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        return parsed && Object.prototype.hasOwnProperty.call(parsed, 'value')
          ? parsed.value
          : parsed;
      } catch {
        return defaultValue;
      }
    },
    async set(key, value) {
      const safe = sanitizeKey(key);
      const filePath = resolve(baseDir, `${safe}.json`);
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = {
        key: safe,
        project: cleanProj,
        value,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      return value;
    },
    async delete(key) {
      const safe = sanitizeKey(key);
      const filePath = resolve(baseDir, `${safe}.json`);
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
      return true;
    },
    async list(prefix = '') {
      if (!existsSync(baseDir)) return [];
      const all = [];
      function walk(dir, relPrefix = '') {
        for (const item of readdirSync(dir)) {
          const full = resolve(dir, item);
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, `${relPrefix}${item}/`);
          } else if (item.endsWith('.json')) {
            const k = `${relPrefix}${item.slice(0, -5)}`;
            if (!prefix || k.startsWith(prefix)) {
              all.push(k);
            }
          }
        }
      }
      walk(baseDir, '');
      return all.sort();
    },
  };
}

export async function dispatchFullStackModule(rawMod, request, context) {
  const mod =
    rawMod &&
    rawMod.default &&
    typeof rawMod.default === 'object' &&
    !rawMod.fetch &&
    !rawMod.GET &&
    !rawMod.POST &&
    !rawMod.onRequest &&
    (typeof rawMod.default.fetch === 'function' ||
      typeof rawMod.default.GET === 'function' ||
      typeof rawMod.default.POST === 'function' ||
      typeof rawMod.default.onRequest === 'function' ||
      typeof rawMod.default.onRequestGet === 'function' ||
      typeof rawMod.default.onRequestPost === 'function' ||
      typeof rawMod.default.handler === 'function')
      ? rawMod.default
      : rawMod;

  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoMethodKey = 'onRequest' + methodTitle;

  let handler = null;
  let isContextFirst = false;

  if (mod && typeof mod[eoMethodKey] === 'function') {
    handler = mod[eoMethodKey];
    isContextFirst = true;
  } else if (mod && typeof mod[method] === 'function') {
    handler = mod[method];
  } else if (mod && typeof mod.fetch === 'function') {
    handler = mod.fetch.bind(mod);
  } else if (mod && typeof mod.onRequest === 'function') {
    handler = mod.onRequest;
    isContextFirst = true;
  } else if (mod && typeof mod.default === 'function') {
    handler = mod.default;
    if (handler.name && handler.name.startsWith('onRequest')) {
      isContextFirst = true;
    }
  } else if (mod && typeof mod.default === 'object' && mod.default && typeof mod.default.fetch === 'function') {
    handler = mod.default.fetch.bind(mod.default);
  } else if (mod && typeof mod.handler === 'function') {
    handler = mod.handler;
  }

  if (!handler) {
    return new Response(
      JSON.stringify({
        error: 'Method ' + method + ' Not Allowed or no Web Fetch handler exported',
        route: context.route,
      }),
      { status: 405, headers: { 'content-type': 'application/json; charset=UTF-8' } }
    );
  }

  const result = isContextFirst
    ? await handler(context, request)
    : await handler(request, context);

  if (result instanceof Response || (result && typeof result.arrayBuffer === 'function' && result.headers)) {
    return result;
  }
  if (typeof result === 'string') {
    return new Response(result, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    });
  }
  return new Response(JSON.stringify(result ?? { ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function generateBootstrapRuntimeSource(userAppImportPath = '../server/index.mjs') {
  return `import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

if (typeof process.setSourceMapsEnabled === 'function') {
  process.setSourceMapsEnabled(true);
}

const userApp = await import(${JSON.stringify(userAppImportPath)});

const PORT = Number(process.env.PORT || 9000);
const PROJECT = process.env.MYSHIP_PROJECT || 'default';
const GATEWAY_TOKEN = process.env.MYSHIP_GATEWAY_TOKEN || '';

function sha1Hex(str) {
  return createHash('sha1').update(str).digest('hex');
}
function hmacSha1Hex(key, str) {
  return createHmac('sha1', key).update(str).digest('hex');
}

function sanitizeStorageKey(key) {
  const clean = String(key || '')
    .trim()
    .replace(/^\\/+|\\/+$/g, '')
    .replace(/\\.json$/i, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '_');
  if (!clean || clean.includes('..')) {
    throw new Error('Invalid storage key: ' + key);
  }
  return clean;
}

function createCloudStorage() {
  const cosOrigin = (process.env.MYSHIP_COS_ORIGIN || '').replace(/\\/$/, '');
  const secretId =
    process.env.MYSHIP_DATA_SECRET_ID || process.env.TENCENTCLOUD_SECRETID || '';
  const secretKey =
    process.env.MYSHIP_DATA_SECRET_KEY || process.env.TENCENTCLOUD_SECRETKEY || '';
  const sessionToken =
    process.env.MYSHIP_DATA_TOKEN || process.env.TENCENTCLOUD_SESSIONTOKEN || '';
  const prefixBase = 'data/' + PROJECT + '/';

  if (!cosOrigin || !secretId || !secretKey) {
    const missingErr = () => {
      throw new Error(
        'Cloud persistent storage (context.storage) is unavailable: missing COS credentials in SCF environment (MYSHIP_COS_ORIGIN / MYSHIP_DATA_SECRET_ID / MYSHIP_DATA_SECRET_KEY).'
      );
    };
    return {
      async get() { return missingErr(); },
      async set() { return missingErr(); },
      async delete() { return missingErr(); },
      async list() { return missingErr(); },
    };
  }

  function signCos(method, objectKey) {
    const url = new URL(objectKey.startsWith('/') ? objectKey : '/' + objectKey, cosOrigin);
    const now = Math.floor(Date.now() / 1000);
    const keyTime = (now - 60) + ';' + (now + 3600);
    const signKey = hmacSha1Hex(secretKey, keyTime);
    const paramEntries = [];
    for (const [k, v] of url.searchParams.entries()) {
      paramEntries.push([encodeURIComponent(k).toLowerCase(), encodeURIComponent(v)]);
    }
    paramEntries.sort((a, b) => a[0].localeCompare(b[0]));
    const urlParamList = paramEntries.map(([k]) => k).join(';');
    const httpParameters = paramEntries.map(([k, v]) => k + '=' + v).join('&');
    const httpString = method.toLowerCase() + '\\n' + url.pathname + '\\n' + httpParameters + '\\nhost=' + encodeURIComponent(url.host).toLowerCase() + '\\n';
    const stringToSign = 'sha1\\n' + keyTime + '\\n' + sha1Hex(httpString) + '\\n';
    const signature = hmacSha1Hex(signKey, stringToSign);
    const headers = {
      Authorization: [
        'q-sign-algorithm=sha1',
        'q-sign-time=' + keyTime,
        'q-key-time=' + keyTime,
        'q-ak=' + secretId,
        'q-header-list=host',
        'q-url-param-list=' + urlParamList,
        'q-signature=' + signature,
      ].join('&'),
    };
    if (sessionToken) {
      headers['x-cos-security-token'] = sessionToken;
    }
    return { url: url.toString(), headers };
  }

  return {
    async get(key, defaultValue = null) {
      const safe = sanitizeStorageKey(key);
      const objKey = prefixBase + safe + '.json';
      const { url, headers } = signCos('GET', objKey);
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 404) return defaultValue;
      if (!res.ok) throw new Error('COS storage.get failed (' + res.status + ')');
      const data = await res.json();
      return data && Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : data;
    },
    async set(key, value) {
      const safe = sanitizeStorageKey(key);
      const objKey = prefixBase + safe + '.json';
      const { url, headers } = signCos('PUT', objKey);
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      headers['x-cos-acl'] = 'private';
      const payload = JSON.stringify({
        key: safe,
        project: PROJECT,
        value,
        updatedAt: new Date().toISOString(),
      });
      const res = await fetch(url, { method: 'PUT', headers, body: payload });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('COS storage.set failed (' + res.status + '): ' + txt.slice(0, 200));
      }
      return value;
    },
    async delete(key) {
      const safe = sanitizeStorageKey(key);
      const objKey = prefixBase + safe + '.json';
      const { url, headers } = signCos('DELETE', objKey);
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error('COS storage.delete failed (' + res.status + ')');
      }
      return true;
    },
    async list(prefix = '') {
      const fullPrefix = prefixBase + (prefix ? String(prefix).replace(/^\\/+/, '') : '');
      const { url, headers } = signCos('GET', '/?prefix=' + encodeURIComponent(fullPrefix) + '&max-keys=1000');
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) throw new Error('COS storage.list failed (' + res.status + ')');
      const xml = await res.text();
      const regex = /<Key>([^<]+)<\\/Key>/g;
      const out = [];
      let m;
      while ((m = regex.exec(xml)) !== null) {
        if (m[1].startsWith(prefixBase) && m[1].endsWith('.json')) {
          out.push(m[1].slice(prefixBase.length, -5));
        }
      }
      return out.sort();
    },
  };
}

const storage = createCloudStorage();
globalThis.myshipStorage = storage;

const RECENT_LOGS = [];
const MAX_RECENT_LOGS = 100;
let activeRequestLogs = null;

function formatLogArgs(args) {
  return args
    .map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args) => {
  origLog(...args);
  if (activeRequestLogs) activeRequestLogs.push({ level: 'INFO', text: formatLogArgs(args) });
};
console.warn = (...args) => {
  origWarn(...args);
  if (activeRequestLogs) activeRequestLogs.push({ level: 'WARN', text: formatLogArgs(args) });
};
console.error = (...args) => {
  origError(...args);
  if (activeRequestLogs) activeRequestLogs.push({ level: 'ERROR', text: formatLogArgs(args) });
};

async function appendBackendLog(entry, forcePersist = false) {
  RECENT_LOGS.unshift(entry);
  if (RECENT_LOGS.length > MAX_RECENT_LOGS) {
    RECENT_LOGS.length = MAX_RECENT_LOGS;
  }
  if (forcePersist || entry.level === 'ERROR' || entry.status >= 400) {
    try {
      const existing = (await storage.get('__myship_logs', [])) || [];
      const merged = [entry, ...(Array.isArray(existing) ? existing : [])].slice(0, 80);
      await storage.set('__myship_logs', merged);
    } catch {
      // ignore storage log persistence error
    }
  }
}

async function dispatchModule(rawMod, request, context) {
  const mod =
    rawMod &&
    rawMod.default &&
    typeof rawMod.default === 'object' &&
    !rawMod.fetch &&
    !rawMod.GET &&
    !rawMod.POST &&
    !rawMod.onRequest &&
    (typeof rawMod.default.fetch === 'function' ||
      typeof rawMod.default.GET === 'function' ||
      typeof rawMod.default.POST === 'function' ||
      typeof rawMod.default.onRequest === 'function' ||
      typeof rawMod.default.onRequestGet === 'function' ||
      typeof rawMod.default.onRequestPost === 'function' ||
      typeof rawMod.default.handler === 'function')
      ? rawMod.default
      : rawMod;

  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoMethodKey = 'onRequest' + methodTitle;

  let handler = null;
  let isContextFirst = false;

  if (mod && typeof mod[eoMethodKey] === 'function') {
    handler = mod[eoMethodKey];
    isContextFirst = true;
  } else if (mod && typeof mod[method] === 'function') {
    handler = mod[method];
  } else if (mod && typeof mod.fetch === 'function') {
    handler = mod.fetch.bind(mod);
  } else if (mod && typeof mod.onRequest === 'function') {
    handler = mod.onRequest;
    isContextFirst = true;
  } else if (mod && typeof mod.default === 'function') {
    handler = mod.default;
    if (handler.name && handler.name.startsWith('onRequest')) {
      isContextFirst = true;
    }
  } else if (mod && typeof mod.default === 'object' && mod.default && typeof mod.default.fetch === 'function') {
    handler = mod.default.fetch.bind(mod.default);
  } else if (mod && typeof mod.handler === 'function') {
    handler = mod.handler;
  }

  if (!handler) {
    return new Response(
      JSON.stringify({
        error: 'Method ' + method + ' Not Allowed or no Web Fetch handler exported',
        route: context.route,
      }),
      { status: 405, headers: { 'content-type': 'application/json; charset=UTF-8' } }
    );
  }

  const result = isContextFirst
    ? await handler(context, request)
    : await handler(request, context);

  if (result instanceof Response || (result && typeof result.arrayBuffer === 'function' && result.headers)) {
    return result;
  }
  if (typeof result === 'string') {
    return new Response(result, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    });
  }
  return new Response(JSON.stringify(result ?? { ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

const server = http.createServer(async (req, res) => {
  const startMs = Date.now();
  const requestId =
    req.headers['x-scf-request-id'] ||
    req.headers['x-request-id'] ||
    'req_' + Math.random().toString(36).slice(2, 10);
  const scfVersion = process.env.SCF_FUNCTIONVERSION || '$LATEST';
  const deploymentId = req.headers['x-myship-deployment-id'] || '';
  const subdomain = req.headers['x-myship-subdomain'] || '';
  const method = (req.method || 'GET').toUpperCase();
  let pathname = req.url || '/';

  try {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    pathname = decodeURIComponent(url.pathname);

    if (GATEWAY_TOKEN) {
      const incomingToken = req.headers['x-myship-gateway-token'] || '';
      if (incomingToken !== GATEWAY_TOKEN) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=UTF-8');
        res.end(
          JSON.stringify({
            error: 'Forbidden: Missing or invalid X-MyShip-Gateway-Token',
            project: PROJECT,
          })
        );
        return;
      }
    }

    if (pathname === '/_myship_health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      res.end(
        JSON.stringify({
          ok: true,
          project: PROJECT,
          scfVersion,
          nodeVersion: process.version,
        })
      );
      return;
    }

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      res.end();
      return;
    }

    const reqLogs = [];
    activeRequestLogs = reqLogs;

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

    const webReq = new Request(url.toString(), {
      method,
      headers: req.headers,
      body: bodyBuf,
    });

    const normalizedRoute =
      pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

    const context = {
      request: webReq,
      project: PROJECT,
      deploymentId,
      subdomain,
      scfVersion,
      route: normalizedRoute,
      pathname,
      url,
      query: Object.fromEntries(url.searchParams),
      env: process.env,
      storage,
      clientIp: req.headers['x-myship-client-ip'] || req.headers['x-forwarded-for'] || '127.0.0.1',
    };

    const webRes = await dispatchModule(userApp, webReq, context);
    activeRequestLogs = null;
    const status = webRes.status || 200;
    res.statusCode = status;
    webRes.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-length') {
        res.setHeader(k, v);
      }
    });
    res.setHeader('X-MyShip-SCF-Version', scfVersion);

    if (webRes.body && typeof webRes.body.getReader === 'function') {
      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } else {
      const outBuf = Buffer.from(await webRes.arrayBuffer());
      res.setHeader('Content-Length', String(outBuf.length));
      res.end(outBuf);
    }

    await appendBackendLog(
      {
        timestamp: new Date().toISOString(),
        requestId,
        project: PROJECT,
        scfVersion,
        deploymentId,
        subdomain,
        method,
        path: pathname,
        status,
        durationMs: Date.now() - startMs,
        level: status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO',
        lines: reqLogs,
      },
      status >= 400 || reqLogs.length > 0
    );
  } catch (err) {
    const errStack = err && err.stack ? err.stack : String(err);
    const reqLogs = activeRequestLogs || [];
    activeRequestLogs = null;
    origError('[MyShip SCF Backend Error]', errStack);
    await appendBackendLog(
      {
        timestamp: new Date().toISOString(),
        requestId,
        project: PROJECT,
        scfVersion,
        deploymentId,
        subdomain,
        method,
        path: pathname,
        status: 500,
        durationMs: Date.now() - startMs,
        level: 'ERROR',
        error: err && err.message ? err.message : String(err),
        stack: errStack,
        lines: reqLogs,
      },
      true
    );
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    res.setHeader('X-MyShip-SCF-Version', scfVersion);
    res.end(
      JSON.stringify({
        error: err && err.message ? err.message : 'Internal Backend Error',
        requestId,
        project: PROJECT,
      })
    );
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[MyShip SCF Web Function] Listening on 0.0.0.0:' + PORT + ' (project: ' + PROJECT + ')');
});
`;
}

function generateApiDirVirtualEntry(apiFiles) {
  const imports = [];
  const routes = [];
  apiFiles.forEach((f, idx) => {
    const varName = `routeMod_${idx}`;
    const cleanPath = f.fullPath.split('\\').join('/');
    imports.push(`import * as ${varName} from ${JSON.stringify(cleanPath)};`);
    routes.push(`  ${JSON.stringify(f.route)}: ${varName},`);
  });

  return `${imports.join('\n')}

const ROUTE_TABLE = {
${routes.join('\n')}
};

export async function fetch(request, context) {
  const url = new URL(request.url);
  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  let targetMod = ROUTE_TABLE[normalizedRoute];
  if (!targetMod) {
    for (const [r, mod] of Object.entries(ROUTE_TABLE)) {
      if (r !== '/api' && normalizedRoute.startsWith(r + '/')) {
        targetMod = mod;
        break;
      }
    }
    if (!targetMod && ROUTE_TABLE['/api']) {
      targetMod = ROUTE_TABLE['/api'];
    }
  }

  if (!targetMod) {
    return new Response(
      JSON.stringify({
        error: 'API Route Not Found: ' + normalizedRoute,
        availableRoutes: Object.keys(ROUTE_TABLE),
      }),
      { status: 404, headers: { 'content-type': 'application/json; charset=UTF-8' } }
    );
  }

  const method = (request.method || 'GET').toUpperCase();
  const methodTitle = method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
  const eoKey = 'onRequest' + methodTitle;

  let handler = null;
  let isContextFirst = false;
  if (typeof targetMod[eoKey] === 'function') {
    handler = targetMod[eoKey];
    isContextFirst = true;
  } else if (typeof targetMod[method] === 'function') {
    handler = targetMod[method];
  } else if (typeof targetMod.fetch === 'function') {
    handler = targetMod.fetch.bind(targetMod);
  } else if (typeof targetMod.onRequest === 'function') {
    handler = targetMod.onRequest;
    isContextFirst = true;
  } else if (typeof targetMod.default === 'function') {
    handler = targetMod.default;
    if (handler.name && handler.name.startsWith('onRequest')) {
      isContextFirst = true;
    }
  } else if (typeof targetMod.handler === 'function') {
    handler = targetMod.handler;
  }

  if (!handler) {
    return new Response(
      JSON.stringify({ error: 'Method ' + method + ' Not Allowed', route: normalizedRoute }),
      { status: 405, headers: { 'content-type': 'application/json; charset=UTF-8' } }
    );
  }

  return isContextFirst ? await handler(context, request) : await handler(request, context);
}
`;
}

// ============================================================================
// 零外部命令依赖的标准 ZIP 归档构建器 (精确支持 scf_bootstrap 0o100755 可执行权限)
// ============================================================================
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8');
    const rawBuf = Buffer.isBuffer(item.content)
      ? item.content
      : Buffer.from(String(item.content), 'utf8');
    const crc = crc32(rawBuf);
    const compressedBuf = deflateRawSync(rawBuf);
    const mode = item.mode || 0o100644;

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5821, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5821, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((mode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, compressedBuf);
    centralParts.push(centralHeader);
    offset += localHeader.length + compressedBuf.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const STATIC_ASSET_EXTENSIONS = new Set([
  '.json',
  '.txt',
  '.md',
  '.sql',
  '.html',
  '.yaml',
  '.yml',
  '.csv',
  '.wasm',
]);

function mapTsRelPath(relPath) {
  return relPath.replace(/\.(mts|cts|ts)$/i, '.mjs');
}

export async function bundleScfBackend({
  cwd = process.cwd(),
  targetDir = null,
  explicitEntry = null,
} = {}) {
  const resolved = resolveBackendEntry(cwd, targetDir, explicitEntry);
  if (!resolved) {
    throw new Error(
      [
        '未找到项目后端代码入口！',
        '请创建 `server/index.mjs` (或 `api/*.js`)，或在 `.myship/project.json` 的 `backend.entry` 中指定入口文件。',
      ].join('\n')
    );
  }

  const esbuild = await loadEsbuild(cwd);
  const bannerJs = `import { createRequire as __myshipCreateRequire } from 'node:module'; const require = __myshipCreateRequire(import.meta.url && import.meta.url.startsWith('file:') ? import.meta.url : process.cwd() + '/index.js');`;

  // 使用 esbuild 标准打包 + sourcemap: 'inline' (本地 myship dev 与云端 SCF 运行完全相同的产物，且保留精确源码行号)
  let buildResult;
  try {
    if (resolved.mode === 'entry') {
      buildResult = await esbuild.build({
        entryPoints: [resolved.entryPath],
        absWorkingDir: cwd,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        sourcemap: 'inline',
        metafile: true,
        banner: { js: bannerJs },
        write: false,
        logLevel: 'silent',
      });
    } else {
      const virtualSource = generateApiDirVirtualEntry(resolved.files);
      buildResult = await esbuild.build({
        stdin: {
          contents: virtualSource,
          resolveDir: cwd,
          sourcefile: '_myship_virtual_api_entry.mjs',
          loader: 'js',
        },
        absWorkingDir: cwd,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        sourcemap: 'inline',
        metafile: true,
        banner: { js: bannerJs },
        write: false,
        logLevel: 'silent',
      });
    }
  } catch (err) {
    const detail =
      err && Array.isArray(err.errors) && err.errors.length > 0
        ? err.errors
            .map((e) => {
              const loc = e.location ? `${e.location.file}:${e.location.line}:${e.location.column}` : '';
              return `${loc ? `[${loc}] ` : ''}${e.text}`;
            })
            .join('\n  ')
        : err.message;
    throw new Error(`后端代码打包失败 (esbuild):\n  ${detail}`);
  }

  const appBundleCode = buildResult.outputFiles[0].text;

  // 从 esbuild metafile 中提取第一方源码列表与实际引用的第三方 npm 包列表
  const sourceFiles = [];
  const sourceDirs = new Set();
  const externalPackagesSet = new Set();

  for (const rawInputKey of Object.keys(buildResult?.metafile?.inputs || {})) {
    if (rawInputKey === '_myship_virtual_api_entry.mjs' || rawInputKey.startsWith('<')) {
      continue;
    }
    const absInput = resolve(cwd, rawInputKey);
    const relFromCwd = relative(cwd, absInput).split('\\').join('/');
    const pkgName = parsePackageNameFromNodeModulesPath(relFromCwd);
    if (pkgName) {
      externalPackagesSet.add(pkgName);
      continue;
    }
    if (!relFromCwd.startsWith('..') && existsSync(absInput) && statSync(absInput).isFile()) {
      sourceFiles.push(mapTsRelPath(relFromCwd));
      sourceDirs.add(dirname(absInput));
    }
  }

  const externalPackages = Array.from(externalPackagesSet).sort();

  const zipFiles = [];
  const addedZipNames = new Set();

  function addZipFile(name, content, mode = 0o100644) {
    const cleanName = name.split('\\').join('/').replace(/^\/+/, '');
    if (addedZipNames.has(cleanName)) return;
    addedZipNames.add(cleanName);
    zipFiles.push({
      name: cleanName,
      content: Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'),
      mode,
    });
  }

  // 将带 inline sourcemap 的打包产物写入与原入口一致的相对路径 (确保 import.meta.url 相对路径一致)
  let bootstrapUserEntryImport;
  if (resolved.mode === 'entry') {
    const finalEntryRel = mapTsRelPath(resolved.relEntry);
    addZipFile(finalEntryRel, appBundleCode, 0o100644);
    bootstrapUserEntryImport = `../${finalEntryRel}`;
  } else {
    addZipFile('_myship/api-router.mjs', appBundleCode, 0o100644);
    bootstrapUserEntryImport = './api-router.mjs';
  }

  // 递归保留后端源码目录 (如 server/**, lib/**, api/**, backend/**) 下的非代码静态数据/模板文件 (.json, .txt, .sql 等)
  function collectStaticAssetsRecursive(dirToScan) {
    let entries = [];
    try {
      entries = readdirSync(dirToScan);
    } catch {
      return;
    }
    for (const entryName of entries) {
      if (
        entryName.startsWith('.') ||
        entryName === 'node_modules' ||
        entryName === 'package.json' ||
        entryName === 'tsconfig.json'
      ) {
        continue;
      }
      const fullAsset = resolve(dirToScan, entryName);
      let st;
      try {
        st = statSync(fullAsset);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        collectStaticAssetsRecursive(fullAsset);
      } else if (st.isFile() && st.size <= 2 * 1024 * 1024) {
        const ext = extname(entryName).toLowerCase();
        if (STATIC_ASSET_EXTENSIONS.has(ext)) {
          const assetRel = relative(cwd, fullAsset).split('\\').join('/');
          if (!assetRel.startsWith('..')) {
            addZipFile(assetRel, readFileSync(fullAsset), 0o100644);
          }
        }
      }
    }
  }

  for (const dirAbs of sourceDirs) {
    if (dirAbs === cwd) continue;
    collectStaticAssetsRecursive(dirAbs);
  }

  const bootstrapJsCode = generateBootstrapRuntimeSource(bootstrapUserEntryImport);
  const scfBootstrapSh = [
    '#!/bin/bash',
    'for d in /var/lang/node24*/bin /var/lang/node22*/bin /var/lang/node20*/bin /var/lang/node18*/bin /var/lang/node16*/bin; do',
    '  if [ -x "$d/node" ]; then',
    '    export PATH="$d:$PATH"',
    '    exec "$d/node" --enable-source-maps _myship/bootstrap.mjs',
    '  fi',
    'done',
    'exec node --enable-source-maps _myship/bootstrap.mjs',
    '',
  ].join('\n');

  addZipFile('scf_bootstrap', scfBootstrapSh, 0o100755);
  addZipFile(
    'package.json',
    JSON.stringify({ name: 'myship-scf-project', private: true, type: 'module' }, null, 2),
    0o100644
  );
  addZipFile('_myship/bootstrap.mjs', bootstrapJsCode, 0o100644);

  const zipBuffer = createZipBuffer(zipFiles);

  return {
    mode: resolved.mode,
    relEntry: resolved.relEntry,
    routes: resolved.files ? resolved.files.map((f) => f.route) : ['/api/*'],
    sourceFiles,
    externalPackages,
    zipEntries: zipFiles.map((z) => z.name),
    appBundleCode,
    zipBuffer,
    zipSizeBytes: zipBuffer.length,
  };
}
