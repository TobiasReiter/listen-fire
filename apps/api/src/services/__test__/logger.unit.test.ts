/**
 * `winston.format.simple()` stringifies metadata with plain JSON.stringify,
 * which drops Error.message/Error.stack (non-enumerable) → `{}`. The logger's
 * `simple()` replacement must apply the same Error-aware replacer used for
 * `info.message` to the rest-metadata too, in any NODE_ENV.
 */

import { Writable } from "node:stream";

import winston from 'winston';

import { logger } from '../logger';

// Captures through a transport on the real logger rather than spying on
// process.stdout: winston's Console transport writes via `console._stdout`,
// which exists only under jest's verbose (single-file) console. A multi-file
// run swaps in a buffered console, so a stdout spy sees nothing there.
function captureLogOutput(emit: () => void): string {
  const chunks: string[] = [];
  const transport = new winston.transports.Stream({
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk.toString());
        done();
      },
    }),
  });
  logger.add(transport);
  try {
    emit();
  } finally {
    logger.remove(transport);
  }
  return chunks.join('');
}

describe('logger metadata Error serialization', () => {
  it('keeps message/stack for a top-level Error in metadata', () => {
    const output = captureLogOutput(() => {
      logger.warn('Plugin failed to fetch URL', { url: 'https://example.com', error: new Error('boom') });
    });
    expect(output).toContain('"message":"boom"');
    expect(output).toContain('"stack":"Error: boom');
    expect(output).not.toContain('"error":{}');
  });

  it('keeps message/stack for a nested Error in metadata', () => {
    const output = captureLogOutput(() => {
      logger.warn('Nested error case', { ctx: { error: new Error('nested') } });
    });
    expect(output).toContain('"message":"nested"');
    expect(output).toContain('"stack":"Error: nested');
  });

  it('omits trailing metadata json when there is none', () => {
    const output = captureLogOutput(() => {
      logger.warn('Plain message no metadata');
    });
    expect(output).toContain('Plain message no metadata');
    expect(output).not.toContain('{}');
  });
});
