// Skaala's data engine as a TARS remote adapter: one POST endpoint speaking
// the remote adapter wire protocol, translated to the data engine's
// `deal-ingest` edge function (SKA-406). No dependencies; Node 20+.
//
// Graph:  data_engine -[:Deal]-> Deal { Title, LinearIdentifier, … }  (create only)
// A Deal write registers the deal at intake (`POST …/register-deal`). The
// automation's extracted fields go to `intake` as extracted; the deal's own
// fields that the intake cannot know (kind, sleeve, manager, fund, currency)
// are sent as null. The function refuses unknown keys and a top-level "".
// Then each of the Deal's Files is stored through `deal-files` (upload-url,
// PUT, complete). A file that is skipped or fails never fails the write: it
// comes back in Skipped / Failed for the automation to report.
//
// Env: ADAPTER_SECRET (the bearer TARS sends), DEAL_INGEST_URL (the full
// `…/deal-ingest/register-deal` URL; the file routes sit beside it),
// DEAL_INTAKE_TOKEN (its token for registering deals and storing their
// files), SLACK_WORKSPACE_URL (e.g. https://acme.slack.com, to turn TARS's
// `slack://archives/…` post links into web links), PORT.

import http from 'node:http';
import { createHash } from 'node:crypto';

const ADAPTER = process.env.ADAPTER_TYPE ?? 'data_engine';
const SECRET = process.env.ADAPTER_SECRET;
const INGEST_URL = process.env.DEAL_INGEST_URL;
const BASE = INGEST_URL?.replace(/\/register-deal\/?$/, '');
const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL?.replace(/\/+$/, '');
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
  SlackURL: 'slack_url',
};

// The triage's asset class → the data engine's fixed class_key (SKA-416).
// Macro / Multi-asset counts as absolute return, as Tars maps it. Unclear
// goes as null and the deal shows as Unassigned for the team to set.
const CLASS_KEYS = {
  'Absolute Return': 'absolute_return',
  'Macro / Multi-asset': 'absolute_return',
  'Public Equity': 'public_equity',
  Venture: 'venture',
  'Private Equity': 'private_equity',
  'Private Credit': 'private_credit',
  'Real Assets': 'real_assets',
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
      field('Files', 'file', { cardinality: 'many' }),
      field('DealId', 'string', { writable: false }),
      // One line per file, "name (reason)"; empty when there are none.
      field('Stored', 'string', { writable: false }),
      field('Skipped', 'string', { writable: false }),
      field('Failed', 'string', { writable: false }),
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

async function ingest(path, payload, what) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${INTAKE_TOKEN}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = [body.code, body.error].filter((v) => typeof v === 'string').join(': ');
    throw new AdapterError('adapter_error', `data engine refused ${what}: HTTP ${res.status}${reason ? ` (${reason})` : ''}`, res.status >= 500 || res.status === 429);
  }
  return body;
}

const MAX_FILE_BYTES = 15 * 1024 * 1024;

// The types the data engine stores, by MIME type and by extension (mail
// attachments often arrive as application/octet-stream).
const TYPES_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  eml: 'message/rfc822',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ALLOWED_TYPES = new Set(Object.values(TYPES_BY_EXT));

function contentTypeOf(ref) {
  const given = String(ref.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_TYPES.has(given)) return given;
  return TYPES_BY_EXT[String(ref.name ?? '').split('.').pop().toLowerCase()];
}

// One file into the data engine. Returns 'stored' or 'already stored', or
// throws { skip } / an error with the reason.
async function storeFile(linearIdentifier, ref) {
  const name = ref.name ?? 'attachment';
  const contentType = contentTypeOf(ref);
  if (!contentType) throw Object.assign(new Error(`unsupported type ${ref.contentType ?? 'unknown'}`), { skip: true });
  if (ref.size > MAX_FILE_BYTES) throw Object.assign(new Error('over 15 MiB'), { skip: true });
  if (!ref.url) throw new Error('came without a url');
  const res = await fetch(ref.url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`could not fetch it: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw Object.assign(new Error('over 15 MiB'), { skip: true });

  const meta = { linear_identifier: linearIdentifier, name, size: bytes.length, content_type: contentType, sha256: createHash('sha256').update(bytes).digest('hex') };
  const slot = await ingest('/deal-files/upload-url', meta, `"${name}"`);
  if (slot.duplicate === true) return 'already stored';
  const put = await fetch(slot.upload_url, { method: 'PUT', headers: { 'content-type': contentType }, body: bytes, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new Error(`the upload was refused: HTTP ${put.status}`);
  await ingest('/deal-files/complete', { ...meta, upload_id: slot.upload_id }, `"${name}"`);
  return 'stored';
}

// TARS links a Slack post as `slack://archives/<channel>/p<ts>`, which only
// the desktop app opens; the same path under the workspace's address is the
// message's web permalink.
const slackWebUrl = (v) => (typeof v === 'string' && SLACK_WORKSPACE_URL ? v.replace(/^slack:\/\//, `${SLACK_WORKSPACE_URL}/`) : v);

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
    const body = await ingest('/register-deal', {
      title: String(fields.Title),
      description: value(fields.Description),
      linear_identifier: String(fields.LinearIdentifier),
      linear_url: value(fields.LinearURL),
      asset_class: value(fields.AssetClass),
      class_key: CLASS_KEYS[fields.AssetClass] ?? null,
      kind: null,
      sleeve: null,
      manager_id: null,
      fund_id: null,
      currency: null,
      source: 'listen_fire',
      // Inside intake "" is fine; an absent text is "", an absent IsDeal null.
      intake: Object.fromEntries(Object.entries(INTAKE).map(([f, key]) => [key, (f === 'SlackURL' ? slackWebUrl(fields[f]) : fields[f]) ?? (f === 'IsDeal' ? null : '')])),
    }, 'the deal');
    const dealId = String(body.deal_id ?? body.id ?? fields.LinearIdentifier);

    const outcome = { Stored: [], Skipped: [], Failed: [] };
    for (const ref of Array.isArray(fields.Files) ? fields.Files : fields.Files ? [fields.Files] : []) {
      const name = ref?.name ?? 'attachment';
      try {
        const done = await storeFile(String(fields.LinearIdentifier), ref ?? {});
        outcome.Stored.push(done === 'stored' ? name : `${name} (${done})`);
      } catch (err) {
        outcome[err.skip ? 'Skipped' : 'Failed'].push(`${name} (${err.message})`);
      }
    }
    if (outcome.Skipped.length + outcome.Failed.length > 0) console.log(`${fields.LinearIdentifier}: ${JSON.stringify(outcome)}`);
    const lines = (list) => list.join('\n');
    return {
      adapterType: ADAPTER,
      externalId: dealId,
      recordType: 'Deal',
      data: { DealId: dealId, Stored: lines(outcome.Stored), Skipped: lines(outcome.Skipped), Failed: lines(outcome.Failed) },
    };
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
