import { brotliCompress, constants, gzip } from 'node:zlib';

import { RequestHandler } from 'express';

import { logger } from 'movement-engine/public/log';

/**
 * Compress what the API sends back, when the client says it can read it.
 *
 * The portfolio list is the reason: a megabyte of JSON that gzips to a sixth of
 * itself, sent uncompressed on every load because nothing here had ever looked
 * at `Accept-Encoding`. There is no compression dependency in the tree and
 * adding one to compress one content type is not worth it, so this is Node's
 * own zlib behind the smallest middleware that can hold a response.
 *
 * It buffers rather than streams, which is why it is mounted on tRPC alone:
 * those responses are built whole in memory before they are written anyway, so
 * holding one costs nothing new — whereas a file download or a long-lived
 * stream must not be held at all.
 *
 * Compression is asynchronous. A megabyte of gzip is tens of milliseconds of
 * CPU, and this process has one thread to answer everybody with.
 */
function compressResponses({ threshold = 1024 }: { threshold?: number } = {}): RequestHandler {
  return (request, response, next) => {
    const accepted = String(request.headers['accept-encoding'] ?? '');
    // Brotli first: same speed as gzip at these settings, and smaller.
    const encoding = /\bbr\b/.test(accepted)
      ? 'br'
      : /\bgzip\b/.test(accepted)
        ? 'gzip'
        : undefined;

    if (!encoding || request.method === 'HEAD') {
      next();
      return;
    }

    // The answer differs by what the asker can read, so any cache between here
    // and there has to key on it.
    response.vary('Accept-Encoding');

    const chunks: Buffer[] = [];
    const write = response.write.bind(response);
    const end = response.end.bind(response);

    const collect = (chunk: unknown, encodingOrCallback?: unknown) => {
      if (chunk === undefined || chunk === null) return;
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
        return;
      }
      const charset = typeof encodingOrCallback === 'string' ? encodingOrCallback : 'utf8';
      chunks.push(Buffer.from(String(chunk), charset as BufferEncoding));
    };

    /* eslint-disable @typescript-eslint/no-explicit-any */
    response.write = ((chunk: any, encodingOrCallback?: any, callback?: any) => {
      collect(chunk, encodingOrCallback);
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') done();
      return true;
    }) as any;

    response.end = ((chunk?: any, encodingOrCallback?: any, callback?: any) => {
      if (typeof chunk !== 'function') collect(chunk, encodingOrCallback);
      const done =
        typeof chunk === 'function'
          ? chunk
          : typeof encodingOrCallback === 'function'
            ? encodingOrCallback
            : callback;

      response.write = write;
      response.end = end;

      const body = Buffer.concat(chunks);
      const contentType = String(response.getHeader('content-type') ?? '');
      const worthIt =
        body.length >= threshold &&
        !response.getHeader('content-encoding') &&
        /^(application\/json|application\/javascript|text\/|image\/svg)/.test(contentType);

      if (!worthIt) {
        response.setHeader('Content-Length', body.length);
        return end(body, done);
      }

      const finish = (error: Error | null, compressed: Buffer) => {
        if (error) {
          logger.warn('[compression] falling back to an uncompressed response', {
            cause: error.message,
          });
          response.setHeader('Content-Length', body.length);
          end(body, done);
          return;
        }

        response.setHeader('Content-Encoding', encoding);
        response.setHeader('Content-Length', compressed.length);
        end(compressed, done);
      };

      if (encoding === 'br') {
        // Quality 5 is where brotli stops being slower than gzip for what it
        // saves; the default, 11, is for files compressed once and served many
        // times, not for an answer computed per request.
        brotliCompress(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }, finish);
      } else {
        gzip(body, finish);
      }

      return response;
    }) as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    next();
  };
}

export { compressResponses };
