import { Readable } from 'node:stream';

interface DocumentProvider {
  upload(
    readable: Readable,
    {
      filename,
      mimeType,
      contentLength,
      keyPrefix,
    }: {
      filename: string;
      mimeType?: string;
      contentLength: number;
      /** Optional isolation prefix for the stored object's key (e.g. a
       *  short-lived `exposed/` namespace). When set, the object key begins
       *  with it, so a presign route can be scoped to that prefix alone. */
      keyPrefix?: string;
    },
  ): Promise<{ objectUri: string; checksum: string }>;

  getFile({ objectUri }: { objectUri: string }): Promise<{
    webStream: ReadableStream;
    ContentLength: number | undefined;
    ContentType: string | undefined;
  } | null>;

  getFileNodeStream({ objectUri }: { objectUri: string }): Promise<
    Readable & {
      size: number;
      contentType?: string;
    }
  >;

  getDownloadUrl({ objectUri }: { objectUri: string }): Promise<string>;

  /**
   * The store's key for an `objectUri` it would serve, or undefined for one it
   * would not: the ONE reading of a URI, which every read, delete and
   * ownership check (`streamFileRef`) goes through, so none reads a key
   * another would not.
   */
  keyOf(objectUri: string): string | undefined;

  delete(uri: string): Promise<void>;
}

/** A store key whose `/`-separated segments are each a name, or undefined. */
export function storeKey(key: string): string | undefined {
  const segments = key.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') ? key : undefined;
}

export { DocumentProvider };
