/**
 * demo-run.mjs — 无需任何云端账号的端到端 CAS 全链路离线沙盒自测
 *
 * 自动演示：
 * 1. 创建包含 2 个文件的构建产物 (index.html + assets/common.js) 并发布为 v1 版本
 * 2. 仅修改 index.html，发布为 v2 版本 -> 验证 assets/common.js 命中 CAS 去重跳过上传
 * 3. 通过泛域名边缘网关同时请求 v1.ship.localhost 和 v2.ship.localhost -> 验证多版本独立共存
 * 4. 将 prod.ship.localhost 从 v2 秒级回滚到 v1 -> 验证 0 秒原子切流生效
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

console.log('==============================================================');
console.log('🚀 步骤 1: 构建并发布【第 1 版 (v1)】，同时绑定 v1 与 prod 域名');
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

const dpl1 = deployDirectory(demoBuildDir, {
  storageDir: demoStorageDir,
  aliases: ['v1', 'prod'],
});
assert.equal(dpl1.manifest.stats.uploadedBlobs, 2);
assert.equal(dpl1.manifest.stats.reusedBlobs, 0);

console.log('\n==============================================================');
console.log('🚀 步骤 2: 仅修改 index.html 并发布【第 2 版 (v2)】，测试 CAS 增量去重');
console.log('==============================================================');
writeFileSync(
  resolve(demoBuildDir, 'index.html'),
  '<h1>Hello from Release V2 (第二版全新界面)</h1>',
  'utf8'
);

const dpl2 = deployDirectory(demoBuildDir, {
  storageDir: demoStorageDir,
  aliases: ['v2', 'prod'],
});
assert.equal(dpl2.manifest.stats.uploadedBlobs, 1);
assert.equal(dpl2.manifest.stats.reusedBlobs, 1);

console.log('\n==============================================================');
console.log('🌐 步骤 3: 通过泛域名边缘网关同时请求不同子域名，验证多版本独立共存');
console.log('==============================================================');
const adapter = createLocalStorageAdapter(demoStorageDir);

async function fetchFromEdge(host, path = '/') {
  const req = new Request(`http://${host}${path}`, { headers: { host } });
  const res = await handleEdgeRequest(req, adapter);
  return {
    status: res.status,
    deploymentId: res.headers.get('x-deployment-id'),
    body: await res.text(),
  };
}

const resV1 = await fetchFromEdge('v1.ship.localhost:4100');
const resV2 = await fetchFromEdge('v2.ship.localhost:4100');
const resImmutable1 = await fetchFromEdge(`${dpl1.immutableSubdomain}.ship.localhost:4100`);
const resProdBeforeRollback = await fetchFromEdge('prod.ship.localhost:4100');

console.log(`  [请求 v1.ship.localhost]       -> 命中版本 ${resV1.deploymentId} | 内容: ${resV1.body}`);
console.log(`  [请求 v2.ship.localhost]       -> 命中版本 ${resV2.deploymentId} | 内容: ${resV2.body}`);
console.log(
  `  [请求 ${dpl1.immutableSubdomain}.ship.localhost] -> 命中版本 ${resImmutable1.deploymentId} | 内容: ${resImmutable1.body}`
);
console.log(
  `  [请求 prod.ship.localhost]     -> 命中版本 ${resProdBeforeRollback.deploymentId} | 内容: ${resProdBeforeRollback.body}`
);

assert.equal(resV1.body, '<h1>Hello from Release V1 (第一版构建产物)</h1>');
assert.equal(resV2.body, '<h1>Hello from Release V2 (第二版全新界面)</h1>');
assert.equal(resProdBeforeRollback.body, '<h1>Hello from Release V2 (第二版全新界面)</h1>');

console.log('\n==============================================================');
console.log('⚡ 步骤 4: 0 秒将 prod.ship.localhost 一键回滚到第 1 版');
console.log('==============================================================');
setAlias('prod', dpl1.deploymentId, { storageDir: demoStorageDir });
const resProdAfterRollback = await fetchFromEdge('prod.ship.localhost:4100');
console.log(
  `  [回滚后请求 prod.ship.localhost] -> 命中版本 ${resProdAfterRollback.deploymentId} | 内容: ${resProdAfterRollback.body}`
);
assert.equal(resProdAfterRollback.body, '<h1>Hello from Release V1 (第一版构建产物)</h1>');

console.log('\n==============================================================');
console.log('🎉 离线沙盒验证全部通过！当前 CAS 池仅存了 3 个文件块，却支撑了 2 个完整版本与 5 个独立子域名！');
console.log('==============================================================');
