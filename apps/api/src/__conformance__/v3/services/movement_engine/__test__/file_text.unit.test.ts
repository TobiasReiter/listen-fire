// The FileRef → text seam's AUDIO kind: classification, transcription via
// the transcription capability, the duration-based meter report, and the size guard.
// streamFileRef + RawTextService are mocked — this suite proves file_text.ts
// itself (the other kinds are covered one level up in extraction-file tests).

const transcribeMock = jest.fn();
jest.mock('../../../lib/models/transcription', () => ({
  transcribe: (...args: unknown[]) => transcribeMock(...args),
}));

const streamFileRefMock = jest.fn();
jest.mock('../../translation_graph/engine/files/retrieve', () => ({
  streamFileRef: (...args: unknown[]) => streamFileRefMock(...args),
}));

const getOrCreateRawTextIdMock = jest.fn();
jest.mock('../raw_text_store', () => ({
  getOrCreateRawTextId: (...args: unknown[]) => getOrCreateRawTextIdMock(...args),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// unpdf's PDF.js bundle is ESM, and jest's CJS vm cannot load it without
// --experimental-vm-modules — so the PARSER is mocked here (it still receives
// the real PDF bytes) and the real parse is exercised end-to-end in the dev
// loop, which runs the same code under plain node.
const extractTextMock = jest.fn();
jest.mock('unpdf', () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
}));

import { Readable } from 'node:stream';

import { jsPDF } from 'jspdf';

import { makeFileTextResolver } from '../file_text';
import { services } from '../../../adapters/registry';
import { LlmUsageContext } from '../../../lib/llm_usage';
import { logger } from '../../logger';
import type { FileRef } from '../../translation_graph/adapter';

const ocrMock = jest.fn();

function audioRef(overrides: Partial<{ name: string; contentType: string; size: number }> = {}): FileRef {
  return {
    __brand: 'FileRef',
    name: overrides.name ?? 'voice.ogg',
    contentType: overrides.contentType === '' ? undefined : (overrides.contentType ?? 'audio/ogg'),
    size: overrides.size,
    source: { ownerAdapterType: 'telegram', handle: 'file-1' },
  };
}

function resolvedAudio(bytes = 'fake-audio-bytes') {
  return { stream: Readable.from([Buffer.from(bytes)]), contentType: 'audio/ogg', size: bytes.length };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MAX_TRANSCRIPTION_BYTES;
  services.ocr = { extractPdf: ocrMock };
  streamFileRefMock.mockResolvedValue(resolvedAudio());
  transcribeMock.mockResolvedValue({ text: 'hello from the voice note', durationSeconds: 2.4 });
  getOrCreateRawTextIdMock.mockResolvedValue('rt-audio-1');
});

describe('audio classification → transcription → raw text', () => {
  it.each([
    ['content type audio/ogg', { contentType: 'audio/ogg', name: 'x.bin' }],
    ['opus voice-note content type', { contentType: 'audio/ogg; codecs=opus', name: 'x' }],
    ['audio/mp4 (whatsapp/telegram audio)', { contentType: 'audio/mp4', name: 'x' }],
    ['.m4a extension only', { contentType: '', name: 'memo.m4a' }],
    ['.mp3 extension only', { contentType: '', name: 'song.mp3' }],
    ['.wav extension only', { contentType: '', name: 'clip.wav' }],
    ['.opus extension only', { contentType: '', name: 'note.opus' }],
    ['.webm extension only', { contentType: '', name: 'rec.webm' }],
  ])('transcribes when classified by %s', async (_label, over) => {
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef(over));
    expect(transcribeMock).toHaveBeenCalledWith('whisper-1', {
      audio: expect.any(Buffer),
      name: over.name,
      contentType: over.contentType || undefined,
      label: 'file_transcription',
    });
    expect(getOrCreateRawTextIdMock).toHaveBeenCalledWith('hello from the voice note');
    expect(result).toEqual({ text: 'hello from the voice note', rawTextId: 'rt-audio-1' });
  });

  it('hands the resolved bytes to the transcriber', async () => {
    const resolve = makeFileTextResolver();
    await resolve(audioRef());
    const [, { audio }] = transcribeMock.mock.calls[0];
    expect(String(audio)).toBe('fake-audio-bytes');
  });

  it('reports an empty transcript as unreadable rather than as nothing at all', async () => {
    transcribeMock.mockResolvedValue({ text: '   ' });
    const resolve = makeFileTextResolver();
    const result = await new LlmUsageContext({ teamId: 'team-1' }).runAsync(async () =>
      resolve(audioRef()),
    );
    expect(result).toEqual({ unreadable: 'no_text' });
    expect(getOrCreateRawTextIdMock).not.toHaveBeenCalled();
  });
});

describe('the size guard — no silent truncation', () => {
  it('skips (loudly) when the declared size exceeds the cap', async () => {
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('bytes')]) });
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef({ size: 25 * 1024 * 1024 }));
    expect(result).toMatchObject({ unreadable: 'extraction_failed' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('audio too large'),
      expect.objectContaining({ name: 'voice.ogg' }),
    );
  });

  it('aborts (loudly) when an undeclared-size stream overruns the cap', async () => {
    process.env.MAX_TRANSCRIPTION_BYTES = '8';
    streamFileRefMock.mockResolvedValue({
      stream: Readable.from([Buffer.from('way-more-than-eight-bytes')]),
    });
    const resolve = makeFileTextResolver();
    const result = await resolve(audioRef({ size: undefined }));
    expect(result).toMatchObject({ unreadable: 'extraction_failed' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('audio too large'),
      expect.objectContaining({ name: 'voice.ogg' }),
    );
  });
});

/** A born-digital PDF: real text in the page's text layer, no images. */
function textLayerPdf(lines: string[]): Buffer {
  const doc = new jsPDF();
  lines.forEach((line, i) => doc.text(line, 10, 10 + i * 10));
  return Buffer.from(doc.output('arraybuffer'));
}

function pdfRef(): FileRef {
  return {
    __brand: 'FileRef',
    name: 'onepager.pdf',
    contentType: 'application/pdf',
    source: { ownerAdapterType: 'slack', handle: 'F-1' },
  };
}

describe('a born-digital PDF is read from its own text layer — no OCR service', () => {
  const PROSE = [
    'Acme Corp raised a $5M seed round led by Example Ventures.',
    'Revenue is $1.2M ARR, growing 20% month over month.',
    'Jane Doe is the founder and chief executive.',
  ];

  function servePdf(lines: string[]): Buffer {
    const bytes = textLayerPdf(lines);
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([bytes]), size: bytes.length });
    return bytes;
  }

  it('extracts the text layer and never reaches the OCR provider', async () => {
    const bytes = servePdf(PROSE);
    extractTextMock.mockResolvedValue({ totalPages: 1, text: PROSE.join('\n') });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-layer');

    const result = await makeFileTextResolver()(pdfRef());

    // The parser was handed the PDF's own bytes …
    const handed = extractTextMock.mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(handed).subarray(0, 5).toString()).toBe('%PDF-');
    expect(Buffer.from(handed).length).toBe(bytes.length);
    // … and its text is the file's text: no OCR service in the path at all.
    expect(ocrMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: PROSE.join('\n'), rawTextId: 'rt-layer' });
  });

  it('falls through to OCR when the pages carry no real text layer', async () => {
    // Two page numbers across two pages is what a stamping tool leaves on a
    // scan — it must not be mistaken for pages of prose.
    servePdf(['1']);
    extractTextMock.mockResolvedValue({ totalPages: 2, text: '1\n2' });
    ocrMock.mockResolvedValue('OCR read the scan.');
    getOrCreateRawTextIdMock.mockResolvedValue('rt-ocr');

    const result = await makeFileTextResolver()(pdfRef());

    expect(ocrMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: 'OCR read the scan.', rawTextId: 'rt-ocr' });
  });

  it('still reaches OCR when the text layer cannot be read at all', async () => {
    servePdf(PROSE);
    extractTextMock.mockRejectedValue(new Error('invalid PDF structure'));
    ocrMock.mockResolvedValue('OCR read it anyway.');
    getOrCreateRawTextIdMock.mockResolvedValue('rt-ocr-2');

    const result = await makeFileTextResolver()(pdfRef());

    expect(ocrMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: 'OCR read it anyway.', rawTextId: 'rt-ocr-2' });
  });

  it('says BOTH halves when there is no text layer and no OCR provider', async () => {
    servePdf(['1']);
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '1' });
    ocrMock.mockRejectedValue(new Error('OCR is not configured, so text cannot be extracted.'));

    const result = await makeFileTextResolver()(pdfRef());

    expect(result).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured, so text cannot be extracted.',
    });
  });
});

describe('the existing kinds are untouched', () => {
  it('a PDF with no text layer still routes to services.ocr', async () => {
    ocrMock.mockResolvedValue('pdf text');
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '' });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    getOrCreateRawTextIdMock.mockResolvedValue('rt-pdf');
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'email', handle: 'a-1' },
    });
    expect(ocrMock).toHaveBeenCalled();
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: 'pdf text', rawTextId: 'rt-pdf' });
  });

  it("carries the extractor's own sentence when it throws", async () => {
    ocrMock.mockRejectedValue(new Error('OCR is not configured, so text cannot be extracted.'));
    extractTextMock.mockResolvedValue({ totalPages: 1, text: '' });
    streamFileRefMock.mockResolvedValue({ stream: Readable.from([Buffer.from('%PDF')]), size: 4 });
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'email', handle: 'a-3' },
    });
    expect(result).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured, so text cannot be extracted.',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('text extraction failed'),
      expect.objectContaining({ name: 'deck.pdf' }),
    );
  });

  it('reports unreachable bytes as their own reason', async () => {
    streamFileRefMock.mockRejectedValue(new Error('file not found (404)'));
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      source: { ownerAdapterType: 'email', handle: 'a-4' },
    });
    expect(result).toEqual({ unreadable: 'bytes_unavailable', detail: 'file not found (404)' });
  });

  it('an unknown binary type is skipped — and says which type it was', async () => {
    const resolve = makeFileTextResolver();
    const result = await resolve({
      __brand: 'FileRef',
      name: 'archive.zip',
      contentType: 'application/zip',
      source: { ownerAdapterType: 'email', handle: 'a-2' },
    });
    expect(result).toEqual({ unreadable: 'unsupported_type', detail: 'application/zip' });
    expect(transcribeMock).not.toHaveBeenCalled();
    expect(ocrMock).not.toHaveBeenCalled();
  });
});
