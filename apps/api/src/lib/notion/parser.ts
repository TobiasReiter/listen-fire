import { getNotionPageContent } from '.';

import {
  BlockObjectResponse,
  PartialBlockObjectResponse,
  RichTextItemResponse,
} from '@notionhq/client/build/src/api-endpoints';

import { NotionTokenService } from '../../services/notion_token';
import { currentContext } from '../../services/context';
import { DocumentService } from '../../services/document';
import { logger } from 'movement-engine/public/log';
import { signDocumentUrl } from '../document_link';

const DATE_REGEX = /\d{4}-\d{2}/;

const getPlainTextFromRichText = async (richText: RichTextItemResponse[]) => {
  const values = [];
  for (const element of richText) {
    if (element.href && element.type === 'text') {
      let url = element.href;
      if (url.startsWith('http')) {
        try {
          const response = await fetch(element.href, { redirect: 'follow' });
          url = response.url;
        } catch (error) {
          logger.error(`Error following link: ${error}.`);
        }
      }
      values.push(` [${element.plain_text.trim()}](${url})`);
    } else {
      values.push(element.plain_text);
    }
  }

  return values.join('');
};

async function getTextFromBlock(
  block: BlockObjectResponse,
  previousBlock?: BlockObjectResponse,
  listLevel: number = 0,
): Promise<string> {
  let text;
  switch (block.type) {
    case 'unsupported':
      // The public API does not support all block types yet
      text = '[Unsupported block type]';
      break;
    case 'paragraph': {
      const content = block.paragraph.rich_text
        ? await getPlainTextFromRichText(block.paragraph.rich_text)
        : '<br>';
      text = DATE_REGEX.test(content) ? `#### ${content}` : content;
      break;
    }
    case 'bulleted_list_item': {
      const elements = [];
      elements.push(
        `${Array(listLevel).fill('\t').join('')}* ${await getPlainTextFromRichText(block.bulleted_list_item.rich_text)}`,
      );

      if (block.has_children) {
        const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
        const childrenBlocks = await getNotionPageContent({
          pageId: block.id,
          secret: token?.token ?? '',
        });
        for (const b of childrenBlocks) {
          const level = listLevel + 1;
          const content = await getTextFromBlock(b as BlockObjectResponse, previousBlock, level);
          elements.push(content);
          previousBlock = b as BlockObjectResponse;
        }
      }
      text = elements.join('\n');
      break;
    }
    case 'numbered_list_item': {
      const elements = [];
      elements.push(
        `${Array(listLevel).fill('\t').join('')}* ${await getPlainTextFromRichText(block.numbered_list_item.rich_text)}`,
      );
      if (block.has_children) {
        const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
        const childrenBlocks = await getNotionPageContent({
          pageId: block.id,
          secret: token?.token ?? '',
        });
        for (const b of childrenBlocks) {
          const level = listLevel + 1;
          const content = await getTextFromBlock(b as BlockObjectResponse, previousBlock, level);
          elements.push(content);
          previousBlock = b as BlockObjectResponse;
        }
      }
      text = elements.join('\n');
      break;
    }
    case 'quote':
      text = block.quote.rich_text
        ? ` > ${await getPlainTextFromRichText(block.quote.rich_text)}`
        : '<br>';
      break;
    case 'callout':
      text = block.callout.rich_text
        ? ` > ${await getPlainTextFromRichText(block.callout.rich_text)}`
        : '<br>';
      break;
    case 'image': {
      if (block.image.type === 'file') {
        const doc = await DocumentService.uploadImageFromUrl(block.image.file.url);
        const url = signDocumentUrl(doc.id);
        text = `![${block.image.caption}](${url})`;
      }
      break;
    }
    case 'table': {
      const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
      const childrenBlocks = await getNotionPageContent({
        pageId: block.id,
        secret: token?.token ?? '',
      });
      text = await notionToMarkdown(childrenBlocks);
      break;
    }
    case 'table_row': {
      const cells = ['| '];
      for (const cell of block.table_row.cells) {
        const v = await getPlainTextFromRichText(cell);
        cells.push(` ${v.split('\n').join(' ')} |`);
      }
      // We know this is the header because the previous block is null.
      if (!previousBlock) {
        cells.push(`\n| ${Array(cells.length).fill('---').join(' | ')} |`);
      }
      text = cells.join('');
      break;
    }
    case 'heading_1':
      text = `# ${await getPlainTextFromRichText(block.heading_1.rich_text)}`;
      break;
    case 'heading_2':
      text = `## ${await getPlainTextFromRichText(block.heading_2.rich_text)}`;
      break;
    case 'heading_3':
      text = `### ${await getPlainTextFromRichText(block.heading_3.rich_text)}`;
      break;
    case 'toggle': {
      const elements = [];
      elements.push(`### ${await getPlainTextFromRichText(block.toggle.rich_text)}`);
      if (block.has_children) {
        const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
        const childrenBlocks = await getNotionPageContent({
          pageId: block.id,
          secret: token?.token ?? '',
        });
        elements.push(await notionToMarkdown(childrenBlocks));
      }
      text = elements.join('\n');
      break;
    }
    case 'child_page': {
      const elements = [];
      elements.push(`# ${block.child_page.title}`);
      const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
      const childrenBlocks = await getNotionPageContent({
        pageId: block.id,
        secret: token?.token ?? '',
      });
      elements.push(await notionToMarkdown(childrenBlocks));

      text = elements.join('\n');
      break;
    }
    case 'file': {
      const getUrl = () => {
        if (block.file.type === 'external') {
          return block.file.external.url;
        } else if (block.file.type === 'file') {
          return block.file.file.url;
        }
        return null;
      };
      const name = () => {
        if (block.file.type === 'file') return block.file.name;
        return 'External file';
      };
      const fileURL = getUrl();
      if (fileURL) {
        const doc = await DocumentService.uploadImageFromUrl(fileURL);
        const url = signDocumentUrl(doc.id);
        text = `[${name()}](${url})`;
      }
      break;
    }
    case 'column_list': {
      const elements = [];
      const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
      const childrenBlocks = await getNotionPageContent({
        pageId: block.id,
        secret: token?.token ?? '',
      });
      elements.push(await notionToMarkdown(childrenBlocks));

      text = elements.join('\n');
      break;
    }
    case 'column': {
      const elements = [];
      const token = await NotionTokenService.getByTeamId(currentContext().user.teamId);
      const childrenBlocks = await getNotionPageContent({
        pageId: block.id,
        secret: token?.token ?? '',
      });
      elements.push(await notionToMarkdown(childrenBlocks));
      text = elements.join('\n');
      break;
    }
    case 'bookmark': {
      const caption = await getPlainTextFromRichText(block.bookmark.caption);
      text = text = `> [${caption ? caption : block.bookmark.url}](${block.bookmark.url})`;
      break;
    }
    case 'divider':
      text = '\n---\n';
      break;
    default:
      logger.info(`Unsupported block type: ${block.type}`);
      text = '[Missing data]';
      break;
  }
  return text ?? '';
}

async function notionToMarkdown(blocks: PartialBlockObjectResponse[]): Promise<string> {
  let previousBlock: BlockObjectResponse | undefined = undefined;
  const promises = blocks.map((block) => {
    const text = getTextFromBlock(block as BlockObjectResponse, previousBlock);
    previousBlock = block as BlockObjectResponse;
    return text;
  });
  const values = await Promise.all(promises);
  return values.join('\n');
}

export { notionToMarkdown };
