import { PdfStream } from '.';

import { logger } from 'movement-engine/public/log';
import { PlaywrightService } from '../../services/playwright';
import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';

class FigmaCrawler extends Crawler {
  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    const slideLocators = this.page.locator('#viewerContainer').nth(0);
    const nextButtonLocator = this.page.locator('[aria-label="Next frame"]').nth(0);
    const footerLocator = this.page.locator('[aria-label="Pages"]').nth(0);
    const progressBar = this.page.locator(
      'div[class^="progress_bar--outer--"], div[class*=" progress_bar--outer--"]',
    );

    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(8000);

    // Wait for the progress bar to disappear
    await progressBar.waitFor({ state: 'hidden', timeout: 120000 });

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(10000);
      const box = await slideLocators.boundingBox();
      if (box) {
        const screenshot = await slideLocators.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if (await nextButtonLocator.isDisabled()) {
        break;
      }

      await footerLocator.evaluate((el) =>
        el.setAttribute('style', 'opacity: 1; pointer-events: auto;'),
      );
      await nextButtonLocator.waitFor({ state: 'visible' });
      await nextButtonLocator.click();

      // it's a little tricky to confirm that the effects of clicking the button
      // have taken effect, so wait briefly to increase the chance of the render completing.
      await new Promise((resolve) => setTimeout(resolve, 500)); // eslint-disable-line @typescript-eslint/no-loop-func
    }

    return screenshots;
  }
}

class Figma {
  // figma URLs can contain a page id. It's not obvious how to get to the first page easily
  getFirstPageUrl(url: string) {
    // TODO: click the back button until it's disabled
    const parsedUrl = new URL(url);
    // show the "next" button so we can click it
    parsedUrl.searchParams.set('hide-ui', '0');
    return parsedUrl.toString();
  }

  /**
   * Get the PDF at the given figma URL
   */
  async getAsPdf(url: string): Promise<PdfStream | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a figma link.
      const figmaResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          const figmaCrawler = new FigmaCrawler({
            page,
            browser,
            url: this.getFirstPageUrl(url),
          });
          return figmaCrawler.getPdf();
        },
      );

      if (figmaResult.error) {
        throw figmaResult.error;
      }

      return figmaResult.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from figma link: ${url}.`);

      return null;
    }
  }
}

const FigmaService = new Figma();

export { FigmaService };
