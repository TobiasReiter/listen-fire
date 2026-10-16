// Proves the construction + traversal + filter SHAPE an author writes to pull
// PAST Granola meetings: construct `granola(credentials:)`, traverse its
// `Meetings` meta-collection (with a WHERE / ORDER BY / LIMIT), read a landed
// Meeting Note's fields. The instance schema here mirrors EXACTLY what the real
// catalog projection (`instanceSchemaFromDescriptors`) emits for the Granola
// adapter's `listEntryPoints()` + `describe()` — `collections.Meetings` keyed
// distinctly from the `Meeting Note` position it yields (the `collectionName`
// the adapter declares). So a green check here predicts a green save.

import {
  type InstanceSchema,
  checkProgram,
  mockCatalog,
  parseProgram,
} from 'movement-lang';

// The Granola instance schema as the real projection produces it: one readable
// `Meeting Note` position reachable through a `Meetings` collection.
const granolaSchema: InstanceSchema = {
  positions: {
    'Meeting Note': {
      properties: {
        Title: 'text',
        Summary: 'text',
        Transcript: 'text',
        'Meeting Start': 'date',
        'Meeting End': 'date',
        'Organizer Email': 'text',
      },
      edges: { Attendees: { target: 'Attendee' } },
    },
    Attendee: { properties: { Email: 'text', Name: 'text' }, edges: {} },
  },
  collections: { Meetings: { target: 'Meeting Note' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    granola: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: granolaSchema },
    kg: {
      constructionArgs: [],
      schema: {
        positions: { Meeting: { properties: { Title: 'text', Notes: 'text', Held: 'date' }, edges: {} } },
        collections: { Meeting: { target: 'Meeting' } },
        writableRoots: {
          Meeting: {
            fields: { Title: 'text', Notes: 'text', Held: 'date' },
            resultShape: { externalId: 'text', Title: 'text', Notes: 'text', Held: 'date' },
          },
        },
        supportsInPlaceUpdate: true,
      },
    },
  },
  credentials: { granola_cred: { adapter: 'granola' } },
});

const errors = (source: string): string[] =>
  checkProgram(parseProgram(source), catalog)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);

const PRELUDE = [
  'import { granola, kg } from adapters',
  'import { granola_cred } from credentials',
  '',
  'past = connect granola using granola_cred',
  // The graph is an ordinary adapter: constructed and named like any other, so
  // the writes below are really typed against its `Meeting` root rather than
  // skipped as an unresolvable head.
  'graph = connect kg',
].join('\n');

describe('a movement pulling PAST Granola meetings via the `Meetings` collection', () => {
  it('checks ok:true — construct, traverse `Meetings`, read the Meeting Note`s fields', () => {
    const source = [
      PRELUDE,
      '',
      'function file_past_meetings(root: <past-[:`Meeting Note`]->>) {',
      '  past-[m:Meetings]-> {',
      '    write graph-[:Meeting]-> {',
      '      unique by (`Title`)',
      '      Title: m.`Title`',
      '      Notes: m.`Summary`',
      '      Held:  m.`Meeting Start`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    // The head roots at the constructed `past` instance (the meta position),
    // traverses its `Meetings` collection, and each landed `m` is a Meeting
    // Note whose Summary / Title / Meeting Start read cleanly.
    expect(errors(source)).toEqual([]);
  });

  it('accepts a date WHERE + ORDER BY + LIMIT on the `Meetings` collection hop', () => {
    const source = [
      PRELUDE,
      '',
      'function recent_meetings(root: <past-[:`Meeting Note`]->>) {',
      '  past-[m:Meetings WHERE m.`Meeting Start` > @current_date ORDER BY m.`Meeting Start` LIMIT 25]-> {',
      '    write graph-[:Meeting]-> {',
      '      unique by (`Title`)',
      '      Title: m.`Title`',
      '      Notes: m.`Transcript`',
      '    }',
      '  }',
      '}',
    ].join('\n');
    expect(errors(source)).toEqual([]);
  });

  it('rejects a meta-collection that the instance does not publish', () => {
    const source = [
      PRELUDE,
      '',
      'movement bad(root: <past-[:`Meeting Note`]->>) {',
      '  past-[m:webinars]-> {',
      '    write graph-[:Meeting]-> { unique by (`Title`) Title: m.`Title` }',
      '  }',
      '}',
    ].join('\n');
    expect(errors(source).join('\n')).toMatch(/has no collection 'webinars'/);
  });
});
