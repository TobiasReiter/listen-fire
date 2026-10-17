// The patterns of the language patterns_oracle.ts runs on the Rust engine,
// the version 5 reference: each a construct family (a name the engine's
// former admission layer gave it), with the programs that exercise it. A
// pattern whose name holds a placeholder (`function:<id>`) is exercised by
// its instances.
//
// A program is the body of `movement m(msg: <inbox-[:message]->>)` over the
// oracle's world (an inbox whose message has attachments, a CRM of two
// companies with notes, deals and people), or a whole file after the
// prelude, written in the spelling versions 1–4 read: the oracle runs its
// version 5 spelling (the upgrade tool's own rewrites).

/** How a program's run on the Rust engine ends: run whole (to its result or
 *  its own runtime failure), at the check (before a segment opens), refused
 *  as unsupported (MOVENG_UNSUPPORTED) by a gap the reachability test lists
 *  as still open, refused by the shim for an event the eval wire cannot
 *  carry, or (a resume) its parked state refused as one that does not read. */
export type Ends = 'whole' | 'at_check' | 'unsupported' | 'unrecordable' | 'state_refused';

export interface Program {
  body?: string;
  file?: string;
  /** Pinned past version 5 on purpose (a version this release does not
   *  run); otherwise the program runs under version 5. */
  version?: number;
  replies?: unknown[];
  files?: Record<string, { source: string }>;
  movementName?: string;
  /** Where this program ends, when not where its pattern's do. */
  ends?: Ends;
  /** The event's payload, over the world's own. */
  payload?: Record<string, unknown>;
  /** A resume of the run's park: the program runs to its first timer park,
   *  and the oracle records the resume of the state this makes of it. */
  resume?: (state: Record<string, unknown>) => unknown;
  /** What the scripted host answers otherwise than the world does: an
   *  acting user, a records plugin's records, a file's unreadable reason —
   *  the malformed answers a host may give. */
  answers?: { actingUser?: unknown; records?: unknown; unreadable?: unknown };
  /** Its input holds what JSON cannot carry, which the recorder refuses: it
   *  runs unrecorded, kept by how it ended. */
  unrecordable?: true;
}

export interface Pattern {
  name: string;
  ends: Ends;
  /** What the pattern covers, and where its programs end. */
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

/** A library with its own instance, value, `type` and shape, and a function
 *  that writes through them, nests a call, and hands back a value. */
const NOTES_LIBRARY = [
  'import { attio } from adapters',
  'import { crm_cred } from credentials',
  'crm = attio(credentials: crm_cred)',
  'prefix = "lib"',
  'type Mood = <"calm" | "loud">',
  'export node Note {',
  '  body: <text>',
  '}',
  'export function note(n: <Note>, tag: <text>) {',
  '  copy = FIRST(MAP([n], (v) => {',
  '    g = graph { ...v }',
  '    return g',
  '  }))',
  '  write crm-[:notes]-> { body: "${prefix}:${tag}:${copy.body}" }',
  '  return UPPER(copy.body)',
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

/** The one record an `extractOne` of the message hands back: the companies
 *  it names, each with its rounds, to walk hops down. */
const FOUND_DECL = [
  'node Found: "the companies this message names" {',
  '  node co: "each company" {',
  '    name: <text> "its name"',
  '    node round: "each round it raised" {',
  '      stage: <text> "the stage"',
  '    }',
  '  }',
  '}',
].join('\n');

/** The model's answer for `Found`: one company per name, no rounds. */
const found = (...names: Array<[string, string]>) => ({ record: { co: names.map(([value, quote]) => ({ name: said(value, quote), round: [] })) } });
const ACME_BETA = found(['Acme', 'Acme Corp'], ['Beta', 'Beta Ltd']);

/** `body` over `found = extractOne([msg.text], Found)` (at `settings`),
 *  inside the guard a record that may be absent needs before a walk. */
const overFound = (body: string, settings?: string) =>
  `${FOUND_DECL}\n${m(`  found = extractOne([msg.\`text\`], Found${settings !== undefined ? `, ${settings}` : ''})\n  if found != null {\n${body
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}\n  }`)}`;

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

/** The state with the syntax tree of every piece of parked code (a closure's,
 *  a kept walk's head) replaced by one that does not read as an AST. */
function withCodeCorrupted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withCodeCorrupted);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) out[key] = withCodeCorrupted(entry);
  if (object.kind === 'closure') out.closure = 'nonsense';
  else if ('head' in object && 'captured' in object) out.head = 'nonsense';
  return out;
}

const m = (body: string) => `movement m(msg: <inbox-[:message]->>) {\n${body}\n}`;

export const PATTERNS: Pattern[] = [
  // ── Closed in chunk 7A Task 6 ────────────────────────────────────────────
  {
    name: 'expression:llm',
    ends: 'whole',
    note: "AI() asks llm.client.call at its tier",
    programs: [
      (pick) => ({ body: `  x = AI("${pick(WORDS)}")\n  write crm-[:notes]-> { body: COALESCE(x, "none") }` }),
      (pick) => ({ body: `  p = "about \${msg.\`subject\`}"\n  write crm-[:companies]-> { unique by (\`name\`), name: "${pick(NAMES)}", summary: AI(p, "${pick(['quick', 'careful', 'thorough', 'smart'])}") }` }),
    ],
  },
  {
    name: 'extract_tier',
    ends: 'whole',
    note: "an extraction call's tier, read from the deployment's tier table (a run input)",
    programs: [
      (pick) => ({
        body: `  d = extractOne([msg.\`text\`], node D: "the company" { name: <text> "the company's name" }, { tier: '${pick(['quick', 'careful'])}' })\n  write crm-[:notes]-> { body: COALESCE(d.name, "none") }`,
        replies: [{ record: { name: said(pick(NAMES), 'Acme Corp') } }],
      }),
      (pick) => ({
        file: overFound('found-[c:co]-> {\n  write crm-[:notes]-> { body: c.name }\n}', `{ tier: '${pick(['careful', 'quick'])}' }`),
        replies: [found([pick(NAMES), 'Acme Corp'], ['Beta', 'Beta Ltd'])],
      }),
    ],
  },
  {
    name: 'meta:user_email',
    ends: 'whole',
    note: "@user_* asks lookup.resolveActingUser once per segment, a malformed answer included",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: COALESCE(@user_email, "nobody") }' }),
      (pick) => ({ body: `  who = "\${@user_name} <\${@user_email}>"\n  write crm-[:notes]-> { body: who, title: "${pick(WORDS)}" }` }),
      () => ({ body: '  write crm-[:notes]-> { body: COALESCE(@user_email, "nobody") }\n  write crm-[:notes]-> { body: COALESCE(@user_name, "nameless") }', answers: { actingUser: { email: 'ada@acme.example' } } }),
      () => ({ body: '  x = MAP(["a", "b"], { onError: "warn" }, (n) => "${n}:${@user_name}")\n  write crm-[:notes]-> { body: "${COUNT(x)}" }', answers: { actingUser: { email: 'ada@acme.example' } } }),
      () => ({ body: '  x = MAP(["a"], { onError: "ignore" }, (n) => @user_id)\n  write crm-[:notes]-> { body: "${COUNT(x)}" }', answers: { actingUser: { email: 'ada@acme.example', principal: null } } }),
    ],
  },
  {
    name: 'meta:user_id',
    ends: 'whole',
    note: "@user_id, as meta:user_email",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "id=${@user_id}" }' }),
      () => ({ body: '  if @user_id != null {\n    write crm-[:notes]-> { body: "${@user_id}:${@user_name}" }\n  }' }),
    ],
  },
  {
    name: 'meta:actor_email',
    ends: 'whole',
    note: "@actor_* asks the source adapter's extractActor once per segment",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "${@actor_email} (${@actor_name}) ${@actor_id}" }' }),
      (pick) => ({ body: `  a = COALESCE(@actor_name, "${pick(NAMES)}")\n  write crm-[:notes]-> { body: a }` }),
    ],
  },
  {
    name: 'function:domain_of',
    ends: 'whole',
    note: "a function a write field advertises runs through invokeFieldFunction; inside a `unique by` write it is refused as unsupported (a gap reachability lists)",
    programs: [
      (pick) => ({ body: `  write crm-[:companies]-> { unique by (\`name\`), name: "${pick(NAMES)}", domain: DOMAIN_OF(msg.\`user\`) }` }),
      (pick) => ({ body: `  write crm-[:companies]-> { unique by (\`name\`), name: DOMAIN_OF("${pick(NAMES)}") }`, ends: 'unsupported' }),
    ],
  },
  {
    name: 'function:file',
    ends: 'whole',
    note: "FILE() asks files.render",
    programs: [
      (pick) => ({ body: `  f = FILE("report on \${msg.\`subject\`}", "${pick(['pdf', 'text'])}")\n  write crm-[:notes]-> { body: COALESCE(f.name, "none") }` }),
      () => ({ body: '  items = msg-[f:files]-> {\n    return f.`filename`\n  }\n  doc = FILE(JOIN(items, ", "), "text")\n  write crm-[:notes]-> { body: doc.contentType }' }),
    ],
  },
  {
    name: 'function:read',
    ends: 'whole',
    note: "READ() asks files.resolveFileText, an unreadable answer included",
    programs: [
      () => ({ body: '  t = READ(msg.`deck`)\n  write crm-[:notes]-> { body: COALESCE(t, "unread") }' }),
      () => ({ body: '  files = COLLECT(msg-[:files]->.data)\n  write crm-[:notes]-> { body: COALESCE(READ(AT(files, 1)), "unread") }' }),
      () => ({ body: '  t = READ(msg.`deck`)\n  write crm-[:notes]-> { body: COALESCE(t, "unread") }', answers: { unreadable: 'no_text' } }),
    ],
  },
  {
    name: 'expression_does_not_lower',
    ends: 'at_check',
    note: "an expression the checker cannot read (MOV_EXPR_PARSE) ends at the check; a held list of a block's records read back runs whole",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: CURRENCY.PARSE(msg.`text`) }' }),
      () => ({ body: '  x = TEXT.NOPE(msg.`text`)' }),
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  write crm-[:notes]-> { body: "${COUNT(held.entries)} ${FIRST(held.entries).name}" }', ends: 'whole' }),
    ],
  },
  {
    name: 'extract_proto_field',
    ends: 'whole',
    note: "a field and a node of an extraction's shape named __proto__: from version 5 an ordinary name, read off the answer as its own key",
    programs: [
      () => ({
        body: '  d = extractOne([msg.`text`], node D: "the company" {\n    __proto__: <text> "p"\n    name: <text> "n"\n  })\n  write crm-[:notes]-> { body: COALESCE(d.__proto__, "none") }',
        replies: [JSON.parse('{"record":{"__proto__":{"evidence":"pitch","value":"pitch"},"name":{"evidence":"Acme","value":"Acme"}}}')],
      }),
      () => ({
        file: `node Found: "the companies" {\n  name: <text> "a name"\n  node __proto__: "each round" {\n    a: <text> "a stage"\n  }\n}\n${m('  d = extractOne([msg.`text`], Found)\n  if d != null {\n    d-[r:__proto__]-> {\n      write crm-[:notes]-> { body: r.a }\n    }\n  }')}`,
        replies: [JSON.parse('{"record":{"name":{"evidence":"Acme","value":"Acme"},"__proto__":[{"a":{"evidence":"Seed","value":"Seed"}}]}}')],
      }),
    ],
  },
  // ── The file ─────────────────────────────────────────────────────────────
  {
    name: 'language_version_unsupported',
    ends: 'at_check',
    note: "a pin this release does not run ends at the check (MOVENG_LANGUAGE_VERSION)",
    programs: [
      () => ({ body: '  x = msg.`subject`', version: 99 }),
    ],
  },
  {
    name: 'import_from_file',
    ends: 'whole',
    note: "a library file's functions run in the library's own scope, its shapes and types read where written; a file the snapshot does not carry ends at the check (MOV_IMPORT_FILE_UNSUPPORTED)",
    programs: [
      () => ({
        file: `import { Deal } from "lib/deals"\n${m('  d = extract([msg.`text`], Deal)\n  MAP(d, (x) => {\n    write crm-[:notes]-> { body: x.name }\n  })')}`,
        files: { 'lib/deals': { source: LIBRARY } },
        replies: [{ records: [{ name: said('Acme'), stage: said('Seed') }] }],
      }),
      (pick) => ({
        file: `import { Deal } from "lib/deals"\n${m(`  d = extractOne([msg.\`subject\`, "${pick(WORDS)}"], Deal)`)}`,
        files: { 'lib/deals': { source: LIBRARY } },
      }),
      (pick) => ({
        file: `import { note as jot } from "lib/notes"\n${m(`  jot(n: node { body: msg.\`subject\` }, tag: "${pick(WORDS)}")`)}`,
        files: { 'lib/notes': { source: NOTES_LIBRARY } },
      }),
      () => ({
        file: `import { note } from "lib/notes"\n${m('  r = note(n: node { body: msg.`text` }, tag: "x")\n  write crm-[:notes]-> { body: r }')}`,
        files: { 'lib/notes': { source: NOTES_LIBRARY } },
      }),
      () => ({ file: `import { Deal } from "lib/missing"\n${m('  x = 1')}`, ends: 'at_check' }),
    ],
  },
  {
    name: 'file_assignment',
    ends: 'at_check',
    note: "a file-level extraction or node: from version 5 a file-level value holds a value only (MOV_FILE_VALUE_RUNS)",
    programs: [
      () => ({ file: `r = extractOne(["a fixed document"], node R: "the document" { name: <text> "a name" })\n${m('  write crm-[:notes]-> { body: msg.`subject` }')}` }),
      (pick) => ({ file: `n = node { title: "${pick(NAMES)}" }\n${m('  write crm-[:notes]-> { body: n.`title` }')}` }),
    ],
  },
  {
    name: 'file_call',
    ends: 'at_check',
    note: "a file-level plugin call: refused as file_assignment is (MOV_FILE_VALUE_RUNS)",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\npage = fetch_url(url: "https://acme.example")\n${m('  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { echo } from plugins\nsaid = echo(q: "hello")\n${m('  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
    ],
  },
  {
    name: 'file_statement:<kind>',
    ends: 'whole',
    note: "a statement at file scope (a write, an if) runs nothing",
    programs: [
      () => ({ file: `write crm-[:notes]-> { body: "at file scope" }\n${m('  x = 1')}` }),
      () => ({ file: `if TRUE {\n  x = 1\n}\n${m('  y = 1')}` }),
    ],
  },
  {
    name: 'movement_value_param@entry',
    ends: 'whole',
    note: "a function taking a value, fired itself, fails the run before its body",
    programs: [
      () => ({ file: `movement total(n: <number[]>) {\n  return SUM(n)\n}\n${m('  x = 1')}`, movementName: 'total' }),
      () => ({ file: `movement label(names: <text[]>) {\n  return COUNT(names)\n}\n${m('  x = 1')}`, movementName: 'label' }),
    ],
  },
  {
    name: 'movement_value_param',
    ends: 'whole',
    note: "a function taking a value that no call reaches: walked as a closure, or never run",
    programs: [
      () => ({ file: `movement total(n: <number[]>) {\n  return SUM(n)\n}\n${m('  r = MAP([[1, 2], [3]], total)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }')}`, movementName: 'm' }),
      () => ({ file: `movement label(names: <text[]>) {\n  return COUNT(names)\n}\n${m('  x = "label"\n  write crm-[:notes]-> { body: x }')}`, movementName: 'label' }),
    ],
  },
  {
    name: 'name_shadowed',
    ends: 'at_check',
    note: "a body binding a name its parameters or the file bind: the checker refuses it (MOV_SHADOWED_NAME, MOV_REBOUND_NAME)",
    programs: [
      (pick) => ({ body: `  crm = "${pick(NAMES)}"\n  x = crm` }),
      () => ({ body: '  msg = 1\n  y = msg' }),
    ],
  },
  {
    name: 'name_rebound',
    ends: 'at_check',
    note: "one name bound twice where one binding sees the other: the checker refuses it (MOV_REBOUND_NAME, MOV_SHADOWED_NAME)",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  co = 1' }),
      () => ({ body: '  crm-[c:companies]-> {\n    x = 1\n  }\n  c = 1' }),
    ],
  },
  {
    name: 'name_not_value',
    ends: 'whole',
    note: "a plugin argument naming a record bare (a handle, an extraction's record, a node) is handed the record's fields",
    programs: [
      () => ({ file: `import { echo } from plugins\n${m('  e = extractOne([msg.`text`], node E: "the company" { name: <text> "a name" })\n  said = echo(q: e)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}`, replies: [{ record: { name: said('Acme') } }] }),
      () => ({ file: `import { echo } from plugins\n${m('  n = node { title: "t" }\n  said = echo(q: n)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
    ],
  },
  {
    name: 'plugin_arg_record',
    ends: 'at_check',
    note: "a record inside a list or map handed to a plugin's argument: the checker refuses it (MOV_CALL_ARG_TYPE); a helper function's json parameter under a key runs whole",
    programs: [
      () => ({ file: `import { summarise } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  said = summarise(data: [co])\n  write crm-[:notes]-> { body: said }')}` }),
      () => ({ file: `import { summarise } from plugins\n${m('  rows = crm-[c:companies]->\n  said = summarise(data: { all: rows })\n  write crm-[:notes]-> { body: said }')}` }),
      () => ({ file: `import { summarise } from plugins\nmovement put(x: <json>) {\n  said = summarise(data: { k: x })\n  write crm-[:notes]-> { body: said }\n}\n${m('  put(x: "Acme")')}`, movementName: 'm', ends: 'whole' }),
      () => ({ file: `import { summarise } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  said = summarise(data: { k: COALESCE(co, "x") })\n  write crm-[:notes]-> { body: said }')}` }),
    ],
  },
  {
    name: 'builtin_arg_record',
    ends: 'at_check',
    note: "a record handed to a built-in's text parameter: the checker refuses it (MOV_RECORD_NOT_A_VALUE)",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  x = TEXT.REGEX_EXTRACT(top, "x")' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  x = SPLIT(co, ",")' }),
    ],
  },
  {
    name: 'write_field_record',
    ends: 'at_check',
    note: "a record reaching a system write's json field: the checker refuses it (MOV_WRITE_FIELD_TYPE, and MOV_CLOSURE_NOT_DATA for closures held in a list); a field read off a closure's record parameter runs whole",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  write crm-[:notes]-> { body: "x", payload: { company: co } }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  write crm-[:notes]-> { body: "x", payload: { a: co, b: "x" } }' }),
      () => ({ file: `node Co {\n  name: <text>\n}\n${m('  x = graph<Co> { name: "Acme" }\n  named = (r: <Co>) => {\n    write crm-[:notes]-> { body: r.name }\n  }\n  named(r: x)')}`, ends: 'whole' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  f = () => COALESCE(co, "x")\n  write crm-[:notes]-> { body: f() }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  write crm-[:notes]-> { body: COALESCE(co, "x") }' }),
      // Arms a MAP builds, joined by the retired `parallel`.
      (pick) => ({ body: `  arms = MAP([1, 2], (n) => {\n    return () => {\n      write crm-[:notes]-> { body: "arm \${n}" }\n      return n * ${pick([5, 7])}\n    }\n  })\n  r = await parallel(arms)\n  write crm-[:notes]-> { body: "x", payload: { r: r } }` }),
      // Since main's receipt typing (a MAP of closures types the parallel
      // receipt, 4a76f886) the checker refuses the written records reaching
      // the json field (MOV_WRITE_FIELD_TYPE).
      () => ({ body: '  arms = MAP([1, 2], (n) => {\n    return () => {\n      co = write crm-[:companies]-> { name: "arm ${n}" }\n      return co\n    }\n  })\n  r = await parallel(arms)\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
    ],
  },
  {
    name: 'call_arg_record',
    ends: 'at_check',
    note: "a value that may hold a record handed to a value parameter: the checker refuses it (MOV_CALL_ARG_MAYBE_RECORD)",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  note(COALESCE(co, "x"))' }),
      () => ({ file: `movement put(t: <text>) {\n  write crm-[:notes]-> { body: t }\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  put(t: COALESCE(co, "x"))')}`, movementName: 'm' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  note = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n  }\n  MAP([COALESCE(co, "x")], note)' }),
    ],
  },
  {
    name: 'value_call_arg_record',
    ends: 'at_check',
    note: "a call through a value handed an argument that may be a record: the checker refuses it (MOV_CALL_ARG_MAYBE_RECORD)",
    programs: [
      () => ({ file: `function run(h: <(n: <number>) => <number>>) {\n  co = write crm-[:companies]-> { name: "a" }\n  return h(COALESCE(co, 1))\n}\n${m('  x = run((n: <number>) => n)')}`, movementName: 'm' }),
    ],
  },
  {
    name: 'position_arg_record',
    ends: 'at_check',
    note: "a graph entry that may hold a record, handed to a record parameter: the checker refuses it (MOV_GRAPH_ENTRY_RECORD); a clean graph runs whole",
    programs: [
      () => ({ file: `node Co {\n  name: <text>\n}\nfunction hp(r: <Co>) {\n  write crm-[:notes]-> { body: r.name }\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  x = graph<Co> { name: COALESCE(co, "x") }\n  hp(r: x)')}`, movementName: 'm' }),
      () => ({ file: `node Co {\n  name: <text>\n}\nfunction hp(r: <Co>) {\n  named = (q: <Co>) => {\n    write crm-[:notes]-> { body: q.name }\n  }\n  named(q: r)\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  x = graph<Co> { name: COALESCE(co, "x") }\n  hp(r: x)')}`, movementName: 'm' }),
      () => ({ file: `node Co {\n  name: <text>\n}\nfunction hp(r: <Co>) {\n  write crm-[:notes]-> { body: r.name }\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  f = () => COALESCE(co, "x")\n  x = graph<Co> { name: f() }\n  hp(r: x)')}`, movementName: 'm' }),
      () => ({ file: `node Co {\n  name: <text>\n}\nfunction hp(r: <Co>) {\n  named = (q: <Co>) => {\n    write crm-[:notes]-> { body: q.name }\n  }\n  named(q: r)\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  f = () => COALESCE(co, "x")\n  x = graph<Co> { name: f() }\n  hp(r: x)')}`, movementName: 'm' }),
      () => ({ file: `node Co {\n  name: <text>\n}\nfunction hp(r: <Co>) {\n  write crm-[:notes]-> { body: r.name }\n}\n${m('  x = graph<Co> { name: "Acme" }\n  hp(r: x)')}`, movementName: 'm', ends: 'whole' }),
    ],
  },
  {
    name: 'extract_from_record',
    ends: 'at_check',
    note: "an extraction call over a record, a map or a list holding one: the checker holds the content to text and files (MOV_EXTRACT_CONTENT)",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  d = extractOne([rows], node D: "the company" { name: <text> "a name" })' }),
      // A record the run wrote.
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  d = extractOne([co], node D: "the company" { name: <text> "a name" })' }),
      // A node the run built, one declared field left absent (it reads null).
      () => ({ file: `node Co {\n  name: <text>\n  stage: <text | null>\n}\n${m('  x = graph<Co> { name: "Acme" }\n  d = extractOne([x], node D: "the company" { name: <text> "a name" })')}` }),
      // An earlier extraction's result.
      () => ({ body: '  e = extractOne([msg.`text`], node E: "the company" {\n    name: <text> "a name"\n    stage: <text> "a stage"\n  })\n  d = extractOne([e], node D: "the company" { name: <text> "a name" })' }),
      // A record under a key, beside a value.
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  d = extractOne([{ lead: co, note: "met at the fair" }], node D: "the company" { name: <text> "a name" })' }),
      // Records nested in maps and lists, a written one and a built one.
      () => ({ file: `node Co {\n  name: <text>\n  stage: <text>\n}\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  x = graph<Co> { name: "Beta", stage: "Seed" }\n  d = extractOne([{ a: { both: [co, x] } }, [x]], node D: "the company" { name: <text> "a name" })')}` }),
      // A file inside an input: refused at the check.
      () => ({ body: '  f = FIRST(msg-[:files]->)\n  d = extractOne([{ doc: f }], node D: "the company" { name: <text> "a name" })' }),
    ],
  },
  {
    name: 'at_record_key',
    ends: 'at_check',
    note: "AT on a record with a key that is not an index: the checker refuses it (MOV_AT_RECORD_KEY)",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  key = "name"\n  a = AT(top, key)' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  a = AT(FIRST(rows), "provenance")' }),
    ],
  },
  {
    name: 'node_spread_record',
    ends: 'at_check',
    note: "a map holding a record spread into a graph: the checker refuses it (MOV_GRAPH_SPREAD_RECORD); a clean map runs whole",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  held = { k: co }\n  g = graph { ...held }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  held = { first: FIRST(rows) }\n  g = graph { ...held }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  held = { a: "x", deep: { list: [FIRST(rows)] } }\n  g = graph { ...held }' }),
      () => ({ body: '  held = { a: "x", deep: { b: 2 } }\n  g = graph { ...held }\n  write crm-[:notes]-> { body: g.a }', ends: 'whole' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  f = () => COALESCE(co, "x")\n  held = { k: f() }\n  g = graph { ...held }' }),
      // A record nested in a null-prototype map: found at its key.
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  held = { k: { __proto__: null, inner: co } }\n  g = graph { ...held }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  held = { k: [{ __proto__: null, inner: co }] }\n  g = graph { ...held }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  f = () => COALESCE(co, "x")\n  held = { k: { __proto__: null, inner: f() } }\n  g = graph { ...held }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "a" }\n  f = () => COALESCE(co, "x")\n  held = { k: [{ __proto__: null, inner: f() }] }\n  g = graph { ...held }' }),
    ],
  },

  // ── Statements and right-hand sides ──────────────────────────────────────
  {
    name: 'statement:call',
    ends: 'whole',
    note: "a call statement of a closure bound to a name (recursion, a park inside it); a match statement gating nothing and a built-in's value dropped end at the check",
    programs: [
      (pick) => ({ body: `  note = (a: <text>) => {\n    write crm-[:notes]-> { body: a }\n  }\n  note("${pick(NAMES)}")` }),
      () => ({ body: '  shout = (t: <text>) => {\n    write crm-[:notes]-> { body: UPPER(t) }\n  }\n  shout(msg.`subject`)' }),
      (pick) => ({ body: `  tag = (c: <crm-[:company]->>, label: <text>) => {\n    write crm-[:notes]-> { body: CONCAT(c.\`name\`, label) }\n  }\n  co = write crm-[:companies]-> { name: "${pick(NAMES)}" }\n  tag(co, "!")` }),
      () => ({ body: '  stop = (t: <text>) => {\n    match crm-[:companies]-> { unique by (`name`), name: t }\n    write crm-[:notes]-> { body: "found" }\n  }\n  stop("nobody")\n  write crm-[:notes]-> { body: "after" }', ends: 'at_check' }),
      () => ({ body: '  later = (t: <text>) => {\n    await sleep(1h)\n    write crm-[:notes]-> { body: t }\n  }\n  later(msg.`subject`)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => state }),
      () => ({ body: '  later = (t: <text>) => {\n    await sleep(1h)\n    write crm-[:notes]-> { body: t }\n  }\n  later(msg.`subject`)' }),
      (pick) => ({ body: `  down = (n: <number>) => {\n    if n > 0 {\n      write crm-[:notes]-> { body: "\${n}" }\n      down(n - 1)\n    }\n  }\n  down(${pick([2, 3])})` }),
      // A built-in called on its own line: the checker refuses it (from
      // version 5 the upgrade's namespaced call on its own line does not
      // parse).
      (pick) => ({ body: `  write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  UPPER(msg.\`subject\`)`, ends: 'at_check' }),
      () => ({ body: '  UPPER(text: msg.`subject`)', ends: 'at_check' }),
    ],
  },
  {
    name: 'movement_call',
    ends: 'whole',
    note: "a function called by name, its returned value the call's",
    programs: [
      () => ({ file: `function is_even(n: <number>): <boolean> {\n  if n == 0 {\n    return true\n  }\n  return is_odd(n - 1)\n}\nfunction is_odd(n: <number>): <boolean> {\n  if n == 0 {\n    return false\n  }\n  return is_even(n - 1)\n}\n${m('  a = is_even(4)\n  write crm-[:notes]-> { body: "${a}" }')}`, movementName: 'm' }),
      (pick) => ({ file: `function down(n: <number>): <number> {\n  if n <= 0 {\n    return 0\n  }\n  return down(n - 1)\n}\n${m(`  a = down(${pick([2, 3])})\n  write crm-[:notes]-> { body: "\${a}" }`)}`, movementName: 'm' }),
    ],
  },
  {
    name: 'function_call',
    ends: 'whole',
    note: "a closure called by name, one returned by a call, and from version 5 one called through a value; a list of closures ends at the check (MOV_CLOSURE_NOT_DATA)",
    programs: [
      (pick) => ({ body: `  f = (n: <number>) => {\n    return n + ${pick([1, 2, 5])}\n  }\n  y = f(2)\n  write crm-[:notes]-> { body: "\${y}" }` }),
      () => ({ body: '  base = 5\n  f = (n: <number>) => n + base\n  y = f(n: 3)\n  write crm-[:notes]-> { body: "${y}" }' }),
      () => ({ body: '  name_of = (r: <crm-[:company]->>) => {\n    return r.`name`\n  }\n  co = write crm-[:companies]-> { name: "a" }\n  n = name_of(r: co)\n  write crm-[:notes]-> { body: UPPER(n) }' }),
      (pick) => ({ body: `  f = (n: <number>) => n * 2\n  g = (k: <number>) => k + 1\n  y = g(k: f(n: ${pick([1, 4])}))\n  write crm-[:notes]-> { body: "\${y}" }` }),
      // Inside a library function, its closure's call returned (the batch review's L2; PLAN-08B Task 2).
      (pick) => ({
        file: `import { tag } from "lib/tag"\n${m('  r = tag(n: msg.`subject`)\n  write crm-[:notes]-> { body: COALESCE(r, "none") }')}`,
        files: { 'lib/tag': { source: `export function tag(n: <text>) {\n  f = (x: <text>) => CONCAT(x, "-${pick(['L', 'M'])}")\n  return f(n)\n}` } },
        movementName: 'm',
      }),
      () => ({ body: '  f = (n: <number>) => {\n    return n\n  }\n  y = f(1, 2)\n  write crm-[:notes]-> { body: "${y}" }', ends: 'at_check' }),
      // Closures as values (version 5): a call through a value — a closure
      // a call hands back, a function bound to a name — runs; a closure is
      // not data, so the checker refuses one written as a list's member.
      () => ({ body: '  mk = () => { return () => { return msg.`subject` } }\n  g = mk()\n  x = g()\n  write crm-[:notes]-> { body: COALESCE(x, "none") }' }),
      () => ({ body: '  fs = [() => { return "a" }, () => { return msg.`subject` }]\n  g = AT(fs, 1)\n  x = g()\n  write crm-[:notes]-> { body: COALESCE(x, "none") }', ends: 'at_check' }),
      () => ({ file: `function one() {\n  return "one"\n}\n${m('  g = one\n  write crm-[:notes]-> { body: g() }')}`, movementName: 'm' }),
    ],
  },
  {
    name: 'rvalue:closure',
    ends: 'at_check',
    note: "a closure written where a value goes: from version 5 a closure is a value and a function's argument, never data (MOV_CLOSURE_NOT_DATA)",
    programs: [
      () => ({ body: '  fs = [(v: <number>) => v + 1]\n  x = COUNT(fs)' }),
      () => ({ body: '  inc = (v: <number>) => v + 1\n  held = { f: inc }\n  x = 1' }),
      () => ({ file: `movement apply(e: <inbox-[:message]->>, f: <text>) {\n  return 1\n}\n${m('  r = apply(e: msg, f: (v: <text>) => UPPER(v))')}`, movementName: 'm' }),
      // Closures as values (Dancing Wren, 5): written in place as an
      // argument; a list's members are refused under 5 and 4 alike.
      () => ({ file: `function run(h: <(n: <number>) => <number>>) {\n  return h(20)\n}\n${m('  k = 2\n  x = run((n) => n + k)\n  write crm-[:notes]-> { body: "${x}" }')}`, movementName: 'm', ends: 'whole' }),
      () => ({ body: '  k = 3\n  r = MAP([() => k, () => k * 2], (f) => f())\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
    ],
  },
  {
    name: 'rvalue:lazy',
    ends: 'whole',
    note: "a kept (lazy) walk returned from a function's body runs whole; counted as a bare value it is refused as unsupported (a gap reachability lists)",
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  x = COUNT(people)', ends: 'unsupported' }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  n = COUNT(cos)\n  write crm-[:notes]-> { body: "${n}" }', ends: 'unsupported' }),
      () => ({ body: '  return lazy crm-[c:companies]->' }),
      () => ({ file: `movement cos(e: <inbox-[:message]->>) {\n  return lazy crm-[c:companies ORDER BY \`name\`]->\n}\n${m('  x = cos(e: msg)\n  x-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }')}`, movementName: 'm' }),
    ],
  },
  {
    name: 'rvalue:inlineBlock',
    ends: 'at_check',
    note: "the retired inline block (`{ … }.name`): the checker refuses it (MOV_INLINE_BLOCK_RETIRED)",
    programs: [
      () => ({ body: '  x = {\n    y = 1\n  }.y' }),
      () => ({ body: '  x = {\n    z = msg.`subject`\n  }.z' }),
    ],
  },
  {
    name: 'expression_closure',
    ends: 'whole',
    note: "a collection call written inside an expression, staged at its place; a closure where nothing stages one ends at the check",
    programs: [
      () => ({ body: '  names = { all: MAP([msg.`subject`, "beta"], (s) => UPPER(s)) }\n  write crm-[:notes]-> { body: COALESCE(AT(names.all, 1), "none") }' }),
      () => ({ body: '  if COUNT(FILTER([msg.`subject`], (s) => s != "")) > 0 {\n    write crm-[:notes]-> { body: "some" }\n  }' }),
      () => ({ body: '  write crm-[c:companies]-> { unique by (`name` == AT(MAP([1], (v) => v), 0)) name: "a" }', ends: 'at_check' }),
      // A closure in a list is not data (version 5).
      () => ({ body: '  r = MAP([() => {\n    await sleep(1h)\n    return 1\n  }, () => 2], (f) => f())\n  write crm-[:notes]-> { body: "x", payload: { r: r } }', ends: 'at_check' }),
    ],
  },
  {
    name: 'statement:collection',
    ends: 'whole',
    note: "a collection call's members run `concurrency` at a time, each in a flow of its own, their traces in member order",
    programs: [
      () => ({ body: '  MAP(["a", "b", "c", "d"], { concurrency: 2, initialConcurrency: 1 }, (n) => {\n    write crm-[:notes]-> { body: n }\n  })' }),
      () => ({ body: '  MAP(["Acme", "Beta", "Acme"], { concurrency: 3, onError: "warn" }, (n) => {\n    if n == "Beta" {\n      x = ONLY(crm-[c:companies]->.`name`)\n    }\n    write crm-[:companies]-> { unique by (`name`), name: n }\n  })' }),
      (pick) => ({ body: `  MAP(["a", "b", "c"], { concurrency: ${pick([2, 3])} }, (n) => {\n    write crm-[:notes]-> { body: n }\n  })` }),
      () => ({ body: '  MAP(["Acme", "Beta"], { concurrency: 2 }, (n) => {\n    write crm-[:companies]-> { unique by (`name`), name: n }\n  })' }),
    ],
  },
  {
    name: 'rvalue:collection',
    ends: 'whole',
    note: "as statement:collection, bound (REDUCE carries what the members before each answered)",
    programs: [
      () => ({ body: '  lengths = MAP(["a", "bb", "ccc", "dddd"], { concurrency: 2 }, (n) => LENGTH(n))\n  write crm-[:notes]-> { body: "${SUM(lengths)}" }' }),
      () => ({ body: '  slow = MAP([1, 2, 3], { concurrency: 3 }, (n) => {\n    if n == 2 {\n      await sleep(1h)\n    }\n    return n * 10\n  })' }),
      (pick) => ({ body: `  done = MAP(["a", "b"], { concurrency: ${pick([2, 4])} }, (n) => {\n    write crm-[:notes]-> { body: n }\n    return n\n  })\n  write crm-[:notes]-> { body: "\${COUNT(done)}" }` }),
      () => ({ body: '  kept = FILTER(["a", "bb", "ccc"], { concurrency: 3 }, (n) => LENGTH(n) > 1)\n  write crm-[:notes]-> { body: "${COUNT(kept)}" }' }),
    ],
  },
  {
    name: 'statement:refresh',
    ends: 'whole',
    note: "refresh re-fetches the handle's record, and every holder of it moves on in place",
    programs: [
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  refresh co' }),
      () => ({ body: '  crm-[c:companies]-> {\n    refresh c\n  }' }),
      (pick) => ({ body: `  co = write crm-[:companies]-> { name: "${pick(NAMES)}" }\n  refresh co\n  write crm-[:notes]-> { body: co.\`name\` }` }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    refresh c\n    write crm-[:notes]-> { body: "${c.`name`}/${held.k.`name`}" }\n  }' }),
    ],
  },
  {
    name: 'statement:<kind>',
    ends: 'whole',
    note: "a shape declared in a body is hoisted for the body; any other statement kind there the parser or the checker refuses",
    programs: [
      () => ({ body: '  node Tag {\n    label: <text>\n  }\n  write crm-[:notes]-> { body: msg.`subject` }' }),
      () => ({ body: '  node Lead {\n    who: <text>\n  }\n  write crm-[:notes]-> { body: "lead" }' }),
      (pick) => ({ body: `  t = graph<Tag> { label: "${pick(WORDS)}" }\n  node Tag {\n    label: <text>\n  }\n  write crm-[:notes]-> { body: t.label }` }),
      (pick) => ({
        body: `  word = "${pick(WORDS)}"\n  node Tag: "a tag, \${word}" {\n    label: <text> "its label"\n  }\n  d = extract([msg.\`subject\`], Tag)\n  MAP(d, (x) => {\n    write crm-[:notes]-> { body: x.label }\n  })`,
        replies: [{ records: [{ label: said('Infra') }] }],
      }),
    ],
  },
  {
    name: 'rvalue:extractCall',
    ends: 'whole',
    note: "`extract(…)` and `extractOne(…)`: the prompt laid out for the cache, llm.extractCall.call at the call's settings, one retry, files read once per run",
    programs: [
      (pick) => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company)\n  MAP(found, (c) => {\n    write crm-[:notes]-> { body: c.name }\n  })')}`, replies: [{ records: [{ name: said(pick(NAMES), 'Acme Corp'), round: [{ stage: { value: pick(STAGES), evidence: { item: '0', quote: 'raised' } } }] }] }] }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m(`  one = extractOne([msg.\`subject\`], Company, { tier: '${pick(['quick', 'careful'])}' })\n  write crm-[:notes]-> { body: COALESCE(one.name, "none") }`)}` }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m("  one = extractOne([msg.`subject`, msg.`text`], Company, { effort: 'high' })\n  write crm-[:notes]-> { body: COALESCE(one.name, \"none\") }")}`, replies: [{ record: { name: said(pick(NAMES)), round: [] } }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  one = extractOne([msg.`subject`], Company)\n  write crm-[:notes]-> { body: COALESCE(one.name, "none") }')}`, replies: [{ record: null }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  one = extractOne([msg.`subject`], Company)\n  write crm-[:notes]-> { body: COALESCE(one.name, "none") }')}`, replies: [{ record: [{ name: said('A') }, { name: said('B') }] }, { record: [{ name: said('B') }] }] }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, replies: ['oops', { records: [{ name: said(pick(NAMES)) }, { name: { value: '  ', evidence: null } }] }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, replies: [{ records: [{ other: 1 }] }, { records: [{ name: { value: 'Acme', evidence: 'Acme Corp' }, round: { stage: { value: 'Seed' } } }] }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, replies: [{ records: [{ name: { value: 5 } }] }, { records: [{ name: { value: 6 } }] }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract([], Company)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}` }),
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract(COLLECT(msg-[:files]->.data), Company)\n  again = extract(COLLECT(msg-[:files]->.data), Company)\n  write crm-[:notes]-> { body: "${COUNT(found)}/${COUNT(again)}" }')}`, replies: [{ records: [{ name: said('Acme', 'x') }] }, { records: [] }] }),
      (pick) => ({ body: `  found = extract([msg.\`subject\`, "${pick(WORDS)}"], node Lead: "a lead" { who: <text> "the person" })\n  MAP(found, (l) => {\n    write crm-[:notes]-> { body: l.who }\n  })`, replies: [{ records: [{ who: said('Ada') }] }] }),
      () => ({ file: `${COMPANY_DECL}\n${m('  parts = [msg.`subject`, msg.`text`]\n  seen = MAP(parts, (p) => {\n    return COUNT(extractOne([msg.`subject`, p], Company))\n  })\n  write crm-[:notes]-> { body: "x" }')}`, replies: [{ record: { name: said('Acme') } }, { record: null }] }),
    ],
  },
  {
    name: 'extract_call_shape',
    ends: 'whole',
    note: "a shape written in place reads its words in the body's scope; a name bound to a shape is the shape",
    programs: [
      () => ({ body: '  found = extract([msg.`text`], node Lead: "a lead about ${msg.`subject`}" { who: <text> "the person" })\n  write crm-[:notes]-> { body: "${COUNT(found)}" }' }),
      (pick) => ({ body: `  found = extract([msg.\`text\`], node Lead: "a lead" { who: <text> "who wrote \${msg.\`subject\`}" })\n  write crm-[:notes]-> { body: "${pick(WORDS)}" }` }),
      () => ({ file: `${COMPANY_DECL}\n${m('  C = Company\n  found = extract([msg.`text`], C)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, replies: [{ records: [] }] }),
    ],
  },
  {
    name: 'extract_call_settings',
    ends: 'at_check',
    note: "an extraction call's settings that do not read clean: the checker refuses them (MOV_EXTRACT_CONFIG)",
    programs: [
      () => ({ file: `${COMPANY_DECL}\n${m("  found = extract([msg.`text`], Company, { speed: 'fast' })")}` }),
      () => ({ file: `${COMPANY_DECL}\n${m('  found = extract([msg.`text`], Company, { tier: msg.`subject` })')}` }),
    ],
  },
  {
    name: 'extract_call_model',
    ends: 'whole',
    note: "an extraction call's written model, held to the catalog snapshot's models (the oracle's snapshot has none, so it is unchecked)",
    programs: [
      () => ({ file: `${COMPANY_DECL}\n${m("  found = extract([msg.`text`], Company, { model: 'claude-opus-5' })\n  write crm-[:notes]-> { body: \"${COUNT(found)}\" }")}`, replies: [{ records: [] }] }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m(`  one = extractOne([msg.\`subject\`], Company, { model: 'claude-sonnet-4-6', effort: '${pick(['low', 'medium'])}' })`)}` }),
    ],
  },
  {
    name: 'rvalue:<kind>',
    ends: 'whole',
    note: "a `return` of a write or of a block (its iterations returning, a park inside joined by its fan-out)",
    programs: [
      () => ({ body: '  return write crm-[:notes]-> { body: msg.`subject` }' }),
      () => ({ body: '  return crm-[c:companies]-> {\n    await sleep(1h)\n    return c.`name`\n  }' }),
      () => ({ body: '  return crm-[c:companies]-> {\n    return c.`name`\n  }' }),
    ],
  },
  {
    name: 'plugin_call',
    ends: 'at_check',
    note: "a plugin's call as imported; one spelled in another letter case ends at the check from version 5 (MOV_NAME_UNRESOLVED, MOV_FUNCTION_UNKNOWN)",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = Fetch_Url(url: msg.`text`)\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { echo } from plugins\n${m('  said = ECHO(q: msg.`subject`)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  x = { page: fetch_url(url: msg.`text`) }')}`, ends: 'whole' }),
      () => ({ file: `import { echo } from plugins\n${m('  Echo(q: msg.`subject`)\n  write crm-[:notes]-> { body: "after" }')}` }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  d = extract from [msg.`text`] through [Fetch_Url(url: msg.`text`)] {\n    a: "a"\n  }')}` }),
    ],
  },
  {
    name: 'plugin_call:records',
    ends: 'whole',
    note: "a records output binds one record per record found, in order, the empty list for none (malformed answers included)",
    programs: [
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`text`)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}` }),
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`subject`)\n  one = FIRST(found)\n  if one != null {\n    write crm-[:notes]-> { body: one.url }\n  }')}` }),
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`text`)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, answers: { records: ['ab', [1, 2], 5, { url: 'u' }] } }),
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`text`)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, answers: { records: [{ url: 'u' }, null] } }),
      () => ({ file: `import { find_files } from plugins\n${m('  found = find_files(q: msg.`text`)\n  write crm-[:notes]-> { body: "${COUNT(found)}" }')}`, answers: { records: { url: 'u' } } }),
    ],
  },
  {
    name: 'plugin_call_form',
    ends: 'whole',
    note: "a plugin's arguments: a built-in's call, a node as its fields, a function's value, positional from version 5; a write as an argument ends at the check (MOV_CALL_ARG_TYPE)",
    programs: [
      () => ({ file: `import { fetch_url } from plugins\nmovement shout(t: <text>) {\n  return UPPER(t)\n}\n${m('  page = fetch_url(url: shout(t: msg.`text`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}`, movementName: 'm' }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  loud = (t: <text>) => UPPER(t)\n  page = fetch_url(url: loud(msg.`text`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = fetch_url(url: UPPER(msg.`text`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      () => ({ file: `import { fetch_url } from plugins\n${m('  page = fetch_url(LOWER(msg.`text`))')}` }),
      (pick) => ({ file: `import { summarise } from plugins\n${m(`  said = summarise(data: node { name: "${pick(NAMES)}", tag: "c" })\n  write crm-[:notes]-> { body: said }`)}` }),
      () => ({ file: `import { summarise } from plugins\n${m('  said = summarise(data: write crm-[:notes]-> { body: "x" })')}`, ends: 'at_check' }),
      () => ({ file: `import { fetch_url, echo } from plugins\n${m('  page = fetch_url(url: echo(q: msg.`subject`))\n  write crm-[:notes]-> { body: COALESCE(page, "none") }')}` }),
      (pick) => ({ file: `import { summarise } from plugins\nmovement pick(n: <text>) {\n  co = write crm-[:companies]-> { name: n }\n  return co\n}\n${m(`  said = summarise(data: pick(n: "${pick(NAMES)}"))\n  write crm-[:notes]-> { body: said }`)}`, movementName: 'm' }),
      () => ({ file: `import { summarise } from plugins\nmovement hide(n: <text>) {\n  co = write crm-[:companies]-> { name: n }\n  return COALESCE(co, n)\n}\n${m('  said = summarise(data: hide(n: "Acme"))\n  write crm-[:notes]-> { body: said }')}`, movementName: 'm' }),
    ],
  },
  {
    name: 'builtin_call_form',
    ends: 'whole',
    note: "a call among a built-in's arguments, staged at its place",
    programs: [
      () => ({ file: `movement mark(t: <text>) {\n  write crm-[:notes]-> { body: t }\n  return t\n}\n${m('  x = CONCAT(mark(t: "a"), mark(t: "b"))\n  write crm-[:notes]-> { body: x }')}`, movementName: 'm' }),
      () => ({ file: `movement mark(t: <text>) {\n  return UPPER(t)\n}\n${m('  x = LOWER(mark(t: msg.`subject`))\n  write crm-[:notes]-> { body: x }')}`, movementName: 'm' }),
    ],
  },

  // ── Writes, matches, links, deletes ──────────────────────────────────────
  {
    name: 'match_tuple',
    ends: 'whole',
    note: "a match at the convergence of a tuple of paths, bound or missed as a linked match is",
    programs: [
      // A tuple rooted at an instance fails as a tuple write's does.
      () => ({ body: '  crm-[p:people]-> {\n    found = match (crm-[:companies]->, p-[:company]->) { unique by (`name`), name: "Acme" }\n  }' }),
      (pick) => ({ body: `  crm-[c:companies]-> {\n    c-[d:deals]-> {\n      found = match (c-[:people]->, d-[:people]->) { unique by (\`name\`), name: "${pick(NAMES)} founder" }\n      write crm-[:notes]-> { body: COALESCE(found.\`name\`, "none") }\n    }\n  }` }),
      (pick) => ({ body: `  crm-[c:companies]-> {\n    c-[d:deals]-> {\n      found = match (c-[:people]->, d-[:people]->) { unique by (\`name\`), name: "${pick(NAMES)}" }\n      write crm-[:notes]-> { body: IF found == null THEN "absent" ELSE found.\`name\` END }\n    }\n  }` }),
    ],
  },
  {
    name: 'match_position',
    ends: 'at_check',
    note: "a match of a bare alias: the parser refuses it",
    programs: [
      () => ({ body: '  crm-[c:companies]-> {\n    found = match c { unique by (`name`), name: "Acme" }\n  }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  found = match co { unique by (`name`), name: "Acme" }' }),
    ],
  },
  {
    name: 'write_position_not_record',
    ends: 'at_check',
    note: "`write x { … }` where x is a node: the checker refuses it (MOV_WRITE_POSITION_NOT_RECORD); what a node's edge holds runs whole",
    programs: [
      () => ({ body: '  d = node { name: "a" }\n  write d { name: "b" }' }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  e = write d-[:entries]-> { name: "a" }\n  write e { name: "b" }')}`, ends: 'whole' }),
    ],
  },
  {
    name: 'delete_not_record',
    ends: 'at_check',
    note: "a delete of what its system does not declare deletable, or of no record: the checker refuses it (MOV_DELETE_NOT_DECLARED, MOV_DELETE_NOT_RECORD)",
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  g-[f:files]-> {\n    delete f\n  }' }),
      () => ({ body: '  delete msg' }),
      (pick) => ({ body: `  x = "${pick(NAMES)}"\n  delete x` }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  e = write d-[:entries]-> { name: "a" }\n  delete e')}` }),
    ],
  },
  {
    name: 'write_position_member_path',
    ends: 'whole',
    note: "`write m.k { … }` updates the record the member holds",
    programs: [
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    write held.k { stage: "seen" }\n  }' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  held = { k: co }\n  write held.k { stage: "seen" }' }),
    ],
  },
  {
    name: 'write_root_expression',
    ends: 'at_check',
    note: "a linked write rooted at an expression that is no member path: the parser refuses it; one rooted at a map member's record runs whole",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  write AT(rows, 0)-[:notes]-> { body: "x" }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    write held.k-[:notes]-> { body: "x" }\n  }', ends: 'whole' }),
    ],
  },
  {
    name: 'match_root_expression',
    ends: 'at_check',
    note: "a linked match rooted as write_root_expression is",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  found = match AT(rows, 0)-[:notes]-> { unique by (`body`), body: "x" }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    found = match held.k-[:notes]-> { unique by (`body`), body: "x" }\n  }', ends: 'whole' }),
    ],
  },
  {
    name: 'write_root_not_held',
    ends: 'whole',
    note: "a linked write rooted at a declared shape writes an in-memory position of the shape's type; with a `unique by` it is refused as unsupported (a gap reachability lists)",
    programs: [
      () => ({ file: `node Note {\n  title: <text>\n}\nmovement persist(n: <Note>) {\n  write crm-[:notes]-> { body: n.\`title\` }\n}\n${m('  persist(n: write Note-[:item]-> { title: msg.`subject` })')}`, movementName: 'm' }),
      (pick) => ({ file: `node Note {\n  title: <text>\n}\nmovement persist(n: <Note>) {\n  write crm-[:notes]-> { body: n.\`title\` }\n}\n${m(`  persist(n: write Note-[:item]-> { title: "${pick(NAMES)}" })`)}`, movementName: 'm' }),
      () => ({ file: `node Note {\n  title: <text>\n}\n${m('  n = write Note-[:item]-> { unique by (`title`), title: msg.`subject` }')}`, ends: 'unsupported' }),
    ],
  },
  {
    name: 'match_root_not_held',
    ends: 'at_check',
    note: "a linked match rooted at a declared shape: the checker refuses it (MOV_LINKED_UNKNOWN_EDGE)",
    programs: [
      () => ({ file: `node Note {\n  title: <text>\n}\n${m('  found = match Note-[:item]-> { title: "x" }')}` }),
      () => ({ file: `node Note {\n  title: <text>\n}\n${m('  found = match Note-[:item]-> { title: msg.`subject` }')}` }),
    ],
  },
  {
    name: 'write_multi_hop',
    ends: 'unsupported',
    note: "a linked write walking more than one edge: refused as unsupported after the writes before it (a gap reachability lists)",
    programs: [
      () => ({ body: '  write crm-[:companies]->-[:notes]-> { body: "x" }' }),
      () => ({ body: '  write crm-[:companies]->-[:notes]-> { body: msg.`subject`, title: "t" }' }),
      () => ({ body: '  MAP([1, 2], { onError: "ignore" }, (n) => {\n    write crm-[:companies]->-[:notes]-> { body: "${n}" }\n  })\n  write crm-[:notes]-> { body: "after" }', ends: 'whole' }),
    ],
  },
  {
    name: 'match_multi_hop',
    ends: 'unsupported',
    note: "a linked match walking more than one edge: as write_multi_hop",
    programs: [
      () => ({ body: '  found = match crm-[:companies]->-[:notes]-> { unique by (`body`), body: "x" }' }),
      (pick) => ({ body: `  write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  found = match crm-[:companies]->-[:notes]-> { unique by (\`body\`), body: msg.\`subject\` }` }),
    ],
  },
  {
    name: 'write_spread_path',
    ends: 'whole',
    note: "`...m.k` in a write: a node the program spells out, held under a key, runs whole; one it does not spell out the checker refuses (MOV_WRITE_SPREAD_SOURCE)",
    programs: [
      () => ({ body: '  n = node { body: msg.`subject` }\n  held = { k: n }\n  write crm-[:notes]-> { ...held.k }' }),
      () => ({ body: '  n = node { body: "a body" }\n  held = { k: n }\n  write crm-[:notes]-> { ...held.k, title: "t" }' }),
      () => ({ body: '  d = extractOne([msg.`text`], node N: "the note" { body: <text> "a body" })\n  held = { k: d }\n  write crm-[:notes]-> { ...held.k }', ends: 'at_check' }),
    ],
  },
  {
    name: 'node_spread',
    ends: 'at_check',
    note: "a spread in a `node { … }` literal: the parser refuses it",
    programs: [
      () => ({ body: '  held = { a: 1 }\n  n = node { ...held }' }),
      () => ({ body: '  held = { title: msg.`subject` }\n  n = node { ...held, extra: 1 }' }),
    ],
  },
  {
    name: 'node_spread_path',
    ends: 'whole',
    note: "a spread of a map's or a record's member into a graph, what the member holds copied",
    programs: [
      () => ({ file: `node S {\n  a: <text | null>\n}\n${m('  g = graph<S> { ...msg.`meta` }\n  write crm-[:notes]-> { body: COALESCE(g.`a`, "none") }')}` }),
      (pick) => ({ file: `node S {\n  a: <text | null>\n}\n${m(`  n = write crm-[:notes]-> { body: "b", payload: { a: "${pick(WORDS)}" } }\n  g = graph<S> { ...n.\`payload\` }\n  write crm-[:notes]-> { body: COALESCE(g.\`a\`, "none") }`)}` }),
      () => ({ body: '  held = { k: { name: "a" } }\n  g = graph { ...held.k }' }),
      () => ({ body: '  held = { k: { name: msg.`subject` } }\n  g = graph { ...held.k, extra: 1 }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    held = { k: c }\n    g = graph { ...held.k }\n    write crm-[:notes]-> { body: g.`name` }\n  }' }),
    ],
  },
  {
    name: 'node_spread_source',
    ends: 'whole',
    note: "a spread of the event, or of a block's landing, into a graph",
    programs: [
      () => ({ body: '  g = graph { ...msg }' }),
      () => ({ body: '  g = graph { ...msg, extra: 1 }\n  write crm-[:notes]-> { body: "${g.`subject`}/${g.`extra`}" }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    g = graph { ...c }\n  }' }),
    ],
  },
  {
    name: 'unique_by_without_key',
    ends: 'at_check',
    note: "a `unique by` with no key: the checker refuses it (MOV_UNIQUE_CONJUNCT_NEEDS_WHERE)",
    programs: [
      () => ({ body: '  write crm-[:companies]-> { unique by (`name` CONTAINS "a"), name: "Acme" }' }),
      () => ({ body: '  found = match crm-[:companies]-> { unique by (`employees` > 3), name: "Acme" }' }),
    ],
  },
  {
    name: 'unique_by_reads_beyond_candidate',
    ends: 'at_check',
    note: "a `unique by` conjunct reading beyond the candidate: the checker refuses it (MOV_UNIQUE_CONJUNCT_NEEDS_WHERE)",
    programs: [
      () => ({ body: '  write crm-[:companies]-> { unique by (`name`, EXISTS(msg-[:files]->)), name: "Acme" }' }),
      () => ({ body: '  write crm-[:companies]-> { unique by (`name`, AI("same?") == "yes"), name: "Beta" }' }),
    ],
  },

  // ── Nodes and graphs ─────────────────────────────────────────────────────
  {
    name: 'node_declared_entry',
    ends: 'at_check',
    note: "a declared edge entry inside a graph literal: the parser refuses it",
    programs: [
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  g = graph { entries: <Entry> }')}` }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  g = graph { title: "t", entries: <Entry> }')}` }),
    ],
  },
  {
    name: 'node_event_entry',
    ends: 'whole',
    note: "a graph entry holding the event holds it as its record, across a park too; a node literal's entry holding it the checker refuses (MOV_NODE_ENTRY_NODE_VALUE)",
    programs: [
      () => ({ body: '  g = graph { owner: msg }' }),
      () => ({ body: '  g = graph { title: "t", source: msg }' }),
      () => ({ body: '  g = graph { title: "t", owner: msg, inner: { from: msg } }\n  g-[o:owner]-> {\n    write crm-[:notes]-> { body: "${g.`title`} ${o.`subject`}" }\n  }\n  await sleep(1h)\n  g-[i:inner]->-[f:from]-> {\n    write crm-[:notes]-> { body: f.`subject` }\n  }', resume: (state) => state }),
      () => ({ body: '  n = node { owner: msg }', ends: 'at_check' }),
    ],
  },
  {
    name: 'rvalue:node',
    ends: 'whole',
    note: "a node a block's iteration returns",
    programs: [
      () => ({ body: '  made = crm-[c:companies]-> {\n    return node { name: c.`name` }\n  }' }),
      () => ({ body: '  made = msg-[f:files]-> {\n    return node { file: f.`filename` }\n  }' }),
    ],
  },
  {
    name: 'exists_node',
    ends: 'whole',
    note: "EXISTS off a run-built node, over more than one hop or with an ORDER BY",
    programs: [
      () => ({ file: `node Co {\n  name: <text>\n  node founder {\n    first: <text>\n  }\n}\n${m('  d = node { cos: <Co> }\n  if EXISTS(d-[:cos]->-[:founder]->) {\n    x = 1\n  }')}` }),
      () => ({ file: `node Co {\n  name: <text>\n}\n${m('  d = node { cos: <Co> }\n  if EXISTS(d-[c:cos ORDER BY `name`]->) {\n    x = 1\n  }')}` }),
    ],
  },
  {
    name: 'is_test_declared_record',
    ends: 'whole',
    note: "an `IS <Decl>` test of a system's record, decided by a check.compatible request",
    programs: [
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  crm-[c:companies]-> {\n    if c IS <Lead> {\n      write crm-[:notes]-> { body: c.`name` }\n    } else {\n      write crm-[:notes]-> { body: "no" }\n    }\n  }')}` }),
      () => ({ file: `node Elsewhere {\n  nowhere: <text>\n}\n${m('  crm-[c:companies]-> {\n    if c IS <Elsewhere> {\n      write crm-[:notes]-> { body: "fits" }\n    } else {\n      write crm-[:notes]-> { body: "does not" }\n    }\n  }')}` }),
      () => ({ file: `node Typed {\n  name: <number>\n}\n${m('  crm-[c:companies]-> {\n    if c IS <Typed> {\n      write crm-[:notes]-> { body: "fits" }\n    }\n  }')}` }),
    ],
  },
  {
    name: 'is_test_declared_graph',
    ends: 'whole',
    note: "an `IS <Decl>` test of a graph literal's edge, compared with the declaration's node there",
    programs: [
      (pick) => ({ file: `node Lead {\n  name: <text>\n  node owner {\n    name: <text>\n  }\n}\n${m(`  co = write crm-[:companies]-> { name: "${pick(NAMES)}" }\n  g = graph { name: "a", owner: co }\n  if g IS <Lead> {\n    write crm-[:notes]-> { body: "fits" }\n  } else {\n    write crm-[:notes]-> { body: "does not" }\n  }`)}` }),
      () => ({ file: `node Lead {\n  name: <text>\n  node owner {\n    name: <number>\n  }\n}\n${m('  crm-[c:companies]-> {\n    g = graph { name: c.`name`, owner: c }\n    if g IS <Lead> {\n      write crm-[:notes]-> { body: "fits" }\n    } else {\n      write crm-[:notes]-> { body: "does not" }\n    }\n  }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph { name: "a" }\n  if g IS <Lead> {\n    x = 1\n  }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph { name: msg.`subject` }\n  if g IS <Lead> {\n    write crm-[:notes]-> { body: "lead" }\n  }')}` }),
    ],
  },

  // ── Traversal blocks and heads ───────────────────────────────────────────
  {
    name: 'block_head_expression_root',
    ends: 'at_check',
    note: "a block head rooted at a list's member: the member may be absent, which the checker refuses unguarded (MOV_ABSENT_REQUIRED)",
    programs: [
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  AT(rows, 0)-[n:notes]-> {\n    write crm-[:notes]-> { body: n.`body` }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  FIRST(rows)-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
    ],
  },
  {
    name: 'block_head_value_root',
    ends: 'whole',
    note: "a block head rooted at a kept walk continues it past its head; one off a value holding records walks them",
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  people-[c:company]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  rows-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
      () => ({ body: '  cos = lazy crm-[c:companies ORDER BY `name`]->\n  cos-[d:deals WHERE `title` != ""]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
      () => ({ body: '  cos = lazy crm-[c:companies]-> node { label: c.`name`, notes: c-[n:notes]-> }\n  cos-[k:notes]-> {\n    write crm-[:notes]-> { body: "x" }\n  }' }),
    ],
  },
  {
    name: 'block_multi_hop',
    ends: 'whole',
    note: "a block head walks every hop off every path the hop before reached, each alias naming its level's record",
    programs: [
      () => ({ body: '  crm-[c:companies]->-[d:deals]-> {\n    write crm-[:notes]-> { body: d.`title` }\n  }' }),
      () => ({ body: '  crm-[:companies]->-[:deals]->-[p:people]-> {\n    write crm-[:notes]-> { body: p.`name` }\n  }' }),
    ],
  },
  {
    name: 'block_head_extract_hop',
    ends: 'whole',
    note: "a block head over an extraction's records, walking the one record an extractOne hands back",
    programs: [
      () => ({ file: overFound('write crm-[:notes]-> { body: "first" }\nfound-[c:co WHERE `name` == "Acme"]-> {\n  write crm-[:notes]-> { body: c.`name` }\n}'), replies: [ACME_BETA] }),
      () => ({ file: overFound('found-[c:co ORDER BY `name` DESC LIMIT 1]-> {\n  write crm-[:notes]-> { body: c.`name` }\n}'), replies: [ACME_BETA] }),
    ],
  },
  {
    name: 'block_head_resources',
    ends: 'at_check',
    note: "a `_resources` head off an extraction call's result: the checker refuses it (MOV_RESOURCES_NOT_EXTRACTED), though version 5 reads `_resources` only off an extraction's result",
    programs: [
      () => ({
        body: '  d = extractOne([msg.`text`, msg.`deck`], node D: "the company" { name: <text> "a name" })\n  if d != null {\n    d-[f:_resources WHERE f.type == "FILE"]-> {\n      write crm-[:notes]-> { body: f.`name` }\n    }\n  }',
        replies: [{ record: { name: said('Acme') } }],
      }),
      () => ({
        body: '  found = extract([msg.`text`], node D: "each company" { name: <text> "a name" })\n  found-[f:_resources]-> {\n    write crm-[:notes]-> { body: "a file" }\n  }',
        replies: [{ records: [{ name: said('Acme') }] }],
      }),
    ],
  },
  {
    name: 'select_multi_hop',
    ends: 'whole',
    note: "a pick walks every hop as a block head does",
    programs: [
      () => ({ body: '  x = FIRST(crm-[:companies]->-[d:deals ORDER BY `title`]->)' }),
      () => ({ body: '  x = LAST(crm-[:companies]->-[n:notes ORDER BY `body`]->)' }),
    ],
  },
  {
    name: 'traversal_step',
    ends: 'at_check',
    note: "a walk with a `#transform` hop: the checker refuses the retired hop (MOV_TRANSFORM_HOP_RETIRED)",
    programs: [
      () => ({ body: '  x = msg-[:files]->-[#transform]->.`name`' }),
      () => ({ body: '  x = COUNT(msg-[:files]->-[#transform]->)' }),
    ],
  },
  {
    name: 'exists_step',
    ends: 'at_check',
    note: "an EXISTS hop that is not an edge: as traversal_step",
    programs: [
      () => ({ body: '  if EXISTS(msg-[:files]->-[#transform]->) {\n    x = 1\n  }' }),
      () => ({ body: '  y = EXISTS(msg-[:files]->-[#transform]->)' }),
    ],
  },
  {
    name: 'walk_extract_hop',
    ends: 'whole',
    note: "a hop down the record an extractOne hands back, with a WHERE, ORDER BY or LIMIT",
    programs: [
      () => ({ file: overFound('write crm-[:notes]-> { body: "first" }\nx = COUNT(found-[c:co WHERE c.`name` != ""]->)'), replies: [ACME_BETA] }),
      () => ({ file: overFound('x = COUNT(found-[c:co ORDER BY `name` LIMIT 1]->)\nwrite crm-[:notes]-> { body: "${x}" }'), replies: [ACME_BETA] }),
      () => ({ file: overFound('x = COLLECT(found<-[:co]-.`name`)\nwrite crm-[:notes]-> { body: "${x}" }'), replies: [ACME_BETA] }),
    ],
  },
  {
    name: 'exists_extract_hop',
    ends: 'whole',
    note: "EXISTS down the record an extractOne hands back, reading each hop's WHERE, ORDER BY and LIMIT",
    programs: [
      () => ({ file: overFound('if EXISTS(found-[c:co WHERE c.name == "Beta" ORDER BY `name` DESC LIMIT 1]->) {\n  write crm-[:notes]-> { body: "yes" }\n}'), replies: [ACME_BETA] }),
      () => ({ file: overFound('if EXISTS(found-[c:co WHERE `name` == "Beta"]->) {\n  write crm-[:notes]-> { body: "yes" }\n}'), replies: [ACME_BETA] }),
    ],
  },

  // ── Expressions ──────────────────────────────────────────────────────────
  {
    name: 'aggregate:llm',
    ends: 'at_check',
    note: "the `LLM_AGG` fold: the checker refuses it (MOV_BUILTIN_NOT_RUN)",
    programs: [
      () => ({ body: '  x = LLM_AGG(["a", "b"], "summarise them")' }),
      () => ({ body: '  x = LLM_AGG(crm-[c:companies]->.`name`, "the best")' }),
    ],
  },
  {
    name: 'aggregate:only',
    ends: 'whole',
    note: "ONLY of any expression, its failure spelling the expression back; a node entry holding it, and a resource walk, end at the check",
    programs: [
      () => ({ body: '  x = ONLY(crm-[c:companies WHERE `name` == "Acme"]->.`stage`)\n  write crm-[:notes]-> { body: COALESCE(x, "none") }' }),
      () => ({ body: '  crm-[c:companies]-> {\n    x = ONLY(c-[:deals]->.`title`)\n  }' }),
      () => ({ body: '  x = ONLY(crm-[c:companies WHERE `stage` != "x" AND `employees` > 3 ORDER BY `name` DESC LIMIT 5]->.`name`)' }),
      () => ({ body: '  x = ONLY([1, "a b", null, 2.5, msg.`subject`])' }),
      () => ({ body: '  x = ONLY(crm-[c:companies]->.`name`)\n  write crm-[:notes]-> { body: COALESCE(x, "none") }' }),
      // A pick of the record a walk lands on as a graph's entry (PLAN-08A Task 2).
      () => ({ body: '  g = graph { owner: ONLY(msg-[:files]->) }\n  g-[o:owner]-> {\n    write crm-[:notes]-> { body: o.filename }\n  }' }),
      () => ({ body: '  g = graph { owner: FIRST(msg-[:files]->), top: LAST(crm-[c:companies ORDER BY `name`]->) }\n  g-[o:owner]-> {\n    write crm-[:notes]-> { body: o.filename }\n  }\n  g-[t:top]-> {\n    write crm-[:notes]-> { body: t.`name` }\n  }' }),
      () => ({ body: '  g = graph { owner: ONLY(crm-[c:companies WHERE `name` == "Acme"]->) }\n  g-[o:owner]-> {\n    write crm-[:notes]-> { body: o.`name` }\n  }' }),
      () => ({ body: '  n = node { owner: ONLY(msg-[:files]->) }', ends: 'at_check' }),
      () => ({ body: '  x = ONLY(msg-[:_resources]->.`name`)', ends: 'at_check' }),
    ],
  },
  {
    name: 'aggregate:sort_key',
    ends: 'whole',
    note: "`sort(xs, key)` with a function key over records and maps; `SORT` with a key that is no function ends at the check (MOV_V5_SPELLING)",
    programs: [
      () => ({ body: '  x = SORT(["b", "a"], UPPER("a"))', ends: 'at_check' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = sort(rows, (c) => LOWER(c.`name`))\n  write crm-[:notes]-> { body: JOIN(MAP(x, (c) => c.`name`), ",") }' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = sort(rows, (c) => LENGTH(c.`stage`))\n  write crm-[:notes]-> { body: JOIN(MAP(x, (c) => c.`name`), ",") }' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = sort(rows, (c) => c.employees * -1, { order: "desc" })\n  write crm-[:notes]-> { body: JOIN(MAP(x, (c) => c.`name`), ",") }' }),
      () => ({ body: '  rows = [{ n: "b", s: 2 }, { n: "a", s: 9 }, { n: "c" }]\n  x = sort(rows, (r) => COALESCE(r.s, 0) * -1)\n  write crm-[:notes]-> { body: JOIN(MAP(x, (r) => r.n), ",") }' }),
    ],
  },
  {
    name: 'aggregate_records',
    ends: 'whole',
    note: "a fold of a bare walk inside a list or map",
    programs: [
      () => ({ body: '  x = [FIRST(crm-[c:companies ORDER BY `name`]->)]' }),
      () => ({ body: '  x = { top: LAST(crm-[c:companies ORDER BY `name`]->) }' }),
    ],
  },
  {
    name: 'expression:<type>',
    ends: 'at_check',
    note: "the retired KG_VALUE and KG_EXISTS pass the checker and are refused as unsupported (a gap reachability lists); `_resources`, @resource and @parent reads end at the check",
    programs: [
      () => ({ body: '  x = COLLECT(msg-[:_resources]->.`name`)' }),
      () => ({ body: '  found = extract from [msg.`text`] {\n    name: "a"\n  }\n  x = COLLECT(found-[:_resources]->.`name`)' }),
      () => ({ body: '  x = KG_VALUE("MATCH (n) RETURN n")', ends: 'unsupported' }),
      () => ({ body: '  if KG_EXISTS("MATCH (n) RETURN n") {\n    x = 1\n  }', ends: 'unsupported' }),
      (pick) => ({ body: `  write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  write crm-[:notes]-> { body: "\${KG_VALUE("MATCH (n) RETURN n", msg.\`subject\`)}" }`, ends: 'unsupported' }),
      () => ({ body: '  xs = MAP([1, 2], { onError: "ignore" }, (n) => {\n    return KG_VALUE("MATCH (n) RETURN n")\n  })\n  write crm-[:notes]-> { body: "${COUNT(xs)}" }', ends: 'whole' }),
      () => ({ body: '  x = @resource.name' }),
      () => ({ body: '  x = @parent.name' }),
    ],
  },
  {
    name: 'expression:exists',
    ends: 'unsupported',
    note: "a rootless `EXISTS(-[…]->)` outside a WHERE is refused as unsupported (a gap reachability lists); inside a hop's WHERE it walks off the landed record",
    programs: [
      () => ({ body: '  x = EXISTS(-[:notes]->)' }),
      () => ({ body: '  if EXISTS(-[:deals]->) {\n    x = 1\n  }' }),
      (pick) => ({ body: `  write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  y = EXISTS(-[:notes]-> WHERE \`body\` == "x")` }),
      () => ({ body: '  crm-[c:companies WHERE EXISTS(-[:deals]->)]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }', ends: 'whole' }),
      () => ({ file: overFound('if EXISTS(found-[c:co]-> WHERE EXISTS(-[:round]->)) {\n  write crm-[:notes]-> { body: "rounds" }\n}'), replies: [{ record: { co: [{ name: said('Acme', 'Acme Corp'), round: [{ stage: said('Seed', 'seed') }] }, { name: said('Beta', 'Beta Ltd'), round: [] }] } }] }),
    ],
  },
  {
    name: 'meta:<key>',
    ends: 'at_check',
    note: "an unknown `@` key (`@trigger`, `@mutationContext`): the checker refuses it (MOV_META_UNKNOWN_KEY)",
    programs: [
      () => ({ body: '  x = @trigger' }),
      () => ({ body: '  x = @mutationContext' }),
    ],
  },
  {
    name: 'function:<id>',
    ends: 'whole',
    note: "a built-in function by name (CHUNKS among them); a closure called in another letter case ends at the check from version 5 (MOV_FUNCTION_UNKNOWN)",
    programs: [
      (pick) => ({ body: `  pieces = CHUNKS("aaaa bbbb cccc dddd eeee ffff", { size: ${pick([8, 12])} })\n  write crm-[:notes]-> { body: "\${COUNT(pieces)}" }` }),
      (pick) => ({ body: `  pieces = CHUNKS("Acme Corp met Example Ventures\\n- one\\n- two\\nsee acme.com", { entities: ${pick([1, 2])}, overlap: 3 })\n  write crm-[:notes]-> { body: "\${COUNT(pieces)}" }` }),
      () => ({ body: '  pieces = CHUNKS(msg.`missing`, { size: 10 })\n  write crm-[:notes]-> { body: "${COUNT(pieces)}" }' }),
      () => ({ body: '  pieces = CHUNKS(msg.`subject`, { size: 0 })\n  write crm-[:notes]-> { body: "x" }' }),
      // A closure called in another letter case: from version 5 no call.
      (pick) => ({ body: `  inc = (v: <number>) => v + ${pick([1, 2])}\n  c = INC(inc(1)) * 10\n  write crm-[:notes]-> { body: "\${c}" }`, ends: 'at_check' }),
      () => ({ file: `movement double(n: <number>) {\n  return n * 2\n}\n${m('  inc = (v: <number>) => v + 1\n  c = double(INC(inc(1)))\n  write crm-[:notes]-> { body: "${c}" }')}`, movementName: 'm', ends: 'at_check' }),
    ],
  },
  {
    name: 'nested_call',
    ends: 'whole',
    note: "a closure's, a plugin's or an extraction's call inside an expression, staged in the order written and only where reached (AND, OR, IF and COALESCE skip what they do not need); one that would park the checker refuses (MOV_NESTED_CALL_SUSPENDS)",
    programs: [
      (pick) => ({ body: `  f = (n: <number>) => n * ${pick([2, 3])}\n  write crm-[:notes]-> { body: "\${f(3) + 1}" }` }),
      () => ({ body: '  loud = (t: <text>) => {\n    write crm-[:notes]-> { body: t }\n    return UPPER(t)\n  }\n  x = msg.`subject` == "nope" AND loud("skipped") == "SKIPPED"\n  y = COALESCE(msg.`subject`, loud("unreached"))\n  z = IF msg.`subject` != "" THEN loud("taken") ELSE loud("not taken") END\n  write crm-[:notes]-> { body: "${x} ${y} ${z}" }' }),
      (pick) => ({ body: `  fact = (n: <number>): <number> => {\n    if n <= 1 {\n      return 1\n    }\n    return n * fact(n - 1)\n  }\n  write crm-[:notes]-> { body: "\${fact(${pick([3, 5])})}" }` }),
      () => ({ body: '  big = (n: <number>) => n > 2\n  small = (n: <number>) => n < 10\n  if big(4) AND small(4) {\n    write crm-[:notes]-> { body: "between" }\n  }\n  if big(1) AND small(9) {\n    write crm-[:notes]-> { body: "never" }\n  }' }),
      () => ({ file: `${COMPANY_DECL}\n${m('  n = COUNT(extract([msg.`text`], Company))\n  top = ONLY(extract([msg.`subject`], Company)).name\n  write crm-[:notes]-> { body: "${n} ${top}" }')}`, replies: [{ records: [{ name: said('Acme') }, { name: said('Beta') }] }, { records: [{ name: said('Gamma') }] }] }),
      () => ({ file: `import { echo } from plugins\n${m('  said = { page: echo(q: msg.`subject`) }\n  write crm-[:notes]-> { body: COALESCE(said.page, "none") }')}` }),
      // A nested call's value read whole by a write's field, a plugin's
      // argument and an extraction's source keeps the trail of what fed it.
      () => ({ body: '  loud = (t: <text>) => UPPER(t)\n  write crm-[:notes]-> { body: loud(msg.`subject`) }' }),
      () => ({ file: `import { echo } from plugins\n${m('  write crm-[:notes]-> { body: COALESCE(echo(q: READ(msg.`deck`)), "none") }')}` }),
      () => ({ file: `import { echo } from plugins\n${m('  loud = (t: <text>) => UPPER(t)\n  said = echo(q: COALESCE(loud(msg.`subject`), "n"))\n  write crm-[:notes]-> { body: said }')}` }),
      () => ({ file: m('  loud = (t: <text>) => UPPER(t)\n  d = extractOne([loud(msg.`text`)], node D: "the company" { name: <text> "the company\'s name" })\n  write crm-[:notes]-> { body: COALESCE(d.name, "none") }'), replies: [{ record: { name: { value: 'Acme', evidence: { item: '0', quote: 'ACME' } } } }] }),
      () => ({ body: '  later = (t: <text>) => {\n    await sleep(1h)\n    return UPPER(t)\n  }\n  write crm-[:notes]-> { body: CONCAT(later(msg.`subject`), "!") }', ends: 'at_check' }),
    ],
  },
  {
    name: 'nested_call_form',
    ends: 'whole',
    note: "a nested call handed a write, a node, a function or a type",
    programs: [
      () => ({ file: `${COMPANY_DECL}\n${m('  name_of = (c: <Company>) => c.name\n  write crm-[:notes]-> { body: "${name_of(node { name: "A" })}" }')}` }),
      (pick) => ({ file: `${COMPANY_DECL}\n${m(`  name_of = (c: <Company>) => c.name\n  x = "\${name_of(node { name: "${pick(NAMES)}" })}!"`)}` }),
    ],
  },
  {
    name: 'nested_movement_call',
    ends: 'whole',
    note: "a function called inside an expression, staged as the binding it means",
    programs: [
      () => ({ file: `function double(n: <number>): <number> {\n  return n * 2\n}\n${m('  write crm-[:notes]-> { body: "${double(3) + 1}" }')}`, movementName: 'm' }),
      (pick) => ({ file: `function inc(n: <number>): <number> {\n  return n + 1\n}\n${m(`  x = inc(${pick([1, 2])}) * 2\n  write crm-[:notes]-> { body: "\${x}" }`)}`, movementName: 'm' }),
    ],
  },
  {
    name: 'within_compare',
    ends: 'whole',
    note: "`WITHIN`, measured from the host's clock, in an expression and in a hop's WHERE",
    programs: [
      () => ({ body: '  x = msg.`subject` WITHIN "7d"\n  write crm-[:notes]-> { body: "${x}" }' }),
      () => ({ body: '  if "2025-12-30" WITHIN "7d" {\n    write crm-[:notes]-> { body: "recent" }\n  }' }),
      () => ({ body: '  if "2025-12-30" WITHIN "7d" {\n    write crm-[:notes]-> { body: "recent" }\n  }\n  if "2025-12-20T00:00:00Z" WITHIN "1w" {\n    write crm-[:notes]-> { body: "stale" }\n  }' }),
      () => ({ body: '  crm-[c:companies WHERE `name` WITHIN "7d"]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }' }),
      () => ({ body: '  crm-[c:companies WHERE `employees` WITHIN "99999w"]-> {\n    write crm-[:notes]-> { body: c.`name` }\n  }' }),
    ],
  },
  {
    name: 'static_number',
    ends: 'whole',
    note: "a `-0` literal is `0`, a -0 computed at run time is -0, across a park too; `1e400` does not parse (MOV_EXPR_PARSE)",
    programs: [
      () => ({ body: '  x = -0\n  write crm-[:notes]-> { body: "${x}" }' }),
      () => ({ body: '  x = -0\n  y = 1 / x\n  write crm-[:notes]-> { body: "${y}", payload: { n: x, list: [x, -0.0] } }' }),
      () => ({ body: '  x = -0\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${1 / x}" }', resume: (state) => state }),
      () => ({ body: '  x = 1e400', ends: 'at_check' }),
    ],
  },
  {
    name: 'proto_key',
    ends: 'whole',
    note: "a `__proto__` key written in a map literal",
    programs: [
      () => ({ body: '  x = { __proto__: 1 }' }),
      () => ({ body: '  x = { a: 1, __proto__: { b: 2 } }\n  k = "b"\n  y = AT(x, k)\n  write crm-[:notes]-> { body: "${AT(x, "a")} ${x.a}", payload: { y: y } }' }),
      () => ({ body: '  x = { __proto__: 1, a: 2 }\n  write crm-[:notes]-> { body: "x", payload: x }' }),
      () => ({ body: '  x = { __proto__: null, a: 2 }\n  write crm-[:notes]-> { body: "${x.a}" }' }),
    ],
  },

  // ── The rest of the file, heads and walks ────────────────────────────────
  {
    name: 'import_from_<namespace>',
    ends: 'at_check',
    note: "an import from a namespace other than adapters, credentials and plugins: the parser refuses it",
    programs: [
      () => ({ file: `import { thing } from builtins\n${m('  x = 1')}` }),
      () => ({ file: `import { other } from somewhere\n${m('  x = 1')}` }),
    ],
  },
  {
    name: 'block_head_rootless',
    ends: 'unsupported',
    note: "a block head with no root passes the checker and is refused as unsupported, after the writes before it (a gap reachability lists)",
    programs: [
      () => ({ body: '  -[c:companies]-> {\n    x = 1\n  }' }),
      () => ({ body: '  -[n:notes]-> {\n    y = 1\n  }' }),
      (pick) => ({ body: `  write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  -[c:companies]-> {\n    write crm-[:notes]-> { body: c.\`name\` }\n  }` }),
    ],
  },
  {
    name: 'block_head_root',
    ends: 'at_check',
    note: "a block head rooted at a name no record is held under: the checker refuses it (MOV_HEAD_NOT_A_POSITION, MOV_TRAVERSE_UNKNOWN_EDGE)",
    programs: [
      () => ({ body: '  x = 1\n  x-[c:companies]-> {\n    y = 1\n  }' }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  Lead-[c:companies]-> {\n    y = 1\n  }')}` }),
    ],
  },
  {
    name: 'block_head_step',
    ends: 'at_check',
    note: "a block head with a `#transform` hop: the checker refuses the retired hop (MOV_TRANSFORM_HOP_RETIRED)",
    programs: [
      () => ({ body: '  msg-[t:#transform]-> {\n    y = 1\n  }' }),
      () => ({ body: '  msg-[:files]->-[t:#transform]-> {\n    y = 1\n  }' }),
    ],
  },
  {
    name: 'traversal_root',
    ends: 'whole',
    note: "a hop off a kept walk continues it past its head",
    programs: [
      () => ({ body: '  files = lazy msg-[a:files]->\n  x = COLLECT(files.`filename`)' }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  x = COUNT(cos-[:deals]->)' }),
    ],
  },
  {
    name: 'traversal_steps',
    ends: 'whole',
    note: "a field read off a held name that also walks hops",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  x = COLLECT(rows-[:deals]->.`title`)' }),
      () => ({ body: '  rows = crm-[c:companies]->\n  x = COUNT(rows-[:notes]->)' }),
    ],
  },
  {
    name: 'traversal_terminal',
    ends: 'whole',
    note: "a walk ending in anything but a field",
    programs: [
      () => ({ body: '  x = COUNT(crm-[c:companies]->-[:notes]->)' }),
      () => ({ body: '  co = write crm-[:companies]-> { name: "Acme" }\n  x = COUNT(co-[:deals]->-[:people]->)' }),
    ],
  },

  // ── A parked state ───────────────────────────────────────────────────────
  {
    name: 'resume_state_does_not_read',
    ends: 'state_refused',
    note: "a parked state whose journal or scopes do not read: the resume refuses it (resume_state_does_not_read); the state as parked resumes whole",
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => ({ ...state, journal: 'nonsense' }) }),
      () => ({ body: '  x = msg.`subject`\n  await sleep(1h)\n  write crm-[:notes]-> { body: x }', resume: (state) => ({ ...state, scopeChain: 'nonsense' }) }),
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => state, ends: 'whole' }),
      () => ({ body: '  x = msg.`subject`\n  await sleep(1h)\n  write crm-[:notes]-> { body: x }', resume: (state) => state, ends: 'whole' }),
    ],
  },
  {
    name: 'resume_state_code_does_not_read',
    ends: 'whole',
    note: "a parked state naming code (a closure, a kept walk's head) the pinned program does not hold: the resume fails at run time where the code is read (MOVENG_RUNTIME), not up front by this name",
    programs: [
      () => ({ body: '  inc = (v: <number>) => v + 1\n  await sleep(1h)\n  r = MAP([1, 2], inc)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }', resume: (state) => withCodeCorrupted(state) }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(cos)}" }', resume: (state) => withCodeCorrupted(state) }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(cos)}" }', resume: (state) => state, ends: 'unsupported' }),
    ],
  },
  {
    name: 'resume_state_version',
    ends: 'state_refused',
    note: "a parked state of another park-state version than this engine writes (2): a version 1 state is the TypeScript engine's, and the resume refuses it (resume_state_version)",
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => ({ ...state, version: 1 }) }),
    ],
  },
  {
    name: 'resume_state_suspended',
    ends: 'state_refused',
    note: "a parked state whose `suspended` is not true: the resume refuses it (resume_state_suspended)",
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => ({ ...state, suspended: false }) }),
      () => ({ body: '  await sleep(1h)\n  x = 1', resume: (state) => ({ ...state, suspended: 'yes' }) }),
    ],
  },
  {
    name: 'resume_state_kind:localShape',
    ends: 'whole',
    note: "a shape declared in a body, held across a park, rebuilt from its declaration",
    programs: [
      () => ({ body: '  node Note {\n    title: <text>\n  }\n  await sleep(1h)\n  d = extractOne([msg.`text`], Note)' }),
      () => ({ body: '  node Tag {\n    label: <text>\n  }\n  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }' }),
    ].map((make) => (pick: Pick) => ({ ...make(), resume: (state: Record<string, unknown>) => state })),
  },
  {
    name: 'resume_state_kind:blockMeta',
    ends: 'state_refused',
    note: "a parked state holding a block's meta edges bound as a name, which no run makes: the resume refuses it (resume_state_kind:blockMeta)",
    programs: [
      () => ({ body: '  await sleep(1h)\n  write crm-[:notes]-> { body: "after" }', resume: (state) => withBinding(state, 'meta', { kind: 'blockMeta', edges: [] }) }),
      () => ({ body: '  await sleep(1h)\n  x = 1', resume: (state) => withBinding(state, 'm2', { kind: 'blockMeta', edges: [] }) }),
    ],
  },

  // ── The shim's input checks, and after the check ─────────────────────────
  {
    name: 'event_does_not_cross',
    ends: 'unrecordable',
    note: "an event the eval wire cannot carry as itself (a Map): the shim refuses it before the engine opens (event_does_not_cross)",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "seen" }', payload: { when: new Map([['at', 0]]) }, unrecordable: true }),
    ],
  },
  {
    name: 'event_field_dated',
    ends: 'whole',
    note: "a date-typed event field, its ISO text",
    programs: [
      () => ({ body: '  write crm-[:notes]-> { body: "${msg.`sent`}" }', payload: { sent: '2026-01-01T09:00:00.000Z' } }),
      () => ({ body: '  if msg.`sent` != null {\n    write crm-[:notes]-> { body: "dated" }\n  }', payload: { sent: '2026-01-01T09:00:00.000Z' } }),
    ],
  },
  {
    name: 'condition_does_not_lower',
    ends: 'whole',
    note: "a field read off a call's answer in a condition",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  if FIRST(held.entries).name == "Acme" {\n    write crm-[:notes]-> { body: "acme" }\n  }' }),
      () => ({ body: '  rows = crm-[c:companies]-> {\n    return c\n  }\n  held = { entries: rows }\n  if LAST(held.entries).name != "" {\n    x = 1\n  }' }),
    ],
  },

  // ── Closed earlier in chunk 7A (Tasks 1 to 5b): the retirement proof ─────
  {
    name: 'statement:combinator',
    ends: 'whole',
    note: "`all` and `race` as statements, their functions as arguments; `parallel` and a list of arms end at the check (MOV_PARALLEL_RETIRED, MOV_COMBINATOR_ARMS_ARE_ARGUMENTS)",
    programs: [
      () => ({ body: '  await parallel([() => {\n    write crm-[:notes]-> { body: "a" }\n  }, () => {\n    write crm-[:notes]-> { body: "b" }\n  }])', ends: 'at_check' }),
      (pick) => ({ body: `  await race([() => {\n    write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  }])`, ends: 'at_check' }),
      () => ({ body: '  all(() => {\n    write crm-[:notes]-> { body: "a" }\n  }, () => {\n    write crm-[:notes]-> { body: "b" }\n  })' }),
      (pick) => ({ body: `  race(() => {\n    write crm-[:notes]-> { body: "${pick(NAMES)}" }\n  })` }),
    ],
  },
  {
    name: 'rvalue:combinator',
    ends: 'whole',
    note: "`all` and `race` bound, their settings (`concurrency`, `onError`) included; `parallel` and a list of arms end at the check, as statement:combinator",
    programs: [
      () => ({ body: '  r = await parallel([() => {\n    return 1\n  }, () => {\n    return msg.`subject`\n  }])\n  write crm-[:notes]-> { body: "x", payload: r }', ends: 'at_check' }),
      () => ({ body: '  r = await race([() => {\n    write crm-[:notes]-> { body: "won" }\n    return "a"\n  }, () => {\n    return "b"\n  }])', ends: 'at_check' }),
      // `parallel` is retired under version 5: `all` answers as it did.
      () => ({ body: '  r = all(() => {\n    return 1\n  }, () => {\n    return msg.`subject`\n  })\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
      () => ({ body: '  r = all(() => {\n    await sleep(1h)\n    return 1\n  }, () => {\n    write crm-[:notes]-> { body: "second" }\n    return msg.`subject`\n  }, { concurrency: 1 })\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
      () => ({ body: '  r = all(() => {\n    ERROR("boom")\n  }, () => {\n    return msg.`subject`\n  }, { onError: "warn" })\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
      () => ({ body: '  r = race(() => {\n    await sleep(1h)\n    return 1\n  }, () => {\n    return msg.`subject`\n  })\n  write crm-[:notes]-> { body: "x", payload: { r: r } }' }),
    ],
  },
  {
    name: 'write_tuple',
    ends: 'whole',
    note: "a write at the convergence of a tuple of paths",
    programs: [
      () => ({ body: '  crm-[p:people]-> {\n    write (crm-[:companies]->, p-[:company]->) { unique by (`name`), name: "Acme" }\n  }' }),
      (pick) => ({ body: `  crm-[p:people]-> {\n    write (crm-[:companies]->, p-[:company]->) { unique by (\`name\`), name: "${pick(NAMES)}" }\n  }` }),
    ],
  },
  {
    name: 'write_node_root',
    ends: 'whole',
    note: "writes into a node the run built",
    programs: [
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { name: "a" }\n  write crm-[:notes]-> { body: "${COUNT(d-[:entries]->)}" }')}` }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { unique by (`name`), name: msg.`subject` }\n  write d-[:entries]-> { unique by (`name`), name: msg.`subject` }')}` }),
    ],
  },
  {
    name: 'graph_shape',
    ends: 'whole',
    note: "a shaped graph literal",
    programs: [
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph<Lead> { name: "a" }\n  write crm-[:notes]-> { body: g.name }')}` }),
      () => ({ file: `node Lead {\n  name: <text>\n}\n${m('  g = graph<Lead> { name: msg.`subject` }\n  write crm-[:notes]-> { body: g.name }')}` }),
    ],
  },
  {
    name: 'node_traversal_entry',
    ends: 'whole',
    note: "a graph entry holding a traversal",
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  write crm-[:notes]-> { body: "${COUNT(g-[:files]->)}" }' }),
      () => ({ body: '  g = graph { cos: crm-[c:companies]-> }\n  write crm-[:notes]-> { body: "${COUNT(g-[:cos]->)}" }' }),
    ],
  },
  {
    name: 'block_head_node_root',
    ends: 'whole',
    note: "a block head over a node the run built",
    programs: [
      () => ({ body: '  g = graph { files: msg-[:files]-> }\n  g-[f:files]-> {\n    write crm-[:notes]-> { body: f.`filename` }\n  }' }),
      () => ({ file: `node Entry {\n  name: <text>\n}\n${m('  d = node { entries: <Entry> }\n  write d-[:entries]-> { name: "a" }\n  d-[e:entries]-> {\n    write crm-[:notes]-> { body: e.`name` }\n  }')}` }),
    ],
  },
  {
    name: 'walk_records',
    ends: 'whole',
    note: "a bare walk read as its records",
    programs: [
      () => ({ body: '  rows = crm-[c:companies]->\n  write crm-[:notes]-> { body: "${COUNT(rows)}" }' }),
      () => ({ body: '  rows = crm-[c:companies ORDER BY `name`]->\n  top = FIRST(rows)\n  write crm-[:notes]-> { body: COALESCE(top.`name`, "none") }' }),
    ],
  },
  {
    name: 'rvalue:members',
    ends: 'whole',
    note: "MEMBERS of a declared type",
    programs: [
      () => ({ file: `type Stage = <"Seed" | "Series A">\n${m('  stages = MEMBERS(<Stage>)\n  write crm-[:notes]-> { body: JOIN(stages, ", ") }')}` }),
      () => ({ file: `type Thesis = <"Consumer" | "Infra" | "Health">\n${m('  every = MEMBERS(<Thesis>)\n  write crm-[:notes]-> { body: "${COUNT(every)}" }')}` }),
    ],
  },
  {
    name: 'lazy_park',
    ends: 'unsupported',
    note: "a kept walk held across a park, then counted: refused as unsupported (a gap reachability lists)",
    programs: [
      () => ({ body: '  people = lazy crm-[p:people]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(people)}" }', resume: (state) => state }),
      () => ({ body: '  cos = lazy crm-[c:companies]->\n  await sleep(1h)\n  write crm-[:notes]-> { body: "${COUNT(cos)}" }', resume: (state) => state }),
    ],
  },
  {
    name: 'resume_state_kind:closure',
    ends: 'whole',
    note: "a closure held across a park, and resumed",
    programs: [
      () => ({ body: '  inc = (v: <number>) => v + 1\n  await sleep(1h)\n  r = MAP([1, 2], inc)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }', resume: (state) => state }),
      () => ({ body: '  base = 3\n  add = (v: <number>) => v + base\n  await sleep(1h)\n  r = MAP([1], add)\n  write crm-[:notes]-> { body: "${COUNT(r)}" }', resume: (state) => state }),
    ],
  },
  {
    name: 'resume_state_extraction_origin',
    ends: 'whole',
    note: "an extraction's values held across a park, and resumed",
    programs: [
      () => ({ body: '  d = extractOne([msg.`text`], node D: "the company" { name: <text> "a name" })\n  n = d.name\n  await sleep(1h)\n  write crm-[:notes]-> { body: COALESCE(n, "none") }', replies: [{ record: { name: said('Acme', 'Acme Corp') } }], resume: (state) => state }),
      () => ({ file: `${FOUND_DECL}\n${m('  found = extractOne([msg.`text`], Found)\n  await sleep(1h)\n  if found != null {\n    found-[c:co]-> {\n      write crm-[:notes]-> { body: c.name }\n    }\n  }')}`, replies: [found(['Acme', 'Acme Corp'])], resume: (state) => state }),
    ],
  },
  {
    name: 'name_not_value@plugin',
    ends: 'whole',
    note: "a plugin's call handed a handle (the record read as its fields); the event, whose `deck` field is a file, ends at the check (MOV_CALL_ARG_TYPE)",
    programs: [
      () => ({ file: `import { echo } from plugins\n${m('  said = echo(q: msg)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}`, ends: 'at_check' }),
      () => ({ file: `import { echo } from plugins\n${m('  co = write crm-[:companies]-> { name: "Acme" }\n  said = echo(q: co)\n  write crm-[:notes]-> { body: COALESCE(said, "none") }')}` }),
    ],
  },

];
