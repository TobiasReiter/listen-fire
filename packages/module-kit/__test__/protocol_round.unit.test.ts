// The module server's half of the 2026-10-17 protocol round: the one
// credential a request carries reaches the module, the install's
// settings arrive as construction arguments, and what the module spends rides
// the answer as `cost`.

import { Readable } from 'node:stream';

import { PROTOCOL_VERSION } from 'engine-contracts';
import type { PluginDeclaration } from 'movement-engine/public/plugins';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { defineModule } from '../define';
import { refusingFiles, refusingKv } from '../in_process';
import { createModuleProtocolHandler } from '../module_server';

const ECHO: PluginDeclaration = {
  priced: true,
  signature: {
    name: 'echo',
    description: 'Say what the module was handed.',
    params: [],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'string' } },
  },
};

const definition = defineModule({
  kind: 'plugin',
  name: '@lf/echo',
  credentials: [
    { name: 'reader', kind: 'static', fields: [{ name: 'token' }] },
    { name: 'writer', kind: 'static', fields: [{ name: 'token' }] },
  ],
  plugins: [ECHO],
  create: (ctx) => ({
    invokePlugin: async () => {
      const used = await ctx.credential.fields();
      await ctx.credential.update({ token: 'rotated' });
      ctx.spend.charge({ microdollars: 1500, label: 'echo-service' });
      return { text: `${ctx.credential.name}/${used.token}/${ctx.config.constructionArgs.base ?? '-'}` };
    },
  }),
});

async function post(envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = createModuleProtocolHandler({
    definition,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    files: refusingFiles('no files'),
    kvFor: () => refusingKv('no kv'),
  });
  const req = Object.assign(Readable.from([JSON.stringify({ protocolVersion: PROTOCOL_VERSION, cacheScopeId: 's', ...envelope })]), {
    headers: {},
  }) as unknown as IncomingMessage;
  let payload = '';
  const res = { writeHead: () => undefined, end: (body: string) => void (payload = body) } as unknown as ServerResponse;
  await handler(req, res);
  return JSON.parse(payload);
}

test('the one named credential, the settings and the spend cross the process transport', async () => {
  const body = await post({
    method: 'invokePlugin',
    params: { name: 'echo', config: {}, extractedContext: {} },
    credential: { name: 'writer', fields: { token: 'w1' } },
    settings: { base: 'app123' },
  });
  expect(body.ok).toBe(true);
  expect(body.result).toEqual({ text: 'writer/w1/app123' });
  expect(body.cost).toEqual([{ microdollars: 1500, label: 'echo-service' }]);
  expect(body.credentialUpdate).toEqual({ name: 'writer', fields: { token: 'rotated' } });
});

test('a credential the module does not declare refuses by name when read', async () => {
  const body = await post({
    method: 'invokePlugin',
    params: { name: 'echo', config: {}, extractedContext: {} },
    credential: { name: 'stranger', fields: { token: 's1' } },
  });
  expect(body.ok).toBe(false);
  expect(JSON.stringify(body.error)).toContain('declares no credential \\"stranger');
});
