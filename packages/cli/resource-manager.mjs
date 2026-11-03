/**
 * resource-manager.mjs — MyShip 声明式资源注册与自动注入编排器 (`myship use`)
 *
 * 模块职责划分：
 * - `./tui-prompts.mjs`: 交互式终端选择器 (`promptSelect`) 与文本问答 (`promptText`)
 * - `./db-provisioners.mjs`: 多引擎数据库物理建库、建 Schema 与连接派生引擎
 * - `./resource-manager.mjs`: 项目资源环境变量解析 (`resolveProjectResourceEnv`) 与 `myship use` 命令编排 (`runUseCommand`)
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_STORAGE_DIR,
  detectProjectContext,
  ensureProjectConfig,
  normalizeDomainToken,
} from './project-context.mjs';
import {
  discoverCloudBasePgEnvs,
  getEffectiveEndpoints,
  getGlobalDbProvidersConfig,
  saveMyShipFileConfig,
} from './cos-client.mjs';
import {
  getLocalProjectEnv,
  saveLocalProjectEnv,
  getRemoteProjectEnv,
} from './env-manager.mjs';
import { saveRemoteProjectEnvAndSyncWorker } from './serverless.mjs';
import { promptSelect, promptText } from './tui-prompts.mjs';
import {
  sanitizePgSchemaIdent,
  parsePostgresEnvVars,
  executePostgresSimpleSqlViaWire,
  executeMysqlSimpleSqlViaWire,
  ensureNeonSchemaOverHttp,
  provisionPostgresSchemaOrDb,
  provisionMysqlDatabase,
  derivePostgresProjectUrl,
  deriveMysqlProjectUrl,
  discoverTursoOrganizations,
  provisionTursoDatabase,
  provisionCloudflareD1Database,
  provisionNeonDatabase,
} from './db-provisioners.mjs';

export {
  promptSelect,
  promptText,
  sanitizePgSchemaIdent,
  parsePostgresEnvVars,
  executePostgresSimpleSqlViaWire,
  executeMysqlSimpleSqlViaWire,
  ensureNeonSchemaOverHttp,
  provisionPostgresSchemaOrDb,
  provisionMysqlDatabase,
  derivePostgresProjectUrl,
  deriveMysqlProjectUrl,
  discoverTursoOrganizations,
  provisionTursoDatabase,
  provisionCloudflareD1Database,
  provisionNeonDatabase,
};

export const MANAGED_STORAGE_ENV_KEYS = [
  'MYSHIP_STORAGE_PREFIX',
  'MYSHIP_FILES_PREFIX',
  'MYSHIP_STORAGE_ISOLATION',
  'MYSHIP_STORAGE_ENV',
];

export const MANAGED_DB_ENV_KEYS = [
  'MYSHIP_DB_PROVIDER',
  'MYSHIP_DB_ISOLATION',
  'DATABASE_URL',
  'NEON_DATABASE_URL',
  'MYSQL_URL',
  'MYSQL_DATABASE',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'CF_ACCOUNT_ID',
  'CF_D1_DATABASE_ID',
  'CF_D1_DATABASE_NAME',
  'CF_API_TOKEN',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PG_SCHEMA',
  'PGOPTIONS',
  'TCB_ENV_ID',
  'TCB_REGION',
];

const LAST_STORAGE_DIR_BY_CWD = new Map();

export function resolveProjectResourceEnv(
  cwd = process.cwd(),
  explicitProject = null,
  storageDir = null
) {
  const effectiveStorageDir =
    storageDir || LAST_STORAGE_DIR_BY_CWD.get(resolve(cwd)) || DEFAULT_STORAGE_DIR;
  const ctx = detectProjectContext(cwd, explicitProject);
  const project = ctx.project;
  const resources = ctx.resources || {};
  const globalDb = getGlobalDbProvidersConfig();
  const envFilePath = resolve(effectiveStorageDir, 'envs', `${project}.json`);
  const hasSavedEnvFile = existsSync(envFilePath);
  const privateEnv = getLocalProjectEnv(project, effectiveStorageDir);
  const out = {};

  if (resources.storage && resources.storage.enabled) {
    out.MYSHIP_STORAGE_PREFIX = resources.storage.dataPrefix || `data/${project}/`;
    out.MYSHIP_FILES_PREFIX = resources.storage.filesPrefix || `files/${project}/`;
    out.MYSHIP_STORAGE_ENV = resources.storage.env || 'prod';
    out.MYSHIP_STORAGE_ISOLATION = resources.storage.isolation || 'shared';
  }

  if (resources.db && resources.db.enabled) {
    const dbCfg = resources.db;
    out.MYSHIP_DB_PROVIDER = dbCfg.provider;
    out.MYSHIP_DB_ISOLATION = dbCfg.isolation || 'shared';
    if (dbCfg.schema) {
      out.PG_SCHEMA = dbCfg.schema;
      if (dbCfg.schema !== 'public') {
        out.PGOPTIONS = `-c search_path=${dbCfg.schema},public`;
      }
    }
    if (dbCfg.dbName && dbCfg.provider === 'mysql') {
      out.MYSQL_DATABASE = dbCfg.dbName;
    }
    if (dbCfg.provider === 'd1') {
      if (dbCfg.accountId || globalDb.cfAccountId) {
        out.CF_ACCOUNT_ID = dbCfg.accountId || globalDb.cfAccountId;
      }
      if (dbCfg.databaseId) out.CF_D1_DATABASE_ID = dbCfg.databaseId;
      if (dbCfg.dbName) out.CF_D1_DATABASE_NAME = dbCfg.dbName;
    }

    // 仅当项目环境变量文件尚未创建时（例如全新克隆仓库），才从全局配置派生初始连接串；
    // 一旦 envs/<project>.json 已存在，严格以 envs/<project>.json 为唯一可信源，绝不把被 `myship env rm` 删除的凭证或旧密码重新带回。
    if (hasSavedEnvFile) {
      for (const k of MANAGED_DB_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(privateEnv, k)) {
          out[k] = privateEnv[k];
        }
      }
    } else if (dbCfg.provider === 'pg') {
      if (globalDb.pgMasterUrl) {
        const derived = derivePostgresProjectUrl(
          globalDb.pgMasterUrl,
          project,
          dbCfg.env || 'prod',
          {
            raw: Boolean(dbCfg.raw),
            isolateBy: dbCfg.isolateBy || 'schema',
          }
        );
        out.DATABASE_URL = derived.databaseUrl;
        out.PG_SCHEMA = derived.schema;
        Object.assign(out, parsePostgresEnvVars(out.DATABASE_URL, out.PG_SCHEMA));
      }
      if (dbCfg.tcbEnvId) {
        out.TCB_ENV_ID = dbCfg.tcbEnvId;
        out.TCB_REGION = dbCfg.tcbRegion || globalDb.tcbRegion || 'ap-shanghai';
      }
    } else if (dbCfg.provider === 'mysql' && globalDb.mysqlMasterUrl) {
      const derived = deriveMysqlProjectUrl(
        globalDb.mysqlMasterUrl,
        project,
        dbCfg.env || 'prod',
        { raw: Boolean(dbCfg.raw) }
      );
      out.DATABASE_URL = derived.databaseUrl;
      out.MYSQL_URL = derived.databaseUrl;
      out.MYSQL_DATABASE = derived.dbName;
    } else if (dbCfg.provider === 'neon' && globalDb.neonMasterUrl) {
      const derived = derivePostgresProjectUrl(
        globalDb.neonMasterUrl,
        project,
        dbCfg.env || 'prod'
      );
      out.NEON_DATABASE_URL = derived.databaseUrl;
      out.DATABASE_URL = derived.databaseUrl;
      out.PG_SCHEMA = derived.schema;
      Object.assign(out, parsePostgresEnvVars(out.DATABASE_URL, out.PG_SCHEMA));
    } else if (dbCfg.provider === 'd1' && globalDb.cfApiToken) {
      out.CF_API_TOKEN = globalDb.cfApiToken;
    }

    const pgTargetStr = `${out.PGHOST || ''} ${out.DATABASE_URL || ''} ${out.NEON_DATABASE_URL || ''}`;
    if (pgTargetStr.includes('-pooler.')) {
      delete out.PGOPTIONS;
    }
  }

  return out;
}

async function persistResourceEnvVars({
  project,
  cwd = null,
  entries,
  clearKeys = [],
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
}) {
  if (cwd && storageDir) {
    LAST_STORAGE_DIR_BY_CWD.set(resolve(cwd), storageDir);
  }
  const applyMerge = (baseVars) => {
    const cleaned = { ...baseVars };
    for (const k of clearKeys) {
      delete cleaned[k];
    }
    return { ...cleaned, ...entries };
  };

  const endpoints = getEffectiveEndpoints();
  const useLocal = Boolean(isLocal || !endpoints.isConfigured);
  if (useLocal) {
    const currentVars = getLocalProjectEnv(project, storageDir);
    const nextVars = applyMerge(currentVars);
    saveLocalProjectEnv(project, nextVars, storageDir);
    return { persistedTo: '本地沙盒 (envs/)' };
  }

  try {
    const currentVars = await getRemoteProjectEnv(project);
    const nextVars = applyMerge(currentVars);
    await saveRemoteProjectEnvAndSyncWorker(project, nextVars, { hotReload: false });
    saveLocalProjectEnv(project, nextVars, storageDir);
    return { persistedTo: '腾讯云 COS 私有存储 (envs/)' };
  } catch (err) {
    const currentVars = getLocalProjectEnv(project, storageDir);
    const nextVars = applyMerge(currentVars);
    saveLocalProjectEnv(project, nextVars, storageDir);
    return {
      persistedTo: `本地环境缓存 (远端 COS 同步跳过: ${err.message || err})`,
    };
  }
}

export async function runUseCommand({
  args = [],
  cwd = process.cwd(),
  explicitProject = null,
  isLocal = false,
  storageDir = DEFAULT_STORAGE_DIR,
  interactive = false,
  promptAnswers = null,
} = {}) {
  const ctx = detectProjectContext(cwd, explicitProject);
  const project = normalizeDomainToken(explicitProject || ctx.project) || 'app';

  const getOpt = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : null;
  };

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a === '--provider' ||
      a === '--set-default' ||
      a === '--isolate' ||
      a === '--url' ||
      a === '--org' ||
      a === '--token' ||
      a === '--api-key' ||
      a === '--db-token' ||
      a === '--account-id' ||
      a === '--project-id' ||
      a === '--env-id' ||
      a === '--region' ||
      a === '--db-id' ||
      a === '--env' ||
      a === '--group' ||
      a === '--project' ||
      a === '-p' ||
      a === '--storage-dir'
    ) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    positional.push(a.toLowerCase());
  }

  let target = positional[0] || '';
  const envName = normalizeDomainToken(getOpt('--env') || 'prod') || 'prod';
  const isolation = args.includes('--strict') ? 'strict' : 'shared';
  let isRawUrl = args.includes('--raw');
  const isGlobalFlag = args.includes('--global') || args.includes('-g');
  const isDefaultFlag = args.includes('--default');
  const setDefaultArg = getOpt('--set-default');
  const isInteractive = Boolean(
    interactive ||
      args.includes('-i') ||
      args.includes('--interactive') ||
      (process.stdin.isTTY && process.stdout.isTTY && !args.includes('--no-interactive'))
  );

  if (!target && !setDefaultArg) {
    if (isInteractive) {
      target = await promptSelect({
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
    } else {
      target = 'status';
    }
  }

  if (setDefaultArg || target === 'default-db') {
    const chosen = normalizeDomainToken(setDefaultArg || positional[1] || '');
    const allowed = new Set(['turso', 'd1', 'neon', 'pg', 'postgres', 'mysql']);
    if (!allowed.has(chosen)) {
      throw new Error(
        `无效的默认数据库平台 (${chosen})，可选值: turso | d1 | neon | pg | mysql`
      );
    }
    const normalizedProvider = chosen === 'postgres' ? 'pg' : chosen;
    const extraGlobalCfg = { defaultDbProvider: normalizedProvider };
    const urlOpt = getOpt('--url');
    const tokenOpt = getOpt('--token') || getOpt('--api-key');
    const orgOpt = getOpt('--org');
    const groupOpt = getOpt('--group');
    const accountIdOpt = getOpt('--account-id');
    const projectIdOpt = getOpt('--project-id');
    const envIdOpt = getOpt('--env-id');
    const regionOpt = getOpt('--region');
    if (normalizedProvider === 'pg') {
      if (urlOpt && !isRawUrl) extraGlobalCfg.pgMasterUrl = urlOpt;
      if (envIdOpt) extraGlobalCfg.tcbEnvId = envIdOpt;
      if (regionOpt) extraGlobalCfg.tcbRegion = regionOpt;
    } else if (normalizedProvider === 'mysql' && urlOpt && !isRawUrl) {
      extraGlobalCfg.mysqlMasterUrl = urlOpt;
    } else if (normalizedProvider === 'neon') {
      if (urlOpt && !isRawUrl) extraGlobalCfg.neonMasterUrl = urlOpt;
      if (tokenOpt) extraGlobalCfg.neonApiKey = tokenOpt;
      if (projectIdOpt) extraGlobalCfg.neonProjectId = projectIdOpt;
    } else if (normalizedProvider === 'turso') {
      if (orgOpt) extraGlobalCfg.tursoOrg = orgOpt;
      if (tokenOpt) extraGlobalCfg.tursoApiToken = tokenOpt;
      if (groupOpt) extraGlobalCfg.tursoGroup = groupOpt;
    } else if (normalizedProvider === 'd1') {
      if (accountIdOpt) extraGlobalCfg.cfAccountId = accountIdOpt;
      if (tokenOpt) extraGlobalCfg.cfApiToken = tokenOpt;
    }
    saveMyShipFileConfig(extraGlobalCfg);
    console.log(
      `✅ 已将全局默认数据库平台设置为: [${normalizedProvider}] (~/.myship/config.json)`
    );
    console.log(`   后续在任意新项目中直接运行 \`myship use db\` 即可自动使用 [${normalizedProvider}]！`);
    if (!getOpt('--provider') && target === 'default-db') {
      return { defaultDbProvider: normalizedProvider };
    }
  }

  if (target === 'storage' || target === 'files' || target === 'cos') {
    const envSegment = envName !== 'prod' ? `${envName}/` : '';
    const dataPrefix = `data/${project}/${envSegment}`;
    const filesPrefix = `files/${project}/${envSegment}`;

    const nextResources = {
      ...(ctx.resources || {}),
      storage: {
        enabled: true,
        provider: 'cos',
        env: envName,
        isolation,
        dataPrefix,
        filesPrefix,
        updatedAt: new Date().toISOString(),
      },
    };

    ensureProjectConfig(cwd, {
      project,
      resources: nextResources,
    });

    const envEntries = {
      MYSHIP_STORAGE_PREFIX: dataPrefix,
      MYSHIP_FILES_PREFIX: filesPrefix,
      MYSHIP_STORAGE_ISOLATION: isolation,
      MYSHIP_STORAGE_ENV: envName,
    };
    const { persistedTo } = await persistResourceEnvVars({
      project,
      cwd,
      entries: envEntries,
      clearKeys: MANAGED_STORAGE_ENV_KEYS,
      isLocal,
      storageDir,
    });

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
    return { project, resource: 'storage', config: nextResources.storage };
  }

  if (target === 'db' || target === 'database') {
    const globalDb = getGlobalDbProvidersConfig();
    if (setDefaultArg && !getOpt('--provider') && !positional[1]) {
      return { defaultDbProvider: normalizeDomainToken(setDefaultArg) };
    }

    const explicitProviderArg = getOpt('--provider') || positional[1] || '';
    let rawProvider = '';

    if (explicitProviderArg) {
      rawProvider = explicitProviderArg.toLowerCase();
    } else if (isInteractive) {
      const defProv = (ctx.resources?.db?.provider || globalDb.defaultDbProvider || '').toLowerCase();
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

      rawProvider = await promptSelect({
        title: `请选择项目 [${project}] 要接入的数据库底座`,
        items: providerMenu,
        defaultIndex: defaultIdx,
        promptAnswers,
      });
    } else {
      rawProvider = (
        ctx.resources?.db?.provider ||
        globalDb.defaultDbProvider ||
        'turso'
      ).toLowerCase();
    }

    const maybeSaveDefaultProvider = (canonicalProvider) => {
      if (isDefaultFlag || !globalDb.defaultDbProvider) {
        saveMyShipFileConfig({ defaultDbProvider: canonicalProvider });
      }
    };

    // 1. 腾讯云 CloudBase PostgreSQL / 原生 PostgreSQL
    if (
      rawProvider === 'pg' ||
      rawProvider === 'postgres' ||
      rawProvider === 'postgresql' ||
      rawProvider === 'cloudbase-pg'
    ) {
      let inputUrl = getOpt('--url');
      let inputEnvId = getOpt('--env-id');
      let inputRegion = getOpt('--region');
      let isolateBy = (getOpt('--isolate') || 'schema').toLowerCase();

      // 交互式自动扫描腾讯云 CloudBase PG 环境 (免记 EnvId / Region)
      if (rawProvider === 'cloudbase-pg' && !inputEnvId) {
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
            inputEnvId = await promptText({
              question: '请输入腾讯云 CloudBase 环境 ID (EnvId)',
              defaultValue: globalDb.tcbEnvId || '',
              promptAnswers,
            });
            inputRegion = await promptText({
              question: '请输入所属地域 (Region)',
              defaultValue: globalDb.tcbRegion || 'ap-shanghai',
              promptAnswers,
            });
          } else {
            const [pickedId, pickedRegion] = chosenEnv.split(':::');
            inputEnvId = pickedId;
            inputRegion = pickedRegion || 'ap-shanghai';
          }
        } else if (discoveredEnvs.length === 1 && !isInteractive) {
          inputEnvId = discoveredEnvs[0].envId;
          inputRegion = discoveredEnvs[0].region;
        } else if (isInteractive && !globalDb.tcbEnvId && rawProvider === 'cloudbase-pg') {
          inputEnvId = await promptText({
            question: '请输入腾讯云 CloudBase 环境 ID (EnvId)',
            defaultValue: '',
            promptAnswers,
          });
          inputRegion = await promptText({
            question: '请输入所属地域 (Region)',
            defaultValue: 'ap-shanghai',
            promptAnswers,
          });
        }

        // 选择连接模式：黄金组合连接串模式 vs 极速零配置管控模式 vs 绑定现有 public 库
        if (isInteractive && (inputEnvId || globalDb.tcbEnvId) && !inputUrl && !globalDb.pgMasterUrl) {
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
            inputUrl = await promptText({
              question: '请粘贴 PostgreSQL 主连接串 (postgresql://user:pass@host:5432/postgres)',
              defaultValue: '',
              promptAnswers,
            });
          } else if (modeChoice === 'raw-public') {
            isRawUrl = true;
          }
        }
      } else if (
        rawProvider === 'pg' &&
        isInteractive &&
        !inputUrl &&
        !globalDb.pgMasterUrl
      ) {
        inputUrl = await promptText({
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
          isRawUrl = true;
        } else {
          isolateBy = isoChoice;
        }
      }

      if (
        (inputUrl && !isRawUrl && (isGlobalFlag || !globalDb.pgMasterUrl)) ||
        inputEnvId ||
        inputRegion
      ) {
        saveMyShipFileConfig({
          ...(inputUrl && !isRawUrl && (isGlobalFlag || !globalDb.pgMasterUrl)
            ? { pgMasterUrl: inputUrl }
            : {}),
          ...(inputEnvId ? { tcbEnvId: inputEnvId } : {}),
          ...(inputRegion ? { tcbRegion: inputRegion } : {}),
        });
      }
      maybeSaveDefaultProvider('pg');

      const masterUrl = inputUrl || globalDb.pgMasterUrl;
      // 仅当显式指定 --env-id、或使用 cloudbase-pg、或未指定独立 --url 时才启用 CloudBase TCB_ENV_ID，防止全局 tcbEnvId 污染无关的原生 PG 连接串
      const shouldUseTcbEnv =
        Boolean(inputEnvId) ||
        rawProvider === 'cloudbase-pg' ||
        (!inputUrl && !globalDb.pgMasterUrl);
      const tcbEnvId = inputEnvId || (shouldUseTcbEnv ? globalDb.tcbEnvId : '');
      const tcbRegion = inputRegion || globalDb.tcbRegion || 'ap-shanghai';
      if (!masterUrl && !tcbEnvId) {
        throw new Error(
          [
            '尚未配置全局 PostgreSQL / CloudBase PG 主连接串 (pgMasterUrl) 或 CloudBase 环境 ID (tcbEnvId)。',
            '👉 推荐直接运行交互式引导自动发现并选择环境：',
            '   myship use db',
            '👉 或使用命令行参数配置：',
            '   myship use db --provider pg --url "postgresql://user:pass@host:5432/postgres" [--env-id <tcb-env-id>]',
          ].join('\n')
        );
      }

      const cleanProj = sanitizePgSchemaIdent(project);
      const cleanEnv = sanitizePgSchemaIdent(envName);
      const defaultSchema =
        !cleanEnv || cleanEnv === 'prod'
          ? `myship_${cleanProj}`
          : `myship_${cleanProj}_${cleanEnv}`;

      const derived = masterUrl
        ? derivePostgresProjectUrl(masterUrl, project, envName, {
            raw: isRawUrl,
            isolateBy,
          })
        : {
            schema: isRawUrl ? 'public' : defaultSchema,
            dbName: defaultSchema,
            databaseUrl: '',
          };
      const schema = derived.schema;
      const databaseUrl = derived.databaseUrl;

      const provisionResult = await provisionPostgresSchemaOrDb({
        masterUrl,
        tcbEnvId,
        tcbRegion,
        schema,
        dbName: derived.dbName || defaultSchema,
        isolateBy,
        isRaw: isRawUrl,
        isLocal,
      });

      const pgSplitVars = parsePostgresEnvVars(databaseUrl, schema);

      // 安全规范：.myship/project.json 严禁落盘含密码的 databaseUrl，仅保存非敏感资源声明
      const nextResources = {
        ...(ctx.resources || {}),
        db: {
          enabled: true,
          provider: 'pg',
          env: envName,
          schema,
          isolateBy,
          raw: isRawUrl,
          ...(tcbEnvId ? { tcbEnvId, tcbRegion } : {}),
          isolation,
          updatedAt: new Date().toISOString(),
        },
      };

      ensureProjectConfig(cwd, {
        project,
        resources: nextResources,
      });

      const envEntries = {
        MYSHIP_DB_PROVIDER: 'pg',
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        ...pgSplitVars,
        ...(tcbEnvId ? { TCB_ENV_ID: tcbEnvId, TCB_REGION: tcbRegion } : {}),
      };

      const { persistedTo } = await persistResourceEnvVars({
        project,
        cwd,
        entries: envEntries,
        clearKeys: MANAGED_DB_ENV_KEYS,
        isLocal,
        storageDir,
      });

      console.log('==============================================================');
      console.log(`✅ 项目 [${project}] PostgreSQL (CloudBase PG / 原生 PG) 已注册并注入！`);
      console.log(
        `   🐘 数据库模式:   ${
          isRawUrl
            ? '原生直连 (--raw 自定义库)'
            : isolateBy === 'db'
            ? `独立数据库隔离 (${derived.dbName})`
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
      return {
        project,
        resource: 'db',
        provider: 'pg',
        schema,
        databaseUrl,
        provisionStatus: provisionResult.status,
        provisionMethod: provisionResult.method,
      };
    }

    // 1b. 原生 MySQL / MariaDB / TiDB / 腾讯云 TDSQL-C MySQL
    if (
      rawProvider === 'mysql' ||
      rawProvider === 'mariadb' ||
      rawProvider === 'tidb' ||
      rawProvider === 'tdsql-mysql'
    ) {
      let inputUrl = getOpt('--url');
      if (isInteractive && !inputUrl && !globalDb.mysqlMasterUrl) {
        inputUrl = await promptText({
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
        if (mysqlIso === 'raw') isRawUrl = true;
      }
      if (inputUrl && !isRawUrl && (isGlobalFlag || !globalDb.mysqlMasterUrl)) {
        saveMyShipFileConfig({ mysqlMasterUrl: inputUrl });
      }
      maybeSaveDefaultProvider('mysql');

      const masterUrl = inputUrl || globalDb.mysqlMasterUrl;
      if (!masterUrl) {
        throw new Error(
          [
            '尚未配置全局原生 MySQL 主连接串 (mysqlMasterUrl)。',
            '👉 首次使用请附带 `--url` 参数 (只需配置一次，后续新项目自动按 `myship_<project>` 派生并创建独立库)：',
            '   myship use db --provider mysql --url "mysql://root:pass@host:3306/"',
            '👉 专业开发者如需直接连接现有 MySQL 数据库 (不改写库名)，请加 `--raw`：',
            '   myship use db --provider mysql --url "mysql://user:pass@host:3306/existing_db" --raw',
          ].join('\n')
        );
      }

      const { dbName, databaseUrl } = deriveMysqlProjectUrl(masterUrl, project, envName, {
        raw: isRawUrl,
      });

      const provisionResult = await provisionMysqlDatabase({
        masterUrl,
        dbName,
        isRaw: isRawUrl,
        isLocal,
      });

      const nextResources = {
        ...(ctx.resources || {}),
        db: {
          enabled: true,
          provider: 'mysql',
          env: envName,
          dbName,
          raw: isRawUrl,
          isolation,
          updatedAt: new Date().toISOString(),
        },
      };

      ensureProjectConfig(cwd, {
        project,
        resources: nextResources,
      });

      const { persistedTo } = await persistResourceEnvVars({
        project,
        cwd,
        entries: {
          MYSHIP_DB_PROVIDER: 'mysql',
          DATABASE_URL: databaseUrl,
          MYSQL_URL: databaseUrl,
          MYSQL_DATABASE: dbName,
        },
        clearKeys: MANAGED_DB_ENV_KEYS,
        isLocal,
        storageDir,
      });

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
      console.log('   - 标准生态: 使用 `mysql2/promise` / `drizzle-orm` / `prisma` 连接 `process.env.DATABASE_URL` (或 `MYSQL_URL`)');
      console.log('==============================================================');
      return {
        project,
        resource: 'db',
        provider: 'mysql',
        dbName,
        databaseUrl,
        provisionStatus: provisionResult.status,
      };
    }

    // 2. Turso (libSQL / Edge SQLite)
    if (rawProvider === 'turso' || rawProvider === 'libsql') {
      let inputOrg = getOpt('--org');
      let inputApiToken = getOpt('--token') || process.env.TURSO_API_TOKEN || '';
      const inputGroup = getOpt('--group');
      const directDbUrl = getOpt('--url');
      const directDbToken = getOpt('--db-token');

      if (isInteractive && !directDbUrl && !inputApiToken && !globalDb.tursoApiToken) {
        inputApiToken = await promptText({
          question: '请输入 Turso Platform API Token',
          defaultValue: '',
          promptAnswers,
        });
      }

      const activeApiToken = inputApiToken || globalDb.tursoApiToken;
      if (!directDbUrl && !inputOrg && !globalDb.tursoOrg && activeApiToken) {
        const orgs = await discoverTursoOrganizations({ apiToken: activeApiToken });
        if (orgs.length === 1) {
          inputOrg = orgs[0].slug;
          console.log(`✅ 已通过 API Token 自动识别 Turso 组织: ${inputOrg}`);
        } else if (orgs.length > 1) {
          if (isInteractive) {
            inputOrg = await promptSelect({
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
            inputOrg = orgs[0].slug;
          }
        } else if (isInteractive) {
          inputOrg = await promptText({
            question: '请输入 Turso 组织名 (Organization Slug)',
            defaultValue: '',
            promptAnswers,
          });
        }
      }

      if (inputOrg || inputApiToken || inputGroup) {
        saveMyShipFileConfig({
          ...(inputOrg ? { tursoOrg: inputOrg } : {}),
          ...(inputApiToken ? { tursoApiToken: inputApiToken } : {}),
          ...(inputGroup ? { tursoGroup: inputGroup } : {}),
        });
      }
      maybeSaveDefaultProvider('turso');

      const dbName =
        envName === 'prod' ? `myship-${project}` : `myship-${project}-${envName}`;

      let databaseUrl = directDbUrl || '';
      let authToken = directDbToken || '';
      let action = 'bound';

      if (!databaseUrl || !authToken) {
        const org = inputOrg || globalDb.tursoOrg;
        const apiToken = activeApiToken;
        const group = inputGroup || globalDb.tursoGroup || 'default';
        if (!org || !apiToken) {
          throw new Error(
            [
              '尚未配置 Turso Platform API Token (tursoApiToken)。',
              '👉 方式一 (推荐 · 仅需传入一次 --token，自动识别组织并建库签发 Token)：',
              '   myship use db --provider turso --token <turso-api-token>',
              '👉 方式二 (直接绑定单个已有 Turso 数据库 URL 与 Token)：',
              '   myship use db --provider turso --url "libsql://..." --db-token "<db-jwt>"',
            ].join('\n')
          );
        }

        const provisioned = await provisionTursoDatabase({
          org,
          apiToken,
          dbName,
          group,
          explicitGroup: Boolean(inputGroup),
        });
        databaseUrl = provisioned.databaseUrl;
        authToken = provisioned.authToken;
        action = provisioned.action;
      }

      const nextResources = {
        ...(ctx.resources || {}),
        db: {
          enabled: true,
          provider: 'turso',
          env: envName,
          dbName,
          isolation,
          updatedAt: new Date().toISOString(),
        },
      };

      ensureProjectConfig(cwd, {
        project,
        resources: nextResources,
      });

      const { persistedTo } = await persistResourceEnvVars({
        project,
        cwd,
        entries: {
          MYSHIP_DB_PROVIDER: 'turso',
          TURSO_DATABASE_URL: databaseUrl,
          TURSO_AUTH_TOKEN: authToken,
        },
        clearKeys: MANAGED_DB_ENV_KEYS,
        isLocal,
        storageDir,
      });

      console.log('==============================================================');
      console.log(`✅ 项目 [${project}] Turso (Edge SQLite) 数据库已${action === 'created' ? '自动创建' : '绑定'}并注入！`);
      console.log(`   ⚡ 数据库名称:   ${dbName}`);
      console.log(`   🔗 连接地址:     ${databaseUrl}`);
      console.log(`   🌍 环境模式:     ${envName} (本地 dev 自动映射至 .myship/data/${project}/local.sqlite)`);
      console.log(`   🔐 隔离策略:     ${isolation}`);
      console.log(`   📥 环境变量同步: ${persistedTo} (TURSO_DATABASE_URL, TURSO_AUTH_TOKEN)`);
      console.log('--------------------------------------------------------------');
      console.log('💡 在后端代码中零依赖直接使用：');
      console.log("   await context.db.execute('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');");
      console.log("   await context.db.execute('INSERT INTO notes (text) VALUES (?)', ['Hello Turso']);");
      console.log("   const rows = await context.db.query('SELECT * FROM notes');");
      console.log('==============================================================');
      return { project, resource: 'db', provider: 'turso', dbName, databaseUrl, action };
    }

    // 3. Cloudflare D1 (Serverless SQLite)
    if (rawProvider === 'd1' || rawProvider === 'cloudflare-d1') {
      let inputAccountId = getOpt('--account-id');
      let inputApiToken = getOpt('--token');
      const explicitDbId = getOpt('--db-id');

      if (
        isInteractive &&
        !inputAccountId &&
        !globalDb.cfAccountId &&
        !inputApiToken &&
        !globalDb.cfApiToken
      ) {
        inputAccountId = await promptText({
          question: '请输入 Cloudflare Account ID',
          defaultValue: '',
          promptAnswers,
        });
        inputApiToken = await promptText({
          question: '请输入 Cloudflare API Token (需 D1 Edit 权限)',
          defaultValue: '',
          promptAnswers,
        });
      }

      if (inputAccountId || inputApiToken) {
        saveMyShipFileConfig({
          ...(inputAccountId ? { cfAccountId: inputAccountId } : {}),
          ...(inputApiToken ? { cfApiToken: inputApiToken } : {}),
        });
      }
      maybeSaveDefaultProvider('d1');

      const accountId = inputAccountId || globalDb.cfAccountId;
      const apiToken = inputApiToken || globalDb.cfApiToken;
      if (!accountId || !apiToken) {
        throw new Error(
          [
            '尚未配置 Cloudflare 全局 Account ID 或 API Token。',
            '👉 首次使用请附带 `--account-id` 与 `--token` (只需配置一次，后续所有新项目自动查找或创建 D1 数据库)：',
            '   myship use db --provider d1 --account-id <cf-account-id> --token <cf-api-token>',
          ].join('\n')
        );
      }

      const dbName =
        envName === 'prod' ? `myship-${project}` : `myship-${project}-${envName}`;

      const provisioned = await provisionCloudflareD1Database({
        accountId,
        apiToken,
        dbName,
        explicitDbId,
      });

      const nextResources = {
        ...(ctx.resources || {}),
        db: {
          enabled: true,
          provider: 'd1',
          env: envName,
          dbName,
          accountId,
          databaseId: provisioned.databaseId,
          isolation,
          updatedAt: new Date().toISOString(),
        },
      };

      ensureProjectConfig(cwd, {
        project,
        resources: nextResources,
      });

      const { persistedTo } = await persistResourceEnvVars({
        project,
        cwd,
        entries: {
          MYSHIP_DB_PROVIDER: 'd1',
          CF_ACCOUNT_ID: accountId,
          CF_D1_DATABASE_ID: provisioned.databaseId,
          CF_D1_DATABASE_NAME: dbName,
          CF_API_TOKEN: apiToken,
        },
        clearKeys: MANAGED_DB_ENV_KEYS,
        isLocal,
        storageDir,
      });

      console.log('==============================================================');
      console.log(
        `✅ 项目 [${project}] Cloudflare D1 数据库已${
          provisioned.action === 'created' ? '自动创建' : '绑定'
        }并注入！`
      );
      console.log(`   ☁️  D1 数据库名:  ${dbName}`);
      console.log(`   🆔 Database ID:  ${provisioned.databaseId}`);
      console.log(`   🌍 环境模式:     ${envName} (本地 dev 自动映射至 .myship/data/${project}/local.sqlite)`);
      console.log(`   🔐 隔离策略:     ${isolation}`);
      console.log(`   📥 环境变量同步: ${persistedTo} (CF_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_API_TOKEN)`);
      console.log('--------------------------------------------------------------');
      console.log('💡 在后端代码中零依赖直接使用：');
      console.log("   await context.db.execute('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');");
      console.log("   const rows = await context.db.query('SELECT * FROM items WHERE id = ?', [1]);");
      console.log('==============================================================');
      return {
        project,
        resource: 'db',
        provider: 'd1',
        dbName,
        databaseId: provisioned.databaseId,
        action: provisioned.action,
      };
    }

    // 4. Neon (Serverless PostgreSQL: 支持全局连接串多 Schema 隔离 + Neon API v2 自动建库 + 原生 HTTP /sql)
    if (rawProvider === 'neon' || rawProvider === 'neon-pg') {
      let inputUrl = getOpt('--url');
      let inputApiKey = getOpt('--api-key') || getOpt('--token');
      const inputProjectId = getOpt('--project-id');

      if (
        isInteractive &&
        !inputUrl &&
        !globalDb.neonMasterUrl &&
        !inputApiKey &&
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
          inputApiKey = await promptText({
            question: '请输入 Neon API Key',
            defaultValue: '',
            promptAnswers,
          });
        } else {
          inputUrl = await promptText({
            question: '请粘贴 Neon 连接串 (postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require)',
            defaultValue: '',
            promptAnswers,
          });
        }
      }

      if ((!isRawUrl && inputUrl) || inputApiKey || inputProjectId) {
        saveMyShipFileConfig({
          ...(inputUrl && !isRawUrl ? { neonMasterUrl: inputUrl } : {}),
          ...(inputApiKey ? { neonApiKey: inputApiKey } : {}),
          ...(inputProjectId ? { neonProjectId: inputProjectId } : {}),
        });
      }
      maybeSaveDefaultProvider('neon');

      const apiKey = inputApiKey || globalDb.neonApiKey;
      const neonProjectId = inputProjectId || globalDb.neonProjectId;
      const masterUrl = inputUrl || globalDb.neonMasterUrl;

      let databaseUrl = '';
      let schema = 'public';
      let dbName = '';
      let action = 'bound';

      if (apiKey && !inputUrl) {
        const cleanIdent = sanitizePgSchemaIdent(project);
        dbName =
          envName === 'prod'
            ? `myship_${cleanIdent}`
            : `myship_${cleanIdent}_${sanitizePgSchemaIdent(envName)}`;
        const provisioned = await provisionNeonDatabase({
          apiKey,
          projectId: neonProjectId,
          dbName,
        });
        if (!neonProjectId && provisioned.projectId) {
          saveMyShipFileConfig({ neonProjectId: provisioned.projectId });
        }
        databaseUrl = provisioned.databaseUrl;
        action = provisioned.action;
      } else if (masterUrl) {
        const derived = derivePostgresProjectUrl(masterUrl, project, envName, {
          raw: isRawUrl,
        });
        schema = derived.schema;
        databaseUrl = derived.databaseUrl;
        action = 'schema-isolated';
        if (!isRawUrl) {
          await ensureNeonSchemaOverHttp({
            connectionUrl: masterUrl,
            schema,
            isLocal,
          });
        }
      } else {
        throw new Error(
          [
            '尚未配置 Neon Serverless PostgreSQL 全局连接串或 API Key。',
            '👉 方式一 (推荐 · 配置一次全局 Neon 主连接串，后续所有新项目零额外成本自动派生独立 Schema)：',
            '   myship use db --provider neon --url "postgresql://neondb_owner:npg_xxx@ep-xxx.neon.tech/neondb?sslmode=require"',
            '👉 方式二 (配置一次 Neon API Key，自动调用 Neon API v2 为每个项目创建独立逻辑库)：',
            '   myship use db --provider neon --token <neon-api-key> [--project-id <neon-project-id>]',
          ].join('\n')
        );
      }

      // 安全规范：.myship/project.json 严禁落盘含密码的 databaseUrl
      const nextResources = {
        ...(ctx.resources || {}),
        db: {
          enabled: true,
          provider: 'neon',
          env: envName,
          ...(dbName ? { dbName } : {}),
          schema,
          isolation,
          updatedAt: new Date().toISOString(),
        },
      };

      ensureProjectConfig(cwd, {
        project,
        resources: nextResources,
      });

      const { persistedTo } = await persistResourceEnvVars({
        project,
        cwd,
        entries: {
          MYSHIP_DB_PROVIDER: 'neon',
          NEON_DATABASE_URL: databaseUrl,
          DATABASE_URL: databaseUrl,
          ...parsePostgresEnvVars(databaseUrl, schema),
        },
        clearKeys: MANAGED_DB_ENV_KEYS,
        isLocal,
        storageDir,
      });

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
      console.log("   1. 零依赖内置 HTTP SQL: await context.db.query('SELECT * FROM users WHERE id = $1', [1]);");
      console.log('   2. 标准生态驱动/ORM:    使用 `@neondatabase/serverless` / `drizzle-orm` / `pg` 连接 `process.env.DATABASE_URL`');
      console.log('==============================================================');
      return {
        project,
        resource: 'db',
        provider: 'neon',
        dbName: dbName || null,
        schema,
        databaseUrl,
        action,
      };
    }

    throw new Error(
      `不支持的数据库 Provider: ${rawProvider}。目前支持: --provider turso | d1 | neon | pg | mysql`
    );
  }

  // 默认 status 视图
  const globalDb = getGlobalDbProvidersConfig();
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
  return { project, resources: ctx.resources || {}, defaultDbProvider: globalDb.defaultDbProvider || 'turso' };
}
