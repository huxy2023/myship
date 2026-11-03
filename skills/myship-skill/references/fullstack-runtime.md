# MyShip Full-Stack Runtime & Multi-DB Reference

This reference covers the complete runtime APIs injected into `server/index.mjs` (Tencent Cloud SCF Node.js Web Function & `myship dev`) and `api/*.js` (EdgeOne V8 Isolates).

---

## 1. Full-Stack Entry Signatures (`server/index.mjs`)

MyShip's bundler (`scf-bundler.mjs`) supports three export styles out of the box:

### Style A: Web Standard `fetch(request, context)` (Recommended)
```javascript
export async function fetch(request, context) {
  return Response.json({
    ok: true,
    project: context.project,
    deploymentId: context.deploymentId,
  });
}
```

### Style B: Hono / Web Framework Default Export (`export default app`)
```javascript
import { Hono } from 'hono';
const app = new Hono();

app.get('/api/hello', async (c) => {
  const ctx = c.env; // MyShip injects `context` as the second arg `env` in `app.fetch(request, context)`
  const { rows } = await ctx.db.query('SELECT 1 AS ok');
  return c.json({ ok: true, rows });
});

export default app;
```

### Style C: Method-Named Exports (`GET`, `POST`, `PUT`, `DELETE`)
```javascript
export async function GET(request, context) {
  return Response.json({ ok: true });
}
```

---

## 2. The `context` Object Specification

Every request to `server/index.mjs` receives `context` with the following properties:

| Property | Type | Description |
| :--- | :--- | :--- |
| `context.project` | `string` | Normalized project namespace (e.g. `'fullstack-starter'`) |
| `context.subdomain` | `string` | Active subdomain token handling the request |
| `context.deploymentId` | `string` | Immutable deployment snapshot ID (`dpl_<hash>`) |
| `context.env` | `Record<string, string>` | Project environment variables + injected resource credentials |
| `context.storage` | `StorageClient` | JSON KV store isolated under `data/<project>/<key>.json` |
| `context.files` | `FileStorageClient` | Binary object store isolated under `files/<project>/<key>` |
| `context.db` | `DatabaseClient` | Unified multi-engine SQL client (`pg`, `cloudbase-pg`, `neon`, `turso`, `d1`, `mysql`, `sqlite`) |
| `context.clientIp` | `string` | Client IP forwarded from EdgeOne gateway |

---

## 3. `context.db` — Unified Multi-Engine SQL Client

### 3.1 Supported Providers & Multi-Project Isolation
| Provider ID (`db.provider`) | Cloud Engine | Physical Multi-Project Isolation | SQL Parameter Placeholder |
| :--- | :--- | :--- | :--- |
| `'pg'` / `'cloudbase-pg'` | Native PostgreSQL / Tencent CloudBase PG | Dedicated Schema `myship_<project>` (`SET LOCAL search_path`) | `$1, $2, $3` (also auto-converts `?`) |
| `'neon'` | Neon Serverless PostgreSQL | Dedicated Schema `myship_<project>` | `$1, $2, $3` (also auto-converts `?`) |
| `'turso'` | Turso libSQL / Edge SQLite | Dedicated Database `myship-<project>` | `?, ?, ?` |
| `'d1'` | Cloudflare D1 Serverless SQLite | Dedicated Database `myship-<project>` | `?, ?, ?` |
| `'mysql'` | MySQL 8 / Tencent TDSQL-C | Dedicated Database `myship_<project>` | `?, ?, ?` |
| `'sqlite'` | Local `node:sqlite` (`myship dev` default) | Local file `.myship/data/<project>/local.sqlite` | `?, ?, ?` |

### 3.2 `context.db` Methods
- **`await context.db.query(sql, params = [])`** (Alias: `all`):
  - Returns an Array of row objects `rows` with non-enumerable metadata properties attached:
    - `result.rows` (`Array<Object>` — points to the array itself, so both `const rows = await db.query(...)` and `const { rows } = await db.query(...)` work!)
    - `result.rowsAffected` (`number`)
    - `result.lastInsertRowid` (`number | null`)
- **`await context.db.execute(sql, params = [])`** (Aliases: `exec`, `run`):
  - Executes DDL/DML (`CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE`) and returns the same dual-compatible result object.
- **`await context.db.first(sql, params = [])`**:
  - Returns the first row object or `null`.
- **`await context.db.batch(statements)`**:
  - Executes an array of `{ sql, params }` or `string` statements in sequence/batch.

---

## 4. `context.files` — Binary Object Storage & Presigned URLs

Isolated per project at COS prefix `files/<project>/<key>` (or locally at `.myship/files/<project>/<key>` during `myship dev`).

- **`await context.files.put(key, bufferOrString, { contentType })`**:
  - Uploads binary `Buffer`, `Uint8Array`, `ArrayBuffer`, or `string`.
  - Returns `{ key, size, contentType }`.
- **`await context.files.get(key, options = {})`**:
  - Returns a Node.js `Buffer` (with `.contentType` and `.size` properties attached), or `null` if not found.
  - If `options.type === 'text'`, returns a UTF-8 `string`; if `options.type === 'json'`, returns the parsed JSON value.
  - Example download response:
    ```javascript
    const buf = await context.files.get('uploads/avatar.png');
    if (!buf) return Response.json({ ok: false }, { status: 404 });
    return new Response(buf, { headers: { 'Content-Type': buf.contentType || 'application/octet-stream' } });
    ```
- **`await context.files.delete(key)`**:
  - Deletes the object and returns `true`.
- **`await context.files.list(prefix = '')`**:
  - Lists object keys under the project's `files/<project>/` namespace.
- **`await context.files.presignUrl(key, { method = 'GET', expiresSec = 900, expiresIn })`**:
  - Generates a Tencent Cloud COS V5 presigned URL (`GET` or `PUT`) valid for `expiresSec` (or `expiresIn`) seconds.
  - During `myship dev`, automatically returns a local dev-server URL (`/_myship_files/<project>/<key>?method=PUT&expires=...`) so frontend direct-upload code works identically in local development and production!

---

## 5. `context.storage` — Lightweight JSON KV Store

Isolated per project at COS prefix `data/<project>/<key>.json` (or `.myship/data/<project>/<key>.json` locally).

- **`await context.storage.get(key, defaultValue = null)`**: Reads parsed JSON value.
- **`await context.storage.set(key, jsonValue)`**: Persists JSON-serializable value.
- **`await context.storage.delete(key)`**: Removes key.
- **`await context.storage.list(prefix = '')`**: Lists keys.

---

## 6. Edge V8 Functions (`api/*.js`)

For projects without SCF backend enabled, files in `api/*.js` are compiled into the project's EdgeOne V8 Worker:
- Supports `export async function GET(request, context)` / `POST` or EdgeOne's `export async function onRequestGet(context)`.
- Has access to Web standard `fetch`, `crypto.subtle`, `TextEncoder`, and `context.env` (injected from `myship env`).
- Does **not** have access to Node.js `fs`/`net` or TCP database drivers (`pg`/`mysql2`).
