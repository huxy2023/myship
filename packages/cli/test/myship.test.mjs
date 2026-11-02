import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deployDirectory,
  setAlias,
  rollbackAlias,
  detectProjectContext,
  setupCiWorkflow,
  parseDotEnv,
  formatDotEnv,
  maskEnvValue,
  validateEdgeFunctionCompliance,
  createDevRequestHandler,
  parseOlderThanCutoffMs,
  removeResources,
  gcState,
  gcRemoteState,
  runEnvCommand,
  computeManifestDiff,
  startConsoleServer,
  runBackendCommand,
  bundleScfBackend,
  createLocalPersistentStorage,
  createLocalFileStorage,
  createDatabaseClient,
  closeDatabasePools,
  runUseCommand,
  resolveProjectResourceEnv,
} from '../myship.mjs';
import { renderConsoleHtml } from '../console-ui.mjs';
import { handleEdgeRequest } from '../../edge-gateway/local-gateway.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

test('1. Package & module integrity: npm pack includes all CLI modules and excludes tests', () => {
  const cliDir = resolve(__dirname, '..');
  const cliModules = readdirSync(cliDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `packages/cli/${f}`)
    .sort();

  const packRes = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(packRes.status, 0, `npm pack --dry-run failed: ${packRes.stderr}`);
  const packInfo = JSON.parse(packRes.stdout);
  const packedFiles = new Set(packInfo[0].files.map((f) => f.path));

  for (const modPath of cliModules) {
    assert(
      packedFiles.has(modPath),
      `Published package files whitelist is missing module: ${modPath}`
    );
  }
  for (const p of packedFiles) {
    assert(
      !p.startsWith('packages/cli/test/'),
      `Test file should not be included in published tarball: ${p}`
    );
  }

  // Verify actual npm pack tarball can be extracted and executed in an isolated temp folder
  const packTmp = mkdtempSync(join(tmpdir(), 'myship-test-pack-'));
  try {
    const realPack = spawnSync('npm', ['pack', '--pack-destination', packTmp], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(realPack.status, 0, `npm pack failed: ${realPack.stderr}`);
    const tgzName = realPack.stdout.trim().split(/\r?\n/).pop();
    const tarRes = spawnSync('tar', ['-xzf', join(packTmp, tgzName), '-C', packTmp], {
      encoding: 'utf8',
    });
    assert.equal(tarRes.status, 0, `tar extract failed: ${tarRes.stderr}`);

    const verRes = spawnSync('node', [join(packTmp, 'package/packages/cli/myship.mjs'), '--version'], {
      cwd: packTmp,
      encoding: 'utf8',
    });
    assert.equal(verRes.status, 0, `Unpacked myship --version failed: ${verRes.stderr}`);
    assert.match(verRes.stdout, /^myship v\d+\.\d+\.\d+/);
  } finally {
    rmSync(packTmp, { recursive: true, force: true });
  }
});

test('2. Core CAS engine: deduplication, rollback, and cross-project alias collision protection', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-cas-'));
  const storageDir = join(tmpRoot, '.cas-storage');
  const srcDir = join(tmpRoot, 'src');
  mkdirSync(srcDir, { recursive: true });

  try {
    writeFileSync(join(srcDir, 'shared.txt'), 'immutable shared blob');
    writeFileSync(join(srcDir, 'index.html'), '<h1>V1</h1>');
    const dpl1 = deployDirectory(srcDir, {
      storageDir,
      project: 'app',
      aliases: ['app'],
    });
    assert.equal(dpl1.manifest.stats.uploadedBlobs, 2);
    assert.equal(dpl1.manifest.stats.reusedBlobs, 0);

    writeFileSync(join(srcDir, 'index.html'), '<h1>V2</h1>');
    const dpl2 = deployDirectory(srcDir, {
      storageDir,
      project: 'app',
      aliases: ['app'],
    });
    assert.equal(dpl2.manifest.stats.uploadedBlobs, 1);
    assert.equal(dpl2.manifest.stats.reusedBlobs, 1);

    const rolled = rollbackAlias('app', null, { storageDir, project: 'app' });
    assert.equal(rolled.deploymentId, dpl1.deploymentId);

    // Cross-project collision check: project 'app-test' owns 'app-test'
    deployDirectory(srcDir, {
      storageDir,
      project: 'app-test',
      aliases: ['app-test'],
    });
    assert.throws(
      () => setAlias('app-test', dpl2.deploymentId, { storageDir, project: 'app' }),
      /已被项目 \[app-test\] 占用/
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('3. Project context & CI workflow generator: Vite public/ handling and workflow idempotency', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-ci-'));
  try {
    // Case A: Build project (has scripts.build) with root index.html and public/logo.svg, before dist/ is built
    const viteDir = join(tmpRoot, 'vite-app');
    mkdirSync(join(viteDir, 'public'), { recursive: true });
    writeFileSync(
      join(viteDir, 'package.json'),
      JSON.stringify({ name: 'vite-app', scripts: { build: 'vite build' } })
    );
    writeFileSync(join(viteDir, 'index.html'), '<!doctype html>');
    writeFileSync(join(viteDir, 'public', 'logo.svg'), '<svg></svg>');

    const ctxVite = detectProjectContext(viteDir);
    assert.equal(ctxVite.buildDir, './dist', 'Build project should not mistake public/ for buildDir');

    const ciRes1 = setupCiWorkflow(viteDir, {});
    assert.equal(ciRes1.buildDir, './dist');
    assert.equal(ciRes1.preservedExistingWorkflow, false);

    // User customizes workflow -> re-running without overwrite preserves custom content
    writeFileSync(ciRes1.workflowPath, '# custom workflow\n', 'utf8');
    const ciRes2 = setupCiWorkflow(viteDir, { overwrite: false });
    assert.equal(ciRes2.preservedExistingWorkflow, true);
    assert.equal(readFileSync(ciRes1.workflowPath, 'utf8'), '# custom workflow\n');

    // Re-running with overwrite=true regenerates workflow
    const ciRes3 = setupCiWorkflow(viteDir, { overwrite: true });
    assert.equal(ciRes3.preservedExistingWorkflow, false);
    assert(readFileSync(ciRes1.workflowPath, 'utf8').includes('MYSHIP_DIR: "./dist"'));

    // Case B: Pure static project (no scripts.build) with root index.html
    const staticDir = join(tmpRoot, 'static-app');
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<h1>Static</h1>');
    const staticCi = setupCiWorkflow(staticDir, {});
    assert.equal(staticCi.buildDir, '.');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('4. Serverless compilation, V8 compliance, .env parsing, and Dev Server', async () => {
  const parsed = parseDotEnv('export API_KEY="secret\\nval"\nPLAIN=123 # comment\n');
  assert.deepEqual(parsed, { API_KEY: 'secret\nval', PLAIN: '123' });
  assert.equal(maskEnvValue('abcd'), '****');
  assert.equal(maskEnvValue('abcdefghij'), 'abc****ij');
  assert.deepEqual(parseDotEnv(formatDotEnv(parsed)), parsed);

  assert.throws(
    () => validateEdgeFunctionCompliance('import fs from "node:fs"; export function GET() {}'),
    /EdgeOne V8 规范拦截/
  );

  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-dev-'));
  const apiDir = join(tmpRoot, 'api');
  mkdirSync(apiDir, { recursive: true });
  try {
    writeFileSync(join(tmpRoot, '.env'), 'GREETING=HelloFromDotEnv\n');
    writeFileSync(join(tmpRoot, 'index.html'), '<h1>Home</h1>');
    writeFileSync(
      join(apiDir, 'hello.js'),
      'export function GET(req, ctx) { return { msg: ctx.env.GREETING, envVar: process.env.GREETING }; }'
    );

    const handler = createDevRequestHandler({
      staticDir: tmpRoot,
      cwd: tmpRoot,
      project: 'dev-demo',
      storageDir: join(tmpRoot, '.cas-storage'),
    });

    const apiRes = await handler(new Request('http://localhost:3000/api/hello'));
    assert.equal(apiRes.status, 200);
    const apiBody = await apiRes.json();
    assert.equal(apiBody.msg, 'HelloFromDotEnv');
    assert.equal(apiBody.envVar, 'HelloFromDotEnv');

    // Sensitive file access (.env) must be blocked with 404 or SPA fallback, never leaking .env content
    const envRes = await handler(new Request('http://localhost:3000/.env'));
    assert.equal(envRes.status, 404);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('5. Lifecycle cleanup (rm & gc --older-than) and Console HTTP API', async () => {
  const fixedNow = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(parseOlderThanCutoffMs('7d', fixedNow), fixedNow - 7 * 86400_000);
  assert.equal(parseOlderThanCutoffMs('2026-10-01', fixedNow), Date.parse('2026-10-01'));

  const html = renderConsoleHtml({ defaultProject: 'app', modeLabel: 'LOCAL' });
  assert(html.includes("const keepCount = olderThan\n        ? 'all'"));

  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-lifecycle-'));
  const storageDir = join(tmpRoot, '.cas-storage');
  const srcDir = join(tmpRoot, 'src');
  mkdirSync(srcDir, { recursive: true });

  try {
    writeFileSync(join(srcDir, 'shared.txt'), 'shared across versions');
    writeFileSync(join(srcDir, 'v1.txt'), 'v1 exclusive');
    const dpl1 = deployDirectory(srcDir, {
      storageDir,
      project: 'app',
      aliases: ['app', 'app-staging'],
    });
    const v1BlobHash = dpl1.manifest.files['/v1.txt'].sha256;
    const sharedBlobHash = dpl1.manifest.files['/shared.txt'].sha256;

    await new Promise((r) => setTimeout(r, 15));
    rmSync(join(srcDir, 'v1.txt'));
    writeFileSync(join(srcDir, 'v2.txt'), 'v2 exclusive');
    const dpl2 = deployDirectory(srcDir, {
      storageDir,
      project: 'app',
      aliases: ['app'],
    });

    // Unbind staging alias so dpl1 is no longer active
    await removeResources({
      aliases: ['staging'],
      project: 'app',
      isLocal: true,
      storageDir,
    });

    // Deleting active dpl2 without force must fail
    await assert.rejects(
      () =>
        removeResources({
          deploymentIds: [dpl2.deploymentId],
          isLocal: true,
          storageDir,
        }),
      /当前正在线上服役/
    );

    // Deleting inactive dpl1 succeeds, reclaims v1BlobHash, preserves sharedBlobHash, and cleans dangling previousDeploymentId
    const rmDpl1 = await removeResources({
      deploymentIds: [dpl1.deploymentId],
      isLocal: true,
      storageDir,
    });
    assert.deepEqual(rmDpl1.removedManifests, [dpl1.deploymentId]);
    assert.equal(existsSync(join(storageDir, 'blobs', v1BlobHash)), false);
    assert.equal(existsSync(join(storageDir, 'blobs', sharedBlobHash)), true);
    const updatedAppAlias = JSON.parse(
      readFileSync(join(storageDir, 'aliases', 'app.json'), 'utf8')
    );
    assert.equal(updatedAppAlias.previousDeploymentId, undefined);

    // Deploy 11 more versions of 'app' (total 12 versions within today) + 1 old project 'old-proj'
    for (let i = 3; i <= 13; i++) {
      writeFileSync(join(srcDir, 'v2.txt'), `v${i} content`);
      deployDirectory(srcDir, {
        storageDir,
        project: 'app',
        aliases: ['app'],
      });
    }

    writeFileSync(join(srcDir, 'old.txt'), 'old project exclusive');
    const dplOld = deployDirectory(srcDir, {
      storageDir,
      project: 'old-proj',
      aliases: ['old-proj'],
    });
    await runEnvCommand({
      subcommand: 'set',
      args: ['SECRET=123'],
      project: 'old-proj',
      isLocal: true,
      storageDir,
    });

    const { server, url } = await startConsoleServer({
      port: 0,
      isLocal: true,
      storageDir,
      cwd: tmpRoot,
    });

    try {
      // Cross-origin protection
      const forbiddenOrigin = await fetch(`${url}/api/console/state`, {
        headers: { Origin: 'https://evil.example.com' },
      });
      assert.equal(forbiddenOrigin.status, 403);

      // Missing X-MyShip-Console header on POST
      const forbiddenCsrf = await fetch(`${url}/api/console/gc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(forbiddenCsrf.status, 403);

      // Time-based GC via Console (keepCount: 'all', olderThan: '30d') must expire 0 snapshots from today's 12 versions
      const gcTimeRes = await fetch(`${url}/api/console/gc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MyShip-Console': '1',
        },
        body: JSON.stringify({ keepCount: 'all', olderThan: '30d', dryRun: true }),
      });
      const gcTimeJson = await gcTimeRes.json();
      assert.equal(gcTimeJson.ok, true);
      assert.equal(gcTimeJson.plan.expiredManifestsCount, 0);

      // Purge 'old-proj' via Console API
      const purgeRes = await fetch(`${url}/api/console/rm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MyShip-Console': '1',
        },
        body: JSON.stringify({ type: 'project', project: 'old-proj' }),
      });
      const purgeJson = await purgeRes.json();
      assert.equal(purgeJson.ok, true);
      assert.deepEqual(purgeJson.result.removedManifests, [dplOld.deploymentId]);
      assert.equal(existsSync(join(storageDir, 'envs', 'old-proj.json')), false);
    } finally {
      server.close();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('6. Fail-closed cloud abort before delete & live frontend runGc request payload', async () => {
  // Part A: Execute frontend <script> in VM and verify runGc() sends keepCount: 'all' when olderThan is selected
  const html = renderConsoleHtml({ defaultProject: 'app', modeLabel: 'LOCAL' });
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(scriptMatch, 'Console HTML must contain <script>');

  const elements = {
    gcOlderThanSelect: { value: '30d', style: {} },
    gcKeepInput: { value: '10', disabled: false, style: {}, title: '' },
    gcResultBox: { textContent: '', innerHTML: '' },
    toast: { textContent: '', style: {} },
  };
  let capturedGcPayload = null;

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) => elements[id] || { value: '', style: {}, innerHTML: '', textContent: '' },
    },
    fetch: async (url, opts = {}) => {
      if (url === '/api/console/gc') {
        capturedGcPayload = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            ok: true,
            plan: {
              expiredManifestsCount: 0,
              orphanBlobsCount: 0,
              orphanFnsCount: 0,
              activeRoutes: [],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ ok: true, projects: [], defaultProject: 'app' }),
      };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
  };

  vm.runInNewContext(scriptMatch[1], sandbox);
  sandbox.onGcOlderThanChange();
  assert.equal(elements.gcKeepInput.disabled, true, 'gcKeepInput should be disabled when olderThan is set');
  await sandbox.runGc(true);
  assert.deepEqual(capturedGcPayload, {
    keepCount: 'all',
    olderThan: '30d',
    dryRun: true,
  });

  // Part B: Simulate COS returning incomplete/corrupted manifest during GC and rm -> must abort before any DELETE/PUT
  const writeRequests = [];
  let responseMode = 'incomplete';
  const mockCosServer = http.createServer((req, res) => {
    if (req.method === 'DELETE' || req.method === 'PUT') {
      writeRequests.push(`${req.method} ${req.url}`);
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && u.pathname === '/') {
      const prefix = u.searchParams.get('prefix') || '';
      let key = 'blobs/abc12345';
      if (prefix === 'manifests/') key = 'manifests/dpl_broken01.json';
      else if (prefix === 'aliases/') key = 'aliases/app.json';
      else if (prefix === 'functions/') key = 'functions/fn1.json';
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`
      );
      return;
    }
    if (req.method === 'GET' && u.pathname === '/manifests/dpl_broken01.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(responseMode === 'invalid-json' ? '{corrupted-json' : JSON.stringify({ broken: true }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/aliases/app.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ subdomain: 'app', deploymentId: 'dpl_broken01' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolvePromise) => mockCosServer.listen(0, '127.0.0.1', resolvePromise));
  const cosPort = mockCosServer.address().port;

  const prevEnv = {
    COS_ORIGIN: process.env.COS_ORIGIN,
    SHIP_REMOTE_DOMAIN: process.env.SHIP_REMOTE_DOMAIN,
    MYSHIP_SECRET_ID: process.env.MYSHIP_SECRET_ID,
    MYSHIP_SECRET_KEY: process.env.MYSHIP_SECRET_KEY,
  };
  process.env.COS_ORIGIN = `http://127.0.0.1:${cosPort}`;
  process.env.SHIP_REMOTE_DOMAIN = 'ship.example.com';
  process.env.MYSHIP_SECRET_ID = 'AKID_TEST_MOCK';
  process.env.MYSHIP_SECRET_KEY = 'SECRET_TEST_MOCK';

  try {
    await assert.rejects(() => gcRemoteState({ keepCount: 2 }), /GC安全中止/);
    await assert.rejects(
      () => removeResources({ deploymentIds: ['dpl_broken01'], isLocal: false }),
      /删除安全中止/
    );
    responseMode = 'invalid-json';
    await assert.rejects(() => gcRemoteState({ keepCount: 2 }), /SyntaxError/);
    assert.deepEqual(
      writeRequests,
      [],
      'No PUT or DELETE requests may be issued when cloud state snapshot fails integrity check'
    );
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mockCosServer.close();
  }
});

test('7. SCF Full-Stack Opt-in Switch, esbuild bundler, dev-server hot reload & gateway prefix proxy', async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-scf-'));
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const appDir = join(tmpRoot, 'fullstack-app');
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'lib'), { recursive: true });
  mkdirSync(join(appDir, 'server'), { recursive: true });

  writeFileSync(join(appDir, 'dist', 'index.html'), '<h1>FullStack App</h1>');
  writeFileSync(
    join(appDir, 'lib', 'auth.mjs'),
    `export const AUTH_ROLE = 'admin-v1';\nexport function checkAuth(token) { return token === 'secret-123'; }\n`
  );
  // 模拟一个被后端引用的 npm 依赖包 + 一个未被后端引用的前端大依赖包 + 后端目录下的静态模板文件
  mkdirSync(join(appDir, 'node_modules', 'mock-id-pkg'), { recursive: true });
  writeFileSync(
    join(appDir, 'node_modules', 'mock-id-pkg', 'package.json'),
    JSON.stringify({ name: 'mock-id-pkg', main: 'index.js' })
  );
  writeFileSync(
    join(appDir, 'node_modules', 'mock-id-pkg', 'index.js'),
    `module.exports = { makePrefix() { return 'id_'; } };\n`
  );
  mkdirSync(join(appDir, 'node_modules', 'unused-frontend-pkg'), { recursive: true });
  writeFileSync(
    join(appDir, 'node_modules', 'unused-frontend-pkg', 'package.json'),
    JSON.stringify({ name: 'unused-frontend-pkg', main: 'index.js' })
  );
  writeFileSync(
    join(appDir, 'node_modules', 'unused-frontend-pkg', 'index.js'),
    `export const HEAVY_UI = 'should-not-be-in-scf-zip';\n`
  );
  writeFileSync(join(appDir, 'server', 'prompt.txt'), 'system prompt template');
  mkdirSync(join(appDir, 'server', 'templates'), { recursive: true });
  writeFileSync(join(appDir, 'server', 'templates', 'sub.txt'), 'nested template');

  writeFileSync(
    join(appDir, 'server', 'index.mjs'),
    `import { createHash } from 'node:crypto';
import { makePrefix } from 'mock-id-pkg';
import { AUTH_ROLE, checkAuth } from '../lib/auth.mjs';

export async function fetch(request, context) {
  const url = new URL(request.url);
  if (url.pathname === '/api/notes' && request.method === 'POST') {
    const token = request.headers.get('x-auth-token') || '';
    if (!checkAuth(token)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await request.json();
    const list = (await context.storage.get('notes', [])) || [];
    const item = {
      id: makePrefix() + createHash('sha256').update(String(body.text)).digest('hex').slice(0, 8),
      text: body.text,
      role: AUTH_ROLE,
    };
    list.push(item);
    await context.storage.set('notes', list);
    return Response.json({ ok: true, item, total: list.length });
  }
  if (url.pathname === '/api/notes' && request.method === 'GET') {
    const list = (await context.storage.get('notes', [])) || [];
    return Response.json({ ok: true, role: AUTH_ROLE, notes: list });
  }
  return Response.json({ error: 'Not Found' }, { status: 404 });
}
`
  );

  // 1. 默认未开启开关时 backend 为空
  let ctx = detectProjectContext(appDir);
  assert.equal(ctx.backend, null);

  // 2. 开启开关 (--local 跳过云端预检) 并验证 backend.role 读写保留
  const enableRes = await runBackendCommand({
    subcommand: 'enable',
    cwd: appDir,
    explicitProject: 'fullstack-app',
    role: 'SCF_ReviewRole',
    isLocal: true,
  });
  assert.equal(enableRes.enabled, true);
  ctx = detectProjectContext(appDir);
  assert.equal(ctx.backend?.enabled, true);
  assert.equal(ctx.backend?.provider, 'scf');
  assert.equal(ctx.backend?.role, 'SCF_ReviewRole');
  assert(ctx.backend?.gatewayToken?.startsWith('msgt_'));

  // 3. 标准 esbuild 打包 + inline sourcemap + 递归保留静态模板文件验证
  const bundleRes = await bundleScfBackend({ cwd: appDir, targetDir: join(appDir, 'dist') });
  assert.equal(bundleRes.mode, 'entry');
  assert(bundleRes.zipSizeBytes > 500);
  assert.deepEqual(bundleRes.sourceFiles.sort(), ['lib/auth.mjs', 'server/index.mjs']);
  assert.deepEqual(bundleRes.externalPackages, ['mock-id-pkg']);
  assert(bundleRes.appBundleCode.includes('sourceMappingURL=data:application/json;base64,'));
  assert(bundleRes.zipEntries.includes('server/index.mjs'));
  assert(bundleRes.zipEntries.includes('server/prompt.txt'));
  assert(bundleRes.zipEntries.includes('server/templates/sub.txt'));
  assert(bundleRes.zipEntries.includes('_myship/bootstrap.mjs'));
  assert(!bundleRes.zipEntries.some((e) => e.includes('unused-frontend-pkg')));

  // 4. myship dev 同源运行、持久化数据读写与修改公共模块即时生效
  const devHandler = createDevRequestHandler({
    staticDir: join(appDir, 'dist'),
    cwd: appDir,
    project: 'fullstack-app',
  });

  const unauthRes = await devHandler(
    new Request('http://localhost:3000/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
  );
  assert.equal(unauthRes.status, 401);

  const postRes = await devHandler(
    new Request('http://localhost:3000/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth-token': 'secret-123' },
      body: JSON.stringify({ text: 'first persistent note' }),
    })
  );
  assert.equal(postRes.status, 200);
  const postData = await postRes.json();
  assert.equal(postData.item.role, 'admin-v1');
  assert.equal(postData.total, 1);

  // 修改本地公共模块 lib/auth.mjs，无需重启即可生效且持久化数据保留
  writeFileSync(
    join(appDir, 'lib', 'auth.mjs'),
    `export const AUTH_ROLE = 'admin-v2-updated';\nexport function checkAuth(token) { return token === 'secret-123'; }\n`
  );
  const getRes = await devHandler(new Request('http://localhost:3000/api/notes'));
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  assert.equal(getData.role, 'admin-v2-updated');
  assert.equal(getData.notes.length, 1);
  assert.equal(getData.notes[0].text, 'first persistent note');

  // 5. 验证网关 manifest.backend 通配前缀转发、注入 X-MyShip-Gateway-Token 并剥离 content-disposition: attachment
  let receivedHeaders = {};
  let receivedPath = '';
  const mockScfServer = http.createServer((req, res) => {
    receivedHeaders = req.headers;
    receivedPath = req.url;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment');
    res.end(JSON.stringify({ proxied: true, path: req.url }));
  });
  await new Promise((r) => mockScfServer.listen(0, '127.0.0.1', r));
  const scfPort = mockScfServer.address().port;

  try {
    const gwRes = await handleEdgeRequest(
      new Request('http://fullstack-app.ship.localhost:4100/api/deep/nested/route?page=2'),
      {
        getAlias: () => ({ deploymentId: 'dpl_scf00001' }),
        getManifest: () => ({
          id: 'dpl_scf00001',
          project: 'fullstack-app',
          files: {},
          functions: {},
          backend: {
            provider: 'scf',
            functionName: 'myship-fullstack-app',
            scfVersion: '3',
            upstreamUrl: `http://127.0.0.1:${scfPort}`,
            prefix: '/api',
            gatewayToken: 'msgt_secret_token_999',
          },
        }),
        getBlob: () => null,
      }
    );
    assert.equal(gwRes.status, 200);
    assert.equal(gwRes.headers.get('content-disposition'), null, 'Must strip attachment header');
    assert.equal(gwRes.headers.get('x-myship-backend-version'), '3');
    assert.equal(receivedPath, '/api/deep/nested/route?page=2');
    assert.equal(receivedHeaders['x-myship-gateway-token'], 'msgt_secret_token_999');
  } finally {
    mockScfServer.close();
  }

  // 6. 关闭开关
  const disableRes = await runBackendCommand({
    subcommand: 'disable',
    cwd: appDir,
    explicitProject: 'fullstack-app',
    isLocal: true,
  });
  assert.equal(disableRes.enabled, false);
  assert.equal(detectProjectContext(appDir).backend?.enabled, false);

  // 7. 验证未开启后端的纯静态项目 (含 .myship/project.json 与前端 lib/app.js) 不会误删前端 lib/
  const pureStaticDir = join(tmpRoot, 'pure-static-app');
  mkdirSync(join(pureStaticDir, 'lib'), { recursive: true });
  mkdirSync(join(pureStaticDir, '.myship'), { recursive: true });
  writeFileSync(join(pureStaticDir, 'index.html'), '<script src="/lib/app.js"></script>');
  writeFileSync(join(pureStaticDir, 'lib', 'app.js'), 'console.log("frontend lib");');
  writeFileSync(
    join(pureStaticDir, '.myship', 'project.json'),
    JSON.stringify({ project: 'pure-static-app', dir: '.' })
  );
  const staticDev = createDevRequestHandler({
    staticDir: pureStaticDir,
    cwd: pureStaticDir,
    project: 'pure-static-app',
  });
  const libRes = await staticDev(new Request('http://localhost:3000/lib/app.js'));
  assert.equal(libRes.status, 200);
  assert.equal(await libRes.text(), 'console.log("frontend lib");');
});

test('8. Phase 5 Declarative Resource Registration (`myship use storage|db`): COS files, CloudBase PG schema isolation, Turso & Cloudflare D1 auto-provisioning, and local node:sqlite parity', async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-resources-'));
  const storageDir = join(tmpRoot, 'cas-storage');
  const mockConfigPath = join(tmpRoot, 'global-config.json');
  const prevConfigPath = process.env.MYSHIP_CONFIG_PATH;
  process.env.MYSHIP_CONFIG_PATH = mockConfigPath;

  t.after(() => {
    if (prevConfigPath === undefined) {
      delete process.env.MYSHIP_CONFIG_PATH;
    } else {
      process.env.MYSHIP_CONFIG_PATH = prevConfigPath;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const appADir = join(tmpRoot, 'app-alpha');
  const appBDir = join(tmpRoot, 'app-beta');
  mkdirSync(join(appADir, 'dist'), { recursive: true });
  mkdirSync(join(appADir, 'server'), { recursive: true });
  mkdirSync(join(appBDir, 'dist'), { recursive: true });
  writeFileSync(join(appADir, 'dist', 'index.html'), '<h1>App Alpha</h1>');
  writeFileSync(join(appBDir, 'dist', 'index.html'), '<h1>App Beta</h1>');

  // 1. 注册对象存储 (`myship use storage`) 并验证跨项目文件隔离与预签名 URL
  const useStorageRes = await runUseCommand({
    args: ['storage'],
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
    storageDir,
  });
  assert.equal(useStorageRes.resource, 'storage');
  assert.equal(useStorageRes.config.dataPrefix, 'data/app-alpha/');
  assert.equal(useStorageRes.config.filesPrefix, 'files/app-alpha/');

  const filesAlpha = createLocalFileStorage(appADir, 'app-alpha');
  const filesBeta = createLocalFileStorage(appADir, 'app-beta');
  await filesAlpha.put('avatars/u1.txt', 'alpha-binary-content', { contentType: 'text/plain' });
  await filesBeta.put('avatars/u1.txt', 'beta-binary-content', { contentType: 'text/plain' });

  const alphaBuf = await filesAlpha.get('avatars/u1.txt');
  assert.equal(alphaBuf.toString('utf8'), 'alpha-binary-content');
  assert.equal(alphaBuf.contentType, 'text/plain');
  assert.equal(await filesBeta.get('avatars/u1.txt', { type: 'text' }), 'beta-binary-content');
  assert.deepEqual(await filesAlpha.list('avatars/'), ['avatars/u1.txt']);

  // 2. 注册腾讯云 CloudBase PostgreSQL (`myship use db --provider pg`)
  //    首次配置 --url 后保存在全局配置，第二个项目无需传 --url 自动派生独立 Schema
  const pgAlpha = await runUseCommand({
    args: ['db', '--provider', 'pg', '--url', 'postgresql://pguser:pgpass@cb-pg.tencentcdb.com:5432/postgres'],
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
    storageDir,
  });
  assert.equal(pgAlpha.provider, 'pg');
  assert.equal(pgAlpha.schema, 'myship_app_alpha');
  assert(pgAlpha.databaseUrl.includes('schema=myship_app_alpha'));
  assert(pgAlpha.databaseUrl.includes('search_path%3Dmyship_app_alpha'));

  // 第二个项目 app-beta 不传 --url + 指定 --env staging，自动复用全局 pgMasterUrl 并派生 myship_app_beta_staging
  const pgBetaStaging = await runUseCommand({
    args: ['db', '--provider', 'pg', '--env', 'staging'],
    cwd: appBDir,
    explicitProject: 'app-beta',
    isLocal: true,
    storageDir,
  });
  assert.equal(pgBetaStaging.schema, 'myship_app_beta_staging');
  const betaEnv = resolveProjectResourceEnv(appBDir, 'app-beta');
  assert.equal(betaEnv.PG_SCHEMA, 'myship_app_beta_staging');
  assert(betaEnv.DATABASE_URL.includes('myship_app_beta_staging'));

  // 2b. 原生 MySQL 接入 (--provider mysql) + 全局默认数据库平台切换 (--set-default mysql) + 单项目自定义 --raw 直连
  const mysqlGlobal = await runUseCommand({
    args: ['db', '--provider', 'mysql', '--url', 'mysql://root:pass@mysql.internal:3306/', '--default'],
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
    storageDir,
  });
  assert.equal(mysqlGlobal.provider, 'mysql');
  assert.equal(mysqlGlobal.dbName, 'myship_app_alpha');
  assert.equal(mysqlGlobal.databaseUrl, 'mysql://root:pass@mysql.internal:3306/myship_app_alpha');

  // 新项目 app-gamma 不传 --provider，自动继承全局默认平台 (mysql) 并派生 myship_app_gamma
  const appCDir = join(tmpRoot, 'app-gamma');
  mkdirSync(join(appCDir, 'dist'), { recursive: true });
  const gammaAutoDefault = await runUseCommand({
    args: ['db'],
    cwd: appCDir,
    explicitProject: 'app-gamma',
    isLocal: true,
    storageDir,
  });
  assert.equal(gammaAutoDefault.provider, 'mysql');
  assert.equal(gammaAutoDefault.dbName, 'myship_app_gamma');

  // 专业开发者在 app-gamma 单独使用 --raw 连接已有生产 MySQL 库 (不污染全局 mysqlMasterUrl)
  const gammaCustomRaw = await runUseCommand({
    args: ['db', '--provider', 'mysql', '--url', 'mysql://pro:sec@vip-mysql.com:3306/legacy_erp', '--raw'],
    cwd: appCDir,
    explicitProject: 'app-gamma',
    isLocal: true,
    storageDir,
  });
  assert.equal(gammaCustomRaw.dbName, 'legacy_erp');
  assert.equal(gammaCustomRaw.databaseUrl, 'mysql://pro:sec@vip-mysql.com:3306/legacy_erp');
  const gammaEnv = resolveProjectResourceEnv(appCDir, 'app-gamma');
  assert.equal(gammaEnv.MYSQL_DATABASE, 'legacy_erp');
  assert.equal(gammaEnv.MYSQL_URL, 'mysql://pro:sec@vip-mysql.com:3306/legacy_erp');

  // 3. 模拟 Turso Platform API + Turso HTTP SQL (/v2/pipeline) + Cloudflare D1 API + Neon API v2 + Neon HTTP (/sql)
  const mockDbState = {
    tursoCreatedDbs: [],
    d1CreatedDbs: [],
    neonCreatedDbs: [],
    tursoExecutedSql: [],
    d1ExecutedSql: [],
    neonExecutedSql: [],
  };

  const mockProviderServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    const bodyJson = bodyStr ? JSON.parse(bodyStr) : {};
    const hostPort = req.headers.host;

    res.setHeader('Content-Type', 'application/json');

    // Turso Platform API: GET database
    if (req.method === 'GET' && req.url.startsWith('/v1/organizations/myorg/databases/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    // Turso Platform API: POST create database
    if (req.method === 'POST' && req.url === '/v1/organizations/myorg/databases') {
      mockDbState.tursoCreatedDbs.push(bodyJson.name);
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          database: {
            DbId: 'db_turso_123',
            Hostname: `http://${hostPort}/turso-sql/${bodyJson.name}`,
            Name: bodyJson.name,
          },
        })
      );
      return;
    }
    // Turso Platform API: POST create token
    if (req.method === 'POST' && req.url.endsWith('/auth/tokens')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ jwt: 'turso_jwt_token_xyz' }));
      return;
    }
    // Turso HTTP SQL Pipeline API: POST /turso-sql/<db>/v2/pipeline
    if (req.method === 'POST' && req.url.endsWith('/v2/pipeline')) {
      const execReqs = (bodyJson.requests || []).filter((r) => r.type === 'execute');
      const results = execReqs.map((r) => {
        mockDbState.tursoExecutedSql.push(r.stmt);
        return {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: [
                { name: 'id', decltype: 'INTEGER' },
                { name: 'title', decltype: 'TEXT' },
              ],
              rows: [
                [
                  { type: 'integer', value: '1' },
                  { type: 'text', value: r.stmt.args?.[0]?.value || 'turso-row' },
                ],
              ],
              affected_row_count: 1,
              last_insert_rowid: '1',
            },
          },
        };
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ results }));
      return;
    }

    // Cloudflare D1 API: GET list databases
    if (req.method === 'GET' && req.url.startsWith('/accounts/cf_acc_1/d1/database')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, result: [] }));
      return;
    }
    // Cloudflare D1 API: POST create database
    if (req.method === 'POST' && req.url === '/accounts/cf_acc_1/d1/database') {
      mockDbState.d1CreatedDbs.push(bodyJson.name);
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          result: { uuid: 'd1-uuid-8888', name: bodyJson.name },
        })
      );
      return;
    }
    // Cloudflare D1 API: POST query
    if (req.method === 'POST' && req.url === '/accounts/cf_acc_1/d1/database/d1-uuid-8888/query') {
      mockDbState.d1ExecutedSql.push(bodyJson);
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: [{ id: 10, name: bodyJson.params?.[0] || 'd1-item' }],
              meta: { changes: 1, last_row_id: 10 },
            },
          ],
        })
      );
      return;
    }

    // Neon Platform API v2: GET projects
    if (req.method === 'GET' && req.url === '/projects') {
      res.statusCode = 200;
      res.end(JSON.stringify({ projects: [{ id: 'neon-proj-1', name: 'myship-neon' }] }));
      return;
    }
    // Neon Platform API v2: GET branches
    if (req.method === 'GET' && req.url === '/projects/neon-proj-1/branches') {
      res.statusCode = 200;
      res.end(JSON.stringify({ branches: [{ id: 'br-main-1', name: 'main', primary: true }] }));
      return;
    }
    // Neon Platform API v2: GET databases
    if (req.method === 'GET' && req.url === '/projects/neon-proj-1/branches/br-main-1/databases') {
      res.statusCode = 200;
      res.end(JSON.stringify({ databases: [{ id: 1, name: 'neondb', owner_name: 'neondb_owner' }] }));
      return;
    }
    // Neon Platform API v2: POST create database
    if (req.method === 'POST' && req.url === '/projects/neon-proj-1/branches/br-main-1/databases') {
      mockDbState.neonCreatedDbs.push(bodyJson.database?.name);
      res.statusCode = 201;
      res.end(JSON.stringify({ database: bodyJson.database }));
      return;
    }
    // Neon Platform API v2: GET connection_uri
    if (req.method === 'GET' && req.url.startsWith('/projects/neon-proj-1/connection_uri')) {
      const u = new URL(req.url, `http://${hostPort}`);
      const dbName = u.searchParams.get('database_name');
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          uri: `postgresql://neondb_owner:npg_secret@ep-mock-123.us-east-2.aws.neon.tech/${dbName}?sslmode=require`,
        })
      );
      return;
    }
    // Neon Serverless HTTP SQL endpoint: POST /sql
    if (req.method === 'POST' && req.url === '/sql') {
      mockDbState.neonExecutedSql.push({
        connStr: req.headers['neon-connection-string'],
        query: bodyJson.query,
        params: bodyJson.params,
      });
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          rows: [{ id: 77, label: bodyJson.params?.[0] || 'neon-row' }],
          rowCount: 1,
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'unhandled mock route: ' + req.url }));
  });

  await new Promise((r) => mockProviderServer.listen(0, '127.0.0.1', r));
  const mockPort = mockProviderServer.address().port;
  const mockBaseUrl = `http://127.0.0.1:${mockPort}`;
  process.env.TURSO_API_BASE_URL = mockBaseUrl;
  process.env.CF_API_BASE_URL = mockBaseUrl;
  process.env.NEON_API_BASE_URL = mockBaseUrl;

  try {
    // 3a. 测试 Turso 自动建库与远程 HTTP Pipeline 查询
    const tursoUse = await runUseCommand({
      args: ['db', '--provider', 'turso', '--org', 'myorg', '--token', 'turso_pat_123'],
      cwd: appADir,
      explicitProject: 'app-alpha',
      isLocal: true,
      storageDir,
    });
    assert.equal(tursoUse.provider, 'turso');
    assert.equal(tursoUse.action, 'created');
    assert.deepEqual(mockDbState.tursoCreatedDbs, ['myship-app-alpha']);

    const tursoRemoteDb = createDatabaseClient({
      cwd: appADir,
      project: 'app-alpha',
      env: {
        TURSO_DATABASE_URL: tursoUse.databaseUrl,
        TURSO_AUTH_TOKEN: 'turso_jwt_token_xyz',
        MYSHIP_DB_REMOTE: '1',
      },
      preferLocalSqlite: false,
    });
    const tursoRows = await tursoRemoteDb.query('SELECT * FROM todos WHERE title = ?', ['hello-turso']);
    assert.equal(tursoRows.length, 1);
    assert.equal(tursoRows[0].id, 1);
    assert.equal(tursoRows[0].title, 'hello-turso');
    assert.equal(tursoRows.rows.length, 1);

    // 3b. 测试 Cloudflare D1 自动建库与远程 HTTP /query 查询
    const d1Use = await runUseCommand({
      args: ['db', '--provider', 'd1', '--account-id', 'cf_acc_1', '--token', 'cf_tok_123'],
      cwd: appBDir,
      explicitProject: 'app-beta',
      isLocal: true,
      storageDir,
    });
    assert.equal(d1Use.provider, 'd1');
    assert.equal(d1Use.action, 'created');
    assert.equal(d1Use.databaseId, 'd1-uuid-8888');
    assert.deepEqual(mockDbState.d1CreatedDbs, ['myship-app-beta']);

    const d1RemoteDb = createDatabaseClient({
      cwd: appBDir,
      project: 'app-beta',
      env: {
        CF_ACCOUNT_ID: 'cf_acc_1',
        CF_D1_DATABASE_ID: 'd1-uuid-8888',
        CF_API_TOKEN: 'cf_tok_123',
        CF_API_BASE_URL: mockBaseUrl,
        MYSHIP_DB_REMOTE: '1',
      },
      preferLocalSqlite: false,
    });
    const d1Rows = await d1RemoteDb.query('SELECT * FROM items WHERE name = ?', ['hello-d1']);
    assert.equal(d1Rows.length, 1);
    assert.equal(d1Rows[0].id, 10);
    assert.equal(d1Rows[0].name, 'hello-d1');

    // 3c. 测试 Neon Serverless PostgreSQL API 自动建库 + Neon HTTP (/sql) 零依赖查询
    const neonUse = await runUseCommand({
      args: ['db', '--provider', 'neon', '--token', 'neon_api_key_999'],
      cwd: appADir,
      explicitProject: 'app-alpha',
      isLocal: true,
      storageDir,
    });
    assert.equal(neonUse.provider, 'neon');
    assert.equal(neonUse.action, 'created');
    assert.equal(neonUse.dbName, 'myship_app_alpha');
    assert.deepEqual(mockDbState.neonCreatedDbs, ['myship_app_alpha']);

    const neonRemoteDb = createDatabaseClient({
      cwd: appADir,
      project: 'app-alpha',
      env: {
        NEON_DATABASE_URL: neonUse.databaseUrl,
        NEON_HTTP_URL: `${mockBaseUrl}/sql`,
        MYSHIP_DB_REMOTE: '1',
      },
      preferLocalSqlite: false,
    });
    // 同时验证 SQLite 风格 `?` 占位符自动转换为 PostgreSQL `$1`
    const neonRows = await neonRemoteDb.query('SELECT * FROM posts WHERE label = ?', ['hello-neon']);
    assert.equal(neonRows.length, 1);
    assert.equal(neonRows[0].id, 77);
    assert.equal(neonRows[0].label, 'hello-neon');
    assert.equal(mockDbState.neonExecutedSql[0].query, 'SELECT * FROM posts WHERE label = $1');
  } finally {
    delete process.env.TURSO_API_BASE_URL;
    delete process.env.CF_API_BASE_URL;
    delete process.env.NEON_API_BASE_URL;
    mockProviderServer.close();
  }

  // 4. 验证 `myship dev` 全栈路由中同时使用 `context.files` 与 `context.db` (SQLite 家族 provider 在本地自动使用 node:sqlite)
  await runUseCommand({
    args: [
      'db',
      '--provider',
      'turso',
      '--url',
      'libsql://myship-app-alpha-myorg.turso.io',
      '--db-token',
      'turso_dev_tok',
    ],
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
    storageDir,
  });
  writeFileSync(
    join(appADir, 'server', 'index.mjs'),
    `export async function fetch(request, context) {
      const url = new URL(request.url);
      if (url.pathname === '/api/resources-demo' && request.method === 'POST') {
        const body = await request.json();
        await context.files.put('docs/readme.txt', body.fileText, { contentType: 'text/plain' });
        await context.db.execute('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
        const ins = await context.db.execute('INSERT INTO items (name) VALUES (?)', [body.itemName]);
        const rows = await context.db.query('SELECT id, name FROM items ORDER BY id ASC');
        const fileText = await context.files.get('docs/readme.txt', { type: 'text' });
        const presigned = await context.files.presignUrl('docs/readme.txt', { method: 'GET' });
        return new Response(JSON.stringify({
          project: context.project,
          storagePrefix: context.env.MYSHIP_STORAGE_PREFIX,
          filesPrefix: context.env.MYSHIP_FILES_PREFIX,
          lastInsertRowid: ins.lastInsertRowid,
          rows,
          fileText,
          presigned,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('Not Found', { status: 404 });
    }`
  );

  await runBackendCommand({
    subcommand: 'enable',
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
  });

  const devHandler = createDevRequestHandler({
    staticDir: join(appADir, 'dist'),
    cwd: appADir,
    project: 'app-alpha',
    storageDir,
  });

  const res = await devHandler(
    new Request('http://localhost:3000/api/resources-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileText: 'Saved via context.files!', itemName: 'First SQLite Row' }),
    })
  );
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.project, 'app-alpha');
  assert.equal(payload.storagePrefix, 'data/app-alpha/');
  assert.equal(payload.filesPrefix, 'files/app-alpha/');
  assert.equal(payload.fileText, 'Saved via context.files!');
  assert.equal(payload.lastInsertRowid, 1);
  assert.deepEqual(payload.rows, [{ id: 1, name: 'First SQLite Row' }]);

  // 验证本地预签名 URL 可直接通过 devHandler GET 下载
  const presignedReq = new Request(payload.presigned.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'http://localhost:3000'));
  const dlRes = await devHandler(presignedReq);
  assert.equal(dlRes.status, 200);
  assert.equal(await dlRes.text(), 'Saved via context.files!');
});

test('9. Phase 5.1 True Physical Provisioning: CloudBase PG ExecutePGSql (DDL DO $$ retry), PG & MySQL Wire Protocol, and PGHOST split env vars', async (t) => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'myship-test-phys-prov-'));
  const storageDir = join(tmpBase, 'storage');
  const configFile = join(tmpBase, 'config.json');
  const projDir = join(tmpBase, 'app-cloudbase');
  mkdirSync(projDir, { recursive: true });

  const prevCfgPath = process.env.MYSHIP_CONFIG_PATH;
  const prevSecId = process.env.MYSHIP_SECRET_ID;
  const prevSecKey = process.env.MYSHIP_SECRET_KEY;
  process.env.MYSHIP_CONFIG_PATH = configFile;
  process.env.MYSHIP_SECRET_ID = 'AKID_TEST_TCB_123456';
  process.env.MYSHIP_SECRET_KEY = 'SK_TEST_TCB_654321';

  t.after(() => {
    if (prevCfgPath === undefined) delete process.env.MYSHIP_CONFIG_PATH;
    else process.env.MYSHIP_CONFIG_PATH = prevCfgPath;
    if (prevSecId === undefined) delete process.env.MYSHIP_SECRET_ID;
    else process.env.MYSHIP_SECRET_ID = prevSecId;
    if (prevSecKey === undefined) delete process.env.MYSHIP_SECRET_KEY;
    else process.env.MYSHIP_SECRET_KEY = prevSecKey;
    rmSync(tmpBase, { recursive: true, force: true });
  });

  // 1. Mock 腾讯云 CloudBase TCB ExecutePGSql API (模拟首次直接执行 CREATE SCHEMA 返回 InternalError，验证自动 DO $$ 包装重试成功)
  const tcbReceivedCalls = [];
  const mockTcbServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    tcbReceivedCalls.push({
      action: req.headers['x-tc-action'],
      region: req.headers['x-tc-region'],
      auth: req.headers['authorization'],
      body,
    });
    res.setHeader('content-type', 'application/json');
    if (!String(body.Sql).startsWith('DO LANGUAGE plpgsql')) {
      res.end(
        JSON.stringify({
          Response: {
            Error: { Code: 'InternalError', Message: 'Direct DDL not allowed without DO block' },
          },
        })
      );
      return;
    }
    res.end(JSON.stringify({ Response: { RequestId: 'req-tcb-ok-1' } }));
  });
  await new Promise((r) => mockTcbServer.listen(0, '127.0.0.1', r));
  const tcbPort = mockTcbServer.address().port;
  process.env.TCB_API_ENDPOINT = `http://127.0.0.1:${tcbPort}/`;

  try {
    const tcbRes = await runUseCommand({
      args: [
        'db',
        '--provider',
        'pg',
        '--env-id',
        'surprised-salamander-d1adc3ebc70',
        '--region',
        'ap-shanghai',
        '--url',
        'postgresql://tcb_user:tcb_pass@pg.tcb.qcloud.la:5432/postgres',
      ],
      cwd: projDir,
      explicitProject: 'app-cloudbase',
      isLocal: true,
      storageDir,
    });
    assert.equal(tcbRes.provider, 'pg');
    assert.equal(tcbRes.provisionStatus, 'created');
    assert.equal(tcbReceivedCalls.length, 2);
    assert.equal(tcbReceivedCalls[0].action, 'ExecutePGSql');
    assert.equal(tcbReceivedCalls[0].region, 'ap-shanghai');
    assert.equal(tcbReceivedCalls[0].body.EnvId, 'surprised-salamander-d1adc3ebc70');
    assert.equal(tcbReceivedCalls[0].body.Sql, 'CREATE SCHEMA IF NOT EXISTS "myship_app_cloudbase"');
    assert.equal(
      tcbReceivedCalls[1].body.Sql,
      'DO LANGUAGE plpgsql $$ BEGIN EXECUTE \'CREATE SCHEMA IF NOT EXISTS "myship_app_cloudbase"\'; END $$'
    );

    // 验证官方推荐的独立 PG 环境变量 (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PG_SCHEMA, TCB_ENV_ID) 均已自动注入
    const resolvedEnv = resolveProjectResourceEnv(projDir, 'app-cloudbase');
    assert.equal(resolvedEnv.PGHOST, 'pg.tcb.qcloud.la');
    assert.equal(resolvedEnv.PGPORT, '5432');
    assert.equal(resolvedEnv.PGDATABASE, 'postgres');
    assert.equal(resolvedEnv.PGUSER, 'tcb_user');
    assert.equal(resolvedEnv.PGPASSWORD, 'tcb_pass');
    assert.equal(resolvedEnv.PG_SCHEMA, 'myship_app_cloudbase');
    assert.equal(resolvedEnv.TCB_ENV_ID, 'surprised-salamander-d1adc3ebc70');
  } finally {
    delete process.env.TCB_API_ENDPOINT;
    mockTcbServer.close();
  }

  // 2. 测试内置零依赖 PostgreSQL v3 Wire Protocol 物理建 Schema
  const pgWireQueries = [];
  const mockPgWireServer = net.createServer((sock) => {
    let startupDone = false;
    sock.on('data', (chunk) => {
      if (!startupDone) {
        startupDone = true;
        // Send AuthenticationOk ('R', len=8, code=0) + ReadyForQuery ('Z', len=5, 'I')
        const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
        const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
        sock.write(Buffer.concat([authOk, ready]));
        return;
      }
      if (chunk[0] === 0x51) {
        // 'Q' Simple Query
        const qLen = chunk.readInt32BE(1);
        const sqlStr = chunk.subarray(5, 1 + qLen - 1).toString('utf8');
        pgWireQueries.push(sqlStr);
        // Send CommandComplete ('C') + ReadyForQuery ('Z')
        const tag = Buffer.from('CREATE SCHEMA\0', 'utf8');
        const cmdDone = Buffer.alloc(5 + tag.length);
        cmdDone[0] = 0x43;
        cmdDone.writeInt32BE(4 + tag.length, 1);
        tag.copy(cmdDone, 5);
        const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
        sock.write(Buffer.concat([cmdDone, ready]));
      }
    });
  });
  await new Promise((r) => mockPgWireServer.listen(0, '127.0.0.1', r));
  const pgWirePort = mockPgWireServer.address().port;

  try {
    // 清除 tcbEnvId 以测试纯 PostgreSQL Wire Protocol 通道
    writeFileSync(configFile, JSON.stringify({}), 'utf8');
    const wireRes = await runUseCommand({
      args: [
        'db',
        '--provider',
        'pg',
        '--url',
        `postgresql://pgadmin:secret@127.0.0.1:${pgWirePort}/postgres?sslmode=disable`,
      ],
      cwd: projDir,
      explicitProject: 'app-wire-pg',
      isLocal: false,
      storageDir,
    });
    assert.equal(wireRes.provisionStatus, 'created');
    assert.deepEqual(pgWireQueries, ['CREATE SCHEMA IF NOT EXISTS "myship_app_wire_pg"']);
  } finally {
    mockPgWireServer.close();
  }

  // 3. 测试内置零依赖 MySQL v10 Wire Protocol 物理建库 (`CREATE DATABASE IF NOT EXISTS`)
  const mysqlWireQueries = [];
  const mockMysqlWireServer = net.createServer((sock) => {
    // Send MySQL v10 Initial Handshake packet
    const ver = Buffer.from('8.0.32-myship-mock\0', 'utf8');
    const threadId = Buffer.alloc(4);
    const scramble1 = Buffer.from('12345678', 'ascii');
    const filler = Buffer.from([0]);
    const capLower = Buffer.from([0xff, 0xf7]);
    const charset = Buffer.from([33]);
    const status = Buffer.from([0x02, 0x00]);
    const capUpper = Buffer.from([0xff, 0x81]);
    const authLen = Buffer.from([21]);
    const reserved = Buffer.alloc(10);
    const scramble2 = Buffer.from('123456789012\0', 'ascii');
    const pluginName = Buffer.from('mysql_native_password\0', 'utf8');
    const body = Buffer.concat([
      Buffer.from([10]),
      ver,
      threadId,
      scramble1,
      filler,
      capLower,
      charset,
      status,
      capUpper,
      authLen,
      reserved,
      scramble2,
      pluginName,
    ]);
    const hdr = Buffer.alloc(4);
    hdr.writeUIntLE(body.length, 0, 3);
    hdr[3] = 0;
    sock.write(Buffer.concat([hdr, body]));

    let authed = false;
    sock.on('data', (chunk) => {
      const seq = chunk[3];
      const payload = chunk.subarray(4);
      if (!authed) {
        authed = true;
        // Reply OK packet (0x00, 0, 0, 2, 0, 0, 0)
        const okBody = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const okHdr = Buffer.alloc(4);
        okHdr.writeUIntLE(okBody.length, 0, 3);
        okHdr[3] = seq + 1;
        sock.write(Buffer.concat([okHdr, okBody]));
        return;
      }
      if (payload[0] === 0x03) {
        // COM_QUERY
        mysqlWireQueries.push(payload.subarray(1).toString('utf8'));
        const okBody = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const okHdr = Buffer.alloc(4);
        okHdr.writeUIntLE(okBody.length, 0, 3);
        okHdr[3] = seq + 1;
        sock.write(Buffer.concat([okHdr, okBody]));
      }
    });
  });
  await new Promise((r) => mockMysqlWireServer.listen(0, '127.0.0.1', r));
  const mysqlWirePort = mockMysqlWireServer.address().port;

  try {
    const mysqlRes = await runUseCommand({
      args: [
        'db',
        '--provider',
        'mysql',
        '--url',
        `mysql://root:rootpass@127.0.0.1:${mysqlWirePort}/mysql`,
      ],
      cwd: projDir,
      explicitProject: 'app-wire-mysql',
      isLocal: false,
      storageDir,
    });
    assert.equal(mysqlRes.provisionStatus, 'created');
    assert.equal(mysqlWireQueries.length, 1);
    assert.match(mysqlWireQueries[0], /CREATE DATABASE IF NOT EXISTS `myship_app_wire_mysql`/);
  } finally {
    mockMysqlWireServer.close();
  }
});

test('Scenario 6: Interactive selection wizard (myship use & myship use db)', async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-interactive-test-'));
  const storageDir = join(tmpRoot, 'storage');
  const configFile = join(tmpRoot, 'config.json');
  const prevConfigPath = process.env.MYSHIP_CONFIG_PATH;
  process.env.MYSHIP_CONFIG_PATH = configFile;

  t.after(() => {
    if (prevConfigPath === undefined) {
      delete process.env.MYSHIP_CONFIG_PATH;
    } else {
      process.env.MYSHIP_CONFIG_PATH = prevConfigPath;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const proj1Dir = join(tmpRoot, 'interactive-app');
  const proj2Dir = join(tmpRoot, 'interactive-app2');
  mkdirSync(join(proj1Dir, 'dist'), { recursive: true });
  mkdirSync(join(proj2Dir, 'dist'), { recursive: true });

  // 1. 顶层交互菜单：`myship use` -> 选择 2 (storage)
  const storageRes = await runUseCommand({
    args: [],
    cwd: proj1Dir,
    explicitProject: 'interactive-app',
    isLocal: true,
    storageDir,
    interactive: true,
    promptAnswers: ['storage'],
  });
  assert.equal(storageRes.resource, 'storage');
  assert.equal(storageRes.config.filesPrefix, 'files/interactive-app/');

  // 2. 数据库交互选择向导：`myship use` -> 选择 db -> 选择 pg -> 输入连接串 -> 选择 schema 隔离
  const pgWizardRes = await runUseCommand({
    args: [],
    cwd: proj1Dir,
    explicitProject: 'interactive-app',
    isLocal: true,
    storageDir,
    interactive: true,
    promptAnswers: [
      'db',
      'pg',
      'postgresql://pguser:pgpass@cb.tencentcdb.com:5432/postgres',
      'schema',
    ],
  });
  assert.equal(pgWizardRes.provider, 'pg');
  assert.equal(pgWizardRes.schema, 'myship_interactive_app');

  // 3. 第二个项目 `myship use db`：全局连接串已就绪，仅需回车选择平台，零文本输入即可完成派生
  const pgSecondRes = await runUseCommand({
    args: ['db'],
    cwd: proj2Dir,
    explicitProject: 'interactive-app2',
    isLocal: true,
    storageDir,
    interactive: true,
    promptAnswers: ['pg'],
  });
  assert.equal(pgSecondRes.provider, 'pg');
  assert.equal(pgSecondRes.schema, 'myship_interactive_app2');
  assert(pgSecondRes.databaseUrl.includes('schema=myship_interactive_app2'));
});

test('11. Codex Review Security & Correctness Regression Suite (All 8 P1/P2 findings)', async (t) => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-codex-review-'));
  const storageDir = join(tmpRoot, 'storage');
  const configFile = join(tmpRoot, 'config.json');
  const prevConfigPath = process.env.MYSHIP_CONFIG_PATH;
  const prevSecId = process.env.MYSHIP_SECRET_ID;
  const prevSecKey = process.env.MYSHIP_SECRET_KEY;
  process.env.MYSHIP_CONFIG_PATH = configFile;
  process.env.MYSHIP_SECRET_ID = 'AKID_CODEX_TEST';
  process.env.MYSHIP_SECRET_KEY = 'SK_CODEX_TEST';

  t.after(() => {
    if (prevConfigPath === undefined) delete process.env.MYSHIP_CONFIG_PATH;
    else process.env.MYSHIP_CONFIG_PATH = prevConfigPath;
    if (prevSecId === undefined) delete process.env.MYSHIP_SECRET_ID;
    else process.env.MYSHIP_SECRET_ID = prevSecId;
    if (prevSecKey === undefined) delete process.env.MYSHIP_SECRET_KEY;
    else process.env.MYSHIP_SECRET_KEY = prevSecKey;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const projDir = join(tmpRoot, 'review-app');
  mkdirSync(join(projDir, 'dist'), { recursive: true });
  mkdirSync(join(projDir, 'server'), { recursive: true });

  // Finding #1 & #3: `.myship/project.json` 严禁包含密码/连接串，且 PGOPTIONS / search_path 注入到位
  await runUseCommand({
    args: [
      'db',
      '--provider',
      'pg',
      '--url',
      'postgresql://dba:TopSecretPass999@127.0.0.1:1/postgres',
    ],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  const projectJsonText = readFileSync(join(projDir, '.myship', 'project.json'), 'utf8');
  assert(!projectJsonText.includes('TopSecretPass999'), '.myship/project.json must not contain DB password');
  assert(!projectJsonText.includes('databaseUrl'), '.myship/project.json must not contain databaseUrl');

  const resolvedPgEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(resolvedPgEnv.PGPASSWORD, 'TopSecretPass999');
  assert.equal(resolvedPgEnv.PG_SCHEMA, 'myship_review_app');
  assert.equal(resolvedPgEnv.PGOPTIONS, '-c search_path=myship_review_app,public');

  // Finding #4: 切换 DB Provider 时清理旧 Provider 托管变量，同时保留用户自定义变量，且驱动按 MYSHIP_DB_PROVIDER 精确选择
  await runEnvCommand({
    subcommand: 'set',
    args: ['CUSTOM_USER_KEY=keep_me_alive'],
    cwd: projDir,
    project: 'review-app',
    isLocal: true,
    storageDir,
  });
  await runUseCommand({
    args: [
      'db',
      '--provider',
      'turso',
      '--url',
      'https://review-app-org.turso.io',
      '--db-token',
      'turso_secret_tok',
      '--raw',
    ],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  await runUseCommand({
    args: [
      'db',
      '--provider',
      'neon',
      '--url',
      'postgresql://neondb_owner:NeonPass123@ep-cool-frog-123.us-east-2.aws.neon.tech/neondb?sslmode=require',
    ],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  const neonSwitchedEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(neonSwitchedEnv.MYSHIP_DB_PROVIDER, 'neon');
  assert.equal(neonSwitchedEnv.TURSO_DATABASE_URL, undefined, 'Stale TURSO_DATABASE_URL must be cleaned up');
  assert.equal(neonSwitchedEnv.TURSO_AUTH_TOKEN, undefined, 'Stale TURSO_AUTH_TOKEN must be cleaned up');
  const fullEnvDoc = JSON.parse(readFileSync(join(storageDir, 'envs', 'review-app.json'), 'utf8'));
  assert.equal(fullEnvDoc.vars.CUSTOM_USER_KEY, 'keep_me_alive', 'Custom user env var must be preserved');
  const projectJsonAfterSwitch = readFileSync(join(projDir, '.myship', 'project.json'), 'utf8');
  assert(!projectJsonAfterSwitch.includes('NeonPass123'));
  assert(!projectJsonAfterSwitch.includes('turso_secret_tok'));

  const dbClientAfterSwitch = createDatabaseClient({
    cwd: projDir,
    project: 'review-app',
    env: {
      ...neonSwitchedEnv,
      // 模拟宿主残留旧 TURSO 变量，验证按 MYSHIP_DB_PROVIDER 优先走 neon 而非被旧变量劫持
      TURSO_DATABASE_URL: 'https://stale.turso.io',
      TURSO_AUTH_TOKEN: 'stale_token',
    },
    preferLocalSqlite: false,
  });
  assert.equal(dbClientAfterSwitch.provider, 'neon');

  // Finding #2 & #3: 云端 SCF 打包产物 (`bundleScfBackend`) 支持 `TCB_ENV_ID` (`ExecutePGSql`) 且查询自动前置 `SET search_path`
  const tcbSqlLogs = [];
  const mockTcbSrv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    tcbSqlLogs.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        Response: {
          ResultSet: {
            Columns: [{ Name: 'id' }, { Name: 'title' }],
            Rows: [JSON.stringify(['1', 'cloud-scf-ok'])],
          },
          AffectedRows: 1,
        },
      })
    );
  });
  await new Promise((r) => mockTcbSrv.listen(0, '127.0.0.1', r));
  const tcbSrvPort = mockTcbSrv.address().port;
  process.env.TCB_API_ENDPOINT = `http://127.0.0.1:${tcbSrvPort}/`;

  try {
    await runUseCommand({
      args: [
        'db',
        '--provider',
        'cloudbase-pg',
        '--env-id',
        'surprised-salamander-d1adc3ebc70',
        '--region',
        'ap-shanghai',
      ],
      cwd: projDir,
      explicitProject: 'review-app',
      isLocal: true,
      storageDir,
    });
    writeFileSync(
      join(projDir, 'server', 'index.mjs'),
      `export async function fetch(req, ctx) {
        const rows = await ctx.db.query('SELECT id, title FROM notes WHERE id = $1', [1]);
        return new Response(JSON.stringify({ provider: ctx.db.provider, rows }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }`
    );
    const bundle = await bundleScfBackend({ cwd: projDir, targetDir: join(projDir, 'dist') });
    const scfRunDir = join(tmpRoot, 'scf-run');
    mkdirSync(join(scfRunDir, '_myship'), { recursive: true });
    mkdirSync(join(scfRunDir, 'server'), { recursive: true });
    writeFileSync(
      join(scfRunDir, 'package.json'),
      JSON.stringify({ name: 'scf-run', private: true, type: 'module' }),
      'utf8'
    );
    writeFileSync(join(scfRunDir, '_myship', 'bootstrap.mjs'), bundle.bootstrapJsCode, 'utf8');
    writeFileSync(join(scfRunDir, 'server', 'index.mjs'), bundle.appBundleCode, 'utf8');

    const scfPort = 19400 + Math.floor(Math.random() * 500);
    const scfEnv = {
      ...process.env,
      ...resolveProjectResourceEnv(projDir, 'review-app', storageDir),
      PORT: String(scfPort),
      TCB_API_ENDPOINT: `http://127.0.0.1:${tcbSrvPort}/`,
    };
    const child = spawn(process.execPath, ['_myship/bootstrap.mjs'], {
      cwd: scfRunDir,
      env: scfEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error('SCF server start timeout')), 5000);
        child.stdout.on('data', (d) => {
          if (String(d).toLowerCase().includes('listening on')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          rejectReady(new Error(`SCF server exited early: ${code}`));
        });
      });

      const resp = await fetch(`http://127.0.0.1:${scfPort}/api/notes`);
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.provider, 'cloudbase-pg');
      assert.deepEqual(data.rows, [{ id: '1', title: 'cloud-scf-ok' }]);
      const queryCall = tcbSqlLogs.find((item) => String(item.Sql).includes('SELECT id, title FROM notes'));
      assert(queryCall, 'Cloud SCF bundle must invoke ExecutePGSql');
      assert.equal(
        queryCall.Sql,
        'SET search_path TO "myship_review_app", public; SELECT id, title FROM notes WHERE id = 1'
      );
    } finally {
      child.kill('SIGTERM');
    }

    // Finding #5: 全局存有 tcbEnvId 时，显式绑定普通原生 PG (--provider pg --url ...) 绝不能误调 CloudBase ExecutePGSql 或残留 TCB_ENV_ID
    tcbSqlLogs.length = 0;
    const otherPgDir = join(tmpRoot, 'plain-pg-app');
    mkdirSync(otherPgDir, { recursive: true });
    await runUseCommand({
      args: [
        'db',
        '--provider',
        'pg',
        '--url',
        'postgresql://plain_user:plain_pass@127.0.0.1:1/plaindb',
      ],
      cwd: otherPgDir,
      explicitProject: 'plain-pg-app',
      isLocal: true,
      storageDir,
    });
    assert.equal(tcbSqlLogs.length, 0, 'Plain PG binding must not call CloudBase ExecutePGSql');
    const plainPgEnv = resolveProjectResourceEnv(otherPgDir, 'plain-pg-app', storageDir);
    assert.equal(plainPgEnv.TCB_ENV_ID, undefined, 'Plain PG binding must not inherit TCB_ENV_ID');
    assert.equal(plainPgEnv.PGHOST, '127.0.0.1');
  } finally {
    delete process.env.TCB_API_ENDPOINT;
    mockTcbSrv.close();
  }

  // Finding #6: `myship use storage --env staging` 切回 `myship use storage` (prod) 时，必须清理 staging 并落回 `files/<project>/`
  await runUseCommand({
    args: ['storage', '--env', 'staging'],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  const stagingEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(stagingEnv.MYSHIP_STORAGE_ENV, 'staging');
  assert.equal(stagingEnv.MYSHIP_FILES_PREFIX, 'files/review-app/staging/');

  await runUseCommand({
    args: ['storage'],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  const prodStorageEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(prodStorageEnv.MYSHIP_STORAGE_ENV, 'prod');
  assert.equal(prodStorageEnv.MYSHIP_FILES_PREFIX, 'files/review-app/');
  const prodFiles = createLocalFileStorage(projDir, 'review-app', prodStorageEnv);
  assert.equal(prodFiles.prefix, 'files/review-app/');
  await prodFiles.put('check.txt', 'in-prod-root');
  assert(
    existsSync(join(projDir, '.myship', 'files', 'review-app', 'check.txt')),
    'Prod file storage must write to .myship/files/review-app/check.txt'
  );
  assert(
    !existsSync(join(projDir, '.myship', 'files', 'review-app', 'staging', 'check.txt')),
    'Prod file storage must not write into /staging/'
  );

  // Finding #7: MySQL 8 `0xfe` AuthSwitchRequest (`caching_sha2_password` -> `0x01 0x03` fast auth -> `0x00` OK)
  const mysql8Queries = [];
  const mockMysql8Server = net.createServer((sock) => {
    const ver = Buffer.from('8.0.36-mysql8\0', 'utf8');
    const threadId = Buffer.alloc(4);
    const scramble1 = Buffer.from('ABCDEFGH', 'ascii');
    const filler = Buffer.from([0]);
    const capLower = Buffer.from([0xff, 0xf7]);
    const charset = Buffer.from([33]);
    const status = Buffer.from([0x02, 0x00]);
    const capUpper = Buffer.from([0xff, 0x81]);
    const authLen = Buffer.from([21]);
    const reserved = Buffer.alloc(10);
    const scramble2 = Buffer.from('IJKLMNOPQRST\0', 'ascii');
    const pluginName = Buffer.from('mysql_native_password\0', 'utf8');
    const body = Buffer.concat([
      Buffer.from([10]),
      ver,
      threadId,
      scramble1,
      filler,
      capLower,
      charset,
      status,
      capUpper,
      authLen,
      reserved,
      scramble2,
      pluginName,
    ]);
    const hdr = Buffer.alloc(4);
    hdr.writeUIntLE(body.length, 0, 3);
    hdr[3] = 0;
    sock.write(Buffer.concat([hdr, body]));

    let step = 0;
    sock.on('data', (chunk) => {
      const seq = chunk[3];
      const payload = chunk.subarray(4);
      if (step === 0) {
        step = 1;
        // Send 0xfe AuthSwitchRequest to caching_sha2_password
        const switchBody = Buffer.concat([
          Buffer.from([0xfe]),
          Buffer.from('caching_sha2_password\0', 'utf8'),
          Buffer.from('12345678901234567890\0', 'ascii'),
        ]);
        const switchHdr = Buffer.alloc(4);
        switchHdr.writeUIntLE(switchBody.length, 0, 3);
        switchHdr[3] = seq + 1;
        sock.write(Buffer.concat([switchHdr, switchBody]));
        return;
      }
      if (step === 1) {
        step = 2;
        // Send 0x01 0x03 (fast auth success) followed by 0x00 OK_Packet
        const fastOk = Buffer.from([0x01, 0x03]);
        const fastHdr = Buffer.alloc(4);
        fastHdr.writeUIntLE(fastOk.length, 0, 3);
        fastHdr[3] = seq + 1;
        const okBody = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const okHdr = Buffer.alloc(4);
        okHdr.writeUIntLE(okBody.length, 0, 3);
        okHdr[3] = seq + 2;
        sock.write(Buffer.concat([fastHdr, fastOk, okHdr, okBody]));
        return;
      }
      if (payload[0] === 0x03) {
        mysql8Queries.push(payload.subarray(1).toString('utf8'));
        const okBody = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const okHdr = Buffer.alloc(4);
        okHdr.writeUIntLE(okBody.length, 0, 3);
        okHdr[3] = seq + 1;
        sock.write(Buffer.concat([okHdr, okBody]));
      }
    });
  });
  await new Promise((r) => mockMysql8Server.listen(0, '127.0.0.1', r));
  const mysql8Port = mockMysql8Server.address().port;
  try {
    const mysql8Res = await runUseCommand({
      args: [
        'db',
        '--provider',
        'mysql',
        '--url',
        `mysql://root:sha2pass@127.0.0.1:${mysql8Port}/mysql`,
      ],
      cwd: projDir,
      explicitProject: 'mysql8-app',
      isLocal: false,
      storageDir,
    });
    assert.equal(mysql8Res.provisionStatus, 'created');
    assert.equal(mysql8Queries.length, 1);
    assert.match(mysql8Queries[0], /CREATE DATABASE IF NOT EXISTS `myship_mysql8_app`/);
  } finally {
    mockMysql8Server.close();
  }

  // Round 2 Regression #1: `myship env rm` 删除凭证后绝不被缓存复活，`myship env set` 更新连接串时自动同步 PGHOST/PGPASSWORD
  await runUseCommand({
    args: [
      'db',
      '--provider',
      'neon',
      '--url',
      'postgresql://u1:OldPass111@old-neon.invalid:5432/olddb',
      '--raw',
    ],
    cwd: projDir,
    explicitProject: 'review-app',
    isLocal: true,
    storageDir,
  });
  await runEnvCommand({
    subcommand: 'rm',
    args: ['DATABASE_URL', 'NEON_DATABASE_URL', 'PGPASSWORD'],
    cwd: projDir,
    project: 'review-app',
    isLocal: true,
    storageDir,
  });
  const afterRmEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(afterRmEnv.DATABASE_URL, undefined, 'Deleted DATABASE_URL must not reappear');
  assert.equal(afterRmEnv.NEON_DATABASE_URL, undefined, 'Deleted NEON_DATABASE_URL must not reappear');
  assert.equal(afterRmEnv.PGPASSWORD, undefined, 'Deleted PGPASSWORD must not reappear');

  await runEnvCommand({
    subcommand: 'set',
    args: ['DATABASE_URL=postgresql://u2:NewPass222@new-neon.invalid:5433/newdb'],
    cwd: projDir,
    project: 'review-app',
    isLocal: true,
    storageDir,
  });
  const afterSetEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(afterSetEnv.DATABASE_URL, 'postgresql://u2:NewPass222@new-neon.invalid:5433/newdb');
  assert.equal(afterSetEnv.PGHOST, 'new-neon.invalid');
  assert.equal(afterSetEnv.PGPORT, '5433');
  assert.equal(afterSetEnv.PGUSER, 'u2');
  assert.equal(afterSetEnv.PGPASSWORD, 'NewPass222');
  assert.equal(afterSetEnv.PGDATABASE, 'newdb');

  // Round 2 Regression #2: Neon HTTP `/sql` 在设置 PG_SCHEMA 时使用单事务 `queries: [SET LOCAL search_path, query]` 实现真实 Schema 隔离
  const neonHttpBodies = [];
  const mockNeonSqlServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    neonHttpBodies.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        results: [
          { command: 'SET', rows: [], rowCount: null },
          { command: 'SELECT', rows: [{ id: 9, title: 'neon-txn-schema-ok' }], rowCount: 1 },
        ],
      })
    );
  });
  await new Promise((r) => mockNeonSqlServer.listen(0, '127.0.0.1', r));
  const neonSqlPort = mockNeonSqlServer.address().port;
  try {
    const neonSchemaDb = createDatabaseClient({
      cwd: projDir,
      project: 'review-app',
      env: {
        MYSHIP_DB_PROVIDER: 'neon',
        NEON_DATABASE_URL: 'postgresql://u:p@ep-test.neon.tech/neondb',
        NEON_HTTP_URL: `http://127.0.0.1:${neonSqlPort}/sql`,
        PG_SCHEMA: 'myship_review_app',
      },
      preferLocalSqlite: true, // 即使传入 preferLocalSqlite: true，neon 也不应降级为 SQLite
    });
    const rows = await neonSchemaDb.query('SELECT id, title FROM posts WHERE id = $1', [9]);
    assert.deepEqual(rows, [{ id: 9, title: 'neon-txn-schema-ok' }]);
    assert.equal(neonHttpBodies.length, 1);
    assert.deepEqual(neonHttpBodies[0], {
      queries: [
        { query: 'SET LOCAL search_path TO "myship_review_app", public', params: [] },
        { query: 'SELECT id, title FROM posts WHERE id = $1', params: [9] },
      ],
    });
  } finally {
    mockNeonSqlServer.close();
  }

  // Round 3 Regression #1: `executePostgresSimpleSqlViaWire` 对 `42P04` (duplicate_database) / `42P06` (duplicate_schema) 保持幂等
  function buildPgMsg(typeChar, payloadBuf) {
    const out = Buffer.alloc(1 + 4 + payloadBuf.length);
    out.write(typeChar, 0, 1, 'ascii');
    out.writeInt32BE(4 + payloadBuf.length, 1);
    payloadBuf.copy(out, 5);
    return out;
  }
  const dupDbQueries = [];
  const mockPgDupServer = net.createServer((sock) => {
    let handshakeDone = false;
    sock.on('data', (chunk) => {
      if (!handshakeDone) {
        if (chunk.length === 8 && chunk.readInt32BE(4) === 80877103) {
          sock.write(Buffer.from('N', 'ascii'));
          return;
        }
        handshakeDone = true;
        const authOk = Buffer.alloc(4);
        authOk.writeInt32BE(0, 0);
        sock.write(
          Buffer.concat([
            buildPgMsg('R', authOk),
            buildPgMsg('Z', Buffer.from('I', 'ascii')),
          ])
        );
        return;
      }
      if (chunk[0] === 0x51) {
        dupDbQueries.push(chunk.subarray(5, chunk.length - 1).toString('utf8'));
        // Return PostgreSQL ErrorResponse with SQLSTATE 42P04 (duplicate_database)
        const errPayload = Buffer.from(
          'SERROR\0VERROR\0C42P04\0Mdatabase already exists\0\0',
          'utf8'
        );
        sock.write(
          Buffer.concat([
            buildPgMsg('E', errPayload),
            buildPgMsg('Z', Buffer.from('I', 'ascii')),
          ])
        );
      }
    });
  });
  await new Promise((r) => mockPgDupServer.listen(0, '127.0.0.1', r));
  const pgDupPort = mockPgDupServer.address().port;
  try {
    const dupDbRes = await runUseCommand({
      args: [
        'db',
        '--provider',
        'pg',
        '--url',
        `postgresql://postgres:pass@127.0.0.1:${pgDupPort}/postgres`,
        '--isolate',
        'db',
      ],
      cwd: projDir,
      explicitProject: 'dup-db-app',
      isLocal: false,
      storageDir,
    });
    assert.equal(dupDbRes.provisionStatus, 'created', '42P04 duplicate_database must be treated as idempotent success');
    assert.deepEqual(dupDbQueries, ['CREATE DATABASE "myship_dup_db_app"']);
  } finally {
    mockPgDupServer.close();
  }

  // Round 3 Regression #2 & #3:
  // - 本地 dev 跨请求复用同一个 `pg.Pool` 连接池，6 次请求只建立 1 条 TCP 连接，且支持 `pool.on('error')` 防进程崩溃与 `closeDatabasePools` 回收
  // - 云端 SCF 打包产物 (`_myship/bootstrap.mjs`) 已由 esbuild 内联打包 `pg` 与 `mysql2/promise`，在完全脱离仓库 `node_modules` 的 `/tmp` 目录中独立运行返回 200
  function buildPgRowResult(idStr, titleStr) {
    const makeField = (name, oid, size) => {
      const nameBuf = Buffer.from(`${name}\0`, 'utf8');
      const meta = Buffer.alloc(18);
      meta.writeInt32BE(0, 0);
      meta.writeInt16BE(0, 4);
      meta.writeInt32BE(oid, 6);
      meta.writeInt16BE(size, 10);
      meta.writeInt32BE(-1, 12);
      meta.writeInt16BE(0, 16);
      return Buffer.concat([nameBuf, meta]);
    };
    const rowDescHdr = Buffer.alloc(2);
    rowDescHdr.writeInt16BE(2, 0);
    const rowDesc = buildPgMsg(
      'T',
      Buffer.concat([rowDescHdr, makeField('id', 25, -1), makeField('title', 25, -1)])
    );
    const c1 = Buffer.from(String(idStr), 'utf8');
    const c2 = Buffer.from(String(titleStr), 'utf8');
    const dataPayload = Buffer.alloc(2 + 4 + c1.length + 4 + c2.length);
    dataPayload.writeInt16BE(2, 0);
    dataPayload.writeInt32BE(c1.length, 2);
    c1.copy(dataPayload, 6);
    dataPayload.writeInt32BE(c2.length, 6 + c1.length);
    c2.copy(dataPayload, 10 + c1.length);
    const dataRow = buildPgMsg('D', dataPayload);
    const cmdComplete = buildPgMsg('C', Buffer.from('SELECT 1\0', 'utf8'));
    const ready = buildPgMsg('Z', Buffer.from('I', 'ascii'));
    return Buffer.concat([rowDesc, dataRow, cmdComplete, ready]);
  }

  let pgPoolConnCount = 0;
  const activePgSockets = new Set();
  const mockPgQueryServer = net.createServer((sock) => {
    pgPoolConnCount++;
    activePgSockets.add(sock);
    sock.on('close', () => activePgSockets.delete(sock));
    let handshakeDone = false;
    sock.on('data', (chunk) => {
      if (!handshakeDone) {
        if (chunk.length === 8 && chunk.readInt32BE(4) === 80877103) {
          sock.write(Buffer.from('N', 'ascii'));
          return;
        }
        handshakeDone = true;
        const authOk = Buffer.alloc(4);
        authOk.writeInt32BE(0, 0);
        sock.write(
          Buffer.concat([
            buildPgMsg('R', authOk),
            buildPgMsg('Z', Buffer.from('I', 'ascii')),
          ])
        );
        return;
      }
      if (chunk[0] === 0x51) {
        const sqlText = chunk.subarray(5, chunk.length - 1).toString('utf8');
        if (/^\s*(SET|BEGIN|COMMIT|ROLLBACK)\b/i.test(sqlText)) {
          sock.write(
            Buffer.concat([
              buildPgMsg('C', Buffer.from('SET\0', 'utf8')),
              buildPgMsg('Z', Buffer.from('I', 'ascii')),
            ])
          );
          return;
        }
        sock.write(buildPgRowResult('1', 'scf-pg-bundled-ok'));
      }
    });
  });
  await new Promise((r) => mockPgQueryServer.listen(0, '127.0.0.1', r));
  const pgQueryPort = mockPgQueryServer.address().port;

  function makeMysqlPacket(seq, bodyBuf) {
    const hdr = Buffer.alloc(4);
    hdr.writeUIntLE(bodyBuf.length, 0, 3);
    hdr[3] = seq;
    return Buffer.concat([hdr, bodyBuf]);
  }
  function makeLenEncStr(str) {
    const b = Buffer.from(String(str), 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  }
  function makeMysqlColDef(seq, name) {
    const body = Buffer.concat([
      makeLenEncStr('def'),
      makeLenEncStr(''),
      makeLenEncStr(''),
      makeLenEncStr(''),
      makeLenEncStr(name),
      makeLenEncStr(name),
      Buffer.from([0x0c, 0x21, 0x00, 0x40, 0x00, 0x00, 0x00, 0xfd, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ]);
    return makeMysqlPacket(seq, body);
  }

  const mockMysqlQueryServer = net.createServer((sock) => {
    const handshakeBody = Buffer.concat([
      Buffer.from([10]),
      Buffer.from('8.0.36-mock\0', 'utf8'),
      Buffer.alloc(4),
      Buffer.from('12345678', 'ascii'),
      Buffer.from([0x00, 0xff, 0xf7, 0x21, 0x02, 0x00, 0xff, 0x81, 21]),
      Buffer.alloc(10),
      Buffer.from('123456789012\0', 'ascii'),
      Buffer.from('mysql_native_password\0', 'utf8'),
    ]);
    sock.write(makeMysqlPacket(0, handshakeBody));

    let authed = false;
    sock.on('data', (chunk) => {
      const seq = chunk[3];
      const payload = chunk.subarray(4);
      if (!authed) {
        authed = true;
        sock.write(makeMysqlPacket(seq + 1, Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00])));
        return;
      }
      if (payload[0] === 0x03) {
        // COM_QUERY -> return 2-column resultset
        const p1 = makeMysqlPacket(seq + 1, Buffer.from([0x02]));
        const p2 = makeMysqlColDef(seq + 2, 'id');
        const p3 = makeMysqlColDef(seq + 3, 'title');
        const p4 = makeMysqlPacket(seq + 4, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]));
        const rowBody = Buffer.concat([makeLenEncStr('1'), makeLenEncStr('scf-mysql-bundled-ok')]);
        const p5 = makeMysqlPacket(seq + 5, rowBody);
        const p6 = makeMysqlPacket(seq + 6, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]));
        sock.write(Buffer.concat([p1, p2, p3, p4, p5, p6]));
      }
    });
  });
  await new Promise((r) => mockMysqlQueryServer.listen(0, '127.0.0.1', r));
  const mysqlQueryPort = mockMysqlQueryServer.address().port;

  try {
    // 1. 验证本地 `createDatabaseClient` 连续 6 次请求复用同一个 `pg.Pool` (仅建立 1 条连接)
    const pgEnv = {
      MYSHIP_DB_PROVIDER: 'pg',
      DATABASE_URL: `postgresql://u:p@127.0.0.1:${pgQueryPort}/postgres?sslmode=disable`,
      PG_SCHEMA: 'myship_pool_reuse',
    };
    for (let i = 0; i < 6; i++) {
      const client = createDatabaseClient({
        cwd: projDir,
        project: 'pool-reuse-app',
        env: pgEnv,
        preferLocalSqlite: true,
      });
      const rows = await client.query('SELECT id, title FROM notes');
      assert.deepEqual(rows, [{ id: '1', title: 'scf-pg-bundled-ok' }]);
    }
    assert.equal(pgPoolConnCount, 1, '6 consecutive requests must reuse the cached pg.Pool connection');

    // 2. 模拟服务端向空闲连接发送 FATAL 57P01 帧并断开，验证 `pool.on("error")` 不会导致进程未捕获异常崩溃
    for (const sock of activePgSockets) {
      const fatalPayload = Buffer.from(
        'SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0',
        'utf8'
      );
      sock.write(buildPgMsg('E', fatalPayload));
      sock.destroy();
    }
    await new Promise((r) => setTimeout(r, 60));
    await closeDatabasePools('pool-reuse-app');

    // 3. 验证解包到无 `node_modules` 的 `/tmp` 独立目录后，`_myship/bootstrap.mjs` 可直接运行原生 `pg` 与 `mysql`
    writeFileSync(
      join(projDir, 'server', 'index.mjs'),
      `export async function fetch(req, ctx) {
        const rows = await ctx.db.query('SELECT id, title FROM items');
        return new Response(JSON.stringify({ provider: ctx.db.provider, rows }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }`
    );
    const isolatedBundle = await bundleScfBackend({ cwd: projDir, targetDir: join(projDir, 'dist') });
    const isolatedTmpDir = mkdtempSync(join(tmpdir(), 'myship-isolated-scf-'));
    try {
      mkdirSync(join(isolatedTmpDir, '_myship'), { recursive: true });
      mkdirSync(join(isolatedTmpDir, 'server'), { recursive: true });
      writeFileSync(
        join(isolatedTmpDir, 'package.json'),
        JSON.stringify({ name: 'isolated-scf', private: true, type: 'module' }),
        'utf8'
      );
      writeFileSync(join(isolatedTmpDir, '_myship', 'bootstrap.mjs'), isolatedBundle.bootstrapJsCode, 'utf8');
      writeFileSync(join(isolatedTmpDir, 'server', 'index.mjs'), isolatedBundle.appBundleCode, 'utf8');

      // 3a. 独立目录启动 SCF 运行原生 PG
      const pgScfPort = 19950 + Math.floor(Math.random() * 300);
      const pgChild = spawn(process.execPath, ['_myship/bootstrap.mjs'], {
        cwd: isolatedTmpDir,
        env: {
          ...process.env,
          PORT: String(pgScfPort),
          MYSHIP_DB_PROVIDER: 'pg',
          DATABASE_URL: `postgresql://u:p@127.0.0.1:${pgQueryPort}/postgres?sslmode=disable`,
          PG_SCHEMA: 'myship_isolated_pg',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await new Promise((resolveReady, rejectReady) => {
          const timer = setTimeout(() => rejectReady(new Error('Isolated PG SCF timeout')), 5000);
          pgChild.stdout.on('data', (d) => {
            if (String(d).toLowerCase().includes('listening on')) {
              clearTimeout(timer);
              resolveReady();
            }
          });
          pgChild.on('exit', (code) => {
            clearTimeout(timer);
            rejectReady(new Error(`Isolated PG SCF exited early: ${code}`));
          });
        });
        const pgResp = await fetch(`http://127.0.0.1:${pgScfPort}/api/items`);
        assert.equal(pgResp.status, 200);
        const pgData = await pgResp.json();
        assert.equal(pgData.provider, 'pg');
        assert.deepEqual(pgData.rows, [{ id: '1', title: 'scf-pg-bundled-ok' }]);
      } finally {
        pgChild.kill('SIGTERM');
      }

      // 3b. 独立目录启动 SCF 运行原生 MySQL
      const mysqlScfPort = 20300 + Math.floor(Math.random() * 300);
      const mysqlChild = spawn(process.execPath, ['_myship/bootstrap.mjs'], {
        cwd: isolatedTmpDir,
        env: {
          ...process.env,
          PORT: String(mysqlScfPort),
          MYSHIP_DB_PROVIDER: 'mysql',
          MYSQL_URL: `mysql://root:pass@127.0.0.1:${mysqlQueryPort}/testdb`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      try {
        await new Promise((resolveReady, rejectReady) => {
          const timer = setTimeout(() => rejectReady(new Error('Isolated MySQL SCF timeout')), 5000);
          mysqlChild.stdout.on('data', (d) => {
            if (String(d).toLowerCase().includes('listening on')) {
              clearTimeout(timer);
              resolveReady();
            }
          });
          mysqlChild.on('exit', (code) => {
            clearTimeout(timer);
            rejectReady(new Error(`Isolated MySQL SCF exited early: ${code}`));
          });
        });
        const mysqlResp = await fetch(`http://127.0.0.1:${mysqlScfPort}/api/items`);
        assert.equal(mysqlResp.status, 200);
        const mysqlData = await mysqlResp.json();
        assert.equal(mysqlData.provider, 'mysql');
        assert.deepEqual(mysqlData.rows, [{ id: '1', title: 'scf-mysql-bundled-ok' }]);
      } finally {
        mysqlChild.kill('SIGTERM');
      }
    } finally {
      rmSync(isolatedTmpDir, { recursive: true, force: true });
    }

    // 4. 验证 Neon `-pooler.` 连接串不会在 `resolveProjectResourceEnv` 注入 `PGOPTIONS` 或 `options=`，且 Turso 多组织选择 + 显式 `--group` 严格生效
    await runUseCommand({
      args: [
        'db',
        '--provider',
        'neon',
        '--url',
        'postgresql://neondb_owner:pass@ep-cool-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
      ],
      cwd: projDir,
      explicitProject: 'pooler-app',
      isLocal: true,
      storageDir,
    });
    const poolerEnv = resolveProjectResourceEnv(projDir, 'pooler-app', storageDir);
    assert.equal(poolerEnv.PG_SCHEMA, 'myship_pooler_app');
    assert.equal(poolerEnv.PGOPTIONS, undefined, '-pooler host must not inject PGOPTIONS');
    assert(!poolerEnv.DATABASE_URL.includes('options='), '-pooler URL must not contain options=');

    const tursoGroupsAttempted = [];
    const mockTursoMultiOrgSrv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && u.pathname === '/v1/organizations') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify([
            { slug: 'org-alpha', name: 'Alpha', type: 'personal' },
            { slug: 'org-beta', name: 'Beta', type: 'team' },
          ])
        );
        return;
      }
      if (req.method === 'GET' && u.pathname.includes('/databases/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.method === 'GET' && u.pathname.endsWith('/groups')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ groups: [{ name: 'production' }] }));
        return;
      }
      if (req.method === 'POST' && u.pathname.endsWith('/databases')) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || '{}');
        tursoGroupsAttempted.push({ path: u.pathname, group: parsed.group });
        if (parsed.group !== 'production') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `group ${parsed.group} not found` }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ database: { Hostname: 'myship-turso-org-beta.turso.io', DbId: 'db-2' } }));
        return;
      }
      if (req.method === 'POST' && u.pathname.endsWith('/auth/tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jwt: 'jwt-org-beta' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => mockTursoMultiOrgSrv.listen(0, '127.0.0.1', r));
    const prevTursoBase = process.env.TURSO_API_BASE_URL;
    process.env.TURSO_API_BASE_URL = `http://127.0.0.1:${mockTursoMultiOrgSrv.address().port}`;
    try {
      const multiOrgRes = await runUseCommand({
        args: ['db', '--provider', 'turso', '--token', 'turso-tok-multi'],
        cwd: projDir,
        explicitProject: 'multi-org-app',
        interactive: true,
        promptAnswers: ['2'], // 选择第 2 个组织 org-beta
        isLocal: true,
        storageDir,
      });
      assert.equal(multiOrgRes.action, 'created');
      assert(tursoGroupsAttempted.some((x) => x.path.includes('/org-beta/') && x.group === 'production'));

      // 显式指定 `--group staging` 不存在时，必须报错且不得静默篡改为 `production`
      await assert.rejects(
        () =>
          runUseCommand({
            args: ['db', '--provider', 'turso', '--org', 'org-beta', '--token', 'turso-tok-multi', '--group', 'staging'],
            cwd: projDir,
            explicitProject: 'explicit-group-app',
            interactive: false,
            isLocal: true,
            storageDir,
          }),
        /group staging not found/
      );
    } finally {
      if (prevTursoBase === undefined) delete process.env.TURSO_API_BASE_URL;
      else process.env.TURSO_API_BASE_URL = prevTursoBase;
      mockTursoMultiOrgSrv.close();
    }
  } finally {
    await closeDatabasePools();
    mockPgQueryServer.close();
    mockMysqlQueryServer.close();
  }
});
