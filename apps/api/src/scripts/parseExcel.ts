import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';

import { getXlsxContent } from 'file-text';

import { analyzeSheet } from '../services/translation_graph/movement/file_text';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: pnpm run parseExcel <path-to-xlsx-or-csv>');
    process.exit(1);
  }

  const absolutePath = resolve(process.cwd(), filePath);
  const filename = basename(absolutePath);
  console.error(`Parsing: ${absolutePath}\n`);

  const stream = createReadStream(absolutePath);
  const content = await getXlsxContent(stream, filename, analyzeSheet);

  console.log(content);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
