import { Prompt } from '../../prompts';
import { DocumentSourceService } from '../../document_sources';
import { RawTextService } from '../../../services/raw_text';
import {
  DealTextOutput,
  EmptyOutput,
  GreetingOutput,
  InjectionOutput,
  PitchDeckUrlOutput,
  Tool,
  WebsiteUrlOutput,
} from './types';
import { handleError } from '../../errors';
import { neverAsAny } from 'movement-engine/public/types';

const URL_REGEX = /^https?:\/\/\S+$/;

type ClassifyTextToolParams = {
  rawTextId: string;
};

const classifyTextTool: Tool<
  ClassifyTextToolParams,
  | DealTextOutput
  | PitchDeckUrlOutput
  | WebsiteUrlOutput
  | GreetingOutput
  | EmptyOutput
  | InjectionOutput
> = async ({ rawTextId }) => {
  const { content } = await RawTextService.getById(rawTextId);

  if (content.length === 0) {
    return { type: 'EMPTY' };
  }

  if (content.match(URL_REGEX)) {
    const response = await fetch(content, { redirect: 'follow' });
    return {
      type: DocumentSourceService.isSupportedUrl(response.url) ? 'PITCH_DECK_URL' : 'WEBSITE_URL',
      url: response.url,
    };
  }

  const { classification, reply } = await Prompt.classifyInput({
    message: content,
  });

  if (classification === 'INJECTION') {
    handleError(new Error('Prompt injection detected'));
    return { type: 'INJECTION', rawTextId };
  } else if (
    classification === 'CONVERSATION' ||
    classification === 'QUERY' ||
    classification === 'COMMAND'
  ) {
    return { type: 'GREETING', rawTextId, reply: reply ?? null };
  } else if (classification === 'CONTEXT') {
    return { type: 'DEAL_TEXT', rawTextId };
  } else {
    throw new Error(`Unknown classification: ${neverAsAny(classification)}`);
  }
};

classifyTextTool.type = 'CLASSIFY_TEXT';

export { classifyTextTool };
