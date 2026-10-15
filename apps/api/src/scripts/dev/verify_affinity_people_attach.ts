/**
 * Matching is not associating — end to end against a live fake Affinity.
 *
 * The production bug (run 3285f127): `write org-[:People]-> { \`First name\`
 * ?: …, \`Last name\` ?: … }` against a person who already existed with those
 * exact names reported `action: "update", committed: true` with a parent on
 * the record — and no person ever joined the organization. The engine
 * suppressed every field, found nothing left to send, and returned without
 * ever calling the adapter. The adapter is where the association is made.
 *
 * Seven things to see:
 *   1. the person joins the org even though not one of their own fields
 *      changed, and the run calls it `attach` — with the association the
 *      target CONFIRMED (`made`), not one the engine assumed;
 *   2. running it again is free — the person is already a member, so no PUT
 *      is sent at all, and it still reads `attach`, now `already`;
 *   3. the same suppression with NO parent sends nothing and reads `noop`;
 *   4. a write with a genuinely changed field still reads `update`;
 *   5. `link org -[:People]-> p` joins the same association the write does,
 *      through the same code — one PUT, then nothing on a re-run — and
 *      `unlink` takes it back;
 *   6. `link org -[:List Entries]-> entry` is refused at CHECK time: Affinity
 *      makes a membership by adding a company to a list, and cannot point an
 *      entry that already exists at a different one;
 *   7. a pinned person update reads the person ONCE for the whole run. The
 *      engine's no-op detection read (`readRecord`) and the write's own read
 *      are the same question, and the run's read memo answers the second from
 *      the first — where the write alone used to make three.
 *
 * The write carries the person's address as well as their names — Affinity's
 * identity surface matches a person on their address first, so the whole leg
 * runs offline. (A names-only write matches too, through the name matcher's
 * two model calls; the address keeps this script deterministic.)
 *
 * Usage:
 *   FAKE_CHANNELS_PORT=6377 npx tsx apps/fake-channels/src/index.ts   # or the dev loop
 *   FAKE_BASE=http://localhost:6377/affinity npx tsx apps/api/src/scripts/dev/verify_affinity_people_attach.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import { checkProgram, fromCatalogSnapshot, parseProgram, type CatalogSnapshot } from 'movement-lang';

import type { WriteRecord } from 'movement-engine/services/movement_engine/expression';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

import { runMovement } from 'movement-engine/services/movement_engine/run';
import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import {
  AffinityAdapter,
  AFFINITY_MANIFEST,
} from '../../services/translation_graph/adapters/affinity';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';
import { everyCredential, probeEngineHost } from './lib/probe_host';
import { tenantOfTeam } from '../../services/translation_graph/movement/tenant';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6377/affinity';
const TEAM_ID = '00000000-0000-0000-0000-000000000011' as TeamId;
const AUTH = 'Basic ' + Buffer.from(':fake').toString('base64');

// A run of its own each time, so a re-run of this script starts from a person
// and an org that nothing else has touched.
const STAMP = Date.now().toString(36).slice(-5);
const ORG_NAME = `Attach Labs ${STAMP}`;
const FIRST = 'Ada';
const LAST = `Lovelace${STAMP}`;
const EMAIL = `ada-${STAMP}@attach.test`;

const requests: string[] = [];

function adapterOnFake(): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: TEAM_ID,
    credentialsId: 'creds-verify' as ExternalServiceCredentialsId,
  });
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  const send = client.fetch.bind(client);
  Object.assign(client, {
    fetch: async (args: { route: string; method: string; query?: Record<string, string> }) => {
      const query = args.query ? `?${new URLSearchParams(args.query).toString()}` : '';
      requests.push(`${args.method} ${args.route}${query}`);
      return send(args as Parameters<typeof send>[0]);
    },
  });
  Object.assign(adapter, {
    getApiClient: async () => {
      Object.assign(adapter, { web: { getWebBaseUrl: async () => 'https://fake.affinity.co' } });
      return client;
    },
  });
  return adapter;
}

async function snapshot(adapter: AffinityAdapter): Promise<CatalogSnapshot> {
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map(
    (
      await Promise.all(
        entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
      )
    ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
  );
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'affinity',
    entries,
    descriptors,
    supportsInPlaceUpdate: true,
  });
  return {
    adapters: {
      affinity: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        canFire: true,
        triggerConfig: ['events'],
        triggerConfigOptions: { events: [...(AFFINITY_MANIFEST.subscribableEvents ?? [])] },
        schemas: { affinity_creds: schema },
      },
    },
    credentials: { affinity_creds: { adapters: ['affinity'] } },
    plugins: {},
  };
}

const HEADER = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)
`;

/** The production shape: the org is found by name, the person hangs off it by
 *  the built-in `People` edge, and every field is set-if-empty — so against a
 *  person who already carries them, nothing of the person's own is sent. */
const ATTACH = `${HEADER}
movement attach(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
  }
  write org-[:\`People\`]-> {
    \`First name\` ?: "${FIRST}"
    \`Last name\` ?: "${LAST}"
    \`Email\` ?: "${EMAIL}"
  }
}`;

/** The same suppressed person write with no parent at all — the other half of
 *  the story: nothing to send, and nothing to attach it to. */
const ROOTED = `${HEADER}
movement rooted(e: <crm-[:\`Organization\`]->>) {
  write crm-[:\`Person\`]-> {
    \`First name\` ?: "${FIRST}"
    \`Last name\` ?: "${LAST}"
    \`Email\` ?: "${EMAIL}"
  }
}`;

/** One field genuinely different — the write the engine has always sent, still
 *  reading `update` with its parent alongside. */
const RENAME = `${HEADER}
movement rename(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
  }
  write org-[:\`People\`]-> {
    \`Last name\`: "${LAST}Renamed"
    \`Email\` ?: "${EMAIL}"
  }
}`;

/** The standalone link statements, over the same two records the write joins:
 *  `link` must reach the SAME association a linked write makes, because it is
 *  the same code — and `unlink` must take it back. */
const LINK = `${HEADER}
movement joinUp(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
  }
  p = write crm-[:\`Person\`]-> {
    \`First name\` ?: "${FIRST}"
    \`Last name\` ?: "${LAST}"
    \`Email\` ?: "${EMAIL}"
  }
  link org -[:\`People\`]-> p
}`;

const UNLINK = `${HEADER}
movement partWays(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
  }
  p = write crm-[:\`Person\`]-> {
    \`First name\` ?: "${FIRST}"
    \`Last name\` ?: "${LAST}"
    \`Email\` ?: "${EMAIL}"
  }
  unlink org -[:\`People\`]-> p
}`;

/** A `link` along an edge Affinity can only WRITE along. Membership is made by
 *  adding a company to a list; an entry that already exists IS its (list,
 *  member) pair, so there is nothing to point at a different list. */
const LINK_ENTRY = `${HEADER}
movement joinList(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
  }
  entry = write org-[:\`List Entries\`]-> {
    \`listName\`: "Pipeline"
  }
  link org -[:\`List Entries\`]-> entry
}`;

const event = {
  pipelineInputId: 'pi-verify',
  adapterType: 'affinity',
  triggerType: 'webhook' as const,
  payload: {},
};

async function run(
  source: string,
  movementName: string,
  adapter: AffinityAdapter,
  catalog: CatalogSnapshot,
): Promise<{ writes: WriteRecord[]; sent: string[] }> {
  const mark = requests.length;
  const result = await runMovement({
    source,
    movementName,
    event,
    teamId: tenantOfTeam(TEAM_ID),
    catalog,
    credentialIds: everyCredential(catalog, 'creds-verify'),
    host: probeEngineHost({
      teamId: TEAM_ID,
      resolve: () => adapter,
    }),
  });
  return { writes: result.writes, sent: requests.slice(mark) };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** An org, and a person of the same name who belongs to NOTHING — the exact
 *  state the production run met. */
async function seed(): Promise<{ orgId: number; personId: number }> {
  const org = await api<{ id: number }>('/organizations', {
    method: 'POST',
    body: JSON.stringify({ name: ORG_NAME, domain: `attach-${STAMP}.test` }),
  });
  const person = await api<{ id: number }>('/persons', {
    method: 'POST',
    body: JSON.stringify({
      first_name: FIRST,
      last_name: LAST,
      emails: [EMAIL],
      organization_ids: [],
    }),
  });
  return { orgId: org.id, personId: person.id };
}

const membership = (personId: number) =>
  api<{ organization_ids?: number[] }>(`/persons/${personId}`).then(
    (p) => p.organization_ids ?? [],
  );

/** What the run record says a write did, in the currency the inspection
 *  surface reports (`kind` wins, else the engine's own outcome). */
const action = (w: WriteRecord) => w.kind ?? w.outcome ?? (w.created ? 'create' : 'update');

const puts = (sent: string[]) => sent.filter((r) => r.startsWith('PUT /persons/'));
const personGets = (sent: string[], personId: number) =>
  sent.filter((r) => r === `GET /persons/${personId}`);

async function main() {
  const { orgId, personId } = await seed();
  console.log(`\n── seeded org ${orgId} "${ORG_NAME}", person ${personId} "${FIRST} ${LAST}"`);
  console.log(`   the person's organizations before: ${JSON.stringify(await membership(personId))}`);

  const adapter = adapterOnFake();
  const catalog = await snapshot(adapter);

  console.log('\n── 1. the write, against a person whose every field already matches');
  const first = await run(ATTACH, 'attach', adapter, catalog);
  console.log(`   writes: ${JSON.stringify(first.writes.map((w) => [w.recordType, action(w), w.writtenValues]))}`);
  console.log(`   parents on the person write: ${JSON.stringify(first.writes[1]?.parents)}`);
  console.log(`   the person's organizations after: ${JSON.stringify(await membership(personId))}`);
  console.log(`   person PUTs: ${JSON.stringify(puts(first.sent))}`);

  console.log('\n── 2. the same run again — the person already belongs to the org');
  const second = await run(ATTACH, 'attach', adapter, catalog);
  console.log(`   writes: ${JSON.stringify(second.writes.map((w) => [w.recordType, action(w)]))}`);
  console.log(`   the person's organizations after: ${JSON.stringify(await membership(personId))}`);
  console.log(`   person PUTs: ${JSON.stringify(puts(second.sent))}`);

  console.log('\n── 3. the same suppression with no parent to attach to');
  const rooted = await run(ROOTED, 'rooted', adapter, catalog);
  console.log(`   writes: ${JSON.stringify(rooted.writes.map((w) => [w.recordType, action(w), w.writtenValues]))}`);
  console.log(`   person PUTs: ${JSON.stringify(puts(rooted.sent))}`);

  console.log('\n── 4. a genuinely changed field on the same person');
  const changed = await run(RENAME, 'rename', adapter, catalog);
  console.log(`   writes: ${JSON.stringify(changed.writes.map((w) => [w.recordType, action(w), w.writtenValues]))}`);
  console.log(`   person PUTs: ${JSON.stringify(puts(changed.sent))}`);

  console.log('\n── 5. `link org -[:People]-> p` — the same association, joined by hand');
  await api(`/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({ organization_ids: [] }),
  });
  const linked = await run(LINK, 'joinUp', adapter, catalog);
  console.log(`   the person's organizations after: ${JSON.stringify(await membership(personId))}`);
  console.log(`   person PUTs: ${JSON.stringify(puts(linked.sent))}`);
  const relinked = await run(LINK, 'joinUp', adapter, catalog);
  console.log(`   a second link sends: ${JSON.stringify(puts(relinked.sent))}`);
  const unlinked = await run(UNLINK, 'partWays', adapter, catalog);
  const afterUnlink = await membership(personId);
  console.log(`   after unlink: ${JSON.stringify(afterUnlink)} (PUTs ${JSON.stringify(puts(unlinked.sent))})`);

  console.log('\n── 6. `link org -[:List Entries]-> entry` — refused at check time');
  const refusals = checkProgram(parseProgram(LINK_ENTRY), fromCatalogSnapshot(catalog)).filter(
    (d) => d.code === 'MOV_LINK_UNSUPPORTED_EDGE',
  );
  console.log(`   diagnostics: ${JSON.stringify(refusals.map((d) => d.message))}`);

  console.log('\n── 7. one read of the person for the whole run');
  await api(`/persons/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({ organization_ids: [] }),
  });
  const reads = await run(ATTACH, 'attach', adapter, catalog);
  console.log(`   GET /persons/${personId}: ${personGets(reads.sent, personId).length}`);
  console.log(`   every person call: ${JSON.stringify(reads.sent.filter((r) => r.includes('/persons')))}`);

  const orgs = await membership(personId);
  const ok =
    orgs.includes(orgId) &&
    action(first.writes[1]) === 'attach' &&
    first.writes[1].association === 'made' &&
    puts(first.sent).length === 1 &&
    action(second.writes[1]) === 'attach' &&
    second.writes[1].association === 'already' &&
    puts(second.sent).length === 0 &&
    action(changed.writes[1]) === 'update' &&
    changed.writes[1].association === 'already' &&
    action(rooted.writes[0]) === 'noop' &&
    puts(rooted.sent).length === 0 &&
    // 5 — the standalone link makes the association, is idempotent, and
    // unlink takes it back.
    puts(linked.sent).length === 1 &&
    puts(relinked.sent).length === 0 &&
    afterUnlink.includes(orgId) === false &&
    // 6 — the checker refuses the link Affinity cannot make.
    refusals.length === 1 &&
    // 7 — ONE read of the person for the run: the engine's no-op detection
    // read, which the write's own read is then served from.
    personGets(reads.sent, personId).length === 1;

  console.log(`\n── ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

void main();
