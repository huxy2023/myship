#!/usr/bin/env node
/**
 * verify-local.mjs — MyShip 全栈黄金样板工程本地自动化自检脚本
 *
 * 验证链路：
 * 1. 复制样板工程到临时隔离沙盒目录
 * 2. 启动 `myship dev` 本地全栈开发服务器
 * 3. 逐一验证：
 *    - GET  /               (前端静态页)
 *    - GET  /api/health     (运行时上下文 + server/templates/banner.txt 静态模板读取)
 *    - POST /api/state      (context.storage 持久化计数器)
 *    - POST /api/notes      (context.db 本地 node:sqlite 建表、插入与查询)
 *    - POST /api/files      (context.files 二进制存储读写与列表)
 *    - POST /api/files/presign (context.files 预签名直传 URL 生成)
 * 4. 调用 `bundleFullStackServer` 验证 esbuild 单包编译、_myship/bootstrap.mjs 生成与静态模板复制
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { bundleScfBackend } from '../../packages/cli/scf-bundler.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(__dirname, '../../packages/cli/myship.mjs');

async function getFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

async function main() {
  console.log('🚀 [Full-Stack Starter] 开始本地端到端自检...');
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'myship-fullstack-starter-'));

  try {
    cpSync(__dirname, tempRoot, { recursive: true });
    const port = await getFreePort();

    const child = spawn(process.execPath, [CLI_BIN, 'dev', './public', '--port', String(port)], {
      cwd: tempRoot,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('myship dev 启动超时')), 8000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes(`http://localhost:${port}`)) {
          clearTimeout(timer);
          res();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        rej(new Error(`myship dev 提前退出: ${code}`));
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. 验证前端静态首页
      const htmlRes = await fetch(`${baseUrl}/`);
      assert.equal(htmlRes.status, 200);
      const htmlText = await htmlRes.text();
      assert.ok(htmlText.includes('MyShip 全栈黄金样板工程'));
      console.log('  ✔ 1. 前端静态首页 (GET /) 响应正常');

      // 2. 验证 /api/health 与静态模板读取
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const health = await healthRes.json();
      assert.equal(health.ok, true);
      assert.equal(health.project, 'fullstack-starter');
      assert.ok(health.banner.includes('MyShip Full-Stack Starter'));
      assert.deepEqual(health.capabilities, { storage: true, files: true, db: true });
      console.log(`  ✔ 2. 全栈健康检查 (GET /api/health) 通过 [dbProvider=${health.dbProvider}]`);

      // 3. 验证 /api/state (context.storage)
      const stateRes1 = await fetch(`${baseUrl}/api/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta: 3 }),
      });
      const state1 = await stateRes1.json();
      assert.equal(state1.ok, true);
      assert.equal(state1.state.count, 3);
      console.log('  ✔ 3. KV 状态存储 (POST /api/state -> context.storage) 持久化正常');

      // 4. 验证 /api/notes (context.db)
      const noteRes = await fetch(`${baseUrl}/api/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'First Full-Stack Note' }),
      });
      const noteData = await noteRes.json();
      assert.equal(noteData.ok, true);
      assert.equal(noteData.notes.length, 1);
      assert.equal(noteData.notes[0].title, 'First Full-Stack Note');
      console.log('  ✔ 4. 数据库读写 (POST /api/notes -> context.db) 建表与写入正常');

      // 5. 验证 /api/files & /api/files/presign (context.files)
      const fileRes = await fetch(`${baseUrl}/api/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'docs/greeting.txt', content: 'Hello Starter Files!' }),
      });
      const fileData = await fileRes.json();
      assert.equal(fileData.ok, true);
      assert.equal(fileData.content, 'Hello Starter Files!');
      assert.ok(fileData.files.includes('docs/greeting.txt'));

      const presignRes = await fetch(`${baseUrl}/api/files/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'uploads/photo.png', method: 'PUT' }),
      });
      const presignData = await presignRes.json();
      assert.equal(presignData.ok, true);
      assert.ok(presignData.presignedUrl.includes('uploads/photo.png'));
      console.log('  ✔ 5. 对象文件存储与预签名 URL (POST /api/files & /api/files/presign) 正常');
    } finally {
      child.kill('SIGTERM');
    }

    // 6. 验证 SCF 全栈打包器 (bundleScfBackend)
    const bundleInfo = await bundleScfBackend({
      cwd: tempRoot,
    });
    assert.ok(bundleInfo.zipEntries.includes('_myship/bootstrap.mjs'));
    assert.ok(bundleInfo.zipEntries.includes('server/index.mjs'));
    assert.ok(bundleInfo.zipEntries.includes('server/templates/banner.txt'));
    assert.ok(bundleInfo.zipSizeBytes > 1000);
    console.log(
      `  ✔ 6. SCF 全栈 esbuild 单包构建 (_myship/bootstrap.mjs + 静态模板复制) 成功 [zipSize=${bundleInfo.zipSizeBytes}B]`
    );

    console.log('✅ [Full-Stack Starter] 全部 6 项全栈能力验证通过！');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ [Full-Stack Starter] 验证失败:', err);
  process.exit(1);
});
