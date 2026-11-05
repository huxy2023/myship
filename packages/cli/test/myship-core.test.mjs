import test, { before, after } from 'node:test';
import { Console } from 'node:console';
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
  startDevServer,
  parseOlderThanCutoffMs,
  removeResources,
  gcRemoteState,
  runEnvCommand,
  startConsoleServer,
  runBackendCommand,
  bundleScfBackend,
  installMyShipSkill,
  getMyShipSkillStatus,
  runSkillCommand,
  scaffoldProjectTemplate,
  createLocalFileStorage,
  createCloudStorage,
  setAvailabilityState,
  generateEdgeFunctionCode,
  generateProjectApiWorkerCode,
  createConsoleRequestHandler,
} from '../myship.mjs';
import { withKeyWriteLock } from '../project-context.mjs';
import { createLocalPersistentStorage } from '../storage-client.mjs';
import { createDatabaseClient } from '../db-client.mjs';
import { renderConsoleHtml } from '../console-ui.mjs';
import { startScfRuntimeServer } from '../scf-bootstrap-runtime.mjs';
import { handleEdgeRequest } from '../../edge-gateway/local-gateway.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

// Node 22 `node --test` uses child stdout for binary V8-serialized test events;
// route business console output to stderr so multi-byte UTF-8 logs never collide with protocol frames.
const originalConsole = globalThis.console;
before(() => {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
});
after(() => {
  globalThis.console = originalConsole;
});

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
  assert(packedFiles.has('skills/myship-skill/SKILL.md'), 'Tarball must include SKILL.md');
  assert(
    packedFiles.has('packages/cli/console/template.html'),
    'Tarball must include console/template.html'
  );
  assert(
    packedFiles.has('packages/cli/console/styles.css'),
    'Tarball must include console/styles.css'
  );
  assert(
    packedFiles.has('packages/cli/console/client.js'),
    'Tarball must include console/client.js'
  );
  assert(
    packedFiles.has('skills/myship-skill/references/fullstack-runtime.md'),
    'Tarball must include fullstack-runtime.md reference'
  );
  assert(
    packedFiles.has('skills/myship-skill/references/cli-and-ops.md'),
    'Tarball must include cli-and-ops.md reference'
  );
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

    // Verify CLI --dir flag overrides auto-detected ./dist in the isolated unpacked CLI copy
    const fakeProj = join(packTmp, 'dir-flag-proj');
    mkdirSync(join(fakeProj, 'dist'), { recursive: true });
    mkdirSync(join(fakeProj, 'custom'), { recursive: true });
    writeFileSync(join(fakeProj, 'dist/index.html'), 'FROM_DIST');
    writeFileSync(join(fakeProj, 'custom/index.html'), 'FROM_CUSTOM');
    const cliDirRes = spawnSync(
      'node',
      [join(packTmp, 'package/packages/cli/myship.mjs'), '--dir', './custom', '--local'],
      { cwd: fakeProj, encoding: 'utf8' }
    );
    assert.equal(cliDirRes.status, 0, `--dir deploy failed: ${cliDirRes.stderr}`);
    const projJsonAfterDir = JSON.parse(readFileSync(join(fakeProj, '.myship/project.json'), 'utf8'));
    assert.equal(projJsonAfterDir.dir, './custom');
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
    const regeneratedYaml = readFileSync(ciRes1.workflowPath, 'utf8');
    assert(regeneratedYaml.includes('MYSHIP_DIR: "./dist"'));
    assert(regeneratedYaml.includes('runs-on: ubuntu-24.04'), 'Must pin ubuntu-24.04 instead of ubuntu-latest');
    assert(regeneratedYaml.includes('actions/checkout@v6'), 'Must use Node 24 compatible checkout@v6');
    assert(regeneratedYaml.includes('actions/setup-node@v6'), 'Must use Node 24 compatible setup-node@v6');
    assert(regeneratedYaml.includes('actions/github-script@v8'), 'Must use Node 24 compatible github-script@v8');
    assert(regeneratedYaml.includes('@myship/cli@latest'), 'Must invoke published @myship/cli@latest package');
    assert(!regeneratedYaml.includes('ubuntu-latest'));
    assert(!regeneratedYaml.includes('@v4'));
    assert(!regeneratedYaml.includes('@v7'));

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
      assert.equal(batchEnvJson.importedCount, 4);
      assert.equal(batchEnvJson.totalCount, 4);
      assert.equal(batchEnvJson.count, 4);

      const envCheckRes = await fetch(`${url}/api/console/env?project=app&reveal=1`);
      const envCheckJson = await envCheckRes.json();
      assert.equal(envCheckJson.ok, true);
      assert.equal(envCheckJson.vars.API_TOKEN, 'abc');
      assert.equal(envCheckJson.vars.MULTI_LINE, 'line1\nline2');

      const singleKeyEnvRes = await fetch(
        `${url}/api/console/env?project=app&key=API_TOKEN&reveal=1`
      );
      const singleKeyEnvJson = await singleKeyEnvRes.json();
      assert.equal(singleKeyEnvJson.ok, true);
      assert.equal(singleKeyEnvJson.exists, true);
      assert.equal(singleKeyEnvJson.value, 'abc');

      const resInspect = await fetch(`${url}/api/console/resources?project=app`);
      const resInspectJson = await resInspect.json();
      assert.equal(resInspectJson.ok, true);
      assert.equal(resInspectJson.db.provider, 'turso');
      assert.equal(resInspectJson.db.source, 'env');
      assert.equal(resInspectJson.storage.filesPrefix, 'files/app/');

      // Test KV read-only inspector (/api/console/kv) & SQLite table/row preview (/api/console/db-preview)
      const betaKv = createLocalPersistentStorage(tmpRoot, 'beta');
      await betaKv.set('site-config', { title: 'Beta Console', theme: 'light' });
      const kvInspectRes = await fetch(
        `${url}/api/console/kv?project=beta&key=site-config`
      );
      const kvInspectJson = await kvInspectRes.json();
      assert.equal(kvInspectJson.ok, true);
      assert.equal(kvInspectJson.value.title, 'Beta Console');
      assert.equal(kvInspectJson.truncated, false);

      const betaDb = createDatabaseClient({
        cwd: tmpRoot,
        project: 'beta',
        preferLocalSqlite: true,
      });
      await betaDb.execute(
        'CREATE TABLE IF NOT EXISTS articles (id INTEGER PRIMARY KEY, title TEXT)'
      );
      await betaDb.execute('INSERT INTO articles (title) VALUES (?)', ['Hello Console DB']);
      const dbPreviewRes = await fetch(`${url}/api/console/db-preview?project=beta`);
      const dbPreviewJson = await dbPreviewRes.json();
      assert.equal(dbPreviewJson.ok, true);
      assert.equal(dbPreviewJson.configured, true);
      assert.equal(dbPreviewJson.provider, 'sqlite-local');
      assert.deepEqual(dbPreviewJson.tables, ['articles']);
      assert.equal(dbPreviewJson.selectedTable, 'articles');
      assert.deepEqual(dbPreviewJson.columns, ['id', 'title']);
      assert.equal(dbPreviewJson.rows.length, 1);
      assert.equal(dbPreviewJson.rows[0].title, 'Hello Console DB');
      await betaDb.close();

      // Test local file presign & direct preview download on Console Server
      const appFiles = createLocalFileStorage(tmpRoot, 'app');
      await appFiles.put('demo/hello.txt', 'console-file-preview-ok', {
        contentType: 'text/plain',
      });
      const presignRes = await fetch(
        `${url}/api/console/file-presign?project=app&key=demo/hello.txt`
      );
      const presignJson = await presignRes.json();
      assert.equal(presignJson.ok, true);
      assert.match(presignJson.url, /\/_myship_files\/app\/demo\/hello\.txt\?method=GET/);
      const fileDownloadRes = await fetch(presignJson.url);
      assert.equal(fileDownloadRes.status, 200);
      assert.equal(fileDownloadRes.headers.get('content-security-policy'), 'sandbox');
      assert.equal(fileDownloadRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await fileDownloadRes.text(), 'console-file-preview-ok');

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
    logsContainer: { innerHTML: '', textContent: '' },
    logsSummaryText: { innerHTML: '', textContent: '' },
    envKeyInput: { value: 'OLD_KEY', disabled: true, style: {} },
    envValInput: { value: 'OLD_SECRET', disabled: false, style: {} },
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
      if (String(url).startsWith('/api/console/logs')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            functionName: 'myship-app',
            logs: [
              {
                timestamp: '2026-11-05T12:00:00.000Z',
                requestId: 'req_123',
                method: 'GET',
                path: '/api/health',
                status: 200,
                durationMs: 12,
                level: 'INFO',
                scfVersion: '1',
                lines: [{ level: 'INFO', text: 'health check passed' }],
              },
            ],
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

  // Verify resolveProjectAccessState does NOT mistake custom alias for primary domain and detects disabled target deployment
  const unboundState = sandbox.resolveProjectAccessState({
    name: 'app',
    aliases: [{ subdomain: 'app-staging', deploymentId: 'dpl_v2' }],
    manifests: [{ id: 'dpl_v2' }],
  });
  assert.equal(unboundState.code, 'unbound');
  assert.equal(unboundState.primaryAlias, null);
  assert.equal(unboundState.activeManifest, null);

  const disabledTargetState = sandbox.resolveProjectAccessState({
    name: 'app',
    aliases: [{ subdomain: 'app', deploymentId: 'dpl_v2' }],
    manifests: [{ id: 'dpl_v2', disabled: true, disabledReason: '紧急熔断' }],
  });
  assert.equal(disabledTargetState.code, 'version-disabled');
  assert.equal(disabledTargetState.reason, '紧急熔断');

  // Verify resolveRollbackCandidate skips disabled previousDeploymentId and picks older healthy manifest
  const rbTarget = sandbox.resolveRollbackCandidate(
    {
      name: 'app',
      manifests: [
        { id: 'dpl_v3' },
        { id: 'dpl_v2', disabled: true },
        { id: 'dpl_v1' },
      ],
    },
    { subdomain: 'app', deploymentId: 'dpl_v3', previousDeploymentId: 'dpl_v2' }
  );
  assert.equal(rbTarget.id, 'dpl_v1');

  // Verify loadLogs renders timestamp, method/path, lines[].text, and marks INFO 200 as non-error
  await sandbox.loadLogs();
  assert.match(elements.logsContainer.innerHTML, /GET \/api\/health/);
  assert.match(elements.logsContainer.innerHTML, /health check passed/);
  assert.match(elements.logsContainer.innerHTML, /badge-green/);
  assert.doesNotMatch(elements.logsContainer.innerHTML, /badge-red/);

  // Verify selectProject clears editing env form state
  sandbox.selectProject('other-proj');
  assert.equal(elements.envKeyInput.value, '');
  assert.equal(elements.envKeyInput.disabled, false);
  assert.equal(elements.envValInput.value, '');

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
  const diskProjJson = JSON.parse(readFileSync(join(appDir, '.myship/project.json'), 'utf8'));
  assert.equal(
    diskProjJson.backend?.gatewayToken,
    undefined,
    'Auto-generated gatewayToken must be stored in git-ignored .myship/secrets.json, never in .myship/project.json'
  );
  const diskSecretsJson = JSON.parse(readFileSync(join(appDir, '.myship/secrets.json'), 'utf8'));
  assert.equal(diskSecretsJson.gatewayToken, ctx.backend.gatewayToken);

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

  // Verify AI Vibecoding Skill installer (workspace & global)
  const skillTmp = mkdtempSync(join(tmpdir(), 'myship-test-skill-'));
  const fakeHome = join(skillTmp, 'home');
  const fakeProj = join(skillTmp, 'proj');
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeProj, { recursive: true });

  const initialStatus = getMyShipSkillStatus({ cwd: fakeProj, homeDir: fakeHome });
  assert.equal(initialStatus.workspace.installed, false);
  assert.equal(initialStatus.globalAntigravity.installed, false);

  const wsRes = runSkillCommand('install', { cwd: fakeProj, homeDir: fakeHome, global: false });
  assert.equal(wsRes.scope, 'workspace');
  assert(existsSync(join(fakeProj, '.agents/skills/myship-skill/SKILL.md')));
  assert(existsSync(join(fakeProj, '.agents/skills/myship-skill/references/fullstack-runtime.md')));

  const glRes = installMyShipSkill({
    cwd: fakeProj,
    homeDir: fakeHome,
    global: true,
    includeClaude: true,
  });
  assert.equal(glRes.scope, 'global');
  assert(existsSync(join(fakeHome, '.gemini/config/skills/myship-skill/SKILL.md')));
  assert(existsSync(join(fakeHome, '.agents/skills/myship-skill/SKILL.md')));
  assert(existsSync(join(fakeHome, '.claude/skills/myship-skill/SKILL.md')));

  const afterStatus = runSkillCommand('status', { cwd: fakeProj, homeDir: fakeHome });
  assert.equal(afterStatus.workspace.installed, true);
  assert.equal(afterStatus.globalAntigravity.installed, true);
  assert.equal(afterStatus.globalUniversal.installed, true);
  assert.equal(afterStatus.globalClaude.installed, true);

  // Verify presignUrl expiresIn vs expiresSec & files.get Buffer return
  const localFiles = createLocalFileStorage(fakeProj, 'skill-proj');
  await localFiles.put('hello.txt', 'hello buffer', { contentType: 'text/plain' });
  const gotBuf = await localFiles.get('hello.txt');
  assert(Buffer.isBuffer(gotBuf), 'files.get must return a Buffer');
  assert.equal(gotBuf.toString('utf8'), 'hello buffer');
  assert.equal(gotBuf.contentType, 'text/plain');
  assert.equal(gotBuf.size, 12);

  const nowSec = Math.floor(Date.now() / 1000);
  const localPresigned = new URL(await localFiles.presignUrl('hello.txt', { method: 'PUT', expiresIn: 600 }));
  const expDiff = Number(localPresigned.searchParams.get('expires')) - nowSec;
  assert(expDiff >= 595 && expDiff <= 605, `Expected expiresIn=600 TTL, got ${expDiff}s`);

  const cloudFiles = createCloudStorage('skill-proj', {
    MYSHIP_COS_ORIGIN: 'https://test-1250000000.cos.ap-guangzhou.myqcloud.com',
    TENCENT_SECRET_ID: 'AKIDtest123',
    TENCENT_SECRET_KEY: 'SKtest456',
  }).files;
  const cloudPresigned = new URL(await cloudFiles.presignUrl('hello.txt', { method: 'PUT', expiresIn: 600 }));
  const [startStr, endStr] = cloudPresigned.searchParams.get('q-sign-time').split(';');
  const cloudTtl = Number(endStr) - Number(startStr) - 60;
  assert.equal(cloudTtl, 600, `Expected cloud presignUrl expiresIn=600, got ${cloudTtl}`);

  rmSync(skillTmp, { recursive: true, force: true });
});

test('8. Project scaffolding (`myship init --template static | edge | fullstack` & interactive create)', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-test-scaffold-'));
  try {
    // 1) Static template + idempotency (skip existing files unless overwrite=true)
    const staticDir = join(tmpRoot, 'my-static-site');
    const s1 = await scaffoldProjectTemplate(staticDir, { template: 'static' });
    assert.equal(s1.project, 'my-static-site');
    assert.equal(s1.template, 'static');
    assert.equal(s1.dir, '.');
    assert(s1.createdFiles.includes('index.html'));
    writeFileSync(join(staticDir, 'index.html'), '<h1>Custom Static</h1>', 'utf8');

    const s2 = await scaffoldProjectTemplate(staticDir, { template: 'static', overwrite: false });
    assert(s2.skippedFiles.includes('index.html'));
    assert.equal(readFileSync(join(staticDir, 'index.html'), 'utf8'), '<h1>Custom Static</h1>');

    const s3 = await scaffoldProjectTemplate(staticDir, { template: 'static', overwrite: true });
    assert(s3.createdFiles.includes('index.html'));
    assert(readFileSync(join(staticDir, 'index.html'), 'utf8').includes('MyShip Static Starter'));

    // 2) Edge template + end-to-end dev handler execution
    const edgeDir = join(tmpRoot, 'my-edge-app');
    const e1 = await scaffoldProjectTemplate(edgeDir, { template: 'edge' });
    assert.equal(e1.template, 'edge');
    assert(existsSync(join(edgeDir, 'api/hello.js')));
    const edgeHandler = createDevRequestHandler({
      staticDir: edgeDir,
      cwd: edgeDir,
      project: e1.project,
      storageDir: join(edgeDir, '.cas-storage'),
    });
    const edgePost = await edgeHandler(
      new Request('http://localhost:3000/api/hello', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 3 }),
      })
    );
    assert.equal(edgePost.status, 200);
    const edgeJson = await edgePost.json();
    assert.equal(edgeJson.ok, true);
    assert.equal(edgeJson.counter.count, 3);

    // 3) Fullstack template (via interactive prompt selection) + end-to-end dev handler & SCF bundler
    const fsDir = join(tmpRoot, 'my-fullstack-app');
    const f1 = await scaffoldProjectTemplate(fsDir, {
      interactive: true,
      promptAnswers: { template: 'fullstack' },
    });
    assert.equal(f1.template, 'fullstack');
    assert.equal(f1.dir, './public');
    assert(existsSync(join(fsDir, 'server/index.mjs')));
    assert(existsSync(join(fsDir, 'public/index.html')));

    const fsHandler = createDevRequestHandler({
      staticDir: join(fsDir, 'public'),
      cwd: fsDir,
      project: f1.project,
      storageDir: join(fsDir, '.cas-storage'),
    });
    const healthRes = await fsHandler(new Request('http://localhost:3000/api/health'));
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.capabilities.db, true);

    const noteRes = await fsHandler(
      new Request('http://localhost:3000/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Hello Scaffold DB' }),
      })
    );
    assert.equal(noteRes.status, 200);
    const noteJson = await noteRes.json();
    assert.equal(noteJson.notes[0].title, 'Hello Scaffold DB');

    const bundleRes = await bundleScfBackend({ cwd: fsDir });
    assert(bundleRes.zipEntries.includes('server/index.mjs'));
    assert(bundleRes.zipEntries.includes('server/templates/banner.txt'));
    assert(bundleRes.zipEntries.includes('_myship/bootstrap.mjs'));
    assert(bundleRes.zipSizeBytes > 1000);

    // Verify fullstack project.json does NOT falsely mark resources.db.enabled = true before `myship use db`
    const fsProjectCfg = JSON.parse(readFileSync(join(fsDir, '.myship/project.json'), 'utf8'));
    assert.equal(fsProjectCfg.resources?.storage?.enabled, true);
    assert.equal(fsProjectCfg.resources?.db, undefined);

    // Verify generated server/index.mjs returns friendly 503 needsSetup when cloud DB is unconfigured
    const fsServerMod = await import(`file://${join(fsDir, 'server/index.mjs')}`);
    const unconfHealth = await fsServerMod.fetch(new Request('http://localhost/api/health'), {
      project: f1.project,
      db: { provider: 'unconfigured' },
      storage: {},
      files: {},
    });
    const unconfHealthBody = await unconfHealth.json();
    assert.equal(unconfHealthBody.capabilities.db, false);
    assert.equal(unconfHealthBody.dbProvider, 'unconfigured');

    const unconfNotes = await fsServerMod.fetch(new Request('http://localhost/api/notes'), {
      project: f1.project,
      db: { provider: 'unconfigured' },
    });
    assert.equal(unconfNotes.status, 503);
    const unconfNotesBody = await unconfNotes.json();
    assert.equal(unconfNotesBody.ok, false);
    assert.equal(unconfNotesBody.needsSetup, true);
    assert.equal(unconfNotesBody.setupCommand, 'myship use db');

    // 4) Preserving existing .myship/project.json & respecting package.json name when overwrite=false
    const existingDir = join(tmpRoot, 'folder-name-ignored');
    mkdirSync(join(existingDir, '.myship'), { recursive: true });
    writeFileSync(
      join(existingDir, '.myship/project.json'),
      JSON.stringify(
        {
          project: 'existing-custom-proj',
          dir: './dist',
          prodDomain: 'custom-prod',
          backend: {
            enabled: true,
            provider: 'scf',
            region: 'ap-shanghai',
            entry: 'custom/server.mjs',
            functionName: 'myship-existing-custom-proj',
            gatewayToken: 'tok_keep_me',
            role: 'SCF_QcsRole',
          },
        },
        null,
        2
      ),
      'utf8'
    );
    const exRes = await scaffoldProjectTemplate(existingDir, {
      template: 'fullstack',
      overwrite: false,
    });
    assert.equal(exRes.project, 'existing-custom-proj');
    assert.equal(exRes.dir, './dist');
    assert(exRes.skippedFiles.includes('.myship/project.json'));
    const preservedJson = JSON.parse(
      readFileSync(join(existingDir, '.myship/project.json'), 'utf8')
    );
    assert.equal(preservedJson.project, 'existing-custom-proj');
    assert.equal(preservedJson.dir, './dist');
    assert.equal(preservedJson.prodDomain, 'custom-prod');
    assert.equal(preservedJson.backend.gatewayToken, 'tok_keep_me');
    assert.equal(preservedJson.backend.role, 'SCF_QcsRole');
    assert.equal(preservedJson.backend.entry, 'custom/server.mjs');

    // Also verify running setupCiWorkflow (or `myship init --template fullstack --ci`) preserves custom prodDomain and existing project.json
    const ciOnExisting = setupCiWorkflow(existingDir, { overwrite: false });
    assert.equal(ciOnExisting.project, 'existing-custom-proj');
    assert.equal(ciOnExisting.buildDir, './dist');
    const afterCiJson = JSON.parse(
      readFileSync(join(existingDir, '.myship/project.json'), 'utf8')
    );
    assert.equal(afterCiJson.prodDomain, 'custom-prod');
    assert.equal(afterCiJson.backend.gatewayToken, 'tok_keep_me');

    // 5) Real CLI subprocess test: `myship init --template fullstack --dir ./demo --ci`
    const cliEntry = resolve(__dirname, '../myship.mjs');
    const cliRes = spawnSync(
      process.execPath,
      [cliEntry, 'init', '--template', 'fullstack', '--dir', './demo', '--ci'],
      { cwd: tmpRoot, encoding: 'utf8' }
    );
    assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}`);
    const demoDir = join(tmpRoot, 'demo');
    const demoProjJson = JSON.parse(readFileSync(join(demoDir, '.myship/project.json'), 'utf8'));
    assert.equal(demoProjJson.project, 'demo');
    assert.equal(demoProjJson.dir, './public');
    const demoCiYaml = readFileSync(join(demoDir, '.github/workflows/myship.yml'), 'utf8');
    assert(demoCiYaml.includes('MYSHIP_DIR: "./public"'));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('myship dev SSE real-time streaming & exact Source Map path without duplicate server/server prefix', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-sse-sourcemap-test-'));
  try {
    mkdirSync(join(tmpRoot, 'public'), { recursive: true });
    mkdirSync(join(tmpRoot, 'server'), { recursive: true });
    writeFileSync(join(tmpRoot, 'public', 'index.html'), '<h1>SSE Test</h1>', 'utf8');
    writeFileSync(
      join(tmpRoot, 'server', 'index.mjs'),
      `export async function fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/crash') {
    throw new Error('boom-from-line-4');
  }
  if (url.pathname === '/api/sse') {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('data: chunk-1\\n\\n'));
        await new Promise((r) => setTimeout(r, 180));
        controller.enqueue(encoder.encode('data: chunk-2\\n\\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }
  return Response.json({ ok: true });
}
`,
      'utf8'
    );

    // 1. Check inline source map sources array does NOT have duplicate `server/` prefix
    const bundleRes = await bundleScfBackend({ cwd: tmpRoot, targetDir: join(tmpRoot, 'public') });
    const smMatch = bundleRes.appBundleCode.match(
      /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/
    );
    assert(smMatch, 'Should contain inline base64 source map');
    const smJson = JSON.parse(Buffer.from(smMatch[1], 'base64').toString('utf8'));
    assert.deepEqual(smJson.sources, ['index.mjs'], 'Source map source relative to server/ must be index.mjs');

    // 2. Check runtime error stack in dev mode resolves to `server/index.mjs:4`, never `server/server/index.mjs`
    const devServer = await startDevServer({
      staticDir: join(tmpRoot, 'public'),
      cwd: tmpRoot,
      project: 'sse-demo',
      port: 0,
      storageDir: join(tmpRoot, '.cas-storage'),
    });
    const port = devServer.address().port;

    try {
      const crashRes = await fetch(`http://127.0.0.1:${port}/api/crash`);
      assert.equal(crashRes.status, 500);
      const logFile = join(tmpRoot, '.myship', 'data', 'sse-demo', '__myship_logs.json');
      const logsDoc = JSON.parse(readFileSync(logFile, 'utf8'));
      const latestLog = (logsDoc.value || logsDoc)[0];
      assert(latestLog.stack.includes('server/index.mjs:4'), `Expected server/index.mjs:4 in stack: ${latestLog.stack}`);
      assert(!latestLog.stack.includes('server/server/index.mjs'), `Must not duplicate server/ prefix: ${latestLog.stack}`);

      // 3. Verify real-time SSE chunk-by-chunk arrival (chunk-1 arrives well before chunk-2)
      const sseRes = await fetch(`http://127.0.0.1:${port}/api/sse`);
      assert.equal(sseRes.status, 200);
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      const chunkTimestamps = [];
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        if (text.trim()) {
          chunks.push(text.trim());
          chunkTimestamps.push(Date.now());
        }
      }
      assert.equal(chunks.length, 2, `Should receive 2 distinct SSE chunks, got: ${JSON.stringify(chunks)}`);
      assert.equal(chunks[0], 'data: chunk-1');
      assert.equal(chunks[1], 'data: chunk-2');
      assert(
        chunkTimestamps[1] - chunkTimestamps[0] >= 100,
        `SSE chunks must stream progressively over time (delta: ${chunkTimestamps[1] - chunkTimestamps[0]}ms)`
      );
    } finally {
      await new Promise((r) => devServer.close(r));
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('SCF runtime server dynamically hot-reloads envs/<project>.json on already-published versions without redeploy', async () => {
  let currentRemoteVars = { HOT_KEY: 'v1-initial', EXTRA_FLAG: 'yes' };
  const putPaths = [];
  const mockCosServer = http.createServer((req, res) => {
    if (req.url.startsWith('/envs/hot-app.json')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ project: 'hot-app', vars: currentRemoteVars }));
      return;
    }
    if (req.method === 'PUT' && req.url.startsWith('/data/hot-app/')) {
      putPaths.push(req.url.split('?')[0]);
      res.statusCode = 200;
      res.end('OK');
      return;
    }
    res.statusCode = 404;
    res.end('Not Found');
  });
  await new Promise((r) => mockCosServer.listen(0, '127.0.0.1', r));
  const cosPort = mockCosServer.address().port;

  const savedEnv = { ...process.env };
  process.env.PORT = '0';
  process.env.MYSHIP_PROJECT = 'hot-app';
  process.env.MYSHIP_GATEWAY_TOKEN = 'msgt_hot_test';
  process.env.MYSHIP_COS_ORIGIN = `http://127.0.0.1:${cosPort}`;
  process.env.MYSHIP_DATA_SECRET_ID = 'AKIDhottest';
  process.env.MYSHIP_DATA_SECRET_KEY = 'SKhottest';
  process.env.MYSHIP_PROJECT_ENV_KEYS = 'HOT_KEY,BAKED_ONLY_KEY';
  process.env.HOT_KEY = 'baked-in-v0';
  process.env.BAKED_ONLY_KEY = 'should-be-deleted-on-cold-start';

  const scfServer = startScfRuntimeServer({
    async fetch(_req, ctx) {
      await ctx.storage.set('probe', { ok: true });
      return Response.json({
        hotKey: ctx.env.HOT_KEY || null,
        bakedOnlyKey: ctx.env.BAKED_ONLY_KEY || null,
        extraFlag: ctx.env.EXTRA_FLAG || null,
        procHotKey: process.env.HOT_KEY || null,
        dbProvider: ctx.db.provider,
      });
    },
  });
  if (!scfServer.listening) {
    await new Promise((r) => scfServer.once('listening', r));
  }
  const scfPort = scfServer.address().port;

  try {
    const r1 = await fetch(`http://127.0.0.1:${scfPort}/api/env-check`, {
      headers: { 'x-myship-gateway-token': 'msgt_hot_test' },
    });
    const j1 = await r1.json();
    assert.equal(j1.hotKey, 'v1-initial');
    assert.equal(j1.bakedOnlyKey, null, 'Baked-in key absent from remote envs must be cleared on cold start');
    assert.equal(j1.extraFlag, 'yes');
    assert.equal(j1.procHotKey, 'v1-initial');
    assert.equal(j1.dbProvider, 'unconfigured');
    assert.equal(putPaths[putPaths.length - 1], '/data/hot-app/probe.json');

    // Simulate `myship env set HOT_KEY=v2-updated` & `myship env rm EXTRA_FLAG` & DB + Storage namespace update on COS
    currentRemoteVars = {
      HOT_KEY: 'v2-updated',
      MYSHIP_DB_PROVIDER: 'turso',
      TURSO_DATABASE_URL: 'libsql://hot-app.turso.io',
      TURSO_AUTH_TOKEN: 'tok_test_123',
      MYSHIP_STORAGE_ENV: 'staging',
    };
    await new Promise((r) => setTimeout(r, 2100));

    const r2 = await fetch(`http://127.0.0.1:${scfPort}/api/env-check`, {
      headers: { 'x-myship-gateway-token': 'msgt_hot_test' },
    });
    const j2 = await r2.json();
    assert.equal(j2.hotKey, 'v2-updated', 'Already-deployed SCF version must reflect updated env');
    assert.equal(j2.extraFlag, null, 'Removed env key must be cleaned up on hot reload');
    assert.equal(j2.dbProvider, 'turso', 'DB client must be recreated when DB env vars change');
    assert.equal(
      putPaths[putPaths.length - 1],
      '/data/hot-app/staging/probe.json',
      'Storage client must be recreated when MYSHIP_STORAGE_ENV changes'
    );
  } finally {
    await new Promise((r) => scfServer.close(r));
    await new Promise((r) => mockCosServer.close(r));
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  }
});

test('SCF api-dir bundler supports api/upstreams.json and export const upstreamUrl proxy routes end-to-end', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-api-proxy-test-'));
  const receivedRequests = [];
  const upstreamServer = http.createServer((req, res) => {
    receivedRequests.push({
      method: req.method,
      url: req.url,
      project: req.headers['x-myship-project'],
      route: req.headers['x-myship-function-route'],
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, upstreamUrl: req.url }));
  });
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
  const upstreamPort = upstreamServer.address().port;

  try {
    mkdirSync(join(tmpRoot, 'public'), { recursive: true });
    mkdirSync(join(tmpRoot, 'api'), { recursive: true });
    writeFileSync(join(tmpRoot, 'public', 'index.html'), '<h1>Proxy Demo</h1>', 'utf8');
    writeFileSync(
      join(tmpRoot, 'api', 'upstreams.json'),
      JSON.stringify({ '/api/orders': `http://127.0.0.1:${upstreamPort}` }),
      'utf8'
    );
    writeFileSync(
      join(tmpRoot, 'api', 'js-proxy.js'),
      `export const upstreamUrl = 'http://127.0.0.1:${upstreamPort}/v1/js';\n`,
      'utf8'
    );

    const bundleRes = await bundleScfBackend({ cwd: tmpRoot, targetDir: join(tmpRoot, 'public') });
    assert.equal(bundleRes.mode, 'api-dir');

    // Execute the compiled bundle directly to verify real outbound proxy execution
    const bundlePath = join(tmpRoot, 'compiled-api-bundle.mjs');
    writeFileSync(bundlePath, bundleRes.appBundleCode, 'utf8');
    const mod = await import(`file://${bundlePath}`);

    const r1 = await mod.fetch(new Request('http://demo.ship.test/api/orders?id=1'), {
      project: 'proxy-app',
    });
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.upstreamUrl, '/api/orders?id=1', 'Root upstream URL must preserve request pathname and query');

    const r2 = await mod.fetch(new Request('http://demo.ship.test/api/js-proxy?foo=bar'), {
      project: 'proxy-app',
    });
    assert.equal(r2.status, 200);
    const j2 = await r2.json();
    assert.equal(j2.upstreamUrl, '/v1/js?foo=bar', 'Explicit upstream path must preserve target path and append query');
    assert.equal(receivedRequests.length, 2);
    assert.equal(receivedRequests[0].project, 'proxy-app');
    assert.equal(receivedRequests[0].route, '/api/orders');
    assert.equal(receivedRequests[1].route, '/api/js-proxy');
  } finally {
    await new Promise((r) => upstreamServer.close(r));
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Reversible online/offline & version disable across project, alias, deployment, rollback, Console API, and Edge SWR', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'myship-availability-test-'));
  const storageDir = join(tmpRoot, '.cas-storage');
  const distDir = join(tmpRoot, 'dist');
  mkdirSync(distDir, { recursive: true });

  let scfHits = 0;
  const mockScfServer = http.createServer((req, res) => {
    scfHits++;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((r) => mockScfServer.listen(0, '127.0.0.1', r));
  const scfPort = mockScfServer.address().port;

  function makeStorageReader() {
    return {
      getAlias: (sub) => {
        const p = join(storageDir, 'aliases', `${sub}.json`);
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
      },
      getManifest: (id) => {
        const p = join(storageDir, 'manifests', `${id}.json`);
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
      },
      getBlob: (sha) => {
        const p = join(storageDir, 'blobs', sha);
        return existsSync(p) ? readFileSync(p) : null;
      },
    };
  }

  try {
    // Deploy v1, v2, v3 for project 'avail-app'
    writeFileSync(join(distDir, 'index.html'), '<h1>v1</h1>', 'utf8');
    const v1 = deployDirectory(distDir, {
      storageDir,
      project: 'avail-app',
      aliases: ['avail-app', 'avail-app-staging'],
    });
    await new Promise((r) => setTimeout(r, 15));

    writeFileSync(join(distDir, 'index.html'), '<h1>v2-vulnerable</h1>', 'utf8');
    const v2 = deployDirectory(distDir, {
      storageDir,
      project: 'avail-app',
      aliases: ['avail-app'],
    });
    await new Promise((r) => setTimeout(r, 15));

    writeFileSync(join(distDir, 'index.html'), '<h1>v3-safe</h1>', 'utf8');
    const v3 = deployDirectory(distDir, {
      storageDir,
      project: 'avail-app',
      aliases: ['avail-app'],
    });

    // Attach SCF backend info to v3 manifest to test /api/* edge short-circuiting
    const v3ManifestPath = join(storageDir, 'manifests', `${v3.deploymentId}.json`);
    const v3Manifest = JSON.parse(readFileSync(v3ManifestPath, 'utf8'));
    v3Manifest.backend = {
      provider: 'scf',
      functionName: 'myship-avail-app',
      scfVersion: '1',
      upstreamUrl: `http://127.0.0.1:${scfPort}`,
      prefix: '/api',
      gatewayToken: 'msgt_avail_123',
    };
    writeFileSync(v3ManifestPath, JSON.stringify(v3Manifest, null, 2), 'utf8');

    // 1) Disable vulnerable deployment v2 (`myship offline <v2>`)
    const disableV2Res = await setAvailabilityState({
      action: 'offline',
      project: 'avail-app',
      deploymentIds: [v2.deploymentId],
      reason: 'CVE-2026-0001 修复中',
      isLocal: true,
      storageDir,
    });
    assert.equal(disableV2Res.scope, 'deployment');

    // Immutable preview URL for v2 must return 503 HTML for browser
    const v2PreviewRes = await handleEdgeRequest(
      new Request(`http://${v2.immutableSubdomain}.ship.localhost:4100/`, {
        headers: { Accept: 'text/html' },
      }),
      makeStorageReader()
    );
    assert.equal(v2PreviewRes.status, 503);
    assert.equal(v2PreviewRes.headers.get('x-myship-status'), 'offline');
    const v2Html = await v2PreviewRes.text();
    assert(v2Html.includes('CVE-2026-0001 修复中'));

    // Switching alias to disabled v2 must be rejected
    assert.throws(
      () => setAlias('avail-app', v2.deploymentId, { storageDir, project: 'avail-app' }),
      /当前处于已禁用状态/
    );

    // Automatic rollback from v3 must skip disabled v2 (even though previousDeploymentId is v2!) and land on v1
    const rolledAlias = rollbackAlias('avail-app', null, { storageDir, project: 'avail-app' });
    assert.equal(
      rolledAlias.deploymentId,
      v1.deploymentId,
      'Rollback must skip disabled v2 and fall back to v1'
    );
    // Switch back to v2 for rollback-with-newer-preview test:
    // Suppose v1 is disabled, avail-app is at v3 (with previousDeploymentId = v1), and v3_preview is a newer --preview deployment
    await setAvailabilityState({
      action: 'offline',
      project: 'avail-app',
      deploymentIds: [v1.deploymentId],
      reason: 'v1 也被禁用',
      isLocal: true,
      storageDir,
    });
    setAlias('avail-app', v3.deploymentId, { storageDir, project: 'avail-app', silent: true });
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(join(distDir, 'index.html'), '<h1>v3-unreleased-preview</h1>', 'utf8');
    const vPreview = deployDirectory(distDir, {
      storageDir,
      project: 'avail-app',
      aliases: [],
    });
    assert.throws(
      () => rollbackAlias('avail-app', null, { storageDir, project: 'avail-app' }),
      /历史候选版本均处于已禁用状态/,
      `Rollback from v3 when v1 & v2 are disabled must NOT promote newer unreleased preview ${vPreview.deploymentId}`
    );
    await setAvailabilityState({
      action: 'online',
      project: 'avail-app',
      deploymentIds: [v1.deploymentId],
      isLocal: true,
      storageDir,
    });

    // Regression: concurrent `offline <v1>` and `online <project>` must not clobber v1's disabled flag
    await setAvailabilityState({
      action: 'offline',
      project: 'avail-app',
      reason: '准备并发测试',
      isLocal: true,
      storageDir,
    });
    await Promise.all([
      setAvailabilityState({
        action: 'offline',
        project: 'avail-app',
        deploymentIds: [v1.deploymentId],
        reason: '并发禁用 v1',
        isLocal: true,
        storageDir,
      }),
      setAvailabilityState({
        action: 'online',
        project: 'avail-app',
        isLocal: true,
        storageDir,
      }),
    ]);
    const v1AfterConcurrent = JSON.parse(
      readFileSync(join(storageDir, 'manifests', `${v1.deploymentId}.json`), 'utf8')
    );
    assert.equal(
      v1AfterConcurrent.disabled,
      true,
      'Concurrent project online must not overwrite concurrent deployment disable on v1'
    );
    assert.equal(v1AfterConcurrent.projectDisabled, undefined);
    await setAvailabilityState({
      action: 'online',
      project: 'avail-app',
      deploymentIds: [v1.deploymentId],
      isLocal: true,
      storageDir,
    });

    // 2) Project-wide offline (`myship offline`) + online (`myship online`) preserves v2's individual disabled state
    await setAvailabilityState({
      action: 'offline',
      project: 'avail-app',
      reason: '夜间数据库割接维护',
      isLocal: true,
      storageDir,
    });

    // Both mutable prod alias and immutable v3 preview must return 503, and /api/* must NOT hit SCF
    const apiPausedRes = await handleEdgeRequest(
      new Request('http://avail-app.ship.localhost:4100/api/posts'),
      makeStorageReader()
    );
    assert.equal(apiPausedRes.status, 503);
    assert.equal(scfHits, 0, 'Paused project must short-circuit at edge without hitting SCF');
    const apiPausedJson = await apiPausedRes.json();
    assert.equal(apiPausedJson.error, 'SERVICE_UNAVAILABLE');
    assert.equal(apiPausedJson.reason, '夜间数据库割接维护');

    const v3PreviewPausedRes = await handleEdgeRequest(
      new Request(`http://${v3.immutableSubdomain}.ship.localhost:4100/`),
      makeStorageReader()
    );
    assert.equal(v3PreviewPausedRes.status, 503);

    // Deploying v4 while project is offline must inherit projectDisabled: true
    writeFileSync(join(distDir, 'index.html'), '<h1>v4-while-paused</h1>', 'utf8');
    const v4 = deployDirectory(distDir, {
      storageDir,
      project: 'avail-app',
      aliases: ['avail-app'],
    });
    assert.equal(v4.manifest.projectDisabled, true);

    // Bring project back online (`myship online`)
    await setAvailabilityState({
      action: 'online',
      project: 'avail-app',
      isLocal: true,
      storageDir,
    });

    const prodOnlineRes = await handleEdgeRequest(
      new Request('http://avail-app.ship.localhost:4100/'),
      makeStorageReader()
    );
    assert.equal(prodOnlineRes.status, 200);
    assert.equal(await prodOnlineRes.text(), '<h1>v4-while-paused</h1>');

    // Crucially, v2 must STILL be disabled after project-level `online`!
    const v2StillDisabledRes = await handleEdgeRequest(
      new Request(`http://${v2.immutableSubdomain}.ship.localhost:4100/`),
      makeStorageReader()
    );
    assert.equal(
      v2StillDisabledRes.status,
      503,
      'Project-level online must NOT re-enable individually disabled deployment v2'
    );

    // 3) Alias-level pause (`myship offline --alias staging`) and Console API `/api/console/availability`
    await setAvailabilityState({
      action: 'offline',
      project: 'avail-app',
      aliases: ['staging'],
      reason: '测试环境暂停对外',
      isLocal: true,
      storageDir,
    });
    const stagingPausedRes = await handleEdgeRequest(
      new Request('http://avail-app-staging.ship.localhost:4100/'),
      makeStorageReader()
    );
    assert.equal(stagingPausedRes.status, 503);

    // Switching paused alias to v3 must preserve its paused state
    setAlias('avail-app-staging', v3.deploymentId, {
      storageDir,
      project: 'avail-app',
      silent: true,
    });
    const stagingStillPausedRes = await handleEdgeRequest(
      new Request('http://avail-app-staging.ship.localhost:4100/'),
      makeStorageReader()
    );
    assert.equal(stagingStillPausedRes.status, 503);

    // Re-enable staging alias via Console API `POST /api/console/availability`
    const consoleHandler = createConsoleRequestHandler({
      isLocal: true,
      storageDir,
      cwd: tmpRoot,
    });
    const consoleServer = http.createServer(consoleHandler);
    await new Promise((r) => consoleServer.listen(0, '127.0.0.1', r));
    const consolePort = consoleServer.address().port;
    try {
      const toggleRes = await fetch(`http://127.0.0.1:${consolePort}/api/console/availability`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-MyShip-Console': '1',
        },
        body: JSON.stringify({
          action: 'online',
          project: 'avail-app',
          subdomain: 'avail-app-staging',
          raw: true,
        }),
      });
      assert.equal(toggleRes.status, 200);
    } finally {
      await new Promise((r) => consoleServer.close(r));
    }

    const stagingOnlineRes = await handleEdgeRequest(
      new Request('http://avail-app-staging.ship.localhost:4100/'),
      makeStorageReader()
    );
    assert.equal(stagingOnlineRes.status, 200);

    // 4) Cloud EdgeOne Function (`edgeone-function.template.js`) 2.5s SWR on MANIFEST_CACHE & ALIAS_CACHE
    let remoteManifestDisabled = false;
    const mockCos = http.createServer((req, res) => {
      const reqPathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (reqPathname === '/manifests/dpl_11223344.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'dpl_11223344',
            project: 'demo',
            immutableSubdomain: 'demo-11223344',
            ...(remoteManifestDisabled
              ? { disabled: true, disabledReason: '云端边缘 2.5s 禁用生效' }
              : {}),
            files: {
              '/index.html': { sha256: 'sha_idx', size: 11, contentType: 'text/html' },
            },
            functions: {
              '/api/hello': { sha256: 'fn_sha_1', runtime: 'edge-js', source: 'api/hello.js' },
            },
          })
        );
        return;
      }
      if (reqPathname === '/blobs/sha_idx') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('hello-cloud');
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    await new Promise((r) => mockCos.listen(0, '127.0.0.1', r));
    const cosPort = mockCos.address().port;

    try {
      const edgeOutPath = join(tmpRoot, 'edgeone.dist.js');
      const { code: edgeCode } = generateEdgeFunctionCode({
        cosOrigin: `http://127.0.0.1:${cosPort}`,
        outputPath: edgeOutPath,
        silent: true,
      });
      let registeredListener = null;
      const sandbox = {
        Request,
        Response,
        Headers,
        URL,
        fetch,
        Date,
        Map,
        Set,
        Promise,
        JSON,
        Math,
        String,
        Number,
        Boolean,
        Array,
        Object,
        RegExp,
        Error,
        encodeURIComponent,
        decodeURIComponent,
        addEventListener: (_type, fn) => {
          registeredListener = fn;
        },
      };
      vm.runInNewContext(edgeCode, sandbox);
      assert.equal(typeof registeredListener, 'function');

      async function invokeEdge(reqUrl) {
        let respPromise = null;
        const waitPromises = [];
        registeredListener({
          request: new Request(reqUrl, { headers: { Accept: 'application/json' } }),
          respondWith(p) {
            respPromise = p;
          },
          waitUntil(p) {
            waitPromises.push(p);
          },
        });
        const resp = await respPromise;
        await Promise.all(waitPromises);
        return resp;
      }

      const { code: apiWorkerCode } = generateProjectApiWorkerCode({
        project: 'demo',
        cosOrigin: `http://127.0.0.1:${cosPort}`,
        silent: true,
        functionsPool: {
          fn_sha_1: {
            sha256: 'fn_sha_1',
            project: 'demo',
            route: '/api/hello',
            source: 'api/hello.js',
            code: 'export default function() { return { ok: true, worker: "dedicated" }; }',
          },
        },
        envsPool: {},
      });
      let apiListener = null;
      const apiSandbox = {
        ...sandbox,
        addEventListener: (_type, fn) => {
          apiListener = fn;
        },
      };
      vm.runInNewContext(apiWorkerCode, apiSandbox);
      assert.equal(typeof apiListener, 'function');

      async function invokeApiWorker(reqUrl) {
        let respPromise = null;
        const waitPromises = [];
        apiListener({
          request: new Request(reqUrl, { headers: { Accept: 'application/json' } }),
          respondWith(p) {
            respPromise = p;
          },
          waitUntil(p) {
            waitPromises.push(p);
          },
        });
        const resp = await respPromise;
        await Promise.all(waitPromises);
        return resp;
      }

      // Initial request to immutable preview URL -> 200 OK on both routers
      const r1 = await invokeEdge('https://demo-11223344.ship.example.com/');
      assert.equal(r1.status, 200);
      assert.equal(await r1.text(), 'hello-cloud');

      const apiR1 = await invokeApiWorker('https://demo-11223344.ship.example.com/api/hello');
      assert.equal(apiR1.status, 200);
      assert.equal((await apiR1.json()).worker, 'dedicated');

      // Flip manifest to disabled on COS and advance beyond 2.5s SWR TTL
      remoteManifestDisabled = true;
      await new Promise((r) => setTimeout(r, 2600));

      // First request after 2.5s triggers background SWR revalidation; next request sees 503!
      await invokeEdge('https://demo-11223344.ship.example.com/');
      const r3 = await invokeEdge('https://demo-11223344.ship.example.com/');
      assert.equal(r3.status, 503, 'Edge MANIFEST_CACHE SWR must reflect disabled manifest after 2.5s');
      const r3Json = await r3.json();
      assert.equal(r3Json.error, 'SERVICE_UNAVAILABLE');
      assert.equal(r3Json.reason, '云端边缘 2.5s 禁用生效');

      await invokeApiWorker('https://demo-11223344.ship.example.com/api/hello');
      const apiR3 = await invokeApiWorker('https://demo-11223344.ship.example.com/api/hello');
      assert.equal(
        apiR3.status,
        503,
        'Dedicated API Worker MANIFEST_CACHE SWR must also reflect disabled manifest after 2.5s'
      );
      const apiR3Json = await apiR3.json();
      assert.equal(apiR3Json.error, 'SERVICE_UNAVAILABLE');
      assert.equal(apiR3Json.reason, '云端边缘 2.5s 禁用生效');
    } finally {
      await new Promise((r) => mockCos.close(r));
    }

    // 10. Verify withKeyWriteLock rejection does not trigger unhandledRejection
    let unhandledRejected = null;
    const onUnhandled = (err) => {
      unhandledRejected = err;
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        () =>
          withKeyWriteLock('test-reject-lock', async () => {
            throw new Error('simulated-write-failure');
          }),
        /simulated-write-failure/
      );
      await new Promise((r) => setImmediate(r));
      assert.equal(
        unhandledRejected,
        null,
        'Rejected task in withKeyWriteLock must not emit unhandledRejection'
      );
      const afterRecovery = await withKeyWriteLock('test-reject-lock', async () => 'recovered-ok');
      assert.equal(afterRecovery, 'recovered-ok');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  } finally {
    await new Promise((r) => mockScfServer.close(r));
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
