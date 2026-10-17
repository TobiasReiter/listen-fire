// The package on its own: fixture files read to the exact text the product
// produced before the move (the goldens below were taken from the pre-move
// code), and the resolver's rules with every dependency injected. unpdf is ESM
// and jest's CJS vm cannot load it, so the PDF parser is mocked here; the real
// parse was compared against the pre-move text under plain node.

const extractTextMock = jest.fn();
jest.mock('unpdf', () => ({ extractText: (...args: unknown[]) => extractTextMock(...args) }));

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import { getPptxText, getXlsxContent, makeFileTextResolver, type FileDescriptor } from '../index';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => createReadStream(path.join(FIXTURES, name));

const logger = { debug: jest.fn(), warn: jest.fn() };

function resolver(overrides: Partial<Parameters<typeof makeFileTextResolver<FileDescriptor>>[0]> = {}) {
  return makeFileTextResolver<FileDescriptor>({
    openBytes: async () => ({ stream: Readable.from([Buffer.from('bytes')]), size: 5 }),
    ocrPdf: jest.fn().mockResolvedValue('ocr text'),
    transcribe: jest.fn().mockResolvedValue({ text: 'spoken words' }),
    analyzeSheet: jest.fn(),
    rawText: { getOrCreateId: async () => 'rt-1' },
    logger,
    ...overrides,
  });
}

describe('fixtures read to the text they always did', () => {
  it('a deck: pages in numeric order, paragraphs on their own lines', async () => {
    expect(await getPptxText(fixture('deck.pptx'))).toBe(
      '--- Page 1 ---\n\n\nAcme Robotics\nSeed round, 2026\n\n--- Page 2 ---\n\n\nTraction\n120 customers\nRevenue up 4x\n\n--- Page 10 ---\n\n\nAppendix',
    );
  });

  it('a CSV: the sheet model answers the layout, formulas stay as written', async () => {
    const analyzeSheet = jest
      .fn()
      .mockResolvedValue(
        '[{"type":"header","startRow":0,"endRow":0},{"type":"table","startRow":0,"endRow":2,"startCol":0,"endCol":3,"hasHeader":true}]',
      );
    expect(await getXlsxContent(fixture('sheet.csv'), 'sheet.csv', analyzeSheet)).toBe(
      '# sheet1\n\n## Name Q1 Q2 Total\n\n```json\n[\n  {\n    "Name": "Alpha",\n    "Q1": 10,\n    "Q2": 20,\n    "Total": "=B2+C2"\n  },\n  {\n    "Name": "Beta",\n    "Q1": 5,\n    "Q2": 7,\n    "Total": "=B3+C3"\n  }\n]\n```\n',
    );
    expect(analyzeSheet).toHaveBeenCalledTimes(1);
  });
});

describe('the resolver', () => {
  it('refuses an unsupported type with its content type as the detail', async () => {
    expect(await resolver()({ file: { name: 'x.zip', contentType: 'application/zip' } })).toEqual({
      unreadable: 'unsupported_type',
      detail: 'application/zip',
    });
  });

  it('says the bytes were unavailable, but lets a refusal propagate', async () => {
    const boom = new Error('gone');
    expect(
      await resolver({ openBytes: async () => { throw boom; } })({ file: { name: 'a.pdf' } }),
    ).toEqual({ unreadable: 'bytes_unavailable', detail: 'gone' });
    const refusal = new Error('not yours');
    await expect(
      resolver({ openBytes: async () => { throw refusal; }, isRefusal: (e) => e === refusal })({
        file: { name: 'a.pdf' },
      }),
    ).rejects.toBe(refusal);
  });

  it('reads the PDF text layer without calling OCR', async () => {
    extractTextMock.mockResolvedValue({ text: 'x'.repeat(200), totalPages: 1 });
    const ocrPdf = jest.fn();
    const result = await resolver({ ocrPdf })({ file: { name: 'a.pdf' } });
    expect(result).toEqual({ text: 'x'.repeat(200), rawTextId: 'rt-1' });
    expect(ocrPdf).not.toHaveBeenCalled();
  });

  it('falls through to OCR on a scan, and names both halves when OCR fails', async () => {
    extractTextMock.mockResolvedValue({ text: '1 2 3', totalPages: 3 });
    const ocrPdf = jest.fn().mockResolvedValue('scanned words');
    expect(await resolver({ ocrPdf })({ file: { name: 'a.pdf' } })).toEqual({
      text: 'scanned words',
      rawTextId: 'rt-1',
    });
    const failing = jest.fn().mockRejectedValue(new Error('OCR is not configured'));
    expect(await resolver({ ocrPdf: failing })({ file: { name: 'a.pdf' } })).toEqual({
      unreadable: 'extraction_failed',
      detail: 'no text layer; OCR is not configured',
    });
  });

  it('transcribes audio, and scrubs NUL from any text', async () => {
    const transcribe = jest.fn().mockResolvedValue({ text: 'a\u0000b' });
    expect(await resolver({ transcribe })({ file: { name: 'v.ogg' } })).toEqual({
      text: 'a b',
      rawTextId: 'rt-1',
    });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'v.ogg', audio: Buffer.from('bytes') }),
    );
  });

  it('still answers with the text when the raw-text store fails', async () => {
    const rawText = { getOrCreateId: async () => { throw new Error('db down'); } };
    expect(await resolver({ rawText })({ file: { name: 'v.ogg' } })).toEqual({ text: 'spoken words' });
  });
});
