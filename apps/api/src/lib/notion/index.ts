import { Client, iteratePaginatedAPI } from '@notionhq/client';

import { logger } from 'movement-engine/public/log';

const NOTION_PAGE_ID_REGEX = /\b[0-9a-f]{32}\b/;

async function getNotionPageContent({ pageId, secret }: { pageId: string; secret: string }) {
  const notion = new Client({ auth: secret });
  const blocks = [];

  try {
    for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
      block_id: pageId,
    })) {
      blocks.push(block);
    }
  } catch (error) {
    logger.error(error);
  }

  return blocks;
}

export { getNotionPageContent, NOTION_PAGE_ID_REGEX };
