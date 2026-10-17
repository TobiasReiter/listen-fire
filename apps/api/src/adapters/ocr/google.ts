import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { google } from '@google-cloud/documentai/build/protos/protos';
import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Storage } from '@google-cloud/storage';
import { backOff } from 'exponential-backoff';

import { OcrAdapter } from './interface';
import { MB, OCR_START_PAGE_TAG, SECOND } from '../../constants';
import { streamToBuffer } from '../../lib/utils/stream';
import { Queue } from 'movement-engine/public/queue';
import { logger } from 'movement-engine/public/log';

// This queue is used to limit the number of concurrent requests to the Google Document AI API
// and to handle retries in case of rate limiting
const batchRateLimitQueue = new Queue<string>({ concurrency: 5 });

const RETRY_LIMIT = 4;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 4;
const RATE_LIMIT_DELAY = 30 * SECOND;

async function enqueueBatch(fn: () => Promise<string>) {
  return batchRateLimitQueue.enqueue(async () => {
    return backOff(fn, {
      jitter: 'none',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE, // 0s, 1s, 4s, 16s, 64s
      retry: async (e, attempt) => {
        if (e instanceof Error && e.message.includes('429')) {
          // rate limit
          // extra delay to lower the odds of hitting the rate limit again
          logger.info(`Hit rate limit, waiting an additional ${RATE_LIMIT_DELAY / SECOND} seconds`);
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        } else if (e instanceof Error && e.message.includes('401')) {
          // invalid api key
          return false;
        }

        if (attempt < RETRY_LIMIT) {
          logger.info(
            `Retrying Google Document AI query in ${
              (INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)
            } seconds`,
            {
              error: e,
            },
          );
        }
        return true;
      },
    });
  });
}

class GoogleDocumentAIAdapter implements OcrAdapter {
  private storageClient: Storage;
  private documentProcessorClient: DocumentProcessorServiceClient;
  private processorName: string;
  private bucketName: string;

  constructor({
    privateKey,
    clientEmail,
    clientId,
    projectId,
    projectLocation,
    processorId,
    bucketName,
  }: {
    privateKey: string;
    clientEmail: string;
    clientId: string;
    projectId: string;
    projectLocation: string;
    processorId: string;
    bucketName: string;
  }) {
    const credentials = {
      type: 'service_account',
      private_key: privateKey,
      client_email: clientEmail,
      client_id: clientId,
    };

    this.storageClient = new Storage({
      credentials,
    });

    this.documentProcessorClient = new DocumentProcessorServiceClient({
      apiEndpoint: 'eu-documentai.googleapis.com',
      credentials,
    });

    this.processorName = `projects/${projectId}/locations/${projectLocation}/processors/${processorId}`;

    this.bucketName = bucketName;
  }

  extractPdf(rs: Readable, { numpages, size }: { numpages?: number; size: number }) {
    // Quota limits https://cloud.google.com/document-ai/quotas
    if (numpages && numpages <= 15 && size < 20 * MB) {
      return this.ocrOnline(rs);
    } else {
      return this.ocrInBatch(rs);
    }
  }

  /** Up to 15 pages or 20MB */
  async ocrOnline(rs: Readable): Promise<string | null> {
    const buffered = await streamToBuffer(rs);
    const [result] = await this.documentProcessorClient.processDocument({
      name: this.processorName,
      rawDocument: {
        content: buffered.toString('base64'),
        mimeType: 'application/pdf',
      },
    });

    return this.extractConcatenatedPages(result.document);
  }

  // the storage here is not ephemeral, but we want it to act like it is
  // so it's important to delete the files after we're done with them
  async ocrInBatch(file: Readable): Promise<string> {
    const inputFileId = await this.uploadToStorage(file);
    const cleanupInputFile = () => this.deleteFileById(inputFileId);

    // we expect the OCR results to go into separate files with the same prefix
    const outputPrefix = `${inputFileId}-output/`;
    const cleanupOutputFiles = () => this.deleteFilesByPrefix(outputPrefix);

    // handle rate limiting and retries
    // you can't retry the upload (as the stream's closed once read), so we do that before
    return enqueueBatch(async () => {
      await this.ocrDocumentByFileId(inputFileId, { outputPrefix }).finally(cleanupInputFile);

      // at this point the OCR results are in the output files
      return this.getTextFromAllFilesWithPrefix(outputPrefix).finally(cleanupOutputFiles);
    });
  }

  /*
    Text Postprocessing Utilities

    The output of Google Document OCR isn't plain text. We need to extract the text and add metadata.
  */

  private extractConcatenatedPages(
    document?: google.cloud.documentai.v1.IDocument | null,
  ): string | null {
    if (!document || !document.text || !document.pages?.length) {
      return null;
    }

    let text = '';
    for (const page of document.pages) {
      const pageContent = this.extractPage(page, document.text);
      if (pageContent) {
        text += `${OCR_START_PAGE_TAG}\n${pageContent}`;
      }
    }

    return text === '' ? null : text;
  }

  private extractPage(
    page: google.cloud.documentai.v1.Document.IPage,
    fulltext: string,
  ): string | null {
    const paragraphs = page?.paragraphs;
    const numParagraphs = paragraphs?.length;
    if (!paragraphs || !numParagraphs) {
      return null;
    }

    const startAnchor = paragraphs[0].layout?.textAnchor;
    const endAnchor = paragraphs[numParagraphs - 1].layout?.textAnchor;
    if (!startAnchor || !endAnchor) {
      return null;
    }

    const startIndex = this.getStartIndex(startAnchor) ?? 0; // First shard in document doesn't have startIndex property
    const endIndex = this.getEndIndex(endAnchor);

    return endIndex ? fulltext.substring(startIndex, endIndex) : null;
  }

  private getStartIndex(anchor: google.cloud.documentai.v1.Document.ITextAnchor): number | null {
    return !anchor.textSegments || !anchor.textSegments[0].startIndex
      ? null
      : Number(anchor.textSegments[0].startIndex);
  }

  private getEndIndex(anchor: google.cloud.documentai.v1.Document.ITextAnchor): number | null {
    return !anchor.textSegments || !anchor.textSegments[anchor.textSegments.length - 1].endIndex
      ? null
      : Number(anchor.textSegments[anchor.textSegments.length - 1].endIndex);
  }

  /*
    Temporary Storage Utilities

    For the batch processing, we upload the file to storage and let Google OCR it async.
    It writes the outputs into separate files in storage.
    We then download and combine them to get our output.
    We clean up the storage files to ensure we're not building a massive storage bill.
  */

  private async uploadToStorage(file: Readable) {
    const fileId = randomUUID();
    const ws = this.storageClient.bucket(this.bucketName).file(fileId).createWriteStream();
    await pipeline(file, ws);

    return fileId;
  }

  private async ocrDocumentByFileId(fileId: string, { outputPrefix }: { outputPrefix: string }) {
    const [operation] = await this.documentProcessorClient.batchProcessDocuments({
      name: this.processorName,
      inputDocuments: {
        gcsDocuments: {
          documents: [
            {
              gcsUri: `gs://${this.bucketName}/${fileId}`,
              mimeType: 'application/pdf',
            },
          ],
        },
      },
      documentOutputConfig: {
        gcsOutputConfig: {
          gcsUri: `gs://${this.bucketName}/${outputPrefix}`,
          fieldMask: { paths: ['text', 'pages.paragraphs'] },
        },
      },
    });

    await operation.promise();
  }

  private async deleteFileById(fileId: string) {
    await this.storageClient.bucket(this.bucketName).file(fileId).delete();
  }

  private async deleteFilesByPrefix(prefix: string) {
    await this.storageClient.bucket(this.bucketName).deleteFiles({ prefix });
  }

  private async getTextFromAllFilesWithPrefix(prefix: string) {
    const [files] = await this.storageClient.bucket(this.bucketName).getFiles({ prefix });
    // Extract pages from multiple files which can have several pages

    let text = '';
    for (const fileReference of files) {
      const [file] = await fileReference.download();
      const document = JSON.parse(file.toString()) as google.cloud.documentai.v1.IDocument;
      text += this.extractConcatenatedPages(document);
    }

    return text;
  }
}

export { GoogleDocumentAIAdapter };
