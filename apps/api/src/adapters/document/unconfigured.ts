import { Readable } from 'node:stream';

import { DocumentProvider } from './interface';

const MESSAGE =
  'Object storage is not configured, so this deployment cannot store or serve files. ' +
  'Set AWS_DOCUMENT_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY ' +
  '(plus AWS_S3_ENDPOINT and AWS_S3_FORCE_PATH_STYLE=true for a non-AWS S3-compatible ' +
  'service such as R2, MinIO or Supabase Storage).';

/**
 * The stand-in for a deployment with no object storage. Registering it —
 * rather than throwing while wiring the services up — is what makes storage
 * genuinely OPTIONAL: a deployment that never touches a file boots and runs,
 * and only the file-touching paths fail, naming the vars they need.
 */
class UnconfiguredDocumentProvider implements DocumentProvider {
  async upload(
    _readable: Readable,
    _options: {
      filename: string;
      mimeType?: string;
      contentLength: number;
      keyPrefix?: string;
    },
  ): Promise<{ objectUri: string; checksum: string }> {
    throw new Error(MESSAGE);
  }

  async getFile(_args: { objectUri: string }): Promise<{
    webStream: ReadableStream;
    ContentLength: number | undefined;
    ContentType: string | undefined;
  } | null> {
    throw new Error(MESSAGE);
  }

  async getFileNodeStream(
    _args: { objectUri: string },
  ): Promise<Readable & { size: number; contentType?: string }> {
    throw new Error(MESSAGE);
  }

  async getDownloadUrl(_args: { objectUri: string }): Promise<string> {
    throw new Error(MESSAGE);
  }

  keyOf(_objectUri: string): string | undefined {
    return undefined;
  }

  async delete(_uri: string): Promise<void> {
    throw new Error(MESSAGE);
  }
}

export { UnconfiguredDocumentProvider };
