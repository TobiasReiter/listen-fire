// URL fetching for the vc-url-retrieval transform.
//
// Two fetch shapes the transform can't get from the generic scraper: a
// pitch-deck-style URL (DocSend, Drive, a data room — possibly email-gated,
// possibly a document that needs text extraction) and a LinkedIn profile.
//
// The transform used to borrow these from the dealflow pipeline's segment
// helpers, which returned dealflow `Segment`s and routed the tool call
// through the dealflow job queue. On the movement path there was never a
// dealflow job — the queue wrapper called the tool directly — so this is
// that path, owned by the runtime that actually uses it and free of
// dealflow types.

import type { ResourceId } from '../../../../generated/kysely/knowledge/Resource';

import { services } from '../../../../adapters/registry';
import { SECOND } from '../../../../constants';
import { extractDocumentTextTool } from '../../../../lib/agent/tools/extract_document_text';
import { pitchDeckUrlTool } from '../../../../lib/agent/tools/pitch_deck_url';
import { handleError } from '../../../../lib/errors';
import { logger } from '../../../logger';
import { RawTextService } from '../../../raw_text';
import { ResourceService } from '../../../resource';

type FetchedSegment = {
  resourceId: ResourceId;
  rawTextId: string | null;
  documentId: string | null;
};

// LinkedIn shows a login wall to anything arriving without a session, so a
// scrape of any LinkedIn address comes back as a hundred characters of "join
// to view" — after tens of seconds of rendering, and indistinguishable
// downstream from a page that was genuinely thin. The profile service is the
// one mechanism that reads LinkedIn, and it reads people: a profile address
// goes to it, and every other LinkedIn address is known here to be
// unreadable, without spending a request to find out.
const LINKEDIN_HOST_REGEX = /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com(?:[/?#]|$)/i;
const LINKEDIN_PROFILE_REGEX =
  /^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/(?:pub|in|profile)\/([\w-]+)/i;

function isLinkedInUrl(url: string): boolean {
  return LINKEDIN_HOST_REGEX.test(url);
}

async function fetchPitchDeckUrl({
  url,
  email,
  password,
}: {
  url: string;
  email?: string | null;
  password?: string | null;
}): Promise<FetchedSegment | null> {
  const resource = await ResourceService.getOrCreate({
    type: 'URL',
    name: url,
    url,
    isPrivate: true,
    metadata: { email, password },
  });

  const output = await pitchDeckUrlTool({
    url,
    email: email ?? undefined,
    password: password ?? undefined,
  });

  if (Array.isArray(output)) {
    // A Listen-Fire-internal link — the deck lives in our own storage and the
    // fetch path doesn't handle it.
    handleError(new Error('Tried to ingest a Listen-Fire link - not supported yet'));
    return null;
  }

  if (!output || output.type === 'EMPTY') return null;

  if (output.type === 'DOCUMENT') {
    await ResourceService.update(resource.id, { documentId: output.documentId });
    return extractDocumentText(output.documentId, resource.id as ResourceId);
  }

  await ResourceService.update(resource.id, { rawTextId: output.rawTextId });
  return {
    resourceId: resource.id as ResourceId,
    rawTextId: output.rawTextId,
    documentId: resource.documentId ?? null,
  };
}

// The downloaded document is the fetch's result even when none of its text can
// be read: a deck that is all images, on a deployment with no OCR, is still the
// deck, and whoever receives it can store it or read it later. Unreadable text
// costs the text, never the file.
async function extractDocumentText(
  documentId: string,
  resourceId: ResourceId,
): Promise<FetchedSegment> {
  let rawTextId: string | null = null;
  try {
    const extracted = await extractDocumentTextTool({ documentId });
    if (extracted?.type === 'DOCUMENT_WITH_CONTENT') rawTextId = extracted.rawTextId;
    else {
      logger.warn('[transform:url-fetch] no readable text; unsupported document type', {
        documentId,
      });
    }
  } catch (error) {
    logger.warn('[transform:url-fetch] no readable text; keeping the document without it', {
      documentId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  await ResourceService.update(resourceId, { rawTextId });
  return { resourceId, rawTextId, documentId };
}

// Fetching a link a record happens to carry is a side errand, and it runs once
// per record across a fan-out. The profile service collects asynchronously and
// is polled every five seconds, so a wait of minutes per record is a wait
// nobody asked for: give it three polls, take the profile if collection
// finished that fast, and otherwise move on with nothing. (The deliberate
// person lookup, which exists to wait, does not pass a budget.)
const PROFILE_FETCH_BUDGET_MS = 15 * SECOND;

async function fetchLinkedInProfile(linkedInUrl: string): Promise<FetchedSegment | null> {
  if (!LINKEDIN_PROFILE_REGEX.test(linkedInUrl)) {
    logger.info(
      `Not a LinkedIn profile — nothing can read it, and a scrape would only return the login wall: ${linkedInUrl}`,
    );
    return null;
  }

  let profile;
  try {
    profile = await services.linkedin?.getProfileTextByUrl(linkedInUrl, {
      maxWaitMs: PROFILE_FETCH_BUDGET_MS,
    });
  } catch (e) {
    logger.error(`Failed to get linkedin content for ${linkedInUrl}: ${e}`);
    return null;
  }

  if (!profile?.text) return null;

  const rawText = await RawTextService.getOrCreateFromContent(profile.text);
  const resource = await ResourceService.getOrCreate({
    type: 'URL',
    name: linkedInUrl,
    url: linkedInUrl,
    rawTextId: rawText.id,
    retrievedAt: new Date(),
    isDemo: false,
    isPrivate: false,
  });

  return {
    resourceId: resource.id as ResourceId,
    rawTextId: rawText.id,
    documentId: resource.documentId ?? null,
  };
}

export { fetchPitchDeckUrl, fetchLinkedInProfile, isLinkedInUrl };
export type { FetchedSegment };
