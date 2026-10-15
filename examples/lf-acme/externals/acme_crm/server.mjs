// Acme CRM: a sample external speaking adapter protocol 2, with no
// dependencies — a port of the dev loop's fake CRM (apps/api/src/scripts/dev/
// fake_crm_adapter.ts) as a plain process, so it shows an external can be any
// program that answers the protocol over HTTP.
//
// One record type, `Company { Name, Description }`, and two events a listen
// may choose, `company.created` and `company.updated`; a webhook delivers
// created companies as `{ companies: [{ id, Name }] }`. Each
// company has a comment thread (`Comments`, to `Comment { Text }`) a movement
// can await: `await FIRST(company-[:Comments]->)` parks until somebody
// comments, on the correlation key `thread:<company id>`. A webhook delivery
// may carry comments too (`comments: [{ thread, text }]`), each waking its
// thread. Companies and comments are kept in the file named by
// ACME_CRM_STATE, so a test (or a developer) can see a write land.
//
// The CRM also owns an inbound side of its own, the way a hosted system
// would: `POST /dev/companies { Name }` and `POST /dev/comments { company,
// text }` change its state and push the change to the host's doors (`emit`,
// `wake` under LF_HOST_URL, which `lf serve` hands the externals it starts),
// presenting the credential the host calls it with.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const port = Number(process.env.PORT ?? 0);
const statePath = process.env.ACME_CRM_STATE;

const hostUrl = process.env.LF_HOST_URL;

const COMPANY = 'Company';
const COMMENT = 'Comment';
const COMMENTS_EDGE = 'Comments';
const COMPANY_CREATED = 'company.created';
const COMPANY_UPDATED = 'company.updated';

function readState() {
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  return { companies: state.companies ?? [], comments: state.comments ?? [] };
}

const threadKey = (company) => `thread:${company}`;

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
    { fieldId: 'Report', displayName: 'Report', kind: 'file', writable: true, required: false },
  ],
  references: [
    {
      fieldId: COMMENTS_EDGE,
      name: COMMENTS_EDGE,
      targetTypeId: COMMENT,
      cardinality: 'many',
      direction: 'outgoing',
      // People comment in the CRM; nothing is created along the thread.
      writable: false,
      // Awaitable (the first comment), and watched: the CRM pushes a wake
      // when a comment lands, so a park is woken, not polled.
      awaitable: true,
      watchable: true,
      // A company the CRM does not have settles empty rather than parking forever.
      resolvesEmpty: true,
    },
  ],
};

const COMMENT_DESCRIPTOR = {
  typeId: COMMENT,
  displayName: COMMENT,
  fields: [{ fieldId: 'Text', displayName: 'Text', kind: 'string', writable: false, required: false }],
  references: [],
};

function companyCreatedEvent(company) {
  return {
    payload: company,
    externalId: company.id,
    tag: COMPANY_CREATED,
    eventType: COMPANY_CREATED,
    changeType: 'create',
    recordType: COMPANY,
  };
}

const METHODS = {
  manifest: () => ({
    protocolVersion: 2,
    adapterType: 'acme_crm',
    supportedTriggers: ['webhook'],
    // What a listen on this CRM may say: `events: [...]` from this list.
    subscribableEvents: [COMPANY_CREATED, COMPANY_UPDATED],
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
    // Reached only along a company's `Comments`; published so it is named.
    { typeId: COMMENT, displayName: COMMENT, scope: 'self-configured', writable: false, readable: false },
  ],
  describe: ({ typeId }) => (typeId === COMPANY ? COMPANY_DESCRIPTOR : typeId === COMMENT ? COMMENT_DESCRIPTOR : null),
  resolveEntity: () => ({ candidates: [] }),
  getFieldValue: ({ position, fieldId }) => {
    const data = position?.identity?.data;
    return data && typeof data === 'object' ? (data[fieldId] ?? null) : null;
  },
  getRelated: () => [],
  createRecord: async ({ recordType, fields: written }) => {
    const fields = await withFileContents(written);
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
  preprocessInbound: ({ raw }) => ({ events: (raw?.companies ?? []).map(companyCreatedEvent) }),
  listEventTypes: () => [
    { tag: COMPANY_CREATED, positionType: COMPANY },
    { tag: COMPANY_UPDATED, positionType: COMPANY },
  ],
  // What an awaited thread holds now: its comments, or pending on its key.
  resolveAwait: ({ recordId, edge }) => {
    if (edge !== COMMENTS_EDGE) throw new Error(`'${edge}' is not an awaitable edge (only '${COMMENTS_EDGE}')`);
    const state = readState();
    if (!state.companies.some((c) => c.externalId === recordId)) return { status: 'empty' };
    const thread = state.comments.filter((c) => c.thread === recordId);
    if (thread.length === 0) return { status: 'pending', correlationKey: threadKey(recordId) };
    return {
      status: 'landed',
      correlationKey: threadKey(recordId),
      landings: thread.map((c) => ({ recordId: c.id, recordType: COMMENT, fields: { Text: c.Text } })),
    };
  },
  // The threads a webhook delivery's comments land on.
  wakeKeys: ({ raw }) => (raw?.comments ?? []).map((comment) => threadKey(comment.thread)),
};

// The credential the host calls with: the one this install holds, which a
// push to the host's doors presents back.
let hostCredential;

/** Push to one of the host's doors. */
async function push(door, body) {
  if (!hostUrl) throw new Error('LF_HOST_URL is not set: start this external under `lf serve`');
  if (!hostCredential) throw new Error('the host has not called yet, so there is no credential to present');
  const response = await fetch(new URL(`/api/public/adapter/acme_crm/${door}`, hostUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: hostCredential },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// A user changes the CRM itself; the CRM tells the host.
const DEV_ROUTES = {
  '/dev/companies': async (body) => {
    if (typeof body?.Name !== 'string') return [400, { error: 'expected { Name }' }];
    const state = readState();
    const externalId = `company-${state.companies.length + 1}`;
    state.companies.push({ externalId, fields: { Name: body.Name } });
    writeState(state);
    const pushed = await push('emit', { events: [companyCreatedEvent({ id: externalId, Name: body.Name })] });
    return [200, { id: externalId, pushed }];
  },
  '/dev/comments': async (body) => {
    if (typeof body?.company !== 'string' || typeof body?.text !== 'string') return [400, { error: 'expected { company, text }' }];
    const state = readState();
    const comment = { id: `comment-${state.comments.length + 1}`, thread: body.company, Text: body.text };
    state.comments.push(comment);
    writeState(state);
    const pushed = await push('wake', { keys: [threadKey(body.company)] });
    return [200, { id: comment.id, pushed }];
  },
};

// A file arrives as a descriptor whose bytes the host exposed at a URL (they
// cannot ride the JSON envelope): fetch them, and keep their text.
async function withFileContents(fields) {
  const out = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (value && typeof value === 'object' && value.__brand === 'FileRef' && typeof value.url === 'string') {
      const res = await fetch(value.url);
      out[name] = { name: value.name ?? null, contentType: value.contentType ?? null, text: await res.text() };
    } else out[name] = value;
  }
  return out;
}

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
    const dev = DEV_ROUTES[req.url ?? ''];
    if (dev) {
      try {
        const [status, answer] = await dev(body ? JSON.parse(body) : {});
        return send(res, status, answer);
      } catch (error) {
        return send(res, 500, { error: String(error?.message ?? error) });
      }
    }
    // The host hands the install's credential on every call; this CRM only
    // asks that one is there.
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
      return send(res, 200, { ok: false, error: { code: 'unauthorized', message: 'no credential', retryable: false } });
    }
    hostCredential = req.headers.authorization;
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
  // The host reads the bound port from this line; a developer (or a test)
  // driving the dev routes reads it beside the state file.
  const bound = server.address().port;
  if (statePath) writeFileSync(join(dirname(statePath), 'port'), String(bound));
  process.stdout.write(`listening ${bound}\n`);
});
