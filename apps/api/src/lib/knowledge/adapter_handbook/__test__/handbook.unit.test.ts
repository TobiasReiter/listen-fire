import type { ChapterId } from '../types';

import { readBook, getLibraryShelf } from '../../library';
import { adapterHandbook } from '../index';

// Distinctive late-in-the-chapter markers. Each lives deep enough in its
// chapter that over-escaping (which silently TRUNCATES the rendered
// template string) would drop it — so a rendered chapter that still
// contains its marker is proof the whole body survived.
const MARKERS: Record<ChapterId, string> = {
  overview: 'reference server you can start from',
  protocol: 'retryable',
  schema: 'Keeping the two in sync',
  events: 'The two ways are independent and unordered',
  files: 'Fetch and store their bytes exactly as above',
  reference: 'Do not put the secret in the manifest',
};

describe('adapter_handbook on the Library shelf', () => {
  it("the shelf serves 'adapter-authoring' as available", () => {
    const shelf = getLibraryShelf();
    const book = shelf.find((b) => b.bookId === 'adapter-authoring');
    expect(book).toBeDefined();
    expect(book!.status).toBe('available');
    expect(book!.chapters.map((c) => c.id)).toEqual([
      'overview',
      'protocol',
      'schema',
      'events',
      'files',
      'reference',
    ]);
  });

  it.each(Object.keys(MARKERS) as ChapterId[])(
    "chapter '%s' renders non-empty and contains its late marker",
    (chapter) => {
      const res = readBook({ bookId: 'adapter-authoring', chapter });
      const content = 'content' in res ? res.content : undefined;
      expect(typeof content).toBe('string');
      expect((content ?? '').length).toBeGreaterThan(400);
      expect(content ?? '').toContain(MARKERS[chapter]);
    },
  );

  it('every chapter balances its code fences (no truncated fence blocks)', () => {
    for (const c of Object.values(adapterHandbook.chapters)) {
      const fences = c.content.match(/```/g) ?? [];
      expect(fences.length % 2).toBe(0);
    }
  });

  it('every intent entry routes to a registered chapter', () => {
    for (const e of adapterHandbook.intentIndex) {
      expect(adapterHandbook.chapters[e.chapter]).toBeDefined();
    }
  });
});
