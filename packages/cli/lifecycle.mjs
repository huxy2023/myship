import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import {
  cosHeadObject,
  cosPutObject,
  cosDeleteObject,
  deployProjectApiFunctionToTeo,
} from './cos-client.mjs';
import {
  DEFAULT_STORAGE_DIR,
  ensureStorageDirs,
  normalizeDomainToken,
  normalizeSubdomain,
  resolveNamespacedSubdomain,
  inferProjectFromRecord,
  loadCasStateSnapshot,
} from './project-context.mjs';
import {
  loadLocalEnvsPool,
  saveLocalEnvsPool,
  syncCloudEnvsPool,
} from './env-manager.mjs';
import {
  loadLocalFunctionsPool,
  saveLocalFunctionsPool,
  syncCloudFunctionsPool,
  generateProjectApiWorkerCode,
} from './serverless.mjs';
import {
  cleanupScfResources,
  resolveScfFunctionName,
} from './scf-client.mjs';

export function parseOlderThanCutoffMs(spec, nowMs = Date.now()) {
  if (spec === null || spec === undefined || String(spec).trim() === '') {
    return null;
  }
  const raw = String(spec).trim();
  const relMatch = raw.match(
    /^(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)$/i
  );
  if (relMatch) {
    const val = Number.parseFloat(relMatch[1]);
    if (!Number.isFinite(val) || val < 0) {
      throw new Error(`无效的时间过滤参数: ${spec}`);
    }
    const unit = relMatch[2].toLowerCase();
    const mult = unit.startsWith('d')
      ? 86400_000
      : unit.startsWith('h')
      ? 3600_000
      : unit.startsWith('m')
      ? 60_000
      : 1000;
    return nowMs - Math.round(val * mult);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  throw new Error(
    `无效的时间过滤参数 (${spec})。支持相对时长 (如 30d, 7d, 24h, 60m) 或 ISO 日期 (如 2026-10-01)`
  );
}

export function computeGcPlan({
  allManifests = [],
  allAliases = [],
  blobKeys = [],
  fnKeys = [],
  keepCount = 10,
  olderThan = null,
  projectFilter = null,
  includeFnInBlobs = false,
}) {
  const beforeTimestampMs =
    typeof olderThan === 'number' ? olderThan : parseOlderThanCutoffMs(olderThan);

  const liveDplIds = new Set();
  const protectedDplIds = new Set();
  for (const a of allAliases) {
    if (a && a.deploymentId) {
      liveDplIds.add(a.deploymentId);
      protectedDplIds.add(a.deploymentId);
    }
    if (a && a.previousDeploymentId) {
      protectedDplIds.add(a.previousDeploymentId);
    }
  }

  const byProject = new Map();
  for (const m of allManifests) {
    if (!m || !m.id) continue;
    const proj = inferProjectFromRecord(m, 'default');
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(m);
  }

  const retainedManifests = [];
  const expiredManifests = [];

  for (const [proj, list] of byProject.entries()) {
    list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const effectiveKeep =
      keepCount === Infinity ? Infinity : Math.max(Number(keepCount) || 10, 2);
    const hasAnyLiveInProj = list.some((item) => liveDplIds.has(item.id));

    list.forEach((m, idx) => {
      const isTargetProject = !projectFilter || proj === projectFilter;
      if (!isTargetProject) {
        retainedManifests.push(m);
        return;
      }
      if (liveDplIds.has(m.id) || (!hasAnyLiveInProj && idx === 0)) {
        retainedManifests.push(m);
        return;
      }

      const createdMs = Date.parse(m.createdAt || '');
      const isExpiredByTime =
        beforeTimestampMs !== null && Number.isFinite(createdMs) && createdMs < beforeTimestampMs;
      const isExpiredByCount = idx >= effectiveKeep && !protectedDplIds.has(m.id);

      if (isExpiredByTime || isExpiredByCount) {
        expiredManifests.push(m);
      } else {
        retainedManifests.push(m);
      }
    });
  }

  const referencedBlobHashes = new Set();
  const referencedFnHashes = new Set();
  const activeRoutes = new Set();

  for (const m of retainedManifests) {
    for (const fileEntry of Object.values(m.files || {})) {
      if (fileEntry && fileEntry.sha256) {
        referencedBlobHashes.add(fileEntry.sha256);
      }
    }
    for (const [route, fnEntry] of Object.entries(m.functions || {})) {
      activeRoutes.add(route);
      if (fnEntry && fnEntry.sha256) {
        referencedFnHashes.add(fnEntry.sha256);
        if (includeFnInBlobs) {
          referencedBlobHashes.add(fnEntry.sha256);
        }
      }
    }
  }

  const orphanBlobKeys = blobKeys.filter((k) => !referencedBlobHashes.has(basename(k)));
  const orphanFnKeys = fnKeys.filter(
    (k) => k.endsWith('.json') && !referencedFnHashes.has(basename(k, '.json'))
  );

  return {
    retainedManifests,
    expiredManifests,
    referencedBlobHashes,
    referencedFnHashes,
    activeRoutes: [...activeRoutes].sort(),
    orphanBlobKeys,
    orphanFnKeys,
    beforeTimestampMs,
  };
}

export function gcState({
  storageDir = DEFAULT_STORAGE_DIR,
  keepCount = 10,
  olderThan = null,
  projectFilter = null,
  dryRun = false,
} = {}) {
  ensureStorageDirs(storageDir);
  const blobKeys = readdirSync(resolve(storageDir, 'blobs')).map((f) => `blobs/${f}`);
  const allManifests = readdirSync(resolve(storageDir, 'manifests'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'manifests', f), 'utf8')));
  const allAliases = readdirSync(resolve(storageDir, 'aliases'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(resolve(storageDir, 'aliases', f), 'utf8')));

  const plan = computeGcPlan({
    allManifests,
    allAliases,
    blobKeys,
    fnKeys: [],
    keepCount,
    olderThan,
    projectFilter,
    includeFnInBlobs: true,
  });

  const timeDesc = olderThan ? `, 清理早于 ${olderThan} 的历史快照` : '';
  console.log(
    `=== 🧹 MyShip 本地沙盒 GC 扫描报告 (每个项目保留最近 ${
      keepCount === Infinity ? '全部' : keepCount
    } 个版本${timeDesc}) ===`
  );
  console.log(
    `  🚀 构建快照 (manifests/): 总计 ${allManifests.length} 个 -> 保留 ${plan.retainedManifests.length} 个, 待清理过期快照 ${plan.expiredManifests.length} 个`
  );
  console.log(
    `  🗂️  CAS 数据块 (blobs/):   总计 ${blobKeys.length} 个 -> 活跃引用 ${
      blobKeys.length - plan.orphanBlobKeys.length
    } 个, 待回收孤儿块 ${plan.orphanBlobKeys.length} 个`
  );

  if (dryRun) {
    console.log('\n💡 [Dry-Run 预览模式] 未执行实际删除。去掉 --dry-run 即可立即清理。');
    return plan;
  }

  const expiredIdSet = new Set(plan.expiredManifests.map((m) => m.id));
  for (const a of allAliases) {
    if (a && a.previousDeploymentId && expiredIdSet.has(a.previousDeploymentId)) {
      const updatedAlias = { ...a };
      delete updatedAlias.previousDeploymentId;
      writeFileSync(
        resolve(storageDir, 'aliases', `${a.subdomain}.json`),
        JSON.stringify(updatedAlias, null, 2),
        'utf8'
      );
    }
  }
  for (const m of plan.expiredManifests) {
    rmSync(resolve(storageDir, 'manifests', `${m.id}.json`), { force: true });
  }
  for (const k of plan.orphanBlobKeys) {
    rmSync(resolve(storageDir, k), { force: true });
  }
  console.log(
    `\n✅ 本地沙盒 GC 完成！已清理 ${plan.expiredManifests.length} 个过期快照与 ${plan.orphanBlobKeys.length} 个孤儿数据块。`
  );
  return plan;
}

export async function gcRemoteState({
  keepCount = 10,
  olderThan = null,
  projectFilter = null,
  dryRun = false,
} = {}) {
  const { remoteDomain, blobKeys, fnKeys, allManifests, allAliases } = await loadCasStateSnapshot({
    isLocal: false,
    includeFunctionsKeys: true,
    actionLabel: 'GC',
  });

  const plan = computeGcPlan({
    allManifests,
    allAliases,
    blobKeys,
    fnKeys,
    keepCount,
    olderThan,
    projectFilter,
    includeFnInBlobs: false,
  });

  const timeDesc = olderThan ? `, 清理早于 ${olderThan} 的历史快照` : '';
  console.log(
    `=== 🧹 MyShip 云端 CAS 垃圾回收报告 (每个项目保留最近 ${
      keepCount === Infinity ? '全部' : keepCount
    } 个版本${timeDesc}${projectFilter ? `, 仅限项目 [${projectFilter}]` : ''}) ===`
  );
  console.log(
    `  🚀 构建快照 (manifests/):   总计 ${allManifests.length} 个 -> 保留 ${plan.retainedManifests.length} 个, 待清理过期快照 ${plan.expiredManifests.length} 个`
  );
  console.log(
    `  🗂️  静态文件块 (blobs/):     总计 ${blobKeys.length} 个 -> 活跃引用 ${
      blobKeys.length - plan.orphanBlobKeys.length
    } 个, 待回收孤儿块 ${plan.orphanBlobKeys.length} 个`
  );
  console.log(
    `  🔒 云函数归档 (functions/): 总计 ${fnKeys.length} 个 -> 活跃引用 ${
      fnKeys.length - plan.orphanFnKeys.length
    } 个, 待回收废弃函数 ${plan.orphanFnKeys.length} 个`
  );
  console.log(
    `  🛣️  活跃 API 路由配额占用:   ${plan.activeRoutes.length} / 15 个路径 (${
      plan.activeRoutes.length > 0 ? plan.activeRoutes.join(', ') : '无'
    })`
  );

  if (plan.expiredManifests.length > 0) {
    console.log(
      `     - 待清理过期快照: ${plan.expiredManifests
        .map((m) => `${m.id} (${m.immutableSubdomain || m.project || 'default'})`)
        .join(', ')}`
    );
  }
  if (plan.orphanFnKeys.length > 0) {
    console.log(
      `     - 待回收废弃函数归档: ${plan.orphanFnKeys
        .map((k) => basename(k, '.json').slice(0, 8))
        .join(', ')}`
    );
  }

  if (dryRun) {
    console.log('\n💡 [Dry-Run 预览模式] 未执行实际删除。去掉 --dry-run 即可执行清理。');
    return plan;
  }

  const expiredIdSet = new Set(plan.expiredManifests.map((m) => m.id));
  for (const a of allAliases) {
    if (a && a.previousDeploymentId && expiredIdSet.has(a.previousDeploymentId)) {
      const updatedAlias = { ...a };
      delete updatedAlias.previousDeploymentId;
      await cosPutObject(
        `aliases/${a.subdomain}.json`,
        JSON.stringify(updatedAlias, null, 2),
        'application/json; charset=UTF-8'
      );
    }
  }

  const keysToDelete = [
    ...plan.expiredManifests.map((m) => `manifests/${m.id}.json`),
    ...plan.orphanFnKeys,
    ...plan.orphanBlobKeys,
  ];

  if (keysToDelete.length > 0) {
    const CONCURRENCY = 6;
    let cursor = 0;
    async function deleteWorker() {
      while (cursor < keysToDelete.length) {
        const key = keysToDelete[cursor++];
        await cosDeleteObject(key);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, keysToDelete.length) }, () => deleteWorker())
    );
  }

  const localPool = loadLocalFunctionsPool();
  let localPruned = 0;
  for (const hash of Object.keys(localPool)) {
    if (!plan.referencedFnHashes.has(hash)) {
      delete localPool[hash];
      localPruned++;
    }
  }
  if (localPruned > 0) {
    saveLocalFunctionsPool(localPool);
  }

  const [syncedPool, syncedEnvs] =
    plan.activeRoutes.length > 0
      ? await Promise.all([syncCloudFunctionsPool(), syncCloudEnvsPool()])
      : [{}, {}];
  const { code } = generateProjectApiWorkerCode({
    project: 'myship',
    silent: true,
    functionsPool: syncedPool,
    envsPool: syncedEnvs,
  });
  await deployProjectApiFunctionToTeo({
    project: 'myship',
    code,
    routes: plan.activeRoutes,
    remoteDomain,
    replaceRoutes: true,
  });
  console.log(
    `  ⚡ [EdgeOne 配额同步] 已校验并同步统一 API 边缘函数路由池，当前活跃路由 (${
      plan.activeRoutes.length
    }/15): ${plan.activeRoutes.length > 0 ? plan.activeRoutes.join(', ') : '已清空并释放触发规则'}`
  );

  console.log(
    `\n✅ 云端 GC 清理完成！已回收 ${plan.expiredManifests.length} 个过期快照、${plan.orphanBlobKeys.length} 个孤儿静态块、${plan.orphanFnKeys.length} 个废弃函数归档。`
  );
  return plan;
}

export async function removeResources({
  deploymentIds = [],
  aliases = [],
  purgeProject = null,
  project = null,
  raw = false,
  force = false,
  dryRun = false,
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
} = {}) {
  const cleanPurgeProj = purgeProject ? normalizeDomainToken(purgeProject) : null;
  const cleanProj = project ? normalizeDomainToken(project) : null;

  const { remoteDomain, blobKeys, fnKeys, allManifests, allAliases } = await loadCasStateSnapshot({
    isLocal,
    storageDir,
    includeFunctionsKeys: !isLocal,
    actionLabel: '删除',
  });

  // 模式 A: 仅解绑子域名 (--alias)
  if (aliases.length > 0 && deploymentIds.length === 0 && !cleanPurgeProj) {
    const resolvedSubs = aliases.map((s) =>
      raw ? normalizeSubdomain(s) : resolveNamespacedSubdomain(s, cleanProj, false)
    );
    const toRemoveAliases = [];
    for (const sub of resolvedSubs) {
      const found = allAliases.find((a) => a.subdomain === sub);
      if (!found) {
        throw new Error(`未找到子域名绑定记录: ${sub}`);
      }
      if (!raw && cleanProj && found.project && found.project !== cleanProj) {
        throw new Error(
          `子域名 [${sub}] 属于项目 [${found.project}]，不属于当前项目 [${cleanProj}]，已拒绝删除`
        );
      }
      toRemoveAliases.push(found);
    }

    if (dryRun) {
      console.log(
        `🔍 [Dry-Run 预览] 将解绑移除 ${toRemoveAliases.length} 个子域名: ${toRemoveAliases
          .map((a) => a.subdomain)
          .join(', ')}`
      );
      return {
        mode: 'alias',
        dryRun: true,
        removedAliases: toRemoveAliases.map((a) => a.subdomain),
        removedManifests: [],
        orphanBlobsCount: 0,
        orphanFnsCount: 0,
      };
    }

    for (const a of toRemoveAliases) {
      if (isLocal) {
        rmSync(resolve(storageDir, 'aliases', `${a.subdomain}.json`), { force: true });
      } else {
        await cosDeleteObject(`aliases/${a.subdomain}.json`);
      }
    }
    console.log(
      `✅ 已解绑并移除子域名路由: ${toRemoveAliases.map((a) => a.subdomain).join(', ')}`
    );
    return {
      mode: 'alias',
      dryRun: false,
      removedAliases: toRemoveAliases.map((a) => a.subdomain),
      removedManifests: [],
      orphanBlobsCount: 0,
      orphanFnsCount: 0,
    };
  }

  // 模式 B & C: 删除指定构建快照 (deploymentIds) 或彻底销毁整个项目 (cleanPurgeProj)
  const manifestsToRemove = [];
  const aliasesToRemove = [];
  let deleteProjectEnv = false;

  if (cleanPurgeProj) {
    for (const m of allManifests) {
      if (inferProjectFromRecord(m, 'default') === cleanPurgeProj) {
        manifestsToRemove.push(m);
      }
    }
    const projDplSet = new Set(manifestsToRemove.map((m) => m.id));
    for (const a of allAliases) {
      const aProj =
        a.project ||
        (projDplSet.has(a.deploymentId) ? cleanPurgeProj : inferProjectFromRecord(a, 'default'));
      if (aProj === cleanPurgeProj || projDplSet.has(a.deploymentId)) {
        aliasesToRemove.push(a);
      }
    }
    if (isLocal) {
      deleteProjectEnv = existsSync(resolve(storageDir, 'envs', `${cleanPurgeProj}.json`));
    } else {
      deleteProjectEnv = await cosHeadObject(`envs/${cleanPurgeProj}.json`);
    }

    if (manifestsToRemove.length === 0 && aliasesToRemove.length === 0 && !deleteProjectEnv) {
      throw new Error(`未找到项目 [${cleanPurgeProj}] 的任何构建快照、域名或环境变量记录`);
    }
  } else if (deploymentIds.length > 0) {
    const uniqueIds = Array.from(new Set(deploymentIds.map((id) => String(id || '').trim())));
    for (const dplId of uniqueIds) {
      if (!/^dpl_[a-zA-Z0-9_-]+$/.test(dplId)) {
        throw new Error(`无效的构建版本 ID: ${dplId}`);
      }
      const m = allManifests.find((item) => item.id === dplId);
      if (!m) {
        throw new Error(`未找到构建版本快照: ${dplId}`);
      }
      const mProj = inferProjectFromRecord(m, 'default');
      if (cleanProj && mProj !== cleanProj) {
        throw new Error(
          `构建版本 [${dplId}] 属于项目 [${mProj}]，不属于指定项目 [${cleanProj}]`
        );
      }

      const activeBoundAliases = allAliases.filter((a) => a.deploymentId === dplId);
      if (activeBoundAliases.length > 0 && !force) {
        throw new Error(
          `构建版本 [${dplId}] 当前正在线上服役（绑定于子域名: ${activeBoundAliases
            .map((a) => a.subdomain)
            .join(', ')}）。为防止线上站点 404，请先将域名切流至其他版本，或加 --force 连同绑定域名一起移除。`
        );
      }
      for (const a of activeBoundAliases) {
        if (!aliasesToRemove.some((x) => x.subdomain === a.subdomain)) {
          aliasesToRemove.push(a);
        }
      }
      manifestsToRemove.push(m);
    }
  } else {
    throw new Error(
      '请指定要删除的版本 ID (myship rm <dpl_id>)、子域名 (--alias <sub>) 或整个项目 (--project <name>)'
    );
  }

  const removeManifestIds = new Set(manifestsToRemove.map((m) => m.id));
  const removeAliasSubs = new Set(aliasesToRemove.map((a) => a.subdomain));
  const remainingManifests = allManifests.filter((m) => !removeManifestIds.has(m.id));
  const remainingAliases = allAliases.filter((a) => !removeAliasSubs.has(a.subdomain));

  const orphanPlan = computeGcPlan({
    allManifests: remainingManifests,
    allAliases: remainingAliases,
    blobKeys,
    fnKeys,
    keepCount: Infinity,
    includeFnInBlobs: isLocal,
  });

  if (dryRun) {
    console.log(
      `🔍 [Dry-Run 预览] 将删除 ${manifestsToRemove.length} 个构建快照、${
        aliasesToRemove.length
      } 个子域名指针${deleteProjectEnv ? `、项目 [${cleanPurgeProj}] 环境变量` : ''}，并回收 ${
        orphanPlan.orphanBlobKeys.length
      } 个孤儿静态块与 ${orphanPlan.orphanFnKeys.length} 个废弃云函数。`
    );
    return {
      mode: cleanPurgeProj ? 'project' : 'deployment',
      dryRun: true,
      project: cleanPurgeProj || cleanProj,
      removedAliases: aliasesToRemove.map((a) => a.subdomain),
      removedManifests: manifestsToRemove.map((m) => m.id),
      deletedProjectEnv: deleteProjectEnv,
      orphanBlobsCount: orphanPlan.orphanBlobKeys.length,
      orphanFnsCount: orphanPlan.orphanFnKeys.length,
      activeRoutes: orphanPlan.activeRoutes,
    };
  }

  for (const a of remainingAliases) {
    if (a.previousDeploymentId && removeManifestIds.has(a.previousDeploymentId)) {
      const updated = { ...a };
      delete updated.previousDeploymentId;
      if (isLocal) {
        writeFileSync(
          resolve(storageDir, 'aliases', `${a.subdomain}.json`),
          JSON.stringify(updated, null, 2),
          'utf8'
        );
      } else {
        await cosPutObject(
          `aliases/${a.subdomain}.json`,
          JSON.stringify(updated, null, 2),
          'application/json; charset=UTF-8'
        );
      }
    }
  }

  if (isLocal) {
    for (const a of aliasesToRemove) {
      rmSync(resolve(storageDir, 'aliases', `${a.subdomain}.json`), { force: true });
    }
    for (const m of manifestsToRemove) {
      rmSync(resolve(storageDir, 'manifests', `${m.id}.json`), { force: true });
    }
    if (cleanPurgeProj && deleteProjectEnv) {
      rmSync(resolve(storageDir, 'envs', `${cleanPurgeProj}.json`), { force: true });
    }
    for (const k of orphanPlan.orphanBlobKeys) {
      rmSync(resolve(storageDir, k), { force: true });
    }
  } else {
    const keysToDelete = [
      ...aliasesToRemove.map((a) => `aliases/${a.subdomain}.json`),
      ...manifestsToRemove.map((m) => `manifests/${m.id}.json`),
      ...(cleanPurgeProj && deleteProjectEnv ? [`envs/${cleanPurgeProj}.json`] : []),
      ...orphanPlan.orphanFnKeys,
      ...orphanPlan.orphanBlobKeys,
    ];

    if (keysToDelete.length > 0) {
      const CONCURRENCY = 6;
      let cursor = 0;
      async function deleteWorker() {
        while (cursor < keysToDelete.length) {
          const key = keysToDelete[cursor++];
          await cosDeleteObject(key);
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, keysToDelete.length) }, () => deleteWorker())
      );
    }

    if (cleanPurgeProj && deleteProjectEnv) {
      const localEnvs = loadLocalEnvsPool();
      if (localEnvs[cleanPurgeProj]) {
        delete localEnvs[cleanPurgeProj];
        saveLocalEnvsPool(localEnvs);
      }
    }

    const localPool = loadLocalFunctionsPool();
    let localPruned = 0;
    for (const hash of Object.keys(localPool)) {
      if (!orphanPlan.referencedFnHashes.has(hash)) {
        delete localPool[hash];
        localPruned++;
      }
    }
    if (localPruned > 0) {
      saveLocalFunctionsPool(localPool);
    }

    const hadFunctionsInvolved =
      orphanPlan.orphanFnKeys.length > 0 ||
      deleteProjectEnv ||
      manifestsToRemove.some((m) => Object.keys(m.functions || {}).length > 0);

    if (hadFunctionsInvolved) {
      const [syncedPool, syncedEnvs] =
        orphanPlan.activeRoutes.length > 0
          ? await Promise.all([syncCloudFunctionsPool(), syncCloudEnvsPool()])
          : [{}, {}];
      const { code } = generateProjectApiWorkerCode({
        project: 'myship',
        silent: true,
        functionsPool: syncedPool,
        envsPool: syncedEnvs,
      });
      await deployProjectApiFunctionToTeo({
        project: 'myship',
        code,
        routes: orphanPlan.activeRoutes,
        remoteDomain,
        replaceRoutes: true,
      });
    }

    // 联动清理 SCF 云函数或历史版本
    if (cleanPurgeProj) {
      const scfManifest = manifestsToRemove.find((m) => m.backend && m.backend.functionName);
      if (scfManifest) {
        await cleanupScfResources({
          functionName: scfManifest.backend.functionName || resolveScfFunctionName(cleanPurgeProj),
          region: scfManifest.backend.region || 'ap-guangzhou',
          deleteEntireFunction: true,
        });
      }
    } else {
      const retainedScfVers = new Set(
        remainingManifests
          .filter((m) => m.backend && m.backend.functionName && m.backend.scfVersion)
          .map((m) => `${m.backend.functionName}:${m.backend.scfVersion}`)
      );
      const byFn = new Map();
      for (const m of manifestsToRemove) {
        if (m.backend && m.backend.functionName && m.backend.scfVersion) {
          const key = `${m.backend.functionName}:${m.backend.scfVersion}`;
          if (!retainedScfVers.has(key)) {
            const fnName = m.backend.functionName;
            if (!byFn.has(fnName)) {
              byFn.set(fnName, { region: m.backend.region || 'ap-guangzhou', versions: new Set() });
            }
            byFn.get(fnName).versions.add(String(m.backend.scfVersion));
          }
        }
      }
      for (const [fnName, info] of byFn.entries()) {
        await cleanupScfResources({
          functionName: fnName,
          region: info.region,
          removeVersions: [...info.versions],
        });
      }
    }
  }

  console.log(
    `✅ 清理完成！已移除 ${manifestsToRemove.length} 个构建快照、${
      aliasesToRemove.length
    } 个子域名指针${deleteProjectEnv ? `、项目 [${cleanPurgeProj}] 环境变量` : ''}，并自动回收 ${
      orphanPlan.orphanBlobKeys.length
    } 个独占静态块与 ${orphanPlan.orphanFnKeys.length} 个云函数。`
  );

  return {
    mode: cleanPurgeProj ? 'project' : 'deployment',
    dryRun: false,
    project: cleanPurgeProj || cleanProj,
    removedAliases: aliasesToRemove.map((a) => a.subdomain),
    removedManifests: manifestsToRemove.map((m) => m.id),
    deletedProjectEnv: deleteProjectEnv,
    orphanBlobsCount: orphanPlan.orphanBlobKeys.length,
    orphanFnsCount: orphanPlan.orphanFnKeys.length,
    activeRoutes: orphanPlan.activeRoutes,
  };
}
