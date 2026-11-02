# ⚡ MyShip

**Build your own personal `surge.sh` + `Vercel` on Tencent Cloud EdgeOne & COS in 10 minutes.**  
**基于自有云设施（BYOC）的零依赖、高 DX 内容寻址（CAS）静态部署与泛域名路由引擎。**

[![NPM Version](https://img.shields.io/npm/v/@myship/cli.svg?color=cb3837)](https://www.npmjs.com/package/@myship/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-339933.svg)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen.svg)](./packages/cli/package.json)
[![Live Docs](https://img.shields.io/badge/Website%20%26%20Docs-myship.ship.onehub.top-0284c7.svg)](https://myship.ship.onehub.top)

- 🌐 **官方在线门户与文档站 (由 MyShip 自举托管)**：[https://myship.ship.onehub.top](https://myship.ship.onehub.top)
- 🤖 **AI / LLM 知识库索引 (`llms.txt`)**：[https://myship.ship.onehub.top/llms.txt](https://myship.ship.onehub.top/llms.txt) | [全量 Markdown (`llms-full.txt`)](https://myship.ship.onehub.top/llms-full.txt)

---

## 🎯 为什么要做 MyShip？(Why MyShip?)

国内主流静态托管平台（如标准 Pages 服务）通常将构建与托管强绑定，且存在两个明显痛点：
1. **历史版本数量受限**（例如仅保留最近 10 次部署，早期构建链接自动失效）。
2. **子域名绑定死板**（通常只提供 `Production` 和 `Preview` 两个固定环境域名，无法像 `surge.sh` 或 `Vercel` 那样随手为任意一次本地构建指定 `https://app1-v2.ship.example.com` 或 `https://app1-pr-42.ship.example.com`）。

**MyShip** 采用 **BYOC（Bring Your Own Cloud，自带云设施）** 模式，只需利用你自己的 **1 个域名 + 腾讯云 EdgeOne 标准站点（免费版含泛域名与边缘函数）+ 腾讯云 COS 对象存储**，即可获得：

| 特性维度 | 传统目录覆盖式托管 / 标准 Pages | ⚡ MyShip (EdgeOne + COS CAS 引擎) |
| :--- | :--- | :--- |
| **历史版本保留** | 仅保留最近 N 个版本（如 10 个），旧版自动清理 | **无限历史版本永久保留**（每个版本仅占 ~1KB JSON 清单） |
| **上传速度与存储成本** | 每次全量复制目录，重复上传未改动的公共依赖 | **全局 SHA-256 内容寻址去重 (`blobs/<sha256>`)**，未改动文件 0 字节秒跳 |
| **自定义子域名自由度** | 仅限固定的生产/预览环境域名 | **任意单次构建可绑定任意数量子域名**（`*.ship.example.com` 自动享免费泛域名 HTTPS） |
| **多项目命名空间隔离** | 多个前端项目混杂或需频繁建新站点 | **内置 `.myship/project.json` 命名空间**（自动隔离 `app1-*` 与 `app2-*`，`myship ls` 默认按当前项目过滤） |
| **线上切流与回滚耗时** | 需重新触发流水线或复制目录（数十秒至数分钟） | **0 毫秒原子切流/回滚**（仅改写 80 字节 `aliases/<subdomain>.json` 指针） |
| **全栈 Serverless 函数 (`api/*.js`)** | 需单独配置网关或前后端分离部署，回滚易出现接口版本错位 | **约定式 `api/*.js` 自动路由 + CAS 寻址**，前后端共享同一 `dpl_<id>` 快照，0 秒同帧回滚 |
| **客户端安装负担** | 需安装重型 SDK 或特定框架插件 | **0 外部 npm 依赖**，纯原生 Node.js 实现，任意电脑 1 秒全局安装 |

---

## 🚀 30 秒免云账号体验（Local Sandbox）

即使你还没有配置腾讯云账号或域名，克隆仓库后只需一行命令即可在本地完整体验 **V1/V2 增量构建、CAS 块级去重、泛域名并发路由与 0 秒原子回滚**：

```bash
git clone https://github.com/huxy2023/myship.git
cd myship

# 1. 运行本地离线 CAS 全链路自测
pnpm demo

# 2. 编译生成 MyShip 产品门户与 Clarify 风格文档站 (输出至 apps/site/dist)
pnpm build:site
```

---

## ☁️ 10 分钟接入你自己的云端底座 (BYOC Quickstart)

### 第 1 步：全局安装 `myship` CLI

直接从 NPM 官方源（或国内淘宝镜像）一键安装：

```bash
npm i -g @myship/cli
# 安装后终端命令即为 6 个字母的 myship：
myship --version
```

### 第 2 步：绑定你的腾讯云凭证与云底座配置

```bash
myship login
```
向导提供两种安全的认证方式任选其一：
- **方式一（CAM 子账号最小权限密钥，跨电脑零依赖）**：前往 [腾讯云 CAM 用户控制台](https://console.cloud.tencent.com/cam/user) 新建编程访问子账号，**日常发包/切流/回滚仅需授予 1 项最小权限：`QcloudCOSDataFullControl`（对象存储 COS 数据读写权限）**。
- **方式二（`tccli` 浏览器扫码免静态密钥）**：选择 `[2]` 直接唤起 `tccli auth login` 扫码授权（或自动检测并一键复用本机已有的 `~/.tccli/default.credential`，支持 OAuth 自动续期）。
- 随后填入你的 **COS 存储桶地址**（如 `https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`）与 **泛域名后缀**（如 `ship.example.com`）。
- **全局边缘函数智能检测与一键回车上传**：
  - `myship login` 会自动探测你的云端泛域名网关是否已在线：若你是在**第二台电脑登录**（云端网关已在线），会自动跳过边缘函数部署，且**绝不在你的业务项目目录内生成任何边缘函数文件**（全局备份统一保存在 `~/.myship/edgeone-function.dist.js`）。
  - 若你是**首次搭建云底座**，只需在终端按一下回车（`[Y/n]`），`myship` 会自动调用腾讯云 EdgeOne API 匹配站点并将全局边缘函数 `myship-cas-router` 上传生效！

### 第 3 步：（可选）随时一键更新云端全局边缘函数

```bash
myship setup-edge
```
全账号所有前端项目共享 **1 个**云端边缘函数。若日后修改了存储桶地址，运行 `myship setup-edge` 敲回车即可一键同步至 EdgeOne。  
*(详细的 DNSPod 泛解析、EdgeOne 免费泛域名 HTTPS 证书申请与避坑指南，请阅读 👉 **[《从 0 到 1 自建云端底座保姆级指南》](./docs/02-self-hosting-guide.md)**)*。

### 第 4 步：在任意前端项目中享受 6 个字母的极简发布

```bash
cd /path/to/your-vue-or-react-app

# 本地即时调试静态目录、api/*.js 云函数与 .env 环境变量（免执行 --local CAS 快照打包）
myship dev

npm run build

# 直接输入 6 个字母！自动初始化 .myship/project.json 并发布至：
#   - 构建快照域名: https://app1-<hash>.ship.example.com
#   - 项目默认主域: https://app1.ship.example.com
myship

# 发布到当前项目的指定子环境（自动拼接项目前缀 -> https://app1-v2.ship.example.com）
myship -d v2

# 查看当前项目命名空间下的历史版本与线上域名（加 --all 查看全量项目分组）
myship ls

# 0 秒将当前项目主域名一键回退到上一个历史版本（前端页面与 /api/* 云函数同帧原子回退！）
myship rollback

# 清理过期历史快照 (支持按保留版本数 --keep 或按时间窗口 --older-than 30d)、回收孤儿静态块并释放路由配额
myship gc --dry-run
myship gc --older-than 7d

# 手动删除指定构建快照、解绑子域名或彻底销毁废弃项目 (自动通过引用计数回收独占块，绝不误伤共享资源)
myship rm dpl_xxxx
myship rm --alias pr-1
myship rm --project old-demo

# 一键生成 GitHub Actions 自动部署与 PR 预览机器人工作流 (.github/workflows/myship.yml) 并同步仓库 Secrets
myship init --ci --sync-secrets

# 启动轻量单页 Web 可视化管控台 (本机 127.0.0.1:4200 直连云端，鼠标一键切流/回滚/双版本 Diff/环境变量/GC)
myship console
```

### 第 5 步：（Phase 2 全栈能力）零配置编写 `api/*.js` 边缘 Serverless 云函数

在你的项目目录下新建 `api/hello.js`，下次执行 `myship` 时会自动将其私有归档至 `functions/<sha256>.json`、打包进当前构建版本的 `dpl_<id>` 快照，并同步至腾讯云 EdgeOne 上的**独立统一 API 边缘函数**（与全局纯静态路由 `myship-cas-router` 100% 物理隔离；内部通过 `host -> subdomain -> manifest -> functions[route].sha256` 精确寻址，多项目同名路由互不串线；同时支持 Web 标准 `GET(request, context)` 与 EdgeOne 官方 `onRequestGet(context)` 签名）：

```javascript
// api/hello.js -> 自动映射为 https://app1.ship.example.com/api/hello
export async function GET(request, context) {
  return {
    ok: true,
    message: `Hello from ${context.subdomain} (${context.deploymentId})!`,
    hasApiKey: Boolean(context.env.API_KEY), // 或直接读取 process.env.API_KEY
    clientIp: context.clientIp, // 自动透传 EdgeOne 客户端真实 IP
    geo: context.geo,           // 自动透传 EdgeOne 国家/省份/城市/运营商地理信息
  };
}
```

通过 `myship env` 管理项目专属环境变量（云端私有存储于 `envs/<project>.json`，修改后自动热更新边缘 API 函数，无需重传静态文件）：

```bash
myship env set API_KEY=sk-123456 DB_URL=postgres://...
myship env ls              # 默认脱敏展示 (加 --reveal 查看明文)
myship env import .env     # 批量导入标准 .env 文件
myship env rm DB_URL       # 移除指定变量并热更新
```

### 第 6 步：（按需开启）腾讯云 SCF 全栈 Node.js 业务后端与持久化存储

当你的应用需要完整的 Node.js 24/20 运行时、第三方 npm 依赖（或 **Hono** 等 Web 标准路由框架）、SSE 流式输出及独立持久化数据访问时，可通过渐进式能力开关一键开启 SCF Web 函数后端：

```bash
# 1. 开启当前项目的 SCF 全栈后端开关（自动执行权限预检与生成 server/index.mjs 入口骨架）
myship backend enable

# 2. 本地前后端同源联调（支持修改公共模块秒级热重载，本地数据持久化在 .myship/data/<project>/）
myship dev

# 3. 一键全栈发布（先构建并校验 SCF 不可变新版本与专属触发器，通过健康检查后再切换线上入口）
myship

# 4. 实时查询云端后端运行日志与 SourceMap 还原后的精确源码报错行号
myship logs
myship logs --error
```

**全栈后端契约与工程约定**：
- **标准入口与框架**：默认入口为 `server/index.{mjs,js,ts}`，统一遵循现代 ESM + Web Standard `fetch(request, context)` 契约（原生支持 `export async function fetch` 或 **Hono** 的 `export default app`）。
- **打包与静态资源约定**：底层使用 `esbuild` 标准打包并开启 `sourcemap: 'inline'` + `node --enable-source-maps`，自动还原真实源码堆栈行号；后端静态模板文件请统一放置在 `server/` 目录（如 `server/templates/prompt.txt`），通过相对于 `server/index.mjs` 的 `new URL('./templates/prompt.txt', import.meta.url)` 读取（被打包合并的外部共享子模块如 `lib/*.mjs` 内部请勿假设保留独立的 `import.meta.url` 目录基准）。
- **独立持久化存储 (`context.storage`)**：内置 `await context.storage.get(key)` / `set(key, val)`（云端私有存储于 COS `data/<project>/<key>.json`，`ACL: private`），应用代码执行 `myship rollback` 回滚时仅切换代码版本，**绝不清空或回滚业务持久化数据**。需要使用长期 AK/SK 凭证、显式配置 `MYSHIP_DATA_SECRET_ID` / `MYSHIP_DATA_SECRET_KEY` 或配置 `backend.role` 运行角色（拒绝将短期过期的临时会话 Token 固化进云函数）。
- **不可变版本隔离与保留规则**：每个部署版本绑定独立的 SCF 不可变版本（`Version 1`, `Version 2`），新旧预览域名各自访问对应版本后端；每个项目云端保留 **当前活跃别名（含回滚版本）+ 最近最多 5 个历史预览版本（总计上限 8 个版本）**，超出窗口的旧预览版本自动联动回收其 SCF 触发器、版本与历史 `manifest`。

### 第 7 步：（v0.3+ 声明式云资源）`myship use` 交互式接入多引擎数据库与对象文件存储

无需记忆冗长参数，在任意项目根目录直接运行 `myship use` 即可通过交互式菜单（`↑`/`↓` 方向键或数字键选择）为当前项目一键开通并注入对象存储（`context.files`）或 Serverless 数据库（`context.db`）：

```bash
# 1. 启动交互式云资源引导向导（推荐：选择优于输入，自动扫描账号下已有 CloudBase PG / Turso / Neon 底座）
myship use

# 2. 也可使用非交互式命令一键绑定（首次配置全局凭证后，后续所有新项目零参数自动建库/分 Schema）：
myship use storage                         # 注册二进制文件存储 (files/<project>/ + 预签名直传 URL)
myship use db --provider pg                # 腾讯云 CloudBase PG / 原生 PG (自动创建 myship_<project> Schema)
myship use db --provider neon              # Neon Serverless PG (支持 API Key 自动建库 + 连接串多 Schema 隔离)
myship use db --provider turso             # Turso Edge SQLite (自动识别组织、初始化默认 Group 并签发项目 Token)
myship use db --provider d1                # Cloudflare D1 Serverless SQLite (自动查找或创建 D1 数据库)
myship use db --provider mysql             # 原生 MySQL 8 / TDSQL-C (自动创建 myship_<project> 独立库)
```

在后端代码（`server/index.mjs` 或 `api/*.js`）中直接通过 `context.db` 与 `context.files` 调用，或使用标准 `pg.Pool` / `mysql2/promise` / `drizzle-orm` 直连注入的 `process.env.DATABASE_URL`：

```javascript
// 1. 统一 SQL 客户端 (本地 myship dev 默认映射至 Node 22+ 原生 node:sqlite .myship/data/<project>/local.sqlite)
await context.db.execute('CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, title TEXT)');
await context.db.execute('INSERT INTO notes (title) VALUES ($1)', ['Hello MyShip v0.3']);
const rows = await context.db.query('SELECT * FROM notes');

// 2. 二进制文件存储与前端预签名直传 (COS files/<project>/ 隔离)
await context.files.put('uploads/readme.txt', 'Hello COS Files!', { contentType: 'text/plain' });
const uploadUrl = await context.files.presignUrl('uploads/avatar.png', { method: 'PUT', expiresIn: 900 });
```

---

## 📦 Monorepo 工程结构 (`pnpm workspace`)

```text
myship/
├── LICENSE                        # MIT 开源许可证
├── README.md                      # 项目主页
├── CONTRIBUTING.md                # 开源贡献与本地开发规范
├── pnpm-workspace.yaml            # pnpm 工作区定义
├── package.json                   # 根配置 (含全局 bin.myship 入口)
│
├── packages/
│   ├── cli/                       # @myship/cli — 零依赖 CLI 客户端
│   │   ├── myship.mjs             # CLI 主程序 (init / login / build-edge-fn / deploy / alias / rollback / ls)
│   │   └── cos-client.mjs         # 原生 node:crypto 腾讯云 COS XML v5 与 EdgeOne TEO API 客户端
│   │
│   └── edge-gateway/              # @myship/edge-gateway — 边缘路由网关
│       ├── edgeone-function.template.js   # 纯净版全局静态 CAS 路由模板 (myship-cas-router)
│       ├── edgeone-api-worker.template.js # 独立统一 API 边缘函数模板 (多项目 SHA-256 路由隔离, 方案 A+C)
│       └── local-gateway.mjs      # 本地 4100 端口泛域名模拟网关 (*.ship.localhost:4100)
│
├── apps/
│   └── site/                      # @myship/site — 产品门户与 Clarify 风格文档站构建器
│       └── build-site.mjs         # 读取 docs/*.md 一键生成门户、交互式 Mermaid 画布与 /llms.txt
│
├── docs/                          # 统一文档中心 (Single Source of Truth)
│   ├── 01-quickstart.md           # 📘 5 分钟快速上手与 CLI 命令全解
│   ├── 02-self-hosting-guide.md   # 🛠️ 从 0 到 1 自建云端底座保姆级指南 (含证书避坑 SOP)
│   ├── 03-architecture.md         # 🏗️ CAS 三级指针架构原理与成本拆解
│   └── 04-roadmap.md              # 🧭 产品愿景与演进路线图
│
└── examples/
    └── cas-sandbox/               # @myship/cas-sandbox — 离线沙盒自测与云端多版本演示脚本
```

---

## 📚 核心文档导航

1. **[《5 分钟快速上手与 CLI 命令全解》](./docs/01-quickstart.md)**
2. **[《从 0 到 1 自建云端底座保姆级指南 (BYOC Setup & Troubleshooting)》](./docs/02-self-hosting-guide.md)**
3. **[《CAS 三级指针架构原理与成本拆解》](./docs/03-architecture.md)**
4. **[《产品愿景与演进路线图》](./docs/04-roadmap.md)**

---

## 📄 开源许可 (License)

本项目基于 [MIT License](./LICENSE) 开源。
