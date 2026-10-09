// The cells of the binding × consumer matrix (see
// binding_consumer_matrix.unit.test.ts for what a cell is and how one is
// judged). Pure data and string building — no engine, no jest — so the test
// file holds only the harness and the verdicts.

import type { LanguageVersion } from 'movement-lang';

// ── The records every program starts from ──────────────────────────────────

/** A record as the author would describe it: its fields and its children. */
export interface Rec {
  name: string;
  tag: string;
  child: string[];
  /** `false` for a system record the run created and never walked: what its
   *  `child` edge holds is not in hand, so a serialisation leaves the edge out
   *  rather than claim it is empty. */
  childInHand?: false;
}

export const ACME: Rec = { name: 'Acme', tag: 'a', child: ['Ann'] };
export const BETA: Rec = { name: 'Beta', tag: 'b', child: ['Bob'] };
export const GAMMA: Rec = { name: 'Gamma', tag: 'g', child: ['Gail'] };

/** A record copied by a spread into a WRITE: fields only, never nested
 *  records (Henry's ruling 2026-10-07). A spread into a GRAPH LITERAL keeps
 *  nested records too — those paths use the record as-is, child and all. */
const fieldsOnly = (rec: Rec): Rec => ({ ...rec, child: [] });

/** A system record a write created: the system gives it its children (the
 *  fake attaches `rec.child`), and the run never walked its edge to find out
 *  — so a serialisation leaves the edge out, and a walk finds the system's. */
const createdUnwalked = (rec: Rec): Rec => ({ ...rec, childInHand: false });

// ── Binding paths ───────────────────────────────────────────────────────────

/** Where the records a path binds live: on the run's own collection, or on an
 *  external system's collection. */
export type Origin = 'local' | 'system';

const WALK: Record<Origin, { bare: string; as: (alias: string) => string }> = {
  local: { bare: 'deduped-[:entries]->', as: (a) => `deduped-[${a}:entries]->` },
  // Ordered, so a fold or a pick over it is legal: an external collection has
  // no order of its own.
  system: { bare: 'src-[:companies ORDER BY name]->', as: (a) => `src-[${a}:companies ORDER BY name]->` },
};

/** Whether `write x { … }` has a record to update: the bound record sits on an
 *  edge of a graph — a system's, or one the run built, an extraction's
 *  included (`true`) — or on none (`false` — refused). */
export type OnEdge = boolean;

/**
 * How a path hands its binding to a consumer:
 *   - `each`   — the consumer's statements run once per bound record;
 *   - `reduce` — the binding is a REDUCE parameter: only a value consumer fits,
 *                and the run emits the fold of its values;
 *   - `count`  — the binding is a FILTER parameter: only a value consumer fits,
 *                and the run emits how many records the predicate kept.
 */
export type Emit = 'each' | 'reduce' | 'count';

/** What the checker's documented rules say about a path's binding, so a
 *  consumer that needs it can be expected to be refused. */
interface PathFacts {
  onEdge: OnEdge;
  /** A record traversed off an external system: the program does not hold
   *  its field list, so a consumer that needs every field is refused. */
  opaque?: true;
  /** The record's own fields are in hand, but the records reached through its
   *  edges are a system's (a system write's result): a consumer that needs
   *  every field of a CHILD is refused. Implied by `opaque`. */
  childrenOpaque?: true;
  /** The whole path is refused, whatever consumes it. */
  refusedAs?: string;
  /** The record is held under a map key, and before this version every key of
   *  a map literal may miss (version 1 typed a literal by its values alone):
   *  the record is maybe-empty, which a write updating it in place refuses. */
  keysMayMissBefore?: LanguageVersion;
}

export interface OnePath extends PathFacts {
  arity: 'one';
  id: string;
  since: LanguageVersion;
  emit: Emit;
  /** The records the binding holds, in the order the body sees them. */
  instances: Rec[];
  /** The program: `body(x)` is the consumer's lines with `x` the expression
   *  naming the bound record. */
  program(body: (x: string) => string[]): string[];
  /** For a `reduce`/`count` path: the program given a value consumer's
   *  setup lines and expression. */
  valueProgram?(pre: (x: string) => string[], expr: (x: string) => string): string[];
}

export interface ManyPath extends PathFacts {
  arity: 'many';
  id: string;
  since: LanguageVersion;
  instances: Rec[];
  /** The program: `body(xs)` is the consumer's lines with `xs` the expression
   *  naming the list. */
  program(body: (xs: string) => string[]): string[];
}

export type BindingPath = OnePath | ManyPath;

const indent = (lines: string[], by = '  '): string[] => lines.map((l) => by + l);

const EXTRACT = 'extract([msg.`text`], Entry)';

const GRAPH_HOLDER =
  'g = graph<Holder> { name: "h", entries: [' +
  '{ name: "Acme", tag: "a", child: [{ first: "Ann" }] }, ' +
  '{ name: "Beta", tag: "b", child: [{ first: "Bob" }] }] }';

function manyPaths(): ManyPath[] {
  const paths: ManyPath[] = [];
  for (const origin of ['local', 'system'] as const) {
    const walk = WALK[origin];
    const base = { arity: 'many' as const, onEdge: true, instances: [ACME, BETA], ...(origin === 'system' ? { opaque: true as const } : {}) };
    paths.push(
      { ...base, id: `${origin}: bare traversal`, since: 1, program: (body) => body(walk.bare) },
      { ...base, id: `${origin}: name = traversal`, since: 1, program: (body) => [`xs = ${walk.bare}`, ...body('xs')] },
      {
        ...base,
        id: `${origin}: block's returned records`,
        since: 1,
        program: (body) => [`xs = ${walk.as('e')} { return e }`, ...body('xs')],
      },
      {
        ...base,
        id: `${origin}: FILTER(…) result`,
        since: 1,
        program: (body) => [`xs = FILTER(${walk.bare}, (e) => { return e.name != "" })`, ...body('xs')],
      },
      {
        ...base,
        id: `${origin}: { k: list }.k`,
        since: 1,
        program: (body) => [`m = { k: ${walk.bare} }`, ...body('m.k')],
      },
    );
  }
  paths.push(
    { arity: 'many', id: 'extract(…) answer', since: 3, onEdge: true, instances: [ACME, BETA], program: (body) => [`xs = ${EXTRACT}`, ...body('xs')] },
    {
      arity: 'many',
      id: '{ entries: extract(…) }.entries',
      since: 3,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [`m = { piece: "p", entries: ${EXTRACT} }`, ...body('m.entries')],
    },
    {
      arity: 'many',
      id: 'MAP-returned { entries: extract(…) }.entries',
      since: 3,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [
        'rows = MAP(["p"], (p) => {',
        `  return { piece: p, entries: ${EXTRACT} }`,
        '})',
        'MAP(rows, (row) => {',
        ...indent(body('row.entries')),
        '})',
      ],
    },
    {
      arity: 'many',
      id: 'graph<Holder> nested walk',
      since: 3,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [GRAPH_HOLDER, ...body('g-[:entries ORDER BY name]->')],
    },
  );
  return paths;
}

/** What a pick's consumer runs under: the record is there. `ERROR` leaves the
 *  body in every version (a `return` narrows only from version 3), so the
 *  guard narrows the pick wherever the cell runs. */
const GUARD = 'if x == null { ERROR("no record") }';

/** FIRST / ONLY / AT of a plural path — a singular path of its own. */
function pickedFrom(many: ManyPath): OnePath[] {
  const [first, second] = many.instances;
  const picked = (id: string, pick: (xs: string) => string[], rec: Rec): OnePath => ({
    arity: 'one',
    id: `${id} of ${many.id}`,
    since: many.since,
    emit: 'each',
    onEdge: many.onEdge,
    ...(many.opaque !== undefined ? { opaque: many.opaque } : {}),
    instances: [rec],
    program: (body) => many.program((xs) => [...pick(xs), GUARD, ...body('x')]),
  });
  return [
    picked('FIRST', (xs) => [`x = FIRST(${xs})`], first),
    // Versions 1 and 2 refuse a closure nested in a call's argument.
    picked('ONLY', (xs) => [`kept = FILTER(${xs}, (e) => { return e.name == "${first.name}" })`, 'x = ONLY(kept)'], first),
    picked('AT', (xs) => [`x = AT(${xs}, 1)`], second),
  ];
}

function onePaths(): OnePath[] {
  const paths: OnePath[] = [];
  const each = { arity: 'one' as const, emit: 'each' as const };
  for (const origin of ['local', 'system'] as const) {
    const walk = WALK[origin];
    const opaque = origin === 'system' ? { opaque: true as const } : {};
    // A record held under a map key — one key deep, and under a nested map.
    const held = (id: string, map: string, path: string): OnePath => ({
      ...each,
      ...opaque,
      id: `${origin}: ${id}`,
      since: 1,
      onEdge: true,
      keysMayMissBefore: 2,
      instances: [ACME, BETA],
      program: (body) => [`${walk.as('e')} {`, `  m = ${map}`, ...indent(body(path)), '}'],
    });
    paths.push(held('{ k: e }.k', '{ k: e }', 'm.k'), held('{ k: { inner: e } }.k.inner', '{ k: { inner: e } }', 'm.k.inner'));
    paths.push(
      {
        ...each,
        ...opaque,
        id: `${origin}: block head alias`,
        since: 1,
        onEdge: true,
        instances: [ACME, BETA],
        program: (body) => [`${walk.as('x')} {`, ...indent(body('x')), '}'],
      },
      {
        ...each,
        ...opaque,
        id: `${origin}: block head alias, child walked`,
        since: 1,
        onEdge: true,
        instances: [ACME, BETA],
        program: (body) => [`${walk.as('x')} {`, '  kids = x-[:child]->', ...indent(body('x')), '}'],
      },
      {
        ...each,
        ...opaque,
        id: `${origin}: MAP parameter`,
        since: 1,
        onEdge: true,
        instances: [ACME, BETA],
        program: (body) => [`MAP(${walk.bare}, (x) => {`, ...indent(body('x')), '})'],
      },
      {
        arity: 'one',
        ...opaque,
        id: `${origin}: REDUCE parameter`,
        since: 1,
        emit: 'reduce',
        onEdge: true,
        instances: [ACME, BETA],
        program: () => [],
        valueProgram: (pre, expr) => [
          `folded = REDUCE(${walk.bare}, "", (acc, x) => {`,
          ...indent(pre('x')),
          `  val = ${expr('x')}`,
          '  return "${acc}[${val}]"',
          '})',
          'write sink-[:rows]-> { v: folded }',
        ],
      },
      {
        arity: 'one',
        ...opaque,
        id: `${origin}: FILTER parameter`,
        since: 1,
        emit: 'count',
        onEdge: true,
        instances: [ACME, BETA],
        program: () => [],
        valueProgram: (pre, expr) => [
          `kept = FILTER(${walk.bare}, (x) => {`,
          ...indent(pre('x')),
          `  val = ${expr('x')}`,
          '  return "${val}" != ""',
          '})',
          'write sink-[:rows]-> { v: "${COUNT(kept)}" }',
        ],
      },
    );
  }
  paths.push(
    {
      ...each,
      id: 'local: write handle',
      since: 1,
      onEdge: true,
      instances: [GAMMA],
      program: (body) => [
        'x = write deduped-[:entries]-> { name: "Gamma", tag: "g" }',
        'write x-[:child]-> { first: "Gail" }',
        ...body('x'),
      ],
    },
    {
      ...each,
      id: 'system: write handle',
      since: 1,
      onEdge: true,
      childrenOpaque: true,
      instances: [createdUnwalked(GAMMA)],
      program: (body) => ['x = write src-[:companies]-> { name: "Gamma", tag: "g" }', ...body('x')],
    },
    {
      ...each,
      id: 'graph<Holder> nested alias',
      since: 3,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [GRAPH_HOLDER, 'g-[x:entries ORDER BY name]-> {', ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'graph<Entry> root',
      since: 3,
      onEdge: false,
      instances: [ACME],
      program: (body) => ['x = graph<Entry> { name: "Acme", tag: "a", child: [{ first: "Ann" }] }', ...body('x')],
    },
    {
      ...each,
      id: 'local: MAP([e], (x) => …)',
      since: 1,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [`${WALK.local.as('e')} {`, '  MAP([e], (x) => {', ...indent(body('x'), '    '), '  })', '}'],
    },
    {
      ...each,
      id: 'local: FIRST([e])',
      since: 1,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = FIRST([e])', `  ${GUARD}`, ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'local: AT([e], 0)',
      since: 1,
      onEdge: true,
      instances: [ACME, BETA],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = AT([e], 0)', `  ${GUARD}`, ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'extractOne(…) answer',
      since: 3,
      onEdge: true,
      instances: [ACME],
      program: (body) => ['x = extractOne([msg.`text`], Entry)', GUARD, ...body('x')],
    },
    {
      ...each,
      id: 'local: write handle of { ...e }',
      since: 2,
      onEdge: true,
      instances: [fieldsOnly(ACME), fieldsOnly(BETA)],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = write copies-[:entries]-> { ...e }', ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'local: write handle of { ?...e }',
      since: 2,
      onEdge: true,
      instances: [fieldsOnly(ACME), fieldsOnly(BETA)],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = write copies-[:entries]-> { ?...e }', ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'local: graph<Entry> { ...e }',
      since: 3,
      onEdge: false,
      // Unlike a write spread, a graph-literal spread is a VALUE copy: it
      // keeps e's nested child records.
      instances: [ACME, BETA],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = graph<Entry> { ...e }', ...indent(body('x')), '}'],
    },
    {
      ...each,
      id: 'local: graph<Entry> { ?...e }',
      since: 3,
      onEdge: false,
      // The parser's own rule: a graph literal starts empty, so set-if-empty
      // is meaningless there.
      refusedAs: 'PARSE',
      instances: [fieldsOnly(ACME), fieldsOnly(BETA)],
      program: (body) => [`${WALK.local.as('e')} {`, '  x = graph<Entry> { ?...e }', ...indent(body('x')), '}'],
    },
  );
  for (const many of manyPaths()) paths.push(...pickedFrom(many));
  return paths;
}

// ── Consumers ───────────────────────────────────────────────────────────────

/** What a consumer expects a cell to do. */
export type Expectation =
  | { kind: 'value'; observed: string[] }
  /** `code` absent: the right answer is a refusal, and no code for it exists
   *  yet — any refusal passes, acceptance fails. */
  | { kind: 'refused'; code?: string; why: string };

const emit = (expr: string): string => `write sink-[:rows]-> { v: ${expr} }`;

/** A rendered sink write or effect row, as the matrix compares them. */
export const row = (fields: Record<string, unknown>): string =>
  Object.keys(fields)
    .sort()
    .map((k) => `${k}=${String(fields[k])}`)
    .join(';');

const json = (value: unknown): string => JSON.stringify(value, null, 2);
/** A record serialised: an edge the run never walked is absent, never `[]`. */
const serialised = (rec: Rec) => ({
  ...(rec.childInHand === false ? {} : { child: rec.child.map((first) => ({ first })) }),
  name: rec.name,
  tag: rec.tag,
});

interface ConsumerBase {
  id: string;
  since: LanguageVersion;
  /** Needs every field of the record: refused, with this code, over a
   *  record whose field list the program does not hold (`opaque`). */
  fieldList?: string;
  /** `fieldList` is about the records reached through the binding's edges,
   *  not the binding itself: refused over `childrenOpaque` paths too. */
  throughEdges?: true;
  /** The right answer is a refusal whatever the path. */
  refused?: { code?: string; why: string };
  /** Paired with this path alone: the consumer's verdict does not depend on
   *  how the record was bound. */
  onlyPath?: string;
}

/** A consumer that reads a VALUE off the binding — usable anywhere, including
 *  inside a REDUCE or FILTER lambda. */
export interface OneValueConsumer extends ConsumerBase {
  arity: 'one';
  form: 'value';
  pre(x: string): string[];
  expr(x: string): string;
  /** The value for one record — or, for a consumer whose right answer is a
   *  refusal, that refusal. */
  value(rec: Rec): string;
}

/** A consumer that is a STATEMENT over the binding (a write, a block head, a
 *  call) — usable only where a path runs statements per record. */
export interface OneStatementConsumer extends ConsumerBase {
  arity: 'one';
  form: 'statement';
  stmts(x: string): string[];
  /** The rows the statement leaves for one record. */
  rows(rec: Rec): string[];
  /** Whether the statement updates the record itself — so its verdict
   *  depends on the path's `onEdge`. */
  writesInPlace?: boolean;
}

export interface ManyConsumer extends ConsumerBase {
  arity: 'many';
  stmts(xs: string, recs: Rec[]): string[];
  rows(recs: Rec[]): string[];
}

export type OneConsumer = OneValueConsumer | OneStatementConsumer;
export type Consumer = OneConsumer | ManyConsumer;

const v = (value: string): string => row({ v: value });

function oneConsumers(): OneConsumer[] {
  const value = (c: Omit<OneValueConsumer, 'arity' | 'form' | 'pre'> & { pre?: OneValueConsumer['pre'] }): OneValueConsumer => ({
    arity: 'one',
    form: 'value',
    pre: () => [],
    ...c,
  });
  return [
    value({ id: 'x.f', since: 1, expr: (x) => `${x}.name`, value: (r) => r.name }),
    value({ id: '"${x.f}"', since: 1, expr: (x) => `"<\${${x}.name}>"`, value: (r) => `<${r.name}>` }),
    value({
      id: '{ ...x }',
      since: 3,
      fieldList: 'MOV_JSON_OPAQUE+MOV_MAP_SPREAD_NOT_KEYED',
      pre: (x) => [`m2 = { ...${x}, k: "1" }`],
      expr: () => '"${m2.name}/${m2.k}"',
      value: (r) => `${r.name}/1`,
    }),
    value({
      id: 'graph<Entry> { ...x }',
      since: 3,
      pre: (x) => [`g2 = graph<Entry> { ...${x} }`],
      expr: () => 'g2.name',
      value: (r) => r.name,
    }),
    value({ id: 'TEXT.PAIRS(x)', since: 2, fieldList: 'MOV_STDLIB_ARG_NOT_RECORD', expr: (x) => `TEXT.PAIRS(${x})`, value: (r) => `name=${r.name} | tag=${r.tag}` }),
    value({ id: 'TEXT.SERIALISE(x)', since: 3, fieldList: 'MOV_STDLIB_ARG_NOT_RECORD', expr: (x) => `TEXT.SERIALISE(${x}, "JSON")`, value: (r) => json(serialised(r)) }),
    // A plugin argument that takes structured data is handed every field at
    // once: the engine reads a system's record's fields one at a time, so it
    // has none to hand over.
    value({
      id: 'plugin(data: x) (json)',
      since: 1,
      fieldList: 'MOV_CALL_ARG_TYPE',
      pre: (x) => [`said = summarise(data: ${x})`],
      expr: () => 'said',
      value: (r) => r.name,
    }),
    value({
      id: 'plugin(data: { name: x.name }) (json)',
      since: 1,
      pre: (x) => [`said = summarise(data: { name: ${x}.name })`],
      expr: () => 'said',
      value: (r) => r.name,
    }),
    value({
      id: 'plugin(arg: x)',
      since: 1,
      pre: (x) => [`page = fetch_url(url: ${x})`],
      expr: () => 'COALESCE(page, "none")',
      value: () => 'page',
      refused: { code: 'MOV_CALL_ARG_TYPE', why: "a record is not the plugin's text argument" },
    }),
    {
      arity: 'one',
      form: 'statement',
      id: 'write x {…}',
      since: 1,
      writesInPlace: true,
      stmts: (x) => [`write ${x} { tag: "W-\${${x}.name}" }`],
      rows: (r) => [`update ${row({ tag: `W-${r.name}` })}`],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'write x-[:child]->',
      since: 1,
      stmts: (x) => [`write ${x}-[:child]-> { first: "K-\${${x}.name}" }`],
      rows: (r) => [`create ${row({ first: `K-${r.name}` })}`],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'x-[c:child]-> {…}',
      since: 1,
      stmts: (x) => [`${x}-[c:child]-> {`, `  ${emit('c.first')}`, '}'],
      rows: (r) => r.child.map(v),
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'movement(e: <Entry>)',
      since: 1,
      stmts: (x) => [`use_entry(e: ${x})`],
      rows: (r) => [v(r.name)],
    },
    // A function's parameter carries what its body needs of the record: one
    // that serialises it needs the fields in hand, so a system's record is
    // refused at the call, as it is by the consumer written in place.
    {
      arity: 'one',
      form: 'statement',
      id: 'movement(e: <Entry>) that reads TEXT.PAIRS(e)',
      since: 2,
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
      stmts: (x) => [`pairs_entry(e: ${x})`],
      rows: (r) => [v(`name=${r.name} | tag=${r.tag}`)],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'movement(e: <Entry>) that serialises e',
      since: 3,
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
      stmts: (x) => [`serialise_entry(e: ${x})`],
      rows: (r) => [v(json(serialised(r)))],
    },
    // A record reached through the parameter is the caller's record's child:
    // its fields are in hand exactly when the caller's are.
    {
      arity: 'one',
      form: 'statement',
      id: "movement(e: <Entry>) that walks e's child and reads a field",
      since: 1,
      stmts: (x) => [`child_entry(e: ${x})`],
      rows: (r) => r.child.map(v),
    },
    {
      arity: 'one',
      form: 'statement',
      id: "movement(e: <Entry>) that walks e's child and serialises it",
      since: 3,
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
      throughEdges: true,
      stmts: (x) => [`serialise_child(e: ${x})`],
      rows: (r) => r.child.map((first) => v(json({ first }))),
    },
    {
      arity: 'one',
      form: 'statement',
      id: "movement(e: <Entry>) that hands e to a plugin's json argument",
      since: 1,
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
      stmts: (x) => [`summarise_entry(e: ${x})`],
      rows: (r) => [v(r.name)],
    },
    // A closure bound to a name is a function (version 3): its record
    // parameter carries what its body needs, as a declared function's does.
    // `r`, not `e`: several paths already bind `e`.
    {
      arity: 'one',
      form: 'statement',
      id: 'closure (r: <Entry>) => … that reads r.name, called with x',
      since: 3,
      stmts: (x) => ['named = (r: <Entry>) => {', `  ${emit('r.name')}`, '}', `named(r: ${x})`],
      rows: (r) => [v(r.name)],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'closure (r: <Entry>) => … that serialises r, called with x',
      since: 3,
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
      stmts: (x) => ['ser_closure = (r: <Entry>) => {', `  ${emit('TEXT.SERIALISE(r, "JSON")')}`, '}', `ser_closure(r: ${x})`],
      rows: (r) => [v(json(serialised(r)))],
    },
    // A write written in place is no value a plugin can be handed, whatever
    // the binding; a `node { … }` is, to an argument that takes structured
    // data: the dict of its fields.
    {
      arity: 'one',
      form: 'statement',
      id: 'plugin(data: write copies-[:entries]-> {…}) (json)',
      since: 1,
      refused: { code: 'MOV_CALL_ARG_TYPE', why: 'a write written in place is not a value a plugin is handed' },
      stmts: (x) => [`said = summarise(data: write copies-[:entries]-> { name: ${x}.name, tag: "c" })`, emit('said')],
      rows: (r) => [v(r.name)],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'plugin(data: node {…}) (json)',
      since: 1,
      stmts: (x) => [`said = summarise(data: node { name: ${x}.name, tag: "c" })`, emit('said')],
      rows: (r) => [v(r.name)],
    },
    // An untyped plugin argument is handed what binding the argument to a name
    // would bind: a call written in place is the value it computes, a node
    // literal its fields; a write, a function or a type is refused.
    ...pluginArgForms(),
    {
      arity: 'one',
      form: 'statement',
      id: 'write { ...x }',
      since: 2,
      fieldList: 'MOV_WRITE_SPREAD_SOURCE',
      stmts: (x) => [`write sink-[:rows]-> { ...${x} }`],
      rows: (r) => [row({ name: r.name, tag: r.tag })],
    },
    {
      arity: 'one',
      form: 'statement',
      id: 'write { ?...x }',
      since: 2,
      fieldList: 'MOV_WRITE_SPREAD_SOURCE',
      stmts: (x) => [`write sink-[:rows]-> { v: "s", ?...${x} }`],
      rows: (r) => [row({ name: r.name, tag: r.tag, v: 's' })],
    },
  ];
}

/** The run-built row the plugin-argument forms are paired with. */
const RUN_BUILT_ROW = 'local: block head alias';

function pluginArgForms(): OneStatementConsumer[] {
  const form = (
    id: string,
    o: {
      since: LanguageVersion;
      arg: (x: string) => string;
      pre?: (x: string) => string[];
      rows: (rec: Rec) => string[];
      /** Why it is refused, when it is. */
      refused?: string;
    },
  ): OneStatementConsumer => ({
    arity: 'one',
    form: 'statement',
    id: `relay(data: ${id}) (untyped)`,
    since: o.since,
    onlyPath: RUN_BUILT_ROW,
    ...(o.refused !== undefined ? { refused: { code: 'MOV_CALL_ARG_TYPE', why: o.refused } } : {}),
    stmts: (x) => [...(o.pre?.(x) ?? []), `relayed = relay(data: ${o.arg(x)})`, emit('relayed')],
    rows: o.rows,
  });
  const named = (r: Rec) => [v(r.name)];
  const shouted = (r: Rec) => [v(r.name.toUpperCase())];
  return [
    form('x.name', { since: 1, arg: (x) => `${x}.name`, rows: named }),
    form('u = UPPER(x.name), u', { since: 1, pre: (x) => [`u = UPPER(${x}.name)`], arg: () => 'u', rows: shouted }),
    form('UPPER(x.name)', { since: 1, arg: (x) => `UPPER(${x}.name)`, rows: shouted }),
    form('write …', { since: 1, arg: (x) => `write copies-[:entries]-> { name: ${x}.name, tag: "c" }`, rows: named, refused: 'a write written in place is not a value a plugin is handed' }),
    // The literal's fields, as the same literal bound to a name would hand
    // over: `relay` answers the name among them.
    form('node {…}', { since: 1, arg: (x) => `node { name: ${x}.name, tag: "c" }`, rows: named }),
    form('n = node {…}, n', { since: 1, pre: (x) => [`n = node { name: ${x}.name, tag: "c" }`], arg: () => 'n', rows: named }),
    form('summarise(data: …)', { since: 1, arg: (x) => `summarise(data: { name: ${x}.name })`, rows: named }),
    form('(r) => …', { since: 3, arg: () => '(r) => { return r }', rows: named, refused: 'a function is not a value an argument carries' }),
    form('<Entry>', { since: 3, arg: () => '<Entry>', rows: named, refused: 'a type is not a value an argument carries' }),
  ];
}

// A call taking a lambda is a statement of its own, with a block-bodied
// lambda (version 1 refuses a closure nested in an expression), and a call's
// answer is bound before a field is read off it: the spelling every supported
// version parses.
function manyConsumers(): ManyConsumer[] {
  const value = (
    id: string,
    since: LanguageVersion,
    lines: (xs: string, recs: Rec[]) => { pre?: string[]; expr: string },
    out: (recs: Rec[]) => string,
  ): ManyConsumer => ({
    arity: 'many',
    id,
    since,
    stmts: (xs, recs) => {
      const { pre = [], expr } = lines(xs, recs);
      return [...pre, emit(expr)];
    },
    rows: (recs) => [v(out(recs))],
  });
  return [
    value('MAP', 1, (xs) => ({ pre: [`names = MAP(${xs}, (e) => { return e.name })`], expr: 'JOIN(names, ",")' }), (rs) => rs.map((r) => r.name).join(',')),
    value('FILTER', 1, (xs, rs) => ({ pre: [`kept2 = FILTER(${xs}, (e) => { return e.name == "${rs[1].name}" })`], expr: '"${COUNT(kept2)}"' }), () => '1'),
    value('REDUCE', 1, (xs) => ({ pre: [`folded2 = REDUCE(${xs}, "", (acc, e) => { return "\${acc}\${e.name}" })`], expr: 'folded2' }), (rs) => rs.map((r) => r.name).join('')),
    value('GROUPBY', 1, (xs, rs) => ({ pre: [`grouped = GROUPBY(${xs}, (e) => { return e.name })`], expr: `"\${COUNT(AT(grouped, "${rs[0].name}"))}"` }), () => '1'),
    value(
      'KEYBY',
      1,
      (xs, rs) => ({ pre: [`keyed = KEYBY(${xs}, (e) => { return e.name })`, `picked = AT(keyed, "${rs[1].name}")`], expr: 'COALESCE(picked.name, "none")' }),
      (rs) => rs[1].name,
    ),
    value('COUNT', 1, (xs) => ({ expr: `"\${COUNT(${xs})}"` }), (rs) => String(rs.length)),
    value('FIRST', 1, (xs) => ({ pre: [`picked = FIRST(${xs})`], expr: 'COALESCE(picked.name, "none")' }), (rs) => rs[0].name),
    value('AT', 1, (xs) => ({ pre: [`picked = AT(${xs}, 1)`], expr: 'COALESCE(picked.name, "none")' }), (rs) => rs[1].name),
    value('EXISTS', 1, (xs) => ({ expr: `"\${EXISTS(${xs})}"` }), () => 'true'),
    {
      ...value('TEXT.SERIALISE(xs)', 3, (xs) => ({ expr: `TEXT.SERIALISE(${xs}, "JSON")` }), (rs) => json(rs.map(serialised))),
      fieldList: 'MOV_STDLIB_ARG_NOT_RECORD',
    },
    // A collection op binds its function's annotated record parameter to each
    // member: one whose body serialises it needs every member's fields in
    // hand, as a declared function's call does.
    value(
      'MAP(xs, (e: <Entry>) => e.name)',
      1,
      (xs) => ({ pre: [`names3 = MAP(${xs}, (e: <Entry>) => { return e.name })`], expr: 'JOIN(names3, ",")' }),
      (rs) => rs.map((r) => r.name).join(','),
    ),
    {
      ...value(
        'MAP(xs, (e: <Entry>) => TEXT.SERIALISE(e))',
        3,
        (xs) => ({ pre: [`sers = MAP(${xs}, (e: <Entry>) => { return TEXT.SERIALISE(e, "JSON") })`], expr: 'JOIN(sers, "|")' }),
        (rs) => rs.map((r) => json(serialised(r))).join('|'),
      ),
      fieldList: 'MOV_CALL_ARG_OPAQUE_RECORD',
    },
    {
      arity: 'many',
      id: 'xs-[c:child]-> {…}',
      since: 1,
      stmts: (xs) => [`${xs}-[c:child]-> {`, `  ${emit('c.first')}`, '}'],
      rows: (rs) => rs.flatMap((r) => r.child.map(v)),
    },
  ];
}

// ── The matrix ──────────────────────────────────────────────────────────────

export interface Cell {
  path: BindingPath;
  consumer: Consumer;
  /** The movement body, one line per element, indented for the movement. */
  body: string[];
  since: LanguageVersion;
  /** What the cell must do. A cell whose right answer nobody has decided is
   *  pinned to today's outcome by the test's TRIAGE table. */
  expect: Expectation;
  /** What it must do instead under the versions before `version`. */
  expectBefore?: { version: LanguageVersion; expect: Expectation };
}

/** What a cell must do under `version`. */
export const expectationAt = (cell: Cell, version: LanguageVersion): Expectation =>
  cell.expectBefore !== undefined && version < cell.expectBefore.version ? cell.expectBefore.expect : cell.expect;

/** A version rule that changes a pairing's answer, where one does. */
function expectationBefore(path: PathFacts, consumer: Consumer): Cell['expectBefore'] {
  if (path.keysMayMissBefore === undefined || !('writesInPlace' in consumer) || consumer.writesInPlace !== true) return undefined;
  if (ruledRefusal(path, consumer) !== undefined) return undefined;
  return {
    version: path.keysMayMissBefore,
    expect: { kind: 'refused', code: 'MOV_WRITE_POSITION_NOT_RECORD', why: 'a key of a map literal may miss, so the record may be empty' },
  };
}

function oneBody(path: OnePath, consumer: OneConsumer): string[] | undefined {
  if (path.emit === 'each') {
    return path.program((x) => (consumer.form === 'value' ? [...consumer.pre(x), emit(consumer.expr(x))] : consumer.stmts(x)));
  }
  if (consumer.form !== 'value' || path.valueProgram === undefined) return undefined;
  return path.valueProgram(consumer.pre, consumer.expr);
}

/** The documented refusals: a rule of the checker that says this pairing is
 *  wrong, with the code that says so. Undefined ⇒ the pairing should run. */
function ruledRefusal(path: PathFacts, consumer: ConsumerBase): Extract<Expectation, { kind: 'refused' }> | undefined {
  if (path.refusedAs !== undefined) return { kind: 'refused', code: path.refusedAs, why: 'the path itself is refused' };
  if (consumer.refused !== undefined) return { kind: 'refused', ...consumer.refused };
  const fieldsOpaque = path.opaque === true || (consumer.throughEdges === true && path.childrenOpaque === true);
  if (fieldsOpaque && consumer.fieldList !== undefined) {
    return { kind: 'refused', code: consumer.fieldList, why: "a system record's field list is not in the program's hands" };
  }
  return undefined;
}

function oneExpectation(path: OnePath, consumer: OneConsumer): Cell['expect'] {
  const refusal = ruledRefusal(path, consumer);
  if (refusal !== undefined) return refusal;
  if (consumer.form === 'statement' && consumer.writesInPlace === true) {
    if (path.onEdge === false) return { kind: 'refused', code: 'MOV_WRITE_POSITION_NOT_RECORD', why: 'the record is on no edge' };
  }
  if (consumer.form === 'statement') {
    return { kind: 'value', observed: path.instances.flatMap((r) => consumer.rows(r)) };
  }
  switch (path.emit) {
    case 'each':
      return { kind: 'value', observed: path.instances.map((r) => v(consumer.value(r))) };
    case 'reduce':
      return { kind: 'value', observed: [v(path.instances.map((r) => `[${consumer.value(r)}]`).join(''))] };
    case 'count':
      return { kind: 'value', observed: [v(String(path.instances.length))] };
  }
}

export function cells(): Cell[] {
  const out: Cell[] = [];
  for (const path of onePaths()) {
    for (const consumer of oneConsumers()) {
      if (consumer.onlyPath !== undefined && consumer.onlyPath !== path.id) continue;
      const body = oneBody(path, consumer);
      if (body === undefined) continue;
      const before = expectationBefore(path, consumer);
      out.push({
        path,
        consumer,
        body: indent(body),
        since: Math.max(path.since, consumer.since),
        expect: oneExpectation(path, consumer),
        ...(before !== undefined ? { expectBefore: before } : {}),
      });
    }
  }
  for (const path of manyPaths()) {
    for (const consumer of manyConsumers()) {
      out.push({
        path,
        consumer,
        body: indent(path.program((xs) => consumer.stmts(xs, path.instances))),
        since: Math.max(path.since, consumer.since),
        expect: ruledRefusal(path, consumer) ?? { kind: 'value', observed: consumer.rows(path.instances) },
      });
    }
  }
  return out;
}

export const cellId = (cell: Pick<Cell, 'path' | 'consumer'>): string => `${cell.path.id} × ${cell.consumer.id}`;

