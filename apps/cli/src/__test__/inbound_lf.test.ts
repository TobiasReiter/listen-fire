// What lf adds to the shared inbound contract: externals that declare their
// signing in the manifest, the signed-inbound rule, the /hooks name, and the
// pull cursor held in lf's SQLite state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WireListenDeclarations, type WireInboundDeclarationShape } from 'engine-contracts';
import type { RunningExternal } from '../externals';
import { initProject, loadProject } from '../project';
import { openSession } from '../runs';
import { serve, type Serving } from '../serve';

function external(name: string, extra: { inbound?: WireInboundDeclarationShape; webhook?: { header: string; secretField: string } }): RunningExternal {
  return {
    external: {
      dir: '',
      manifest: {
        name,
        kind: 'adapter',
        protocol: 2,
        env: {},
        ...(extra.webhook !== undefined ? { webhook: { signature: 'hmac-sha256' as const, ...extra.webhook } } : {}),
      },
    },
    baseUrl: '',
    methods: [],
    supportedTriggers: [],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    listen: WireListenDeclarations.parse({}),
    credentials: [],
    ...(extra.inbound !== undefined ? { inbound: extra.inbound } : {}),
    stop: () => {},
  };
}

async function lfServing(setup: (serving: Serving) => void): Promise<Serving> {
  const dir = mkdtempSync(join(tmpdir(), 'lf-inbound-'));
  initProject(dir);
  const serving = await serve((hostUrl) => openSession(loadProject(dir), { ephemeral: true, start: false, hostUrl }), {
    port: 0,
    tickMs: 3_600_000,
    log: () => {},
    inbound: {
      adapterOf: ({ running }) => ({
        adapterType: running.external.manifest.name,
        preprocessInbound: async ({ raw, checkpoint }) => ({
          events: [{ payload: { raw, sawCheckpoint: checkpoint ?? null } }],
          checkpoint: 'cursor-1',
        }),
      }),
    },
  });
  setup(serving);
  return serving;
}

const hex = (body: string, key: string) => createHmac('sha256', key).update(body).digest('hex');

async function post(serving: Serving, path: string, body: string, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${serving.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: response.status, body: (await response.json()) as unknown };
}

const ATTIO: WireInboundDeclarationShape = { providerKey: 'acme_attio', scheme: 'attio', signatureHeaders: ['attio-signature'] };

test('a declared scheme verifies the delivery, with the secret in webhook_secret by default', async () => {
  const serving = await lfServing(({ session }) => {
    session.running.set('acme', external('acme', { inbound: ATTIO }));
    session.credentials.set('one', { name: 'one', external: 'acme', fields: { webhook_secret: 's3cret' }, origin: { envFields: new Set() } });
  });
  try {
    const body = '{"a":1}';
    const ok = await post(serving, '/api/public/webhook-sync/acme_attio/one', body, { 'attio-signature': hex(body, 's3cret') });
    assert.deepEqual([ok.status, ok.body], [200, { ok: true, eventsProcessed: 1 }]);
    const bad = await post(serving, '/api/public/webhook-sync/acme_attio/one', body, { 'attio-signature': hex(body, 'other') });
    assert.equal(bad.status, 401);
  } finally {
    await serving.stop();
    serving.session.close();
  }
});

test('the signed-inbound rule: a missing, empty or placeholder secret refuses every delivery, even to a scheme that would accept an empty key', async () => {
  const serving = await lfServing(({ session }) => {
    session.running.set('acme', external('acme', { inbound: ATTIO }));
    session.credentials.set('missing', { name: 'missing', external: 'acme', fields: {}, origin: { envFields: new Set() } });
    session.credentials.set('empty', { name: 'empty', external: 'acme', fields: { webhook_secret: '' }, origin: { envFields: new Set() } });
    session.credentials.set('pending', { name: 'pending', external: 'acme', fields: { webhook_secret: 'pending' }, origin: { envFields: new Set() } });
  });
  try {
    const body = '{"a":1}';
    for (const install of ['missing', 'empty', 'pending']) {
      const forgedWithEmptyKey = await post(serving, `/api/public/webhook-sync/acme_attio/${install}`, body, { 'attio-signature': hex(body, '') });
      assert.deepEqual([install, forgedWithEmptyKey.status], [install, 401]);
      const forgedWithPlaceholder = await post(serving, `/api/public/webhook-sync/acme_attio/${install}`, body, { 'attio-signature': hex(body, 'pending') });
      assert.deepEqual([install, forgedWithPlaceholder.status], [install, 401]);
    }
  } finally {
    await serving.stop();
    serving.session.close();
  }
});

test('the yaml webhook block is the protocol scheme; /hooks and the canonical door both take it, and /hooks answers with its runs', async () => {
  const serving = await lfServing(({ session }) => {
    session.running.set('acme_crm', external('acme_crm', { webhook: { header: 'X-Acme-Signature', secretField: 'hook' } }));
    session.credentials.set('acme', { name: 'acme', external: 'acme_crm', fields: { hook: 'k' }, origin: { envFields: new Set() } });
  });
  try {
    const body = '{"a":1}';
    const signed = { 'x-acme-signature': hex(body, 'k') };
    const legacy = await post(serving, '/hooks/acme_crm/acme', body, signed);
    assert.deepEqual([legacy.status, legacy.body], [202, { runs: [] }]);
    const onlyInstall = await post(serving, '/hooks/acme_crm', body, signed);
    assert.equal(onlyInstall.status, 202, 'the external\'s only credential is the install');
    const canonical = await post(serving, '/api/public/webhook-sync/ACME_CRM/acme', body, signed);
    assert.deepEqual([canonical.status, canonical.body], [200, { ok: true, eventsProcessed: 1 }]);
    const refused = await post(serving, '/hooks/acme_crm/acme', body, { 'x-acme-signature': '00' });
    assert.equal(refused.status, 401);
    const unknown = await post(serving, '/hooks/nobody/acme', body, signed);
    assert.equal(unknown.status, 404);
  } finally {
    await serving.stop();
    serving.session.close();
  }
});

test('a pull cursor the external returns is kept in lf\'s state and handed back on the next delivery', async () => {
  const serving = await lfServing(({ session }) => {
    session.running.set('acme', external('acme', { inbound: ATTIO }));
    session.credentials.set('one', { name: 'one', external: 'acme', fields: { webhook_secret: 'k' }, origin: { envFields: new Set() } });
  });
  try {
    const body = '{"a":1}';
    assert.equal(serving.session.state.inboundCheckpoint('one'), null);
    await post(serving, '/api/public/webhook-sync/acme_attio/one', body, { 'attio-signature': hex(body, 'k') });
    assert.equal(serving.session.state.inboundCheckpoint('one'), 'cursor-1');
  } finally {
    await serving.stop();
    serving.session.close();
  }
});
