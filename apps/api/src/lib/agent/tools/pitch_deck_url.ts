import { DocumentService } from '../../../services/document';
import { RawTextService } from '../../../services/raw_text';
import { DocumentSourceService } from '../../document_sources';
import { pipeThroughTmpFile } from '../../utils/tmp';
import { neverAsAny } from 'movement-engine/public/types';
import { DocumentOutput, EmptyOutput, TextOutput, Tool } from './types';

type PitchDeckParams = {
  url: string;
  // No implicit guessing — a caller with no email to offer passes none.
  // A source that hits an email gate with no email fails that fetch with an
  // actionable error rather than typing a placeholder.
  email?: string;
  password?: string;
  cache?: boolean;
};

const pitchDeckUrlTool: Tool<PitchDeckParams, DocumentOutput | TextOutput | EmptyOutput> = async ({
  url,
  email,
  password,
  cache = true,
}) => {
  if (cache) {
    // TODO: check if we have already processed this url
    // if so, clone the created document and return it
  }

  // follow redirects (bounded — tracking-redirect intermediaries can hang
  // the connection indefinitely without an AbortSignal)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  const resolvedUrl = response.url;

  const deckType = DocumentSourceService.outputFormat(resolvedUrl);

  if (deckType === 'DOCUMENT') {
    const result = await DocumentSourceService.getUrlAsPdfStream(response.url, { email, password });

    if (!result || !result.data) {
      throw new Error(`Failed to fetch deck from ${response.url}`);
    }

    // store in tmp file to get the pdf size
    // we primarily need to do this because playwright's Download API doesn't expose content length
    // https://github.com/microsoft/playwright/issues/23832
    const { data, size } = await pipeThroughTmpFile(result.data);

    // upload to s3
    const document = await DocumentService.createAndUpload(data, {
      description: result.name,
      contentLength: size,
      mimeType: result.name.endsWith('.pptx')
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'application/pdf',
    });

    return { type: 'DOCUMENT', documentId: document.id };
  } else if (deckType === 'TEXT') {
    const result = await DocumentSourceService.getUrlAsText(response.url, { email, password });
    if (!result) {
      return { type: 'EMPTY' };
    }

    const rawText = await RawTextService.getOrCreateFromContent(result);

    return { type: 'TEXT', rawTextId: rawText.id };
  } else {
    return neverAsAny(deckType);
  }
};

pitchDeckUrlTool.type = 'PITCH_DECK_URL';

export { pitchDeckUrlTool };
