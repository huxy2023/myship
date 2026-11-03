# 从 0 到 1 自建云端底座保姆级指南 (BYOC Setup & Troubleshooting)

**MyShip** 采用 **BYOC（Bring Your Own Cloud，自带云设施）** 架构。你不需要向任何第三方 SaaS 平台按月付费，只需利用你自己的 **1 个域名 + 腾讯云 COS 对象存储 + 腾讯云 EdgeOne 标准站点（免费版即可）**，就能在 10 分钟内搭建一套完全归你所有的个人级全栈部署平台。

---

## 一、云端基础设施全景拓扑

```mermaid
flowchart TB
    subgraph Local["1. 本地开发端 / CI 流水线"]
        CLI["myship CLI<br/>(CAS 去重 + esbuild 打包 + 资源编排 + 指针切换)"]
        Config["~/.myship/config.json<br/>或 ~/.tccli/default.credential"]
        CLI -. "读取凭证" .-> Config
    end

    subgraph DNS["2. 权威 DNS 解析层 (如腾讯云 DNSPod: example.com)"]
        DNS_Wild["CNAME: *.ship<br/>-> <your-zone>.ship.example.com.eo.dnse2.com"]
        DNS_ACME["CNAME: _acme-challenge.ship<br/>-> <your-zone>.ship.example.com.eoacme0.com"]
    end

    subgraph EdgeOne["3. 腾讯云 EdgeOne 标准站点 (zone-xxxxxxxx)"]
        EO_Domain["泛加速域名: *.ship.example.com<br/>(免费版全球套餐即可支持)"]
        EO_Cert["边缘 HTTPS 泛域名免费证书<br/>(SHA256-RSA / HTTP2 / 到期前15天自动续期)"]
        EO_ApiWorker["独立 API 边缘函数 (myship-api-<project>)<br/>拦截 /api/* 或反向代理至 SCF 全栈版本"]
        EO_Func["全局静态路由器 myship-cas-router<br/>动态解析 Host 并向 COS 寻址"]
        EO_Domain --> EO_Cert --> EO_ApiWorker & EO_Func
    end

    subgraph ComputeAndData["4. 云存储、全栈后端与 Serverless 数据库"]
        COS["腾讯云 COS 对象存储 (myship-1250000000)<br/>blobs/ · manifests/ · aliases/ · data/ · files/"]
        SCF["腾讯云 SCF Web 函数 (按需开启)<br/>Node.js 24/20 不可变版本 + 专属触发器"]
        DB["声明式 Serverless 数据库 (myship use db)<br/>CloudBase PG / Neon / Turso / D1 / MySQL"]
        SCF --> COS & DB
    end

    User["公网浏览器访问<br/>https://app1.ship.example.com"] -- "1. DNS 解析" --> DNS_Wild
    DNS_Wild -- "2. 调度至边缘节点" --> EO_Domain
    EO_Func -- "3a. 静态 CAS 寻址" --> COS
    EO_ApiWorker -- "3b. 边缘 V8 执行或转发全栈 SCF" --> SCF & COS
    CLI -- "4. 部署快照 / 开通资源 / 0秒改写指针" --> COS & SCF & DB
```

---

## 二、四步搭建你自己的云端底座 (10 分钟 SOP)

假设你拥有的主域名为 `example.com`，我们规划将 **`*.ship.example.com`** 作为 MyShip 的专属泛域名空间（完全不影响你主域名 `@` 或 `www.example.com` 的现有业务）。

### 第 1 步：创建腾讯云 COS 存储桶（持久化 CAS 与文件存储层）

1. 登录 [腾讯云 COS 控制台](https://console.cloud.tencent.com/cos5/bucket)，创建一个新存储桶：
   - **名称示例**：`myship-1250000000`（后缀为你的腾讯云 `AppId`）
   - **所属地域**：推荐就近选择（如 `ap-guangzhou` 或 `ap-shanghai`）
   - **访问权限**：保持默认的 **私有读写** 即可（`myship` 在上传公开静态块 `blobs/`、`manifests/`、`aliases/` 时会自动附加对象级 `x-cos-acl: public-read`；而在保存环境变量 `envs/`、函数源码 `functions/`、应用状态 `data/` 与私有文件 `files/` 时严格使用 `x-cos-acl: private`）。
2. 复制该存储桶的访问域名，形如：
   `https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`

---

### 第 2 步：在腾讯云 EdgeOne 标准站点接入泛域名与免费 HTTPS 证书

1. 登录 [腾讯云 EdgeOne 控制台](https://console.cloud.tencent.com/edgeone/zones)，添加站点 `example.com`：
   - **套餐选择**：选择 **免费版（Free Plan）** 即可（免费版即支持泛域名加速与边缘函数调用）。
   - **接入方式**：推荐选择 **CNAME 接入（`partial`）**（既不影响主域名现有 DNS，也能避开部分新后缀域名的 Whois 校验问题，详见下文第 三 节避坑指南）。
2. 在【域名管理】中添加加速域名：
   - **加速域名**：输入 **`*.ship.example.com`**（开启泛域名）。
   - **源站配置**：选择你的 COS 存储桶域名 `myship-1250000000.cos.ap-guangzhou.myqcloud.com`。
3. 按 EdgeOne 界面提示，在你的 DNS 服务商（如 DNSPod）添加两条 CNAME 记录：

| 主机记录 (SubDomain) | 记录类型 | 记录值示例 | 配置作用说明 |
| :--- | :---: | :--- | :--- |
| **`*.ship`** | `CNAME` | `<assigned>.ship.example.com.eo.dnse2.com` | **【核心流量入口】** 将所有 `<任意名字>.ship.example.com` 指向 EdgeOne 全球边缘节点。 |
| **`_acme-challenge.ship`** | `CNAME` | `<zone-id>.ship.example.com.eoacme0.com` | **【HTTPS 自动签发与续期委派】** 在为 `*.ship.example.com` 申请免费边缘 HTTPS 证书时选择「DNS 委派验证」，配置后证书将在数分钟内自动签发并支持到期前 15 天自动续期。 |

---

### 第 3 步：在本机执行 `myship login`，敲回车一键上传全局边缘函数

在终端运行：

```bash
myship login
```

1. **选择认证方式（二选一）**：
   - **方式 `[1]` CAM 子账号密钥**：前往 [腾讯云 CAM 用户控制台](https://console.cloud.tencent.com/cam/user) 新建编程访问子账号。
     - **纯静态发包最小权限**：仅需授予 **`QcloudCOSDataFullControl`**（对象存储 COS 数据读写权限）。
     - **边缘函数与全栈 SCF 后端权限（按需）**：若希望 CLI 自动同步 EdgeOne 边缘函数及部署 SCF Web 函数后端，可额外勾选 `QcloudTEOFullAccess` 与 `QcloudSCFFullAccess`。
   - **方式 `[2]` `tccli` 浏览器扫码授权**：自动唤起 `tccli auth login` 扫码登录，免建静态密钥。
2. **填入 COS 存储桶地址与泛域名后缀**（如 `ship.example.com`）。
3. **全局边缘函数智能探测与一键上传**：
   - **全账号共享 1 个静态路由云函数**：无论你有多少个前端项目、多少台电脑，云端永远只需要 **1 个全局静态边缘函数 (`myship-cas-router`)**。生成的全局函数代码统一保存在 **`~/.myship/edgeone-function.dist.js`**，绝不会在你的业务项目文件夹内产生任何冗余文件。
   - **换新电脑自动跳过**：`myship login` 会自动探测 `https://_myship_probe.ship.example.com`。如果你是在第二台新电脑上登录，探测到云端网关已在线后会自动跳过边缘函数部署。
   - **首次搭建敲回车直传**：首次搭建时，直接敲回车，`myship` 会通过内置的 EdgeOne API 自动匹配站点、创建/更新 `myship-cas-router` 函数并配置触发规则。

*(注：若你日后更换了 COS 存储桶地址，随时运行 `myship setup-edge` 敲回车即可一键同步至云端。)*

---

### 第 4 步：（可选）按需接入云数据库底座 (`myship use`)

当你的全栈项目需要持久化 SQL 数据库时，无需手动拼装连接串，直接运行：

```bash
myship use
```

向导支持五大 Serverless 数据库底座，首次配置后自动持久化在 `~/.myship/config.json`，后续任意新项目执行 `myship use` 即可 **0 参数自动建库或分配独立 Schema**：
- **腾讯云 CloudBase PostgreSQL (`pg`)**：自动扫描当前腾讯云账号下的 CloudBase 环境与 PG 实例，一键开启公网访问并为每个项目自动创建独立 Schema（`myship_<project>`）。
- **Neon Serverless PostgreSQL (`neon`)**：填入 Neon API Key 后自动识别组织与项目、创建默认库并为每个应用隔离独立 Schema（同时支持 HTTP SQL 零冷启动与标准 TCP 连接池）。
- **Turso Edge SQLite (`turso`)**：填入 Turso API Token 后自动识别组织、初始化默认 Group（如 Tokyo `aws-ap-northeast-1`），为每个项目创建独立 SQLite 数据库并签发项目级读写 Token。
- **Cloudflare D1 (`d1`)**：填入 Cloudflare Account ID 与 API Token，自动为每个项目查找或创建独立 D1 数据库。
- **原生 MySQL 8 / TDSQL-C (`mysql`)**：填入主连接串后自动为每个项目创建 `myship_<project>` 独立数据库。

---

## 三、独家实战避坑指南 (FAQ & Troubleshooting)

### 坑点 1：申请免费泛域名证书时报错 `ApplyCertDnsServerNotPointToDP` 怎么办？
- **现象**：你的域名明明已经在 DNSPod 解析，且在 EdgeOne 选择了「DNSPod 托管接入（`dnsPodAccess`）」，但在为 `*.ship.example.com` 申请免费泛域名 HTTPS 证书时却报错 `OperationDenied.ApplyCertDnsServerNotPointToDP`（提示 DNS 服务器未指向 DNSPod）。
- **根因**：对于 `.top` 等部分后缀，注册局 Whois 接口（`DescribeDomainWhois`）返回的 `NameServers` 可能为 `null`（导致 `ActualNsList: []`），从而触发 EdgeOne 在 `dnsPodAccess` 模式下的 NS 校验误判。
- **解决方案**：
  将 EdgeOne 站点的接入模式从 `dnsPodAccess` 切换为 **CNAME 接入 (`partial`)**：
  ```bash
  tccli teo ModifyZone --ZoneId "zone-xxxxxxxx" --Type "partial"
  ```
  然后在证书申请界面选择 **「DNS 委派验证」**，在 DNSPod 添加一条 `_acme-challenge.ship` 的 CNAME 记录指向 `<zone-id>.ship.example.com.eoacme0.com`，约 3~5 分钟即可成功签发泛域名证书。

### 坑点 2：添加泛域名 `*.ship.example.com` 时报错 `DomainAlreadyExists`？
- **根因**：如果你此前在腾讯云 **EdgeOne Pages** 项目中添加过同名自定义域名，它会被绑定在隐藏的 `default-pages-zone` 下，导致标准站点无法重复添加同一域名。
- **解决方案**：先前往 EdgeOne Pages 控制台删除该自定义域名，等待约 1 分钟状态释放后，即可在标准站点顺利添加。

### 坑点 3：如何通过 HTTP 响应头快速排查当前子域名命中了哪个构建版本与后端引擎？
线上边缘网关会自动在每个响应中注入 `X-MyShip-*` 诊断头，随时可用 `curl -i` 巡检静态文件、边缘 V8 函数或 SCF 全栈后端的命中状态：

```bash
# 巡检静态页面命中版本与边缘内存缓存状态
curl -I https://app1.ship.example.com/

# 巡检 /api/* 接口命中版本与运行引擎
curl -i https://app1.ship.example.com/api/hello
```

响应头示例：
```http
HTTP/2 200
content-type: application/json; charset=UTF-8
x-myship-engine: EdgeOne-API-Worker/2.2-FullStack
x-myship-subdomain: app1
x-myship-deployment-id: dpl_816ac41e
x-myship-function-route: /api/hello
```

### 坑点 4：为什么手写 EdgeOne 边缘函数有时会报 `HTTP 545 Error return from script`？（MyShip 已内置全套防崩护栏）
腾讯云 EdgeOne 边缘函数运行在高度精简的 **V8 Isolate 沙盒**中，若不了解其底层边界极易触发 `545` 脚本异常。`MyShip` 已在 CLI 与网关层为你内置了自动化防护：
1. **`URLSearchParams` 迭代器与 `Response.json()` 差异**：EdgeOne V8 中直接调用 `Object.fromEntries(url.searchParams)` 或 `Response.json()` 会抛出 `TypeError`。`MyShip` 网关已内置零依赖 Query 解析器（直接读取 `context.query`）与 `Response.json` / `process.env` 兼容垫片。
2. **严禁在边缘 V8 中使用 `new Headers()` 复杂构造与 Node.js 内置模块**：网关内部统一使用 Plain Object 合并响应头；同时 `myship` CLI 在部署边缘 `api/*.js` 时会自动静态扫描，若需要使用完整 Node.js 模块或数据库连接池，只需开启 `myship backend enable` 切换至 SCF 全栈 Node.js 引擎。
3. **`128 MB` 内存红线与 `5 MB` 代码包红线**：网关对边缘内存缓存实施严格的 **`8 MB` 字节级总量控制 + `Uint8Array` 零拷贝视图**；CLI 对预编译函数池实施 **`3.5 MB` 自动水位线保护**，从根源上杜绝 OOM 与代码包超限。
