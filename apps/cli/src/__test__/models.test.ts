// A model call through the real `lf` binary: the provider key and endpoint
// come from the secrets file's `anthropic` credential, the request reaches a
// fake Anthropic Messages API, and the model's answer lands in the external's
// write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { companies, lfCommand, project } from './example';

const ANSWER = 'Vireo Robotics, welcomed by a model';

interface Received {
  headers: IncomingHttpHeaders;
  body: { model: string; messages: Array<{ content: unknown }> };
}

// Answers every request as a stream, the way the shared client asks for it.
async function fakeAnthropic(): Promise<{ url: string; received: Received[]; close: () => void }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      const events: Array<[string, object]> = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received, close: () => server.close() };
}

// Asynchronous rather than `lf()`'s spawnSync: the fake answers from this
// process's event loop.
function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(...lfCommand(args), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => done({ code: code ?? -1, out }));
  });
}

test('lf run: AI() calls Anthropic on the secrets key and its answer is written', async () => {
  const fake = await fakeAnthropic();
  try {
    const dir = project();
    appendFileSync(
      join(dir, '.lf/secrets.yaml'),
      `\nanthropic:\n  external: anthropic\n  api_key: test-key\n  base_url: ${fake.url}\n`,
    );
    writeFileSync(
      join(dir, 'movements/named.mvt'),
      [
        'import { acme_crm } from adapters',
        'import { acme } from credentials',
        '',
        'crm = connect acme_crm using acme',
        '',
        'function name_it(company: <crm-[:Company]->>) {',
        '  write crm-[:Company]-> { Name: ai("Write a welcome line for ${company.Name}") }',
        '}',
        '',
        'listen to crm { events: ["company.created"] } fire name_it',
        '',
      ].join('\n'),
    );

    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);

    assert.equal(fake.received.length, 1, run.out);
    const [request] = fake.received;
    assert.equal(request?.headers['x-api-key'], 'test-key');
    assert.match(JSON.stringify(request?.body.messages), /Write a welcome line for Vireo Robotics/);
    assert.ok(companies(dir).includes(ANSWER), `${companies(dir).join(', ')}\n${run.out}`);
  } finally {
    fake.close();
  }
});

test('lf run: a model call with no provider key fails naming the secrets entry', async () => {
  const dir = project();
  writeFileSync(
    join(dir, 'movements/named.mvt'),
    [
      'import { acme_crm } from adapters',
      'import { acme } from credentials',
      '',
      'crm = connect acme_crm using acme',
      '',
      'function name_it(company: <crm-[:Company]->>) {',
      '  write crm-[:Company]-> { Name: ai("Write a welcome line for ${company.Name}") }',
      '}',
      '',
      'listen to crm { events: ["company.created"] } fire name_it',
      '',
    ].join('\n'),
  );
  const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
  assert.match(run.out, /a model call needs a provider key/);
});
