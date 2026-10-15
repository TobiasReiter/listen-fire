import { Readable } from 'node:stream';

import { logger } from 'movement-engine/services/logger';
import { OcrAdapter } from './interface';

class HybridAdapter implements OcrAdapter {
  constructor(
    private googleAdapter: OcrAdapter,
    private openAiAdapter: OcrAdapter,
  ) {}

  async extractPdf(rs: Readable, options: { numpages?: number; size: number }) {
    try {
      const openAiResult = await this.openAiAdapter.extractPdf(rs, options);
      return openAiResult;
    } catch (e) {
      logger.info(
        `Failed to extract text from PDF using OpenAI, falling back to Google. Error: ${e}`,
      );
      const googleResult = await this.googleAdapter.extractPdf(rs, options);
      return googleResult;
    }
  }
}

export { HybridAdapter };
