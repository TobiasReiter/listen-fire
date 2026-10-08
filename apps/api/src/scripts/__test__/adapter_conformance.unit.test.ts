// The conformance CLI against servers it must judge: the fake CRM (which
// passes every check with no SKIP), a server that answers protocol version 1,
// and a server whose `describe` answer is malformed. Real HTTP on ephemeral
// ports, no database.

import http from 'node:http';

import { BASE_RUNTIME_CAPABILITIES } from '../../services/translation_graph/adapter';
import {
  FAKE_CRM_COMPANY_TYPE,
  startFakeCrmServer,
  type FakeCrmServer,
} from '../dev/fake_crm_adapter';
import { runConformance, type CheckResult } from '../adapter_conformance';

const SECRET = 'conformance-test-secret';

function byName(results: readonly CheckResult[], name: string): CheckResult {
  const found = results.find((r) => r.name === name);
  if (!found) throw new Error(`no check named ${name} in ${results.map((r) => r.name).join(', ')}`);
  return found;
}

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  const { port } = address;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

interface StubServer {
  baseUrl: string;
  close: () => Promise<void>;
}

/** A server that answers each method from `answers`, else an error envelope. */
async function startStub(answers: Record<string, unknown>): Promise<StubServer> {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { method, protocolVersion } = JSON.parse(raw || '{}') as { method: string; protocolVersion: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (protocolVersion !== '2') {
        res.end(JSON.stringify({ ok: false, error: { code: 'protocol_version', message: 'expected protocol version 2', retryable: false } }));
      } else if (method in answers) {
        res.end(JSON.stringify({ ok: true, result: answers[method] }));
      } else {
        res.end(JSON.stringify({ ok: false, error: { code: 'method_not_implemented', message: method, retryable: false } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe('adapter conformance CLI', () => {
  describe('against the fake CRM', () => {
    let crm: FakeCrmServer;
    let results: CheckResult[];

    beforeAll(async () => {
      const hostPort = await freePort();
      crm = await startFakeCrmServer({
        secret: SECRET,
        host: { apiBaseUrl: `http://127.0.0.1:${hostPort}` },
      });
      results = await runConformance({
        baseUrl: crm.baseUrl,
        authStrategy: { kind: 'bearer' },
        secret: SECRET,
        scratch: { typeId: FAKE_CRM_COMPANY_TYPE, fields: { Name: 'Conformance Co' } },
        sampleDelivery: { companies: [{ id: 'c1', Name: 'A' }] },
        hostPort,
        waitForPushSeconds: 10,
        onWaitingForPush: async () => {
          const company = (await postJson(new URL('dev/companies', crm.baseUrl).href, { Name: 'Pushed Co' })) as {
            company: { externalId: string };
          };
          await postJson(new URL('dev/comments', crm.baseUrl).href, {
            company: company.company.externalId,
            text: 'hello',
          });
        },
      });
    });

    afterAll(async () => {
      await crm.close();
    });

    it('passes every check with no failure and no skip', () => {
      expect(results.filter((r) => r.status !== 'PASS')).toEqual([]);
    });

    it('runs the whole check list', () => {
      expect(results.map((r) => r.name)).toEqual([
        'manifest',
        'protocol-version-refusal',
        'error-bad-request',
        'error-method-not-implemented',
        'manifest-methods',
        'listEntryPoints',
        'describe',
        'natural-names',
        'createRecord',
        'resolveEntity',
        'getRelated',
        'iterateRelatedPage',
        'getFieldValue',
        'updateRecord',
        'resolveAwait',
        'deleteRecord',
        'ensureEventSubscription',
        'removeEventSubscription',
        'listEventTypes',
        'preprocessInbound',
        'wakeKeys',
        'door-emit',
        'door-wake',
        'scratch-cleanup',
      ]);
    });

    it('pages across a boundary and deletes its scratch records', () => {
      expect(byName(results, 'iterateRelatedPage').detail).toMatch(/[2-9] pages/);
      // Three scratch records + the one the door trigger created, minus none:
      // the scratch records are gone, the pushed company is the CRM's own.
      expect(crm.writes.map((w) => w.fields)).toEqual([{ Name: 'Pushed Co' }]);
    });
  });

  it('skips the record checks and names the flags when no scratch type is given', async () => {
    const crm = await startFakeCrmServer({ secret: SECRET });
    try {
      const results = await runConformance({ baseUrl: crm.baseUrl, authStrategy: { kind: 'bearer' }, secret: SECRET });
      const create = byName(results, 'createRecord');
      expect(create.status).toBe('SKIP');
      expect(create.detail).toContain('--scratch-type');
      expect(results.filter((r) => r.status === 'FAIL')).toEqual([]);
    } finally {
      await crm.close();
    }
  });

  it('fails a wrong secret at the manifest, naming the transport error', async () => {
    const crm = await startFakeCrmServer({ secret: SECRET });
    try {
      const results = await runConformance({ baseUrl: crm.baseUrl, authStrategy: { kind: 'bearer' }, secret: 'wrong' });
      expect(byName(results, 'manifest').status).toBe('FAIL');
      expect(byName(results, 'manifest').detail).toContain('401');
    } finally {
      await crm.close();
    }
  });

  it('fails a server that answers protocol version 1, naming both versions', async () => {
    const stub = await startStub({
      manifest: {
        protocolVersion: 1,
        adapterType: 'old_crm',
        supportedTriggers: [],
        runtimeCapabilities: BASE_RUNTIME_CAPABILITIES,
        methods: [],
      },
    });
    try {
      const results = await runConformance({ baseUrl: stub.baseUrl, authStrategy: { kind: 'bearer' }, secret: SECRET });
      const manifest = byName(results, 'manifest');
      expect(manifest.status).toBe('FAIL');
      expect(manifest.detail).toMatch(/expected 2, got 1/);
    } finally {
      await stub.close();
    }
  });

  it('fails a malformed describe answer at the describe check, naming the method', async () => {
    const stub = await startStub({
      manifest: {
        protocolVersion: 2,
        adapterType: 'sloppy_crm',
        supportedTriggers: [],
        runtimeCapabilities: BASE_RUNTIME_CAPABILITIES,
        methods: ['listEntryPoints', 'describe'],
      },
      listEntryPoints: [{ typeId: 'Company', displayName: 'Company', writable: true, readable: false }],
      describe: { typeId: 'Company' },
    });
    try {
      const results = await runConformance({ baseUrl: stub.baseUrl, authStrategy: { kind: 'bearer' }, secret: SECRET });
      const describe = byName(results, 'describe');
      expect(describe.status).toBe('FAIL');
      expect(describe.detail).toContain('"describe"');
    } finally {
      await stub.close();
    }
  });
});
