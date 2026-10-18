// A third-party limiter module for the tests: the limiter slot's wire
// (docs/contracts/limiter-slot.md) served on its stdin and stdout over the
// TypeScript built-in (`MemoryLimiter`). It stands for a limiter shared by
// many hosts — Redis, a database — which is the same wire over other state.
// It refuses to be used before `limiter.open`, as a real one would.

import { createInterface } from 'node:readline';
import { MemoryLimiter } from 'movement-engine/services/limiter/limiter';

const limiter = new MemoryLimiter();
let opened = false;

async function answer(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'limiter.open') {
    opened = true;
    return null;
  }
  if (!opened) throw new Error('open me with limiter.open first');
  switch (method) {
    case 'limiter.acquire':
      return limiter.acquire(params as never);
    case 'limiter.release':
      await limiter.release(String(params.permit));
      return null;
    case 'limiter.throttle':
      await limiter.throttle({ key: String(params.key), until: String(params.until) });
      return null;
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
