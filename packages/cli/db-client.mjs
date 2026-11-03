/**
 * db-client.mjs — MyShip 统一多引擎数据库客户端 (context.db)
 *
 * 作为本地开发 (`myship dev`) 与云端腾讯云 SCF 运行时 (`_myship/bootstrap.mjs`) 的单一可信源实现：
 * - 支持 Turso HTTP (`/v2/pipeline`)
 * - 支持 Cloudflare D1 HTTP (`/query`)
 * - 支持 Neon Serverless PostgreSQL HTTP (`/sql`, 支持单事务 `SET LOCAL search_path`)
 * - 支持腾讯云 CloudBase PostgreSQL 管控面 `ExecutePGSql`
 * - 支持原生 PostgreSQL (`pg.Pool`, 含跨请求连接池复用、PgBouncer `-pooler.` 兼容与事务级 `SET LOCAL search_path`)
 * - 支持原生 MySQL (`mysql2/promise`, 含跨请求连接池复用)
 * - 本地开发 (`preferLocalSqlite: true`) 默认使用 Node.js 22+ 原生 `node:sqlite` (`DatabaseSync`) 落盘至 `.myship/data/<project>/local.sqlite`
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeDomainToken } from './project-context.mjs';
import { executeCloudBasePgSql } from './cos-client.mjs';

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

  // 1. Turso HTTP (/v2/pipeline)
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

    return withDbAliases(
      {
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
      },
      cleanProj
    );
  }

  // 2. Cloudflare D1 HTTP (/query)
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

    return withDbAliases(
      {
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
      },
      cleanProj
    );
  }

  // 3. Neon Serverless PostgreSQL HTTP (/sql)
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

    return withDbAliases(
      {
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
      },
      cleanProj
    );
  }

  // 4. 腾讯云 CloudBase PG 管控面 ExecutePGSql 零依赖查询通道
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
          const col =
            typeof rawCol === 'object' && rawCol !== null
              ? rawCol.Name || rawCol.name || String(i)
              : String(rawCol);
          const val = arr[i];
          const t = String(types[i] || rawCol?.Type || '').toLowerCase();
          if (val === null || val === undefined) {
            obj[col] = null;
          } else if (
            t === 'int2' ||
            t === 'int4' ||
            t === 'int8' ||
            t === 'float4' ||
            t === 'float8'
          ) {
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
        apiEndpoint:
          env.TCB_API_ENDPOINT ||
          process.env.TCB_API_ENDPOINT ||
          'https://tcb.tencentcloudapi.com/',
      });
      return parseTcbPgResponse(resp);
    }

    return withDbAliases(
      {
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
      },
      cleanProj
    );
  }

  // 5. 原生 PostgreSQL (`pg.Pool`) 驱动通道
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
        url:
          connStr ||
          `postgresql://${env.PGHOST}:${env.PGPORT || 5432}/${env.PGDATABASE || 'postgres'}`,
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

  // 6. 原生 MySQL (`mysql2/promise`) 驱动通道
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

  // 7. 云端 SCF 模式 (`preferLocalSqlite: false`) 下未配置任何远端数据库时返回明确引导异常
  if (!preferLocalSqlite) {
    return withDbAliases(
      {
        provider: env?.DATABASE_URL ? 'pg' : 'unconfigured',
        url: env?.DATABASE_URL || null,
        schema: env?.PG_SCHEMA || null,
        async execute() {
          throw new Error(
            env?.DATABASE_URL
              ? 'PostgreSQL (DATABASE_URL) 已注入环境变量，请使用 pg / postgres / Drizzle 连接 process.env.DATABASE_URL。'
              : '未配置云端数据库。请先运行 "myship use db --provider <turso|d1|neon|pg|mysql>" 注册数据库。'
          );
        },
        async query(sql, params) {
          return this.execute(sql, params);
        },
        async batch(stmts) {
          return this.execute(stmts);
        },
      },
      cleanProj
    );
  }

  // 8. 本地开发 (SQLite 模式): 使用 Node.js 22+ 原生内置 node:sqlite (DatabaseSync)
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
