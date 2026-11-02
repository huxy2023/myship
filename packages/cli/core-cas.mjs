import {
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { resolve, extname } from 'node:path';
import {
  cosHeadObject,
  cosPutObject,
  cosGetJson,
  cosListKeys,
  cosDeleteObject,
  assertCloudEndpointsConfigured,
  deployProjectApiFunctionToTeo,
} from './cos-client.mjs';
import {
  DEFAULT_STORAGE_DIR,
  BASE_DOMAIN,
  MIME_MAP,
  ensureStorageDirs,
  walkFiles,
  sha256Hex,
  normalizeSubdomain,
  appendLocalProjectHistory,
  inferProjectFromRecord,
  loadCasStateSnapshot,
  detectProjectContext,
  ensureProjectConfig,
} from './project-context.mjs';
import {
  syncCloudEnvsPool,
  getRemoteProjectEnv,
  loadDevProjectEnv,
} from './env-manager.mjs';
import {
  resolveApiDir,
  scanApiFunctions,
  transformEsmToFactorySource,
  saveLocalFunctionsPool,
  syncCloudFunctionsPool,
  generateProjectApiWorkerCode,
} from './serverless.mjs';
import {
  deployScfBackendVersion,
  ensureScfVersionHttpTrigger,
  deleteScfVersionAndTrigger,
} from './scf-client.mjs';

export function emitGitHubActionsOutputs({
  deploymentId = '',
  immutableUrl = '',
  primaryUrl = '',
  boundUrls = [],
  functions = [],
} = {}) {
  const ghOutputPath = process.env.GITHUB_OUTPUT;
  if (!ghOutputPath) return;
  try {
    const lines = [
      `deployment_id=${deploymentId}`,
      `immutable_url=${immutableUrl}`,
      `primary_url=${primaryUrl}`,
      `urls=${boundUrls.join(',')}`,
      `functions=${functions.join(',')}`,
    ];
    appendFileSync(ghOutputPath, lines.join('\n') + '\n', 'utf8');
  } catch {
    // ignore non-critical GITHUB_OUTPUT write failure
  }
}

export function deployDirectory(
  targetDir,
  {
    storageDir = DEFAULT_STORAGE_DIR,
    aliases = [],
    project = 'default',
    cwd = process.cwd(),
    apiDir = null,
  } = {}
) {
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }
  ensureStorageDirs(storageDir);

  const files = walkFiles(absTarget);
  const resolvedApiDir = resolveApiDir(absTarget, cwd, apiDir);
  const apiFunctions = scanApiFunctions(resolvedApiDir);

  if (files.length === 0 && apiFunctions.length === 0) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};
  const manifestFunctions = {};

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

  for (const fn of apiFunctions) {
    transformEsmToFactorySource(fn.sourceCode, fn.relSource, true);
    const content = Buffer.from(fn.sourceCode, 'utf8');
    const hash = sha256Hex(content);
    const blobPath = resolve(storageDir, 'blobs', hash);

    if (existsSync(blobPath)) {
      reusedBlobs++;
      console.log(
        `  ⚡ [API 函数 CAS 复用] ${fn.route} (${fn.relSource}) (sha256: ${hash.slice(0, 10)}...)`
      );
    } else {
      writeFileSync(blobPath, content);
      uploadedBlobs++;
      console.log(
        `  ⚡ [API 函数新块写入] ${fn.route} (${fn.relSource}) -> blobs/${hash.slice(0, 10)}... (${fn.size} B)`
      );
    }

    manifestFunctions[fn.route] = {
      sha256: hash,
      entryBlob: hash,
      runtime: fn.upstreamUrl ? 'scf-url' : 'edge-js',
      ...(fn.upstreamUrl ? { upstreamUrl: fn.upstreamUrl } : {}),
      size: fn.size,
      source: fn.relSource,
    };
  }

  const treeSignature = JSON.stringify({
    project,
    files: manifestFiles,
    functions: manifestFunctions,
    ts: Date.now(),
  });
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
      totalFunctions: apiFunctions.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
    functions: manifestFunctions,
  };

  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const boundUrls = [`http://${immutableSubdomain}.${BASE_DOMAIN}`];
  const mutableAliases = new Set(aliases.map(normalizeSubdomain).filter(Boolean));
  for (const sub of mutableAliases) {
    if (sub === immutableSubdomain || sub === `dpl-${shortHash}`) continue;
    setAlias(sub, deploymentId, { storageDir, silent: true, project });
    boundUrls.push(`http://${sub}.${BASE_DOMAIN}`);
  }

  console.log(`\n✅ 部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   资源统计: 静态文件 ${files.length} 个, 云函数 ${apiFunctions.length} 个 (新增块 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 访问地址: ${u}`);
  }
  for (const route of Object.keys(manifestFunctions)) {
    console.log(`   ⚡ 云函数路由: ${boundUrls[0] || ''}${route}`);
  }

  emitGitHubActionsOutputs({
    deploymentId,
    immutableUrl: boundUrls[0] || '',
    primaryUrl: boundUrls[boundUrls.length - 1] || boundUrls[0] || '',
    boundUrls,
    functions: Object.keys(manifestFunctions),
  });

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export function setAlias(
  subdomain,
  deploymentId,
  { storageDir = DEFAULT_STORAGE_DIR, silent = false, project = null } = {}
) {
  if (!/^dpl_[a-zA-Z0-9_-]+$/.test(String(deploymentId || ''))) {
    throw new Error(`无效的部署版本 ID: ${deploymentId}`);
  }
  const cleanSub = normalizeSubdomain(subdomain);
  ensureStorageDirs(storageDir);
  const manifestPath = resolve(storageDir, 'manifests', `${deploymentId}.json`);
  if (!existsSync(manifestPath)) {
    throw new Error(`目标部署版本不存在: ${deploymentId}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestProj = inferProjectFromRecord(manifest, null);
  if (project && manifestProj && manifestProj !== project) {
    throw new Error(
      `目标版本 (${deploymentId}) 属于项目 [${manifestProj}]，不能绑定到项目 [${project}] 的域名下`
    );
  }
  const effectiveProject = project || manifestProj || 'default';

  const aliasPath = resolve(storageDir, 'aliases', `${cleanSub}.json`);
  let previousDeploymentId = null;
  if (existsSync(aliasPath)) {
    const existing = JSON.parse(readFileSync(aliasPath, 'utf8'));
    const existingProj = existing?.project || null;
    if (existingProj && effectiveProject && existingProj !== effectiveProject) {
      throw new Error(
        `子域名 [${cleanSub}] 已被项目 [${existingProj}] 占用，不能被项目 [${effectiveProject}] 覆盖`
      );
    }
    if (existing?.deploymentId && existing.deploymentId !== deploymentId) {
      previousDeploymentId = existing.deploymentId;
    } else if (existing?.previousDeploymentId && existing.previousDeploymentId !== deploymentId) {
      previousDeploymentId = existing.previousDeploymentId;
    }
  }

  const aliasData = {
    subdomain: cleanSub,
    project: effectiveProject,
    deploymentId,
    ...(previousDeploymentId ? { previousDeploymentId } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(aliasPath, JSON.stringify(aliasData, null, 2), 'utf8');

  if (!silent) {
    console.log(`🔗 域名别名已切换: http://${cleanSub}.${BASE_DOMAIN} -> ${deploymentId} (0 秒生效)`);
  }
  return aliasData;
}

export function rollbackAlias(
  subdomain,
  targetDeploymentId = null,
  { storageDir = DEFAULT_STORAGE_DIR, project = null } = {}
) {
  const cleanSub = normalizeSubdomain(subdomain);
  ensureStorageDirs(storageDir);
  const aliasPath = resolve(storageDir, 'aliases', `${cleanSub}.json`);
  if (!existsSync(aliasPath)) {
    throw new Error(`未找到本地沙盒子域名 http://${cleanSub}.${BASE_DOMAIN} 的现有绑定记录`);
  }
  const currentAlias = JSON.parse(readFileSync(aliasPath, 'utf8'));
  const currentDplId = currentAlias.deploymentId;
  const effectiveProject = project || currentAlias.project || null;

  if (targetDeploymentId) {
    if (targetDeploymentId === currentDplId) {
      console.log(`ℹ️  http://${cleanSub}.${BASE_DOMAIN} 当前已经指向 ${targetDeploymentId}`);
      return currentAlias;
    }
    return setAlias(cleanSub, targetDeploymentId, { storageDir, project: effectiveProject });
  }

  const manifests = readdirSync(resolve(storageDir, 'manifests'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'manifests', f), 'utf8')))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const pool = effectiveProject
    ? manifests.filter((m) => inferProjectFromRecord(m) === effectiveProject)
    : manifests;

  const currentIdx = pool.findIndex((m) => m.id === currentDplId);
  const byPrevious = currentAlias.previousDeploymentId
    ? pool.find((m) => m.id === currentAlias.previousDeploymentId && m.id !== currentDplId)
    : null;
  const previousManifest =
    byPrevious ||
    (currentIdx >= 0 && currentIdx + 1 < pool.length
      ? pool[currentIdx + 1]
      : pool.find((m) => m.id !== currentDplId));

  if (!previousManifest) {
    throw new Error(
      `当前仅有 1 个部署版本 (${currentDplId})，没有更早的历史版本可供回滚。`
    );
  }

  console.log(
    `⏪ 正在将 http://${cleanSub}.${BASE_DOMAIN} 从 ${currentDplId} 回滚至上一版本 ${previousManifest.id} (${previousManifest.createdAt})...`
  );
  return setAlias(cleanSub, previousManifest.id, { storageDir, project: effectiveProject });
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

const SCF_MAX_TOTAL_VERSIONS = 8; // 单函数硬上限 10 个触发器，固定保留最多 8 个已发布版本 (含活跃别名与回滚版本 + 最近最多 5 个预览版本)，始终为新发布预留充足名额
const SCF_MAX_PREVIEW_VERSIONS = 5;

export async function enforceProjectScfRetention({
  project,
  functionName,
  region = 'ap-guangzhou',
  extraProtectedDeploymentIds = [],
  upcomingAliases = [],
}) {
  const snap = await loadCasStateSnapshot({
    isLocal: false,
    actionLabel: '读取活跃后端版本与执行统一保留计划',
  });
  const projectAliases = snap.allAliases.filter(
    (a) =>
      (a.project || project) === project &&
      !(a.subdomain && /^.*-[0-9a-f]{8}$/.test(a.subdomain) && !a.previousDeploymentId)
  );
  const activeDplIds = new Set(
    projectAliases.flatMap((a) => [a.deploymentId, a.previousDeploymentId]).filter(Boolean)
  );
  for (const id of extraProtectedDeploymentIds) {
    if (id) activeDplIds.add(id);
  }

  // 若处于部署前预检阶段，提前推演本次切流完成后的受保护版本集合，防止“先切换线上别名、后报超限失败”
  const cleanUpcoming = upcomingAliases.map((s) => normalizeSubdomain(s)).filter(Boolean);
  let projectedSize = activeDplIds.size;
  if (cleanUpcoming.length > 0 || extraProtectedDeploymentIds.length === 0) {
    const upcomingSet = new Set(cleanUpcoming);
    const projectedIds = new Set(['__UPCOMING_DEPLOYMENT__']);
    for (const a of projectAliases) {
      if (upcomingSet.has(a.subdomain)) {
        if (a.deploymentId) projectedIds.add(a.deploymentId); // 切流后原 deploymentId 转为 previousDeploymentId
      } else {
        if (a.deploymentId) projectedIds.add(a.deploymentId);
        if (a.previousDeploymentId) projectedIds.add(a.previousDeploymentId);
      }
    }
    projectedSize = projectedIds.size;
    if (projectedSize > SCF_MAX_TOTAL_VERSIONS) {
      throw new Error(
        `项目 [${project}] 本次发布切流后受保护的活跃域名及回滚版本数 (${projectedSize}) 将超过单函数触发器保留上限 (${SCF_MAX_TOTAL_VERSIONS})。请先使用 \`myship rm\` 清理不再使用的域名别名。`
      );
    }
  }

  if (activeDplIds.size > SCF_MAX_TOTAL_VERSIONS) {
    throw new Error(
      `项目 [${project}] 当前受保护的活跃域名及回滚版本数 (${activeDplIds.size}) 已超过单函数触发器保留上限 (${SCF_MAX_TOTAL_VERSIONS})。请先使用 \`myship rm\` 清理不再使用的域名别名。`
    );
  }

  const reservedSlots =
    extraProtectedDeploymentIds.length === 0
      ? Math.max(activeDplIds.size + 1, projectedSize)
      : activeDplIds.size;
  const maxPreviewsAllowed = Math.max(
    0,
    Math.min(SCF_MAX_PREVIEW_VERSIONS, SCF_MAX_TOTAL_VERSIONS - reservedSlots)
  );

  const projManifests = snap.allManifests
    .filter((m) => inferProjectFromRecord(m) === project)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const protectedQualifiers = new Set();
  let previewKept = 0;

  for (const m of projManifests) {
    if (!m || !m.id) continue;
    if (activeDplIds.has(m.id)) {
      if (m.backend && m.backend.scfVersion) {
        protectedQualifiers.add(String(m.backend.scfVersion));
      }
      continue;
    }
    if (previewKept < maxPreviewsAllowed) {
      previewKept++;
      if (m.backend && m.backend.scfVersion) {
        protectedQualifiers.add(String(m.backend.scfVersion));
      }
      continue;
    }

    // 超出统一保留计划的旧预览版本：原子化联动清理 SCF 触发器、SCF 版本、不可变子域名指针与历史 manifest
    if (m.backend && m.backend.scfVersion) {
      await deleteScfVersionAndTrigger({
        functionName: m.backend.functionName || functionName,
        qualifier: m.backend.scfVersion,
        region: m.backend.region || region,
      });
    }
    if (m.immutableSubdomain) {
      await cosDeleteObject(`aliases/${m.immutableSubdomain}.json`);
    }
    await cosDeleteObject(`manifests/${m.id}.json`);
  }

  return { protectedQualifiers, activeDplIds };
}

export async function deployRemoteDirectory(
  targetDir,
  { aliases = [], project = 'default', cwd = process.cwd(), apiDir = null } = {}
) {
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const absTarget = resolve(targetDir);
  if (!existsSync(absTarget)) {
    throw new Error(`目标构建目录不存在: ${absTarget}`);
  }

  const projCtx = detectProjectContext(cwd, project);
  const scfBackendEnabled = Boolean(projCtx.backend && projCtx.backend.enabled);

  const files = walkFiles(absTarget);
  const resolvedApiDir = scfBackendEnabled ? null : resolveApiDir(absTarget, cwd, apiDir);
  const apiFunctions = scfBackendEnabled ? [] : scanApiFunctions(resolvedApiDir);

  if (files.length === 0 && apiFunctions.length === 0 && !scfBackendEnabled) {
    throw new Error(`目标目录为空: ${absTarget}`);
  }

  console.log(`☁️  正在向腾讯云 COS 执行 CAS 去重部署... [项目命名空间: ${project}]`);
  console.log(
    `📂 目标目录: ${absTarget} (静态文件: ${files.length} 个${
      scfBackendEnabled
        ? `, 全栈业务后端: SCF Web 函数 [已开启]`
        : apiFunctions.length > 0
        ? `, 边缘 API 函数: ${apiFunctions.length} 个`
        : ''
    })`
  );

  // 若开启了 SCF 全栈业务后端，必须【先准备好并校验新后端版本】，成功后再写入部署清单并切换线上入口
  let backendManifestInfo = null;
  if (scfBackendEnabled) {
    // 统一版本保留计划：预检切流后活跃别名额度并回收超出保留窗口 (活跃版本 + 最近 5 个预览，总计 <= 8) 的旧预览版本，确保为新版本预留触发器名额
    const { protectedQualifiers } = await enforceProjectScfRetention({
      project,
      functionName: projCtx.backend.functionName,
      region: projCtx.backend.region || 'ap-guangzhou',
      upcomingAliases: aliases,
    });

    let remoteVars = {};
    try {
      remoteVars = await getRemoteProjectEnv(project);
    } catch {
      remoteVars = {};
    }
    const localVars = loadDevProjectEnv(project, cwd);
    const mergedEnvVars = { ...localVars, ...remoteVars };

    backendManifestInfo = await deployScfBackendVersion({
      project,
      cwd,
      targetDir: absTarget,
      backendConfig: projCtx.backend,
      envVars: mergedEnvVars,
      protectedQualifiers,
    });

    if (!projCtx.backend.gatewayToken && backendManifestInfo.gatewayToken) {
      ensureProjectConfig(cwd, {
        project,
        backend: {
          ...projCtx.backend,
          gatewayToken: backendManifestInfo.gatewayToken,
        },
      });
    }
  }

  let uploadedBlobs = 0;
  let reusedBlobs = 0;
  const manifestFiles = {};
  const manifestFunctions = {};

  const CONCURRENCY = 6;
  const fileResults = new Array(files.length);
  let cursor = 0;
  async function uploadWorker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const file = files[idx];
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
      fileResults[idx] = {
        relPath: file.relPath,
        entry: {
          sha256: hash,
          size: file.size,
          contentType,
        },
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => uploadWorker())
  );
  for (const item of fileResults) {
    if (item) manifestFiles[item.relPath] = item.entry;
  }

  const pendingFnUploads = [];

  for (const fn of apiFunctions) {
    transformEsmToFactorySource(fn.sourceCode, fn.relSource, true);
    const content = Buffer.from(fn.sourceCode, 'utf8');
    const hash = sha256Hex(content);
    const fnPoolKey = `functions/${hash}.json`;

    const fnRecord = {
      sha256: hash,
      project,
      route: fn.route,
      source: fn.relSource,
      code: fn.sourceCode,
      updatedAt: new Date().toISOString(),
    };
    pendingFnUploads.push({ fn, hash, fnPoolKey, fnRecord });

    manifestFunctions[fn.route] = {
      sha256: hash,
      entryBlob: hash,
      runtime: fn.upstreamUrl ? 'scf-url' : 'edge-js',
      ...(fn.upstreamUrl ? { upstreamUrl: fn.upstreamUrl } : {}),
      size: fn.size,
      source: fn.relSource,
    };
  }

  const treeSignature = JSON.stringify({
    project,
    files: manifestFiles,
    functions: manifestFunctions,
    backend: backendManifestInfo
      ? {
          functionName: backendManifestInfo.functionName,
          scfVersion: backendManifestInfo.scfVersion,
        }
      : null,
    ts: Date.now(),
  });
  const shortHash = sha256Hex(Buffer.from(treeSignature)).slice(0, 8);
  const deploymentId = `dpl_${shortHash}`;
  const immutableSubdomain =
    project && project !== 'default' ? `${project}-${shortHash}` : `dpl-${shortHash}`;

  const mutableAliases = Array.from(
    new Set(aliases.map(normalizeSubdomain).filter(Boolean))
  );
  const allSubdomains = [immutableSubdomain, ...mutableAliases.filter((s) => s !== immutableSubdomain)];

  if (apiFunctions.length > 0) {
    const [existingPool, envsPool] = await Promise.all([
      syncCloudFunctionsPool(),
      syncCloudEnvsPool(),
    ]);
    const candidatePool = { ...existingPool };
    for (const item of pendingFnUploads) {
      candidatePool[item.hash] = item.fnRecord;
    }

    const { code: apiWorkerCode, allRoutes } = generateProjectApiWorkerCode({
      project,
      silent: true,
      functionsPool: candidatePool,
      envsPool,
    });
    const mergedRoutes = Array.from(
      new Set([...Object.keys(manifestFunctions), ...(allRoutes || [])])
    );

    const apiTeoRes = await deployProjectApiFunctionToTeo({
      project,
      code: apiWorkerCode,
      hosts: allSubdomains,
      routes: mergedRoutes,
      remoteDomain,
    });

    for (const { fn, hash, fnPoolKey, fnRecord } of pendingFnUploads) {
      const existsInPool = await cosHeadObject(fnPoolKey);
      if (existsInPool) {
        reusedBlobs++;
        console.log(
          `  ⚡ [云函数私有归档复用] ${fn.route} (${fn.relSource}) (sha256: ${hash.slice(0, 8)})`
        );
      } else {
        await cosPutObject(
          fnPoolKey,
          JSON.stringify(fnRecord, null, 2),
          'application/json; charset=UTF-8',
          undefined,
          { acl: 'private' }
        );
        uploadedBlobs++;
        console.log(
          `  🔒 [云函数私有归档上传] ${fn.route} (${fn.relSource}) -> ${fnPoolKey.slice(0, 18)}... (${fn.size} B, ACL: private)`
        );
      }
    }
    saveLocalFunctionsPool(candidatePool);

    console.log(
      `  ⚡ [EdgeOne API 边缘函数同步] 已将项目 [${project}] 的 API 路由 (${Object.keys(
        manifestFunctions
      ).join(', ')}) 同步至边缘函数: ${apiTeoRes.functionName} (${apiTeoRes.functionId})`
    );
  }

  const manifest = {
    id: deploymentId,
    project,
    immutableSubdomain,
    createdAt: new Date().toISOString(),
    stats: {
      totalFiles: files.length,
      totalFunctions: apiFunctions.length,
      uploadedBlobs,
      reusedBlobs,
    },
    spaFallback: manifestFiles['/200.html']
      ? '/200.html'
      : manifestFiles['/index.html']
      ? '/index.html'
      : null,
    files: manifestFiles,
    functions: manifestFunctions,
    ...(backendManifestInfo ? { backend: backendManifestInfo } : {}),
  };

  await cosPutObject(
    `manifests/${deploymentId}.json`,
    JSON.stringify(manifest, null, 2),
    'application/json; charset=UTF-8'
  );

  const boundUrls = [`https://${immutableSubdomain}.${remoteDomain}`];
  for (const sub of mutableAliases) {
    if (!sub || sub === immutableSubdomain || sub === `dpl-${shortHash}`) continue;
    await setRemoteAlias(sub, deploymentId, { silent: true, skipVerify: true, project });
    boundUrls.push(`https://${sub}.${remoteDomain}`);
  }

  // 统一全栈版本保留计划：保留当前生产/别名版本 (含回滚指针) + 最近预览版本 (总计 <= 8)，原子化清理超出窗口的旧预览版本
  if (backendManifestInfo && backendManifestInfo.functionName) {
    await enforceProjectScfRetention({
      project,
      functionName: backendManifestInfo.functionName,
      region: backendManifestInfo.region || 'ap-guangzhou',
      extraProtectedDeploymentIds: [deploymentId],
    });
  }

  appendLocalProjectHistory(cwd, {
    id: deploymentId,
    project,
    immutableSubdomain,
    aliases: [...allSubdomains],
    urls: boundUrls,
    functions: Object.keys(manifestFunctions),
    ...(backendManifestInfo
      ? {
          backend: {
            provider: backendManifestInfo.provider,
            functionName: backendManifestInfo.functionName,
            scfVersion: backendManifestInfo.scfVersion,
            upstreamUrl: backendManifestInfo.upstreamUrl,
          },
        }
      : {}),
    createdAt: manifest.createdAt,
  });

  console.log(`\n✅ 云端部署完成! [项目: ${project}] Deployment ID: ${deploymentId}`);
  console.log(
    `   资源统计: 静态文件 ${files.length} 个${
      backendManifestInfo
        ? `, SCF 全栈后端: ${backendManifestInfo.functionName}@v${backendManifestInfo.scfVersion}`
        : `, 云函数 ${apiFunctions.length} 个`
    } (COS 新增上传 ${uploadedBlobs} 个, CAS 复用 ${reusedBlobs} 个)`
  );
  for (const u of boundUrls) {
    console.log(`   🌐 线上访问地址: ${u}`);
  }
  if (backendManifestInfo) {
    const primaryUrl = boundUrls[boundUrls.length - 1] || boundUrls[0] || '';
    console.log(
      `   🏭 业务后端服务: ${primaryUrl}${backendManifestInfo.prefix}/* -> ${backendManifestInfo.functionName} (SCF 不可变版本 v${backendManifestInfo.scfVersion})`
    );
    console.log(`   📋 后端日志查询: myship logs`);
  }
  for (const route of Object.keys(manifestFunctions)) {
    const primaryUrl = boundUrls[boundUrls.length - 1] || boundUrls[0] || '';
    console.log(`   ⚡ 云函数接口:   ${primaryUrl}${route}`);
  }

  emitGitHubActionsOutputs({
    deploymentId,
    immutableUrl: boundUrls[0] || '',
    primaryUrl: boundUrls[boundUrls.length - 1] || boundUrls[0] || '',
    boundUrls,
    functions: Object.keys(manifestFunctions),
  });

  return { deploymentId, immutableSubdomain, boundUrls, manifest };
}

export async function setRemoteAlias(
  subdomain,
  deploymentId,
  { silent = false, skipVerify = false, project = null } = {}
) {
  if (!/^dpl_[a-zA-Z0-9_-]+$/.test(String(deploymentId || ''))) {
    throw new Error(`无效的部署版本 ID: ${deploymentId}`);
  }
  const { remoteDomain } = assertCloudEndpointsConfigured();
  const cleanSub = normalizeSubdomain(subdomain);
  let inferredProject = project;

  if (!skipVerify) {
    const manifest = await cosGetJson(`manifests/${deploymentId}.json`);
    if (!manifest) {
      throw new Error(`云端 COS 中不存在目标部署版本: ${deploymentId}`);
    }
    const manifestProj = inferProjectFromRecord(manifest, null);
    if (project && manifestProj && manifestProj !== project) {
      throw new Error(
        `目标版本 (${deploymentId}) 属于项目 [${manifestProj}]，不能绑定到项目 [${project}] 的域名下`
      );
    }
    inferredProject = inferredProject || manifestProj || 'default';

    // 若目标部署版本包含全栈 SCF 后端，确保其对应不可变版本的 HTTP 触发器在线可用
    if (
      manifest.backend &&
      manifest.backend.provider === 'scf' &&
      manifest.backend.functionName &&
      manifest.backend.scfVersion
    ) {
      const protectedQualifiers = new Set([String(manifest.backend.scfVersion)]);
      try {
        const snap = await loadCasStateSnapshot({ isLocal: false, actionLabel: '读取活跃后端版本' });
        const activeDplIds = new Set(
          snap.allAliases
            .filter((a) => (a.project || inferredProject) === inferredProject)
            .flatMap((a) => [a.deploymentId, a.previousDeploymentId])
            .filter(Boolean)
        );
        for (const m of snap.allManifests) {
          if (activeDplIds.has(m.id) && m.backend && m.backend.scfVersion) {
            protectedQualifiers.add(String(m.backend.scfVersion));
          }
        }
      } catch {
        // ignore
      }
      const ensuredUrl = await ensureScfVersionHttpTrigger({
        functionName: manifest.backend.functionName,
        qualifier: manifest.backend.scfVersion,
        region: manifest.backend.region || 'ap-guangzhou',
        protectedQualifiers,
      });
      if (ensuredUrl && ensuredUrl !== manifest.backend.upstreamUrl) {
        manifest.backend.upstreamUrl = ensuredUrl;
        await cosPutObject(
          `manifests/${deploymentId}.json`,
          JSON.stringify(manifest, null, 2),
          'application/json; charset=UTF-8'
        );
      }
      if (!silent) {
        console.log(
          `  🏭 [全栈后端同步] 已锁定 SCF 不可变后端版本: ${manifest.backend.functionName}@v${manifest.backend.scfVersion}`
        );
      }
    }
  }

  const effectiveProject = inferredProject || inferProjectFromRecord({ subdomain: cleanSub });
  let previousDeploymentId = null;
  const aliasKey = `aliases/${cleanSub}.json`;
  const exists = await cosHeadObject(aliasKey);
  if (exists) {
    const existing = await cosGetJson(aliasKey);
    if (!existing || typeof existing !== 'object') {
      throw new Error(`读取云端现有域名指针失败 (${aliasKey})，已安全中止以防误覆盖`);
    }
    const existingProj = existing.project || null;
    if (existingProj && effectiveProject && existingProj !== effectiveProject) {
      throw new Error(
        `子域名 [${cleanSub}] 已被项目 [${existingProj}] 占用，不能被项目 [${effectiveProject}] 覆盖`
      );
    }
    if (existing.deploymentId && existing.deploymentId !== deploymentId) {
      previousDeploymentId = existing.deploymentId;
    } else if (existing.previousDeploymentId && existing.previousDeploymentId !== deploymentId) {
      previousDeploymentId = existing.previousDeploymentId;
    }
  }

  const aliasData = {
    subdomain: cleanSub,
    project: effectiveProject,
    deploymentId,
    ...(previousDeploymentId ? { previousDeploymentId } : {}),
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

  const manifestKeys = (await cosListKeys('manifests/')).filter((k) => k.endsWith('.json'));
  const rawManifests = await Promise.all(manifestKeys.map((k) => cosGetJson(k)));
  const manifests = [];
  for (let i = 0; i < manifestKeys.length; i++) {
    if (!rawManifests[i] || !rawManifests[i].id) {
      throw new Error(`回滚安全中止: 无法完整读取云端构建快照 (${manifestKeys[i]})`);
    }
    manifests.push(rawManifests[i]);
  }
  manifests.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const pool = effectiveProject
    ? manifests.filter((m) => inferProjectFromRecord(m) === effectiveProject)
    : manifests;

  const currentIdx = pool.findIndex((m) => m.id === currentDplId);
  const byPrevious = currentAlias.previousDeploymentId
    ? pool.find((m) => m.id === currentAlias.previousDeploymentId && m.id !== currentDplId)
    : null;
  const previousManifest =
    byPrevious ||
    (currentIdx >= 0 && currentIdx + 1 < pool.length
      ? pool[currentIdx + 1]
      : pool.find((m) => m.id !== currentDplId));

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

export function printFormattedState({
  modeLabel,
  domainSuffix,
  protocol,
  blobsCount,
  allManifests,
  allAliases,
  projectFilter,
  showAll,
}) {
  const immutableSubSet = new Set(
    allManifests.flatMap((m) => [m.immutableSubdomain, m.id?.replace(/^dpl_/, 'dpl-')]).filter(Boolean)
  );
  const mutableAliases = allAliases.filter(
    (a) =>
      a &&
      a.subdomain &&
      !immutableSubSet.has(a.subdomain) &&
      !a.subdomain.startsWith('dpl-')
  );

  if (!showAll && projectFilter) {
    const projManifests = allManifests.filter(
      (m) => inferProjectFromRecord(m) === projectFilter
    );
    const projDplIds = new Set(projManifests.map((m) => m.id));
    const projAliases = mutableAliases.filter(
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
        const fnRoutes = m.functions ? Object.keys(m.functions) : [];
        const scfSummary =
          m.backend && m.backend.scfVersion
            ? ` | SCF后端:${m.backend.functionName || 'scf'}@v${m.backend.scfVersion}`
            : '';
        const fnSummary =
          fnRoutes.length > 0 ? ` | 云函数:${fnRoutes.length} (${fnRoutes.join(', ')})` : '';
        console.log(
          `  - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles}${scfSummary}${fnSummary} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
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
  for (const a of mutableAliases) {
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
      const fnRoutes = m.functions ? Object.keys(m.functions) : [];
      const scfSummary =
        m.backend && m.backend.scfVersion
          ? ` | SCF后端:${m.backend.functionName || 'scf'}@v${m.backend.scfVersion}`
          : '';
      const fnSummary =
        fnRoutes.length > 0 ? ` | 云函数:${fnRoutes.length} (${fnRoutes.join(', ')})` : '';
      console.log(
        `     - ${m.id} (${m.immutableSubdomain}) | ${m.createdAt} | 文件:${m.stats.totalFiles}${scfSummary}${fnSummary} (新增:${m.stats.uploadedBlobs}, 复用:${m.stats.reusedBlobs})`
      );
    }
    console.log(`  🌐 绑定域名列表 (${group.aliases.length} 个):`);
    for (const a of group.aliases) {
      console.log(`     - ${protocol}://${a.subdomain}.${domainSuffix}  -->  ${a.deploymentId}`);
    }
  }
}

export async function listRemoteState({ projectFilter = null, showAll = false } = {}) {
  const { remoteDomain, blobKeys, allManifests, allAliases } = await loadCasStateSnapshot({
    isLocal: false,
    includeFunctionsKeys: false,
    actionLabel: '读取状态',
  });

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
