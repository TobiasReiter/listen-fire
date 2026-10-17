// A third-party store module for the tests: it reads its `path` setting
// from the store wire's opening request (`store.open`) and forwards every
// line, that one included, to `lf --contract-store <path>`, which serves the
// same wire over a SQLite state file. Usage: node forward.mjs <lf binary>.

import { spawn } from 'node:child_process';

const [lf] = process.argv.slice(2);
let head = '';

function begin(firstLine, rest) {
  const opening = JSON.parse(firstLine);
  const path = opening.params?.settings?.path;
  if (opening.method !== 'store.open' || typeof path !== 'string') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: opening.id ?? null, error: { code: -32602, message: 'open me with store.open { settings: { path } }' } })}\n`);
    process.exit(1);
  }
  const store = spawn(lf, ['--contract-store', path], { stdio: ['pipe', 'pipe', 'inherit'] });
  store.stdout.pipe(process.stdout);
  store.stdin.write(`${firstLine}\n${rest}`);
  process.stdin.pipe(store.stdin);
  store.on('exit', (code) => process.exit(code ?? 1));
}

function onData(chunk) {
  head += chunk.toString();
  const end = head.indexOf('\n');
  if (end < 0) return;
  process.stdin.off('data', onData);
  begin(head.slice(0, end), head.slice(end + 1));
}

process.stdin.on('data', onData);
process.stdin.on('end', () => {
  if (head.indexOf('\n') < 0) process.exit(0);
});
