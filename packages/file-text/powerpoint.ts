import { createWriteStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import yauzl from 'yauzl-promise';
import sax from 'sax';

import { tmpPromise } from './tmp';

declare module 'yauzl-promise' {
  interface ZipFile {
    readEntry(): Promise<(yauzl.Entry & { filename: string }) | null>;
  }
}

function asyncPipe(from: Readable, to: Writable) {
  return new Promise((res, rej) => {
    // need to prevent multiple resolve/reject calls
    let resolved = false;
    const [resolve, reject] = [res, rej].map((fn) => {
      return (...args: Parameters<typeof fn>) => {
        if (!resolved) {
          resolved = true;
          fn(...args);
        }
      };
    });

    from.pipe(to);
    from.on('error', reject);
    to.on('error', reject);
    to.on('end', resolve);
  });
}

async function getPptxText(docStream: Readable) {
  // create temp file
  const [path, fd, cleanup] = await tmpPromise();

  // write to tmp file
  const ws = createWriteStream(path);
  await pipeline(docStream, ws);

  const zip = await yauzl.fromFd(fd);

  // set up parser listeners
  let slideText = '';
  const onOpenTag = (node: sax.Tag | sax.QualifiedTag) => {
    if (node.name === 'a:p') {
      slideText += '\n';
    }
  };
  const onText = (t: string) => {
    if (t.trim()) {
      slideText += t;
    }
  };

  // get text from each slide file
  let entry = await zip.readEntry();
  while (entry) {
    const match = entry.filename.match(/slide(\d+)\.xml$/);
    if (match) {
      const rs = await zip.openReadStream(entry);
      const parser = sax.createStream(true);

      if (slideText.length) {
        slideText += '\n\n';
      }

      slideText += `--- Page ${match[1]} ---\n\n`;

      parser.on('opentag', onOpenTag);
      parser.on('text', onText);

      // "pipeline" hung here - think the sax parser
      // expects to be piped onwards so doesn't close its output
      await asyncPipe(rs, parser);
      parser.removeAllListeners();
    }
    entry = await zip.readEntry();
  }

  await zip.close();
  cleanup();

  return slideText;
}

export { getPptxText };
