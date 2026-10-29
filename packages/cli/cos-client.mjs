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
export const TCCLI_CRED_PATH = resolve(homedir(), '.tccli', 'default.credential');

export function loadMyShipFileConfig() {
  if (!existsSync(MYSHIP_CONFIG_PATH)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(MYSHIP_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMyShipFileConfig(newConfig) {
  const current = loadMyShipFileConfig();
  const merged = {
    ...current,
    ...newConfig,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(MYSHIP_CONFIG_PATH), { recursive: true });
  writeFileSync(MYSHIP_CONFIG_PATH, JSON.stringify(merged, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    chmodSync(MYSHIP_CONFIG_PATH, 0o600);
  } catch {
    // Windows 忽略 chmod
  }
  return merged;
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

  const httpString = `${method.toLowerCase()}\n${url.pathname}\n\nhost=${encodeURIComponent(host).toLowerCase()}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1Hex(signKey, stringToSign);

  const authorization = [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    'q-url-param-list=',
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
  return res.status === 200;
}

export async function cosPutObject(
  objectKey,
  body,
  contentType = 'application/octet-stream',
  customOrigin
) {
  const { url, headers } = signCosRequest('PUT', objectKey, customOrigin);
  headers['Content-Type'] = contentType;
  headers['x-cos-acl'] = 'public-read';

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

export async function cosGetJson(objectKey, customOrigin) {
  const { url, headers } = signCosRequest('GET', objectKey, customOrigin);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

export async function cosListKeys(prefix = '', customOrigin) {
  const { url, headers } = signCosRequest('GET', '/', customOrigin);
  const res = await fetch(url, { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`COS ListBucket 失败 (${res.status})`);
  }
  const xml = await res.text();
  const keys = [];
  const regex = /<Key>([^<]+)<\/Key>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    if (!prefix || match[1].startsWith(prefix)) {
      keys.push(match[1]);
    }
  }
  return keys;
}
