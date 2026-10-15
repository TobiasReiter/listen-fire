import { DocumentService } from '../../../services/document';
import { logger } from 'movement-engine/services/logger';
import { RawTextService } from '../../../services/raw_text';
import { DocumentWithContentOutput, EmptyOutput, Tool } from './types';
import { getPptxText } from '../../utils/powerpoint';
import { getXlsxContent } from '../../utils/excel';
import { services } from '../../../adapters/registry';
import { extractPdfText } from '../../../services/translation_graph/movement/file_text';

type ExtractDocumentTextParams = {
  documentId: string;
  cache?: boolean;
};

const extractDocumentTextTool: Tool<
  ExtractDocumentTextParams,
  DocumentWithContentOutput | EmptyOutput
> = async ({ documentId, cache = true }) => {
  const document = await DocumentService.getById(documentId);

  // return early if not a supported file type
  const supportedExtensions = ['.pdf', '.pptx', '.xlsx'];
  if (!supportedExtensions.some((ext) => document.description.endsWith(ext))) {
    logger.error(`Unsupported file type, skipping ${document.description}`);
    return { type: 'EMPTY' };
  }

  if (cache) {
    if (!document.checksum) {
      throw new Error('Document does not have a checksum');
    }

    const existingDocumentWithContent = await DocumentService.findFirstWithContentByChecksum(
      document.checksum,
    );

    if (existingDocumentWithContent?.rawTextId) {
      const rawText = await RawTextService.getById(existingDocumentWithContent.rawTextId);

      await DocumentService.setRawTextId(documentId, rawText.id);
      await RawTextService.ensureIndexed(rawText.id);
      return { type: 'DOCUMENT_WITH_CONTENT', documentId, rawTextId: rawText.id };
    }
  }

  const documentContent = await getDocumentContent({
    documentId,
    filename: document.description,
  });

  if (!documentContent) {
    throw new Error('Could not extract any text from the document');
  }

  const rawText = await RawTextService.getOrCreateFromContent(documentContent);
  await DocumentService.setRawTextId(documentId, rawText.id);
  return { type: 'DOCUMENT_WITH_CONTENT', documentId, rawTextId: rawText.id };
};

extractDocumentTextTool.type = 'EXTRACT_DOCUMENT_TEXT';

async function getDocumentContent({
  documentId,
  filename,
}: {
  documentId: string;
  filename: string;
}) {
  const doc = await DocumentService.getById(documentId);
  const docStream = await services.document.getFileNodeStream({ objectUri: doc.objectUri });
  if (filename.endsWith('.pdf')) {
    const text = await extractPdfText(docStream, { name: filename, size: docStream.size });
    if (text === null || typeof text === 'string') return text;
    throw new Error(text.detail ?? `the PDF could not be read (${text.unreadable})`);
  } else if (filename.endsWith('.pptx')) {
    return getPptxText(docStream);
  } else if (filename.endsWith('.xlsx')) {
    return getXlsxContent(docStream);
  } else {
    throw new Error(`Unsupported file type: ${filename}`);
  }
}

export { extractDocumentTextTool };
