import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertCloudEndpointsConfigured,
  loadTencentCredentials,
} from './cos-client.mjs';
import {
  normalizeDomainToken,
  detectProjectContext,
  ensureProjectConfig,
} from './project-context.mjs';

export function generateGitHubWorkflowYaml({ project = 'app', buildDir = './dist' } = {}) {
  const cleanProj = normalizeDomainToken(project) || 'app';
  const cleanDir = String(buildDir || './dist').trim() || './dist';

  return `name: MyShip Deploy & PR Preview

on:
  push:
    branches: [main, master]
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install & Build (if package.json has build script)
        run: |
          if [ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts.build ? 0 : 1)"; then
            if [ -f pnpm-lock.yaml ]; then
              corepack enable && pnpm install --frozen-lockfile && pnpm run build
            elif [ -f package-lock.json ]; then
              npm ci && npm run build
            else
              npm install && npm run build
            fi
          else
            echo "No build script detected in package.json, skipping build step."
          fi

      - name: Deploy to MyShip EdgeOne & COS
        id: deploy
        env:
          MYSHIP_SECRET_ID: \${{ secrets.MYSHIP_SECRET_ID }}
          MYSHIP_SECRET_KEY: \${{ secrets.MYSHIP_SECRET_KEY }}
          MYSHIP_TOKEN: \${{ secrets.MYSHIP_TOKEN }}
          COS_ORIGIN: \${{ secrets.COS_ORIGIN }}
          SHIP_REMOTE_DOMAIN: \${{ secrets.SHIP_REMOTE_DOMAIN }}
          EVENT_NAME: \${{ github.event_name }}
          PR_NUMBER: \${{ github.event.number }}
          MYSHIP_PROJECT: ${JSON.stringify(cleanProj)}
          MYSHIP_DIR: ${JSON.stringify(cleanDir)}
        run: |
          if [ -z "$MYSHIP_SECRET_ID" ] || [ -z "$COS_ORIGIN" ]; then
            echo "⚠️ MyShip secrets (MYSHIP_SECRET_ID / COS_ORIGIN) not available in this context. Skipping deployment."
            exit 0
          fi
          if [ "$EVENT_NAME" = "pull_request" ]; then
            npx --yes github:huxy2023/myship "$MYSHIP_DIR" -d "pr-\${PR_NUMBER}" -p "$MYSHIP_PROJECT"
          else
            npx --yes github:huxy2023/myship "$MYSHIP_DIR" -p "$MYSHIP_PROJECT"
          fi

      - name: Post PR Preview Comment
        if: github.event_name == 'pull_request' && steps.deploy.outputs.primary_url != ''
        uses: actions/github-script@v7
        env:
          PREVIEW_URL: \${{ steps.deploy.outputs.primary_url }}
          IMMUTABLE_URL: \${{ steps.deploy.outputs.immutable_url }}
          DEPLOYMENT_ID: \${{ steps.deploy.outputs.deployment_id }}
          FUNCTIONS_LIST: \${{ steps.deploy.outputs.functions }}
          COMMIT_SHA: \${{ github.event.pull_request.head.sha }}
        with:
          script: |
            const marker = '<!-- myship-pr-preview -->';
            const previewUrl = process.env.PREVIEW_URL;
            const immutableUrl = process.env.IMMUTABLE_URL;
            const deploymentId = process.env.DEPLOYMENT_ID;
            const fnList = process.env.FUNCTIONS_LIST || '无 (纯静态)';
            const shortSha = (process.env.COMMIT_SHA || '').slice(0, 7);
            const body = [
              marker,
              '### 🚀 MyShip PR Preview Deployed!',
              '',
              '| 维度 | 访问链接 / 详情 |',
              '| :--- | :--- |',
              \`| 🌐 **PR 预览域名 (随最新提交自动更新)** | [\${previewUrl}](\${previewUrl}) |\`,
              \`| 🔒 **本次构建永久不可变快照** | [\${immutableUrl}](\${immutableUrl}) (\\\`\${deploymentId}\\\`) |\`,
              \`| ⚡ **边缘 Serverless 云函数** | \\\`\${fnList}\\\` |\`,
              \`| 📌 **触发提交 (Commit)** | \\\`\${shortSha}\\\` |\`,
            ].join('\\n');

            const { owner, repo } = context.repo;
            const issue_number = context.issue.number;
            const { data: comments } = await github.rest.issues.listComments({
              owner,
              repo,
              issue_number,
            });
            const existing = comments.find((c) => c.body && c.body.includes(marker));
            if (existing) {
              await github.rest.issues.updateComment({
                owner,
                repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner,
                repo,
                issue_number,
                body,
              });
            }
`;
}

export function setupCiWorkflow(
  cwd = process.cwd(),
  { project = null, dir = null, syncSecrets = false, overwrite = false } = {}
) {
  const ctx = detectProjectContext(cwd, project);
  let hasBuildScript = false;
  const pkgJsonPath = resolve(cwd, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      hasBuildScript = Boolean(pkg?.scripts?.build);
    } catch {
      // ignore
    }
  }

  let targetDir = dir || ctx.buildDir;
  if (!dir && !ctx.hasSavedConfig && !hasBuildScript) {
    if (
      (!targetDir || !existsSync(resolve(cwd, targetDir))) &&
      existsSync(resolve(cwd, 'index.html'))
    ) {
      targetDir = '.';
    }
  }
  const cfg =
    ctx.hasSavedConfig && !project && !dir
      ? { ...ctx, dir: ctx.buildDir || './dist' }
      : ensureProjectConfig(cwd, {
          ...(project ? { project } : {}),
          dir: targetDir || './dist',
        });

  const workflowsDir = resolve(cwd, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  const workflowPath = resolve(workflowsDir, 'myship.yml');
  const alreadyExists = existsSync(workflowPath);

  if (alreadyExists && !overwrite) {
    console.log(
      `⚡ 检测到已有工作流文件，已保留现有配置: ${workflowPath} (如需强制重新生成请加 --force)`
    );
  } else {
    const yamlContent = generateGitHubWorkflowYaml({
      project: cfg.project,
      buildDir: cfg.dir,
    });
    writeFileSync(workflowPath, yamlContent, 'utf8');
    console.log(`✅ 已生成 GitHub Actions 自动部署与 PR 预览工作流: ${workflowPath}`);
    console.log(`   🏷️  绑定项目: ${cfg.project} | 📁 默认构建目录: ${cfg.dir}`);
    console.log(`   🌐 Push main/master -> 自动更新 https://${cfg.prodDomain}.<domain>`);
    console.log(
      `   🔍 Pull Request #N  -> 自动发布 https://${cfg.project}-pr-<N>.<domain> 并评论预览卡片`
    );
  }

  const syncedSecretKeys = [];
  if (syncSecrets) {
    const { cosOrigin, remoteDomain } = assertCloudEndpointsConfigured();
    const cred = loadTencentCredentials();
    const secretsToPush = {
      MYSHIP_SECRET_ID: cred.secretId,
      MYSHIP_SECRET_KEY: cred.secretKey,
      COS_ORIGIN: cosOrigin,
      SHIP_REMOTE_DOMAIN: remoteDomain,
    };
    if (cred.token) {
      secretsToPush.MYSHIP_TOKEN = cred.token;
    }

    for (const [k, v] of Object.entries(secretsToPush)) {
      const res = spawnSync('gh', ['secret', 'set', k], {
        cwd,
        input: String(v),
        encoding: 'utf8',
      });
      if (res.status !== 0) {
        throw new Error(
          `通过 gh secret set 同步密钥 [${k}] 失败: ${(res.stderr || res.stdout || '').trim()}`
        );
      }
      syncedSecretKeys.push(k);
    }
    if (!cred.token) {
      spawnSync('gh', ['secret', 'remove', 'MYSHIP_TOKEN'], {
        cwd,
        encoding: 'utf8',
      });
    }
    console.log(
      `🔐 已通过 GitHub CLI 自动将云端密钥同步至当前仓库 Secrets: ${syncedSecretKeys.join(', ')}`
    );
    if (cred.token) {
      console.log(
        `💡 提示: 当前同步的是临时凭证 (含 MYSHIP_TOKEN)；若需长期无人值守 CI，后续可换用 CAM 子账号密钥再次执行 --sync-secrets。`
      );
    }
  } else {
    console.log(
      `💡 提示: 如需一键把本机云端配置写入 GitHub 仓库 Secrets，可执行 \`myship init --ci --sync-secrets\`。`
    );
  }

  return {
    workflowPath,
    project: cfg.project,
    buildDir: cfg.dir,
    syncedSecretKeys,
    preservedExistingWorkflow: alreadyExists && !overwrite,
  };
}
