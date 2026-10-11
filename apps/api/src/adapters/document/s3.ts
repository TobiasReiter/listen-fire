import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ReadableStream as WebReadableStream } from 'node:stream/web';

import {
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { ChecksumTransform } from '../../lib/utils/hash';
import { DocumentProvider, storeKey } from './interface';

type s3AdapterProps = {
  bucket: string;
  // The region must match that of the S3 bucket. S3-compatible services that
  // have no regions of their own conventionally accept `auto`.
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Any S3-compatible endpoint — R2, MinIO, Supabase Storage, Ceph. Absent
   *  means AWS S3 itself (the SDK derives the endpoint from the region). */
  endpoint?: string;
  /** Bucket in the PATH rather than the hostname. Self-hosted endpoints
   *  (MinIO, a bare-IP Ceph) generally need it; AWS and R2 do not. */
  forcePathStyle?: boolean;
};

class S3Adapter implements DocumentProvider {
  private bucket: string;
  private client: S3Client;

  constructor({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint,
    forcePathStyle,
  }: s3AdapterProps) {
    this.bucket = bucket;
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  private generateObjectKey({ filename, keyPrefix }: { filename: string; keyPrefix?: string }) {
    // One segment, a name: what `keyOf` reads back.
    const named = filename.replace(/\//g, '_');
    const base = `${randomUUID()}/${named === '' || named === '.' || named === '..' ? 'file' : named}`;
    return keyPrefix ? `${keyPrefix.replace(/\/+$/, '')}/${base}` : base;
  }

  private getObjectUri({ key }: { key: string }) {
    return `s3://${this.bucket}/${key}`;
  }

  /** `s3://<this bucket>/<key>` exactly, its key's segments each a name: no
   *  other bucket, no empty segment, no `.` or `..`. */
  keyOf(objectUri: string): string | undefined {
    const prefix = `s3://${this.bucket}/`;
    if (!objectUri.startsWith(prefix)) return undefined;
    return storeKey(objectUri.slice(prefix.length));
  }

  private requireKey(objectUri: string): string {
    const key = this.keyOf(objectUri);
    if (key === undefined) throw new Error(`'${objectUri}' is not an object of this document store`);
    return key;
  }

  async upload(
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
      keyPrefix?: string;
    },
  ) {
    const key = this.generateObjectKey({ filename, keyPrefix });
    const checksumTransform = new ChecksumTransform();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: readable.pipe(checksumTransform),
        ContentLength: contentLength,
        ContentType: mimeType,
      }),
    );

    const checksum = checksumTransform.getDigest();

    return {
      objectUri: this.getObjectUri({ key }),
      checksum,
    };
  }

  async getFile({ objectUri }: { objectUri: string }): Promise<{
    webStream: ReadableStream;
    ContentLength: number | undefined;
    ContentType: string | undefined;
  } | null> {
    const key = this.requireKey(objectUri);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);
    const webStream = response.Body?.transformToWebStream();
    return webStream
      ? {
          webStream,
          ContentLength: response.ContentLength,
          ContentType: response.ContentType,
        }
      : null;
  }

  async getDownloadUrl({ objectUri }: { objectUri: string }) {
    const key = this.requireKey(objectUri);
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    const signedUrl = await getSignedUrl(this.client, command, { expiresIn: 15 * 60 });
    return signedUrl;
  }

  async getFileNodeStream({ objectUri }: { objectUri: string }) {
    const response = await this.getFile({ objectUri });
    if (!response) {
      throw new Error('Could not get file data');
    }
    const { webStream, ContentLength, ContentType } = response;

    const nodeStream = Readable.fromWeb(webStream as WebReadableStream) as Readable & {
      size: number;
      contentType?: string;
    };

    nodeStream.size = ContentLength ?? 0;
    nodeStream.contentType = ContentType;

    return nodeStream;
  }

  async delete(uri: string) {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: this.requireKey(uri),
    });
    await this.client.send(command);
  }
}

export { S3Adapter };
