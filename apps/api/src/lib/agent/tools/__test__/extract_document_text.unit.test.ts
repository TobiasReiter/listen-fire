// A stored document (a deck downloaded from a link) is read the way an
// attachment is: the PDF's own text layer first, OCR only for a scan. The
// document store and the OCR provider are mocked; the PDF parser is mocked
// too, for the reason file_text.unit.test.ts gives (unpdf is ESM).

const mockGetById = jest.fn();
const mockFindFirstWithContentByChecksum = jest.fn();
const mockSetRawTextId = jest.fn();
jest.mock('../../../../services/document', () => ({
  DocumentService: {
    getById: (...args: unknown[]) => mockGetById(...args),
    findFirstWithContentByChecksum: (...args: unknown[]) =>
      mockFindFirstWithContentByChecksum(...args),
    setRawTextId: (...args: unknown[]) => mockSetRawTextId(...args),
  },
}));

const mockGetOrCreateFromContent = jest.fn();
jest.mock('../../../../services/raw_text', () => ({
  RawTextService: {
    getOrCreateFromContent: (...args: unknown[]) => mockGetOrCreateFromContent(...args),
    getById: jest.fn(),
    ensureIndexed: jest.fn(),
  },
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const extractTextMock = jest.fn();
jest.mock('unpdf', () => ({
  extractText: (...args: unknown[]) => extractTextMock(...args),
}));

import { Readable } from 'node:stream';

import { services } from '../../../../adapters/registry';
import { UnconfiguredOcrAdapter } from '../../../../adapters/ocr/unconfigured';
import { extractDocumentTextTool } from '../extract_document_text';

const ocrMock = jest.fn();
const PDF_BYTES = Buffer.from('%PDF-1.4 fake deck bytes');

function serveDocument() {
  mockGetById.mockResolvedValue({
    id: 'doc-1',
    description: 'deck.pdf',
    checksum: 'sum-1',
    objectUri: 's3://bucket/deck.pdf',
  });
  services.document = {
    getFileNodeStream: async () =>
      Object.assign(Readable.from([PDF_BYTES]), { size: PDF_BYTES.length }),
  } as unknown as typeof services.document;
}

beforeEach(() => {
  jest.clearAllMocks();
  services.ocr = { extractPdf: ocrMock };
  mockFindFirstWithContentByChecksum.mockResolvedValue(null);
  mockGetOrCreateFromContent.mockImplementation(async (content: string) => ({
    id: 'rt-1',
    content,
  }));
  serveDocument();
});

describe('a linked PDF is read in the same order as an attachment', () => {
  it('reads the embedded text layer and never calls OCR', async () => {
    const prose = 'Acme raised a seed round. Revenue grows every month, and the team is hiring.';
    extractTextMock.mockResolvedValue({ totalPages: 1, text: prose });

    const out = await extractDocumentTextTool({ documentId: 'doc-1' });

    expect(ocrMock).not.toHaveBeenCalled();
    expect(mockGetOrCreateFromContent).toHaveBeenCalledWith(prose);
    expect(out).toEqual({ type: 'DOCUMENT_WITH_CONTENT', documentId: 'doc-1', rawTextId: 'rt-1' });
  });

  it('falls through to OCR for a scan when OCR is configured', async () => {
    extractTextMock.mockResolvedValue({ totalPages: 3, text: '1\n2\n3' });
    ocrMock.mockResolvedValue('OCR read the scan.');

    const out = await extractDocumentTextTool({ documentId: 'doc-1' });

    expect(ocrMock).toHaveBeenCalledTimes(1);
    expect(mockGetOrCreateFromContent).toHaveBeenCalledWith('OCR read the scan.');
    expect(out).toEqual({ type: 'DOCUMENT_WITH_CONTENT', documentId: 'doc-1', rawTextId: 'rt-1' });
  });

  it('says there is no text layer and no OCR when a scan meets an unconfigured deployment', async () => {
    services.ocr = new UnconfiguredOcrAdapter();
    extractTextMock.mockResolvedValue({ totalPages: 2, text: '' });

    await expect(extractDocumentTextTool({ documentId: 'doc-1' })).rejects.toThrow(
      /^no text layer; OCR is not configured/,
    );
    expect(mockSetRawTextId).not.toHaveBeenCalled();
  });
});
