// The extraction-source FILE → TEXT seam (knowledge-pipeline parity).
//
// When an `extract from [ … ]` source resolves to a `FileRef` (an
// attachment — e.g. `msg-[:attachments]->.`File``), the extractor must read
// the file's TEXT, not a stringified handle. This mirrors the knowledge
// pipeline exactly:
//
//   FileRef (a descriptor)
//     → resolveFileRef  (the owning instance, re-resolved with the descriptor's
//                        credential, fetches bytes → Readable)
//     → OCR/text extractor  (the PDF's own text layer first, then
//                            services.ocr.extractPdf for scanned PDFs;
//                            getPptxText / getXlsxContent for decks/sheets)
//     → the host's raw-text store  (checksum dedup + store → stable id; in
//       production the Context-free Kysely twin of RawTextService —
//       raw_text_store.ts)
//
// Byte resolution is `streamFileRef`'s: the descriptor names the instance
// that owns the bytes, and that instance is resolved on this side of the
// engine boundary — the engine hands over a descriptor and gets text back.
//
// Audio (voice notes / audio attachments) is the fourth kind: the bytes are
// transcribed (Whisper's registry name, wherever the model map sends it) and the TRANSCRIPT is the file's
// text — so spoken words flow into `extract from [ … ]` exactly where a
// deck's slides do. The audio's duration is metered as its own ledger line.
//
// Unsupported types (anything past PDF/PPTX/XLSX/audio), unreachable bytes, a
// failed extractor and empty extractions all come back as an UNREADABLE reason:
// the materialiser skips the file either way rather than emitting a garbage
// FRAGMENT, but the run can then name the file it could not read and say why —
// a deployment with no OCR provider otherwise reports an empty source and no
// sign there was ever a file. The text-extraction primitives are the SAME ones
// `lib/agent/tools/extract_document_text.ts` calls — we operate on the
// resolved stream directly because that tool is keyed by a `Document` record
// id, which a source `FileRef` doesn't have.

import { Readable } from 'node:stream';

import type { FileUnreadable } from '../../movement_engine/extraction';
import type { FileTextResolution } from '../../movement_engine/expression';
import type { FileRef, ResolveFileRefResult } from '../adapter';
import type { RawTextStore } from './raw_text_store';

import { services } from '../../../adapters/registry';
import { MB } from '../../../constants';
import { transcribe } from '../../../lib/models/transcription';
import { getXlsxContent } from '../../../lib/utils/excel';
import { getPptxText } from '../../../lib/utils/powerpoint';
import { logger } from '../../logger';
import { FileOutsideTeamError } from '../engine/files/file_outside_team';
import { streamFileRef, type StreamFileRefOptions } from '../engine/files/retrieve';


type FileKind = 'pdf' | 'pptx' | 'xlsx' | 'audio';

const AUDIO_EXTENSIONS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.webm', '.flac'];

/** OpenAI's transcription endpoint rejects requests past 25 MB — cap just
 *  under it. Read per call so tests (and ops) can override via env. */
function maxTranscriptionBytes(): number {
  const fromEnv = Number(process.env.MAX_TRANSCRIPTION_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24 * MB;
}

/**
 * Classify a `FileRef` to a supported extractor by its content type or its
 * display-name extension — the union the knowledge pipeline handles.
 * Unknown/binary types return `undefined` (the file is skipped).
 */
function fileKind(ref: FileRef): FileKind | undefined {
  const name = (ref.name ?? '').toLowerCase();
  const type = (ref.contentType ?? '').toLowerCase();
  if (type.includes('pdf') || name.endsWith('.pdf')) return 'pdf';
  if (
    type.includes('presentationml') ||
    type.includes('powerpoint') ||
    name.endsWith('.pptx')
  ) {
    return 'pptx';
  }
  if (
    type.includes('spreadsheetml') ||
    type.includes('excel') ||
    name.endsWith('.xlsx') ||
    name.endsWith('.csv')
  ) {
    return 'xlsx';
  }
  if (type.startsWith('audio/') || AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return 'audio';
  }
  return undefined;
}

/** Buffer a stream up to `cap` bytes; null (the caller logs loudly) past it —
 *  a voice note must transcribe whole or not at all, never silently cut. */
async function bufferStreamCapped(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > cap) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * The audio kind: buffer the bytes (size-capped), transcribe via the
 * registered speech-to-text service, and report the audio's duration to the
 * run's cost meter (the `transcription` ledger line) off the ambient usage
 * context — mirroring how the plugin call sites reach the meter.
 */
async function transcribeAudio(
  resolved: ResolveFileRefResult,
  ref: FileRef,
): Promise<string | FileUnreadable | null> {
  const cap = maxTranscriptionBytes();
  const tooLarge = (): FileUnreadable => ({
    unreadable: 'extraction_failed',
    detail: `the audio is larger than the ${cap}-byte transcription limit`,
  });
  const declaredSize = resolved.size ?? ref.size;
  if (declaredSize !== undefined && declaredSize > cap) {
    logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      size: declaredSize,
      cap,
    });
    return tooLarge();
  }
  const audio = await bufferStreamCapped(resolved.stream, cap);
  if (audio === null) {
    logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      cap,
    });
    return tooLarge();
  }
  const { text } = await transcribe('whisper-1', {
    audio,
    name: ref.name,
    contentType: ref.contentType,
    label: 'file_transcription',
  });
  // Nothing said is unreadable, not an empty transcript.
  return text.trim().length === 0 ? null : text;
}

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

/**
 * The PDF's own text layer, when it has a real one — no OCR service in the
 * path, which is the whole point: a deployment with no OCR provider can still
 * read every born-digital PDF it is sent. A scanned page has no text layer, so
 * the caller falls through to the provider.
 */
async function pdfTextLayer(bytes: Buffer, name: string | undefined): Promise<string | null> {
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
 * Exported so a linked document (a deck fetched from a link) is read by this
 * same function: the linked path used to send every PDF straight to OCR, so a
 * deployment without OCR could read attachments but not the same file linked.
 */
export async function extractPdfText(
  stream: Readable,
  file: { name?: string; size?: number },
): Promise<string | FileUnreadable | null> {
  const declaredSize = file.size ?? 0;
  const cap = maxPdfBufferBytes();
  if (declaredSize > cap) return services.ocr.extractPdf(stream, { size: declaredSize });

  const bytes = await bufferStreamCapped(stream, cap);
  if (bytes === null) {
    // The stream is spent, so OCR can no longer be offered the bytes either.
    return {
      unreadable: 'extraction_failed',
      detail: `the PDF is larger than the ${cap}-byte limit for reading a PDF`,
    };
  }
  const layer = await pdfTextLayer(bytes, file.name);
  if (layer !== null) return layer;
  try {
    return await services.ocr.extractPdf(Readable.from(bytes), { size: bytes.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`no text layer; ${message}`, { cause: error });
  }
}

async function extractTextFromStream(
  kind: FileKind,
  resolved: ResolveFileRefResult,
  ref: FileRef,
): Promise<string | FileUnreadable | null> {
  switch (kind) {
    case 'pdf':
      return extractPdfText(resolved.stream, { name: ref.name, size: resolved.size ?? ref.size });
    case 'pptx':
      return getPptxText(resolved.stream);
    case 'xlsx':
      return getXlsxContent(resolved.stream, ref.name);
    case 'audio':
      return transcribeAudio(resolved, ref);
  }
}

/**
 * The production `files.resolveFileText` the host hands the engine: byte
 * resolution (`streamFileRef`, for the run's team) → text extraction → the
 * raw-text store, which is a parameter so tests need no database.
 */
/** A file's text, read on the host. Unmetered: the run's host serves it under
 *  the run's budget (`engine_host.ts`). */
export type FileTextReader = (input: { file: FileRef }) => Promise<FileTextResolution>;

export function makeFileTextResolver(rawText: RawTextStore, bytes: StreamFileRefOptions): FileTextReader {
  return async ({ file: ref }) => {
    const kind = fileKind(ref);
    if (!kind) {
      logger.debug('[movement:file-text] unsupported file type — skipping', {
        name: ref.name,
        contentType: ref.contentType,
      });
      return {
        unreadable: 'unsupported_type',
        ...(ref.contentType !== undefined ? { detail: ref.contentType } : {}),
      };
    }
    let resolved: ResolveFileRefResult;
    try {
      resolved = await streamFileRef(ref, bytes);
    } catch (error) {
      // A file that is not the team's is refused by name, never read as one
      // whose bytes were merely unavailable.
      if (error instanceof FileOutsideTeamError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[movement:file-text] failed to resolve file bytes', {
        name: ref.name,
        message,
        error,
      });
      return { unreadable: 'bytes_unavailable', detail: message };
    }

    let text: string | FileUnreadable | null;
    try {
      text = await extractTextFromStream(kind, resolved, ref);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[movement:file-text] text extraction failed', {
        name: ref.name,
        kind,
        message,
        error,
      });
      return { unreadable: 'extraction_failed', detail: message };
    }
    if (text !== null && typeof text !== 'string') return text;
    // A font map with no glyph for some characters leaves U+0000 in the text
    // layer (a real deck produced 43 of them); Postgres rejects NUL in a text
    // column outright, so swap it for a space here — once, for every file
    // kind — before the no-text check or the store ever see it. A missing
    // glyph usually stood where a separator was, so a space keeps word
    // boundaries intact.
    if (text !== null) text = text.replace(/\u0000/g, ' ');
    if (!text || text.trim().length === 0) return { unreadable: 'no_text' };

    try {
      const rawTextId = await rawText.getOrCreateId(text);
      return { text, rawTextId };
    } catch (error) {
      // Provenance is a nice-to-have on top of the extracted text, not a
      // precondition for it — a store failure (e.g. an encoding edge case
      // that slips past sanitisation) must not take the whole run down.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[movement:file-text] could not store raw text provenance', {
        name: ref.name,
        message,
      });
      return { text };
    }
  };
}
