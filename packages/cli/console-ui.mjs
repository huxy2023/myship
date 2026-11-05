/**
 * console-ui.mjs — 组装原生 packages/cli/console/{template.html,styles.css,client.js}
 */
import { readFileSync } from 'node:fs';
import { CONSOLE_CSS } from './console-styles.mjs';
import { buildConsoleClientScript } from './console-client.mjs';

const RAW_TEMPLATE_HTML = readFileSync(
  new URL('./console/template.html', import.meta.url),
  'utf8'
);

export function renderConsoleHtml({
  modeLabel = 'REMOTE',
  defaultProject = 'default',
} = {}) {
  const safeModeLabel = String(modeLabel).replace(/</g, '&lt;');
  return RAW_TEMPLATE_HTML
    .replace('/* __CONSOLE_CSS__ */', () => CONSOLE_CSS)
    .replace('__MODE_LABEL__', () => safeModeLabel)
    .replace('/* __CONSOLE_CLIENT_JS__ */', () => buildConsoleClientScript(defaultProject));
}
