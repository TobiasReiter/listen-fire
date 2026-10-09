// Golden tests for the movement-language parser: every fenced example in
// plans/2026-06-10-data-movement-language/3_syntax_sketch.md (§A–G, I) is copied
// verbatim below and must parse, with structural assertions per example.

import { MovementParseError, parseProgram } from '../parse';
import { fileCallScope, readCall, resolveCallee } from '../../checker/calls';
import {
  CallArg,
  CallStatement,
  ExtractExpression,
  RValue,
  Statement,
  UniqueClause,
  WriteExpression,
  WriteTarget,
} from '../ast';
import { pathRootName, typeNameOf } from '../ast';

function as<K extends Statement['kind']>(
  s: Statement | undefined,
  kind: K,
): Extract<Statement, { kind: K }> {
  if (!s || s.kind !== kind) throw new Error(`expected statement '${kind}', got '${s?.kind}'`);
  return s as Extract<Statement, { kind: K }>;
}

function rv<K extends RValue['kind']>(v: RValue, kind: K): Extract<RValue, { kind: K }> {
  if (v.kind !== kind) throw new Error(`expected rvalue '${kind}', got '${v.kind}'`);
  return v as Extract<RValue, { kind: K }>;
}

function target<K extends WriteTarget['kind']>(
  w: WriteExpression,
  kind: K,
): Extract<WriteTarget, { kind: K }> {
  if (w.target.kind !== kind) {
    throw new Error(`expected write target '${kind}', got '${w.target.kind}'`);
  }
  return w.target as Extract<WriteTarget, { kind: K }>;
}

function arg<K extends CallArg['kind']>(a: CallArg | undefined, kind: K): Extract<CallArg, { kind: K }> {
  if (!a || a.kind !== kind) throw new Error(`expected call arg '${kind}', got '${a?.kind}'`);
  return a as Extract<CallArg, { kind: K }>;
}

const pred = (c: UniqueClause | undefined) => (c ? c.predicate.raw.trim() : '');

function expectParseError(source: string, pattern: RegExp): MovementParseError {
  try {
    parseProgram(source);
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    expect(e.message).toMatch(pattern);
    expect(e.loc.line).toBeGreaterThanOrEqual(1);
    expect(e.loc.col).toBeGreaterThanOrEqual(1);
    return e;
  }
  throw new Error(`expected parse to fail with ${pattern}`);
}

// ── §A — instances, and movements as functions ──

const A1 = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
  'movement dealflow_intake(msg: <inbox-[:message]->>) {',
  '  if msg.`subject` CONTAINS "deal" {',
  '    …',
  '  }',
  '}',
].join('\n');

describe('§A instances and movements', () => {
  it('parses the intake skeleton', () => {
    const program = parseProgram(A1);
    expect(program.statements).toHaveLength(5);

    const imp1 = as(program.statements[0], 'import');
    expect(imp1.names).toEqual([{ name: 'email' }, { name: 'attio' }]);
    expect(imp1.source).toEqual({ kind: 'builtin', namespace: 'adapters' });
    const imp2 = as(program.statements[1], 'import');
    expect(imp2.names).toEqual([{ name: 'dealflow_inbox' }, { name: 'acme_main' }]);
    expect(imp2.source).toEqual({ kind: 'builtin', namespace: 'credentials' });

    const inboxAssign = as(program.statements[2], 'assign');
    expect(inboxAssign.name).toBe('inbox');
    const construct = rv(inboxAssign.value, 'construct').construct;
    expect(construct.callee).toBe('email');
    expect(construct.args).toHaveLength(1);
    expect(construct.args[0].name).toBe('credentials');
    expect(construct.args[0].value.raw).toBe('dealflow_inbox');

    const movement = as(program.statements[4], 'movement');
    expect(movement.name).toBe('dealflow_intake');
    expect(movement.params).toHaveLength(1);
    expect(movement.params[0].name).toBe('msg');
    expect(typeNameOf(movement.params[0].type)?.graph).toBe('inbox');
    expect(typeNameOf(movement.params[0].type)?.position).toBe('message');

    const ifStmt = as(movement.body[0], 'if');
    expect(ifStmt.arms).toHaveLength(1);
    expect(ifStmt.arms[0].condition.raw).toBe('msg.`subject` CONTAINS "deal"');
    expect(ifStmt.arms[0].body).toHaveLength(0); // elided body (…)
    expect(ifStmt.elseArm).toBeUndefined();
  });
});

describe('§A backtick-quoted construction callee', () => {
  it('constructs a dash-slugged adapter named via a backtick callee', () => {
    const src = [
      'import { `native-valuations` } from adapters',
      'import { vals_cred } from credentials',
      'vals = `native-valuations`(credentials: vals_cred)',
    ].join('\n');
    const program = parseProgram(src);
    const construct = rv(as(program.statements[2], 'assign').value, 'construct').construct;
    expect(construct.callee).toBe('native-valuations');
    expect(construct.args).toHaveLength(1);
    expect(construct.args[0].name).toBe('credentials');
    expect(construct.args[0].value.raw).toBe('vals_cred');
  });

  it('backtracks a bare backtick reference (no parens) to a plain expression', () => {
    const src = 'x = `some name`';
    const program = parseProgram(src);
    // Not a construction — falls through to expression parsing.
    expect(rv(as(program.statements[0], 'assign').value, 'expr').expr.raw).toBe('`some name`');
  });
});

// ── §B — writes, handles, identity ──

const B1 = [
  'company = write crm-[:company]-> {',
  '  unique by (`domains`)',
  '  name:    AI("the company name this email is about")',
  '  domains: [msg-[:sender]->.`domain`]',
  '}',
].join('\n');

const B2 = [
  'part = write fr-[:participants]-> {',
  '  unique by (fr AND `investor_name`)',
  '  investor_name: i.`name`',
  '}',
].join('\n');

const B3 = 'link champion -[:led]-> part';

describe('§B writes, handles, identity', () => {
  it('parses a root write with unique-by and expression fields', () => {
    const program = parseProgram(B1);
    const assign = as(program.statements[0], 'assign');
    expect(assign.name).toBe('company');
    const write = rv(assign.value, 'write').write;
    const t = target(write, 'linked');
    expect(t.path.root).toEqual({ kind: 'name', name: 'crm' });
    expect(t.path.hopsRaw).toBe('-[:company]->');
    expect(write.uniqueBy).toHaveLength(1);
    expect(pred(write.uniqueBy[0])).toBe('`domains`');
    expect(write.fields.map((f) => f.name)).toEqual(['name', 'domains']);
    expect(write.fields[0].value.raw).toBe('AI("the company name this email is about")');
    expect(write.fields[1].value.raw).toBe('[msg-[:sender]->.`domain`]');
  });

  it('parses a linked write with compound (ref + field) identity', () => {
    const program = parseProgram(B2);
    const write = rv(as(program.statements[0], 'assign').value, 'write').write;
    const t = target(write, 'linked');
    expect(t.path.root).toEqual({ kind: 'name', name: 'fr' });
    expect(t.path.hopsRaw).toBe('-[:participants]->');
    expect(t.explicitType).toBeUndefined();
    expect(pred(write.uniqueBy[0])).toBe('fr AND `investor_name`');
    expect(write.fields.map((f) => f.name)).toEqual(['investor_name']);
  });

  it('parses the bare-handle link statement', () => {
    const program = parseProgram(B3);
    const link = as(program.statements[0], 'link').link;
    expect(link).toMatchObject({ from: 'champion', edge: 'led', to: { kind: 'handle', name: 'part' } });
  });

  it('parses a link body as the match of the hop, identified by its unique by', () => {
    const program = parseProgram(
      'link c -[:portfolio]-> { unique by (FUZZY `name`), name: "Fund III", city: "Berlin" }',
    );
    const link = as(program.statements[0], 'link').link;
    expect(link).toMatchObject({ from: 'c', edge: 'portfolio' });
    if (link.to.kind !== 'match') throw new Error('expected a match body');
    expect(link.to.impliedIdentity).toBe(false);
    const match = link.to.match;
    expect(match.target).toMatchObject({
      kind: 'linked',
      path: { root: { kind: 'name', name: 'c' }, hopsRaw: '-[:portfolio]->' },
    });
    expect(match.uniqueBy.map(pred)).toEqual(['FUZZY `name`']);
    expect(match.fields.map((f) => f.name)).toEqual(['name', 'city']);
  });

  it('a link body with no unique by identifies by all of its fields, exactly', () => {
    const program = parseProgram('link c -[:portfolio]-> { name: "Fund III", `Legal Name`: n }');
    const link = as(program.statements[0], 'link').link;
    if (link.to.kind !== 'match') throw new Error('expected a match body');
    expect(link.to.impliedIdentity).toBe(true);
    expect(link.to.match.uniqueBy.map(pred)).toEqual(['name, `Legal Name`']);
  });

  it('binds the record a link body finds; a polymorphic edge takes the type in brackets', () => {
    const program = parseProgram('p = link c -[:related]-> <company> { name: "Fund III" }');
    const assign = as(program.statements[0], 'assign');
    expect(assign.name).toBe('p');
    const link = rv(assign.value, 'link').link;
    expect(link.to.match.target).toMatchObject({ kind: 'linked', explicitType: 'company' });
    expectParseError('p = link c -[:related]->company { name: "x" }', /wrap the type in angle brackets: <company>/);
  });

  it('keeps the edge spelling of a backticked hop', () => {
    const program = parseProgram('link entry -[:`Owners`]-> { `Full name`: o.name }');
    const link = as(program.statements[0], 'link').link;
    if (link.to.kind !== 'match') throw new Error('expected a match body');
    expect(link.edge).toBe('Owners');
    expect(link.to.match.target).toMatchObject({ path: { hopsRaw: '-[:`Owners`]->' } });
  });

  it.each(['?:', '+:', '+?:'])("refuses the '%s' operator in a link body — it never writes", (op) => {
    expectParseError(`link c -[:portfolio]-> { name ${op} "x" }`, /a link body never writes/);
  });

  it('refuses binding the handle form: only a body finds something to bind', () => {
    expectParseError('p = link a -[:e]-> b', /A link binds only the record it finds/);
  });

  it("retires the 'edge' statement keyword, pointing at link and at nesting", () => {
    expectParseError('edge champion -[:led]-> part', /'edge' is not a statement[\s\S]*link a/);
  });

  it('parses a tuple-path multi-parent write target', () => {
    const program = parseProgram(
      [
        'inv = write (company-[:investments]->, investor-[:investments]->) {',
        '  unique by (company AND investor)',
        '  amount: 100',
        '}',
      ].join('\n'),
    );
    const write = rv(as(program.statements[0], 'assign').value, 'write').write;
    const t = target(write, 'tuple');
    expect(t.paths.map((p) => [pathRootName(p), p.hopsRaw])).toEqual([
      ['company', '-[:investments]->'],
      ['investor', '-[:investments]->'],
    ]);
    expect(t.explicitType).toBeUndefined();
    expect(pred(write.uniqueBy[0])).toBe('company AND investor');
    expect(write.fields.map((f) => f.name)).toEqual(['amount']);
  });

  it('parses a tuple write target with an explicit type after the paths', () => {
    const program = parseProgram('write (a-[:rel]->, b-[:rel]->) <note> { text: "x" }');
    const t = target(as(program.statements[0], 'write').write, 'tuple');
    expect(t.paths).toHaveLength(2);
    expect(t.explicitType).toBe('note');
  });

  it('rejects a one-path tuple, pointing at the linked form', () => {
    expectParseError('write (a-[:rel]->) { text: "x" }', /two or more parent paths/);
  });

  it('parses a bare-alias position write target (`write a { … }`)', () => {
    const program = parseProgram('write a { status: "Open" }');
    const t = target(as(program.statements[0], 'write').write, 'position');
    expect(t.root).toEqual({ kind: 'name', name: 'a' });
    expect(as(program.statements[0], 'write').write.fields.map((f) => f.name)).toEqual(['status']);
  });

  it('parses a linked write with an explicit type for a polymorphic edge', () => {
    const program = parseProgram('write fr-[:related]-><company> { name: "x" }');
    const write = as(program.statements[0], 'write').write;
    const t = target(write, 'linked');
    expect(t.path.root).toEqual({ kind: 'name', name: 'fr' });
    expect(t.explicitType).toBe('company');
  });

  it("parses the '?:' set-if-empty field marker per field, mixed with plain ':'", () => {
    const program = parseProgram(
      ['write crm-[:company]-> {', '  name:  m.`subject`', '  owner ?: @user_email', '}'].join('\n'),
    );
    const write = as(program.statements[0], 'write').write;
    expect(write.fields.map((f) => ({ name: f.name, semantics: f.semantics }))).toEqual([
      { name: 'name', semantics: undefined },
      { name: 'owner', semantics: 'fill' },
    ]);
    expect(write.fields[1].value.raw).toBe('@user_email');
  });

  it("parses '?:' on a backticked field name", () => {
    const program = parseProgram('write crm-[:company]-> { `Deal Owner` ?: @user_email }');
    const write = as(program.statements[0], 'write').write;
    expect(write.fields[0]).toMatchObject({ name: 'Deal Owner', semantics: 'fill' });
  });

  it("parses the append operators '+:' and '+?:' (longest match first), mixed with ':'/'?:'", () => {
    const program = parseProgram(
      [
        'write crm-[:company]-> {',
        '  name:        m.`subject`',
        '  summary ?:   m.`text`',
        '  tags +:      ["a"]',
        '  domains +?:  ["b"]',
        '}',
      ].join('\n'),
    );
    const write = as(program.statements[0], 'write').write;
    expect(write.fields.map((f) => ({ name: f.name, semantics: f.semantics }))).toEqual([
      { name: 'name', semantics: undefined },
      { name: 'summary', semantics: 'fill' },
      { name: 'tags', semantics: 'append' },
      { name: 'domains', semantics: 'append-missing' },
    ]);
  });

  it('parses the unlink statement (the inverse of edge)', () => {
    const program = parseProgram('unlink champion -[:led]-> part');
    const unlink = as(program.statements[0], 'unlink');
    expect(unlink).toMatchObject({ from: 'champion', edge: 'led', to: 'part' });
  });

  it('parses the delete statement (one bound handle)', () => {
    const program = parseProgram('delete stale');
    const del = as(program.statements[0], 'delete');
    expect(del.name).toBe('stale');
  });

  it("rejects 'delete' without a handle name", () => {
    expect(() => parseProgram('delete')).toThrow(MovementParseError);
  });

  it('parses a bound write — `bind <name>` between the target and the body', () => {
    const program = parseProgram('co = write crm-[:company]-> bind src { name: "x" }');
    const write = rv(as(program.statements[0], 'assign').value, 'write').write;
    expect(target(write, 'linked').path.hopsRaw).toBe('-[:company]->');
    expect(write.bind?.name).toBe('src');
    expect(write.fields.map((f) => f.name)).toEqual(['name']);
  });

  it('parses bind on a linked write target', () => {
    const program = parseProgram('write fr-[:participants]-> bind src { investor_name: "x" }');
    const write = as(program.statements[0], 'write').write;
    expect(target(write, 'linked').path.root).toEqual({ kind: 'name', name: 'fr' });
    expect(write.bind?.name).toBe('src');
  });

  it('parses bind on a tuple write target', () => {
    const program = parseProgram(
      'write (a-[:e]->, b-[:f]->) bind src { name: "x" }',
    );
    const write = as(program.statements[0], 'write').write;
    expect(target(write, 'tuple').paths).toHaveLength(2);
    expect(write.bind?.name).toBe('src');
  });

  it('parses a backtick-quoted bind name', () => {
    const program = parseProgram('write crm-[:company]-> bind `Source Record` { name: "x" }');
    const write = as(program.statements[0], 'write').write;
    expect(write.bind?.name).toBe('Source Record');
  });

  it('treats absent bind as undefined and keeps a body field named bind legal', () => {
    const program = parseProgram('write crm-[:company]-> { bind: "x" }');
    const write = as(program.statements[0], 'write').write;
    expect(write.bind).toBeUndefined();
    expect(write.fields.map((f) => f.name)).toEqual(['bind']);
  });

  it("rejects 'bind' with no name", () => {
    expectParseError('write crm-[:company]-> bind { name: "x" }', /counterpart record name after 'bind'/);
  });
});

// ── §C — traversal-headed blocks and meta-node returns ──

const C1 = [
  'drive = dropbox(credentials: team_drive)',
  '',
  'msg-[file:_resources WHERE `contentType` == "application/pdf"]-> {',
  '  write drive-[:file]-> {',
  '    name: file.`filename`',
  '    data: file.`data`',
  '  }',
  '}',
].join('\n');

const C2 = [
  'mentioned = extract from [msg.`text`] {',
  '  node company: "each company mentioned" {',
  "    name: \"the company's name\"",
  '  }',
  '}',
  '',
  'orgs = mentioned-[c:company]-> {',
  '  co = write crm-[:company]-> {',
  '    unique by (`name`)',
  '    name: c.`name`',
  '  }',
  '}',
  '',
  'write team-[:message]-> {',
  '  channel: "#deals"',
  '  text: "Logged ${COUNT(orgs-[:co]->)} companies. First: ${FIRST(orgs-[:co]->).`url`}"',
  '}',
].join('\n');

describe('§C traversal-headed blocks', () => {
  it('parses a _resources block with a WHERE filter in the hop', () => {
    const program = parseProgram(C1);
    expect(program.statements).toHaveLength(2);
    rv(as(program.statements[0], 'assign').value, 'construct');
    const block = as(program.statements[1], 'block').block;
    expect(block.head.root).toEqual({ kind: 'name', name: 'msg' });
    expect(block.head.hopsRaw).toBe(
      '-[file:_resources WHERE `contentType` == "application/pdf"]->',
    );
    const write = as(block.body[0], 'write').write;
    expect(write.fields.map((f) => f.name)).toEqual(['name', 'data']);
  });

  // The `_resources` edge is a leading-underscore identifier (no `#`), so it
  // survives the comment lexer in any position — including outside traversal
  // brackets, where the old `#resources` label was swallowed as a comment. A
  // bare reference to it parses cleanly.
  it('a bare `_resources` reference parses (not eaten by the comment lexer)', () => {
    const program = parseProgram(
      ['x = _resources', 'write crm-[:note]-> { body: x }'].join('\n'),
    );
    // Two statements survive — the `_resources` identifier did not start a
    // comment that swallowed the rest of the line and the write below it.
    expect(program.statements).toHaveLength(2);
    const assign = as(program.statements[0], 'assign');
    expect(assign.name).toBe('x');
  });

  // Unary minus (a formula-grammar amendment, not a statement-layer change)
  // and the traversal `-[` form are disjoint: `scanExpressionRootEnd` only
  // ever looks for `-[`, so a bare `-x` never matches a path head and falls
  // through to an ordinary expression slot, while `a-[:b]->` is untouched.
  it('a leading unary minus is an expression slot, not a traversal head', () => {
    const program = parseProgram('x = -back_days');
    const assign = as(program.statements[0], 'assign');
    expect(assign.name).toBe('x');
    expect(rv(assign.value, 'expr').expr.raw).toBe('-back_days');
  });

  it('a name root still traverses (-[ is unaffected by unary minus)', () => {
    const program = parseProgram(['y = a-[:b]-> {', '  z = 1', '}'].join('\n'));
    const block = rv(as(program.statements[0], 'assign').value, 'block').block;
    expect(block.head.root).toEqual({ kind: 'name', name: 'a' });
    expect(block.head.hopsRaw).toBe('-[:b]->');
  });

  it('parses extract assign + block assign + unbound write', () => {
    const program = parseProgram(C2);
    expect(program.statements).toHaveLength(3);

    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.from.map((f) => f.raw)).toEqual(['msg.`text`']);
    expect(extract.stages).toHaveLength(1);
    expect(extract.stages[0].children.map((c) => c.name)).toEqual(['company']);
    expect(extract.stages[0].children[0].description?.raw).toBe('"each company mentioned"');
    expect(extract.stages[0].children[0].stages[0].fields.map((f) => f.name)).toEqual(['name']);

    const orgsAssign = as(program.statements[1], 'assign');
    expect(orgsAssign.name).toBe('orgs');
    const block = rv(orgsAssign.value, 'block').block;
    expect(block.head.root).toEqual({ kind: 'name', name: 'mentioned' });
    expect(block.head.hopsRaw).toBe('-[c:company]->');
    const coAssign = as(block.body[0], 'assign');
    expect(coAssign.name).toBe('co');
    rv(coAssign.value, 'write');

    const write = as(program.statements[2], 'write').write;
    expect(target(write, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'team' }, hopsRaw: '-[:message]->' });
    expect(write.fields[1].value.raw).toBe(
      '"Logged ${COUNT(orgs-[:co]->)} companies. First: ${FIRST(orgs-[:co]->).`url`}"',
    );
  });
});

// From language version 3 a collection op is a call like any other: the parser
// records `MAP(…)` as a call, and resolution reads it as the op once `MAP`
// resolves to the standard library (`checker/calls.ts`). These read each one
// through that resolution; under version 2 the op is still parsed by name.
const noFunctions = fileCallScope([]);
function readOp(call: CallStatement, position: 'statement' | 'value') {
  const reading = readCall(call, (callee) => resolveCallee(callee, noFunctions, 3), position);
  if (reading.kind !== 'collection') throw new Error(`expected a collection op, got ${reading.kind}`);
  return reading.collection;
}
const bareOp = (s: Statement | undefined) => readOp(as(s, 'call'), 'statement');
const boundOp = (s: Statement | undefined) => readOp(rv(as(s, 'assign').value, 'call').call, 'value');

describe('a bare collection-op statement (no binding)', () => {
  it('MAP(...) run bare parses — the function runs for its effects, the answer unbound', () => {
    const program = parseProgram(
      ['xs = [1, 2, 3]', 'MAP(xs, (n) => { write crm-[:note]-> { text: "x" } })'].join('\n'),
    );
    expect(program.statements).toHaveLength(2);
    expect(bareOp(program.statements[1]).op).toBe('map');
  });

  it('under version 2 it is the collection statement, read by name', () => {
    const program = parseProgram(
      ['xs = [1, 2, 3]', 'MAP(xs, (n) => { write crm-[:note]-> { text: "x" } })'].join('\n'),
      { languageVersion: 2 },
    );
    expect(as(program.statements[1], 'collection').collection.op).toBe('map');
  });

  it('FILTER(...) and REDUCE(...) parse bare too — the checker, not the parser, decides whether the function must return', () => {
    const filterProgram = parseProgram(
      ['xs = [1, 2, 3]', 'FILTER(xs, (n) => { return n > 1 })'].join('\n'),
    );
    expect(bareOp(filterProgram.statements[1]).op).toBe('filter');

    const reduceProgram = parseProgram(
      ['xs = [1, 2, 3]', 'REDUCE(xs, 0, (acc, n) => { return acc + n })'].join('\n'),
    );
    expect(bareOp(reduceProgram.statements[1]).op).toBe('reduce');
  });

  it('MAP and FILTER take a settings record between the collection and the function', () => {
    const program = parseProgram(
      [
        'xs = [1, 2, 3]',
        'ys = MAP(xs, { onError: "warn", concurrency: 4 }, (n) => { return n })',
        'FILTER(xs, {\n  concurrency: 2,\n  initialConcurrency: 1\n}, (n) => { return n > 1 })',
      ].join('\n'),
    );
    const mapped = boundOp(program.statements[1]);
    expect(mapped.op).toBe('map');
    expect(mapped.config?.raw).toBe('{ onError: "warn", concurrency: 4 }');
    expect(mapped.fn.kind).toBe('closure');
    const filtered = bareOp(program.statements[2]);
    expect(filtered.config?.raw).toContain('initialConcurrency: 1');
    expect(filtered.fn.kind).toBe('closure');
  });

  it('the two-argument forms carry no settings', () => {
    const program = parseProgram(['xs = [1, 2, 3]', 'MAP(xs, (n) => { return n })'].join('\n'));
    expect(bareOp(program.statements[1]).config).toBeUndefined();
  });

  it("REDUCE's middle argument is still its starting value, even when it is a record", () => {
    const program = parseProgram(
      ['xs = [1, 2, 3]', 'REDUCE(xs, { total: 0 }, (acc, n) => { return acc })'].join('\n'),
    );
    const reduced = bareOp(program.statements[1]);
    expect(reduced.init?.raw).toBe('{ total: 0 }');
    expect(reduced.config).toBeUndefined();
  });

  it('settings held in a name are refused, naming the in-place record', () => {
    const program = parseProgram(['xs = [1, 2, 3]', 'MAP(xs, cfg, (n) => { return n })'].join('\n'));
    const reading = readCall(as(program.statements[1], 'call'), (callee) => resolveCallee(callee, noFunctions, 3), 'statement');
    expect(reading).toMatchObject({ kind: 'refused', refusal: { kind: 'args' } });
    expect(reading.kind === 'refused' ? reading.refusal.message : '').toMatch(/settings as a record written in place/);
    expect(() =>
      parseProgram(['xs = [1, 2, 3]', 'MAP(xs, cfg, (n) => { return n })'].join('\n'), { languageVersion: 2 }),
    ).toThrow(/settings as a record written in place/);
  });

  it('a name that merely happens to be spelled MAP but is not called stays an ordinary name', () => {
    const program = parseProgram(['MAP = 3', 'y = MAP + 1'].join('\n'));
    expect(program.statements).toHaveLength(2);
    expect(as(program.statements[0], 'assign').name).toBe('MAP');
  });
});

// ── §D — extraction with through stages ──

const D1 = [
  'deals = extract from [msg.`text`, msg-[:files]->.`data`] through [scrub_sensitive] {',
  '  node company: "each company seeking investment in this message" {',
  "    name: \"the company's name\"",
  '    urls: "URLs in the message associated with this company"',
  '  } through [vc_url_retrieval(urls: urls)] {',
  "    name:    \"the company's name\"",
  "    website: \"the company's official website\"",
  '',
  '    node round: "the funding round this company is raising" {',
  "      stage:  \"the round's stage, e.g. Seed, Series A\"",
  '      amount: "the amount being raised"',
  '      node investor: "each investor participating in this round" {',
  '        name: "investor name"',
  '        lead: "whether this investor is leading the round"',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

describe('§D extraction is materialisation', () => {
  it('parses the staged extract tree', () => {
    const program = parseProgram(D1);
    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.from.map((f) => f.raw)).toEqual(['msg.`text`', 'msg-[:files]->.`data`']);

    // the `from … through [scrub_sensitive]` pipeline belongs to stage 0
    expect(extract.stages).toHaveLength(1);
    expect(extract.stages[0].through?.map((p) => p.plugin)).toEqual(['scrub_sensitive']);
    expect(extract.stages[0].through?.[0].args).toHaveLength(0);
    expect(extract.stages[0].fields).toHaveLength(0);

    const company = extract.stages[0].children[0];
    expect(company.name).toBe('company');
    expect(company.stages).toHaveLength(2);
    expect(company.stages[0].through).toBeUndefined();
    expect(company.stages[0].fields.map((f) => f.name)).toEqual(['name', 'urls']);
    expect(company.stages[1].through?.map((p) => p.plugin)).toEqual(['vc_url_retrieval']);
    expect(company.stages[1].through?.[0].args).toEqual([
      { name: 'urls', value: expect.objectContaining({ raw: 'urls' }) },
    ]);
    expect(company.stages[1].fields.map((f) => f.name)).toEqual(['name', 'website']);

    const round = company.stages[1].children[0];
    expect(round.name).toBe('round');
    expect(round.stages[0].fields.map((f) => f.name)).toEqual(['stage', 'amount']);
    const investor = round.stages[0].children[0];
    expect(investor.name).toBe('investor');
    expect(investor.stages[0].fields.map((f) => f.name)).toEqual(['name', 'lead']);
    expect(investor.stages[0].fields[1].description.raw).toBe(
      '"whether this investor is leading the round"',
    );
  });

  it('parses an explicit field type annotation', () => {
    const program = parseProgram(
      'd = extract from [x] {\n  amount: <number> "the amount being raised"\n}',
    );
    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.stages[0].fields[0]).toMatchObject({
      name: 'amount',
      type: 'number',
      description: { raw: '"the amount being raised"' },
    });
  });

  it('parses a borrowed (dotted-path) field type annotation', () => {
    const program = parseProgram(
      'd = extract from [x] {\n  stage: <crm-[:companies]->.funding_stage> "the round\'s stage"\n}',
    );
    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.stages[0].fields[0]).toMatchObject({
      name: 'stage',
      type: 'crm.companies.funding_stage',
      description: { raw: '"the round\'s stage"' },
    });
  });

  it('a dangling dot in a borrowed type is a parse error', () => {
    expect(() => parseProgram('d = extract from [x] {\n  stage: crm. "the stage"\n}')).toThrow(
      /path segment/,
    );
  });

  // The tier sits between the keyword and `from`, the one slot that already
  // demands a specific word — so no lookahead against `through` or the stage
  // brace is needed to tell it apart.
  it('parses the tier between `extract` and `from`', () => {
    const program = parseProgram('d = extract "thorough" from [x] {\n  name: "the name"\n}');
    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.tier).toBe('thorough');
    expect(extract.stages[0].fields[0]).toMatchObject({ name: 'name' });
  });

  it('carries an unrecognised tier through to the checker, and leaves it off when absent', () => {
    const written = parseProgram('d = extract "loud" from [x] {\n  name: "the name"\n}');
    expect(rv(as(written.statements[0], 'assign').value, 'extract').extract.tier).toBe('loud');
    const bare = parseProgram('d = extract from [x] {\n  name: "the name"\n}');
    expect(rv(as(bare.statements[0], 'assign').value, 'extract').extract.tier).toBeUndefined();
  });

  it('parses a tier ahead of a `through` pipeline', () => {
    const program = parseProgram(
      'd = extract "quick" from [x] through [scrub_sensitive] {\n  name: "the name"\n}',
    );
    const extract = rv(as(program.statements[0], 'assign').value, 'extract').extract;
    expect(extract.tier).toBe('quick');
    expect(extract.stages[0].through?.[0]).toMatchObject({ plugin: 'scrub_sensitive' });
  });
});

// ── §E — program order and parallel ──

const E1 = [
  'movement nightly_mirror(root: <crm>) {',
  '',
  '  root-[c:companies]-> {',
  '    write kg-[:company]-> { unique by (`domains`), name: c.`Name`, domains: c.`Domains` }',
  '  }',
  '',
  '  root-[d:deals]-> {',
  '    write kg-[:deal]-> {',
  '      unique by (`name`)',
  '      name:    d.`Name`',
  '      company: FIRST(d-[:Company]->.`Domains`)',
  '    }',
  '  }',
  '}',
].join('\n');

const E2 = [
  'await parallel([',
  '  () => { write team-[:message]-> { channel: "#deals", text: company.`name` } },',
  '  () => { write aff-[:organization]-> { unique by (`name`), name: company.`name` } },',
  '])',
].join('\n');

describe('§E ordering and parallel', () => {
  it('parses nightly_mirror as two sequential block statements', () => {
    const program = parseProgram(E1);
    const movement = as(program.statements[0], 'movement');
    expect(typeNameOf(movement.params[0].type)?.graph).toBe('crm');
    expect(typeNameOf(movement.params[0].type)?.position).toBeUndefined(); // bare instance = meta position
    expect(movement.body).toHaveLength(2);

    const first = as(movement.body[0], 'block').block;
    expect(first.head).toMatchObject({ root: { kind: 'name', name: 'root' }, hopsRaw: '-[c:companies]->' });
    const firstWrite = as(first.body[0], 'write').write;
    expect(pred(firstWrite.uniqueBy[0])).toBe('`domains`');
    expect(firstWrite.fields.map((f) => f.name)).toEqual(['name', 'domains']);

    const second = as(movement.body[1], 'block').block;
    expect(second.head).toMatchObject({ root: { kind: 'name', name: 'root' }, hopsRaw: '-[d:deals]->' });
    const secondWrite = as(second.body[0], 'write').write;
    expect(secondWrite.fields[1].value.raw).toBe('FIRST(d-[:Company]->.`Domains`)');
  });

  it('parses a parallel of two write arms', () => {
    const program = parseProgram(E2);
    const source = as(program.statements[0], 'await').await.source;
    if (source.kind !== 'combinator') throw new Error('expected a combinator source');
    expect(source.combinator.kind).toBe('parallel');
    const arms = source.combinator.arms;
    if (arms.kind !== 'literal') throw new Error('expected literal arms');
    expect(arms.arms).toHaveLength(2);
    const armBody = (index: number) => {
      const arm = arms.arms[index];
      if (arm.kind !== 'closure') throw new Error('expected a closure arm');
      return arm.closure.body;
    };
    const w1 = as(armBody(0)[0], 'write').write;
    expect(target(w1, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'team' }, hopsRaw: '-[:message]->' });
    expect(w1.fields[0].value.raw).toBe('"#deals"');
    const w2 = as(armBody(1)[0], 'write').write;
    expect(pred(w2.uniqueBy[0])).toBe('`name`');
  });

  it('refuses the retired parallel BLOCK with the combinator rewrite', () => {
    expect(() =>
      parseProgram('parallel {\n  write team-[:message]-> { channel: "#d" }\n}'),
    ).toThrow(/await parallel\(\[/);
  });

  it('refuses `all` by name, and says what replaced it', () => {
    expect(() => parseProgram('r = await all([f, g])')).toThrow(/`all` was replaced by `parallel`/);
  });
});

// ── §F — branching with type tests ──

const F1 = [
  'import { attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'crm = attio(credentials: acme_main)',
  '',
  'movement attio_to_kg(rec: <crm-[:record]->>) {',
  '  if rec IS <crm-[:company]->> {',
  '    write kg-[:company]-> { unique by (`domains`), name: rec.`Name`, domains: rec.`Domains` }',
  '  } else if rec IS <crm-[:person]->> AND EXISTS(rec-[:Company]->) {',
  '    write kg-[:person]-> { name: rec.`Name`, company: rec-[:Company]->.`Name` }',
  '  }',
  '}',
].join('\n');

describe('§F branching', () => {
  it('an if condition may wrap across lines', () => {
    const src = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main)',
      'movement m(rec: <crm-[:record]->>) {',
      '  if rec IS <crm-[:company]->>',
      '     AND EXISTS(rec-[:Company]->) {',
      '    write kg-[:company]-> { unique by (`name`) name: rec.`Name` }',
      '  }',
      '}',
    ].join('\n');
    const ifStmt = as(as(parseProgram(src).statements[3], 'movement').body[0], 'if');
    expect(ifStmt.arms[0].condition.raw.replace(/\s+/g, ' ')).toBe(
      'rec IS <crm-[:company]->> AND EXISTS(rec-[:Company]->)',
    );
  });

  it('parses if / else if with IS conditions captured raw', () => {
    const program = parseProgram(F1);
    const movement = as(program.statements[3], 'movement');
    const ifStmt = as(movement.body[0], 'if');
    expect(ifStmt.arms).toHaveLength(2);
    expect(ifStmt.arms[0].condition.raw).toBe('rec IS <crm-[:company]->>');
    expect(ifStmt.arms[1].condition.raw).toBe(
      'rec IS <crm-[:person]->> AND EXISTS(rec-[:Company]->)',
    );
    expect(ifStmt.elseArm).toBeUndefined();
    expect(as(ifStmt.arms[0].body[0], 'write').write.fields.map((f) => f.name)).toEqual([
      'name',
      'domains',
    ]);
    expect(as(ifStmt.arms[1].body[0], 'write').write.fields.map((f) => f.name)).toEqual([
      'name',
      'company',
    ]);
  });

  it('parses an else branch', () => {
    const program = parseProgram(
      'if a == 1 {\n  write kg-[:a]-> { x: 1 }\n} else {\n  write kg-[:b]-> { x: 2 }\n}',
    );
    const ifStmt = as(program.statements[0], 'if');
    expect(ifStmt.arms).toHaveLength(1);
    expect(ifStmt.elseArm?.body).toHaveLength(1);
  });
});

// ── §G — node declarations and composition ──

const G1 = [
  '# declarations/deals',
  '',
  'node Deal {',
  '  name:   <text>',
  '  amount: <number>',
  '  node participants {',
  '    name: <text>',
  '  }',
  '}',
].join('\n');

// The declaration WRITE is retired at CHECK time (wave 4) and still parsed here on
// purpose: a construct the grammar rejects can only be refused as a syntax
// error, and the refusal that teaches `node { … }` needs the parse to land.
const G2 = [
  'd = write Deal-[:round]-> { name: "Series A", amount: 5000000 }',
  'write d-[:participants]-> { name: "Acme Ventures" }',
].join('\n');

const G3 = [
  '# lib/file-routines',
  '',
  'import { dropbox } from adapters',
  'import { team_drive } from credentials',
  '',
  'node Files {',
  '  name: <text>',
  '  data: <file>',
  '}',
  '',
  'movement files_to_dropbox(f: <Files>) {',
  '  drive = dropbox(credentials: team_drive)',
  '  write drive-[:file]-> {',
  '    name: f.`name`',
  '    data: f.`data`',
  '  }',
  '}',
].join('\n');

const G4 = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  'import { files_to_dropbox, Files } from "lib/file-routines"',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  msg-[f:#resources]-> {',
  '    files_to_dropbox(f: write Files-[:file]-> { name: f.`filename`, data: f.`data` })',
  '  }',
  '}',
].join('\n');

describe('§G node declarations and composition', () => {
  it('parses the Deal declaration: the body IS the root node, nesting IS the edge', () => {
    const program = parseProgram(G1);
    const shape = as(program.statements[0], 'shape');
    expect(shape.name).toBe('Deal');
    expect(shape.root.name).toBe('Deal');
    expect(shape.root.fields).toMatchObject([
      { name: 'name', type: 'text' },
      { name: 'amount', type: 'number' },
    ]);
    expect(shape.root.children).toHaveLength(1);
    expect(shape.root.children[0].name).toBe('participants');
    expect(shape.root.children[0].fields).toMatchObject([{ name: 'name', type: 'text' }]);
    expect(shape.root.children[0].children).toEqual([]);
  });

  it('accepts a backtick-quoted top-level name, carrying spaces — same grammar as any other name', () => {
    const program = parseProgram(
      ['node `Multi Words` {', '  Name: <text>', '}'].join('\n'),
    );
    const shape = as(program.statements[0], 'shape');
    expect(shape.name).toBe('Multi Words');
    expect(shape.root.name).toBe('Multi Words');
  });

  it('a backtick-quoted single-word name is identical to the bare spelling', () => {
    const bare = as(parseProgram('node Deal {\n  name: <text>\n}').statements[0], 'shape');
    const backticked = as(
      parseProgram('node `Deal` {\n  name: <text>\n}').statements[0],
      'shape',
    );
    expect(backticked.name).toBe(bare.name);
    expect(backticked.root.name).toBe(bare.root.name);
  });

  it('a backtick-quoted nested name is the edge that reaches it, same as a bare child', () => {
    const program = parseProgram(
      [
        'node Deal {',
        '  name: <text>',
        '  node `Multi Words` {',
        '    label: <text>',
        '  }',
        '}',
      ].join('\n'),
    );
    const shape = as(program.statements[0], 'shape');
    expect(shape.root.children).toHaveLength(1);
    expect(shape.root.children[0].name).toBe('Multi Words');
    expect(shape.root.children[0].fields).toMatchObject([{ name: 'label', type: 'text' }]);
  });

  it('parses declaration writes: root write + linked write', () => {
    const program = parseProgram(G2);
    const d = rv(as(program.statements[0], 'assign').value, 'write').write;
    expect(target(d, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'Deal' }, hopsRaw: '-[:round]->' });
    expect(d.fields.map((f) => f.value.raw)).toEqual(['"Series A"', '5000000']);
    const linked = as(program.statements[1], 'write').write;
    expect(target(linked, 'linked').path).toMatchObject({
      root: { kind: 'name', name: 'd' },
      hopsRaw: '-[:participants]->',
    });
  });

  it('parses lib/file-routines: a flat declaration + movement constructing its target', () => {
    const program = parseProgram(G3);
    const shape = as(program.statements[2], 'shape');
    expect(shape.name).toBe('Files');
    expect(shape.root.fields).toHaveLength(2);
    expect(shape.root.children).toEqual([]);

    const movement = as(program.statements[3], 'movement');
    expect(movement.name).toBe('files_to_dropbox');
    expect(movement.params[0].type).toMatchObject({ graph: 'Files' });
    expect(typeNameOf(movement.params[0].type)?.hopsRaw).toBeUndefined();
    expect(movement.body).toHaveLength(2);
    const construct = rv(as(movement.body[0], 'assign').value, 'construct').construct;
    expect(construct.callee).toBe('dropbox');
    as(movement.body[1], 'write');
  });

  it('parses intake: a call with an inline declaration-write argument', () => {
    const program = parseProgram(G4);
    const fileImport = as(program.statements[2], 'import');
    expect(fileImport.names).toEqual([{ name: 'files_to_dropbox' }, { name: 'Files' }]);
    expect(fileImport.source).toEqual({ kind: 'file', path: 'lib/file-routines' });

    const movement = as(program.statements[4], 'movement');
    const block = as(movement.body[0], 'block').block;
    expect(block.head).toMatchObject({ root: { kind: 'name', name: 'msg' }, hopsRaw: '-[f:#resources]->' });
    const call = as(block.body[0], 'call');
    expect(call.callee).toBe('files_to_dropbox');
    expect(call.args).toHaveLength(1);
    const writeArg = arg(call.args[0], 'write').write;
    expect(target(writeArg, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'Files' }, hopsRaw: '-[:file]->' });
    expect(writeArg.fields.map((f) => f.name)).toEqual(['name', 'data']);
  });

  it('export marks movement and node declarations', () => {
    const program = parseProgram(
      [
        'export node Files {',
        '  name: <text>',
        '}',
        '',
        'export movement helper(f: <Files>) {',
        '  x = f.`name`',
        '}',
        '',
        'movement private_one(f: <Files>) {',
        '  y = f.`name`',
        '}',
      ].join('\n'),
    );
    expect(as(program.statements[0], 'shape')).toMatchObject({ name: 'Files', exported: true });
    expect(as(program.statements[1], 'movement')).toMatchObject({
      name: 'helper',
      exported: true,
    });
    expect(as(program.statements[2], 'movement').exported).toBeUndefined();
  });

  it("export before anything but a movement/node declaration errors with the fix", () => {
    expect(() => parseProgram('export x = 1')).toThrow(/export movement/);
  });
});

// `order by <sequencing>` after a NESTED node's closing `}` — the same clause
// (and the same three words) an entry's type marker takes, since a nested node
// has no marker of its own for the clause to trail.
describe('§G nested declared node can say its order', () => {
  it('a nested node followed by `order by arrival` carries it on the ShapeNode', () => {
    const program = parseProgram(
      ['node Entry {', '  name: <text>', '  node founder {', '    first: <text>', '  } order by arrival', '}'].join(
        '\n',
      ),
    );
    const shape = as(program.statements[0], 'shape');
    expect(shape.root.children).toHaveLength(1);
    expect(shape.root.children[0].name).toBe('founder');
    expect(shape.root.children[0].sequenced).toBe('arrival');
  });

  it('without the clause the nested node claims nothing — a SET, as before', () => {
    const program = parseProgram(
      ['node Entry {', '  name: <text>', '  node founder {', '    first: <text>', '  }', '}'].join('\n'),
    );
    const shape = as(program.statements[0], 'shape');
    expect(shape.root.children[0].sequenced).toBeUndefined();
  });

  it('the other two words parse too — an author collecting pieces already in that order', () => {
    for (const word of ['document', 'chronological'] as const) {
      const program = parseProgram(
        ['node Entry {', '  node founder {', `    first: <text>`, `  } order by ${word}`, '}'].join('\n'),
      );
      const shape = as(program.statements[0], 'shape');
      expect(shape.root.children[0].sequenced).toBe(word);
    }
  });

  it('nesting recurses — a doubly-nested node takes the clause on its own `}` too', () => {
    const program = parseProgram(
      [
        'node Deep {',
        '  name: <text>',
        '  node founder {',
        '    first: <text>',
        '    node profile {',
        '      url: <text>',
        '    } order by arrival',
        '  }',
        '}',
      ].join('\n'),
    );
    const shape = as(program.statements[0], 'shape');
    const founder = shape.root.children[0];
    expect(founder.sequenced).toBeUndefined();
    expect(founder.children[0].name).toBe('profile');
    expect(founder.children[0].sequenced).toBe('arrival');
  });

  it('a word that is not one of the three is refused, and the three are named', () => {
    expectParseError(
      ['node Entry {', '  node founder {', '    first: <text>', '  } order by newest', '}'].join('\n'),
      /'order by' takes one of 'arrival'.*'document'.*'chronological'/s,
    );
  });

  it("'order' with no 'by' is refused by name", () => {
    expectParseError(
      ['node Entry {', '  node founder {', '    first: <text>', '  } order arrival', '}'].join('\n'),
      /written 'order by'/,
    );
  });

  it('the clause is same-line only — on the next line it starts the next entry, and a bare name errors as one', () => {
    expectParseError(
      [
        'node Entry {',
        '  node founder {',
        '    first: <text>',
        '  }',
        '  order by arrival',
        '}',
      ].join('\n'),
      /the field name 'order'/,
    );
  });
});

// One keyword, two positions, and each refuses the other's spelling: NAMED with
// type annotations DECLARES a structure; ANONYMOUS with values BUILDS a record.
describe('declaration vs literal — the two positions of `node`', () => {
  it("retires the 'shape' keyword, pointing at the node declaration", () => {
    expectParseError(
      'shape Deal {\n  name: <text>\n}',
      /'shape' is not a statement[\s\S]*node <name>/,
    );
  });

  it('an anonymous literal in declaration position is refused, and named', () => {
    expectParseError('node {\n  name: "x"\n}', /literal builds a record[\s\S]*name it/);
  });

  it('a NAMED node where a value belongs is refused', () => {
    expectParseError(
      'movement m(e: <inbox-[:message]->>) {\n  d = node Deal { name: "x" }\n}',
      /named node DECLARES a structure[\s\S]*node \{ … \}/,
    );
    expectParseError(
      'movement m(e: <inbox-[:message]->>) {\n  takes(d: node Deal { name: "x" })\n}',
      /named node DECLARES a structure/,
    );
  });

  it("an 'edge' line inside a declaration points at nesting", () => {
    expectParseError(
      'node Deal {\n  edge item -[:company]-> org\n}',
      /'edge' lines are retired[\s\S]*nesting IS the edge/,
    );
  });

  it('an ANONYMOUS nested node inside a declaration is refused — the name is the edge', () => {
    expectParseError(
      'node Deal {\n  name: <text>\n  node { other: <text> }\n}',
      /is NAMED, and its name is the relationship/,
    );
  });
});

// ── §H — imports (bonus coverage: all four sources) ──

const H1 = [
  'import { attio, dropbox } from adapters',
  'import { acme_main, team_drive } from credentials',
  'import { vc_url_retrieval } from plugins',
  'import { files_to_dropbox, Files } from "lib/file-routines"',
  'import { Deal } from "shapes/deals"',
].join('\n');

describe('§H imports', () => {
  it('parses all four import sources', () => {
    const program = parseProgram(H1);
    expect(program.statements).toHaveLength(5);
    const sources = program.statements.map((s) => as(s, 'import').source);
    expect(sources).toEqual([
      { kind: 'builtin', namespace: 'adapters' },
      { kind: 'builtin', namespace: 'credentials' },
      { kind: 'builtin', namespace: 'plugins' },
      { kind: 'file', path: 'lib/file-routines' },
      { kind: 'file', path: 'shapes/deals' },
    ]);
  });

  it('parses aliased imports — `name as alias` is one entry', () => {
    const program = parseProgram(
      [
        'import { acme_main as crm_creds, team_drive } from credentials',
        'import { files_to_dropbox as ship_files } from "lib/file-routines"',
      ].join('\n'),
    );
    expect(program.statements).toHaveLength(2);
    const credentials = as(program.statements[0], 'import');
    expect(credentials.names).toEqual([
      { name: 'acme_main', alias: 'crm_creds' },
      { name: 'team_drive' },
    ]);
    const file = as(program.statements[1], 'import');
    expect(file.names).toEqual([{ name: 'files_to_dropbox', alias: 'ship_files' }]);
    expect(file.source).toEqual({ kind: 'file', path: 'lib/file-routines' });
  });

  it('parses a backtick-quoted credential import name', () => {
    const program = parseProgram('import { `Dev-loop Granola` } from credentials');
    expect(program.statements[0]).toMatchObject({
      kind: 'import',
      names: [{ name: 'Dev-loop Granola' }],
      source: { kind: 'builtin', namespace: 'credentials' },
    });
  });

  it('parses a backtick credential import with a bare alias', () => {
    const program = parseProgram('import { `Dev-loop Granola` as granola_cred } from credentials');
    expect(program.statements[0]).toMatchObject({
      kind: 'import',
      names: [{ name: 'Dev-loop Granola', alias: 'granola_cred' }],
      source: { kind: 'builtin', namespace: 'credentials' },
    });
  });
});

// ── §I — worked examples ──

const I1 = [
  'import { email, attio, slack, affinity } from adapters',
  'import { dealflow_inbox, acme_main, acme_workspace, acme_affinity } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
  'aff   = affinity(credentials: acme_affinity)',
  '',
  'company_prompt = "the company name this email is about.',
  '  Prefer the legal entity name over the brand name;',
  "  ignore the sender's own firm.\"",
  '',
  'movement dealflow_intake(msg: <inbox-[:message]->>) {',
  '',
  '  company = write crm-[:company]-> {',
  '    unique by (`domains`)',
  '    name:    AI(company_prompt)',
  '    domains: [msg-[:sender]->.`domain`]',
  '  }',
  '',
  '  await parallel([',
  '    () => {',
  '      write team-[:message]-> {',
  '        channel: "#dealflow"',
  '        text:    "New deal from ${msg-[:sender]->.`name`}: ${company.`url`}"',
  '      }',
  '    },',
  '    () => {',
  '      write aff-[:organization]-> {',
  '        unique by (`name`)',
  '        name:      company.`name`',
  '        attio_url: company.`url`',
  '      }',
  '    },',
  '  ])',
  '}',
].join('\n');

const I2 = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  'import { vc_url_retrieval } from plugins',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  '',
  'movement log_dealflow(msg: <inbox-[:message]->>) {',
  '',
  '  deals = extract from [msg.`text`, msg-[:files]->.`data`] {',
  '    node company: "each company seeking investment in this message" {',
  "      name: \"the company's name\"",
  '      urls: "URLs in the message associated with this company"',
  '    } through [vc_url_retrieval(urls: urls)] {',
  "      name: \"the company's name\"",
  '',
  '      node round: "the funding round this company is raising" {',
  "        stage:  \"the round's stage, e.g. Seed, Series A\"",
  '        node investor: "each investor participating in this round" {',
  '          name: "investor name"',
  '          lead: "whether this investor is leading the round"',
  '        }',
  '      }',
  '    }',
  '  }',
  '',
  '  deals-[c:company]-> {',
  '    co = write kg-[:company]-> {',
  '      unique by (`name`)',
  '      name: c.`name`',
  '    }',
  '',
  '    c-[r:round]-> {',
  '      fr = write co-[:rounds]-> {',
  '        unique by (co AND `stage`)',
  '        stage: r.`stage`',
  '      }',
  '',
  '      r-[i:investor]-> {',
  '        write fr-[:participants]-> {',
  '          unique by (fr AND `investor_name`)',
  '          investor_name: i.`name`',
  '          lead:          i.`lead`',
  '        }',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

describe('§I worked examples', () => {
  it('parses dealflow_intake end to end', () => {
    const program = parseProgram(I1);
    // 2 imports + 4 constructions + company_prompt + 1 movement
    expect(program.statements).toHaveLength(8);

    expect(as(program.statements[0], 'import').names).toHaveLength(4);
    expect(as(program.statements[1], 'import').names).toHaveLength(4);

    const constructions = program.statements.slice(2, 6).map((s) => {
      const assign = as(s, 'assign');
      return { name: assign.name, callee: rv(assign.value, 'construct').construct.callee };
    });
    expect(constructions).toEqual([
      { name: 'inbox', callee: 'email' },
      { name: 'crm', callee: 'attio' },
      { name: 'team', callee: 'slack' },
      { name: 'aff', callee: 'affinity' },
    ]);

    // a multiline string is a plain value binding
    const prompt = rv(as(program.statements[6], 'assign').value, 'expr').expr;
    expect(prompt.raw.startsWith('"the company name this email is about.')).toBe(true);
    expect(prompt.raw).toContain('\n');
    expect(prompt.raw.endsWith('"')).toBe(true);

    const movement = as(program.statements[7], 'movement');
    expect(movement.name).toBe('dealflow_intake');
    expect(movement.params).toHaveLength(1);
    expect(movement.params[0].type).toMatchObject({ graph: 'inbox', position: 'message' });
    expect(movement.body).toHaveLength(2);

    const companyAssign = as(movement.body[0], 'assign');
    expect(companyAssign.name).toBe('company');
    const companyWrite = rv(companyAssign.value, 'write').write;
    expect(target(companyWrite, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'crm' }, hopsRaw: '-[:company]->' });
    expect(pred(companyWrite.uniqueBy[0])).toBe('`domains`');

    const source = as(movement.body[1], 'await').await.source;
    if (source.kind !== 'combinator') throw new Error('expected a combinator source');
    const arms = source.combinator.arms;
    if (arms.kind !== 'literal') throw new Error('expected literal arms');
    expect(arms.arms).toHaveLength(2);
    const armBody = (index: number) => {
      const arm = arms.arms[index];
      if (arm.kind !== 'closure') throw new Error('expected a closure arm');
      return arm.closure.body;
    };
    const slackWrite = as(armBody(0)[0], 'write').write;
    expect(target(slackWrite, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'team' }, hopsRaw: '-[:message]->' });
    expect(slackWrite.fields[1].value.raw).toBe(
      '"New deal from ${msg-[:sender]->.`name`}: ${company.`url`}"',
    );
    const affWrite = as(armBody(1)[0], 'write').write;
    expect(target(affWrite, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'aff' }, hopsRaw: '-[:organization]->' });
    expect(affWrite.fields.map((f) => f.name)).toEqual(['name', 'attio_url']);
  });

  it('parses log_dealflow: extract tree then nested write mapping', () => {
    const program = parseProgram(I2);
    expect(program.statements).toHaveLength(5);
    const movement = as(program.statements[4], 'movement');
    expect(movement.body).toHaveLength(2);

    // extraction tree
    const extract = rv(as(movement.body[0], 'assign').value, 'extract').extract;
    expect(extract.from.map((f) => f.raw)).toEqual(['msg.`text`', 'msg-[:files]->.`data`']);
    expect(extract.stages).toHaveLength(1);
    expect(extract.stages[0].through).toBeUndefined();

    const company = extract.stages[0].children[0];
    expect(company.stages).toHaveLength(2);
    expect(company.stages[0].fields.map((f) => f.name)).toEqual(['name', 'urls']);
    expect(company.stages[1].through?.map((p) => p.plugin)).toEqual(['vc_url_retrieval']);
    expect(company.stages[1].through?.[0].args).toHaveLength(1);
    expect(company.stages[1].fields.map((f) => f.name)).toEqual(['name']);

    const round = company.stages[1].children[0];
    expect(round.name).toBe('round');
    expect(round.stages[0].fields.map((f) => f.name)).toEqual(['stage']);
    const investor = round.stages[0].children[0];
    expect(investor.stages[0].fields.map((f) => f.name)).toEqual(['name', 'lead']);

    // write mapping mirrors the nesting
    const companyBlock = as(movement.body[1], 'block').block;
    expect(companyBlock.head).toMatchObject({ root: { kind: 'name', name: 'deals' }, hopsRaw: '-[c:company]->' });
    const coAssign = as(companyBlock.body[0], 'assign');
    expect(coAssign.name).toBe('co');

    const roundBlock = as(companyBlock.body[1], 'block').block;
    expect(roundBlock.head).toMatchObject({ root: { kind: 'name', name: 'c' }, hopsRaw: '-[r:round]->' });
    const frWrite = rv(as(roundBlock.body[0], 'assign').value, 'write').write;
    expect(target(frWrite, 'linked').path).toMatchObject({ root: { kind: 'name', name: 'co' }, hopsRaw: '-[:rounds]->' });
    expect(pred(frWrite.uniqueBy[0])).toBe('co AND `stage`');

    const investorBlock = as(roundBlock.body[1], 'block').block;
    expect(investorBlock.head).toMatchObject({ root: { kind: 'name', name: 'r' }, hopsRaw: '-[i:investor]->' });
    const partWrite = as(investorBlock.body[0], 'write').write;
    expect(target(partWrite, 'linked').path.root).toEqual({ kind: 'name', name: 'fr' });
    expect(pred(partWrite.uniqueBy[0])).toBe('fr AND `investor_name`');
    expect(partWrite.fields.map((f) => f.name)).toEqual(['investor_name', 'lead']);
  });
});

// ── Error cases ──

describe('parse errors', () => {
  it('reports an unterminated string at its opening quote', () => {
    const err = expectParseError('x = "abc', /Unterminated string/);
    expect(err.loc).toEqual({ line: 1, col: 5 });
  });

  it('reports an unterminated multiline string', () => {
    expectParseError('prompt = "line one\nline two\n', /Unterminated string/);
  });

  it('reports an unbalanced brace at the block opener', () => {
    const err = expectParseError(
      'movement m(p: <kg-[:node]->>) {\n  x = 1\n',
      /Expected '\}' to close the movement 'm'/,
    );
    expect(err.loc).toEqual({ line: 1, col: 31 });
  });

  it('reports an unbalanced paren inside an expression', () => {
    const err = expectParseError('x = (1 + 2', /Unbalanced '\('/);
    expect(err.loc).toEqual({ line: 1, col: 5 });
  });

  it('reports a mismatched closer against its opener', () => {
    expectParseError('x = (1 + 2]', /Expected '\)' to close the '\('/);
  });

  it('rejects an unknown import namespace', () => {
    const err = expectParseError(
      'import { x } from unknown_namespace',
      /Unknown import source 'unknown_namespace'/,
    );
    expect(err.loc).toEqual({ line: 1, col: 19 });
  });

  it('rejects a garbage write target', () => {
    expectParseError('write 123 { }', /Expected a write target after 'write'/);
    // `write crm` is now a valid bare-alias (position) target, so trailing
    // garbage after it is a missing-body error rather than a bad target.
    expectParseError('write crm company { }', /Expected '\{' to open the write body/);
  });

  it('rejects an extract field with no description', () => {
    const err = expectParseError(
      'd = extract from [x] {\n  name:\n}',
      /description for the extract field 'name'/,
    );
    expect(err.loc.line).toBe(2);
  });

  it('rejects an extract node with no description', () => {
    expectParseError(
      'd = extract from [x] {\n  node company: {\n  }\n}',
      /Expected a double-quoted description for the node 'company'/,
    );
  });

  it('reports an unterminated backtick name', () => {
    expectParseError('x = msg.`subject\n', /Unterminated backtick-quoted name/);
  });

  it("rejects 'else' without an 'if'", () => {
    expectParseError('else {\n}', /'else' without a preceding 'if'/);
  });

  it('rejects a bare extract statement', () => {
    expectParseError('extract from [x] { name: "y" }', /must be bound to a name/);
  });
});

// `?:` is EXCLUSIVELY the write-body set-if-empty marker. Reached for anywhere
// else (a Kotlin/Groovy Elvis) it must name the real semantics and the fixes,
// not fall through to a generic "unexpected '?'" or a bridge parse failure.
describe("'?:' Elvis misuse outside a write body", () => {
  const NAMES_MARKER = /`\?:` is the set-if-empty write-field marker/;
  const OFFERS_FIXES = /use `COALESCE\(a, b\)`; to branch, use an `if` block/;

  it('diagnoses `?:` in an assignment RHS (`x = a ?: b`)', () => {
    const err = expectParseError('x = a ?: b', NAMES_MARKER);
    expect(err.message).toMatch(OFFERS_FIXES);
  });

  it('diagnoses the Kotlin block-Elvis form (`x = value ?: { … }`)', () => {
    expectParseError('x = value ?: { y }', NAMES_MARKER);
  });

  it('diagnoses `?:` in a statement head (`a ?: { … }`)', () => {
    expectParseError('a ?: { y }', NAMES_MARKER);
  });

  it('diagnoses `?:` inside a call argument (`f(a ?: b)`)', () => {
    expectParseError('m(x: a ?: b)', NAMES_MARKER);
  });

  it('still parses `?:` in a write body across all four ladder forms', () => {
    const program = parseProgram(
      [
        'write crm-[:company]-> {',
        '  name:        m.`subject`',
        '  summary ?:   m.`text`',
        '  tags +:      ["a"]',
        '  domains +?:  ["b"]',
        '}',
      ].join('\n'),
    );
    const write = as(program.statements[0], 'write').write;
    expect(write.fields.map((f) => ({ name: f.name, semantics: f.semantics }))).toEqual([
      { name: 'name', semantics: undefined },
      { name: 'summary', semantics: 'fill' },
      { name: 'tags', semantics: 'append' },
      { name: 'domains', semantics: 'append-missing' },
    ]);
  });
});

// ── listen — file-level listener declarations ──

describe('listen statements', () => {
  it('parses `listen to <instance> { config } fire <movement>`', () => {
    const program = parseProgram(
      [
        'inbox = email(credentials: dealflow_inbox)',
        'listen to inbox { key: "dealflow" } fire dealflow_intake',
      ].join('\n'),
    );
    const listen = as(program.statements[1], 'listen');
    expect(listen.instance).toBe('inbox');
    expect(listen.movement).toBe('dealflow_intake');
    expect(listen.config).toHaveLength(1);
    expect(listen.config[0].name).toBe('key');
    expect(listen.config[0].value.raw).toBe('"dealflow"');
    expect(listen.span.start.line).toBe(2);
  });

  it('parses a config-free listen', () => {
    const program = parseProgram('listen to inbox fire intake');
    const listen = as(program.statements[0], 'listen');
    expect(listen.instance).toBe('inbox');
    expect(listen.movement).toBe('intake');
    expect(listen.config).toEqual([]);
  });

  it('parses multiple config entries, comma- or newline-separated', () => {
    const inline = as(
      parseProgram('listen to chat { channel: "#deals", thread: TRUE } fire intake').statements[0],
      'listen',
    );
    expect(inline.config.map(c => c.name)).toEqual(['channel', 'thread']);
    expect(inline.config[1].value.raw).toBe('TRUE');

    const multiline = as(
      parseProgram(
        ['listen to chat {', '  channel: "#deals"', '  thread: TRUE', '} fire intake'].join('\n'),
      ).statements[0],
      'listen',
    );
    expect(multiline.config.map(c => c.name)).toEqual(['channel', 'thread']);
  });

  // The grammar still ACCEPTS an angle-bracketed config value, and must: the
  // `isType` slot is what lets the checker reject it by name and hand back the
  // quoted rewrite (MOV_LISTEN_BAD_CONFIG). No listen config takes a type any
  // more — this is the parse half of a rejection, not a blessed spelling.
  it('parses an angle-bracketed config value into the isType slot', () => {
    const program = parseProgram(
      [
        'listen to kg { type: <company>, changes: ["create", "update"], fields: [domains] } fire on_company_change',
      ].join('\n'),
    );
    const listen = as(program.statements[0], 'listen');
    expect(listen.instance).toBe('kg');
    expect(listen.movement).toBe('on_company_change');
    expect(listen.config.map(c => c.name)).toEqual(['type', 'changes', 'fields']);
    // The AST stores the unbracketed spelling; `isType` marks the slot.
    expect(listen.config[0].value.raw).toBe('company');
    expect(listen.config[0].isType).toBe(true);
    expect(listen.config[1].value.raw).toBe('["create", "update"]');
    expect(listen.config[1].isType).toBeUndefined();
    expect(listen.config[2].value.raw).toBe('[domains]');
  });

  it('parses a newline-separated config block, isType slot and all', () => {
    const listen = as(
      parseProgram(
        [
          'listen to kg {',
          '  type: <company>',
          '  changes: ["update"]',
          '} fire on_company_change',
        ].join('\n'),
      ).statements[0],
      'listen',
    );
    expect(listen.config.map(c => c.name)).toEqual(['type', 'changes']);
    expect(listen.config[0].isType).toBe(true);
  });

  it('rejects an unterminated angle-bracketed value in listener config', () => {
    expectParseError(
      'listen to kg { type: <company fire intake',
      /to close the type/,
    );
  });

  it('parses several listens in one file', () => {
    const program = parseProgram(
      [
        'listen to inbox { key: "dealflow" } fire intake',
        'listen to inbox { key: "intros" } fire intake',
        'listen to crm fire sync',
      ].join('\n'),
    );
    expect(program.statements.map(s => s.kind)).toEqual(['listen', 'listen', 'listen']);
  });
});

describe('listen alias (leading `as "…"`)', () => {
  const listenOf = (src: string) =>
    parseProgram(src).statements.find((s) => s.kind === 'listen') as any;

  it('parses a leading alias before `to`', () => {
    const src = 'g = granola()\nmovement m(x: <g-[:invocation]->>) {}\nlisten as "Alice\'s meetings" to g {} fire m';
    expect(listenOf(src).alias).toBe("Alice's meetings");
    expect(listenOf(src).instance).toBe('g');
    expect(listenOf(src).movement).toBe('m');
  });

  it('absent alias leaves alias undefined', () => {
    const src = 'g = granola()\nmovement m(x: <g-[:invocation]->>) {}\nlisten to g {} fire m';
    expect(listenOf(src).alias).toBeUndefined();
  });
});

describe('listen statements (continued)', () => {
  it("requires 'to' after 'listen'", () => {
    expectParseError('listen inbox fire intake', /Expected 'to' after 'listen'/);
  });

  it("requires 'fire' after the instance/config", () => {
    expectParseError('listen to inbox intake', /Expected 'fire' after 'listen to inbox'/);
    expectParseError(
      'listen to inbox { key: "x" } intake',
      /Expected 'fire' after 'listen to inbox \{ … \}'/,
    );
  });

  it('requires a movement name after fire', () => {
    expectParseError('listen to inbox fire', /Expected a movement name after 'fire'/);
  });

  it('reports an unterminated config block at its brace', () => {
    const err = expectParseError(
      'listen to inbox { key: "x"\n',
      /Expected '\}' to close the listener config/,
    );
    expect(err.loc).toEqual({ line: 1, col: 17 });
  });

  it('parses a backtick-quoted movement name at declaration and fire site', () => {
    const src = [
      'import { manual } from adapters',
      'ga = manual()',
      'movement `Sweep Intake`(x: <ga-[:invocation]->>) {}',
      'listen as "Lane A" to ga {} fire `Sweep Intake`',
    ].join('\n');
    const program = parseProgram(src);
    const movement = program.statements.find((s) => s.kind === 'movement');
    expect(movement).toMatchObject({ kind: 'movement', name: 'Sweep Intake' });
    const listen = program.statements.find((s) => s.kind === 'listen');
    expect(listen).toMatchObject({ kind: 'listen', movement: 'Sweep Intake' });
  });

  it('still parses a bare movement name (back-compat)', () => {
    const program = parseProgram('movement sweep_intake() {}');
    expect(program.statements[0]).toMatchObject({ kind: 'movement', name: 'sweep_intake' });
  });
});

// ── `run` is retired — `listen` is the only invoker ──

describe('run retirement', () => {
  it('rejects the run statement with the manual-listener fix-it', () => {
    const err = expectParseError(
      'run backfill(root: crm)',
      /'run' is not a statement — movements are invoked only by listeners/,
    );
    expect(err.message).toContain('listen to go {} fire <movement>');
    expect(err.loc).toEqual({ line: 1, col: 1 });
  });

  it('points schedules at the cron channel', () => {
    expectParseError('run tidy()', /timer = cron\(\)/);
  });
});

// ── Inline channel constructions (`listen to manual() {} fire …`) ──
// These now-rejected forms still PARSE (the call lands in `construct`) so the
// CHECKER can point at the named-construction fix rather than the parser
// emitting a confusing "expected fire". See the checker's
// MOV_ADAPTER_NOT_CONSTRUCTED tests for the rejection.

describe('inline-construction listens (parsed, rejected by the checker)', () => {
  it('parses `listen to manual() {} fire backfill`', () => {
    const program = parseProgram('listen to manual() {} fire backfill');
    const listen = as(program.statements[0], 'listen');
    expect(listen.instance).toBe('manual');
    expect(listen.construct).toMatchObject({ callee: 'manual', args: [] });
    expect(listen.config).toEqual([]);
    expect(listen.movement).toBe('backfill');
  });

  it('parses construction args and listener config together', () => {
    const listen = as(
      parseProgram('listen to cron() { schedule: "0 9 * * 1" } fire digest').statements[0],
      'listen',
    );
    expect(listen.construct).toMatchObject({ callee: 'cron', args: [] });
    expect(listen.config).toHaveLength(1);
    expect(listen.config[0].name).toBe('schedule');
    expect(listen.config[0].value.raw).toBe('"0 9 * * 1"');
  });

  it('a named-instance listen carries no construct', () => {
    const listen = as(
      parseProgram('listen to inbox { key: "deals" } fire intake').statements[0],
      'listen',
    );
    expect(listen.construct).toBeUndefined();
  });

  it('reports an unterminated inline construction', () => {
    expectParseError('listen to manual( {} fire x', /a construction argument of 'manual'/);
  });
});

// ── The universal type marker (`<…>`) and named call arguments ──
// 3_syntax_sketch.md "Types wear angle brackets; calls name their
// arguments" (2026-06-11). Every type slot requires `<…>`; bare spellings
// error with the bracketed fix-it; calls and runs name every argument.

describe('type markers (every type slot wears angle brackets)', () => {
  const FIXIT = /wrap the type in angle brackets: /;

  it('movement parameters: bare types get the bracketed fix-it, spelled as an address', () => {
    const err = expectParseError(
      'movement m(msg: inbox.message) {\n  …\n}',
      /write it as: <inbox-\[:message\]->>/,
    );
    expect(err.loc).toEqual({ line: 1, col: 17 });
    expectParseError('movement m(root: crm) {\n  …\n}', /wrap the type in angle brackets: <crm>/);
  });

  it('movement parameters: the meta-position form `<crm>` parses', () => {
    const program = parseProgram('movement m(root: <crm>) {\n  …\n}');
    const movement = as(program.statements[0], 'movement');
    expect(typeNameOf(movement.params[0].type)?.graph).toBe('crm');
    expect(typeNameOf(movement.params[0].type)?.position).toBeUndefined();
    expect(typeNameOf(movement.params[0].type)?.hopsRaw).toBeUndefined();
  });

  it('movement parameters: the dotted form is a parse error with the exact address replacement', () => {
    const err = expectParseError(
      'movement m(msg: <inbox.message>) {\n  …\n}',
      /'\.' reads a property — a type names an EDGE, and an edge is an address\. Write '<inbox-\[:message\]->>' instead of '<inbox\.message>'\./,
    );
    expect(err.loc).toEqual({ line: 1, col: 17 });
    // Backticked segments keep the author's spelling in the replacement.
    expectParseError(
      'movement m(e: <at.`Record Created`>) {\n  …\n}',
      /Write '<at-\[:`Record Created`\]->>' instead of '<at\.`Record Created`>'\./,
    );
  });

  it('movement parameters: a three-segment dotted type is rejected (a position, not a field)', () => {
    expectParseError(
      'movement m(x: <crm.company.funding_stage>) {\n  …\n}',
      /'\.' reads a property — a type is a single name or an address \('<crm-\[:…\]->>'\)/,
    );
  });

  it('declared fields: bare primitive and borrowed types get the fix-it', () => {
    expectParseError('node S {\n  name: text\n}', /wrap the type in angle brackets: <text>/);
    expectParseError(
      'node S {\n  stage: crm.companies.funding_stage\n}',
      /write it as: <crm-\[:companies\]->\.`funding_stage`>/,
    );
  });

  it('declared fields: the dotted borrowed form errors with the hop-then-property replacement', () => {
    expectParseError(
      'node S {\n  stage: <crm.companies.funding_stage>\n}',
      /'\.' reads a property — the middle of a borrowed type is an EDGE\. Write '<crm-\[:companies\]->\.`funding_stage`>' instead of '<crm\.companies\.funding_stage>'\./,
    );
  });

  it('declared fields: the borrowed hop-then-property form parses to the resolver segments', () => {
    const program = parseProgram(
      'node S {\n  stage: <crm-[:companies]->.`funding_stage`>\n}',
    );
    const shape = as(program.statements[0], 'shape');
    expect(shape.root.fields[0].type).toBe('crm.companies.funding_stage');
  });

  it('declared fields: a borrowed hop with no property tail names no field — parse error', () => {
    expectParseError(
      'node S {\n  stage: <crm-[:companies]->>\n}',
      /A borrowed type names a FIELD — add the property tail: <crm-\[:companies\]->\.`field`>/,
    );
  });

  it('extract field annotations: bare types get the fix-it', () => {
    expectParseError(
      'd = extract from [x] {\n  amount: number "the amount"\n}',
      /wrap the type in angle brackets: <number>/,
    );
  });

  it('linked-write explicit types: bare types get the fix-it', () => {
    expectParseError('write fr-[:related]->company { name: "x" }', FIXIT);
  });

  it('tuple-write explicit types: bare types get the fix-it', () => {
    expectParseError('write (a-[:rel]->, b-[:rel]->) note { text: "x" }', /wrap the type in angle brackets: <note>/);
  });

  it('match explicit types: bare types get the fix-it, the bracketed form parses', () => {
    expectParseError('p = match c-[:related]->company { unique by (`name`), name: "x" }', /wrap the type in angle brackets: <company>/);
    const program = parseProgram('p = match c-[:related]-> <company> { unique by (`name`), name: "x" }');
    const match = rv(as(program.statements[0], 'assign').value, 'match').match;
    expect(match.target).toMatchObject({ kind: 'linked', explicitType: 'company' });
  });

  it('an unclosed type marker is reported at the missing `>`', () => {
    expectParseError('movement m(msg: <inbox-[:message]->) {\n  …\n}', /Expected '>' to close the type/);
  });
});

describe('named call arguments (parens = callable arguments, always named)', () => {
  it('a call names each argument; the AST carries the names', () => {
    const program = parseProgram('movement m(msg: <inbox-[:message]->>) {\n  send(f: msg, note: "hi")\n}');
    const call = as(as(program.statements[0], 'movement').body[0], 'call');
    expect(call.args.map(a => a.name)).toEqual(['f', 'note']);
  });

  it('an inline write argument is named like any other', () => {
    const program = parseProgram(
      'movement m(msg: <inbox-[:message]->>) {\n  send(f: write Files-[:file]-> { name: msg.`subject` })\n}',
    );
    const call = as(as(program.statements[0], 'movement').body[0], 'call');
    expect(call.args[0].name).toBe('f');
    expect(call.args[0].kind).toBe('write');
  });

  it('positional arguments parse, unnamed, in order', () => {
    const program = parseProgram(
      'movement m(msg: <inbox-[:message]->>) {\n  send(msg, write Files-[:file]-> { name: "x" })\n}',
    );
    const call = as(as(program.statements[0], 'movement').body[0], 'call');
    expect(call.args.map(arg => [arg.kind, arg.name])).toEqual([
      ['expr', undefined],
      ['write', undefined],
    ]);
  });

  it('a call mixing positional and named arguments is a parse error', () => {
    expectParseError(
      'movement m(msg: <inbox-[:message]->>) {\n  send(msg, to: "x")\n}',
      /The arguments to 'send' are positional, and 'to:' names this one/,
    );
    expectParseError(
      'movement m(msg: <inbox-[:message]->>) {\n  send(to: "x", msg)\n}',
      /The arguments to 'send' are named, and this one isn't/,
    );
  });

  it('run is rejected before its arguments parse', () => {
    expectParseError('run backfill(crm)', /'run' is not a statement/);
  });
});

// ── general rule: every user-coined name is backtickable ──
//
// `node <Name>` went first (readName + atNodeDeclaration's lookahead); this
// sweep extends the same reader to every other name a user coins — binding
// names, import aliases, listen instance names, and movement parameter/call
// argument names — leaving the language's actual keywords (recognised bare
// only) as the sole structural tokens.

describe('backtick-quoted names — the general rule', () => {
  it('a backtick-led statement dispatches through the same forms as a bare one', () => {
    const program = parseProgram(
      ['`my thing` = 1', '`my call`()', '`my root`-[:edge]-> {\n  …\n}'].join('\n'),
    );
    expect(as(program.statements[0], 'assign').name).toBe('my thing');
    expect(as(program.statements[1], 'call').callee).toBe('my call');
    expect(as(program.statements[2], 'block').block.head).toMatchObject({
      root: { kind: 'name', name: 'my root' },
      hopsRaw: '-[:edge]->',
    });
  });

  it('a backtick-quoted legacy-keyword-shaped name is an ordinary NAME, not the retired construct', () => {
    // Bare `ask`/`fallback`/`sleep` at a statement head hit the retired-construct
    // notices; backtick-quoted, they are just names and dispatch like any other.
    const program = parseProgram('`ask`()');
    expect(as(program.statements[0], 'call').callee).toBe('ask');
  });

  it('a bare dangling `ask` still gets the legacy-retirement notice, but a backtick-quoted one does not', () => {
    // Neither is `=`, `(`, nor `-[…]->` led, so both fall to the statement's
    // final check — which must special-case the retirement notice ONLY for the
    // bare spelling (a backtick-quoted name is unambiguously a NAME, and a
    // dangling name is just an incomplete statement, not the retired form).
    expectParseError('ask', /`ask` statement was replaced by the ask adapter/);
    expectParseError(
      '`ask`',
      /Unexpected end of file after 'ask' — expected '=' \(binding\), '\(' \(a call\), or '-\[…\]->' \(a traversal\)/,
    );
  });

  it('parses a backtick-quoted import alias', () => {
    const program = parseProgram('import { acme_main as `crm creds` } from credentials');
    expect(program.statements[0]).toMatchObject({
      kind: 'import',
      names: [{ name: 'acme_main', alias: 'crm creds' }],
    });
  });

  it('a backtick-quoted movement parameter is callable by the same backtick-quoted argument name', () => {
    const program = parseProgram(
      ['movement m(`my param`: <text>) {', '  send(`my param`: 1)', '}'].join('\n'),
    );
    const movement = as(program.statements[0], 'movement');
    expect(movement.params[0].name).toBe('my param');
    const call = as(movement.body[0], 'call');
    expect(call.args[0].name).toBe('my param');
  });

  it('a backtick-quoted binding is a valid write target (position + linked), delete/refresh handle, and inline-block binding', () => {
    const program = parseProgram(
      [
        '`my deal` = write crm-[:company]-> { name: "Acme" }',
        'write `my deal` { name: "Acme 2" }',
        'refresh `my deal`',
        'delete `my deal`',
        'x = {\n  `my deal` = 1\n}.`my deal`',
      ].join('\n'),
    );
    const assignWrite = rv(as(program.statements[0], 'assign').value, 'write').write;
    expect(target(assignWrite, 'linked').path.root).toEqual({ kind: 'name', name: 'crm' });
    const positionWrite = as(program.statements[1], 'write').write;
    expect(target(positionWrite, 'position').root).toEqual({ kind: 'name', name: 'my deal' });
    expect(as(program.statements[2], 'refresh').name).toBe('my deal');
    expect(as(program.statements[3], 'delete').name).toBe('my deal');
    const inlineBlock = rv(as(program.statements[4], 'assign').value, 'inlineBlock').inlineBlock;
    expect(inlineBlock.binding).toBe('my deal');
  });

  it('parses backtick-quoted link/unlink source and target handles, and a listen instance name', () => {
    const program = parseProgram(
      [
        'import { manual } from adapters',
        '`my channel` = manual()',
        '`my deal` = manual()',
        'link `my channel` -[:owns]-> `my deal`',
        'unlink `my channel` -[:owns]-> `my deal`',
        'listen to `my channel` {} fire sweep',
        'movement sweep() {}',
      ].join('\n'),
    );
    const link = as(program.statements[3], 'link').link;
    expect(link.from).toBe('my channel');
    expect(link.to).toEqual({ kind: 'handle', name: 'my deal' });
    const unlink = as(program.statements[4], 'unlink');
    expect(unlink).toMatchObject({ from: 'my channel', edge: 'owns', to: 'my deal' });
    const listen = as(program.statements[5], 'listen');
    expect(listen.instance).toBe('my channel');
  });
});

describe('match — the identity half of a write, on its own', () => {
  it('binds a match over a hop, with two OR-ed unique by clauses', () => {
    const program = parseProgram(
      [
        'existing = match source-[:val]-> {',
        '  unique by (FUZZY `name`)',
        '  unique by (`website`)',
        '  name: extractedName',
        '  website: extractedWebsite',
        '}',
      ].join('\n'),
    );
    const assign = as(program.statements[0], 'assign');
    expect(assign.name).toBe('existing');
    const match = rv(assign.value, 'match').match;
    expect(match.target).toMatchObject({ kind: 'linked', path: { root: { kind: 'name', name: 'source' }, hopsRaw: '-[:val]->' } });
    expect(match.uniqueBy.map(pred)).toEqual(['FUZZY `name`', '`website`']);
    expect(match.fields.map((f) => f.name)).toEqual(['name', 'website']);
  });

  it('an unbound match is a statement (a gate), over a root collection', () => {
    const program = parseProgram('match crm-[:companies]-> { unique by (`domain`), domain: "acme.com" }');
    const statement = as(program.statements[0], 'match');
    expect(statement.match.target).toMatchObject({ kind: 'linked', path: { hopsRaw: '-[:companies]->' } });
    expect(statement.match.fields[0].value.raw).toBe('"acme.com"');
  });

  it('takes the tuple target a write takes', () => {
    const program = parseProgram(
      'deal = match (company-[:investments]->, investor-[:investments]->) { unique by (company, investor) }',
    );
    const match = rv(as(program.statements[0], 'assign').value, 'match').match;
    expect(match.target.kind).toBe('tuple');
    if (match.target.kind !== 'tuple') throw new Error('expected tuple');
    expect(match.target.paths.map((p) => pathRootName(p))).toEqual(['company', 'investor']);
  });

  it('refuses a bare position: a record in hand has nothing left to find', () => {
    expectParseError('match a { unique by (`name`), name: "x" }', /'a' is already a record — a match FINDS one/);
  });

  it.each(['?:', '+:', '+?:'])("refuses the '%s' operator — a match never writes", (op) => {
    expectParseError(`match crm-[:companies]-> { unique by (\`name\`), name ${op} "x" }`, /a match never writes/);
  });

  it('is contextual: a value named match still binds and reads', () => {
    const program = parseProgram('match = 1\nx = match');
    expect(as(program.statements[0], 'assign').name).toBe('match');
    expect(rv(as(program.statements[1], 'assign').value, 'expr').expr.raw).toBe('match');
  });

  it('a node literal refuses a match entry by name', () => {
    expectParseError('n = node { co: match crm-[:companies]-> { unique by (`name`) } }', /'match' acts/);
  });
});

describe('`<T | null>` — an extraction field that may be missing', () => {
  const field = (annotation: string) => {
    const program = parseProgram(`d = extract from [x] {\n  name: ${annotation} "the name"\n}`);
    return rv(as(program.statements[0], 'assign').value, 'extract').extract.stages[0].fields[0];
  };

  it('parses on an inline extraction field, the type kept bare beside the mark', () => {
    expect(field('<text | null>')).toMatchObject({ name: 'name', type: 'text', nullable: true });
    expect(field('<text|null>')).toMatchObject({ type: 'text', nullable: true });
    expect(field('<text>').nullable).toBeUndefined();
  });

  it('parses on every type an annotation takes — a primitive, a declared set, a borrowed field', () => {
    for (const type of ['number', 'date', 'boolean', 'Thesis']) {
      expect(field(`<${type} | null>`)).toMatchObject({ type, nullable: true });
    }
    expect(field('<crm-[:companies]->.funding_stage | null>')).toMatchObject({
      type: 'crm.companies.funding_stage',
      nullable: true,
    });
  });

  it('parses on a declared node\'s field', () => {
    const shape = as(parseProgram('node Entry {\n  name: <text | null> "its name"\n  label: <text>\n}').statements[0], 'shape');
    expect(shape.root.fields).toMatchObject([
      { name: 'name', type: 'text', nullable: true },
      { name: 'label', type: 'text' },
    ]);
    expect(shape.root.fields[1].nullable).toBeUndefined();
  });

  it('refuses `null` on its own, naming where it goes', () => {
    expectParseError('d = extract from [x] {\n  name: <null> "the name"\n}', /'null' is not a type on its own .*<text \| null>/);
  });

  it('refuses anything but one `| null`', () => {
    expectParseError('d = extract from [x] {\n  name: <text | null | x> "the name"\n}', /takes one '\| null' and nothing more/);
    expectParseError('d = extract from [x] {\n  name: <text | number> "the name"\n}', /Only '\| null' may follow a type/);
    expectParseError('d = extract from [x] {\n  name: <text | absent> "the name"\n}', /'null' is the spelling, not 'absent'/);
  });

  it('refuses it outside a field annotation, naming where it is allowed', () => {
    const where = /written only on an extraction field's annotation .* or a declared node's field/;
    expectParseError('movement m(x: <text | null>) {\n}', where);
    expectParseError('d = extract from [x] {\n  node e: <Entry | null>\n}', where);
    expectParseError('t = MEMBERS(<Thesis | null>)', where);
  });
});

// A statement's expression slot ends where the expression grammar would end it:
// both find a bracket's close with the same scan, so a literal or comment hides
// a bracket from both or from neither.
describe('a slot steps over literals and comments at every depth', () => {
  const callArgs = (source: string): string[] => {
    const call = rv(as(parseProgram(source).statements[0], 'assign').value, 'call').call;
    return call.args.map((arg) => (arg.kind === 'expr' ? arg.expr.raw : arg.kind));
  };

  it.each([
    ["a ' inside a \" string", '"it\'s } here"'],
    ["a \" inside a ' string", "'say \"hi\" }'"],
    ['a brace in a string inside an interpolation', '"a ${ "}" } b"'],
    ['a backtick name with an escaped backtick', '`a\\`}`'],
  ])('%s', (_label, literal) => {
    expect(callArgs(`y = CONCAT(${literal}, z)`)).toEqual([literal, 'z']);
  });

  it('a comment inside a closure body is prose wherever the closure is written', () => {
    const closure = ['MAP(xs, (x) => {', '  # the "website } isn\'t `here', '  return x', '})'].join('\n');
    expect(callArgs(`y = ${closure}`)).toEqual(['xs', 'closure']);
    // Inside a list the closure is one bracketed slot, found by the scan alone.
    const listed = rv(as(parseProgram(`y = [${closure}]`).statements[0], 'assign').value, 'expr');
    expect(listed.expr.raw).toBe(`[${closure}]`);
  });

  it('a `#` hop head inside a closure body is the hop, and a comment after it is a comment', () => {
    const source = ['y = MAP(xs, (x) => {', "  return FIRST(x-[#linked]->) # isn't }", '})'].join('\n');
    const call = rv(as(parseProgram(source).statements[0], 'assign').value, 'call').call;
    const closure = call.args[1];
    if (closure.kind !== 'closure') throw new Error('expected a closure argument');
    const ret = as(closure.closure.body[0], 'return');
    expect(rv(ret.value, 'call').call.args).toMatchObject([{ kind: 'expr', expr: { raw: 'x-[#linked]->' } }]);
  });

  it('a `#` inside a hop is a head at statement level too', () => {
    const program = parseProgram(['x-[#linked]-> {', '  z = 1 # a comment }', '}'].join('\n'));
    expect(as(program.statements[0], 'block').block.head.hopsRaw).toBe('-[#linked]->');
  });
});
