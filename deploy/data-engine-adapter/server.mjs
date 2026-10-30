// Skaala's data engine as a TARS remote adapter: one POST endpoint speaking
// the remote adapter wire protocol, translated to the data engine's
// `deal-ingest` edge function (SKA-406). No dependencies; Node 20+.
//
// Graph:  data_engine -[:Deal]-> Deal { Title, LinearIdentifier, … }  (create only)
// A Deal write registers the deal at intake (`POST …/register-deal`). The
// automation's extracted fields go to `intake` as extracted; the deal's own
// fields that the intake cannot know (kind, sleeve, manager, fund, currency)
// are sent as null. The function refuses unknown keys and a top-level "".
//
// Env: ADAPTER_SECRET (the bearer TARS sends), DEAL_INGEST_URL (the full
// `…/deal-ingest/register-deal` URL), DEAL_INTAKE_TOKEN (its register-only
// token), PORT.

import http from 'node:http';

const ADAPTER = process.env.ADAPTER_TYPE ?? 'data_engine';
const SECRET = process.env.ADAPTER_SECRET;
const INGEST_URL = process.env.DEAL_INGEST_URL;
const INTAKE_TOKEN = process.env.DEAL_INTAKE_TOKEN;

const field = (fieldId, kind = 'string', extra = {}) => ({ fieldId, displayName: fieldId, kind, writable: true, required: false, ...extra });

// Deal field → intake key, for the fields the triage extracts.
const INTAKE = {
  IsDeal: 'is_deal',
  Name: 'name',
  Sender: 'sender',
  Ask: 'ask',
  Summary: 'summary',
  Links: 'links',
  Points: 'points',
  Amount: 'amount',
};

const TYPES = {
  Deal: {
    typeId: 'Deal',
    displayName: 'Deal',
    fields: [
      field('Title', 'string', { required: true }),
      field('Description'),
      field('LinearIdentifier', 'string', { required: true }),
      field('LinearURL'),
      field('AssetClass'),
      ...Object.keys(INTAKE).map((f) => field(f, f === 'IsDeal' ? 'boolean' : 'string')),
      field('DealId', 'string', { writable: false }),
    ],
    references: [],
  },
};

const ENTRY_POINTS = [{ typeId: 'Deal', displayName: 'Deal', scope: 'self-configured', readable: false, writable: true }];

class AdapterError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

async function registerDeal(payload) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTAKE_TOKEN}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = [body.code, body.error].filter((v) => typeof v === 'string').join(': ');
    throw new AdapterError('adapter_error', `data engine refused the deal: HTTP ${res.status}${reason ? ` (${reason})` : ''}`, res.status >= 500 || res.status === 429);
  }
  return body;
}

// A top-level field with no value is null: the function refuses "".
const value = (v) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v);

const methods = {
  listEntryPoints: async () => ENTRY_POINTS,
  describe: async ({ typeId }) => TYPES[typeId] ?? null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async ({ position, fieldId }) => position?.identity?.data?.[fieldId] ?? null,
  getRelated: async () => [],

  createRecord: async ({ recordType, fields }) => {
    if (recordType !== 'Deal') throw new AdapterError('bad_request', `cannot create a ${recordType}`);
    if (!value(fields.Title)) throw new AdapterError('bad_request', 'a Deal needs a Title');
    if (!value(fields.LinearIdentifier)) throw new AdapterError('bad_request', 'a Deal needs a LinearIdentifier');
    const body = await registerDeal({
      title: String(fields.Title),
      description: value(fields.Description),
      linear_identifier: String(fields.LinearIdentifier),
      linear_url: value(fields.LinearURL),
      asset_class: value(fields.AssetClass),
      kind: null,
      sleeve: null,
      manager_id: null,
      fund_id: null,
      currency: null,
      source: 'listen_fire',
      // Inside intake "" is fine; an absent text is "", an absent IsDeal null.
      intake: Object.fromEntries(Object.entries(INTAKE).map(([f, key]) => [key, fields[f] ?? (f === 'IsDeal' ? null : '')])),
    });
    const dealId = String(body.deal_id ?? body.id ?? fields.LinearIdentifier);
    return { adapterType: ADAPTER, externalId: dealId, recordType: 'Deal', data: { DealId: dealId } };
  },
};

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handle(req, res) {
  if (req.method === 'GET') return send(res, 200, { ok: true, adapter: ADAPTER });
  if (req.method !== 'POST') return send(res, 405, { ok: false });
  if (req.headers.authorization !== `Bearer ${SECRET}`) return send(res, 401, { ok: false });

  let envelope;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { ok: false });
  }

  const method = methods[envelope?.method];
  if (!method) {
    return send(res, 200, { ok: false, error: { code: 'method_not_implemented', message: `${envelope?.method} is not supported`, retryable: false } });
  }
  try {
    send(res, 200, { ok: true, result: await method(envelope.params ?? {}) });
  } catch (err) {
    const known = err instanceof AdapterError;
    if (!known) console.error(err);
    send(res, 200, {
      ok: false,
      error: { code: known ? err.code : 'adapter_error', message: err.message, retryable: known ? err.retryable : true },
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!SECRET || !INGEST_URL || !INTAKE_TOKEN) {
    console.error('ADAPTER_SECRET, DEAL_INGEST_URL and DEAL_INTAKE_TOKEN must all be set');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 10000);
  http.createServer(handle).listen(port, () => console.log(`data engine adapter on :${port}`));
}
