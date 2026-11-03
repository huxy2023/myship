/**
 * storage-client.mjs — MyShip 统一数据与文件存储引擎 (context.storage / context.files) 与全栈请求分发器
 *
 * 1. 本地开发 (`myship dev` / `--local`)：
 *    - `createLocalPersistentStorage`: 落盘 `<cwd>/.myship/data/<project>/<env?>/<key>.json`
 *    - `createLocalFileStorage`: 落盘 `<cwd>/.myship/files/<project>/<env?>/<key>`
 * 2. 云端腾讯云 SCF Web 函数 (`_myship/bootstrap.mjs`)：
 *    - `createCloudStorage`: 落盘腾讯云 COS `data/<project>/<env?>/<key>.json` 与 `files/<project>/<env?>/<key>`
 * 3. 统一请求分发 (`dispatchFullStackModule`)：
 *    - 同时支持 `export async function fetch(req, ctx)`、Hono `export default app`、`export async function GET/POST`、`onRequestGet/onRequestPost`
 */
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { normalizeDomainToken } from './project-context.mjs';
import { loadTencentCredentials } from './cos-client.mjs';

function sanitizeStorageKey(key) {
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

  return {
    async get(key, defaultValue = null) {
      const safe = sanitizeStorageKey(key);
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
      const safe = sanitizeStorageKey(key);
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
      const safe = sanitizeStorageKey(key);
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
    async presignUrl(key, { method = 'GET', expiresSec, expiresIn } = {}) {
      const safe = sanitizeFileKey(key);
      const baseOrigin = (
        env?.MYSHIP_DEV_ORIGIN || `http://127.0.0.1:${env?.PORT || 4321}`
      ).replace(/\/$/, '');
      const ttlSec = Number(expiresSec ?? expiresIn ?? 900) || 900;
      const exp = Math.floor(Date.now() / 1000) + ttlSec;
      return `${baseOrigin}/_myship_files/${encodeURIComponent(cleanProj)}/${safe}?method=${encodeURIComponent(
        String(method).toUpperCase()
      )}&expires=${exp}`;
    },
  };
}

function sha1Hex(str) {
  return createHash('sha1').update(str).digest('hex');
}

function hmacSha1Hex(key, str) {
  return createHmac('sha1', key).update(str).digest('hex');
}

/**
 * 云端腾讯云 SCF 运行时下的 COS 持久化存储 (`context.storage`) 与文件对象存储 (`context.files`)
 */
export function createCloudStorage(project = 'default', env = process.env) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const cosOrigin = (env?.MYSHIP_COS_ORIGIN || env?.COS_ORIGIN || '').replace(/\/$/, '');
  let secretId = '';
  let secretKey = '';
  let sessionToken = '';
  try {
    const creds = loadTencentCredentials(env);
    secretId = creds.secretId;
    secretKey = creds.secretKey;
    sessionToken = creds.token || '';
  } catch {
    // missing credentials handled below
  }

  const rawStorageEnv = env?.MYSHIP_STORAGE_ENV ? sanitizeStorageKey(env.MYSHIP_STORAGE_ENV) : '';
  const envSub = rawStorageEnv && rawStorageEnv !== 'prod' ? `${rawStorageEnv}/` : '';
  const prefixBase = `data/${cleanProj}/${envSub}`;
  const filesPrefixBase = `files/${cleanProj}/${envSub}`;

  if (!cosOrigin || !secretId || !secretKey) {
    const missingErr = () => {
      throw new Error(
        'Cloud persistent storage (context.storage / context.files) is unavailable: missing COS credentials in SCF environment (MYSHIP_COS_ORIGIN / MYSHIP_DATA_SECRET_ID / MYSHIP_DATA_SECRET_KEY).'
      );
    };
    const stub = {
      async get() {
        return missingErr();
      },
      async set() {
        return missingErr();
      },
      async put() {
        return missingErr();
      },
      async delete() {
        return missingErr();
      },
      async list() {
        return missingErr();
      },
      async presignUrl() {
        return missingErr();
      },
    };
    return { storage: stub, files: stub };
  }

  function signCos(method, objectKey, expiresSec = 3600) {
    const url = new URL(objectKey.startsWith('/') ? objectKey : `/${objectKey}`, cosOrigin);
    const now = Math.floor(Date.now() / 1000);
    const keyTime = `${now - 60};${now + Number(expiresSec || 3600)}`;
    const signKey = hmacSha1Hex(secretKey, keyTime);
    const paramEntries = [];
    for (const [k, v] of url.searchParams.entries()) {
      paramEntries.push([encodeURIComponent(k).toLowerCase(), encodeURIComponent(v)]);
    }
    paramEntries.sort((a, b) => a[0].localeCompare(b[0]));
    const urlParamList = paramEntries.map(([k]) => k).join(';');
    const httpParameters = paramEntries.map(([k, v]) => `${k}=${v}`).join('&');
    const httpString = `${method.toLowerCase()}\n${url.pathname}\n${httpParameters}\nhost=${encodeURIComponent(url.host).toLowerCase()}\n`;
    const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
    const signature = hmacSha1Hex(signKey, stringToSign);
    const authParts = [
      'q-sign-algorithm=sha1',
      `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`,
      `q-ak=${secretId}`,
      'q-header-list=host',
      `q-url-param-list=${urlParamList}`,
      `q-signature=${signature}`,
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
      const objKey = `${prefixBase}${safe}.json`;
      const { url, headers } = signCos('GET', objKey);
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 404) return defaultValue;
      if (!res.ok) throw new Error(`COS storage.get failed (${res.status})`);
      const data = await res.json();
      return data && Object.prototype.hasOwnProperty.call(data, 'value') ? data.value : data;
    },
    async set(key, value) {
      const safe = sanitizeStorageKey(key);
      const objKey = `${prefixBase}${safe}.json`;
      const { url, headers } = signCos('PUT', objKey);
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      headers['x-cos-acl'] = 'private';
      const payload = JSON.stringify({
        key: safe,
        project: cleanProj,
        value,
        updatedAt: new Date().toISOString(),
      });
      const res = await fetch(url, { method: 'PUT', headers, body: payload });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`COS storage.set failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      return value;
    },
    async delete(key) {
      const safe = sanitizeStorageKey(key);
      const objKey = `${prefixBase}${safe}.json`;
      const { url, headers } = signCos('DELETE', objKey);
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error(`COS storage.delete failed (${res.status})`);
      }
      return true;
    },
    async list(prefix = '') {
      const fullPrefix = `${prefixBase}${prefix ? String(prefix).replace(/^\/+/, '') : ''}`;
      const { url, headers } = signCos('GET', `/?prefix=${encodeURIComponent(fullPrefix)}&max-keys=1000`);
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) throw new Error(`COS storage.list failed (${res.status})`);
      const xml = await res.text();
      const regex = /<Key>([^<]+)<\/Key>/g;
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
      const objKey = `${filesPrefixBase}${safe}`;
      const { url, headers } = signCos('PUT', objKey);
      const contentType = options.contentType || 'application/octet-stream';
      headers['Content-Type'] = contentType;
      headers['x-cos-acl'] = options.acl || 'private';
      const buf = toBuffer(body);
      const res = await fetch(url, { method: 'PUT', headers, body: buf });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`COS files.put failed (${res.status}): ${txt.slice(0, 200)}`);
      }
      return { key: safe, size: buf.length, contentType };
    },
    async get(key, options = {}) {
      const safe = sanitizeFileKey(key);
      const objKey = `${filesPrefixBase}${safe}`;
      const { url, headers } = signCos('GET', objKey);
      const res = await fetch(url, { method: 'GET', headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`COS files.get failed (${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (options.type === 'text') return buf.toString('utf8');
      if (options.type === 'json') return JSON.parse(buf.toString('utf8'));
      buf.contentType = res.headers.get('content-type') || 'application/octet-stream';
      buf.size = buf.length;
      return buf;
    },
    async delete(key) {
      const safe = sanitizeFileKey(key);
      const objKey = `${filesPrefixBase}${safe}`;
      const { url, headers } = signCos('DELETE', objKey);
      const res = await fetch(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404 && res.status !== 204) {
        throw new Error(`COS files.delete failed (${res.status})`);
      }
      return true;
    },
    async list(prefix = '') {
      const fullPrefix = `${filesPrefixBase}${prefix ? String(prefix).replace(/^\/+/, '') : ''}`;
      const { url, headers } = signCos('GET', `/?prefix=${encodeURIComponent(fullPrefix)}&max-keys=1000`);
      const res = await fetch(url, { method: 'GET', headers });
      if (!res.ok) throw new Error(`COS files.list failed (${res.status})`);
      const xml = await res.text();
      const regex = /<Key>([^<]+)<\/Key>/g;
      const out = [];
      let m;
      while ((m = regex.exec(xml)) !== null) {
        if (m[1].startsWith(filesPrefixBase)) {
          out.push(m[1].slice(filesPrefixBase.length));
        }
      }
      return out.sort();
    },
    async presignUrl(key, { method = 'GET', expiresSec, expiresIn } = {}) {
      const safe = sanitizeFileKey(key);
      const objKey = `${filesPrefixBase}${safe}`;
      const ttlSec = Number(expiresSec ?? expiresIn ?? 900) || 900;
      const { url, authQuery } = signCos(method, objKey, ttlSec);
      const tokenPart = sessionToken ? `&x-cos-security-token=${encodeURIComponent(sessionToken)}` : '';
      return `${url}${url.includes('?') ? '&' : '?'}${authQuery}${tokenPart}`;
    },
  };

  return { storage: storageObj, files: filesObj };
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
  } else if (
    mod &&
    typeof mod.default === 'object' &&
    mod.default &&
    typeof mod.default.fetch === 'function'
  ) {
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

  if (
    result instanceof Response ||
    (result && typeof result.arrayBuffer === 'function' && result.headers)
  ) {
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
