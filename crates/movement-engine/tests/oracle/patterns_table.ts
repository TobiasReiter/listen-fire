// The patterns the retirement proof covers (patterns_oracle.ts runs them):
// every reason the Rust engine's port list names (crates/movement-engine/
// README.md, "The port list"), and the reasons chunk 7A closed, each with
// the programs that exercise it. A template a reason spells with a
// placeholder (`function:<id>`) is exercised by its instances.
//
// A program is the body of `movement m(msg: <inbox-[:message]->>)` over the
// oracle's world (an inbox whose message has attachments, a CRM of two
// companies with notes, deals and people), or a whole file after the
// prelude. Each must pass the TypeScript checker, unless it says it is a
// pattern the checker itself decides (`checks: false`).

/** Where a pattern's programs end on the Rust engine: run whole, refused at
 *  admission (by every reason met), declined after the check, or a pattern
 *  no program reaches through the real shim (each program shows the
 *  nearest thing, and ends identically on both engines). */
export type Routes = 'whole' | 'refused' | 'declined' | 'unreached';

export interface Program {
  body?: string;
  file?: string;
  version?: number;
  replies?: unknown[];
  files?: Record<string, { source: string }>;
  movementName?: string;
  /** The checker refuses it, on purpose: the pattern is what it decides. */
  checks?: false;
  /** Where this program ends, when not where its pattern's do: a form of
   *  the pattern that now runs whole, or one only the checker decides. */
  routes?: Routes;
  /** The event's payload, over the world's own. */
  payload?: Record<string, unknown>;
  /** A resume of the run's park: the program runs once on the TypeScript
   *  engine to its first timer park, and both engines resume the state this
   *  makes of it (and are compared on the resume). */
  resume?: (state: Record<string, unknown>) => unknown;
  /** Its input holds what JSON cannot carry (a lone surrogate), which the
   *  recorder refuses: each engine runs it unrecorded, compared on how it
   *  ended. */
  unrecordable?: true;
}

export interface Pattern {
  reason: string;
  routes: Routes;
  /** Closed: by which task. Still refused: why, and what closing it takes. */
  note: string;
  programs: Array<(pick: Pick) => Program>;
}

export type Pick = <T>(items: readonly T[]) => T;

const NAMES = ['Acme', 'Beta', 'Gamma', 'Delta'];
const WORDS = ['why', 'who', 'what next', 'summarise'];
const STAGES = ['Seed', 'Series A', 'Series B'];

/** An entity of the scripted model's answer: a field's value with its quote. */
const said = (value: unknown, evidence = String(value)) => ({ evidence, value });

const LIBRARY = [
  'export node Deal: "each deal named" {',
  '  name: <text> "the deal\'s name"',
  '  stage: <text> "its stage"',
  '}',
].join('\n');

const COMPANY_DECL = [
  'node Company: "each company named in this message" {',
  '  name: <text> "the company\'s name"',
  '  node round: "each round it raised" {',
  '    stage: <text> "the stage"',
  '  }',
  '}',
].join('\n');

/** `state` with one more binding in its innermost scope. */
function withBinding(state: Record<string, unknown>, name: string, binding: unknown): unknown {
  const chain = Array.isArray(state.scopeChain) ? [...(state.scopeChain as unknown[])] : [];
  const inner = chain[chain.length - 1];
  if (inner !== null && typeof inner === 'object' && 'bindings' in inner) {
    const bindings = (inner as { bindings: unknown }).bindings;
    if (bindings !== null && typeof bindings === 'object') chain[chain.length - 1] = { ...inner, bindings: { ...bindings, [name]: binding } };
  }
  return { ...state, scopeChain: chain };
}

const m = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;

export const PATTERNS: Pattern[] = [
  // ── Closed in chunk 7A Task 6 ────────────────────────────────────────────
  {
    reason: 'expression:llm',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: AI() asks llm.client.call at its tier',
    programs: [
      (pick) => ({ body: `  x = AI("${pick(WORDS)}")\n  write crm-[:notes]-> { body: COALESCE(x, "none") }` }),
      (pick) => ({ body: `  p = "about \${msg.\`subject\`}"\n  write crm-[:companies]-> { unique by (\`name\`), name: "${pick(NAMES)}", summary: AI(p, "${pick(['quick', 'careful', 'thorough', 'smart'])}") }` }),
    ],
  },
  {
    reason: 'extract_tier',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: the deployment tier table is a run input (extractionTiers)',
    programs: [
      (pick) => ({
        body: `  d = extract "${pick(['quick', 'careful', 'thorough'])}" from [msg.\`text\`] {\n    name: "the company's name"\n  }\n  write crm-[:notes]-> { body: COALESCE(d.\`name\`, "none") }`,
        replies: [{ 'x:extract_result#1': [{ name: said(pick(NAMES), 'Acme Corp') }] }],
      }),
      (pick) => ({
        body: `  d = extract "${pick(['careful', 'smart'])}" from [msg.\`text\`] {\n    node co: "each company" {\n      name: "its name"\n    }\n  }\n  d-[c:co]-> {\n    write crm-[:notes]-> { body: c.\`name\` }\n  }`,
        replies: [{ 'x:extract_result#1': [{ co: [{ name: said(pick(NAMES), 'Acme Corp') }, { name: said('Beta', 'Beta Ltd') }] }] }],
      }),
    ],
  },
  {
    reason: 'meta:user_email',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: @user_* asks lookup.resolveActingUser once per segment',
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: COALESCE(@user_email, "nobody") }' }),
      (pick) => ({ body: `  who = "\${@user_name} <\${@user_email}>"\n  write crm-[:notes]-> { body: who, title: "${pick(WORDS)}" }` }),
    ],
  },
  {
    reason: 'meta:user_id',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: as meta:user_email',
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "id=${@user_id}" }' }),
      () => ({ body: '  if @user_id != null {\n    write crm-[:notes]-> { body: "${@user_id}:${@user_name}" }\n  }' }),
    ],
  },
  {
    reason: 'meta:actor_email',
    routes: 'whole',
    note: "closed in chunk 7A Task 6: @actor_* asks the source adapter's extractActor once per segment",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "${@actor_email} (${@actor_name}) ${@actor_id}" }' }),
      (pick) => ({ body: `  a = COALESCE(@actor_name, "${pick(NAMES)}")\n  write crm-[:notes]-> { body: a }` }),
    ],
  },
  {
    reason: 'function:domain_of',
    routes: 'whole',
    note: "closed in chunk 7A Task 6: a function the write field advertises (invokeFieldFunction), else the TypeScript's MOVENG_UNSUPPORTED",
    programs: [
      (pick) => ({ body: `  write crm-[:companies]-> { unique by (\`name\`), name: "${pick(NAMES)}", domain: DOMAIN_OF(msg.\`user\`) }` }),
      (pick) => ({ body: `  write crm-[:companies]-> { unique by (\`name\`), name: DOMAIN_OF("${pick(NAMES)}") }` }),
    ],
  },
  {
    reason: 'function:file',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: FILE() asks files.render',
    programs: [
      (pick) => ({ body: `  f = FILE("report on \${msg.\`subject\`}", "${pick(['pdf', 'text'])}")\n  write crm-[:notes]-> { body: COALESCE(f.name, "none") }` }),
      () => ({ body: '  items = msg-[f:files]-> {\n    return f.`filename`\n  }\n  doc = FILE(JOIN(items, ", "), "text")\n  write crm-[:notes]-> { body: doc.contentType }' }),
    ],
  },
  {
    reason: 'function:read',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: READ() asks files.resolveFileText',
    programs: [
      () => ({ body: '  t = READ(msg.`deck`)\n  write crm-[:notes]-> { body: COALESCE(t, "unread") }' }),
      () => ({ body: '  files = COLLECT(msg-[:files]->.data)\n  write crm-[:notes]-> { body: COALESCE(READ(AT(files, 1)), "unread") }' }),
    ],
  },
  {
    reason: 'expression_does_not_lower',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6 for a slot the checker refuses: the run ends at the check on either engine (a slot the checker passes is declined after it, below)',
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: CURRENCY.PARSE(msg.`text`) }', checks: false }),
      () => ({ body: '  x = TEXT.NOPE(msg.`text`)', checks: false }),
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  write crm-[:notes]-> { body: "${COUNT(held.entries)} ${FIRST(held.entries).name}" }', routes: 'declined' }),
    ],
  },
  {
    reason: 'extract_proto_field',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: the checker refuses a field or node named __proto__ (MOV_SHAPE_FIELD_PROTO), on both engines',
    programs: [
      () => ({ body: '  d = extract from [msg.`text`] {\n    __proto__: "p"\n    name: "n"\n  }', checks: false }),
      () => ({ file: `node Entry {\n  name: <text>\n  node __proto__ {\n    a: <text>\n  }\n}\n${m('  d = extract from [msg.`text`] {\n    node entry: <Entry>\n  }')}`, checks: false }),
    ],
  },
  // ── The file ─────────────────────────────────────────────────────────────
  {
    reason: 'language_version_unsupported',
    routes: 'refused',
    note: 'a pin this release does not support: refused on either engine (the TypeScript with its own message); nothing to port',
    programs: [
      () => ({ body: '  x = msg.`subject`', version: 99, checks: false }),
      () => ({ body: '  write crm-[:notes]-> { body: "x" }', version: 0, checks: false }),
    ],
  },
  {
    reason: 'import_from_file',
    routes: 'refused',
    note: "a library file's imports: needs the file scope from the check's link (imported movements and shapes, libraryShape/shapeChain) and calls into library movements",
    programs: [
      () => ({
        file: `import { Deal } from "lib/deals"\n${m('  d = extract from [msg.`text`] {\n    node deal: <Deal>\n  }\n  d-[x:deal]-> {\n    write crm-[:notes]-> { body: x.`name` }\n  }')}`,
        files: { 'lib/deals': { source: LIBRARY } },
        replies: [{ 'x:extract_result#1': [{ deal: [{ name: said('Acme'), stage: said('Seed') }] }] }],
      }),
      (pick) => ({
        file: `import { Deal } from "lib/deals"\n${m(`  d = extract from [msg.\`subject\`] {\n    node deal: <Deal> "the deal ${pick(WORDS)}"\n  }`)}`,
        files: { 'lib/deals': { source: LIBRARY } },
      }),
    ],
  },
  {
    reason: 'file_assignment',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: a file-level extraction, block, write, match or link fails the run as interpretFileStatement fails it; any other right-hand side binds nothing, and a read of it fails naming it, on either engine',
    programs: [
      () => ({ file: `r = extract from ["a fixed document"] {\n  name: "a name"\n}\n${m('  write crm-[:notes]-> { body: msg.`subject` }')}` }),
      (pick) => ({ file: `n = node { title: "${pick(NAMES)}" }\n${m('  write crm-[:notes]-> { body: n.`title` }')}` }),
    ],
  },
  {
    reason: 'file_call',
    routes: 'whole',
    note: "closed in chunk 7A Task 6: a file-level plugin or movement call fails the run with fileLevelCall's MOVENG_UNSUPPORTED, on either engine",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\npage = fetch_url(url: "https://acme.example")\n${m('  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { echo } from plugins\nsaid = echo(q: "hello")\n${m('  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
    ],
  },
  {
    reason: 'file_statement:<kind>',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: a statement at file scope (a write, an if) runs nothing, as interpretFileStatement runs nothing for it',
    programs: [
      () => ({ file: `write crm-[:notes]-> { body: "at file scope" }\n${m('  x = 1')}` }),
      () => ({ file: `if TRUE {\n  x = 1\n}\n${m('  y = 1')}` }),
    ],
  },
  {
    reason: 'movement_value_param@entry',
    routes: 'whole',
    note: "closed in chunk 7A Task 6: a movement taking a value, fired itself, fails the run in prepareMovement with the TypeScript's MOVENG_RUNTIME, before any body",
    programs: [
      () => ({ file: `movement total(n: <number[]>) {\n  return SUM(n)\n}\n${m('  x = 1')}`, movementName: 'total' }),
      () => ({ file: `movement label(names: <text[]>) {\n  return COUNT(names)\n}\n${m('  x = 1')}`, movementName: 'label' }),
    ],
  },
  {
    reason: 'movement_value_param',
    routes: 'whole',
    note: 'closed in chunk 7A Task 6: a movement taking a value that no call reaches runs only as a closure (walked as one) or never (a name the text merely mentions); as an arm the checker refuses it',
    programs: [
      () => ({ file: `movement total(n: <number[]>) {\n  return SUM(n)\n}\n${m('  r = MAP([[1, 2], [3]], total)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }')}`, movementName: 'm' }),
      () => ({ file: `movement label(names: <text[]>) {\n  return COUNT(names)\n}\n${m('  x = "label"\n  write crm-[:notes]-> { body: x }')}`, movementName: 'm' }),
    ],
  },
  {
    reason: 'name_shadowed',
    routes: 'unreached',
    note: 'a body binding a name its parameters or the file bind: the checker refuses it (MOV_SHADOWED_NAME, MOV_REBOUND_NAME) under every version this release supports, so no checked program reaches it',
    programs: [
      (pick) => ({ body: `  crm = "${pick(NAMES)}"\n  x = crm`, checks: false }),
      () => ({ body: '  msg = 1\n  y = msg', version: 1, checks: false }),
    ],
  },
  {
    reason: 'name_rebound',
    routes: 'unreached',
    note: 'one name bound twice where one binding sees the other: the checker refuses it (MOV_REBOUND_NAME, MOV_SHADOWED_NAME), so no checked program reaches it',
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  co = 1', checks: false }),
      () => ({ body: '  crm-[c:companies]-> {\n    x = 1\n  }\n  c = 1', version: 2, checks: false }),
    ],
  },
  {
    reason: 'name_not_value',
    routes: 'refused',
    note: "a through stage's plugin argument naming bare a record (the event, a handle): needs what the TypeScript hands a plugin for a binding there (the binding object)",
    programs: [
      () => ({ file: `import { echo } from plugins\n${m('  d = extract from [msg.`text`] through [echo(q: msg)] {\n    name: "a name"\n  }')}` }),
      () => ({ file: `import { echo } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  d = extract from [msg.`text`] through [echo(q: co)] {\n    name: "a name"\n  }')}` }),
    ],
  },
  {
    reason: 'plugin_arg_record',
    routes: 'refused',
    note: "a record inside a list or map reaching a plugin's argument: needs the binding objects themselves on the eval wire",
    programs: [
      () => ({ file: `import { summarise } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  said = summarise(data: [co])\n  write crm-[:notes]-> { body: said }')}` }),
      () => ({ file: `import { summarise } from plugins\n${m('  rows = crm-[c:companies]->\n  said = summarise(data: { all: rows })\n  write crm-[:notes]-> { body: said }')}` }),
    ],
  },
  {
    reason: 'builtin_arg_record',
    routes: 'unreached',
    note: 'a record reaching a reading this engine hands back (a regex, a split): the checker refuses a record handed to a text parameter (MOV_RECORD_NOT_A_VALUE), so no checked program reaches it',
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  x = TEXT.REGEX_EXTRACT(top, "x")', checks: false }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  x = SPLIT(co, ",")', checks: false }),
    ],
  },
  {
    reason: 'write_field_record',
    routes: 'refused',
    note: "a record reaching a system write's field (one typed json): needs the binding object as the TypeScript hands it to the adapter",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  write crm-[:notes]-> { body: "x", payload: { company: co } }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  write crm-[:notes]-> { body: "x", payload: { a: co, b: "x" } }' }),
    ],
  },
  {
    reason: 'extract_from_record',
    routes: 'refused',
    note: "a record in an extraction's from datum, written into the prompt as JSON.stringify writes the binding object: needs the binding object",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  d = extract from [rows] {\n    name: "a name"\n  }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  d = extract from [co] {\n    name: "a name"\n  }' }),
    ],
  },
  {
    reason: 'at_record_key',
    routes: 'refused',
    note: "AT over a record with a key that is not a text literal, or names the binding object's internals: needs those internals as values",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  key = "name"\n  a = AT(top, key)' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  a = AT(FIRST(rows), "provenance")' }),
    ],
  },
  {
    reason: 'node_spread_record',
    routes: 'refused',
    note: "a map holding a record spread into a graph, which asMapList files as a child of the binding object's keys: needs those keys",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  held = { k: co }\n  g = graph { ...held }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  held = { first: FIRST(rows) }\n  g = graph { ...held }' }),
    ],
  },

  // ── Statements and right-hand sides ──────────────────────────────────────
  {
    reason: 'statement:call',
    routes: 'refused',
    note: "a call statement of a closure or a built-in: needs the remaining call forms (closures as callees, a collection op or built-in as a statement)",
    programs: [
      (pick) => ({ body: `  note = (a: <text>) => {\n    write crm-[:notes]-> { body: a }\n  }\n  note("${pick(NAMES)}")` }),
      () => ({ body: '  shout = (t: <text>) => {\n    write crm-[:notes]-> { body: UPPER(t) }\n  }\n  shout(msg.`subject`)' }),
    ],
  },
  {
    reason: 'movement_call',
    routes: 'refused',
    note: "a call of a movement whose value is not one kind on every path, or left open by a recursion: needs the call's value kind decided at run time",
    programs: [
      () => ({ file: `function is_even(n: <number>): <boolean> {\n  if n == 0 {\n    return true\n  }\n  return is_odd(n - 1)\n}\nfunction is_odd(n: <number>): <boolean> {\n  if n == 0 {\n    return false\n  }\n  return is_even(n - 1)\n}\n${m('  a = is_even(4)\n  write crm-[:notes]-> { body: "${a}" }')}`, movementName: 'm' }),
      (pick) => ({ file: `function down(n: <number>): <number> {\n  if n <= 0 {\n    return 0\n  }\n  return down(n - 1)\n}\n${m(`  a = down(${pick([2, 3])})\n  write crm-[:notes]-> { body: "\${a}" }`)}`, movementName: 'm' }),
    ],
  },
  {
    reason: 'function_call',
    routes: 'refused',
    note: 'a bound call of a closure (or a non-movement callee): needs closures as callees',
    programs: [
      (pick) => ({ body: `  f = (n: <number>) => {\n    return n + ${pick([1, 2, 5])}\n  }\n  y = f(2)\n  write crm-[:notes]-> { body: "\${y}" }` }),
      () => ({ body: '  base = 5\n  f = (n: <number>) => n + base\n  y = f(n: 3)\n  write crm-[:notes]-> { body: "${y}" }' }),
    ],
  },
  {
    reason: 'rvalue:closure',
    routes: 'unreached',
    note: "a closure written where a value goes (a list's member, a movement call's argument): the checker refuses both (MOV_EXPR_CLOSURE_POSITION, MOV_CALL_ARG_TYPE); a closure bound to a name, held in a map, or written in a collection op runs since chunk 7A Task 3",
    programs: [
      () => ({ body: '  fs = [(v: <number>) => v + 1]\n  x = COUNT(fs)', checks: false, routes: 'unreached' }),
      () => ({ body: '  inc = (v: <number>) => v + 1\n  held = { f: inc }\n  x = 1', routes: 'whole' }),
      () => ({ file: `movement apply(e: <inbox-[:message]->>, f: <text>) {\n  return 1\n}\n${m('  r = apply(e: msg, f: (v: <text>) => UPPER(v))')}`, movementName: 'm', checks: false }),
    ],
  },
  {
    reason: 'rvalue:lazy',
    routes: 'refused',
    note: 'a lazy walk where this engine does not bind one (a `return` of one): needs the lazy-walk binding kind as a returned value (a lazy walk bound, counted or walked runs since chunk 7A Task 3)',
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  x = COUNT(people)', routes: 'whole' }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  n = COUNT(cos)\n  write crm-[:notes]-> { body: "${n}" }', routes: 'whole' }),
      () => ({ body: '  return lazy crm-[c:companies]->' }),
    ],
  },
  {
    reason: 'rvalue:inlineBlock',
    routes: 'unreached',
    note: 'the retired inline block (`{ … }.name`): the checker refuses it, so no checked program reaches it',
    programs: [
      () => ({ body: '  x = {\n    y = 1\n  }.y', checks: false }),
      () => ({ body: '  x = {\n    z = msg.`subject`\n  }.z', checks: false }),
    ],
  },
  {
    reason: 'expression_closure',
    routes: 'refused',
    note: 'a collection op written inside an expression (`{ all: MAP(xs, (x) => …) }`), which the TypeScript runs as a call bound first (from version 3): needs calls bound inside expressions (the checker’s nested_calls)',
    programs: [
      () => ({ body: '  names = { all: MAP([msg.`subject`, "beta"], (s) => UPPER(s)) }\n  write crm-[:notes]-> { body: COALESCE(AT(names.all, 1), "none") }' }),
      () => ({ body: '  if COUNT(FILTER([msg.`subject`], (s) => s != "")) > 0 {\n    write crm-[:notes]-> { body: "some" }\n  }' }),
    ],
  },
  {
    reason: 'statement:collection',
    routes: 'refused',
    note: 'a collection op statement asking a concurrency or batch other than 1 (members here run one at a time): needs bounded fan-out (fans.ts mapConcurrent), members interleaved as the TypeScript interleaves them',
    programs: [
      (pick) => ({ body: `  MAP(["a", "b", "c"], { concurrency: ${pick([2, 3])} }, (n) => {\n    write crm-[:notes]-> { body: n }\n  })` }),
      () => ({ body: '  MAP(["Acme", "Beta"], { concurrency: 2 }, (n) => {\n    write crm-[:companies]-> { unique by (`name`), name: n }\n  })' }),
    ],
  },
  {
    reason: 'rvalue:collection',
    routes: 'refused',
    note: 'as statement:collection, bound',
    programs: [
      (pick) => ({ body: `  done = MAP(["a", "b"], { concurrency: ${pick([2, 4])} }, (n) => {\n    write crm-[:notes]-> { body: n }\n    return n\n  })\n  write crm-[:notes]-> { body: "\${COUNT(done)}" }` }),
      () => ({ body: '  kept = FILTER(["a", "bb", "ccc"], { concurrency: 3 }, (n) => LENGTH(n) > 1)\n  write crm-[:notes]-> { body: "${COUNT(kept)}" }' }),
    ],
  },
  {
    reason: 'statement:refresh',
    routes: 'refused',
    note: '`refresh`: needs its semantics (no corpus program runs one)',
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  refresh co' }),
      () => ({ body: '  crm-[c:companies]-> {\n    refresh c\n  }' }),
    ],
  },
  {
    reason: 'rvalue:extractCall',
    routes: 'refused',
    note: 'the version-3 `extract(…)` call form: needs its prompt blocks (laid out for the cache), llm.client.call at its settings, site ids xc:<shape>#<n>',
    programs: [
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company)\n  MAP(found, (c) => {\n    write crm-[:notes]-> { body: c.name }\n  })')}`, replies: [{ 'xc:Company#1': [{ name: said('Acme', 'Acme Corp'), round: [] }] }] }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m(`  one = extractOne([msg.\`subject\`], Company, { tier: '${pick(['quick', 'careful'])}' })\n  write crm-[:notes]-> { body: COALESCE(one.name, "none") }`)}` }),
    ],
  },
  {
    reason: 'rvalue:<kind>',
    routes: 'refused',
    note: 'a right-hand side this engine does not bind there: a `return` of a block (its iterations returning), of an inline block; needs a returned block value (a `return` of a write runs since chunk 7A Task 3)',
    programs: [
      () => ({ body: '  return write crm-[:notes]-> { body: msg.`subject` }', routes: 'whole' }),
      () => ({ body: '  return crm-[c:companies]-> {\n    await sleep(1h)\n    return c.`name`\n  }' }),
      () => ({ body: '  return crm-[c:companies]-> {\n    return c.`name`\n  }' }),
    ],
  },
  {
    reason: 'plugin_call',
    routes: 'refused',
    note: "a plugin's call spelled in another letter case than imported (from version 3), or inside an expression (bound first by the TypeScript; such a slot does not lower here, so it declines after the check): needs any-case resolution and calls bound inside an expression (the checker's nested_calls)",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = Fetch_Url(url: msg.`text`)\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { echo } from plugins\n${m('  said = ECHO(q: msg.`subject`)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  x = { page: fetch_url(url: msg.`text`) }')}`, routes: 'declined' }),
    ],
  },
  {
    reason: 'plugin_call:records',
    routes: 'refused',
    note: 'a call of a plugin whose declared output is records: needs a records-output binding kind',
    programs: [
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`text`)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}` }),
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`subject`)\n  one = FIRST(found)\n  if one != null {\n    write crm-[:notes]-> { body: one.url }\n  }')}` }),
    ],
  },
  {
    reason: 'plugin_call_form',
    routes: 'refused',
    note: "a plugin's argument that is not a value (a built-in's or a movement's call): needs arguments of every kind, each evaluated as the TypeScript evaluates it before the invocation (a positional argument the checker refuses, MOV_PLUGIN_ARGS_NAMED)",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = fetch_url(LOWER(msg.`text`))')}`, checks: false, routes: 'unreached' }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = fetch_url(url: UPPER(msg.`text`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { fetch_url } from plugins\nmovement shout(t: <text>) {\n  return UPPER(t)\n}\n${m('  page = fetch_url(url: shout(t: msg.`text`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}`, movementName: 'm' }),
    ],
  },
  {
    reason: 'builtin_call_form',
    routes: 'refused',
    note: "a built-in's call with a named argument, an argument that is not a value (a call, a closure, a write), or no expression to read: needs the built-ins' call forms",
    programs: [
      () => ({ file: `movement mark(t: <text>) {\n  write crm-[:notes]-> { body: t }\n  return t\n}\n${m('  x = CONCAT(mark(t: "a"), mark(t: "b"))\n  write crm-[:notes]-> { body: x }')}`, movementName: 'm' }),
      () => ({ file: `movement mark(t: <text>) {\n  return UPPER(t)\n}\n${m('  x = LOWER(mark(t: msg.`subject`))\n  write crm-[:notes]-> { body: x }')}`, movementName: 'm' }),
    ],
  },

  // ── Writes, matches, links, deletes ──────────────────────────────────────
  {
    reason: 'write_bind',
    routes: 'refused',
    note: 'a write with `bind`: needs park.bindings.* (record, findBoundCounterpart, delete)',
    programs: [
      () => ({ body: '  write crm-[:companies]-> bind msg { name: "Acme" }' }),
      (pick) => ({ body: `  write crm-[:notes]-> bind msg { body: "${pick(WORDS)}" }` }),
    ],
  },
  {
    reason: 'match_tuple',
    routes: 'refused',
    note: 'a match over a tuple of paths: needs a tuple binding kind and per-slot matches',
    programs: [
      () => ({ body: '  crm-[p:people]-> {\n    found = match (crm-[:companies]->, p-[:company]->) { unique by (`name`), name: "Acme" }\n  }' }),
      (pick) => ({ body: `  crm-[p:people]-> {\n    found = match (crm-[:companies]->, p-[:company]->) { unique by (\`name\`), name: "${pick(NAMES)}" }\n  }` }),
    ],
  },
  {
    reason: 'match_position',
    routes: 'unreached',
    note: "a match of a bare alias: the parser refuses it ('c' is already a record — a match finds one), so no program reaches it",
    programs: [
      () => ({ body: '  crm-[c:companies]-> {\n    found = match c { unique by (`name`), name: "Acme" }\n  }', checks: false }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  found = match co { unique by (`name`), name: "Acme" }', checks: false }),
    ],
  },
  {
    reason: 'write_position_not_record',
    routes: 'unreached',
    note: "`write x { … }` where x is not a record: the checker refuses a node (MOV_WRITE_POSITION_NOT_RECORD); what a node's edge holds runs since chunk 7A Task 2",
    programs: [
      () => ({ body: '  d = node { name: "a" }\n  write d { name: "b" }', checks: false }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  e = write d-[:entries]-> { name: "a" }\n  write e { name: "b" }')}`, routes: 'whole' }),
    ],
  },
  {
    reason: 'delete_not_record',
    routes: 'refused',
    note: "`delete x` where x is not a write's handle or a hop alias (what a node's edge holds): needs a delete of what a node's edge holds",
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  g-[f:files]-> {\n    delete f\n  }' }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  e = write d-[:entries]-> { name: "a" }\n  delete e')}` }),
    ],
  },
  {
    reason: 'write_position_member_path',
    routes: 'refused',
    note: '`write m.k { … }`: a write from the record a map’s member holds; needs a member-path record binding',
    programs: [
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    write held.k { stage: "seen" }\n  }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  held = { k: co }\n  write held.k { stage: "seen" }' }),
    ],
  },
  {
    reason: 'write_root_expression',
    routes: 'refused',
    note: "a linked write rooted at a map member's record (`write held.k-[:notes]-> { … }`): needs the TypeScript's root resolution (a root written as an expression the parser refuses)",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  write AT(rows, 0)-[:notes]-> { body: "x" }', checks: false, routes: 'unreached' }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    write held.k-[:notes]-> { body: "x" }\n  }' }),
    ],
  },
  {
    reason: 'match_root_expression',
    routes: 'refused',
    note: "a linked match rooted at a map member's record: as write_root_expression",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  found = match AT(rows, 0)-[:notes]-> { unique by (`body`), body: "x" }', checks: false, routes: 'unreached' }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    found = match held.k-[:notes]-> { unique by (`body`), body: "x" }\n  }' }),
    ],
  },
  {
    reason: 'write_root_not_held',
    routes: 'refused',
    note: "a linked write rooted at a shape the file declares (`write Note-[:item]-> { … }`): needs the TypeScript's root resolution",
    programs: [
      () => ({ file: `node Note {\n  title: <text>\n}\nmovement persist(n: <Note>) {\n  write crm-[:notes]-> { body: n.\`title\` }\n}\n${m('  persist(n: write Note-[:item]-> { title: msg.`subject` })')}`, movementName: 'm' }),
      (pick) => ({ file: `node Note {\n  title: <text>\n}\nmovement persist(n: <Note>) {\n  write crm-[:notes]-> { body: n.\`title\` }\n}\n${m(`  persist(n: write Note-[:item]-> { title: "${pick(NAMES)}" })`)}`, movementName: 'm' }),
    ],
  },
  {
    reason: 'match_root_not_held',
    routes: 'unreached',
    note: 'a linked match rooted at a declared shape: the checker refuses it (MOV_LINKED_UNKNOWN_EDGE: the shape itself has no edge), so no checked program reaches it',
    programs: [
      () => ({ file: `node Note {\n  title: <text>\n}\n${m('  found = match Note-[:item]-> { title: "x" }')}`, checks: false }),
      () => ({ file: `node Note {\n  title: <text>\n}\n${m('  found = match Note-[:item]-> { title: msg.`subject` }')}`, checks: false }),
    ],
  },
  {
    reason: 'write_multi_hop',
    routes: 'refused',
    note: "a linked write walking more than one edge: needs the TypeScript's multi-hop semantics",
    programs: [
      () => ({ body: '  write crm-[:companies]->-[:notes]-> { body: "x" }' }),
      () => ({ body: '  write crm-[:companies]->-[:notes]-> { body: msg.`subject`, title: "t" }' }),
    ],
  },
  {
    reason: 'match_multi_hop',
    routes: 'refused',
    note: 'a linked match walking more than one edge: as write_multi_hop',
    programs: [
      () => ({ body: '  found = match crm-[:companies]->-[:notes]-> { unique by (`body`), body: "x" }' }),
      () => ({ body: '  found = match crm-[:companies]->-[:notes]-> { unique by (`body`), body: msg.`subject` }' }),
    ],
  },
  {
    reason: 'write_spread_path',
    routes: 'whole',
    note: '`...m.k` in a write: a member the checker lets through (an extraction’s record) runs whole on Rust; one it does not spell out the checker refuses (MOV_WRITE_SPREAD_SOURCE); the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ body: '  d = extract from [msg.`text`] {\n    body: "a body"\n  }\n  held = { k: d }\n  write crm-[:notes]-> { ...held.k }', replies: [{ 'x:extract_result#1': [{ body: { evidence: 'Acme', value: 'Acme' } }] }] }),
      () => ({ body: '  d = extract from [msg.`text`] {\n    body: "a body"\n  }\n  held = { k: d }\n  write crm-[:notes]-> { ...held.k, title: "t" }' }),
    ],
  },
  {
    reason: 'node_spread',
    routes: 'unreached',
    note: 'a spread in a `node { … }` literal: the parser refuses it (an entry name is expected), so no program reaches it',
    programs: [
      () => ({ body: '  held = { a: 1 }\n  n = node { ...held }', checks: false }),
      () => ({ body: '  held = { title: msg.`subject` }\n  n = node { ...held, extra: 1 }', checks: false }),
    ],
  },
  {
    reason: 'node_spread_path',
    routes: 'refused',
    note: '`...m.k` in a graph literal: needs spreads of map members',
    programs: [
      () => ({ body: '  held = { k: { name: "a" } }\n  g = graph { ...held.k }' }),
      () => ({ body: '  held = { k: { name: msg.`subject` } }\n  g = graph { ...held.k, extra: 1 }' }),
    ],
  },
  {
    reason: 'node_spread_source',
    routes: 'refused',
    note: "a graph spread of the event: needs spreads of the event's record (a spread of a block's landing runs since chunk 7A Task 3)",
    programs: [
      () => ({ body: '  g = graph { ...msg }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    g = graph { ...c }\n  }', routes: 'whole' }),
    ],
  },
  {
    reason: 'unique_by_without_key',
    routes: 'unreached',
    note: "a `unique by` with no key: the checker refuses it (MOV_UNIQUE_CONJUNCT_NEEDS_WHERE), so no checked program reaches it",
    programs: [
      () => ({ body: '  write crm-[:companies]-> { unique by (`name` CONTAINS "a"), name: "Acme" }', checks: false }),
      () => ({ body: '  found = match crm-[:companies]-> { unique by (`employees` > 3), name: "Acme" }', checks: false }),
    ],
  },
  {
    reason: 'unique_by_reads_beyond_candidate',
    routes: 'unreached',
    note: "a `unique by` conjunct reading beyond the candidate: the checker refuses it (MOV_UNIQUE_CONJUNCT_NEEDS_WHERE), so no checked program reaches it",
    programs: [
      () => ({ body: '  write crm-[:companies]-> { unique by (`name`, EXISTS(msg-[:files]->)), name: "Acme" }', checks: false }),
      () => ({ body: '  write crm-[:companies]-> { unique by (`name`, AI("same?") == "yes"), name: "Beta" }', checks: false }),
    ],
  },

  // ── Nodes and graphs ─────────────────────────────────────────────────────
  {
    reason: 'node_declared_entry',
    routes: 'unreached',
    note: 'a declared edge entry inside a graph literal: the parser refuses one (both parsers), so no program reaches it',
    programs: [
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  g = graph { entries: <Entry> }')}`, checks: false }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  g = graph { title: "t", entries: <Entry> }')}`, checks: false }),
    ],
  },
  {
    reason: 'node_event_entry',
    routes: 'refused',
    note: 'a graph entry holding the event: needs an entry holding the event',
    programs: [
      () => ({ body: '  g = graph { owner: msg }' }),
      () => ({ body: '  g = graph { title: "t", source: msg }' }),
    ],
  },
  {
    reason: 'rvalue:node',
    routes: 'whole',
    note: "a node a block's iteration returns: the forms tried run whole on Rust (chunk 7A Task 2/3); the reason stays in admission for a form no checked program here reaches",
    programs: [
      () => ({ body: '  made = crm-[c:companies]-> {\n    return node { name: c.`name` }\n  }' }),
      () => ({ body: '  made = msg-[f:files]-> {\n    return node { file: f.`filename` }\n  }' }),
    ],
  },
  {
    reason: 'exists_node',
    routes: 'whole',
    note: 'EXISTS off a run-built node of more than one hop or with an ORDER BY: the forms tried run whole on Rust; the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ file: `node Co {\n  name: <text>\n  node founder {\n    first: <text>\n  }\n}\n${m('  d = node { cos: <Co> }\n  if EXISTS(d-[:cos]->-[:founder]->) {\n    x = 1\n  }')}` }),
      () => ({ file: `node Co {\n  name: <text>\n}\n${m('  d = node { cos: <Co> }\n  if EXISTS(d-[c:cos ORDER BY `name`]->) {\n    x = 1\n  }')}` }),
    ],
  },
  {
    reason: 'is_test_declared_record',
    routes: 'whole',
    note: "closed in chunk 7A Task 6 by a check.compatible request (the checker's assignability over the record type's schema, which stays TypeScript with the checker; porting it would fork the type system)",
    programs: [
      () => ({ file: `node Shape {\n  subject: <text>\n}\n${m('  if msg IS <Shape> {\n    write crm-[:notes]-> { body: "fits" }\n  }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  crm-[c:companies]-> {\n    if c IS <Lead> {\n      write crm-[:notes]-> { body: c.`name` }\n    }\n  }')}` }),
    ],
  },
  {
    reason: 'is_test_declared_graph',
    routes: 'refused',
    note: '`x IS <Decl>` on a `graph { … }` literal: as is_test_declared_record',
    programs: [
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph { name: "a" }\n  if g IS <Lead> {\n    x = 1\n  }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph { name: msg.`subject` }\n  if g IS <Lead> {\n    write crm-[:notes]-> { body: "lead" }\n  }')}` }),
    ],
  },

  // ── Traversal blocks and heads ───────────────────────────────────────────
  {
    reason: 'block_head_expression_root',
    routes: 'whole',
    note: 'a block head rooted at an expression: the forms tried (`AT(rows, 0)-[…]->`, `FIRST(rows)-[…]->`) run whole on Rust; the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  AT(rows, 0)-[n:notes]-> {\n    write crm-[:notes]-> { body: n.`body` }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  FIRST(rows)-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
    ],
  },
  {
    reason: 'block_head_value_root',
    routes: 'refused',
    note: 'a block head rooted at a kept (lazy) walk: needs heads rooted at every binding kind (one off a value holding records runs since chunk 7A Task 3)',
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  people-[c:company]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  rows-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }', routes: 'whole' }),
    ],
  },
  {
    reason: 'block_multi_hop',
    routes: 'refused',
    note: 'a block head of more than one hop: needs multi-hop walks',
    programs: [
      () => ({ body: '  crm-[c:companies]->-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
      () => ({ body: '  crm-[:companies]->-[:deals]->-[p:people]-> {\n    write crm-[:notes]-> { body: p.`name` }\n  }' }),
    ],
  },
  {
    reason: 'block_head_extract_hop',
    routes: 'refused',
    note: "a head over an extraction's records with a WHERE (the TypeScript refuses it), an ORDER BY or a LIMIT: needs the TypeScript's refusal and readings there",
    programs: [
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  found-[c:co WHERE `name` == "x"]-> {\n    x = c.`name`\n  }' }),
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  found-[c:co LIMIT 1]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }' }),
    ],
  },
  {
    reason: 'block_head_resources',
    routes: 'refused',
    note: 'a `_resources` head (off the event or an extraction): needs resource descriptors (FileRef) crossing as the descriptor',
    programs: [
      () => ({ body: '  found = extract from [msg.`text`] {\n    name: "a"\n  }\n  found-[f:_resources]-> {\n    write crm-[:notes]-> { body: "a file" }\n  }' }),
      () => ({ body: '  msg-[f:_resources]-> {\n    write crm-[:notes]-> { body: "a file" }\n  }' }),
    ],
  },
  {
    reason: 'traversal_meta_edge',
    routes: 'refused',
    note: "a hop over a `#` edge (the engine's own meta references): needs the meta-edge walks over run-built accumulants and the read wrapper's pass-through without restamping (kg.ts)",
    programs: [
      () => ({ body: '  crm-[b:bags]-> {\n    x = FIRST(b-[:#foo]->)\n  }' }),
      () => ({ body: '  crm-[b:bags]-> {\n    b-[:#foo]-> {\n      y = 1\n    }\n  }' }),
    ],
  },
  {
    reason: 'select_multi_hop',
    routes: 'refused',
    note: '`x = FIRST(…)` of a walk of more than one hop: needs the full walk evaluator',
    programs: [
      () => ({ body: '  x = FIRST(crm-[:companies]->-[d:deals ORDER BY `title`]->)' }),
      () => ({ body: '  x = LAST(crm-[:companies]->-[n:notes ORDER BY `body`]->)' }),
    ],
  },
  {
    reason: 'traversal_step',
    routes: 'unreached',
    note: 'a walk with a hop that is not an edge (`#transform`): the checker refuses the retired hop (MOV_TRANSFORM_HOP_RETIRED), so no checked program reaches it',
    programs: [
      () => ({ body: '  x = msg-[:files]->-[#transform]->.`name`', checks: false }),
      () => ({ body: '  x = COUNT(msg-[:files]->-[#transform]->)', checks: false }),
    ],
  },
  {
    reason: 'exists_step',
    routes: 'unreached',
    note: 'an EXISTS hop that is not an edge: as traversal_step, the checker refuses it',
    programs: [
      () => ({ body: '  if EXISTS(msg-[:files]->-[#transform]->) {\n    x = 1\n  }', checks: false }),
      () => ({ body: '  y = EXISTS(msg-[:files]->-[#transform]->)', checks: false }),
    ],
  },
  {
    reason: 'walk_extract_hop',
    routes: 'refused',
    note: "a hop down an extraction with a WHERE: needs the TypeScript's refusal there",
    programs: [
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  x = found-[c:co WHERE c.`name` == "x"]->.`name`' }),
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  x = COUNT(found-[c:co WHERE c.`name` != ""]->)' }),
    ],
  },
  {
    reason: 'exists_extract_hop',
    routes: 'refused',
    note: "EXISTS down an extraction with an ORDER BY or a LIMIT: needs EXISTS's readings there",
    programs: [
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  if EXISTS(found-[c:co ORDER BY `name`]->) {\n    x = 1\n  }' }),
      () => ({ body: '  found = extract from [msg.`text`] {\n    node co: "c" {\n      name: "a"\n    }\n  }\n  if EXISTS(found-[c:co LIMIT 1]->) {\n    x = 1\n  }' }),
    ],
  },

  // ── Expressions ──────────────────────────────────────────────────────────
  {
    reason: 'aggregate:llm',
    routes: 'unreached',
    note: "the `LLM_AGG` fold: the checker refuses it (MOV_BUILTIN_NOT_RUN: neither engine runs it), so no checked program reaches it",
    programs: [
      () => ({ body: '  x = LLM_AGG(["a", "b"], "summarise them")', checks: false }),
      () => ({ body: '  x = LLM_AGG(crm-[c:companies]->.`name`, "the best")', checks: false }),
    ],
  },
  {
    reason: 'aggregate:only',
    routes: 'whole',
    note: "closed in chunk 7A Task 6: ONLY of any expression its failure spells back (crate::formula, the formula grammar's serialize), its more-than-one failure naming it as the TypeScript does; a resource walk stays refused",
    programs: [
      () => ({ body: '  x = ONLY(crm-[c:companies WHERE `name` == "Acme"]->.`stage`)\n  write crm-[:notes]-> { body: COALESCE(x, "none") }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    x = ONLY(c-[:deals]->.`title`)\n  }' }),
      () => ({ body: '  x = ONLY(crm-[c:companies WHERE `stage` != "x" AND `employees` > 3 ORDER BY `name` DESC LIMIT 5]->.`name`)' }),
      () => ({ body: '  x = ONLY([1, "a b", null, 2.5, msg.`subject`])' }),
      () => ({ body: '  x = ONLY(crm-[c:companies]->.`name`)\n  write crm-[:notes]-> { body: COALESCE(x, "none") }' }),
    ],
  },
  {
    reason: 'aggregate:sort_key',
    routes: 'refused',
    note: '`SORT(xs, key)` whose key is not a field name (over records): needs record sorts by an expression (a key over plain values the checker refuses, MOV_SORT_KEY_ON_SCALAR)',
    programs: [
      () => ({ body: '  x = SORT(["b", "a"], UPPER("a"))', checks: false, routes: 'unreached' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = SORT(rows, LOWER(`name`))' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = SORT(rows, LENGTH(`stage`))' }),
    ],
  },
  {
    reason: 'aggregate_records',
    routes: 'whole',
    note: 'a fold of a bare walk inside a list or map: the forms tried run whole on Rust; the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ body: '  x = [FIRST(crm-[c:companies ORDER BY `name`]->)]' }),
      () => ({ body: '  x = { top: LAST(crm-[c:companies ORDER BY `name`]->) }' }),
    ],
  },
  {
    reason: 'expression:<type>',
    routes: 'refused',
    note: 'an expression kind that needs the host: the retired KG_VALUE / KG_EXISTS (the checker passes them; the TypeScript fails the run), needs mirroring that failure; a `_resources` read in an expression the checker refuses (MOV_RESOURCE_WALK_UNREAD)',
    programs: [
      () => ({ body: '  x = COLLECT(msg-[:_resources]->.`name`)', checks: false, routes: 'unreached' }),
      () => ({ body: '  found = extract from [msg.`text`] {\n    name: "a"\n  }\n  x = COLLECT(found-[:_resources]->.`name`)', checks: false, routes: 'unreached' }),
      () => ({ body: '  x = KG_VALUE("MATCH (n) RETURN n")' }),
      () => ({ body: '  if KG_EXISTS("MATCH (n) RETURN n") {\n    x = 1\n  }' }),
    ],
  },
  {
    reason: 'expression:exists',
    routes: 'refused',
    note: 'a rootless `EXISTS(-[…]->)` outside a WHERE: the TypeScript fails it (MOVENG_UNSUPPORTED, rootless EXISTS()); closing it is mirroring that error',
    programs: [
      () => ({ body: '  x = EXISTS(-[:notes]->)' }),
      () => ({ body: '  if EXISTS(-[:deals]->) {\n    x = 1\n  }' }),
    ],
  },
  {
    reason: 'meta:<key>',
    routes: 'unreached',
    note: "a key of the dispatch's bag (`@trigger`, `@mutationContext`): the checker refuses an unknown `@` key, so no checked program reaches it",
    programs: [
      () => ({ body: '  x = @trigger', checks: false }),
      () => ({ body: '  x = @mutationContext', checks: false }),
    ],
  },
  {
    reason: 'function:<id>',
    routes: 'refused',
    note: 'CHUNKS, a namespaced member this engine lacks, or a function, movement or closure called inside an expression (bound first by the TypeScript, the checker’s nested_calls): needs CHUNKS ported and calls bound inside expressions',
    programs: [
      (pick) => ({ body: `  pieces = CHUNKS("aaaa bbbb cccc dddd eeee ffff", { size: ${pick([8, 12])} })\n  write crm-[:notes]-> { body: "\${COUNT(pieces)}" }` }),
      () => ({ file: `function double(n: <number>): <number> {\n  return n * 2\n}\n${m('  write crm-[:notes]-> { body: "${double(3) + 1}" }')}`, movementName: 'm' }),
    ],
  },
  {
    reason: 'within_compare',
    routes: 'refused',
    note: '`WITHIN` in an expression: needs WITHIN against the clock (the shared comparator answers it for a unique by today)',
    programs: [
      () => ({ body: '  x = msg.`subject` WITHIN "7d"' }),
      () => ({ body: '  if "2025-12-30" WITHIN "7d" {\n    write crm-[:notes]-> { body: "recent" }\n  }' }),
    ],
  },
  {
    reason: 'static_number',
    routes: 'refused',
    note: 'a numeric literal JSON cannot carry: `-0` (the lowering folds the negation into a literal); needs the wire carrying it (transition artefacts row 12); no literal reads as Infinity (`1e400` does not parse)',
    programs: [
      () => ({ body: '  x = -0\n  write crm-[:notes]-> { body: "${x}" }', routes: 'refused' }),
      () => ({ body: '  x = 1e400', checks: false, routes: 'unreached' }),
    ],
  },
  {
    reason: 'proto_key',
    routes: 'refused',
    note: 'a `__proto__` key written in an object literal: needs the wire carrying it (transition artefacts row 12)',
    programs: [
      () => ({ body: '  x = { __proto__: 1 }' }),
      () => ({ body: '  x = { a: 1, __proto__: { b: 2 } }\n  write crm-[:notes]-> { body: "x", payload: x }' }),
    ],
  },

  // ── The rest of the file, heads and walks ────────────────────────────────
  {
    reason: 'import_from_<namespace>',
    routes: 'unreached',
    note: 'an import from a namespace other than adapters, credentials and plugins: the checker refuses it, so no checked program reaches it',
    programs: [
      () => ({ file: `import { thing } from builtins\n${m('  x = 1')}`, checks: false }),
      () => ({ file: `import { other } from somewhere\n${m('  x = 1')}`, checks: false }),
    ],
  },
  {
    reason: 'block_head_rootless',
    routes: 'refused',
    note: 'a block head with no root (the checker passes it): needs the TypeScript’s reading of a rootless head',
    programs: [
      () => ({ body: '  -[c:companies]-> {\n    x = 1\n  }' }),
      () => ({ body: '  -[n:notes]-> {\n    y = 1\n  }' }),
    ],
  },
  {
    reason: 'block_head_root',
    routes: 'unreached',
    note: "a block head rooted at a name no record is held under (a plain value, a plugin, a shape): the checker refuses it, so no checked program reaches it",
    programs: [
      () => ({ body: '  x = 1\n  x-[c:companies]-> {\n    y = 1\n  }', checks: false }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  Lead-[c:companies]-> {\n    y = 1\n  }')}`, checks: false }),
    ],
  },
  {
    reason: 'block_head_step',
    routes: 'unreached',
    note: "a block head whose hop is not an edge (`#transform`): the checker refuses the retired hop, so no checked program reaches it",
    programs: [
      () => ({ body: '  msg-[t:#transform]-> {\n    y = 1\n  }', checks: false }),
      () => ({ body: '  msg-[:files]->-[t:#transform]-> {\n    y = 1\n  }', checks: false }),
    ],
  },
  {
    reason: 'traversal_root',
    routes: 'refused',
    note: 'a walk rooted at a name not held as its root (a hop off a kept walk): needs the full walk evaluator (a field read off a kept walk runs)',
    programs: [
      () => ({ body: '  files = lazy msg-[a:files]->\n  x = COLLECT(files.`filename`)', routes: 'whole' }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  x = COUNT(cos-[:deals]->)' }),
    ],
  },
  {
    reason: 'traversal_steps',
    routes: 'whole',
    note: 'a field read off a held name that also walks hops: the forms tried run whole on Rust; the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  x = COLLECT(rows-[:deals]->.`title`)' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = COUNT(rows-[:notes]->)' }),
    ],
  },
  {
    reason: 'traversal_terminal',
    routes: 'whole',
    note: 'a walk ending in anything but a field: the forms tried run whole on Rust; the reason stays in admission for a form no checked program here reaches',
    programs: [
      () => ({ body: '  x = COUNT(crm-[c:companies]->-[:notes]->)' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  x = COUNT(co-[:deals]->-[:people]->)' }),
    ],
  },

  // ── A parked state ───────────────────────────────────────────────────────
  {
    reason: 'resume_state_does_not_read',
    routes: 'unreached',
    note: 'a parked state that does not read off the eval wire: every state a JSON host hands back reads, so none reaches it through the real shim; a state an engine parked resumes on Rust (these programs, parked by the TypeScript engine)',
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => state, routes: 'whole' }),
      () => ({ body: '  x = msg.`subject`\n  await sleep(1h)\n  write crm-[:notes]-> { body: x }', resume: (state) => state, routes: 'whole' }),
    ],
  },
  {
    reason: 'resume_state_version',
    routes: 'unreached',
    note: 'a parked state of a version other than 1: both entries refuse it before routing (refuseUnsupportedParkStateVersion), on either engine',
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => ({ ...state, version: 2 }), routes: 'whole' }),
      () => ({ body: '  await sleep(1h)\n  x = 1', resume: (state) => ({ ...state, version: 0 }), routes: 'whole' }),
    ],
  },
  {
    reason: 'resume_state_suspended',
    routes: 'refused',
    note: 'a parked state whose `suspended` is not true: refused on resume',
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => ({ ...state, suspended: false }) }),
      () => ({ body: '  await sleep(1h)\n  x = 1', resume: (state) => ({ ...state, suspended: 'yes' }) }),
    ],
  },
  {
    reason: 'resume_state_kind:localShape',
    routes: 'refused',
    note: 'a parked state holding a shape declared in a body: needs its rehydration (serialize.ts rehydrate)',
    programs: [
      () => ({ body: '  node Note {\n    title: <text>\n  }\n  await sleep(1h)\n  d = extract from [msg.`text`] {\n    node note: <Note>\n  }' }),
      () => ({ body: '  node Tag {\n    label: <text>\n  }\n  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }' }),
    ].map((make) => (pick: Pick) => ({ ...make(), resume: (state: Record<string, unknown>) => state })),
  },
  {
    reason: 'resume_state_kind:blockMeta',
    routes: 'refused',
    note: "a parked state holding a block's meta edges bound as a name: needs its rehydration (serialize.ts rehydrate); no program parks holding one, so the state is made",
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => withBinding(state, 'meta', { kind: 'blockMeta', edges: [] }) }),
      () => ({ body: '  await sleep(1h)\n  x = 1', resume: (state) => withBinding(state, 'm2', { kind: 'blockMeta', edges: [] }) }),
    ],
  },

  // ── The shim's input checks, and after the check ─────────────────────────
  {
    reason: 'event_does_not_cross',
    routes: 'refused',
    note: 'an event, source or parked state the eval wire cannot carry as itself (a lone surrogate): needs a lone surrogate on the wire (transition artefacts row 9)',
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: COALESCE(msg.`text`, "none") }', payload: { text: 'half a pair \uD83D' }, unrecordable: true }),
      () => ({ body: '  x = "\uDC00"\n  write crm-[:notes]-> { body: x }', unrecordable: true }),
    ],
  },
  {
    reason: 'event_field_dated',
    routes: 'declined',
    note: "the program reads an event field the source's schema types as a date: an adapter may answer it as a Date, which no value of this engine is; needs a Date on the wire (or a ruling that adapters never answer one)",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "${msg.`sent`}" }', payload: { sent: '2026-01-01T09:00:00.000Z' } }),
      () => ({ body: '  if msg.`sent` != null {\n    write crm-[:notes]-> { body: "dated" }\n  }', payload: { sent: '2026-01-01T09:00:00.000Z' } }),
    ],
  },
  ...(['catalog_does_not_load', 'event_does_not_read', 'instant_does_not_read', 'local_zone_does_not_read', 'check_answer_malformed'] as const).map(
    (reason): Pattern => ({
      reason,
      routes: 'unreached',
      note: 'a shim fault in all but name: the real shim always sends an input that reads (its catalog, event, instant and zone) and a check answer that reads, so no program reaches it through the real shim; pinned by the crate’s unit tests',
      programs: [
        () => ({ body: '  write crm-[:notes]-> { body: msg.`subject` }', routes: 'whole' }),
        (pick) => ({ body: `  x = "${pick(NAMES)}"\n  write crm-[:notes]-> { body: x }`, routes: 'whole' }),
      ],
    }),
  ),
  {
    reason: 'source_does_not_parse',
    routes: 'unreached',
    note: "a source this engine's parser refuses and the checker passes: none is known (a graph literal's fill spread both parsers refuse), so no checked program reaches it",
    programs: [
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  g = graph<Entry> { ?...msg }')}`, checks: false }),
      () => ({ body: '  x = ((1)', checks: false }),
    ],
  },
  {
    reason: 'condition_does_not_lower',
    routes: 'declined',
    note: "a condition this engine's lowering misses and the checker passes (a field read off a fold's answer): declined after the check; needs the lowering's coverage",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  if FIRST(held.entries).name == "Acme" {\n    write crm-[:notes]-> { body: "acme" }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  if LAST(held.entries).name != "" {\n    x = 1\n  }' }),
    ],
  },
  {
    reason: 'block_head_does_not_lower',
    routes: 'unreached',
    note: "a block head this engine's probe cannot read: none is known for a checked program",
    programs: [
      () => ({ body: '  crm-[c:companies]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }', routes: 'whole' }),
      () => ({ body: '  msg-[f:files]-> {\n    write crm-[:notes]-> { body: f.`filename` }\n  }', routes: 'whole' }),
    ],
  },
  {
    reason: 'unreproduced',
    routes: 'unreached',
    note: "a refusal of this engine's own met mid-run before any effect: a backstop behind admission (every construct whose port it lacks is refused there first); no checked program here reaches one",
    programs: [
      () => ({ body: '  x = TEXT.REGEX_EXTRACT(msg.`text`, "([A-Z])")\n  write crm-[:notes]-> { body: COALESCE(x, "none") }', routes: 'whole' }),
      () => ({ body: '  x = SPLIT(msg.`text`, " ")\n  write crm-[:notes]-> { body: "${COUNT(x)}" }', routes: 'whole' }),
    ],
  },

  // ── Closed earlier in chunk 7A (Tasks 1 to 5b): the retirement proof ─────
  {
    reason: 'statement:combinator',
    routes: 'whole',
    note: 'closed in chunk 7A Task 4: parallel and race as statements',
    programs: [
      () => ({ body: '  await parallel([() => {\n    write crm-[:notes]-> { body: "a" }\n  }, () => {\n    write crm-[:notes]-> { body: "b" }\n  }])' }),
      (pick) => ({ body: `  await race([() => {\n    write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  }])` }),
    ],
  },
  {
    reason: 'rvalue:combinator',
    routes: 'whole',
    note: 'closed in chunk 7A Task 4: a combinator bound, one slot per arm',
    programs: [
      () => ({ body: '  r = await parallel([() => {\n    return 1\n  }, () => {\n    return msg.`subject`\n  }])\n  write crm-[:notes]-> { body: "x", payload: r }' }),
      () => ({ body: '  r = await race([() => {\n    write crm-[:notes]-> { body: "won" }\n    return "a"\n  }, () => {\n    return "b"\n  }])' }),
    ],
  },
  {
    reason: 'await_not_sleep',
    routes: 'whole',
    note: 'closed in chunk 7A Task 4: every await kind (combinators here; callbacks and landings in the corpora)',
    programs: [
      () => ({ body: '  r = await parallel([() => {\n    await sleep(1h)\n    return 1\n  }])' }),
      () => ({ body: '  await parallel([() => {\n    write crm-[:notes]-> { body: "first" }\n  }])\n  await sleep(30s)' }),
    ],
  },
  {
    reason: 'write_tuple',
    routes: 'whole',
    note: 'closed in chunk 7A Task 3: a write at the convergence of a tuple of paths',
    programs: [
      () => ({ body: '  crm-[p:people]-> {\n    write (crm-[:companies]->, p-[:company]->) { unique by (`name`), name: "Acme" }\n  }' }),
      (pick) => ({ body: `  crm-[p:people]-> {\n    write (crm-[:companies]->, p-[:company]->) { unique by (\`name\`), name: "${pick(NAMES)}" }\n  }` }),
    ],
  },
  {
    reason: 'write_node_root',
    routes: 'whole',
    note: 'closed in chunk 7A Task 2: writes into a node the run built (the in-process stand-in adapter)',
    programs: [
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { name: "a" }\n  write crm-[:notes]-> { body: "${COUNT(d-[:entries]->)}" }')}` }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { unique by (`name`), name: msg.`subject` }\n  write d-[:entries]-> { unique by (`name`), name: msg.`subject` }')}` }),
    ],
  },
  {
    reason: 'graph_shape',
    routes: 'whole',
    note: 'closed in chunk 7A Task 2: a shaped graph literal',
    programs: [
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph<Lead> { name: "a" }\n  write crm-[:notes]-> { body: g.name }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph<Lead> { name: msg.`subject` }\n  write crm-[:notes]-> { body: g.name }')}` }),
    ],
  },
  {
    reason: 'node_traversal_entry',
    routes: 'whole',
    note: 'closed in chunk 7A Task 2: a graph entry holding a traversal',
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  write crm-[:notes]-> { body: "${COUNT(g-[:files]->)}" }' }),
      () => ({ body: '  g = graph { cos: crm-[c:companies]-> }\n  write crm-[:notes]-> { body: "${COUNT(g-[:cos]->)}" }' }),
    ],
  },
  {
    reason: 'block_head_node_root',
    routes: 'whole',
    note: 'closed in chunk 7A Task 2: a block head over a node the run built',
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  g-[f:files]-> {\n    write crm-[:notes]-> { body: f.`filename` }\n  }' }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { name: "a" }\n  d-[e:entries]-> {\n    write crm-[:notes]-> { body: e.`name` }\n  }')}` }),
    ],
  },
  {
    reason: 'walk_records',
    routes: 'whole',
    note: 'closed in chunk 7A Task 3: a bare walk read as its records',
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  write crm-[:notes]-> { body: "${COUNT(rows)}" }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  write crm-[:notes]-> { body: COALESCE(top.`name`, "none") }' }),
    ],
  },
  {
    reason: 'rvalue:members',
    routes: 'whole',
    note: "closed in chunk 7A Task 3: MEMBERS of a declared type",
    programs: [
      () => ({ file: `type Stage = <"Seed" | "Series A">\n${m('  stages = MEMBERS(<Stage>)\n  write crm-[:notes]-> { body: JOIN(stages, ", ") }')}` }),
      () => ({ file: `type Thesis = <"Consumer" | "Infra" | "Health">\n${m('  all = MEMBERS(<Thesis>)\n  write crm-[:notes]-> { body: "${COUNT(all)}" }')}` }),
    ],
  },
  {
    reason: 'lazy_park',
    routes: 'whole',
    note: 'closed in chunk 7A Task 3: a kept walk held across a park, and resumed',
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(people)}" }', resume: (state) => state }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(cos)}" }', resume: (state) => state }),
    ],
  },
  {
    reason: 'resume_state_kind:closure',
    routes: 'whole',
    note: 'closed in chunk 7A Task 3: a closure held across a park, and resumed',
    programs: [
      () => ({ body: '  inc = (v: <number>) => v + 1\n  await sleep(1h)\n  r = MAP([1, 2], inc)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }', resume: (state) => state }),
      () => ({ body: '  base = 3\n  add = (v: <number>) => v + base\n  await sleep(1h)\n  r = MAP([1], add)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }', resume: (state) => state }),
    ],
  },
  {
    reason: 'resume_state_extraction_origin',
    routes: 'whole',
    note: 'closed in chunk 7A Task 3: an extraction’s values held across a park, and resumed',
    programs: [
      () => ({ body: '  d = extract from [msg.`text`] {\n    name: "a name"\n  }\n  n = d.`name`\n  await sleep(1h)\n  write crm-[:notes]-> { body: COALESCE(n, "none") }', replies: [{ 'x:extract_result#1': [{ name: said('Acme', 'Acme Corp') }] }], resume: (state) => state }),
      () => ({ body: '  d = extract from [msg.`text`] {\n    node co: "each company" {\n      name: "its name"\n    }\n  }\n  await sleep(1h)\n  d-[c:co]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }', replies: [{ 'x:extract_result#1': [{ co: [{ name: said('Acme', 'Acme Corp') }] }] }], resume: (state) => state }),
    ],
  },
  {
    reason: 'name_not_value@plugin',
    routes: 'whole',
    note: "closed in chunk 7A Task 3: a plugin's plain call handed the event or a handle (the record read as its fields)",
    programs: [
      () => ({ file: `import { echo } from plugins\n${m('  said = echo(q: msg)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
      () => ({ file: `import { echo } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  said = echo(q: co)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
    ],
  },

];
