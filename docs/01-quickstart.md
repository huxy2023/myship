# 5 分钟快速上手与 CLI 命令全解 (Quickstart & CLI Reference)

**MyShip** 是面向个人与独立开发者的 **BYOC（Bring Your Own Cloud，自带云设施）** 全栈部署与资源编排引擎。它将零参数 CLI 极简发布、SHA-256 不可变多版本预览、项目命名空间隔离、全栈 Serverless 后端、声明式云资源（数据库与文件存储）及 0 秒原子回滚融为一体。

---

## 一、核心功能全景一览

| 功能模块 | 功能特性 | 本地开发 (`myship dev` / `--local`) | 云端生产模式 | 说明 |
| :--- | :--- | :---: | :---: | :--- |
| **CAS 去重存储** | `SHA-256` 内容寻址增量上传 | ✅ | ✅ | 仅上传修改过的文件块 (`blobs/<sha256>`)，未改动的依赖/图片自动 `HEAD` 命中秒跳 |
| **不可变部署快照** | 每次构建生成独立 `dpl_<hash>` 清单 | ✅ | ✅ | 每个版本仅占 ~1KB JSON 清单 (`manifests/dpl_<id>.json`)，前后端快照一体绑定 |
| **项目命名空间隔离** | 自动维护 `.myship/project.json` | ✅ | ✅ | 自动将不同项目隔离为 `app1-<hash>.ship.example.com` 与 `app2-<hash>.ship.example.com` |
| **0 秒原子切流/回滚** | 毫秒级切换任意子域名指向的构建版本 | ✅ | ✅ | 仅修改 80 字节 `aliases/<subdomain>.json` 指针，前端页面与后端接口同帧原子切换 |
| **边缘 Serverless 函数** | `api/**/*.js` 零配置自动路由与 V8 寻址 | ✅ | ✅ | 自动识别 `api/*.js` 映射为 `/api/*` 接口，运行于 EdgeOne 全球边缘 V8 Isolate |
| **SCF 全栈 Node.js 后端** | `myship backend enable` + `server/index.mjs` | ✅ | ✅ | 完整 Node.js 24/20 运行时、Hono/Web Fetch 框架、`esbuild` 内联 SourceMap 与不可变 SCF 版本绑定 |
| **声明式云资源编排** | `myship use` 交互式注入文件存储与五大数据库 | ✅ | ✅ | 一行命令开通并注入 `context.files`（COS 预签名直传）与 `context.db`（PG / Neon / Turso / D1 / MySQL） |
| **生命周期与可视化管控** | `myship gc` / `rm` / `logs` / `console` / `init --ci` | ✅ | ✅ | 引用计数安全回收、云端源码级错误日志聚合、GitHub PR 预览机器人与本机 Web 管控台 |

---

## 二、安装与认证配置

### 1. 全局安装 `myship`

在任何安装了 Node.js (`>=20.0.0`，推荐使用 Node.js `>=22.5.0` 以享受内置 `node:sqlite` 本地数据库体验) 的电脑上：

```bash
npm i -g @myship/cli
myship --version
```

### 2. 绑定你的自有云底座 (`myship login`)

在首次向云端部署前，运行交互式配置向导：

```bash
myship login
```

向导会自动检测本机是否已有可用凭证，并提供两种安全认证方式供选择：

1. **方式一：CAM 子账号最小权限 API 密钥（跨电脑推荐）**
   - 前往 [腾讯云访问管理 (CAM) -> 用户列表](https://console.cloud.tencent.com/cam/user) 新建编程访问子账号。
   - **纯静态发包/切流/回滚最小权限**：仅需授予 `QcloudCOSDataFullControl`（对象存储 COS 数据读写权限）。
   - **边缘网关同步与全栈 SCF 后端权限（按需）**：若使用 EdgeOne 自动同步或 `myship backend enable`，可额外授予 `QcloudTEOFullAccess` 与 `QcloudSCFFullAccess`。
2. **方式二：使用腾讯云官方 `tccli` 浏览器扫码登录（免创建静态密钥）**
   - 在 `myship login` 中选择 `[2]`，向导会自动唤起 `tccli auth login` 打开浏览器扫码登录，并自动复用 `~/.tccli/default.credential`。
3. **填入云底座地址**：
   - **你的 COS 存储桶地址**（例如：`https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`）
   - **你的泛域名后缀**（例如：`ship.example.com`）
4. **全局边缘网关智能探测与一键上传**：
   - **全账号共享 1 个静态路由云函数**：所有项目共享同一个全局边缘函数 `myship-cas-router`（备份保存在 `~/.myship/edgeone-function.dist.js`，绝不污染业务项目目录）。
   - **换新电脑免重复操作**：`myship login` 会自动探测 `https://_myship_probe.<你的泛域名后缀>`。若云端边缘网关已在线，直接就绪结束；若首次搭建，按回车即可自动上传并绑定触发规则。

### 3. 巡检当前身份与项目上下文 (`myship whoami`)

```bash
myship whoami
```

---

## 三、日常高频工作流（项目级命名空间隔离）

当你同时开发 `app1`、`app2` 等多个项目时，`MyShip` 会通过项目根目录下的 `.myship/project.json` 自动隔离域名、环境变量、存储前缀与历史记录：

### 1. 零参数直发主环境 (`myship`)

进入任意项目（如 `app1`），构建后直接输入 6 个字母：

```bash
npm run build
myship
```

- 若项目下尚无 `.myship/project.json`，`myship` 会自动初始化配置并生成两个 HTTPS 域名：
  - **本次构建永久快照域名**：`https://app1-6e46ed99.ship.example.com`
  - **项目默认主域名**：`https://app1.ship.example.com`

### 2. 发布到项目的指定子环境 (`myship -d <env>`)

```bash
# 自动拼接项目前缀，绑定至 https://app1-v2.ship.example.com
myship -d v2

# 或使用位置参数：
myship ./dist v2

# 若不希望自动拼接 app1- 前缀，可加上 --raw 参数：
myship ./dist custom-name --raw
```

### 3. 查看当前项目或全局域名列表 (`myship ls`)

```bash
# 默认仅展示当前所在项目 (如 app1) 的历史构建与域名
myship ls

# 加上 --all (或 -A)，按项目分组展示云端所有项目的汇总视图
myship ls --all
```

### 4. 0 秒一键回滚 (`myship rollback`) 与手动切流 (`myship alias`)

```bash
# 零参数回滚：0 秒将当前项目主域名回退到上一历史版本（前端页面与后端接口同帧回退）
myship rollback

# 回滚当前项目下的指定子环境域名 (https://app1-v2.ship.example.com)
myship rollback v2

# 手动将子域名 0 秒切换到指定的历史构建 ID
myship alias v2 dpl_6e46ed99
```

### 5. 垃圾回收 (`myship gc`) 与资源精确销毁 (`myship rm`)

```bash
# 预览可清理的过期历史快照、无引用孤儿静态块与废弃函数版本（不执行删除）
myship gc --dry-run

# 按保留版本数或按时间窗口执行清理（自动保留所有当前活跃别名指向的版本）
myship gc --keep 5
myship gc --older-than 7d

# 手动删除单个构建快照、解绑子域名或彻底销毁废弃项目（基于引用计数安全回收独占块）
myship rm dpl_6e46ed99
myship rm --alias pr-1
myship rm --project old-demo
```

### 6. GitHub Actions 自动部署与 PR 预览 (`myship init --ci`) 及 Web 管控台 (`myship console`)

```bash
# 一键生成 .github/workflows/myship.yml 并通过 gh CLI 自动同步仓库 Secrets
myship init --ci --sync-secrets

# 启动本机 127.0.0.1:4200 可视化 Web 管控台（支持鼠标点击切流/回滚/双版本 SHA-256 Diff/环境变量/GC）
myship console
```

---

## 四、双引擎 Serverless 后端：边缘 V8 函数 (`api/*.js`) 与 SCF 全栈 Node.js (`myship backend`)

`MyShip` 提供两种互补的后端运行模式，均可与前端静态产物绑定在同一份 `dpl_<id>` 快照中实现 **0 秒同帧回滚**：

### 模式 1：零配置边缘 Serverless 云函数 (`api/*.js` · EdgeOne V8 Isolate)

适合轻量 API、Webhook、边缘鉴权与低延迟请求处理。只需在项目下创建 `api/hello.js`，执行 `myship` 时自动按 `SHA-256` 归档并同步至项目专属 API 边缘函数：

```javascript
// api/hello.js -> 自动映射为 https://<子域名>/api/hello
export async function GET(request, context) {
  return {
    ok: true,
    message: `Hello, ${context.query.name || 'Developer'}!`,
    project: context.project,
    deploymentId: context.deploymentId,
    clientIp: context.clientIp, // 自动透传 EdgeOne 客户端真实 IP
    geo: context.geo,           // 自动透传 EdgeOne 国家/省份/城市/运营商信息
  };
}
```

### 模式 2：完整 Node.js 全栈后端 (`myship backend enable` · 腾讯云 SCF Web 函数)

当你的应用需要完整的 Node.js 24/20 运行时、任意第三方 npm 包（如 **Hono**、数据库驱动、AI SDK）、SSE 流式响应或长耗时计算时，开启 SCF 全栈模式：

```bash
# 1. 开启当前项目的 SCF 全栈后端（自动执行权限预检并生成 server/index.mjs 骨架）
myship backend enable

# 2. 本地全栈热重载联调（默认 http://localhost:3000）
myship dev

# 3. 一键全栈构建与不可变版本发布
myship

# 4. 实时查询云端运行日志与 SourceMap 还原后的源码报错行号
myship logs
myship logs --error
```

编写标准的 `server/index.mjs`（同时支持原生 `export async function fetch(request, context)` 或 **Hono** 的 `export default app`）：

```javascript
// server/index.mjs
export async function fetch(request, context) {
  const url = new URL(request.url);

  if (url.pathname === '/api/counter' && request.method === 'POST') {
    // 1. 内置私有 KV 状态存储 (云端存储于 COS data/<project>/counter.json，代码回滚绝不丢失数据)
    const current = (await context.storage.get('counter')) || { count: 0 };
    current.count += 1;
    await context.storage.set('counter', current);
    return Response.json({ ok: true, count: current.count, deploymentId: context.deploymentId });
  }

  return Response.json({ ok: true, runtime: process.version });
}
```

---

## 五、声明式云资源编排 (`myship use`)：多引擎数据库与对象文件存储

无需手工去各个云控制台拼装连接串、建库、配权限。在项目根目录运行 **`myship use`** 即可通过交互式向导（或一行命令）为当前项目开通并注入 **对象文件存储 (`context.files`)** 与 **五大 Serverless 数据库 (`context.db`)**：

### 1. 启动交互式资源向导或一键命令绑定

```bash
# 推荐：启动交互式 TUI 向导（支持 ↑/↓ 方向键选择，自动扫描账号下已有 CloudBase PG / Turso / Neon 底座）
myship use

# 或使用非交互式命令一键绑定（首次配置全局凭证后，后续新项目零参数自动建库/分 Schema）：
myship use storage                         # 注册二进制文件存储 (COS files/<project>/ + 预签名直传 URL)
myship use db --provider pg                # 腾讯云 CloudBase PG / 原生 PG (自动创建 myship_<project> Schema)
myship use db --provider neon              # Neon Serverless PG (支持 API Key 自动建库 + 连接串多 Schema 隔离)
myship use db --provider turso             # Turso Edge SQLite (自动识别组织、初始化默认 Group 并签发项目 Token)
myship use db --provider d1                # Cloudflare D1 Serverless SQLite (自动查找或创建 D1 数据库)
myship use db --provider mysql             # 原生 MySQL 8 / TDSQL-C (自动创建 myship_<project> 独立库)

# 查看当前项目的云资源绑定状态
myship use status
```

### 2. 在代码中调用统一数据库客户端 (`context.db`) 与文件存储 (`context.files`)

`context.db` 为所有数据库提供统一的调用方法（`query(sql, params)`、`execute(sql, params)`、`batch(statements)`），而 **SQL 语法方言则遵循所选的底层数据库引擎**：
- **本地开发 (`myship dev`) 连接策略**：当项目未绑定远程数据库或使用 SQLite 体系（`turso` / `d1`）时，本地 `myship dev` 默认使用 Node.js 22+ 内置 `node:sqlite` 读写 `.myship/data/<project>/local.sqlite`（如需在本地直连远端 Turso/D1 可设置 `MYSHIP_DB_REMOTE=1`）；当项目绑定了 `pg`、`neon` 或 `mysql` 时，本地 `myship dev` 与云端一致直连对应的远端数据库并自动隔离 Schema / 独立库。

```javascript
// 方式 A：PostgreSQL (CloudBase PG / Neon / 原生 PG — 自动隔离至 myship_<project> Schema)
await context.db.execute(`
  CREATE TABLE IF NOT EXISTS todos (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL
  )
`);
await context.db.execute('INSERT INTO todos (title) VALUES ($1)', ['Ship with PostgreSQL']);
const { rows } = await context.db.query('SELECT * FROM todos WHERE id = $1', [1]);

// 方式 B：SQLite 体系 (Turso / Cloudflare D1 / 本地 node:sqlite — 使用标准 SQLite 方言与 ? 占位符)
await context.db.execute(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL
  )
`);
await context.db.batch([
  { sql: 'INSERT INTO notes (title) VALUES (?)', params: ['Step 1'] },
  { sql: 'INSERT INTO notes (title) VALUES (?)', params: ['Step 2'] },
]);

// 方式 C：MySQL 体系 (原生 MySQL 8 / TDSQL-C — 自动隔离至 myship_<project> 独立库)
await context.db.execute(`
  CREATE TABLE IF NOT EXISTS items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(255) NOT NULL
  )
`);
await context.db.execute('INSERT INTO items (title) VALUES (?)', ['Hello MySQL']);

// 二进制文件存储与前端预签名直传 (COS files/<project>/ 隔离)
await context.files.put('reports/summary.txt', 'Hello COS Files!', { contentType: 'text/plain' });
const uploadUrl = await context.files.presignUrl('uploads/avatar.png', { method: 'PUT', expiresIn: 900 });
```

### 3. 项目环境变量管理 (`myship env`)

```bash
# 设置环境变量（私有存储于 COS envs/<project>.json；边缘 api/*.js 自动热更新，SCF 全栈后端需重新执行 myship 发布新版本生效）
myship env set OPENAI_API_KEY=sk-xxxx WEBHOOK_SECRET=whsec_123
myship env import .env
myship env ls              # 默认掩码脱敏展示（加 --reveal 查看明文）
myship env pull            # 导出云端环境变量到本地 .env.local (权限 0600)
myship env rm WEBHOOK_SECRET
```
