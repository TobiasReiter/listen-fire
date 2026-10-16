import {
  parseProgram,
  checkProgram,
  mockCatalog,
  scanInstanceChains,
  eventAddressDisplay,
  eventAddressKey,
  narrowingPrefixKey,
  type AdapterSpec,
  type Catalog,
  type InstanceSchema,
  type PositionSchema,
} from 'movement-lang';

import type { InstanceChain } from 'movement-lang';
import type { ChapterId, EngineClaim } from '../types';

import {
  KG_EVENT_RECORD_EDGE_NAME,
  KG_EVENT_TYPE_NAME,
  KG_NODE_TYPE_META_TYPE,
  KG_SUBSCRIBABLE_EVENTS,
} from '../../../../services/translation_graph/adapters/knowledge_graph';
import adapterSchemas from './adapter_schemas.fixture.json';
import { registeredPluginSpecs } from '../../../../services/translation_graph/movement/catalog';
import { proseViolations } from './prose_rules';
import { chapterRoute } from 'movement-engine/lib/handbook_section';
import { frontPageClaims } from '../front_page';
import { controlFormClaims } from '../language_search';
import {
  renderMovementIndex,
  getMovementChapter,
  buildMovementFrontMatter,
  getMovementHandbook,
} from '../index';

// Assembled once: the same book every consumer reads — hand-written chapters
// plus every adapter-declared section, so the rules below cover both.
const movementHandbook = getMovementHandbook();

const ALL_CHAPTERS: ChapterId[] = [
  'foundations',
  'anatomy',
  'expressions',
  'writes',
  'traversal',
  'extraction',
  'branching',
  'listeners',
  'reviews',
  'patterns',
  'use-cases',
  'runs',
  'reference',
  'builtins',
];

describe('movement_handbook registry', () => {
  it('all chapters are registered and load', () => {
    for (const id of ALL_CHAPTERS) {
      const r = getMovementChapter(id);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.content.length).toBeGreaterThan(200);
    }
  });

  it('getMovementChapter errors on an unknown id and lists options', () => {
    const r = getMovementChapter('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/anatomy/);
  });

  it('renderMovementIndex routes the duplicate-prevention intent', () => {
    expect(renderMovementIndex()).toMatch(/duplicate/i);
  });

  // The front matter is foundations + the index, and nothing else: the model
  // card arrives ONCE, whether a reader meets it here or fetches the chapter.
  // It used to be paraphrased into a second preface constant, so every
  // consumer read the model twice and the two copies drifted.
  it('buildMovementFrontMatter is the foundations chapter plus the index', () => {
    const fm = buildMovementFrontMatter();
    const chapter = getMovementChapter('foundations');
    expect(chapter.ok).toBe(true);
    if (chapter.ok) expect(fm).toContain(chapter.content);
    expect(fm).toMatch(/When you need to:/); // index
    expect(fm).toMatch(/no magic values/i); // conventions, via foundations
    // One copy: the model card is stated once, not restated as a preface.
    expect(fm.match(/### what-an-automation-is/g) ?? []).toHaveLength(1);
  });

  // Foundations IS the model card: the chapter every consumer is sent to first
  // carries the model, the cardinal rule, and the conventions. Routing is NOT
  // among them — the index is the one place a situation is routed from, so a
  // reading map here would be a second copy to drift.
  it('the foundations chapter carries model, cardinal rule, and conventions', () => {
    const r = getMovementChapter('foundations');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const section of ['what-an-automation-is', 'the-cardinal-rule', 'conventions']) {
      expect(getMovementChapter('foundations', section).ok).toBe(true);
    }
    expect(getMovementChapter('foundations', 'reading-map').ok).toBe(false);
  });
});

describe('movement_handbook referential integrity', () => {
  it('every intent entry routes to a registered chapter', () => {
    for (const e of movementHandbook.intentIndex) {
      expect(movementHandbook.chapters[e.chapter]).toBeDefined();
    }
  });

  // The index routes to `chapter#section`, and a route is only worth serving
  // if the section it names is FETCHABLE — so this asserts through the real
  // fetch path rather than grepping the chapter body for a heading. An anchor
  // that renamed or lost its heading fails here the way an agent would meet it.
  it('every intent route resolves through the real fetch path', () => {
    for (const e of movementHandbook.intentIndex) {
      const r = getMovementChapter(e.chapter, e.section);
      if (!r.ok) throw new Error(`${chapterRoute(e)}: ${r.error}`);
      expect(r.content.length).toBeGreaterThan(0);
      if (e.section) expect(r.content.startsWith('### ')).toBe(true);
    }
  });

  it('an unknown section names the chapter\'s real sections', () => {
    const r = getMovementChapter('writes', 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/identity/);
  });

  it('a section fetch costs a fraction of its chapter', () => {
    const whole = getMovementChapter('writes');
    const one = getMovementChapter('writes', 'identity');
    expect(whole.ok && one.ok).toBe(true);
    if (whole.ok && one.ok) {
      expect(one.content.length).toBeLessThan(whole.content.length / 4);
      expect(one.content).toContain('unique by');
    }
  });

  it('the index routes some situations straight at a system chapter', () => {
    const systemRoutes = movementHandbook.intentIndex.filter((e) =>
      e.chapter.startsWith('system:'),
    );
    expect(systemRoutes.length).toBeGreaterThan(0);
  });

  // The per-chapter contract — retired constructs, tool names, internal
  // shorthands, use-case tuning, fence balance, and the vocabulary rules — is
  // one function (prose_rules.ts) run over EVERY chapter the book assembles,
  // adapter-contributed sections included. A system's own section is bound by
  // the same prose contract as a hand-written chapter; nothing about it is
  // exempt, and nothing about it is special-cased here.
  it.each(Object.values(movementHandbook.chapters).map((c) => [c.id, c] as const))(
    '%s holds the prose contract',
    (_id, chapter) => {
      expect(proseViolations(chapter)).toEqual([]);
    },
  );

  // These assert the RENDERED text — what an agent actually reads — not the
  // chapter SOURCE. The chapters are template literals that escape backticks
  // and `${`, so a source-level grep can report a construct absent while the
  // rendered handbook still teaches it (and vice versa). Both constructs below
  // were retired by the event-edge collapse, and both survived ~87 occurrences
  // across ~10 chapters because nothing checked the rendered string.
  it('no chapter, front matter, or index still teaches the retired `Email Received` event node', () => {
    const rendered = [
      buildMovementFrontMatter(),
      renderMovementIndex(),
      ...Object.values(movementHandbook.chapters).map((c) => c.content),
      ...Object.values(movementHandbook.chapters).flatMap((c) =>
        (c.engineClaims ?? []).map((claim) => claim.probe),
      ),
    ].join('\n');
    // The fires edge lands straight on `Email`; the wrapper node carried no
    // facts of its own and died with rule 1's collapse.
    expect(rendered).not.toMatch(/Email Received/);
  });

  it('no chapter still teaches the retired generic event→record wrapper hop', () => {
    const rendered = [
      ...Object.values(movementHandbook.chapters).map((c) => c.content),
      ...Object.values(movementHandbook.chapters).flatMap((c) =>
        (c.engineClaims ?? []).map((claim) => claim.probe),
      ),
    ].join('\n');
    // `e-[msg:record]-> { … }` — an event's fields are read STRAIGHT off the
    // movement parameter. This deliberately matches the lowercase generic hop
    // only: Airtable's event node really does publish a `Record` edge, and a
    // blanket ban on the word would forbid that true one.
    expect(rendered).not.toMatch(/-\[\w*:record\]->/);
  });

  it('carries no internal vocabulary in agent-visible prose', () => {
    const everything = [
      buildMovementFrontMatter(),
      ...movementHandbook.intentIndex.map((e) => e.intent),
      ...Object.values(movementHandbook.chapters).map((c) => `${c.title}\n${c.content}`),
    ].join('\n');
    const prose = everything.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
    expect(prose).not.toMatch(/\bmovements?\b/i);
    expect(prose).not.toMatch(/\basks?\b/i);
  });
});

// ── Checker validation of runnable examples ──
//
// Fence-balance (above) and the engine's interpretability scan (the
// engine_claims lockstep test) are both too permissive to catch a prose
// example that doesn't actually compile: the broken
// `extract from [..., go-[:_resources]->]` example parsed and scanned
// clean, yet the real CHECKER rejects it (MOV_EXPR_PARSE). So an example
// that claims to RUN must be validated against the real checker.
//
// TWO THINGS MAKE THIS BITE, and both were missing when the handbook rotted:
//
// 1. COVERAGE IS OPT-OUT, NOT OPT-IN. Every `status:'runs'` probe is checked;
//    a probe escapes only by being listed in CHECKER_EXEMPT with a reason, and
//    that list is itself asserted to stay small. The old model was an opt-in
//    list with ONE entry against ~50 runnable examples, which is why 87
//    occurrences of two retired constructs survived: nothing compared the other
//    49 to anything.
//
// 2. THE FIXTURE IS CAPTURED FROM THE REAL ADAPTERS, NOT HAND-WRITTEN.
//    `adapter_schemas.fixture.json` is the live output of the real catalog
//    projection for the dev-loop workspace — regenerate it against a running
//    dev loop with
//
//        pnpm dev:movement snapshot-catalog --handbook \
//          --out <this dir>/adapter_schemas.fixture.json
//
//    (the full procedure — boot, seed, and how to read the diff — is in
//    docs/dev-loop.md, "Regenerating the handbook's adapter schema snapshot")
//
//    A hand-written fixture validates an example against a shape someone
//    imagined, which is validation theatre: the previous fixture declared
//    `Companies -[:People]-> People`, an edge REAL Attio does not have (its
//    reference lives on the child, `People -[:Company]-> Companies`), so an
//    example could pass this test and still be untrue. Captured schemas make
//    "passes the test" and "true about the adapter" the same statement, and an
//    adapter that changes shape fails every example the change invalidated.
//
//    `--handbook` is what makes that capture honest, and it is not a
//    convenience flag. It drives the capture from THESE PROBES — the same
//    `engineClaims` the test below checks — through the very catalog build a
//    save performs, so what gets described is what the examples demand. The
//    flagless form is a full-surface sweep, which no save has ever done and
//    which a container-shaped system (Attio) refuses outright: swept, every
//    Attio position came back `undescribed` and every example naming
//    `Companies` failed on a position nobody had looked at. So the fixture is
//    the UNION of what the handbook's own examples demand, and an example that
//    names something no example demands is an example the fixture cannot back.

const capturedSchemas = adapterSchemas.schemas as Record<string, InstanceSchema>;

const KG_NODE_TYPES = ['Company', 'Person', 'Support Ticket'];

/**
 * The graph's EVENT surface, as the adapter declares it and the host grafts it.
 *
 * Every NAME here comes from the adapter module, so a rename there breaks these
 * probes rather than quietly making the chapter teach a spelling the graph no
 * longer answers to; every KEY comes from `eventAddressKey`, so the fixture and
 * the checker cannot disagree about which position an address means. What is
 * hand-written is only the SHAPE the host's graft produces — a copy of the event
 * node per action, its record edge landing on the type the `type:` pin walks to,
 * dropped entirely under the deleted pin (there is no record left to fetch).
 *
 */
function kgEventSurface(): Pick<
  InstanceSchema,
  'positions' | 'unions' | 'eventPosition' | 'eventPositions' | 'eventNarrowingKeys' | 'eventNarrowingValues'
> {
  const properties = {
    action: { kind: 'enum' as const, options: [...KG_SUBSCRIBABLE_EVENTS] },
    type: 'text' as const,
    record: 'text' as const,
  };
  const positions: Record<string, PositionSchema> = {
    [KG_NODE_TYPE_META_TYPE]: { properties: {}, edges: {}, undescribed: true },
    [KG_EVENT_TYPE_NAME]: {
      properties,
      edges: {
        [KG_EVENT_RECORD_EDGE_NAME]: {
          target: KG_NODE_TYPE_META_TYPE,
          subject: true,
          requiresLiveRecord: true,
        },
      },
    },
  };
  const unions: Record<string, string[]> = {};
  for (const nodeType of KG_NODE_TYPES) {
    const variants: string[] = [];
    for (const action of KG_SUBSCRIBABLE_EVENTS) {
      const narrowing = { action, type: nodeType };
      const key = eventAddressKey({ event: KG_EVENT_TYPE_NAME, narrowing });
      variants.push(key);
      positions[key] = {
        properties,
        edges:
          action === 'record.deleted'
            ? {}
            : { [KG_EVENT_RECORD_EDGE_NAME]: { target: nodeType, subject: true } },
        displayName: eventAddressDisplay({ event: KG_EVENT_TYPE_NAME, narrowing }),
      };
    }
    unions[eventAddressKey({ event: KG_EVENT_TYPE_NAME, narrowing: { type: nodeType } })] = variants;
  }
  return {
    positions,
    unions,
    eventPosition: KG_EVENT_TYPE_NAME,
    eventPositions: [{ position: KG_EVENT_TYPE_NAME }],
    eventNarrowingKeys: ['type'],
    eventNarrowingValues: { [narrowingPrefixKey({})]: { type: KG_NODE_TYPES } },
  };
}

const KG_EVENT_SURFACE = kgEventSurface();

/**
 * The knowledge graph's ontology, hand-written — the one schema here that is
 * NOT captured, and could not be. Every other adapter has a vendor surface
 * that is the same for every workspace, so a capture is the truth. The KG's
 * types ARE the team's own data model: there is no workspace-independent
 * ontology to record, and capturing one team's would teach that team's nouns
 * as though they were the language's.
 *
 * So this is a REPRESENTATIVE ontology, and what the kg probes are held to is
 * the language surface over it — the root write and its `unique by`, the
 * linked write scoped to its parent, the mutation listen's config vocabulary,
 * the rooted read. Those are workspace-independent; `Company` and `Domains`
 * are set dressing, exactly as the credential aliases above are.
 *
 * Shaped to match what the real adapter projects (knowledge_graph.ts): one
 * root per node type, keyed by the type's own display name; every ontology
 * edge writable from both ends; fuzzy uniqueness resolution supported. A
 * multi-word type earns its place — it is what proves a name with a space
 * rides the same spellings a bare one does.
 */
const KG_ONTOLOGY: InstanceSchema = {
  ...KG_EVENT_SURFACE,
  positions: {
    ...KG_EVENT_SURFACE.positions,
    Company: {
      properties: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Stage: 'text' },
      edges: {
        Team: { target: 'Person', readable: true, writable: true },
        'Support Tickets': { target: 'Support Ticket', readable: true, writable: true },
      },
    },
    Person: { properties: { Name: 'text', Email: 'text' }, edges: {} },
    'Support Ticket': {
      properties: { Status: 'text', Priority: 'number' },
      edges: { Reporter: { target: 'Person', readable: true, writable: true } },
    },
  },
  collections: { Company: { target: 'Company' }, Person: { target: 'Person' }, 'Support Ticket': { target: 'Support Ticket' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Company: {
      fields: { Name: 'text', Domains: { kind: 'list', of: 'text' }, Stage: 'text' },
      requiredFields: [],
      fuzzyResolution: true,
      resultShape: { externalId: 'text', Name: 'text' },
    },
    Person: {
      fields: { Name: 'text', Email: 'text' },
      requiredFields: [],
      resultShape: { externalId: 'text', Name: 'text' },
    },
    'Support Ticket': {
      fields: { Status: 'text', Priority: 'number' },
      requiredFields: [],
      resultShape: { externalId: 'text', Status: 'text' },
    },
  },
};

/**
 * The graph is an ordinary adapter now — constructed like any other, and firing
 * an event entry like any other, so its listen vocabulary rides the spec
 * exactly as a captured adapter's does. Mirrors `KG_MANIFEST`: `type` is the
 * required address hop, `events` names the uniform `record.*` currency, and
 * `fields` is the changed-property filter.
 */
const KG_SPEC: AdapterSpec & { schema: InstanceSchema } = {
  constructionArgs: [],
  canFire: true,
  triggerConfig: ['type', 'events', 'fields'],
  triggerConfigRequired: ['type'],
  triggerConfigOptions: { events: [...KG_SUBSCRIBABLE_EVENTS] },
  triggerConfigFormats: { fields: 'fields' },
  schema: KG_ONTOLOGY,
};

/**
 * The credential names the chapters import. Chapters name credentials
 * illustratively (`acme`, `main_crm`, `team_chat`) — a workspace's connections
 * are its own — so each alias maps to the adapter whose REAL captured schema
 * backs it. The schema is what's under test; the name is set dressing.
 */
const CREDENTIAL_ADAPTERS: Record<string, string> = {
  acme: 'attio',
  acme_main: 'attio',
  main_crm: 'attio',
  acme_slack: 'slack',
  team_chat: 'slack',
  team_workspace: 'slack',
  team_telegram: 'telegram',
};

const capturedSpecs = adapterSchemas.specs as Record<string, Omit<AdapterSpec, 'schema'>>;

const HANDBOOK_CATALOG: Catalog = mockCatalog({
  adapters: {
    ...Object.fromEntries(
      Object.keys(capturedSchemas).map((adapter) => [
        adapter,
        { ...capturedSpecs[adapter], schema: capturedSchemas[adapter] },
      ]),
    ),
    kg: KG_SPEC,
  },
  credentials: Object.fromEntries(
    Object.entries(CREDENTIAL_ADAPTERS).map(([name, adapter]) => [name, { adapter }]),
  ),
  // The real registry, not a hand-kept copy: a chapter teaching an argument
  // the plugin doesn't accept fails here rather than passing against a
  // literal someone remembered to update.
  plugins: registeredPluginSpecs(),
});

/**
 * The ask surface is REBUILT LIVE rather than read out of the capture, and it is
 * the one adapter that may be: it talks to no third party and needs no
 * credential, so the real adapter IS the truth the capture would record. Two
 * things follow, both of which the captured file cannot give us:
 *
 *  - it can never go stale against the adapter (a captured ask surface silently
 *    lags every change to the families until someone reruns a dev loop);
 *  - a save does not hand the checker a flat schema — it resolves what each
 *    write BODY decides (`graftGenericLandings`: a `Response` is generic over
 *    the very `Options`/`Fields` that ask offered) and grafts the synthesized
 *    positions in. Doing the same here is what lets a probe read a `Choose`'s
 *    enum answer or a `Form`'s named field, which is what the chapter teaches.
 *
 * Everything else stays captured — for a system we cannot reach, a rebuilt
 * surface would be an imagined one.
 */
let askSchema: InstanceSchema | undefined;

// Required lazily: this reaches the adapter tree that registers the very
// handbook sections assembled at the top of this file, and importing it eagerly
// loads that graph mid-assembly.
type AskHostModules = {
  AskAdapter: new (teamId: string) => {
    listEntryPoints: () => Promise<
      Array<{ typeId: string; displayName: string; writable: boolean; readable: boolean }>
    >;
    describe: (typeId: string) => Promise<unknown>;
  };
  instanceSchemaFromDescriptors: (input: {
    adapterType: string;
    entries: Array<{ typeId: string; displayName: string; writable: boolean; readable: boolean }>;
    descriptors: Map<string, unknown>;
    supportsInPlaceUpdate: boolean;
  }) => { schema: InstanceSchema };
  graftGenericLandings: (input: {
    instance: {
      adapterType: string;
      schema: InstanceSchema;
      entryPoints: Array<{ typeId: string; displayName: string; writable: boolean; readable: boolean }>;
    };
    chains: InstanceChain[];
  }) => { schema: InstanceSchema };
};

function askHost(): AskHostModules {
  /* eslint-disable @typescript-eslint/no-var-requires */
  return {
    AskAdapter: require('../../../../services/translation_graph/adapters/ask').AskAdapter,
    instanceSchemaFromDescriptors:
      require('movement-engine/services/translation_graph/movement/schema_projection')
        .instanceSchemaFromDescriptors,
    graftGenericLandings:
      require('../../../../services/translation_graph/movement/generic_landings')
        .graftGenericLandings,
  };
}

let askEntryPoints: Array<{
  typeId: string;
  displayName: string;
  writable: boolean;
  readable: boolean;
}> = [];

beforeAll(async () => {
  const { AskAdapter, instanceSchemaFromDescriptors } = askHost();
  const adapter = new AskAdapter('handbook-team');
  askEntryPoints = await adapter.listEntryPoints();
  const descriptors = new Map<string, unknown>();
  for (const e of askEntryPoints) {
    const d = await adapter.describe(e.typeId);
    if (d) descriptors.set(e.typeId, d);
  }
  askSchema = instanceSchemaFromDescriptors({
    adapterType: 'ask',
    entries: askEntryPoints,
    descriptors,
    supportsInPlaceUpdate: true,
  }).schema;
});

function catalogFor(probe: string): Catalog {
  if (askSchema === undefined) return HANDBOOK_CATALOG;
  const { graftGenericLandings } = askHost();
  const { schema } = graftGenericLandings({
    instance: { adapterType: 'ask', schema: askSchema, entryPoints: askEntryPoints },
    chains: scanInstanceChains(probe),
  });
  return mockCatalog({
    adapters: {
      ...Object.fromEntries(
        Object.keys(capturedSchemas).map((adapter) => [
          adapter,
          {
            ...capturedSpecs[adapter],
            schema: adapter === 'ask' ? schema : capturedSchemas[adapter],
          },
        ]),
      ),
      kg: KG_SPEC,
    },
    credentials: Object.fromEntries(
      Object.entries(CREDENTIAL_ADAPTERS).map(([name, adapter]) => [name, { adapter }]),
    ),
    plugins: registeredPluginSpecs(),
  });
}

/**
 * Probes deliberately NOT checked, each with the reason. A probe belongs here
 * only when the checker cannot be given a truthful catalog for it — never
 * because it fails. Keep this list short: it is the hole coverage escapes
 * through, and the test below pins its size.
 */
const CHECKER_EXEMPT: Array<{ match: string; why: string }> = [
  {
    match: 'file imports (shared movement libraries)',
    why: 'imports a movement from another FILE; the checker needs a file resolver, not a catalog',
  },
  {
    match: 'integration functions outside a write field',
    why: "status:'pending' — it is SUPPOSED to be refused; the engine-claims lockstep owns it",
  },
  {
    match: 'tuple-path multi-parent writes',
    why: 'no captured system publishes a real many-to-many JOIN record. Attio comes closest — `Notes`/`Tasks`/`files` are writable from Companies, People and Deals — but each of those children carries a single scalar `parent_object`/`parent_record_id`, so it belongs to exactly ONE record. The checker WOULD accept `write (co-[:Notes]->, p-[:Notes]->) { … }`, because the captured schema has no way to express single-parent-ness; validating it there would buy a green test for an example that is false about Attio, which is the exact failure this file exists to prevent. Revisit when a system with a genuine join type is connected.',
  },
];

const allClaims: Array<EngineClaim & { chapter: string }> = Object.values(
  movementHandbook.chapters,
).flatMap((chapter): Array<EngineClaim & { chapter: string }> =>
  (chapter.engineClaims ?? []).map((claim) => ({ ...claim, chapter: chapter.id })),
).concat(
  // The handbook's front page and the language search's
  // control forms show examples too, outside any chapter; they are held the
  // same way.
  frontPageClaims().map((claim) => ({ ...claim, chapter: 'front' })),
  controlFormClaims().map((claim) => ({ ...claim, chapter: 'language-search' })),
);

const exemptFor = (construct: string) =>
  CHECKER_EXEMPT.find((e) => construct.includes(e.match));

const checkedClaims = allClaims.filter(
  (c) => c.status === 'runs' && exemptFor(c.construct) === undefined,
);

describe('movement_handbook runnable examples check clean against the real checker', () => {
  it('the captured fixture covers every adapter the chapters construct', () => {
    for (const adapter of ['email', 'attio', 'slack', 'manual', 'cron']) {
      expect(Object.keys(capturedSchemas)).toContain(adapter);
    }
  });

  it('every exemption names a probe that exists (no stale exemptions)', () => {
    for (const entry of CHECKER_EXEMPT) {
      const claim = allClaims.find((c) => c.construct.includes(entry.match));
      if (!claim) throw new Error(`stale exemption: no probe includes "${entry.match}"`);
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it('checker validation covers the overwhelming majority of runnable examples', () => {
    const runnable = allClaims.filter((c) => c.status === 'runs');
    // Nothing sits outside coverage except a runnable probe that is explicitly
    // exempt — so adding a probe adds a checked example unless you justify it.
    const exemptRunnable = runnable.filter((c) => exemptFor(c.construct) !== undefined);
    expect(checkedClaims.length).toBe(runnable.length - exemptRunnable.length);
    // A floor, so coverage can only ever ratchet up. It stood at ONE when two
    // retired constructs rotted across ~87 occurrences.
    expect(checkedClaims.length).toBeGreaterThanOrEqual(35);
  });

  it.each(checkedClaims.map((c) => [c.chapter, c.construct, c] as const))(
    '%s — "%s" checks clean',
    (_chapter, _construct, claim) => {
      // TEMP(v5-docs): the parser does not yet read a `fail(…)` statement
      const probe = claim.probe.replace(/(^[ \t]*|\{ )fail\(/gm, '$1ERROR(');
      const program = parseProgram(probe);
      const files = claim.status === 'runs' ? claim.files : undefined;
      const resolveFile = files
        ? (path: string) => (files[path] !== undefined ? { source: files[path] } : undefined)
        : undefined;
      const errors = checkProgram(program, catalogFor(probe), resolveFile ? { resolveFile } : undefined).filter(
        (d) => (d.severity ?? 'error') === 'error',
      );
      expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    },
  );
});

// ── The record-order rules, against the real adapters ─────────────────────
//
// The traversal chapter teaches which aggregates may read which relationships,
// and the teaching is only worth anything if the captured schemas back it. So
// the refusals are pinned here, on the same fixture the examples are checked
// against: an order the source does not have cannot be borrowed by writing
// `first`, and a source that DOES keep an order needs no `ORDER BY` to prove it.

const ORDER_PRELUDE = `import { \`@lf/attio\` as attio, \`@lf/slack\` as slack } from adapters
import { acme, team_workspace } from credentials

crm  = connect attio using acme
chat = connect slack using team_workspace
`;

function orderCheck(body: string): Array<{ code: string; message: string }> {
  const probe = `${ORDER_PRELUDE}
function m(evt: <crm-[:\`Webhook Event\`]->>) {
${body}
}`;
  // TEMP(v5-docs): the parser does not yet read a `fail(…)` statement
  const checked = probe.replace(/(^[ \t]*|\{ )fail\(/gm, '$1ERROR(');
  return checkProgram(parseProgram(checked), catalogFor(checked))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => ({ code: d.code, message: d.message }));
}

describe('the record-order rules hold against the captured adapter schemas', () => {
  it('Text.join over a relationship with no order is refused, naming the fix', () => {
    const found = orderCheck('  t = Text.join(chat-[c:Channels]->.Name, ", ")');
    expect(found.map((d) => d.code)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(found[0].message).toContain('ORDER BY');
  });

  it('the same Text.join with an ORDER BY on the hop is clean', () => {
    expect(orderCheck('  t = Text.join(chat-[c:Channels ORDER BY c.Name]->.Name, ", ")')).toEqual([]);
  });

  it("a chat channel's messages fold clean with no ORDER BY — the source keeps them in order", () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  t = Text.join(channel-[m:Messages]->.Message, "\\n")',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('first over a relationship with no order is refused, and the message names only', () => {
    const found = orderCheck('  t = first(chat-[c:Channels]->.Name)');
    expect(found.map((d) => d.code)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(found[0].message).toContain('only(');
  });

  it('only over the same lookup is clean — it is what the WHERE meant', () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  write channel-[:Messages]-> { Message: "hi" }',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('LIMIT with no ORDER BY over an unordered relationship is refused', () => {
    const found = orderCheck('  n = count(chat-[c:Channels LIMIT 3]->)');
    expect(found.map((d) => d.code)).toContain('MOV_LIMIT_NEEDS_ORDER');
    expect(found[0].message).toContain('ORDER BY');
  });

  it('…and is clean on a relationship the source keeps in order', () => {
    expect(
      orderCheck(
        [
          '  channel = only(chat-[c:Channels WHERE c.Name == "general"]->)',
          '  if (channel == null) { fail("no channel") }',
          '  n = count(channel-[m:Messages LIMIT 20]->)',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a commutative aggregate reads either', () => {
    expect(orderCheck('  n = count(chat-[c:Channels]->)')).toEqual([]);
  });
});
