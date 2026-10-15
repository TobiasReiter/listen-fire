// Acme CRM: a sample external speaking adapter protocol 2, with no
// dependencies — a port of the dev loop's fake CRM (apps/api/src/scripts/dev/
// fake_crm_adapter.ts) as a plain process, so it shows an external can be any
// program that answers the protocol over HTTP.
//
// One record type, `Company { Name, Description }`, and one event,
// `company.created`, delivered as `{ companies: [{ id, Name }] }`. Companies
// written through it are kept in the file named by ACME_CRM_STATE, so a test
// (or a developer) can see a write land.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const port = Number(process.env.PORT ?? 0);
const statePath = process.env.ACME_CRM_STATE;

const COMPANY = 'Company';
const COMPANY_CREATED = 'company.created';

function readState() {
  if (statePath && existsSync(statePath)) return JSON.parse(readFileSync(statePath, 'utf8'));
  return { companies: [] };
}

function writeState(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const COMPANY_DESCRIPTOR = {
  typeId: COMPANY,
  displayName: COMPANY,
  deletable: true,
  fields: [
    { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'Description', displayName: 'Description', kind: 'string', writable: true, required: false },
  ],
  references: [],
};

const METHODS = {
  manifest: () => ({
    protocolVersion: 2,
    adapterType: 'acme_crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),
  }),
  listEntryPoints: () => [
    {
      typeId: COMPANY,
      displayName: COMPANY,
      scope: 'self-configured',
      writable: true,
      readable: false,
      fires: true,
      description: 'A company. A listen is delivered each one somebody creates in the CRM.',
    },
  ],
  describe: ({ typeId }) => (typeId === COMPANY ? COMPANY_DESCRIPTOR : null),
  resolveEntity: () => ({ candidates: [] }),
  getFieldValue: ({ position, fieldId }) => {
    const data = position?.identity?.data;
    return data && typeof data === 'object' ? (data[fieldId] ?? null) : null;
  },
  getRelated: () => [],
  createRecord: ({ recordType, fields }) => {
    const state = readState();
    const externalId = `company-${state.companies.length + 1}`;
    state.companies.push({ externalId, fields });
    writeState(state);
    return { adapterType: 'acme_crm', externalId, recordType, data: { ...fields } };
  },
  updateRecord: ({ externalId, recordType, fields }) => {
    const state = readState();
    const existing = state.companies.find((c) => c.externalId === externalId);
    if (!existing) return { notFound: true };
    existing.fields = { ...existing.fields, ...fields };
    writeState(state);
    return { adapterType: 'acme_crm', externalId, recordType, data: { ...existing.fields } };
  },
  preprocessInbound: ({ raw }) => ({
    events: (raw?.companies ?? []).map((company) => ({
      payload: company,
      externalId: company.id,
      tag: COMPANY_CREATED,
      eventType: COMPANY_CREATED,
      changeType: 'create',
      recordType: COMPANY,
    })),
  }),
  listEventTypes: () => [{ tag: COMPANY_CREATED, positionType: COMPANY }],
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    if (req.method === 'GET' && req.url === '/dev/state') return send(res, 200, readState());
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    // The host hands the install's credential on every call; this CRM only
    // asks that one is there.
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
      return send(res, 200, { ok: false, error: { code: 'unauthorized', message: 'no credential', retryable: false } });
    }
    try {
      const { method, params } = JSON.parse(body);
      const handler = METHODS[method];
      if (!handler) {
        return send(res, 200, { ok: false, error: { code: 'method_not_found', message: method, retryable: false } });
      }
      send(res, 200, { ok: true, result: await handler(params ?? {}) });
    } catch (error) {
      send(res, 200, { ok: false, error: { code: 'internal', message: String(error?.message ?? error), retryable: false } });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  // The host reads the bound port from this line.
  process.stdout.write(`listening ${server.address().port}\n`);
});
