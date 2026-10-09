// extraction.json: what the extraction keyword asks a model and how it reads
// the answer, written by the TypeScript's own code (apps/api's
// movement_engine/extraction.ts and run_context.ts), which
// tests/extraction_pin.rs holds crates/movement-engine/src/extract and the
// ledger to. Written by generate.ts; deterministic.
//
// Five kinds of case:
//   - `program`: a seeded program (and the library files it imports) with an
//     extraction, the spec `buildExtractSpec` builds for it, and every region
//     a materialisation of it would call, each with its system prompt, the
//     envelope its retry shows, its site count, and seeded replies read by
//     `responseSchemaFor` (valid, wrapped, bare, mislabelled, a required
//     answer missing, a value of the wrong type, keys nothing declared, …):
//     the data it reads or the issues it raises, what it coerced, the retry's
//     words and the failure's detail. Descriptions that interpolate are
//     resolved by a stand-in that names the scope it was asked in (the
//     firing, or the file that declared the words), so the pin holds which
//     scope each description reads.
//   - `message`: a user message `renderUserMessage` renders from seeded
//     segments, an entity's context and its enrichments.
//   - `datum`: a `from` datum as `segmentForDatum` reads it, and a plugin's
//     answer as `transformResultSegments` does.
//   - `priced`: a `through` plugin's invocation under a seeded ledger
//     (`pricedCalls`): refused before the host is asked once the cap is
//     spent, or invoked with the run's budget and its cost charged — and the
//     ledger's account either way.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { declaredTypesIn, parseProgram, resolveBorrowedField } from '../../../../packages/movement-lang';
import type { ExprSlot, InstanceSchema, Program, ShapeDeclaration, Statement } from '../../../../packages/movement-lang';
import {
  buildExtractSpec,
  buildSystemPrompt,
  CoercionTracker,
  countSites,
  envelopeExample,
  planRegion,
  renderUserMessage,
  responseSchemaFor,
  retryUserMessage,
  segmentForDatum,
  transformResultSegments,
  unansweredDetail,
  type CallSite,
  type DeclaredNodeShape,
  type ExtractNodeSpec,
  type PluginSpecs,
} from '../../../../apps/api/src/services/movement_engine/extraction';
import { MovementEngineError } from '../../../../apps/api/src/services/movement_engine/errors';
import { pricedCalls, RunLedger } from '../../../../apps/api/src/services/movement_engine/run_context';
import type { EngineHost } from '../../../../apps/api/src/services/movement_engine/host';

type Rand = () => number;

// ── The live schemas a borrowed type resolves against ─────────────────────────

/** Only `crm` and `kg` are instances; any other name borrows nothing. Every
 *  field type an extraction can meet, the program-only shapes included. */
const SCHEMAS: Record<string, InstanceSchema> = {
  crm: {
    positions: {
      company: {
        properties: {
          name: 'text',
          size: 'number',
          stage: 'text',
          tags: { kind: 'list', of: { kind: 'enum', options: ['B2B', 'SaaS', 'Fintech'], open: {} } },
          founded: 'date',
          seen: 'datetime',
          deck: 'file',
          meta: 'json',
          active: 'boolean',
        },
        edges: {},
      },
    },
    collections: {},
    writableRoots: {
      company: {
        fields: {
          stage: { kind: 'enum', options: ['Seed', 'Series A', 'Series B'] },
          sector: { kind: 'enum', options: ['Climate', 'Health'], open: { allowPattern: '^[A-Z]' } },
          blank: { kind: 'enum', options: [] },
          labels: { kind: 'list', of: { kind: 'enum', options: ['hot', 'cold'] } },
          nolabels: { kind: 'list', of: { kind: 'enum', options: [] } },
          notes: { kind: 'list', of: 'text' },
          scores: { kind: 'list', of: 'number' },
          pair: { kind: 'tuple', of: ['text', 'number'] },
          bag: { kind: 'dict', of: 'text' },
          maybe: { kind: 'maybeAbsent', of: 'number' },
        },
        resultShape: {},
      },
    },
  },
  kg: {
    positions: { deal: { properties: { kind: 'text', amount: 'number' }, edges: {} } },
    collections: {},
    writableRoots: {
      deal: {
        // Shapes no surface declares, written here to pin what the
        // validator does with them should one ever arrive.
        fields: {
          kind: { kind: 'enum', options: ['equity', 'debt'] },
          either: { kind: 'union', of: ['text', 'number'] } as never,
          either3: { kind: 'union', of: ['boolean', { kind: 'list', of: 'number' }, 'text'] } as never,
          lone: { kind: 'union', of: ['text'] } as never,
          held: { kind: 'record' } as never,
          nothing: 'absent',
        },
        resultShape: {},
      },
    },
  },
};

const BORROWED = [
  'crm-[:company]->.`stage`', 'crm-[:company]->.`sector`', 'crm-[:company]->.`blank`', 'crm-[:company]->.`labels`',
  'crm-[:company]->.`nolabels`', 'crm-[:company]->.`notes`', 'crm-[:company]->.`scores`', 'crm-[:company]->.`pair`',
  'crm-[:company]->.`bag`', 'crm-[:company]->.`maybe`', 'crm-[:company]->.`tags`', 'crm-[:company]->.`size`',
  'crm-[:company]->.`founded`', 'crm-[:company]->.`deck`', 'crm-[:company]->.`meta`', 'crm-[:company]->.`active`',
  'crm-[:company]->.`missing`', 'crm-[:nowhere]->.`stage`', 'kg-[:deal]->.`kind`', 'kg-[:deal]->.`either`',
  'kg-[:deal]->.`either3`', 'kg-[:deal]->.`lone`', 'kg-[:deal]->.`held`', 'kg-[:deal]->.`nothing`', 'kg-[:deal]->.`amount`',
  'zz-[:a]->.`b`',
];
const PRIMITIVES = ['text', 'number', 'boolean', 'date', 'datetime', 'json', 'file'];

// ── Library files (fixed: the link is the generator's, so it must be right) ──

const LIBRARIES: Array<{ path: string; source: string }> = [
  {
    path: 'deals',
    source: [
      'type LStage = <"pre" | "post">',
      'lens = "for funds"',
      'node Base: "the base ${lens}" {',
      '  origin: <text> "where it came from ${lens}"',
      '  phase: <LStage>',
      '}',
      'export node Pitch extends Base: "a pitch" {',
      '  stage: <LStage> "its stage"',
      '  node person: "each person" {',
      '    role: <Stage> "their role"',
      '    name: <text>',
      '  }',
      '}',
      'export node Plain {',
      '  title: <text> "the title"',
      '  count: <number>',
      '}',
    ].join('\n'),
  },
  {
    path: 'more',
    source: [
      'import { Plain } from "deals"',
      'type Kind = <"x" | "y">',
      'export node Wide extends Plain: "a wide one ${x}" {',
      '  kind: <Kind> "${x} kind"',
      '}',
    ].join('\n'),
  },
];

/** What the root may import from the libraries, by local name. */
const ROOT_IMPORTS = [
  { local: 'Pitch', name: 'Pitch', file: 'deals' },
  { local: 'P2', name: 'Plain', file: 'deals' },
  { local: 'Wide', name: 'Wide', file: 'more' },
];

function shapeIndex(program: Program, name: string): number {
  const index = program.statements.findIndex((s) => s.kind === 'shape' && s.name === name);
  if (index < 0) throw new Error(`no shape ${name}`);
  return index;
}

const LIBRARY_PROGRAMS = new Map(LIBRARIES.map((l) => [l.path, parseProgram(l.source, { languageVersion: 3 })]));
const LIBRARY_IMPORTS = new Map<string, Array<{ local: string; kind: 'shape'; name: string; file: string; declaration: string }>>([
  ['deals', []],
  ['more', [{ local: 'Plain', kind: 'shape', name: 'Plain', file: 'deals', declaration: `/statements/${shapeIndex(LIBRARY_PROGRAMS.get('deals')!, 'Plain')}` }]],
]);

// ── The scope chain a declaration is resolved through (run.ts, mirrored) ─────

interface ShapeAt {
  declaration: ShapeDeclaration;
  /** 'root', or the library path that declared it. */
  file: string;
}

function shapeOf(program: Program, name: string): ShapeDeclaration | undefined {
  return program.statements.find((s): s is Extract<Statement, { kind: 'shape' }> => s.kind === 'shape' && s.name === name);
}

/** run.ts `libraryShape`: a library's own declaration, or one it imports. */
function libraryShape(file: string, name: string): ShapeAt | undefined {
  const own = shapeOf(LIBRARY_PROGRAMS.get(file)!, name);
  if (own !== undefined) return { declaration: own, file };
  const imported = LIBRARY_IMPORTS.get(file)!.find((i) => i.local === name);
  return imported === undefined ? undefined : { declaration: shapeOf(LIBRARY_PROGRAMS.get(imported.file)!, imported.name)!, file: imported.file };
}

/** The tag a stand-in description carries: the scope it was asked in. */
function describedIn(scope: string, slot: ExprSlot): string {
  return `⟪${scope}|${slot.raw}⟫`;
}

function declaredNode(root: Map<string, ShapeAt>, rootTypes: ReturnType<typeof declaredTypesIn>, shape: ShapeAt): DeclaredNodeShape {
  // run.ts `shapeChain` then `declaredNodeShape`.
  const chain: ShapeAt[] = [];
  for (let at: ShapeAt | undefined = shape; at !== undefined; ) {
    const current: ShapeAt = at;
    if (chain.some((c) => c.declaration === current.declaration)) {
      throw new MovementEngineError('MOVENG_RUNTIME', `'${shape.declaration.name}' extends itself — the checker should have caught this`);
    }
    chain.push(current);
    const base = current.declaration.extends;
    if (base === undefined) break;
    at = current.file === 'root' ? root.get(base.name) : libraryShape(current.file, base.name);
    if (at === undefined) {
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `'${current.declaration.name}' extends '${base.name}', which is not a node declaration in scope — the checker should have caught this`,
      );
    }
  }
  let declared: DeclaredNodeShape | undefined;
  for (const link of chain.reverse()) {
    const program = link.file === 'root' ? undefined : LIBRARY_PROGRAMS.get(link.file)!;
    const types = program !== undefined ? declaredTypesIn(program) : undefined;
    declared = {
      root: link.declaration.root,
      resolveDeclaredType: (name) => (types ?? rootTypes).get(name),
      resolveDescription: async (slot) => describedIn(link.file, slot),
      ...(declared !== undefined ? { base: declared } : {}),
    };
  }
  return declared!;
}


// ── Seeded programs ──────────────────────────────────────────────────────────

const FIELD_NAMES = ['name', 'stage', 'website', 'amount', 'founded', 'tags', 'notes', 'summary', 'when', 'deck', 'score', 'kind', 'value', 'evidence', 'Ünï', 'flag'];
const NODE_NAMES = ['company', 'founder', 'round', 'deal', 'Big Co', 'person', 'value', 'note', 'entry'];
const WORDS = [
  '"the name"', '"what it is called, \\"quoted\\""', '"pick from ${rules}"', '"${UPPER(rules)} and more"', '"a tab\\there"',
  '"Ünïcode ✓"', '""', '"each one, if any"', '"the ${msg.`name`}"',
];
const PIPELINES = ['vc_url_retrieval', 'fetch_url(url: website)', 'p(url: name, depth: 2)', 'vc_url_retrieval, fetch_url(url: website)'];

class Program$ {
  readonly shapes: string[] = [];
  constructor(readonly rand: Rand) {}
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }
}

function distinct(g: Program$, pool: readonly string[], count: number, taken: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < 20 && out.length < count; i++) {
    const name = g.pick(pool);
    if (taken.has(name)) continue;
    taken.add(name);
    out.push(name);
  }
  return out;
}

const quoteName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name}\``);

function inlineType(g: Program$): string {
  const roll = g.rand();
  const base =
    roll < 0.3 ? '' : roll < 0.55 ? g.pick(PRIMITIVES) : roll < 0.65 ? g.pick(['Stage', 'Flag', 'Missing', 'LStage']) : g.pick(BORROWED);
  if (base === '') return '';
  return `<${base}${g.chance(0.2) ? ' | null' : ''}> `;
}

function inlineStage(g: Program$, depth: number, indent: string, taken: Set<string>): string[] {
  const lines: string[] = [];
  for (const field of distinct(g, FIELD_NAMES, Math.floor(g.rand() * 4), taken)) {
    lines.push(`${indent}${quoteName(field)}: ${inlineType(g)}${g.pick(WORDS)}`);
  }
  if (depth < 3) {
    const childNames = distinct(g, NODE_NAMES, g.chance(0.6) ? 1 + Math.floor(g.rand() * 2) : 0, taken);
    for (const child of childNames) lines.push(...childNode(g, child, depth + 1, indent));
  }
  return lines;
}

function followingStages(g: Program$, depth: number, indent: string, taken: Set<string>, opened: string): string[] {
  const lines: string[] = [];
  let close = opened;
  const stages = g.chance(0.35) ? 1 + Math.floor(g.rand() * 2) : 0;
  for (let s = 0; s < stages; s++) {
    lines.push(`${close} through [${g.pick(PIPELINES)}] {`);
    // A later stage may re-declare a field (the transformation) or add new ones.
    const again = new Set([...taken].filter(() => g.chance(0.5)));
    lines.push(...inlineStage(g, depth, `${indent}  `, again));
    close = `${indent}}`;
  }
  lines.push(close);
  return lines;
}

function childNode(g: Program$, name: string, depth: number, indent: string): string[] {
  const at = `${indent}  `;
  if (g.shapes.length > 0 && g.chance(0.35)) {
    const shape = g.pick(g.shapes);
    const words = g.chance(0.5) ? ` ${g.pick(WORDS)}` : '';
    if (!g.chance(0.4)) return [`${at}node ${quoteName(name)}: <${shape}>${words}`];
    const lines = [`${at}node ${quoteName(name)}: <${shape}>${words} through [${g.pick(PIPELINES)}] {`];
    lines.push(...inlineStage(g, depth, `${at}  `, new Set()));
    lines.push(`${at}}`);
    return lines;
  }
  const lines = [`${at}node ${quoteName(name)}: ${g.pick(WORDS)} {`];
  const taken = new Set<string>();
  lines.push(...inlineStage(g, depth, `${at}  `, taken));
  // A fenced child: its own first stage behind a pipeline.
  if (g.chance(0.15)) {
    lines[0] = `${at}node ${quoteName(name)}: ${g.pick(WORDS)} through [${g.pick(PIPELINES)}] {`;
  }
  lines.push(...followingStages(g, depth, at, taken, `${at}}`));
  return lines;
}

function shapeFields(g: Program$, indent: string, depth: number): string[] {
  const lines: string[] = [];
  const taken = new Set<string>();
  for (const field of distinct(g, FIELD_NAMES, 1 + Math.floor(g.rand() * 3), taken)) {
    const type = g.chance(0.6) ? g.pick(PRIMITIVES) : g.pick(['Stage', 'Flag', 'Missing', ...BORROWED.slice(0, 6)]);
    lines.push(`${indent}${quoteName(field)}: <${type}${g.chance(0.2) ? ' | null' : ''}>${g.chance(0.6) ? ` ${g.pick(WORDS)}` : ''}`);
  }
  if (depth < 2 && g.chance(0.4)) {
    const [child] = distinct(g, NODE_NAMES, 1, taken);
    if (child !== undefined) {
      lines.push(`${indent}node ${quoteName(child)}${g.chance(0.6) ? `: ${g.pick(WORDS)}` : ''} {`);
      lines.push(...shapeFields(g, `${indent}  `, depth + 1));
      lines.push(`${indent}}`);
    }
  }
  return lines;
}

/** Fields named after `Object.prototype` members: the known divergence. */
const PROTOTYPE_KEYS = [
  'import { attio } from adapters',
  'crm = attio()',
  'movement m(msg: <crm-[:company]->>) {',
  '  found = extract from [msg.`name`] {',
  '    constructor: "c"',
  '    toString: <text> "t"',
  '    name: "n"',
  '  }',
  '}',
].join('\n');

/** Two declarations extending each other, which the checker refuses. */
const CYCLE = [
  'node A extends B {',
  '  a: <text>',
  '}',
  'node B extends A {',
  '  b: <text>',
  '}',
  'movement m(msg: <crm-[:company]->>) {',
  '  found = extract from [msg.`name`] {',
  '    node e: <A>',
  '  }',
  '}',
].join('\n');

/** One seeded program: the declarations, then a movement whose first
 *  statement is the extraction. */
function seededProgram(rand: Rand, index: number): { source: string; imports: typeof ROOT_IMPORTS } {
  if (index === 0) return { source: PROTOTYPE_KEYS, imports: [] };
  if (index === 1) return { source: CYCLE, imports: [] };
  const g = new Program$(rand);
  const lines = ['import { attio } from adapters', 'crm = attio()', 'kg = attio()', 'rules = "the rules"'];
  const imports = ROOT_IMPORTS.filter(() => g.chance(0.4));
  if (imports.length > 0) {
    const byFile = new Map<string, string[]>();
    for (const i of imports) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i.local === i.name ? i.name : `${i.name} as ${i.local}`]);
    for (const [file, names] of byFile) lines.push(`import { ${names.join(', ')} } from "${file}"`);
    g.shapes.push(...imports.map((i) => i.local));
  }
  if (g.chance(0.7)) lines.push('type Stage = <"Seed" | "Series A" | "Late">');
  if (g.chance(0.4)) lines.push('type Flag = <"yes" | "no">');
  const declared = Math.floor(g.rand() * 3);
  for (let d = 0; d < declared; d++) {
    const name = `Shape${d}`;
    const roll = g.rand();
    // Extending one already declared, an imported one, a missing one, or (as
    // the last word of a cycle) one declared after it.
    const base =
      roll < 0.25 && g.shapes.length > 0 ? g.pick(g.shapes) : roll < 0.28 ? 'Nowhere' : roll < 0.3 ? `Shape${d + 1}` : undefined;
    const words = g.chance(0.6) ? `: ${g.pick(WORDS)}` : '';
    lines.push(`node ${name}${base !== undefined ? ` extends ${base}` : ''}${words} {`);
    lines.push(...shapeFields(g, '  ', 0));
    lines.push('}');
    g.shapes.push(name);
  }
  if (g.chance(0.04)) g.shapes.push('Undeclared');
  lines.push('movement m(msg: <crm-[:company]->>) {');
  const tier = g.chance(0.15) ? ` "${g.pick(['fast', 'deep'])}"` : '';
  const from = g.chance(0.2) ? ` through [${g.pick(PIPELINES)}]` : '';
  lines.push(`  found = extract${tier} from [msg.\`name\`]${from} {`);
  const taken = new Set<string>();
  lines.push(...inlineStage(g, 0, '    ', taken));
  lines.push(...followingStages(g, 0, '  ', taken, '  }'));
  lines.push('}');
  return { source: lines.join('\n'), imports };
}

function extractOf(program: Program) {
  for (const statement of program.statements) {
    if (statement.kind !== 'movement') continue;
    const first = statement.body[0];
    if (first?.kind === 'assign' && first.value.kind === 'extract') return first.value.extract;
  }
  throw new Error('no extraction');
}

// ── Regions, in tree order ───────────────────────────────────────────────────

/** Every call a materialisation of `spec` makes, numbered in tree order: the
 *  root region, then each node's continuation stages and fenced children,
 *  depth first. */
function regionsOf(spec: ExtractNodeSpec): CallSite[] {
  let counter = 0;
  const next = () => ++counter;
  const regions = [planRegion(spec, 0, true, next, { skipOwnThrough: true })];
  const walk = (node: ExtractNodeSpec) => {
    for (let s = 1; s < node.stages.length; s++) regions.push(planRegion(node, s, true, next, { skipOwnThrough: true }));
    for (const stage of node.stages) {
      for (const child of stage.children) {
        if ((child.stages[0]?.through ?? []).length > 0) regions.push(planRegion(child, 0, false, next, { skipOwnThrough: true }));
        walk(child);
      }
    }
  };
  walk(spec);
  return regions;
}

function regionJson(site: CallSite): unknown {
  return { siteId: site.siteId, node: site.spec.name, stageIndex: site.stageIndex, single: site.single, children: site.children.map(regionJson) };
}

// ── Seeded replies ───────────────────────────────────────────────────────────

const TEXTS = ['Acme', '  Acme  ', '', '   ', 'Ünïcode ✓', 'line\nbreak', 'say "hi"', 'Seed', 'seed', ' series a ', 'Series B', 'SaaS', 'saas', 'hot', 'HOT', 'Climate', 'climate', 'Other', 'x', 'none', '2026-03-12', '😀'];
const NUMBERS = [0, 1, -2.5, 1e21, 12345678.9, 0.1];
const ANY: unknown[] = [...TEXTS.slice(0, 6), ...NUMBERS, true, false, null, [], ['a', 'b'], ['SaaS', ' fintech ', 7, '', null, 'Robotics'], { a: 1 }, { quote: 'q' }];

class Replies {
  constructor(readonly rand: Rand) {}
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }
  chance(p: number): boolean {
    return this.rand() < p;
  }

  /** A value for a field, mostly of its type. */
  value(type: unknown): unknown {
    if (this.chance(0.15)) return this.pick(ANY);
    if (type === undefined) return this.pick(ANY);
    if (typeof type === 'string') {
      switch (type) {
        case 'number':
          return this.pick(NUMBERS);
        case 'boolean':
          return this.chance(0.5);
        case 'json':
          return this.pick(ANY);
        case 'absent':
          return null;
        default:
          return this.pick(TEXTS);
      }
    }
    const t = type as { kind: string; of?: unknown };
    if (t.kind === 'list') return Array.from({ length: Math.floor(this.rand() * 4) }, () => this.value(t.of));
    if (t.kind === 'maybeAbsent') return this.value(t.of);
    if (t.kind === 'enum') return this.chance(0.2) ? this.pick(NUMBERS) : this.pick(TEXTS);
    return this.pick(ANY);
  }

  evidence(): unknown {
    const roll = this.rand();
    if (roll < 0.55) return this.pick(['the source says so', '', 'Acme raised']);
    if (roll < 0.65) return null;
    if (roll < 0.75) return undefined;
    return this.pick([{ quote: 'a quote' }, { text: '  ', where: 'p2' }, { page: 2, line: 'the only string' }, ['one', 'two'], 7, [{ deep: ['x'] }], { quote: 5, note: 'n' }]);
  }

  field(type: unknown): unknown {
    const roll = this.rand();
    if (roll < 0.1) return undefined;
    if (roll < 0.15) return null;
    if (roll < 0.2) return this.value(type);
    const evidence = this.evidence();
    const wrapped: Record<string, unknown> = evidence === undefined ? { value: this.value(type) } : { evidence, value: this.value(type) };
    if (this.chance(0.05)) delete wrapped.value;
    if (this.chance(0.05)) wrapped.extra = 'kept out';
    return wrapped;
  }

  entity(site: CallSite, depth: number): unknown {
    if (this.chance(0.04)) return this.pick(['a string', 5, null, [1]]);
    const out: Record<string, unknown> = {};
    const fields = site.spec.stages[site.stageIndex].fields;
    if (this.chance(0.05)) {
      out.unrelated = 'x';
      out.other = { evidence: 'e', value: 1 };
      return out;
    }
    for (const field of fields) {
      const value = this.field(field.type);
      if (value !== undefined) out[field.name] = value;
    }
    for (const child of site.children) {
      const roll = this.rand();
      if (roll < 0.15) continue;
      if (roll < 0.2) {
        out[child.spec.name] = null;
        continue;
      }
      const list = Array.from({ length: depth > 2 ? 0 : Math.floor(this.rand() * 3) }, () => this.entity(child, depth + 1));
      out[child.spec.name] =
        roll < 0.3 ? (list[0] ?? {}) : roll < 0.38 ? { evidence: 'the list', value: list } : roll < 0.4 ? { value: list[0] ?? null } : list;
    }
    if (this.chance(0.08)) out.surplus = 'an extra key';
    return out;
  }

  /** One reply to the region, packaged one of the ways a model packages it. */
  reply(site: CallSite): unknown {
    const entities = Array.from({ length: site.single ? 1 : Math.floor(this.rand() * 3) }, () => this.entity(site, 0));
    const roll = this.rand();
    if (roll < 0.45) return { [site.siteId]: entities };
    if (roll < 0.5) return { [site.siteId]: entities, notes: 'and more' };
    if (roll < 0.55) return { [site.siteId]: { evidence: 'all of them', value: entities } };
    if (roll < 0.6) return { [site.siteId]: entities[0] ?? null };
    if (roll < 0.65) return entities[0] ?? {};
    if (roll < 0.7) return entities;
    if (roll < 0.75) return { [site.spec.name]: entities };
    if (roll < 0.78) return { [site.spec.name]: entities[0] ?? [] };
    if (roll < 0.8) return { 'x:other#9': entities, also: 1 };
    if (roll < 0.83) return {};
    if (roll < 0.85) return [];
    if (roll < 0.87) return this.pick([null, 'text', 3]);
    if (roll < 0.9) return { [site.siteId]: null };
    if (roll < 0.93) return { [site.siteId]: this.pick(['x', 5, true]) };
    return { [site.siteId]: [...entities, this.pick(['a', 3, null, []])] };
  }
}

function verdict(site: CallSite, text: string): unknown {
  const sink = new CoercionTracker();
  const reply: unknown = JSON.parse(text);
  const parsed = responseSchemaFor(site, sink).safeParse(reply);
  if (parsed.success) {
    return {
      data: JSON.parse(JSON.stringify(parsed.data)),
      coerced: Object.entries(sink.snapshot() ?? {}),
      evidenceCoerced: Object.entries(sink.evidenceSnapshot() ?? {}),
      envelope: sink.envelopeSnapshot() ?? null,
    };
  }
  // zod reads a declared key through the object's prototype: a field named
  // `constructor` that the reply leaves out is a function. The Rust engine
  // reads it absent (README, "Spec the tail").
  const prototypeKey = parsed.error.issues.some((i) => i.message.endsWith('received function'));
  return {
    ...(prototypeKey ? { divergence: 'prototype_key' } : {}),
    issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    retry: retryUserMessage('', site, parsed.error.issues),
    detail: unansweredDetail(site, reply, parsed.error),
  };
}

async function programCase(rand: Rand, index: number): Promise<unknown | undefined> {
  const { source, imports } = seededProgram(rand, index);
  let program: Program;
  try {
    program = parseProgram(source, { languageVersion: 3 });
  } catch {
    return undefined;
  }
  const rootTypes = declaredTypesIn(program);
  const rootShapes = new Map<string, ShapeAt>();
  for (const i of imports) rootShapes.set(i.local, { declaration: shapeOf(LIBRARY_PROGRAMS.get(i.file)!, i.name)!, file: i.file });
  for (const statement of program.statements) if (statement.kind === 'shape') rootShapes.set(statement.name, { declaration: statement, file: 'root' });
  const link = {
    imports: imports.map((i) => ({
      local: i.local, kind: 'shape', name: i.name, file: i.file,
      declaration: `/statements/${shapeIndex(LIBRARY_PROGRAMS.get(i.file)!, i.name)}`,
    })),
    files: LIBRARIES.map((l) => ({ path: l.path, source: l.source, imports: LIBRARY_IMPORTS.get(l.path), exports: [] })),
  };
  const extract = extractOf(program);
  let spec: ExtractNodeSpec;
  try {
    spec = await buildExtractSpec(extract, {
      resolveBorrowed: ([instance, root, field]) => {
        const schema = SCHEMAS[instance];
        return schema !== undefined ? resolveBorrowedField(schema, root, field) : undefined;
      },
      resolveDeclaredType: (name) => rootTypes.get(name),
      resolveDescription: async (slot) => describedIn('firing', slot),
      resolveDeclaredNode: (type) => {
        const shape = rootShapes.get(type);
        return shape !== undefined ? declaredNode(rootShapes, rootTypes, shape) : undefined;
      },
    });
  } catch (error) {
    return { case: index, source, link, error: error instanceof Error ? error.message : String(error) };
  }
  const replies = new Replies(rand);
  const regions = regionsOf(spec).map((site) => ({
    region: regionJson(site),
    sites: countSites(site),
    system: buildSystemPrompt(site),
    envelope: envelopeExample(site),
    replies: Array.from({ length: 6 }, () => {
      const text = JSON.stringify(replies.reply(site));
      return { reply: text, verdict: verdict(site, text) };
    }),
  }));
  return { case: index, source, link, spec, regions };
}

// ── User messages, segments ──────────────────────────────────────────────────

const CONTENTS = ['Acme raised a seed round.', '', 'line one\nline two', 'Ünïcode ✓ — “quotes”', '{"json": true}', '   '];
const CONTEXT_VALUES: unknown[] = ['Acme', '', 'say "hi"\n', 3, 0.1, 1e21, -1.5, true, null, ['a', 1, null], { nested: { deep: [1, { k: 'v' }] } }, [], {}];

function messageCase(rand: Rand): unknown {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const segments = Array.from({ length: Math.floor(rand() * 4) }, () => ({ classification: pick(['TEXT', 'FILE', 'FRAGMENT', 'deck']), content: pick(CONTENTS) }));
  let entity: Parameters<typeof renderUserMessage>[1];
  if (rand() < 0.6) {
    const context: Record<string, unknown> = {};
    for (const key of ['name', '10', 'stage', '2', 'Ünï', 'company_name'].filter(() => rand() < 0.5)) context[key] = pick(CONTEXT_VALUES);
    const enrichments = Array.from({ length: Math.floor(rand() * 3) }, () => {
      const result: { text?: string; data?: Record<string, unknown> } = {};
      if (rand() < 0.6) result.text = pick(['the page text', '', 'more\ntext']);
      if (rand() < 0.5) result.data = rand() < 0.3 ? {} : { url: 'acme.com', '3': [1, 2], deep: { a: null } };
      return { plugin: pick(['fetch_url', 'vc_url_retrieval', 'linkedin']), result };
    });
    const description = pick(['', 'each company', 'say "hi"']);
    entity = { spec: { name: 'n', description, stages: [], exported: [] }, context, enrichments };
  }
  const rendered = renderUserMessage(segments, entity);
  return {
    segments,
    ...(entity !== undefined
      ? { entity: { description: entity.spec.description, context: JSON.stringify(entity.context), enrichments: entity.enrichments.map((e) => ({ plugin: e.plugin, ...(e.result.text !== undefined ? { text: e.result.text } : {}), ...(e.result.data !== undefined ? { data: JSON.stringify(e.result.data) } : {}) })) } }
      : {}),
    text: rendered.text,
    parts: rendered.parts,
  };
}

const DATA: unknown[] = [
  'plain text', '', 5, 0.1, true, null, ['a', 'b'], { content: 'body' }, { content: 'body', type: 'EMAIL' }, { content: 'body', type: 7 },
  { content: 3 }, { type: 'X' }, {}, [], { b: 1, a: [1, { c: 'é' }], '10': 'ten', '2': 'two' }, 'Ünïcode ✓\n', 1e21,
];

// ── Priced plugins ───────────────────────────────────────────────────────────

const PLUGINS: PluginSpecs = {
  fetch_url: { args: ['url'], priced: true },
  vc_url_retrieval: { args: [], priced: true },
  free_lookup: { args: ['q'], priced: false },
};

async function pricedCase(rand: Rand): Promise<unknown> {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)];
  const spend = {
    priorMicrodollars: pick([0, 0, 40, 120]),
    capBaselineMicrodollars: pick([0, 0, 20]),
    ...(rand() < 0.85 ? { capMicrodollars: pick([50, 100, 150]) } : {}),
  };
  const charges = Array.from({ length: Math.floor(rand() * 3) }, () => ({ source: pick(['model:extract', 'plugin:fetch_url']), microdollars: pick([10, 30.5, 60]) }));
  const plugin = pick(['fetch_url', 'vc-url-retrieval', 'free_lookup', 'unknown_one', 'Fetch_url']);
  const answerCost = pick([[], [{ source: 'plugin:fetch_url', microdollars: 25 }], [{ source: 'plugin:x', microdollars: 0.4 }, { source: 'model:y', microdollars: 2 }]]);
  const ledger = new RunLedger(spend);
  ledger.charge(charges);
  const asked: unknown[] = [];
  const host = {
    llm: { transforms: { invoke: async (input: { budget: unknown }) => (asked.push(input.budget), { text: 'ok', cost: answerCost }) } },
    files: {},
  } as unknown as EngineHost;
  const calls = pricedCalls(host, { segmentId: 'g1', ledger, plugins: PLUGINS });
  let refused: unknown;
  try {
    await calls.transforms.invoke({ plugin, config: {}, extractedContext: {} });
  } catch (error) {
    const e = error as { capMicrodollars: number; spentMicrodollars: number; message: string; name: string };
    refused = { class: e.name, capMicrodollars: e.capMicrodollars, spentMicrodollars: e.spentMicrodollars, message: e.message };
  }
  return { spend, charges, plugin, answerCost, asked, ...(refused !== undefined ? { refused } : {}), account: ledger.spend };
}

export async function writeExtractionOracle(rand: Rand): Promise<void> {
  // What both sides resolve against: the live schemas and the catalog's plugins.
  const cases: unknown[] = [{ kind: 'world', schemas: SCHEMAS, plugins: PLUGINS }];
  let programs = 0;
  let replies = 0;
  for (let attempt = 0; programs < 160 && attempt < 400; attempt++) {
    const built = await programCase(rand, programs);
    if (built === undefined) continue;
    cases.push({ kind: 'program', ...(built as object) });
    programs += 1;
    for (const region of (built as { regions?: Array<{ replies: unknown[] }> }).regions ?? []) replies += region.replies.length;
  }
  for (let i = 0; i < 120; i++) cases.push({ kind: 'message', ...(messageCase(rand) as object) });
  for (const datum of DATA) {
    cases.push({
      kind: 'datum',
      datum: JSON.stringify(datum),
      segment: segmentForDatum(datum),
      ...(datum !== null && typeof datum === 'object' && !Array.isArray(datum)
        ? { asPlugin: transformResultSegments('p', { data: datum as Record<string, unknown> }) }
        : typeof datum === 'string' ? { asPlugin: transformResultSegments('p', { text: datum }) } : {}),
    });
  }
  for (let i = 0; i < 80; i++) cases.push({ kind: 'priced', ...((await pricedCase(rand)) as object) });
  // A generator that silently lost its programs would pin nothing.
  if (programs < 160 || replies < 1500) throw new Error(`extraction.json: only ${programs} programs and ${replies} replies`);
  writeFileSync(path.join(__dirname, 'extraction.json'), `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
  console.log(`extraction.json: ${programs} programs, ${replies} replies, ${cases.length} cases`);
}
