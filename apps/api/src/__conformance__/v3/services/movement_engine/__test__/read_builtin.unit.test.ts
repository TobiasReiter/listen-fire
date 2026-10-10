// `READ(<file>)` — a file to its text, as a language function.
//
// The seam is the extraction's (`file_text.ts`, injected here), so a file read
// by `READ` and a file read as an `extract from [ … ]` source go through the
// same resolver. What the LANGUAGE says is only `text | absent`: an absence in
// this language never carries a reason. The reason lives on the run's trace,
// which is what these tests pin — that, and the `file` provenance origin, which
// is what keeps whole-document provenance when the text is then extracted from.

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { ExprSlot, Span } from 'movement-lang';
import { parseMovementExpression } from 'movement-lang';
import {
  Environment,
  evalMovementExpr,
  type FileTextResolution,
  type MovementTraceEntry,
} from '../expression';
import { buildExtractSpec, materializeExtract, type ExtractRuntime } from '../extraction';
import type { FileRef } from '../../translation_graph/adapter';
import type { LlmCallInput, LlmCallResult } from '../../translation_graph/engine/batched_extraction';
import type { ExtractExpression, ExtractStage } from 'movement-lang';

const SPAN: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

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

/** Evaluate an expression with `attachment` bound and a stubbed file seam. */
async function evaluate(
  text: string,
  opts: {
    attachment?: unknown;
    resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
    trace?: MovementTraceEntry[];
  },
) {
  const env = new Environment();
  env.declare('attachment', { kind: 'value', value: opts.attachment ?? null });
  return evalMovementExpr(parseMovementExpression(text), {
    env,
    ...(opts.resolveFileText ? { resolveFileText: opts.resolveFileText } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
  });
}

/** The `read` entries of a trace, in order. */
function readEntries(trace: MovementTraceEntry[]) {
  return trace.filter(
    (e): e is Extract<MovementTraceEntry, { kind: 'read' }> => e.kind === 'read',
  );
}

describe('READ(file) — the text', () => {
  it('answers with the file text and records what it read on the trace', async () => {
    const trace: MovementTraceEntry[] = [];
    const resolveFileText = jest.fn(async (): Promise<FileTextResolution> => ({
      text: 'Acme is raising a $5M seed round.',
      rawTextId: 'rt-123',
    }));

    const result = await evaluate('READ(attachment)', {
      attachment: fileRef(),
      resolveFileText,
      trace,
    });

    expect(result.value).toBe('Acme is raising a $5M seed round.');
    expect(resolveFileText).toHaveBeenCalledTimes(1);
    expect(readEntries(trace)).toEqual([
      {
        kind: 'read',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        chars: 'Acme is raising a $5M seed round.'.length,
      },
    ]);
  });

  it('carries a `file` provenance origin — rawTextId, handle and all', async () => {
    const result = await evaluate('READ(attachment)', {
      attachment: fileRef(),
      resolveFileText: async () => ({ text: 'the deck', rawTextId: 'rt-123' }),
    });

    const origin = {
      kind: 'file',
      rawTextId: 'rt-123',
      handle: 'attachment-1',
      name: 'deck.pdf',
      contentType: 'application/pdf',
    };
    expect(result.provenance.origins).toContainEqual(origin);
    // Un-transformed: the text IS the file, so a quote out of it cites it.
    expect(result.provenance.direct).toEqual(origin);
  });
});

describe('READ(file) — the absences', () => {
  it('a file nothing could read is ABSENT, with the reason and detail on the trace', async () => {
    const trace: MovementTraceEntry[] = [];
    const result = await evaluate('READ(attachment)', {
      attachment: fileRef({ name: 'scan.png', contentType: 'image/png' }),
      resolveFileText: async () => ({
        unreadable: 'extraction_failed',
        detail: 'no OCR provider is configured',
      }),
      trace,
    });

    expect(result.value).toBeNull();
    expect(readEntries(trace)).toEqual([
      {
        kind: 'read',
        name: 'scan.png',
        contentType: 'image/png',
        unreadable: 'extraction_failed',
        detail: 'no OCR provider is configured',
      },
    ]);
  });

  it('an empty file says `no_text` rather than answering with nothing silently', async () => {
    const trace: MovementTraceEntry[] = [];
    const result = await evaluate('READ(attachment)', {
      attachment: fileRef(),
      resolveFileText: async () => ({ unreadable: 'no_text' }),
      trace,
    });

    expect(result.value).toBeNull();
    expect(readEntries(trace)).toEqual([
      { kind: 'read', name: 'deck.pdf', contentType: 'application/pdf', unreadable: 'no_text' },
    ]);
  });

  it('an absent FILE is absent without asking the seam — and without a trace line', async () => {
    const trace: MovementTraceEntry[] = [];
    const resolveFileText = jest.fn(async (): Promise<FileTextResolution> => ({ text: 'x' }));

    const result = await evaluate('READ(attachment)', {
      attachment: null,
      resolveFileText,
      trace,
    });

    expect(result.value).toBeNull();
    expect(resolveFileText).not.toHaveBeenCalled();
    expect(readEntries(trace)).toEqual([]);
  });

  it('no seam in scope fails loud — "nothing can read it" is not "it had no text"', async () => {
    await expect(evaluate('READ(attachment)', { attachment: fileRef() })).rejects.toThrow(
      /nothing in scope that can read a file/,
    );
  });
});

// ── Composition: the text READ gives back is extraction source ──────────────

function slot(raw: string): ExprSlot {
  return { raw, span: SPAN };
}

function extractExpr(
  fromSlots: string[],
  fields: { name: string; description: string }[],
): ExtractExpression {
  const stage: ExtractStage = {
    fields: fields.map((f) => ({
      name: f.name,
      description: slot(JSON.stringify(f.description)),
      span: SPAN,
    })),
    children: [],
    span: SPAN,
  };
  return { from: fromSlots.map(slot), stages: [stage], span: SPAN };
}

describe('extract from [READ(f)]', () => {
  it('extracts from the file text, and the call still sees the file origin', async () => {
    const calls: LlmCallInput[] = [];
    const llm = {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        return {
          parsedJson: { 'x:extract_result#1': [{ name: { evidence: 'q', value: 'Acme' } }] },
        };
      },
    };
    const resolveFileText = async (): Promise<FileTextResolution> => ({
      text: 'Acme is raising a $5M seed round.',
      rawTextId: 'rt-123',
    });
    // The slot is evaluated exactly as the interpreter evaluates one: through
    // the expression engine, with the same file seam the extraction would use.
    const runtime: ExtractRuntime = {
      llm,
      transformInvoker: { async invoke() { return {}; } },
      evalSlot: (s: ExprSlot) => evaluate(s.raw, { attachment: fileRef(), resolveFileText }),
      resolveFileText,
    };

    const extract = extractExpr(['READ(attachment)'], [
      { name: 'name', description: 'the company name' },
    ]);
    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].userMessage).toContain('Acme is raising a $5M seed round');
    expect(calls[0].userMessage).not.toContain('__brand');
    expect(emission.fields).toEqual({ name: 'Acme' });

    // Whole-document provenance survives the composition: the extraction call's
    // data sources carry the file origin READ stamped, rawTextId included.
    const site =
      emission.provenance.name?.kind === 'extraction'
        ? emission.provenance.name.site
        : undefined;
    expect(site?.dataSources).toContainEqual({
      kind: 'file',
      rawTextId: 'rt-123',
      handle: 'attachment-1',
      name: 'deck.pdf',
      contentType: 'application/pdf',
    });
  });
});
