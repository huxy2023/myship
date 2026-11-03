/**
 * tcb-client.mjs — 腾讯云 CloudBase (TCB) 管控面 API v3 (TC3-HMAC-SHA256) 客户端
 *
 * 职责：
 * - 执行 CloudBase PostgreSQL SQL (`ExecutePGSql`，含 DDL 自动包装重试与 Schema `search_path` 注入)
 * - 自动扫描当前腾讯云账号下所有启用 PostgreSQL 的 CloudBase 环境 (`DescribeEnvs`)
 */
import { createHash, createHmac } from 'node:crypto';
import { loadTencentCredentials } from './cos-client.mjs';

function sha256HexStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Buf(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function hmacSha256Hex(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

const TCB_DDL_KEYWORDS_RE =
  /^\s*(CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT|SET|RESET|LOCK|REINDEX|CLUSTER|VACUUM|ANALYZE)\b/i;

export function wrapPlpgsqlDdl(sql, schema = null) {
  const cleaned = String(sql || '')
    .trim()
    .replace(/;+\s*$/, '')
    .replace(/'/g, "''");
  if (schema && schema !== 'public' && !/^\s*CREATE\s+SCHEMA\b/i.test(sql)) {
    const safeSchema = String(schema).replace(/"/g, '""').replace(/'/g, "''");
    return `DO LANGUAGE plpgsql $$ BEGIN EXECUTE 'SET LOCAL search_path TO "${safeSchema}", public'; EXECUTE '${cleaned}'; END $$`;
  }
  return `DO LANGUAGE plpgsql $$ BEGIN EXECUTE '${cleaned}'; END $$`;
}

/**
 * 调用腾讯云 CloudBase (TCB) 管控面 ExecutePGSql 云 API 执行 PostgreSQL 语句
 * 遵循官方文档规范 (https://docs.cloudbase.net/database/postgresql/initialization)：
 * - 复用腾讯云 SecretId / SecretKey (TC3-HMAC-SHA256)
 * - 支持自动按项目专属 Schema 注入 `SET search_path TO "<schema>", public;`
 * - DDL 直接执行若返回 InternalError，自动使用 `DO LANGUAGE plpgsql $$ BEGIN EXECUTE '...'; END $$` 包装重试
 */
export async function executeCloudBasePgSql({
  envId,
  region = 'ap-shanghai',
  sql,
  schema = null,
  role = null,
  retryWithWrap = true,
  apiEndpoint = process.env.TCB_API_ENDPOINT || 'https://tcb.tencentcloudapi.com/',
} = {}) {
  if (!envId) {
    throw new Error('缺少腾讯云 CloudBase 环境 ID (envId)');
  }
  const { secretId, secretKey, token } = loadTencentCredentials();
  const service = 'tcb';
  const host = 'tcb.tencentcloudapi.com';
  const action = 'ExecutePGSql';
  const version = '2018-06-08';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const rawSql = String(sql || '').trim();
  const shouldApplySchema =
    schema &&
    schema !== 'public' &&
    !/^\s*CREATE\s+SCHEMA\b/i.test(rawSql) &&
    !/\bsearch_path\b/i.test(rawSql) &&
    !/^\s*DO\s+LANGUAGE\s+plpgsql\b/i.test(rawSql);
  const safeSchema = shouldApplySchema ? String(schema).replace(/"/g, '""') : '';
  const effectiveSql = shouldApplySchema
    ? `SET search_path TO "${safeSchema}", public; ${rawSql}`
    : rawSql;

  const payload = {
    EnvId: envId,
    Sql: effectiveSql,
    ...(role ? { Role: role } : {}),
  };
  const bodyStr = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256HexStr(bodyStr),
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256HexStr(canonicalRequest),
  ].join('\n');

  const secretDate = hmacSha256Buf(`TC3${secretKey}`, date);
  const secretService = hmacSha256Buf(secretDate, service);
  const secretSigning = hmacSha256Buf(secretService, 'tc3_request');
  const signature = hmacSha256Hex(secretSigning, stringToSign);
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Region': region || 'ap-shanghai',
    'X-TC-Timestamp': String(timestamp),
  };
  if (token) {
    headers['X-TC-Token'] = token;
  }

  try {
    const res = await fetch(apiEndpoint, {
      method: 'POST',
      headers,
      body: bodyStr,
    });
    const data = await res.json();
    if (data.Response && data.Response.Error) {
      const err = new Error(
        `CloudBase ExecutePGSql 失败 (${data.Response.Error.Code}): ${data.Response.Error.Message}`
      );
      err.code = data.Response.Error.Code;
      throw err;
    }
    return data.Response || data;
  } catch (err) {
    if (retryWithWrap && TCB_DDL_KEYWORDS_RE.test(String(sql || '').trim())) {
      return executeCloudBasePgSql({
        envId,
        region,
        sql: wrapPlpgsqlDdl(sql, schema),
        schema: null,
        role,
        retryWithWrap: false,
        apiEndpoint,
      });
    }
    throw err;
  }
}

/**
 * 自动扫描当前腾讯云账号下所有已启用 PostgreSQL 模式的 CloudBase 环境 (免手敲 envId 与 region)
 */
export async function discoverCloudBasePgEnvs({
  regions = ['ap-shanghai', 'ap-guangzhou', 'ap-beijing'],
  apiEndpoint = process.env.TCB_API_ENDPOINT || 'https://tcb.tencentcloudapi.com/',
} = {}) {
  let creds;
  try {
    creds = loadTencentCredentials();
  } catch {
    return [];
  }
  const { secretId, secretKey, token } = creds;
  const service = 'tcb';
  const host = 'tcb.tencentcloudapi.com';
  const action = 'DescribeEnvs';
  const version = '2018-06-08';

  const queryOneRegion = async (region) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const bodyStr = '{}';
    const contentType = 'application/json; charset=utf-8';
    const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
      'POST',
      '/',
      '',
      canonicalHeaders,
      signedHeaders,
      sha256HexStr(bodyStr),
    ].join('\n');
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = [
      'TC3-HMAC-SHA256',
      String(timestamp),
      credentialScope,
      sha256HexStr(canonicalRequest),
    ].join('\n');
    const secretDate = hmacSha256Buf(`TC3${secretKey}`, date);
    const secretService = hmacSha256Buf(secretDate, service);
    const secretSigning = hmacSha256Buf(secretService, 'tc3_request');
    const signature = hmacSha256Hex(secretSigning, stringToSign);
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
      Authorization: authorization,
      'Content-Type': contentType,
      Host: host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': region,
      'X-TC-Timestamp': String(timestamp),
    };
    if (token) {
      headers['X-TC-Token'] = token;
    }

    try {
      const res = await fetch(apiEndpoint, {
        method: 'POST',
        headers,
        body: bodyStr,
      });
      const data = await res.json();
      const envList = data?.Response?.EnvList || [];
      return envList
        .filter((env) => {
          const hasPgArr = Array.isArray(env.PostgreSQL) && env.PostgreSQL.length > 0;
          const hasPgMeta =
            Array.isArray(env.Meta) &&
            env.Meta.some(
              (m) => (m.Key === 'postgresql' || m.Key === 'postgre_sql') && m.Value === 'enable'
            );
          return hasPgArr || hasPgMeta;
        })
        .map((env) => ({
          envId: env.EnvId,
          alias: env.Alias || env.EnvId,
          region: env.Region || region,
          packageName: env.PackageName || '标准版',
          instanceName:
            env.PostgreSQL?.[0]?.InstanceName || env.PostgreSQL?.[0]?.Name || 'postgres',
          status: env.Status || 'NORMAL',
        }));
    } catch {
      return [];
    }
  };

  const results = await Promise.all(regions.map((r) => queryOneRegion(r)));
  const seen = new Set();
  const merged = [];
  for (const list of results) {
    for (const item of list) {
      if (!seen.has(item.envId)) {
        seen.add(item.envId);
        merged.push(item);
      }
    }
  }
  return merged;
}
