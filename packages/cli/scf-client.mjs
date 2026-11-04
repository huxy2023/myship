/**
 * scf-client.mjs — 腾讯云云函数 SCF (Serverless Cloud Function) 全栈业务后端驱动与渐进式能力门禁
 *
 * 核心职责：
 * 1. 渐进式能力开关与前置准备预检向导 (`myship backend <enable|disable|status|doctor>`)：
 *    - 校验凭证、探测 SCF 服务开通状态与 CAM 权限 (`QcloudSCFFullAccess`)，缺失时给出逐步引导或唤起 `tccli`。
 * 2. 项目级 SCF Web 函数 (`Type: "HTTP"`) 生命周期管理：
 *    - 创建/更新函数代码与环境变量、轮询 `Active` 就绪状态、发布不可变版本 (`PublishVersion`)。
 * 3. 版本级函数 URL (`Type: "http"` 触发器) 池管理与健康检查：
 *    - 为每个发布的不可变版本绑定专属 HTTP 触发器，自动维护触发器池（保护活跃生产/预览版本，规避单函数 10 触发器上限）。
 *    - 切流前对新版本执行 `/_myship_health` 探针校验，失败则中止切流，保护线上版本。
 * 4. 后端日志聚合查询 (`myship logs`)：
 *    - 聚合实时容器日志、COS 持久化错误/请求日志 (`data/<project>/__myship_logs.json`) 与 SCF 原生日志。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dns from 'node:dns';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  loadTencentCredentials,
  getEffectiveEndpoints,
  cosGetJson,
  deployEdgeFunctionToTeo,
  probeEdgeGateway,
} from './cos-client.mjs';
import {
  generateEdgeFunctionCode,
} from './serverless.mjs';
import {
  normalizeDomainToken,
  detectProjectContext,
  ensureProjectConfig,
  inferCosRegion,
  loadCasStateSnapshot,
} from './project-context.mjs';
import {
  resolveBackendEntry,
  bundleScfBackend,
  createLocalPersistentStorage,
} from './scf-bundler.mjs';
import { resolveProjectResourceEnv } from './resource-manager.mjs';

function sha256HexStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Buf(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function hmacSha256Hex(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function resolveScfFunctionName(project = 'default') {
  const clean = normalizeDomainToken(project) || 'default';
  return `myship-${clean}`.slice(0, 56).replace(/-$/, '');
}

export async function scfRequest(action, payload = {}, region = 'ap-guangzhou') {
  const { secretId, secretKey, token } = loadTencentCredentials();
  const service = 'scf';
  const host = 'scf.tencentcloudapi.com';
  const version = '2018-04-16';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  const bodyStr = JSON.stringify(payload);
  const contentType = 'application/json; charset=utf-8';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256HexStr(bodyStr),
  ].join('\n');

  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    String(timestamp),
    credentialScope,
    sha256HexStr(canonicalRequest),
  ].join('\n');

  const secretDate = hmacSha256Buf(`TC3${secretKey}`, date);
  const secretService = hmacSha256Buf(secretDate, service);
  const secretSigning = hmacSha256Buf(secretService, 'tc3_request');
  const signature = hmacSha256Hex(secretSigning, stringToSign);

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Region': region || 'ap-guangzhou',
  };
  if (token) {
    headers['X-TC-Token'] = token;
  }

  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers,
    body: bodyStr,
  });
  const data = await res.json();
  if (data.Response && data.Response.Error) {
    const err = new Error(
      `SCF API [${action}] 失败 (${data.Response.Error.Code}): ${data.Response.Error.Message}`
    );
    err.code = data.Response.Error.Code;
    err.rawMessage = data.Response.Error.Message;
    err.requestId = data.Response.RequestId;
    throw err;
  }
  return data.Response;
}

/**
 * 前置环境与权限只读预检探针 (Preflight Check / Doctor)
 */
export async function preflightScfCheck({ region = 'ap-guangzhou' } = {}) {
  let cred;
  try {
    cred = loadTencentCredentials();
  } catch (err) {
    return {
      ok: false,
      reason: 'no_credentials',
      region,
      errorMessage: err.message,
      guidance: [
        '尚未配置腾讯云访问凭证。',
        '👉 方式一：运行 `myship login` 配置 SecretId / SecretKey',
        '👉 方式二：安装腾讯云官方 CLI (`pip install tccli`) 后运行 `tccli auth login` 浏览器扫码授权',
      ],
    };
  }

  try {
    const [accResp, listResp] = await Promise.all([
      scfRequest('GetAccount', {}, region),
      scfRequest('ListFunctions', { Limit: 5 }, region),
    ]);
    const nsUsage = accResp?.AccountUsage?.Namespace?.[0] || {};
    const nsLimit = accResp?.AccountLimit?.Namespace?.[0] || {};
    return {
      ok: true,
      region,
      credentialSource: cred.source,
      functionsCount: listResp?.TotalCount ?? nsUsage.FunctionsCount ?? 0,
      functionsLimit: nsLimit.FunctionsCount || 50,
      concurrentLimit: nsLimit.ConcurrentExecutions || 100,
    };
  } catch (err) {
    const code = String(err.code || '');
    if (code.startsWith('AuthFailure')) {
      return {
        ok: false,
        reason: 'unauthorized',
        region,
        credentialSource: cred.source,
        errorCode: code,
        errorMessage: err.rawMessage || err.message,
        guidance: [
          `当前凭证 (${cred.source}) 缺少腾讯云云函数 (SCF) 操作权限 [${code}]。`,
          '',
          '🛠️  请按以下任一方式完成前置授权准备：',
          '  1. 【CAM 子账号授权（推荐）】：',
          '     前往腾讯云访问管理控制台: https://console.cloud.tencent.com/cam/user',
          '     找到当前子用户 -> 点击「授权」 -> 搜索并勾选策略：',
          '     👉 QcloudSCFFullAccess (云函数 SCF 全读写访问权限)',
          '  2. 【或使用腾讯云 CLI 扫码授权】：',
          '     在终端执行 `tccli auth login` 使用主账号或有权限账号扫码，MyShip 将自动复用凭证。',
        ],
      };
    }

    return {
      ok: false,
      reason: 'service_error',
      region,
      credentialSource: cred.source,
      errorCode: code || 'UnknownError',
      errorMessage: err.rawMessage || err.message,
      guidance: [
        `腾讯云 SCF 服务预检未通过 [${code || 'Error'}]: ${err.rawMessage || err.message}`,
        '',
        '🛠️  前置准备指引：',
        '  1. 请确认已在腾讯云控制台开通「云函数 SCF」服务：',
        '     👉 https://console.cloud.tencent.com/scf',
        '  2. 若使用 CAM 子账号，请确认已授予 `QcloudSCFFullAccess` 权限策略：',
        '     👉 https://console.cloud.tencent.com/cam/user',
      ],
    };
  }
}

async function waitForFunctionActive({
  functionName,
  qualifier = '$LATEST',
  region = 'ap-guangzhou',
  maxWaitMs = 90000,
}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const info = await scfRequest(
      'GetFunction',
      {
        FunctionName: functionName,
        Qualifier: qualifier,
        ShowCode: 'FALSE',
      },
      region
    );
    const status = info.Status || '';
    if (status === 'Active') {
      return info;
    }
    if (status.includes('Failed') || status === 'Dead') {
      const reason =
        info.StatusDesc ||
        (Array.isArray(info.StatusReasons) && info.StatusReasons.length > 0
          ? JSON.stringify(info.StatusReasons)
          : status);
      throw new Error(`SCF 函数 [${functionName}@${qualifier}] 状态异常 (${status}): ${reason}`);
    }
    await sleep(1200);
  }
  throw new Error(
    `等待 SCF 函数 [${functionName}@${qualifier}] 就绪超时 (${Math.round(maxWaitMs / 1000)}s)`
  );
}

function extractExtranetUrlFromTrigger(trigger) {
  if (!trigger || !trigger.TriggerDesc) return null;
  try {
    const desc =
      typeof trigger.TriggerDesc === 'string'
        ? JSON.parse(trigger.TriggerDesc)
        : trigger.TriggerDesc;
    return desc?.NetConfig?.ExtranetUrl || desc?.NetConfig?.ExtranetHTTPUrl || null;
  } catch {
    return null;
  }
}

/**
 * 为指定的 SCF 版本 (Qualifier) 创建或复用专属 HTTP 函数 URL 触发器
 * 并自动维护触发器池（单函数上限 10 个，达到 8 个时自动回收未被活跃域名引用的旧版本触发器）
 */
export async function ensureScfVersionHttpTrigger({
  functionName,
  qualifier,
  region = 'ap-guangzhou',
  protectedQualifiers = new Set(),
}) {
  const trigResp = await scfRequest(
    'ListTriggers',
    {
      FunctionName: functionName,
      Limit: 20,
    },
    region
  );
  const allTriggers = trigResp.Triggers || [];
  const httpTriggers = allTriggers.filter((t) => t.Type === 'http');

  const existing = httpTriggers.find((t) => String(t.Qualifier) === String(qualifier));
  if (existing) {
    const url = extractExtranetUrlFromTrigger(existing);
    if (url) return url;
  }

  // 触发器配额保护（腾讯云单函数硬上限 10 个）：仅回收未被任何保留 manifest 引用的孤儿触发器，绝不越权删除受保护版本的触发器
  const SCF_MAX_HTTP_TRIGGERS = 10;
  if (httpTriggers.length >= SCF_MAX_HTTP_TRIGGERS) {
    const candidates = httpTriggers
      .filter(
        (t) =>
          String(t.Qualifier) !== String(qualifier) &&
          !protectedQualifiers.has(String(t.Qualifier))
      )
      .sort((a, b) => String(a.AddTime || '').localeCompare(String(b.AddTime || '')));

    const toDeleteCount = httpTriggers.length - SCF_MAX_HTTP_TRIGGERS + 1;
    if (candidates.length < toDeleteCount) {
      throw new Error(
        `函数 [${functionName}] 的 HTTP 触发器已达上限 (${httpTriggers.length}/${SCF_MAX_HTTP_TRIGGERS}) 且均处于受保护状态，无法为版本 v${qualifier} 创建触发器。请先清理不再使用的域名别名 (myship rm)。`
      );
    }
    for (let i = 0; i < toDeleteCount; i++) {
      const victim = candidates[i];
      await scfRequest(
        'DeleteTrigger',
        {
          FunctionName: functionName,
          TriggerName: victim.TriggerName,
          Type: 'http',
          Qualifier: victim.Qualifier,
          TriggerDesc: victim.TriggerDesc,
        },
        region
      );
    }
  }

  const triggerDesc = JSON.stringify({
    AuthType: 'NONE',
    NetConfig: {
      EnableIntranet: false,
      EnableExtranet: true,
    },
  });
  const triggerName = `myship-v${String(qualifier).replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 24);

  const createResp = await scfRequest(
    'CreateTrigger',
    {
      FunctionName: functionName,
      TriggerName: triggerName,
      Type: 'http',
      Qualifier: String(qualifier),
      TriggerDesc: triggerDesc,
      Enable: 'OPEN',
    },
    region
  );

  const url = extractExtranetUrlFromTrigger(createResp.TriggerInfo);
  if (!url) {
    const refreshed = await scfRequest(
      'ListTriggers',
      { FunctionName: functionName, Limit: 20 },
      region
    );
    const matched = (refreshed.Triggers || []).find(
      (t) => t.Type === 'http' && String(t.Qualifier) === String(qualifier)
    );
    const fallbackUrl = extractExtranetUrlFromTrigger(matched);
    if (!fallbackUrl) {
      throw new Error(`无法从 SCF 触发器响应中解析函数 URL (${functionName}@${qualifier})`);
    }
    return fallbackUrl;
  }
  return url;
}

/**
 * 删除指定 SCF 版本 (Qualifier) 的 HTTP 触发器与不可变版本
 * 供版本保留策略 (当前生产/别名版本 + 最近 5 个历史预览版本) 自动回收使用
 */
export async function deleteScfVersionAndTrigger({
  functionName,
  qualifier,
  region = 'ap-guangzhou',
}) {
  if (!functionName || !qualifier || qualifier === '$LATEST') return;
  try {
    const trigResp = await scfRequest(
      'ListTriggers',
      { FunctionName: functionName, Limit: 20 },
      region
    );
    const matched = (trigResp.Triggers || []).filter(
      (t) => String(t.Qualifier) === String(qualifier)
    );
    for (const trig of matched) {
      try {
        await scfRequest(
          'DeleteTrigger',
          {
            FunctionName: functionName,
            TriggerName: trig.TriggerName,
            Type: trig.Type || 'http',
            Qualifier: trig.Qualifier,
            TriggerDesc: trig.TriggerDesc,
          },
          region
        );
      } catch (err) {
        if (!String(err?.code || '').includes('ResourceNotFound')) {
          throw err;
        }
      }
    }
  } catch (err) {
    if (!String(err?.code || '').includes('ResourceNotFound')) {
      throw err;
    }
  }

  try {
    await scfRequest(
      'DeleteFunctionVersion',
      {
        FunctionName: functionName,
        Qualifier: String(qualifier),
      },
      region
    );
  } catch {
    // ignore if version already deleted or in use
  }
}

async function scfHttpGet(urlStr, headers = {}, timeoutMs = 8000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(urlStr, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    const causeCode = err?.cause?.code || err?.code || '';
    const parsed = new URL(urlStr);
    // 刚创建的 SCF 触发器子域名 (<appid>-<id>.<region>.tencentscf.com) 是指向 <region>.tencentscf.com 的 CNAME，
    // 首秒 DNS 尚未同步时回退解析父级地域网关域名，同时严格保留原始 Host 与 TLS SNI 校验。
    if (
      (causeCode === 'ENOTFOUND' || String(err?.message || '').includes('fetch failed')) &&
      parsed.protocol === 'https:' &&
      parsed.hostname.endsWith('.tencentscf.com')
    ) {
      const parts = parsed.hostname.split('.');
      if (parts.length >= 4) {
        const regionGatewayHost = parts.slice(1).join('.');
        return await new Promise((resolvePromise, rejectPromise) => {
          const req = https.request(
            parsed,
            {
              method: 'GET',
              headers: {
                ...headers,
                Host: parsed.hostname,
              },
              servername: parsed.hostname,
              timeout: timeoutMs,
              lookup: (_hostname, opts, cb) => dns.lookup(regionGatewayHost, opts, cb),
            },
            (res) => {
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                const status = res.statusCode || 500;
                resolvePromise({ status, ok: status >= 200 && status < 300, text });
              });
            }
          );
          req.on('timeout', () => {
            req.destroy(new Error(`SCF HTTPS request timeout (${timeoutMs}ms)`));
          });
          req.on('error', rejectPromise);
          req.end();
        });
      }
    }
    throw err;
  }
}

async function verifyScfEndpointHealth(upstreamUrl, gatewayToken = '', expectedVersion = null) {
  const healthUrl = new URL('/_myship_health', upstreamUrl).toString();
  const headers = {
    Accept: 'application/json',
  };
  if (gatewayToken) {
    headers['X-MyShip-Gateway-Token'] = gatewayToken;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await scfHttpGet(healthUrl, headers, 8000);
      if (res.ok) {
        const body = JSON.parse(res.text);
        if (body && body.ok) {
          return body;
        }
      } else {
        lastErr = new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(1200);
  }
  throw new Error(
    `SCF 后端新版本 (${expectedVersion || '$LATEST'}) 健康检查未通过 (${healthUrl}): ${
      lastErr ? lastErr.message : '未知响应'
    }。为保护线上稳定，已中止切流。可执行 \`myship logs\` 排查启动错误。`
  );
}

/**
 * 构建并发布项目的全栈 SCF 后端不可变新版本
 * 遵循原则：先准备并校验新后端版本，再写入部署清单并切换线上入口。
 */
export async function deployScfBackendVersion({
  project = 'default',
  cwd = process.cwd(),
  targetDir = null,
  backendConfig = {},
  envVars = {},
  remoteEnvKeys = null,
  protectedQualifiers = new Set(),
} = {}) {
  const cleanProj = normalizeDomainToken(project) || 'default';
  const region = backendConfig.region || inferCosRegion();
  const functionName = backendConfig.functionName || resolveScfFunctionName(cleanProj);
  const gatewayToken =
    backendConfig.gatewayToken || `msgt_${randomBytes(16).toString('hex')}`;
  const prefix = backendConfig.prefix || '/api';

  // 1. 前置权限与服务连通性预检
  const check = await preflightScfCheck({ region });
  if (!check.ok) {
    throw new Error(
      [
        `SCF 全栈后端预检失败: ${check.errorMessage || ''}`,
        ...check.guidance,
        '',
        '💡 提示: 如只需静态托管，可执行 `myship backend disable` 关闭 SCF 后端开关。',
      ].join('\n')
    );
  }

  // 2. 方案 C：保留项目多文件工程结构 + 按需提取收敛第三方 npm 依赖
  console.log(`📦 正在构建项目 [${cleanProj}] 的全栈后端工程包 (保留源码目录树 + 按需提取依赖)...`);
  const bundleRes = await bundleScfBackend({
    cwd,
    targetDir,
    explicitEntry: backendConfig.entry || null,
  });
  const srcCount = Array.isArray(bundleRes.sourceFiles) ? bundleRes.sourceFiles.length : 1;
  const extPkgs = Array.isArray(bundleRes.externalPackages) ? bundleRes.externalPackages : [];
  const pkgSummary =
    extPkgs.length > 0 ? `, 按需收敛 npm 依赖: ${extPkgs.join(', ')}` : ', 无外部 npm 依赖';
  console.log(
    `  ✅ 后端工程构建完成: 入口 ${bundleRes.relEntry} (保留源码文件 ${srcCount} 个${pkgSummary}) -> ZIP 归档 ${(
      bundleRes.zipSizeBytes / 1024
    ).toFixed(1)} KB`
  );

  // 3. 组装环境变量 (含项目环境变量、网关鉴权 Token 与 COS 持久化数据访问上下文)
  const { cosOrigin } = getEffectiveEndpoints();
  const cred = loadTencentCredentials();
  const scfRole =
    backendConfig.role || envVars.MYSHIP_SCF_ROLE || process.env.MYSHIP_SCF_ROLE || '';
  const hasExplicitRuntimeCreds = Boolean(
    envVars.MYSHIP_DATA_SECRET_ID && envVars.MYSHIP_DATA_SECRET_KEY && !envVars.MYSHIP_DATA_TOKEN
  );

  if (cred.token && !hasExplicitRuntimeCreds && !scfRole) {
    const remainMin =
      cred.expiresAt && Number.isFinite(cred.expiresAt)
        ? Math.max(0, Math.round((cred.expiresAt * 1000 - Date.now()) / 60000))
        : null;
    const expireHint = remainMin !== null ? `，剩余有效期约 ${remainMin} 分钟` : '';
    console.log(
      `  ℹ️  [凭证提示] 当前使用临时会话凭证 (${cred.source}${expireHint})，将继续为你完成部署；如需云函数长期免续期读写 COS，可按需配置长期密钥或绑定 SCF 运行角色。`
    );
  }

  const resourceEnv = resolveProjectResourceEnv(cwd, cleanProj);
  const trackedRemoteKeys = Array.isArray(remoteEnvKeys) ? remoteEnvKeys : [];
  const projectEnvKeysList = trackedRemoteKeys.filter(Boolean).join(',');
  const mergedEnvMap = {
    NODE_ENV: 'production',
    ...resourceEnv,
    ...envVars,
    MYSHIP_PROJECT: cleanProj,
    MYSHIP_GATEWAY_TOKEN: gatewayToken,
    ...(projectEnvKeysList ? { MYSHIP_PROJECT_ENV_KEYS: projectEnvKeysList } : {}),
    ...(cosOrigin ? { MYSHIP_COS_ORIGIN: cosOrigin } : {}),
  };

  if (!scfRole && !hasExplicitRuntimeCreds) {
    mergedEnvMap.MYSHIP_DATA_SECRET_ID = cred.secretId;
    mergedEnvMap.MYSHIP_DATA_SECRET_KEY = cred.secretKey;
    if (cred.token) {
      mergedEnvMap.MYSHIP_DATA_TOKEN = cred.token;
    }
    const totalEnvLen = JSON.stringify(mergedEnvMap).length;
    if (totalEnvLen >= 3900) {
      throw new Error(
        `项目环境变量与云端持久化凭证总长度 (${totalEnvLen} B) 超出腾讯云 SCF 4KB 限制。请精简环境变量，或配置 SCF 运行角色 (backend.role / MYSHIP_SCF_ROLE) 后重试。`
      );
    }
  } else if (JSON.stringify(mergedEnvMap).length >= 3950) {
    throw new Error(
      `项目环境变量总长度 (${JSON.stringify(mergedEnvMap).length} B) 超出腾讯云 SCF 4KB 限制，请精简环境变量后重试。`
    );
  }

  const Environment = {
    Variables: Object.entries(mergedEnvMap)
      .filter(([k, v]) => k && v !== undefined && v !== null && String(v) !== '')
      .map(([Key, Value]) => ({ Key, Value: String(Value) })),
  };

  const zipBase64 = bundleRes.zipBuffer.toString('base64');

  // 4. 创建或更新 SCF Web 函数 ($LATEST)
  let fnExists = false;
  for (let delWait = 0; delWait < 20; delWait++) {
    try {
      const fnInfo = await scfRequest(
        'GetFunction',
        { FunctionName: functionName, ShowCode: 'FALSE' },
        region
      );
      if (fnInfo.Status && String(fnInfo.Status).includes('Deleting')) {
        await sleep(1000);
        continue;
      }
      fnExists = true;
      break;
    } catch (err) {
      if (err.code !== 'ResourceNotFound.Function') {
        throw err;
      }
      fnExists = false;
      break;
    }
  }

  if (!fnExists) {
    console.log(`🚀 正在创建项目专属 SCF Web 云函数: ${functionName} (${region})...`);
    const runtimesToTry = ['Nodejs24.11', 'Nodejs18.15'];
    let created = false;
    let lastCreateErr = null;
    for (const rt of runtimesToTry) {
      try {
        await scfRequest(
          'CreateFunction',
          {
            FunctionName: functionName,
            Namespace: 'default',
            Type: 'HTTP',
            Runtime: rt,
            Handler: 'index.main_handler',
            MemorySize: 256,
            Timeout: 30,
            Description: `MyShip Full-Stack Backend for project [${cleanProj}]`,
            ...(scfRole ? { Role: scfRole } : {}),
            Code: {
              ZipFile: zipBase64,
            },
            Environment,
          },
          region
        );
        created = true;
        break;
      } catch (err) {
        lastCreateErr = err;
      }
    }
    if (!created && lastCreateErr) {
      throw lastCreateErr;
    }
    await waitForFunctionActive({ functionName, qualifier: '$LATEST', region });
  } else {
    console.log(`🔄 正在更新 SCF Web 云函数代码与环境配置: ${functionName} (${region})...`);
    await waitForFunctionActive({ functionName, qualifier: '$LATEST', region });
    await scfRequest(
      'UpdateFunctionCode',
      {
        FunctionName: functionName,
        Namespace: 'default',
        ZipFile: zipBase64,
      },
      region
    );
    await waitForFunctionActive({ functionName, qualifier: '$LATEST', region });
    await scfRequest(
      'UpdateFunctionConfiguration',
      {
        FunctionName: functionName,
        Namespace: 'default',
        MemorySize: 256,
        Timeout: 30,
        ...(scfRole ? { Role: scfRole } : {}),
        Environment,
      },
      region
    );
    await waitForFunctionActive({ functionName, qualifier: '$LATEST', region });
  }

  // 5. 发布不可变 SCF 版本 (PublishVersion)
  const pubResp = await scfRequest(
    'PublishVersion',
    {
      FunctionName: functionName,
      Namespace: 'default',
      Description: `MyShip deployment at ${new Date().toISOString()}`,
    },
    region
  );
  const scfVersion = String(pubResp.FunctionVersion);
  await waitForFunctionActive({ functionName, qualifier: scfVersion, region });

  // 6. 为该不可变版本绑定专属 HTTP 函数 URL 触发器
  const upstreamUrl = await ensureScfVersionHttpTrigger({
    functionName,
    qualifier: scfVersion,
    region,
    protectedQualifiers,
  });

  // 7. 切流前执行新版本健康探针校验
  console.log(
    `🩺 正在校验 SCF 后端新版本 [${functionName}@v${scfVersion}] 就绪状态 (${upstreamUrl})...`
  );
  await verifyScfEndpointHealth(upstreamUrl, gatewayToken, scfVersion);
  console.log(`  ✅ SCF 后端版本 v${scfVersion} 健康校验通过！`);

  return {
    provider: 'scf',
    region,
    functionName,
    scfVersion,
    upstreamUrl,
    prefix,
    gatewayToken,
    entry: bundleRes.relEntry,
    zipSizeBytes: bundleRes.zipSizeBytes,
  };
}

/**
 * 清理 SCF 历史版本或整个项目函数 (配合 myship gc / myship rm)
 */
export async function cleanupScfResources({
  functionName,
  region = 'ap-guangzhou',
  deleteEntireFunction = false,
  removeVersions = [],
} = {}) {
  if (!functionName) return;
  if (deleteEntireFunction) {
    try {
      const trigResp = await scfRequest(
        'ListTriggers',
        { FunctionName: functionName, Limit: 20 },
        region
      ).catch(() => ({ Triggers: [] }));
      for (const trig of trigResp.Triggers || []) {
        await scfRequest(
          'DeleteTrigger',
          {
            FunctionName: functionName,
            Type: trig.Type || 'http',
            TriggerName: trig.TriggerName,
            TriggerDesc: trig.TriggerDesc,
            Qualifier: trig.Qualifier,
          },
          region
        ).catch(() => {});
      }
      await scfRequest('DeleteFunction', { FunctionName: functionName }, region);
      console.log(`  🗑️  [SCF 清理] 已销毁项目云函数: ${functionName}`);
    } catch (err) {
      if (err.code !== 'ResourceNotFound.Function') {
        console.warn(`  ⚠️  [SCF 清理提示] 删除函数 ${functionName} 失败: ${err.message}`);
      }
    }
    return;
  }

  if (removeVersions.length === 0) return;

  let triggers = [];
  try {
    const trigResp = await scfRequest(
      'ListTriggers',
      { FunctionName: functionName, Limit: 20 },
      region
    );
    triggers = trigResp.Triggers || [];
  } catch {
    return;
  }

  for (const ver of removeVersions) {
    const q = String(ver);
    if (!q || q === '$LATEST' || q === '$DEFAULT') continue;
    const boundTriggers = triggers.filter((t) => String(t.Qualifier) === q);
    for (const t of boundTriggers) {
      try {
        await scfRequest(
          'DeleteTrigger',
          {
            FunctionName: functionName,
            TriggerName: t.TriggerName,
            Type: t.Type,
            Qualifier: q,
            TriggerDesc: t.TriggerDesc,
          },
          region
        );
      } catch {
        // ignore
      }
    }
    try {
      await scfRequest(
        'DeleteFunctionVersion',
        {
          FunctionName: functionName,
          Qualifier: q,
        },
        region
      );
    } catch {
      // ignore
    }
  }
}

/**
 * 渐进式能力开关 CLI 命令：`myship backend <enable|disable|status|doctor>`
 */
export async function runBackendCommand({
  subcommand = 'status',
  cwd = process.cwd(),
  explicitProject = null,
  region = null,
  entry = null,
  role = null,
  isLocal = false,
  upgradeGateway = false,
} = {}) {
  const ctx = detectProjectContext(cwd, explicitProject);
  const targetRegion = region || ctx.backend?.region || inferCosRegion();
  const functionName = ctx.backend?.functionName || resolveScfFunctionName(ctx.project);

  if (subcommand === 'disable' || subcommand === 'off') {
    const nextBackend = {
      ...(ctx.backend || {}),
      enabled: false,
      provider: 'scf',
      region: targetRegion,
      functionName,
    };
    ensureProjectConfig(cwd, {
      project: ctx.project,
      backend: nextBackend,
    });
    console.log(`🔒 已关闭项目 [${ctx.project}] 的 SCF 全栈后端开关 (.myship/project.json)`);
    console.log(`   后续执行 \`myship\` 将仅执行静态资源与常规部署，不再调用腾讯云 SCF 接口。`);
    return { enabled: false, project: ctx.project };
  }

  if (subcommand === 'enable' || subcommand === 'on') {
    console.log('==============================================================');
    console.log(`🔌 MyShip 全栈业务后端 (腾讯云 SCF) 能力开关与前置准备向导`);
    console.log(`   目标项目: [${ctx.project}] | 目标地域: ${targetRegion}`);
    console.log('==============================================================');

    if (!isLocal) {
      let check = await preflightScfCheck({ region: targetRegion });
      if (!check.ok && process.stdin.isTTY) {
        console.log(`\n⚠️  前置预检发现待配置项：`);
        for (const line of check.guidance) {
          console.log(`   ${line}`);
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const checkTccli = spawnSync('tccli', ['--version'], { stdio: 'ignore' });
        if (checkTccli.status === 0) {
          const ans = (
            await rl.question(
              '\n👉 检测到本机已安装 `tccli`，是否立即唤起 `tccli auth login` 扫码授权？[Y/n]: '
            )
          )
            .trim()
            .toLowerCase();
          if (!ans || ans === 'y' || ans === 'yes') {
            rl.pause();
            spawnSync('tccli', ['auth', 'login'], { stdio: 'inherit' });
            rl.resume();
          }
        } else {
          await rl.question(
            '\n👉 请在浏览器完成上述 CAM 授权或开通 SCF 服务后，按 [Enter] 键重新检测...'
          );
        }
        rl.close();
        check = await preflightScfCheck({ region: targetRegion });
      }

      if (!check.ok) {
        console.error(`\n❌ SCF 前置预检仍未通过：`);
        for (const line of check.guidance) {
          console.error(`   ${line}`);
        }
        throw new Error(`请先完成腾讯云 SCF 授权或服务开通后再运行 \`myship backend enable\`。`);
      }

      console.log(
        `✅ 腾讯云 SCF 权限与服务预检通过！(凭证来源: ${check.credentialSource}, 当前函数数: ${check.functionsCount}/${check.functionsLimit})`
      );
    }

    let resolvedEntry = null;
    try {
      resolvedEntry = resolveBackendEntry(cwd, ctx.buildDir, entry || ctx.backend?.entry || null);
    } catch {
      resolvedEntry = null;
    }

    let entryRel = entry || ctx.backend?.entry || (resolvedEntry ? resolvedEntry.relEntry : null);
    if (!resolvedEntry && !entryRel) {
      // 自动生成最小可用的标准后端入口骨架 server/index.mjs
      const defaultEntryPath = resolve(cwd, 'server', 'index.mjs');
      mkdirSync(dirname(defaultEntryPath), { recursive: true });
      writeFileSync(
        defaultEntryPath,
        [
          `// MyShip Full-Stack Node.js Backend (SCF Web Function & myship dev 同源入口)`,
          `export async function fetch(request, context) {`,
          `  const url = new URL(request.url);`,
          `  if (url.pathname === '/api/health' || url.pathname === '/api/hello') {`,
          `    return Response.json({`,
          `      ok: true,`,
          `      project: context.project,`,
          `      scfVersion: context.scfVersion,`,
          `      time: new Date().toISOString(),`,
          `    });`,
          `  }`,
          `  return Response.json({ error: 'Not Found', path: url.pathname }, { status: 404 });`,
          `}`,
          ``,
        ].join('\n'),
        'utf8'
      );
      entryRel = 'server/index.mjs';
      console.log(`📁 已自动生成标准全栈后端入口骨架: server/index.mjs`);
    }

    const gatewayToken =
      ctx.backend?.gatewayToken || `msgt_${randomBytes(16).toString('hex')}`;
    const nextRole = role || ctx.backend?.role || null;
    const nextBackend = {
      enabled: true,
      provider: 'scf',
      region: targetRegion,
      entry: entryRel,
      prefix: ctx.backend?.prefix || '/api',
      functionName,
      gatewayToken,
      ...(nextRole ? { role: nextRole } : {}),
    };

    const saved = ensureProjectConfig(cwd, {
      project: ctx.project,
      backend: nextBackend,
    });

    if (!isLocal) {
      const { cosOrigin, remoteDomain } = getEffectiveEndpoints();
      if (cosOrigin && remoteDomain) {
        try {
          const probe = await probeEdgeGateway(remoteDomain);
          if (!probe.online || upgradeGateway) {
            const { code } = generateEdgeFunctionCode({ cosOrigin, silent: true });
            await deployEdgeFunctionToTeo({ code, remoteDomain });
            console.log(`🌐 已同步部署全局 EdgeOne 网关 (myship-cas-router v2.2，支持 /api/* 通配转发)`);
          } else {
            console.log(`🌐 全局 EdgeOne 网关 (myship-cas-router) 已在线运行，无需重复修改共享网关`);
          }
        } catch {
          // ignore if current credential does not have TEO ModifyFunction permission
        }
      }
    }

    console.log(`\n🎉 已成功开启项目 [${ctx.project}] 的 SCF 全栈业务后端开关！`);
    console.log(`   📄 配置文件: ${saved.projectJsonPath}`);
    console.log(`   🏭 云函数名: ${functionName} (${targetRegion})`);
    console.log(`   🎯 后端入口: ${entryRel || '自动探测 (server/index.mjs 或 api/*.js)'}`);
    console.log(`   🛣️  转发前缀: ${nextBackend.prefix}/*`);
    console.log(
      `   🚀 下一步: 运行 \`myship dev\` 本地全栈联调，或直接运行 \`myship\` 一键发布前后端！`
    );
    return { enabled: true, project: ctx.project, backend: nextBackend };
  }

  // status / doctor
  console.log(`=== 🔌 MyShip 全栈业务后端状态 [${ctx.project}] ===`);
  console.log(
    `  开关状态: ${
      ctx.backend?.enabled ? '✅ 已开启 (provider: scf)' : '⚪ 未开启 (纯静态 / 边缘轻量模式)'
    }`
  );
  console.log(`  函数名称: ${functionName}`);
  console.log(`  目标地域: ${targetRegion}`);
  if (ctx.backend?.entry) {
    console.log(`  后端入口: ${ctx.backend.entry}`);
  }
  if (!isLocal) {
    const check = await preflightScfCheck({ region: targetRegion });
    if (check.ok) {
      console.log(
        `  云端预检: ✅ 正常 (函数配额 ${check.functionsCount}/${check.functionsLimit}, 并发配额 ${check.concurrentLimit})`
      );
    } else {
      console.log(`  云端预检: ⚠️ 未就绪 (${check.errorMessage})`);
      for (const g of check.guidance) {
        console.log(`    ${g}`);
      }
    }
  }
  return {
    enabled: Boolean(ctx.backend?.enabled),
    project: ctx.project,
    backend: ctx.backend,
  };
}

/**
 * 查询并格式化输出项目的后端运行与错误日志 (`myship logs`)
 */
export async function fetchAndPrintScfLogs({
  project = null,
  cwd = process.cwd(),
  region = null,
  functionName: explicitFunctionName = null,
  limit = 20,
  errorsOnly = false,
  isLocal = false,
  silent = false,
} = {}) {
  const ctx = detectProjectContext(cwd, project);
  const cleanProj = project ? normalizeDomainToken(project) : ctx.project;
  const targetRegion = region || ctx.backend?.region || inferCosRegion();
  const functionName =
    explicitFunctionName || ctx.backend?.functionName || resolveScfFunctionName(cleanProj);

  const logs = [];
  const seenKeys = new Set();

  function addLogItem(item) {
    if (!item) return;
    const key = `${item.requestId || ''}:${item.timestamp || ''}:${item.path || ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    logs.push(item);
  }

  if (isLocal) {
    const localStore = createLocalPersistentStorage(cwd, cleanProj);
    const localItems = (await localStore.get('__myship_logs', [])) || [];
    for (const item of Array.isArray(localItems) ? localItems : []) {
      addLogItem(item);
    }
  } else {
    // 1. 从 COS 私有持久化日志归档读取 (data/<project>/__myship_logs.json, ACL: private)
    try {
      const cosLogDoc = await cosGetJson(`data/${cleanProj}/__myship_logs.json`);
      const list =
        cosLogDoc && Array.isArray(cosLogDoc.value)
          ? cosLogDoc.value
          : Array.isArray(cosLogDoc)
          ? cosLogDoc
          : [];
      for (const item of list) {
        addLogItem(item);
      }
    } catch {
      // ignore
    }

    // 2. 兼容拉取 SCF 原生 GetFunctionLogs (通过腾讯云 AK/SK 认证接口读取)
    try {
      const scfLogResp = await scfRequest(
        'GetFunctionLogs',
        {
          FunctionName: functionName,
          Limit: Math.min(limit, 50),
        },
        targetRegion
      );
      for (const raw of scfLogResp.Data || []) {
        addLogItem({
          timestamp: raw.StartTime || new Date().toISOString(),
          requestId: raw.RequestId || '',
          project: cleanProj,
          scfVersion: raw.FunctionVersion || '$LATEST',
          method: 'SCF',
          path: raw.FunctionName || functionName,
          status: raw.RetCode === 0 ? 200 : 500,
          durationMs: raw.Duration || 0,
          level: raw.RetCode === 0 ? 'INFO' : 'ERROR',
          error: raw.RetCode !== 0 ? raw.RetMsg : undefined,
          lines: raw.Log ? [{ level: raw.RetCode === 0 ? 'INFO' : 'ERROR', text: raw.Log }] : [],
        });
      }
    } catch {
      // ignore if CLS not configured
    }
  }

  logs.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  const filtered = errorsOnly
    ? logs.filter((l) => l.level === 'ERROR' || (l.status && l.status >= 400) || l.error)
    : logs;
  const displayList = filtered.slice(0, limit);

  if (silent) {
    return displayList;
  }

  console.log(
    `=== 📋 MyShip 后端运行日志 [项目: ${cleanProj} | 函数: ${functionName}] (显示 ${displayList.length}/${filtered.length} 条) ===`
  );
  if (displayList.length === 0) {
    console.log('  (暂无匹配的后端请求或错误日志记录)');
    return [];
  }

  for (const item of displayList) {
    const badge =
      item.level === 'ERROR' || (item.status && item.status >= 500)
        ? '❌ [ERROR]'
        : item.level === 'WARN' || (item.status && item.status >= 400)
        ? '⚠️  [WARN] '
        : '✅ [INFO] ';
    const verStr = item.scfVersion ? `v${item.scfVersion}` : '$LATEST';
    const dplStr = item.deploymentId ? ` | ${item.deploymentId}` : '';
    console.log(
      `  ${badge} ${item.timestamp} | ${item.method || 'REQ'} ${item.path || '/'} -> ${
        item.status || 200
      } (${item.durationMs ?? 0}ms) [SCF:${verStr}${dplStr}] (ReqId: ${item.requestId || '-'})`
    );
    if (item.error) {
      console.log(`      💥 错误摘要: ${item.error}`);
    }
    if (item.stack) {
      const stackLines = String(item.stack)
        .split('\n')
        .slice(0, 6)
        .map((l) => `         ${l}`)
        .join('\n');
      console.log(stackLines);
    }
    if (Array.isArray(item.lines) && item.lines.length > 0) {
      for (const l of item.lines) {
        console.log(`      📝 [${l.level || 'LOG'}] ${l.text}`);
      }
    }
  }
  return displayList;
}
