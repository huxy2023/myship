import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
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
  gcRemoteState,
  runEnvCommand,
  startConsoleServer,
  runBackendCommand,
  bundleScfBackend,
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

    const verRes = spawnSync(
      'node',
      [join(packTmp, 'package/packages/cli/myship.mjs'), '--version'],
      {
        cwd: packTmp,
        encoding: 'utf8',
      }
    );
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
    assert.equal(
      ctxVite.buildDir,
      './dist',
      'Build project should not mistake public/ for buildDir'
    );

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

      // Phase 4 & 5 Console APIs: batch env set (including rawContent with inline comments & escapes),
      // cross-project isolation, resources inspection, presigned file URL, and logs
      mkdirSync(join(tmpRoot, '.myship'), { recursive: true });
      writeFileSync(
        join(tmpRoot, '.myship', 'project.json'),
        JSON.stringify(
          {
            project: 'alpha',
            dir: './custom-out',
            backend: {
              enabled: true,
              provider: 'scf',
              region: 'ap-shanghai',
              entry: 'server/index.mjs',
              functionName: 'custom-alpha-fn',
            },
            resources: {
              db: { provider: 'turso', databaseName: 'alpha-db' },
            },
          },
          null,
          2
        )
      );

      // CLI --project override must preserve current project's custom dir, backend, and resources
      const cliOverrideCtx = detectProjectContext(tmpRoot, 'beta-release');
      assert.equal(cliOverrideCtx.project, 'beta-release');
      assert.equal(cliOverrideCtx.buildDir, './custom-out');
      assert.equal(cliOverrideCtx.backend?.entry, 'server/index.mjs');
      assert.equal(cliOverrideCtx.resources?.db?.provider, 'turso');

      // Cross-project Console query for 'beta' must NOT inherit 'alpha' cwd config
      const betaLogsRes = await fetch(`${url}/api/console/logs?project=beta&limit=5`);
      const betaLogsJson = await betaLogsRes.json();
      assert.equal(betaLogsJson.ok, true);
      assert.equal(betaLogsJson.functionName, 'myship-beta');
      assert.notEqual(betaLogsJson.region, 'ap-shanghai');

      // Same-project query for 'alpha' DOES use 'alpha' cwd config when no manifest overrides it
      const alphaLogsRes = await fetch(`${url}/api/console/logs?project=alpha&limit=5`);
      const alphaLogsJson = await alphaLogsRes.json();
      assert.equal(alphaLogsJson.ok, true);
      assert.equal(alphaLogsJson.functionName, 'custom-alpha-fn');
      assert.equal(alphaLogsJson.region, 'ap-shanghai');

      const betaResInspect = await fetch(`${url}/api/console/resources?project=beta`);
      const betaResInspectJson = await betaResInspect.json();
      assert.equal(betaResInspectJson.ok, true);
      assert.equal(betaResInspectJson.db.enabled, false);
      assert.equal(betaResInspectJson.db.provider, 'sqlite-local');

      const batchEnvRes = await fetch(`${url}/api/console/env`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MyShip-Console': '1',
        },
        body: JSON.stringify({
          project: 'app',
          action: 'set-batch',
          rawContent: [
            '# Full-line comment',
            'API_TOKEN=abc # production key',
            'MULTI_LINE="line1\\nline2"',
            'MYSHIP_DB_PROVIDER=turso',
            'TURSO_DATABASE_URL=libsql://app-test.turso.io',
          ].join('\n'),
        }),
      });
      const batchEnvJson = await batchEnvRes.json();
      assert.equal(batchEnvJson.ok, true);
      assert.equal(batchEnvJson.count, 4);

      const envCheckRes = await fetch(`${url}/api/console/env?project=app&reveal=1`);
      const envCheckJson = await envCheckRes.json();
      assert.equal(envCheckJson.ok, true);
      assert.equal(envCheckJson.vars.API_TOKEN, 'abc');
      assert.equal(envCheckJson.vars.MULTI_LINE, 'line1\nline2');

      const resInspect = await fetch(`${url}/api/console/resources?project=app`);
      const resInspectJson = await resInspect.json();
      assert.equal(resInspectJson.ok, true);
      assert.equal(resInspectJson.db.provider, 'turso');
      assert.equal(resInspectJson.storage.filesPrefix, 'files/app/');

      const presignRes = await fetch(
        `${url}/api/console/file-presign?project=app&key=demo/hello.txt`
      );
      const presignJson = await presignRes.json();
      assert.equal(presignJson.ok, true);
      assert.match(presignJson.url, /\/_myship_files\/app\/demo\/hello\.txt\?method=GET/);

      const logsRes = await fetch(`${url}/api/console/logs?project=app&limit=10`);
      const logsJson = await logsRes.json();
      assert.equal(logsJson.ok, true);
      assert(Array.isArray(logsJson.logs));
    } finally {
      server.close();
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('6. Fail-closed cloud abort before delete & live frontend runGc request payload', async () => {
  const html = renderConsoleHtml({ defaultProject: 'app', modeLabel: 'LOCAL' });
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert(scriptMatch, 'Console HTML must contain <script>');

  const elements = {
    gcOlderThanSelect: { value: '30d', style: {} },
    gcKeepInput: { value: '10', disabled: false, style: {}, title: '' },
    gcResultBox: { textContent: '', innerHTML: '' },
    backendStatusSummary: { innerHTML: '', textContent: '' },
    toast: { textContent: '', style: {} },
  };
  let capturedGcPayload = null;

  const sandbox = {
    window: {},
    document: {
      getElementById: (id) =>
        elements[id] || { value: '', style: {}, innerHTML: '', textContent: '' },
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
  assert.equal(
    elements.gcKeepInput.disabled,
    true,
    'gcKeepInput should be disabled when olderThan is set'
  );
  await sandbox.runGc(true);
  assert.deepEqual(capturedGcPayload, {
    keepCount: 'all',
    olderThan: '30d',
    dryRun: true,
  });

  // Verify renderBackendOverviewCard distinguishes live rolled-back deployment from latest deployment and shows actual runtime
  sandbox.renderBackendOverviewCard({
    name: 'app',
    aliases: [{ subdomain: 'app', deploymentId: 'dpl_v1' }],
    manifests: [
      {
        id: 'dpl_v2',
        backend: {
          mode: 'scf-web',
          functionName: 'myship-app',
          version: '2',
          region: 'ap-guangzhou',
          prefix: '/api',
          runtime: 'Nodejs18.15',
        },
      },
      {
        id: 'dpl_v1',
        backend: {
          mode: 'scf-web',
          functionName: 'myship-app',
          version: '1',
          region: 'ap-guangzhou',
          prefix: '/api',
          runtime: 'Nodejs18.15',
        },
      },
    ],
  });
  assert.match(elements.backendStatusSummary.innerHTML, /Version 1 \(dpl_v1\)/);
  assert.match(elements.backendStatusSummary.innerHTML, /Version 2 \(dpl_v2\)/);
  assert.match(elements.backendStatusSummary.innerHTML, /已回滚偏离/);
  assert.match(elements.backendStatusSummary.innerHTML, /Nodejs18\.15/);
  assert.doesNotMatch(elements.backendStatusSummary.innerHTML, /Nodejs20\.19/);

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
      res.end(
        responseMode === 'invalid-json' ? '{corrupted-json' : JSON.stringify({ broken: true })
      );
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

  let ctx = detectProjectContext(appDir);
  assert.equal(ctx.backend, null);

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

  const disableRes = await runBackendCommand({
    subcommand: 'disable',
    cwd: appDir,
    explicitProject: 'fullstack-app',
    isLocal: true,
  });
  assert.equal(disableRes.enabled, false);
  assert.equal(detectProjectContext(appDir).backend?.enabled, false);

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
