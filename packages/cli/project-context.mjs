import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cosGetJson,
  cosListKeys,
  getEffectiveEndpoints,
  assertCloudEndpointsConfigured,
} from './cos-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORAGE_DIR = resolve(__dirname, '.cas-storage');
export const BASE_DOMAIN = process.env.SHIP_BASE_DOMAIN || 'ship.localhost:4100';

export const MIME_MAP = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.md': 'text/plain; charset=UTF-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml; charset=UTF-8',
};

export const BLOCKED_DIRS = new Set([
  '.git',
  '.github',
  '.myship',
  '.vercel',
  '.edgeone',
  '.ssh',
  '.tccli',
  'node_modules',
  '.cas-storage',
]);

export function isSensitiveEntry(entryName) {
  const lower = entryName.toLowerCase();
  if (lower === '.ds_store' || lower === '.npmrc' || lower === '.netrc') return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (
    lower.endsWith('.pem') ||
    lower.endsWith('.key') ||
    lower.endsWith('.credential') ||
    lower.endsWith('.p12') ||
    lower.endsWith('.pfx')
  ) {
    return true;
  }
  if (lower === 'id_rsa' || lower === 'id_ed25519') return true;
  return false;
}

export function ensureMyShipGitignore(myshipDir) {
  mkdirSync(myshipDir, { recursive: true });
  const gitignorePath = resolve(myshipDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      '# Automatically created by MyShip CLI to prevent accidental leaks\n*\n!project.json\n!.gitignore\n',
      'utf8'
    );
  }
}

export function ensureStorageDirs(storageDir) {
  mkdirSync(resolve(storageDir, 'blobs'), { recursive: true });
  mkdirSync(resolve(storageDir, 'manifests'), { recursive: true });
  mkdirSync(resolve(storageDir, 'aliases'), { recursive: true });
  mkdirSync(resolve(storageDir, 'envs'), { recursive: true });
}

export function hasBackendEnabledAtRoot(rootDir) {
  if (!rootDir) return false;
  if (existsSync(resolve(rootDir, 'server')) || existsSync(resolve(rootDir, 'backend'))) {
    return true;
  }
  const projJsonPath = resolve(rootDir, '.myship', 'project.json');
  if (existsSync(projJsonPath)) {
    try {
      const cfg = JSON.parse(readFileSync(projJsonPath, 'utf8'));
      return Boolean(cfg && cfg.backend && cfg.backend.enabled);
    } catch {
      return false;
    }
  }
  return false;
}

export function walkFiles(dir, baseDir = dir, { excludeApiJs = true } = {}) {
  const results = [];
  const hasBackendRoot = excludeApiJs && hasBackendEnabledAtRoot(baseDir);
  const isProjectRoot =
    excludeApiJs &&
    (hasBackendRoot ||
      existsSync(resolve(baseDir, 'api')) ||
      existsSync(resolve(baseDir, 'package.json')) ||
      existsSync(resolve(baseDir, '.myship', 'project.json')));

  for (const entry of readdirSync(dir)) {
    if (BLOCKED_DIRS.has(entry)) {
      continue;
    }
    if (isSensitiveEntry(entry)) {
      if (entry !== '.DS_Store') {
        console.warn(`  🛡️  [安全防泄漏] 已自动拦截并跳过敏感文件: ${entry}`);
      }
      continue;
    }
    const full = resolve(dir, entry);
    const stat = statSync(full);
    const relPath = '/' + relative(baseDir, full).split('\\').join('/');

    if (stat.isDirectory()) {
      if (
        excludeApiJs &&
        (relPath === '/server' ||
          relPath === '/backend' ||
          (hasBackendRoot && relPath === '/lib'))
      ) {
        continue;
      }
      results.push(...walkFiles(full, baseDir, { excludeApiJs }));
    } else if (stat.isFile()) {
      if (excludeApiJs) {
        if (
          (relPath.startsWith('/api/') ||
            relPath === '/api' ||
            relPath.startsWith('/server/') ||
            relPath.startsWith('/backend/')) &&
          (relPath.endsWith('.js') || relPath.endsWith('.mjs') || relPath.endsWith('.cjs') || relPath.endsWith('.ts'))
        ) {
          continue;
        }
        if (
          isProjectRoot &&
          (relPath === '/package.json' ||
            relPath === '/package-lock.json' ||
            relPath === '/pnpm-lock.yaml' ||
            relPath === '/yarn.lock' ||
            relPath === '/tsconfig.json')
        ) {
          continue;
        }
      }
      results.push({ fullPath: full, relPath, size: stat.size });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function normalizeDomainToken(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function normalizeSubdomain(input) {
  if (!input) return '';
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const { remoteDomain } = getEffectiveEndpoints();
  if (remoteDomain && s.endsWith(`.${remoteDomain}`)) {
    s = s.slice(0, -(remoteDomain.length + 1));
  }
  if (s.endsWith(`.${BASE_DOMAIN}`)) {
    s = s.slice(0, -(BASE_DOMAIN.length + 1));
  }
  return s.split('.')[0];
}

export function inferCosRegion(cosOrigin = '') {
  const effective = cosOrigin || getEffectiveEndpoints().cosOrigin || '';
  const match = String(effective).match(/\.cos\.([a-z0-9-]+)\.myqcloud\.com/i);
  return match ? match[1].toLowerCase() : 'ap-guangzhou';
}

export function loadLocalProjectSecrets(cwd = process.cwd()) {
  try {
    const secretsPath = resolve(cwd, '.myship', 'secrets.json');
    if (existsSync(secretsPath)) {
      const parsed = JSON.parse(readFileSync(secretsPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch {
    // ignore
  }
  return {};
}

export function saveLocalProjectSecrets(cwd = process.cwd(), partial = {}) {
  try {
    const myshipDir = resolve(cwd, '.myship');
    ensureMyShipGitignore(myshipDir);
    const secretsPath = resolve(myshipDir, 'secrets.json');
    const existing = loadLocalProjectSecrets(cwd);
    const merged = { ...existing, ...partial, updatedAt: new Date().toISOString() };
    writeFileSync(secretsPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    return merged;
  } catch {
    return partial;
  }
}

export function detectProjectContext(cwd = process.cwd(), explicitProject = null) {
  const myshipDir = resolve(cwd, '.myship');
  const projectJsonPath = resolve(myshipDir, 'project.json');
  const legacyMyshipJson = resolve(cwd, '.myship.json');
  const pkgJsonPath = resolve(cwd, 'package.json');
  const localSecrets = loadLocalProjectSecrets(cwd);

  let savedCfg = null;
  let configSource = null;

  if (existsSync(projectJsonPath)) {
    try {
      savedCfg = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
      configSource = '.myship/project.json';
    } catch {
      // ignore
    }
  } else if (existsSync(legacyMyshipJson)) {
    try {
      savedCfg = JSON.parse(readFileSync(legacyMyshipJson, 'utf8'));
      configSource = '.myship.json';
    } catch {
      // ignore
    }
  }

  let inferredName = explicitProject || savedCfg?.project || savedCfg?.domain || '';
  let hasBuildScript = false;
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (!inferredName && pkg.name) inferredName = pkg.name;
      hasBuildScript = Boolean(pkg?.scripts?.build);
    } catch {
      // ignore
    }
  }
  if (!inferredName) {
    inferredName = basename(cwd);
  }
  const project = normalizeDomainToken(inferredName) || 'app';

  let buildDir = savedCfg?.dir || null;
  if (!buildDir) {
    const candidates = hasBuildScript
      ? ['./dist', './build', './out']
      : ['./dist', './build', './out', './public'];
    for (const c of candidates) {
      const abs = resolve(cwd, c);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        buildDir = c;
        break;
      }
    }
  }

  const prodDomain = normalizeDomainToken(savedCfg?.prodDomain || project) || project;
  const backend =
    savedCfg?.backend && typeof savedCfg.backend === 'object'
      ? {
          enabled: Boolean(savedCfg.backend.enabled),
          provider: savedCfg.backend.provider || 'scf',
          region: savedCfg.backend.region || inferCosRegion(),
          entry: savedCfg.backend.entry || null,
          prefix: savedCfg.backend.prefix || '/api',
          functionName: savedCfg.backend.functionName || `myship-${project}`.slice(0, 56),
          gatewayToken: savedCfg.backend.gatewayToken || localSecrets.gatewayToken || null,
          role: savedCfg.backend.role || null,
        }
      : null;

  const resources =
    savedCfg?.resources && typeof savedCfg.resources === 'object'
      ? {
          ...(savedCfg.resources.storage && typeof savedCfg.resources.storage === 'object'
            ? { storage: { ...savedCfg.resources.storage } }
            : {}),
          ...(savedCfg.resources.db && typeof savedCfg.resources.db === 'object'
            ? { db: { ...savedCfg.resources.db } }
            : {}),
        }
      : null;

  return {
    project,
    buildDir: buildDir || './dist',
    prodDomain,
    backend,
    resources,
    hasSavedConfig: Boolean(savedCfg),
    configSource: configSource || '自动推断 (package.json / 目录名)',
    projectJsonPath,
    myshipDir,
  };
}

export function ensureProjectConfig(cwd = process.cwd(), overrides = {}) {
  const ctx = detectProjectContext(cwd);
  ensureMyShipGitignore(ctx.myshipDir);
  let diskBackendGatewayToken = null;
  if (existsSync(ctx.projectJsonPath)) {
    try {
      const diskCfg = JSON.parse(readFileSync(ctx.projectJsonPath, 'utf8'));
      if (diskCfg?.backend?.gatewayToken) {
        diskBackendGatewayToken = diskCfg.backend.gatewayToken;
      }
    } catch {
      // ignore
    }
  }

  const nextProject = overrides.project ? normalizeDomainToken(overrides.project) : ctx.project;
  const projectChanged = Boolean(overrides.project && nextProject !== ctx.project);
  const rawNextBackend =
    overrides.backend !== undefined
      ? overrides.backend
      : ctx.backend
      ? { ...ctx.backend }
      : undefined;

  let nextBackendForDisk = rawNextBackend ? { ...rawNextBackend } : undefined;
  if (nextBackendForDisk && nextBackendForDisk.gatewayToken) {
    saveLocalProjectSecrets(cwd, { gatewayToken: nextBackendForDisk.gatewayToken });
    if (diskBackendGatewayToken) {
      nextBackendForDisk.gatewayToken = diskBackendGatewayToken;
    } else {
      delete nextBackendForDisk.gatewayToken;
    }
  } else if (nextBackendForDisk && nextBackendForDisk.gatewayToken === null) {
    delete nextBackendForDisk.gatewayToken;
  }

  const nextResources =
    overrides.resources !== undefined
      ? overrides.resources
      : ctx.resources && Object.keys(ctx.resources).length > 0
      ? { ...ctx.resources }
      : undefined;
  const payload = {
    project: nextProject,
    dir: overrides.dir || ctx.buildDir || './dist',
    prodDomain: overrides.prodDomain
      ? normalizeDomainToken(overrides.prodDomain)
      : projectChanged || !ctx.hasSavedConfig
      ? nextProject
      : ctx.prodDomain,
    ...(nextBackendForDisk ? { backend: nextBackendForDisk } : {}),
    ...(nextResources && Object.keys(nextResources).length > 0 ? { resources: nextResources } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(ctx.projectJsonPath, JSON.stringify(payload, null, 2), 'utf8');
  return {
    ...ctx,
    ...payload,
    ...(rawNextBackend ? { backend: rawNextBackend } : {}),
    hasSavedConfig: true,
    configSource: '.myship/project.json',
  };
}

export function appendLocalProjectHistory(cwd, entry) {
  try {
    const myshipDir = resolve(cwd, '.myship');
    ensureMyShipGitignore(myshipDir);
    const historyPath = resolve(myshipDir, 'history.json');
    let list = [];
    if (existsSync(historyPath)) {
      list = JSON.parse(readFileSync(historyPath, 'utf8'));
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(entry);
    writeFileSync(historyPath, JSON.stringify(list.slice(0, 50), null, 2), 'utf8');
  } catch {
    // ignore non-critical local history write error
  }
}

export function resolveNamespacedSubdomain(rawSub, project, isRaw = false) {
  const cleanSub = normalizeSubdomain(rawSub);
  if (!cleanSub) return project || 'prod';
  if (isRaw || !project || project === 'default') return cleanSub;
  if (cleanSub === 'prod' || cleanSub === project) return project;
  if (cleanSub.startsWith(`${project}-`)) return cleanSub;
  return `${project}-${cleanSub}`;
}

export function inferProjectFromRecord(item, fallback = 'default') {
  if (item?.project) return item.project;
  const sub = item?.subdomain || item?.immutableSubdomain || '';
  if (sub && !sub.startsWith('dpl-') && sub.includes('-')) {
    return sub.split('-')[0];
  }
  return fallback;
}

/**
 * 统一加载本地沙盒或云端 COS 的 CAS 状态快照（带完整性校验，杜绝半截数据导致的误删或脏视图）
 */
export async function loadCasStateSnapshot({
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  includeFunctionsKeys = false,
  actionLabel = '操作',
} = {}) {
  if (isLocal) {
    ensureStorageDirs(storageDir);
    const blobKeys = readdirSync(resolve(storageDir, 'blobs')).map((f) => `blobs/${f}`);
    const allManifests = readdirSync(resolve(storageDir, 'manifests'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'manifests', f), 'utf8')))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const allAliases = readdirSync(resolve(storageDir, 'aliases'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'aliases', f), 'utf8')))
      .sort((a, b) => String(a.subdomain || '').localeCompare(String(b.subdomain || '')));

    return {
      isLocal: true,
      modeLabel: '本地沙盒',
      domainSuffix: BASE_DOMAIN,
      protocol: 'http',
      remoteDomain: BASE_DOMAIN,
      blobKeys,
      fnKeys: [],
      allManifests,
      allAliases,
    };
  }

  const { remoteDomain } = assertCloudEndpointsConfigured();
  const [blobKeys, manifestKeys, aliasKeys, fnKeys] = await Promise.all([
    cosListKeys('blobs/'),
    cosListKeys('manifests/'),
    cosListKeys('aliases/'),
    includeFunctionsKeys ? cosListKeys('functions/') : Promise.resolve([]),
  ]);

  const validManifestKeys = manifestKeys.filter((k) => k.endsWith('.json'));
  const rawManifests = await Promise.all(validManifestKeys.map((k) => cosGetJson(k)));
  const allManifests = [];
  for (let i = 0; i < validManifestKeys.length; i++) {
    const m = rawManifests[i];
    if (!m || !m.id || typeof m.files !== 'object') {
      throw new Error(
        `${actionLabel}安全中止: 无法完整读取或解析云端构建快照 (${validManifestKeys[i]})`
      );
    }
    allManifests.push(m);
  }
  allManifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const validAliasKeys = aliasKeys.filter((k) => k.endsWith('.json'));
  const rawAliases = await Promise.all(validAliasKeys.map((k) => cosGetJson(k)));
  const allAliases = [];
  for (let i = 0; i < validAliasKeys.length; i++) {
    const a = rawAliases[i];
    if (!a || !a.subdomain || !a.deploymentId) {
      throw new Error(
        `${actionLabel}安全中止: 无法完整读取或解析云端域名别名指针 (${validAliasKeys[i]})`
      );
    }
    allAliases.push(a);
  }
  allAliases.sort((a, b) => String(a.subdomain || '').localeCompare(String(b.subdomain || '')));

  return {
    isLocal: false,
    modeLabel: '腾讯云 COS',
    domainSuffix: remoteDomain,
    protocol: 'https',
    remoteDomain,
    blobKeys,
    fnKeys,
    allManifests,
    allAliases,
  };
}

const KEY_WRITE_LOCKS = new Map();

export async function withKeyWriteLock(lockKey, taskFn) {
  const prev = KEY_WRITE_LOCKS.get(lockKey) || Promise.resolve();
  const next = prev.catch(() => {}).then(taskFn);
  const tail = next
    .catch(() => {})
    .finally(() => {
      if (KEY_WRITE_LOCKS.get(lockKey) === tail) {
        KEY_WRITE_LOCKS.delete(lockKey);
      }
    });
  KEY_WRITE_LOCKS.set(lockKey, tail);
  return next;
}
