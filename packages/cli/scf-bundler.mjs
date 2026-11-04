/**
 * scf-bundler.mjs — MyShip 全栈业务后端 (腾讯云 SCF Web 函数) 构建与打包引擎
 *
 * 设计契约（克制、强约定）：
 * 1. 统一支持现代 ESM + Web Standard Fetch 契约 (`export async function fetch(request, context)` 或 Hono `export default app`)。
 * 2. 使用 `esbuild` 标准打包 (`bundle: true, format: 'esm', platform: 'node', sourcemap: 'inline'`)
 *    配合 `node --enable-source-maps` 与 `process.setSourceMapsEnabled(true)`，精确还原真实源码文件名与行号堆栈。
 * 3. 递归保留后端目录下的非代码静态模板/数据文件 (`server/**` `.txt`, `.json`, `.sql` 等)，使本地 `myship dev` 与云端 SCF 产物完全一致。
 * 4. 云端引导层 (`_myship/bootstrap.mjs`) 直接通过 `esbuild` 打包真实模块 `./scf-bootstrap-runtime.mjs`、`./db-client.mjs` 与 `./storage-client.mjs`，
 *    消灭本地与云端运行时之间的双份代码复制。
 */
import { existsSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { walkFiles } from './project-context.mjs';
import { normalizeApiRoute, resolveApiDir, extractDeclaredUpstreamUrl } from './serverless.mjs';

export {
  createLocalPersistentStorage,
  createLocalFileStorage,
  createCloudStorage,
  dispatchFullStackModule,
} from './storage-client.mjs';
export { createDatabaseClient, closeDatabasePools } from './db-client.mjs';

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

function scanApiDirectoryEntries(apiDir) {
  if (!apiDir || !existsSync(apiDir) || !statSync(apiDir).isDirectory()) {
    return [];
  }
  const upstreamsMap = {};
  const upstreamsJsonPath = resolve(apiDir, 'upstreams.json');
  if (existsSync(upstreamsJsonPath) && statSync(upstreamsJsonPath).isFile()) {
    try {
      const rawUpstreams = JSON.parse(readFileSync(upstreamsJsonPath, 'utf8'));
      if (rawUpstreams && typeof rawUpstreams === 'object') {
        for (const [k, v] of Object.entries(rawUpstreams)) {
          const normRoute = normalizeApiRoute(k);
          const urlVal = typeof v === 'string' ? v : v && v.upstreamUrl ? v.upstreamUrl : null;
          if (urlVal && /^https?:\/\//i.test(urlVal)) {
            upstreamsMap[normRoute] = urlVal.trim();
          }
        }
      }
    } catch {
      // ignore invalid upstreams.json
    }
  }

  const rawFiles = walkFiles(apiDir, apiDir, { excludeApiJs: false }).filter(
    (f) =>
      f.relPath.endsWith('.js') || f.relPath.endsWith('.mjs') || f.relPath.endsWith('.ts')
  );
  const byRoute = new Map();
  for (const f of rawFiles) {
    const route = normalizeApiRoute(f.relPath);
    let sourceCode = '';
    try {
      sourceCode = readFileSync(f.fullPath, 'utf8');
    } catch {
      sourceCode = '';
    }
    const upstreamUrl = extractDeclaredUpstreamUrl(sourceCode) || upstreamsMap[route] || null;
    byRoute.set(route, {
      ...f,
      route,
      upstreamUrl,
    });
  }

  for (const [route, upstreamUrl] of Object.entries(upstreamsMap)) {
    if (!byRoute.has(route)) {
      byRoute.set(route, {
        fullPath: null,
        relPath: '/upstreams.json',
        size: 0,
        route,
        upstreamUrl,
      });
    }
  }

  return [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
}

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
        const scannedFiles = scanApiDirectoryEntries(absExplicit);
        if (scannedFiles.length > 0) {
          return {
            mode: 'api-dir',
            apiDir: absExplicit,
            relEntry: relative(cwd, absExplicit).split('\\').join('/') || 'api',
            files: scannedFiles,
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
    const scannedFiles = scanApiDirectoryEntries(apiDir);
    if (scannedFiles.length > 0) {
      return {
        mode: 'api-dir',
        apiDir,
        relEntry: relative(cwd, apiDir).split('\\').join('/') || 'api',
        files: scannedFiles,
      };
    }
  }

  return null;
}

function generateBootstrapRuntimeSource(userAppImportPath = '../server/index.mjs') {
  return [
    "import { startScfRuntimeServer } from './scf-bootstrap-runtime.mjs';",
    "if (typeof process.setSourceMapsEnabled === 'function') {",
    '  process.setSourceMapsEnabled(true);',
    '}',
    `const userApp = await import(${JSON.stringify(userAppImportPath)});`,
    'startScfRuntimeServer(userApp);',
    '',
  ].join('\n');
}

function generateApiDirVirtualEntry(apiFiles) {
  const imports = [];
  const routes = [];
  apiFiles.forEach((f, idx) => {
    if (f.fullPath) {
      const varName = `routeMod_${idx}`;
      const cleanPath = f.fullPath.split('\\').join('/');
      imports.push(`import * as ${varName} from ${JSON.stringify(cleanPath)};`);
      routes.push(
        `  ${JSON.stringify(f.route)}: { mod: ${varName}, upstreamUrl: ${JSON.stringify(
          f.upstreamUrl || null
        )} },`
      );
    } else {
      routes.push(
        `  ${JSON.stringify(f.route)}: { mod: {}, upstreamUrl: ${JSON.stringify(
          f.upstreamUrl || null
        )} },`
      );
    }
  });

  return `${imports.join('\n')}

const ROUTE_TABLE = {
${routes.join('\n')}
};

async function proxyToUpstreamUrl(upstreamUrl, request, context, matchedRoute) {
  const method = (request.method || 'GET').toUpperCase();
  const baseProxyHeaders = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Requested-With',
    'cache-control': 'no-store, no-cache, must-revalidate',
    'x-myship-proxy-mode': 'SCF-Upstream-Proxy',
    'x-myship-project': (context && context.project) || 'default',
    'x-myship-function-route': matchedRoute,
  };
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseProxyHeaders });
  }
  const reqUrl = new URL(request.url);
  const targetUrl = new URL(upstreamUrl);
  if (targetUrl.pathname === '/') targetUrl.pathname = reqUrl.pathname;
  if (reqUrl.search) targetUrl.search = reqUrl.search;
  const forwardHeaders = {};
  request.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (lower !== 'host' && lower !== 'x-myship-gateway-token') {
      forwardHeaders[k] = v;
    }
  });
  forwardHeaders['x-myship-project'] = (context && context.project) || 'default';
  forwardHeaders['x-myship-subdomain'] = (context && context.subdomain) || '';
  forwardHeaders['x-myship-deployment-id'] = (context && context.deploymentId) || '';
  forwardHeaders['x-myship-function-route'] = matchedRoute;

  const upstreamRes = await globalThis.fetch(targetUrl.toString(), {
    method,
    headers: forwardHeaders,
    body: method !== 'GET' && method !== 'HEAD' ? request.body : undefined,
    duplex: method !== 'GET' && method !== 'HEAD' ? 'half' : undefined,
  });
  const mergedHeaders = { ...baseProxyHeaders };
  upstreamRes.headers.forEach((v, k) => {
    const lower = k.toLowerCase();
    if (
      lower !== 'content-encoding' &&
      lower !== 'content-length' &&
      lower !== 'transfer-encoding' &&
      lower !== 'connection'
    ) {
      mergedHeaders[k] = v;
    }
  });
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: mergedHeaders,
  });
}

export async function fetch(request, context) {
  const url = new URL(request.url);
  const rawPathname = decodeURIComponent(url.pathname);
  const normalizedRoute =
    rawPathname.length > 1 && rawPathname.endsWith('/')
      ? rawPathname.slice(0, -1)
      : rawPathname;

  let matchedRoute = normalizedRoute;
  let targetEntry = ROUTE_TABLE[normalizedRoute];
  if (!targetEntry) {
    for (const [r, entry] of Object.entries(ROUTE_TABLE)) {
      if (r !== '/api' && normalizedRoute.startsWith(r + '/')) {
        matchedRoute = r;
        targetEntry = entry;
        break;
      }
    }
    if (!targetEntry && ROUTE_TABLE['/api']) {
      matchedRoute = '/api';
      targetEntry = ROUTE_TABLE['/api'];
    }
  }

  if (!targetEntry) {
    return new Response(
      JSON.stringify({
        error: 'API Route Not Found: ' + normalizedRoute,
        availableRoutes: Object.keys(ROUTE_TABLE),
      }),
      { status: 404, headers: { 'content-type': 'application/json; charset=UTF-8' } }
    );
  }

  const targetMod = targetEntry.mod || targetEntry;
  const declaredUpstream =
    targetEntry.upstreamUrl ||
    targetMod.upstreamUrl ||
    targetMod.scfUrl ||
    targetMod.proxyUrl ||
    null;

  if (declaredUpstream) {
    return await proxyToUpstreamUrl(declaredUpstream, request, context, matchedRoute);
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
  cwd: rawCwd = process.cwd(),
  targetDir = null,
  explicitEntry = null,
} = {}) {
  const cwd = existsSync(rawCwd) ? realpathSync(rawCwd) : resolve(rawCwd);
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
      const finalEntryRel = mapTsRelPath(resolved.relEntry);
      buildResult = await esbuild.build({
        entryPoints: [resolved.entryPath],
        absWorkingDir: cwd,
        outfile: resolve(cwd, finalEntryRel),
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
        outfile: resolve(cwd, '_myship/api-router.mjs'),
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
    external: [bootstrapUserEntryImport, 'pg-native', 'node:sqlite'],
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
