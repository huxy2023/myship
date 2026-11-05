/**
 * console-styles.mjs — 读取原生 packages/cli/console/styles.css 样式表
 */
import { readFileSync } from 'node:fs';

export const CONSOLE_CSS = readFileSync(new URL('./console/styles.css', import.meta.url), 'utf8');
