// The real `lf` run as a person runs it: its questions answered on stdin as
// they come, its output watched line by line.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lfCommand } from './example';

export interface Running {
  /** Resolves with the first output line matching. */
  line(pattern: RegExp): Promise<string>;
  /** Answer the next question(s). */
  answer(...lines: string[]): void;
  done: Promise<{ code: number; out: string }>;
}

export function lf(dir: string, args: string[], options: { answers?: string[]; env?: Record<string, string> } = {}): Running {
  const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1', ...options.env } });
  let out = '';
  const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = [];
  const scan = () => {
    for (const waiter of [...waiters]) {
      const found = out.split('\n').find((l) => waiter.pattern.test(l));
      if (found !== undefined) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    }
  };
  child.stdout.on('data', (c) => ((out += c), scan()));
  child.stderr.on('data', (c) => ((out += c), scan()));
  const done = new Promise<{ code: number; out: string }>((resolve) => child.on('close', (code) => resolve({ code: code ?? -1, out })));
  const answer = (...lines: string[]) => child.stdin.write(lines.map((l) => `${l}\n`).join(''));
  if (options.answers !== undefined) answer(...options.answers);
  return {
    line: (pattern) =>
      new Promise((resolve, reject) => {
        waiters.push({ pattern, resolve });
        scan();
        void done.then(({ out: all }) => reject(new Error(`lf exited before printing ${pattern}:\n${all}`)));
      }),
    answer,
    done,
  };
}

export async function ok(running: Running): Promise<string> {
  const { code, out } = await running.done;
  assert.equal(code, 0, out);
  return out;
}

