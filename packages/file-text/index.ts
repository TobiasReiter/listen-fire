// A file's text, for any shell. Classify a file by content type or name, read
// its bytes, extract text, and (optionally) store the text for provenance.
//
// Everything that is a provider or a product is injected: the bytes
// (`openBytes`), OCR for scanned PDFs, speech-to-text for audio, the model call
// that reads a spreadsheet's layout, the raw-text store, and the logger.
// The package itself carries only the format readers (PDF text layer, PPTX,
// XLSX/CSV) and the rules around them (size caps, NUL scrubbing, the
// unreadable reasons).
//
// Unsupported types, unreachable bytes, a failed extractor and empty
// extractions all come back as an UNREADABLE reason, never as garbage text.

import { Readable } from 'node:stream';

import { getXlsxContent, type SheetAnalyzer } from './excel';
import { extractPdfText, type OcrPdf } from './pdf';
import { getPptxText } from './powerpoint';
import {
  bufferStreamCapped,
  MB,
  type FileTextLogger,
  type FileUnreadable,
} from './shared';

export { extractPdfText, getPptxText, getXlsxContent };
export type { FileTextLogger, FileUnreadable, OcrPdf, SheetAnalyzer };
export type { FileUnreadableReason } from './shared';

/** What classification reads of a file descriptor. */
export interface FileDescriptor {
  name?: string;
  contentType?: string;
  size?: number;
}

export interface OpenedBytes {
  stream: Readable;
  size?: number;
}

export interface FileTextResult {
  text: string;
  rawTextId?: string;
}

export type FileTextResolution = FileTextResult | FileUnreadable;

export interface TranscribeAudio {
  (input: { audio: Buffer; name?: string; contentType?: string }): Promise<{ text: string }>;
}

export interface RawTextSink {
  getOrCreateId(content: string): Promise<string | undefined>;
}

export interface FileTextDeps<Ref extends FileDescriptor> {
  /** The file's bytes. Throw to say they are unavailable. */
  openBytes(ref: Ref): Promise<OpenedBytes>;
  /** Errors from `openBytes` that must propagate (a file that is not the
   *  caller's own), instead of reading as "bytes unavailable". */
  isRefusal?(error: unknown): boolean;
  ocrPdf: OcrPdf;
  transcribe: TranscribeAudio;
  analyzeSheet: SheetAnalyzer;
  rawText: RawTextSink;
  logger: FileTextLogger;
}

type FileKind = 'pdf' | 'pptx' | 'xlsx' | 'audio';

const AUDIO_EXTENSIONS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.webm', '.flac'];

/** OpenAI's transcription endpoint rejects requests past 25 MB — cap just
 *  under it. Read per call so tests (and ops) can override via env. */
function maxTranscriptionBytes(): number {
  const fromEnv = Number(process.env.MAX_TRANSCRIPTION_BYTES);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24 * MB;
}

/**
 * Classify a file to a supported extractor by its content type or its
 * display-name extension. Unknown/binary types return `undefined` (skipped).
 */
function fileKind(ref: FileDescriptor): FileKind | undefined {
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

/** Buffer the bytes (size-capped) and transcribe. Over the cap the audio is
 *  refused whole, never cut. */
async function transcribeAudio<Ref extends FileDescriptor>(
  resolved: OpenedBytes,
  ref: Ref,
  deps: FileTextDeps<Ref>,
): Promise<string | FileUnreadable | null> {
  const cap = maxTranscriptionBytes();
  const tooLarge = (): FileUnreadable => ({
    unreadable: 'extraction_failed',
    detail: `the audio is larger than the ${cap}-byte transcription limit`,
  });
  const declaredSize = resolved.size ?? ref.size;
  if (declaredSize !== undefined && declaredSize > cap) {
    deps.logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      size: declaredSize,
      cap,
    });
    return tooLarge();
  }
  const audio = await bufferStreamCapped(resolved.stream, cap);
  if (audio === null) {
    deps.logger.warn('[movement:file-text] audio too large to transcribe — skipping', {
      name: ref.name,
      cap,
    });
    return tooLarge();
  }
  const { text } = await deps.transcribe({ audio, name: ref.name, contentType: ref.contentType });
  // Nothing said is unreadable, not an empty transcript.
  return text.trim().length === 0 ? null : text;
}

async function extractTextFromStream<Ref extends FileDescriptor>(
  kind: FileKind,
  resolved: OpenedBytes,
  ref: Ref,
  deps: FileTextDeps<Ref>,
): Promise<string | FileUnreadable | null> {
  switch (kind) {
    case 'pdf':
      return extractPdfText(
        resolved.stream,
        { name: ref.name, size: resolved.size ?? ref.size },
        deps,
      );
    case 'pptx':
      return getPptxText(resolved.stream);
    case 'xlsx':
      return getXlsxContent(resolved.stream, ref.name, deps.analyzeSheet);
    case 'audio':
      return transcribeAudio(resolved, ref, deps);
  }
}

export type FileTextReader<Ref extends FileDescriptor> = (input: {
  file: Ref;
}) => Promise<FileTextResolution>;

export function makeFileTextResolver<Ref extends FileDescriptor>(
  deps: FileTextDeps<Ref>,
): FileTextReader<Ref> {
  const { logger } = deps;
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
    let resolved: OpenedBytes;
    try {
      resolved = await deps.openBytes(ref);
    } catch (error) {
      if (deps.isRefusal?.(error)) throw error;
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
      text = await extractTextFromStream(kind, resolved, ref, deps);
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
      const rawTextId = await deps.rawText.getOrCreateId(text);
      return { text, rawTextId };
    } catch (error) {
      // Provenance is a nice-to-have on top of the extracted text, not a
      // precondition for it — a store failure must not take the whole run down.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('[movement:file-text] could not store raw text provenance', {
        name: ref.name,
        message,
      });
      return { text };
    }
  };
}
