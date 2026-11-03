/**
 * server/index.mjs — MyShip 全栈黄金样板工程后端入口
 *
 * 完整演示 MyShip 全栈三大核心原语：
 * 1. context.storage : 私有 JSON KV 状态存储 (COS data/<project>/<key>.json)
 * 2. context.db      : 多引擎 SQL 数据库读写 (PostgreSQL / Neon / Turso / D1 / MySQL / 本地 node:sqlite)
 * 3. context.files   : 二进制文件存储与前端预签名直传 URL (COS files/<project>/<key>)
 */
import { readFileSync } from 'node:fs';

const BANNER_TEXT = readFileSync(new URL('./templates/banner.txt', import.meta.url), 'utf-8').trim();

let schemaInitializedForProvider = null;

async function ensureNotesTable(db) {
  if (!db) throw new Error('context.db 未初始化');
  const provider = String(db.provider || 'sqlite').toLowerCase();
  if (schemaInitializedForProvider === provider) return provider;

  if (
    provider === 'pg' ||
    provider === 'cloudbase-pg' ||
    provider === 'neon' ||
    provider === 'postgres'
  ) {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  } else if (provider === 'mysql') {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        created_at VARCHAR(64) NOT NULL
      )
    `);
  } else {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS starter_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  schemaInitializedForProvider = provider;
  return provider;
}

export async function fetch(request, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  // 1. GET /api/health — 运行时与资源绑定自检
  if (path === '/api/health' && method === 'GET') {
    const dbReady = Boolean(context.db && context.db.provider !== 'unconfigured');
    return Response.json({
      ok: true,
      banner: BANNER_TEXT,
      project: context.project,
      subdomain: context.subdomain,
      deploymentId: context.deploymentId,
      nodeVersion: process.version,
      dbProvider: context.db?.provider || 'unconfigured',
      capabilities: {
        storage: Boolean(context.storage),
        files: Boolean(context.files),
        db: dbReady,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // 2. GET / POST /api/state — context.storage (JSON KV 持久化状态)
  if (path === '/api/state') {
    if (method === 'GET') {
      const state = (await context.storage.get('counter')) || { count: 0, updatedAt: null };
      return Response.json({ ok: true, state });
    }
    if (method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const delta = Number(body.delta ?? 1) || 1;
      const prev = (await context.storage.get('counter')) || { count: 0 };
      const next = {
        count: Number(prev.count || 0) + delta,
        updatedAt: new Date().toISOString(),
        lastDeploymentId: context.deploymentId,
      };
      await context.storage.set('counter', next);
      return Response.json({ ok: true, state: next });
    }
  }

  // 3. GET / POST / DELETE /api/notes — context.db (多引擎 SQL 读写)
  if (path === '/api/notes') {
    if (!context.db || context.db.provider === 'unconfigured') {
      return Response.json(
        {
          ok: false,
          needsSetup: true,
          provider: 'unconfigured',
          setupCommand: 'myship use db',
          error:
            '当前项目尚未绑定云端数据库。请在项目根目录执行 "myship use db" 一键开通并注入数据库凭证后再执行 "myship" 发布。',
          notes: [],
        },
        { status: 503 }
      );
    }
    const provider = await ensureNotesTable(context.db);
    const isPg =
      provider === 'pg' ||
      provider === 'cloudbase-pg' ||
      provider === 'neon' ||
      provider === 'postgres';

    if (method === 'GET') {
      const { rows } = await context.db.query(
        'SELECT id, title, created_at FROM starter_notes ORDER BY id DESC LIMIT 20'
      );
      return Response.json({ ok: true, provider, notes: rows });
    }

    if (method === 'POST') {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      const title = String(body.title || '').trim();
      if (!title) {
        return Response.json({ ok: false, error: 'title 不能为空' }, { status: 400 });
      }
      const createdAt = new Date().toISOString();
      const insertSql = isPg
        ? 'INSERT INTO starter_notes (title, created_at) VALUES ($1, $2)'
        : 'INSERT INTO starter_notes (title, created_at) VALUES (?, ?)';
      await context.db.execute(insertSql, [title, createdAt]);
      const { rows } = await context.db.query(
        'SELECT id, title, created_at FROM starter_notes ORDER BY id DESC LIMIT 20'
      );
      return Response.json({ ok: true, provider, notes: rows });
    }

    if (method === 'DELETE') {
      await context.db.execute('DELETE FROM starter_notes');
      return Response.json({ ok: true, provider, notes: [] });
    }
  }

  // 4. GET / POST /api/files & POST /api/files/presign — context.files (对象文件存储与预签名直传)
  if (path === '/api/files' && method === 'GET') {
    const keys = await context.files.list('');
    return Response.json({ ok: true, files: keys });
  }

  if (path === '/api/files' && method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const key = String(body.key || 'hello.txt').replace(/^\/+/, '');
    const content = String(body.content || `Saved by ${context.project} at ${new Date().toISOString()}`);
    await context.files.put(key, content, { contentType: 'text/plain; charset=utf-8' });
    const readBack = await context.files.get(key, { type: 'text' });
    const keys = await context.files.list('');
    return Response.json({
      ok: true,
      key,
      content: readBack,
      files: keys,
    });
  }

  if (path === '/api/files/presign' && method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const key = String(body.key || 'demo/hello.txt').replace(/^\/+/, '');
    const reqMethod = String(body.method || 'GET').toUpperCase();

    // 若请求的是 GET 预览预签名且默认示例文件尚未创建，先自动写入一份示例内容，确保用户在浏览器直接打开该链接即可看到内容
    if (reqMethod === 'GET' && key === 'demo/hello.txt') {
      const existing = await context.files.get(key);
      if (!existing) {
        await context.files.put(key, `Hello from MyShip Full-Stack Starter! (${new Date().toISOString()})`, {
          contentType: 'text/plain; charset=utf-8',
        });
      }
    }

    const presignedUrl = await context.files.presignUrl(key, {
      method: reqMethod,
      expiresIn: 600,
    });
    const downloadUrl =
      reqMethod === 'GET'
        ? presignedUrl
        : await context.files.presignUrl('demo/hello.txt', { method: 'GET', expiresIn: 600 });

    return Response.json({
      ok: true,
      key,
      method: reqMethod,
      presignedUrl,
      browserOpenableGetUrl: downloadUrl,
      note:
        reqMethod === 'PUT'
          ? '注意: presignedUrl 为 PUT 专用上传签名 (需用 fetch/curl -X PUT 调用)；若要在浏览器地址栏直接打开 (GET 请求)，请访问 browserOpenableGetUrl。'
          : '可直接复制 presignedUrl 到浏览器地址栏打开查看私有文件内容。',
    });
  }

  return Response.json(
    {
      ok: false,
      error: `Route not found: ${method} ${path}`,
    },
    { status: 404 }
  );
}
