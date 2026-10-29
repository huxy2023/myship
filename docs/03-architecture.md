# CAS 三级指针架构原理与成本拆解 (CAS Architecture Deep Dive)

为什么传统的静态站点托管服务大多限制历史版本数量（例如只保留最近 10 次构建），而且切换版本或回滚需要几十秒甚至几分钟？  
本章深入拆解 **MyShip** 如何借鉴 Git 与 Docker 镜像层的思想，用 **三级解耦指针架构** 实现**“无限历史版本保留 + 0 毫秒原子切流”**。

---

## 一、传统“目录覆盖”模型 vs MyShip“三级指针”模型

### 1. 传统托管平台的瓶颈
传统平台在每次部署时，通常将构建产物整包上传并复制到 `/deployments/dpl_xxx/` 或直接覆盖 `/prod/` 目录：
- **存储膨胀快**：假设你的前端项目包含 5MB 的公共 JS/字体/图片，哪怕每次只改了 1 行文案，发布 100 次就会占用 500MB 存储。因此平台不得不强制清理早期版本。
- **切流与回滚慢**：回滚时需要重新复制文件或重新触发构建流水线，存在明显的生效延迟与中间态风险。

### 2. MyShip 的三级解耦寻址流程

```mermaid
flowchart LR
    Req["浏览器请求<br/>https://app1-v2.ship.example.com/index.html"] --> Edge["EdgeOne 边缘函数网关<br/>(myship-cas-router)"]
    Edge -- "1. 提取 Host 子域名 (app1-v2)<br/>实时读取 (no-cache)" --> Alias["COS: aliases/app1-v2.json<br/>{ deploymentId: 'dpl_4f788e9d' }"]
    Alias -- "2. 定位不可变版本清单" --> Manifest["COS: manifests/dpl_4f788e9d.json<br/>{ '/index.html': { sha256: '5adc23...' } }"]
    Manifest -- "3. 按内容哈希寻址" --> Blob["COS: blobs/5adc23fa1d...<br/>(真实文件内容块)"]
    Blob -- "4. 注入 Content-Type 与诊断头返回" --> Req
```

---

## 二、COS 存储桶内的三大核心命名空间

在你的腾讯云 COS 存储桶中，所有数据被严格划分为三个正交目录：

### 1. `blobs/<sha256>`（全局内容寻址去重池 · 永久不可变）
- 存放所有文件去掉文件名后的原始字节流，直接以文件内容的 `SHA-256` 哈希值命名。
- 在执行 `myship` 部署时，CLI 对本地每个文件计算 `SHA-256`，并发起 `HEAD /blobs/<sha256>` 探测：
  - **若返回 `200 OK`**：说明该文件块已在云端存在，**0 字节直接跳过上传**！
  - **若返回 `404`**：仅上传真正发生变化的增量文件块。
- 无论你手头有 10 个项目还是发布了 1,000 个版本，相同的公共依赖库、图标、字体在 COS 里永远只有 1 份。

### 2. `manifests/dpl_<id>.json`（构建快照清单 · 永久不可变）
- 记录某一次构建所属的项目命名空间（`project`）、文件树路径，以及每个路径对应的 `sha256`、`size` 和 `contentType`：
  ```json
  {
    "id": "dpl_4f788e9d",
    "project": "app1",
    "immutableSubdomain": "app1-4f788e9d",
    "createdAt": "2026-10-29T05:36:31.465Z",
    "stats": { "totalFiles": 12, "uploadedBlobs": 1, "reusedBlobs": 11 },
    "spaFallback": "/index.html",
    "files": {
      "/assets/vendor.js": {
        "sha256": "6f3ffee9d9...",
        "size": 142050,
        "contentType": "application/javascript; charset=UTF-8"
      },
      "/index.html": {
        "sha256": "5adc23fa1d...",
        "size": 2194,
        "contentType": "text/html; charset=UTF-8"
      }
    }
  }
  ```
- **为什么能保留无限个历史版本？** 因为每个构建快照清单只是一个约 `1KB` 的 JSON 文件！保留 10,000 个历史构建清单仅占约 `10MB` 空间，成本几乎为零。

### 3. `aliases/<subdomain>.json`（动态域名路由指针表 · 极小可变）
- 每个子域名对应一个仅约 `80 字节` 的轻量指针文件：
  ```json
  {
    "subdomain": "app1",
    "project": "app1",
    "deploymentId": "dpl_4f788e9d",
    "updatedAt": "2026-10-29T05:36:32.100Z"
  }
  ```
- **为什么切流和回滚是 0 秒？**
  当你执行 `myship rollback` 或 `myship alias v2 dpl_6e46ed99` 时，根本不需要搬运任何静态文件，只需用 50ms 改写这 80 字节的 JSON。由于边缘函数对 `aliases/` 采用 `no-cache` 实时读取，全球访问该子域名的下一秒请求即刻命中目标版本！

---

## 三、SPA History 路由与缓存控制策略

### 1. 原生支持 Vue / React History 路由模式
许多前端单页应用（SPA）开启了 `HTML5 History` 路由（如访问 `/users/profile`）。在 `MyShip` 中：
1. 若请求路径精确命中 `manifest.files[reqPath]`（如 `/assets/app.js`），直接返回对应文件块；
2. 若未命中且请求路径不含文件扩展名（如 `/users/profile`），边缘网关会自动回退读取构建产物中的 `/200.html` 或 `/index.html`，让前端路由无缝接管，绝不会出现刷新页面报 `404` 的问题。

### 2. 智能分级缓存头 (`Cache-Control`)
- **HTML 入口文件 (`text/html`)**：自动注入 `Cache-Control: no-cache, no-store, must-revalidate`，确保每次执行 `myship rollback` 或发布新版后，用户刷新浏览器立刻看到最新页面。
- **静态资源文件 (JS / CSS / 图片 / 字体)**：自动注入 `Cache-Control: public, max-age=3600`（本地网关为 `immutable`），充分利用边缘节点与浏览器缓存加速加载。
