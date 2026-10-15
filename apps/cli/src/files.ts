// Reading a file's text on the local host: the files folder `.lf/files/` is
// the object store (`files.render` writes there), so a file's source is a
// `file://` path under it. Nothing outside the folder is ever opened.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileRef, PricedAnswer } from 'engine-contracts';
import type { FileTextResolution } from 'movement-engine/services/movement_engine/expression';
import type { Project } from './project';

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|csv)|application\/[\w.+-]+\+(json|xml))/;
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'html', 'log']);
// `files.render` stores a "pdf" as its text, so a pdf-typed file is text unless its bytes are a real PDF.
const PDF_MAGIC = '%PDF-';

export async function localFileText(project: Project, file: FileRef): Promise<PricedAnswer<FileTextResolution>> {
  return resolve(project, file);
}

function resolve(project: Project, file: FileRef): FileTextResolution {
  const source = file.source;
  if (source === undefined) return { unreadable: 'bytes_unavailable', detail: 'the file has no source' };
  if ('adapterType' in source || 'ownerAdapterType' in source) {
    return { unreadable: 'bytes_unavailable', detail: 'lf has no file transport for externals yet' };
  }
  if (!source.objectUri.startsWith('file://')) {
    return { unreadable: 'bytes_unavailable', detail: `lf reads only file:// stored files, not ${source.objectUri}` };
  }
  const folder = join(project.lfDir, 'files');
  const path = fileURLToPath(source.objectUri);
  if (!existsSync(path)) return { unreadable: 'bytes_unavailable', detail: `no stored file at ${path}` };
  // Real paths on both sides, so neither `..` nor a symlink leaves the folder.
  const real = realpathSync(path);
  const root = existsSync(folder) ? realpathSync(folder) : folder;
  if (!real.startsWith(root + sep)) {
    return { unreadable: 'bytes_unavailable', detail: `${path} is outside the files folder (${folder}); refused` };
  }
  const bytes = readFileSync(real);
  if (bytes.subarray(0, PDF_MAGIC.length).toString('latin1') === PDF_MAGIC) {
    return { unreadable: 'unsupported_type', detail: 'lf cannot extract text from a PDF yet' };
  }
  const type = file.contentType ?? '';
  const extension = (file.name ?? real).split('.').pop()?.toLowerCase() ?? '';
  const textual = type !== '' ? TEXT_TYPES.test(type) || type === 'application/pdf' : TEXT_EXTENSIONS.has(extension);
  if (!textual) return { unreadable: 'unsupported_type', detail: `lf reads text files only, not ${type || extension || 'an unknown type'}` };
  const text = bytes.toString('utf8');
  return text.trim() === '' ? { unreadable: 'no_text' } : { text };
}
