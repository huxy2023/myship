/**
 * console-client.mjs — 读取原生 packages/cli/console/client.js 浏览器端控制器脚本
 */
import { readFileSync } from 'node:fs';

const RAW_CLIENT_JS = readFileSync(new URL('./console/client.js', import.meta.url), 'utf8');

export function buildConsoleClientScript(defaultProject = 'default') {
  return `const __MYSHIP_DEFAULT_PROJECT__ = ${JSON.stringify(defaultProject || 'default')};\n${RAW_CLIENT_JS}`;
}
