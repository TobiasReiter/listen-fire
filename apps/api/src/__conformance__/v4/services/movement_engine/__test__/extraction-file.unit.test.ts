// E2 / §3a — file (attachment `FileRef`) sources become extracted TEXT.
//
// When an `extract from [ … ]` source datum is a `FileRef`, the
// materialiser must feed the extractor the file's extracted text (OCR
// included for scanned PDFs) — NOT a JSON-stringified handle — and stamp a
// `file` provenance origin so extracted-field evidence traces back to the
// attachment. These tests drive `materializeExtract` directly with a
// hand-built extract + an injected `resolveFileText` seam, so the
// adapter/OCR boundary is mocked deterministically.

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type {
  ExprSlot,
  ExtractExpression,
  ExtractStage,
  Span,
} from 'movement-lang';
import {
  buildExtractSpec,
  materializeExtract,
  type ExtractRuntime,
  type FileTextResolution,
} from '../extraction';
import type { FileRef } from '../../translation_graph/adapter';
import { NO_PROVENANCE } from '../provenance';
import type { LlmCallInput, LlmCallResult } from '../../translation_graph/engine/batched_extraction';
import type { MovementTraceEntry } from '../expression';

// ── Builders ────────────────────────────────────────────────────────────────

const SPAN: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

function slot(raw: string): ExprSlot {
  return { raw, span: SPAN };
}

/** A single-stage extract: `extract from [<rawSlots>] { <fields> }`. */
function extractExpr(fromSlots: string[], fields: { name: string; description: string }[]): ExtractExpression {
  const stage: ExtractStage = {
    fields: fields.map((f) => ({ name: f.name, description: slot(JSON.stringify(f.description)), span: SPAN })),
    children: [],
    span: SPAN,
  };
  return { from: fromSlots.map(slot), stages: [stage], span: SPAN };
}

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

/** A queued LLM whose single canned response is the extractor's nested JSON. */
function queuedLlm(responses: unknown[]): {
  calls: LlmCallInput[];
  client: { call(input: LlmCallInput): Promise<LlmCallResult> };
} {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    client: {
      async call(input: LlmCallInput): Promise<LlmCallResult> {
        calls.push(input);
        return { parsedJson: responses[calls.length - 1] };
      },
    },
  };
}

const wrap = (value: unknown) => ({ evidence: 'q', value });

function runtimeFor(opts: {
  llm: { call(input: LlmCallInput): Promise<LlmCallResult> };
  slots: Record<string, unknown>;
  resolveFileText?: (ref: FileRef) => Promise<FileTextResolution>;
  trace?: MovementTraceEntry[];
}): ExtractRuntime {
  return {
    llm: opts.llm,
    transformInvoker: { async invoke() { return {}; } },
    evalSlot: async (s: ExprSlot) => {
      const value = opts.slots[s.raw];
      return { value, provenance: NO_PROVENANCE };
    },
    ...(opts.resolveFileText ? { resolveFileText: opts.resolveFileText } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
  };
}

/** The extraction entries of a trace, in order. */
function extractionEntries(
  trace: MovementTraceEntry[],
): Array<Extract<MovementTraceEntry, { kind: 'extraction' }>> {
  return trace.filter(
    (e): e is Extract<MovementTraceEntry, { kind: 'extraction' }> => e.kind === 'extraction',
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('extract from a file attachment — text + provenance', () => {
  it('feeds the extractor the file TEXT (not a stringified handle) and stamps a file provenance origin', async () => {
    const llm = queuedLlm([
      { 'x:extract_result#1': [{ name: wrap('Acme'), amount: wrap('5M') }] },
    ]);
    const resolveFileText = jest.fn(async (_ref: FileRef): Promise<FileTextResolution> => ({
      text: 'Acme is raising a $5M seed round. Revenue is $1.2M ARR.',
      rawTextId: 'rt-123',
    }));

    const extract = extractExpr(['attachment'], [
      { name: 'name', description: 'the company name' },
      { name: 'amount', description: 'the round size' },
    ]);
    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({
        llm: llm.client,
        slots: { attachment: fileRef() },
        resolveFileText,
      }),
    });

    // The OCR/text seam was hit with the FileRef …
    expect(resolveFileText).toHaveBeenCalledTimes(1);
    expect(resolveFileText.mock.calls[0][0]).toMatchObject({ __brand: 'FileRef', name: 'deck.pdf' });

    // … and the extracted TEXT — not a JSON handle — reached the LLM.
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0].userMessage).toContain('Acme is raising a $5M seed round');
    expect(llm.calls[0].userMessage).not.toContain('__brand');
    expect(llm.calls[0].userMessage).not.toContain('attachment-1');

    // The extracted fields carry through.
    expect(emission.fields).toEqual({ name: 'Acme', amount: '5M' });

    // The extraction call's data sources include a `file` origin linking
    // back to the attachment (rawText id + handle/name) — evidence traces.
    const site = emission.provenance.name?.kind === 'extraction' ? emission.provenance.name.site : undefined;
    expect(site).toBeDefined();
    expect(site?.dataSources).toContainEqual({
      kind: 'file',
      rawTextId: 'rt-123',
      handle: 'attachment-1',
      name: 'deck.pdf',
      contentType: 'application/pdf',
    });
  });

  it('exercises the scanned/OCR path — text from the resolver still reaches the extractor', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Scanned Co') }] }]);
    // The resolver stands in for resolveFileRef → services.ocr.extractPdf:
    // a scanned PDF that yields OCR text.
    const resolveFileText = jest.fn(async (): Promise<FileTextResolution> => ({
      text: 'OCR: Scanned Co pitch deck — Series B.',
      rawTextId: 'rt-ocr',
    }));
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'the company name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({ llm: llm.client, slots: { attachment: fileRef() }, resolveFileText }),
    });

    expect(llm.calls[0].userMessage).toContain('OCR: Scanned Co pitch deck');
    expect(emission.fields).toEqual({ name: 'Scanned Co' });
  });

  it('an OCR-empty file contributes NO extraction text but STILL a FILE resource (carry-forward)', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('From Text') }] }]);
    // The production resolver answers this way for an empty OCR result — e.g.
    // a scanned image with no text in it at all.
    const resolveFileText = jest.fn(
      async (): Promise<FileTextResolution> => ({ unreadable: 'no_text' }),
    );
    const ref = fileRef({ name: 'scan.png', contentType: 'image/png' });
    const extract = extractExpr(['body', 'attachment'], [{ name: 'name', description: 'the company name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({
        llm: llm.client,
        slots: { body: 'A plain text body mentioning From Text.', attachment: ref },
        resolveFileText,
      }),
    });

    expect(resolveFileText).toHaveBeenCalledTimes(1);
    // The text body still extracts; the OCR-empty file feeds the prompt NOTHING
    // (no FILE segment, no stringified handle) — evidence behaviour unchanged.
    expect(llm.calls[0].userMessage).toContain('A plain text body mentioning From Text');
    expect(llm.calls[0].userMessage).not.toContain('scan.png');
    expect(llm.calls[0].userMessage).not.toContain('__brand');
    expect(emission.fields).toEqual({ name: 'From Text' });

    // …BUT the source file STILL becomes a FILE resource carrying its FileRef —
    // a file qualifies as provenance by being a source, not by yielding text.
    const fileResources = emission.resources.filter((r) => r.type === 'FILE');
    expect(fileResources).toHaveLength(1);
    expect(fileResources[0].fileRef).toBe(ref); // byte channel preserved for carry-forward
    expect(fileResources[0].data?.file).toBe(ref);
    // No OCR text → no inline content / rawTextId, just the carry-forward bytes.
    expect(fileResources[0].content).toBeUndefined();
  });

  it('de-duplicates the same attachment — text is extracted once even if the file appears twice', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Once') }] }]);
    const resolveFileText = jest.fn(async (): Promise<FileTextResolution> => ({
      text: 'Deck text once.',
      rawTextId: 'rt-dup',
    }));
    const ref = fileRef();
    const extract = extractExpr(['a', 'b'], [{ name: 'name', description: 'name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      // Same FileRef (same owner handle) bound to two `from` slots.
      runtime: runtimeFor({ llm: llm.client, slots: { a: ref, b: ref }, resolveFileText }),
    });

    expect(resolveFileText).toHaveBeenCalledTimes(1);
    // The text appears once in the prompt (one FILE segment).
    const occurrences = llm.calls[0].userMessage.split('Deck text once.').length - 1;
    expect(occurrences).toBe(1);
    // …and the source file is ONE FILE resource (deduped on its stable id).
    expect(emission.resources.filter((r) => r.type === 'FILE')).toHaveLength(1);
  });

  it('attaches the source FILE as a node resource (Layer 5 provenance) carrying the live FileRef', async () => {
    const llm = queuedLlm([
      { 'x:extract_result#1': [{ name: wrap('Acme') }] },
    ]);
    const resolveFileText = jest.fn(async (): Promise<FileTextResolution> => ({
      text: 'Acme is raising a $5M seed round.',
      rawTextId: 'rt-xyz',
    }));
    const ref = fileRef();
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'the company name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({ llm: llm.client, slots: { attachment: ref }, resolveFileText }),
    });

    // The source file is carried as a FILE resource — the byte channel
    // (`fileRef`) preserved so a downstream write carries the file forward.
    const fileResources = emission.resources.filter((r) => r.type === 'FILE');
    expect(fileResources).toHaveLength(1);
    const resource = fileResources[0];
    expect(resource.name).toBe('deck.pdf');
    expect(resource.externalId).toBe('attachment-1'); // the source handle
    expect(resource.fileRef).toBe(ref); // SAME FileRef — bytes retrievable
    expect(resource.id).toBeDefined(); // engine-stamped stable id
    // The byte channel a carry-forward write reads (`r.`file``).
    expect(resource.data?.file).toBe(ref);
  });

  it('carries a text `from` datum as a TEXT node resource', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);
    const extract = extractExpr(['body'], [{ name: 'name', description: 'name' }]);
    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({ llm: llm.client, slots: { body: 'Acme raised a seed round.' } }),
    });
    const textResources = emission.resources.filter((r) => r.type === 'TEXT');
    expect(textResources).toHaveLength(1);
    expect(textResources[0].content).toContain('Acme raised a seed round');
  });

  it('names the file it could not read on the trace, even when the extraction is skipped for want of any source', async () => {
    // The production shape of this: a PDF on a deployment with no OCR
    // provider. The prompt is empty, so no call is made at all — and without
    // the file on the entry the run says only "it read nothing", which is
    // indistinguishable from a message that carried no attachment.
    const llm = queuedLlm([]);
    const trace: MovementTraceEntry[] = [];
    const resolveFileText = jest.fn(
      async (): Promise<FileTextResolution> => ({
        unreadable: 'extraction_failed',
        detail: 'OCR is not configured, so text cannot be extracted from this PDF.',
      }),
    );
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'the company name' }]);

    await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({
        llm: llm.client,
        slots: { attachment: fileRef() },
        resolveFileText,
        trace,
      }),
    });

    expect(llm.calls).toHaveLength(0);
    const entries = extractionEntries(trace);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      skipped: 'empty_source',
      inputChars: 0,
      files: [
        {
          name: 'deck.pdf',
          contentType: 'application/pdf',
          unreadable: 'extraction_failed',
          detail: 'OCR is not configured, so text cannot be extracted from this PDF.',
        },
      ],
    });
  });

  it('reports the unreadable file on the call it still made from the text source', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('From Text') }] }]);
    const trace: MovementTraceEntry[] = [];
    const resolveFileText = jest.fn(
      async (): Promise<FileTextResolution> => ({
        unreadable: 'bytes_unavailable',
        detail: 'file not found (404)',
      }),
    );
    const extract = extractExpr(['body', 'attachment'], [{ name: 'name', description: 'the company name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({
        llm: llm.client,
        slots: { body: 'A plain text body mentioning From Text.', attachment: fileRef() },
        resolveFileText,
        trace,
      }),
    });

    // The text still extracts …
    expect(emission.fields).toEqual({ name: 'From Text' });
    expect(llm.calls[0].userMessage).toContain('A plain text body mentioning From Text');
    // … and the same entry says the attachment was there and gave nothing.
    const entry = extractionEntries(trace)[0];
    expect(entry.skipped).toBeUndefined();
    expect(entry.files).toEqual([
      {
        name: 'deck.pdf',
        contentType: 'application/pdf',
        unreadable: 'bytes_unavailable',
        detail: 'file not found (404)',
      },
    ]);
  });

  it('counts what a readable file contributed', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);
    const trace: MovementTraceEntry[] = [];
    const text = 'Acme is raising a $5M seed round.';
    const resolveFileText = jest.fn(
      async (): Promise<FileTextResolution> => ({ text, rawTextId: 'rt-chars' }),
    );
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'name' }]);

    await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({ llm: llm.client, slots: { attachment: fileRef() }, resolveFileText, trace }),
    });

    expect(extractionEntries(trace)[0].files).toEqual([
      { name: 'deck.pdf', contentType: 'application/pdf', chars: text.length },
    ]);
  });

  it("bounds ONE file's text in the prompt, and says so — to the model and on the trace", async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);
    const trace: MovementTraceEntry[] = [];
    const long = 'a'.repeat(120_000);
    const resolveFileText = jest.fn(
      async (): Promise<FileTextResolution> => ({ text: long, rawTextId: 'rt-long' }),
    );
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'name' }]);

    const emission = await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      runtime: runtimeFor({ llm: llm.client, slots: { attachment: fileRef() }, resolveFileText, trace }),
    });

    // The prompt carries the first 50k characters and a marker saying so …
    const prompt = llm.calls[0].userMessage;
    expect(prompt).toContain('[… truncated: first 50000 of 120000 characters]');
    expect(prompt).toContain('a'.repeat(50_000));
    expect(prompt).not.toContain('a'.repeat(50_001));
    // … the trace says how much went in and how much there was …
    expect(extractionEntries(trace)[0].files).toEqual([
      { name: 'deck.pdf', contentType: 'application/pdf', chars: 50_000, truncatedFrom: 120_000 },
    ]);
    // … and the STORED copy is untouched: the evidence points at the whole
    // document, and the carry-forward resource carries all of it.
    const site = emission.provenance.name?.kind === 'extraction' ? emission.provenance.name.site : undefined;
    expect(site?.dataSources).toContainEqual(expect.objectContaining({ kind: 'file', rawTextId: 'rt-long' }));
    expect(emission.resources.find((r) => r.type === 'FILE')?.content).toHaveLength(120_000);
  });

  it('raises the ceiling from the environment', async () => {
    process.env.EXTRACTION_FILE_CHARS = '10';
    try {
      const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('Acme') }] }]);
      const trace: MovementTraceEntry[] = [];
      const resolveFileText = jest.fn(
        async (): Promise<FileTextResolution> => ({ text: 'b'.repeat(40), rawTextId: 'rt-env' }),
      );
      const extract = extractExpr(['attachment'], [{ name: 'name', description: 'name' }]);
      await materializeExtract({
        extract,
        spec: await buildExtractSpec(extract),
        runtime: runtimeFor({ llm: llm.client, slots: { attachment: fileRef() }, resolveFileText, trace }),
      });
      expect(llm.calls[0].userMessage).toContain('[… truncated: first 10 of 40 characters]');
      expect(extractionEntries(trace)[0].files).toEqual([
        { name: 'deck.pdf', contentType: 'application/pdf', chars: 10, truncatedFrom: 40 },
      ]);
    } finally {
      delete process.env.EXTRACTION_FILE_CHARS;
    }
  });

  it('falls back to the legacy stringify when no resolveFileText seam is present', async () => {
    const llm = queuedLlm([{ 'x:extract_result#1': [{ name: wrap('x') }] }]);
    const extract = extractExpr(['attachment'], [{ name: 'name', description: 'name' }]);

    await materializeExtract({
      extract,
      spec: await buildExtractSpec(extract),
      // No resolveFileText → the FileRef stringifies (pre-existing behaviour).
      runtime: runtimeFor({ llm: llm.client, slots: { attachment: fileRef() } }),
    });

    expect(llm.calls[0].userMessage).toContain('__brand');
  });
});
