// Self-check: `node check.mjs`. Stands up the adapter against a stub Linear
// and walks the calls TARS makes: auth, schema, teams, issue create, a
// missing label.

import http from 'node:http';
import assert from 'node:assert/strict';

const created = [];
const linearStub = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const { query, variables } = JSON.parse(body);
  assert.equal(req.headers.authorization, 'lin_api_test');
  let data;
  if (query.includes('teams')) data = { teams: { nodes: [{ id: 't1', name: 'Investments & Research', key: 'INV' }] } };
  else if (query.includes('issueLabels')) data = { issueLabels: { nodes: [{ id: 'l1', name: 'pipeline', isGroup: false }, { id: 'l2', name: 'Venture', isGroup: false }, { id: 'g', name: 'Asset class', isGroup: true }] } };
  else {
    created.push(variables.input);
    data = { issueCreate: { success: true, issue: { id: 'i1', identifier: 'INV-1', url: 'https://linear.app/x/issue/INV-1' } } };
  }
  res.end(JSON.stringify({ data }));
});
await new Promise((r) => linearStub.listen(0, r));

process.env.ADAPTER_SECRET = 's3cret';
process.env.LINEAR_API_KEY = 'lin_api_test';
process.env.LINEAR_API_URL = `http://127.0.0.1:${linearStub.address().port}/`;
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
assert.equal((await call('describe', { typeId: 'Nope' })).body.result, null);
assert.equal((await call('listEntryPoints', {})).body.result.find((e) => e.typeId === 'Issue').writable, true);

const teams = (await call('getRelated', { position: { adapterType: 'linear', recordType: 'meta', identity: { kind: 'unstable' } }, fieldId: 'Team', direction: 'outgoing' })).body.result;
assert.equal(teams[0].position.identity.data.Key, 'INV');
assert.equal((await call('getFieldValue', { position: teams[0].position, fieldId: 'Name' })).body.result, 'Investments & Research');

const write = (labels) => call('createRecord', {
  recordType: 'Issue',
  fields: { Team: 'Investments & Research', Title: 'Example Fund', Description: 'summary', Labels: labels },
  parentLinks: [],
  mutationContext: {},
});
const ok = (await write(['pipeline', 'venture'])).body;
assert.equal(ok.result.data.Identifier, 'INV-1');
assert.deepEqual(created[0], { teamId: 't1', title: 'Example Fund', description: 'summary', labelIds: ['l1', 'l2'] });

const missing = (await write(['pipeline', 'Real Estate'])).body;
assert.equal(missing.ok, false);
assert.match(missing.error.message, /"Real Estate"/);
assert.equal(created.length, 1);

const noTeam = (await call('createRecord', { recordType: 'Issue', fields: { Team: 'Nope', Title: 'x' }, parentLinks: [] })).body;
assert.match(noTeam.error.message, /no team named "Nope"/);

assert.equal((await call('updateRecord', {})).body.error.code, 'method_not_implemented');

adapter.close();
linearStub.close();
console.log('linear adapter: all checks passed');
