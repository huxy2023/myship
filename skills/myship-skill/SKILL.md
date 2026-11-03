---
name: myship-skill
description: >-
  Comprehensive AI Vibecoding skill for MyShip (open-source BYOC full-stack deployment & cloud resource orchestration engine on Tencent Cloud EdgeOne, COS, SCF, and Serverless Databases).
  Activate this skill whenever the user wants to initialize, build, debug, or deploy static sites, edge functions (api/*.js), full-stack Node.js backends (server/index.mjs), or provision/query databases (context.db) and object storage (context.files / context.storage) using MyShip (`myship`, `myship dev`, `myship use`, `myship backend`, `myship logs`, `myship rollback`).
---

# MyShip Full-Stack Vibecoding Skill (`myship-skill`)

> **Slogan**: 自有云海，一令启航 (`Your Cloud. Your Fleet. One Command to Ship.`)

MyShip is a self-hosted BYOC full-stack deployment and resource orchestration platform built on the user's own Tencent Cloud **EdgeOne** (`*.ship.<domain>` wildcard gateway), **COS** (SHA-256 Content-Addressed Storage), **SCF** (Node.js Web Functions), and **5 Serverless Databases** (CloudBase PG, Neon, Turso, Cloudflare D1, MySQL).

---

## 1. Architecture Selection Decision Tree

Before writing code, select the minimal sufficient runtime tier for the user's project:

| Scenario | Recommended Tier | Entry Convention | Key Command |
| :--- | :--- | :--- | :--- |
| **Pure Static / SPA / Docs** (HTML, Vite, React, Vue, Next Static) | **Tier 1: CAS Static** | Build output dir (`dist/`, `build/`, `public/`, or `.`) | `myship` |
| **Lightweight Edge API** (WebCrypto, GeoIP, stateless JSON, <8MB payload, no TCP DB) | **Tier 2: Edge V8 Isolate** | `api/<route>.js` (`GET` / `POST` or `onRequestGet`) | `myship` (auto-detected) |
| **Full-Stack App / Database / File Upload / Node NPM Packages** (Hono, `pg`, `mysql2`, `fs`, SSE, `context.db`, `context.files`) | **Tier 3: SCF Full-Stack Node.js** | `server/index.mjs` (`export async function fetch(request, context)` or Hono `export default app`) | `myship backend enable` + `myship` |

---

## 2. Standard 5-Step Vibecoding Workflow

1. **Inspect Context, Auth & Optional Scaffolding (`whoami` / `init --template`)**:
   ```bash
   myship whoami
   # If starting in an empty directory, scaffold a ready-to-run template:
   myship init --template fullstack   # or: static | edge
   ```
   Verify `~/.myship/config.json` is authenticated and check `.myship/project.json` for project name, custom `dir`, `backend`, and `resources`.

2. **Bind Cloud Resources Declaratively (`myship use`)**:
   - **Object & File Storage (`context.storage` + `context.files`)**:
     ```bash
     myship use storage
     ```
   - **Serverless Database (`context.db`)**:
     - Interactive TTY (for human terminals): `myship use db`
     - Non-interactive (preferred for AI Agents):
       ```bash
       # Pick one based on user's configured database in ~/.myship/config.json:
       myship use db --provider pg      # Tencent CloudBase PG / Native PostgreSQL (auto-creates schema myship_<project>)
       myship use db --provider neon    # Neon Serverless PG (auto-creates schema myship_<project>)
       myship use db --provider turso   # Turso Edge SQLite (auto-creates db myship-<project>)
       myship use db --provider d1      # Cloudflare D1 (auto-creates db myship-<project>)
       myship use db --provider mysql   # MySQL 8 / TDSQL-C (auto-creates database myship_<project>)
       ```
   - **Enable Full-Stack Node.js Backend (`SCF`)**:
     ```bash
     myship backend enable --entry server/index.mjs
     ```

3. **Write Isomorphic Full-Stack Code (`server/index.mjs`)**:
   Use the unified `fetch(request, context)` signature. Both `myship dev` (local) and Tencent Cloud SCF (production) inject the exact same `context` object:
   - `context.db`: SQL client (`query`, `execute`, `batch`, `first`, `provider`)
   - `context.files`: Binary object storage (`put`, `get`, `delete`, `list`, `presignUrl`)
   - `context.storage`: JSON KV store (`get`, `set`, `delete`, `list`)
   - `context.env`: Merged environment variables

4. **Verify Locally with Hot-Reload (`myship dev`)**:
   ```bash
   myship dev --port 3000
   ```
   Locally, `context.db` defaults to zero-config `node:sqlite` (`.myship/data/<project>/local.sqlite`) unless cloud DB env vars are active, and `context.files` / `context.storage` persist under `.myship/`.

5. **Deploy, Inspect Logs & Instant Rollback**:
   ```bash
   myship                       # Deploy static + backend snapshot (dpl_<id>) and switch production alias in 0ms
   myship -d staging            # Deploy to preview subdomain https://<project>-staging.ship.<domain>
   myship logs --error          # Inspect real cloud SCF logs with inline SourceMap line numbers
   myship rollback              # 0ms atomic rollback of both frontend and SCF backend version
   ```

---

## 3. Golden Code Patterns (Copy-Paste Ready)

### 3.1 Cross-Dialect `context.db` Pattern (`server/index.mjs`)
Always write SQL that handles both PostgreSQL (`pg` / `cloudbase-pg` / `neon`, which uses `$1, $2` and `SERIAL`) and SQLite/MySQL (`turso` / `d1` / `sqlite` / `mysql`, which uses `?, ?`):

```javascript
export async function fetch(request, context) {
  const url = new URL(request.url);
  const db = context.db;
  const provider = String(db?.provider || 'sqlite').toLowerCase();
  const isPg =
    provider === 'pg' ||
    provider === 'cloudbase-pg' ||
    provider === 'neon' ||
    provider === 'postgres';

  // 1. Idempotent table initialization
  if (isPg) {
    await db.execute(`CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL)`);
  } else if (provider === 'mysql') {
    await db.execute(`CREATE TABLE IF NOT EXISTS items (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NOT NULL, created_at VARCHAR(64) NOT NULL)`);
  } else {
    await db.execute(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }

  // 2. Parameterized INSERT ($1,$2 for PG vs ?,? for SQLite/Turso/D1/MySQL)
  if (request.method === 'POST' && url.pathname === '/api/items') {
    const { title } = await request.json();
    const sql = isPg
      ? 'INSERT INTO items (title, created_at) VALUES ($1, $2)'
      : 'INSERT INTO items (title, created_at) VALUES (?, ?)';
    await db.execute(sql, [title, new Date().toISOString()]);
  }

  // 3. SELECT query (returns array with non-enumerable .rows property — supports both `const { rows } = await db.query(...)` and `const rows = await db.query(...)`)
  const { rows } = await db.query('SELECT id, title, created_at FROM items ORDER BY id DESC LIMIT 20');
  return Response.json({ ok: true, provider, items: rows });
}
```

### 3.2 Direct-to-COS Presigned Upload Pattern (`context.files.presignUrl`)
Backend endpoint (`server/index.mjs`):
```javascript
if (url.pathname === '/api/files/presign' && request.method === 'POST') {
  const { key } = await request.json();
  const uploadUrl = await context.files.presignUrl(key, { method: 'PUT', expiresSec: 600 });
  const downloadUrl = await context.files.presignUrl(key, { method: 'GET', expiresSec: 3600 });
  return Response.json({ ok: true, key, uploadUrl, downloadUrl });
}
```
Frontend upload (`PUT` to `uploadUrl`):
```javascript
// CRITICAL: Do NOT set custom headers (like Content-Type) on the PUT request to COS presigned URLs unless signed!
const putRes = await fetch(uploadUrl, {
  method: 'PUT',
  body: fileOrBlob,
});
```

---

## 4. Six Unbreakable Guardrails (Avoid Common Pitfalls)

1. **COS Presigned URL Signature Rule (`SignatureDoesNotMatch` Prevention)**:
   - `context.files.presignUrl(key, { method: 'PUT' })` signs **only the `Host` header** (`q-header-list=host`) for maximum browser compatibility.
   - When the frontend `fetch(uploadUrl, { method: 'PUT', body })` uploads a file, **DO NOT manually attach `headers: { 'Content-Type': ... }` or custom `x-cos-*` headers** unless necessary, and never tamper with the query string of `uploadUrl`.
2. **Environment Variable Immutability on SCF (`myship env set`)**:
   - Running `myship env set KEY=VAL` updates the encrypted COS env file immediately.
   - Edge functions (`api/*.js`) pick up new env vars within seconds, **but full-stack SCF backends (`server/index.mjs`) freeze environment variables into each immutable SCF version (`manifest.backend.version`)**. After changing env vars or running `myship use`, you **MUST run `myship`** to publish a new deployment snapshot for SCF to receive them.
3. **Edge V8 (`api/*.js`) vs. Node.js SCF (`server/index.mjs`) Boundary**:
   - `api/*.js` runs in Tencent EdgeOne V8 Isolates (no Node `fs`, `net`, `tls`, TCP sockets, and max 8MB response body).
   - Any code using `pg`, `mysql2`, `context.db`, `context.files`, or Node built-ins **must live in `server/index.mjs`** with `myship backend enable`.
4. **Static Asset Reading inside `server/index.mjs`**:
   - `myship` bundles `server/index.mjs` into a single ESM file via `esbuild` and preserves non-code assets (`.txt`, `.json`, `.sql`, `.html`) under `server/**`.
   - Always read backend static files using `readFileSync(new URL('./templates/file.txt', import.meta.url), 'utf-8')`.
5. **Cross-Project Flag (`--project` / `-p`) Caution**:
   - Passing `myship --project <other>` deploys the current directory into `<other>` while keeping the current directory's `.myship/project.json` (`dir`, `backend`, `resources`). To merely inspect all projects without modifying config, run `myship ls --all`.
6. **Production Data Safety**:
   - Before running `myship rm --project <name>`, `myship gc` (without `--dry-run`), or destructive SQL (`DROP` / `TRUNCATE`), always run `--dry-run` first or ask the user for confirmation.

---

## 5. Deep-Dive Reference Manuals

Load these reference files on demand when you need detailed API signatures or troubleshooting runbooks:
- **[Full-Stack Runtime & Multi-DB Reference](./references/fullstack-runtime.md)**: Complete `context.db`, `context.files`, `context.storage`, Hono integration, and EdgeOne `api/*.js` specifications.
- **[CLI Automation, CI/CD & Troubleshooting Runbook](./references/cli-and-ops.md)**: Complete non-interactive CLI flags, GitHub Actions CI setup, SourceMap log debugging, and error resolution table.
