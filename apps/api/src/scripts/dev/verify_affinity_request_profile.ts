/**
 * What one deal costs Affinity — the request profile of the production upsert,
 * counted per request class, run against a live fake Affinity.
 *
 * The shape here is the production `Upsert Deal`: a company written by name and
 * domain, added to the Deal Pipeline with that list's own fields, two
 * owners linked onto the entry by address, two founders written onto the
 * company's own person-reference field — preceded by the two dedup reads that
 * ask whether the company and the contact are already in the CRM. It runs
 * twice: once against an empty workspace (the CREATE run) and once against the
 * workspace it just made (the MATCH run — the morning re-upsert, where nothing
 * has changed and every call is therefore a question already answered).
 *
 * Four things this prints, and asserts as a CEILING so a regression fails:
 *   1. the create run's requests, by `METHOD /pattern` (ids normalised);
 *   2. the match run's, the same way — this is the number that matters, because
 *      it is paid every morning for every deal;
 *   3. both totalled by class: schema (fields / lists / whoami), search
 *      (`?term=`), record read, write;
 *   4. what a catalog build costs cold and warm.
 *
 * And four correctness invariants a cache can silently break, checked end to
 * end (a stale read is indistinguishable from a fresh one until it decides
 * something):
 *   a. two set-if-empty writes to the same record in one run — the second sees
 *      the first's value and leaves it alone;
 *   b. a genuine change after a read in the same run is not suppressed;
 *   c. link, then read the entry's `Owners` — the read reflects the link;
 *   d. a record read in the SOURCE role and written in the TARGET role is
 *      evicted for both (the engine builds a separate adapter instance per
 *      role, over one client);
 *   e. create, then search for what was created — the search must not answer
 *      with the not-found it gave a moment ago, or the run makes a second
 *      company.
 *
 * The library is reconstructed from the audited production shape, not copied
 * from a saved movement: the numbers below are this script's own, and are
 * meaningful as a BEFORE/AFTER pair rather than as an absolute cost.
 *
 * Usage:
 *   cd <scratch> && FAKE_CHANNELS_PORT=6412 npx tsx apps/fake-channels/src/index.ts
 *   FAKE_BASE=http://localhost:6412/affinity npx tsx apps/api/src/scripts/dev/verify_affinity_request_profile.ts
 *
 * Needs DATABASE_URL: the production host's cross-run write locks are
 * Postgres advisory locks.
 */
import type { CatalogSnapshot } from 'movement-lang';
import { runMovement } from '../../services/movement_engine/run';
import { withSegment } from '../../services/translation_graph/segment_scope';
import { AffinityAPIClient } from '../../adapters/affinity/apiClient';
import { AffinityAdapter, AFFINITY_MANIFEST } from '../../services/translation_graph/adapters/affinity';
import { makeWebBaseUrlResolver } from '../../services/translation_graph/adapters/affinity/shared';
import { instanceSchemaFromDescriptors } from '../../services/translation_graph/movement/schema_projection';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import { probeEngineHost } from './lib/probe_host';

const BASE = process.env.FAKE_BASE ?? 'http://localhost:6412/affinity';
const ADMIN = BASE.replace(/\/affinity$/, '/admin');
const TEAM_ID = '00000000-0000-0000-0000-000000000011' as TeamId;
const AUTH = 'Basic ' + Buffer.from(':fake').toString('base64');

const LIST_ID = 90;
const LIST_NAME = 'Deal Pipeline';
const PER_LIST_TYPE = `List Entry — ${LIST_NAME}`;

const DOMAIN = 'veltha-profile.test';
const ORG_NAME = 'Veltha Profile';
const OWNERS = [
  { first: 'Grace', last: 'Graph', email: 'grace-profile@example.com' },
  { first: 'Ivan', last: 'Internal', email: 'ivan-profile@example.com' },
];
const FOUNDERS = [
  { first: 'Fenna', last: 'Founder', email: 'fenna-profile@veltha.test' },
  { first: 'Femi', last: 'Founder', email: 'femi-profile@veltha.test' },
];

// ── The request log ─────────────────────────────────────────────────────────

const requests: string[] = [];

/** One client for every adapter instance, exactly as production has it: the
 *  client is a per-credential singleton, so anything cached ON it is shared by
 *  the source-role and target-role instances the engine builds. */
function makeClient(): AffinityAPIClient {
  const client = new AffinityAPIClient({ apiKey: 'fake', baseUrl: BASE });
  const send = client.fetch.bind(client);
  Object.assign(client, {
    fetch: async (args: { route: string; method: string; query?: Record<string, string> }) => {
      const query = args.query ? `?${new URLSearchParams(args.query).toString()}` : '';
      requests.push(`${args.method} ${args.route}${query}`);
      return send(args as Parameters<typeof send>[0]);
    },
  });
  return client;
}

function adapterOn(client: AffinityAPIClient): AffinityAdapter {
  const adapter = new AffinityAdapter({
    teamId: TEAM_ID,
    credentialsId: 'creds-profile' as ExternalServiceCredentialsId,
  });
  // The real wiring, not a stub: the web base url comes from whoami, and a
  // stub would make the one call this layer caches invisible to the count.
  Object.assign(adapter, {
    getApiClient: async () => {
      Object.assign(adapter, { web: makeWebBaseUrlResolver(client) });
      return client;
    },
  });
  return adapter;
}

/** `GET /persons/4821` and `GET /persons/4822` are the same QUESTION asked
 *  twice; the profile counts questions, so ids come out. */
function pattern(request: string): string {
  const [method, rest] = request.split(' ');
  const [path, qs] = rest.split('?');
  const normalised = path
    .replace(/\/lists\/\d+\/list-entries\/\d+$/, '/lists/:id/list-entries/:id')
    .replace(/\/lists\/\d+\/list-entries$/, '/lists/:id/list-entries')
    .replace(
      /\/(organizations|persons|lists|field-values|notes|entity-files|opportunities|webhooks)\/[^/]+$/,
      '/$1/:id',
    );
  const params = qs
    ? [...new URLSearchParams(qs).keys()]
        .filter((k) => k !== 'with_modified_names' && k !== 'page_size' && k !== 'page_token')
        .sort()
    : [];
  return `${method} ${normalised}${params.length ? `?${params.map((k) => `${k}=`).join('&')}` : ''}`;
}

type RequestClass = 'schema' | 'search' | 'record read' | 'write';

function classOf(p: string): RequestClass {
  if (!p.startsWith('GET ')) return 'write';
  if (p.startsWith('GET /fields') || p.startsWith('GET /auth/whoami') || p === 'GET /lists') {
    return 'schema';
  }
  if (p.includes('term=')) return 'search';
  return 'record read';
}

function profile(label: string, sent: string[]): void {
  const counts = new Map<string, number>();
  for (const r of sent) {
    const p = pattern(r);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const byClass = new Map<RequestClass, number>();
  for (const [p, n] of counts) byClass.set(classOf(p), (byClass.get(classOf(p)) ?? 0) + n);

  console.log(`\n── ${label}: ${sent.length} requests`);
  for (const [p, n] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`   ${String(n).padStart(3)} × ${p}`);
  }
  const classes: RequestClass[] = ['schema', 'search', 'record read', 'write'];
  console.log(
    `   by class — ${classes.map((c) => `${c}: ${byClass.get(c) ?? 0}`).join(', ')}`,
  );
}

// ── Seeding the workspace ───────────────────────────────────────────────────

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: AUTH, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function admin<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ADMIN}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const field = (
  id: number,
  name: string,
  valueType: number,
  listId: number | null,
  allowsMultiple = false,
) => ({
  entity_type: 'field',
  id: String(id),
  data: {
    id,
    name,
    entity_type: 1,
    value_type: valueType,
    list_id: listId,
    enrichment_source: 'none',
    allows_multiple: allowsMultiple,
    track_changes: false,
    dropdown_options: null,
  },
});

/** The production shape: the Deal Pipeline with its own entry fields, and
 *  the company-level `Founders` person field the deal's people hang off. Every
 *  person the run touches already exists — an owner is a colleague, and the
 *  matcher only reaches a model for a person it cannot find by address. */
async function seed(): Promise<{ owners: number[]; founders: number[] }> {
  await admin('/affinity/state', { method: 'DELETE' });
  await admin('/affinity/seed', {
    method: 'POST',
    body: JSON.stringify({
      entities: [
        {
          entity_type: 'list',
          id: String(LIST_ID),
          data: { name: LIST_NAME, type: 1, creator_id: 1 },
        },
        field(901, 'Deal Created', 4, LIST_ID),
        field(902, 'Deal Stage', 6, LIST_ID),
        field(903, 'Deal Source', 6, LIST_ID),
        field(904, 'Owners', 0, LIST_ID, true),
        field(905, 'Founders', 0, null, true),
        field(906, 'Deal Note', 6, null),
      ],
    }),
  });
  const person = async (p: { first: string; last: string; email: string }) =>
    (
      await api<{ id: number }>('/persons', {
        method: 'POST',
        body: JSON.stringify({
          first_name: p.first,
          last_name: p.last,
          emails: [p.email],
          organization_ids: [],
        }),
      })
    ).id;
  return {
    owners: [await person(OWNERS[0]), await person(OWNERS[1])],
    founders: [await person(FOUNDERS[0]), await person(FOUNDERS[1])],
  };
}

// ── The library ─────────────────────────────────────────────────────────────

const HEAD = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)
`;

/** The two dedup reads: is this company already ours, and is this contact? Both
 *  narrow at the source — Affinity substring-matches `term` against a company's
 *  name and domain and a person's name and address. */
const DEDUP = `${HEAD}
movement \`Dedup Check\`(e: <crm-[:\`Organization\`]->>) {
  crm-[o:\`Organization\` WHERE \`Domain\` == "${DOMAIN}"]-> {
    known = o.\`Name\`
  }
  crm-[p:\`Person\` WHERE \`Email\` == "${FOUNDERS[0].email}"]-> {
    contact = p.\`Full name\`
  }
}`;

const UPSERT = `${HEAD}
movement \`Upsert Deal\`(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> {
    \`Name\`: "${ORG_NAME}"
    \`Domain\`: "${DOMAIN}"
  }
  entry = write org-[:\`List Entries\`]-> {
    listName: "${LIST_NAME}"
    \`Deal Created\` ?: "2026-09-01"
    \`Deal Stage\` ?: "Sourced"
    \`Deal Source\` ?: "Inbound"
  }
  first = match entry-[:\`Owners\`]-> { \`Email\`: "${OWNERS[0].email}" }
  link entry -[:\`Owners\`]-> first
  second = match entry-[:\`Owners\`]-> { \`Email\`: "${OWNERS[1].email}" }
  link entry -[:\`Owners\`]-> second
  write org-[:\`Founders\`]-> {
    \`First name\` ?: "${FOUNDERS[0].first}"
    \`Last name\` ?: "${FOUNDERS[0].last}"
    \`Email\` ?: "${FOUNDERS[0].email}"
  }
  write org-[:\`Founders\`]-> {
    \`First name\` ?: "${FOUNDERS[1].first}"
    \`Last name\` ?: "${FOUNDERS[1].last}"
    \`Email\` ?: "${FOUNDERS[1].email}"
  }
}`;

/** (a) Two set-if-empty writes at the same field of the same entry, in ONE run.
 *  The second one's read has to see what the first one wrote. */
const FILL_TWICE = `${HEAD}
movement \`Fill Twice\`(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> { \`Name\`: "${ORG_NAME}", \`Domain\`: "${DOMAIN}" }
  write org-[:\`List Entries\`]-> { listName: "${LIST_NAME}", \`Deal Stage\` ?: "First" }
  write org-[:\`List Entries\`]-> { listName: "${LIST_NAME}", \`Deal Stage\` ?: "Second" }
}`;

/** (b) The other direction: a real change after a read in the same run must
 *  still land — a memo that never expires suppresses it as a no-op. */
const FILL_THEN_CHANGE = `${HEAD}
movement \`Fill Then Change\`(e: <crm-[:\`Organization\`]->>) {
  org = write crm-[:\`Organization\`]-> { \`Name\`: "${ORG_NAME}", \`Domain\`: "${DOMAIN}" }
  write org-[:\`List Entries\`]-> { listName: "${LIST_NAME}", \`Deal Stage\` ?: "First" }
  write org-[:\`List Entries\`]-> { listName: "${LIST_NAME}", \`Deal Stage\`: "Changed" }
}`;

// ── Running ─────────────────────────────────────────────────────────────────

const event = {
  pipelineInputId: 'pi-profile',
  adapterType: 'affinity',
  triggerType: 'webhook' as const,
  payload: {},
};

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

async function runOne(
  source: string,
  movementName: string,
  client: AffinityAPIClient,
  catalog: CatalogSnapshot,
): Promise<string[]> {
  // One instance per ROLE, as the engine builds them — the memo has to span
  // both or the source-role read and the target-role write disagree.
  const source_ = adapterOn(client);
  const target = adapterOn(client);
  const mark = requests.length;
  await runMovement({
    source,
    movementName,
    event,
    teamId: TEAM_ID,
    catalog,
    host: probeEngineHost({
      teamId: TEAM_ID,
      adapters: {
        resolve: ({ role }) => (role === 'source' ? source_ : target),
        credentialId: () => 'creds-profile',
      },
    }),
  });
  return requests.slice(mark);
}

const entriesOfList = () =>
  admin<{ id: string; entity_id: number }[]>(`/affinity/list_entry:${LIST_ID}/state`);

const fieldValues = () =>
  admin<{ id: string; field_id: number; value: unknown; list_entry_id: number | null }[]>(
    '/affinity/field_value/state',
  );

const orgs = () => admin<{ id: string; name: string; domain: string }[]>('/affinity/organization/state');

async function main() {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  const seeded = await seed();
  console.log(`── seeded: list ${LIST_ID} "${LIST_NAME}", owners ${seeded.owners}, founders ${seeded.founders}`);

  // ── the catalog build ────────────────────────────────────────────────────
  const catalogClient = makeClient();
  let mark = requests.length;
  const catalogAdapter = adapterOn(catalogClient);
  const snap = await snapshot(catalogAdapter);
  const cold = requests.length - mark;
  mark = requests.length;
  await snapshot(adapterOn(catalogClient));
  const warm = requests.length - mark;
  console.log(`\n── catalog build: ${cold} requests cold, ${warm} warm`);

  // ── the two runs ─────────────────────────────────────────────────────────
  const client = makeClient();

  const createDedup = await runOne(DEDUP, 'Dedup Check', client, snap);
  const createUpsert = await runOne(UPSERT, 'Upsert Deal', client, snap);
  profile('CREATE run — dedup reads', createDedup);
  profile('CREATE run — Upsert Deal', createUpsert);

  const matchDedup = await runOne(DEDUP, 'Dedup Check', client, snap);
  const matchUpsert = await runOne(UPSERT, 'Upsert Deal', client, snap);
  profile('MATCH run — dedup reads', matchDedup);
  profile('MATCH run — Upsert Deal', matchUpsert);

  const createTotal = createDedup.length + createUpsert.length;
  const matchTotal = matchDedup.length + matchUpsert.length;
  console.log(`\n── totals: create run ${createTotal}, match run ${matchTotal}`);

  // ── what the runs actually did ───────────────────────────────────────────
  console.log('\n── the deal, as Affinity now holds it');
  const entries = await entriesOfList();
  const values = await fieldValues();
  const entryValues = values.filter((v) => v.list_entry_id != null);
  check(entries.length === 1, `one entry on "${LIST_NAME}" (got ${entries.length})`);
  check(
    (await orgs()).filter((o) => o.domain === DOMAIN).length === 1,
    'one company for the domain',
  );
  check(
    entryValues.filter((v) => v.field_id === 904).length === 2,
    `two owners on the entry (got ${entryValues.filter((v) => v.field_id === 904).length})`,
  );
  check(
    values.filter((v) => v.field_id === 905 && v.list_entry_id == null).length === 2,
    'two founders on the company',
  );
  check(
    entryValues.filter((v) => v.field_id === 902).length === 1,
    'one Deal Stage row, not a duplicate per run',
  );

  // ── (a) / (b): set-if-empty and a real change, twice in one run ──────────
  console.log('\n── (a) two set-if-empty writes in one run');
  await seed();
  await runOne(FILL_TWICE, 'Fill Twice', makeClient(), snap);
  let stage = (await fieldValues()).filter((v) => v.field_id === 902);
  check(stage.length === 1 && stage[0].value === 'First', `Deal Stage stayed "First" (got ${JSON.stringify(stage.map((s) => s.value))})`);

  console.log('\n── (b) a genuine change after a read in the same run');
  await seed();
  await runOne(FILL_THEN_CHANGE, 'Fill Then Change', makeClient(), snap);
  stage = (await fieldValues()).filter((v) => v.field_id === 902);
  check(stage.length === 1 && stage[0].value === 'Changed', `Deal Stage became "Changed" (got ${JSON.stringify(stage.map((s) => s.value))})`);

  // ── (c) / (d) / (e): the adapter's own reads, inside one run scope ───────
  const fresh = await seed();
  const bare = makeClient();
  const sourceRole = adapterOn(bare);
  const targetRole = adapterOn(bare);

  console.log('\n── (c) link, then read the entry back');
  await withSegment({ teamId: TEAM_ID }, async () => {
    const org = await targetRole.createRecord({
      recordType: 'Organization',
      fields: { Name: ORG_NAME, Domain: DOMAIN },
      mutationContext: {} as never,
    });
    const entry = await targetRole.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: LIST_NAME },
      parentLinks: [
        { recordType: 'Organization', externalId: org.externalId, edgeName: 'List Entries' },
      ],
      mutationContext: {} as never,
    });
    // Read it FIRST, so the memo is filled with an entry that has no owners.
    const before = await sourceRole.readRecord({
      recordType: PER_LIST_TYPE,
      externalId: entry.externalId,
    });
    check(before?.Owners == null, 'the entry starts with no owners');
    await targetRole.linkRecords({
      from: { recordType: PER_LIST_TYPE, externalId: entry.externalId },
      edgeName: 'Owners',
      to: { recordType: 'Person', externalId: String(fresh.owners[0]) },
      mutationContext: {} as never,
    });
    const after = await sourceRole.readRecord({
      recordType: PER_LIST_TYPE,
      externalId: entry.externalId,
    });
    check(
      JSON.stringify(after?.Owners ?? null).includes(String(fresh.owners[0])),
      `the link is visible to the next read (got ${JSON.stringify(after?.Owners ?? null)})`,
    );

    console.log('\n── (d) read in the source role, written in the target role');
    const readBefore = await sourceRole.readRecord({
      recordType: 'Organization',
      externalId: org.externalId,
    });
    check(readBefore?.Name === ORG_NAME, 'the company reads back under the source role');
    await targetRole.updateRecord({
      recordType: 'Organization',
      externalId: org.externalId,
      fields: { 'Deal Note': 'written by the target role' },
      mutationContext: {} as never,
    });
    const readAfter = await sourceRole.readRecord({
      recordType: 'Organization',
      externalId: org.externalId,
    });
    check(
      readAfter?.['Deal Note'] === 'written by the target role',
      `the source role sees the target role's write (got ${JSON.stringify(readAfter?.['Deal Note'])})`,
    );

    console.log('\n── (e) create, then search for what was created');
    const identity = {
      recordType: 'Organization',
      record: { Name: 'Late Arrival', Domain: 'late-arrival.test' },
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Domain' }] }] },
    };
    const missing = await sourceRole.resolveEntity(identity);
    check(missing.candidates.length === 0, 'nothing matches before the create');
    const made = await targetRole.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Late Arrival', Domain: 'late-arrival.test' },
      mutationContext: {} as never,
    });
    const found = await sourceRole.resolveEntity(identity);
    check(
      found.candidates.length === 1 && found.candidates[0].externalId === made.externalId,
      `the search finds it after the create (got ${JSON.stringify(found.candidates.map((c) => c.externalId))})`,
    );
  });

  // ── the ceiling ──────────────────────────────────────────────────────────
  // What this script measured when the caching work landed — 62 and 43 before
  // it. A change that costs MORE than this fails here rather than in someone's
  // Affinity quota. Raise a number only with the reason a run now has to ask
  // something it did not ask before.
  const CEILING = {
    createRun: Number(process.env.PROFILE_CEILING_CREATE ?? 36),
    matchRun: Number(process.env.PROFILE_CEILING_MATCH ?? 19),
    catalogCold: Number(process.env.PROFILE_CEILING_CATALOG_COLD ?? 3),
    catalogWarm: Number(process.env.PROFILE_CEILING_CATALOG_WARM ?? 0),
  };
  console.log('\n── against the ceiling');
  check(createTotal <= CEILING.createRun, `create run ${createTotal} ≤ ${CEILING.createRun}`);
  check(matchTotal <= CEILING.matchRun, `match run ${matchTotal} ≤ ${CEILING.matchRun}`);
  check(cold <= CEILING.catalogCold, `catalog cold ${cold} ≤ ${CEILING.catalogCold}`);
  check(warm <= CEILING.catalogWarm, `catalog warm ${warm} ≤ ${CEILING.catalogWarm}`);

  console.log(`\n── ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
  for (const f of failures) console.log(`   ✗ ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
