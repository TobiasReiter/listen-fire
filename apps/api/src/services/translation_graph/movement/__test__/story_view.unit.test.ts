// The StoryView join — the IR meets the display vocabulary.
//
// The claim under test is adapter-blindness: every rendered WORD comes from
// what a system declared, and the join only composes. So the fixture uses two
// unrelated shapes with unrelated vocabularies, and one of them declares
// nothing at all — a join that hardcoded either would fail on the other.

import { mockCatalog, storyOf, type InstanceSchema, type StoryIR } from 'movement-lang';

import type { TeamMovementCatalog } from '../catalog';

import {
  joinStoryView,
  storyVocabularyOf,
  type StoryProvisionedListener,
  type StoryVocabulary,
  type StoryView,
} from '../story_view';

// ── Fixture: two systems that share no vocabulary ──

/** The trigger side, plus the pause: a desk whose Query root awaits a Reply. */
const deskSchema: InstanceSchema = {
  positions: {
    note: { properties: { text: 'text' }, edges: {} },
    reply: { properties: { answer: 'boolean' }, edges: {} },
  },
  collections: { Query: { target: 'Query' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Query: {
      fields: { prompt: 'text' },
      resultShape: { externalId: 'text' },
      edges: { Reply: { target: 'reply', awaitable: true, watchable: true, resolvesEmpty: true } },
    },
  },
  eventPositions: [{ position: 'note', on: ['note.filed'] }],
};

/** The write side: a two-record graph with a parent edge. */
const ledgerSchema: InstanceSchema = {
  positions: {
    Orgs: { properties: { Title: 'text' }, edges: { Entries: { target: 'Entries', writable: true } } },
    Entries: { properties: { Amount: 'number' }, edges: {} },
  },
  collections: { Orgs: { target: 'Orgs' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Orgs: {
      fields: { Title: 'text' },
      resultShape: { externalId: 'text' },
      edges: { Entries: { target: 'Entries', writable: true } },
    },
    Entries: { fields: { Amount: 'number', Stage: 'text' }, resultShape: {} },
  },
};

const catalog = mockCatalog({
  adapters: {
    desk_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['box', 'events'],
      triggerConfigOptions: { events: ['note.filed'] },
      schema: deskSchema,
    },
    ledger_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: ledgerSchema,
    },
  },
  credentials: { desk_creds: { adapter: 'desk_sys' }, ledger_creds: { adapter: 'ledger_sys' } },
});

const SOURCE = `import { desk_sys, ledger_sys } from adapters
import { desk_creds, ledger_creds } from credentials

desk = connect desk_sys using desk_creds
books = connect ledger_sys using ledger_creds

function intake(n: <desk-[:note]->>) {
  facts = extractOne([n.\`text\`], node Facts: "what the note says" {
    who: <text> "who filed it"
    node vendor: "the supplier it mentions" {
      title: <text> "the supplier's name"
      node contact: "anyone named at the supplier" {
        email: <text> "their email address"
      }
    }
  })
  org = write books-[:Orgs]-> { unique by (\`Title\`) Title: n.\`text\` }
  entry = write org-[:Entries]-> { Amount: 12 }
  books-[shop:Orgs WHERE shop.\`Title\` == "acme"]-> {
    seen = shop.\`Title\`
  }
  org-[line:Entries]-> {
    seen_line = line.\`Amount\`
  }
  q = write desk-[:Query]-> { prompt: "approve this?" }
  ok = await first(q-[:Reply]->)
  if (ok) {
    write entry { Stage: "settled" }
  }
  await sleep(2d)
}

listen to desk { box: "inbound", events: ["note.filed"] } fire intake
`;

/**
 * Display vocabulary that agrees with NOTHING in the program's own spelling —
 * the point being that if any of it shows up in the view, it was read, not
 * assumed. `ledger_sys` deliberately declares no phrase and no record labels.
 */
const vocabulary: StoryVocabulary = {
  system(adapterType) {
    if (adapterType === 'desk_sys') {
      return { label: 'Front Desk', icon: { d: 'M0 0h1v1H0z', fill: true } };
    }
    if (adapterType === 'ledger_sys') return { label: 'Big Book', icon: null };
    return null;
  },
  eventPhrase(adapterType, config) {
    // The graph declares its own phrasing on its manifest like any other
    // system — nothing in the renderer knows what a knowledge graph is.
    if (adapterType === 'kg') return 'When something changes in your knowledge graph';
    if (adapterType !== 'desk_sys') return null;
    const box = config.box;
    return typeof box === 'string' ? `When a note is filed in ${box}` : null;
  },
  recordLabel({ adapterType, recordType }) {
    if (adapterType === 'ledger_sys' && recordType === 'Entries') return 'Line Item';
    return null;
  },
};

function ir(): StoryIR {
  const result = storyOf({ source: SOURCE, catalog, name: 'Intake' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

function view(): StoryView {
  const story = ir();
  return joinStoryView({
    movement: { id: 'mv-1', name: 'Intake', validity: story.movement.validity },
    story,
    vocabulary,
  });
}

function recordNamed(v: StoryView, binding: string): StoryView['records'][number] {
  const found = v.records.find((r) => r.binding === binding);
  if (!found) throw new Error(`no record bound to ${binding}`);
  return found;
}

// ── The fixture is a program that would run ──

describe('the fixture', () => {
  it('is a valid program, so the view is of something real', () => {
    expect(ir().movement.validity.status).toBe('valid');
  });
});

// ── Systems ──

describe('systems', () => {
  it('labels and icons come from what the system declared, per system', () => {
    const v = view();
    expect(recordNamed(v, 'org').system).toEqual({
      key: 'ledger_sys',
      label: 'Big Book',
      icon: null,
    });
    expect(recordNamed(v, 'q').system).toEqual({
      key: 'desk_sys',
      label: 'Front Desk',
      icon: { d: 'M0 0h1v1H0z', fill: true },
    });
  });

  it('a system nothing is declared for resolves to nothing, not to its slug', () => {
    const v = joinStoryView({
      movement: { id: 'mv-1', name: 'Intake', validity: { status: 'valid', problems: [] } },
      story: ir(),
      vocabulary: { ...vocabulary, system: () => null },
    });
    for (const record of v.records) expect(record.system).toBeNull();
    expect(v.records.map((r) => r.sentence)).not.toContain(expect.stringContaining('ledger_sys'));
  });
});

// ── Records ──

describe('records', () => {
  it('composes the card sentence from the DECLARED record label', () => {
    const entry = recordNamed(view(), 'entry');
    expect(entry.label).toBe('Line Item');
    expect(entry.sentence).toBe('Creates Line Item in Big Book');
  });

  it('falls back to the type as the schema names it when none is declared', () => {
    const v = view();
    expect(recordNamed(v, 'org').label).toBe('Orgs');
    expect(recordNamed(v, 'org').sentence).toBe('Creates Orgs in Big Book');
  });

  it('a writable-only root has NO type name, and the view says so', () => {
    // The ask's target mints no position, so nothing declared a type name.
    // Null is the honest answer; a made-up one would read as declared.
    expect(recordNamed(view(), 'q').label).toBeNull();
  });

  it('says what the write actually does — create vs update', () => {
    const v = view();
    expect(recordNamed(v, 'entry').verb).toBe('Creates');
    const updates = v.records.filter((r) => r.action === 'update');
    expect(updates.length).toBe(1);
    expect(updates[0]!.sentence).toBe('Updates Line Item in Big Book');
  });

  it('keeps the authored expressions as chips, untouched', () => {
    const org = recordNamed(view(), 'org');
    expect(Object.keys(org.fields)).toEqual(['Title']);
    expect(org.fields.Title!.source).toBe('n.`text`');
    expect(org.uniqueBy.map((c) => c.source)).toEqual(['`Title`']);
  });
});

// ── Extractions ──
//
// An extraction is the one thing on the page whose words are entirely the
// AUTHOR's — no system named any of it. So the join's job is to carry the whole
// graph through untouched; summarising it here would lose the only description
// of what is being looked for that exists anywhere.

describe('extractions', () => {
  function extractionOf(v: StoryView) {
    const found: Array<Extract<StoryView['flow'][number], { kind: 'extract' }>> = [];
    const walk = (steps: StoryView['flow']): void => {
      for (const step of steps) {
        if (step.kind === 'extract') found.push(step);
        if (step.kind === 'movement') walk(step.steps);
      }
    };
    walk(v.flow);
    const first = found[0];
    if (!first?.tree) throw new Error('no extraction with a tree');
    return first.tree;
  }

  it('carries every node, its fields and the words the author gave each one', () => {
    const tree = extractionOf(view());

    expect(tree.fields.map((f) => [f.name, f.description, f.type])).toEqual([
      ['who', 'who filed it', 'text'],
    ]);

    const vendor = tree.children[0]!;
    expect(vendor.name).toBe('vendor');
    expect(vendor.description).toBe('the supplier it mentions');
    expect(vendor.fields.map((f) => f.description)).toEqual(["the supplier's name"]);

    // Nesting survives to any depth — the whole point of sending a tree.
    const contact = vendor.children[0]!;
    expect(contact.name).toBe('contact');
    expect(contact.description).toBe('anyone named at the supplier');
    expect(contact.fields.map((f) => [f.name, f.description])).toEqual([
      ['email', 'their email address'],
    ]);
  });

  it('adds no vocabulary of its own — the tree is the IR’s, verbatim', () => {
    expect(extractionOf(view())).toEqual(
      extractionOf(
        joinStoryView({
          movement: { id: 'mv-1', name: 'Intake', validity: { status: 'valid', problems: [] } },
          story: ir(),
          vocabulary: { system: () => null, eventPhrase: () => null, recordLabel: () => null },
        }),
      ),
    );
  });
});

// ── Traversals ──
//
// A traversal reaches the page as structure and a handful of DECLARED words.
// The join's whole job here is those words: what the system calls what each hop
// lands on, and nothing else.

describe('traversals', () => {
  function traversalOf(v: StoryView, binding: string): StoryView['traversals'][number] {
    const found = v.traversals.find((t) => t.hops.some((h) => h.binding === binding));
    if (!found) throw new Error(`no traversal binding ${binding}`);
    return found;
  }

  it('resolves each hop to the label the SYSTEM declared for what it lands on', () => {
    const carried = traversalOf(view(), 'line');
    expect(carried.hops[0]!.label).toBe('Line Item');
    expect(carried.hops[0]!.system).toEqual({ key: 'ledger_sys', label: 'Big Book', icon: null });
  });

  it('falls back to the type as the schema names it, and to null when nothing named one', () => {
    const shop = traversalOf(view(), 'shop');
    expect(shop.hops[0]!.label).toBe('Orgs');
    const v = joinStoryView({
      movement: { id: 'mv-1', name: 'Intake', validity: { status: 'valid', problems: [] } },
      story: ir(),
      vocabulary: { ...vocabulary, recordLabel: () => null },
    });
    expect(traversalOf(v, 'shop').hops[0]!.label).toBe('Orgs');
    expect(traversalOf(v, 'line').hops[0]!.label).toBe('Entries');
  });

  it('says whether the walk fans out over records or carries an earlier result', () => {
    const v = view();
    expect(traversalOf(v, 'shop').from).toBe('graph');
    expect(traversalOf(v, 'line').from).toBe('result');
  });

  it('carries the filter through as structure — nothing about it is display', () => {
    const shop = traversalOf(view(), 'shop');
    expect(shop.hops[0]!.filter).toEqual({
      kind: 'comparisons',
      all: [
        {
          field: 'Title',
          operator: 'eq',
          value: {
            source: '"acme"',
            role: 'literal',
            refs: [],
            parts: [{ kind: 'text', text: '"acme"' }],
          },
        },
      ],
    });
    expect(traversalOf(view(), 'line').hops[0]!.filter).toBeUndefined();
  });

  it('every traversal in the flow is resolved, and each one is found by its own id', () => {
    const v = view();
    const ids = v.traversals.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(traversalOf(v, 'shop').id);
  });

  // A walk written inside a fold is a walk: it needs the same declared labels
  // the block head above it gets, or the page composes "the first Orgs" out of
  // the system's own key instead of the word it declared.
  it('a walk written inside a FOLD is resolved too, by the id the chip carries', () => {
    const source = `import { ledger_sys } from adapters
import { ledger_creds } from credentials

books = ledger_sys(credentials: ledger_creds)

movement pick() {
  one = FIRST(books-[fold:Orgs WHERE \`Title\` == "acme"]->)
}
`;
    const result = storyOf({ source, catalog, name: 'Pick' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const v = joinStoryView({
      movement: { id: 'mv-2', name: 'Pick', validity: result.story.movement.validity },
      story: result.story,
      vocabulary: { ...vocabulary, recordLabel: () => 'Organisation' },
    });
    const walk = v.traversals.find((t) => t.hops.some((h) => h.binding === 'fold'));
    expect(walk).toBeDefined();
    expect(walk!.hops[0]!.label).toBe('Organisation');
    expect(walk!.hops[0]!.system).toEqual({ key: 'ledger_sys', label: 'Big Book', icon: null });
  });
});

// ── What a movement takes, and what the file declares ──
//
// A node the FILE declares belongs to no system: nobody's manifest can name it,
// so the author's own word travels in the story. The address the type system
// knows a nested one by is a composed path (`Packet.attachment`), and printing
// THAT as a name is what put a dotted type into a possessive.

describe('declared nodes', () => {
  const DECLARED_SOURCE = `import { desk_sys, ledger_sys } from adapters
import { desk_creds, ledger_creds } from credentials

desk = connect desk_sys using desk_creds
books = connect ledger_sys using ledger_creds

node Packet {
  text: <text>
  node attachment {
    blob: <text>
  }
}

function file_it(src: <Packet>) {
  src-[a:attachment]-> {
    write books-[:Orgs]-> { unique by (\`Title\`) Title: a.blob }
  }
}

function intake(n: <desk-[:note]->>) {
  file_it(node { text: n.\`text\` })
}

listen to desk { box: "inbound", events: ["note.filed"] } fire intake
`;

  function declaredView(): StoryView {
    const result = storyOf({ source: DECLARED_SOURCE, catalog, name: 'Intake' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    expect(result.story.movement.validity.status).toBe('valid');
    return joinStoryView({
      movement: { id: 'mv-2', name: 'Intake', validity: result.story.movement.validity },
      story: result.story,
      vocabulary,
    });
  }

  it('carries the declaration as the author wrote it, keyed by the address it is known at', () => {
    const [packet] = declaredView().shapes;
    expect(packet).toMatchObject({
      name: 'Packet',
      position: 'Packet',
      fields: [{ name: 'text', type: 'text' }],
      children: [
        {
          name: 'attachment',
          position: 'Packet.attachment',
          fields: [{ name: 'blob', type: 'text' }],
        },
      ],
    });
  });

  it('names a landing inside a declaration by the author’s own word, never by the composed address', () => {
    const v = declaredView();
    const nested = v.types.find((t) => t.recordType === 'Packet.attachment');
    expect(nested).toEqual({
      adapterType: null,
      recordType: 'Packet.attachment',
      label: 'attachment',
      system: null,
    });
    const hop = v.traversals.flatMap((t) => t.hops).find((h) => h.binding === 'a');
    expect(hop!.label).toBe('attachment');
  });

  it('a movement says what it takes: the parameter’s type, resolved like any other', () => {
    const v = declaredView();
    const movements = v.flow.filter(
      (step): step is Extract<StoryView['flow'][number], { kind: 'movement' }> =>
        step.kind === 'movement',
    );
    const helper = movements.find((m) => m.name === 'file_it');
    expect(helper!.params).toEqual([
      { name: 'src', type: { graph: 'Packet' }, target: { instance: 'Packet', recordType: 'Packet' } },
    ]);
    const fired = movements.find((m) => m.name === 'intake');
    expect(fired!.params[0]!.target).toEqual({
      adapterType: 'desk_sys',
      instance: 'desk',
      recordType: 'note',
    });
    // Both parameters' types are resolved for display, with the system that
    // owns one and nothing where none does.
    expect(v.types).toContainEqual({
      adapterType: null,
      recordType: 'Packet',
      label: 'Packet',
      system: null,
    });
    expect(v.types).toContainEqual({
      adapterType: 'desk_sys',
      recordType: 'note',
      label: 'note',
      system: { key: 'desk_sys', label: 'Front Desk', icon: { d: 'M0 0h1v1H0z', fill: true } },
    });
  });
});

// ── Pauses ──
//
// A write is a write. The record an ask raises used to be dressed as a pause
// here, which hid its own fields — the question being put — behind a phrase.
// The pause is the AWAIT, and the flow carries it as its own step.

describe('an ask’s record is an ordinary write', () => {
  it('reads with the same verb and sentence any other create gets', () => {
    const q = recordNamed(view(), 'q');
    expect(q.verb).toBe('Creates');
    // A writable-only root mints no position, so nothing declared a type name —
    // the generic stands in, exactly as it does for any other such write.
    expect(q.label).toBeNull();
    expect(q.sentence).toBe('Creates a record in Front Desk');
  });

  it('keeps its own fields, so the question itself is on the card', () => {
    expect(recordNamed(view(), 'q').fields.prompt!.source).toBe('"approve this?"');
  });

  it('the pause is a step of the flow, not a property of a record', () => {
    const asks: string[] = [];
    const walk = (steps: StoryView['flow']): void => {
      for (const step of steps) {
        if (step.kind === 'ask') asks.push(step.edge ?? '');
        if (step.kind === 'movement') walk(step.steps);
      }
    };
    walk(view().flow);
    expect(asks).toEqual(['Reply']);
  });
});

// ── Referents ──

describe('referents', () => {
  it('resolves the label of every type a reference points at', () => {
    // `line.\`Amount\`` reads a landing on Entries — the one type this
    // vocabulary names something else entirely.
    expect(view().types).toContainEqual({
      adapterType: 'ledger_sys',
      recordType: 'Entries',
      label: 'Line Item',
      system: { key: 'ledger_sys', label: 'Big Book', icon: null },
    });
  });

  it('falls back to the type as the schema names it when nothing declared one', () => {
    // `n.\`text\`` reads the event position; the desk declares no label for it.
    expect(view().types).toContainEqual({
      adapterType: 'desk_sys',
      recordType: 'note',
      label: 'note',
      system: { key: 'desk_sys', label: 'Front Desk', icon: { d: 'M0 0h1v1H0z', fill: true } },
    });
  });
});

// ── Triggers ──

describe('triggers', () => {
  it('uses the system’s own declared sentence, filled from the listen config', () => {
    const [trigger] = view().triggers;
    expect(trigger!.sentence).toBe('When a note is filed in inbound');
    expect(trigger!.system?.label).toBe('Front Desk');
    expect(trigger!.fires).toBe('intake');
    expect(trigger!.firesMovement).toBe(true);
  });

  it('composes a generic sentence from the declared label when none is declared', () => {
    const v = joinStoryView({
      movement: { id: 'mv-1', name: 'Intake', validity: { status: 'valid', problems: [] } },
      story: ir(),
      vocabulary: { ...vocabulary, eventPhrase: () => null },
    });
    expect(v.triggers[0]!.sentence).toBe('When something happens in Front Desk');
  });

  // A phrasing that PREFERS the provisioned address and falls back to the
  // config the script itself carries — the ordered shape every adapter's
  // templates take.
  const addressFirst: StoryVocabulary = {
    ...vocabulary,
    eventPhrase(adapterType, config) {
      if (adapterType !== 'desk_sys') return null;
      if (typeof config.address === 'string') return `When you send a note to ${config.address}`;
      return typeof config.box === 'string' ? `When a note is filed in ${config.box}` : null;
    },
  };

  const withListeners = (listeners: StoryProvisionedListener[]): StoryView =>
    joinStoryView({
      movement: { id: 'mv-1', name: 'Intake', validity: { status: 'valid', problems: [] } },
      story: ir(),
      vocabulary: addressFirst,
      listeners,
    });

  it('fills a phrase slot from what the PLATFORM provisioned, not from the script', () => {
    const v = withListeners([
      {
        kind: 'desk_sys',
        movementName: 'intake',
        config: { box: 'inbound' },
        inboundAddress: 'desk+inbound@example.com',
      },
    ]);
    expect(v.triggers[0]!.sentence).toBe('When you send a note to desk+inbound@example.com');
  });

  it('says only what the script supports when nothing is provisioned yet', () => {
    expect(withListeners([]).triggers[0]!.sentence).toBe('When a note is filed in inbound');
  });

  it('takes nothing from a listener whose channel or config disagrees with the listen', () => {
    const wrongChannel = withListeners([
      {
        kind: 'ledger_sys',
        movementName: 'intake',
        config: { box: 'inbound' },
        inboundAddress: 'ledger+inbound@example.com',
      },
    ]);
    const wrongConfig = withListeners([
      {
        kind: 'desk_sys',
        movementName: 'intake',
        config: { box: 'archive' },
        inboundAddress: 'desk+archive@example.com',
      },
    ]);
    expect(wrongChannel.triggers[0]!.sentence).toBe('When a note is filed in inbound');
    expect(wrongConfig.triggers[0]!.sentence).toBe('When a note is filed in inbound');
  });

  it("the graph's trigger is phrased by its own declared event phrase", () => {
    const v = joinStoryView({
      movement: { id: 'mv-1', name: 'x', validity: { status: 'valid', problems: [] } },
      story: {
        movement: { validity: { status: 'valid', problems: [] } },
        instances: [],
        triggers: [
          {
            id: 't1',
            instance: { name: 'graph' },
            adapterType: 'kg',
            narrowing: {},
            eventTypes: [],
            fires: 'go',
            firesMovement: true,
            at: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
          },
        ],
        flow: [],
        records: [],
        edges: [],
        shapes: [],
      },
      vocabulary,
    });
    expect(v.triggers[0]!.sentence).toBe('When something changes in your knowledge graph');
  });
});

// ── Honesty ──

describe('honesty', () => {
  it('carries the validity ruling through untouched', () => {
    const invalid = storyOf({
      source: `${SOURCE}\nmovement broken(n: <desk-[:note]->>) { write books-[:Nope]-> { Title: "x" } }`,
      catalog,
    });
    if (!invalid.ok) throw new Error('expected a story');
    const v = joinStoryView({
      movement: { id: 'mv-1', name: 'Intake', validity: invalid.story.movement.validity },
      story: invalid.story,
      vocabulary,
    });
    expect(v.movement.validity.status).toBe('invalid');
    expect(v.movement.validity.problems.length).toBeGreaterThan(0);
  });

  it('never speaks a system’s internal slug', () => {
    const spoken = view()
      .records.map((r) => r.sentence)
      .concat(view().triggers.map((t) => t.sentence))
      .join(' | ');
    expect(spoken).not.toMatch(/desk_sys|ledger_sys/);
  });

  it('keeps the flow and the record graph the IR produced', () => {
    const v = view();
    expect(v.flow).toEqual(ir().flow);
    expect(v.edges.map((e) => e.edge)).toContain('Entries');
  });
});

// ── The live vocabulary's label source ──

describe('storyVocabularyOf', () => {
  const teamCatalog = {
    catalog: {},
    instanceSchemas: [
      {
        // The graph is an ordinary instance schema now — its types are labelled
        // from the same place every other system's are.
        adapter: 'kg',
        positionKey: '',
        notes: [],
        schema: {
          positions: { Person: { properties: {}, edges: {}, displayName: 'Human' } },
        },
      },
      {
        adapter: 'ledger_sys',
        positionKey: '',
        notes: [],
        schema: {
          positions: {
            Orgs: { properties: {}, edges: {}, displayName: 'Organisation' },
            Entries: { properties: {}, edges: {} },
          },
        },
      },
    ],
  } as unknown as TeamMovementCatalog;

  it('reads record labels off the instance schema the adapter described', () => {
    const resolved = storyVocabularyOf(teamCatalog);
    expect(resolved.recordLabel({ adapterType: 'ledger_sys', recordType: 'Orgs' })).toBe(
      'Organisation',
    );
  });

  it('declares nothing where the adapter declared nothing', () => {
    const resolved = storyVocabularyOf(teamCatalog);
    expect(resolved.recordLabel({ adapterType: 'ledger_sys', recordType: 'Entries' })).toBeNull();
    expect(resolved.recordLabel({ adapterType: 'other_sys', recordType: 'Orgs' })).toBeNull();
  });

  it('the graph’s own types are labelled from its instance schema', () => {
    expect(
      storyVocabularyOf(teamCatalog).recordLabel({ adapterType: 'kg', recordType: 'Person' }),
    ).toBe('Human');
  });
});
