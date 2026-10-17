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

import type { Readable } from 'node:stream';

import {
  extractPdfText as extractPdfTextFrom,
  makeFileTextResolver as makeResolver,
  type FileTextReader as PackageFileTextReader,
  type SheetAnalyzer,
} from 'file-text';
import type { FileUnreadable } from 'movement-engine/public/model-calls';
import type { FileTextResolution } from 'movement-engine/public/run-support';
import type { FileRef } from 'movement-engine/public/adapter';
import type { RawTextStore } from './raw_text_store';

import { services } from '../../../adapters/registry';
import { anthropicChat } from '../../../lib/anthropic';
import { transcribe } from '../../../lib/models/transcription';
import { logger } from 'movement-engine/public/log';
import { FileOutsideTeamError } from 'movement-engine/public/files';
import { streamFileRef, type StreamFileRefOptions } from '../engine/files/retrieve';

// The format readers and the rules around them live in `packages/file-text`;
// this file binds them to the hosted product's OCR, transcription, spreadsheet
// model call, byte store and logger.

const ocrPdf = (stream: Readable, options: { size: number }) => services.ocr.extractPdf(stream, options);

/** The model call that reads a spreadsheet's layout, metered under its own label. */
export const analyzeSheet: SheetAnalyzer = ({ temperature, system, userMessage }) =>
  anthropicChat({
    model: 'claude-sonnet-5',
    temperature,
    system,
    userMessage,
    label: 'excel-semantic-analysis',
  });

/** A PDF read the way the engine's attachments are: text layer, then OCR.
 *  Also read by the document tool, so a linked deck and an attachment agree. */
export function extractPdfText(
  stream: Readable,
  file: { name?: string; size?: number },
): Promise<string | FileUnreadable | null> {
  return extractPdfTextFrom(stream, file, { ocrPdf, logger });
}

/** A file's text, read on the host. Unmetered: the run's host serves it under
 *  the run's budget (`engine_host.ts`). */
export type FileTextReader = (input: { file: FileRef }) => Promise<FileTextResolution>;

/**
 * The production `files.resolveFileText` the host hands the engine: byte
 * resolution (`streamFileRef`, for the run's team) → text extraction → the
 * raw-text store, which is a parameter so tests need no database.
 */
export function makeFileTextResolver(rawText: RawTextStore, bytes: StreamFileRefOptions): FileTextReader {
  const read: PackageFileTextReader<FileRef> = makeResolver<FileRef>({
    // A file that is not the team's is refused by name, never read as one
    // whose bytes were merely unavailable.
    openBytes: (ref) => streamFileRef(ref, bytes),
    isRefusal: (error) => error instanceof FileOutsideTeamError,
    ocrPdf,
    transcribe: (input) =>
      transcribe('whisper-1', { ...input, label: 'file_transcription' }),
    analyzeSheet,
    rawText,
    logger,
  });
  return read;
}
