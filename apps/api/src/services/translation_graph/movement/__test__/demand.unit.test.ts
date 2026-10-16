// The compile path's demand set: seed = types the program NAMES (verbatim
// natural names + every event-position entry), closure = hop targets along
// the program's traversal paths, iterated because a target only becomes
// known once its parent is described.

import {
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  scanInstanceChains,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

import {
  closeDemandOverChains,
  closeDemandOverWriteVariants,
  demandSeed,
} from '../demand';
import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';

const entries: SchemaEntryPoint[] = [
  { typeId: 'obj-companies', displayName: 'Companies', writable: true, readable: true },
  { typeId: 'obj-leads', displayName: 'Lead List', writable: true, readable: true },
  { typeId: 'obj-invoices', displayName: 'Invoices', writable: true, readable: true },
  {
    typeId: 'obj-events',
    displayName: 'Record Event',
    writable: false,
    readable: true,
    fires: true,
  },
];

const descriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'obj-companies',
    {
      typeId: 'obj-companies',
      displayName: 'Companies',
      fields: [
        { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
      ],
      // The edge NAME ('leads') differs from the target type name ('Lead
      // List') — only the closure can discover this demand, never the seed.
      references: [{ fieldId: 'leads', targetTypeId: 'obj-leads', cardinality: 'many' }],
    },
  ],
]);

const source = `import { crm } from adapters
import { crm_cred } from credentials
c = connect crm using crm_cred
movement m(x: <c-[:Companies]->>) {
  c-[co:Companies]->-[l:leads]-> { }
}`;

describe('demandSeed', () => {
  it('demands textually-named entries and every event-position entry, nothing else', () => {
    const demanded = demandSeed({ entries, sources: [source] });
    expect(demanded).toEqual(new Set(['obj-companies', 'obj-events']));
  });
});

describe('closeDemandOverChains', () => {
  it('discovers hop targets whose edge name differs from the type name', () => {
    // Round 1's interim schema: full entries, only the seed described.
    const interim = instanceSchemaFromDescriptors({
      adapterType: 'crm',
      entries,
      descriptors,
      supportsInPlaceUpdate: false,
    });
    // Collections are complete despite partial description (full entry list),
    // and the types nobody has described yet say exactly that — `undescribed`,
    // which the closure below is what fills in. Not `openProperties`: an
    // un-demanded type makes no claim about its surface, and a read through one
    // the closure never reached is a guess rather than a licensed unknown.
    expect(Object.keys(interim.schema.collections).sort()).toEqual([
      'Companies',
      'Invoices',
      'Lead List',
      'Record Event',
    ]);
    expect(interim.schema.positions['Lead List']).toEqual({
      properties: {},
      edges: {},
      undescribed: true,
    });

    const touched = closeDemandOverChains({
      schema: interim.schema,
      chains: scanInstanceChains(source),
    });
    expect(touched).toEqual(new Set(['Companies', 'Lead List']));
  });

  it('steps through a UNION start — the record edge lives on the variants', () => {
    // A movement types its param as the event UNION (`<c-[:`Record
    // Event`]->>`) and reads through the event's `record` edge. The union is
    // not a position — its variants are — so the closure must consult them
    // or the record's type is never demanded and every read through it
    // projects undescribed. (The messaging adapters are exactly this shape:
    // the edge name `record` never matches the target's type name.)
    // plans/2026-07-10-adapter-entry-positions/8_event_edges.md
    const eventDescriptors = new Map<string, SchemaTypeDescriptor>([
      [
        'obj-events',
        {
          typeId: 'obj-events',
          displayName: 'Record Event',
          fields: [],
          references: [{ fieldId: 'record', targetTypeId: 'obj-invoices', cardinality: 'one' }],
        },
      ],
    ]);
    const interim = instanceSchemaFromDescriptors({
      adapterType: 'crm',
      entries,
      descriptors: eventDescriptors,
      supportsInPlaceUpdate: false,
    });
    const unionSource = `import { crm } from adapters
import { crm_cred } from credentials
c = connect crm using crm_cred
movement m(x: <c-[:\`Record Event\`]->>) {
  x-[r:record]-> { }
}`;
    const touched = closeDemandOverChains({
      schema: interim.schema,
      chains: scanInstanceChains(unionSource),
    });
    expect(touched).toEqual(new Set(['Record Event', 'Invoices']));
  });

  it('a hop LANDING on a union demands its MEMBERS, never the derived key', () => {
    // A multi-target adapter reference projects a polymorphic edge onto a union
    // key. The key is not a type — asking the adapter to describe it resolves
    // nothing, and the members stay undescribed, which silences the narrowing
    // diagnostics the union exists to produce.
    const multiDescriptors = new Map<string, SchemaTypeDescriptor>([
      [
        'obj-companies',
        {
          typeId: 'obj-companies',
          displayName: 'Companies',
          fields: [],
          references: [
            {
              fieldId: 'advisors',
              targetTypeId: 'obj-leads',
              targetTypeIds: ['obj-leads', 'obj-invoices'],
              cardinality: 'many',
            },
          ],
        },
      ],
    ]);
    const interim = instanceSchemaFromDescriptors({
      adapterType: 'crm',
      entries,
      descriptors: multiDescriptors,
      supportsInPlaceUpdate: false,
    });
    const multiSource = `import { crm } from adapters
import { crm_cred } from credentials
c = connect crm using crm_cred
movement m(x: <c-[:Companies]->>) {
  c-[co:Companies]->-[a:advisors]-> { }
}`;
    const touched = closeDemandOverChains({
      schema: interim.schema,
      chains: scanInstanceChains(multiSource),
    });
    expect(touched).toEqual(new Set(['Companies', 'Lead List', 'Invoices']));
  });
});

// A type reached only by a WRITE edge, and the variant types a discriminated
// write declares, are both invisible to the two demand mechanisms above: the
// seed matches source text (neither name appears there) and the chain closure
// only ever walked READ hops. Undemanded ⇒ undescribed ⇒ the create body was
// checked against nothing at all. Regression cover for that hole.
describe('demand reaches write-only landings', () => {
  it('scans the hop chain off a root-write HANDLE', () => {
    // `co` names the written record, so `co-[:\`List Entries\`]->` is the chain
    // `crm-[:Companies]->-[:\`List Entries\`]->`. Before this, nothing rooted at
    // a write handle was scanned at all.
    const writeSource = `import { crm } from adapters
import { crm_cred } from credentials
c = connect crm using crm_cred
movement m(x: <c-[:Companies]->>) {
  co = write c-[:Companies]-> { Name: "Acme" }
  write co-[:leads]-> { listName: "Pipeline" }
}`;
    const chains = scanInstanceChains(writeSource);
    const edgeNames = chains.map((chain) =>
      chain.steps.map((step) => (step.type === 'edge' ? step.edgeTypeId : '?')).join(' → '),
    );
    expect(edgeNames).toContain('Companies → leads');

    // …and the closure therefore lands the write-edge target.
    const interim = instanceSchemaFromDescriptors({
      adapterType: 'crm',
      entries,
      descriptors,
      supportsInPlaceUpdate: false,
    });
    const touched = closeDemandOverChains({ schema: interim.schema, chains });
    expect(touched.has('Lead List')).toBe(true);
  });

  it('demands the variant types a discriminated write declares', () => {
    // The author writes the LITERAL ("Pipeline"), never the type name
    // ('Lead List — Pipeline'), so no textual seed and no hop reaches it.
    const withVariants = new Map<string, SchemaTypeDescriptor>([
      [
        'obj-leads',
        {
          typeId: 'obj-leads',
          displayName: 'Lead List',
          fields: [],
          references: [],
          discriminatedWrite: {
            discriminant: 'listName',
            variantTypes: { Pipeline: 'Lead List — Pipeline', Portfolio: 'Lead List — Portfolio' },
          },
        },
      ],
    ]);
    expect(closeDemandOverWriteVariants(withVariants)).toEqual(
      new Set(['Lead List — Pipeline', 'Lead List — Portfolio']),
    );
  });

  // The EDITOR's form of the same rule. It cannot send raw source (a tRPC
  // query's input rides in the URL), so it sends `referencedNames(source)` and
  // these are matched EXACTLY rather than by substring.
  describe('mentions — the pre-extracted-names form', () => {
    it('demands a type the names mention', () => {
      expect(demandSeed({ entries, mentions: ['Companies'] })).toContain('obj-companies');
    });

    // Each mention stands in for the text it came from, so the SAME
    // over-approximation applies. Exact equality is the tempting simplification
    // and it breaks the two properties the substring rule exists for:
    it('matches a mention that CONTAINS an entry name — the hop spelling', () => {
      // `-[:Invoices]->` mentions "Invoices"; the entry is "Invoices" here, but
      // the general case is a plural hop over a singular type.
      expect(demandSeed({ entries, mentions: ['Lead List entries'] })).toContain('obj-leads');
    });

    it('demands the CONTAINER a qualified name implies — the Airtable base walk', () => {
      // `CRM — Companies` must still demand the base `CRM`, or the table hop
      // degrades to the full-workspace lookup this model exists to kill.
      const airtable: SchemaEntryPoint[] = [
        { typeId: 'base-crm', displayName: 'CRM', writable: false, readable: true },
        { typeId: 'tbl-co', displayName: 'CRM — Companies', writable: true, readable: true },
      ];
      expect(demandSeed({ entries: airtable, mentions: ['CRM — Companies'] })).toContain('base-crm');
    });

    // THE GAP hit in production. A listen-driven movement need never spell its event
    // type — its signature carries an address, not a bare name — so demanding
    // only what is named left the event position undescribed and the checker
    // called the program's own parameter type unknown
    // ('instance' has no position type 'Invocation').
    //
    // This exists because the editor path briefly had its OWN copy of this
    // rule, which dropped the `fires` clause. One rule, two input forms.
    it('demands EVERY firing entry even when nothing mentions it', () => {
      const demanded = demandSeed({ entries, mentions: ['Companies'] });
      expect(demanded).toContain('obj-events');
      expect(demanded).not.toContain('obj-invoices');
    });

    it('demands firing entries even with an EMPTY mention list', () => {
      expect(demandSeed({ entries, mentions: [] })).toEqual(new Set(['obj-events']));
    });
  });
});

// A function handed to MAP is a body the run executes once per member, so every
// chain inside it is the movement's demand exactly as if it were written
// outside. The scan used to skip such bodies, so a type reached only by walking
// from a write handle bound INSIDE one (`record-[:Lists]->`) was never
// described, and the checker checked that write against nothing.
describe('demand reads the body of a function handed to MAP', () => {
  const listEntries: SchemaEntryPoint[] = [
    { typeId: 'obj-companies', displayName: 'Companies', writable: true, readable: true },
    { typeId: 'obj-list', displayName: 'Companies List', writable: true, readable: true },
  ];
  const listDescriptors = new Map<string, SchemaTypeDescriptor>([
    [
      'obj-companies',
      {
        typeId: 'obj-companies',
        displayName: 'Companies',
        fields: [
          { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
        ],
        // The edge NAME ('Lists') is not the target's type name, so only the
        // chain closure can reach `Companies List`, never the textual seed.
        references: [
          { fieldId: 'Lists', targetTypeId: 'obj-list', cardinality: 'many', writable: true },
        ],
      },
    ],
    [
      'obj-list',
      {
        typeId: 'obj-list',
        displayName: 'Companies List',
        fields: [
          { fieldId: 'Stage', displayName: 'Stage', kind: 'string', writable: true, required: false },
        ],
        references: [],
      },
    ],
  ]);

  const PRELUDE = `import { crm } from adapters
import { crm_cred } from credentials
c = connect crm using crm_cred
`;
  const writes = (listBody: string) =>
    `    record = write c-[:Companies]-> { Name: n }\n    write record-[:Lists]-> { ${listBody} }`;
  const insideMap = (listBody: string) =>
    `${PRELUDE}function m() {\n  names = ["Acme", "Globex"]\n  map(names, (n) => {\n${writes(listBody)}\n  })\n}`;
  const outsideMap = (listBody: string) =>
    `${PRELUDE}function m() {\n  n = "Acme"\n${writes(listBody)}\n}`;

  const walkedPaths = (source: string, languageVersion?: number): string[] =>
    scanInstanceChains(source, languageVersion !== undefined ? { languageVersion } : undefined)
      .map((chain) =>
        chain.steps.map((step) => (step.type === 'edge' ? step.edgeTypeId : '?')).join(' → '),
      )
      .sort();

  /** The catalog's demand loop in miniature: seed, describe what is demanded,
   *  close over the chains, repeat until a round adds nothing. */
  const demandScopedSchema = (source: string): InstanceSchema => {
    const demanded = demandSeed({ entries: listEntries, sources: [source] });
    const typeIdByName = new Map(listEntries.map((e) => [e.displayName, e.typeId]));
    const chains = scanInstanceChains(source);
    for (;;) {
      const described = new Map<string, SchemaTypeDescriptor>();
      for (const typeId of demanded) {
        const descriptor = listDescriptors.get(typeId);
        if (descriptor) described.set(typeId, descriptor);
      }
      const projection = instanceSchemaFromDescriptors({
        adapterType: 'crm',
        entries: listEntries,
        descriptors: described,
        supportsInPlaceUpdate: false,
      });
      let grew = false;
      for (const name of closeDemandOverChains({ schema: projection.schema, chains })) {
        const typeId = typeIdByName.get(name) ?? name;
        if (!demanded.has(typeId)) {
          demanded.add(typeId);
          grew = true;
        }
      }
      if (!grew) return projection.schema;
    }
  };

  const errorCodes = (source: string): string[] => {
    const snapshot: CatalogSnapshot = {
      adapters: {
        crm: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          schemas: { crm_cred: demandScopedSchema(source) },
        },
      },
      credentials: { crm_cred: { adapter: 'crm' } },
      plugins: {},
    };
    return checkProgram(parseProgram(source), fromCatalogSnapshot(snapshot))
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);
  };

  it('walks the same paths inside MAP as outside it', () => {
    const outside = walkedPaths(outsideMap('Stage: "Seed"'));
    expect(outside).toEqual(['Companies', 'Companies → Lists']);
    expect(walkedPaths(insideMap('Stage: "Seed"'))).toEqual(outside);
  });

  it('a field the walked type lacks is refused inside MAP, as it is outside', () => {
    expect(errorCodes(insideMap('Stage: "Seed"'))).toEqual([]);
    const outside = errorCodes(outsideMap('Stage: "Seed", Bogus: "x"'));
    expect(outside.length).toBeGreaterThan(0);
    expect(errorCodes(insideMap('Stage: "Seed", Bogus: "x"'))).toEqual(outside);
  });

  it("a hop rooted at the function's parameter grounds nothing — its type is not the scan's to invent", () => {
    const source = `${PRELUDE}function m() {\n  names = ["Acme"]\n  map(names, (n) => {\n    n-[:Lists]-> { }\n  })\n}`;
    expect(walkedPaths(source)).toEqual([]);
  });

  it('a parameter shadows a handle of the same name bound outside the function', () => {
    const source = `${PRELUDE}function m() {\n  record = write c-[:Companies]-> { Name: "Acme" }\n  MAP(["x"], (record) => {\n    record-[:Lists]-> { }\n  })\n}`;
    expect(walkedPaths(source)).toEqual(['Companies']);
  });

  it('a movement pinned to version 1 or 2 keeps the scan it was saved under', () => {
    for (const languageVersion of [1, 2]) {
      expect(walkedPaths(insideMap('Stage: "Seed"'), languageVersion)).toEqual([]);
    }
  });
});
