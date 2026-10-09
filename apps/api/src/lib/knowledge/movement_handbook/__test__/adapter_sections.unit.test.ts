// Adapter-declared handbook sections — the MACHINERY, not Slack's prose.
//
// A system's conceptual documentation is registered on its manifest and
// assembled into the automation book at read time, so the path under test is
// manifest → chapter → shelf. The manifest here is synthetic on purpose: a
// test that only ever asserted the registered adapters would pass on the day
// the assembly stopped reading manifests at all, as long as Slack happened to
// still be listed somewhere.
//
// The prose contract is asserted BOTH ways — a well-written section holds it,
// and a sloppy one is caught — because a rule that never fails is a rule
// nobody can trust to be running.

import type { AdapterManifest } from '../../../../services/translation_graph/adapter';

import * as registry from '../../../../services/translation_graph/adapters/registry';
import { readBook } from '../../library';
import { adapterSectionChapters, getMovementHandbook } from '../index';
import { proseViolations } from './prose_rules';

const SECTION_MANIFEST: AdapterManifest = {
  adapterType: 'orderly',
  displayName: 'Orderly',
  supportedTriggers: [],
  methods: ['createRecord'],
  handbookSection: {
    title: 'Orderly — orders hang under the customer who placed them',
    content: `## Orderly — orders hang under the customer who placed them

An order is never written on its own. It hangs under the customer who placed
it, so the write is a linked one off the customer handle.

### placing-an-order

\`\`\`
write person-[:Orders]-> { Item: "A widget", Quantity: 2 }
\`\`\`

### Common mistakes

- **Writing the order first and the customer after.** There is nowhere to put
  an order that belongs to nobody.`,
  },
};

const PLAIN_MANIFEST: AdapterManifest = {
  adapterType: 'plainly',
  displayName: 'Plainly',
  supportedTriggers: [],
  methods: ['createRecord'],
};

describe('adapter-declared handbook sections', () => {
  it('renders a declared section as a chapter namespaced by the adapter slug', () => {
    const chapters = adapterSectionChapters([SECTION_MANIFEST]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].id).toBe('system:orderly');
    expect(chapters[0].title).toBe(SECTION_MANIFEST.handbookSection?.title);
    expect(chapters[0].content).toContain('hang under the customer');
  });

  it('contributes nothing for an adapter that declares no section', () => {
    expect(adapterSectionChapters([PLAIN_MANIFEST])).toEqual([]);
  });

  it('holds a declared section to the same prose contract as a written chapter', () => {
    expect(proseViolations(adapterSectionChapters([SECTION_MANIFEST])[0])).toEqual([]);
  });

  it('catches a section that breaks the contract (the rules genuinely bite)', () => {
    const sloppy: AdapterManifest = {
      ...SECTION_MANIFEST,
      handbookSection: {
        title: 'Orderly',
        content:
          'Write a movement that logs each order, one for each founder you meet.',
      },
    };
    expect(proseViolations(adapterSectionChapters([sloppy])[0])).toEqual([
      'teaches the retired `for each`',
      'is tuned to one use case: "founder"',
      'says "movement" outside code',
    ]);
  });

  it('a use-case word backticked as a record or field name is an identifier, not tuning', () => {
    const named: AdapterManifest = {
      ...SECTION_MANIFEST,
      handbookSection: {
        title: 'Orderly',
        content: 'An order hangs off the customer who placed it, reachable as `Investors`.',
      },
    };
    expect(proseViolations(adapterSectionChapters([named])[0])).toEqual([]);
  });

  it('the same word bare in prose is still tuning', () => {
    const bare: AdapterManifest = {
      ...SECTION_MANIFEST,
      handbookSection: {
        title: 'Orderly',
        content: 'An order hangs off the customer who placed it, reachable from investors.',
      },
    };
    expect(proseViolations(adapterSectionChapters([bare])[0])).toEqual([
      'is tuned to one use case: "investors"',
    ]);
  });
});

describe('a declared section reaches the reader', () => {
  beforeEach(() => {
    jest.spyOn(registry, 'listAdapterManifests').mockReturnValue([SECTION_MANIFEST]);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('assembles into the book alongside the written chapters', () => {
    const handbook = getMovementHandbook();
    expect(handbook.chapters['system:orderly']?.title).toBe(
      SECTION_MANIFEST.handbookSection?.title,
    );
    expect(handbook.chapters.foundations).toBeDefined();
  });

  it('is listed and readable through the Library reader', () => {
    const listing = readBook({ bookId: 'automations' });
    const listed = 'chapters' in listing ? listing.chapters : undefined;
    if (!listed) throw new Error('expected a chapter listing');
    expect(listed.map((c) => c.id)).toContain('system:orderly');

    const read = readBook({ bookId: 'automations', chapter: 'system:orderly' });
    if (!('content' in read)) throw new Error('expected a chapter body');
    expect(read.content).toContain('placing-an-order');
  });
});

describe('the shipped sections', () => {
  // Five systems, five namespaced chapters, one assembly — which is what
  // makes this a mechanism rather than a Slack feature. The knowledge graph
  // earns its place here twice over: it is the one section whose system is
  // intrinsic, so nothing about it is connected, credentialed, or optional.
  it.each([
    ['system:slack', 'Block Kit'],
    ['system:telegram', 'inline_keyboard'],
    ['system:whatsapp', 'interactive.body.text'],
    ['system:kg', 'import { kg } from adapters'],
    ['system:affinity', 'List Entries'],
  ])('%s is on the shelf and reads back', (chapter, marker) => {
    const read = readBook({ bookId: 'automations', chapter });
    if (!('content' in read)) throw new Error('expected a chapter body');
    expect(read.content).toContain(marker);
  });
});
