// The cutter behind `CHUNKS(text, { size | entities, overlap })`. Pure, so it is pinned
// here rather than through a run: the same text and the same options always
// yield the same pieces, which is the property the whole built-in rests on.

import { chunkText, readChunkSpec, type ChunkSpec } from '../chunk';

const spec = (size: number, overlap = 0): ChunkSpec => {
  const read = readChunkSpec({ size, overlap });
  if ('error' in read) throw new Error(read.error);
  return read.spec;
};

/** The same, cutting by what a piece is expected to yield. */
const byEntities = (entities: number, overlap = 0): ChunkSpec => {
  const read = readChunkSpec({ entities, overlap });
  if ('error' in read) throw new Error(read.error);
  return read.spec;
};

describe('a text with nothing to cut', () => {
  it('an empty text has no pieces — not one empty piece', () => {
    expect(chunkText('', spec(10))).toEqual([]);
  });

  it('a whitespace-only text has no pieces either', () => {
    expect(chunkText('   \n\n\t  ', spec(3))).toEqual([]);
  });

  it('a text that already fits is one piece, uncut', () => {
    expect(chunkText('Acme raised a seed round.', spec(1000))).toEqual([
      'Acme raised a seed round.',
    ]);
  });

  it('a text exactly the size asked for is still one piece', () => {
    expect(chunkText('abcde', spec(5))).toEqual(['abcde']);
  });
});

describe('the ceiling', () => {
  it('an unbroken run longer than the size is cut hard at the size', () => {
    expect(chunkText('a'.repeat(25), spec(10))).toEqual([
      'aaaaaaaaaa',
      'aaaaaaaaaa',
      'aaaaa',
    ]);
  });

  it('no piece is ever longer than the size', () => {
    const text = 'word '.repeat(200);
    for (const piece of chunkText(text, spec(37, 7))) {
      expect(piece.length).toBeLessThanOrEqual(37);
    }
  });

  it('the pieces concatenate back into the text when nothing overlaps', () => {
    const text = 'Some prose, with spaces and\nline breaks.\n\nAnd a second paragraph.';
    expect(chunkText(text, spec(20)).join('')).toBe(text);
  });
});

describe('where the cut lands', () => {
  const size = 20;

  it('prefers a blank line in the last tenth over anything else', () => {
    //                  0123456789012345678 9 0
    const text = 'aaaaaaaaaaaaaaaaaa\n\nbbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaa\n\n');
  });

  it('falls back to a line break in that same window', () => {
    const text = 'aaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaaa\n');
  });

  it('falls back to a space when there is no break at all', () => {
    const text = 'aaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbb';
    expect(chunkText(text, spec(size))[0]).toBe('aaaaaaaaaaaaaaaaaaa ');
  });

  it('looks back no further than a tenth — an early space does not shorten the piece', () => {
    // The only space is at offset 2, far outside the last tenth (offsets 18-19).
    const text = `ab ${'c'.repeat(40)}`;
    expect(chunkText(text, spec(size))[0]).toBe(`ab ${'c'.repeat(17)}`);
    expect(chunkText(text, spec(size))[0]).toHaveLength(size);
  });
});

describe('overlap', () => {
  it('the next piece starts the given number of characters before the cut', () => {
    const pieces = chunkText('a'.repeat(30), spec(10, 4));
    expect(pieces[0]).toBe('a'.repeat(10));
    // Cut at 10, so the second piece opens at 6 and runs to 16.
    expect(pieces[1]).toHaveLength(10);
    expect(pieces.slice(0, 2).map(p => p.length)).toEqual([10, 10]);
  });

  it('every consecutive pair shares exactly the overlap, character for character', () => {
    const text = 'the quick brown fox jumps over the lazy dog. '.repeat(6);
    const overlap = 9;
    const pieces = chunkText(text, spec(40, overlap));
    for (let i = 1; i < pieces.length - 1; i++) {
      const previous = pieces[i - 1];
      expect(pieces[i].slice(0, overlap)).toBe(previous.slice(previous.length - overlap));
    }
  });

  it('an overlap that would undo a short piece still advances', () => {
    // Line breaks every 3 characters put every cut near the start of its
    // window; a 9-character overlap can only be honoured by moving backwards.
    const text = 'ab\n'.repeat(40);
    const pieces = chunkText(text, spec(10, 9));
    expect(pieces.length).toBeLessThan(text.length);
    expect(pieces.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('the same text and options give the same pieces, every time', () => {
    const text = 'Paragraph one.\n\nParagraph two is a little longer.\n\nThree.';
    const once = chunkText(text, spec(24, 6));
    const again = chunkText(text, spec(24, 6));
    expect(again).toEqual(once);
  });
});

describe('unicode', () => {
  // `size` counts UTF-16 code units — what LENGTH() counts — so an emoji is
  // two. What a cut must never do is land between the two halves.
  const emoji = '😀';

  it('never splits a surrogate pair at the ceiling', () => {
    const text = emoji.repeat(20);
    for (const piece of chunkText(text, spec(9))) {
      expect(piece).toBe([...piece].join(''));
      expect(piece.length % 2).toBe(0);
    }
  });

  it('never splits a surrogate pair where an overlap re-enters the text', () => {
    const text = emoji.repeat(20);
    for (const piece of chunkText(text, spec(10, 3))) {
      expect([...piece].every(c => c === emoji)).toBe(true);
    }
  });

  it('still cuts at a break when one is in the window', () => {
    const text = `${emoji.repeat(9)}\n${emoji.repeat(9)}`;
    expect(chunkText(text, spec(20))[0]).toBe(`${emoji.repeat(9)}\n`);
  });
});

describe('the options a run is handed', () => {
  it('rounds a fractional size down — LENGTH(t) / 3 is a normal thing to write', () => {
    expect(readChunkSpec({ size: 10.9, overlap: 2 })).toEqual({
      spec: { mode: 'size', size: 10, overlap: 2 },
    });
  });

  it('treats a missing overlap as none', () => {
    expect(readChunkSpec({ size: 10, overlap: null })).toEqual({
      spec: { mode: 'size', size: 10, overlap: 0 },
    });
  });

  it('refuses a size below one character', () => {
    expect(readChunkSpec({ size: 0, overlap: 0 })).toEqual({
      error: expect.stringContaining('at least 1 character'),
    });
  });

  it('refuses a size that is not a number at all', () => {
    expect(readChunkSpec({ size: 'big', overlap: 0 })).toEqual({
      error: expect.stringContaining('the text "big"'),
    });
  });

  it('refuses an overlap that is not smaller than the size, and says why', () => {
    const read = readChunkSpec({ size: 100, overlap: 100 });
    expect('error' in read && read.error).toContain('has to be smaller than the size');
  });

  it('refuses a negative overlap', () => {
    expect(readChunkSpec({ size: 100, overlap: -1 })).toEqual({ error: expect.any(String) });
  });
});

// ── Cutting by what a piece is expected to YIELD ─────────────────────────────
//
// The other mode: pieces are sized by the records in them rather than by their
// characters, because what runs a reading past its output ceiling is how much
// answer it has to write. A line is never split for this.

describe('cutting by expected records', () => {
  const item = (n: number) => `[Example Ventures · Funding] Company ${n} raised a round`;
  const feed = Array.from({ length: 15 }, (_, i) => item(i + 1)).join('\n');

  it('cuts every time the running estimate reaches the number asked for', () => {
    const pieces = chunkText(feed, byEntities(5));
    expect(pieces).toHaveLength(3);
    expect(pieces.map(p => p.split('\n').filter(Boolean).length)).toEqual([5, 5, 5]);
  });

  it('the pieces concatenate back into the text when nothing overlaps', () => {
    expect(chunkText(feed, byEntities(4)).join('')).toBe(feed);
  });

  it('a text that expects fewer records than the number asked for is one piece', () => {
    expect(chunkText(feed, byEntities(100))).toEqual([feed]);
  });

  it('an empty text has no pieces', () => {
    expect(chunkText('', byEntities(5))).toEqual([]);
    expect(chunkText('  \n\n ', byEntities(5))).toEqual([]);
  });

  it('a line expecting more on its own than a whole piece becomes its own piece', () => {
    const crowded =
      'Intros: linkedin.com/in/a-one, linkedin.com/in/b-two, linkedin.com/in/c-three, ' +
      'linkedin.com/in/d-four, linkedin.com/in/e-five';
    const pieces = chunkText(`${item(1)}\n${crowded}\n${item(2)}`, byEntities(2));
    expect(pieces[1]).toBe(`${crowded}\n`);
  });

  it('never splits a line', () => {
    for (const piece of chunkText(feed, byEntities(2))) {
      for (const line of piece.split('\n').filter(Boolean)) {
        expect(feed.split('\n')).toContain(line);
      }
    }
  });

  it('prefers a paragraph break just past the cut over the line the count landed on', () => {
    // Eight items, a blank line, then a short one. The ninth record fits, so
    // the cut lands after it — one short line past the paragraph, which is
    // well inside the final tenth of the piece, so the paragraph wins.
    const head = Array.from({ length: 8 }, (_, i) => item(i + 1)).join('\n');
    const text = `${head}\n\n• Acme\n${item(10)}\n${item(11)}`;
    expect(chunkText(text, byEntities(9))[0]).toBe(`${head}\n\n`);
  });

  it('repeats whole lines when an overlap is asked for', () => {
    const pieces = chunkText(feed, byEntities(5, item(1).length + 1));
    expect(pieces[0].split('\n').filter(Boolean)).toHaveLength(5);
    expect(pieces[1].split('\n')[0]).toBe(item(5));
  });

  it('an overlap wider than the pieces still advances', () => {
    const pieces = chunkText(feed, byEntities(3, 10_000));
    expect(pieces.length).toBeLessThanOrEqual(15);
    expect(pieces.length).toBeGreaterThan(1);
  });
});

describe('the options a run is handed, cutting by records', () => {
  it('reads a number of expected records', () => {
    expect(readChunkSpec({ entities: 20 })).toEqual({
      spec: { mode: 'entities', entities: 20, overlap: 0 },
    });
  });

  it('rounds a fractional count down', () => {
    expect(readChunkSpec({ entities: 20.8, overlap: 100 })).toEqual({
      spec: { mode: 'entities', entities: 20, overlap: 100 },
    });
  });

  it('refuses a count below one record', () => {
    expect(readChunkSpec({ entities: 0 })).toEqual({
      error: expect.stringContaining('at least 1 record'),
    });
  });

  it('refuses both ways of saying how big a piece is', () => {
    const read = readChunkSpec({ size: 100, entities: 5 });
    expect('error' in read && read.error).toContain('two ways of saying how big a piece is');
  });

  it('refuses neither', () => {
    const read = readChunkSpec({ overlap: 10 });
    expect('error' in read && read.error).toContain('worked out neither');
  });

  it('a size written down and worked out to nothing is still a size', () => {
    expect(readChunkSpec({ size: null })).toEqual({
      error: expect.stringContaining('at least 1 character'),
    });
  });

  it('lets an overlap stand beside a count — there is no size for it to exceed', () => {
    expect(readChunkSpec({ entities: 2, overlap: 5_000 })).toEqual({
      spec: { mode: 'entities', entities: 2, overlap: 5_000 },
    });
  });
});
