#!/usr/bin/env node
/**
 * myship.mjs — 个人级极致 DX 部署与泛域名路由 CLI (BYOC 开源版)
 *
 * 模块化门面与 CLI 主入口：
 * - project-context.mjs : 项目命名空间探测、路径规范化与统一 CAS 状态快照加载
 * - core-cas.mjs        : 本地沙盒与云端 COS 增量去重部署、别名切流、回滚、状态列表
 * - lifecycle.mjs       : 按数量/时间垃圾回收 (gc) 与资源主动销毁 (rm / purge)
 * - serverless.mjs      : 约定式 api/*.js 扫描、安全合规校验、ESM 编译与 EdgeOne 同步
 * - env-manager.mjs     : 项目级云函数环境变量解析、脱敏与私有存储
 * - dev-server.mjs      : myship dev 本地全栈热重载开发服务器
 * - ci-generator.mjs    : myship init --ci GitHub Actions 工作流生成与 Secrets 同步
 * - console-server.mjs  : myship console 轻量单页 Web 可视化管控台后端与 Diff 引擎
 * - console-ui.mjs      : myship console 单页前端视图模板
 * - cos-client.mjs      : 腾讯云 COS V5 XML 签名客户端与 EdgeOne OpenAPI 驱动
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  cosListKeys,
  getEffectiveEndpoints,
  getAuthStatus,
  saveMyShipFileConfig,
  loadTencentCredentials,
  MYSHIP_CONFIG_PATH,
  probeEdgeGateway,
} from './cos-client.mjs';
import {
  normalizeDomainToken,
  detectProjectContext,
  ensureProjectConfig,
  resolveNamespacedSubdomain,
} from './project-context.mjs';
import {
  generateEdgeFunctionCode,
  promptAndDeployEdgeFunction,
  runEnvCommand,
} from './serverless.mjs';
import {
  deployDirectory,
  setAlias,
  rollbackAlias,
  listState,
  deployRemoteDirectory,
  setRemoteAlias,
  rollbackRemoteAlias,
  listRemoteState,
} from './core-cas.mjs';
import {
  gcState,
  gcRemoteState,
  removeResources,
} from './lifecycle.mjs';
import { startDevServer } from './dev-server.mjs';
import { setupCiWorkflow } from './ci-generator.mjs';
import { startConsoleServer } from './console-server.mjs';
import {
  runBackendCommand,
  fetchAndPrintScfLogs,
} from './scf-client.mjs';
import { runUseCommand } from './resource-manager.mjs';

export * from './project-context.mjs';
export * from './env-manager.mjs';
export * from './serverless.mjs';
export * from './scf-bundler.mjs';
export * from './scf-client.mjs';
export * from './resource-manager.mjs';
export * from './core-cas.mjs';
export * from './lifecycle.mjs';
export * from './dev-server.mjs';
export * from './ci-generator.mjs';
export * from './console-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function interactiveLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const currentEndpoints = getEffectiveEndpoints();
  const status = getAuthStatus();

  console.log('==============================================================');
  console.log('🔐 MyShip 跨设备认证与自有云底座 (BYOC) 配置向导');
  console.log('   配置文件将安全保存在 ~/.myship/config.json (权限 0600)');
  console.log('==============================================================');

  let secretId = '';
  let secretKey = '';
  let reuseExistingCred = false;

  if (status.authenticated) {
    console.log(`\n✅ 检测到本机已有可用凭证: ${status.maskedSecretId}`);
    console.log(`   🔑 凭证来源: ${status.source}`);
    const reuseAns = (
      await rl.question('👉 是否直接复用该凭证（跳过密钥输入）？[Y/n]: ')
    )
      .trim()
      .toLowerCase();
    if (!reuseAns || reuseAns === 'y' || reuseAns === 'yes') {
      reuseExistingCred = true;
    }
  }

  if (!reuseExistingCred) {
    console.log('\n--------------------------------------------------------------');
    console.log('🔑 请选择腾讯云认证方式（二选一）：\n');
    console.log('  [1] 方式一：使用 CAM 子账号 API 密钥 (跨电脑零依赖，推荐)');
    console.log('      🛡️  最小权限安全指引：');
    console.log('         • MyShip 日常发包/切流/回滚【仅读写 COS 对象存储】，不触碰其他云资源');
    console.log('         • 前往腾讯云控制台【访问管理 CAM -> 用户 -> 新建子用户】：');
    console.log('           https://console.cloud.tencent.com/cam/user');
    console.log('         • 勾选“编程访问”，日常部署仅需授予 1 项最小权限策略：');
    console.log('           👉 QcloudCOSDataFullControl (对象存储 COS 数据读写权限)\n');
    console.log('  [2] 方式二：使用腾讯云官方 tccli 浏览器扫码登录 (免建静态密钥，自动续期)');
    console.log('      💡 适合已安装 tccli (pip install tccli) 的电脑，扫码后 MyShip 自动复用');
    console.log('--------------------------------------------------------------');

    const modeAns = (await rl.question('请选择认证方式 [1/2，直接回车默认 1]: ')).trim();

    if (modeAns === '2') {
      const checkTccli = spawnSync('tccli', ['--version'], { stdio: 'ignore' });
      if (checkTccli.status === 0) {
        console.log('\n🌐 正在唤起 `tccli auth login` 浏览器扫码授权...');
        rl.pause();
        const loginRes = spawnSync('tccli', ['auth', 'login'], { stdio: 'inherit' });
        rl.resume();
        if (loginRes.status !== 0) {
          rl.close();
          throw new Error('tccli auth login 未完成，请重试或改选方式 [1] 输入密钥。');
        }
        console.log('✅ tccli 扫码登录成功！MyShip 将自动复用 ~/.tccli/default.credential。');
      } else {
        console.log('\n⚠️  未在本机检测到 `tccli` 命令。');
        console.log('   • 如需使用扫码登录，请先执行: pip install tccli && tccli auth login');
        console.log('   • 或现在直接切换为【方式 1】输入 CAM 子账号 SecretId / SecretKey：\n');
        secretId = (await rl.question('1. 请输入腾讯云 SecretId: ')).trim();
        secretKey = (await rl.question('2. 请输入腾讯云 SecretKey: ')).trim();
      }
    } else {
      secretId = (
        await rl.question('\n1. 请输入腾讯云 SecretId (仅需 QcloudCOSDataFullControl 权限): ')
      ).trim();
      secretKey = (await rl.question('2. 请输入腾讯云 SecretKey: ')).trim();
    }
  }

  console.log('\n--------------------------------------------------------------');
  console.log('☁️  配置你的自有云底座地址 (可在已配置电脑上运行 `myship whoami` 查看)');
  console.log('--------------------------------------------------------------');
  const cosDefault =
    currentEndpoints.cosOrigin || 'https://myship-1250000000.cos.ap-guangzhou.myqcloud.com';
  const cosOriginInput = (
    await rl.question(`3. 你的 COS 存储桶地址 [默认: ${cosDefault}]: `)
  ).trim();
  const domainDefault = currentEndpoints.remoteDomain || 'ship.example.com';
  const remoteDomainInput = (
    await rl.question(`4. 你的泛域名后缀 [默认: ${domainDefault}]: `)
  ).trim();

  const patch = {
    cosOrigin: (cosOriginInput || cosDefault).replace(/\/$/, ''),
    remoteDomain: (remoteDomainInput || domainDefault).replace(/^\*\./, ''),
  };
  if (secretId && secretKey) {
    patch.secretId = secretId;
    patch.secretKey = secretKey;
  }

  saveMyShipFileConfig(patch);
  loadTencentCredentials();
  await cosListKeys('manifests/');
  console.log(`\n✅ COS 认证与连通性校验成功！全局配置已写入: ${MYSHIP_CONFIG_PATH}`);

  generateEdgeFunctionCode({ cosOrigin: patch.cosOrigin, silent: true });

  const probe = await probeEdgeGateway(patch.remoteDomain);
  if (probe.online) {
    rl.close();
    console.log(`🌐 云端全局边缘网关检测通过: https://*.${patch.remoteDomain} 已在线运行！`);
    console.log(`   (全局边缘函数全账号仅需部署 1 次，所有项目共享，当前电脑无需重复操作边缘函数)`);
    console.log(`🚀 配置全部完成！现在在任意前端项目下直接输入 \`myship\` 即可秒级发布！`);
  } else {
    console.log(`\n💡 尚未在 https://*.${patch.remoteDomain} 探测到边缘网关响应（若是首次从 0 搭建云底座，需部署 1 次全局边缘函数）。`);
    await promptAndDeployEdgeFunction({
      cosOrigin: patch.cosOrigin,
      remoteDomain: patch.remoteDomain,
      rlExternal: rl,
    });
    rl.close();
  }
}

function printWhoami() {
  const status = getAuthStatus();
  const proj = detectProjectContext();
  console.log('=== 👤 MyShip 当前身份与自有云底座 (BYOC) 配置 ===');
  if (status.authenticated) {
    console.log(`  ✅ 认证状态: 已就绪`);
    console.log(`  🔑 凭证来源: ${status.source}`);
    console.log(`  🆔 SecretId: ${status.maskedSecretId}`);
  } else {
    console.log(`  ❌ 认证状态: 未配置 (${status.error})`);
  }
  console.log(`  ☁️  COS 存储桶: ${status.cosOrigin || '(未配置，请运行 myship login)'}`);
  console.log(
    `  🌐 泛域名后缀: ${
      status.remoteDomain ? `*.${status.remoteDomain}` : '(未配置，请运行 myship login)'
    }`
  );

  const suffix = status.remoteDomain || 'ship.example.com';
  console.log('\n=== 📦 当前项目命名空间上下文 (.myship/project.json) ===');
  console.log(`  🏷️  项目名称 (project):  ${proj.project}`);
  console.log(`  📁 默认构建目录 (dir):  ${proj.buildDir}`);
  console.log(`  🌐 项目主域名:          https://${proj.prodDomain}.${suffix}`);
  console.log(`  🌐 构建指纹域名格式:    https://${proj.project}-<hash>.${suffix}`);
  console.log(
    `  🔌 全栈 SCF 后端开关:   ${
      proj.backend?.enabled
        ? `✅ 已开启 (${proj.backend.functionName} @ ${proj.backend.region})`
        : '⚪ 未开启 (可执行 `myship backend enable` 按需开启)'
    }`
  );
  console.log(
    `  🧩 已注册云资源:        ${
      proj.resources && (proj.resources.storage?.enabled || proj.resources.db?.enabled)
        ? [
            proj.resources.storage?.enabled ? `storage(${proj.resources.storage.filesPrefix})` : null,
            proj.resources.db?.enabled ? `db(${proj.resources.db.provider})` : null,
          ]
            .filter(Boolean)
            .join(', ')
        : '⚪ 未声明 (可执行 `myship use <storage|db>` 一键注入)'
    }`
  );
  console.log(`  📄 配置来源:            ${proj.configSource}`);
}

function printHelp() {
  console.log(`
🚀 MyShip CLI — 基于自有云设施 (BYOC) 的高 DX 全栈部署与泛域名路由工具

极简日常用法 (自动关联 .myship/project.json 项目命名空间):
  myship                                       零参数部署：自动发布前端与后端新版本并更新 <project>.ship.<domain>
  myship <目录> <环境后缀>                     项目内带后缀部署：如在 app1 下执行 myship ./dist v2 -> https://app1-v2.ship.<domain>
  myship -d <环境后缀> [-p <项目名>]           部署并自动拼接当前项目命名空间前缀 (加 --raw 可不加项目前缀)

声明式资源注册与交互式引导 (myship use):
  myship use                                   ✨ 交互式选择向导 (上下方向键 / 数字键选择数据库或对象存储)
  myship use db                                ✨ 交互式选择数据库平台 (自动扫描腾讯云 CloudBase PG 环境，免输参数)
  myship use storage [--env prod|staging]      一键为当前项目注册并注入 COS 对象存储 (context.storage + context.files)
  myship use status                            查看当前项目已绑定的存储与数据库资源状态
  myship use db --provider <pg|neon|turso|d1|mysql> 非交互式脚本/CI 指定数据库底座与凭证参数

全栈业务后端 (腾讯云 SCF) 渐进式开关与日志:
  myship backend enable [--entry server/index.mjs] 开启当前项目的腾讯云 SCF 全栈 Node.js 后端开关 (含权限与服务开通预检向导)
  myship backend disable                       关闭当前项目的 SCF 全栈后端开关，切回纯静态托管模式
  myship backend status                        查看当前项目的 SCF 后端开关状态与云端环境预检结果
  myship logs [--error] [--limit 20]           查看当前项目 SCF 业务后端的实时运行日志与错误堆栈

项目管理与切流回滚命令:
  myship init [项目名] [--scf] [--ci]          初始化 .myship/project.json (加 --scf 同步开启全栈后端，加 --ci 生成 GitHub Actions)
  myship dev [目录] [--port 3000]              启动本地全栈即时开发服务器 (与云端 SCF 同源运行 Node 后端、公共模块与持久化存储)
  myship console [--port 4200] [--local]       启动轻量单页 Web 可视化管控台 (本机 127.0.0.1 直连云端/沙盒，一键切流/回滚/Diff/环境变量/GC)
  myship ls [--all | -A]                       默认仅列出【当前项目】的历史构建与域名；加 --all 按项目分组列出全局所有记录
  myship rollback [环境后缀] [目标dpl_id]      一键秒级回滚（前端静态快照与 SCF 后端版本同步回滚，保留持久化业务数据）
  myship alias <环境后缀> <dpl_id>             0 秒将指定子域名切换到目标前后端版本
  myship env <set|ls|rm|import|pull>           管理当前项目后端环境变量 (COS 私有存储 + 云函数注入)
  myship rm <dpl_id...> [--force]              手动删除指定历史版本快照并自动回收独占块 (加 --alias 解绑域名，加 --project 彻底销毁整个项目)
  myship gc [--keep <N|all>] [--older-than 7d] 清理过期历史快照 (支持按保留版本数或时间窗口如 30d/7d/24h)、回收孤儿块并释放配额

跨设备认证与自有云底座初始化:
  myship login                                 交互式配置腾讯云密钥、COS 地址与泛域名后缀 (~/.myship/config.json)
  myship build-edge-fn [输出路径]              根据当前 COS 配置一键生成专属 EdgeOne 边缘函数代码 (.myship/edgeone-function.dist.js)
  myship whoami                                查看当前生效的认证状态、项目命名空间与 SCF 后端开关配置
`);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();

if (isMainModule) {
  const rawArgs = process.argv.slice(2);
  const isLocal = rawArgs.includes('--local') || rawArgs.includes('-l');
  const isAll = rawArgs.includes('--all') || rawArgs.includes('-A');
  const isRawDomain = rawArgs.includes('--raw');
  const isPreviewOnly = rawArgs.includes('--preview');
  const isDryRun = rawArgs.includes('--dry-run') || rawArgs.includes('-n');
  const isReveal = rawArgs.includes('--reveal') || rawArgs.includes('--plain');
  const isCi = rawArgs.includes('--ci');
  const isSyncSecrets = rawArgs.includes('--sync-secrets');
  const isForce = rawArgs.includes('--force') || rawArgs.includes('-f');
  const isScfFlag = rawArgs.includes('--scf') || rawArgs.includes('--backend');
  const isErrorsOnly = rawArgs.includes('--error') || rawArgs.includes('--errors');

  const domains = [];
  const aliasTargets = [];
  let explicitProject = null;
  let explicitDir = null;
  let explicitEntry = null;
  let explicitRegion = null;
  let explicitRole = null;
  let keepArg = null;
  let olderThanArg = null;
  let portArg = null;
  let limitArg = null;
  let rollbackTargetArg = null;
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--domain' || arg === '-d') {
      if (rawArgs[i + 1]) domains.push(rawArgs[++i]);
    } else if (arg === '--alias' || arg === '-a') {
      if (rawArgs[i + 1]) aliasTargets.push(rawArgs[++i]);
    } else if (arg === '--project' || arg === '-p') {
      if (rawArgs[i + 1]) explicitProject = rawArgs[++i];
    } else if (arg === '--dir') {
      if (rawArgs[i + 1]) explicitDir = rawArgs[++i];
    } else if (arg === '--entry') {
      if (rawArgs[i + 1]) explicitEntry = rawArgs[++i];
    } else if (arg === '--region') {
      if (rawArgs[i + 1]) explicitRegion = rawArgs[++i];
    } else if (arg === '--role') {
      if (rawArgs[i + 1]) explicitRole = rawArgs[++i];
    } else if (arg === '--to' || arg === '--target' || arg === '-t') {
      if (rawArgs[i + 1]) rollbackTargetArg = rawArgs[++i];
    } else if (arg === '--limit' || arg === '-n') {
      if (
        rawArgs[0] === 'logs' ||
        rawArgs[0] === 'log' ||
        (arg === '--limit' && rawArgs[i + 1])
      ) {
        if (rawArgs[i + 1]) limitArg = rawArgs[++i];
      }
    } else if (arg === '--keep' || arg === '-k') {
      if (rawArgs[i + 1]) keepArg = rawArgs[++i];
    } else if (arg === '--older-than' || arg === '--before') {
      if (rawArgs[i + 1]) olderThanArg = rawArgs[++i];
    } else if (arg === '--port' || arg === '-P') {
      if (rawArgs[i + 1]) portArg = rawArgs[++i];
    } else if (
      [
        '--local',
        '-l',
        '--remote',
        '-r',
        '--all',
        '-A',
        '--raw',
        '--preview',
        '--dry-run',
        '-n',
        '--reveal',
        '--plain',
        '--ci',
        '--sync-secrets',
        '--force',
        '-f',
        '--save',
        '-s',
        '--scf',
        '--backend',
        '--error',
        '--errors',
      ].includes(arg)
    ) {
      // flag handled
    } else if (arg === '--help' || arg === '-h') {
      positional.push('help');
    } else if (arg === '--version' || arg === '-v') {
      positional.push('version');
    } else {
      positional.push(arg);
    }
  }

  const first = positional[0];

  (async () => {
    if (first === 'version') {
      try {
        const rootPkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
        console.log(`myship v${rootPkg.version}`);
      } catch {
        console.log('myship v0.1.0');
      }
      return;
    }
    if (first === 'help') {
      printHelp();
      return;
    }
    if (first === 'login') {
      await interactiveLogin();
      return;
    }
    if (first === 'whoami') {
      printWhoami();
      return;
    }
    if (first === 'build-edge-fn' || first === 'setup-edge') {
      if (first === 'setup-edge' || (process.stdin.isTTY && !positional[1])) {
        await promptAndDeployEdgeFunction();
      } else {
        generateEdgeFunctionCode({ outputPath: positional[1] });
      }
      return;
    }
    if (first === 'backend' || first === 'scf' || first === 'enable' || first === 'disable') {
      let sub = positional[1] || 'status';
      if (first === 'enable') sub = 'enable';
      if (first === 'disable') sub = 'disable';
      await runBackendCommand({
        subcommand: sub,
        cwd: process.cwd(),
        explicitProject,
        region: explicitRegion,
        entry: explicitEntry,
        role: explicitRole,
        isLocal,
      });
      return;
    }
    if (first === 'use' || first === 'resource' || first === 'resources') {
      await runUseCommand({
        args: rawArgs.slice(1),
        cwd: process.cwd(),
        explicitProject,
        isLocal,
      });
      return;
    }
    if (first === 'logs' || first === 'log') {
      const limit = Number.parseInt(limitArg || '20', 10) || 20;
      await fetchAndPrintScfLogs({
        project: explicitProject,
        cwd: process.cwd(),
        region: explicitRegion,
        limit,
        errorsOnly: isErrorsOnly,
        isLocal,
      });
      return;
    }
    if (first === 'init' || first === 'ci') {
      if (isCi || first === 'ci') {
        setupCiWorkflow(process.cwd(), {
          project: positional[1] || explicitProject,
          dir: explicitDir,
          syncSecrets: isSyncSecrets,
          overwrite: isForce,
        });
        return;
      }
      const cfg = ensureProjectConfig(process.cwd(), {
        project: positional[1] || explicitProject,
        dir: explicitDir,
      });
      const { remoteDomain } = getEffectiveEndpoints();
      const suffix = remoteDomain || 'ship.example.com';
      console.log(`✅ 项目命名空间已初始化: ${cfg.projectJsonPath}`);
      console.log(`   🏷️  项目名称: ${cfg.project}`);
      console.log(`   📁 构建目录: ${cfg.dir}`);
      console.log(`   🌐 默认主域名: https://${cfg.prodDomain}.${suffix}`);
      if (isScfFlag) {
        await runBackendCommand({
          subcommand: 'enable',
          cwd: process.cwd(),
          explicitProject: cfg.project,
          region: explicitRegion,
          entry: explicitEntry,
          role: explicitRole,
          isLocal,
        });
      }
      return;
    }
    if (first === 'ls' || first === 'list') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const projectFilter = explicitProject ? normalizeDomainToken(explicitProject) : ctx.project;
      if (isLocal) {
        listState({ projectFilter, showAll: isAll });
      } else {
        await listRemoteState({ projectFilter, showAll: isAll });
      }
      return;
    }
    if (first === 'alias') {
      const [, rawSub, dplId] = positional;
      if (!rawSub || !dplId) {
        console.error('用法: myship alias <subdomain> <deployment_id>');
        process.exit(1);
      }
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const finalSub = resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain);
      if (isLocal) {
        setAlias(finalSub, dplId, { project: ctx.project });
      } else {
        await setRemoteAlias(finalSub, dplId, { project: ctx.project });
      }
      return;
    }
    if (first === 'rollback') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      let rawSub = positional[1];
      let targetDplId = positional[2] || rollbackTargetArg || null;
      if (rawSub && rawSub.startsWith('dpl_')) {
        targetDplId = rawSub;
        rawSub = null;
      }
      const finalSub = rawSub
        ? resolveNamespacedSubdomain(rawSub, ctx.project, isRawDomain)
        : ctx.prodDomain;
      if (isLocal) {
        rollbackAlias(finalSub, targetDplId, { project: ctx.project });
      } else {
        await rollbackRemoteAlias(finalSub, targetDplId, { project: ctx.project });
      }
      return;
    }
    if (first === 'console' || first === 'dashboard' || first === 'ui') {
      const port = Number.parseInt(portArg || process.env.PORT || '4200', 10) || 4200;
      await startConsoleServer({
        port,
        isLocal,
        cwd: process.cwd(),
      });
      return;
    }
    if (first === 'gc' || first === 'prune') {
      const parsedKeep =
        keepArg === 'all' || (olderThanArg && keepArg === null)
          ? Infinity
          : keepArg !== null
          ? Math.max(Number.parseInt(keepArg, 10) || 10, 1)
          : 10;
      const projectFilter = explicitProject ? normalizeDomainToken(explicitProject) : null;
      if (isLocal) {
        gcState({
          keepCount: parsedKeep,
          olderThan: olderThanArg,
          projectFilter,
          dryRun: isDryRun,
        });
      } else {
        await gcRemoteState({
          keepCount: parsedKeep,
          olderThan: olderThanArg,
          projectFilter,
          dryRun: isDryRun,
        });
      }
      return;
    }
    if (
      first === 'rm' ||
      first === 'remove' ||
      first === 'del' ||
      first === 'delete' ||
      first === 'purge'
    ) {
      const restTargets = positional.slice(1);
      if (first === 'purge' || (explicitProject && restTargets.length === 0 && aliasTargets.length === 0)) {
        const targetProj = restTargets[0] || explicitProject;
        if (!targetProj) {
          throw new Error('用法: myship rm --project <项目名> [--dry-run]');
        }
        await removeResources({
          purgeProject: targetProj,
          dryRun: isDryRun,
          isLocal,
        });
        return;
      }
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      if (aliasTargets.length > 0) {
        await removeResources({
          aliases: [...aliasTargets, ...restTargets],
          project: explicitProject ? normalizeDomainToken(explicitProject) : ctx.project,
          raw: isRawDomain,
          dryRun: isDryRun,
          isLocal,
        });
        return;
      }
      await removeResources({
        deploymentIds: restTargets,
        project: explicitProject ? normalizeDomainToken(explicitProject) : null,
        force: isForce,
        dryRun: isDryRun,
        isLocal,
      });
      return;
    }
    if (first === 'env') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const targetProj = explicitProject ? normalizeDomainToken(explicitProject) : ctx.project;
      const subcommand = positional[1] || 'ls';
      const subArgs = positional.slice(2);
      await runEnvCommand({
        subcommand,
        args: subArgs,
        project: targetProj,
        isLocal,
        reveal: isReveal,
        cwd: process.cwd(),
      });
      return;
    }
    if (first === 'dev') {
      const ctx = detectProjectContext(process.cwd(), explicitProject);
      const targetProj = explicitProject ? normalizeDomainToken(explicitProject) : ctx.project;
      let staticDir = positional[1];
      if (!staticDir) {
        if (existsSync(resolve(process.cwd(), 'index.html'))) {
          staticDir = '.';
        } else if (existsSync(resolve(process.cwd(), 'public/index.html'))) {
          staticDir = './public';
        } else if (ctx.buildDir && existsSync(resolve(process.cwd(), ctx.buildDir))) {
          staticDir = ctx.buildDir;
        } else {
          staticDir = '.';
        }
      }
      const port = Number.parseInt(portArg || process.env.PORT || '3000', 10) || 3000;
      await startDevServer({
        staticDir,
        cwd: process.cwd(),
        project: targetProj,
        port,
      });
      return;
    }

    // 默认行为：deploy
    let targetDir = null;
    if (first === 'deploy') {
      targetDir = positional[1] || null;
      if (positional[2]) domains.push(positional[2]);
    } else {
      targetDir = positional[0] || null;
      if (positional[1]) domains.push(positional[1]);
    }

    const ctx = detectProjectContext(process.cwd(), explicitProject);
    let finalDir = targetDir || ctx.buildDir;
    const pkgJsonPath = resolve(process.cwd(), 'package.json');
    if (!targetDir && existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
        if (pkg?.scripts?.build && (!existsSync(resolve(finalDir)) || ctx.backend?.enabled)) {
          console.log(`🔨 检测到前端构建脚本 (npm run build)，正在自动构建前端产物...`);
          const buildRes = spawnSync('npm', ['run', 'build'], {
            cwd: process.cwd(),
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });
          if (buildRes.status !== 0) {
            throw new Error(`前端构建失败 (npm run build 退出码: ${buildRes.status})，已终止发布。`);
          }
          const refreshedCtx = detectProjectContext(process.cwd(), explicitProject);
          finalDir = refreshedCtx.buildDir;
        }
      } catch (err) {
        if (err.message.includes('前端构建失败')) throw err;
      }
    }
    if (!finalDir || !existsSync(resolve(finalDir))) {
      console.error(
        `❌ 未找到构建产物目录 (${finalDir || './dist'})。请先执行构建 (如 npm run build) 或指定目录: myship ./dist`
      );
      process.exit(1);
    }

    if (!ctx.hasSavedConfig || explicitProject) {
      ensureProjectConfig(process.cwd(), {
        project: ctx.project,
        dir: finalDir,
      });
      console.log(`📁 已自动创建项目命名空间配置: .myship/project.json [项目: ${ctx.project}]`);
    }

    const resolvedAliases = domains.map((d) =>
      resolveNamespacedSubdomain(d, ctx.project, isRawDomain)
    );
    if (resolvedAliases.length === 0 && !isPreviewOnly) {
      resolvedAliases.push(ctx.prodDomain);
    }

    if (isLocal) {
      deployDirectory(finalDir, { aliases: resolvedAliases, project: ctx.project });
    } else {
      await deployRemoteDirectory(finalDir, {
        aliases: resolvedAliases,
        project: ctx.project,
        cwd: process.cwd(),
      });
    }
  })().catch((err) => {
    console.error(`❌ 执行失败: ${err.message}`);
    process.exit(1);
  });
}
