/**
 * tui-prompts.mjs — MyShip 零依赖交互式终端选择器与文本问答组件
 *
 * - 支持真机 TTY Raw Mode (`↑/↓` 方向键、`j/k`、数字键 `1-9` 与回车确认)
 * - 支持非 TTY 管道降级输入与自动化测试预设应答队列 (`promptAnswers`)
 */
import { createInterface } from 'node:readline/promises';

export async function promptSelect({
  title,
  items = [],
  defaultIndex = 0,
  promptAnswers = null,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('promptSelect requires at least 1 item');
  }
  let idx = Math.max(0, Math.min(defaultIndex, items.length - 1));

  // 支持自动化测试注入预设回答队列
  if (Array.isArray(promptAnswers) && promptAnswers.length > 0) {
    const nextAns = promptAnswers.shift();
    if (typeof nextAns === 'number') {
      const targetIdx = Math.max(0, Math.min(nextAns, items.length - 1));
      return items[targetIdx].value;
    }
    const matched = items.find(
      (it, i) =>
        it.value === nextAns ||
        String(i + 1) === String(nextAns).trim() ||
        it.label.includes(String(nextAns))
    );
    return matched ? matched.value : items[idx].value;
  }

  // 真机交互式终端 (支持 ↑/↓ 方向键 + 数字键 1-9 + 回车确认)
  if (
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  ) {
    return new Promise((resolvePromise) => {
      const renderMenu = (firstRender = false) => {
        if (!firstRender) {
          process.stdout.write(`\x1b[${items.length + 1}A\r\x1b[J`);
        }
        process.stdout.write(
          `\x1b[36m?\x1b[0m \x1b[1m${title}\x1b[0m \x1b[90m(↑/↓ 方向键或数字键 1-${items.length} 选择，回车确认)\x1b[0m\n`
        );
        items.forEach((item, i) => {
          const isSelected = i === idx;
          const prefix = isSelected ? '\x1b[32m❯\x1b[0m' : ' ';
          const labelStr = isSelected
            ? `\x1b[32m\x1b[1m${i + 1}. ${item.label}\x1b[0m`
            : `${i + 1}. ${item.label}`;
          const hintStr = item.hint ? ` \x1b[90m${item.hint}\x1b[0m` : '';
          process.stdout.write(`  ${prefix} ${labelStr}${hintStr}\n`);
        });
      };

      renderMenu(true);
      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        try {
          process.stdin.setRawMode(Boolean(wasRaw));
        } catch {}
        process.stdin.pause();
      };

      const onData = (buf) => {
        const s = buf.toString('utf8');
        if (s === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (s === '\r' || s === '\n') {
          cleanup();
          process.stdout.write(`\x1b[${items.length + 1}A\r\x1b[J`);
          process.stdout.write(
            `\x1b[32m✔\x1b[0m \x1b[1m${title}\x1b[0m: \x1b[36m${items[idx].label}\x1b[0m\n`
          );
          resolvePromise(items[idx].value);
          return;
        }
        if (s === '\u001b[A' || s === 'k') {
          idx = (idx - 1 + items.length) % items.length;
          renderMenu(false);
          return;
        }
        if (s === '\u001b[B' || s === 'j') {
          idx = (idx + 1) % items.length;
          renderMenu(false);
          return;
        }
        if (/^[1-9]$/.test(s)) {
          const numIdx = Number(s) - 1;
          if (numIdx < items.length) {
            idx = numIdx;
            renderMenu(false);
          }
        }
      };

      process.stdin.on('data', onData);
    });
  }

  // 非 Raw TTY 降级为编号输入
  console.log(`\n? ${title}`);
  items.forEach((item, i) => {
    const defTag = i === idx ? ' (默认)' : '';
    console.log(`  [${i + 1}] ${item.label}${item.hint ? ` ${item.hint}` : ''}${defTag}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`👉 请选择序号 [1-${items.length}, 默认 ${idx + 1}]: `)).trim();
    if (!ans) return items[idx].value;
    const num = Number(ans);
    if (Number.isInteger(num) && num >= 1 && num <= items.length) {
      return items[num - 1].value;
    }
    const matched = items.find((it) => it.value === ans);
    return matched ? matched.value : items[idx].value;
  } finally {
    rl.close();
  }
}

export async function promptText({
  question,
  defaultValue = '',
  promptAnswers = null,
} = {}) {
  if (Array.isArray(promptAnswers) && promptAnswers.length > 0) {
    const nextAns = promptAnswers.shift();
    return nextAns !== undefined && nextAns !== null && String(nextAns).trim() !== ''
      ? String(nextAns).trim()
      : defaultValue;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? ` (默认: ${defaultValue})` : '';
    const ans = (await rl.question(`\x1b[36m?\x1b[0m ${question}${suffix}: `)).trim();
    return ans || defaultValue;
  } finally {
    rl.close();
  }
}
