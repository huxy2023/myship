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
| **零依赖跨机认证** | 三级凭证自动兜底 + 边缘函数生成 | — | ✅ | 支持环境变量、`~/.myship/config.json` 与 `~/.tccli/default.credential` 自动复用 |

---

## 二、安装与认证配置

### 1. 全局安装 `myship`

在任何安装了 Node.js (`>=20.0.0`) 的电脑上：

```bash
# 方式 A：直接从 GitHub 全局安装（无需克隆源码，0 外部 npm 依赖）
npm i -g github:huxy2023/myship

# 方式 B：如果已克隆本仓库到本地
git clone https://github.com/huxy2023/myship.git
cd myship
npm link
```

### 2. 绑定你的自有云底座 (`myship login`)

在首次向云端部署前，运行交互式配置向导：

```bash
myship login
```

按终端提示依次输入：
1. **腾讯云 `SecretId` & `SecretKey`**（若本机已安装并登录过 `tccli`，可直接回车自动复用 `~/.tccli/default.credential`）
2. **你的 COS 存储桶地址**（例如：`https://myship-1250000000.cos.ap-guangzhou.myqcloud.com`）
3. **你的泛域名后缀**（例如：`ship.example.com`）

配置将加密保存在 `~/.myship/config.json`（文件权限 `0600`），并自动在 `.myship/edgeone-function.dist.js` 生成注入了你 COS 地址的边缘函数代码。

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

---

## 四、免云账号本地离线沙盒模式 (`--local`)

如果你在没有网络的环境下开发，或者想在不配置云账号的情况下体验完整功能，只需加上 `--local`（或直接运行仓库自带的演示脚本）：

```bash
# 一键运行离线 V1/V2 发布、CAS 去重与 0 秒回滚验证
pnpm demo

# 启动本地 4100 端口泛域名模拟网关 (浏览器可访问 http://*.ship.localhost:4100)
pnpm gateway:local
```
