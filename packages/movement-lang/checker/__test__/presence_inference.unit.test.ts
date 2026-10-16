// Presence and inference (language-ergonomics A).
//
// Four facts the type system now knows instead of making the author say:
// an interpolated value that may be absent prints as nothing; an extracted
// TEXT field is present (the engine hands over "" for one nobody found); a
// dict written as a literal knows its keys, as a TypeScript object literal
// does; and a number index into a list may miss, and needs an order to mean
// anything, exactly as FIRST does.

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
    note: {
      fields: { Body: 'text', Count: 'number', Data: 'json' },
      resultShape: { Body: 'text' },
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema } },
});

const PRELUDE = `import { slack } from adapters
type Verdict = <"yes" | "no">
chat = connect slack
`;

function all(body: string): Diagnostic[] {
  const source = `${PRELUDE}
function m(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog);
}
// Errors carry no explicit severity, so a filter on 'error' alone is vacuous.
const errors = (body: string): Diagnostic[] => all(body).filter((d) => (d.severity ?? 'error') === 'error');
const codes = (body: string): string[] => errors(body).map((d) => d.code);
const messages = (body: string): string => errors(body).map((d) => d.message).join('\n');

const MAYBE = '  x = first(List.from(c-[m:Messages]->.`Text`))\n';

describe('interpolating a value that may be absent', () => {
  it('is accepted in a template, which is present text', () => {
    expect(codes(`${MAYBE}  write chat-[:note]-> { Body: "said: \${x}" }`)).toEqual([]);
  });

  it('is accepted as the whole template', () => {
    expect(codes(`${MAYBE}  write chat-[:note]-> { Body: "\${x}" }`)).toEqual([]);
  });

  it('is accepted in an AI prompt, which is a string', () => {
    expect(codes(`${MAYBE}  y = ai("summarise \${x}")\n  write chat-[:note]-> { Body ?: y }`)).toEqual([]);
  });

  it('the bare value still needs discharging where one is required', () => {
    expect(codes(`${MAYBE}  write chat-[:note]-> { Body: x }`)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('an ordered comparison still refuses it', () => {
    const body = '  n = first(List.from(c-[p:Members]->.`Age`))\n  big = n > 3';
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });
});

const EXTRACT = [
  '  r = extract from [c.`Name`] {',
  '    title: <text> "the title"',
  '    note: "a note"',
  '    size: <number> "how many"',
  '    verdict: <Verdict> "yes or no"',
  '    node item: "each item" {',
  '      label: <text> "its label"',
  '    }',
  '  }',
  '',
].join('\n');

describe('an extracted text field is present', () => {
  it('a declared <text> field fills a plain write field', () => {
    expect(codes(`${EXTRACT}  write chat-[:note]-> { Body: r.title }`)).toEqual([]);
  });

  it('so testing it for null is refused, naming the emptiness test', () => {
    const body = `${EXTRACT}  if (r.title != null) { write chat-[:note]-> { Body: "y" } }`;
    expect(codes(body)).toEqual(['MOV_PRESENCE_TEST_ON_TEXT']);
    expect(messages(body)).toContain('r.title != ""');
  });

  it('every spelling of the test is refused, the shortcut included', () => {
    for (const test of ['r.note == null', 'r.note != null', 'r.title == null']) {
      expect(codes(`${EXTRACT}  if (${test}) { write chat-[:note]-> { Body: "y" } }`)).toEqual([
        'MOV_PRESENCE_TEST_ON_TEXT',
      ]);
    }
    expect(messages(`${EXTRACT}  if (r.note == null) { write chat-[:note]-> { Body: "y" } }`)).toContain(
      'r.note == ""',
    );
  });

  it('inside a nested node too', () => {
    expect(
      codes(`${EXTRACT}  r-[i:item]-> { if (i.label != null) { write chat-[:note]-> { Body: i.label } } }`),
    ).toEqual(['MOV_PRESENCE_TEST_ON_TEXT']);
  });

  it('a typed field may still be tested — it can be absent', () => {
    expect(codes(`${EXTRACT}  if (r.size != null) { write chat-[:note]-> { Body: "sized" } }`)).toEqual([]);
    expect(codes(`${EXTRACT}  if (r.verdict == null) { write chat-[:note]-> { Body: "none" } }`)).toEqual([]);
  });

  it('a typed field proven by a guard is present inside the arm, and only there', () => {
    const write = 'write chat-[:note]-> { Count: r.size }';
    expect(codes(`${EXTRACT}  if (r.size != null) { ${write} }`)).toEqual([]);
    expect(codes(`${EXTRACT}  if (!(r.size == null)) { ${write} }`)).toEqual([]);
    // The control: unguarded, and after the arm, the read may still be absent.
    expect(codes(`${EXTRACT}  ${write}`)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes(`${EXTRACT}  if (r.size != null) { }\n  ${write}`)).toEqual(['MOV_ABSENT_REQUIRED']);
    // A proof about one field says nothing about another.
    expect(codes(`${EXTRACT}  if (r.verdict != null) { ${write} }`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('a guard clause proves a typed field for everything after it', () => {
    const body = `${EXTRACT}  if (r.size == null) { fail("no size") }\n  write chat-[:note]-> { Count: r.size }`;
    expect(codes(body)).toEqual([]);
  });

  it('a typed field of a nested node narrows the same way', () => {
    const nested = EXTRACT.replace('label: <text> "its label"', 'label: <text> "its label"\n      rank: <number> "its rank"');
    expect(
      codes(`${nested}  r-[i:item]-> { if (i.rank != null) { write chat-[:note]-> { Count: i.rank } } }`),
    ).toEqual([]);
  });

  it('a record the program built narrows the same way', () => {
    const built = '  n = node { said: first(List.from(c-[m:Messages]->.`Text`)) }\n';
    const write = 'write chat-[:note]-> { Body: n.said }';
    expect(codes(`${built}  ${write}`)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes(`${built}  if (n.said != null) { ${write} }`)).toEqual([]);
  });

  it('a system text field may still be tested — a source can hand back nothing', () => {
    expect(codes('  if (c.`Name` != null) { write chat-[:note]-> { Body: "y" } }')).toEqual([]);
  });

  it('the shortcut written into a number field is refused, naming the annotation', () => {
    const body = `${EXTRACT}  write chat-[:note]-> { Count: r.note }`;
    expect(codes(body)).toEqual(['MOV_EXTRACT_NEEDS_ANNOTATION']);
    expect(messages(body)).toContain('note: <number> "…"');
  });

  it('the shortcut is text, so it compares as text', () => {
    expect(codes(`${EXTRACT}  big = r.note > 3`)).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('the inline shortcut fills a plain write field', () => {
    expect(codes(`${EXTRACT}  write chat-[:note]-> { Body: r.note }`)).toEqual([]);
  });

  it('a text field of a nested node is present too', () => {
    expect(
      codes(`${EXTRACT}  r-[i:item]-> { write chat-[:note]-> { Body: i.label } }`),
    ).toEqual([]);
  });

  it('a <number> field stays possibly absent', () => {
    expect(codes(`${EXTRACT}  write chat-[:note]-> { Count: r.size }`)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a declared refinement stays possibly absent', () => {
    expect(codes(`${EXTRACT}  write chat-[:note]-> { Body: r.verdict }`)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('every field interpolates, typed or not', () => {
    expect(
      codes(`${EXTRACT}  write chat-[:note]-> { Body: "\${r.title} \${r.note} \${r.size} \${r.verdict}" }`),
    ).toEqual([]);
  });
});

const NULLABLE = [
  '  r = extract from [c.`Name`] {',
  '    title: <text | null> "the title"',
  '    plain: <text> "a plain title"',
  '    note: "a note"',
  '    size: <number | null> "how many"',
  '    verdict: <Verdict | null> "yes or no"',
  '  }',
  '',
].join('\n');

describe('an extracted field annotated `<text | null>`', () => {
  it('reads text | absent, so a plain write is refused until discharged', () => {
    const body = `${NULLABLE}  write chat-[:note]-> { Body: r.title }`;
    expect(codes(body)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(messages(body)).toContain('(text (or absent))');
    expect(codes(`${NULLABLE}  write chat-[:note]-> { Body ?: r.title }`)).toEqual([]);
  });

  it('may be tested for null, in every spelling — no MOV_PRESENCE_TEST_ON_TEXT', () => {
    for (const test of ['r.title == null', 'r.title != null']) {
      expect(codes(`${NULLABLE}  if (${test}) { write chat-[:note]-> { Body: "y" } }`)).toEqual([]);
    }
  });

  it('a guard narrows it inside the arm, and a guard clause for everything after', () => {
    const write = 'write chat-[:note]-> { Body: r.title }';
    expect(codes(`${NULLABLE}  if (r.title != null) { ${write} }`)).toEqual([]);
    expect(codes(`${NULLABLE}  if (r.title != null) { ${write} }`)).toEqual([]);
    expect(codes(`${NULLABLE}  if (r.title == null) { fail("no title") }\n  ${write}`)).toEqual([]);
    expect(codes(`${NULLABLE}  if (r.title != null) { }\n  ${write}`)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('leaves its neighbours as they were: `<text>` and the shortcut stay present', () => {
    expect(codes(`${NULLABLE}  write chat-[:note]-> { Body: r.plain }`)).toEqual([]);
    expect(codes(`${NULLABLE}  write chat-[:note]-> { Body: r.note }`)).toEqual([]);
    expect(codes(`${NULLABLE}  if (r.plain != null) { }`)).toEqual(['MOV_PRESENCE_TEST_ON_TEXT']);
  });

  it('on a typed field means what the type already did', () => {
    expect(codes(`${NULLABLE}  write chat-[:note]-> { Count: r.size }`)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(codes(`${NULLABLE}  if (r.size != null) { write chat-[:note]-> { Count: r.size } }`)).toEqual([]);
    expect(codes(`${NULLABLE}  write chat-[:note]-> { Body ?: r.verdict }`)).toEqual([]);
  });

  it('on a declared node\'s field, used as an extraction shape, types the same', () => {
    const source = `${PRELUDE}
node Entry: "each item" {
  name: <text | null> "its name"
  label: <text> "its label"
}
function m(c: <chat-[:channel]->>) {
  r = extract from [c.\`Name\`] {
    node entry: <Entry>
  }
  r-[e:entry]-> {
    write chat-[:note]-> { Body: e.label }
    write chat-[:note]-> { Body: e.name }
    if (e.name != null) { write chat-[:note]-> { Body: e.name } }
  }
}`;
    const found = checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
    expect(found.map((d) => d.code)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('is what the refusal on a plain text field names first', () => {
    const body = `${EXTRACT}  if (r.note != null) { }`;
    expect(codes(body)).toEqual(['MOV_PRESENCE_TEST_ON_TEXT']);
    const message = messages(body);
    expect(message).toContain('Annotate it `<text | null>` to keep the null test');
    expect(message.indexOf('<text | null>')).toBeLessThan(message.indexOf('r.note != ""'));
  });
});

describe('a dict literal is typed by its keys', () => {
  it('a written key that exists reads its own type, present', () => {
    expect(codes('  d = { bucket: "a", packed: 3 }\n  write chat-[:note]-> { Body: d.bucket }')).toEqual([]);
    expect(codes('  d = { bucket: "a", packed: 3 }\n  write chat-[:note]-> { Count: d.packed }')).toEqual([]);
  });

  it('the key keeps its type — a number into a text field is still a number', () => {
    expect(codes('  d = { bucket: "a", packed: 3 }\n  n = d.packed + 1\n  t = d.bucket + 1')).toEqual([
      'MOV_ARITH_NON_NUMERIC',
    ]);
  });

  it('a value read out of a mixed literal compares — it is no longer opaque json', () => {
    const body = '  d = { bucket: "a", packed: 3 }\n  same = d.bucket == "a"\n  big = d.packed > 2';
    expect(codes(body)).toEqual([]);
    expect(messages(body)).not.toContain('nothing describes');
  });

  it('a written key that does not exist is refused with a did-you-mean', () => {
    const body = '  d = { bucket: "a", packed: 3 }\n  write chat-[:note]-> { Body ?: d.buckt }';
    expect(codes(body)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
    expect(messages(body)).toContain('Did you mean "bucket"?');
  });

  it('a key only known at run time may miss', () => {
    const body = '  d = { one: "a", two: "b" }\n  k = c.`Name`\n  write chat-[:note]-> { Body: d[k] }';
    expect(codes(body)).toContain('MOV_ABSENT_REQUIRED');
  });

  it('a key that may itself be absent in the literal stays possibly absent', () => {
    expect(codes(`${MAYBE}  d = { one: x }\n  write chat-[:note]-> { Body: d.one }`)).toContain(
      'MOV_ABSENT_REQUIRED',
    );
  });

  it('the whole literal is still structured — folding it into text is refused', () => {
    expect(codes('  d = { a: "x", b: 3 }\n  t = Text.concat(d, "!")')).toContain('MOV_JSON_OPAQUE');
  });

  it('a mixed literal still passes through into a json field', () => {
    expect(codes('  write chat-[:note]-> { Data: { a: "x", b: 3 } }')).toEqual([]);
  });

  it('the diagnostic spells the dict by its keys', () => {
    const body = '  d = { a: "x", b: 3 }\n  write chat-[:note]-> { Body: d }';
    expect(messages(body)).toContain('{ a: text, b: number }');
  });
});

describe('the collection ops carry the shape', () => {
  const ROWS = '  rows = map(c-[m:Messages]->, (t) => { return { line: t.`Text`, at: t.`At` } })\n';

  it('MAP answers a list of the shape, so a member reads its keys', () => {
    const body = `${ROWS}  lines = map(rows, (r) => { return r.line })\n  write chat-[:note]-> { Body: Text.join(lines, ", ") }`;
    expect(codes(body)).toEqual([]);
  });

  it('a typo inside the function is caught against the shape', () => {
    const body = `${ROWS}  lines = map(rows, (r) => { return r.lines })`;
    expect(codes(body)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
  });

  it('FILTER hands the shaped members back', () => {
    const body = `${ROWS}  kept = filter(rows, (r) => { return r.line != "" })\n  bad = map(kept, (r) => { return r.nope })`;
    expect(codes(body)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
  });

  it('GROUPBY keys on a shaped value, and files lists of the shape', () => {
    const body = [
      ROWS.trimEnd(),
      '  by = List.groupBy(rows, (r) => { return r.line })',
      '  group = by.x',
      '  bad = map(group, (r) => { return r.nope })',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
  });

  it('KEYBY files one of the shape under each key', () => {
    const body = [
      ROWS.trimEnd(),
      '  by = List.keyBy(rows, (r) => { return r.line })',
      '  one = by.x',
      '  when = one.at',
    ].join('\n');
    // A lookup into a dict whose keys are DATA may miss, so the member itself
    // may be absent, and its key read with it.
    expect(codes(`${body}\n  late = when > DateTime.from("2026-01-01")`)).toContain('MOV_ABSENT_REQUIRED');
    expect(codes(`${body}\n  bad = one.nope`)).toContain('MOV_DICT_UNKNOWN_KEY');
  });

  it('a block that returns a literal is a list of the shape', () => {
    const body = [
      '  rows = c-[msg:Messages]-> { return { line: msg.`Text` } }',
      '  lines = map(rows, (r) => { return r.line })',
      '  bad = map(rows, (r) => { return r.nope })',
    ].join('\n');
    expect(codes(body)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
  });

  it('literals with different keys are still a dict of what they hold — lookups may then miss', () => {
    const body = [
      '  pick = c.`Name` == "a"',
      '  rows = map(c-[m:Messages]->, (t) => { if (pick) { return { a: "x" } }\n    return { b: "y" } })',
    ].join('\n');
    expect(codes(body)).toEqual([]);
  });
});

describe('AT(list, n) needs an order and may miss', () => {
  it('over an ordered list it answers the element, possibly absent', () => {
    const body = '  lines = List.from(c-[m:Messages]->.`Text`)\n  write chat-[:note]-> { Body: lines[0] }';
    expect(codes(body)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('discharged, it is clean', () => {
    const body = '  lines = List.from(c-[m:Messages]->.`Text`)\n  write chat-[:note]-> { Body ?: lines[0] }';
    expect(codes(body)).toEqual([]);
  });

  it('over an unordered one it is refused, exactly as FIRST is', () => {
    const at = '  names = List.from(c-[p:Members]->.`Name`)\n  write chat-[:note]-> { Body ?: names[0] }';
    const first = '  names = List.from(c-[p:Members]->.`Name`)\n  write chat-[:note]-> { Body ?: first(names) }';
    expect(codes(at)).toEqual(['MOV_FOLD_NEEDS_ORDER']);
    expect(codes(first)).toEqual(['MOV_FOLD_NEEDS_ORDER']);
  });
});
