/**
 * demo-run.mjs — 无需任何云端账号的端到端 CAS 全栈离线沙盒自测 (Phase 0 + Phase 1 + Phase 2)
 *
 * 自动演示：
 * 1. 创建包含前端静态产物 (index.html + assets/common.js) 与后端约定式云函数 (api/hello.js) 的 v1 版本
 * 2. 修改 index.html 与 api/hello.js 并发布为 v2 版本 -> 验证未变动的 assets/common.js 命中 CAS 去重跳过上传
 * 3. 通过泛域名边缘网关同时请求 v1.ship.localhost 与 v2.ship.localhost 的前端与 /api/hello -> 验证全栈多版本独立共存
 * 4. 将 prod.ship.localhost 从 v2 秒级回滚到 v1 -> 验证前端 UI 与后端 /api/hello 在同一毫秒原子切流生效！
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployDirectory, setAlias } from '../../packages/cli/myship.mjs';
import {
  handleEdgeRequest,
  createLocalStorageAdapter,
} from '../../packages/edge-gateway/local-gateway.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoBuildDir = resolve(__dirname, '.demo-dist');
const demoStorageDir = resolve(__dirname, '.cas-storage');

rmSync(demoBuildDir, { recursive: true, force: true });
rmSync(demoStorageDir, { recursive: true, force: true });
mkdirSync(resolve(demoBuildDir, 'assets'), { recursive: true });
mkdirSync(resolve(demoBuildDir, 'api'), { recursive: true });

console.log('==============================================================');
console.log('🚀 步骤 1: 构建并发布【全栈第 1 版 (v1)】(静态 UI + api/hello.js)');
console.log('==============================================================');
writeFileSync(
  resolve(demoBuildDir, 'assets/common.js'),
  'console.log("Shared Heavy Vendor Bundle v1.0 - 500KB unchanged");',
  'utf8'
);
writeFileSync(
  resolve(demoBuildDir, 'index.html'),
  '<h1>Hello from Release V1 (第一版构建产物)</h1>',
  'utf8'
);
writeFileSync(
  resolve(demoBuildDir, 'api/hello.js'),
  `export default async function handler(request, context) {
  return Response.json({
    ok: true,
    apiVersion: 'v1',
    message: 'Backend API V1',
    deploymentId: context.deploymentId,
    subdomain: context.subdomain,
  });
}
`,
  'utf8'
);

const dpl1 = deployDirectory(demoBuildDir, {
  storageDir: demoStorageDir,
  aliases: ['v1', 'prod'],
});
assert.equal(dpl1.manifest.stats.totalFiles, 2);
assert.equal(dpl1.manifest.stats.totalFunctions, 1);
assert.equal(dpl1.manifest.stats.uploadedBlobs, 3);
assert.equal(dpl1.manifest.stats.reusedBlobs, 0);

console.log('\n==============================================================');
console.log('🚀 步骤 2: 修改 index.html 与 api/hello.js 发布【全栈第 2 版 (v2)】');
console.log('==============================================================');
writeFileSync(
  resolve(demoBuildDir, 'index.html'),
  '<h1>Hello from Release V2 (第二版全新界面)</h1>',
  'utf8'
);
writeFileSync(
  resolve(demoBuildDir, 'api/hello.js'),
  `export default async function handler(request, context) {
  return Response.json({
    ok: true,
    apiVersion: 'v2',
    message: 'Backend API V2 (Schema Upgraded)',
    deploymentId: context.deploymentId,
    subdomain: context.subdomain,
  });
}
`,
  'utf8'
);

const dpl2 = deployDirectory(demoBuildDir, {
  storageDir: demoStorageDir,
  aliases: ['v2', 'prod'],
});
assert.equal(dpl2.manifest.stats.uploadedBlobs, 2);
assert.equal(dpl2.manifest.stats.reusedBlobs, 1);

console.log('\n==============================================================');
console.log('🌐 步骤 3: 通过泛域名边缘网关同时请求不同子域名，验证全栈多版本共存');
console.log('==============================================================');
const adapter = createLocalStorageAdapter(demoStorageDir);

async function fetchFromEdge(host, path = '/') {
  const req = new Request(`http://${host}${path}`, { headers: { host } });
  const res = await handleEdgeRequest(req, adapter);
  const text = await res.text();
  return {
    status: res.status,
    deploymentId: res.headers.get('x-deployment-id'),
    body: text,
  };
}

const resV1 = await fetchFromEdge('v1.ship.localhost:4100', '/');
const resV2 = await fetchFromEdge('v2.ship.localhost:4100', '/');
const apiV1 = JSON.parse((await fetchFromEdge('v1.ship.localhost:4100', '/api/hello')).body);
const apiV2 = JSON.parse((await fetchFromEdge('v2.ship.localhost:4100', '/api/hello')).body);
const resProdBeforeRollback = await fetchFromEdge('prod.ship.localhost:4100', '/');
const apiProdBeforeRollback = JSON.parse(
  (await fetchFromEdge('prod.ship.localhost:4100', '/api/hello')).body
);

console.log(`  [前端 v1.ship.localhost/]          -> 版本 ${resV1.deploymentId} | ${resV1.body}`);
console.log(`  [后端 v1.ship.localhost/api/hello] -> 版本 ${apiV1.deploymentId} | apiVersion=${apiV1.apiVersion} (${apiV1.message})`);
console.log(`  [前端 v2.ship.localhost/]          -> 版本 ${resV2.deploymentId} | ${resV2.body}`);
console.log(`  [后端 v2.ship.localhost/api/hello] -> 版本 ${apiV2.deploymentId} | apiVersion=${apiV2.apiVersion} (${apiV2.message})`);

assert.equal(resV1.body, '<h1>Hello from Release V1 (第一版构建产物)</h1>');
assert.equal(apiV1.apiVersion, 'v1');
assert.equal(resV2.body, '<h1>Hello from Release V2 (第二版全新界面)</h1>');
assert.equal(apiV2.apiVersion, 'v2');
assert.equal(resProdBeforeRollback.body, '<h1>Hello from Release V2 (第二版全新界面)</h1>');
assert.equal(apiProdBeforeRollback.apiVersion, 'v2');

console.log('\n==============================================================');
console.log('⚡ 步骤 4: 0 秒将 prod.ship.localhost 一键原子回滚到第 1 版 (前后端同步切换)');
console.log('==============================================================');
setAlias('prod', dpl1.deploymentId, { storageDir: demoStorageDir });
const resProdAfterRollback = await fetchFromEdge('prod.ship.localhost:4100', '/');
const apiProdAfterRollback = JSON.parse(
  (await fetchFromEdge('prod.ship.localhost:4100', '/api/hello')).body
);

console.log(
  `  [回滚后前端 prod.ship.localhost/]          -> 命中版本 ${resProdAfterRollback.deploymentId} | ${resProdAfterRollback.body}`
);
console.log(
  `  [回滚后后端 prod.ship.localhost/api/hello] -> 命中版本 ${apiProdAfterRollback.deploymentId} | apiVersion=${apiProdAfterRollback.apiVersion} (${apiProdAfterRollback.message})`
);
assert.equal(resProdAfterRollback.body, '<h1>Hello from Release V1 (第一版构建产物)</h1>');
assert.equal(apiProdAfterRollback.apiVersion, 'v1');
assert.equal(apiProdAfterRollback.deploymentId, dpl1.deploymentId);

console.log('\n==============================================================');
console.log('🎉 Phase 2 全栈沙盒验证全部通过！前端静态资源与 api/*.js 云函数实现同版本原子切流与 0ms 同步回滚！');
console.log('==============================================================');
