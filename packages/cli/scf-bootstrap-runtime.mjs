/**
 * scf-bootstrap-runtime.mjs — 腾讯云 SCF Web 函数标准 HTTP 运行时引导层
 *
 * 作为真实 ESM 模块由 esbuild 打包进 `_myship/bootstrap.mjs`，彻底消灭巨型字符串拼接模板：
 * - 复用单一可信源 `./db-client.mjs` (`createDatabaseClient`) 与 `./storage-client.mjs` (`createCloudStorage`, `dispatchFullStackModule`)
 * - 自动校验 `X-MyShip-Gateway-Token`、响应 `/_myship_health` 探针、捕获请求级结构化日志并持久化异常堆栈至 `__myship_logs`
 */
import http from 'node:http';
import { createCloudStorage, dispatchFullStackModule } from './storage-client.mjs';
import { createDatabaseClient, closeDatabasePools } from './db-client.mjs';

const DB_ENV_WATCH_KEYS = [
  'MYSHIP_DB_PROVIDER',
  'DATABASE_URL',
  'NEON_DATABASE_URL',
  'MYSQL_URL',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'LIBSQL_URL',
  'LIBSQL_AUTH_TOKEN',
  'TCB_ENV_ID',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PG_SCHEMA',
  'PGOPTIONS',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'CF_ACCOUNT_ID',
  'CF_D1_DATABASE_ID',
  'CF_API_TOKEN',
];

function computeDbEnvSignature(envObj) {
  return DB_ENV_WATCH_KEYS.map((k) => `${k}=${envObj[k] || ''}`).join('|');
}

const STORAGE_ENV_WATCH_KEYS = [
  'MYSHIP_STORAGE_ENV',
  'MYSHIP_COS_ORIGIN',
  'COS_ORIGIN',
  'MYSHIP_DATA_SECRET_ID',
  'MYSHIP_DATA_SECRET_KEY',
  'MYSHIP_DATA_TOKEN',
  'MYSHIP_SECRET_ID',
  'MYSHIP_SECRET_KEY',
  'MYSHIP_TOKEN',
  'TENCENT_SECRET_ID',
  'TENCENT_SECRET_KEY',
  'TENCENT_TOKEN',
];

function computeStorageEnvSignature(envObj) {
  return STORAGE_ENV_WATCH_KEYS.map((k) => `${k}=${envObj[k] || ''}`).join('|');
}

export function startScfRuntimeServer(userApp) {
  const PORT = Number(process.env.PORT || 9000);
  const PROJECT = process.env.MYSHIP_PROJECT || 'default';
  const GATEWAY_TOKEN = process.env.MYSHIP_GATEWAY_TOKEN || '';
  const INITIAL_ENV = { ...process.env };

  let currentStorageSig = computeStorageEnvSignature(process.env);
  let { storage, files, loadRemoteEnv } = createCloudStorage(PROJECT, process.env);
  let currentDbSig = computeDbEnvSignature(process.env);
  let db = createDatabaseClient({
    project: PROJECT,
    env: process.env,
    preferLocalSqlite: false,
  });

  globalThis.myshipStorage = storage;
  globalThis.myshipFiles = files;
  globalThis.myshipDb = db;

  let lastEnvSyncMs = 0;
  const ENV_SYNC_TTL_MS = 2000;
  const initialRemoteEnvKeys = new Set(
    String(process.env.MYSHIP_PROJECT_ENV_KEYS || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  );
  let dynamicEnvKeys = new Set(initialRemoteEnvKeys);

  async function refreshProjectEnvIfNeeded() {
    if (typeof loadRemoteEnv !== 'function') return;
    const now = Date.now();
    if (now - lastEnvSyncMs < ENV_SYNC_TTL_MS) return;
    lastEnvSyncMs = now;
    try {
      const remoteVars = await loadRemoteEnv();
      if (remoteVars && typeof remoteVars === 'object') {
        const nextKeys = new Set(Object.keys(remoteVars));
        for (const oldKey of dynamicEnvKeys) {
          if (!nextKeys.has(oldKey)) {
            if (
              !initialRemoteEnvKeys.has(oldKey) &&
              Object.prototype.hasOwnProperty.call(INITIAL_ENV, oldKey)
            ) {
              process.env[oldKey] = INITIAL_ENV[oldKey];
            } else {
              delete process.env[oldKey];
            }
          }
        }
        for (const [k, v] of Object.entries(remoteVars)) {
          if (k && v !== undefined && v !== null) {
            process.env[k] = String(v);
          }
        }
        dynamicEnvKeys = nextKeys;
        const nextStorageSig = computeStorageEnvSignature(process.env);
        if (nextStorageSig !== currentStorageSig) {
          currentStorageSig = nextStorageSig;
          const nextStorageBundle = createCloudStorage(PROJECT, process.env);
          storage = nextStorageBundle.storage;
          files = nextStorageBundle.files;
          loadRemoteEnv = nextStorageBundle.loadRemoteEnv;
          globalThis.myshipStorage = storage;
          globalThis.myshipFiles = files;
        }
        const nextDbSig = computeDbEnvSignature(process.env);
        if (nextDbSig !== currentDbSig) {
          currentDbSig = nextDbSig;
          await closeDatabasePools(PROJECT).catch(() => {});
          db = createDatabaseClient({
            project: PROJECT,
            env: process.env,
            preferLocalSqlite: false,
          });
          globalThis.myshipDb = db;
        }
      }
    } catch {
      // ignore transient network error and keep current process.env
    }
  }

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

  const server = http.createServer(async (req, res) => {
    const startMs = Date.now();
    const requestId =
      req.headers['x-scf-request-id'] ||
      req.headers['x-request-id'] ||
      `req_${Math.random().toString(36).slice(2, 10)}`;
    const scfVersion = process.env.SCF_FUNCTIONVERSION || '$LATEST';
    const deploymentId = req.headers['x-myship-deployment-id'] || '';
    const subdomain = req.headers['x-myship-subdomain'] || '';
    const method = (req.method || 'GET').toUpperCase();
    let pathname = req.url || '/';

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, X-Requested-With'
        );
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

      await refreshProjectEnvIfNeeded();

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
        env: { ...process.env },
        storage,
        files,
        bucket: files,
        db,
        clientIp:
          req.headers['x-myship-client-ip'] || req.headers['x-forwarded-for'] || '127.0.0.1',
      };

      const webRes = await dispatchFullStackModule(userApp, webReq, context);
      activeRequestLogs = null;
      const status = webRes.status || 200;
      res.statusCode = status;
      const isSse = (webRes.headers.get('content-type') || '')
        .toLowerCase()
        .includes('text/event-stream');
      webRes.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'content-length') {
          res.setHeader(k, v);
        }
      });
      res.setHeader('X-MyShip-SCF-Version', scfVersion);
      if (isSse) {
        res.setHeader('X-Accel-Buffering', 'no');
        req.socket?.setNoDelay?.(true);
      }

      if (method === 'HEAD' || !webRes.body) {
        res.end();
      } else if (typeof webRes.body.getReader === 'function') {
        res.flushHeaders();
        const reader = webRes.body.getReader();
        const onClose = () => {
          reader.cancel().catch(() => {});
        };
        req.once('close', onClose);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              res.write(Buffer.from(value));
            }
          }
        } catch {
          // client disconnected or stream aborted
        } finally {
          req.removeListener('close', onClose);
          if (!res.writableEnded) {
            res.end();
          }
        }
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
    console.log(
      `[MyShip SCF Web Function] Listening on 0.0.0.0:${PORT} (project: ${PROJECT})`
    );
  });

  return server;
}
