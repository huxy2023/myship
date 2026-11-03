# MyShip CLI Automation, CI/CD & Troubleshooting Runbook

This reference provides non-interactive CLI commands, CI/CD workflow recipes, and diagnostic steps for AI coding agents.

---

## 1. Non-Interactive CLI Command Cheat Sheet

| Goal | Command |
| :--- | :--- |
| **Check auth, project namespace & resource bindings** | `myship whoami` |
| **Initialize project config (`.myship/project.json`)** | `myship init [project-name] [--scf]` |
| **Deploy current project to production** (`<project>.ship.<domain>`) | `myship` |
| **Deploy custom build directory** | `myship ./dist` (or `myship --dir ./dist`) |
| **Deploy to preview environment** (`<project>-<env>.ship.<domain>`) | `myship -d staging` or `myship ./dist v2` |
| **Deploy without project prefix** (`<subdomain>.ship.<domain>`) | `myship --raw -d custom-sub` |
| **Enable full-stack Node.js SCF backend** | `myship backend enable [--entry server/index.mjs]` |
| **Disable full-stack SCF backend** | `myship backend disable` |
| **Check SCF backend & cloud readiness** | `myship backend status` |
| **Bind COS object & file storage** | `myship use storage [--env prod\|staging]` |
| **Bind Serverless Database (non-interactive)** | `myship use db --provider <pg\|neon\|turso\|d1\|mysql>` |
| **Inspect bound storage & DB status** | `myship use status` |
| **Set / list / remove project environment variables** | `myship env set KEY=VAL` / `myship env ls [--reveal]` / `myship env rm KEY` |
| **Import `.env` file to cloud** | `myship env import .env` |
| **View real-time cloud SCF logs (with SourceMap)** | `myship logs [--limit 30] [--error]` |
| **List current project deployments & aliases** | `myship ls` (or `myship ls --all` for all projects) |
| **0ms atomic rollback (frontend + SCF backend)** | `myship rollback [subdomain] [--to dpl_xxx]` |
| **0ms alias traffic switch** | `myship alias <subdomain> <dpl_id>` |
| **Dry-run garbage collection** | `myship gc --keep 10 --dry-run` |
| **Generate GitHub Actions CI/CD + PR preview workflow** | `myship init --ci [--sync-secrets]` |
| **Install MyShip AI Skill (`myship-skill`)** | `myship skill install [--global]` |

---

## 2. Diagnostic & Troubleshooting Runbook

### Issue 1: Frontend `PUT` to COS `presignUrl` fails with HTTP 403 `SignatureDoesNotMatch`
- **Root Cause**: The browser or frontend code attached extra headers or modified the presigned URL query parameters, OR an older gateway intercepted the request.
- **Fix**:
  1. Ensure `presignUrl(key, { method: 'PUT' })` is called for upload and `method: 'GET'` for download.
  2. In frontend `fetch(uploadUrl, { method: 'PUT', body: file })`, remove custom headers so the browser sends a clean `PUT` request matching `q-header-list=host`.
  3. Redeploy with `myship` so the latest runtime is active on SCF.

### Issue 2: `context.db` or new environment variable is `undefined` in cloud SCF after `myship use` or `myship env set`
- **Root Cause**: Tencent Cloud SCF versions (`manifest.backend.version`) are immutable snapshots. Updating COS `envs/<project>.json` does not mutate an already-published SCF version.
- **Fix**: Run `myship` to publish a new deployment snapshot (`dpl_<id>`) which bundles and freezes the latest environment variables into a new SCF version.

### Issue 3: `myship logs --error` shows a 500 error in `server/index.mjs`
- **Diagnosis**:
  1. Run `myship logs --error --limit 20`.
  2. Because MyShip compiles `server/index.mjs` with `sourcemap: 'inline'` and launches SCF with `NODE_OPTIONS=--enable-source-maps`, the stack trace points directly to your original source file and line number (e.g. `server/index.mjs:122:25`).
  3. Check if a PostgreSQL query accidentally used `?` instead of `$1, $2` (or vice versa for SQLite/Turso/MySQL).

### Issue 4: Custom build directory or backend config missing when deploying
- **Diagnosis**: Check `.myship/project.json` in the project root.
- **Fix**: Ensure `.myship/project.json` specifies `"dir": "./dist"` (if not auto-detected) and `"backend": { "enabled": true, "runtime": "scf-node", "entry": "server/index.mjs" }`.
