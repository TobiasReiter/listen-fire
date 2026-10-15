import { Readable } from 'node:stream';

import { Browser, Page, Locator } from 'playwright';
import jsPDF from 'jspdf';

import type { AICrawlResult } from '../lib/document_sources/ai_crawler';

import { ImageService } from './images';
import { sendSlackNotification } from '../lib/slack';
import { handleError } from '../lib/errors';
import { aiCaptureContent, reportAIResult, getScrollTiles } from '../lib/document_sources/ai_crawler';
import { logger } from 'movement-engine/services/logger';

type Screenshot = { width: number; height: number; data: Buffer };

type PdfStream = {
  type: 'PDF_STREAM';
  data: Readable;
  name: string;
};

/*
 * Helper type to generate return types which contain either a
 * document or an access error, but not both.
 */
type FetchedDocument<Format> =
  | {
      document: Format;
      error: null;
    }
  | {
      document: null;
      error: Error;
    };

abstract class Crawler {
  protected readonly page: Page;
  protected readonly browser: Browser;
  protected readonly url: string;
  protected readonly email: string | undefined;
  protected readonly passcode: string | undefined;

  constructor(opts: {
    page: Page;
    browser: Browser;
    url: string;
    email?: string;
    passcode?: string;
  }) {
    this.page = opts.page;
    this.browser = opts.browser;
    this.url = this.sanitiseUrl(opts.url);
    this.email = opts.email;
    this.passcode = opts.passcode;
  }

  protected sanitiseUrl(url: string) {
    return url;
  }

  protected async setup(): Promise<void> {
    return;
  }

  /**
   * Provide username and/or passcode if requested, and wait
   * for the user to be authenticated and the basic document UI to become visible.
   *
   * Returns null if authentication was successful (or unnecessary),
   * or an access error if not.
   */
  protected async authenticate(): Promise<Error | null> {
    return null;
  }

  protected async errorAlert() {
    try {
      const screenshot = await this.page.screenshot();
      const imageId = await ImageService.upload(new Blob([screenshot]));
      const errorScreenshotUrl = ImageService.getDeliveryUrl(imageId);

      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:arrow_right_hook: crawler failed to fetch anything (from url: ${this.url}, screenshot: ${errorScreenshotUrl})`,
        opsTitle: `Crawler failed to fetch anything from ${this.url}`,
      });
    } catch (err) {
      handleError(err);
    }
  }

  /**
   * Attempt to get a PDF from a URL.
   *
   * This method also ensures that the playwright context gets cleaned
   * up after the returned `PdfStream` has been read (or immediately
   * if the document can't be fetched).
   */
  async getPdf(): Promise<FetchedDocument<PdfStream>> {
    try {
      await this.setup();

      await this.page.goto(this.url);

      const result = await (async () => {
        const authenticationError = await this.authenticate();
        if (authenticationError) {
          return { document: null, error: authenticationError };
        }

        const pdfStream = await this.createPdfFromScreenshots();
        if (pdfStream) {
          return { document: pdfStream, error: null };
        }

        // Fallback if the document couldn't be fetched/created.
        return { document: null, error: new Error('Could not generate PDF from screenshots') };
      })();

      // Any error case should be cleaned up immediately. Successful
      // cases must handle their own cleanup after any relevant
      // streams have been read.
      if (result.error) {
        await this.errorAlert();
        await this.cleanup();
      }

      return result;
    } catch (err) {
      await this.errorAlert();
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Generate a PDF from the page images.
   * Tries the subclass's hardcoded screenshot logic first. If that returns
   * no screenshots, falls back to the AI-driven content capture.
   */
  protected async createPdfFromScreenshots(): Promise<PdfStream | null> {
    let screenshots: Screenshot[] = [];

    try {
      screenshots = await this.takeScreenshotsOfAllPages();
    } catch (err) {
      logger.info('Hardcoded screenshot logic threw, trying AI fallback', { url: this.url, err });
    }

    if (screenshots.length > 0) {
      return this.buildPdfFromScreenshots(screenshots);
    }

    // AI fallback — same page, same session
    const aiResult = await this.aiContentFallback();
    if (aiResult?.type === 'screenshots') {
      return this.buildPdfFromScreenshots(aiResult.data);
    }

    return null;
  }

  /**
   * Invoke AI-driven content capture on the current page.
   * Subclasses can override to disable or customize.
   */
  protected async aiContentFallback(): Promise<AICrawlResult | null> {
    logger.info('AI crawler: fallback activated', { url: this.url });
    const result = await aiCaptureContent(this.page, {
      email: this.email,
      passcode: this.passcode,
    });
    await reportAIResult(this.url, result, 'AI fallback');
    return result;
  }

  protected abstract takeScreenshotsOfAllPages(): Promise<Screenshot[]>;

  protected async buildPdfFromScreenshots(
    screenshots: Screenshot[],
  ): Promise<PdfStream | null> {
    const doc = screenshotsToPdf(screenshots);
    if (!doc) return null;

    const pdfBlob = doc.output('blob');
    const filename = `${(await this.page.title()) ?? 'document'}.pdf`;

    await this.cleanup();

    return {
      type: 'PDF_STREAM',
      data: Readable.from(Buffer.from(await pdfBlob.arrayBuffer())),
      name: filename,
    };
  }

  getContent?: () => Promise<string>;

  protected getPageContent?: () => Promise<string>;

  protected async cleanup() {
    await this.browser.close();
  }
}

/**
 * Shared PDF composition logic. Handles both regular screenshots (one per
 * PDF page) and scroll-tile sentinels (multiple tile images stitched onto
 * a single tall PDF page at sequential y-offsets).
 */
function screenshotsToPdf(screenshots: Screenshot[]): jsPDF | undefined {
  let doc: jsPDF | undefined;
  let isFirstPage = true;

  function addPage(width: number, height: number) {
    const orientation: 'portrait' | 'landscape' = width > height ? 'landscape' : 'portrait';
    if (isFirstPage) {
      doc = new jsPDF({
        orientation,
        unit: 'px',
        format: [height, width],
        putOnlyUsedFonts: true,
        compress: true,
        hotfixes: ['px_scaling'],
      });
      isFirstPage = false;
    } else {
      doc!.addPage([height, width], orientation);
    }
  }

  for (const screenshot of screenshots) {
    if (!screenshot.height || !screenshot.width) continue;

    // Check if this is a scroll-tile sentinel
    const tiles = getScrollTiles(screenshot);

    if (tiles && tiles.length > 0) {
      // Create one tall page and place each tile at its y-offset
      const totalHeight = tiles.reduce((sum, t) => sum + t.height, 0);
      const width = tiles[0].width;

      addPage(width, totalHeight);

      let yOffset = 0;
      for (const tile of tiles) {
        doc!.addImage({
          imageData: new Uint8Array(tile.data),
          x: 0,
          y: yOffset,
          width: tile.width,
          height: tile.height,
        });
        yOffset += tile.height;
      }
    } else {
      // Regular screenshot — one per page
      addPage(screenshot.width, screenshot.height);
      doc!.addImage({
        imageData: new Uint8Array(screenshot.data),
        x: 0,
        y: 0,
        width: screenshot.width,
        height: screenshot.height,
      });
    }
  }

  if (!doc) return undefined;

  doc.setFileId('0'.repeat(32));
  doc.setCreationDate(new Date(0));
  return doc;
}

/**
 * Standalone PDF builder for use outside of a Crawler instance.
 */
async function buildPdf(
  screenshots: Screenshot[],
  filename: string,
): Promise<PdfStream | null> {
  const doc = screenshotsToPdf(screenshots);
  if (!doc) return null;

  const pdfBlob = doc.output('blob');

  return {
    type: 'PDF_STREAM',
    data: Readable.from(Buffer.from(await pdfBlob.arrayBuffer())),
    name: filename,
  };
}

async function waitFor(el: Locator, options: Parameters<Locator['waitFor']>[0]) {
  try {
    return await el.waitFor(options);
  } catch (_err) {
    return;
  }
}

export { Crawler, Screenshot, FetchedDocument, waitFor, buildPdf };
