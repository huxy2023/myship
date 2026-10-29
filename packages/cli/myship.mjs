#!/usr/bin/env node
/**
 * myship.mjs — 个人级极致 DX 部署与泛域名路由 CLI (BYOC 开源版)
 *
 * 核心特性：
 * 1. 项目级命名空间隔离 (.myship/project.json)：
 *    - 自动将不同项目 (如 app1、app2) 隔离到各自的域名前缀：
 *      app1 -> https://app1.ship.example.com, https://app1-v1.ship.example.com, https://app1-<hash>.ship.example.com
 *      app2 -> https://app2.ship.example.com, https://app2-v1.ship.example.com, https://app2-<hash>.ship.example.com
 *    - 在项目目录下执行 `myship ls` 默认只展示当前项目的版本与域名；加 `--all` 按项目分组展示全局总览。
 * 2. 极简命令语法：支持 `myship` (零参数自动部署)、`myship ./dist v1`、`myship rollback` (零参数回滚当前项目主域名)
 * 3. BYOC 自带云底座辅助：支持 `myship login`、`myship whoami` 与 `myship build-edge-fn` (一键生成注入个人 COS 地址的边缘函数)
 * 4. CAS 内容寻址去重 + 永久不可变快照 + 0 秒原子切流与回滚
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { resolve, relative, extname, dirname, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  cosHeadObject,
  cosPutObject,
  cosGetJson,
  cosListKeys,
  getEffectiveEndpoints,
  assertCloudEndpointsConfigured,
  getAuthStatus,
  saveMyShipFileConfig,
  loadTencentCredentials,
  MYSHIP_CONFIG_PATH,
} from './cos-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STORAGE_DIR = resolve(__dirname, '.cas-storage');
const BASE_DOMAIN = process.env.SHIP_BASE_DOMAIN || 'ship.localhost:4100';

const MIME_MAP = {
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
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=UTF-8',
  '.md': 'text/plain; charset=UTF-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const BLOCKED_DIRS = new Set([
  '.git',
  '.myship',
  '.vercel',
  '.edgeone',
  '.ssh',
  '.tccli',
  'node_modules',
  '.cas-storage',
]);

function isSensitiveEntry(entryName) {
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

function ensureStorageDirs(storageDir) {
  mkdirSync(resolve(storageDir, 'blobs'), { recursive: true });
  mkdirSync(resolve(storageDir, 'manifests'), { recursive: true });
  mkdirSync(resolve(storageDir, 'aliases'), { recursive: true });
}

function walkFiles(dir, baseDir = dir) {
  const results = [];
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
    if (stat.isDirectory()) {
      results.push(...walkFiles(full, baseDir));
    } else if (stat.isFile()) {
      const relPath = '/' + relative(baseDir, full).split('\\').join('/');
      results.push({ fullPath: full, relPath, size: stat.size });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function sha256Hex(buffer) {
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

// ============================================================================
// 项目级命名空间与配置探测器 (.myship/project.json)
// ============================================================================
export function detectProjectContext(cwd = process.cwd(), explicitProject = null) {
  const myshipDir = resolve(cwd, '.myship');
  const projectJsonPath = resolve(myshipDir, 'project.json');
  const legacyMyshipJson = resolve(cwd, '.myship.json');
  const pkgJsonPath = resolve(cwd, 'package.json');

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
  if (!inferredName && existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      if (pkg.name) inferredName = pkg.name;
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
    const candidates = ['./dist', './build', './out', './public'];
    for (const c of candidates) {
      const abs = resolve(cwd, c);
      if (existsSync(abs) && statSync(abs).isDirectory()) {
        buildDir = c;
        break;
      }
    }
  }

  const prodDomain = normalizeDomainToken(savedCfg?.prodDomain || project) || project;

  return {
    project,
    buildDir: buildDir || './dist',
    prodDomain,
    hasSavedConfig: Boolean(savedCfg),
    configSource: configSource || '自动推断 (package.json / 目录名)',
    projectJsonPath,
    myshipDir,
  };
}

export function ensureProjectConfig(cwd = process.cwd(), overrides = {}) {
  const ctx = detectProjectContext(cwd, overrides.project);
  ensureMyShipGitignore(ctx.myshipDir);
  const payload = {
    project: overrides.project ? normalizeDomainToken(overrides.project) : ctx.project,
    dir: overrides.dir || ctx.buildDir || './dist',
    prodDomain: overrides.prodDomain
      ? normalizeDomainToken(overrides.prodDomain)
      : overrides.project
      ? normalizeDomainToken(overrides.project)
      : ctx.prodDomain,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(ctx.projectJsonPath, JSON.stringify(payload, null, 2), 'utf8');
  return { ...ctx, ...payload, hasSavedConfig: true, configSource: '.myship/project.json' };
}

function appendLocalProjectHistory(cwd, entry) {
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

// ============================================================================
// 1. 本地模式 CAS 引擎 (离线沙盒验证)
// ============================================================================
export function deployDirectory(
  targetDir,
  { storageDir = DEFAULT_STORAGE_DIR, aliases = [], project = 'default' } = {}
) {
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }
  ensureStorageDirs(storageDir);

  const files = walkFiles(absTarget);
  if (files.length === 0) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};

  for (const file of files) {
    const content = readFileSync(file.fullPath);
    const hash = sha256Hex(content);
    const blobPath = resolve(storageDir, 'blobs', hash);

    if (existsSync(blobPath)) {
      reusedBlobs++;
      console.log(`  ⚡ [CAS 命中跳过] ${file.relPath} (sha256: ${hash.slice(0, 10)}...)`);
    } else {
      writeFileSync(blobPath, content);
      uploadedBlobs++;
      console.log(`  ⬆️ [新块增量上传] ${file.relPath} -> blobs/${hash.slice(0, 10)}... (${file.size} B)`);
    }

    const ext = extname(file.relPath).toLowerCase();
    manifestFiles[file.relPath] = {
      sha256: hash,
      size: file.size,
      contentType: MIME_MAP[ext] || 'application/octet-stream',
    };
  }

  const treeSignature = JSON.stringify({ project, files: manifestFiles, ts: Date.now() });
  const shortHash = sha256Hex(Buffer.from(treeSignature)).slice(0, 8);
  const deploymentId = `dpl_${shortHash}`;
  const immutableSubdomain =
    project && project !== 'default' ? `${project}-${shortHash}` : `dpl-${shortHash}`;

  const manifest = {
    id: deploymentId,
    project,
    immutableSubdomain,
    createdAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
  };

  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const boundUrls = [];
  const allSubdomains = new Set([immutableSubdomain, ...aliases.map(normalizeSubdomain)]);
  if (immutableSubdomain !== `dpl-${shortHash}`) {
    setAlias(`dpl-${shortHash}`, deploymentId, { storageDir, silent: true, project });
  }
  for (const sub of allSubdomains) {
    if (!sub) continue;
    setAlias(sub, deploymentId, { storageDir, silent: true, project });
    boundUrls.push(`http://${sub}.${BASE_DOMAIN}`);
  }

  console.log(`\n✅ 部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   文件统计: 共 ${files.length} 个文件 (新增上传 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 访问地址: ${u}`);
  }

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export function setAlias(
  subdomain,
  deploymentId,
  { storageDir = DEFAULT_STORAGE_DIR, silent = false, project = null } = {}
) {
  const cleanSub = normalizeSubdomain(subdomain);
  ensureStorageDirs(storageDir);
  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`目标部署版本不存在: ${deploymentId}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const effectiveProject = project || manifest.project || 'default';

  const aliasData = {
    subdomain: cleanSub,
    project: effectiveProject,
    deploymentId,
    updatedAt: new Date().toISOString(),
  };
  const aliasPath = resolve(storageDir, 'aliases', `${cleanSub}.json`);
  writeFileSync(aliasPath, JSON.stringify(aliasData, null, 2), 'utf8');

  if (!silent) {
    console.log(`🔗 域名别名已切换: http://${cleanSub}.${BASE_DOMAIN} -> ${deploymentId} (0 秒生效)`);
  }
  return aliasData;
}

export function listState({
  storageDir = DEFAULT_STORAGE_DIR,
  projectFilter = null,
  showAll = false,
} = {}) {
  ensureStorageDirs(storageDir);
  const blobs = readdirSync(resolve(storageDir, 'blobs'));
  const allManifests = readdirSync(resolve(storageDir, 'manifests'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'manifests', f), 'utf8')))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const allAliases = readdirSync(resolve(storageDir, 'aliases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'aliases', f), 'utf8')))
    .sort((a, b) => a.subdomain.localeCompare(b.subdomain));

  printFormattedState({
    modeLabel: '本地沙盒',
    domainSuffix: BASE_DOMAIN,
    protocol: 'http',
    blobsCount: blobs.length,
    allManifests,
    allAliases,
    projectFilter,
    showAll,
  });

  return { blobsCount: blobs.length, manifests: allManifests, aliases: allAliases };
}

// ============================================================================
// 2. 腾讯云 COS + EdgeOne 云端模式 (默认生产模式)
// ============================================================================
export async function deployRemoteDirectory(
  targetDir,
  { aliases = [], project = 'default', cwd = process.cwd() } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }

  const files = walkFiles(absTarget);
  if (files.length === 0) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  console.log(`☁️  正在向腾讯云 COS 执行 CAS 去重部署... [项目命名空间: ${project}]`);
  console.log(`📂 目标目录: ${absTarget} (共 ${files.length} 个文件)`);

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};

  for (const file of files) {
    const content = readFileSync(file.fullPath);
    const hash = sha256Hex(content);
    const blobKey = `blobs/${hash}`;
    const ext = extname(file.relPath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    const exists = await cosHeadObject(blobKey);
    if (exists) {
      reusedBlobs++;
      console.log(`  ⚡ [COS CAS 命中跳过] ${file.relPath} (sha256: ${hash.slice(0, 10)}...)`);
    } else {
      await cosPutObject(blobKey, content, contentType);
      uploadedBlobs++;
      console.log(`  ⬆️ [COS 新块上传] ${file.relPath} -> ${blobKey.slice(0, 16)}... (${file.size} B)`);
    }

    manifestFiles[file.relPath] = {
      sha256: hash,
      size: file.size,
      contentType,
    };
  }

  const treeSignature = JSON.stringify({ project, files: manifestFiles, ts: Date.now() });
  const shortHash = sha256Hex(Buffer.from(treeSignature)).slice(0, 8);
  const deploymentId = `dpl_${shortHash}`;
  const immutableSubdomain =
    project && project !== 'default' ? `${project}-${shortHash}` : `dpl-${shortHash}`;

  const manifest = {
    id: deploymentId,
    project,
    immutableSubdomain,
    createdAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
  };

  await cosPutObject(
    `manifests/${deploymentId}.json`,
    JSON.stringify(manifest, null, 2),
    'application/json; charset=UTF-8'
  );

  const boundUrls = [];
  const allSubdomains = new Set([immutableSubdomain, ...aliases.map(normalizeSubdomain)]);
  for (const sub of allSubdomains) {
    if (!sub) continue;
    await setRemoteAlias(sub, deploymentId, { silent: true, skipVerify: true, project });
    boundUrls.push(`https://${sub}.${remoteDomain}`);
  }

  appendLocalProjectHistory(cwd, {
    id: deploymentId,
    project,
    immutableSubdomain,
    aliases: [...allSubdomains],
    urls: boundUrls,
    createdAt: manifest.createdAt,
  });

  console.log(`\n✅ 云端部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   文件统计: 共 ${files.length} 个文件 (COS 新增上传 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 线上访问地址: ${u}`);
  }

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export async function setRemoteAlias(
  subdomain,
  deploymentId,
  { silent = false, skipVerify = false, project = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanSub = normalizeSubdomain(subdomain);
  let inferredProject = project;

  if (!skipVerify) {
    const manifest = await cosGetJson(`manifests/${deploymentId}.json`);
    if (!manifest) {
      throw new Error(`云端 COS 中不存在目标部署版本: ${deploymentId}`);
    }
    inferredProject = inferredProject || manifest.project || 'default';
  }

  const aliasData = {
    subdomain: cleanSub,
    project: inferredProject || inferProjectFromRecord({ subdomain: cleanSub }),
    deploymentId,
    updatedAt: new Date().toISOString(),
  };

  await cosPutObject(
    `aliases/${cleanSub}.json`,
    JSON.stringify(aliasData, null, 2),
    'application/json; charset=UTF-8'
  );

  if (!silent) {
    console.log(
      `🔗 云端域名别名已切换: https://${cleanSub}.${remoteDomain} -> ${deploymentId} (全球边缘 0 秒生效)`
    );
  }
  return aliasData;
}

export async function rollbackRemoteAlias(
  subdomain,
  targetDeploymentId = null,
  { project = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanSub = normalizeSubdomain(subdomain);
  const currentAlias = await cosGetJson(`aliases/${cleanSub}.json`);
  if (!currentAlias) {
    throw new Error(`未找到子域名 https://${cleanSub}.${remoteDomain} 的现有绑定记录`);
  }

  const currentDplId = currentAlias.deploymentId;
  const effectiveProject = project || currentAlias.project || null;

  if (targetDeploymentId) {
    if (targetDeploymentId === currentDplId) {
      console.log(`ℹ️  https://${cleanSub}.${remoteDomain} 当前已经指向 ${targetDeploymentId}`);
      return currentAlias;
    }
    console.log(
      `⏪ 正在将 https://${cleanSub}.${remoteDomain} 从 ${currentDplId} 回滚至指定版本 ${targetDeploymentId}...`
    );
    return setRemoteAlias(cleanSub, targetDeploymentId, { project: effectiveProject });
  }

  const manifestKeys = await cosListKeys('manifests/');
  const manifests = (
    await Promise.all(manifestKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const projectManifests = effectiveProject
    ? manifests.filter((m) => inferProjectFromRecord(m) === effectiveProject)
    : manifests;
  const pool = projectManifests.length >= 2 ? projectManifests : manifests;

  const currentIdx = pool.findIndex((m) => m.id === currentDplId);
  const previousManifest =
    currentIdx >= 0 && currentIdx + 1 < pool.length
      ? pool[currentIdx + 1]
      : pool.find((m) => m.id !== currentDplId);

  if (!previousManifest) {
    throw new Error(
      `当前仅有 1 个部署版本 (${currentDplId})，没有更早的历史版本可供回滚。`
    );
  }

  console.log(
    `⏪ 正在将 https://${cleanSub}.${remoteDomain} 从 ${currentDplId} 回滚至上一版本 ${previousManifest.id} (${previousManifest.createdAt})...`
  );
  return setRemoteAlias(cleanSub, previousManifest.id, { project: effectiveProject });
}

function printFormattedState({
  modeLabel,
  domainSuffix,
  protocol,
  blobsCount,
  allManifests,
  allAliases,
  projectFilter,
  showAll,
}) {
  if (!showAll && projectFilter) {
    const projManifests = allManifests.filter(
      (m) => inferProjectFromRecord(m) === projectFilter
    );
    const projDplIds = new Set(projManifests.map((m) => m.id));
    const projAliases = allAliases.filter(
      (a) =>
        a.project === projectFilter ||
        a.subdomain === projectFilter ||
        a.subdomain.startsWith(`${projectFilter}-`) ||
        projDplIds.has(a.deploymentId)
    );

    console.log(
      `=== 📦 当前项目命名空间: [${projectFilter}] (${modeLabel}全局 CAS 唯一块: ${blobsCount} 个) ===`
    );
    console.log(`\n=== 🚀 [${projectFilter}] 历史构建部署列表 (${projManifests.length} 个) ===`);
    if (projManifests.length === 0) {
      console.log(`  (当前项目 [${projectFilter}] 尚无部署记录，直接运行 \`myship\` 即可发布第一版)`);
    } else {
      for (const m of projManifests) {
        console.log(
          `  - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
        );
      }
    }

    console.log(`\n=== 🌐 [${projectFilter}] 线上子域名路由映射表 (${projAliases.length} 个) ===`);
    if (projAliases.length === 0) {
      console.log(`  (当前项目 [${projectFilter}] 尚无子域名映射)`);
    } else {
      for (const a of projAliases) {
        console.log(`  - ${protocol}://${a.subdomain}.${domainSuffix}  -->  ${a.deploymentId}`);
      }
    }
    console.log(
      `\n💡 提示: 默认仅展示当前项目 [${projectFilter}] 的记录；如需查看所有项目汇总，请执行 \`myship ls --all\`。`
    );
    return;
  }

  console.log(`=== ☁️  ${modeLabel} CAS 存储池 (全局唯一文件块: ${blobsCount} 个) ===`);
  const projects = new Map();

  function ensureBucket(proj) {
    if (!projects.has(proj)) {
      projects.set(proj, { manifests: [], aliases: [] });
    }
    return projects.get(proj);
  }

  const dplToProject = new Map();
  for (const m of allManifests) {
    const p = inferProjectFromRecord(m, 'default');
    dplToProject.set(m.id, p);
    ensureBucket(p).manifests.push(m);
  }
  for (const a of allAliases) {
    const p = a.project || dplToProject.get(a.deploymentId) || inferProjectFromRecord(a, 'default');
    ensureBucket(p).aliases.push(a);
  }

  const sortedProjectNames = [...projects.keys()].sort((a, b) => {
    if (a === 'default') return 1;
    if (b === 'default') return -1;
    return a.localeCompare(b);
  });

  for (const proj of sortedProjectNames) {
    const group = projects.get(proj);
    const title = proj === 'default' ? '未分类 / 全局部署 (default)' : `项目命名空间: [${proj}]`;
    console.log(`\n📦 ${title}`);
    console.log(`  🚀 历史构建版本 (${group.manifests.length} 个):`);
    for (const m of group.manifests) {
      console.log(
        `     - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
      );
    }
    console.log(`  🌐 绑定域名列表 (${group.aliases.length} 个):`);
    for (const a of group.aliases) {
      console.log(`     - ${protocol}://${a.subdomain}.${domainSuffix}  -->  ${a.deploymentId}`);
    }
  }
}

export async function listRemoteState({ projectFilter = null, showAll = false } = {}) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const [blobKeys, manifestKeys, aliasKeys] = await Promise.all([
    cosListKeys('blobs/'),
    cosListKeys('manifests/'),
    cosListKeys('aliases/'),
  ]);

  const allManifests = (
    await Promise.all(manifestKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const allAliases = (
    await Promise.all(aliasKeys.filter((k) => k.endsWith('.json')).map((k) => cosGetJson(k)))
  )
    .filter(Boolean)
    .sort((a, b) => a.subdomain.localeCompare(b.subdomain));

  printFormattedState({
    modeLabel: '腾讯云 COS',
    domainSuffix: remoteDomain,
    protocol: 'https',
    blobsCount: blobKeys.length,
    allManifests,
    allAliases,
    projectFilter,
    showAll,
  });

  return { blobsCount: blobKeys.length, manifests: allManifests, aliases: allAliases };
}

// ============================================================================
// 3. 边缘函数代码生成器 (`myship build-edge-fn`) 与交互式登录 (`myship login`)
// ============================================================================
export function generateEdgeFunctionCode({ cosOrigin, outputPath } = {}) {
  const effective = getEffectiveEndpoints();
  const targetCosOrigin = (cosOrigin || effective.cosOrigin || '').replace(/\/$/, '');
  if (!targetCosOrigin) {
    throw new Error(
      '尚未配置 COS_ORIGIN！请先运行 `myship login` 或通过环境变量 COS_ORIGIN="https://myship-1250000000.cos.ap-guangzhou.myqcloud.com" 指定。'
    );
  }

  const templatePath = resolve(__dirname, '../edge-gateway/edgeone-function.template.js');
  const templateContent = readFileSync(templatePath, 'utf8');
  const rendered = templateContent.replace(/__MYSHIP_COS_ORIGIN__/g, targetCosOrigin);

  const outFile = outputPath || resolve(process.cwd(), '.myship', 'edgeone-function.dist.js');
  mkdirSync(dirname(outFile), { recursive: true });
  if (basename(dirname(outFile)) === '.myship') {
    ensureMyShipGitignore(dirname(outFile));
  }
  writeFileSync(outFile, rendered, 'utf8');

  console.log(`✅ 已生成注入你专属 COS 地址的 EdgeOne 边缘函数代码:`);
  console.log(`   📄 文件路径: ${outFile}`);
  console.log(`   ☁️  绑定 COS: ${targetCosOrigin}`);
  console.log(`\n👉 下一步 (二选一部署至腾讯云 EdgeOne):`);
  console.log(`   方式 A (控制台粘贴): 复制 ${outFile} 的内容粘贴到 EdgeOne 站点【边缘函数】中并配置触发规则。`);
  console.log(`   方式 B (tccli 命令):`);
  console.log(
    `   tccli teo ModifyFunction --ZoneId "zone-xxxxxxxx" --FunctionId "ef-xxxxxxxx" --Content "$(cat ${outFile})"`
  );
  return { outFile, targetCosOrigin };
}

async function interactiveLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const currentEndpoints = getEffectiveEndpoints();
  const status = getAuthStatus();

  console.log('==============================================================');
  console.log('🔐 MyShip 跨设备认证与自有云底座 (BYOC) 配置向导');
  console.log('   配置文件将安全保存在 ~/.myship/config.json (权限 0600)');
  console.log('==============================================================');
  if (status.authenticated) {
    console.log(`💡 检测到当前已有可用凭证: ${status.maskedSecretId} (来源: ${status.source})`);
  }

  const secretId = (await rl.question('1. 请输入腾讯云 SecretId (直接回车则保持现有凭证): ')).trim();
  const secretKey = (
    await rl.question('2. 请输入腾讯云 SecretKey (直接回车则保持现有凭证): ')
  ).trim();
  const cosDefault =
    currentEndpoints.cosOrigin || 'https://myship-1250000000.cos.ap-guangzhou.myqcloud.com';
  const cosOriginInput = (
    await rl.question(`3. 你的 COS 存储桶地址 [默认: ${cosDefault}]: `)
  ).trim();
  const domainDefault = currentEndpoints.remoteDomain || 'ship.example.com';
  const remoteDomainInput = (
    await rl.question(`4. 你的泛域名后缀 [默认: ${domainDefault}]: `)
  ).trim();
  rl.close();

  const patch = {
    cosOrigin: (cosOriginInput || cosDefault).replace(/\/$/, ''),
    remoteDomain: (remoteDomainInput || domainDefault).replace(/^\*\./, ''),
  };
  if (secretId && secretKey) {
    patch.secretId = secretId;
    patch.secretKey = secretKey;
  }

  saveMyShipFileConfig(patch);
  loadTencentCredentials();
  await cosListKeys('manifests/');
  console.log(`\n✅ 认证与连通性校验成功！配置已写入: ${MYSHIP_CONFIG_PATH}`);
  generateEdgeFunctionCode({ cosOrigin: patch.cosOrigin });
}

function printWhoami() {
  const status = getAuthStatus();
  const proj = detectProjectContext();
  console.log('=== 👤 MyShip 当前身份与自有云底座 (BYOC) 配置 ===');
  if (status.authenticated) {
    console.log(`  ✅ 认证状态: 已就绪`);
    console.log(`  🔑 凭证来源: ${status.source}`);
    console.log(`  🆔 SecretId: ${status.maskedSecretId}`);
  } else {
    console.log(`  ❌ 认证状态: 未配置 (${status.error})`);
  }
  console.log(`  ☁️  COS 存储桶: ${status.cosOrigin || '(未配置，请运行 myship login)'}`);
  console.log(
    `  🌐 泛域名后缀: ${
      status.remoteDomain ? `*.${status.remoteDomain}` : '(未配置，请运行 myship login)'
    }`
  );

  const suffix = status.remoteDomain || 'ship.example.com';
  console.log('\n=== 📦 当前项目命名空间上下文 (.myship/project.json) ===');
  console.log(`  🏷️  项目名称 (project):  ${proj.project}`);
  console.log(`  📁 默认构建目录 (dir):  ${proj.buildDir}`);
  console.log(`  🌐 项目主域名:          https://${proj.prodDomain}.${suffix}`);
  console.log(`  🌐 构建指纹域名格式:    https://${proj.project}-<hash>.${suffix}`);
  console.log(`  📄 配置来源:            ${proj.configSource}`);
}

function printHelp() {
  console.log(`
🚀 MyShip CLI — 基于自有云设施 (BYOC) 的高 DX 部署与泛域名路由工具

极简日常用法 (自动关联 .myship/project.json 项目命名空间):
  myship                                       零参数部署：自动生成 <project>-<hash> 并更新 <project>.ship.<domain>
  myship <目录> <环境后缀>                     项目内带后缀部署：如在 app1 下执行 myship ./dist v2 -> https://app1-v2.ship.<domain>
  myship -d <环境后缀> [-p <项目名>]           部署并自动拼接当前项目命名空间前缀 (加 --raw 可不加项目前缀)

项目管理与切流回滚命令:
  myship init [项目名]                         初始化或更新当前目录下的 .myship/project.json
  myship ls [--all | -A]                       默认仅列出【当前项目】的历史构建与域名；加 --all 按项目分组列出全局所有记录
  myship rollback [环境后缀] [目标dpl_id]      一键秒级回滚（不传参数默认回滚当前项目主域名 <project>.ship.<domain>）
  myship alias <环境后缀> <dpl_id>             0 秒将指定子域名切换到目标版本

跨设备认证与自有云底座初始化:
  myship login                                 交互式配置腾讯云密钥、COS 地址与泛域名后缀 (~/.myship/config.json)
  myship build-edge-fn [输出路径]              根据当前 COS 配置一键生成专属 EdgeOne 边缘函数代码 (.myship/edgeone-function.dist.js)
  myship whoami                                查看当前生效的认证状态与项目命名空间配置

可选参数:
  -p, --project <name>                         显式指定本次操作的项目命名空间
  --raw                                        自定义子域名不自动拼接 <project>- 前缀
  --preview                                    仅生成本次构建快照域名 (<project>-<hash>)，不更新项目主域名
  --local, -l                                  使用本地离线沙盒模式 (.cas-storage + ship.localhost:4100)
`);
}

// ============================================================================
// CLI 主入口解析
// ============================================================================
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMainModule) {
  const rawArgs = process.argv.slice(2);
  const isLocal = rawArgs.includes('--local') || rawArgs.includes('-l');
  const isAll = rawArgs.includes('--all') || rawArgs.includes('-A');
  const isRawDomain = rawArgs.includes('--raw');
  const isPreviewOnly = rawArgs.includes('--preview');

  const domains = [];
  let explicitProject = null;
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--domain' || arg === '-d') {
      if (rawArgs[i + 1]) domains.push(rawArgs[++i]);
    } else if (arg === '--project' || arg === '-p') {
      if (rawArgs[i + 1]) explicitProject = rawArgs[++i];
    } else if (
      [
        '--local',
        '-l',
        '--remote',
        '-r',
        '--all',
        '-A',
        '--raw',
        '--preview',
        '--save',
        '-s',
      ].includes(arg)
    ) {
      // flag handled
    } else if (arg === '--help' || arg === '-h') {
      positional.push('help');
    } else if (arg === '--version' || arg === '-v') {
      positional.push('version');
    } else {
      positional.push(arg);
    }
  }

  const first = positional[0];

  (async () => {
    if (first === 'version') {
      try {
        const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
        console.log(`myship v${rootPkg.version}`);
      } catch {
        console.log('myship v0.1.0');
      }
      return;
    }
    if (first === 'help') {
      printHelp();
      return;
    }
    if (first === 'login') {
      await interactiveLogin();
      return;
    }
    if (first === 'whoami') {
      printWhoami();
      return;
    }
    if (first === 'build-edge-fn') {
      generateEdgeFunctionCode({ outputPath: positional[1] });
      return;
    }
    if (first === 'init') {
      const cfg = ensureProjectConfig(process.cwd(), {
        project: positional[1] || explicitProject,
      });
      const { remoteDomain } = getEffectiveEndpoints();
      const suffix = remoteDomain || 'ship.example.com';
      console.log(`✅ 项目命名空间已初始化: ${cfg.projectJsonPath}`);
      console.log(`   🏷️  项目名称: ${cfg.project}`);
      console.log(`   📁 构建目录: ${cfg.dir}`);
      console.log(`   🌐 默认主域名: https://${cfg.prodDomain}.${suffix}`);
      return;
    }
    if (first === 'ls' || first === 'list') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const projectFilter = explicitProject ? normalizeDomainToken(explicitProject) : ctx.project;
      if (isLocal) {
        listState({ projectFilter, showAll: isAll });
      } else {
        await listRemoteState({ projectFilter, showAll: isAll });
      }
      return;
    }
    if (first === 'alias') {
      const [, rawSub, dplId] = positional;
      if (!rawSub || !dplId) {
        console.error('用法: myship alias <subdomain> <deployment_id>');
        process.exit(1);
      }
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const finalSub = resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain);
      if (isLocal) {
        setAlias(finalSub, dplId, { project: ctx.project });
      } else {
        await setRemoteAlias(finalSub, dplId, { project: ctx.project });
      }
      return;
    }
    if (first === 'rollback') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      let rawSub = positional[1];
      let targetDplId = positional[2] || null;
      if (rawSub && rawSub.startsWith('dpl_')) {
        targetDplId = rawSub;
        rawSub = null;
      }
      const finalSub = rawSub
        ? resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain)
        : ctx.prodDomain;
      await rollbackRemoteAlias(finalSub, targetDplId, { project: ctx.project });
      return;
    }

    // 默认行为：deploy
    let targetDir = null;
    if (first === 'deploy') {
      targetDir = positional[1] || null;
      if (positional[2]) domains.push(positional[2]);
    } else {
      targetDir = positional[0] || null;
      if (positional[1]) domains.push(positional[1]);
    }

    const ctx = detectProjectContext(process.cwd(), explicitProject);
    const finalDir = targetDir || ctx.buildDir;
    if (!finalDir || !existsSync(resolve(finalDir))) {
      console.error(
        `❌ 未找到构建产物目录 (${finalDir || './dist'})。请先执行构建 (如 npm run build) 或指定目录: myship ./dist`
      );
      process.exit(1);
    }

    if (!ctx.hasSavedConfig || explicitProject) {
      ensureProjectConfig(process.cwd(), {
        project: ctx.project,
        dir: finalDir,
      });
      console.log(`📁 已自动创建项目命名空间配置: .myship/project.json [项目: ${ctx.project}]`);
    }

    const resolvedAliases = domains.map((d) =>
      resolveNamespacedSubdomain(d, ctx.project, isRawDomain)
    );
    if (resolvedAliases.length === 0 && !isPreviewOnly) {
      resolvedAliases.push(ctx.prodDomain);
    }

    if (isLocal) {
      deployDirectory(finalDir, { aliases: resolvedAliases, project: ctx.project });
    } else {
      await deployRemoteDirectory(finalDir, {
        aliases: resolvedAliases,
        project: ctx.project,
        cwd: process.cwd(),
      });
    }
  })().catch((err) => {
    console.error(`❌ 执行失败: ${err.message}`);
    process.exit(1);
  });
}
