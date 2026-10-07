// The hybrid catalog: skeleton snapshot (no external introspection),
// on-demand per-(adapter, credential) instance schemas, and the
// referenced-set compile catalog (introspect only what the source
// constructs). DB / registry / adapter seams mocked; the real projection,
// cache, and referenced-set logic run.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import { resolveAdapter } from '../../adapters/resolve';
import { clearIntrospectionCache } from '../instance_cache';
import { credentialArgOf } from 'movement-lang';
import {
  describeMovementInstance,
  movementCatalogForTeam,
  movementCatalogSnapshotForTeam,
} from '../catalog';
import { assessMovementValidity } from '../authoring';
import type { WalkedDescribedNode, WalkedNodeShape } from '../walk';
/** Narrow an edge's landing to a DESCRIBED one. The union makes this explicit
 *  at every call site, which is the point — a reader cannot reach for fields
 *  without first deciding whether it is holding a stub. */
function describedTarget(target: WalkedNodeShape | undefined): WalkedDescribedNode {
  if (!target || target.stub === true) throw new Error('expected a described target, got a stub');
  return target;
}


jest.mock('../../../../lib/kysely', () => {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    external_service_credentials: [
      { id: 'cred-attio-1', name: 'Dev Loop Attio', type: 'ATTIO', created_at: new Date(1) },
      { id: 'cred-attio-2', name: 'Sandbox', type: 'ATTIO', created_at: new Date(2) },
      { id: 'cred-slack-1', name: 'Dev Loop Slack', type: 'SLACK', app_id: 'listen-fire', created_at: new Date(3) },
      // Two NOTION rows, one named for its system — the default-connection
      // rule must prefer 'Notion' rather than calling the pair ambiguous.
      { id: 'cred-notion-1', name: 'Personal', type: 'NOTION', created_at: new Date(4) },
      { id: 'cred-notion-2', name: 'Notion', type: 'NOTION', created_at: new Date(5) },
    ],
    node_type: [{ id: 'nt-1', name: 'Company' }],
    property_type: [
      {
        id: 'pt-1',
        name: 'Name',
        node_type_id: 'nt-1',
        value_type: 'text',
        cardinality: 'single',
        enum_values: null,
      },
    ],
    edge_type: [],
    // One installed REMOTE adapter (+ one colliding with a built-in slug,
    // which must be skipped with a note — built-ins win).
    remote_adapter: [
      {
        id: 'ra-1',
        team_id: 'team-1',
        adapter_type: 'acme_crm',
        base_url: 'https://adapters.acme.dev',
        auth_strategy: { kind: 'bearer' },
        credentials_id: '11111111-1111-4111-8111-111111111111',
        manifest: {
          protocolVersion: 2,
          adapterType: 'acme_crm',
          displayName: 'Acme CRM',
          baseUrl: 'https://adapters.acme.dev',
          authStrategy: { kind: 'bearer' },
          credentialsId: '11111111-1111-4111-8111-111111111111',
          supportedTriggers: ['webhook'],
          runtimeCapabilities: {
            traversal: { incoming: false, edgeProperties: false },
            resources: false,
          },
          methods: ['listEntryPoints', 'describe', 'createRecord', 'updateRecord'],
        },
      },
      {
        id: 'ra-2',
        team_id: 'team-1',
        adapter_type: 'attio',
        base_url: 'https://adapters.evil.dev',
        auth_strategy: { kind: 'bearer' },
        credentials_id: '22222222-2222-4222-8222-222222222222',
        manifest: {
          protocolVersion: 2,
          adapterType: 'attio',
          baseUrl: 'https://adapters.evil.dev',
          authStrategy: { kind: 'bearer' },
          credentialsId: '22222222-2222-4222-8222-222222222222',
          supportedTriggers: [],
          runtimeCapabilities: {
            traversal: { incoming: false, edgeProperties: false },
            resources: false,
          },
          methods: ['listEntryPoints', 'describe'],
        },
      },
    ],
  };
  function builder(table: string) {
    const api = {
      where: () => api,
      select: () => api,
      selectAll: () => api,
      orderBy: () => api,
      execute: async () => tables[table] ?? [],
    };
    return api;
  }
  return {
    getQb: () => ({ selectFrom: builder }),
    getCoreQb: () => ({ selectFrom: builder }),
    getKnowledgeQb: () => ({ selectFrom: builder }),
    getAutomationsQb: () => ({ selectFrom: builder }),
  };
});

jest.mock('../../adapters/registry', () => ({
  listAdapterManifests: () => [
    {
      adapterType: 'attio',
      requiredCredentialType: 'ATTIO',
      // An adapter-declared connect action (now an `action` block in the
      // construction block list) must surface into the skeleton so the
      // editor/chat can render the "+" affordance.
      construction: [
        { kind: 'action', actionKind: 'demo-picker', label: 'Connect something' },
      ],
    },
    {
      adapterType: 'slack',
      displayName: 'Slack',
      requiredCredentialType: 'SLACK',
      // Globally-addressable inbound: the identity note must render the
      // needs-an-account gate from THIS flag alone — no triggerExpectation set.
      inboundRequiresRegisteredActor: true,
      methods: ['createRecord'],
      supportedTriggers: ['webhook'],
      // A construction-time entry-position arg (like Sheets' `spreadsheet`) —
      // the skeleton MUST surface it in constructionArgs, else the author never
      // sees it and the checker rejects the valid `slack(workspace: …)` form.
      positionArgs: [{ name: 'workspace', optionsFrom: 'Workspace', label: 'Workspace' }],
    },
    { adapterType: 'email' },
    { adapterType: 'notion', requiredCredentialType: 'NOTION' },
    // No HUBSPOT credential row exists — the skeleton must say so.
    { adapterType: 'hubspot', requiredCredentialType: 'HUBSPOT' },
    // The graph is an ordinary manifest — nothing filters it out any more.
    { adapterType: 'kg' },
  ],
  // The instance-schema projection reads `methods` for the position-write
  // (`write a`) eligibility flag; an empty method set keeps these fixtures'
  // projected schemas shape-identical (no `supportsInPlaceUpdate`).
  getAdapterManifest: () => ({ methods: [] }),
  indexManifestsByName: (manifests: Array<{ adapterType: string; aliases?: string[] }>) => {
    const index = new Map<string, unknown>();
    for (const manifest of manifests) {
      index.set(manifest.adapterType, manifest);
      for (const alias of manifest.aliases ?? []) index.set(alias, manifest);
    }
    return index;
  },
}));

jest.mock('../../engine/transforms/register-bundled', () => ({
  registerBundledTransforms: () => {},
}));

jest.mock('../../engine/transforms/registry', () => ({
  getTransform: () => undefined,
  listTransforms: () => [],
}));

jest.mock('../../adapters/resolve', () => ({ resolveAdapter: jest.fn() }));

const resolveAdapterMock = resolveAdapter as jest.Mock;

const TEAM = 'team-1' as TeamId;

// The projection now keys positions/collections/writableRoots by the entry's
// NATURAL name (its `displayName`). These fixtures make displayName == typeId
// (`attio:thing`) so the keys read as the program writes them (`crm.\`attio:thing\``)
// and the catalog/projection assertions index by that same name.
function fakeAdapter(adapterType: string) {
  return {
    listEntryPoints: async () => [
      {
        typeId: `${adapterType}:thing`,
        displayName: `${adapterType}:thing`,
        writable: true,
        readable: true,
      },
    ],
    describe: async (typeId: string) => ({
      typeId,
      displayName: typeId,
      fields: [
        { fieldId: 'name', displayName: 'name', kind: 'string', writable: true, required: false },
      ],
      references: [],
    }),
  };
}

beforeEach(() => {
  clearIntrospectionCache();
  resolveAdapterMock.mockReset();
  resolveAdapterMock.mockImplementation(async ({ adapterType }) => fakeAdapter(adapterType));
});

describe('movementCatalogSnapshotForTeam (skeleton)', () => {
  it('returns adapters/credentials/plugins with NO external introspection', async () => {
    const { snapshot, notes } = await movementCatalogSnapshotForTeam(TEAM);

    expect(resolveAdapterMock).not.toHaveBeenCalled();
    // acme_crm is the installed REMOTE adapter (2026-07-05) — remote installs
    // join the manifest machinery like built-ins.
    expect(Object.keys(snapshot.adapters).sort()).toEqual([
      'acme_crm',
      'attio',
      'email',
      'hubspot',
      'kg',
      'notion',
      'slack',
    ]);
    for (const adapter of Object.values(snapshot.adapters)) {
      expect(adapter.schemas).toEqual({});
    }
    // The credential is folded into constructionArgs as a `kind: 'credential'`
    // slot — `credentialArgOf` derives it. It exists ONLY for adapters that
    // authenticate (attio); a credential-free built-in (email) carries no slot,
    // so the author can't reach for a credential the adapter would ignore.
    expect(credentialArgOf(snapshot.adapters.attio)?.required).toBe(true);
    expect(credentialArgOf(snapshot.adapters.email)).toBeUndefined();
    // The full construction signature: the credential folded in, plus every
    // position arg the manifest declares (with its enum-source type + label).
    expect(snapshot.adapters.slack.constructionArgs).toEqual([
      { name: 'credentials', kind: 'credential', required: true },
      { name: 'workspace', kind: 'position', required: false, optionsFromType: 'Workspace', label: 'Workspace' },
    ]);
    expect(snapshot.adapters.attio.constructionArgs).toEqual([
      { name: 'credentials', kind: 'credential', required: true },
    ]);
    // Adapter-declared connect actions ride the snapshot (the "+" affordance);
    // adapters without them carry none.
    expect(snapshot.adapters.attio.connectActions).toEqual([
      { kind: 'demo-picker', label: 'Connect something' },
    ]);
    expect(snapshot.adapters.slack.connectActions).toBeUndefined();
    expect(Object.keys(snapshot.credentials).sort()).toEqual([
      'Dev Loop Attio',
      'Dev Loop Slack',
      'Notion',
      'Personal',
      'Sandbox',
    ]);
    // The graph is an ordinary constructible adapter now — it appears in the
    // adapter list under its own slug, and nothing gives it a second slot.
    expect(snapshot.adapters.kg).toBeDefined();
    expect('kg' in snapshot).toBe(false);
    expect(notes).toEqual([
      'attio: a remote install collides with a built-in adapter — the built-in wins',
      'hubspot: no HUBSPOT credential on this team — instance untyped',
    ]);
  });

  it('an adapter whose required credential the team lacks carries the reason IN the snapshot', async () => {
    const { snapshot } = await movementCatalogSnapshotForTeam(TEAM);
    expect(snapshot.adapters.hubspot.schemaNotes).toEqual({
      '': ['hubspot: no HUBSPOT credential on this team — instance untyped'],
    });
    // Adapters with credentials carry no notes.
    expect(snapshot.adapters.attio.schemaNotes).toBeUndefined();
  });
});

describe('describeMovementInstance — the default connection', () => {
  // `describeConnection` documents `connection` as "defaults to the system
  // name", but every test here had always passed it explicitly, so the
  // defaulting was never implemented and omitting it failed unconditionally
  // ("credential '' not found"). The first hop an author makes is the one
  // where they don't yet know a connection's stored name.

  it('falls back to the sole connection for the system when none is named', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'slack' });

    expect(result.schema?.positions['slack:thing']).toBeDefined();
    expect(resolveAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'slack', credentialsId: 'cred-slack-1' }),
    );
  });

  it('prefers the connection named for the system over its siblings', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'notion' });

    expect(result.schema?.positions['notion:thing']).toBeDefined();
    expect(resolveAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'notion', credentialsId: 'cred-notion-2' }),
    );
  });

  it('reports the choice rather than guessing when several connections could serve', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'attio' });

    // Guessing would describe the wrong workspace silently.
    expect(resolveAdapterMock).not.toHaveBeenCalled();
    expect(result.schema).toBeNull();
    expect(result.notes?.[0]).toContain('Dev Loop Attio');
    expect(result.notes?.[0]).toContain('Sandbox');
  });

  it('says the team has no such connection rather than naming an empty one', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'hubspot' });

    expect(result.schema).toBeNull();
    expect(result.notes).toEqual([
      'hubspot: no HUBSPOT credential on this team — instance untyped',
    ]);
  });

  it('names the reachable connections when the one asked for is unknown', async () => {
    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'attio',
      credentialName: 'Nope',
    });

    expect(result.schema).toBeNull();
    // The old message rendered the name it could not find and nothing else;
    // the way out is knowing what IS there.
    expect(result.notes?.[0]).toContain('Dev Loop Attio');
  });

  it('describes each system at its default connection in the batch form', async () => {
    // The array form never forwarded a credential name at all, so batch
    // describe failed for every credentialed system.
    const results = await Promise.all(
      ['slack', 'notion'].map((adapter) => describeMovementInstance({ teamId: TEAM, adapter })),
    );

    expect(results.map((r) => r.schema !== null)).toEqual([true, true]);
  });
});

describe('describeMovementInstance', () => {
  it('introspects the pair behind the credential import name', async () => {
    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'attio',
      credentialName: 'Dev Loop Attio',
    });
    expect(result.schema?.positions['attio:thing']).toBeDefined();
    expect(result.schema?.writableRoots['attio:thing']).toBeDefined();
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
    expect(resolveAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'attio', credentialsId: 'cred-attio-1' }),
    );
  });

  it('a described edge carries EXPLICIT readable/writable — absent ⇒ readable, and NOT writable', async () => {
    // An adapter whose reference leaves both flags absent (the common case).
    resolveAdapterMock.mockImplementationOnce(async ({ adapterType }: { adapterType: string }) => ({
      listEntryPoints: async () => [
        { typeId: `${adapterType}:thing`, displayName: `${adapterType}:thing`, writable: true, readable: true },
      ],
      describe: async (typeId: string) => ({
        typeId,
        displayName: typeId,
        fields: [{ fieldId: 'name', displayName: 'name', kind: 'string', writable: true, required: false }],
        references: [{ fieldId: 'related', targetTypeId: `${adapterType}:thing`, cardinality: 'one' }],
      }),
    }));

    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'attio',
      credentialName: 'Dev Loop Attio',
    });

    // The projection stores absent (its sparse convention); the agent-facing
    // wire pass fills both, so the described edge states truth, not a default
    // the agent has to know. The two defaults go OPPOSITE ways: `readable`
    // absent means readable, `writable` absent means READ-ONLY — which is
    // exactly what the checker's write gate enforces, so describe cannot
    // promise a write the checker then refuses.
    expect(result.schema?.positions['attio:thing'].edges.related).toEqual({
      target: 'attio:thing',
      readable: true,
      writable: false,
    });
  });

  it('surfaces the identity note derived from the manifest — the needs-an-account gate from the flag alone, no hand-written prose', async () => {
    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'slack',
      credentialName: 'Dev Loop Slack',
    });
    // Runs-as (from requiredCredentialType) + the registered-actor gate (from
    // inboundRequiresRegisteredActor) — neither hand-written on the manifest.
    expect(result.identity).toContain('runs with the Slack account that connected it');
    expect(result.identity).toContain('set up on this team');
    expect(result.identity).toContain('not set up on the team yet');
  });

  it('credential-free adapters describe without a credential name', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    expect(result.schema?.positions['email:thing']).toBeDefined();
    expect(resolveAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'email', credentialsId: undefined }),
    );
  });

  it('unknown adapter / unresolvable or mismatched credential → untyped (null), no introspection', async () => {
    expect((await describeMovementInstance({ teamId: TEAM, adapter: 'nope' })).schema).toBeNull();
    expect(
      (await describeMovementInstance({ teamId: TEAM, adapter: 'attio', credentialName: 'missing' }))
        .schema,
    ).toBeNull();
    // A slack credential can't introspect an attio instance.
    expect(
      (
        await describeMovementInstance({
          teamId: TEAM,
          adapter: 'attio',
          credentialName: 'Dev Loop Slack',
        })
      ).schema,
    ).toBeNull();
    expect(resolveAdapterMock).not.toHaveBeenCalled();
  });

  it('introspection failure degrades to untyped with a note', async () => {
    resolveAdapterMock.mockRejectedValueOnce(new Error('workspace unreachable'));
    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'attio',
      credentialName: 'Dev Loop Attio',
    });
    expect(result.schema).toBeNull();
    expect(result.notes[0]).toMatch(/workspace unreachable/);
  });
});

const SOURCE = `
import { email, attio } from adapters
import { \`Dev Loop Attio\` } from credentials

inbox = email()
crm   = attio(credentials: \`Dev Loop Attio\`)

movement m(item: inbox.\`email:thing\`) {
  write crm-[:\`attio:thing\`]-> {
    name: item.\`name\`
  }
}
`;

describe('movementCatalogForTeam with a source (referenced-set compile catalog)', () => {
  it('introspects ONLY the pairs the source constructs', async () => {
    const catalog = await movementCatalogForTeam(TEAM, { source: SOURCE });

    const introspected = resolveAdapterMock.mock.calls.map((c) => c[0]);
    expect(introspected).toHaveLength(2);
    expect(introspected).toContainEqual(
      expect.objectContaining({ adapterType: 'email', credentialsId: undefined }),
    );
    expect(introspected).toContainEqual(
      expect.objectContaining({ adapterType: 'attio', credentialsId: 'cred-attio-1' }),
    );
    // Neither slack nor attio's second (sandbox) credential is touched.

    expect(
      catalog.catalog.instantiate('attio', { credentials: 'Dev Loop Attio' })?.positions['attio:thing'],
    ).toBeDefined();
    expect(catalog.catalog.instantiate('slack', { credentials: 'Dev Loop Slack' })).toBeUndefined();
    // Adapters carry no translation map — the projection keys every position
    // and collection by the adapter's NATURAL name (its `displayName`). The
    // collection value is that same name (a self-edge off the meta root); the
    // internal typeId the adapter consumes is resolved at the engine boundary.
    expect(
      catalog.catalog.instantiate('attio', { credentials: 'Dev Loop Attio' })?.collections['attio:thing']
        ?.target,
    ).toBe('attio:thing');
  });

  it('shares the TTL cache with describeInstance — one introspection per pair across both paths', async () => {
    await describeMovementInstance({ teamId: TEAM, adapter: 'attio', credentialName: 'Dev Loop Attio' });
    await movementCatalogForTeam(TEAM, { source: SOURCE });
    const attioCalls = resolveAdapterMock.mock.calls.filter((c) => c[0].adapterType === 'attio');
    expect(attioCalls).toHaveLength(1);
  });

  it('resolves an ALIASED credential import to its original name (original = adapter name)', async () => {
    // The credential is referenced by its verbatim name `Dev Loop Attio`
    // (named == identified); the program aliases it locally. Detection must
    // hand the compile catalog the ORIGINAL name or the pair is skipped.
    const catalog = await movementCatalogForTeam(TEAM, {
      source: `import { attio } from adapters
import { \`Dev Loop Attio\` as AttioCred } from credentials

attioTarget = attio(credentials: AttioCred)
`,
    });
    expect(resolveAdapterMock).toHaveBeenCalledTimes(1);
    expect(resolveAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'attio', credentialsId: 'cred-attio-1' }),
    );
    expect(catalog.notes).not.toContainEqual(expect.stringMatching(/credential unresolved/));
    // The checker resolves the alias to the original name before instantiate.
    expect(
      catalog.catalog.instantiate('attio', { credentials: 'Dev Loop Attio' })?.positions['attio:thing'],
    ).toBeDefined();
  });

  it('an unresolvable construction credential is a GAP, not just a note — an untyped instance can never assess `valid`', async () => {
    // The instance stays untyped, so EVERY schema-typed check (field names,
    // edge names, write shapes) goes silent for it. Recording only a note left
    // that silence riding on the checker independently erroring on the same
    // name — a coincidence, not a guarantee. The gap is the `unverified`
    // signal, so the save can never come back clean unchecked.
    const catalog = await movementCatalogForTeam(TEAM, {
      source: 'crm = attio(credentials: who_dis)\n',
    });
    expect(resolveAdapterMock).not.toHaveBeenCalled();
    expect(catalog.notes).toContainEqual(expect.stringMatching(/attio: construction credential unresolved/));
    expect(catalog.gaps).toContainEqual(
      expect.objectContaining({ adapter: 'attio', detail: expect.stringContaining('who_dis') }),
    );
  });

  it('a credential naming a connection for a DIFFERENT system is a gap too', async () => {
    const catalog = await movementCatalogForTeam(TEAM, {
      source: 'crm = attio(credentials: `Dev Loop Slack`)\n',
    });
    expect(catalog.gaps).toContainEqual(expect.objectContaining({ adapter: 'attio' }));
  });

  it('an unresolved credential can never assess `valid` — EVEN IF the checker says nothing', async () => {
    // The invariant, stated where it is decided. `diagnostics: []` is the
    // whole point: it stands in for the checker having nothing to say, which
    // is precisely what the old design was betting against. Before the gap,
    // this assessed `valid` on a movement whose every field, edge and write
    // shape went unchecked.
    const bad = await movementCatalogForTeam(TEAM, {
      source: 'crm = attio(credentials: who_dis)\n',
    });
    expect(assessMovementValidity({ diagnostics: [], gaps: bad.gaps }).status).toBe('unverified');
  });

  it('a RESOLVING credential leaves no gap — the working path stays clean', async () => {
    const catalog = await movementCatalogForTeam(TEAM, {
      source: `import { attio } from adapters
import { \`Dev Loop Attio\` as AttioCred } from credentials

crm = attio(credentials: AttioCred)
`,
    });
    expect(catalog.gaps).toEqual([]);
    expect(catalog.notes).not.toContainEqual(expect.stringMatching(/credential unresolved/));
    expect(assessMovementValidity({ diagnostics: [], gaps: catalog.gaps }).status).toBe('valid');
  });

  it('without a source, sweeps every credential of every manifest (dev CLI path)', async () => {
    await movementCatalogForTeam(TEAM);
    const introspected = resolveAdapterMock.mock.calls.map((c) => c[0]);
    // attio×2 creds, notion×2, slack×1, email credential-free, kg
    // (credential-free), acme_crm (remote, credential-free — the install
    // carries its own credential FK).
    expect(introspected).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Remote installs in the manifest machinery (2026-07-05)
// ---------------------------------------------------------------------------

describe('remote adapters in the per-team catalog', () => {
  it('the skeleton snapshot lists a remote install as a credential-free introspected adapter', async () => {
    const { snapshot, notes } = await movementCatalogSnapshotForTeam(TEAM);
    const remote = snapshot.adapters['acme_crm'];
    expect(remote).toBeDefined();
    expect(credentialArgOf(remote)).toBeUndefined(); // credential bound at install, not a construction arg
    expect(remote.schemaShape).toBe('introspected');
    // The colliding install is skipped — built-ins win — with a note.
    expect(notes.some((n) => n.includes('attio') && n.includes('built-in'))).toBe(true);
  });

  it('the compile catalog instantiates a remote install like any adapter', async () => {
    const source = `import { acme_crm } from adapters
crm = acme_crm()
movement m(x: <crm-[:\`acme_crm:thing\`]->>) {
  write crm-[:\`acme_crm:thing\`]-> { name: x.name }
}`;
    const teamCatalog = await movementCatalogForTeam(TEAM, { source });
    expect(teamCatalog.catalog.adapter('acme_crm')).toBeDefined();
    const schema = teamCatalog.catalog.instantiate('acme_crm', {});
    expect(schema).toBeDefined();
    expect(Object.keys(schema!.positions)).toContain('acme_crm:thing');
    // The remote manifest declares updateRecord → position writes eligible.
    expect(schema!.supportsInPlaceUpdate).toBe(true);
  });
});

// ── The walk, through the call an agent actually makes ─────────────────────
//
// `describeConnection` is the consumer the walk contract exists for: one call
// takes a position (root when absent) and answers with the node, its
// properties, and its edges. These tests drive the REAL service, so they pin
// the wiring — cache → walk → projection — not just the projection.

/** A two-hop walking adapter: root -[Email]-> Email -[Attachments]-> Attachment. */
function walkingAdapter() {
  const attachment = {
    typeId: 'attachment',
    displayName: 'Attachment',
    fields: [{ fieldId: 'filename', displayName: 'Filename', kind: 'string', writable: false, required: false }],
    references: [],
  };
  const email = {
    typeId: 'email',
    displayName: 'Email',
    fields: [{ fieldId: 'subject', displayName: 'Subject', kind: 'string', writable: false, required: false }],
    references: [
      { fieldId: 'attachments', targetTypeId: 'attachment', cardinality: 'many', name: 'Attachments' },
    ],
  };
  const position = (recordType: string) => ({
    adapterType: 'email',
    recordType,
    identity: { kind: 'unstable', data: {} },
  });
  return {
    // Readable, so the entry projects a position: these tests are about
    // whether it gets DESCRIBED, not about whether it is reachable.
    listEntryPoints: async () => [
      { typeId: 'email', displayName: 'Email', writable: false, readable: true },
    ],
    describe: async (typeId: string) => (typeId === 'email' ? email : typeId === 'attachment' ? attachment : null),
    edgesFrom: async (at: { recordType: string | null }) => {
      if (at.recordType === 'meta') {
        return {
          descriptor: {
            typeId: 'meta',
            displayName: 'Email',
            description: 'An email connection — nothing here can be listed.',
            fields: [],
            references: [
              { fieldId: 'email', targetTypeId: 'email', cardinality: 'one', name: 'Email', fires: true, readable: false },
            ],
          },
          targetPositions: { email: position('email') },
          targetNodes: { email: { typeId: 'email', displayName: 'Email', fields: email.fields } },
        };
      }
      if (at.recordType === 'email') {
        return {
          descriptor: email,
          targetPositions: { attachments: position('attachment') },
          targetNodes: { attachments: { typeId: 'attachment', displayName: 'Attachment', fields: attachment.fields } },
        };
      }
      return { descriptor: attachment };
    },
  };
}

describe('describeMovementInstance — the walk', () => {
  beforeEach(() => {
    resolveAdapterMock.mockImplementation(async () => walkingAdapter());
  });

  it('with no position, the call lands on the ROOT — the root is not a special case', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    expect(result.node?.position).toBe('');
    expect(result.node?.name).toBe('Email');
    // A root with no readable edge still describes itself: the agent reads
    // "entered by being pushed into", not "this system is empty".
    expect(result.node?.description).toMatch(/cannot be listed|can be listed/i);
  });

  it('the root hop already carries the landing — an agent can author without a second call', async () => {
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    const [edge] = result.node!.edges;
    expect(edge.name).toBe('Email');
    expect(edge.fires).toBe(true);
    expect(edge.target?.stub).toBeUndefined();
    expect(Object.keys(describedTarget(edge.target).properties)).toEqual(['Subject']);
    // ...but not the landing's onward edges — that is the one thing withheld.
    expect(edge.target).not.toHaveProperty('edges');
  });

  it('echoing an edge\'s address walks it, and the withheld edges are there', async () => {
    const root = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    const address = root.node!.edges[0]!.position!;

    const hop = await describeMovementInstance({ teamId: TEAM, adapter: 'email', position: address });

    expect(hop.node?.name).toBe('Email');
    expect(hop.node?.position).toBe(address);
    expect(hop.node?.edges.map((e) => e.name)).toEqual(['Attachments']);
    expect(hop.node?.edges[0]?.target?.name).toBe('Attachment');
  });

  it('learning to walk does NOT hollow out the eager describe', async () => {
    // The regression this test exists for: the cache refused a full-surface
    // describe for any adapter with `edgesFrom`, but the reason to refuse is
    // that describing a CONTAINER-shaped adapter's entries walks every
    // container. A uniform adapter has none — so the day it learned to walk,
    // its positions came back with no properties, no error, and nobody
    // noticed. Two different facts; only one of them justifies refusing.
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    const position = result.schema?.positions.Email;
    expect(position?.undescribed).toBeUndefined();
    expect(Object.keys(position?.properties ?? {})).toContain('Subject');
  });

  it('a container-shaped adapter still refuses the full surface — that fan-out is real', async () => {
    resolveAdapterMock.mockImplementation(async () => ({
      ...walkingAdapter(),
      walksContainers: true,
    }));
    const result = await describeMovementInstance({ teamId: TEAM, adapter: 'email' });
    // Refused, so the properties are NOT paid for up front. The walk is how
    // you get them, one hop at a time.
    expect(result.schema?.positions.Email?.undescribed).toBe(true);
  });

  it('a position that walks nowhere is reported, not silently answered from the root', async () => {
    const result = await describeMovementInstance({
      teamId: TEAM,
      adapter: 'email',
      position: '-[:`Nonexistent`]->',
    });
    expect(result.node).toBeUndefined();
    expect(result.notes.join(' ')).toMatch(/Nonexistent/);
  });
});
