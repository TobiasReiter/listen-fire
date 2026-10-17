// The example end to end, over HTTP: customers save movements (checked on
// save), a company created in one customer's CRM fires that customer's
// movements and no other's, a model call is charged to the run, and a run
// past its limits is stopped, and a run that sleeps parks until its time.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { Embedding, DEFAULT_LIMITS } from '../src/embedding';
import { FAKE_CALL_MICRODOLLARS, fakeModels } from '../src/models';
import { saasServer } from '../src/server';
import { companyCreated } from '../src/crm';

const PRELUDE = `import { crm } from adapters
import { workspace } from credentials

app = connect crm using workspace
`;

const WELCOME = `${PRELUDE}
function welcome(company: <app-[:Company]->>) {
  write app-[:Company]-> { Name: "Welcome \${company.Name}", Note: ai("One welcome line for \${company.Name}") }
}

listen to app { events: ["company.created"] } fire welcome
`;

let server: Server;
let base: string;

before(async () => {
  server = saasServer(new Embedding({ models: fakeModels() }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server is not listening on a port');
  base = `http://127.0.0.1:${address.port}`;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

test('a saved movement runs when its event happens, for its own customer only', async () => {
  assert.equal((await call('POST', '/customers', { tenant: 'acme', apiKey: 'acme-key' })).status, 201);
  assert.equal((await call('POST', '/customers', { tenant: 'globex', apiKey: 'globex-key' })).status, 201);
  const saved = await call('PUT', '/customers/acme/movements/welcome', WELCOME);
  assert.deepEqual(saved, { status: 200, body: { saved: true, listens: 1 } });

  const created = await call('POST', '/customers/acme/companies', { Name: 'Vireo' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.runs, [{ movement: 'welcome', outcome: { ok: true, writes: 1, spentMicrodollars: FAKE_CALL_MICRODOLLARS } }]);
  const acme = (await call('GET', '/customers/acme/companies')).body;
  assert.deepEqual(acme.map((c: { Name: string }) => c.Name), ['Vireo', 'Welcome Vireo']);
  assert.match(acme[1].Note, /One welcome line for Vireo/);

  // Globex saved nothing: its company fires nothing, and acme's records are not its.
  const other = await call('POST', '/customers/globex/companies', { Name: 'Initech' });
  assert.deepEqual(other.body.runs, []);
  assert.deepEqual((await call('GET', '/customers/globex/companies')).body.map((c: { Name: string }) => c.Name), ['Initech']);
});

test('a movement that does not check is refused on save, saying why', async () => {
  await call('POST', '/customers', { tenant: 'hooli', apiKey: 'hooli-key' });
  const refused = await call('PUT', '/customers/hooli/movements/bad', WELCOME.replace('[:Company]', '[:Invoice]'));
  assert.equal(refused.status, 422);
  assert.equal(refused.body.saved, false);
  assert.match(refused.body.problems[0], /MOVENG_CHECK/);
});

test('a run past its step limit is stopped', async () => {
  const embedding = new Embedding({ models: fakeModels(), limits: { ...DEFAULT_LIMITS, maxSteps: 2 } });
  embedding.addCustomer('acme', 'acme-key');
  assert.equal((await embedding.save('acme', 'welcome', WELCOME)).saved, true);
  const [run] = await embedding.fire('acme', { payload: { id: 'company-1', Name: 'Vireo' }, externalId: 'company-1', eventType: 'company.created', tag: 'company.created', recordType: 'Company' });
  assert.equal(run.outcome.ok, false);
  assert.match(run.outcome.ok ? '' : run.outcome.error, /MOVENG_LIMIT_STEPS/);
});

test("a run past its cost cap makes no further model call, and waits where it stopped", async () => {
  const spend = `${PRELUDE}
function twice(company: <app-[:Company]->>) {
  one = ai("One line for \${company.Name}")
  two = ai("Another line for \${company.Name}")
  write app-[:Company]-> { Name: "\${one} \${two}" }
}

listen to app { events: ["company.created"] } fire twice
`;
  const embedding = new Embedding({ models: fakeModels(), limits: { ...DEFAULT_LIMITS, costCapMicrodollars: FAKE_CALL_MICRODOLLARS / 2 } });
  embedding.addCustomer('acme', 'acme-key');
  assert.equal((await embedding.save('acme', 'twice', spend)).saved, true);
  const [run] = await embedding.fire('acme', { payload: { id: 'company-1', Name: 'Vireo' }, externalId: 'company-1', eventType: 'company.created', tag: 'company.created', recordType: 'Company' });
  // One call spent past the cap: the second is never made. On a host that can
  // park, the flow suspends there (a limit park, which no timer steps on)
  // rather than failing.
  assert.deepEqual(run.outcome, { ok: true, writes: 0, spentMicrodollars: FAKE_CALL_MICRODOLLARS, parked: true });
  assert.deepEqual(embedding.companies.list('acme'), []);
  assert.deepEqual(await embedding.tick(), []);
});

test('a run that sleeps parks, and the next tick past its wake steps it on to its write', async () => {
  let now = new Date('2026-10-17T09:00:00.000Z');
  const embedding = new Embedding({ models: fakeModels(), now: () => now });
  embedding.addCustomer('acme', 'acme-key');
  const followUp = `${PRELUDE}
function follow_up(company: <app-[:Company]->>) {
  await sleep(1h)
  write app-[:Company]-> { Name: "Follow up \${company.Name}" }
}

listen to app { events: ["company.created"] } fire follow_up
`;
  assert.equal((await embedding.save('acme', 'follow_up', followUp)).saved, true);
  const company = embedding.companies.add('acme', { Name: 'Vireo' });
  const [run] = await embedding.fire('acme', companyCreated(company));
  assert.deepEqual(run.outcome, { ok: true, writes: 0, spentMicrodollars: 0, parked: true });

  // Not yet: the hour has not passed.
  now = new Date('2026-10-17T09:30:00.000Z');
  assert.deepEqual(await embedding.tick(), []);
  assert.deepEqual(embedding.companies.list('acme').map((c) => c.Name), ['Vireo']);

  now = new Date('2026-10-17T10:00:01.000Z');
  assert.deepEqual(await embedding.tick(), [{ movement: 'follow_up', outcome: { ok: true, writes: 1, spentMicrodollars: 0 } }]);
  assert.deepEqual(embedding.companies.list('acme').map((c) => c.Name), ['Vireo', 'Follow up Vireo']);
  // Done with: nothing is left to step.
  assert.deepEqual(await embedding.tick(), []);
});
