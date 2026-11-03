/**
 * resource-wizards.mjs — MyShip 交互式云资源引导向导与终端状态面板 (`myship use`)
 *
 * 职责：
 * - 顶层资源选择菜单 (`promptUseTargetWizard`) 与五大数据库底座选择菜单 (`promptDbProviderWizard`)
 * - CloudBase PG / 原生 PG / MySQL / Turso / Cloudflare D1 / Neon 的交互式参数采集与自动发现菜单
 * - 资源开通完成后的终端引导面板与 `myship use status` 全景状态渲染 (`renderUseResourceStatusView`)
 */
import { discoverCloudBasePgEnvs } from './tcb-client.mjs';
import { getEffectiveEndpoints } from './cos-client.mjs';
import { getLocalProjectEnv, getRemoteProjectEnv } from './env-manager.mjs';
import { promptSelect, promptText } from './tui-prompts.mjs';
import {
  sanitizePgSchemaIdent,
  discoverTursoOrganizations,
} from './db-provisioners.mjs';

export async function promptUseTargetWizard({ project, promptAnswers }) {
  return promptSelect({
    title: `请选择要为项目 [${project}] 接入或查看的云资源`,
    items: [
      {
        label: '🗄️  接入数据库 (Database)',
        hint: '[CloudBase PG / Neon / Turso / D1 / MySQL]',
        value: 'db',
      },
      {
        label: '📦 接入对象存储与文件上传 (Storage & Files)',
        hint: '[自动注入 context.storage + context.files]',
        value: 'storage',
      },
      {
        label: '📊 查看当前项目资源状态 (Status)',
        hint: '[查看已绑定资源与全局底座就绪状态]',
        value: 'status',
      },
    ],
    defaultIndex: 0,
    promptAnswers,
  });
}

export async function promptDbProviderWizard({
  project,
  ctx,
  globalDb,
  promptAnswers,
}) {
  const defProv = (
    ctx.resources?.db?.provider ||
    globalDb.defaultDbProvider ||
    ''
  ).toLowerCase();
  const providerMenu = [
    {
      label: '🐘 腾讯云 CloudBase PostgreSQL',
      hint: globalDb.tcbEnvId
        ? `[✅ 已绑定环境: ${globalDb.tcbEnvId}${defProv === 'pg' ? ' · ⭐ 默认' : ''}]`
        : '[自动扫描云端环境，免记配置]',
      value: 'cloudbase-pg',
    },
    {
      label: '⚡ Neon Serverless PostgreSQL',
      hint:
        globalDb.neonApiKey || globalDb.neonMasterUrl
          ? `[✅ 已配置全局凭证${defProv === 'neon' ? ' · ⭐ 默认' : ''}]`
          : '[Serverless PG · 多 Schema 零成本隔离]',
      value: 'neon',
    },
    {
      label: '🚀 Turso (Edge SQLite)',
      hint:
        globalDb.tursoOrg && globalDb.tursoApiToken
          ? `[✅ 已配置 org:${globalDb.tursoOrg}${defProv === 'turso' ? ' · ⭐ 默认' : ''}]`
          : '[libSQL 边缘低延迟 SQLite]',
      value: 'turso',
    },
    {
      label: '☁️  Cloudflare D1',
      hint:
        globalDb.cfAccountId && globalDb.cfApiToken
          ? `[✅ 已配置全局凭证${defProv === 'd1' ? ' · ⭐ 默认' : ''}]`
          : '[Serverless SQLite]',
      value: 'd1',
    },
    {
      label: '🐬 原生 MySQL / 腾讯云 TDSQL-C',
      hint: globalDb.mysqlMasterUrl
        ? `[✅ 已配置主连接串${defProv === 'mysql' ? ' · ⭐ 默认' : ''}]`
        : '[标准 mysql:// 协议自动分库]',
      value: 'mysql',
    },
    {
      label: '🐘 原生 PostgreSQL (标准连接串)',
      hint: globalDb.pgMasterUrl
        ? `[✅ 已配置主连接串${defProv === 'pg' && !globalDb.tcbEnvId ? ' · ⭐ 默认' : ''}]`
        : '[标准 postgresql:// 协议自动分 Schema]',
      value: 'pg',
    },
  ];
  let defaultIdx = 0;
  if (defProv === 'neon') defaultIdx = 1;
  else if (defProv === 'turso') defaultIdx = 2;
  else if (defProv === 'd1') defaultIdx = 3;
  else if (defProv === 'mysql') defaultIdx = 4;
  else if (defProv === 'pg' && globalDb.pgMasterUrl && !globalDb.tcbEnvId) defaultIdx = 5;

  return promptSelect({
    title: `请选择项目 [${project}] 要接入的数据库底座`,
    items: providerMenu,
    defaultIndex: defaultIdx,
    promptAnswers,
  });
}

export async function runInteractivePgSetupWizard({
  project,
  rawProvider,
  inputUrl,
  inputEnvId,
  inputRegion,
  isolateBy,
  isRawUrl,
  isLocal,
  isInteractive,
  globalDb,
  promptAnswers,
}) {
  let nextUrl = inputUrl;
  let nextEnvId = inputEnvId;
  let nextRegion = inputRegion;
  let nextIsolateBy = isolateBy;
  let nextIsRawUrl = isRawUrl;

  if (rawProvider === 'cloudbase-pg' && !nextEnvId) {
    console.log('🔍 正在扫描当前腾讯云账号下的 CloudBase PostgreSQL 环境...');
    let discoveredEnvs = [];
    if (!isLocal || process.env.TCB_API_ENDPOINT) {
      try {
        discoveredEnvs = await discoverCloudBasePgEnvs();
      } catch {
        discoveredEnvs = [];
      }
    }

    if (discoveredEnvs.length > 0 && isInteractive) {
      const envItems = discoveredEnvs.map((env) => ({
        label: `${env.envId}${env.alias && env.alias !== env.envId ? ` (${env.alias})` : ''}`,
        hint: `[${env.region} · ${env.packageName || 'Serverless PG'} · 实例: ${env.instanceName}]`,
        value: `${env.envId}:::${env.region}`,
      }));
      envItems.push({
        label: '✍️  手动输入其他 CloudBase 环境 ID',
        hint: '[输入自定义 EnvId]',
        value: '__manual__',
      });
      const defaultEnvIdx = globalDb.tcbEnvId
        ? Math.max(
            0,
            discoveredEnvs.findIndex((e) => e.envId === globalDb.tcbEnvId)
          )
        : 0;
      const chosenEnv = await promptSelect({
        title: '已自动发现以下腾讯云 CloudBase PG 环境，请选择',
        items: envItems,
        defaultIndex: defaultEnvIdx,
        promptAnswers,
      });
      if (chosenEnv === '__manual__') {
        nextEnvId = await promptText({
          question: '请输入腾讯云 CloudBase 环境 ID (EnvId)',
          defaultValue: globalDb.tcbEnvId || '',
          promptAnswers,
        });
        nextRegion = await promptText({
          question: '请输入所属地域 (Region)',
          defaultValue: globalDb.tcbRegion || 'ap-shanghai',
          promptAnswers,
        });
      } else {
        const [pickedId, pickedRegion] = chosenEnv.split(':::');
        nextEnvId = pickedId;
        nextRegion = pickedRegion || 'ap-shanghai';
      }
    } else if (discoveredEnvs.length === 1 && !isInteractive) {
      nextEnvId = discoveredEnvs[0].envId;
      nextRegion = discoveredEnvs[0].region;
    } else if (isInteractive && !globalDb.tcbEnvId && rawProvider === 'cloudbase-pg') {
      nextEnvId = await promptText({
        question: '请输入腾讯云 CloudBase 环境 ID (EnvId)',
        defaultValue: '',
        promptAnswers,
      });
      nextRegion = await promptText({
        question: '请输入所属地域 (Region)',
        defaultValue: 'ap-shanghai',
        promptAnswers,
      });
    }

    if (isInteractive && (nextEnvId || globalDb.tcbEnvId) && !nextUrl && !globalDb.pgMasterUrl) {
      const modeChoice = await promptSelect({
        title: '请选择 CloudBase PostgreSQL 接入模式',
        items: [
          {
            label: '🔌 黄金组合模式 (推荐 · 标准连接池 / ORM)',
            hint: '[ExecutePGSql 自动建 Schema + 注入 PGHOST/DATABASE_URL，支持 pg.Pool / Drizzle / Prisma]',
            value: 'hybrid',
          },
          {
            label: '⚡ 管控 API 直连模式 (免填连接串)',
            hint: '[仅用 EnvId 自动建 Schema + 零依赖 context.db 直连，适合轻量/低频读写]',
            value: 'api-only',
          },
          {
            label: '🔗 直接绑定默认 public Schema (不新建 Schema)',
            hint: '[使用现有 public Schema + 零依赖 context.db 直连]',
            value: 'raw-public',
          },
        ],
        defaultIndex: 0,
        promptAnswers,
      });
      if (modeChoice === 'hybrid') {
        nextUrl = await promptText({
          question: '请粘贴 PostgreSQL 主连接串 (postgresql://user:pass@host:5432/postgres)',
          defaultValue: '',
          promptAnswers,
        });
      } else if (modeChoice === 'raw-public') {
        nextIsRawUrl = true;
      }
    }
  } else if (
    rawProvider === 'pg' &&
    isInteractive &&
    !nextUrl &&
    !globalDb.pgMasterUrl
  ) {
    nextUrl = await promptText({
      question: '请粘贴 PostgreSQL 连接串 (postgresql://user:pass@host:5432/postgres)',
      defaultValue: '',
      promptAnswers,
    });
    const isoChoice = await promptSelect({
      title: '请选择项目库隔离策略',
      items: [
        {
          label: `🏷️  按项目自动派生独立 Schema (myship_${sanitizePgSchemaIdent(project)})`,
          hint: '[单实例零成本多项目隔离]',
          value: 'schema',
        },
        {
          label: `🗄️  按项目自动创建独立 Database (myship_${sanitizePgSchemaIdent(project)})`,
          hint: '[物理库级隔离]',
          value: 'db',
        },
        {
          label: '🔗 原生直连现有库 (--raw)',
          hint: '[不改写库名或 Schema，直接连接已有生产库]',
          value: 'raw',
        },
      ],
      defaultIndex: 0,
      promptAnswers,
    });
    if (isoChoice === 'raw') {
      nextIsRawUrl = true;
    } else {
      nextIsolateBy = isoChoice;
    }
  }

  return {
    inputUrl: nextUrl,
    inputEnvId: nextEnvId,
    inputRegion: nextRegion,
    isolateBy: nextIsolateBy,
    isRawUrl: nextIsRawUrl,
  };
}

export async function runInteractiveMysqlSetupWizard({
  project,
  inputUrl,
  isRawUrl,
  isInteractive,
  globalDb,
  promptAnswers,
}) {
  let nextUrl = inputUrl;
  let nextIsRawUrl = isRawUrl;
  if (isInteractive && !nextUrl && !globalDb.mysqlMasterUrl) {
    nextUrl = await promptText({
      question: '请粘贴 MySQL 连接串 (mysql://root:pass@host:3306/)',
      defaultValue: '',
      promptAnswers,
    });
    const mysqlIso = await promptSelect({
      title: '请选择 MySQL 隔离模式',
      items: [
        {
          label: `🗄️  按项目自动创建独立库 (myship_${sanitizePgSchemaIdent(project)})`,
          hint: '[推荐 · 自动执行 CREATE DATABASE]',
          value: 'isolated',
        },
        {
          label: '🔗 原生直连现有库 (--raw)',
          hint: '[不改写库名，直接连接已有生产库]',
          value: 'raw',
        },
      ],
      defaultIndex: 0,
      promptAnswers,
    });
    if (mysqlIso === 'raw') nextIsRawUrl = true;
  }
  return { inputUrl: nextUrl, isRawUrl: nextIsRawUrl };
}

export async function runInteractiveTursoSetupWizard({
  inputOrg,
  inputApiToken,
  directDbUrl,
  isInteractive,
  globalDb,
  promptAnswers,
}) {
  let nextOrg = inputOrg;
  let nextApiToken = inputApiToken;

  if (isInteractive && !directDbUrl && !nextApiToken && !globalDb.tursoApiToken) {
    nextApiToken = await promptText({
      question: '请输入 Turso Platform API Token',
      defaultValue: '',
      promptAnswers,
    });
  }

  const activeApiToken = nextApiToken || globalDb.tursoApiToken;
  if (!directDbUrl && !nextOrg && !globalDb.tursoOrg && activeApiToken) {
    const orgs = await discoverTursoOrganizations({ apiToken: activeApiToken });
    if (orgs.length === 1) {
      nextOrg = orgs[0].slug;
      console.log(`✅ 已通过 API Token 自动识别 Turso 组织: ${nextOrg}`);
    } else if (orgs.length > 1) {
      if (isInteractive) {
        nextOrg = await promptSelect({
          title: '🏢 检测到多个 Turso 组织，请选择目标组织：',
          items: orgs.map((o) => ({
            label: `${o.slug} (${o.name})`,
            hint: `[${o.type}]`,
            value: o.slug,
          })),
          defaultIndex: 0,
          promptAnswers,
        });
      } else {
        nextOrg = orgs[0].slug;
      }
    } else if (isInteractive) {
      nextOrg = await promptText({
        question: '请输入 Turso 组织名 (Organization Slug)',
        defaultValue: '',
        promptAnswers,
      });
    }
  }

  return { inputOrg: nextOrg, inputApiToken: nextApiToken, activeApiToken };
}

export async function runInteractiveD1SetupWizard({
  inputAccountId,
  inputApiToken,
  isInteractive,
  globalDb,
  promptAnswers,
}) {
  let nextAccountId = inputAccountId;
  let nextApiToken = inputApiToken;
  if (
    isInteractive &&
    !nextAccountId &&
    !globalDb.cfAccountId &&
    !nextApiToken &&
    !globalDb.cfApiToken
  ) {
    nextAccountId = await promptText({
      question: '请输入 Cloudflare Account ID',
      defaultValue: '',
      promptAnswers,
    });
    nextApiToken = await promptText({
      question: '请输入 Cloudflare API Token (需 D1 Edit 权限)',
      defaultValue: '',
      promptAnswers,
    });
  }
  return { inputAccountId: nextAccountId, inputApiToken: nextApiToken };
}

export async function runInteractiveNeonSetupWizard({
  inputUrl,
  inputApiKey,
  isInteractive,
  globalDb,
  promptAnswers,
}) {
  let nextUrl = inputUrl;
  let nextApiKey = inputApiKey;
  if (
    isInteractive &&
    !nextUrl &&
    !globalDb.neonMasterUrl &&
    !nextApiKey &&
    !globalDb.neonApiKey
  ) {
    const neonMode = await promptSelect({
      title: '请选择 Neon Serverless PostgreSQL 接入方式',
      items: [
        {
          label: '🔗 粘贴 Neon 主连接串 (推荐 · 单实例多 Schema 零成本隔离)',
          hint: '[自动派生 myship_<project> Schema 并通过 HTTP /sql 创建]',
          value: 'url',
        },
        {
          label: '🔑 输入 Neon API Key (自动调用 Neon API v2 建库)',
          hint: '[为每个项目创建独立逻辑 Database]',
          value: 'api-key',
        },
      ],
      defaultIndex: 0,
      promptAnswers,
    });
    if (neonMode === 'api-key') {
      nextApiKey = await promptText({
        question: '请输入 Neon API Key',
        defaultValue: '',
        promptAnswers,
      });
    } else {
      nextUrl = await promptText({
        question: '请粘贴 Neon 连接串 (postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require)',
        defaultValue: '',
        promptAnswers,
      });
    }
  }
  return { inputUrl: nextUrl, inputApiKey: nextApiKey };
}

export function printStorageBoundSummary({
  project,
  dataPrefix,
  filesPrefix,
  envName,
  isolation,
  persistedTo,
}) {
  console.log('==============================================================');
  console.log(`✅ 项目 [${project}] 对象存储资源已注册并注入！`);
  console.log(`   📦 JSON KV 前缀 (context.storage): ${dataPrefix}`);
  console.log(`   🗂️  文件存储前缀 (context.files):   ${filesPrefix}`);
  console.log(`   🌍 环境模式:                        ${envName} (本地 dev 自动映射至 .myship/files/${project}/)`);
  console.log(
    `   🔐 隔离策略:                        ${isolation} (${
      isolation === 'shared'
        ? '复用全局 COS 凭证 + 路径前缀隔离'
        : '路径前缀隔离 (STS 子密钥收紧策略预留，当前版本复用全局 COS 凭证)'
    })`
  );
  console.log(`   📥 环境变量已同步至:                ${persistedTo}`);
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中直接使用：');
  console.log("   await context.files.put('Uploads/hello.txt', 'Hello MyShip!', { contentType: 'text/plain' });");
  console.log("   const buf = await context.files.get('Uploads/hello.txt');");
  console.log("   const uploadUrl = await context.files.presignUrl('Uploads/avatar.png', { method: 'PUT' });");
  console.log('==============================================================');
}

export function printPgBoundSummary({
  project,
  isRawUrl,
  isolateBy,
  dbName,
  schema,
  provisionResult,
  envName,
  isolation,
  persistedTo,
  envEntries,
}) {
  console.log('==============================================================');
  console.log(`✅ 项目 [${project}] PostgreSQL (CloudBase PG / 原生 PG) 已注册并注入！`);
  console.log(
    `   🐘 数据库模式:   ${
      isRawUrl
        ? '原生直连 (--raw 自定义库)'
        : isolateBy === 'db'
        ? `独立数据库隔离 (${dbName})`
        : `单实例多 Schema 隔离 (${schema})`
    }`
  );
  console.log(
    `   🔨 物理建库状态: ${
      provisionResult.status === 'created'
        ? `✅ 已在远端物理创建 [${provisionResult.target}] (${provisionResult.method})`
        : `⚪ ${provisionResult.method}`
    }`
  );
  console.log(`   🌍 环境模式:     ${envName}`);
  console.log(`   🔐 隔离策略:     ${isolation}`);
  console.log(
    `   📥 环境变量同步: ${persistedTo} (${Object.keys(envEntries).join(', ')})`
  );
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中直接使用 (对齐腾讯云 CloudBase PG 官方 Node.js 规范)：');
  console.log('   - 标准连接池: 使用 `new pg.Pool({ host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE, ssl: { rejectUnauthorized: false }, max: 5 })`');
  console.log('   - 标准 ORM:   使用 `drizzle-orm` / `prisma` 连接 `process.env.DATABASE_URL`');
  console.log('==============================================================');
}

export function printMysqlBoundSummary({
  project,
  dbName,
  isRawUrl,
  provisionResult,
  envName,
  isolation,
  persistedTo,
}) {
  console.log('==============================================================');
  console.log(`✅ 项目 [${project}] 原生 MySQL 数据库已注册并注入！`);
  console.log(
    `   🐬 数据库名称:   ${dbName} (${isRawUrl ? '原生直连 --raw' : '按项目自动派生隔离库名'})`
  );
  console.log(
    `   🔨 物理建库状态: ${
      provisionResult.status === 'created'
        ? `✅ 已在远端物理创建数据库 [${dbName}] (${provisionResult.method})`
        : `⚪ ${provisionResult.method}`
    }`
  );
  console.log(`   🌍 环境模式:     ${envName}`);
  console.log(`   🔐 隔离策略:     ${isolation}`);
  console.log(`   📥 环境变量同步: ${persistedTo} (DATABASE_URL, MYSQL_URL, MYSQL_DATABASE)`);
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中直接使用：');
  console.log(
    '   - 标准生态: 使用 `mysql2/promise` / `drizzle-orm` / `prisma` 连接 `process.env.DATABASE_URL` (或 `MYSQL_URL`)'
  );
  console.log('==============================================================');
}

export function printTursoBoundSummary({
  project,
  action,
  dbName,
  databaseUrl,
  envName,
  isolation,
  persistedTo,
}) {
  console.log('==============================================================');
  console.log(
    `✅ 项目 [${project}] Turso (Edge SQLite) 数据库已${
      action === 'created' ? '自动创建' : '绑定'
    }并注入！`
  );
  console.log(`   ⚡ 数据库名称:   ${dbName}`);
  console.log(`   🔗 连接地址:     ${databaseUrl}`);
  console.log(
    `   🌍 环境模式:     ${envName} (本地 dev 自动映射至 .myship/data/${project}/local.sqlite)`
  );
  console.log(`   🔐 隔离策略:     ${isolation}`);
  console.log(`   📥 环境变量同步: ${persistedTo} (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)`);
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中零依赖直接使用：');
  console.log(
    "   await context.db.execute('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');"
  );
  console.log("   await context.db.execute('INSERT INTO notes (text) VALUES (?)', ['Hello Turso']);");
  console.log("   const rows = await context.db.query('SELECT * FROM notes');");
  console.log('==============================================================');
}

export function printD1BoundSummary({
  project,
  action,
  dbName,
  databaseId,
  envName,
  isolation,
  persistedTo,
}) {
  console.log('==============================================================');
  console.log(
    `✅ 项目 [${project}] Cloudflare D1 数据库已${
      action === 'created' ? '自动创建' : '绑定'
    }并注入！`
  );
  console.log(`   ☁️  D1 数据库名:  ${dbName}`);
  console.log(`   🆔 Database ID:  ${databaseId}`);
  console.log(
    `   🌍 环境模式:     ${envName} (本地 dev 自动映射至 .myship/data/${project}/local.sqlite)`
  );
  console.log(`   🔐 隔离策略:     ${isolation}`);
  console.log(`   📥 环境变量同步: ${persistedTo} (CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN)`);
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中零依赖直接使用：');
  console.log(
    "   await context.db.execute('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');"
  );
  console.log("   const rows = await context.db.query('SELECT * FROM items WHERE id = ?', [1]);");
  console.log('==============================================================');
}

export function printNeonBoundSummary({
  project,
  action,
  dbName,
  schema,
  envName,
  isolation,
  persistedTo,
}) {
  console.log('==============================================================');
  console.log(
    `✅ 项目 [${project}] Neon Serverless PostgreSQL 已${
      action === 'created' ? '自动创建数据库' : action === 'schema-isolated' ? '派生独立 Schema' : '绑定'
    }并注入！`
  );
  if (dbName) {
    console.log(`   🐘 独立逻辑库:   ${dbName}`);
  } else {
    console.log(`   🏷️  专属 Schema:  ${schema} (自动注入 search_path=${schema},public)`);
  }
  console.log(`   🌍 环境模式:     ${envName}`);
  console.log(`   🔐 隔离策略:     ${isolation}`);
  console.log(`   📥 环境变量同步: ${persistedTo} (NEON_DATABASE_URL, DATABASE_URL, PG_SCHEMA)`);
  console.log('--------------------------------------------------------------');
  console.log('💡 在后端代码中双模使用：');
  console.log(
    "   1. 零依赖内置 HTTP SQL: await context.db.query('SELECT * FROM users WHERE id = $1', [1]);"
  );
  console.log(
    '   2. 标准生态驱动/ORM:    使用 `@neondatabase/serverless` / `drizzle-orm` / `pg` 连接 `process.env.DATABASE_URL`'
  );
  console.log('==============================================================');
}

export async function renderUseResourceStatusView({
  project,
  ctx,
  globalDb,
  isLocal,
  storageDir,
}) {
  const endpoints = getEffectiveEndpoints();
  const useLocal = Boolean(isLocal || !endpoints.isConfigured);
  let envMap = {};
  try {
    envMap = useLocal
      ? getLocalProjectEnv(project, storageDir)
      : await getRemoteProjectEnv(project);
  } catch {
    // ignore
  }

  console.log('==============================================================');
  console.log(`🧩 MyShip 项目资源注册状态 — 项目 [${project}]`);
  console.log('--------------------------------------------------------------');
  if (ctx.resources?.storage?.enabled) {
    const s = ctx.resources.storage;
    console.log(
      `  📦 对象存储 (storage/files): ✅ 已启用 [env=${s.env || 'prod'}, isolation=${s.isolation || 'shared'}]`
    );
    console.log(`     - JSON 状态前缀: ${s.dataPrefix || `data/${project}/`}`);
    console.log(`     - 文件存储前缀:  ${s.filesPrefix || `files/${project}/`}`);
  } else {
    console.log('  📦 对象存储 (storage/files): ⚪ 未显式声明 (运行 `myship use storage` 一键注入)');
  }

  if (ctx.resources?.db?.enabled) {
    const d = ctx.resources.db;
    console.log(
      `  🗄️  数据库 (db):              ✅ 已启用 [provider=${d.provider}, env=${d.env || 'prod'}, isolation=${d.isolation || 'shared'}]`
    );
    if (d.provider === 'pg') {
      console.log(`     - 专属 Schema:   ${d.schema || `myship_${project}`}`);
    } else if (d.provider === 'mysql') {
      console.log(`     - 数据库名称:    ${d.dbName || `myship_${project}`}`);
    } else if (d.provider === 'neon') {
      if (d.dbName) console.log(`     - 独立数据库名:  ${d.dbName}`);
      console.log(`     - 专属 Schema:   ${d.schema || 'public'}`);
    } else if (d.provider === 'turso') {
      console.log(`     - 数据库名称:    ${d.dbName || `myship-${project}`}`);
      console.log(`     - 连接地址:      ${d.databaseUrl || envMap.TURSO_DATABASE_URL || '(已注入)'}`);
    } else if (d.provider === 'd1') {
      console.log(`     - D1 数据库名:   ${d.dbName || `myship-${project}`}`);
      console.log(`     - Database ID:   ${d.databaseId || envMap.CF_D1_DATABASE_ID || '(已注入)'}`);
    }
  } else {
    console.log(
      '  🗄️  数据库 (db):              ⚪ 未绑定 (运行 `myship use db [--provider <turso|d1|neon|pg|mysql>]` 一键开通)'
    );
  }

  console.log('--------------------------------------------------------------');
  console.log('🌐 全局数据库底座就绪状态 (~/.myship/config.json):');
  console.log(
    `   - ⭐ 全局默认平台:      ${globalDb.defaultDbProvider || 'turso (可通过 --set-default <provider> 修改)'}`
  );
  console.log(
    `   - 腾讯云PG / 原生PG:    ${globalDb.pgMasterUrl ? '✅ 已配置 pgMasterUrl' : '⚪ 未配置 (--provider pg --url ...)'}`
  );
  console.log(
    `   - 原生 MySQL / TiDB:   ${globalDb.mysqlMasterUrl ? '✅ 已配置 mysqlMasterUrl' : '⚪ 未配置 (--provider mysql --url ...)'}`
  );
  console.log(
    `   - Neon Serverless PG:  ${
      globalDb.neonApiKey
        ? '✅ 已配置 neonApiKey (API 自动建库)'
        : globalDb.neonMasterUrl
        ? '✅ 已配置 neonMasterUrl (多 Schema 隔离)'
        : '⚪ 未配置 (--provider neon --url ... 或 --token ...)'
    }`
  );
  console.log(
    `   - Turso Edge SQLite:   ${
      globalDb.tursoOrg && globalDb.tursoApiToken
        ? `✅ 已配置 (org: ${globalDb.tursoOrg})`
        : '⚪ 未配置 (--provider turso --org ... --token ...)'
    }`
  );
  console.log(
    `   - Cloudflare D1:       ${
      globalDb.cfAccountId && globalDb.cfApiToken
        ? '✅ 已配置 (cfAccountId + cfApiToken)'
        : '⚪ 未配置 (--provider d1 --account-id ... --token ...)'
    }`
  );
  console.log('==============================================================');
  return {
    project,
    resources: ctx.resources || {},
    defaultDbProvider: globalDb.defaultDbProvider || 'turso',
  };
}
