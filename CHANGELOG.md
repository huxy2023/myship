# Changelog

All notable changes to **MyShip (`@myship/cli`)** are documented in this file.

---

## [v0.4.0] — 零摩擦工程脚手架 (`init --template`)、第二阶段模块化治理与 Skipper 品牌焕新

### ✨ 核心亮点 (Highlights)
- **🚀 零摩擦全栈工程脚手架 (`myship init --template` & `myship create`)**：支持在空目录或已有目录一键生成 `static`（纯静态极速站）、`edge`（边缘云函数 + `context.storage` 状态计数）或 `fullstack`（静态前端 + `server/index.mjs` SCF 后端 + `context.db` + `context.files` + `context.storage`）标准样板，默认非破坏性保留已有源码与 `.myship/project.json` 配置。
- **🧹 第二阶段模块化内聚治理 (`Modular Architecture Phase 2`)**：将腾讯云 EdgeOne (`teo-client.mjs`) 与 CloudBase (`tcb-client.mjs`) 管控面从 `cos-client.mjs` 正交剥离；将交互式终端引导向导与资源状态面板独立拆分为 `resource-wizards.mjs`。
- **🦭 小海豹 Skipper 品牌视觉体系精修**：统一全身暖奶油与暖杏仁小前鳍配色、贴合头顶的珊瑚橘小纸船帽、透明底呼吸浮动 SVG 动效，以及静谧海蓝圆角方砖应用图标（`logo.svg`、`favicon.svg`、`apple-touch-icon.png`、`og-banner.png`）。

### 🛠️ 关键命令速览
```bash
# 安装或升级至 v0.4.0
npm install -g @myship/cli@0.4.0

# 一键生成全栈 / 边缘 / 静态标准工程骨架
myship init --template fullstack
myship init --template edge
myship init --template static
myship create my-new-app
```

### 📦 发行产物与校验
- **NPM 官方包 (含 SLSA Provenance 签名)**：[`@myship/cli@0.4.0`](https://www.npmjs.com/package/@myship/cli/v/0.4.0)
- **在线门户与文档中心**：[https://myship.ship.onehub.top](https://myship.ship.onehub.top)
- **完整代码变更对比**：[`v0.3.3...v0.4.0`](https://github.com/huxy2023/myship/compare/v0.3.3...v0.4.0)

---

## [v0.3.3] — AI Vibecoding 专属技能包 (`myship-skill`) 与品牌视觉体系

### ✨ 核心亮点 (Highlights)
- **🤖 AI Vibecoding 专属技能包 (`myship-skill`)**：内置面向 Google Antigravity、Claude Code、Cursor 的渐进式全栈开发技能包（`SKILL.md` + `references/`），支持 `myship skill install -g` 一键分发至本机全局 Agent 目录，并在官网提供 `/skill/SKILL.md` 直链。
- **🔒 运行时契约对齐加固**：`context.files.presignUrl` 同时兼容 `expiresIn` 与 `expiresSec` 参数；本地与云端 `context.files.get()` 统一返回 `Buffer`；`myship dev --dir <目录>` 支持显式静态目录挂载。
- **🦭 品牌标语与吉祥物发布**：确立「自有云海，一令启航 (`Your Cloud. Your Fleet. One Command to Ship.`)」品牌定位与小海豹 Skipper 矢量形象。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.3.3`](https://www.npmjs.com/package/@myship/cli/v/0.3.3)
- **完整代码变更对比**：[`v0.3.2...v0.3.3`](https://github.com/huxy2023/myship/compare/v0.3.2...v0.3.3)

---

## [v0.3.2] — Web 管控台全栈化升级 (`Console v2`) 与门户交互焕新

### ✨ 核心亮点 (Highlights)
- **🖥️ `myship console` 可视化管控台 v2**：新增云资源全景面板（直观展示各项目绑定的 PG / Neon / Turso / D1 / MySQL 数据库与 COS 存储前缀）、在线只读表数据与对象文件浏览器，以及 SCF 全栈版本与云端日志 (`myship logs`) 聚合视图。
- **🎨 门户与文档站重构**：支持浅色/深色双主题切换、Mermaid 架构图交互式缩放拖拽画布、章节锚点搜索索引与 `/llms.txt` AI 友好索引。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.3.2`](https://www.npmjs.com/package/@myship/cli/v/0.3.2)
- **完整代码变更对比**：[`v0.3.1...v0.3.2`](https://github.com/huxy2023/myship/compare/v0.3.1...v0.3.2)

---

## [v0.3.1] — 全栈黄金样板工程 (`examples/fullstack-starter`) 与同源运行时解耦

### ✨ 核心亮点 (Highlights)
- **📦 全栈黄金样板工程 (`examples/fullstack-starter`)**：提供串联「静态前端 + `server/index.mjs` (SCF) + `context.db` SQL 读写 + `context.storage` KV + `context.files.presignUrl` 对象预签名直传」的端到端参考范本。
- **🧩 本地与云端 100% 同源运行时**：拆分 `db-client.mjs`、`storage-client.mjs` 与 `scf-bootstrap-runtime.mjs`，彻底消除内联运行时代码重复，确保 `myship dev` 与云端 SCF 行为完全一致。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.3.1`](https://www.npmjs.com/package/@myship/cli/v/0.3.1)
- **完整代码变更对比**：[`v0.3.0...v0.3.1`](https://github.com/huxy2023/myship/compare/v0.3.0...v0.3.1)

---

## [v0.3.0] — 声明式云资源注册与五大 Serverless 数据库自动编排 (`myship use`)

### ✨ 核心亮点 (Highlights)
- **🗄️ 声明式云资源引擎 (`myship use`)**：支持通过方向键交互式菜单或命令行一键开通并绑定 **腾讯云 CloudBase PostgreSQL**（自动发现环境、开启公网并创建 `myship_<project>` 隔离 Schema）、**Neon Serverless PG**、**Turso Edge SQLite**、**Cloudflare D1**、**原生 MySQL 8** 以及 **COS 二进制文件存储 (`context.files`)**。
- **⚡ 零配置本地开发映射**：本地执行 `myship dev` 时，`context.db` 自动回退至 Node.js 原生 `node:sqlite`（`.myship/data/<project>/local.sqlite`），`context.files` 自动映射至 `.myship/files/<project>/`。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.3.0`](https://www.npmjs.com/package/@myship/cli/v/0.3.0)
- **完整代码变更对比**：[`v0.2.0...v0.3.0`](https://github.com/huxy2023/myship/compare/v0.2.0...v0.3.0)

---

## [v0.2.0] — 边缘云函数 (`api/*.js`)、SCF 全栈 Node.js 后端与生命周期治理

### ✨ 核心亮点 (Highlights)
- **🟢 腾讯云 SCF 全栈 Node.js 后端 (`myship backend`)**：内置工业级 `esbuild` 单包编译与内联 SourceMap，支持每次部署冻结不可变 SCF 版本与 8 版本滑动窗口，配合 `myship rollback` 实现前后端同帧 0 秒原子回退。
- **⚡ 约定式边缘云函数 (`api/*.js`) 与私有环境变量 (`myship env`)**：自动扫描并编译边缘函数，支持项目隔离环境变量加密同步。
- **🛠️ 本地全栈热重载 (`myship dev`)、Web 管控台 (`myship console`)、CI 生成器 (`myship init --ci`) 与垃圾回收 (`myship gc` / `myship rm`)**。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.2.0`](https://www.npmjs.com/package/@myship/cli/v/0.2.0)
- **完整代码变更对比**：[`v0.1.1...v0.2.0`](https://github.com/huxy2023/myship/compare/v0.1.1...v0.2.0)

---

## [v0.1.1] — 全局边缘网关自动探测与一键部署

### ✨ 核心亮点 (Highlights)
- **🌐 全局共享边缘路由 (`myship-cas-router`)**：将边缘网关函数收敛至全局 `~/.myship/edgeone-function.dist.js`，执行 `myship login` 时自动探测 `https://_myship_probe.<domain>` 并支持一键上传与绑定 EdgeOne 泛域名触发规则。
- **🔐 复用腾讯云 CLI (`tccli`) 扫码凭证**：自动识别 `~/.tccli/default.credential`，新设备免填密钥即可快速接入。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.1.1`](https://www.npmjs.com/package/@myship/cli/v/0.1.1)
- **完整代码变更对比**：[`v0.1.0...v0.1.1`](https://github.com/huxy2023/myship/compare/v0.1.0...v0.1.1)

---

## [v0.1.0] — MyShip 开源首发：自有云底座 (BYOC) 内容寻址极速部署引擎

### ✨ 核心亮点 (Highlights)
- **⚓ CAS 三级指针架构 (`blobs/` + `manifests/` + `aliases/`)**：基于腾讯云 COS 与 EdgeOne 边缘函数的全局 SHA-256 块级去重增量上传、不可变预览子域名与 0 秒生产别名切换。
- **🛡️ 安全防泄漏护栏**：自动拦截 `.env`、私钥与敏感目录，支持 GitHub Actions OIDC SLSA Provenance 签名发布至 NPM。

### 📦 发行产物与校验
- **NPM 官方包**：[`@myship/cli@0.1.0`](https://www.npmjs.com/package/@myship/cli/v/0.1.0)
