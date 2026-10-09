// The awaited ask landing is CHECKED LIKE ANY POSITION (asks-as-adapter §B —
// "the family IS the answer's type declaration; no runtime disagreement between
// surface and store"). This locks the fix for the two-layer defect chunk B's
// e2e verification surfaced:
//
//   1. the Response descriptor's field is 'Answer' (=== displayName), and the
//      landing dict the engine binds is keyed by that same name — so the
//      DECLARED name `got.Answer` reaches the value (proven end-to-end in
//      ask_adapter.unit.test.ts's getFieldValue read);
//   2. an UNKNOWN field on the awaited landing is a CHECKER error
//      (MOV_UNKNOWN_PROPERTY, the same did-you-mean pattern every other typed
//      position uses) rather than a silent runtime null.
//
// It runs the REAL adapter (listEntryPoints + describe) through the REAL
// projection (`instanceSchemaFromDescriptors`) so a regression in the descriptor
// naming, the projection, or the write-handle edge traversal typing all trip it.
// movement-lang's own jest is broken locally, so the language layer is exercised
// through apps/api's ts-jest (per repo convention).

import {
  parseProgram,
  checkProgram,
  fromCatalogSnapshot,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor } from '../../../types';

import { instanceSchemaFromDescriptors } from '../../../movement/schema_projection';
import { AskAdapter } from '../index';

async function askSnapshot(): Promise<{ schema: InstanceSchema; snapshot: CatalogSnapshot }> {
  const adapter = new AskAdapter('team-1' as TeamId);
  const entries = await adapter.listEntryPoints();
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  for (const e of entries) {
    const d = await adapter.describe(e.typeId);
    if (d) descriptors.set(e.typeId, d);
  }
  const { schema } = instanceSchemaFromDescriptors({
    adapterType: 'ask',
    entries,
    descriptors,
    supportsInPlaceUpdate: true,
  });
  // Credential-free adapter: its schema keys under the empty position key.
  const snapshot: CatalogSnapshot = {
    adapters: { questions: { constructionArgs: [], schemas: { '': schema } } },
    credentials: {},
    plugins: {},
  };
  return { schema, snapshot };
}

const PRELUDE = `import { questions } from adapters\nqa = questions()\n`;

async function errorsFor(body: string): Promise<string[]> {
  const { snapshot } = await askSnapshot();
  return checkProgram(
    parseProgram(`${PRELUDE}\nmovement m() {\n${body}\n}`),
    fromCatalogSnapshot(snapshot),
  )
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

const AWAIT = `  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  r = await FIRST(a-[:Response]->)`;

describe('the awaited ask landing is checked like any position', () => {
  it("projects the Check ask's own Response node CLOSED, Answer typed boolean (not the old shared string)", async () => {
    const { schema } = await askSnapshot();
    expect(schema.positions['Check Response']).toEqual({ properties: { Answer: 'boolean' }, edges: {} });
    // The old shared type no longer exists.
    expect(schema.positions.Response).toBeUndefined();
  });

  it('projects every family\'s OWN Response node with its own honest Answer type', async () => {
    const { schema } = await askSnapshot();
    expect(schema.positions['Check Response']).toEqual({ properties: { Answer: 'boolean' }, edges: {} });
    expect(schema.positions['Choose Response']).toEqual({ properties: { Answer: 'text' }, edges: {} });
    expect(schema.positions['Select Response']).toEqual({
      properties: { Answer: { kind: 'list', of: 'text' } },
      edges: {},
    });
    expect(schema.positions['Review Response']).toEqual({ properties: { Answer: 'text' }, edges: {} });
    expect(schema.positions['Provide Response']).toEqual({ properties: { Answer: 'text' }, edges: {} });
    expect(schema.positions['Correct Response']).toEqual({ properties: { Answer: 'json' }, edges: {} });
    expect(schema.positions['Draft Response']).toEqual({ properties: { Answer: 'json' }, edges: {} });
    expect(schema.positions['Form Response']).toEqual({ properties: { Answer: 'json' }, edges: {} });
  });

  it('reading the DECLARED name is clean', async () => {
    expect(await errorsFor(`${AWAIT}\n  if r.Answer { }`)).toEqual([]);
  });

  it('the lowercase/undeclared name is a CHECKER error (not a silent null)', async () => {
    // The old landing keyed a lowercase `answer` that missed the declared
    // 'Answer' surface and silently nulled at runtime — now refused up front.
    expect(await errorsFor(`${AWAIT}\n  if r.answer { }`)).toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('a bogus field is a CHECKER error', async () => {
    expect(await errorsFor(`${AWAIT}\n  if r.TotallyBogusFieldXYZ { }`)).toContain(
      'MOV_UNKNOWN_PROPERTY',
    );
  });

  it('a Select ask lands Answer as list<text>; reading it is clean', async () => {
    const codes = await errorsFor(
      `  s = write qa-[:Select]-> { Prompt: "Pick", Options: ["a", "b"] }\n  r = await FIRST(s-[:Response]->)\n  x = r.Answer`,
    );
    expect(codes).toEqual([]);
  });

  it('a Draft ask lands Answer as json — comparing it is MOV_JSON_OPAQUE (json is opaque, not a lie of scalar)', async () => {
    const codes = await errorsFor(
      `  d = write qa-[:Draft]-> { Prompt: "Draft the memo" }\n  r = await FIRST(d-[:Response]->)\n  if r.Answer == "x" { }`,
    );
    expect(codes).toContain('MOV_JSON_OPAQUE');
  });

  it('resolvesEmpty still wraps the awaited scalar maybe-absent (unchanged by the per-family split)', async () => {
    // The resolvesEmpty/awaitable flags on the Response edge are untouched by
    // this chunk's per-family retarget — pin that they're still there.
    const d = await new AskAdapter('team-1' as TeamId).describe('Check');
    const response = d!.references.find((r) => r.name === 'Response');
    expect(response).toMatchObject({ resolvesEmpty: true, awaitable: true, targetTypeId: 'Check Response' });
  });
});

// ── The read that WAITS is the same read (callback-primitive layer 3) ───────

const ASK = '  a = write qa-[:Check]-> { Prompt: "Ship it?" }';

describe('awaitable is a read MODE, not an edge kind', () => {
  it('a BARE read of the Response edge is legitimate — it reads now and yields nothing until answered', async () => {
    // MOV_AWAIT_REQUIRED used to refuse this. It is the right diagnostic only
    // for an awaitable edge with NO bare read to fall back on (Slack `Replies`,
    // `readable: false`) — the ask's Response is readable, so reading it now and
    // getting nothing is a legitimate thing to ask for.
    expect(await errorsFor(`${ASK}\n  a-[r:Response]-> { }`)).toEqual([]);
  });

  it('the bare read lands the SAME per-family type `await` does', async () => {
    expect(await errorsFor(`${ASK}\n  a-[r:Response]-> { if r.Answer { } }`)).toEqual([]);
    expect(await errorsFor(`${ASK}\n  a-[r:Response]-> { if r.TotallyBogusFieldXYZ { } }`)).toContain(
      'MOV_UNKNOWN_PROPERTY',
    );
  });

  it('`await` over the very same edge is still clean — one edge, two read modes', async () => {
    expect(await errorsFor(`${AWAIT}\n  if r.Answer { }`)).toEqual([]);
  });
});
