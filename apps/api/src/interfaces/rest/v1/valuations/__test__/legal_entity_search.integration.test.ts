// `GET /legal-entities?search=` finds an entity by any name it answers to,
// spelled roughly: suffix variants reach it through the search vector's tokens
// (Also Known As, Legal Name), a typo through trigram similarity on Name, and
// the best match comes first. Runs the real router against the test database.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import express, { type Router } from 'express';

import type { AddressInfo } from 'node:net';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../../../lib/kysely';
import { Context } from '../../../../../services/context';
import { userPrincipal } from '../../../../../services/principal';
import LegalEntityType from '../../../../../generated/kysely/valuations/LegalEntityType';
import { legalEntitiesRouter } from '../resources';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

let teamId: TeamId;
let userId: UserId;
let server: Server;
let baseUrl: string;

const entities = [
  { name: 'Acme Limited', also_known_as: 'Acme, ACME Ltd' },
  { name: 'Beta Corp', legal_name: 'Beta Corporation Ltd' },
  { name: 'Gamma' },
];

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  userId = randomUUID() as UserId;
  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: teamId, name: `search-${teamId.slice(0, 8)}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(anyVals({ id: userId, default_team_id: teamId, username: `search-${userId.slice(0, 8)}` }))
    .execute();
  for (const entity of entities) {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(anyVals({ id: randomUUID(), team_id: teamId, type: LegalEntityType.COMPANY, ...entity }))
      .execute();
  }

  const app = express();
  app.use((_req, _res, next) => {
    const ctx = new Context();
    ctx.bindPrincipal(userPrincipal({ userId, teamId }));
    void ctx.runAsync(async () => next());
  });
  app.use('/legal-entities', legalEntitiesRouter as Router);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', teamId).execute();
  await getValuationsQb(['valuations_change_outbox'])
    .deleteFrom('valuations_change_outbox')
    .where('team_id', '=', teamId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

async function search(q: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/legal-entities?search=${encodeURIComponent(q)}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ name: string }> };
  return body.data.map((row) => row.name);
}

it.each([
  ['acme ltd', 'Acme Limited'],
  ['beta corporation', 'Beta Corp'],
  ['gama', 'Gamma'],
])('search %p puts %p first', async (q, expected) => {
  const names = await search(q);
  expect(names[0]).toBe(expected);
});

it('still finds a plain substring of the name', async () => {
  expect(await search('amm')).toEqual(['Gamma']);
});

it('finds nothing for a query unlike any name', async () => {
  expect(await search('zzqx')).toEqual([]);
});
