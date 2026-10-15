import { ExternalUrl, PdfStream } from '.';

import { logger } from 'movement-engine/services/logger';
import { PlaywrightService } from '../../services/playwright';
import { MINUTE, SECOND } from '../../constants';
import { sendSlackNotification } from '../slack';
import { ImageService } from '../../services/images';
import { setJitteredTimeout } from '../utils/timeout';
import { Crawler, Screenshot, waitFor } from '../../services/crawler';
import { handleError } from '../errors';
import { retryUntilResolves } from '../utils/retry';
import { Prompt } from '../prompts';
import { pipeThroughTmpFile } from '../utils/tmp';

import { DOCSEND_REGEX } from '#shared/constants/document_sources';

const DOWNLOAD_TIMEOUT = 2 * MINUTE;
const READY_TIMEOUT = 15 * SECOND;

class InvalidCredentialsError extends Error {}

class DocsendCrawler extends Crawler {
  /** Exposed so the outer service can detect external URL redirects. */
  _externalUrl: string | null = null;

  protected sanitiseUrl(url: string): string {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.replace(/^docsend.dropbox.com$/, 'docsend.com');
    return parsed.toString();
  }

  protected async setup(): Promise<void> {
    await this.page.route('**/metrics/events', async (route) => {
      await route.abort();
    });
  }

  protected async authenticate(): Promise<Error | null> {
    const emailField = this.page.locator('#link_auth_form_email').nth(0);
    const passcodeField = this.page.locator('#link_auth_form_passcode').nth(0);
    const continueBtn = this.page.getByRole('button', { name: 'Continue' });

    const spacesEmail = this.page.locator('#email').nth(0);
    const spacesConfirm = this.page.getByRole('button', { name: 'Confirm' });

    // Wait for either the standard DocSend auth form or the Spaces auth form
    await Promise.race([
      waitFor(emailField, { state: 'visible', timeout: 8000 }),
      waitFor(spacesEmail, { state: 'visible', timeout: 8000 }),
    ]);

    if (await emailField.isVisible()) {
      if (!this.email) {
        return new InvalidCredentialsError(
          'This DocSend link needs an email to view — pass email: to vc_url_retrieval (e.g. email: @user_email)',
        );
      }

      await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
      await emailField.click();
      await emailField.fill(this.email);

      if (await passcodeField.isVisible()) {
        if (!this.passcode) {
          return new InvalidCredentialsError('no password provided for docsend link');
        }
        await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
        await passcodeField.fill(this.passcode);
      }

      await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
      await continueBtn.click();
      return null;
    }

    if (await spacesEmail.isVisible()) {
      if (!this.email) {
        return new InvalidCredentialsError(
          'This DocSend link needs an email to view — pass email: to vc_url_retrieval (e.g. email: @user_email)',
        );
      }

      await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
      await spacesEmail.click();
      await spacesEmail.fill(this.email);

      await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
      await spacesConfirm.click();
      // Wait for the space listing to render after auth
      await waitFor(this.page.locator('.dig-Table-row--selectable').first(), {
        state: 'visible',
        timeout: 10000,
      });
      return null;
    }

    return null;
  }

  /**
   * Override to try direct download first, and handle external URL redirects.
   */
  protected async createPdfFromScreenshots(): Promise<PdfStream | null> {
    await setJitteredTimeout({ baseMs: 2500, jitterMs: 200 });

    // If we got redirected away from Docsend, signal via _externalUrl
    if (!DOCSEND_REGEX.test(this.page.url())) {
      this._externalUrl = this.page.url();
      return null;
    }

    // Try direct download first
    const downloaded = await this.tryDirectDownload();
    if (downloaded) return downloaded;

    // Fall back to the base class logic (screenshots → AI fallback if empty)
    return super.createPdfFromScreenshots();
  }

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    await this.page.waitForLoadState('domcontentloaded');
    await setJitteredTimeout({ baseMs: 5000, jitterMs: 500 });

    await this.hideChrome();

    const nextButton = this.page.locator('#nextPageIcon').nth(0);
    const scrollable = this.page.locator('div.carousel.vertical').nth(0);
    const spaceRows = this.page.locator('.dig-Table-row--selectable');

    if (await nextButton.isVisible()) {
      return this.capturePaginated();
    }

    if (await scrollable.isVisible()) {
      return this.captureScrollable();
    }

    // Space listing may still be rendering after auth — wait up to 5s for rows
    await waitFor(spaceRows.first(), { state: 'visible', timeout: 5000 });
    if ((await spaceRows.count()) > 0) {
      return this.navigateSpaceThenCapture();
    }

    // None of the known layouts matched — return empty,
    // base class createPdfFromScreenshots will invoke AI fallback
    return [];
  }

  // ── Docsend-specific helpers ─────────────────────────────────────────────

  private async hideChrome(): Promise<void> {
    const consent = this.page.locator('#ccpa-iframe').nth(0);
    const drawer = this.page.locator('div.drawer_tab').nth(0);

    if (await consent.isVisible()) {
      await consent.evaluate((el) => el.setAttribute('style', 'display: none'));
    }
    if (await drawer.isVisible()) {
      await drawer.evaluate((el) => el.setAttribute('style', 'display: none'));
    }
  }

  private async capturePaginated(): Promise<Screenshot[]> {
    const slide = this.page.locator('div.item.active img.page-view').nth(0);
    const nextBtn = this.page.locator('#nextPageIcon').nth(0);
    const stats = this.page.locator('#stats-content').nth(0);
    const { maxPageNumber } = await this.getCurrentPageNumber();
    const screenshots: Screenshot[] = [];

    await setJitteredTimeout({ baseMs: 1000, jitterMs: 2000 });

    for (let i = 0; i < maxPageNumber; i++) {
      await this.page.waitForLoadState('domcontentloaded');
      if (await stats.isVisible()) break;

      const box = await slide.boundingBox();
      if (!box) {
        handleError('Could not determine bounding box of slide');
        break;
      }

      screenshots.push({
        width: box.width,
        height: box.height,
        data: await slide.screenshot(),
      });

      await nextBtn.click();
      await setJitteredTimeout({ baseMs: 1000, jitterMs: 500 });
    }

    return screenshots;
  }

  private async captureScrollable(): Promise<Screenshot[]> {
    const { maxPageNumber } = await this.getCurrentPageNumber();
    const screenshots: Screenshot[] = [];

    for (let i = 1; i <= maxPageNumber; i++) {
      await this.page.waitForLoadState('domcontentloaded');

      const img = this.page
        .locator(`img.preso-view.page-view[data-pagenum="${i}"]`)
        .nth(0);
      if (!(await img.isVisible())) break;
      await img.scrollIntoViewIfNeeded();
      await setJitteredTimeout({ baseMs: 200, jitterMs: 50 });
      if (!(await img.isVisible())) break;

      const src = await img.getAttribute('src');
      if (!src) throw new Error('Could not get image URL');

      const resp = await fetch(src);
      const buf = Buffer.from(await resp.arrayBuffer());
      const box = await img.boundingBox();
      if (!box) throw new Error('Could not determine bounding box of image');

      screenshots.push({ width: box.width, height: box.height, data: buf });
    }

    return screenshots;
  }

  private async navigateSpaceThenCapture(): Promise<Screenshot[]> {
    const links = await this.findSpaceLinks();
    const names = await Promise.all(links.map((el) => el.textContent())).then((ns) =>
      ns.map((n) => n?.trim()),
    );

    const { name } = await Prompt.getPitchDeckName({ message: names.join('\n') });
    if (!name) return []; // AI fallback will take over

    let matchingLink;
    for (let i = 0; i < links.length; i++) {
      if (names[i] === name) {
        matchingLink = links[i];
        break;
      }
    }
    if (!matchingLink) return [];

    await matchingLink.click();
    await setJitteredTimeout({ baseMs: 2000, jitterMs: 500 });

    return this.takeScreenshotsOfAllPages();
  }

  private async findSpaceLinks() {
    return this.page.locator('.dig-Table-row--selectable').all();
  }

  private async getCurrentPageNumber(): Promise<{ pageNumber: number; maxPageNumber: number }> {
    const indicator = this.page.locator('.toolbar-page-indicator').nth(0);
    const text = await indicator.textContent();
    if (!text) throw new Error('Could not get page number from docsend page.');
    const [pageNumber, maxPageNumber] = text.split('/').map((x) => parseInt(x.trim(), 10));
    return { pageNumber, maxPageNumber };
  }

  private async tryDirectDownload(): Promise<PdfStream | null> {
    const btn = this.page.locator('.js-document-download');

    const canDownload =
      (await btn.isVisible({ timeout: READY_TIMEOUT })) &&
      (await btn.isEnabled({ timeout: READY_TIMEOUT }));

    if (!canDownload) return null;

    await setJitteredTimeout({ baseMs: 1000, jitterMs: 2000 });

    const download = await retryUntilResolves({
      action: () => btn.click({ timeout: READY_TIMEOUT }),
      target: this.page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT }),
      interval: 500,
      timeout: READY_TIMEOUT,
    });

    const stream = await download.createReadStream();
    if (!stream) throw new Error('Could not download document');

    // Drain into a tmp file BEFORE returning so the resulting Readable is
    // self-contained. The Playwright Download stream is tied to the live
    // browser; once withPage's finally closes the browser, reads from a
    // raw createReadStream() silently stall (no `'end'`, no `'error'`),
    // hanging the consumer indefinitely.
    const { data } = await pipeThroughTmpFile(stream);

    return {
      type: 'PDF_STREAM',
      data,
      name: download.suggestedFilename(),
    };
  }
}

class Docsend {
  async getAsPdf(
    url: string,
    { email, password }: { email?: string; password?: string },
  ): Promise<PdfStream | ExternalUrl | null> {
    return PlaywrightService.withPage(async (page, browser) => {
      const crawler = new DocsendCrawler({
        page,
        browser,
        url,
        email,
        passcode: password,
      });

      let errorScreenshotUrl: string | null = null;
      try {
        const result = await crawler.getPdf();

        // Check for external redirect
        if (crawler._externalUrl) {
          await browser.close();
          return { type: 'EXTERNAL_URL' as const, url: crawler._externalUrl };
        }

        if (result.error) {
          throw result.error;
        }

        if (result.document?.type === 'PDF_STREAM') {
          // Close the browser once the stream has been read.
          result.document.data.once('close', () => browser.close().catch(() => {}));
        }

        return result.document;
      } catch (err) {
        try {
          const screenshot = await page.screenshot();
          const imageId = await ImageService.upload(new Blob([screenshot]));
          errorScreenshotUrl = ImageService.getDeliveryUrl(imageId);
        } catch {
          // screenshot may fail if browser is already closed
        }

        await browser.close().catch(() => {});

        if (err instanceof InvalidCredentialsError) {
          await sendSlackNotification({
            type: 'SUPPORT',
            text: `:arrow_right_hook: Docsend crawler was missing credentials (from url: ${url}, screenshot: ${errorScreenshotUrl})`,
            opsTitle: `DocSend crawler was missing credentials for ${url}`,
          });
          // Rethrow (rather than swallow to null) so the actionable message
          // reaches the per-URL failure log the plugin already produces —
          // this is an author config gap, not an unexpected system error.
          throw err;
        }

        await sendSlackNotification({
          type: 'DEALFLOW',
          text: `:arrow_right_hook: Docsend crawler failed to fetch anything (from url: ${url}, screenshot: ${errorScreenshotUrl})`,
          opsTitle: `DocSend crawler failed to fetch ${url}`,
        });

        handleError(err);
        return null;
      }
    });
  }
}

const DocsendService = new Docsend();

export { DocsendService };
