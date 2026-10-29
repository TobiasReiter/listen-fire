// Self-check: `node check.mjs`. Stands up the adapter against a stub
// `deal-ingest` and walks the calls TARS makes: auth, schema, register a
// deal, a refusal.

import http from 'node:http';
import assert from 'node:assert/strict';

const received = [];
let refuse = false;
const ingestStub = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  assert.equal(req.url, '/functions/v1/deal-ingest/register-deal');
  assert.equal(req.headers.authorization, 'Bearer intake-token');
  if (refuse) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'unknown key: foo' })); }
  received.push(JSON.parse(body));
  res.end(JSON.stringify({ deal_id: 'd1' }));
});
await new Promise((r) => ingestStub.listen(0, r));

process.env.ADAPTER_SECRET = 's3cret';
process.env.DEAL_INTAKE_TOKEN = 'intake-token';
process.env.DEAL_INGEST_URL = `http://127.0.0.1:${ingestStub.address().port}/functions/v1/deal-ingest/`;
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
})).body;
assert.equal(ok.result.data.DealId, 'd1');
assert.deepEqual(received[0], {
  title: 'Example Fund · Venture',
  description: '**From:** someone',
  linear_identifier: 'INV-1',
  linear_url: 'https://linear.app/x/issue/INV-1',
  asset_class: 'Venture',
  source: 'listen_fire',
  intake: { is_deal: true, name: 'Example Fund', asset_class: 'Venture', sender: 'someone', ask: '$5m Series A', summary: 'A fund.', links: null, points: null, amount: null },
});

assert.match((await write({ Title: 'x' })).body.error.message, /LinearIdentifier/);

refuse = true;
const refused = (await write({ Title: 'x', LinearIdentifier: 'INV-2' })).body;
assert.equal(refused.ok, false);
assert.match(refused.error.message, /HTTP 400 \(unknown key: foo\)/);
assert.equal(refused.error.retryable, false);

assert.equal((await call('updateRecord', {})).body.error.code, 'method_not_implemented');

adapter.close();
ingestStub.close();
console.log('data engine adapter: all checks passed');
