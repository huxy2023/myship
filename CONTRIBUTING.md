# 参与贡献指南 (Contributing to MyShip)

感谢你对 **MyShip** 的关注与贡献！我们的目标是构建一个**架构清晰、模块化内聚、可完全自托管在个人云设施（BYOC）上**的高 DX 全栈部署与资源编排引擎。

---

## 一、核心工程设计原则

在提交代码或新特性之前，请确保遵循以下四条核心工程约束：

1. **Modular Single Responsibility（职责单一与高内聚模块化）**
   - 严禁将不相关的子系统堆砌在单一巨型文件中，也严禁使用大段字符串拼接的方式在打包器内重复手写运行时代码。
   - **本地与云端运行时同源**：`packages/cli/db-client.mjs`（多引擎数据库客户端）与 `packages/cli/storage-client.mjs`（存储与模块派发器）同时服务于本地 `myship dev` 与云端 SCF 引导层（`packages/cli/scf-bootstrap-runtime.mjs`），由 `esbuild` 统一编译打包，彻底杜绝双份实现带来的行为漂移。
2. **Minimal & Explicit Dependencies（克制且明确的依赖边界）**
   - 云厂商 API 签名（腾讯云 COS XML v5、EdgeOne TEO、SCF、TCB、Turso、Neon、Cloudflare D1）统一使用 Node.js (`>=20.0.0`) 原生 `node:crypto`、`node:tls` 与 `fetch` 实现，不引入臃肿的云厂商 SDK。
   - 全栈打包与标准数据库驱动仅保留经过严格验证的工业级核心包（`esbuild`、`pg`、`mysql2`）。
3. **100% BYOC & Privacy Safe（完全脱敏、自带云底座）**
   - 严禁在源码、注释或文档中硬编码任何真实的个人域名、腾讯云 `AppId`、`ZoneId`、`SecretId`、API Token 或数据库连接串。
   - 所有文档示例统一使用 `example.com`、`*.ship.example.com`、`https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`。
4. **Single Source of Truth for Docs（文档单一数据源）**
   - 所有文档统一维护在 `docs/*.md` 中。
   - 门户与 Clarify 风格文档站（`apps/site/build-site.mjs`）直接读取 `docs/*.md` 编译生成静态 HTML 与 `/llms.txt`，请勿手动修改构建产物目录 `apps/site/dist/`。

---

## 二、本地开发环境快速启动（无需任何云账号）

即使你没有配置腾讯云或数据库账号，也可以在本地 100% 离线验证全部核心逻辑：

```bash
# 1. 运行全套领域测试套件 (CAS 核心 / 云资源编排 / 多引擎数据库运行时与安全隔离)
pnpm test

# 2. 运行 CAS 内容寻址去重、泛域名网关路由与 0 秒回滚全链路自测
pnpm demo

# 3. 启动本地 4100 端口泛域名模拟边缘网关 (支持访问 http://*.ship.localhost:4100)
pnpm gateway:local

# 4. 编译生成产品门户与 Clarify 风格文档站 (输出至 apps/site/dist)
pnpm build:site
```

---

## 三、模块职责速览 (`packages/cli`)

| 模块文件 | 核心职责说明 |
| :--- | :--- |
| `myship.mjs` | CLI 命令解析、CAS 部署主流程、`myship dev`、`myship env`、`myship gc`、`myship rm` |
| `cos-client.mjs` | 腾讯云 COS XML v5 签名、EdgeOne TEO、SCF 与 TCB (CloudBase) TC3-HMAC-SHA256 客户端 |
| `scf-bundler.mjs` | 全栈 `esbuild` 编译打包、SCF Web 函数不可变版本发布与 `myship logs` 日志还原 |
| `scf-bootstrap-runtime.mjs` | 云端 SCF 9000 端口 HTTP 容器引导入口（直接 import `db-client.mjs` 与 `storage-client.mjs`） |
| `db-client.mjs` | 跨引擎统一数据库运行时（`node:sqlite` / Turso / D1 / PG / Neon / MySQL 连接池与事务隔离） |
| `storage-client.mjs` | `context.storage` (KV)、`context.files` (COS 二进制与预签名 URL) 及全栈请求派发器 |
| `resource-manager.mjs` | `myship use` 声明式资源注册、交互式向导编排与项目 `.myship/project.json` 管理 |
| `db-provisioners.mjs` | 五大数据库底层 Wire 协议与 HTTP API 自动建库 / 分 Schema 物理开通引擎 |
| `tui-prompts.mjs` | 终端 Raw-Mode 方向键选择器 (`promptSelect`) 与交互式输入组件 (`promptText`) |
| `console-server.mjs` | `myship console` 本机可视化 Web 管控台服务端与单页应用 |

---

## 四、提交 Pull Request 前的自检清单

- [ ] `pnpm test` 全部测试套件（含 `npm pack --dry-run` 发布文件白名单校验）100% 通过
- [ ] `pnpm demo` 本地离线全链路断言测试通过
- [ ] `pnpm build:site` 文档站构建成功无报错
- [ ] 代码与文档中不包含任何个人私有域名、密钥或真实云资源 ID
