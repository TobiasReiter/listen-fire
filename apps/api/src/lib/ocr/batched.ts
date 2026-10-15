import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { google } from '@google-cloud/documentai/build/protos/protos';
import { backOff } from 'exponential-backoff';

import { SECOND } from '../../constants';
import { getEnvVar } from '../utils/environment';
import { Queue } from 'movement-engine/lib/utils/queue';
import { logger } from 'movement-engine/services/logger';
import { extractConcatenatedPages } from './page';
import { getProcessorName, googleOcrClient, googleStorageClient } from './google';

// Read at first USE: batched OCR is optional, and an eager read made importing
// this module enough to stop a production deployment booting without it.
const bucketName = () =>
  getEnvVar('GOOGLE_STORAGE_BUCKET_NAME', {
    devDefault: 'listen-fire-api-transient',
    because: 'batched OCR stages PDFs in it before handing them to Document AI',
  });

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

async function uploadToStorage(file: Readable) {
  const fileId = randomUUID();
  const ws = googleStorageClient.bucket(bucketName()).file(fileId).createWriteStream();
  await pipeline(file, ws);

  return fileId;
}

async function ocrDocumentByFileId(fileId: string, { outputPrefix }: { outputPrefix: string }) {
  const [operation] = await googleOcrClient.batchProcessDocuments({
    name: getProcessorName(),
    inputDocuments: {
      gcsDocuments: {
        documents: [
          {
            gcsUri: `gs://${bucketName()}/${fileId}`,
            mimeType: 'application/pdf',
          },
        ],
      },
    },
    documentOutputConfig: {
      gcsOutputConfig: {
        gcsUri: `gs://${bucketName()}/${outputPrefix}`,
        fieldMask: { paths: ['text', 'pages.paragraphs'] },
      },
    },
  });

  await operation.promise();
}

async function deleteFileById(fileId: string) {
  await googleStorageClient.bucket(bucketName()).file(fileId).delete();
}

async function deleteFilesByPrefix(prefix: string) {
  await googleStorageClient.bucket(bucketName()).deleteFiles({ prefix });
}

async function getTextFromAllFilesWithPrefix(prefix: string) {
  const [files] = await googleStorageClient.bucket(bucketName()).getFiles({ prefix });
  // Extract pages from multiple files which can have several pages

  let text = '';
  for (const fileReference of files) {
    const [file] = await fileReference.download();
    const document = JSON.parse(file.toString()) as google.cloud.documentai.v1.IDocument;
    text += extractConcatenatedPages(document);
  }

  return text;
}

// the storage here is not ephemeral, but we want it to act like it is
// so it's important to delete the files after we're done with them
async function ocrInBatch(file: Readable): Promise<string> {
  const inputFileId = await uploadToStorage(file);
  const cleanupInputFile = () => deleteFileById(inputFileId);

  // we expect the OCR results to go into separate files with the same prefix
  const outputPrefix = `${inputFileId}-output/`;
  const cleanupOutputFiles = () => deleteFilesByPrefix(outputPrefix);

  // handle rate limiting and retries
  // you can't retry the upload (as the stream's closed once read), so we do that before
  return enqueueBatch(async () => {
    await ocrDocumentByFileId(inputFileId, { outputPrefix }).finally(cleanupInputFile);

    // at this point the OCR results are in the output files
    return getTextFromAllFilesWithPrefix(outputPrefix).finally(cleanupOutputFiles);
  });
}

export { ocrInBatch };
