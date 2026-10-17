import { ExternalUrl, PdfStream } from '.';

import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';
import { logger } from 'movement-engine/public/log';
import { PlaywrightService } from '../../services/playwright';

class PapermarkCrawler extends Crawler {
  protected async authenticate(): Promise<Error | null> {
    const slideLocators = this.page.locator('.viewer-container:not(.hidden)').nth(0);
    const emailFieldLocator = this.page.locator('input[name="email"]').nth(0);
    const passcodeFieldLocator = this.page.locator('input[name="password"]').nth(0);
    const submitButtonLocator = this.page.locator('button[type="submit"]').nth(0);

    await this.page.waitForTimeout(3000);

    if (this.email && (await emailFieldLocator.isVisible())) {
      await emailFieldLocator.fill(this.email);
    }

    if (this.passcode?.length && (await passcodeFieldLocator.isVisible())) {
      await passcodeFieldLocator.fill(this.passcode);
    }

    if (await submitButtonLocator.isVisible()) {
      await this.page.waitForTimeout(500);
      await submitButtonLocator.click();
    }

    await this.page.waitForTimeout(3000);

    if (await slideLocators.isVisible()) {
      return null;
    } else {
      throw new Error('Failed to authenticate');
    }
  }

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    const slideLocators = this.page.locator('.viewer-container:not(.hidden)').nth(0);
    const nextButtonLocator = this.page.locator('button:has(> svg.lucide-chevron-right)').nth(0);
    const floatingShareLocator = this.page.locator('div.absolute.bottom-0').nth(0);
    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(700);

    await floatingShareLocator.evaluate((el) =>
      el.setAttribute('style', 'opacity: 0; pointer-events: none;'),
    );

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);
      if ((await slideLocators.count()) === 0) {
        break;
      }

      const box = await slideLocators.boundingBox();
      if (box) {
        const screenshot = await slideLocators.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if (!(await nextButtonLocator.isVisible())) {
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

class Papermark {
  /**
   * Get the PDF at the given Papermark URL
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<PdfStream | ExternalUrl | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a papermark link.
      const papermarkResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        async (page, browser) => {
          const papermarkCrawler = new PapermarkCrawler({
            page,
            browser,
            url,
            email,
            passcode,
          });
          return papermarkCrawler.getPdf();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      if (papermarkResult.error) {
        throw papermarkResult.error;
      }

      return papermarkResult.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from papermark link: ${url}.`);

      return null;
    }
  }
}

const PapermarkService = new Papermark();

export { PapermarkService };
