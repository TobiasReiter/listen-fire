// A limiter another process serves over the limiter slot's wire
// (docs/contracts/limiter-slot.md): one JSON-RPC 2.0 message per line on its
// stdin and stdout. How the contract suite (contract.ts) holds lf's limiter
// (`lf --contract-limiter`), and a limiter module lf drives, to the meaning
// every limiter has.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { LimitGrant, Limiter, LimitRequest } from './limiter';

const Reply = z.union([
  z.object({ id: z.number().nullable(), error: z.object({ code: z.number(), message: z.string() }) }),
  z.object({ id: z.number(), result: z.unknown() }),
]);
const Grant: z.ZodType<LimitGrant> = z.union([
  z.object({ granted: z.literal(true), permit: z.string() }),
  z.object({ granted: z.literal(false), retryAt: z.string() }),
]);
const Nothing = z.null();

export class RpcLimiter implements Limiter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private exited: Error | undefined;

  constructor(command: string, args: readonly string[]) {
    this.child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    this.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.child.on('exit', (code) => {
      this.exited = new Error(`the limiter process exited (${code})${stderr.length > 0 ? `: ${stderr.join('').trim()}` : ''}`);
      for (const waiter of this.waiting.values()) waiter.reject(this.exited);
      this.waiting.clear();
    });
  }

  private async call<S extends z.ZodType>(method: string, params: object, schema: S): Promise<z.infer<S>> {
    if (this.exited !== undefined) throw this.exited;
    const id = this.nextId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new Error(`${method} answered ${JSON.stringify(result)}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }

  private receive(line: string): void {
    const reply = Reply.safeParse(JSON.parse(line));
    if (!reply.success || reply.data.id === null) return;
    const waiter = this.waiting.get(reply.data.id);
    if (waiter === undefined) return;
    this.waiting.delete(reply.data.id);
    if ('error' in reply.data) waiter.reject(new Error(reply.data.error.message));
    else waiter.resolve(reply.data.result);
  }

  async open(settings: Record<string, string> = {}): Promise<void> {
    await this.call('limiter.open', { settings }, Nothing);
  }

  acquire(request: LimitRequest): Promise<LimitGrant> {
    return this.call('limiter.acquire', request, Grant);
  }

  async release(permit: string): Promise<void> {
    await this.call('limiter.release', { permit }, Nothing);
  }

  async throttle(input: { key: string; until: string }): Promise<void> {
    await this.call('limiter.throttle', input, Nothing);
  }

  close(): void {
    this.child.stdin.end();
  }
}
