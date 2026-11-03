import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runEnvCommand,
  bundleScfBackend,
  createLocalFileStorage,
  createDatabaseClient,
  closeDatabasePools,
  runUseCommand,
  resolveProjectResourceEnv,
} from '../myship.mjs';

test('11. Multi-Engine DB Runtime, Pool Reuse, Transaction Schema Isolation & Security Suite', async (t) => {
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

  // 1. `.myship/project.json` 严禁包含密码/连接串，且 PGOPTIONS / search_path 注入到位
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
  assert(
    !projectJsonText.includes('TopSecretPass999'),
    '.myship/project.json must not contain DB password'
  );
  assert(
    !projectJsonText.includes('databaseUrl'),
    '.myship/project.json must not contain databaseUrl'
  );

  const resolvedPgEnv = resolveProjectResourceEnv(projDir, 'review-app', storageDir);
  assert.equal(resolvedPgEnv.PGPASSWORD, 'TopSecretPass999');
  assert.equal(resolvedPgEnv.PG_SCHEMA, 'myship_review_app');
  assert.equal(resolvedPgEnv.PGOPTIONS, '-c search_path=myship_review_app,public');

  // 2. 切换 DB Provider 时清理旧 Provider 托管变量，同时保留用户自定义变量
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
  assert.equal(neonSwitchedEnv.TURSO_DATABASE_URL, undefined);
  assert.equal(neonSwitchedEnv.TURSO_AUTH_TOKEN, undefined);
  const fullEnvDoc = JSON.parse(readFileSync(join(storageDir, 'envs', 'review-app.json'), 'utf8'));
  assert.equal(fullEnvDoc.vars.CUSTOM_USER_KEY, 'keep_me_alive');
  const projectJsonAfterSwitch = readFileSync(join(projDir, '.myship', 'project.json'), 'utf8');
  assert(!projectJsonAfterSwitch.includes('NeonPass123'));
  assert(!projectJsonAfterSwitch.includes('turso_secret_tok'));

  const dbClientAfterSwitch = createDatabaseClient({
    cwd: projDir,
    project: 'review-app',
    env: {
      ...neonSwitchedEnv,
      TURSO_DATABASE_URL: 'https://stale.turso.io',
      TURSO_AUTH_TOKEN: 'stale_token',
    },
    preferLocalSqlite: false,
  });
  assert.equal(dbClientAfterSwitch.provider, 'neon');

  // 3. 云端 SCF 打包产物 (`bundleScfBackend`) 支持 `TCB_ENV_ID` (`ExecutePGSql`) 且查询自动前置 `SET search_path`
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
      const queryCall = tcbSqlLogs.find((item) =>
        String(item.Sql).includes('SELECT id, title FROM notes')
      );
      assert(queryCall, 'Cloud SCF bundle must invoke ExecutePGSql');
      assert.equal(
        queryCall.Sql,
        'SET search_path TO "myship_review_app", public; SELECT id, title FROM notes WHERE id = 1'
      );
    } finally {
      child.kill('SIGTERM');
    }

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
    assert.equal(plainPgEnv.TCB_ENV_ID, undefined);
    assert.equal(plainPgEnv.PGHOST, '127.0.0.1');
  } finally {
    delete process.env.TCB_API_ENDPOINT;
    mockTcbSrv.close();
  }

  // 4. `myship use storage --env staging` 切回 `myship use storage` (prod)
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
  assert(existsSync(join(projDir, '.myship', 'files', 'review-app', 'check.txt')));
  assert(!existsSync(join(projDir, '.myship', 'files', 'review-app', 'staging', 'check.txt')));

  // 5. MySQL 8 `0xfe` AuthSwitchRequest (`caching_sha2_password` -> `0x01 0x03` fast auth -> `0x00` OK)
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

  // 6. `myship env rm` 删除凭证后绝不被缓存复活，`myship env set` 更新连接串时自动同步 PGHOST/PGPASSWORD
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
  assert.equal(afterRmEnv.DATABASE_URL, undefined);
  assert.equal(afterRmEnv.NEON_DATABASE_URL, undefined);
  assert.equal(afterRmEnv.PGPASSWORD, undefined);

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

  // 7. Neon HTTP `/sql` 在设置 PG_SCHEMA 时使用单事务 `queries: [SET LOCAL search_path, query]`
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
      preferLocalSqlite: true,
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

  // 8. `executePostgresSimpleSqlViaWire` 对 `42P04` (duplicate_database) 保持幂等
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
          Buffer.concat([buildPgMsg('R', authOk), buildPgMsg('Z', Buffer.from('I', 'ascii'))])
        );
        return;
      }
      if (chunk[0] === 0x51) {
        dupDbQueries.push(chunk.subarray(5, chunk.length - 1).toString('utf8'));
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
    assert.equal(dupDbRes.provisionStatus, 'created');
    assert.deepEqual(dupDbQueries, ['CREATE DATABASE "myship_dup_db_app"']);
  } finally {
    mockPgDupServer.close();
  }

  // 9. 本地 `pg.Pool` 连接池复用 + 空闲断连韧性 + 独立 `/tmp` 目录运行云端 `_myship/bootstrap.mjs`
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
          Buffer.concat([buildPgMsg('R', authOk), buildPgMsg('Z', Buffer.from('I', 'ascii'))])
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
        sock.write(
          makeMysqlPacket(seq + 1, Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]))
        );
        return;
      }
      if (payload[0] === 0x03) {
        const p1 = makeMysqlPacket(seq + 1, Buffer.from([0x02]));
        const p2 = makeMysqlColDef(seq + 2, 'id');
        const p3 = makeMysqlColDef(seq + 3, 'title');
        const p4 = makeMysqlPacket(seq + 4, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]));
        const rowBody = Buffer.concat([
          makeLenEncStr('1'),
          makeLenEncStr('scf-mysql-bundled-ok'),
        ]);
        const p5 = makeMysqlPacket(seq + 5, rowBody);
        const p6 = makeMysqlPacket(seq + 6, Buffer.from([0xfe, 0x00, 0x00, 0x02, 0x00]));
        sock.write(Buffer.concat([p1, p2, p3, p4, p5, p6]));
      }
    });
  });
  await new Promise((r) => mockMysqlQueryServer.listen(0, '127.0.0.1', r));
  const mysqlQueryPort = mockMysqlQueryServer.address().port;

  try {
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
    assert.equal(pgPoolConnCount, 1, '6 consecutive requests must reuse the cached pg.Pool');

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
    const isolatedBundle = await bundleScfBackend({
      cwd: projDir,
      targetDir: join(projDir, 'dist'),
    });
    const isolatedTmpDir = mkdtempSync(join(tmpdir(), 'myship-isolated-scf-'));
    try {
      mkdirSync(join(isolatedTmpDir, '_myship'), { recursive: true });
      mkdirSync(join(isolatedTmpDir, 'server'), { recursive: true });
      writeFileSync(
        join(isolatedTmpDir, 'package.json'),
        JSON.stringify({ name: 'isolated-scf', private: true, type: 'module' }),
        'utf8'
      );
      writeFileSync(
        join(isolatedTmpDir, '_myship', 'bootstrap.mjs'),
        isolatedBundle.bootstrapJsCode,
        'utf8'
      );
      writeFileSync(
        join(isolatedTmpDir, 'server', 'index.mjs'),
        isolatedBundle.appBundleCode,
        'utf8'
      );

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
          const timer = setTimeout(
            () => rejectReady(new Error('Isolated MySQL SCF timeout')),
            5000
          );
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

    // 10. 验证 Neon `-pooler.` 连接串不会在 `resolveProjectResourceEnv` 注入 `PGOPTIONS` 或 `options=`，且 Turso 多组织选择 + 显式 `--group` 严格生效
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
        res.end(
          JSON.stringify({
            database: { Hostname: 'myship-turso-org-beta.turso.io', DbId: 'db-2' },
          })
        );
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
        promptAnswers: ['2'],
        isLocal: true,
        storageDir,
      });
      assert.equal(multiOrgRes.action, 'created');
      assert(
        tursoGroupsAttempted.some(
          (x) => x.path.includes('/org-beta/') && x.group === 'production'
        )
      );

      await assert.rejects(
        () =>
          runUseCommand({
            args: [
              'db',
              '--provider',
              'turso',
              '--org',
              'org-beta',
              '--token',
              'turso-tok-multi',
              '--group',
              'staging',
            ],
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
