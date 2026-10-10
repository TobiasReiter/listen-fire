// The set/list split — which folds may read which collections.
//
// A collection either carries a meaningful order or it does not. Order-sensitive
// folds (JOIN, FIRST, LAST, AT) need one that does; commutative folds (COUNT,
// SUM, MIN, MAX, ONLY, COLLECT) answer the same over any permutation and take
// either. The order comes from exactly three places: an authored ORDER BY, an
// edge the adapter declares inherently sequenced, or a value collection that is
// a sequence by construction. Anything else is a set, and saying "first" of a
// set is a guarantee nobody has.
//
// TWO SCHEMAS on purpose: a fixture matching one shape cannot tell derived from
// hardcoded, so the sequenced-edge cases run against both a `chronological`
// edge in one graph and a `document` edge in another.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic } from '../check';
import { mockCatalog, type SchemaFieldType, type InstanceSchema } from '../catalog';

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: {
        // Declared sequenced: the provider answers oldest-first.
        Messages: { target: 'message', readable: true, sequenced: 'chronological' },
        // Nothing declares an order for who is in a channel.
        Members: { target: 'person', readable: true },
        // A bag nobody enumerated — reads and hops off it stay silent.
        Raw: { target: 'bag', readable: true },
      },
    },
    message: { properties: { Text: 'text', At: 'datetime' }, edges: {} },
    person: {
      // `Aliases` is many-valued on purpose: an ordering key over it answers
      // with several values and has nothing to rank by.
      properties: { Name: 'text', Aliases: textList },
      edges: { Employer: { target: 'org', readable: true } },
    },
    org: { properties: { Name: 'text', Founded: 'datetime' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
    bag: { properties: {}, edges: {}, openProperties: true },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const docSchema: InstanceSchema = {
  positions: {
    file: {
      properties: { Title: 'text' },
      edges: {
        // A different graph, a different flavour of sequencing — same rule.
        Sections: { target: 'section', readable: true, sequenced: 'document' },
        Tags: { target: 'tag', readable: true },
      },
    },
    section: { properties: { Heading: 'text' }, edges: {} },
    tag: { properties: { Label: 'text' }, edges: {} },
  },
  collections: { Files: { target: 'file' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    slack: { constructionArgs: [], schema: chatSchema },
    drive: { constructionArgs: [], schema: docSchema },
  },
});

const PRELUDE = `import { slack, drive } from adapters
chat = slack()
docs = drive()
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(c: <chat-[:channel]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('an order-sensitive fold needs a collection with an order', () => {
  it('JOIN over an unordered edge is refused, and the message names the fixes', () => {
    const body = '  t = JOIN(c-[p:Members]->.`Name`, ", ")';
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(messages(body)).toContain('no particular order');
    expect(messages(body)).toContain('ORDER BY');
  });

  it('JOIN over the same edge with an ORDER BY is clean', () => {
    expect(codes('  t = JOIN(c-[p:Members ORDER BY `Name`]->.`Name`, ", ")')).toEqual([]);
  });

  it('JOIN over a SEQUENCED edge is clean with no ORDER BY at all', () => {
    expect(codes('  t = JOIN(c-[m:Messages]->.`Text`, "\\n")')).toEqual([]);
  });

  it('…and over the other graph\'s document-ordered edge too', () => {
    expect(
      codes('  f = ONLY(docs-[x:Files ORDER BY `Title`]->)\n  t = JOIN(f-[s:Sections]->.`Heading`, ", ")'),
    ).toEqual([]);
  });

  it('a root collection is a set until an ORDER BY says otherwise', () => {
    expect(codes('  t = JOIN(chat-[x:Channels]->.`Name`, ", ")')).toContain(
      'MOV_FOLD_NEEDS_ORDER',
    );
    expect(codes('  t = JOIN(chat-[x:Channels ORDER BY `Name`]->.`Name`, ", ")')).toEqual([]);
  });

  it('FIRST over an unordered edge is refused, and the message names ONLY', () => {
    const body = '  n = FIRST(c-[p:Members]->.`Name`)';
    expect(codes(body)).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(messages(body)).toContain('ONLY(');
  });

  it('LAST is the same rule, and clean over a sequenced edge', () => {
    expect(codes('  t = LAST(c-[p:Members]->.`Name`)')).toContain('MOV_FOLD_NEEDS_ORDER');
    expect(codes('  t = LAST(c-[m:Messages]->.`Text`)')).toEqual([]);
  });
});

describe('a commutative fold takes a set or a list', () => {
  it('COUNT, SUM, MIN, MAX and COLLECT over an unordered edge are clean', () => {
    expect(codes('  n = COUNT(c-[p:Members]->)')).toEqual([]);
    expect(codes('  n = MIN(c-[p:Members]->.`Name`)')).toEqual([]);
    expect(codes('  n = MAX(c-[p:Members]->.`Name`)')).toEqual([]);
    expect(codes('  n = COLLECT(c-[p:Members]->.`Name`)')).toEqual([]);
  });

  it('ONLY over a filtered traversal is clean — it is the lookup spelling', () => {
    expect(codes('  n = ONLY(c-[p:Members WHERE `Name` == "ada"]->.`Name`)')).toEqual([]);
  });

  it('ONLY over a bare walk picks a POSITION, exactly as FIRST does', () => {
    const source = `${PRELUDE}
movement m(c: <chat-[:channel]->>) {
  p = ONLY(c-[x:Members WHERE \`Name\` == "ada"]->)
  t = p.\`Name\`
}`;
    const { recording } = checkProgramWithLink(parseProgram(source), catalog, {
      recordAnalysis: true,
    });
    const symbols = (recording?.frames ?? []).flatMap((f) => [...f.scope.symbols.values()]);
    expect(symbols.find((s) => s.name === 'p')?.bindingPlane).toBe('node');
  });

  it('COLLECT carries the ordering through — folding what it collected is the same rule', () => {
    expect(codes('  n = JOIN(COLLECT(c-[p:Members]->.`Name`), ", ")')).toContain(
      'MOV_FOLD_NEEDS_ORDER',
    );
    expect(codes('  n = JOIN(COLLECT(c-[m:Messages]->.`Text`), ", ")')).toEqual([]);
  });
});

describe('LIMIT without ORDER BY is the same bug', () => {
  it('refused over an unordered edge, naming the fix', () => {
    const body = '  n = COUNT(c-[p:Members LIMIT 3]->)';
    expect(codes(body)).toContain('MOV_LIMIT_NEEDS_ORDER');
    expect(messages(body)).toContain('ORDER BY');
  });

  it('an ORDER BY discharges it', () => {
    expect(codes('  n = COUNT(c-[p:Members ORDER BY `Name` LIMIT 3]->)')).toEqual([]);
  });

  it('so does a sequenced edge — "the latest three" is a real thing to ask there', () => {
    expect(codes('  n = COUNT(c-[m:Messages LIMIT 3]->)')).toEqual([]);
  });
});

describe('nobody has said is not the same as no order', () => {
  it('a walk off a position nobody enumerated says nothing', () => {
    expect(codes('  t = JOIN(c-[b:Raw]->-[x:whatever]->.`Name`, ", ")')).toEqual([]);
  });

  it('a fold over a plain value is not this rule\'s business', () => {
    expect(codes('  t = JOIN(c.`Name`, ", ")')).toEqual([]);
  });
});

describe("an extract result's nested nodes come back in the document's order", () => {
  it('JOIN over an extract entry edge is clean with no ORDER BY', () => {
    expect(
      codes(
        [
          '  found = extract from [c.`Name`] {',
          '    node entry: "each company mentioned" {',
          '      name: "the name"',
          '    }',
          '  }',
          '  t = JOIN(found-[e:entry]->.`name`, ", ")',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('an await landing is arrival-ordered', () => {
  it("a callback's calls fold in the order they landed", () => {
    expect(codes('  cb = callback({ write chat-[:note]-> { Body: "x" } })\n  t = JOIN(cb-[k:Called]->.`At`, ", ")')).toEqual(
      [],
    );
  });
});

// An ordering key is an expression over the element the hop lands on — the same
// expression a bracket WHERE is, typed the same way, at the same place.
describe('an ORDER BY key is an expression over the element', () => {
  it('a bare property is still a read of the landed record, typo and all', () => {
    expect(codes('  t = JOIN(c-[p:Members ORDER BY `Nam`]->.`Name`, ", ")')).toContain(
      'MOV_UNKNOWN_PROPERTY',
    );
  });

  it('a short path off the hop’s own alias is clean, and orders the fold', () => {
    expect(
      codes('  t = JOIN(c-[p:Members ORDER BY p-[:Employer]->.`Founded`]->.`Name`, ", ")'),
    ).toEqual([]);
  });

  it('…and a typo one hop along is caught where it is written', () => {
    expect(
      codes('  t = JOIN(c-[p:Members ORDER BY p-[:Employer]->.`Foundd`]->.`Name`, ", ")'),
    ).toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('a key that asks a model is refused — a key is a function of the record', () => {
    const body = '  t = JOIN(c-[p:Members ORDER BY AI("rank this")]->.`Name`, ", ")';
    expect(codes(body)).toContain('MOV_ORDER_KEY_IMPURE');
    expect(messages(body)).toContain('AI(…)');
  });

  it('a key that answers with several values is refused, naming the fold that fixes it', () => {
    const body = '  t = JOIN(c-[p:Members ORDER BY `Aliases`]->.`Name`, ", ")';
    expect(codes(body)).toContain('MOV_ORDER_KEY_MULTI');
    expect(messages(body)).toContain('MIN(…)');
  });

  it('the same walk, the same LIMIT, discharged by a path key', () => {
    expect(
      codes('  n = COUNT(c-[p:Members ORDER BY p-[:Employer]->.`Founded` LIMIT 3]->)'),
    ).toEqual([]);
  });
});

describe('SORT orders a collection already in hand', () => {
  const bound = '  names = c-[p:Members]-> { return p.`Name` }\n';

  it('a collection off an unordered walk is a set, and JOIN refuses it', () => {
    expect(codes(`${bound}  t = JOIN(names, ", ")`)).toContain('MOV_FOLD_NEEDS_ORDER');
  });

  it('…and SORT is what makes it a sequence — JOIN over the answer is clean', () => {
    expect(codes(`${bound}  t = JOIN(SORT(names), ", ")`)).toEqual([]);
    expect(codes(`${bound}  t = JOIN(SORT(names, DESC), ", ")`)).toEqual([]);
  });

  it('FIRST, LAST and AT over a SORT are clean too', () => {
    expect(codes(`${bound}  t = FIRST(SORT(names))`)).toEqual([]);
    expect(codes(`${bound}  t = LAST(SORT(names, DESC))`)).toEqual([]);
    expect(codes(`${bound}  t = AT(SORT(names), 0)`)).toEqual([]);
  });

  it('a key over plain values is refused — a member IS the key there', () => {
    const body = `${bound}  t = JOIN(SORT(names, \`Name\`), ", ")`;
    expect(codes(body)).toContain('MOV_SORT_KEY_ON_SCALAR');
    expect(messages(body)).toContain('SORT(…, DESC)');
  });

  it('SORT of one value is refused — there is nothing to put in order', () => {
    expect(codes('  t = SORT(c.`Name`)')).toContain('MOV_SORT_NOT_COLLECTION');
  });

  it('a walk written inside the call is refused, key or no key, naming the fix', () => {
    const body = '  t = COUNT(SORT(c-[p:Members]->, `Name`))';
    expect(codes(body)).toContain('MOV_SORT_KEY_ON_WALK');
    expect(messages(body)).toContain('Bind the walk first');
    expect(codes('  t = COUNT(SORT(c-[p:Members]->))')).toContain('MOV_SORT_KEY_ON_WALK');
  });

  it('values with named parts need a key too', () => {
    const rows = '  rows = c-[p:Members]-> { return { who: p.`Name`, tag: p.`Name` } }\n';
    expect(codes(`${rows}  t = COUNT(SORT(rows))`)).toContain('MOV_SORT_NEEDS_KEY');
    expect(codes(`${rows}  t = COUNT(SORT(rows, \`who\`))`)).toEqual([]);
  });

  it('records with no key are refused — a record has no order of its own', () => {
    const body = '  people = c-[p:Members]-> { return p }\n  t = COUNT(SORT(people))';
    expect(codes(body)).toContain('MOV_SORT_NEEDS_KEY');
    expect(codes('  people = c-[p:Members]-> { return p }\n  t = COUNT(SORT(people, `Name`))')).toEqual(
      [],
    );
  });
});
