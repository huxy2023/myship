/**
 * teo-client.mjs — 腾讯云 EdgeOne (TEO) 管控面 API v3 (TC3-HMAC-SHA256) 客户端与边缘网关部署引擎
 *
 * 职责：
 * - EdgeOne OpenAPI v3 签名与调用 (`teoRequest`)
 * - 全局泛域名静态 CAS 路由网关探测与一键部署 (`probeEdgeGateway`, `deployEdgeFunctionToTeo`)
 * - 项目级专属 API 边缘网关创建、规则同步与优先级编排 (`deployProjectApiFunctionToTeo`)
 */
import { createHash, createHmac } from 'node:crypto';
import { loadTencentCredentials, saveMyShipFileConfig } from './cos-client.mjs';

function sha256HexStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSha256Buf(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest();
}

function hmacSha256Hex(key, msg) {
  return createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

export async function probeEdgeGateway(remoteDomain) {
  if (!remoteDomain) return { online: false };
  const cleanDomain = remoteDomain.replace(/^\*\./, '');
  const probeUrl = `https://_myship_probe.${cleanDomain}/`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(probeUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/html' },
    });
    clearTimeout(timer);
    const engine = res.headers.get('x-myship-engine') || '';
    const hasHeader = Boolean(res.headers.get('x-myship-subdomain') || engine);
    const text = await res.text();
    const isMyShipBody =
      text.includes('DEPLOYMENT_ALIAS_NOT_FOUND') ||
      text.includes('MyShip') ||
      text.includes('aliases/_myship_probe.json');
    return {
      online: hasHeader || isMyShipBody,
      status: res.status,
      engine,
      probeUrl,
    };
  } catch {
    return { online: false, probeUrl };
  }
}

export async function teoRequest(action, payload = {}) {
  const { secretId, secretKey, token } = loadTencentCredentials();
  const service = 'teo';
  const host = 'teo.tencentcloudapi.com';
  const version = '2022-09-01';
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
      `EdgeOne API [${action}] 失败 (${data.Response.Error.Code}): ${data.Response.Error.Message}`
    );
    err.code = data.Response.Error.Code;
    throw err;
  }
  return data.Response;
}

export async function deployEdgeFunctionToTeo({ code, remoteDomain }) {
  const cleanDomain = (remoteDomain || '').replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomainGuess = parts.length >= 2 ? parts.slice(-2).join('.') : cleanDomain;

  // 1. 自动查找站点 ZoneId
  const zonesResp = await teoRequest('DescribeZones', {});
  const zones = zonesResp.Zones || [];
  if (zones.length === 0) {
    throw new Error('当前腾讯云账号下未找到任何 EdgeOne 站点 (Zone)，请先在控制台添加站点。');
  }

  let matchedZone =
    zones.find((z) => z.ZoneName === rootDomainGuess || cleanDomain.endsWith(z.ZoneName)) ||
    zones[0];
  const zoneId = matchedZone.ZoneId;
  const zoneName = matchedZone.ZoneName;

  // 2. 查询该站点下是否已有 myship-cas-router 边缘函数 (严格按前缀匹配，避免误改项目级 myship-api-* 函数)
  const fnResp = await teoRequest('DescribeFunctions', { ZoneId: zoneId });
  const functions = fnResp.Functions || [];
  let targetFn =
    functions.find(
      (f) => f.Name === 'myship-cas-router' || (f.Name && f.Name.startsWith('myship-cas-router-'))
    ) || null;
  let functionId = null;
  let actionTaken = '';

  if (targetFn) {
    functionId = targetFn.FunctionId;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: 'MyShip Pure Static CAS Router (Managed by @myship/cli)',
    });
    actionTaken = 'updated';
  } else {
    const createResp = await teoRequest('CreateFunction', {
      ZoneId: zoneId,
      Name: 'myship-cas-router',
      Content: code,
      Remark: 'MyShip Pure Static CAS Router (Managed by @myship/cli)',
    });
    functionId = createResp.FunctionId;
    actionTaken = 'created';

    // 尝试自动创建触发规则
    try {
      await teoRequest('CreateFunctionRule', {
        ZoneId: zoneId,
        FunctionId: functionId,
        Remark: `MyShip wildcard route for *.${cleanDomain}`.slice(0, 58),
        FunctionRuleConditions: [
          {
            RuleConditions: [
              {
                Operator: 'notequal',
                Target: 'host',
                Values: [zoneName],
              },
            ],
          },
        ],
      });
    } catch {
      // 若规则已存在或使用规则引擎绑定则忽略
    }
  }

  saveMyShipFileConfig({ zoneId, functionId });
  return { zoneId, zoneName, functionId, actionTaken };
}

/**
 * 方案 A：为包含 `api/*.js` 的项目创建/更新独立的 EdgeOne 边缘函数 (`myship-api-<project>`)
 * 并自动配置高优先级 `/api/*` 触发规则，实现与全局静态路由器 `myship-cas-router` 的 100% 职责分离。
 */
export async function deployProjectApiFunctionToTeo({
  project = 'default',
  code,
  hosts = [],
  routes = [],
  remoteDomain,
  replaceRoutes = false,
}) {
  const cleanDomain = (remoteDomain || '').replace(/^\*\./, '');
  const parts = cleanDomain.split('.');
  const rootDomainGuess = parts.length >= 2 ? parts.slice(-2).join('.') : cleanDomain;

  const cleanProj =
    String(project || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'default';
  // EdgeOne 函数名限制 2~30 字符
  const desiredFnName = `myship-api-${cleanProj}`.slice(0, 28).replace(/-$/, '');

  // 1. 查找站点 ZoneId
  const zonesResp = await teoRequest('DescribeZones', {});
  const zones = zonesResp.Zones || [];
  if (zones.length === 0) {
    throw new Error('当前腾讯云账号下未找到任何 EdgeOne 站点 (Zone)。');
  }
  const matchedZone =
    zones.find((z) => z.ZoneName === rootDomainGuess || cleanDomain.endsWith(z.ZoneName)) ||
    zones[0];
  const zoneId = matchedZone.ZoneId;
  const zoneName = matchedZone.ZoneName;

  // 2. 查询统一 API 边缘函数与现有触发规则 (在修改云端函数或规则前先校验路由配额上限，杜绝静默截断)
  const [fnResp, rulesResp] = await Promise.all([
    teoRequest('DescribeFunctions', { ZoneId: zoneId }),
    teoRequest('DescribeFunctionRules', { ZoneId: zoneId }),
  ]);
  const functions = fnResp.Functions || [];
  const allRules = rulesResp.FunctionRules || [];

  const targetFn =
    functions.find(
      (f) =>
        f.Name === desiredFnName ||
        (f.Name && f.Name.startsWith(`${desiredFnName}-`)) ||
        f.Name === 'myship-api-router' ||
        (f.Name && f.Name.startsWith('myship-api-'))
    ) || null;

  const existingRule = targetFn
    ? allRules.find((r) => r.FunctionId === targetFn.FunctionId)
    : null;

  const existingProjectRoutes = [];
  let hasHostNotEqualZone = false;
  if (existingRule && Array.isArray(existingRule.FunctionRuleConditions)) {
    for (const group of existingRule.FunctionRuleConditions) {
      for (const cond of group.RuleConditions || []) {
        if (
          cond.Target === 'host' &&
          cond.Operator === 'notequal' &&
          Array.isArray(cond.Values) &&
          cond.Values.includes(zoneName)
        ) {
          hasHostNotEqualZone = true;
        }
        if (cond.Target === 'url' && cond.Operator === 'equal' && Array.isArray(cond.Values)) {
          for (const u of cond.Values) {
            if (u && !u.includes('*')) existingProjectRoutes.push(u);
          }
        }
      }
    }
  }

  const fnRemark = `MyShip Dedicated API Worker (Scheme A+C, Multi-Project CAS)`.slice(0, 58);

  // 当 replaceRoutes=true 且活跃 API 路由归零时（如 myship gc 清理了全部 API 版本），撤销 API 触发规则并清空函数池
  if (replaceRoutes && routes.length === 0) {
    if (!targetFn) {
      return {
        zoneId,
        zoneName,
        functionId: null,
        functionName: desiredFnName,
        ruleId: null,
        routes: [],
        actionTaken: 'noop',
      };
    }
    const functionId = targetFn.FunctionId;
    const functionName = targetFn.Name || desiredFnName;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: fnRemark,
    });
    if (existingRule && existingRule.RuleId) {
      await teoRequest('DeleteFunctionRules', {
        ZoneId: zoneId,
        RuleIds: [existingRule.RuleId],
      });
    }
    return {
      zoneId,
      zoneName,
      functionId,
      functionName,
      ruleId: null,
      routes: [],
      actionTaken: 'cleared',
    };
  }

  const MAX_API_RULE_VALUES = 30;
  const routeInputs = replaceRoutes
    ? routes.length > 0
      ? routes
      : ['/api']
    : [...(routes.length > 0 ? routes : ['/api']), ...existingProjectRoutes];
  const normalizedRoutes = Array.from(
    new Set(
      routeInputs.flatMap((r) => {
        const clean = r.startsWith('/') ? r : `/${r}`;
        return clean.length > 1 && !clean.endsWith('/') ? [clean, `${clean}/`] : [clean];
      })
    )
  );

  if (normalizedRoutes.length > MAX_API_RULE_VALUES) {
    throw new Error(
      `API 路由数量超出单条 EdgeOne 触发规则上限: 当前累计需匹配 ${normalizedRoutes.length} 项 URL 条件 (上限 ${MAX_API_RULE_VALUES} 项，约 ${Math.floor(
        MAX_API_RULE_VALUES / 2
      )} 个不同 API 路径)。已终止发布，未修改云端函数与域名。`
    );
  }

  let functionId = null;
  let functionName = desiredFnName;
  let actionTaken = '';

  if (targetFn) {
    functionId = targetFn.FunctionId;
    functionName = targetFn.Name || desiredFnName;
    await teoRequest('ModifyFunction', {
      ZoneId: zoneId,
      FunctionId: functionId,
      Content: code,
      Remark: fnRemark,
    });
    actionTaken = 'updated';
  } else {
    const createResp = await teoRequest('CreateFunction', {
      ZoneId: zoneId,
      Name: desiredFnName,
      Content: code,
      Remark: fnRemark,
    });
    functionId = createResp.FunctionId;
    actionTaken = 'created';
  }

  // 3. 自动创建或按需增量更新 /api/* 边缘函数触发规则
  const existingRouteSet = new Set(existingProjectRoutes);
  const allRoutesAlreadyCovered =
    existingRule &&
    hasHostNotEqualZone &&
    normalizedRoutes.every((r) => existingRouteSet.has(r)) &&
    (!replaceRoutes || existingRouteSet.size === normalizedRoutes.length);

  const ruleConditionsPayload = [
    {
      RuleConditions: [
        {
          Operator: 'notequal',
          Target: 'host',
          Values: [zoneName],
        },
        {
          Operator: 'equal',
          Target: 'url',
          Values: normalizedRoutes,
        },
      ],
    },
  ];
  const ruleRemark = `MyShip API routes for *.${cleanDomain}`.slice(0, 58);

  let ruleId = null;
  if (existingRule) {
    ruleId = existingRule.RuleId;
    if (!allRoutesAlreadyCovered) {
      await teoRequest('ModifyFunctionRule', {
        ZoneId: zoneId,
        RuleId: ruleId,
        FunctionId: functionId,
        TriggerType: 'direct',
        Remark: ruleRemark,
        FunctionRuleConditions: ruleConditionsPayload,
      });
    }
  } else {
    const createRuleResp = await teoRequest('CreateFunctionRule', {
      ZoneId: zoneId,
      FunctionId: functionId,
      TriggerType: 'direct',
      Remark: ruleRemark,
      FunctionRuleConditions: ruleConditionsPayload,
    });
    ruleId = createRuleResp.RuleId;
  }

  // 确保 API 规则排在全局静态 CAS 规则之前 (EdgeOne RuleIds 数组从上到下依次执行，索引 0 优先级最高)
  const latestRules =
    existingRule && allRoutesAlreadyCovered
      ? allRules
      : (await teoRequest('DescribeFunctionRules', { ZoneId: zoneId })).FunctionRules || [];
  if (latestRules.length >= 2) {
    const casFn = functions.find(
      (f) => f.Name === 'myship-cas-router' || (f.Name && f.Name.startsWith('myship-cas-router-'))
    );
    const casFnId = casFn ? casFn.FunctionId : null;
    const apiRuleIds = latestRules.filter((r) => r.FunctionId !== casFnId).map((r) => r.RuleId);
    const casRuleIds = latestRules.filter((r) => r.FunctionId === casFnId).map((r) => r.RuleId);
    const desiredOrder = [...apiRuleIds, ...casRuleIds];
    const currentOrder = latestRules.map((r) => r.RuleId);
    if (JSON.stringify(desiredOrder) !== JSON.stringify(currentOrder)) {
      await teoRequest('ModifyFunctionRulePriority', {
        ZoneId: zoneId,
        RuleIds: desiredOrder,
      });
    }
  }

  return {
    zoneId,
    zoneName,
    functionId,
    functionName,
    ruleId,
    routes: normalizedRoutes,
    actionTaken,
  };
}
