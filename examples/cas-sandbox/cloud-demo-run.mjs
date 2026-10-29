/**
 * cloud-demo-run.mjs — 自有云端底座 (COS + EdgeOne 泛域名) 多版本发布与去重实战脚本
 *
 * 运行前提：已执行 `myship login` 配置好你自己的 COS 存储桶与泛域名后缀。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployRemoteDirectory } from '../../packages/cli/myship.mjs';
import { assertCloudEndpointsConfigured } from '../../packages/cli/cos-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_BUILD_DIR = resolve(__dirname, '.demo-dist');

const { remoteDomain } = assertCloudEndpointsConfigured();

function renderHtml(versionTag, title, badgeColor, desc) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title} — MyShip CAS Engine</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 40px 20px; display: flex; justify-content: center; }
    .card { max-width: 680px; width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 32px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
    .badge { display: inline-block; background: ${badgeColor}; color: #fff; font-weight: 700; padding: 6px 14px; border-radius: 999px; font-size: 14px; margin-bottom: 16px; }
    h1 { margin: 0 0 12px 0; font-size: 28px; }
    p { color: #94a3b8; line-height: 1.6; }
    .links { margin-top: 24px; padding-top: 20px; border-top: 1px solid #334155; display: flex; gap: 12px; flex-wrap: wrap; }
    .links a { color: #38bdf8; text-decoration: none; background: #0f172a; padding: 8px 14px; border-radius: 8px; border: 1px solid #1e293b; font-size: 14px; }
    .links a:hover { border-color: #38bdf8; }
    code { background: #0f172a; padding: 3px 8px; border-radius: 6px; color: #a7f3d0; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">${versionTag}</span>
    <h1>${title}</h1>
    <p>${desc}</p>
    <p>底层架构：<code>EdgeOne 泛域名 (*.${remoteDomain})</code> + <code>EdgeOne 边缘函数动态寻址</code> + <code>腾讯云 COS CAS 去重存储池</code></p>
    <div class="links">
      <a href="https://demo-v1.${remoteDomain}">访问 demo-v1.${remoteDomain}</a>
      <a href="https://demo-v2.${remoteDomain}">访问 demo-v2.${remoteDomain}</a>
      <a href="https://demo.${remoteDomain}">访问 demo.${remoteDomain}</a>
    </div>
  </div>
  <script src="/assets/common.js"></script>
</body>
</html>`;
}

rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });
mkdirSync(resolve(TEMP_BUILD_DIR, 'assets'), { recursive: true });

console.log('==============================================================');
console.log(`☁️  步骤 1: 构建并上传【Release V1】至腾讯云 COS -> 绑定 demo-v1.${remoteDomain}`);
console.log('==============================================================');
writeFileSync(
  resolve(TEMP_BUILD_DIR, 'assets/common.js'),
  'console.log("[MyShip CAS Shared Asset] 公共 JS 模块 — 跨版本自动 SHA-256 去重复用");',
  'utf8'
);
writeFileSync(
  resolve(TEMP_BUILD_DIR, 'index.html'),
  renderHtml(
    'Release V1.0 (深海蓝版)',
    '🚀 欢迎来到第 1 版 (V1) 独立构建预览',
    '#2563eb',
    `这是第 1 次构建生成的独立部署版本，永久保留在你的腾讯云 COS CAS 存储池中，绑定在 demo-v1.${remoteDomain}。`
  ),
  'utf8'
);

const dpl1 = await deployRemoteDirectory(TEMP_BUILD_DIR, {
  project: 'demo',
  aliases: ['demo-v1', 'demo'],
});

console.log('\n==============================================================');
console.log(`☁️  步骤 2: 仅修改 HTML 并上传【Release V2】 -> 验证 common.js 去重秒跳`);
console.log('==============================================================');
writeFileSync(
  resolve(TEMP_BUILD_DIR, 'index.html'),
  renderHtml(
    'Release V2.0 (翡翠绿全新改版)',
    '✨ 欢迎来到第 2 版 (V2) 生产主站',
    '#059669',
    '这是修改了页面主题后的第 2 次构建产物！注意看终端日志：公共依赖 /assets/common.js 命中了 COS CAS 哈希池，0 字节直接跳过上传！'
  ),
  'utf8'
);

const dpl2 = await deployRemoteDirectory(TEMP_BUILD_DIR, {
  project: 'demo',
  aliases: ['demo-v2', 'demo'],
});

rmSync(TEMP_BUILD_DIR, { recursive: true, force: true });

console.log('\n==============================================================');
console.log('🎉 真实云端部署完成！多个版本同时在线：');
console.log(`  1. V1 专属域名:   https://demo-v1.${remoteDomain}  (指向 ${dpl1.deploymentId})`);
console.log(`  2. V2 专属域名:   https://demo-v2.${remoteDomain}  (指向 ${dpl2.deploymentId})`);
console.log(`  3. Demo 主域名:   https://demo.${remoteDomain}     (当前指向 ${dpl2.deploymentId})`);
console.log('==============================================================');
