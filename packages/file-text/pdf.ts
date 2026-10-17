import { Readable } from 'node:stream';

import { bufferStreamCapped, MB, type FileTextLogger, type FileUnreadable } from './shared';

/** A born-digital PDF's text is judged PER PAGE, not in total: a flat total
 *  would accept a sixty-page scan whose only text is the page numbers a
 *  stamping tool wrote, and that file is exactly the one that still needs OCR.
 *  Fifty non-whitespace characters a page is well under any real page of prose
 *  and well over the headers and page numbers a scan carries. */
const PDF_TEXT_LAYER_CHARS_PER_PAGE = 50;

/** Reading the text layer means holding the bytes: both readers start from the
 *  first byte, and a stream is read once. Past this the file is never buffered
 *  — it streams to OCR exactly as it always did. */
function maxPdfBufferBytes(): number {
  const fromEnv = Number(process.env.MAX_PDF_BUFFER_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 64 * MB;
}

/** The OCR provider, injected: a shell with none passes one that refuses with
 *  the sentence saying so. */
export type OcrPdf = (
  stream: Readable,
  options: { size: number },
) => Promise<string | FileUnreadable | null>;

/**
 * The PDF's own text layer, when it has a real one — no OCR service in the
 * path, which is the whole point: a deployment with no OCR provider can still
 * read every born-digital PDF it is sent. A scanned page has no text layer, so
 * the caller falls through to the provider.
 */
async function pdfTextLayer(
  bytes: Buffer,
  name: string | undefined,
  logger: FileTextLogger,
): Promise<string | null> {
  try {
    const { extractText } = await import('unpdf');
    const { text, totalPages } = await extractText(new Uint8Array(bytes), { mergePages: true });
    const dense = text.replace(/\s/g, '').length;
    if (totalPages > 0 && dense / totalPages > PDF_TEXT_LAYER_CHARS_PER_PAGE) return text;
    logger.debug('[movement:file-text] the PDF has no usable text layer — trying OCR', {
      name,
      totalPages,
      chars: dense,
    });
    return null;
  } catch (error) {
    logger.warn('[movement:file-text] the PDF text layer could not be read — trying OCR', {
      name,
      message: error instanceof Error ? error.message : String(error),
      error,
    });
    return null;
  }
}

/**
 * A PDF: its text layer first, the OCR provider second. An OCR failure after an
 * empty text layer says BOTH halves — "no text layer; OCR is not configured …"
 * — because either one alone sends the reader after the wrong thing.
 *
 * A linked document (a deck fetched from a link) is read by this same
 * function: the linked path used to send every PDF straight to OCR, so a
 * deployment without OCR could read attachments but not the same file linked.
 */
export async function extractPdfText(
  stream: Readable,
  file: { name?: string; size?: number },
  deps: { ocrPdf: OcrPdf; logger: FileTextLogger },
): Promise<string | FileUnreadable | null> {
  const declaredSize = file.size ?? 0;
  const cap = maxPdfBufferBytes();
  if (declaredSize > cap) return deps.ocrPdf(stream, { size: declaredSize });

  const bytes = await bufferStreamCapped(stream, cap);
  if (bytes === null) {
    // The stream is spent, so OCR can no longer be offered the bytes either.
    return {
      unreadable: 'extraction_failed',
      detail: `the PDF is larger than the ${cap}-byte limit for reading a PDF`,
    };
  }
  const layer = await pdfTextLayer(bytes, file.name, deps.logger);
  if (layer !== null) return layer;
  try {
    return await deps.ocrPdf(Readable.from(bytes), { size: bytes.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`no text layer; ${message}`, { cause: error });
  }
}
