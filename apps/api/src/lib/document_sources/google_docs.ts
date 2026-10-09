import { PdfStream } from '.';

import { google } from 'googleapis';

import { getEnvVar } from '../utils/environment';
import { PlaywrightService } from '../../services/playwright';
import { logger } from '../../services/logger';
import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';

class GoogleDocsCrawler extends Crawler {
  protected async takeScreenshotsOfAllPages() {
    // this is based on fullscreen presentation at /mobilepresent
    // if this ever breaks in future, consider trying strategy from commit: e4e132c2f8

    const slideLocators = this.page.locator('.punch-viewer-content').nth(0);
    const nextButtonLocator = this.page.locator('.punch-viewer-navbar-next').nth(0);
    const footerLocator = this.page.locator('.punch-viewer-navbar').nth(0);

    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(1000);

    await footerLocator.evaluate((el) =>
      el.setAttribute('style', 'opacity: 1; pointer-events: auto;'),
    );

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);
      const box = await slideLocators.boundingBox();
      if (box) {
        const screenshot = await slideLocators.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if ((await nextButtonLocator.getAttribute('aria-disabled')) === 'true') {
        break;
      }

      await nextButtonLocator.waitFor({ state: 'visible' });
      await nextButtonLocator.click();

      // it's a little tricky to confirm that the effects of clicking the button
      // have taken effect, so wait briefly to increase the chance of the render completing.
      await new Promise((resolve) => setTimeout(resolve, 500)); // eslint-disable-line @typescript-eslint/no-loop-func
    }

    return screenshots;
  }
}

// The viewer's DOM is undocumented and has shifted before, but it currently
// offers two stable contracts to key off: a page-number box whose
// aria-label reads "Page N of M" (tracks the current page and carries the
// total), and a full-size page image whose alt reads "Page N of M" (distinct
// from the thumbnail strip's "A thumbnail image for page N"). Filling the box
// and pressing Enter still navigates. Images render lazily, so a page's image
// only gets a real src once it has been scrolled into view.
const PAGE_BOX_LABEL_PATTERN = /^Page (\d+) of (\d+)$/;

function parsePageBoxLabel(label: string): { page: number; total: number } | undefined {
  const match = label.match(PAGE_BOX_LABEL_PATTERN);
  if (!match) return undefined;
  return { page: Number(match[1]), total: Number(match[2]) };
}

class GoogleDriveCrawler extends Crawler {
  protected async takeScreenshotsOfAllPages() {
    await this.page.waitForTimeout(1000);
    await this.page.waitForLoadState('domcontentloaded');

    // aria-label^="Page " alone also matches the zoom control
    // ("Page zoom control"), so the label must be matched exactly.
    const pageBox = this.page.getByRole('textbox', { name: PAGE_BOX_LABEL_PATTERN });
    await pageBox.waitFor({ state: 'visible', timeout: 30000 });

    const initialLabel = await pageBox.getAttribute('aria-label');
    const initialParsed = initialLabel ? parsePageBoxLabel(initialLabel) : undefined;
    if (!initialParsed) {
      throw new Error(`Could not read page count from Drive viewer page box label: ${initialLabel}`);
    }

    const { total } = initialParsed;
    const screenshots: Screenshot[] = [];

    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      await pageBox.fill(String(pageNumber));
      await pageBox.press('Enter');

      const pageImage = this.page.locator(`img[alt="Page ${pageNumber} of ${total}"]`).nth(0);
      await pageImage.waitFor({ state: 'attached', timeout: 30000 });
      await pageImage.scrollIntoViewIfNeeded({ timeout: 30000 });

      await pageImage.evaluate(
        (img: HTMLImageElement) =>
          new Promise<void>((resolve, reject) => {
            if (img.complete && img.naturalWidth > 0) {
              resolve();
              return;
            }
            const timeout = setTimeout(() => reject(new Error('Image did not load in time')), 30000);
            img.addEventListener(
              'load',
              () => {
                clearTimeout(timeout);
                resolve();
              },
              { once: true },
            );
            img.addEventListener(
              'error',
              () => {
                clearTimeout(timeout);
                reject(new Error('Image failed to load'));
              },
              { once: true },
            );
          }),
      );

      const box = await pageImage.boundingBox({ timeout: 30000 });
      if (box) {
        const screenshot = await pageImage.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      // it's a little tricky to confirm that the effects of filling the page
      // box have taken effect, so wait briefly to increase the chance of the
      // render completing.
      await new Promise((resolve) => setTimeout(resolve, 500)); // eslint-disable-line @typescript-eslint/no-loop-func
    }

    return screenshots;
  }
}

class GoogleDocs {
  private GDRIVE_FILE_ID_REGEX = /(?<=\/d\/(?!e\/)|\/e\/)[^/]*/;

  getFileId(url: URL) {
    const match = url.pathname.match(this.GDRIVE_FILE_ID_REGEX);
    return url.searchParams.get('id') ?? (match ? match[0] : undefined);
  }

  getFirstPageUrl(url: string) {
    const parsedUrl = new URL(url);
    const searchParamKeys = [...parsedUrl.searchParams.keys()];
    for (const key of searchParamKeys) {
      parsedUrl.searchParams.delete(key);
    }

    // in google docs presentation, load fullscreen presentation at /mobilepresent
    if (parsedUrl.pathname.includes('presentation')) {
      const pathname = parsedUrl.pathname;
      const pathnameEdited = pathname.replace(/\/edit(.*)/, '/mobilepresent');
      parsedUrl.pathname = pathnameEdited;
    }

    return parsedUrl.toString();
  }

  async getAsPdf(url: string): Promise<PdfStream | null> {
    try {
      const fileId = this.getFileId(new URL(url));
      if (fileId) {
        const output = await this.getFromDrive(fileId);
        return output;
      } else {
        return await this.getFromCrawler(url);
      }
    } catch (err) {
      console.error(err);
      return this.getFromCrawler(url);
    }
  }

  async getFromCrawler(url: string) {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a figma link.
      const result: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          let crawler;
          if (/drive\.google\.com/.test(url)) {
            crawler = new GoogleDriveCrawler({
              page,
              browser,
              url: this.getFirstPageUrl(url),
            });
          } else {
            crawler = new GoogleDocsCrawler({
              page,
              browser,
              url: this.getFirstPageUrl(url),
            });
          }
          return crawler.getPdf();
        },
      );

      if (result.error) {
        throw result.error;
      }

      return result.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from Google Docs link: ${url}.`);

      return null;
    }
  }

  async getFromDrive(fileId: string): Promise<PdfStream> {
    const service = google.drive({
      version: 'v3',
      auth: getEnvVar('GOOGLE_DRIVE_API_KEY', { devDefault: 'local' }),
    });

    const metadata = await service.files.get({
      fileId,
      fields: 'name,mimeType',
      supportsAllDrives: true,
    });
    let name = metadata.data.name ?? `${fileId}.pdf`;
    let response;

    if (metadata.data.mimeType?.startsWith('application/vnd.google-apps.')) {
      response = await service.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'stream' },
      );

      if (!name.endsWith('.pdf')) {
        name += '.pdf';
      }
    } else {
      response = await service.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' },
      );

      if (
        metadata.data.mimeType ===
          'application/vnd.openxmlformats-officedocument.presentationml.presentation' &&
        !name.endsWith('.pptx')
      ) {
        name += '.pptx';
      }
    }

    return { type: 'PDF_STREAM', data: response.data, name };
  }
}

const GoogleDocsService = new GoogleDocs();

export { GoogleDocsService, parsePageBoxLabel };
