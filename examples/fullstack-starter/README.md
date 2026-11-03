# ⚡ MyShip Full-Stack Starter (`@myship/fullstack-starter`)

这是 **MyShip** 官方提供的**全栈黄金样板工程**，在一个极简目录内完整展示了 MyShip 的四大核心全栈能力：

1. **静态前端 (`public/index.html`)**：通过 CAS 内容寻址去重部署至 EdgeOne 泛域名网关。
2. **SCF Web 函数全栈后端 (`server/index.mjs`)**：基于 Web Standard `fetch(request, context)` 契约，支持 `esbuild` 内联 SourceMap 与静态资产复制（`server/templates/banner.txt`）。
3. **内置持久化存储 (`context.storage` & `context.files`)**：
   - `context.storage`：JSON KV 状态存储（云端私有保存于 COS `data/<project>/counter.json`）。
   - `context.files`：二进制文件读写与前端预签名直传 URL 生成（COS `files/<project>/`）。
4. **多引擎统一数据库 (`context.db`)**：自动适配 PostgreSQL (`pg` / `neon`)、SQLite (`turso` / `d1` / 本地 `node:sqlite`) 与 MySQL (`mysql`)。

---

## 快速运行

```bash
# 1. 运行自动化本地全链路自测 (启动 myship dev + 校验 4 类 API + 校验 esbuild 打包)
pnpm --filter @myship/fullstack-starter test:local

# 2. 启动本地全栈热重载开发服务 (默认 http://localhost:3000)
cd examples/fullstack-starter
myship dev

# 3. 交互式绑定云数据库 (可选: CloudBase PG / Neon / Turso / D1 / MySQL) 并一键发布上云
myship use
myship
```
