// Self-check: `node check.mjs`. Stands up the adapter against a stub
// `deal-ingest` and walks the calls TARS makes: auth, schema, register a
// deal, a refusal, and storing its files (stored, duplicate, skipped, failed).

import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const received = [];
const slots = [];
const puts = [];
const completed = [];
let refuse = false;
let base;
// The stub doubles as TARS's file buffer (/blob/…) and the storage bucket (/put).
const ingestStub = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === '/blob/deck.pdf' || req.url === '/blob/deck.bin') return res.end('PDFBYTES');
  if (req.url === '/blob/old.pdf') return res.end('OLDBYTES');
  if (req.method === 'GET') { res.statusCode = 404; return res.end(); }
  if (req.url === '/put') { puts.push({ body: body.toString(), type: req.headers['content-type'], auth: req.headers.authorization }); return res.end(); }
  assert.equal(req.headers.authorization, 'Bearer intake-token');
  const json = JSON.parse(body.toString());
  if (req.url === '/functions/v1/deal-ingest/deal-files/upload-url') {
    slots.push(json);
    return res.end(JSON.stringify(json.name === 'old.pdf' ? { duplicate: true } : { upload_id: `u${slots.length}`, upload_url: `${base}/put` }));
  }
  if (req.url === '/functions/v1/deal-ingest/deal-files/complete') { completed.push(json); return res.end('{}'); }
  assert.equal(req.url, '/functions/v1/deal-ingest/register-deal');
  if (refuse) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown key: foo', code: 'invalid_payload' })); }
  received.push(json);
  res.end(JSON.stringify({ created: true, deal_id: 'd1', intake_version: 1 }));
});
await new Promise((r) => ingestStub.listen(0, r));
base = `http://127.0.0.1:${ingestStub.address().port}`;

process.env.ADAPTER_SECRET = 's3cret';
process.env.DEAL_INTAKE_TOKEN = 'intake-token';
process.env.SLACK_WORKSPACE_URL = 'https://example.slack.com/';
process.env.DEAL_INGEST_URL = `http://127.0.0.1:${ingestStub.address().port}/functions/v1/deal-ingest/register-deal`;
const { handle } = await import('./server.mjs');
const adapter = http.createServer(handle);
await new Promise((r) => adapter.listen(0, r));
const url = `http://127.0.0.1:${adapter.address().port}/`;

async function call(method, params, secret = 's3cret') {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ protocolVersion: '1', method, cacheScopeId: 'x', params }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
}

assert.equal((await call('listEntryPoints', {}, 'wrong')).status, 401);
assert.equal((await call('listEntryPoints', {})).body.result[0].typeId, 'Deal');
assert.equal((await call('describe', { typeId: 'Deal' })).body.result.fields.find((f) => f.fieldId === 'IsDeal').kind, 'boolean');

const write = (fields) => call('createRecord', { recordType: 'Deal', fields, parentLinks: [], mutationContext: {} });
const ok = (await write({
  Title: 'Example Fund · Venture',
  Description: '**From:** someone',
  LinearIdentifier: 'INV-1',
  LinearURL: 'https://linear.app/x/issue/INV-1',
  IsDeal: true,
  Name: 'Example Fund',
  AssetClass: 'Venture',
  Sender: 'someone',
  Ask: '$5m Series A',
  Summary: 'A fund.',
  Links: '',
  Points: '',
  SlackURL: 'slack://archives/C1/p1',
})).body;
assert.equal(ok.result.data.DealId, 'd1');
assert.deepEqual(received[0], {
  title: 'Example Fund · Venture',
  description: '**From:** someone',
  linear_identifier: 'INV-1',
  linear_url: 'https://linear.app/x/issue/INV-1',
  asset_class: 'Venture',
  class_key: 'venture',
  kind: null,
  sleeve: null,
  manager_id: null,
  fund_id: null,
  currency: null,
  source: 'listen_fire',
  intake: { is_deal: true, name: 'Example Fund', sender: 'someone', ask: '$5m Series A', summary: 'A fund.', links: '', points: '', amount: '', slack_url: 'https://example.slack.com/archives/C1/p1' },
});

assert.match((await write({ Title: 'x' })).body.error.message, /LinearIdentifier/);

// A top-level field with no value goes as null, never "".
await write({ Title: 'x', LinearIdentifier: 'INV-3', LinearURL: '', AssetClass: ' ' });
assert.equal(received[1].linear_url, null);
assert.equal(received[1].asset_class, null);
assert.equal(received[1].class_key, null);
assert.equal(received[1].description, null);

// Files: one stored (typed by extension), one already stored, two skipped,
// one that cannot be fetched. None of them fails the write.
const withFiles = (await write({
  Title: 'F', LinearIdentifier: 'INV-4',
  Files: [
    { name: 'deck.bin', contentType: 'application/octet-stream', url: `${base}/blob/deck.bin` },
    { name: 'deck.pdf', contentType: 'application/pdf', url: `${base}/blob/deck.pdf` },
    { name: 'old.pdf', contentType: 'application/pdf', url: `${base}/blob/old.pdf` },
    { name: 'movie.mp4', contentType: 'video/mp4', url: `${base}/blob/movie.mp4` },
    { name: 'huge.pdf', contentType: 'application/pdf', size: 16 * 1024 * 1024, url: `${base}/blob/huge.pdf` },
    { name: 'gone.pdf', contentType: 'application/pdf', url: `${base}/blob/gone.pdf` },
  ],
})).body;
assert.equal(withFiles.ok, true);
assert.equal(withFiles.result.data.Skipped, 'deck.bin (unsupported type application/octet-stream)\nmovie.mp4 (unsupported type video/mp4)\nhuge.pdf (over 15 MiB)');
assert.equal(withFiles.result.data.Stored, 'deck.pdf\nold.pdf (already stored)');
assert.equal(withFiles.result.data.Failed, 'gone.pdf (could not fetch it: HTTP 404)');
const sha = createHash('sha256').update('PDFBYTES').digest('hex');
assert.deepEqual(slots[0], { linear_identifier: 'INV-4', name: 'deck.pdf', size: 8, content_type: 'application/pdf', sha256: sha });
assert.deepEqual(puts, [{ body: 'PDFBYTES', type: 'application/pdf', auth: undefined }]);
assert.deepEqual(completed, [{ ...slots[0], upload_id: 'u1' }]);
assert.equal(slots.length, 2);

// An extension the engine accepts types an octet-stream attachment.
await write({ Title: 'F', LinearIdentifier: 'INV-5', Files: [{ name: 'notes.MD', contentType: 'application/octet-stream', url: `${base}/blob/deck.pdf` }] });
assert.equal(slots.at(-1).content_type, 'text/markdown');

refuse = true;
const refused = (await write({ Title: 'x', LinearIdentifier: 'INV-2' })).body;
assert.equal(refused.ok, false);
assert.match(refused.error.message, /HTTP 400 \(invalid_payload: unknown key: foo\)/);
assert.equal(refused.error.retryable, false);

assert.equal((await call('updateRecord', {})).body.error.code, 'method_not_implemented');

adapter.close();
ingestStub.close();
console.log('data engine adapter: all checks passed');
