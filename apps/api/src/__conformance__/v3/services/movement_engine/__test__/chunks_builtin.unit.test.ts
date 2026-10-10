// `CHUNKS(<text>, { size | entities, overlap })` — a long text cut into
// pieces, as a language function.
//
// The cut itself is pure and lives in `movement-lang` (`expression/chunk.ts`,
// where the rule is pinned character by character). What these tests pin is the
// SEAM: that the options map reaches the cutter, that the pieces come back as
// an ordinary array of text — so a collection op reads them with nothing in
// between — that a text that isn't there gives no pieces rather than one empty
// one, and that the run's trace says how the text came out, which is the only
// place a reader can find out.

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { parseMovementExpression } from 'movement-lang';
import {
  Environment,
  evalMovementExpr,
  type FileTextResolution,
  type MovementTraceEntry,
} from '../expression';
import type { FileRef } from '../../translation_graph/adapter';

/** 36 characters with no break of any kind in them, so every cut falls at the
 *  ceiling — the arithmetic is readable straight off the string. */
const UNBROKEN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function fileRef(over: Partial<FileRef> = {}): FileRef {
  return {
    __brand: 'FileRef',
    name: 'deck.pdf',
    contentType: 'application/pdf',
    size: 1234,
    source: { ownerAdapterType: 'email', handle: 'attachment-1' },
    ...over,
  };
}

/** Evaluate an expression with `body` and `attachment` bound. */
async function evaluate(
  text: string,
  opts: {
    body?: unknown;
    attachment?: unknown;
    resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
    trace?: MovementTraceEntry[];
  } = {},
) {
  const env = new Environment();
  env.declare('body', { kind: 'value', value: opts.body ?? null });
  env.declare('attachment', { kind: 'value', value: opts.attachment ?? null });
  return evalMovementExpr(parseMovementExpression(text), {
    env,
    ...(opts.resolveFileText ? { resolveFileText: opts.resolveFileText } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
  });
}

const chunkEntries = (trace: MovementTraceEntry[]) =>
  trace.filter((e): e is Extract<MovementTraceEntry, { kind: 'chunks' }> => e.kind === 'chunks');

describe('CHUNKS(text, { size, overlap }) — the pieces', () => {
  it('cuts at the size asked for and repeats the overlap into the next piece', async () => {
    const result = await evaluate('CHUNKS(body, { size: 20, overlap: 5 })', { body: UNBROKEN });
    expect(result.value).toEqual([
      'ABCDEFGHIJKLMNOPQRST',
      'PQRSTUVWXYZ012345678',
      '456789',
    ]);
  });

  it('answers with an ordinary array, which is what lets a collection op read it', async () => {
    const result = await evaluate('CHUNKS(body, { size: 20 })', { body: UNBROKEN });
    expect(Array.isArray(result.value)).toBe(true);
    expect(result.value).toEqual(['ABCDEFGHIJKLMNOPQRST', 'UVWXYZ0123456789']);
  });

  it('works out a size the author computed rather than wrote down', async () => {
    const result = await evaluate('CHUNKS(body, { size: LENGTH(body) / 2 })', { body: UNBROKEN });
    expect(result.value).toEqual([UNBROKEN.slice(0, 18), UNBROKEN.slice(18)]);
  });

  it('records the pieces and their lengths on the run trace', async () => {
    const trace: MovementTraceEntry[] = [];
    await evaluate('CHUNKS(body, { size: 20, overlap: 5 })', { body: UNBROKEN, trace });
    expect(chunkEntries(trace)).toEqual([
      { kind: 'chunks', pieces: 3, sizes: [20, 20, 6], unit: 'chars', mode: 'size' },
    ]);
  });
});

describe('CHUNKS(text, { entities }) — cut by what a piece is expected to yield', () => {
  const item = (n: number) => `[Example Ventures · Funding] Company ${n} raised a round`;
  const feed = Array.from({ length: 6 }, (_, i) => item(i + 1)).join('\n');

  it('cuts on whole lines, by the records in them', async () => {
    const result = await evaluate('CHUNKS(body, { entities: 2 })', { body: feed });
    expect(result.value).toEqual([
      `${item(1)}\n${item(2)}\n`,
      `${item(3)}\n${item(4)}\n`,
      `${item(5)}\n${item(6)}`,
    ]);
  });

  it('says on the trace which way it was cut, and what each piece is expected to yield', async () => {
    const trace: MovementTraceEntry[] = [];
    await evaluate('CHUNKS(body, { entities: 2 })', { body: feed, trace });
    expect(chunkEntries(trace)).toEqual([
      {
        kind: 'chunks',
        pieces: 3,
        sizes: [expect.any(Number), expect.any(Number), expect.any(Number)],
        unit: 'chars',
        mode: 'entities',
        expectedEntities: [2, 2, 2],
      },
    ]);
  });

  it('a count the author computed rather than wrote down works out the same', async () => {
    const result = await evaluate('CHUNKS(body, { entities: 1 + 2 })', { body: feed });
    expect(result.value).toHaveLength(2);
  });

  it('a count that works out to nothing fails the run naming the built-in', async () => {
    await expect(
      evaluate('CHUNKS(body, { entities: 0 + 0 })', { body: feed }),
    ).rejects.toThrow(/CHUNKS needs to expect at least 1 record/);
  });
});

describe('CHUNKS(text, …) — a text that is not there', () => {
  it('gives NO pieces rather than one empty piece', async () => {
    const result = await evaluate('CHUNKS(body, { size: 20 })', { body: null });
    expect(result.value).toEqual([]);
  });

  it('still says so on the trace — a run with nothing to cut must not look silent', async () => {
    const trace: MovementTraceEntry[] = [];
    await evaluate('CHUNKS(body, { size: 20 })', { body: null, trace });
    expect(chunkEntries(trace)).toEqual([
      { kind: 'chunks', pieces: 0, sizes: [], unit: 'chars', mode: 'size' },
    ]);
  });

  it('a text with only whitespace in it has no pieces either', async () => {
    const result = await evaluate('CHUNKS(body, { size: 5 })', { body: '   \n\n  ' });
    expect(result.value).toEqual([]);
  });
});

describe('CHUNKS(READ(file), …) — the two built-ins compose', () => {
  it('reads the attachment, cuts its text, and traces both', async () => {
    const trace: MovementTraceEntry[] = [];
    const result = await evaluate('CHUNKS(READ(attachment), { size: 20, overlap: 5 })', {
      attachment: fileRef(),
      resolveFileText: async () => ({ text: UNBROKEN, rawTextId: 'rt-123' }),
      trace,
    });

    expect(result.value).toEqual([
      'ABCDEFGHIJKLMNOPQRST',
      'PQRSTUVWXYZ012345678',
      '456789',
    ]);
    expect(trace).toEqual([
      { kind: 'read', name: 'deck.pdf', contentType: 'application/pdf', chars: 36 },
      { kind: 'chunks', pieces: 3, sizes: [20, 20, 6], unit: 'chars', mode: 'size' },
    ]);
  });

  it('keeps the file among the origins — a piece still came from the attachment', async () => {
    const result = await evaluate('CHUNKS(READ(attachment), { size: 20 })', {
      attachment: fileRef(),
      resolveFileText: async () => ({ text: UNBROKEN, rawTextId: 'rt-123' }),
    });
    expect(result.provenance.origins).toContainEqual(
      expect.objectContaining({ kind: 'file', rawTextId: 'rt-123' }),
    );
    // A piece is a SLICE, not the file — so nothing here is a verbatim quote of
    // the whole document any more.
    expect(result.provenance.direct).toBeUndefined();
  });

  it('a file nothing could read yields no pieces, not a failure', async () => {
    const trace: MovementTraceEntry[] = [];
    const result = await evaluate('CHUNKS(READ(attachment), { size: 20 })', {
      attachment: fileRef({ name: 'scan.png', contentType: 'image/png' }),
      resolveFileText: async () => ({ unreadable: 'extraction_failed', detail: 'no OCR provider' }),
      trace,
    });
    expect(result.value).toEqual([]);
    expect(trace.map(e => e.kind)).toEqual(['read', 'chunks']);
  });
});

describe('CHUNKS(text, …) — options the run has to refuse', () => {
  it('an overlap the author computed into something too big fails the run, saying why', async () => {
    await expect(
      evaluate('CHUNKS(body, { size: 20, overlap: LENGTH(body) })', { body: UNBROKEN }),
    ).rejects.toThrow(/overlap.*smaller than the size/s);
  });

  it('a size that works out to nothing fails the run naming the built-in', async () => {
    await expect(
      evaluate('CHUNKS(body, { size: 0 + 0 })', { body: UNBROKEN }),
    ).rejects.toThrow(/CHUNKS needs a size of at least 1 character/);
  });
});
