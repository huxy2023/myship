# 5 分钟快速上手与 CLI 命令全解 (Quickstart & CLI Reference)

**MyShip** 是面向个人与独立开发者的 **BYOC（Bring Your Own Cloud，自带云设施）** 部署引擎。它将 `surge.sh` 的零配置直觉体验与 `Vercel` 的不可变多版本预览、项目命名空间隔离与 0 秒原子回滚融为一体。

---

## 一、核心功能一览

| 功能模块 | 功能特性 | 本地沙盒 (`--local`) | 云端生产模式 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| **CAS 去重存储** | `SHA-256` 内容寻址增量上传 | ✅ | ✅ | 仅上传修改过的文件块 (`blobs/<sha256>`)，未改动的依赖/图片自动 `HEAD` 命中秒跳 |
| **不可变部署快照** | 每次构建生成独立 `dpl_<hash>` 清单 | ✅ | ✅ | 每个版本仅占 ~1KB JSON 清单 (`manifests/dpl_<id>.json`)，历史版本永久保留不失效 |
| **项目命名空间隔离** | 自动维护 `.myship/project.json` | ✅ | ✅ | 自动将不同项目隔离为 `app1-<hash>.ship.example.com` 与 `app2-<hash>.ship.example.com` |
| **多环境子域名绑定** | 单次构建支持绑定 1 个或多个子域名 | ✅ | ✅ | 支持 `myship -d v2`（自动补齐项目前缀 `app1-v2`）或 `--raw` 自定义原始子域名 |
| **0 秒原子切流/回滚** | 毫秒级切换任意子域名指向的构建版本 | ✅ | ✅ | 仅修改 80 字节 `aliases/<subdomain>.json` 指针，无需重新构建或复制文件 |
| **项目隔离与全局视图** | `myship ls` 与 `myship ls --all` | ✅ | ✅ | 默认仅显示当前项目的构建与域名；加 `--all` 按项目分组展示全局总览 |
| **SPA History 路由** | 自动回退 `/200.html` 或 `/index.html` | ✅ | ✅ | 原生支持 Vue Router / React Router 的 `createWebHistory()` 模式 |
| **约定式 Serverless 云函数** | `api/**/*.js` 零配置自动路由与 CAS 寻址 | ✅ | ✅ | 自动识别 `api/*.js` 映射为 `/api/*` 接口，与前端共享同一 `dpl_<id>` 快照，支持前后端 0 秒同帧回滚 |
| **零依赖跨机认证** | 三级凭证自动兜底 + 边缘函数生成 | — | ✅ | 支持环境变量、`~/.myship/config.json` 与 `~/.tccli/default.credential` 自动复用 |

---

## 二、安装与认证配置

### 1. 全局安装 `myship`

在任何安装了 Node.js (`>=20.0.0`) 的电脑上：

```bash
# 方式 A：直接从 NPM 官方源全局安装（推荐，0 外部依赖）
npm i -g @myship/cli

# 方式 B：直接下载 GitHub Release 最新安装包到本地安装 (兼容 npm 12 安全策略)
curl -fL https://github.com/huxy2023/myship/releases/download/v0.1.1/myship-cli-0.1.1.tgz -o /tmp/myship.tgz && npm i -g /tmp/myship.tgz
```

### 2. 绑定你的自有云底座 (`myship login`)

在首次向云端部署前，运行交互式配置向导：

```bash
myship login
```

向导会自动检测本机是否已有可用凭证，并提供两种安全认证方式供选择：

1. **方式一：CAM 子账号最小权限 API 密钥（跨电脑零依赖，推荐）**
   - **最小权限原则**：`MyShip` 日常执行 `deploy / alias / rollback / ls` 时**仅读写 COS 对象存储**，完全不触碰其他云资源。
   - 前往 [腾讯云访问管理 (CAM) -> 用户列表](https://console.cloud.tencent.com/cam/user) 新建子用户（勾选“编程访问”），**仅需授予 1 项策略：`QcloudCOSDataFullControl`（对象存储 COS 数据读写权限）**，然后将生成的 `SecretId` 与 `SecretKey` 粘贴至终端。
2. **方式二：使用腾讯云官方 `tccli` 浏览器扫码登录（免创建静态密钥）**
   - 在 `myship login` 中输入 `2`，向导会自动唤起 `tccli auth login` 打开浏览器扫码登录，并自动复用与续期 `~/.tccli/default.credential` 中的临时 STS 凭证。
3. **填入云底座地址**：
   - **你的 COS 存储桶地址**（例如：`https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`）
   - **你的泛域名后缀**（例如：`ship.example.com`）
4. **全局边缘网关智能探测与一键上传**：
   - **全账号共享 1 个云函数**：EdgeOne 边缘函数是全局路由底座，所有前端项目共享同一个云函数，无需为每个项目单独创建。
   - **换新电脑免重复操作**：`myship login` 会自动探测 `https://_myship_probe.<你的泛域名后缀>`。如果云端边缘网关已在线运行，直接提示就绪结束，**绝不在当前业务项目文件夹下生成任何边缘函数文件**（全局函数文件统一存放在 `~/.myship/edgeone-function.dist.js`）。
   - **首次搭建敲回车直传**：若探测到云端尚未部署边缘函数，终端会提示 `是否现在直接将该全局边缘函数自动上传并部署到腾讯云 EdgeOne？[Y/n]`，直接敲回车即可通过内置 EdgeOne API 自动完成上传！

### 3. 巡检当前身份与项目上下文 (`myship whoami`)

```bash
myship whoami
```

---

## 三、日常高频工作流（项目级命名空间隔离）

当你手头同时开发 `app1`、`app2` 等多个前端项目时，`MyShip` 会通过项目根目录下的 `.myship/project.json` 自动为你隔离域名与历史记录：

### 1. 零参数直发主环境 (`myship`)

进入你的任意前端项目（如 `app1`），构建后直接输入 6 个字母：

```bash
npm run build
myship
```

- 若项目下尚无 `.myship/project.json`，`myship` 会自动读取 `package.json` 的 `name`（或文件夹名称）初始化配置：
  ```json
  {
    "project": "app1",
    "dir": "./dist",
    "prodDomain": "app1"
  }
  ```
- 同时自动生成两个 HTTPS 域名：
  - **本次构建永久快照域名**：`https://app1-6e46ed99.ship.example.com`
  - **项目默认主域名**：`https://app1.ship.example.com`

### 2. 发布到项目的指定子环境 (`myship -d <env>`)

```bash
# 在 app1 目录下执行，自动拼接项目前缀，绑定至 https://app1-v2.ship.example.com
myship -d v2

# 或使用 surge.sh 风格的位置参数：
myship ./dist v2

# 若不希望自动拼接 app1- 前缀，可加上 --raw 参数：
myship ./dist custom-name --raw
```

### 3. 查看当前项目或全局域名列表 (`myship ls`)

```bash
# 默认仅展示【当前所在项目 (如 app1)】的历史构建与域名，清爽不混杂
myship ls

# 加上 --all (或 -A)，按 [app1]、[app2] 分组展示云端所有项目的汇总视图
myship ls --all
```

### 4. 0 秒一键回滚 (`myship rollback`) 与手动切流 (`myship alias`)

```bash
# 零参数回滚：0 秒将当前项目主域名 (https://app1.ship.example.com) 回退到上一历史版本
myship rollback

# 回滚当前项目下的指定子环境域名 (https://app1-v2.ship.example.com)
myship rollback v2

# 手动将子域名 0 秒切换到指定的历史构建 ID
myship alias v2 dpl_6e46ed99
```

### 5. CAS 垃圾回收与 API 路由配额释放 (`myship gc`)

```bash
# 预览模式：查看可清理的过期历史快照、无引用孤儿静态块与废弃云函数（不执行删除）
myship gc --dry-run

# 执行清理（默认每个项目保留最近 10 个历史版本 + 所有正在绑定的线上版本，并自动释放废弃 API 路由配额）
myship gc

# 自定义保留版本数（如每个项目保留最近 5 个版本，或 --keep all 仅清理无引用孤儿块）
myship gc --keep 5
```

### 6. GitHub Actions 自动部署与 PR 预览工作流 (`myship init --ci`)

```bash
# 一键生成 .github/workflows/myship.yml（Push main 自动发生产主域，提 PR 自动发 https://<project>-pr-<号>.<domain> 并回复评论）
myship init --ci

# 若本机已安装并登录 GitHub CLI (gh)，可加 --sync-secrets 一键将云端密钥自动写入当前 GitHub 仓库 Secrets
myship init --ci --sync-secrets
```

---

## 四、约定式 Serverless 云函数 (`api/*.js`) 与全栈原子回滚

无需手写任何网关配置文件，只需在你的项目根目录（或构建产物目录）下创建 `api/` 文件夹并编写标准的 JavaScript 模块，`myship` 在部署时会自动执行**前后端职责解耦的双层 Serverless 架构**：
- **方案 A（默认主力 · 独立统一 API 边缘函数）**：自动在腾讯云 EdgeOne 上维护与全局纯静态路由器（`myship-cas-router`）100% 物理隔离的独立 API 边缘函数并绑定高优触发规则；内部按 `host -> subdomain -> manifest -> functions[route].sha256` 寻址，多项目同名路由互不串线，并与前端页面绑定同一 `dpl_<id>` 快照实现 0 秒同帧回滚。
- **方案 C（远期重算力扩展槽 · 腾讯云 SCF 函数 URL 反向代理）**：当某个接口需要超过 5MB 的重型 `node_modules`、原生 TCP 数据库连接池或 900 秒长耗时 AI 推理时，只需在 `api/<route>.js` 中导出 `export const upstreamUrl = 'https://<id>.ap-guangzhou.tencentscf.com'`，边缘网关将自动执行零跨域反向代理并注入 `X-MyShip-Deployment-Id` 上下文头。

### 1. 编写你的第一个云函数 (`api/hello.js`)

同时兼容 **Web / Vercel 标准导出 (`GET` / `POST` / `default`)** 与 **腾讯云 EdgeOne 官方导出 (`onRequest` / `onRequestGet` / `onRequestPost`)**，可直接返回普通 JSON 对象或 `Response` 实例，并自动注入 EdgeOne 原生的客户端 IP 与地理位置信息 (`context.geo` / `context.clientIp`)：

```javascript
// 写法 A：Web / Next.js 风格命名导出 (api/hello.js -> https://<子域名>/api/hello)
export async function GET(request, context) {
  const name = context.query.name || 'MyShip Developer';

  return {
    ok: true,
    message: `Hello, ${name}! Executed at Edge V8 Isolate.`,
    project: context.project,
    deploymentId: context.deploymentId, // 与当前前端页面严格同源的构建版本 ID
    subdomain: context.subdomain,
    functionSha256: context.functionSha256,
    clientIp: context.clientIp,         // 自动透传 EdgeOne request.eo.clientIp
    geo: context.geo,                   // 自动透传 EdgeOne 国家/省份/城市/运营商信息
    timestamp: new Date().toISOString(),
  };
}

// 写法 B：腾讯云 EdgeOne 官方 onRequest* 签名（同样原生支持）
export async function onRequestPost(context) {
  const body = await context.request.json();
  return {
    ok: true,
    received: body,
    deploymentId: context.deploymentId,
  };
}

// 写法 C（可选重算力扩展槽）：一行代码将当前路由反向代理至腾讯云 SCF 函数 URL
// export const upstreamUrl = 'https://xxx-1250000000.ap-guangzhou.tencentscf.com';
```

### 2. 项目级云函数环境变量管理 (`myship env`)

每个项目的环境变量按项目命名空间独立保存在 COS 私有路径 `envs/<project>.json`（`x-cos-acl: private`），并在边缘函数中同时注入 `context.env` 与 `process.env`（支持模块顶层或请求处理函数内读取，多项目互不串线）：

```bash
# 设置一个或多个环境变量（若已部署 API 云函数，3~5 秒内自动热更新生效，无需重传静态文件）
myship env set OPENAI_API_KEY=sk-xxxx WEBHOOK_SECRET=whsec_123

# 从本地 .env 文件批量导入
myship env import .env

# 查看当前项目环境变量（默认掩码脱敏，加 --reveal 查看明文）
myship env ls
myship env ls --reveal

# 导出当前项目云端环境变量到本地 .env.local (权限 0600)
myship env pull

# 删除指定环境变量
myship env rm WEBHOOK_SECRET
```

### 3. 前后端同一毫秒原子切流与回滚

当你修改了前端页面和 `api/hello.js` 并执行 `myship -d v2` 时：
- 访问 `https://app1.ship.example.com/api/hello` 依然执行 **V1 版本**的云函数代码；
- 访问 `https://app1-v2.ship.example.com/api/hello` 立即执行 **V2 版本**的云函数代码；
- 当执行 `myship rollback` 时，主域名的前端 HTML 与 `/api/*` 后端接口**在同一毫秒内同步回退到旧版本**，彻底杜绝前后端发版时间差导致的接口报错！

### 3. 腾讯云 EdgeOne V8 运行时规范与内置防超限护栏

由于云端网关运行在腾讯云 **EdgeOne 全球边缘节点 V8 Isolate 沙盒**中，`MyShip` 已针对 EdgeOne 官方配额与 Runtime API 规范内置了静态检查与运行时水位线保护：

| 规范维度 | 腾讯云 EdgeOne 官方限制 | MyShip 内置护栏与兼容策略 |
| :--- | :--- | :--- |
| **运行环境** | 纯 V8 Isolate（非 Node.js），不支持 `fs` / `path` / `net` / `child_process` | CLI 部署期静态扫描拦截 Node.js 原生内置模块，提示改用 `fetch` / `crypto.subtle` |
| **函数签名兼容** | 官方支持 `onRequest(context)` / `onRequestGet(context)`，且扩展了 `request.eo` | **双向全兼容**：同时支持标准 `GET(request, context)` 与 EdgeOne `onRequestGet(context)`，自动注入 `context.geo` 与 `context.clientIp` |
| **API 差异垫片** | 原生 V8 未提供 `Response.json()`、`process.env`，禁止 `new Headers()` 复杂构造与 `eval` | 网关自动注入 `Response.json` 与 `process.env` 兼容垫片，使用纯对象 Headers 与 100% 预编译 AST（零 `eval`/`new Function`） |
| **运行内存上限** | 单实例最大 **128 MB** | 边缘内存缓存采用 `Uint8Array` 零拷贝视图，并设 **8 MB 总容量上限 + 256 KB 单文件上限**，严防 OOM |
| **代码包体积上限** | 单函数代码包最大 **5 MB** | 单 `api/*.js` 限制 `512 KB`，全局预编译池设 **3.5 MB 自动水位线淘汰**（优先保留最新活跃版本） |
| **请求体与执行配额** | 客户端请求 Body 最大 **1 MB**；单次 CPU 时间 **200 ms**；子请求 `fetch` 最多 **64 次（并发 8）** | 网关自动拦截 `>1MB` 请求并返回标准 `413 Payload Too Large` JSON 提示 |

---

## 五、本地全栈即时开发 (`myship dev`) 与离线沙盒 (`--local`)

### 1. 本地全栈即时开发服务器 (`myship dev`)

日常编写静态页面与 `api/*.js` 云函数时，无需每次修改都生成 `.cas-storage` 本地快照，直接运行 `myship dev` 即可启动零依赖本地开发服务器（注：`myship dev` 直接服务静态文件与 `api/*.js`，不内置 Vue/React/TS 前端构建编译器；若项目包含根目录 `index.html` 会优先挂载当前目录 `.`，也可显式传入已生成的构建目录）：

```bash
# 默认在 http://localhost:3000 启动（自动实时加载静态目录、api/*.js 与 .env / .env.local）
myship dev

# 指定静态目录与自定义端口
myship dev ./public --port 8080
```

- **保存即生效**：每次请求实时读取最新 `api/*.js` 与 `.env`，并内置 EdgeOne V8 规范实时校验（若误用 Node.js `fs` 或语法错误，直接返回 500 JSON 诊断详情而不中断开发服务）。
- **安全防泄漏**：自动拦截对 `/.env`、`/.git`、`/.myship`、`/api/*.js` 源码及 `..` 目录穿越的访问。

### 2. 免云账号本地离线 CAS 沙盒模式 (`--local`)

如果你在没有网络的环境下开发，或者想在不配置云账号的情况下体验完整 CAS 多版本切流与回滚，只需加上 `--local`（或直接运行仓库自带的演示脚本）：

```bash
# 一键运行离线 V1/V2 发布、CAS 去重与 0 秒回滚验证
pnpm demo

# 启动本地 4100 端口泛域名模拟网关 (浏览器可访问 http://*.ship.localhost:4100)
pnpm gateway:local
```
