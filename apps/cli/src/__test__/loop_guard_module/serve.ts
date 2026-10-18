// A third-party loop guard module for the tests: the loopGuard slot's wire
// (docs/contracts/loop-guard-slot.md) served on its stdin and stdout over the
// TypeScript built-in (`FingerprintGuard`). It stands for a guard whose
// memory is elsewhere — Redis, a database — which is the same wire over
// other state. It refuses to be used before `guard.open`, as a real one would.

import { createInterface } from 'node:readline';
import { FingerprintGuard } from 'movement-engine/services/loop_guard/loop_guard';

const guard = new FingerprintGuard();
let opened = false;

async function answer(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'guard.open') {
    opened = true;
    return null;
  }
  if (!opened) throw new Error('open me with guard.open first');
  switch (method) {
    case 'guard.recordWrite':
      await guard.recordWrite(params as never);
      return null;
    case 'guard.isEcho':
      return guard.isEcho(params as never);
    default:
      throw new Error(`no method "${method}"`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const request = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> };
  answer(request.method, request.params ?? {}).then(
    (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`),
    (error: Error) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } })}\n`),
  );
});
