/**
 * cos-client.mjs — 零依赖腾讯云 COS 轻量级客户端 (BYOC 开源版)
 *
 * 三级凭证与配置加载优先级 (跨电脑零依赖)：
 *   1. 环境变量 (适合 CI/CD): MYSHIP_SECRET_ID / TENCENTCLOUD_SECRET_ID 等
 *   2. MyShip 独立全局配置 (适合任意新电脑): ~/.myship/config.json (由 myship login 生成, 权限 0600)
 *   3. 本机 tccli 凭证自动兜底: ~/.tccli/default.credential (由 tccli auth login 生成，自动支持 STS token)
 *
 * 安全红线：绝不在任何日志或输出中打印完整 SecretId / SecretKey。
 */
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

export const MYSHIP_CONFIG_PATH = resolve(homedir(), '.myship', 'config.json');
export const MYSHIP_GLOBAL_EDGE_FN_PATH = resolve(
  homedir(),
  '.myship',
  'edgeone-function.dist.js'
);
export const TCCLI_CRED_PATH = resolve(homedir(), '.tccli', 'default.credential');

function getConfigPath() {
  return process.env.MYSHIP_CONFIG_PATH || MYSHIP_CONFIG_PATH;
}

export function loadMyShipFileConfig() {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMyShipFileConfig(newConfig) {
  const cfgPath = getConfigPath();
  const current = loadMyShipFileConfig();
  const merged = {
    ...current,
    ...newConfig,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(merged, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(cfgPath, 0o600);
  } catch {
    // Windows 忽略 chmod
  }
  return merged;
}

export function getGlobalDbProvidersConfig() {
  const fileCfg = loadMyShipFileConfig();
  return {
    defaultDbProvider:
      process.env.MYSHIP_DEFAULT_DB_PROVIDER || fileCfg.defaultDbProvider || '',
    pgMasterUrl: process.env.MYSHIP_PG_MASTER_URL || fileCfg.pgMasterUrl || '',
    tcbEnvId:
      process.env.MYSHIP_TCB_ENV_ID || process.env.TCB_ENV_ID || fileCfg.tcbEnvId || '',
    tcbRegion:
      process.env.MYSHIP_TCB_REGION ||
      process.env.TCB_REGION ||
      fileCfg.tcbRegion ||
      'ap-shanghai',
    mysqlMasterUrl: process.env.MYSHIP_MYSQL_MASTER_URL || fileCfg.mysqlMasterUrl || '',
    neonMasterUrl: process.env.MYSHIP_NEON_MASTER_URL || fileCfg.neonMasterUrl || '',
    neonApiKey: process.env.MYSHIP_NEON_API_KEY || fileCfg.neonApiKey || '',
    neonProjectId: process.env.MYSHIP_NEON_PROJECT_ID || fileCfg.neonProjectId || '',
    tursoApiToken: process.env.MYSHIP_TURSO_API_TOKEN || fileCfg.tursoApiToken || '',
    tursoOrg: process.env.MYSHIP_TURSO_ORG || fileCfg.tursoOrg || '',
    tursoGroup: process.env.MYSHIP_TURSO_GROUP || fileCfg.tursoGroup || 'default',
    cfAccountId: process.env.MYSHIP_CF_ACCOUNT_ID || fileCfg.cfAccountId || '',
    cfApiToken: process.env.MYSHIP_CF_API_TOKEN || fileCfg.cfApiToken || '',
  };
}

export function getEffectiveEndpoints() {
  const fileCfg = loadMyShipFileConfig();
  const cosOrigin = (process.env.COS_ORIGIN || fileCfg.cosOrigin || '').replace(/\/$/, '');
  const remoteDomain = (process.env.SHIP_REMOTE_DOMAIN || fileCfg.remoteDomain || '').replace(
    /^\*\./,
    ''
  );
  return {
    cosOrigin: cosOrigin || null,
    remoteDomain: remoteDomain || null,
    isConfigured: Boolean(cosOrigin && remoteDomain),
  };
}

export function assertCloudEndpointsConfigured() {
  const { cosOrigin, remoteDomain, isConfigured } = getEffectiveEndpoints();
  if (!isConfigured) {
    throw new Error(
      [
        '尚未配置你的云端存储桶 (COS_ORIGIN) 或泛域名后缀 (SHIP_REMOTE_DOMAIN)。',
        '',
        '👉 方式一 (交互式绑定你自己的云底座):',
        '   运行 `myship login` 填写你的 COS 桶地址 (如 https://myship-1250000000.cos.ap-guangzhou.myqcloud.com) 与泛域名后缀 (如 ship.example.com)',
        '',
        '👉 方式二 (无需云账号，使用本地离线沙盒模式体验):',
        '   在命令后加上 `--local` (如 `myship ./dist --local` 或运行 `pnpm demo`)',
      ].join('\n')
    );
  }
  return { cosOrigin, remoteDomain };
}

function maskSecret(str) {
  if (!str || str.length < 8) return '****';
  return `${str.slice(0, 4)}****${str.slice(-4)}`;
}

export function loadTencentCredentials() {
  // 1. 优先读取环境变量 (CI/CD)
  const envId = process.env.MYSHIP_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID;
  const envKey = process.env.MYSHIP_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY;
  if (envId && envKey) {
    return {
      secretId: envId,
      secretKey: envKey,
      token: process.env.MYSHIP_TOKEN || process.env.TENCENTCLOUD_TOKEN || '',
      source: '环境变量 (ENV)',
    };
  }

  // 2. 其次读取 ~/.myship/config.json (跨电脑独立登录配置)
  const fileCfg = loadMyShipFileConfig();
  if (fileCfg.secretId && fileCfg.secretKey) {
    return {
      secretId: fileCfg.secretId,
      secretKey: fileCfg.secretKey,
      token: fileCfg.token || '',
      source: `~/.myship/config.json`,
    };
  }

  // 3. 自动兜底读取 ~/.tccli/default.credential (支持 OAuth 临时 Token 自动续期)
  if (existsSync(TCCLI_CRED_PATH)) {
    let raw = JSON.parse(readFileSync(TCCLI_CRED_PATH, 'utf8'));
    const nowSec = Math.floor(Date.now() / 1000);
    if (raw.expiresAt && Number(raw.expiresAt) - 60 < nowSec) {
      try {
        execFileSync('tccli', ['sts', 'GetCallerIdentity'], { stdio: 'ignore' });
        raw = JSON.parse(readFileSync(TCCLI_CRED_PATH, 'utf8'));
      } catch {
        // ignore if tccli is not in PATH
      }
    }
    const secretId = raw.secretId || raw.SecretId;
    const secretKey = raw.secretKey || raw.SecretKey;
    const token = raw.token || raw.Token || '';
    if (secretId && secretKey) {
      return {
        secretId,
        secretKey,
        token,
        source: `~/.tccli/default.credential (tccli 自动复用)`,
      };
    }
  }

  throw new Error(
    '未检测到云端部署凭证！请先运行 `myship login` 配置密钥，或设置环境变量 MYSHIP_SECRET_ID / MYSHIP_SECRET_KEY。'
  );
}

export function getAuthStatus() {
  const endpoints = getEffectiveEndpoints();
  try {
    const cred = loadTencentCredentials();
    return {
      authenticated: true,
      source: cred.source,
      maskedSecretId: maskSecret(cred.secretId),
      ...endpoints,
    };
  } catch (err) {
    return {
      authenticated: false,
      error: err.message,
      ...endpoints,
    };
  }
}

function sha1Hex(str) {
  return createHash('sha1').update(str).digest('hex');
}

function hmacSha1Hex(key, str) {
  return createHmac('sha1', key).update(str).digest('hex');
}

export function signCosRequest(method, objectKey, customOrigin) {
  const cosOrigin = customOrigin || assertCloudEndpointsConfigured().cosOrigin;
  const { secretId, secretKey, token } = loadTencentCredentials();
  const url = new URL(objectKey.startsWith('/') ? objectKey : `/${objectKey}`, cosOrigin);
  const host = url.host;

  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 3600}`;
  const signKey = hmacSha1Hex(secretKey, keyTime);

  const paramEntries = [];
  for (const [k, v] of url.searchParams.entries()) {
    paramEntries.push([encodeURIComponent(k).toLowerCase(), encodeURIComponent(v)]);
  }
  paramEntries.sort((a, b) => a[0].localeCompare(b[0]));
  const urlParamList = paramEntries.map(([k]) => k).join(';');
  const httpParameters = paramEntries.map(([k, v]) => `${k}=${v}`).join('&');

  const httpString = `${method.toLowerCase()}\n${url.pathname}\n${httpParameters}\nhost=${encodeURIComponent(host).toLowerCase()}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1Hex(signKey, stringToSign);

  const authorization = [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    `q-url-param-list=${urlParamList}`,
    `q-signature=${signature}`,
  ].join('&');

  const headers = {
    Authorization: authorization,
  };
  if (token) {
    headers['x-cos-security-token'] = token;
  }
  return { url: url.toString(), headers };
}

export async function cosHeadObject(objectKey, customOrigin) {
  const { url, headers } = signCosRequest('HEAD', objectKey, customOrigin);
  const res = await fetch(url, { method: 'HEAD', headers });
  if (res.status === 404) {
    return false;
  }
  if (!res.ok) {
    throw new Error(`COS HEAD 检查失败 (${res.status}) [${objectKey}]`);
  }
  return true;
}

export async function cosPutObject(
  objectKey,
  body,
  contentType = 'application/octet-stream',
  customOrigin,
  options = {}
) {
  const { url, headers } = signCosRequest('PUT', objectKey, customOrigin);
  headers['Content-Type'] = contentType;
  headers['x-cos-acl'] = options.acl || 'public-read';

  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`COS PUT 失败 (${res.status}) [${objectKey}]: ${errText.slice(0, 300)}`);
  }
  return true;
}

export async function cosDeleteObject(objectKey, customOrigin) {
  const { url, headers } = signCosRequest('DELETE', objectKey, customOrigin);
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404 && res.status !== 204) {
    const errText = await res.text();
    throw new Error(`COS DELETE 失败 (${res.status}) [${objectKey}]: ${errText.slice(0, 300)}`);
  }
  return true;
}

export async function cosGetJson(objectKey, customOrigin) {
  const { url, headers } = signCosRequest('GET', objectKey, customOrigin);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

export async function cosListKeys(prefix = '', customOrigin, { maxKeys = 1000 } = {}) {
  const keys = [];
  let marker = '';

  while (true) {
    const qs = new URLSearchParams();
    if (prefix) qs.set('prefix', prefix);
    if (maxKeys) qs.set('max-keys', String(maxKeys));
    if (marker) qs.set('marker', marker);

    const queryStr = qs.toString();
    const reqPath = queryStr ? `/?${queryStr}` : '/';
    const { url, headers } = signCosRequest('GET', reqPath, customOrigin);
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`COS ListBucket 失败 (${res.status})`);
    }
    const xml = await res.text();
    const regex = /<Key>([^<]+)<\/Key>/g;
    let match;
    let lastKeyInPage = '';
    while ((match = regex.exec(xml)) !== null) {
      lastKeyInPage = match[1];
      if (!prefix || match[1].startsWith(prefix)) {
        keys.push(match[1]);
      }
    }

    const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    if (!isTruncated) {
      break;
    }
    const nextMarkerMatch = xml.match(/<NextMarker>([^<]+)<\/NextMarker>/i);
    const nextMarker = nextMarkerMatch ? nextMarkerMatch[1] : lastKeyInPage;
    if (!nextMarker || nextMarker === marker) {
      break;
    }
    marker = nextMarker;
  }

  return keys;
}

// ============================================================================
// 腾讯云 EdgeOne (TEO) 原生 API v3 (TC3-HMAC-SHA256) 客户端与全局网关探测
// ============================================================================
function sha256HexStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Buf(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function hmacSha256Hex(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

export async function probeEdgeGateway(remoteDomain) {
  if (!remoteDomain) return { online: false };
  const cleanDomain = remoteDomain.replace(/^\*\./, '');
  const probeUrl = `https://_myship_probe.${cleanDomain}/`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(probeUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html' },
    });
    clearTimeout(timer);
    const hasHeader = Boolean(
      res.headers.get('x-myship-subdomain') || res.headers.get('x-myship-engine')
    );
    const text = await res.text();
    const isMyShipBody =
      text.includes('DEPLOYMENT_ALIAS_NOT_FOUND') ||
      text.includes('MyShip') ||
      text.includes('aliases/_myship_probe.json');
    return {
      online: hasHeader || isMyShipBody,
      status: res.status,
      probeUrl,
    };
  } catch {
    return { online: false, probeUrl };
  }
}

export async function teoRequest(action, payload = {}) {
  const { secretId, secretKey, token } = loadTencentCredentials();
  const service = 'teo';
  const host = 'teo.tencentcloudapi.com';
  const version = '2022-09-01';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

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
    'X-TC-Timestamp': String(timestamp),
  };
  if (token) {
    headers['X-TC-Token'] = token;
  }

  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });
  const data = await res.json();
  if (data.Response && data.Response.Error) {
    const err = new Error(
      `EdgeOne API [${action}] 失败 (${data.Response.Error.Code}): ${data.Response.Error.Message}`
    );
    err.code = data.Response.Error.Code;
    throw err;
  }
  return data.Response;
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

export async function deployEdgeFunctionToTeo({ code, remoteDomain }) {
  const cleanDomain = (remoteDomain || '').replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomainGuess = parts.length >= 2 ? parts.slice(-2).join('.') : cleanDomain;

  // 1. 自动查找站点 ZoneId
  const zonesResp = await teoRequest('DescribeZones', {});
  const zones = zonesResp.Zones || [];
  if (zones.length === 0) {
    throw new Error('当前腾讯云账号下未找到任何 EdgeOne 站点 (Zone)，请先在控制台添加站点。');
  }

  let matchedZone =
    zones.find((z) => z.ZoneName === rootDomainGuess || cleanDomain.endsWith(z.ZoneName)) ||
    zones[0];
  const zoneId = matchedZone.ZoneId;
  const zoneName = matchedZone.ZoneName;

  // 2. 查询该站点下是否已有 myship-cas-router 边缘函数 (严格按前缀匹配，避免误改项目级 myship-api-* 函数)
  const fnResp = await teoRequest('DescribeFunctions', { ZoneId: zoneId });
  const functions = fnResp.Functions || [];
  let targetFn =
    functions.find(
      (f) => f.Name === 'myship-cas-router' || (f.Name && f.Name.startsWith('myship-cas-router-'))
    ) || null;
  let functionId = null;
  let actionTaken = '';

  if (targetFn) {
    functionId = targetFn.FunctionId;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: 'MyShip Pure Static CAS Router (Managed by @myship/cli)',
    });
    actionTaken = 'updated';
  } else {
    const createResp = await teoRequest('CreateFunction', {
      ZoneId: zoneId,
      Name: 'myship-cas-router',
      Content: code,
      Remark: 'MyShip Pure Static CAS Router (Managed by @myship/cli)',
    });
    functionId = createResp.FunctionId;
    actionTaken = 'created';

    // 尝试自动创建触发规则
    try {
      await teoRequest('CreateFunctionRule', {
        ZoneId: zoneId,
        FunctionId: functionId,
        Remark: `MyShip wildcard route for *.${cleanDomain}`.slice(0, 58),
        FunctionRuleConditions: [
          {
            RuleConditions: [
              {
                Operator: 'notequal',
                Target: 'host',
                Values: [zoneName],
              },
            ],
          },
        ],
      });
    } catch {
      // 若规则已存在或使用规则引擎绑定则忽略
    }
  }

  saveMyShipFileConfig({ zoneId, functionId });
  return { zoneId, zoneName, functionId, actionTaken };
}

/**
 * 方案 A：为包含 `api/*.js` 的项目创建/更新独立的 EdgeOne 边缘函数 (`myship-api-<project>`)
 * 并自动配置高优先级 `/api/*` 触发规则，实现与全局静态路由器 `myship-cas-router` 的 100% 职责分离。
 */
export async function deployProjectApiFunctionToTeo({
  project = 'default',
  code,
  hosts = [],
  routes = [],
  remoteDomain,
  replaceRoutes = false,
}) {
  const cleanDomain = (remoteDomain || '').replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomainGuess = parts.length >= 2 ? parts.slice(-2).join('.') : cleanDomain;

  const cleanProj =
    String(project || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'default';
  // EdgeOne 函数名限制 2~30 字符
  const desiredFnName = `myship-api-${cleanProj}`.slice(0, 28).replace(/-$/, '');

  // 1. 查找站点 ZoneId
  const zonesResp = await teoRequest('DescribeZones', {});
  const zones = zonesResp.Zones || [];
  if (zones.length === 0) {
    throw new Error('当前腾讯云账号下未找到任何 EdgeOne 站点 (Zone)。');
  }
  const matchedZone =
    zones.find((z) => z.ZoneName === rootDomainGuess || cleanDomain.endsWith(z.ZoneName)) ||
    zones[0];
  const zoneId = matchedZone.ZoneId;
  const zoneName = matchedZone.ZoneName;

  // 2. 查询统一 API 边缘函数与现有触发规则 (在修改云端函数或规则前先校验路由配额上限，杜绝静默截断)
  const [fnResp, rulesResp] = await Promise.all([
    teoRequest('DescribeFunctions', { ZoneId: zoneId }),
    teoRequest('DescribeFunctionRules', { ZoneId: zoneId }),
  ]);
  const functions = fnResp.Functions || [];
  const allRules = rulesResp.FunctionRules || [];

  const targetFn =
    functions.find(
      (f) =>
        f.Name === desiredFnName ||
        (f.Name && f.Name.startsWith(`${desiredFnName}-`)) ||
        f.Name === 'myship-api-router' ||
        (f.Name && f.Name.startsWith('myship-api-'))
    ) || null;

  const existingRule = targetFn
    ? allRules.find((r) => r.FunctionId === targetFn.FunctionId)
    : null;

  const existingProjectRoutes = [];
  let hasHostNotEqualZone = false;
  if (existingRule && Array.isArray(existingRule.FunctionRuleConditions)) {
    for (const group of existingRule.FunctionRuleConditions) {
      for (const cond of group.RuleConditions || []) {
        if (
          cond.Target === 'host' &&
          cond.Operator === 'notequal' &&
          Array.isArray(cond.Values) &&
          cond.Values.includes(zoneName)
        ) {
          hasHostNotEqualZone = true;
        }
        if (cond.Target === 'url' && cond.Operator === 'equal' && Array.isArray(cond.Values)) {
          for (const u of cond.Values) {
            if (u && !u.includes('*')) existingProjectRoutes.push(u);
          }
        }
      }
    }
  }

  const fnRemark = `MyShip Dedicated API Worker (Scheme A+C, Multi-Project CAS)`.slice(0, 58);

  // 当 replaceRoutes=true 且活跃 API 路由归零时（如 myship gc 清理了全部 API 版本），撤销 API 触发规则并清空函数池
  if (replaceRoutes && routes.length === 0) {
    if (!targetFn) {
      return {
        zoneId,
        zoneName,
        functionId: null,
        functionName: desiredFnName,
        ruleId: null,
        routes: [],
        actionTaken: 'noop',
      };
    }
    const functionId = targetFn.FunctionId;
    const functionName = targetFn.Name || desiredFnName;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: fnRemark,
    });
    if (existingRule && existingRule.RuleId) {
      await teoRequest('DeleteFunctionRules', {
        ZoneId: zoneId,
        RuleIds: [existingRule.RuleId],
      });
    }
    return {
      zoneId,
      zoneName,
      functionId,
      functionName,
      ruleId: null,
      routes: [],
      actionTaken: 'cleared',
    };
  }

  const MAX_API_RULE_VALUES = 30;
  const routeInputs = replaceRoutes
    ? routes.length > 0
      ? routes
      : ['/api']
    : [...(routes.length > 0 ? routes : ['/api']), ...existingProjectRoutes];
  const normalizedRoutes = Array.from(
    new Set(
      routeInputs.flatMap((r) => {
        const clean = r.startsWith('/') ? r : `/${r}`;
        return clean.length > 1 && !clean.endsWith('/') ? [clean, `${clean}/`] : [clean];
      })
    )
  );

  if (normalizedRoutes.length > MAX_API_RULE_VALUES) {
    throw new Error(
      `API 路由数量超出单条 EdgeOne 触发规则上限: 当前累计需匹配 ${normalizedRoutes.length} 项 URL 条件 (上限 ${MAX_API_RULE_VALUES} 项，约 ${Math.floor(
        MAX_API_RULE_VALUES / 2
      )} 个不同 API 路径)。已终止发布，未修改云端函数与域名。`
    );
  }

  let functionId = null;
  let functionName = desiredFnName;
  let actionTaken = '';

  if (targetFn) {
    functionId = targetFn.FunctionId;
    functionName = targetFn.Name || desiredFnName;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: fnRemark,
    });
    actionTaken = 'updated';
  } else {
    const createResp = await teoRequest('CreateFunction', {
      ZoneId: zoneId,
      Name: desiredFnName,
      Content: code,
      Remark: fnRemark,
    });
    functionId = createResp.FunctionId;
    actionTaken = 'created';
  }

  // 3. 自动创建或按需增量更新 /api/* 边缘函数触发规则
  const existingRouteSet = new Set(existingProjectRoutes);
  const allRoutesAlreadyCovered =
    existingRule &&
    hasHostNotEqualZone &&
    normalizedRoutes.every((r) => existingRouteSet.has(r)) &&
    (!replaceRoutes || existingRouteSet.size === normalizedRoutes.length);

  const ruleConditionsPayload = [
    {
      RuleConditions: [
        {
          Operator: 'notequal',
          Target: 'host',
          Values: [zoneName],
        },
        {
          Operator: 'equal',
          Target: 'url',
          Values: normalizedRoutes,
        },
      ],
    },
  ];
  const ruleRemark = `MyShip API routes for *.${cleanDomain}`.slice(0, 58);

  let ruleId = null;
  if (existingRule) {
    ruleId = existingRule.RuleId;
    if (!allRoutesAlreadyCovered) {
      await teoRequest('ModifyFunctionRule', {
        ZoneId: zoneId,
        RuleId: ruleId,
        FunctionId: functionId,
        TriggerType: 'direct',
        Remark: ruleRemark,
        FunctionRuleConditions: ruleConditionsPayload,
      });
    }
  } else {
    const createRuleResp = await teoRequest('CreateFunctionRule', {
      ZoneId: zoneId,
      FunctionId: functionId,
      TriggerType: 'direct',
      Remark: ruleRemark,
      FunctionRuleConditions: ruleConditionsPayload,
    });
    ruleId = createRuleResp.RuleId;
  }

  // 确保 API 规则排在全局静态 CAS 规则之前 (EdgeOne RuleIds 数组从上到下依次执行，索引 0 优先级最高)
  const latestRules = existingRule && allRoutesAlreadyCovered
    ? allRules
    : (await teoRequest('DescribeFunctionRules', { ZoneId: zoneId })).FunctionRules || [];
  if (latestRules.length >= 2) {
    const casFn = functions.find(
      (f) => f.Name === 'myship-cas-router' || (f.Name && f.Name.startsWith('myship-cas-router-'))
    );
    const casFnId = casFn ? casFn.FunctionId : null;
    const apiRuleIds = latestRules.filter((r) => r.FunctionId !== casFnId).map((r) => r.RuleId);
    const casRuleIds = latestRules.filter((r) => r.FunctionId === casFnId).map((r) => r.RuleId);
    const desiredOrder = [...apiRuleIds, ...casRuleIds];
    const currentOrder = latestRules.map((r) => r.RuleId);
    if (JSON.stringify(desiredOrder) !== JSON.stringify(currentOrder)) {
      await teoRequest('ModifyFunctionRulePriority', {
        ZoneId: zoneId,
        RuleIds: desiredOrder,
      });
    }
  }

  return {
    zoneId,
    zoneName,
    functionId,
    functionName,
    ruleId,
    routes: normalizedRoutes,
    actionTaken,
  };
}
