import { PdfStream } from '.';

import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';
import { logger } from 'movement-engine/public/log';
import { PlaywrightService } from '../../services/playwright';

class InvalidCredentialsError extends Error {}

class BrieflinkCrawler extends Crawler {
  protected async authenticate(): Promise<Error | null> {
    const slideLocators = this.page.locator('.DeckGalleryPageContainer').nth(0);
    const emailFieldLocator = this.page.locator('input[name="email"]').nth(0);
    const passcodeFieldLocator = this.page.locator('input[name="passcode"]').nth(0);
    const submitButtonLocator = this.page.locator('button[type="submit"]').nth(0);

    await this.page.waitForTimeout(3000);

    if (await emailFieldLocator.isVisible()) {
      if (!this.email) {
        return new InvalidCredentialsError(
          'This BriefLink needs an email to view — pass email: to vc_url_retrieval (e.g. email: @user_email)',
        );
      }
      await emailFieldLocator.fill(this.email);
      if (this.passcode?.length && (await passcodeFieldLocator.isVisible())) {
        await passcodeFieldLocator.fill(this.passcode);
      }
      await submitButtonLocator.click();
    }

    await this.page.waitForTimeout(500);

    if (await slideLocators.isVisible()) {
      return null;
    } else {
      throw new Error('Failed to authenticate');
    }
  }

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    const slideLocators = this.page.locator('.DeckGalleryPageContainer').nth(0);
    const nextButtonLocator = this.page.locator('button.Button.Right').nth(0);
    const screenshots: Screenshot[] = [];

    await this.page.waitForTimeout(700);

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(200);
      const box = await slideLocators.boundingBox();
      if (box) {
        const screenshot = await slideLocators.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if (await nextButtonLocator.isDisabled()) {
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

class Brieflink {
  /**
   * Get the PDF at the given BriefLink URL
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<PdfStream | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a brieflink link.
      const brieflinkResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          const brieflinkCrawler = new BrieflinkCrawler({
            page,
            browser,
            url,
            email,
            passcode,
          });
          return brieflinkCrawler.getPdf();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      if (brieflinkResult.error) {
        throw brieflinkResult.error;
      }

      return brieflinkResult.document;
    } catch (err) {
      // Rethrow (rather than swallow to null) so the actionable message
      // reaches the per-URL failure log the plugin already produces — this
      // is an author config gap, not an unexpected system error.
      if (err instanceof InvalidCredentialsError) throw err;

      console.error(err);
      logger.info(`Failed to fetch PDF from brieflink link: ${url}.`);

      return null;
    }
  }
}

const BrieflinkService = new Brieflink();

export { BrieflinkService };
