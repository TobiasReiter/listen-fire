import { PdfStream } from '.';

import { logger } from 'movement-engine/services/logger';
import { PlaywrightService } from '../../services/playwright';
import { SECOND } from '../../constants';
import { Crawler, FetchedDocument, Screenshot } from '../../services/crawler';

enum PitchDotComAccessError {
  UNKNOWN = 'unknown',
  INVALID_CREDENTIALS = 'invalid_credentials',
}

const READY_TIMEOUT = 5 * SECOND;

/**
 * Helper class to manage the lifecycle of fetching a PDF from a
 * pitch.com link in a playwright browser.
 */
class PitchDotComCrawler extends Crawler {
  protected async setup() {
    // Silence unnecessary metrics requests.
    await this.page.route('**/metrics', async (route) => {
      await route.abort();
    });
  }

  protected async authenticate() {
    await this.page.waitForLoadState('networkidle');

    const emailField = this.page.locator('#visitor-email');
    const rememberParamsCheckbox = this.page.locator(
      'input[data-test-id=player-access-layer-form-checkbox]',
    );
    const passcodeField = this.page.locator('#access-code');

    let needsSubmit = false;

    if ((await emailField.count()) > 0) {
      if (!this.email) {
        return new Error(PitchDotComAccessError.INVALID_CREDENTIALS);
      }

      needsSubmit = true;
      await emailField.fill(this.email);

      // Uncheck "Remember for next visit" checkbox
      if ((await rememberParamsCheckbox.count()) > 0) {
        await rememberParamsCheckbox.uncheck();
      }
    }

    if ((await passcodeField.count()) > 0) {
      if (!this.passcode) {
        return new Error(PitchDotComAccessError.INVALID_CREDENTIALS);
      }

      needsSubmit = true;
      await passcodeField.fill(this.passcode);
    }

    if (needsSubmit) {
      // Submit form.
      await this.page.locator('button[type="submit"]').click();
      // TODO: Detect errors.
    }

    // wait for the loaded page to exist
    try {
      await this.page
        .locator('.platform--player-page-container')
        .isVisible({ timeout: READY_TIMEOUT });
    } catch (e) {
      // if we have a passcode but we don't load the main page
      // then we probably have an invalid passcode
      if (this.passcode) {
        return new Error(PitchDotComAccessError.INVALID_CREDENTIALS);
      }

      throw e;
    }

    return null;
  }

  protected async takeScreenshotsOfAllPages() {
    const modalContainerLocator = this.page.locator('div.platform--modal__container');
    const slideLocators = this.page.locator('div.slide-wrapper').nth(0);
    const nextButtonLocator = this.page.locator('button[aria-label="Next"]').nth(0);

    const screenshots: Screenshot[] = [];

    await this.page.waitForLoadState('networkidle');

    // if there's a tracking consent modal, hide it
    if (await modalContainerLocator.count()) {
      await modalContainerLocator.evaluateAll((modals) => {
        modals.forEach((modal) => {
          modal.style.zIndex = '-1';
        });
      });
    }

    while (true /* eslint-disable-line no-constant-condition */) {
      await this.page.waitForLoadState('domcontentloaded');
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

class PitchDotCom {
  // pitch.com URLs can contain a page UUID after the presentation UUID
  // so we need to strip that off to ensure we're crawling the whole presentation
  getFirstPageUrl(url: string) {
    const parsedUrl = new URL(url);
    parsedUrl.pathname = parsedUrl.pathname.replace(/^(\/(?:v|public)\/[\w-]+).*$/, '$1');
    return parsedUrl.toString();
  }

  /**
   * Get the PDF at the given pitch.com URL, or a `PitchDotComAccessError`
   * describing why the PDF is inaccessible.
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string } = {},
  ): Promise<PdfStream | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a pitch.com link.
      const pitchDotComResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          const pitchDotComCrawler = new PitchDotComCrawler({
            page,
            browser,
            url: this.getFirstPageUrl(url),
            email,
            passcode,
          });
          return pitchDotComCrawler.getPdf();
        },
      );

      if (pitchDotComResult.error) {
        throw pitchDotComResult.error;
      }

      return pitchDotComResult.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from pitch.com link: ${url}.`);

      return null;
    }
  }
}

const PitchDotComService = new PitchDotCom();

export { PitchDotComService };
