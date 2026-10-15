import { PdfStream } from '.';

import { Page } from 'playwright';

import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';
import { logger } from 'movement-engine/services/logger';
import { PlaywrightService } from '../../services/playwright';

class TomeCrawler extends Crawler {
  protected async authenticate(): Promise<Error | null> {
    const slideLocators = this.page.locator('#OverflowContainer').nth(0);

    // NOTE these are guesses, we haven't seen a email and/or password locked tome link yet
    const emailFieldLocator = this.page.locator('input[name="email"]').nth(0);
    const passcodeFieldLocator = this.page.locator('input[name="passcode"]').nth(0);
    const submitButtonLocator = this.page.locator('button[type="submit"]').nth(0);

    await this.page.waitForTimeout(3000);

    if (await emailFieldLocator.isVisible()) {
      try {
        if (!this.email) {
          throw new Error('no email provided for tome link');
        }
        await emailFieldLocator.fill(this.email);
        logger.info('tome: filling email.');
        if (await passcodeFieldLocator.isVisible()) {
          if (!this.passcode) {
            throw new Error('no password provided for tome link');
          }
          logger.info('tome: filling password.');
          await passcodeFieldLocator.fill(this.passcode);
        }
        await submitButtonLocator.click();
      } catch (err) {
        logger.info('Error with entering tome credentials: ' + err);
        throw new Error('Failed to authenticate');
      }
    }

    await this.page.waitForTimeout(500);

    if (await slideLocators.isVisible()) {
      return null;
    } else {
      throw new Error("Can't locate slides");
    }
  }

  protected async adjustViewportSizeForBoxHeight(
    page: Page,
    box: {
      x: number;
      y: number;
      width: number;
      height: number;
    },
  ) {
    await page.setViewportSize({
      width: 1100,
      height: Math.max(Math.ceil(box.height) + 100, 900),
    });
  }

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    const numberOfSlides = await this.page.getByTestId('progress_segment').count();
    const nextButtonLocator = this.page.getByLabel('Next page').nth(0);
    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(1000);

    let slideNumber = 0;
    let slidesScreenshotted = 0;

    while (true /* eslint-disable-line no-constant-condition */) {
      slideNumber += 1;
      if (slideNumber > numberOfSlides) {
        break;
      }

      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);

      // await this.setViewportToSizeOfCurrentSlide(this.page, slideNumber);
      const slideLocator = this.page.locator('#OverflowContainer').nth(slideNumber - 1);
      const box = await slideLocator.boundingBox();

      if (box) {
        await this.adjustViewportSizeForBoxHeight(this.page, box);
        slidesScreenshotted += 1;
        const screenshot = await slideLocator.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      const nextButtonIsVisible = await nextButtonLocator.isVisible();
      if (!nextButtonIsVisible) {
        break;
      }

      await nextButtonLocator.click();

      // it's a little tricky to confirm that the effects of clicking the button
      // have taken effect, so wait briefly to increase the chance of the render completing.
      await new Promise((resolve) => setTimeout(resolve, 1000)); // eslint-disable-line @typescript-eslint/no-loop-func
    }
    logger.info(`Took screenshots of ${slidesScreenshotted} pages`);

    return screenshots;
  }
}

class Tome {
  /**
   * Get the PDF at the given Tome URL
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<PdfStream | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a tome link.
      const tomeResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          const tomeCrawler = new TomeCrawler({
            page,
            browser,
            url,
            email,
            passcode,
          });
          return tomeCrawler.getPdf();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      if (tomeResult.error) {
        throw tomeResult.error;
      }

      return tomeResult.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from tome link: ${url}.`);

      return null;
    }
  }
}

const TomeService = new Tome();

export { TomeService };
