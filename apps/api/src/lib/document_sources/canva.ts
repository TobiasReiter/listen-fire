import { PdfStream } from '.';

import { Crawler, FetchedDocument, Screenshot, waitFor } from '../../services/crawler';
import { logger } from 'movement-engine/public/log';
import { PlaywrightService } from '../../services/playwright';

/*
 * The share link people paste is usually the one from their address bar, which
 * is the editor route. The viewer route serves the same design to anyone
 * holding the same share token, and is the only route we can crawl — the
 * editor is a canvas app behind a bot challenge.
 */
const CANVA_EDIT_URL_REGEX = /^(https:\/\/www\.canva\.com\/design\/[^/?#\s]+\/[^/?#\s]+)\/edit(\S*)$/;

function normalizeCanvaUrl(url: string): string {
  return url.replace(CANVA_EDIT_URL_REGEX, '$1/view$2');
}

/*
 * The viewer keeps exactly one page container mounted at a time. Its
 * `data-page-id` is the 0-based index of the page on screen, and its box is
 * the deck page itself — no header, filmstrip, cookie banner or grey margin.
 * That attribute is both the capture target and the navigation cursor: pages
 * are turned with ArrowRight (the old "Next page" button no longer exists) and
 * the deck ends where the id stops changing.
 */
const PAGE_SELECTOR = '[data-page-id]';
const PAGE_ID_ATTRIBUTE = 'data-page-id';
const DECK_LOAD_TIMEOUT = 60_000;
const COOKIE_BANNER_TIMEOUT = 5_000;
const PAGE_TURN_TIMEOUT = 5_000;
const RENDER_SETTLE_MS = 800;
// Safety net only: the browser session is capped at 5 minutes wall clock, and
// a deck this deep would not finish anyway.
const MAX_PAGES = 150;

class CanvaCrawler extends Crawler {
  private async dismissCookieBanner(): Promise<void> {
    const rejectButton = this.page.getByRole('button', { name: 'Reject all cookies' }).first();
    await waitFor(rejectButton, { state: 'visible', timeout: COOKIE_BANNER_TIMEOUT });

    if (await rejectButton.isVisible()) {
      await rejectButton.click();
    }
  }

  /**
   * Turn to the next page, returning false once the deck refuses to advance
   * (i.e. we were already on the last page).
   */
  private async goToNextPage(currentPageId: string): Promise<boolean> {
    await this.page.keyboard.press('ArrowRight');

    try {
      await this.page.waitForFunction(
        ({ selector, attribute, previousId }) => {
          const element = document.querySelector(selector);
          return !!element && element.getAttribute(attribute) !== previousId;
        },
        { selector: PAGE_SELECTOR, attribute: PAGE_ID_ATTRIBUTE, previousId: currentPageId },
        { timeout: PAGE_TURN_TIMEOUT },
      );
    } catch (_err) {
      return false;
    }

    return true;
  }

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    const pageLocator = this.page.locator(PAGE_SELECTOR).first();
    await pageLocator.waitFor({ state: 'visible', timeout: DECK_LOAD_TIMEOUT });
    await this.dismissCookieBanner();

    const screenshots: Screenshot[] = [];

    for (let turns = 0; turns < MAX_PAGES; turns++) {
      // Page content streams in after the container mounts, so let the render
      // settle before capturing.
      await this.page.waitForTimeout(RENDER_SETTLE_MS);

      const pageId = await pageLocator.getAttribute(PAGE_ID_ATTRIBUTE);
      if (!pageId) {
        break;
      }

      const box = await pageLocator.boundingBox();
      if (box) {
        const screenshot = await pageLocator.screenshot();
        screenshots.push({ width: box.width, height: box.height, data: screenshot });
      }

      if (!(await this.goToNextPage(pageId))) {
        break;
      }
    }

    logger.info(`Took screenshots of ${screenshots.length} Canva pages`);

    return screenshots;
  }
}

class Canva {
  getFirstPageUrl(url: string) {
    const parsedUrl = new URL(url);
    parsedUrl.hash = '#1';
    return parsedUrl.toString();
  }
  /**
   * Get the PDF at the given Canva URL
   */
  async getAsPdf(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<PdfStream | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a Canva link.
      const canvaResult: FetchedDocument<PdfStream> = await PlaywrightService.withPage(
        (page, browser) => {
          const canvaCrawler = new CanvaCrawler({
            page,
            browser,
            url: this.getFirstPageUrl(url),
            email,
            passcode,
          });
          return canvaCrawler.getPdf();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      if (canvaResult.error) {
        throw canvaResult.error;
      }

      return canvaResult.document;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from Canva link: ${url}.`);

      return null;
    }
  }
}

const CanvaService = new Canva();

export { CanvaService, normalizeCanvaUrl };
