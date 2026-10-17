// A model call under lf is priced from the shared price table and charged to
// the call that made it, so a run's cost cap sees what its model calls spent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { modelCalls } from '../models';
import { MODEL_CREDENTIAL, type Credential } from '../secrets';

test('a model call answers the cost the shared table prices its tokens at', async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const events: Array<[string, object]> = [
        ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"a":1}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 500 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  try {
    const { port } = server.address() as AddressInfo;
    const credentials = new Map<string, Credential>([
      [
        MODEL_CREDENTIAL,
        {
          name: MODEL_CREDENTIAL,
          external: 'anthropic',
          fields: { api_key: 'k', base_url: `http://127.0.0.1:${port}` },
          origin: { envFields: new Set() },
        },
      ],
    ]);
    const answer = await modelCalls(credentials).client.call({
      system: 's',
      userMessage: 'u',
      model: 'sonnet',
      label: 'test',
      budget: { remainingMicrodollars: null },
    } as never);
    // claude-sonnet-5 is $2 in / $10 out per million: 1000 * 2 + 500 * 10.
    assert.deepEqual('cost' in answer ? answer.cost : undefined, [{ source: 'model:claude-sonnet-5', microdollars: 7000 }]);
  } finally {
    server.close();
  }
});
