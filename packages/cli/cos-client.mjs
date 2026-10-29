/**
 * cos-client.mjs — 零外部依赖的腾讯云 COS REST API 签名与上传客户端 (BYOC 开源版)
 *
 * 凭证与云底座配置读取优先级（3 级自动兜底）：
 * 1. 环境变量 (适合 CI/CD):
 *    - 密钥: MYSHIP_SECRET_ID / MYSHIP_SECRET_KEY 或 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY
 *    - 端点: COS_ORIGIN / SHIP_REMOTE_DOMAIN
 * 2. MyShip 独立配置文件 (由 `myship login` 生成): ~/.myship/config.json
 * 3. 本机 tccli 凭证自动复用: ~/.tccli/default.credential
 */
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const MYSHIP_CONFIG_PATH = resolve(homedir(), '.myship', 'config.json');
export const TCCLI_CRED_PATH = resolve(homedir(), '.tccli', 'default.credential');

export function loadMyShipFileConfig() {
  if (!existsSync(MYSHIP_CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MYSHIP_CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveMyShipFileConfig(config) {
  const dir = dirname(MYSHIP_CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  const existing = loadMyShipFileConfig() || {};
  const merged = {
    ...existing,
    ...config,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(MYSHIP_CONFIG_PATH, JSON.stringify(merged, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return merged;
}

export function getEffectiveEndpoints() {
  const fileCfg = loadMyShipFileConfig();
  const cosOrigin = (
    process.env.COS_ORIGIN ||
    fileCfg?.cosOrigin ||
    ''
  ).replace(/\/$/, '');
  const remoteDomain = (
    process.env.SHIP_REMOTE_DOMAIN ||
    fileCfg?.remoteDomain ||
    ''
  ).replace(/^\*\./, '');

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

export function loadTencentCredentials() {
  // 1. 环境变量优先
  const envId = process.env.MYSHIP_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID;
  const envKey = process.env.MYSHIP_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY;
  if (envId && envKey) {
    return {
      secretId: envId,
      secretKey: envKey,
      source: 'env (环境变量)',
    };
  }

  // 2. ~/.myship/config.json 独立配置文件
  const fileCfg = loadMyShipFileConfig();
  if (fileCfg?.secretId && fileCfg?.secretKey) {
    return {
      secretId: fileCfg.secretId,
      secretKey: fileCfg.secretKey,
      source: `~/.myship/config.json`,
    };
  }

  // 3. ~/.tccli/default.credential 自动兜底
  if (existsSync(TCCLI_CRED_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(TCCLI_CRED_PATH, 'utf8'));
      if (raw.secretId && raw.secretKey) {
        return {
          secretId: raw.secretId,
          secretKey: raw.secretKey,
          source: `~/.tccli/default.credential (tccli 自动复用)`,
        };
      }
    } catch {
      // ignore parse errors
    }
  }

  throw new Error(
    '未找到腾讯云凭证！请先执行 `myship login` 进行交互式配置（免安装 tccli），或设置环境变量 MYSHIP_SECRET_ID / MYSHIP_SECRET_KEY。'
  );
}

export function getAuthStatus() {
  const endpoints = getEffectiveEndpoints();
  try {
    const cred = loadTencentCredentials();
    const maskedId =
      cred.secretId.length > 8
        ? `${cred.secretId.slice(0, 4)}****${cred.secretId.slice(-4)}`
        : '****';
    return {
      authenticated: true,
      maskedSecretId: maskedId,
      source: cred.source,
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

function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

function hmacSha1Hex(key, data) {
  return createHmac('sha1', key).update(data).digest('hex');
}

export function signCosRequest({ method, pathname, headers = {}, secretId, secretKey }) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now - 60};${now + 3600}`;
  const signKey = hmacSha1Hex(secretKey, keyTime);

  const headerKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const headerList = headerKeys.join(';');
  const httpHeaders = headerKeys
    .map((k) => {
      const origKey = Object.keys(headers).find((ok) => ok.toLowerCase() === k);
      return `${encodeURIComponent(k)}=${encodeURIComponent(String(headers[origKey]).trim())}`;
    })
    .join('&');

  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1Hex(signKey, stringToSign);

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

export async function cosHeadObject(key, customOrigin) {
  const origin = customOrigin || assertCloudEndpointsConfigured().cosOrigin;
  const { secretId, secretKey } = loadTencentCredentials();
  const url = new URL(`${origin}/${key.replace(/^\//, '')}`);
  const headers = { Host: url.host };
  headers.Authorization = signCosRequest({
    method: 'HEAD',
    pathname: url.pathname,
    headers,
    secretId,
    secretKey,
  });

  const res = await fetch(url, { method: 'HEAD', headers });
  return res.status === 200;
}

export async function cosPutObject(key, body, contentType = 'application/octet-stream', customOrigin) {
  const origin = customOrigin || assertCloudEndpointsConfigured().cosOrigin;
  const { secretId, secretKey } = loadTencentCredentials();
  const url = new URL(`${origin}/${key.replace(/^\//, '')}`);
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);

  const headers = {
    Host: url.host,
    'Content-Type': contentType,
    'Content-Length': String(buf.length),
    'x-cos-acl': 'public-read',
  };
  headers.Authorization = signCosRequest({
    method: 'PUT',
    pathname: url.pathname,
    headers,
    secretId,
    secretKey,
  });

  const res = await fetch(url, { method: 'PUT', headers, body: buf });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`COS PUT ${key} 失败 (${res.status}): ${errText}`);
  }
  return true;
}

export async function cosGetJson(key, customOrigin) {
  const origin = customOrigin || assertCloudEndpointsConfigured().cosOrigin;
  const url = new URL(`${origin}/${key.replace(/^\//, '')}?t=${Date.now()}`);
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`COS GET ${key} 失败 (${res.status})`);
  return res.json();
}

export async function cosListKeys(prefix = '', customOrigin) {
  const origin = customOrigin || assertCloudEndpointsConfigured().cosOrigin;
  const { secretId, secretKey } = loadTencentCredentials();
  const url = new URL(`${origin}/?prefix=${encodeURIComponent(prefix)}&max-keys=1000`);
  const headers = { Host: url.host };
  headers.Authorization = signCosRequest({
    method: 'GET',
    pathname: '/',
    headers,
    secretId,
    secretKey,
  });

  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) return [];
  const xml = await res.text();
  const matches = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)];
  return matches.map((m) => m[1]);
}
