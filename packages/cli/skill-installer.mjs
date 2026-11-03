/**
 * skill-installer.mjs — MyShip AI Vibecoding 专属技能包 (myship-skill) 安装与状态管理器
 *
 * 支持一键将内置的高密度 `myship-skill` (SKILL.md + references/) 注入到：
 * 1. 当前项目工作区 (`.agents/skills/myship-skill/`) — 供团队 Git 共享及 Antigravity / Cursor / OpenCode 自动发现
 * 2. 本机全局 AI 代理目录 (`--global` / `-g`)：
 *    - Google Antigravity: `~/.gemini/config/skills/myship-skill/`
 *    - Universal Agent Skills: `~/.agents/skills/myship-skill/`
 *    - Claude Code: `~/.claude/skills/myship-skill/` (当检测到 ~/.claude 或显式指定时)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BUILTIN_SKILL_SOURCE_DIR = resolve(__dirname, '../../skills/myship-skill');

function copyDirectoryRecursive(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  const copiedFiles = [];
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copiedFiles.push(...copyDirectoryRecursive(srcPath, destPath));
    } else if (st.isFile()) {
      writeFileSync(destPath, readFileSync(srcPath));
      copiedFiles.push(destPath);
    }
  }
  return copiedFiles;
}

export function installMyShipSkill({
  cwd = process.cwd(),
  global = false,
  homeDir = homedir(),
  includeClaude = false,
} = {}) {
  if (!existsSync(join(BUILTIN_SKILL_SOURCE_DIR, 'SKILL.md'))) {
    throw new Error(`未找到内置技能包源文件: ${BUILTIN_SKILL_SOURCE_DIR}/SKILL.md`);
  }

  const installedTargets = [];

  if (global) {
    const agyGlobalDir = resolve(homeDir, '.gemini', 'config', 'skills', 'myship-skill');
    const universalGlobalDir = resolve(homeDir, '.agents', 'skills', 'myship-skill');
    copyDirectoryRecursive(BUILTIN_SKILL_SOURCE_DIR, agyGlobalDir);
    installedTargets.push({ agent: 'Google Antigravity (Global)', path: agyGlobalDir });

    copyDirectoryRecursive(BUILTIN_SKILL_SOURCE_DIR, universalGlobalDir);
    installedTargets.push({ agent: 'Universal Agent Skills (Global)', path: universalGlobalDir });

    const claudeRoot = resolve(homeDir, '.claude');
    if (includeClaude || existsSync(claudeRoot)) {
      const claudeSkillDir = resolve(claudeRoot, 'skills', 'myship-skill');
      copyDirectoryRecursive(BUILTIN_SKILL_SOURCE_DIR, claudeSkillDir);
      installedTargets.push({ agent: 'Claude Code (Global)', path: claudeSkillDir });
    }
  } else {
    const workspaceSkillDir = resolve(cwd, '.agents', 'skills', 'myship-skill');
    copyDirectoryRecursive(BUILTIN_SKILL_SOURCE_DIR, workspaceSkillDir);
    installedTargets.push({ agent: 'Workspace (.agents/skills)', path: workspaceSkillDir });
  }

  return {
    ok: true,
    scope: global ? 'global' : 'workspace',
    sourceDir: BUILTIN_SKILL_SOURCE_DIR,
    targets: installedTargets,
  };
}

export function getMyShipSkillStatus({
  cwd = process.cwd(),
  homeDir = homedir(),
} = {}) {
  const workspacePath = resolve(cwd, '.agents', 'skills', 'myship-skill', 'SKILL.md');
  const agyGlobalPath = resolve(homeDir, '.gemini', 'config', 'skills', 'myship-skill', 'SKILL.md');
  const universalGlobalPath = resolve(homeDir, '.agents', 'skills', 'myship-skill', 'SKILL.md');
  const claudeGlobalPath = resolve(homeDir, '.claude', 'skills', 'myship-skill', 'SKILL.md');

  return {
    workspace: {
      installed: existsSync(workspacePath),
      path: dirname(workspacePath),
    },
    globalAntigravity: {
      installed: existsSync(agyGlobalPath),
      path: dirname(agyGlobalPath),
    },
    globalUniversal: {
      installed: existsSync(universalGlobalPath),
      path: dirname(universalGlobalPath),
    },
    globalClaude: {
      installed: existsSync(claudeGlobalPath),
      path: dirname(claudeGlobalPath),
    },
  };
}

export function runSkillCommand(subAction = 'install', options = {}) {
  const action = String(subAction || 'install').toLowerCase();
  const cwd = options.cwd || process.cwd();
  const isGlobal = Boolean(options.global);
  const homeDir = options.homeDir || homedir();

  if (action === 'status' || action === 'ls' || action === 'check') {
    const status = getMyShipSkillStatus({ cwd, homeDir });
    console.log('==============================================================');
    console.log('🤖 MyShip AI Vibecoding Skill (myship-skill) 安装状态');
    console.log('==============================================================');
    console.log(
      `  📂 当前工程工作区 (.agents/skills):  ${status.workspace.installed ? '✅ 已安装' : '⚪ 未安装'} (${status.workspace.path})`
    );
    console.log(
      `  🌐 Antigravity 全局技能目录:         ${status.globalAntigravity.installed ? '✅ 已安装' : '⚪ 未安装'} (${status.globalAntigravity.path})`
    );
    console.log(
      `  🌐 Universal Agents 全局目录:        ${status.globalUniversal.installed ? '✅ 已安装' : '⚪ 未安装'} (${status.globalUniversal.path})`
    );
    console.log(
      `  🌐 Claude Code 全局技能目录:         ${status.globalClaude.installed ? '✅ 已安装' : '⚪ 未安装'} (${status.globalClaude.path})`
    );
    console.log('--------------------------------------------------------------');
    console.log('💡 提示: 执行 `myship skill install` 安装到当前项目，或 `myship skill install -g` 安装到本机全局。');
    console.log('==============================================================');
    return status;
  }

  if (action === 'install' || action === 'add' || action === 'init') {
    const res = installMyShipSkill({
      cwd,
      global: isGlobal,
      homeDir,
      includeClaude: Boolean(options.claude),
    });
    console.log('==============================================================');
    console.log(
      `🤖 已成功安装 MyShip AI Vibecoding 技能包 (myship-skill) [${isGlobal ? '本机全局 Global' : '当前项目 Workspace'}]`
    );
    console.log('==============================================================');
    for (const t of res.targets) {
      console.log(`  ✅ ${t.agent}:`);
      console.log(`     ${t.path}/SKILL.md`);
      console.log(`     ${t.path}/references/fullstack-runtime.md`);
      console.log(`     ${t.path}/references/cli-and-ops.md`);
    }
    console.log('--------------------------------------------------------------');
    console.log('💡 AI Agent 现已掌握 MyShip 全栈开发契约 (context.db / context.files / SCF / 0ms 回滚)。');
    console.log('==============================================================');
    return res;
  }

  throw new Error(
    `未知的 myship skill 子命令: ${subAction}。可用用法: myship skill [install|status] [--global|-g]`
  );
}
