import test, { before, after } from 'node:test';
import { Console } from 'node:console';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDevRequestHandler,
  runBackendCommand,
  createLocalFileStorage,
  createDatabaseClient,
  runUseCommand,
  resolveProjectResourceEnv,
} from '../myship.mjs';

const originalConsole = globalThis.console;
before(() => {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
});
after(() => {
  globalThis.console = originalConsole;
});

test('8. Declarative Resource Registration (`myship use storage|db`): COS files, CloudBase PG schema isolation, Turso & Cloudflare D1 auto-provisioning, and local node:sqlite parity', async (t) => {
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
  const pgAlpha = await runUseCommand({
    args: [
      'db',
      '--provider',
      'pg',
      '--url',
      'postgresql://pguser:pgpass@cb-pg.tencentcdb.com:5432/postgres',
    ],
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

  // 2b. 原生 MySQL 接入 (--provider mysql) + 全局默认数据库平台切换 + 单项目自定义 --raw 直连
  const mysqlGlobal = await runUseCommand({
    args: [
      'db',
      '--provider',
      'mysql',
      '--url',
      'mysql://root:pass@mysql.internal:3306/',
      '--default',
    ],
    cwd: appADir,
    explicitProject: 'app-alpha',
    isLocal: true,
    storageDir,
  });
  assert.equal(mysqlGlobal.provider, 'mysql');
  assert.equal(mysqlGlobal.dbName, 'myship_app_alpha');
  assert.equal(mysqlGlobal.databaseUrl, 'mysql://root:pass@mysql.internal:3306/myship_app_alpha');

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

  const gammaCustomRaw = await runUseCommand({
    args: [
      'db',
      '--provider',
      'mysql',
      '--url',
      'mysql://pro:sec@vip-mysql.com:3306/legacy_erp',
      '--raw',
    ],
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

  // 3. 模拟 Turso Platform API + Turso HTTP SQL + Cloudflare D1 API + Neon API v2 + Neon HTTP (/sql)
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

    if (req.method === 'GET' && req.url.startsWith('/v1/organizations/myorg/databases/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
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
    if (req.method === 'POST' && req.url.endsWith('/auth/tokens')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ jwt: 'turso_jwt_token_xyz' }));
      return;
    }
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

    if (req.method === 'GET' && req.url.startsWith('/accounts/cf_acc_1/d1/database')) {
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true, result: [] }));
      return;
    }
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

    if (req.method === 'GET' && req.url === '/projects') {
      res.statusCode = 200;
      res.end(JSON.stringify({ projects: [{ id: 'neon-proj-1', name: 'myship-neon' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/projects/neon-proj-1/branches') {
      res.statusCode = 200;
      res.end(JSON.stringify({ branches: [{ id: 'br-main-1', name: 'main', primary: true }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/projects/neon-proj-1/branches/br-main-1/databases') {
      res.statusCode = 200;
      res.end(
        JSON.stringify({ databases: [{ id: 1, name: 'neondb', owner_name: 'neondb_owner' }] })
      );
      return;
    }
    if (req.method === 'POST' && req.url === '/projects/neon-proj-1/branches/br-main-1/databases') {
      mockDbState.neonCreatedDbs.push(bodyJson.database?.name);
      res.statusCode = 201;
      res.end(JSON.stringify({ database: bodyJson.database }));
      return;
    }
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
    const tursoRows = await tursoRemoteDb.query('SELECT * FROM todos WHERE title = ?', [
      'hello-turso',
    ]);
    assert.equal(tursoRows.length, 1);
    assert.equal(tursoRows[0].id, 1);
    assert.equal(tursoRows[0].title, 'hello-turso');
    assert.equal(tursoRows.rows.length, 1);

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
    const neonRows = await neonRemoteDb.query('SELECT * FROM posts WHERE label = ?', [
      'hello-neon',
    ]);
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
      body: JSON.stringify({
        fileText: 'Saved via context.files!',
        itemName: 'First SQLite Row',
      }),
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

  const presignedReq = new Request(
    payload.presigned.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'http://localhost:3000')
  );
  const dlRes = await devHandler(presignedReq);
  assert.equal(dlRes.status, 200);
  assert.equal(await dlRes.text(), 'Saved via context.files!');
});

test('9. True Physical Provisioning: CloudBase PG ExecutePGSql (DDL DO $$ retry), PG & MySQL Wire Protocol, and PGHOST split env vars', async (t) => {
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
    assert.equal(
      tcbReceivedCalls[0].body.Sql,
      'CREATE SCHEMA IF NOT EXISTS "myship_app_cloudbase"'
    );
    assert.equal(
      tcbReceivedCalls[1].body.Sql,
      'DO LANGUAGE plpgsql $$ BEGIN EXECUTE \'CREATE SCHEMA IF NOT EXISTS "myship_app_cloudbase"\'; END $$'
    );

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

  const pgWireQueries = [];
  const mockPgWireServer = net.createServer((sock) => {
    let startupDone = false;
    sock.on('data', (chunk) => {
      if (!startupDone) {
        startupDone = true;
        const authOk = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]);
        const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
        sock.write(Buffer.concat([authOk, ready]));
        return;
      }
      if (chunk[0] === 0x51) {
        const qLen = chunk.readInt32BE(1);
        const sqlStr = chunk.subarray(5, 1 + qLen - 1).toString('utf8');
        pgWireQueries.push(sqlStr);
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

  const mysqlWireQueries = [];
  const mockMysqlWireServer = net.createServer((sock) => {
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
        const okBody = Buffer.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
        const okHdr = Buffer.alloc(4);
        okHdr.writeUIntLE(okBody.length, 0, 3);
        okHdr[3] = seq + 1;
        sock.write(Buffer.concat([okHdr, okBody]));
        return;
      }
      if (payload[0] === 0x03) {
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

test('10. Interactive selection wizard (`myship use` & `myship use db`)', async (t) => {
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
