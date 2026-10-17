// The golden corpus harness: a case is a plain description of one inbound
// request. Replaying it builds the request bytes (signing them with the test
// secrets in secrets.ts), sends it through an express app that mounts the REAL
// routers exactly as server.ts does, and records what came back and what the
// fakes in world.ts saw. Recordings live beside this file; a replay compares
// them byte for byte.

import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

import { effects } from './world';

/** How a request body is built. `padded` grows a JSON object with a filler
 *  field to a byte size, so a 120 KB body is a number here, not 120 KB on disk. */
export type BodySpec =
  | { kind: 'none' }
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; value: string }
  | { kind: 'form'; fields: Record<string, string> }
  | { kind: 'padded'; value: Record<string, unknown>; paddedToBytes: number };

export interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  /** Headers as sent; a function receives the built body bytes (for signing). */
  headers: Record<string, string> | ((body: Buffer) => Record<string, string>);
  body: BodySpec;
  /** For a door that never answers: give up after this long and record that. */
  abortAfterMs?: number;
}

export interface GoldenCase {
  id: string;
  door: string;
  note: string;
  /** Arrange the fake world (and process.env) before the request. */
  arrange?: () => void | (() => void);
  request: RequestSpec;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The body as UTF-8 text, or `{ bytes, sha256, head }` past 4 KB. */
  body: string | { bytes: number; sha256: string; head: string };
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: string | { bytes: number; sha256: string; head: string };
}

export interface RecordedCase {
  id: string;
  door: string;
  note: string;
  request: RecordedRequest;
  response: RecordedResponse;
  effects: Record<string, unknown>[];
}

const KEPT_RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'cache-control', 'www-authenticate', 'allow'];

export function buildBody(spec: BodySpec): Buffer {
  switch (spec.kind) {
    case 'none':
      return Buffer.alloc(0);
    case 'json':
      return Buffer.from(JSON.stringify(spec.value), 'utf-8');
    case 'text':
      return Buffer.from(spec.value, 'utf-8');
    case 'form':
      return Buffer.from(new URLSearchParams(spec.fields).toString(), 'utf-8');
    case 'padded': {
      const base = Buffer.from(JSON.stringify({ ...spec.value, pad: '' }), 'utf-8');
      const filler = Math.max(0, spec.paddedToBytes - base.length);
      return Buffer.from(JSON.stringify({ ...spec.value, pad: 'x'.repeat(filler) }), 'utf-8');
    }
  }
}

function describeBytes(buffer: Buffer): string | { bytes: number; sha256: string; head: string } {
  if (buffer.length <= 4096) return buffer.toString('utf-8');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return {
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    head: buffer.subarray(0, 120).toString('utf-8'),
  };
}

export interface Served {
  baseUrl: string;
  close(): Promise<void>;
}

export function serve(app: Express): Promise<Served> {
  const server: Server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** Let work a door does after it has answered (setImmediate hand-offs, floating
 *  promises) finish, so its effects are in the record before the next case. */
export async function settleBackgroundWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setTimeout(done, 2));
  }
}

export async function run(served: Served, spec: GoldenCase): Promise<RecordedCase> {
  const body = buildBody(spec.request.body);
  const headers =
    typeof spec.request.headers === 'function' ? spec.request.headers(body) : { ...spec.request.headers };
  effects.length = 0;
  let recordedResponse: RecordedResponse;
  try {
    const response = await fetch(`${served.baseUrl}${spec.request.path}`, {
      method: spec.request.method,
      headers,
      ...(spec.request.method === 'GET' || body.length === 0 ? {} : { body }),
      redirect: 'manual',
      ...(spec.request.abortAfterMs !== undefined ? { signal: AbortSignal.timeout(spec.request.abortAfterMs) } : {}),
    });
    const responseBody = Buffer.from(await response.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    for (const name of KEPT_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) responseHeaders[name] = value;
    }
    recordedResponse = { status: response.status, headers: responseHeaders, body: describeBytes(responseBody) };
  } catch (error) {
    if (spec.request.abortAfterMs === undefined) throw error;
    recordedResponse = { status: 0, headers: {}, body: `no response within ${spec.request.abortAfterMs} ms` };
  }
  await settleBackgroundWork();
  return {
    id: spec.id,
    door: spec.door,
    note: spec.note,
    request: {
      method: spec.request.method,
      path: spec.request.path,
      headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
      body: describeBytes(body),
    },
    response: recordedResponse,
    effects: effects.map((effect) => ({ ...effect })),
  };
}

const RECORDINGS = join(__dirname, 'recordings');

export function recordingPath(door: string): string {
  return join(RECORDINGS, `${door}.json`);
}

export function readRecording(door: string): RecordedCase[] | null {
  const path = recordingPath(door);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as RecordedCase[]) : null;
}

export function writeRecording(door: string, cases: RecordedCase[]): void {
  writeFileSync(recordingPath(door), `${JSON.stringify(cases, null, 2)}\n`);
}

export const RECORD_MODE = process.env.GOLDEN_RECORD === '1';
