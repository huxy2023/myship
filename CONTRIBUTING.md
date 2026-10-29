# 参与贡献指南 (Contributing to MyShip)

感谢你对 **MyShip** 的关注与贡献！我们的目标是构建一个**零外部运行时依赖、极简直觉、可完全自托管在个人云设施（BYOC）上**的高 DX 部署引擎。

---

## 一、核心工程设计原则

在提交代码或新特性之前，请确保遵循以下三条核心约束：

1. **Zero Runtime Dependencies（零外部 npm 运行时依赖）**
   - `packages/cli` 与 `packages/edge-gateway` 必须仅依赖 Node.js (`>=20.0.0`) 原生内置模块（如 `node:crypto`、`node:fs`、`node:http` 与全局 `fetch`）。
   - 这保证了任何开发者在任何机器上执行 `npm i -g github:huxy2023/myship` 时都能在 1 秒内完成安装，不受复杂依赖树污染。
2. **100% BYOC & Privacy Safe（完全脱敏、自带云底座）**
   - 严禁在源码、注释或文档中硬编码任何真实的个人域名、腾讯云 `AppId`、`ZoneId`、`SecretId` 或存储桶地址。
   - 所有文档示例统一使用 `example.com`、`*.ship.example.com`、`https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`。
3. **Single Source of Truth for Docs（文档单一数据源）**
   - 所有文档统一维护在 `docs/*.md` 中。
   - 门户与 Clarify 风格文档站（`apps/site/build-site.mjs`）直接读取 `docs/*.md` 编译生成静态 HTML 与 `/llms.txt`，请勿手动修改构建产物目录 `apps/site/dist/`。

---

## 二、本地开发环境快速启动（无需任何云账号）

即使你没有配置腾讯云 COS 或 EdgeOne 账号，也可以在本地 100% 离线验证全部核心逻辑：

```bash
# 1. 运行 CAS 内容寻址去重、泛域名网关路由与 0 秒回滚全链路自测
pnpm demo

# 2. 启动本地 4100 端口泛域名模拟边缘网关 (支持访问 http://*.ship.localhost:4100)
pnpm gateway:local

# 3. 编译生成产品门户与 Clarify 风格文档站 (输出至 apps/site/dist)
pnpm build:site
```

---

## 三、目录职责速览

- `packages/cli`：MyShip 命令行工具，负责计算 SHA-256、增量上传 `blobs/`、生成 `manifests/`、切换 `aliases/`、管理 `.myship/project.json` 命名空间，以及通过 `myship build-edge-fn` 生成边缘函数代码。
- `packages/edge-gateway`：包含运行在腾讯云 EdgeOne 标准站点上的边缘函数模板（`edgeone-function.template.js`）和本地模拟网关（`local-gateway.mjs`）。
- `apps/site`：零依赖门户与文档站静态生成器。
- `docs/`：项目全部开源文档（快速上手、自建云底座 SOP、架构原理、演进蓝图）。
- `examples/cas-sandbox`：本地离线自测脚本与云端多版本演示脚本。

---

## 四、提交 Pull Request 前的自检清单

- [ ] `pnpm demo` 本地离线全链路断言测试通过
- [ ] `pnpm build:site` 文档站构建成功无报错
- [ ] 代码与文档中不包含任何个人私有域名、密钥或真实云资源 ID
