import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cosGetJson,
  assertCloudEndpointsConfigured,
} from './cos-client.mjs';
import { renderConsoleHtml } from './console-ui.mjs';
import {
  DEFAULT_STORAGE_DIR,
  normalizeDomainToken,
  normalizeSubdomain,
  detectProjectContext,
  resolveNamespacedSubdomain,
  inferProjectFromRecord,
  loadCasStateSnapshot,
} from './project-context.mjs';
import {
  assertValidEnvKey,
  maskEnvValue,
  getLocalProjectEnv,
  getRemoteProjectEnv,
} from './env-manager.mjs';
import { runEnvCommand } from './serverless.mjs';
import {
  setAlias,
  rollbackAlias,
  setRemoteAlias,
  rollbackRemoteAlias,
} from './core-cas.mjs';
import {
  gcState,
  gcRemoteState,
  removeResources,
} from './lifecycle.mjs';

export function computeManifestDiff(baseManifest, targetManifest) {
  if (!baseManifest || typeof baseManifest !== 'object') {
    throw new Error('缺少有效的基准构建快照 (baseManifest)');
  }
  if (!targetManifest || typeof targetManifest !== 'object') {
    throw new Error('缺少有效的目标构建快照 (targetManifest)');
  }

  const baseFiles = baseManifest.files || {};
  const targetFiles = targetManifest.files || {};
  const allFilePaths = Array.from(
    new Set([...Object.keys(baseFiles), ...Object.keys(targetFiles)])
  ).sort();

  const filesAdded = [];
  const filesModified = [];
  const filesDeleted = [];
  let filesUnchangedCount = 0;

  for (const path of allFilePaths) {
    const b = baseFiles[path];
    const t = targetFiles[path];
    if (!b && t) {
      filesAdded.push({
        path,
        sha256: t.sha256,
        size: t.size ?? 0,
        contentType: t.contentType || '',
      });
    } else if (b && !t) {
      filesDeleted.push({
        path,
        sha256: b.sha256,
        size: b.size ?? 0,
        contentType: b.contentType || '',
      });
    } else if (b && t) {
      if (b.sha256 !== t.sha256) {
        const beforeSize = b.size ?? 0;
        const afterSize = t.size ?? 0;
        filesModified.push({
          path,
          beforeSha256: b.sha256,
          afterSha256: t.sha256,
          beforeSize,
          afterSize,
          deltaBytes: afterSize - beforeSize,
          contentType: t.contentType || b.contentType || '',
        });
      } else {
        filesUnchangedCount++;
      }
    }
  }

  const baseFns = baseManifest.functions || {};
  const targetFns = targetManifest.functions || {};
  const allFnRoutes = Array.from(
    new Set([...Object.keys(baseFns), ...Object.keys(targetFns)])
  ).sort();

  const fnsAdded = [];
  const fnsModified = [];
  const fnsDeleted = [];
  let fnsUnchangedCount = 0;

  for (const route of allFnRoutes) {
    const b = baseFns[route];
    const t = targetFns[route];
    if (!b && t) {
      fnsAdded.push({
        route,
        sha256: t.sha256,
        runtime: t.runtime || 'edge-js',
        source: t.source || '',
        size: t.size ?? 0,
        upstreamUrl: t.upstreamUrl || null,
      });
    } else if (b && !t) {
      fnsDeleted.push({
        route,
        sha256: b.sha256,
        runtime: b.runtime || 'edge-js',
        source: b.source || '',
        size: b.size ?? 0,
        upstreamUrl: b.upstreamUrl || null,
      });
    } else if (b && t) {
      const bRuntime = b.runtime || 'edge-js';
      const tRuntime = t.runtime || 'edge-js';
      const bUpstream = b.upstreamUrl || null;
      const tUpstream = t.upstreamUrl || null;
      if (b.sha256 !== t.sha256 || bRuntime !== tRuntime || bUpstream !== tUpstream) {
        fnsModified.push({
          route,
          beforeSha256: b.sha256,
          afterSha256: t.sha256,
          beforeRuntime: bRuntime,
          afterRuntime: tRuntime,
          beforeUpstreamUrl: bUpstream,
          afterUpstreamUrl: tUpstream,
          source: t.source || b.source || '',
        });
      } else {
        fnsUnchangedCount++;
      }
    }
  }

  return {
    baseId: baseManifest.id,
    targetId: targetManifest.id,
    baseCreatedAt: baseManifest.createdAt || null,
    targetCreatedAt: targetManifest.createdAt || null,
    files: {
      added: filesAdded,
      modified: filesModified,
      deleted: filesDeleted,
      unchangedCount: filesUnchangedCount,
    },
    functions: {
      added: fnsAdded,
      modified: fnsModified,
      deleted: fnsDeleted,
      unchangedCount: fnsUnchangedCount,
    },
  };
}

async function loadConsoleStateData({
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  cwd = process.cwd(),
} = {}) {
  const ctx = detectProjectContext(cwd);
  const { domainSuffix, protocol, blobKeys, allManifests, allAliases } =
    await loadCasStateSnapshot({
      isLocal,
      storageDir,
      includeFunctionsKeys: false,
      actionLabel: '读取管控台状态',
    });

  const modeLabel = isLocal ? '本地沙盒 (.cas-storage)' : '腾讯云 COS + EdgeOne';
  const blobsCount = blobKeys.length;

  const immutableSubSet = new Set(
    allManifests
      .flatMap((m) => [m.immutableSubdomain, m.id?.replace(/^dpl_/, 'dpl-')])
      .filter(Boolean)
  );
  const mutableAliases = allAliases.filter(
    (a) =>
      a &&
      a.subdomain &&
      !immutableSubSet.has(a.subdomain) &&
      !a.subdomain.startsWith('dpl-')
  );

  const projectMap = new Map();
  function ensureGroup(name) {
    if (!projectMap.has(name)) {
      projectMap.set(name, { name, manifests: [], aliases: [] });
    }
    return projectMap.get(name);
  }

  const dplToProject = new Map();
  if (ctx.project) {
    ensureGroup(ctx.project);
  }
  for (const m of allManifests) {
    const p = inferProjectFromRecord(m, 'default');
    dplToProject.set(m.id, p);
    ensureGroup(p).manifests.push(m);
  }
  for (const a of mutableAliases) {
    const p = a.project || dplToProject.get(a.deploymentId) || inferProjectFromRecord(a, 'default');
    ensureGroup(p).aliases.push(a);
  }

  const projects = [...projectMap.values()].sort((a, b) => {
    if (a.name === 'default') return 1;
    if (b.name === 'default') return -1;
    return a.name.localeCompare(b.name);
  });

  return {
    isLocal,
    modeLabel,
    domainSuffix,
    protocol,
    defaultProject: ctx.project,
    blobsCount,
    manifestsCount: allManifests.length,
    aliasesCount: mutableAliases.length,
    projects,
    immutableSubSet,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  });
  res.end(body);
}

function isAllowedLocalOrigin(originHeader, hostHeader) {
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (hostHeader) {
    try {
      const hostUrl = new URL(`http://${hostHeader}`);
      if (!allowedHosts.has(hostUrl.hostname)) return false;
    } catch {
      return false;
    }
  }
  if (!originHeader) return true;
  try {
    const u = new URL(originHeader);
    if (!allowedHosts.has(u.hostname)) return false;
    if (hostHeader && u.host !== hostHeader) return false;
    return true;
  } catch {
    return false;
  }
}

async function readRequestBodyBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
}

export function createConsoleRequestHandler({
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  cwd = process.cwd(),
} = {}) {
  return async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = urlObj.pathname.replace(/^\/+/, '/') || '/';

      if (!isAllowedLocalOrigin(req.headers.origin, req.headers.host)) {
        return sendJson(res, 403, {
          ok: false,
          error: 'Forbidden: Cross-origin access to MyShip Console API is blocked.',
        });
      }

      if (pathname === '/' || pathname === '/index.html') {
        const ctx = detectProjectContext(cwd);
        const html = renderConsoleHtml({
          modeLabel: isLocal ? '本地沙盒 (.cas-storage)' : '腾讯云 COS + EdgeOne',
          defaultProject: ctx.project,
        });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(html);
        return;
      }

      if (!pathname.startsWith('/api/console/')) {
        return sendJson(res, 404, { ok: false, error: `Not Found: ${pathname}` });
      }

      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        if (req.headers['x-myship-console'] !== '1') {
          return sendJson(res, 403, {
            ok: false,
            error: 'Forbidden: Missing X-MyShip-Console protection header.',
          });
        }
      }

      let body = {};
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        const rawBuf = await readRequestBodyBuffer(req);
        if (rawBuf.length > 0) {
          try {
            body = JSON.parse(rawBuf.toString('utf8'));
          } catch {
            return sendJson(res, 400, { ok: false, error: '请求体不是合法的 JSON 格式' });
          }
        }
      }

      if (pathname === '/api/console/state' && method === 'GET') {
        const state = await loadConsoleStateData({ isLocal, storageDir, cwd });
        const { immutableSubSet, ...publicState } = state;
        return sendJson(res, 200, { ok: true, ...publicState });
      }

      if (pathname === '/api/console/diff' && method === 'GET') {
        const baseId = String(urlObj.searchParams.get('base') || '').trim();
        const targetId = String(urlObj.searchParams.get('target') || '').trim();
        if (
          !/^dpl_[a-zA-Z0-9_-]+$/.test(baseId) ||
          !/^dpl_[a-zA-Z0-9_-]+$/.test(targetId)
        ) {
          return sendJson(res, 400, { ok: false, error: '请提供合法的 base 与 target 版本 ID (dpl_*)' });
        }

        let baseManifest = null;
        let targetManifest = null;
        if (isLocal) {
          const basePath = resolve(storageDir, 'manifests', `${baseId}.json`);
          const targetPath = resolve(storageDir, 'manifests', `${targetId}.json`);
          if (existsSync(basePath)) baseManifest = JSON.parse(readFileSync(basePath, 'utf8'));
          if (existsSync(targetPath)) targetManifest = JSON.parse(readFileSync(targetPath, 'utf8'));
        } else {
          assertCloudEndpointsConfigured();
          [baseManifest, targetManifest] = await Promise.all([
            cosGetJson(`manifests/${baseId}.json`),
            cosGetJson(`manifests/${targetId}.json`),
          ]);
        }

        if (!baseManifest) {
          return sendJson(res, 404, { ok: false, error: `未找到基准构建快照: ${baseId}` });
        }
        if (!targetManifest) {
          return sendJson(res, 404, { ok: false, error: `未找到对比目标快照: ${targetId}` });
        }

        const diff = computeManifestDiff(baseManifest, targetManifest);
        return sendJson(res, 200, { ok: true, diff });
      }

      if (pathname === '/api/console/alias' && method === 'POST') {
        const project = normalizeDomainToken(body.project || '') || null;
        const rawSub = String(body.subdomain || '').trim();
        const deploymentId = String(body.deploymentId || '').trim();
        const isRaw = Boolean(body.raw);
        if (!rawSub || !deploymentId) {
          return sendJson(res, 400, { ok: false, error: '请提供 subdomain 与 deploymentId' });
        }

        const finalSub = resolveNamespacedSubdomain(rawSub, project, isRaw);
        const state = await loadConsoleStateData({ isLocal, storageDir, cwd });
        if (state.immutableSubSet.has(finalSub) || /^dpl-[0-9a-f]{8}$/.test(finalSub)) {
          return sendJson(res, 400, {
            ok: false,
            error: `不可变快照子域名 (${finalSub}) 受永久不可变保护，不能改写指向其他版本`,
          });
        }

        const alias = isLocal
          ? setAlias(finalSub, deploymentId, { storageDir, project })
          : await setRemoteAlias(finalSub, deploymentId, { project });
        return sendJson(res, 200, { ok: true, alias });
      }

      if (pathname === '/api/console/rollback' && method === 'POST') {
        const project = normalizeDomainToken(body.project || '') || null;
        const rawSub = String(body.subdomain || '').trim();
        const targetDeploymentId = body.targetDeploymentId
          ? String(body.targetDeploymentId).trim()
          : null;
        const finalSub = rawSub ? normalizeSubdomain(rawSub) : project || 'prod';

        const alias = isLocal
          ? rollbackAlias(finalSub, targetDeploymentId, { storageDir, project })
          : await rollbackRemoteAlias(finalSub, targetDeploymentId, { project });
        return sendJson(res, 200, { ok: true, alias });
      }

      if (pathname === '/api/console/env' && method === 'GET') {
        const project =
          normalizeDomainToken(urlObj.searchParams.get('project') || '') ||
          detectProjectContext(cwd).project;
        const reveal =
          urlObj.searchParams.get('reveal') === '1' ||
          urlObj.searchParams.get('reveal') === 'true';
        const rawVars = isLocal
          ? getLocalProjectEnv(project, storageDir)
          : await getRemoteProjectEnv(project);
        const outVars = {};
        for (const k of Object.keys(rawVars).sort()) {
          outVars[k] = reveal ? rawVars[k] : maskEnvValue(rawVars[k]);
        }
        return sendJson(res, 200, {
          ok: true,
          project,
          reveal,
          count: Object.keys(rawVars).length,
          vars: outVars,
        });
      }

      if (pathname === '/api/console/env' && method === 'POST') {
        const project =
          normalizeDomainToken(body.project || '') || detectProjectContext(cwd).project;
        const action = String(body.action || 'set').toLowerCase();
        if (action === 'set') {
          const key = assertValidEnvKey(body.key || '');
          const val = String(body.value ?? '');
          const updated = await runEnvCommand({
            subcommand: 'set',
            args: [`${key}=${val}`],
            project,
            isLocal,
            storageDir,
            cwd,
          });
          return sendJson(res, 200, {
            ok: true,
            project,
            count: Object.keys(updated).length,
          });
        }
        if (action === 'rm' || action === 'delete') {
          const key = assertValidEnvKey(body.key || '');
          const updated = await runEnvCommand({
            subcommand: 'rm',
            args: [key],
            project,
            isLocal,
            storageDir,
            cwd,
          });
          return sendJson(res, 200, {
            ok: true,
            project,
            count: Object.keys(updated).length,
          });
        }
        return sendJson(res, 400, { ok: false, error: `不支持的 env 操作: ${action}` });
      }

      if (pathname === '/api/console/gc' && method === 'POST') {
        const olderThan = body.olderThan ? String(body.olderThan).trim() : null;
        const parsedKeep =
          body.keepCount === 'all' || (olderThan && (body.keepCount === undefined || body.keepCount === null || body.keepCount === ''))
            ? Infinity
            : Math.max(Number.parseInt(body.keepCount, 10) || 10, 2);
        const projectFilter = body.project ? normalizeDomainToken(body.project) : null;
        const dryRun = Boolean(body.dryRun);

        const plan = isLocal
          ? gcState({ storageDir, keepCount: parsedKeep, olderThan, projectFilter, dryRun })
          : await gcRemoteState({ keepCount: parsedKeep, olderThan, projectFilter, dryRun });

        return sendJson(res, 200, {
          ok: true,
          dryRun,
          plan: {
            retainedManifestsCount: plan.retainedManifests.length,
            expiredManifestsCount: plan.expiredManifests.length,
            expiredManifestIds: plan.expiredManifests.map((m) => m.id),
            orphanBlobsCount: plan.orphanBlobKeys.length,
            orphanFnsCount: plan.orphanFnKeys.length,
            activeRoutes: plan.activeRoutes,
          },
        });
      }

      if (pathname === '/api/console/rm' && method === 'POST') {
        const rmType = String(body.type || 'deployment').toLowerCase();
        const project = body.project ? normalizeDomainToken(body.project) : null;
        const dryRun = Boolean(body.dryRun);
        const force = Boolean(body.force);

        if (rmType === 'alias') {
          const subdomain = String(body.subdomain || '').trim();
          if (!subdomain) {
            return sendJson(res, 400, { ok: false, error: '请提供要解绑的子域名 subdomain' });
          }
          const result = await removeResources({
            aliases: [subdomain],
            project,
            raw: body.raw !== false,
            dryRun,
            isLocal,
            storageDir,
          });
          return sendJson(res, 200, { ok: true, result });
        }

        if (rmType === 'project') {
          if (!project) {
            return sendJson(res, 400, { ok: false, error: '请提供要销毁的项目名 project' });
          }
          const result = await removeResources({
            purgeProject: project,
            dryRun,
            isLocal,
            storageDir,
          });
          return sendJson(res, 200, { ok: true, result });
        }

        if (rmType === 'deployment') {
          const dplIds = Array.isArray(body.deploymentIds)
            ? body.deploymentIds
            : body.deploymentId
            ? [body.deploymentId]
            : [];
          if (dplIds.length === 0) {
            return sendJson(res, 400, { ok: false, error: '请提供要删除的构建版本 ID (deploymentId)' });
          }
          const result = await removeResources({
            deploymentIds: dplIds,
            project,
            force,
            dryRun,
            isLocal,
            storageDir,
          });
          return sendJson(res, 200, { ok: true, result });
        }

        return sendJson(res, 400, { ok: false, error: `未知的删除类型: ${rmType}` });
      }

      return sendJson(res, 404, { ok: false, error: `Unknown Console API: ${method} ${pathname}` });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err.message || String(err) });
    }
  };
}

export async function startConsoleServer({
  port = 4200,
  host = '127.0.0.1',
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  cwd = process.cwd(),
} = {}) {
  const handler = createConsoleRequestHandler({ isLocal, storageDir, cwd });
  const server = http.createServer(handler);

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;
  console.log('==============================================================');
  console.log('🖥️  MyShip Console — 轻量单页 Web 可视化管控台已启动');
  console.log('==============================================================');
  console.log(`  🌐 管控台地址:   ${url} (仅绑定本机回环地址，密钥零公网暴露)`);
  console.log(
    `  📦 管控数据源:   ${isLocal ? `本地沙盒 (${storageDir})` : '腾讯云 COS + EdgeOne 生产池'}`
  );
  console.log('  ⚡ 支持能力:     多项目快照总览 / 0秒切流回滚 / 双版本 Diff / 环境变量热更新 / GC');
  console.log('==============================================================');

  return { server, port: actualPort, url };
}
