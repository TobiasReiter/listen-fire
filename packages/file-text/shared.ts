export const MB = 1024 * 1024;

export type FileUnreadableReason =
  | 'unsupported_type'
  | 'bytes_unavailable'
  | 'extraction_failed'
  | 'no_text';

/** A file that could not be turned into text, and why. Structurally the
 *  engine's own `FileUnreadable`, so a result is handed to it as is. */
export interface FileUnreadable {
  unreadable: FileUnreadableReason;
  detail?: string;
}

export interface FileTextLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/** Buffer a stream up to `cap` bytes; null (the caller logs loudly) past it —
 *  a voice note must transcribe whole or not at all, never silently cut. */
export async function bufferStreamCapped(
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
