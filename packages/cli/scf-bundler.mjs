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
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { walkFiles, normalizeDomainToken } from './project-context.mjs';
import { executeCloudBasePgSql } from './cos-client.mjs';
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
export function createLocalPersistentStorage(cwd = process.cwd(), project = 'default', env = process.env) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const rawStorageEnv = env?.MYSHIP_STORAGE_ENV ? normalizeDomainToken(env.MYSHIP_STORAGE_ENV) : '';
  const envSub = rawStorageEnv && rawStorageEnv !== 'prod' ? rawStorageEnv : '';
  const baseDir = envSub
    ? resolve(cwd, '.myship', 'data', cleanProj, envSub)
    : resolve(cwd, '.myship', 'data', cleanProj);

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

/**
 * 本地开发模式 (myship dev / --local) 下的二进制对象存储实现 (context.files / context.bucket)
 * 落盘在 <cwd>/.myship/files/<project>/<env?>/<key>，与云端 COS files/<project>/ 100% 同构
 */
export function createLocalFileStorage(cwd = process.cwd(), project = 'default', env = process.env) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const rawStorageEnv = env?.MYSHIP_STORAGE_ENV ? normalizeDomainToken(env.MYSHIP_STORAGE_ENV) : '';
  const envSub = rawStorageEnv && rawStorageEnv !== 'prod' ? rawStorageEnv : '';
  const baseDir = envSub
    ? resolve(cwd, '.myship', 'files', cleanProj, envSub)
    : resolve(cwd, '.myship', 'files', cleanProj);

  function sanitizeFileKey(key) {
    const clean = String(key || '')
      .trim()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\\/g, '/')
      .replace(/[^a-zA-Z0-9._/-]/g, '_');
    if (!clean || clean.includes('..') || clean.endsWith('.__meta__.json')) {
      throw new Error(`无效的对象存储文件 Key: ${key}`);
    }
    return clean;
  }

  function toBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    return Buffer.from(String(body ?? ''), 'utf8');
  }

  return {
    prefix: envSub ? `files/${cleanProj}/${envSub}/` : `files/${cleanProj}/`,
    async put(key, body, options = {}) {
      const safe = sanitizeFileKey(key);
      const filePath = resolve(baseDir, safe);
      const metaPath = `${filePath}.__meta__.json`;
      mkdirSync(dirname(filePath), { recursive: true });
      const buf = toBuffer(body);
      const contentType = options.contentType || 'application/octet-stream';
      writeFileSync(filePath, buf);
      writeFileSync(
        metaPath,
        JSON.stringify(
          {
            key: safe,
            project: cleanProj,
            contentType,
            size: buf.length,
            updatedAt: new Date().toISOString(),
          },
          null,
          2
        ),
        'utf8'
      );
      return { key: safe, size: buf.length, contentType };
    },
    async get(key, options = {}) {
      const safe = sanitizeFileKey(key);
      const filePath = resolve(baseDir, safe);
      if (!existsSync(filePath)) return null;
      const buf = readFileSync(filePath);
      const metaPath = `${filePath}.__meta__.json`;
      let contentType = 'application/octet-stream';
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          if (meta && meta.contentType) contentType = meta.contentType;
        } catch {
          // ignore
        }
      }
      if (options.type === 'text') return buf.toString('utf8');
      if (options.type === 'json') return JSON.parse(buf.toString('utf8'));
      buf.contentType = contentType;
      buf.size = buf.length;
      return buf;
    },
    async delete(key) {
      const safe = sanitizeFileKey(key);
      const filePath = resolve(baseDir, safe);
      const metaPath = `${filePath}.__meta__.json`;
      if (existsSync(filePath)) rmSync(filePath, { force: true });
      if (existsSync(metaPath)) rmSync(metaPath, { force: true });
      return true;
    },
    async list(prefix = '') {
      if (!existsSync(baseDir)) return [];
      const cleanPrefix = String(prefix || '').replace(/^\/+/, '');
      const all = [];
      function walk(dir, relPrefix = '') {
        for (const item of readdirSync(dir)) {
          if (item.endsWith('.__meta__.json')) continue;
          const full = resolve(dir, item);
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full, `${relPrefix}${item}/`);
          } else {
            const k = `${relPrefix}${item}`;
            if (!cleanPrefix || k.startsWith(cleanPrefix)) {
              all.push(k);
            }
          }
        }
      }
      walk(baseDir, '');
      return all.sort();
    },
    async presignUrl(key, { method = 'GET', expiresSec = 900, expiresIn = 900 } = {}) {
      const safe = sanitizeFileKey(key);
      const baseOrigin = (
        env?.MYSHIP_DEV_ORIGIN || `http://127.0.0.1:${env?.PORT || 4321}`
      ).replace(/\/$/, '');
      const exp = Math.floor(Date.now() / 1000) + Number(expiresSec || expiresIn || 900);
      return `${baseOrigin}/_myship_files/${encodeURIComponent(cleanProj)}/${safe}?method=${encodeURIComponent(
        String(method).toUpperCase()
      )}&expires=${exp}`;
    },
  };
}

function attachQueryResultMeta(rows, rowsAffected = 0, lastInsertRowid = null) {
  const arr = Array.isArray(rows) ? rows : [];
  Object.defineProperties(arr, {
    rows: { value: arr, enumerable: false },
    rowsAffected: { value: rowsAffected, enumerable: false },
    lastInsertRowid: { value: lastInsertRowid, enumerable: false },
  });
  return arr;
}

function formatTursoArg(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float', value: v };
  }
  return { type: 'text', value: String(v) };
}

function parseTursoResult(resObj) {
  if (!resObj) return { rows: [], rowsAffected: 0, lastInsertRowid: null };
  const cols = Array.isArray(resObj.cols) ? resObj.cols : [];
  const rawRows = Array.isArray(resObj.rows) ? resObj.rows : [];
  const rows = rawRows.map((rowArr) => {
    const obj = {};
    cols.forEach((col, i) => {
      const cell = rowArr[i];
      if (!cell || cell.type === 'null') {
        obj[col.name] = null;
      } else if (cell.type === 'integer') {
        const num = Number(cell.value);
        obj[col.name] = Number.isSafeInteger(num) ? num : cell.value;
      } else if (cell.type === 'float') {
        obj[col.name] = Number(cell.value);
      } else {
        obj[col.name] = cell.value;
      }
    });
    return obj;
  });
  return {
    rows,
    rowsAffected: Number(resObj.affected_row_count || 0),
    lastInsertRowid:
      resObj.last_insert_rowid !== undefined && resObj.last_insert_rowid !== null
        ? Number(resObj.last_insert_rowid)
        : null,
  };
}

const ACTIVE_DB_POOLS = new Map();

async function disposeCachedPoolEntry(entry) {
  if (!entry || !entry.poolPromise) return;
  try {
    const inst = await entry.poolPromise;
    if (inst && typeof inst.end === 'function') {
      await inst.end().catch(() => {});
    } else if (inst && typeof inst.close === 'function') {
      inst.close();
    }
  } catch {
    // ignore cleanup error
  }
}

export async function closeDatabasePools(project = null) {
  const cleanFilter = project ? normalizeDomainToken(project) || 'default' : null;
  const tasks = [];
  for (const [key, entry] of ACTIVE_DB_POOLS.entries()) {
    if (!cleanFilter || entry.project === cleanFilter) {
      ACTIVE_DB_POOLS.delete(key);
      tasks.push(disposeCachedPoolEntry(entry));
    }
  }
  await Promise.all(tasks);
}

function withDbAliases(client, project = null) {
  if (!client) return client;
  client.exec = (sql, params = []) => client.execute(sql, params);
  client.run = (sql, params = []) => client.execute(sql, params);
  client.all = (sql, params = []) => client.query(sql, params);
  client.first = async (sql, params = []) => {
    const rows = await client.query(sql, params);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  };
  if (typeof client.close !== 'function') {
    client.close = () => closeDatabasePools(project);
  }
  return client;
}

/**
 * 创建统一数据库客户端 (context.db)
 * - 支持 Turso HTTP (/v2/pipeline)、Cloudflare D1 HTTP (/query)、腾讯云 CloudBase PG (DATABASE_URL)
 * - 本地开发默认使用 Node.js 22+ 原生内置 node:sqlite (DatabaseSync) 落盘至 .myship/data/<project>/local.sqlite
 */
export function createDatabaseClient({
  cwd = process.cwd(),
  project = 'default',
  env = process.env,
  preferLocalSqlite = true,
} = {}) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const explicitProv = String(env?.MYSHIP_DB_PROVIDER || '').toLowerCase();
  const isSqliteFamily =
    !explicitProv ||
    explicitProv === 'sqlite' ||
    explicitProv === 'turso' ||
    explicitProv === 'libsql' ||
    explicitProv === 'd1' ||
    explicitProv === 'cloudflare-d1';
  const useRemote =
    !preferLocalSqlite ||
    !isSqliteFamily ||
    env?.MYSHIP_DB_REMOTE === '1' ||
    env?.MYSHIP_DB_REMOTE === 'true';

  if (
    useRemote &&
    (!explicitProv || explicitProv === 'turso' || explicitProv === 'libsql') &&
    env?.TURSO_DATABASE_URL &&
    env?.TURSO_AUTH_TOKEN
  ) {
    const httpBase = String(env.TURSO_DATABASE_URL)
      .replace(/^libsql:\/\//i, 'https://')
      .replace(/\/$/, '');
    const token = env.TURSO_AUTH_TOKEN;

    async function runStatements(stmts) {
      const requests = stmts.map((s) => {
        const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
        const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
        return {
          type: 'execute',
          stmt: {
            sql,
            args: params.map(formatTursoArg),
          },
        };
      });
      requests.push({ type: 'close' });
      const res = await fetch(`${httpBase}/v2/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Turso HTTP SQL 执行失败 (${res.status}): ${txt.slice(0, 300)}`);
      }
      const data = await res.json();
      const results = [];
      for (const item of data.results || []) {
        if (item.type === 'error') {
          throw new Error(`Turso SQL Error: ${item.error?.message || JSON.stringify(item.error)}`);
        }
        if (item.type === 'ok' && item.response?.type === 'execute') {
          results.push(parseTursoResult(item.response.result));
        }
      }
      return results;
    }

    return withDbAliases({
      provider: 'turso',
      url: env.TURSO_DATABASE_URL,
      async execute(sql, params = []) {
        const [first] = await runStatements([{ sql, params }]);
        return first || { rows: [], rowsAffected: 0, lastInsertRowid: null };
      },
      async query(sql, params = []) {
        const res = await this.execute(sql, params);
        return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
      },
      async batch(statements = []) {
        return runStatements(statements);
      },
    });
  }

  if (
    useRemote &&
    (!explicitProv || explicitProv === 'd1' || explicitProv === 'cloudflare-d1') &&
    env?.CF_ACCOUNT_ID &&
    env?.CF_D1_DATABASE_ID &&
    env?.CF_API_TOKEN
  ) {
    const apiBase = (env.CF_API_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/$/, '');
    const endpoint = `${apiBase}/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_D1_DATABASE_ID}/query`;
    const token = env.CF_API_TOKEN;

    async function runD1(sql, params = []) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const msg =
          data?.errors?.[0]?.message || `Cloudflare D1 HTTP 失败 (${res.status})`;
        throw new Error(`Cloudflare D1 SQL Error: ${msg}`);
      }
      const first = Array.isArray(data.result) ? data.result[0] || {} : data.result || {};
      const rows = Array.isArray(first.results) ? first.results : [];
      const rowsAffected = Number(first.meta?.changes ?? 0);
      const lastInsertRowid =
        first.meta?.last_row_id !== undefined ? Number(first.meta.last_row_id) : null;
      return { rows, rowsAffected, lastInsertRowid };
    }

    return withDbAliases({
      provider: 'd1',
      databaseId: env.CF_D1_DATABASE_ID,
      async execute(sql, params = []) {
        return runD1(sql, params);
      },
      async query(sql, params = []) {
        const res = await runD1(sql, params);
        return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
      },
      async batch(statements = []) {
        const out = [];
        for (const s of statements) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params =
            typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runD1(sql, params));
        }
        return out;
      },
    });
  }

  const neonConnUrl =
    env?.NEON_DATABASE_URL ||
    (explicitProv === 'neon' && env?.DATABASE_URL ? env.DATABASE_URL : '');
  if (
    useRemote &&
    (!explicitProv || explicitProv === 'neon' || explicitProv === 'neon-pg') &&
    neonConnUrl
  ) {
    const parsedNeon = new URL(neonConnUrl);
    const activeSchema = env.PG_SCHEMA || parsedNeon.searchParams.get('schema') || null;
    if (parsedNeon.hostname.includes('-pooler.')) {
      parsedNeon.searchParams.delete('options');
    } else if (activeSchema && activeSchema !== 'public') {
      parsedNeon.searchParams.set('options', `-c search_path=${activeSchema},public`);
    }
    const effectiveNeonConnStr = parsedNeon.toString();
    const endpoint =
      env.NEON_HTTP_URL || env.MYSHIP_NEON_HTTP_ENDPOINT || `https://${parsedNeon.host}/sql`;

    function toPgParams(sql, params = []) {
      if (!Array.isArray(params) || params.length === 0 || !sql.includes('?') || /\$\d+/.test(sql)) {
        return sql;
      }
      let idx = 0;
      return sql.replace(/\?/g, () => `$${++idx}`);
    }

    async function runNeon(sql, params = []) {
      const normalizedSql = toPgParams(sql, params);
      const useTxnSchema = Boolean(activeSchema && activeSchema !== 'public');
      const safeSchema = useTxnSchema ? String(activeSchema).replace(/"/g, '""') : '';
      const bodyPayload = useTxnSchema
        ? {
            queries: [
              { query: `SET LOCAL search_path TO "${safeSchema}", public`, params: [] },
              { query: normalizedSql, params },
            ],
          }
        : { query: normalizedSql, params };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Neon-Connection-String': effectiveNeonConnStr,
          'Content-Type': 'application/json',
          'Neon-Raw-Text-Output': 'false',
          'Neon-Array-Mode': 'false',
        },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.message) {
        throw new Error(`Neon HTTP SQL Error (${res.status}): ${data.message || JSON.stringify(data)}`);
      }
      const targetResult = Array.isArray(data.results)
        ? data.results[data.results.length - 1] || {}
        : data;
      const rows = Array.isArray(targetResult.rows) ? targetResult.rows : [];
      const rowsAffected = Number(targetResult.rowCount ?? rows.length);
      const lastInsertRowid = rows[0]?.id !== undefined ? rows[0].id : null;
      return { rows, rowsAffected, lastInsertRowid };
    }

    return withDbAliases({
      provider: 'neon',
      url: effectiveNeonConnStr,
      schema: activeSchema,
      async execute(sql, params = []) {
        return runNeon(sql, params);
      },
      async query(sql, params = []) {
        const res = await runNeon(sql, params);
        return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
      },
      async batch(statements = []) {
        const out = [];
        for (const s of statements) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params =
            typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runNeon(sql, params));
        }
        return out;
      },
    });
  }

  // 腾讯云 CloudBase PG 管控面 ExecutePGSql 零依赖查询通道
  if (
    useRemote &&
    (!explicitProv ||
      explicitProv === 'pg' ||
      explicitProv === 'postgres' ||
      explicitProv === 'cloudbase-pg') &&
    env?.TCB_ENV_ID
  ) {
    const tcbEnvId = env.TCB_ENV_ID;
    const tcbRegion = env.TCB_REGION || 'ap-shanghai';
    const tcbSchema = env.PG_SCHEMA || null;

    function formatPgLiteral(v) {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    }

    function bindSqlParams(sql, params = []) {
      if (!Array.isArray(params) || params.length === 0) return sql;
      if (/\$\d+/.test(sql)) {
        return sql.replace(/\$(\d+)/g, (_, numStr) => {
          const idx = Number(numStr) - 1;
          return idx >= 0 && idx < params.length ? formatPgLiteral(params[idx]) : 'NULL';
        });
      }
      let idx = 0;
      return sql.replace(/\?/g, () =>
        idx < params.length ? formatPgLiteral(params[idx++]) : 'NULL'
      );
    }

    function parseTcbPgResponse(resp) {
      const rs = resp?.ResultSet || resp || {};
      const cols = Array.isArray(rs?.Columns) ? rs.Columns : [];
      const types = Array.isArray(rs?.ColumnTypes) ? rs.ColumnTypes : [];
      const rawRows = Array.isArray(rs?.Rows) ? rs.Rows : [];
      const rows = rawRows.map((rowItem) => {
        const arr = typeof rowItem === 'string' ? JSON.parse(rowItem) : rowItem;
        const obj = {};
        cols.forEach((rawCol, i) => {
          const col = typeof rawCol === 'object' && rawCol !== null ? rawCol.Name || rawCol.name || String(i) : String(rawCol);
          const val = arr[i];
          const t = String(types[i] || rawCol?.Type || '').toLowerCase();
          if (val === null || val === undefined) {
            obj[col] = null;
          } else if (t === 'int2' || t === 'int4' || t === 'int8' || t === 'float4' || t === 'float8') {
            const num = Number(val);
            obj[col] = Number.isSafeInteger(num) || t.startsWith('float') ? num : val;
          } else if (t === 'bool' || t === 'boolean') {
            obj[col] = val === true || val === 'true' || val === 't' || val === '1';
          } else if (t === 'json' || t === 'jsonb') {
            try {
              obj[col] = typeof val === 'string' ? JSON.parse(val) : val;
            } catch {
              obj[col] = val;
            }
          } else {
            obj[col] = val;
          }
        });
        return obj;
      });
      return {
        rows,
        rowsAffected: Number(resp?.AffectedRows ?? rs?.AffectedRows ?? rows.length),
        lastInsertRowid: rows[0]?.id !== undefined ? rows[0].id : null,
      };
    }

    async function runTcbSql(sql, params = []) {
      const boundSql = bindSqlParams(sql, params);
      const resp = await executeCloudBasePgSql({
        envId: tcbEnvId,
        region: tcbRegion,
        sql: boundSql,
        schema: tcbSchema,
      });
      return parseTcbPgResponse(resp);
    }

    return withDbAliases({
      provider: 'cloudbase-pg',
      envId: tcbEnvId,
      schema: tcbSchema,
      async execute(sql, params = []) {
        return runTcbSql(sql, params);
      },
      async query(sql, params = []) {
        const res = await runTcbSql(sql, params);
        return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
      },
      async batch(statements = []) {
        const out = [];
        for (const s of statements) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params =
            typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runTcbSql(sql, params));
        }
        return out;
      },
    });
  }

  // 原生 PostgreSQL (`pg.Pool`) 驱动通道
  if (
    useRemote &&
    (!explicitProv || explicitProv === 'pg' || explicitProv === 'postgres') &&
    !env?.TCB_ENV_ID &&
    (env?.DATABASE_URL || env?.PGHOST)
  ) {
    const connStr = env.DATABASE_URL || '';
    const activeSchema = env.PG_SCHEMA || null;
    const poolKey = `${cleanProj}:pg`;
    const poolSig = JSON.stringify({
      connStr,
      host: env.PGHOST || '',
      port: String(env.PGPORT || 5432),
      database: env.PGDATABASE || 'postgres',
      user: env.PGUSER || 'postgres',
      password: env.PGPASSWORD || '',
      schema: activeSchema || '',
    });

    function toPgPositional(sql, params = []) {
      if (!Array.isArray(params) || params.length === 0 || !sql.includes('?') || /\$\d+/.test(sql)) {
        return sql;
      }
      let idx = 0;
      return sql.replace(/\?/g, () => `$${++idx}`);
    }

    async function getPgPool() {
      const existing = ACTIVE_DB_POOLS.get(poolKey);
      if (existing && existing.sig === poolSig) {
        return existing.poolPromise;
      }
      if (existing) {
        ACTIVE_DB_POOLS.delete(poolKey);
        disposeCachedPoolEntry(existing);
      }
      const poolPromise = (async () => {
        const pgMod = await import('pg');
        const PoolCtor = pgMod.default?.Pool || pgMod.Pool;
        let isLocalHost = false;
        let isPoolerHost = false;
        let sslDisabled = false;
        let cleanConnStr = connStr;
        if (connStr) {
          try {
            const u = new URL(connStr);
            isLocalHost =
              u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
            isPoolerHost = u.hostname.includes('-pooler.');
            sslDisabled = (u.searchParams.get('sslmode') || '').toLowerCase() === 'disable';
            u.searchParams.delete('schema');
            u.searchParams.delete('sslmode');
            u.searchParams.delete('options');
            cleanConnStr = u.toString();
          } catch {
            // ignore
          }
        } else {
          isLocalHost =
            env.PGHOST === '127.0.0.1' || env.PGHOST === 'localhost' || env.PGHOST === '::1';
          isPoolerHost = String(env.PGHOST || '').includes('-pooler.');
        }
        if (isPoolerHost && process.env.PGOPTIONS) {
          delete process.env.PGOPTIONS;
        }
        const pool = new PoolCtor(
          cleanConnStr
            ? {
                connectionString: cleanConnStr,
                max: 5,
                ssl: isLocalHost || sslDisabled ? false : { rejectUnauthorized: false },
              }
            : {
                host: env.PGHOST,
                port: Number(env.PGPORT || 5432),
                database: env.PGDATABASE || 'postgres',
                user: env.PGUSER || 'postgres',
                password: env.PGPASSWORD || '',
                max: 5,
                ssl: isLocalHost ? false : { rejectUnauthorized: false },
              }
        );
        pool.on('error', (err) => {
          console.warn('[MyShip PG Pool] Idle client error:', err?.message || err);
        });
        return pool;
      })();
      poolPromise.catch(() => {
        if (ACTIVE_DB_POOLS.get(poolKey)?.poolPromise === poolPromise) {
          ACTIVE_DB_POOLS.delete(poolKey);
        }
      });
      ACTIVE_DB_POOLS.set(poolKey, { project: cleanProj, sig: poolSig, poolPromise });
      return poolPromise;
    }

    async function runPgQuery(sql, params = []) {
      if (`${connStr || ''} ${env.PGHOST || ''}`.includes('-pooler.') && process.env.PGOPTIONS) {
        delete process.env.PGOPTIONS;
      }
      const pool = await getPgPool();
      let res;
      if (activeSchema && activeSchema !== 'public') {
        const client = await pool.connect();
        try {
          const safeSc = String(activeSchema).replace(/"/g, '""');
          await client.query('BEGIN');
          try {
            await client.query(`SET LOCAL search_path TO "${safeSc}", public`);
            res =
              Array.isArray(params) && params.length > 0
                ? await client.query(toPgPositional(sql, params), params)
                : await client.query(sql);
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK').catch(() => {});
            throw txErr;
          }
        } finally {
          client.release();
        }
      } else {
        res =
          Array.isArray(params) && params.length > 0
            ? await pool.query(toPgPositional(sql, params), params)
            : await pool.query(sql);
      }
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      return {
        rows,
        rowsAffected: Number(res?.rowCount ?? rows.length),
        lastInsertRowid: rows[0]?.id !== undefined ? rows[0].id : null,
      };
    }

    return withDbAliases(
      {
        provider: 'pg',
        url: connStr || `postgresql://${env.PGHOST}:${env.PGPORT || 5432}/${env.PGDATABASE || 'postgres'}`,
        schema: activeSchema,
        async execute(sql, params = []) {
          return runPgQuery(sql, params);
        },
        async query(sql, params = []) {
          const res = await runPgQuery(sql, params);
          return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
        },
        async batch(statements = []) {
          const out = [];
          for (const s of statements) {
            const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
            const params =
              typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
            out.push(await runPgQuery(sql, params));
          }
          return out;
        },
      },
      cleanProj
    );
  }

  // 原生 MySQL (`mysql2/promise`) 驱动通道
  const mysqlConnUrl =
    env?.MYSQL_URL || (explicitProv === 'mysql' && env?.DATABASE_URL ? env.DATABASE_URL : '');
  if (useRemote && (!explicitProv || explicitProv === 'mysql') && mysqlConnUrl) {
    const poolKey = `${cleanProj}:mysql`;
    const poolSig = mysqlConnUrl;

    async function getMysqlPool() {
      const existing = ACTIVE_DB_POOLS.get(poolKey);
      if (existing && existing.sig === poolSig) {
        return existing.poolPromise;
      }
      if (existing) {
        ACTIVE_DB_POOLS.delete(poolKey);
        disposeCachedPoolEntry(existing);
      }
      const poolPromise = (async () => {
        const mysqlMod = await import('mysql2/promise');
        const createPoolFn = mysqlMod.default?.createPool || mysqlMod.createPool;
        return createPoolFn({ uri: mysqlConnUrl, connectionLimit: 5 });
      })();
      poolPromise.catch(() => {
        if (ACTIVE_DB_POOLS.get(poolKey)?.poolPromise === poolPromise) {
          ACTIVE_DB_POOLS.delete(poolKey);
        }
      });
      ACTIVE_DB_POOLS.set(poolKey, { project: cleanProj, sig: poolSig, poolPromise });
      return poolPromise;
    }

    async function runMysqlQuery(sql, params = []) {
      const pool = await getMysqlPool();
      const [result] =
        Array.isArray(params) && params.length > 0
          ? await pool.execute(sql, params)
          : await pool.query(sql);
      if (Array.isArray(result)) {
        return {
          rows: result,
          rowsAffected: result.length,
          lastInsertRowid: result[0]?.id !== undefined ? result[0].id : null,
        };
      }
      return {
        rows: [],
        rowsAffected: Number(result?.affectedRows ?? 0),
        lastInsertRowid: result?.insertId !== undefined ? Number(result.insertId) : null,
      };
    }

    return withDbAliases(
      {
        provider: 'mysql',
        url: mysqlConnUrl,
        async execute(sql, params = []) {
          return runMysqlQuery(sql, params);
        },
        async query(sql, params = []) {
          const res = await runMysqlQuery(sql, params);
          return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
        },
        async batch(statements = []) {
          const out = [];
          for (const s of statements) {
            const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
            const params =
              typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
            out.push(await runMysqlQuery(sql, params));
          }
          return out;
        },
      },
      cleanProj
    );
  }

  // 本地开发 (SQLite 模式): 使用 Node.js 22+ 原生内置 node:sqlite (DatabaseSync)
  const dbDir = resolve(cwd, '.myship', 'data', cleanProj);
  const sqliteFile = resolve(dbDir, 'local.sqlite');
  const sqlitePoolKey = `${cleanProj}:sqlite`;
  const sqlitePoolSig = sqliteFile;

  async function getLocalDb() {
    const existing = ACTIVE_DB_POOLS.get(sqlitePoolKey);
    if (existing && existing.sig === sqlitePoolSig && existsSync(sqliteFile)) {
      return existing.poolPromise;
    }
    if (existing) {
      ACTIVE_DB_POOLS.delete(sqlitePoolKey);
      disposeCachedPoolEntry(existing);
    }
    const poolPromise = (async () => {
      const sqliteMod = await import('node:sqlite');
      mkdirSync(dbDir, { recursive: true });
      return new sqliteMod.DatabaseSync(sqliteFile);
    })();
    poolPromise.catch(() => {
      if (ACTIVE_DB_POOLS.get(sqlitePoolKey)?.poolPromise === poolPromise) {
        ACTIVE_DB_POOLS.delete(sqlitePoolKey);
      }
    });
    ACTIVE_DB_POOLS.set(sqlitePoolKey, {
      project: cleanProj,
      sig: sqlitePoolSig,
      poolPromise,
    });
    return poolPromise;
  }

  async function execLocal(sql, params = []) {
    const db = await getLocalDb();
    const stmt = db.prepare(sql);
    const isSelectLike =
      /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
    if (isSelectLike) {
      const rawRows = stmt.all(...params);
      const rows = Array.isArray(rawRows) ? rawRows.map((r) => ({ ...r })) : [];
      return { rows, rowsAffected: rows.length, lastInsertRowid: null };
    }
    const info = stmt.run(...params);
    return {
      rows: [],
      rowsAffected: Number(info?.changes ?? 0),
      lastInsertRowid:
        info?.lastInsertRowid !== undefined && info?.lastInsertRowid !== null
          ? Number(info.lastInsertRowid)
          : null,
    };
  }

  return withDbAliases(
    {
      provider: 'sqlite-local',
      filePath: sqliteFile,
      url: env?.TURSO_DATABASE_URL || `file:${sqliteFile}`,
      schema: null,
      async execute(sql, params = []) {
        return execLocal(sql, params);
      },
      async query(sql, params = []) {
        const res = await execLocal(sql, params);
        return attachQueryResultMeta(res.rows, res.rowsAffected, res.lastInsertRowid);
      },
      async batch(statements = []) {
        const out = [];
        for (const s of statements) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params =
            typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await execLocal(sql, params));
        }
        return out;
      },
    },
    cleanProj
  );
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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
function sha256HexStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}
function hmacSha256Buf(key, str) {
  return createHmac('sha256', key).update(str, 'utf8').digest();
}
function hmacSha256Hex(key, str) {
  return createHmac('sha256', key).update(str, 'utf8').digest('hex');
}

function resolveTencentCreds() {
  let secretId =
    process.env.MYSHIP_DATA_SECRET_ID ||
    process.env.TENCENT_SECRET_ID ||
    process.env.TENCENTCLOUD_SECRETID ||
    '';
  let secretKey =
    process.env.MYSHIP_DATA_SECRET_KEY ||
    process.env.TENCENT_SECRET_KEY ||
    process.env.TENCENTCLOUD_SECRETKEY ||
    '';
  let token =
    process.env.MYSHIP_DATA_TOKEN ||
    process.env.TENCENT_TOKEN ||
    process.env.TENCENTCLOUD_SESSIONTOKEN ||
    '';
  if (secretId && secretKey) return { secretId, secretKey, token };
  try {
    const cfgPath = process.env.MYSHIP_CONFIG_PATH || join(homedir(), '.myship', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.secretId && cfg.secretKey) {
        return { secretId: cfg.secretId, secretKey: cfg.secretKey, token: cfg.token || '' };
      }
    }
  } catch {}
  try {
    const tcPath = join(homedir(), '.tccli', 'default.credential');
    if (existsSync(tcPath)) {
      const tc = JSON.parse(readFileSync(tcPath, 'utf8'));
      if (tc.secretId && tc.secretKey) {
        return { secretId: tc.secretId, secretKey: tc.secretKey, token: tc.token || '' };
      }
    }
  } catch {}
  return { secretId, secretKey, token };
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

function sanitizeFileKey(key) {
  const clean = String(key || '')
    .trim()
    .replace(/^\\/+|\\/+$/g, '')
    .replace(/\\\\/g, '/')
    .replace(/[^a-zA-Z0-9._/-]/g, '_');
  if (!clean || clean.includes('..')) {
    throw new Error('Invalid file key: ' + key);
  }
  return clean;
}

function createCloudStorage() {
  const cosOrigin = (process.env.MYSHIP_COS_ORIGIN || '').replace(/\\/$/, '');
  const { secretId, secretKey, token: sessionToken } = resolveTencentCreds();
  const rawStorageEnv = process.env.MYSHIP_STORAGE_ENV
    ? sanitizeStorageKey(process.env.MYSHIP_STORAGE_ENV)
    : '';
  const envSub = rawStorageEnv && rawStorageEnv !== 'prod' ? rawStorageEnv + '/' : '';
  const prefixBase = 'data/' + PROJECT + '/' + envSub;
  const filesPrefixBase = 'files/' + PROJECT + '/' + envSub;

  if (!cosOrigin || !secretId || !secretKey) {
    const missingErr = () => {
      throw new Error(
        'Cloud persistent storage (context.storage / context.files) is unavailable: missing COS credentials in SCF environment (MYSHIP_COS_ORIGIN / MYSHIP_DATA_SECRET_ID / MYSHIP_DATA_SECRET_KEY).'
      );
    };
    const stub = {
      async get() { return missingErr(); },
      async set() { return missingErr(); },
      async put() { return missingErr(); },
      async delete() { return missingErr(); },
      async list() { return missingErr(); },
      async presignUrl() { return missingErr(); },
    };
    return { storage: stub, files: stub };
  }

  function signCos(method, objectKey, expiresSec = 3600) {
    const url = new URL(objectKey.startsWith('/') ? objectKey : '/' + objectKey, cosOrigin);
    const now = Math.floor(Date.now() / 1000);
    const keyTime = (now - 60) + ';' + (now + Number(expiresSec || 3600));
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
    const authParts = [
      'q-sign-algorithm=sha1',
      'q-sign-time=' + keyTime,
      'q-key-time=' + keyTime,
      'q-ak=' + secretId,
      'q-header-list=host',
      'q-url-param-list=' + urlParamList,
      'q-signature=' + signature,
    ];
    const headers = {
      Authorization: authParts.join('&'),
    };
    if (sessionToken) {
      headers['x-cos-security-token'] = sessionToken;
    }
    return { url: url.toString(), headers, authQuery: authParts.join('&') };
  }

  const storageObj = {
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

  const filesObj = {
    prefix: filesPrefixBase,
    async put(key, body, options = {}) {
      const safe = sanitizeFileKey(key);
      const objKey = filesPrefixBase + safe;
      const { url, headers } = signCos('PUT', objKey);
      const contentType = options.contentType || 'application/octet-stream';
      headers['Content-Type'] = contentType;
      headers['x-cos-acl'] = options.acl || 'private';
      const buf = Buffer.isBuffer(body)
        ? body
        : body instanceof Uint8Array
        ? Buffer.from(body)
        : body instanceof ArrayBuffer
        ? Buffer.from(new Uint8Array(body))
        : Buffer.from(String(body ?? ''), 'utf8');
      const res = await fetch(url, { method: 'PUT', headers, body: buf });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('COS files.put failed (' + res.status + '): ' + txt.slice(0, 200));
      }
      return { key: safe, size: buf.length, contentType };
    },
    async get(key, options = {}) {
      const safe = sanitizeFileKey(key);
      const objKey = filesPrefixBase + safe;
      const { url, headers } = signCos('GET', objKey);
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('COS files.get failed (' + res.status + ')');
      const buf = Buffer.from(await res.arrayBuffer());
      if (options.type === 'text') return buf.toString('utf8');
      if (options.type === 'json') return JSON.parse(buf.toString('utf8'));
      buf.contentType = res.headers.get('content-type') || 'application/octet-stream';
      buf.size = buf.length;
      return buf;
    },
    async delete(key) {
      const safe = sanitizeFileKey(key);
      const objKey = filesPrefixBase + safe;
      const { url, headers } = signCos('DELETE', objKey);
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error('COS files.delete failed (' + res.status + ')');
      }
      return true;
    },
    async list(prefix = '') {
      const fullPrefix = filesPrefixBase + (prefix ? String(prefix).replace(/^\\/+/, '') : '');
      const { url, headers } = signCos('GET', '/?prefix=' + encodeURIComponent(fullPrefix) + '&max-keys=1000');
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) throw new Error('COS files.list failed (' + res.status + ')');
      const xml = await res.text();
      const regex = /<Key>([^<]+)<\\/Key>/g;
      const out = [];
      let m;
      while ((m = regex.exec(xml)) !== null) {
        if (m[1].startsWith(filesPrefixBase)) {
          out.push(m[1].slice(filesPrefixBase.length));
        }
      }
      return out.sort();
    },
    async presignUrl(key, { method = 'GET', expiresSec = 900 } = {}) {
      const safe = sanitizeFileKey(key);
      const objKey = filesPrefixBase + safe;
      const { url, authQuery } = signCos(method, objKey, expiresSec);
      const tokenPart = sessionToken ? '&x-cos-security-token=' + encodeURIComponent(sessionToken) : '';
      return url + (url.includes('?') ? '&' : '?') + authQuery + tokenPart;
    },
  };

  return { storage: storageObj, files: filesObj };
}

function createCloudDbClient() {
  function attachMeta(rows, rowsAffected = 0, lastInsertRowid = null) {
    const arr = Array.isArray(rows) ? rows : [];
    Object.defineProperties(arr, {
      rows: { value: arr, enumerable: false },
      rowsAffected: { value: rowsAffected, enumerable: false },
      lastInsertRowid: { value: lastInsertRowid, enumerable: false },
    });
    return arr;
  }
  function withCloudAliases(client) {
    if (!client) return client;
    client.exec = (sql, params = []) => client.execute(sql, params);
    client.run = (sql, params = []) => client.execute(sql, params);
    client.all = (sql, params = []) => client.query(sql, params);
    client.first = async (sql, params = []) => {
      const rows = await client.query(sql, params);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    };
    return client;
  }

  const explicitProv = String(process.env.MYSHIP_DB_PROVIDER || '').toLowerCase();

  if (
    (!explicitProv || explicitProv === 'turso' || explicitProv === 'libsql') &&
    process.env.TURSO_DATABASE_URL &&
    process.env.TURSO_AUTH_TOKEN
  ) {
    const httpBase = String(process.env.TURSO_DATABASE_URL)
      .replace(/^libsql:\\/\\//i, 'https://')
      .replace(/\\/$/, '');
    const token = process.env.TURSO_AUTH_TOKEN;
    const fmtArg = (v) => {
      if (v === null || v === undefined) return { type: 'null' };
      if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
      if (typeof v === 'number') {
        return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
      }
      return { type: 'text', value: String(v) };
    };
    const parseRes = (resObj) => {
      if (!resObj) return { rows: [], rowsAffected: 0, lastInsertRowid: null };
      const cols = Array.isArray(resObj.cols) ? resObj.cols : [];
      const rows = (resObj.rows || []).map((rowArr) => {
        const obj = {};
        cols.forEach((col, i) => {
          const cell = rowArr[i];
          if (!cell || cell.type === 'null') obj[col.name] = null;
          else if (cell.type === 'integer') {
            const n = Number(cell.value);
            obj[col.name] = Number.isSafeInteger(n) ? n : cell.value;
          } else if (cell.type === 'float') obj[col.name] = Number(cell.value);
          else obj[col.name] = cell.value;
        });
        return obj;
      });
      return {
        rows,
        rowsAffected: Number(resObj.affected_row_count || 0),
        lastInsertRowid:
          resObj.last_insert_rowid !== undefined && resObj.last_insert_rowid !== null
            ? Number(resObj.last_insert_rowid)
            : null,
      };
    };
    const runStmts = async (stmts) => {
      const requests = stmts.map((s) => {
        const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
        const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
        return { type: 'execute', stmt: { sql, args: params.map(fmtArg) } };
      });
      requests.push({ type: 'close' });
      const res = await fetch(httpBase + '/v2/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Turso HTTP failed (' + res.status + '): ' + txt.slice(0, 200));
      }
      const data = await res.json();
      const out = [];
      for (const item of data.results || []) {
        if (item.type === 'error') throw new Error('Turso SQL Error: ' + (item.error?.message || 'unknown'));
        if (item.type === 'ok' && item.response?.type === 'execute') {
          out.push(parseRes(item.response.result));
        }
      }
      return out;
    };
    return withCloudAliases({
      provider: 'turso',
      url: process.env.TURSO_DATABASE_URL,
      async execute(sql, params = []) {
        const [first] = await runStmts([{ sql, params }]);
        return first || { rows: [], rowsAffected: 0, lastInsertRowid: null };
      },
      async query(sql, params = []) {
        const r = await this.execute(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        return runStmts(stmts);
      },
    });
  }

  if (
    (!explicitProv || explicitProv === 'd1' || explicitProv === 'cloudflare-d1') &&
    process.env.CF_ACCOUNT_ID &&
    process.env.CF_D1_DATABASE_ID &&
    process.env.CF_API_TOKEN
  ) {
    const apiBase = (process.env.CF_API_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\\/$/, '');
    const endpoint = apiBase + '/accounts/' + process.env.CF_ACCOUNT_ID + '/d1/database/' + process.env.CF_D1_DATABASE_ID + '/query';
    const token = process.env.CF_API_TOKEN;
    const runD1 = async (sql, params = []) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error('Cloudflare D1 SQL Error: ' + (data?.errors?.[0]?.message || res.status));
      }
      const first = Array.isArray(data.result) ? data.result[0] || {} : data.result || {};
      return {
        rows: Array.isArray(first.results) ? first.results : [],
        rowsAffected: Number(first.meta?.changes ?? 0),
        lastInsertRowid: first.meta?.last_row_id !== undefined ? Number(first.meta.last_row_id) : null,
      };
    };
    return withCloudAliases({
      provider: 'd1',
      databaseId: process.env.CF_D1_DATABASE_ID,
      async execute(sql, params = []) { return runD1(sql, params); },
      async query(sql, params = []) {
        const r = await runD1(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        const out = [];
        for (const s of stmts) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runD1(sql, params));
        }
        return out;
      },
    });
  }

  const neonConnUrl =
    process.env.NEON_DATABASE_URL ||
    (explicitProv === 'neon' && process.env.DATABASE_URL
      ? process.env.DATABASE_URL
      : '');
  if (
    (!explicitProv || explicitProv === 'neon' || explicitProv === 'neon-pg') &&
    neonConnUrl
  ) {
    const parsedNeon = new URL(neonConnUrl);
    const activeSchema = process.env.PG_SCHEMA || parsedNeon.searchParams.get('schema') || null;
    if (parsedNeon.hostname.includes('-pooler.')) {
      parsedNeon.searchParams.delete('options');
    } else if (activeSchema && activeSchema !== 'public') {
      parsedNeon.searchParams.set('options', '-c search_path=' + activeSchema + ',public');
    }
    const effectiveNeonConnStr = parsedNeon.toString();
    const endpoint =
      process.env.NEON_HTTP_URL ||
      process.env.MYSHIP_NEON_HTTP_ENDPOINT ||
      'https://' + parsedNeon.host + '/sql';
    const toPgParams = (sql, params = []) => {
      if (!Array.isArray(params) || params.length === 0 || !sql.includes('?') || /\\$\\d+/.test(sql)) {
        return sql;
      }
      let idx = 0;
      return sql.replace(/\\?/g, () => '$' + (++idx));
    };
    const runNeon = async (sql, params = []) => {
      const normalizedSql = toPgParams(sql, params);
      const useTxnSchema = Boolean(activeSchema && activeSchema !== 'public');
      const safeSchema = useTxnSchema ? String(activeSchema).replace(/"/g, '""') : '';
      const bodyPayload = useTxnSchema
        ? {
            queries: [
              { query: 'SET LOCAL search_path TO "' + safeSchema + '", public', params: [] },
              { query: normalizedSql, params },
            ],
          }
        : { query: normalizedSql, params };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Neon-Connection-String': effectiveNeonConnStr,
          'Content-Type': 'application/json',
          'Neon-Raw-Text-Output': 'false',
          'Neon-Array-Mode': 'false',
        },
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.message) {
        throw new Error('Neon HTTP SQL Error (' + res.status + '): ' + (data.message || JSON.stringify(data)));
      }
      const targetResult = Array.isArray(data.results)
        ? data.results[data.results.length - 1] || {}
        : data;
      const rows = Array.isArray(targetResult.rows) ? targetResult.rows : [];
      return {
        rows,
        rowsAffected: Number(targetResult.rowCount ?? rows.length),
        lastInsertRowid: rows[0]?.id !== undefined ? rows[0].id : null,
      };
    };
    return withCloudAliases({
      provider: 'neon',
      url: effectiveNeonConnStr,
      schema: activeSchema,
      async execute(sql, params = []) { return runNeon(sql, params); },
      async query(sql, params = []) {
        const r = await runNeon(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        const out = [];
        for (const s of stmts) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runNeon(sql, params));
        }
        return out;
      },
    });
  }

  // 腾讯云 CloudBase PG 管控面 ExecutePGSql 云端运行通道
  if (
    (!explicitProv ||
      explicitProv === 'pg' ||
      explicitProv === 'postgres' ||
      explicitProv === 'cloudbase-pg') &&
    process.env.TCB_ENV_ID
  ) {
    const tcbEnvId = process.env.TCB_ENV_ID;
    const tcbRegion = process.env.TCB_REGION || 'ap-shanghai';
    const tcbSchema = process.env.PG_SCHEMA || null;
    const ddlKeywordsRe = /^\\s*(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT|SET|RESET|LOCK|REINDEX|CLUSTER|VACUUM|ANALYZE)\\b/i;

    const formatPgLit = (v) => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      return "'" + String(v).replace(/'/g, "''") + "'";
    };

    const bindParams = (sql, params = []) => {
      if (!Array.isArray(params) || params.length === 0) return sql;
      if (/\\$\\d+/.test(sql)) {
        return sql.replace(/\\$(\\d+)/g, (_, numStr) => {
          const idx = Number(numStr) - 1;
          return idx >= 0 && idx < params.length ? formatPgLit(params[idx]) : 'NULL';
        });
      }
      let idx = 0;
      return sql.replace(/\\?/g, () =>
        idx < params.length ? formatPgLit(params[idx++]) : 'NULL'
      );
    };

    const wrapDdl = (sql, schema) => {
      const cleaned = String(sql || '').trim().replace(/;+\\s*$/, '').replace(/'/g, "''");
      if (schema && schema !== 'public' && !/^\\s*CREATE\\s+SCHEMA\\b/i.test(sql)) {
        const safeSc = String(schema).replace(/"/g, '""').replace(/'/g, "''");
        return 'DO LANGUAGE plpgsql $$ BEGIN EXECUTE \\'SET LOCAL search_path TO "' + safeSc + '", public\\'; EXECUTE \\'' + cleaned + '\\'; END $$';
      }
      return "DO LANGUAGE plpgsql $$ BEGIN EXECUTE '" + cleaned + "'; END $$";
    };

    const parseTcbResp = (resp) => {
      const rs = resp?.ResultSet || resp || {};
      const cols = Array.isArray(rs?.Columns) ? rs.Columns : [];
      const types = Array.isArray(rs?.ColumnTypes) ? rs.ColumnTypes : [];
      const rawRows = Array.isArray(rs?.Rows) ? rs.Rows : [];
      const rows = rawRows.map((rowItem) => {
        const arr = typeof rowItem === 'string' ? JSON.parse(rowItem) : rowItem;
        const obj = {};
        cols.forEach((rawCol, i) => {
          const col = typeof rawCol === 'object' && rawCol !== null ? rawCol.Name || rawCol.name || String(i) : String(rawCol);
          const val = arr[i];
          const t = String(types[i] || rawCol?.Type || '').toLowerCase();
          if (val === null || val === undefined) obj[col] = null;
          else if (t === 'int2' || t === 'int4' || t === 'int8' || t === 'float4' || t === 'float8') {
            const num = Number(val);
            obj[col] = Number.isSafeInteger(num) || t.startsWith('float') ? num : val;
          } else if (t === 'bool' || t === 'boolean') {
            obj[col] = val === true || val === 'true' || val === 't' || val === '1';
          } else if (t === 'json' || t === 'jsonb') {
            try {
              obj[col] = typeof val === 'string' ? JSON.parse(val) : val;
            } catch {
              obj[col] = val;
            }
          } else {
            obj[col] = val;
          }
        });
        return obj;
      });
      return {
        rows,
        rowsAffected: Number(resp?.AffectedRows ?? rs?.AffectedRows ?? rows.length),
        lastInsertRowid: rows[0]?.id !== undefined ? rows[0].id : null,
      };
    };

    const callTcbExecutePgSql = async (rawSql, schema, retryWrap = true) => {
      const { secretId, secretKey, token } = resolveTencentCreds();
      if (!secretId || !secretKey) {
        throw new Error('CloudBase ExecutePGSql missing Tencent Cloud credentials (MYSHIP_DATA_SECRET_ID / TENCENTCLOUD_SECRETID).');
      }
      const trimmed = String(rawSql || '').trim();
      const applySc =
        schema &&
        schema !== 'public' &&
        !/^\\s*CREATE\\s+SCHEMA\\b/i.test(trimmed) &&
        !/\\bsearch_path\\b/i.test(trimmed) &&
        !/^\\s*DO\\s+LANGUAGE\\s+plpgsql\\b/i.test(trimmed);
      const safeSc = applySc ? String(schema).replace(/"/g, '""') : '';
      const effectiveSql = applySc ? 'SET search_path TO "' + safeSc + '", public; ' + trimmed : trimmed;

      const service = 'tcb';
      const host = 'tcb.tencentcloudapi.com';
      const action = 'ExecutePGSql';
      const version = '2018-06-08';
      const timestamp = Math.floor(Date.now() / 1000);
      const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
      const bodyStr = JSON.stringify({ EnvId: tcbEnvId, Sql: effectiveSql });
      const contentType = 'application/json; charset=utf-8';
      const canonicalHeaders = 'content-type:' + contentType + '\\nhost:' + host + '\\nx-tc-action:' + action.toLowerCase() + '\\n';
      const signedHeaders = 'content-type;host;x-tc-action';
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256HexStr(bodyStr)].join('\\n');
      const credentialScope = date + '/' + service + '/tc3_request';
      const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, sha256HexStr(canonicalRequest)].join('\\n');
      const secretDate = hmacSha256Buf('TC3' + secretKey, date);
      const secretService = hmacSha256Buf(secretDate, service);
      const secretSigning = hmacSha256Buf(secretService, 'tc3_request');
      const signature = hmacSha256Hex(secretSigning, stringToSign);
      const authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
      const headers = {
        Authorization: authorization,
        'Content-Type': contentType,
        Host: host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Region': tcbRegion,
        'X-TC-Timestamp': String(timestamp),
      };
      if (token) headers['X-TC-Token'] = token;

      const apiEndpoint = process.env.TCB_API_ENDPOINT || 'https://tcb.tencentcloudapi.com/';
      try {
        const res = await fetch(apiEndpoint, { method: 'POST', headers, body: bodyStr });
        const data = await res.json();
        if (data.Response && data.Response.Error) {
          throw new Error('CloudBase ExecutePGSql failed (' + data.Response.Error.Code + '): ' + data.Response.Error.Message);
        }
        return data.Response || data;
      } catch (err) {
        if (retryWrap && ddlKeywordsRe.test(trimmed)) {
          return callTcbExecutePgSql(wrapDdl(trimmed, schema), null, false);
        }
        throw err;
      }
    };

    const runTcb = async (sql, params = []) => {
      const bound = bindParams(sql, params);
      const resp = await callTcbExecutePgSql(bound, tcbSchema, true);
      return parseTcbResp(resp);
    };

    return withCloudAliases({
      provider: 'cloudbase-pg',
      envId: tcbEnvId,
      schema: tcbSchema,
      async execute(sql, params = []) { return runTcb(sql, params); },
      async query(sql, params = []) {
        const r = await runTcb(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        const out = [];
        for (const s of stmts) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runTcb(sql, params));
        }
        return out;
      },
    });
  }

  // 原生 PostgreSQL (pg.Pool) 云端运行通道
  if (
    (!explicitProv || explicitProv === 'pg' || explicitProv === 'postgres') &&
    !process.env.TCB_ENV_ID &&
    (process.env.DATABASE_URL || process.env.PGHOST)
  ) {
    const connStr = process.env.DATABASE_URL || '';
    const activeSchema = process.env.PG_SCHEMA || null;
    let poolPromise = null;
    const toPgPositional = (sql, params = []) => {
      if (!Array.isArray(params) || params.length === 0 || !sql.includes('?') || /\\$\\d+/.test(sql)) {
        return sql;
      }
      let idx = 0;
      return sql.replace(/\\?/g, () => '$' + (++idx));
    };
    const getPgPool = async () => {
      if (!poolPromise) {
        poolPromise = (async () => {
          const pgMod = await import('pg');
          const PoolCtor = pgMod.default?.Pool || pgMod.Pool;
          let isLocalHost = false;
          let isPoolerHost = false;
          let sslDisabled = false;
          let cleanConnStr = connStr;
          if (connStr) {
            try {
              const u = new URL(connStr);
              isLocalHost = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
              isPoolerHost = u.hostname.includes('-pooler.');
              sslDisabled = (u.searchParams.get('sslmode') || '').toLowerCase() === 'disable';
              u.searchParams.delete('schema');
              u.searchParams.delete('sslmode');
              u.searchParams.delete('options');
              cleanConnStr = u.toString();
            } catch {}
          } else {
            isLocalHost = process.env.PGHOST === '127.0.0.1' || process.env.PGHOST === 'localhost' || process.env.PGHOST === '::1';
            isPoolerHost = String(process.env.PGHOST || '').includes('-pooler.');
          }
          if (isPoolerHost && process.env.PGOPTIONS) {
            delete process.env.PGOPTIONS;
          }
          const pool = new PoolCtor(
            cleanConnStr
              ? {
                  connectionString: cleanConnStr,
                  max: 5,
                  ssl: isLocalHost || sslDisabled ? false : { rejectUnauthorized: false },
                }
              : {
                  host: process.env.PGHOST,
                  port: Number(process.env.PGPORT || 5432),
                  database: process.env.PGDATABASE || 'postgres',
                  user: process.env.PGUSER || 'postgres',
                  password: process.env.PGPASSWORD || '',
                  max: 5,
                  ssl: isLocalHost ? false : { rejectUnauthorized: false },
                }
          );
          pool.on('error', (err) => {
            console.warn('[MyShip PG Pool] Idle client error:', err?.message || err);
          });
          return pool;
        })();
      }
      return poolPromise;
    };
    const runPg = async (sql, params = []) => {
      if (((connStr || '') + ' ' + (process.env.PGHOST || '')).includes('-pooler.') && process.env.PGOPTIONS) {
        delete process.env.PGOPTIONS;
      }
      const pool = await getPgPool();
      let res;
      if (activeSchema && activeSchema !== 'public') {
        const client = await pool.connect();
        try {
          const safeSc = String(activeSchema).replace(/"/g, '""');
          await client.query('BEGIN');
          try {
            await client.query('SET LOCAL search_path TO "' + safeSc + '", public');
            res =
              Array.isArray(params) && params.length > 0
                ? await client.query(toPgPositional(sql, params), params)
                : await client.query(sql);
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK').catch(() => {});
            throw txErr;
          }
        } finally {
          client.release();
        }
      } else {
        res =
          Array.isArray(params) && params.length > 0
            ? await pool.query(toPgPositional(sql, params), params)
            : await pool.query(sql);
      }
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      return {
        rows,
        rowsAffected: Number(res?.rowCount ?? rows.length),
        lastInsertRowid: rows[0]?.id !== undefined ? rows[0].id : null,
      };
    };
    return withCloudAliases({
      provider: 'pg',
      url: connStr || ('postgresql://' + process.env.PGHOST + ':' + (process.env.PGPORT || 5432) + '/' + (process.env.PGDATABASE || 'postgres')),
      schema: activeSchema,
      async execute(sql, params = []) { return runPg(sql, params); },
      async query(sql, params = []) {
        const r = await runPg(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        const out = [];
        for (const s of stmts) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runPg(sql, params));
        }
        return out;
      },
    });
  }

  // 原生 MySQL (mysql2/promise) 云端运行通道
  const mysqlConnUrl =
    process.env.MYSQL_URL ||
    (explicitProv === 'mysql' && process.env.DATABASE_URL ? process.env.DATABASE_URL : '');
  if ((!explicitProv || explicitProv === 'mysql') && mysqlConnUrl) {
    let mysqlPoolPromise = null;
    const getMysqlPool = async () => {
      if (!mysqlPoolPromise) {
        mysqlPoolPromise = (async () => {
          const mysqlMod = await import('mysql2/promise');
          const createPoolFn = mysqlMod.default?.createPool || mysqlMod.createPool;
          return createPoolFn({ uri: mysqlConnUrl, connectionLimit: 5 });
        })();
      }
      return mysqlPoolPromise;
    };
    const runMysql = async (sql, params = []) => {
      const pool = await getMysqlPool();
      const [result] =
        Array.isArray(params) && params.length > 0
          ? await pool.execute(sql, params)
          : await pool.query(sql);
      if (Array.isArray(result)) {
        return {
          rows: result,
          rowsAffected: result.length,
          lastInsertRowid: result[0]?.id !== undefined ? result[0].id : null,
        };
      }
      return {
        rows: [],
        rowsAffected: Number(result?.affectedRows ?? 0),
        lastInsertRowid: result?.insertId !== undefined ? Number(result.insertId) : null,
      };
    };
    return withCloudAliases({
      provider: 'mysql',
      url: mysqlConnUrl,
      async execute(sql, params = []) { return runMysql(sql, params); },
      async query(sql, params = []) {
        const r = await runMysql(sql, params);
        return attachMeta(r.rows, r.rowsAffected, r.lastInsertRowid);
      },
      async batch(stmts = []) {
        const out = [];
        for (const s of stmts) {
          const sql = typeof s === 'string' ? s : Array.isArray(s) ? s[0] : s.sql;
          const params = typeof s === 'string' ? [] : Array.isArray(s) ? s[1] || [] : s.params || [];
          out.push(await runMysql(sql, params));
        }
        return out;
      },
    });
  }

  return withCloudAliases({
    provider: process.env.DATABASE_URL ? 'pg' : 'unconfigured',
    url: process.env.DATABASE_URL || null,
    schema: process.env.PG_SCHEMA || null,
    async execute() {
      throw new Error(
        process.env.DATABASE_URL
          ? 'PostgreSQL (DATABASE_URL) 已注入环境变量，请使用 pg / postgres / Drizzle 连接 process.env.DATABASE_URL。'
          : '未配置云端数据库。请先运行 "myship use db --provider <turso|d1|neon|pg>" 注册数据库。'
      );
    },
    async query(sql, params) { return this.execute(sql, params); },
    async batch(stmts) { return this.execute(stmts); },
  });
}

const { storage, files } = createCloudStorage();
const db = createCloudDbClient();
globalThis.myshipStorage = storage;
globalThis.myshipFiles = files;
globalThis.myshipDb = db;

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
      files,
      bucket: files,
      db,
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

  const rawBootstrapJs = generateBootstrapRuntimeSource(bootstrapUserEntryImport);
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const bootstrapBuildResult = await esbuild.build({
    stdin: {
      contents: rawBootstrapJs,
      resolveDir: cliDir,
      sourcefile: '_myship_bootstrap.mjs',
      loader: 'js',
    },
    absWorkingDir: cliDir,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: { js: bannerJs },
    external: [bootstrapUserEntryImport, 'pg-native'],
    write: false,
    logLevel: 'silent',
  });
  const bootstrapJsCode = bootstrapBuildResult.outputFiles[0].text;
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
    bootstrapJsCode,
    zipBuffer,
    zipSizeBytes: zipBuffer.length,
  };
}
