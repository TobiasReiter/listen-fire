// Value collections completed — dicts, the collection ops, and MEMBERS.
//
// A value collection is a list or a dict; positions keep the traversal-headed
// block. `{ k: v }` is the dict literal, `AT(d, k)` is the lookup, and the key
// world is text and nothing else. `MAP` / `FILTER` / `REDUCE` / `GROUPBY` /
// `KEYBY` take a FUNCTION, which is why they are read where `race` is rather
// than by the expression bridge. `members(<T>)` is a closed type's values in
// the order they were declared.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: {
        Messages: { target: 'message', readable: true, sequenced: 'chronological' },
        Members: { target: 'person', readable: true },
      },
    },
    message: { properties: { Text: 'text', At: 'datetime' }, edges: {} },
    person: { properties: { Name: 'text', Age: 'number' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Stage: { kind: 'enum', options: ['Seed', 'Series A'] } },
      edges: {},
    },
  },
  collections: { Companies: { target: 'company' } },
  writableRoots: {
    companies: {
      fields: {
        Name: 'text',
        // Open (known values) — other values are legal, so there is no complete
        // membership to walk.
        Tier: { kind: 'enum', options: ['gold', 'silver'], open: {} },
        Stage: { kind: 'enum', options: ['Seed', 'Series A'] },
      },
      resultShape: {},
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [], schema: chatSchema },
    attio: { constructionArgs: [], schema: crmSchema },
  },
});

const PRELUDE = `import { slack, attio } from adapters
type Thesis = <"Consumer" | "Infra" | "Health">
chat = connect slack
crm = connect attio
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
function m(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('the dict literal', () => {
  it('a brace-led value is a dict, and a lookup off it may come up empty', () => {
    // Bound, then read — a value the write field must discharge, exactly as
    // every other maybe-absent read is.
    expect(codes('  d = { one: "a", two: "b" }\n  write chat-[:note]-> { Body ?: d.one }')).toEqual([]);
  });

  it('a key the literal wrote down is present, so it fills a plain write field', () => {
    expect(codes('  d = { one: "a" }\n  write chat-[:note]-> { Body: d.one }')).toEqual([]);
  });

  it('a key only known at run time is possibly absent, so an undischarged write is refused', () => {
    const body = '  d = { one: "a" }\n  k = c.`Name`\n  write chat-[:note]-> { Body: d[k] }';
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a non-text key is refused, naming the coercion to write', () => {
    const body = [
      '  d = { one: "a" }',
      '  n = 3',
      '  write chat-[:note]-> { Body ?: d[n] }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
    expect(messages(body)).toContain('keyed by text');
  });

  it('a date key names DATE.FORMAT — the coercion that exists', () => {
    const body = [
      '  d = { one: "a" }',
      '  when = Date.from("2026-01-01")',
      '  write chat-[:note]-> { Body ?: d[when] }',
    ].join('\n');
    expect(messages(body)).toContain('Date.format');
  });

  it('a literal whose values disagree is still structured — folding the whole of it into text is refused', () => {
    // Its keys are typed one by one, but the dict itself is no text, so
    // folding it is the structured-value error.
    expect(codes('  d = { a: "x", b: 3 }\n  t = Text.concat(d, "!")')).toContain('MOV_JSON_OPAQUE');
  });

  it('the retired inline block still refuses by name — the `.binding` tells them apart', () => {
    expect(codes('  x = { a = 1 }.a')).toContain('MOV_INLINE_BLOCK_RETIRED');
  });
});

describe('MAP / FILTER over a value collection', () => {
  const NAMES = '  names = List.from(c-[m:Messages]->.`Text`)\n';

  it("MAP's function takes one member, untyped — the collection says what it is", () => {
    expect(codes(`${NAMES}  loud = map(names, (t) => { return Text.upper(t) })`)).toEqual([]);
  });

  it('the member keeps its type inside the function', () => {
    // A text member added up is an arithmetic error — proof the element type
    // reached the parameter.
    expect(
      codes(`${NAMES}  bad = map(names, (t) => { return t + 1 })`),
    ).toContain('MOV_ARITH_NON_NUMERIC');
  });

  it('an annotation on the parameter still wins where one is written', () => {
    expect(codes(`${NAMES}  n = map(names, (t: <text>) => { return Text.upper(t) })`)).toEqual([]);
  });

  it('a function with the wrong number of parameters is refused', () => {
    const body = `${NAMES}  x = map(names, (a, b) => { return a })`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('one member at a time');
  });

  // MAP alone lets its function skip `return` — each slot is then absent,
  // the same shape an extracted field with no value has. FILTER/REDUCE keep
  // requiring one: a filter needs a boolean to decide by, a reduce needs the
  // carried value, and neither has an "absent" that means anything.
  it('a MAP function that hands nothing back is legal — no diagnostic', () => {
    expect(codes(`${NAMES}  x = map(names, (t) => { y = t })`)).toEqual([]);
  });

  it('MAP with no return types the list as absent per slot', () => {
    const body = [
      NAMES,
      '  x = map(names, (t) => { y = t })',
      '  write chat-[:note]-> { Body: x[0] }',
    ].join('\n');
    // AT(list-of-absent, 0) is absent, unguarded into a required field —
    // MOV_ABSENT_REQUIRED is the type-level proof the slot really is absent
    // (not silently unknown, which would say nothing here).
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('FILTER still requires a return (unlike MAP)', () => {
    expect(codes(`${NAMES}  x = filter(names, (t) => { y = t })`)).toContain(
      'MOV_COLLECTION_OP_RETURNS_NOTHING',
    );
  });

  it('REDUCE still requires a return (unlike MAP)', () => {
    const body = `${NAMES}  x = reduce(names, (carried, t) => { y = t }, "")`;
    expect(codes(body)).toContain('MOV_COLLECTION_OP_RETURNS_NOTHING');
  });

  it('a function that waits is allowed — each member parks on its own', () => {
    const body = `${NAMES}  x = map(names, (t) => { await sleep(1d)\n    return t })`;
    expect(codes(body)).not.toContain('MOV_COLLECTION_OP_SUSPENDS');
  });
  // Before version 3 it is refused: the v1 / v2 conformance corpora pin that.

  it('reading POSITIONS is refused, and the message names the traversal-headed block', () => {
    const body = '  x = map(c, (p) => { return p })';
    expect(codes(body)).toContain('MOV_COLLECTION_OP_NOT_A_COLLECTION');
    expect(messages(body)).toContain('traversal-headed block');
  });

  it('MAP preserves the input ordering: an unordered list stays unordered', () => {
    // Members are unordered, so a JOIN of what MAP made of them is the same
    // refusal a JOIN of the members would be.
    expect(
      codes([
        '  people = List.from(c-[p:Members]->.`Name`)',
        '  loud = map(people, (n) => { return "${n}!" })',
        '  t = Text.join(loud, ", ")',
      ].join('\n')),
    ).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('…and an ordered one stays ordered', () => {
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  loud = map(lines, (t) => { return "${t}!" })',
        '  joined = Text.join(loud, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });

  it('FILTER hands back the members it was given', () => {
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  kept = filter(lines, (t) => { return t != "" })',
        '  joined = Text.join(kept, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('MAP / FILTER settings: what a failure does, and how many run at once', () => {
  const NAMES = '  names = List.from(c-[m:Messages]->.`Text`)\n';

  it('a record of known settings, written down, is clean — and types the answer as the two-argument form does', () => {
    expect(
      codes([
        NAMES,
        '  loud = map(names, (t) => { return Text.upper(t) }, { onError: "warn", concurrency: 4, initialConcurrency: 1 })',
        '  kept = filter(loud, (t) => { return t != "" }, { onError: "ignore" })',
        '  joined = Text.join(kept, "\\n")',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a key the op has no setting for is refused, with a did-you-mean', () => {
    const body = `${NAMES}  x = map(names, (t) => { return t }, { concurency: 4 })`;
    expect(codes(body)).toEqual(['MOV_COLLECTION_OP_CONFIG']);
    expect(messages(body)).toContain("no setting 'concurency' — did you mean 'concurrency'?");
  });

  it('an onError that is not one of its three answers is refused, naming them', () => {
    const body = `${NAMES}  x = filter(names, (t) => { return t != "" }, { onError: "retry" })`;
    expect(codes(body)).toEqual(['MOV_COLLECTION_OP_CONFIG']);
    expect(messages(body)).toContain('"ignore", "warn", "error"');
  });

  it('a concurrency of nothing, or of a part, is refused', () => {
    expect(codes(`${NAMES}  x = map(names, (t) => { return t }, { concurrency: 0 })`)).toEqual([
      'MOV_COLLECTION_OP_CONFIG',
    ]);
    expect(codes(`${NAMES}  x = map(names, (t) => { return t }, { concurrency: 1.5 })`)).toEqual([
      'MOV_COLLECTION_OP_CONFIG',
    ]);
    expect(
      codes(`${NAMES}  x = map(names, (t) => { return t }, { concurrency: 2, initialConcurrency: 0 })`),
    ).toEqual(['MOV_COLLECTION_OP_CONFIG']);
  });

  it('a value worked out rather than written down is refused', () => {
    const body = `${NAMES}  n = 4\n  x = map(names, (t) => { return t }, { concurrency: n })`;
    expect(codes(body)).toEqual(['MOV_COLLECTION_OP_CONFIG']);
    expect(messages(body)).toContain('written down, not worked out');
  });

  it('a first batch wider than the rest is refused — the warm-up is never the wider one', () => {
    const body = `${NAMES}  x = map(names, (t) => { return t }, { concurrency: 2, initialConcurrency: 4 })`;
    expect(codes(body)).toEqual(['MOV_COLLECTION_OP_CONFIG']);
  });

  it("REDUCE is untouched: a record in the middle is its starting value, and its type is the fold's", () => {
    const body = [
      '  lines = List.from(c-[m:Messages]->.`Text`)',
      '  x = reduce(lines, (carried, t) => { return carried }, { concurrency: 0 })',
    ].join('\n');
    expect(codes(body)).not.toContain('MOV_COLLECTION_OP_CONFIG');
  });
});

describe('a bare collection-op statement (no binding)', () => {
  const NAMES = '  names = List.from(c-[m:Messages]->.`Text`)\n';

  it('MAP run bare, for its writes, is legal', () => {
    expect(
      codes(`${NAMES}  map(names, (t) => { write chat-[:note]-> { Body: t } })`),
    ).toEqual([]);
  });

  it('FILTER run bare still requires a return (the rule is the op’s, not the binding’s)', () => {
    expect(
      codes(`${NAMES}  filter(names, (t) => { write chat-[:note]-> { Body: t } })`),
    ).toContain('MOV_COLLECTION_OP_RETURNS_NOTHING');
  });

  it('REDUCE run bare still requires a return', () => {
    expect(
      codes(`${NAMES}  reduce(names, (carried, t) => { write chat-[:note]-> { Body: t } }, "")`),
    ).toContain('MOV_COLLECTION_OP_RETURNS_NOTHING');
  });
});

describe('REDUCE is order-sensitive', () => {
  it('over an unordered collection it is refused, like every other order-sensitive fold', () => {
    const body = [
      '  ages = List.from(c-[p:Members]->.`Age`)',
      '  total = reduce(ages, (carried, n) => { return carried + n }, 0)',
    ].join('\n');
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('over an ordered one it is clean, and its value is what the function returns', () => {
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  every = reduce(lines, (carried, t) => { return Text.concat(carried, t) }, "")',
        '  write chat-[:note]-> { Body: every }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('its function takes two things, and one is refused', () => {
    const body = [
      '  lines = List.from(c-[m:Messages]->.`Text`)',
      '  every = reduce(lines, (t) => { return t }, "")',
    ].join('\n');
    expect(codes(body)).toContain('MOV_COLLECTION_OP_ARITY');
    expect(messages(body)).toContain('carried so far');
  });
});

describe('GROUPBY and KEYBY build dicts', () => {
  const LINES = '  lines = List.from(c-[m:Messages]->.`Text`)\n';

  it('a lookup into a dict may miss, so an undischarged write is refused', () => {
    // KEYBY's members are text, so this reads a text field directly — the
    // absence is the only thing left to report, which is what proves a
    // lookup can come up empty. (A JOIN would discharge it: joining nothing
    // is the empty string, the fold's own zero.)
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  by = List.keyBy(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body: by.A }',
      ].join('\n')),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a group discharged with COALESCE joins cleanly — the group keeps the source order', () => {
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  by = List.groupBy(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: Text.join(by.A, ", ") }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a key that is not text is refused at the key function', () => {
    const body = [
      '  ages = List.from(c-[p:Members]->.`Age`)',
      '  by = List.groupBy(ages, (n) => { return n })',
    ].join('\n');
    expect(codes(body)).toContain('MOV_DICT_KEY_NOT_TEXT');
  });

  it('KEYBY hands back the member itself, not a list of them', () => {
    // The member is text, so joining the looked-up value is a type error —
    // proof KEYBY did not wrap it in a list.
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  by = List.keyBy(lines, (t) => { return "${t}!" })',
        '  write chat-[:note]-> { Body ?: by.A }',
      ].join('\n')),
    ).toEqual([]);
  });
});

describe('MEMBERS — a closed type, in declaration order', () => {
  it('a declared refinement lists its values, and the list is ordered', () => {
    expect(
      codes('  every = members(<Thesis>)\n  t = Text.join(every, ", ")'),
    ).toEqual([]);
  });

  it('the members are the type, so they key a dict of it', () => {
    expect(
      codes([
        '  lines = List.from(c-[m:Messages]->.`Text`)',
        '  by = List.groupBy(lines, (t) => { return "${t}!" })',
        '  every = members(<Thesis>)',
        '  lines2 = map(every, (th) => { return Text.join(coalesce(by[th], []), ", ") })',
      ].join('\n')),
    ).toEqual([]);
  });

  it('written inside a collection op it is the list it reads (version 3); before, a refusal', () => {
    // From language version 3 MAP and MEMBERS are calls, and a call nested in
    // another's arguments means what binding it first means
    // (checker/nested_calls.ts). Before it, nesting one is the parser's
    // pointed refusal.
    const source = `${PRELUDE}\nfunction m(c: <chat-[:channel]->>) {\n  x = map(members(<Thesis>), (t) => { return t })\n}`;
    const found = checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
    expect(found).toEqual([]);
    const before3 = `import { slack, attio } from adapters\ntype Thesis = <"Consumer" | "Infra" | "Health">\nchat = slack()\ncrm = attio()\nmovement m(c: <chat-[:channel]->>) {\n  x = MAP(MEMBERS(<Thesis>), (t) => { return t })\n}`;
    expect(() => parseProgram(before3, { languageVersion: 2 })).toThrow(/bind it first/);
  });

  it('a borrowed CLOSED option set works the same way', () => {
    expect(codes('  every = members(<crm-[:companies]->.`Stage`>)\n  t = Text.join(every, ", ")')).toEqual([]);
  });

  it('an OPEN known-values field is refused — its membership is not closed', () => {
    const body = '  every = members(<crm-[:companies]->.`Tier`>)';
    expect(codes(body)).toContain('MOV_MEMBERS_NOT_CLOSED');
    expect(messages(body)).toContain('other values are legal');
  });

  it('a primitive is refused — there is nothing to list', () => {
    expect(codes('  every = members(<text>)')).toContain('MOV_MEMBERS_NOT_CLOSED');
  });

  it('a name that is no type reports the ordinary unknown-type error', () => {
    expect(codes('  every = members(<Nope>)')).toContain('MOV_UNKNOWN_TYPE_NAME');
  });
});

describe('a block head rooted at a value', () => {
  // The handbook's chunked rehearsal: one extraction per piece, gathered by a
  // block over the list of results. `MAP` hands each answer back in the
  // currency it arrived in, so the list holds extraction ROOTS — something the
  // value plane has no word for, which is exactly why it stays silent and runs.
  const CHUNKED = [
    '  pieces = Text.chunks(coalesce(c.`Name`, ""), { size: 40 })',
    '  found = map(pieces, (p) => {',
    '    return extract from [p] {',
    '      node company: "each company named" {',
    '        name: "the company\'s name"',
    '      }',
    '    }',
    '  })',
  ].join('\n');

  it('a list of extraction results walks', () => {
    const body = [
      CHUNKED,
      '  found-[x:company]-> {',
      '    write chat-[:note]-> { Body ?: x.name }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('one result held on the value plane walks too', () => {
    const body = [
      CHUNKED,
      '  one = found[0]',
      '  one-[x:company]-> {',
      '    write chat-[:note]-> { Body ?: x.name }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('a list whose type IS known is refused — no value is a position', () => {
    const body = [
      '  names = List.from(c-[m:Messages]->.`Text`)',
      '  names-[x:company]-> {',
      '    write chat-[:note]-> { Body: "x" }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
    expect(messages(body)).toContain('list of text');
    expect(messages(body)).toContain('hop walks from a POSITION');
  });

  it('a plain text binding is refused the same way', () => {
    const body = [
      '  label = "hello"',
      '  label-[x:company]-> {',
      '    write chat-[:note]-> { Body: "x" }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
  });
});

describe('a parameter with no type, where nothing supplies one', () => {
  it('a bare closure parameter is refused', () => {
    const body = '  f = (x) => { return x }';
    expect(codes(body)).toContain('MOV_PARAM_NEEDS_TYPE');
  });

  it('a movement parameter is refused too — its type is the promise to callers', () => {
    const source = `${PRELUDE}\nfunction other(x) {\n  y = x\n}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain('MOV_PARAM_NEEDS_TYPE');
  });
});

describe('a list literal of records', () => {
  // `both = [one, two]` is a list of records — one type universe, so the list
  // holds records the way any list holds its members, and a head off it walks
  // each member in list order.
  const TWO = [
    '  one = node { name: "Acme", founder: node { name: "Jane Doe" } }',
    '  two = node { name: "Zenith", founder: node { name: "Ada Byron" } }',
    '  both = [one, two]',
  ].join('\n');

  it('two records in a list is clean', () => {
    expect(codes(TWO)).toEqual([]);
  });

  it('a block head off the list walks it', () => {
    expect(
      codes([
        TWO,
        '  both-[f:founder]-> {',
        '    write chat-[:note]-> { Body ?: f.name }',
        '  }',
      ].join('\n')),
    ).toEqual([]);
  });

  // A literal holding a record and a value is a TUPLE, which may hold both —
  // each slot is its own type. What a list may not do is hold both, so the
  // mixture is refused where the tuple is READ as a list.
  const READ_AS_LIST = '\n  each = map(both, (b) => { return b })';

  it('a record and a value together make a tuple — refused where it is read as a list', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  label = "hello"',
      '  both = [one, label]',
    ].join('\n');
    expect(codes(body)).toEqual([]);
    expect(codes(`${body}\n  head = both[0]`)).toEqual([]);
    expect(codes(body + READ_AS_LIST)).toContain('MOV_LIST_MIXED');
    expect(messages(body + READ_AS_LIST)).toContain('one kind of thing');
    expect(messages(body + READ_AS_LIST)).toContain('is text');
  });

  it('a literal member is refused the same way', () => {
    expect(codes('  one = node { name: "Acme" }\n  both = [one, 3]' + READ_AS_LIST)).toContain('MOV_LIST_MIXED');
  });

  it('a nested list is refused — a record and a list of them are not one kind', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  two = node { name: "Zenith" }',
      '  both = [one, [two]]',
    ].join('\n') + READ_AS_LIST;
    expect(codes(body)).toContain('MOV_LIST_MIXED');
    expect(messages(body)).toContain('list of');
  });

  it('a computed member is judged by its TYPE, like every other member', () => {
    // The rule is one rule, read off the types: a text read out of a list of
    // text is text wherever it was written, so mixing it with a record is the
    // same mistake as writing the text inline.
    expect(
      codes([
        '  one = node { name: "Acme" }',
        '  names = List.from(c-[m:Messages]->.`Text`)',
        '  both = [one, names[0]]',
      ].join('\n') + READ_AS_LIST),
    ).toContain('MOV_LIST_MIXED');
  });

  it('a member nobody can type stays silent — the honesty rule', () => {
    // `KG_VALUE` answers a value nothing here describes. An untyped member says
    // nothing about the list, so the list says nothing either, and it is the
    // head or the read that names what it turned out to be.
    expect(
      codes([
        '  one = node { name: "Acme" }',
        '  both = [one, KG_VALUE("x")]',
      ].join('\n') + READ_AS_LIST),
    ).not.toContain('MOV_LIST_MIXED');
  });

  it('interpolating a record is refused where it is written, naming the record', () => {
    // A record has no one spelling as text and there is no implicit one — the
    // run refused this already; the type says so at the '=' instead.
    const body = '  one = node { name: "Acme" }\n  t = "${one}"';
    expect(codes(body)).toContain('MOV_RECORD_NOT_A_VALUE');
    expect(messages(body)).toContain('a record, not a value');
  });
});

describe('a list of records is an ordinary collection', () => {
  it('a collection op reads it — a record is a value, so a list of them is a list', () => {
    const body = [
      '  one = node { name: "Acme" }',
      '  two = node { name: "Zenith" }',
      '  both = [one, two]',
      '  x = map(both, (r) => { return r })',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('ONE record is still not a collection — the message names the block', () => {
    const body = '  one = node { name: "Acme" }\n  x = map(one, (r) => { return r })';
    expect(codes(body)).toContain('MOV_COLLECTION_OP_NOT_A_COLLECTION');
    expect(messages(body)).toContain('traversal-headed block');
  });

  it('members that agree on a type carry it, so the walk off the list is checked', () => {
    const body = [
      '  c-[msg:Messages]-> {',
      '    a = msg',
      '    b = msg',
      '    both = [a, b]',
      '    both-[n:Nope]-> {',
      '      write chat-[:note]-> { Body: "x" }',
      '    }',
      '  }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });
});

describe('a record is a value, so the collection ops carry records', () => {
  // One type universe: what a collection op hands back is what its function
  // returned, and a record is one of the things a function can return. The
  // proofs are what the checker says about a LATER read — a bad edge off a
  // member names the position, so the element type is visible from outside.

  it('MAP returning the member is a list of that record', () => {
    const body = [
      '  rows = map(c-[m:Messages]->, (t) => { return t })',
      '  rows-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_TRAVERSE_UNKNOWN_EDGE']);
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('a hop is a collection — MAP over one needs no block first', () => {
    expect(codes('  rows = map(c-[m:Messages]->, (t) => { return t.`Text` })')).toEqual([]);
  });

  it('MAP returning a map literal is a list of maps, and the key keeps its type', () => {
    // `a` holds a number, so writing it into a text field is the number-into-
    // text mistake and nothing else — which is only sayable if the map's value
    // type survived the MAP.
    const body = [
      '  rows = map(c-[m:Messages]->, (t) => { return { a: 1 } })',
      '  head = rows[0]',
      '  write chat-[:note]-> { Body ?: head.a }',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });

  it('MAP returning a map whose key holds a record is a list of those maps', () => {
    const body = [
      '  rows = map(c-[m:Messages]->, (t) => { return { a: t } })',
      '  head = rows[0]',
      '  write chat-[:note]-> { Body ?: head.a }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_WRITE_FIELD_TYPE');
    expect(messages(body)).toContain('a record, not a value');
  });

  it('FILTER over records hands the records back', () => {
    const body = [
      '  rows = filter(c-[m:Messages]->, (t) => { return t.`Text` == "hi" })',
      '  rows-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('GROUPBY over records files lists of records under each key', () => {
    const body = [
      '  groups = List.groupBy(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  one = groups.hi',
      '  one-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('KEYBY over records files one record under each key', () => {
    const body = [
      '  byText = List.keyBy(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  one = byText.hi',
      '  one-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('REDUCE hands back whatever the reducer returns', () => {
    expect(
      codes([
        '  total = reduce(c-[m:Messages]->, (acc, t) => { return acc + 1 }, 0)',
        '  write chat-[:note]-> { Body ?: "${total}" }',
      ].join('\n')),
    ).toEqual([]);
  });

  it('a head off one member of the list walks that record', () => {
    const body = [
      '  rows = map(c-[m:Messages]->, (t) => { return t })',
      '  head = rows[0]',
      '  head-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(messages(body)).toContain("chat.message has no edge 'Nope'");
  });

  it('interpolating a member inside the function is refused, naming the record', () => {
    const body = '  rows = map(c-[m:Messages]->, (t) => { return "${t}" })';
    expect(codes(body)).toContain('MOV_RECORD_NOT_A_VALUE');
  });

  it('writing a member into a field is refused, naming the record', () => {
    const body = [
      '  c-[msg:Messages]-> {',
      '    write chat-[:note]-> { Body: msg }',
      '  }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_WRITE_FIELD_TYPE');
    expect(messages(body)).toContain('a record, not a value');
  });

  it('a hop off a name bound to text is still refused where it is written', () => {
    const body = [
      '  names = map(c-[m:Messages]->, (t) => { return t.`Text` })',
      '  head = names[0]',
      '  head-[n:Nope]-> { write chat-[:note]-> { Body: "x" } }',
    ].join('\n');
    expect(codes(body)).toContain('MOV_HEAD_NOT_A_POSITION');
  });
});

// A comment inside a bracketed value is prose: the statement scan steps over
// it and the expression grammar skips it, so the value checks as if unwritten.
describe('a # comment inside a bracketed value', () => {
  it.each([
    ['a list', '  xs = [1, # the first\n    2]', '  xs = [1, 2]'],
    ['a dict', '  d = { one: "a", # the first\n    two: "b" }', '  d = { one: "a", two: "b" }'],
  ])('inside %s', (_label, commented, plain) => {
    expect(codes(commented)).toEqual([]);
    expect(codes(commented)).toEqual(codes(plain));
  });
});
