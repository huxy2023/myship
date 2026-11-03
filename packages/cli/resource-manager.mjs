/**
 * resource-manager.mjs — MyShip 声明式资源注册与自动注入编排器 (`myship use`)
 *
 * 模块职责划分：
 * - `./tui-prompts.mjs`: 交互式终端选择器 (`promptSelect`) 与文本问答 (`promptText`)
 * - `./resource-wizards.mjs`: 交互式引导流程、云环境自动扫描菜单与终端状态渲染面板
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
import {
  promptUseTargetWizard,
  promptDbProviderWizard,
  runInteractivePgSetupWizard,
  runInteractiveMysqlSetupWizard,
  runInteractiveTursoSetupWizard,
  runInteractiveD1SetupWizard,
  runInteractiveNeonSetupWizard,
  printStorageBoundSummary,
  printPgBoundSummary,
  printMysqlBoundSummary,
  printTursoBoundSummary,
  printD1BoundSummary,
  printNeonBoundSummary,
  renderUseResourceStatusView,
} from './resource-wizards.mjs';

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
    target = isInteractive
      ? await promptUseTargetWizard({ project, promptAnswers })
      : 'status';
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

    printStorageBoundSummary({
      project,
      dataPrefix,
      filesPrefix,
      envName,
      isolation,
      persistedTo,
    });
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
      rawProvider = await promptDbProviderWizard({
        project,
        ctx,
        globalDb,
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

      const pgWizardOut = await runInteractivePgSetupWizard({
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
      });
      inputUrl = pgWizardOut.inputUrl;
      inputEnvId = pgWizardOut.inputEnvId;
      inputRegion = pgWizardOut.inputRegion;
      isolateBy = pgWizardOut.isolateBy;
      isRawUrl = pgWizardOut.isRawUrl;

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

      printPgBoundSummary({
        project,
        isRawUrl,
        isolateBy,
        dbName: derived.dbName,
        schema,
        provisionResult,
        envName,
        isolation,
        persistedTo,
        envEntries,
      });
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
      const mysqlOut = await runInteractiveMysqlSetupWizard({
        project,
        inputUrl,
        isRawUrl,
        isInteractive,
        globalDb,
        promptAnswers,
      });
      inputUrl = mysqlOut.inputUrl;
      isRawUrl = mysqlOut.isRawUrl;

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

      printMysqlBoundSummary({
        project,
        dbName,
        isRawUrl,
        provisionResult,
        envName,
        isolation,
        persistedTo,
      });
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

      const tursoOut = await runInteractiveTursoSetupWizard({
        inputOrg,
        inputApiToken,
        directDbUrl,
        isInteractive,
        globalDb,
        promptAnswers,
      });
      inputOrg = tursoOut.inputOrg;
      inputApiToken = tursoOut.inputApiToken;
      const activeApiToken = tursoOut.activeApiToken;

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

      printTursoBoundSummary({
        project,
        action,
        dbName,
        databaseUrl,
        envName,
        isolation,
        persistedTo,
      });
      return { project, resource: 'db', provider: 'turso', dbName, databaseUrl, action };
    }

    // 3. Cloudflare D1 (Serverless SQLite)
    if (rawProvider === 'd1' || rawProvider === 'cloudflare-d1') {
      let inputAccountId = getOpt('--account-id');
      let inputApiToken = getOpt('--token');
      const explicitDbId = getOpt('--db-id');

      const d1Out = await runInteractiveD1SetupWizard({
        inputAccountId,
        inputApiToken,
        isInteractive,
        globalDb,
        promptAnswers,
      });
      inputAccountId = d1Out.inputAccountId;
      inputApiToken = d1Out.inputApiToken;

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

      printD1BoundSummary({
        project,
        action: provisioned.action,
        dbName,
        databaseId: provisioned.databaseId,
        envName,
        isolation,
        persistedTo,
      });
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

      const neonOut = await runInteractiveNeonSetupWizard({
        inputUrl,
        inputApiKey,
        isInteractive,
        globalDb,
        promptAnswers,
      });
      inputUrl = neonOut.inputUrl;
      inputApiKey = neonOut.inputApiKey;

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

      printNeonBoundSummary({
        project,
        action,
        dbName,
        schema,
        envName,
        isolation,
        persistedTo,
      });
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

  return renderUseResourceStatusView({
    project,
    ctx,
    globalDb: getGlobalDbProvidersConfig(),
    isLocal,
    storageDir,
  });
}
