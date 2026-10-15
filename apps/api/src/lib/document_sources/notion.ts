import { htmlToText } from 'html-to-text';

import { Crawler, Screenshot } from '../../services/crawler';
import { logger } from 'movement-engine/services/logger';
import { PlaywrightService } from '../../services/playwright';

class NotionCrawler extends Crawler {
  protected getPageContent = async () => {
    await this.page.setViewportSize({ width: 1920, height: 1080 });
    await this.page.waitForLoadState('networkidle', { timeout: 15000 });

    await this.page.waitForSelector('.notion-page-content', { timeout: 10000 });

    // use page.evaluate to execute JavaScript on the page
    const pageContent = await this.page.locator('.notion-page-content').innerHTML();

    const titleParents = await this.page.locator('.notion-selectable.notion-page-block');
    const titleParent = await titleParents.first();
    const title = await titleParent.locator('div').first().textContent();

    // covert downloaded html to text
    const text = htmlToText(pageContent, {
      wordwrap: 80,
      formatters: {},
      selectors: [{ selector: 'img', format: 'skip' }],
    });

    return `# ${title}\n\n${text}`;
  };

  getContent = async () => {
    try {
      await this.setup();

      await this.page.goto(this.url);

      const result = await (async () => {
        const authenticationError = await this.authenticate();
        if (authenticationError) {
          throw authenticationError;
        }

        return await this.getPageContent();
      })();

      await this.cleanup();

      return result;
    } catch (err) {
      await this.errorAlert();
      await this.cleanup();
      throw err;
    }
  };

  protected async takeScreenshotsOfAllPages(): Promise<Screenshot[]> {
    return [];
  }
}

class Notion {
  /**
   * Get the PDF at the given Notion URL
   */
  async getAsText(
    url: string,
    { email, passcode }: { email?: string; passcode?: string },
  ): Promise<string | null> {
    try {
      // TODO: We should sanity check the URL to make sure we're
      // actually looking at a notion link.
      const notionResult = await PlaywrightService.withPage(
        async (page, browser) => {
          const notionCrawler = new NotionCrawler({
            page,
            browser,
            url,
            email,
            passcode,
          });
          return notionCrawler.getContent();
        },
        {
          viewport: {
            width: 1100,
            height: 900,
          },
        },
      );

      return notionResult;
    } catch (err) {
      console.error(err);
      logger.info(`Failed to fetch PDF from notion link: ${url}.`);

      return null;
    }
  }
}

const NotionService = new Notion();

export { NotionService };
