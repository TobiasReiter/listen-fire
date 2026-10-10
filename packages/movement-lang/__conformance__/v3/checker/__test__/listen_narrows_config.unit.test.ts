// A listen's config is an ADDRESS plus filters, and nothing in it belongs to
// one adapter. Three surfaces, all declared:
//
//   - a `narrows` hop (`type: "company"`, `folder: "inbox"`) — a quoted value
//     that pins one leg of the event address;
//   - `events: [...]` — the subscribable kinds, from `triggerConfigOptions`;
//   - a `'fields'`-format key (`fields: [domains]`, `watch: [size]`) — BARE
//     property names of whatever the address lands on.
//
// The knowledge graph used to own a private version of all three (`type:
// <company>`, `changes: [...]`, `fields: [...]`, checked by a kg-only branch
// against an ambient schema). It is an ordinary adapter now (D25), so its
// listen rides the general mechanism and this suite tests the mechanism.
//
// TWO DIFFERENTLY-SHAPED ADAPTERS throughout: a fixture matching one adapter's
// shape cannot tell derived behaviour from hardcoded behaviour. `kg` pins a
// `type` and files its filter under `fields`; `vault` pins a `folder`, files
// its filter under `watch`, and subscribes to a `file.*` vocabulary. Wherever
// a diagnostic quotes a key, a value, or a property, both shapes are asserted.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import {
  mockCatalog,
  type SchemaFieldType,
  type InstanceSchema,
  type PositionSchema,
} from '../catalog';
import { eventAddressDisplay, eventAddressKey, narrowingPrefixKey } from '../event_address';

/** The event surface an adapter with ONE address hop publishes: the wide event
 *  node, the per-(hop, action) positions the host grafts on demand, and a
 *  union at each hop value. Built through `eventAddressKey`/`Display` exactly
 *  as the host builds it, so these tests assert the checker AGREES on the key
 *  rather than asserting their own arithmetic. */
function eventSurface(input: {
  event: string;
  actions: string[];
  hop: string;
  /** hop value → the properties the address lands on. */
  landings: Record<string, Record<string, SchemaFieldType>>;
}): InstanceSchema {
  const { event, actions, hop, landings } = input;
  const action: SchemaFieldType = { kind: 'enum', options: actions };
  const positions: Record<string, PositionSchema> = {
    [event]: { properties: { action, [hop]: 'text' }, edges: {} },
  };
  const unions: Record<string, string[]> = {};
  const unionDisplayNames: Record<string, string> = {};
  for (const [value, properties] of Object.entries(landings)) {
    const variants: string[] = [];
    for (const kind of actions) {
      const narrowing = { [hop]: value, action: kind };
      const key = eventAddressKey({ event, narrowing });
      variants.push(key);
      positions[key] = {
        properties: { action, [hop]: 'text', ...properties },
        edges: {},
        displayName: eventAddressDisplay({ event, narrowing }),
      };
    }
    const unionKey = eventAddressKey({ event, narrowing: { [hop]: value } });
    unions[unionKey] = variants;
    unionDisplayNames[unionKey] = eventAddressDisplay({
      event,
      narrowing: { [hop]: value },
    });
  }
  return {
    positions,
    collections: {},
    unions,
    unionDisplayNames,
    writableRoots: {},
    eventPosition: event,
    eventPositions: [{ position: event }],
    eventNarrowingKeys: [hop],
    eventNarrowingValues: {
      [narrowingPrefixKey({})]: { [hop]: Object.keys(landings) },
    },
  };
}

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

const KG_ACTIONS = ['record.created', 'record.updated', 'record.deleted'];
const KG_SCHEMA = eventSurface({
  event: 'Record Change',
  actions: KG_ACTIONS,
  hop: 'type',
  landings: {
    company: { name: 'text', domains: textList },
    person: { name: 'text', email: 'text' },
  },
});

const VAULT_ACTIONS = ['file.added', 'file.removed'];
const VAULT_SCHEMA = eventSurface({
  event: 'Change',
  actions: VAULT_ACTIONS,
  hop: 'folder',
  landings: {
    inbox: { title: 'text', size: 'number' },
    archive: { title: 'text' },
  },
});

const catalog = mockCatalog({
  adapters: {
    kg: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['type', 'events', 'fields'],
      triggerConfigRequired: ['type'],
      triggerConfigOptions: { events: KG_ACTIONS },
      triggerConfigFormats: { fields: 'fields' },
      schema: KG_SCHEMA,
    },
    vault: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['folder', 'events', 'watch'],
      triggerConfigRequired: ['folder'],
      triggerConfigOptions: { events: VAULT_ACTIONS },
      triggerConfigFormats: { watch: 'fields' },
      schema: VAULT_SCHEMA,
    },
  },
  credentials: {
    native_knowledge: { adapter: 'kg' },
    vault_main: { adapter: 'vault' },
  },
});

const checkAll = (source: string): Diagnostic[] => checkProgram(parseProgram(source), catalog);
const check = (source: string): Diagnostic[] =>
  checkAll(source).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => check(source).map(d => d.code);
const messageOf = (source: string, code: string): string | undefined =>
  check(source).find(d => d.code === code)?.message;

function expectClean(source: string): void {
  expect(check(source).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

const PRELUDE = [
  'import { kg, vault } from adapters',
  'import { native_knowledge, vault_main } from credentials',
  '',
  'graph = kg(credentials: native_knowledge)',
  'files = vault(credentials: vault_main)',
].join('\n');

/** The signature names the FULL address, both shapes. */
const KG_COMPANY =
  '<graph-[:`Record Change` WHERE `action` == "record.created" AND `type` == "company"]->>';
const VAULT_INBOX =
  '<files-[:`Change` WHERE `action` == "file.added" AND `folder` == "inbox"]->>';

/** One movement over one address, plus the listens that fire it. Each shape
 *  reads a property of its OWN landing, so a wrong address shows up as a read
 *  error rather than as silence. */
const kgProgram = (listens: string[], param = KG_COMPANY) =>
  [
    PRELUDE,
    `movement on_company_change(rec: ${param}) {`,
    '  ERROR("${rec.`name`}")',
    '}',
    ...listens.map(config => `listen to graph ${config} fire on_company_change`),
  ].join('\n');

const vaultProgram = (listens: string[], param = VAULT_INBOX) =>
  [
    PRELUDE,
    `movement on_file(f: ${param}) {`,
    '  ERROR("${f.`title`}")',
    '}',
    ...listens.map(config => `listen to files ${config} fire on_file`),
  ].join('\n');

// ── The address hop ──

describe('a narrows hop is an ordinary quoted config value', () => {
  it('the full form checks clean — hop, events, and the fields filter', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"], fields: [domains] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"], watch: [size] }']));
  });

  it('a listen pinning a DIFFERENT hop value cannot fire the movement', () => {
    const kgDiag = check(kgProgram(['{ type: "person", events: ["record.created"] }']));
    expect(kgDiag.map(d => d.code)).toEqual([C.LISTEN_PARAM_MISMATCH]);
    expect(kgDiag[0].message).toContain('type=person');
    expect(kgDiag[0].message).toContain('type=company');

    const vaultDiag = check(vaultProgram(['{ folder: "archive", events: ["file.added"] }']));
    expect(vaultDiag.map(d => d.code)).toEqual([C.LISTEN_PARAM_MISMATCH]);
    expect(vaultDiag[0].message).toContain('folder=archive');
    expect(vaultDiag[0].message).toContain('folder=inbox');
  });

  // A hop value the adapter doesn't offer is a typo, and a typo against a known
  // value set is an enum error with a did-you-mean — the same rule everywhere
  // an address is written. A signature and a listen are the same address in
  // two spellings, so the typo dies the same way in both.
  it("a typo'd hop value in the signature is MOV_ENUM_UNKNOWN_VALUE, per adapter", () => {
    const kgDiag = check(
      kgProgram([], '<graph-[:`Record Change` WHERE `type` == "compnay"]->>'),
    );
    expect(kgDiag.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(kgDiag[0].message).toContain('Did you mean "company"?');

    const vaultDiag = check(
      vaultProgram([], '<files-[:`Change` WHERE `folder` == "inbx"]->>'),
    );
    expect(vaultDiag.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(vaultDiag[0].message).toContain('Did you mean "inbox"?');
  });

  // The listen-side twin. This is the check the graph's deleted privilege used
  // to do for itself ("'<ghost>' is not a node type of this workspace's
  // knowledge graph"); losing it would have made the general mechanism WEAKER
  // than the privilege it replaced, which is the one thing the swap may not do.
  it("a typo'd hop value in the LISTEN's config is MOV_ENUM_UNKNOWN_VALUE, per adapter", () => {
    const kgDiag = check(kgProgram(['{ type: "compnay" }']));
    expect(kgDiag.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(messageOf(kgProgram(['{ type: "compnay" }']), C.ENUM_UNKNOWN_VALUE)).toContain(
      'Did you mean "company"?',
    );

    const vaultDiag = check(vaultProgram(['{ folder: "inbx" }']));
    expect(vaultDiag.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(messageOf(vaultProgram(['{ folder: "inbx" }']), C.ENUM_UNKNOWN_VALUE)).toContain(
      'Did you mean "inbox"?',
    );
  });

  it('a listen omitting a REQUIRED hop names that adapter\'s key', () => {
    const kgMessage = messageOf(kgProgram(['{ events: ["record.created"] }']), C.LISTEN_BAD_CONFIG);
    expect(kgMessage).toContain("a 'kg' listener requires a 'type' config");

    const vaultMessage = messageOf(
      vaultProgram(['{ events: ["file.added"] }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain("a 'vault' listener requires a 'folder' config");
  });

  // The graph's `type: <company>` was the last angle-bracketed listen config in
  // the language. The fix-it now runs the other way.
  it('an angle-bracketed hop value is MOV_LISTEN_BAD_CONFIG with the quoted fix-it', () => {
    const kgMessage = messageOf(kgProgram(['{ type: <company> }']), C.LISTEN_BAD_CONFIG);
    expect(kgMessage).toContain('is a type reference');
    expect(kgMessage).toContain('type: "company"');

    const vaultMessage = messageOf(vaultProgram(['{ folder: <inbox> }']), C.LISTEN_BAD_CONFIG);
    expect(vaultMessage).toContain('folder: "inbox"');
  });

  it("an unknown config key names that adapter's own vocabulary", () => {
    const kgMessage = messageOf(
      kgProgram(['{ type: "company", colour: "red" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(kgMessage).toContain("'kg' listeners do not accept a config key 'colour'");
    expect(kgMessage).toContain('type, events, fields');

    const vaultMessage = messageOf(
      vaultProgram(['{ folder: "inbox", colour: "red" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain('folder, events, watch');
  });

  it('two listens on different hop values are not duplicates; two on the same one are', () => {
    const distinct = [
      PRELUDE,
      `movement on_company_change(rec: ${KG_COMPANY}) {`,
      '  ERROR("${rec.`name`}")',
      '}',
      `movement on_person_change(rec: <graph-[:\`Record Change\` WHERE \`action\` == "record.created" AND \`type\` == "person"]->>) {`,
      '  ERROR("${rec.`email`}")',
      '}',
      'listen to graph { type: "company", events: ["record.created"] } fire on_company_change',
      'listen to graph { type: "person", events: ["record.created"] } fire on_person_change',
    ].join('\n');
    expectClean(distinct);

    expect(
      codes(
        kgProgram([
          '{ type: "company", events: ["record.created"] }',
          '{ type: "company", events: ["record.created"] }',
        ]),
      ),
    ).toEqual([C.LISTEN_DUPLICATE]);
  });
});

// ── The events vocabulary ──

describe('events is the subscribable-kind vocabulary (triggerConfigOptions)', () => {
  it('a declared kind subscribes clean — always a list', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"] }']));
  });

  it('a bare-string kind is MOV_LISTEN_BAD_CONFIG — events is always a list', () => {
    const kgMessage = messageOf(
      kgProgram(['{ type: "company", events: "record.created" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(kgMessage).toContain('events: ["record.created"]');

    const vaultMessage = messageOf(
      vaultProgram(['{ folder: "inbox", events: "file.added" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain('events: ["file.added"]');
  });

  it("an undeclared kind names THAT adapter's vocabulary", () => {
    const kgMessage = messageOf(
      kgProgram(['{ type: "company", events: ["record.exploded"] }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(kgMessage).toContain("'record.exploded'");
    expect(kgMessage).toContain('record.created, record.updated, record.deleted');

    const vaultMessage = messageOf(
      vaultProgram(['{ folder: "inbox", events: ["file.exploded"] }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain("'file.exploded'");
    expect(vaultMessage).toContain('file.added, file.removed');
  });

  it('a non-literal kind is MOV_LISTEN_BAD_CONFIG', () => {
    expect(codes(kgProgram(['{ type: "company", events: [TRUE] }']))).toContain(
      C.LISTEN_BAD_CONFIG,
    );
    expect(codes(vaultProgram(['{ folder: "inbox", events: [TRUE] }']))).toContain(
      C.LISTEN_BAD_CONFIG,
    );
  });
});

// ── The changed-attribute filter ──

describe("a 'fields'-format key is bare property names of the landed address", () => {
  it('names the address lands on check clean, under either adapter\'s key', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"], fields: [name, domains] }']));
    expectClean(vaultProgram(['{ folder: "inbox", events: ["file.added"], watch: [title, size] }']));
  });

  it("a name the landed position doesn't carry lists that position's properties", () => {
    // `email` is a property of the graph's PERSON landing, not its company one
    // — which is the whole point of checking against the landed address rather
    // than against the instance.
    const kgMessage = messageOf(
      kgProgram(['{ type: "company", events: ["record.created"], fields: [email] }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(kgMessage).toContain("'email' is not a property of what this listener watches");
    expect(kgMessage).toContain('domains');
    expect(kgMessage).toContain('name');

    // `size` is a property of the vault's INBOX landing, not its archive one.
    const vaultMessage = messageOf(
      vaultProgram(
        ['{ folder: "archive", events: ["file.added"], watch: [size] }'],
        '<files-[:`Change` WHERE `action` == "file.added" AND `folder` == "archive"]->>',
      ),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain("'size' is not a property of what this listener watches");
    expect(vaultMessage).toContain('title');
  });

  it('a value that is not a list of bare names carries the bare-list fix-it', () => {
    const kgMessage = messageOf(
      kgProgram(['{ type: "company", events: ["record.created"], fields: "domains" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(kgMessage).toContain("'fields' is a list of the watched type's properties, bare");

    const vaultMessage = messageOf(
      vaultProgram(['{ folder: "inbox", events: ["file.added"], watch: "size" }']),
      C.LISTEN_BAD_CONFIG,
    );
    expect(vaultMessage).toContain("'watch' is a list of the watched type's properties, bare");
  });

  it('an adapter with no schema leaves the names unvalidated — unknown stays silent', () => {
    const blind = mockCatalog({
      adapters: {
        kg: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          triggerConfig: ['type', 'events', 'fields'],
          triggerConfigOptions: { events: KG_ACTIONS },
          triggerConfigFormats: { fields: 'fields' },
        },
      },
      credentials: { native_knowledge: { adapter: 'kg' } },
    });
    const source = [
      'import { kg } from adapters',
      'import { native_knowledge } from credentials',
      'graph = kg(credentials: native_knowledge)',
      'movement m(rec: <graph-[:`Record Change`]->>) {',
      '  ERROR("nothing to see")',
      '}',
      'listen to graph { type: "company", events: ["record.created"], fields: [whatever] } fire m',
    ].join('\n');
    expect(
      checkProgram(parseProgram(source), blind).filter(d => (d.severity ?? 'error') === 'error'),
    ).toEqual([]);
  });
});

// ── The universal 2-way-sync flag ──
//
// `suppress_self` is valid on EVERY listener, default off, boolean-literal
// only. NOT a loop detector: it declares "ignore my own writes echoing back
// into this system."

describe('suppress_self — the universal listen flag', () => {
  it('rides alongside an adapter\'s own vocabulary, either shape', () => {
    expectClean(
      kgProgram(['{ type: "company", events: ["record.created"], suppress_self: true }']),
    );
    expectClean(
      vaultProgram(['{ folder: "inbox", events: ["file.added"], suppress_self: true }']),
    );
  });

  it('suppress_self: false checks clean (explicit default-off)', () => {
    expectClean(
      kgProgram(['{ type: "company", events: ["record.created"], suppress_self: false }']),
    );
  });

  it('omitting it is clean — the default is off', () => {
    expectClean(kgProgram(['{ type: "company", events: ["record.created"] }']));
  });

  it('a non-boolean value is MOV_LISTEN_BAD_CONFIG (boolean literal only)', () => {
    expect(
      messageOf(
        kgProgram(['{ type: "company", events: ["record.created"], suppress_self: "yes" }']),
        C.LISTEN_BAD_CONFIG,
      ),
    ).toContain('boolean literal');

    expect(
      messageOf(
        vaultProgram(['{ folder: "inbox", events: ["file.added"], suppress_self: 3 }']),
        C.LISTEN_BAD_CONFIG,
      ),
    ).toContain('boolean literal');
  });
});

// ── Nothing is ambient ──

describe('the graph is imported AND constructed, like any adapter (D25)', () => {
  it('a known adapter used unconstructed names both missing lines', () => {
    const source = [
      'import { vault } from adapters',
      'import { vault_main } from credentials',
      'files = vault(credentials: vault_main)',
      `movement m(f: ${VAULT_INBOX}) {`,
      '  ERROR("${kg}")',
      '}',
      'listen to files { folder: "inbox", events: ["file.added"] } fire m',
    ].join('\n');
    const found = check(source);
    expect(found.map(d => d.code)).toContain(C.NAME_UNRESOLVED);
    const message = found.find(d => d.code === C.NAME_UNRESOLVED)?.message;
    expect(message).toContain('import { kg } from adapters');
    expect(message).toContain("kg(credentials: …)");
  });

  it('importing and constructing brings the graph into scope — listen included', () => {
    expect(codes(kgProgram(['{ type: "company", events: ["record.created"] }']))).toEqual([]);
  });

  // The graph's name is no longer its address, so it aliases like any other
  // adapter import (asserted positively in check.unit.test.ts's aliased-import
  // fixture). MOV_KG_IMPORT_ALIASED is gone with the privilege.
});
