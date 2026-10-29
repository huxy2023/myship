# ⚡ MyShip

**Build your own personal `surge.sh` + `Vercel` on Tencent Cloud EdgeOne & COS in 10 minutes.**  
**基于自有云设施（BYOC）的零依赖、高 DX 内容寻址（CAS）静态部署与泛域名路由引擎。**

[![NPM Version](https://img.shields.io/npm/v/myship.svg?color=cb3837)](https://www.npmjs.com/package/myship)
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
npm i -g myship
# 或免安装直接运行：
npx myship
```

### 第 2 步：绑定你的腾讯云凭证与云底座配置

```bash
myship login
```
交互式输入你的：
- 腾讯云 `SecretId` / `SecretKey`（若本机已安装并登录过 `tccli`，可直接回车自动复用 `~/.tccli/default.credential`）
- 你的 COS 存储桶地址（如 `https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`）
- 你的泛域名后缀（如 `ship.example.com`）

### 第 3 步：一键生成你的专属 EdgeOne 边缘函数代码

```bash
myship build-edge-fn
```
该命令会自动将你的 COS 存储桶地址注入边缘网关模板，生成 `.myship/edgeone-function.dist.js` 并输出一键部署命令。  
*(详细的 DNSPod 泛解析、EdgeOne 免费泛域名 HTTPS 证书申请与避坑指南，请阅读 👉 **[《从 0 到 1 自建云端底座保姆级指南》](./docs/02-self-hosting-guide.md)**)*。

### 第 4 步：在任意前端项目中享受 6 个字母的极简发布

```bash
cd /path/to/your-vue-or-react-app
npm run build

# 直接输入 6 个字母！自动初始化 .myship/project.json 并发布至：
#   - 构建快照域名: https://app1-<hash>.ship.example.com
#   - 项目默认主域: https://app1.ship.example.com
myship

# 发布到当前项目的指定子环境（自动拼接项目前缀 -> https://app1-v2.ship.example.com）
myship -d v2

# 查看当前项目命名空间下的历史版本与线上域名（加 --all 查看全量项目分组）
myship ls

# 0 秒将当前项目主域名一键回退到上一个历史版本
myship rollback
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
│   │   └── cos-client.mjs         # 原生 node:crypto 腾讯云 COS XML v5 签名客户端
│   │
│   └── edge-gateway/              # @myship/edge-gateway — 边缘路由网关
│       ├── edgeone-function.template.js # EdgeOne 边缘函数标准模板
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
