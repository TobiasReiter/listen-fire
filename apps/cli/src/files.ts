// Reading a file's text on the local host. The bytes come through the hosted
// product's own path (redeemed from the document store, or from the external
// that owns the file); which files lf can read as text is decided here.

import type { Readable } from 'node:stream';
import type { FileRef, PricedAnswer } from 'engine-contracts';
import type { FileTextResolution } from 'movement-engine/public/run-support';

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|csv)|application\/[\w.+-]+\+(json|xml))/;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'html', 'log']);
// `files.render` stores a "pdf" as its text, so a pdf-typed file is text unless its bytes are a real PDF.
const PDF_MAGIC = '%PDF-';

export async function localFileText(input: {
  file: FileRef;
  /** The file's bytes, redeemed wherever they live. */
  redeem: () => Promise<{ stream: Readable }>;
}): Promise<PricedAnswer<FileTextResolution>> {
  const { file } = input;
  const type = file.contentType ?? '';
  const extension = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  const textual = type !== '' ? TEXT_TYPES.test(type) || type === 'application/pdf' : TEXT_EXTENSIONS.has(extension);
  if (!textual) return { unreadable: 'unsupported_type', detail: `lf reads text files only, not ${type || extension || 'an unknown type'}` };
  let bytes: Buffer;
  try {
    bytes = await bytesOf((await input.redeem()).stream);
  } catch (error) {
    return { unreadable: 'bytes_unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (bytes.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC) {
    return { unreadable: 'unsupported_type', detail: 'lf cannot extract text from a PDF yet' };
  }
  const text = bytes.toString('utf8');
  return text.trim() === '' ? { unreadable: 'no_text' } : { text };
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
