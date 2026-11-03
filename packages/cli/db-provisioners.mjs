/**
 * db-provisioners.mjs — MyShip 多引擎数据库物理建库、建 Schema 与连接派生引擎
 *
 * 支持：
 * 1. PostgreSQL / 腾讯云 CloudBase PG (`ExecutePGSql` 云 API + `pg.Client` Wire 协议物理创建 Schema/Database)
 * 2. 原生 MySQL / 腾讯云 TDSQL-C (`mysql2/promise` Wire 协议物理创建 Database)
 * 3. Neon Serverless PostgreSQL (Neon API v2 自动初始化 Project/Database + HTTP `/sql` 创建 Schema)
 * 4. Turso Edge SQLite (Turso Platform API 自动识别组织、初始化默认 Group、创建 Database 并签发 JWT Token)
 * 5. Cloudflare D1 (Cloudflare v4 API 自动查找或创建 D1 数据库)
 */
import { executeCloudBasePgSql } from './tcb-client.mjs';

export function sanitizePgSchemaIdent(str) {
  return (
    String(str || 'app')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'app'
  );
}

/**
 * 从 PostgreSQL 连接串解析出腾讯云 CloudBase PG / node-postgres 官方推荐的独立环境变量：
 * PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PG_SCHEMA, PGOPTIONS
 */
export function parsePostgresEnvVars(databaseUrl, schema = null) {
  const buildSchemaVars = (sc, isPooler = false) => {
    if (!sc) return {};
    const vars = { PG_SCHEMA: sc };
    if (sc !== 'public' && !isPooler) {
      vars.PGOPTIONS = `-c search_path=${sc},public`;
    }
    return vars;
  };
  if (!databaseUrl) return buildSchemaVars(schema);
  try {
    const parsed = new URL(databaseUrl);
    const effectiveSchema = schema || parsed.searchParams.get('schema');
    const isPooler = parsed.hostname.includes('-pooler.');
    const out = {
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || '5432',
      PGDATABASE: (parsed.pathname || '').replace(/^\/+/, '') || 'postgres',
      PGUSER: decodeURIComponent(parsed.username || ''),
      PGPASSWORD: decodeURIComponent(parsed.password || ''),
      ...buildSchemaVars(effectiveSchema, isPooler),
    };
    return out;
  } catch {
    return buildSchemaVars(schema);
  }
}

/**
 * 使用官方 `pg` (`pg.Client`) 执行 PostgreSQL 建库/建 Schema 指令
 */
export async function executePostgresSimpleSqlViaWire({
  connectionUrl,
  sql,
  timeoutMs = 4500,
} = {}) {
  const pgMod = await import('pg');
  const ClientCtor = pgMod.default?.Client || pgMod.Client;
  const parsed = new URL(connectionUrl);
  const host = parsed.hostname || '127.0.0.1';
  const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();
  const isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const wantSsl =
    sslMode === 'require' ||
    sslMode === 'no-verify' ||
    sslMode === 'verify-full' ||
    sslMode === 'prefer' ||
    (!isLocalHost && sslMode !== 'disable');
  const cleanUrl = new URL(connectionUrl);
  cleanUrl.searchParams.delete('schema');
  cleanUrl.searchParams.delete('sslmode');
  cleanUrl.searchParams.delete('options');

  const client = new ClientCtor({
    connectionString: cleanUrl.toString(),
    connectionTimeoutMillis: timeoutMs,
    ssl: wantSsl ? { rejectUnauthorized: false } : false,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query(sql);
    return { ok: true };
  } catch (err) {
    if (err?.code === '42P04' || err?.code === '42P06') {
      return { ok: true, alreadyExists: true };
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * 使用官方 `mysql2/promise` 执行 MySQL 建库指令 (`CREATE DATABASE IF NOT EXISTS`)
 */
export async function executeMysqlSimpleSqlViaWire({
  connectionUrl,
  sql,
  timeoutMs = 4500,
} = {}) {
  const mysqlMod = await import('mysql2/promise');
  const createConnectionFn = mysqlMod.default?.createConnection || mysqlMod.createConnection;
  const parsed = new URL(connectionUrl);
  const adminUrl = new URL(connectionUrl);
  adminUrl.pathname = (parsed.pathname || '').replace(/^\/+/, '') ? parsed.pathname : '/';
  let conn;
  try {
    conn = await createConnectionFn({
      uri: adminUrl.toString(),
      connectTimeout: timeoutMs,
    });
    await conn.query(sql);
    return { ok: true };
  } finally {
    try {
      conn?.destroy();
    } catch {
      // ignore
    }
  }
}

/**
 * 在 Neon 连接串模式下，通过 Neon 官方 HTTP SQL 接口 (`POST https://<host>/sql`) 物理创建专属 Schema
 */
export async function ensureNeonSchemaOverHttp({
  connectionUrl,
  schema,
  httpEndpoint = process.env.NEON_HTTP_URL || process.env.MYSHIP_NEON_HTTP_ENDPOINT || '',
  isLocal = false,
} = {}) {
  if (!connectionUrl || !schema || schema === 'public') {
    return { status: 'skipped', method: 'none' };
  }
  const parsed = new URL(connectionUrl);
  const endpoint = httpEndpoint || `https://${parsed.host}/sql`;
  const safeSchema = schema.replace(/"/g, '""');
  const sql = `CREATE SCHEMA IF NOT EXISTS "${safeSchema}"`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Neon-Connection-String': connectionUrl,
        'Content-Type': 'application/json',
        'Neon-Raw-Text-Output': 'false',
        'Neon-Array-Mode': 'false',
      },
      body: JSON.stringify({ query: sql, params: [] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.message) {
      throw new Error(`Neon HTTP SQL (${res.status}): ${data.message || JSON.stringify(data)}`);
    }
    return { status: 'created', method: 'Neon HTTP /sql 接口', target: schema };
  } catch (err) {
    if (isLocal) {
      return {
        status: 'deferred-offline',
        method: '本地沙盒跳过远端连接',
        detail: err.message,
      };
    }
    throw err;
  }
}

/**
 * 物理创建 PostgreSQL / 腾讯云 CloudBase PG 的项目专属 Schema 或 Database
 */
export async function provisionPostgresSchemaOrDb({
  masterUrl = '',
  tcbEnvId = '',
  tcbRegion = 'ap-shanghai',
  schema = 'public',
  dbName = '',
  isolateBy = 'schema',
  isRaw = false,
  isLocal = false,
} = {}) {
  if (isRaw) {
    return { status: 'skipped-raw', method: '原生直连已有库 (--raw)' };
  }

  const safeSchema = String(schema || 'public').replace(/"/g, '""');
  const safeDb = String(dbName || '').replace(/"/g, '""');
  const ddlSql =
    isolateBy === 'db' || isolateBy === 'database'
      ? `CREATE DATABASE "${safeDb}"`
      : `CREATE SCHEMA IF NOT EXISTS "${safeSchema}"`;

  // 通道 1: 腾讯云 CloudBase PG 管控面 ExecutePGSql 云 API
  if (
    tcbEnvId &&
    isolateBy !== 'db' &&
    isolateBy !== 'database' &&
    (!isLocal || process.env.TCB_API_ENDPOINT)
  ) {
    try {
      await executeCloudBasePgSql({
        envId: tcbEnvId,
        region: tcbRegion || 'ap-shanghai',
        sql: ddlSql,
      });
      return {
        status: 'created',
        method: `腾讯云 CloudBase ExecutePGSql 云 API (${tcbEnvId})`,
        target: schema,
      };
    } catch (tcbErr) {
      if (!masterUrl) {
        if (isLocal) {
          return {
            status: 'deferred-offline',
            method: `本地沙盒跳过远端 CloudBase API (${tcbErr.message})`,
          };
        }
        throw tcbErr;
      }
      // 若同时提供了 masterUrl，继续尝试 Wire Protocol 直连创建
    }
  }

  // 通道 2: 标准 PostgreSQL Wire Protocol 直连物理创建
  if (masterUrl) {
    try {
      await executePostgresSimpleSqlViaWire({
        connectionUrl: masterUrl,
        sql: ddlSql,
      });
      return {
        status: 'created',
        method: 'PostgreSQL 协议直连物理创建',
        target: isolateBy === 'db' || isolateBy === 'database' ? dbName : schema,
      };
    } catch (wireErr) {
      if (isLocal) {
        return {
          status: 'deferred-offline',
          method: `本地沙盒跳过远端直连 (${wireErr.message})`,
        };
      }
      throw wireErr;
    }
  }

  return { status: 'skipped', method: '未提供可建库连接' };
}

/**
 * 物理创建原生 MySQL 的项目专属 Database (`CREATE DATABASE IF NOT EXISTS`)
 */
export async function provisionMysqlDatabase({
  masterUrl = '',
  dbName = '',
  isRaw = false,
  isLocal = false,
} = {}) {
  if (isRaw) {
    return { status: 'skipped-raw', method: '原生直连已有库 (--raw)' };
  }
  if (!masterUrl || !dbName) {
    return { status: 'skipped', method: '未提供主库连接' };
  }
  const safeDb = String(dbName).replace(/`/g, '``');
  const ddlSql = `CREATE DATABASE IF NOT EXISTS \`${safeDb}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`;
  try {
    await executeMysqlSimpleSqlViaWire({
      connectionUrl: masterUrl,
      sql: ddlSql,
    });
    return {
      status: 'created',
      method: 'MySQL 协议直连物理创建',
      target: dbName,
    };
  } catch (err) {
    if (isLocal) {
      return {
        status: 'deferred-offline',
        method: `本地沙盒跳过远端直连 (${err.message})`,
      };
    }
    throw err;
  }
}

export function derivePostgresProjectUrl(
  masterUrl,
  project,
  envName = 'prod',
  { raw = false, isolateBy = 'schema' } = {}
) {
  let parsed;
  try {
    parsed = new URL(masterUrl);
  } catch {
    throw new Error(
      `无效的 PostgreSQL 连接串格式: ${masterUrl} (示例: postgresql://user:pass@host:5432/postgres)`
    );
  }

  if (raw) {
    return {
      schema: parsed.searchParams.get('schema') || 'public',
      databaseUrl: parsed.toString(),
    };
  }

  const cleanProj = sanitizePgSchemaIdent(project);
  const cleanEnv = sanitizePgSchemaIdent(envName);
  const ident =
    !cleanEnv || cleanEnv === 'prod'
      ? `myship_${cleanProj}`
      : `myship_${cleanProj}_${cleanEnv}`;

  if (isolateBy === 'db' || isolateBy === 'database') {
    parsed.pathname = `/${ident}`;
    return {
      schema: 'public',
      dbName: ident,
      databaseUrl: parsed.toString(),
    };
  }

  parsed.searchParams.set('schema', ident);
  if (parsed.hostname.includes('-pooler.')) {
    parsed.searchParams.delete('options');
  } else {
    parsed.searchParams.set('options', `-c search_path=${ident},public`);
  }
  return {
    schema: ident,
    databaseUrl: parsed.toString(),
  };
}

export function deriveMysqlProjectUrl(
  masterUrl,
  project,
  envName = 'prod',
  { raw = false } = {}
) {
  let parsed;
  try {
    parsed = new URL(masterUrl);
  } catch {
    throw new Error(
      `无效的 MySQL 连接串格式: ${masterUrl} (示例: mysql://user:pass@host:3306/mydb)`
    );
  }

  if (raw) {
    const rawDb = parsed.pathname.replace(/^\/+/, '') || 'mysql';
    return {
      dbName: rawDb,
      databaseUrl: parsed.toString(),
    };
  }

  const cleanProj = sanitizePgSchemaIdent(project);
  const cleanEnv = sanitizePgSchemaIdent(envName);
  const dbName =
    !cleanEnv || cleanEnv === 'prod'
      ? `myship_${cleanProj}`
      : `myship_${cleanProj}_${cleanEnv}`;

  parsed.pathname = `/${dbName}`;
  return {
    dbName,
    databaseUrl: parsed.toString(),
  };
}

export async function discoverTursoOrganizations({
  apiToken,
  apiBaseUrl = process.env.TURSO_API_BASE_URL || 'https://api.turso.tech',
} = {}) {
  if (!apiToken) return [];
  const base = String(apiBaseUrl).replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/v1/organizations`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => []);
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.organizations)
      ? data.organizations
      : [];
    return list
      .map((item) => ({
        slug: item?.slug || item?.name || '',
        name: item?.name || item?.slug || '',
        type: item?.type || 'personal',
      }))
      .filter((item) => Boolean(item.slug));
  } catch {
    return [];
  }
}

export async function provisionTursoDatabase({
  org,
  apiToken,
  dbName,
  group = 'default',
  explicitGroup = false,
  apiBaseUrl = process.env.TURSO_API_BASE_URL || 'https://api.turso.tech',
}) {
  const base = String(apiBaseUrl).replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  let dbRecord = null;
  let action = 'reused';
  let targetGroup = group || 'default';
  const isImplicitDefaultGroup = !explicitGroup && (!group || group === 'default');

  const getRes = await fetch(
    `${base}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(dbName)}`,
    { method: 'GET', headers }
  );
  if (getRes.ok) {
    const getData = await getRes.json();
    dbRecord = getData.database || getData;
  } else if (getRes.status === 404) {
    let createRes = await fetch(
      `${base}/v1/organizations/${encodeURIComponent(org)}/databases`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: dbName, group: targetGroup }),
      }
    );
    let createData = await createRes.json().catch(() => ({}));
    // 仅当用户未显式指定自定义 --group（使用默认 default group）且报不存在时，才自动回退已有 group 或初始化 default group
    if (
      !createRes.ok &&
      isImplicitDefaultGroup &&
      (createRes.status === 404 || createRes.status === 400)
    ) {
      const grpRes = await fetch(
        `${base}/v1/organizations/${encodeURIComponent(org)}/groups`,
        { method: 'GET', headers }
      ).catch(() => null);
      if (grpRes && grpRes.ok) {
        const grpData = await grpRes.json().catch(() => ({}));
        const groups = Array.isArray(grpData?.groups)
          ? grpData.groups
          : Array.isArray(grpData)
          ? grpData
          : [];
        if (groups.length > 0 && groups[0]?.name) {
          targetGroup = groups[0].name;
        } else {
          let preferredLoc = 'aws-ap-northeast-1';
          const locRes = await fetch(`${base}/v1/locations`, { method: 'GET', headers }).catch(
            () => null
          );
          if (locRes && locRes.ok) {
            const locData = await locRes.json().catch(() => ({}));
            const locMap = locData?.locations || {};
            if (locMap['aws-ap-northeast-1']) preferredLoc = 'aws-ap-northeast-1';
            else if (locMap['aws-ap-southeast-1']) preferredLoc = 'aws-ap-southeast-1';
            else if (Object.keys(locMap).length > 0) preferredLoc = Object.keys(locMap)[0];
          }
          await fetch(`${base}/v1/organizations/${encodeURIComponent(org)}/groups`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: targetGroup, location: preferredLoc }),
          }).catch(() => {});
        }
        createRes = await fetch(
          `${base}/v1/organizations/${encodeURIComponent(org)}/databases`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: dbName, group: targetGroup }),
          }
        );
        createData = await createRes.json().catch(() => ({}));
      }
    }
    if (!createRes.ok) {
      throw new Error(
        `Turso 自动建库失败 (${createRes.status}): ${
          createData.error || JSON.stringify(createData)
        }`
      );
    }
    dbRecord = createData.database || createData;
    action = 'created';
  } else {
    const errText = await getRes.text();
    throw new Error(`Turso 查询数据库失败 (${getRes.status}): ${errText.slice(0, 200)}`);
  }

  const rawHost = dbRecord?.Hostname || dbRecord?.hostname || `${dbName}-${org}.turso.io`;
  const databaseUrl =
    rawHost.startsWith('http://') ||
    rawHost.startsWith('https://') ||
    rawHost.startsWith('libsql://')
      ? rawHost
      : `libsql://${rawHost}`;

  const tokenRes = await fetch(
    `${base}/v1/organizations/${encodeURIComponent(org)}/databases/${encodeURIComponent(
      dbName
    )}/auth/tokens`,
    { method: 'POST', headers }
  );
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.jwt) {
    throw new Error(
      `Turso 签发项目数据库 Token 失败 (${tokenRes.status}): ${
        tokenData.error || JSON.stringify(tokenData)
      }`
    );
  }

  return {
    action,
    dbName,
    databaseId: dbRecord?.DbId || dbRecord?.dbId || dbName,
    databaseUrl,
    authToken: tokenData.jwt,
  };
}

export async function provisionCloudflareD1Database({
  accountId,
  apiToken,
  dbName,
  explicitDbId = null,
  apiBaseUrl = process.env.CF_API_BASE_URL || 'https://api.cloudflare.com/client/v4',
}) {
  const base = String(apiBaseUrl).replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  if (explicitDbId) {
    return {
      action: 'bound',
      dbName,
      databaseId: explicitDbId,
    };
  }

  const listRes = await fetch(
    `${base}/accounts/${encodeURIComponent(accountId)}/d1/database?name=${encodeURIComponent(
      dbName
    )}`,
    { method: 'GET', headers }
  );
  const listData = await listRes.json().catch(() => ({}));
  if (!listRes.ok || listData.success === false) {
    throw new Error(
      `Cloudflare D1 查询数据库列表失败 (${listRes.status}): ${
        listData?.errors?.[0]?.message || JSON.stringify(listData)
      }`
    );
  }

  const existingList = Array.isArray(listData.result) ? listData.result : [];
  const matched = existingList.find((d) => d.name === dbName);
  if (matched && matched.uuid) {
    return {
      action: 'reused',
      dbName,
      databaseId: matched.uuid,
    };
  }

  const createRes = await fetch(
    `${base}/accounts/${encodeURIComponent(accountId)}/d1/database`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: dbName }),
    }
  );
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok || createData.success === false || !createData.result?.uuid) {
    throw new Error(
      `Cloudflare D1 自动建库失败 (${createRes.status}): ${
        createData?.errors?.[0]?.message || JSON.stringify(createData)
      }`
    );
  }

  return {
    action: 'created',
    dbName,
    databaseId: createData.result.uuid,
  };
}

export async function provisionNeonDatabase({
  apiKey,
  projectId = null,
  dbName,
  apiBaseUrl = process.env.NEON_API_BASE_URL || 'https://console.neon.tech/api/v2',
}) {
  const base = String(apiBaseUrl).replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  let resolvedProjectId = projectId;
  if (!resolvedProjectId) {
    let projRes = await fetch(`${base}/projects`, { method: 'GET', headers });
    let projData = await projRes.json().catch(() => ({}));
    let projects = Array.isArray(projData.projects) ? projData.projects : [];
    let discoveredOrgId = '';

    if (!projRes.ok || projects.length === 0) {
      const orgRes = await fetch(`${base}/users/me/organizations`, {
        method: 'GET',
        headers,
      }).catch(() => null);
      if (orgRes && orgRes.ok) {
        const orgData = await orgRes.json().catch(() => ({}));
        discoveredOrgId = orgData?.organizations?.[0]?.id || '';
      }
      if (discoveredOrgId) {
        const orgProjRes = await fetch(
          `${base}/projects?org_id=${encodeURIComponent(discoveredOrgId)}`,
          { method: 'GET', headers }
        ).catch(() => null);
        if (orgProjRes && orgProjRes.ok) {
          projRes = orgProjRes;
          projData = await orgProjRes.json().catch(() => ({}));
          projects = Array.isArray(projData.projects) ? projData.projects : [];
        }
      }
    }

    // 全新 Neon 账号尚无任何 Project 时，自动初始化默认 Project (myship-default)
    if (projRes.ok && projects.length === 0) {
      let createProjRes = await fetch(`${base}/projects`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project: {
            name: 'myship-default',
            region_id: 'aws-ap-southeast-1',
            ...(discoveredOrgId ? { org_id: discoveredOrgId } : {}),
          },
        }),
      });
      if (!createProjRes.ok && discoveredOrgId) {
        createProjRes = await fetch(`${base}/projects`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            project: {
              name: 'myship-default',
              region_id: 'aws-ap-southeast-1',
            },
          }),
        });
      }
      const createProjData = await createProjRes.json().catch(() => ({}));
      if (createProjRes.ok && createProjData.project?.id) {
        projects = [createProjData.project];
      }
    }

    if (!projRes.ok || projects.length === 0) {
      throw new Error(
        `Neon 查询项目列表失败 (${projRes.status}): ${
          projData.message || '账号下未找到任何 Neon Project，请先在 Neon 控制台创建一个 Project 或指定 --project-id'
        }`
      );
    }
    resolvedProjectId = projects[0].id;
  }

  const branchRes = await fetch(
    `${base}/projects/${encodeURIComponent(resolvedProjectId)}/branches`,
    { method: 'GET', headers }
  );
  const branchData = await branchRes.json().catch(() => ({}));
  if (!branchRes.ok || !Array.isArray(branchData.branches) || branchData.branches.length === 0) {
    throw new Error(
      `Neon 查询分支失败 (${branchRes.status}): ${branchData.message || JSON.stringify(branchData)}`
    );
  }
  const primaryBranch =
    branchData.branches.find((b) => b.primary || b.default) || branchData.branches[0];
  const branchId = primaryBranch.id;

  const dbsRes = await fetch(
    `${base}/projects/${encodeURIComponent(resolvedProjectId)}/branches/${encodeURIComponent(
      branchId
    )}/databases`,
    { method: 'GET', headers }
  );
  const dbsData = await dbsRes.json().catch(() => ({}));
  if (!dbsRes.ok) {
    throw new Error(
      `Neon 查询数据库列表失败 (${dbsRes.status}): ${dbsData.message || JSON.stringify(dbsData)}`
    );
  }
  const dbList = Array.isArray(dbsData.databases) ? dbsData.databases : [];
  const ownerName = dbList[0]?.owner_name || 'neondb_owner';
  const existingDb = dbList.find((d) => d.name === dbName);

  let action = 'reused';
  if (!existingDb) {
    let createRes = null;
    let createData = {};
    for (let attempt = 0; attempt < 15; attempt++) {
      createRes = await fetch(
        `${base}/projects/${encodeURIComponent(resolvedProjectId)}/branches/${encodeURIComponent(
          branchId
        )}/databases`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            database: {
              name: dbName,
              owner_name: ownerName,
            },
          }),
        }
      );
      createData = await createRes.json().catch(() => ({}));
      if (createRes.ok) break;
      const errMsg = String(createData.message || '').toLowerCase();
      if (
        createRes.status === 423 ||
        createRes.status === 409 ||
        errMsg.includes('conflicting') ||
        errMsg.includes('operation') ||
        errMsg.includes('locked')
      ) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      break;
    }
    if (!createRes || !createRes.ok) {
      throw new Error(
        `Neon 自动创建数据库 [${dbName}] 失败 (${createRes?.status}): ${
          createData.message || JSON.stringify(createData)
        }`
      );
    }
    action = 'created';
  }

  const uriRes = await fetch(
    `${base}/projects/${encodeURIComponent(
      resolvedProjectId
    )}/connection_uri?branch_id=${encodeURIComponent(branchId)}&database_name=${encodeURIComponent(
      dbName
    )}&role_name=${encodeURIComponent(ownerName)}`,
    { method: 'GET', headers }
  );
  const uriData = await uriRes.json().catch(() => ({}));
  if (!uriRes.ok || !uriData.uri) {
    throw new Error(
      `Neon 获取数据库连接串失败 (${uriRes.status}): ${uriData.message || JSON.stringify(uriData)}`
    );
  }

  return {
    action,
    projectId: resolvedProjectId,
    branchId,
    dbName,
    ownerName,
    databaseUrl: uriData.uri,
  };
}
