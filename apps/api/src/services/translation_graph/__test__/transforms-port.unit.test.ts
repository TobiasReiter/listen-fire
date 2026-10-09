// Transform port — the bundled plugins: vc-url-retrieval, fetch-url,
// linkedin-enrichment and linkedin-research.
//
// Covers:
//   1. Registration: both transforms resolve via `getTransform`.
//   2. Signatures: declared shape matches the contracts in the brief
//      (`dataDependency`, `additions`).
//   3. Behavioural parity vs the legacy plugins on representative
//      fixtures — captured as golden-file diffs against expected
//      additions for known inputs.
//
// Brief: plans/2026-05-19-tg-extraction-parity/_execution/wave-1/R7-transforms-port.md

// ── External dependency mocks ─────────────────────────────────────────────
// (declared before module imports so jest hoists them correctly)

const mockAnthropicChat = jest.fn();
const mockFindLinkedIn = jest.fn();
const mockSearch = jest.fn();
const mockPitchDeckUrlTool = jest.fn();
const mockExtractDocumentTextTool = jest.fn();
const mockIsSupportedUrl = jest.fn();
const mockGetWebsite = jest.fn();
const mockGetById = jest.fn();
const mockGetOrCreateFromContent = jest.fn();
const mockResourceGetOrCreate = jest.fn();
const mockResourceUpdate = jest.fn();

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (...args: unknown[]) => mockAnthropicChat(...args),
}));
jest.mock('../../../lib/prompts/execute', () => ({
  parseJson: (raw: string) => JSON.parse(raw),
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('../../web_search', () => ({
  WebSearchService: {
    findLinkedIn: (...args: unknown[]) => mockFindLinkedIn(...args),
    search: (...args: unknown[]) => mockSearch(...args),
  },
  resolveWebSearchProvider: () => 'google',
}));
// vc-url-retrieval no longer borrows the dealflow pipeline's segment
// helpers (chore(carve) teardown step 4 — url-fetch.ts owns this surface
// directly). Mock the tools it now calls instead.
jest.mock('../../../lib/agent/tools/pitch_deck_url', () => ({
  pitchDeckUrlTool: (...args: unknown[]) => mockPitchDeckUrlTool(...args),
}));
jest.mock('../../../lib/agent/tools/extract_document_text', () => ({
  extractDocumentTextTool: (...args: unknown[]) => mockExtractDocumentTextTool(...args),
}));
jest.mock('../../../lib/document_sources', () => ({
  DocumentSourceService: {
    isSupportedUrl: (...args: unknown[]) => mockIsSupportedUrl(...args),
  },
}));
jest.mock('../../scraper', () => ({
  ScraperService: {
    getWebsite: (...args: unknown[]) => mockGetWebsite(...args),
  },
}));
jest.mock('../../raw_text', () => ({
  RawTextService: {
    getById: (...args: unknown[]) => mockGetById(...args),
    getOrCreateFromContent: (...args: unknown[]) => mockGetOrCreateFromContent(...args),
  },
}));
jest.mock('../../resource', () => ({
  ResourceService: {
    getOrCreate: (...args: unknown[]) => mockResourceGetOrCreate(...args),
    update: (...args: unknown[]) => mockResourceUpdate(...args),
  },
}));

// ── Module imports (after mocks) ──────────────────────────────────────────

import '../engine/transforms/register-bundled';
import { getTransform } from '../engine/transforms';
import { vcUrlRetrievalImpl, _extractCandidateUrls } from '../engine/transforms/vc-url-retrieval';
import { fetchUrlImpl, FETCH_URL_PLUGIN_MANIFEST } from '../engine/transforms/fetch-url';
import { linkedinEnrichmentImpl } from '../engine/transforms/linkedin-enrichment';

import type { ContextDependentInput, PreExtractionInput } from '../engine/transforms';
import type { SourcePosition } from '../types';

import { makeStablePosition } from '../types';
import { services } from '../../../adapters/registry';
import { logger } from '../../logger';

// ── Fixtures ──────────────────────────────────────────────────────────────

const sourceNode: SourcePosition = makeStablePosition({
  adapterType: 'fixture',
  recordType: 'fixture.message',
  recordId: 'msg-1',
  data: {},
});

beforeEach(() => {
  mockAnthropicChat.mockReset();
  mockFindLinkedIn.mockReset();
  mockSearch.mockReset();
  mockPitchDeckUrlTool.mockReset();
  mockExtractDocumentTextTool.mockReset();
  mockIsSupportedUrl.mockReset();
  mockGetWebsite.mockReset();
  mockGetById.mockReset();
  mockGetOrCreateFromContent.mockReset();
  mockResourceGetOrCreate.mockReset();
  mockResourceUpdate.mockReset();
  // No linkedin profile adapter by default — the enrichment emits URL only
  // unless a test injects one (matches the un-provisioned registry).
  services.linkedin = undefined;
});

// ── Registration ──────────────────────────────────────────────────────────

describe('transform registration (via register-bundled side-effect import)', () => {
  it('registers vc-url-retrieval', () => {
    const t = getTransform('vc-url-retrieval');
    expect(t).toBeDefined();
    expect(t?.signature.dataDependency).toBe('none');
  });

  it('registers fetch-url', () => {
    const t = getTransform('fetch-url');
    expect(t).toBeDefined();
    // The url it loads comes from the fields the extract has produced, so it
    // is a stage of an extraction and the checker keeps it to one.
    expect(t?.signature.dataDependency).toBe('extracted_context');
  });

  it('registers linkedin-enrichment', () => {
    const t = getTransform('linkedin-enrichment');
    expect(t).toBeDefined();
    expect(t?.signature.dataDependency).toBe('extracted_context');
  });

  it('registers linkedin-research', () => {
    const t = getTransform('linkedin-research');
    expect(t).toBeDefined();
    // It works from the address a stage before it extracted, so it is a
    // stage of an extraction like the other two.
    expect(t?.signature.dataDependency).toBe('extracted_context');
  });

  it('registers web-research', () => {
    const t = getTransform('web-research');
    expect(t).toBeDefined();
    // It works from the name and the context a stage before it extracted.
    expect(t?.signature.dataDependency).toBe('extracted_context');
  });

  it('registers research', () => {
    const t = getTransform('research');
    expect(t).toBeDefined();
    // Name, context and addresses are all fields a stage before it extracted.
    expect(t?.signature.dataDependency).toBe('extracted_context');
  });
});

// ── Signature shapes ──────────────────────────────────────────────────────

describe('vc-url-retrieval signature', () => {
  it('declares the vcUrl edge with the {name,url,file,text} record shape', () => {
    const sig = vcUrlRetrievalImpl.signature;
    expect(sig.name).toBe('vc-url-retrieval');
    expect(sig.dataDependency).toBe('none');

    const vcUrl = sig.additions.edges?.vcUrl;
    expect(vcUrl).toBeDefined();
    expect(vcUrl?.target.kind).toBe('list');
    const target = vcUrl?.target as { kind: 'list'; element: { kind: string; fields?: Record<string, { kind: string }> } };
    expect(target.element.kind).toBe('record');
    const fields = target.element.fields ?? {};
    expect(fields.name).toEqual({ kind: 'string' });
    expect(fields.url).toEqual({ kind: 'string' });
    expect(fields.file).toEqual({ kind: 'file' });
    expect(fields.text).toEqual({ kind: 'string' });
  });

  it('declares a required text param', () => {
    const sig = vcUrlRetrievalImpl.signature;
    const param = sig.params.find((p) => p.name === 'text');
    expect(param).toBeDefined();
    expect(param?.required).toBe(true);
    expect(param?.type.kind).toBe('string');
  });

});

describe('fetch-url signature', () => {
  it('declares url required and author-supplied, with email and password beside it', () => {
    const sig = fetchUrlImpl.signature;
    expect(sig.name).toBe('fetch-url');
    expect(sig.params.map((p) => p.name)).toEqual(['url', 'email', 'password']);

    const url = sig.params.find((p) => p.name === 'url');
    expect(url?.required).toBe(true);
    expect(url?.auto).toBeUndefined();
    expect(url?.type.kind).toBe('string');

    // Nothing here is engine-injected: every argument is the author's, or an
    // extracted field the author named.
    expect(sig.params.some((p) => p.auto)).toBe(false);
  });

  it('declares a single fetched page, not a list', () => {
    const target = fetchUrlImpl.signature.additions.edges?.fetchedUrl?.target as {
      kind: string;
      fields?: Record<string, { kind: string }>;
    };
    expect(target.kind).toBe('record');
    expect(target.fields?.text).toEqual({ kind: 'string' });
    expect(target.fields?.file).toEqual({ kind: 'file' });
  });

  it('declares reading the web and consulting no model', () => {
    expect(fetchUrlImpl.signature.effects).toEqual({ reads: ['the web'] });
  });

  it('is the manifest the catalogue shows, params and all', () => {
    expect(FETCH_URL_PLUGIN_MANIFEST.pluginName).toBe('fetch-url');
    expect(FETCH_URL_PLUGIN_MANIFEST.importName).toBe('fetch_url');
    expect(FETCH_URL_PLUGIN_MANIFEST.params).toBe(fetchUrlImpl.signature.params);
  });
});

describe('linkedin-enrichment signature', () => {
  it('declares the linkedin_url property output', () => {
    const sig = linkedinEnrichmentImpl.signature;
    expect(sig.name).toBe('linkedin-enrichment');
    expect(sig.dataDependency).toBe('extracted_context');
    expect(sig.additions.properties?.linkedin_url).toEqual({ kind: 'string' });
  });
});

// ── Behavioural parity: vc-url-retrieval ──────────────────────────────────
//
// Each test pins the legacy plugin's external surface (classify call,
// fetch call, etc.) and asserts the transform's `TransformOutput`
// matches the expected ephemeral-emission set.

describe('vc-url-retrieval.run — behavioural parity', () => {
  function preInput(content: string): PreExtractionInput {
    return { kind: 'pre-extraction', sourceNode, config: { text: content } };
  }

  it('returns no edges when there are no URLs in the content', async () => {
    const out = await vcUrlRetrievalImpl.run(preInput('Plain text with no links.'));
    expect(out).toEqual({});
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });

  it('returns no edges when config.text is missing', async () => {
    const out = await vcUrlRetrievalImpl.run({
      kind: 'pre-extraction',
      sourceNode,
      config: {},
    });
    expect(out).toEqual({});
  });

  it('throws when invoked with a context-dependent input (wrong timing)', async () => {
    await expect(
      vcUrlRetrievalImpl.run({
        kind: 'context-dependent',
        sourceNode,
        config: { content: 'x' },
        extractedContext: {},
      }),
    ).rejects.toThrow(/pre-extraction/);
  });

  it('emits a vcUrl edge for a fetched pitch-deck URL', async () => {
    const url = 'https://docsend.com/view/abc';

    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ type: 'pitch_deck', password: 'SECRET' }),
    );
    mockIsSupportedUrl.mockReturnValue(true);
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-1', documentId: null });
    mockPitchDeckUrlTool.mockResolvedValue({ type: 'DOCUMENT', documentId: 'doc-1' });
    mockExtractDocumentTextTool.mockResolvedValue({
      type: 'DOCUMENT_WITH_CONTENT',
      documentId: 'doc-1',
      rawTextId: 'rt-1',
    });
    mockGetById.mockResolvedValue({ id: 'rt-1', content: 'Deck contents here.' });

    const out = await vcUrlRetrievalImpl.run(
      preInput(`Pitch deck ${url} Password: SECRET`),
    );

    expect(out.edges?.vcUrl).toEqual([
      {
        data: {
          name: url,
          url,
          file: 'doc-1',
          text: 'Deck contents here.',
        },
      },
    ]);
    expect(mockPitchDeckUrlTool).toHaveBeenCalledWith(
      expect.objectContaining({ url, password: 'SECRET' }),
    );
  });

  it('keeps a fetched document whose text cannot be read, with empty text and a warning', async () => {
    const url = 'https://docsend.com/view/scan';

    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ type: 'pitch_deck', password: null }),
    );
    mockIsSupportedUrl.mockReturnValue(true);
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-s', documentId: null });
    mockPitchDeckUrlTool.mockResolvedValue({ type: 'DOCUMENT', documentId: 'doc-scan' });
    mockExtractDocumentTextTool.mockRejectedValue(
      new Error('no text layer; OCR is not configured, so text cannot be extracted from this PDF.'),
    );

    const out = await vcUrlRetrievalImpl.run(preInput(`Deck ${url}`));

    expect(out.edges?.vcUrl).toEqual([
      { data: { name: url, url, file: 'doc-scan', text: '' } },
    ]);
    expect(mockResourceUpdate).toHaveBeenCalledWith('res-s', { rawTextId: null });
    expect(mockGetById).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no readable text'),
      expect.objectContaining({
        documentId: 'doc-scan',
        reason: expect.stringContaining('OCR is not configured'),
      }),
    );
  });

  it('drops URLs classified as tracking_pixel / unsubscribe (matches legacy filter)', async () => {
    mockAnthropicChat
      .mockResolvedValueOnce(JSON.stringify({ type: 'tracking_pixel', password: null }))
      .mockResolvedValueOnce(JSON.stringify({ type: 'unsubscribe', password: null }));

    const text = [
      '<img src="https://tracker.example.com/pixel" width="1" height="1" />',
      '<a href="https://mailchimp.com/unsubscribe/xyz">Unsubscribe</a>',
    ].join('\n');

    const out = await vcUrlRetrievalImpl.run(preInput(text));
    expect(out).toEqual({});
    expect(mockPitchDeckUrlTool).not.toHaveBeenCalled();
    expect(mockGetWebsite).not.toHaveBeenCalled();
  });

  it('falls back to web scrape for unsupported, classified-as-website URLs', async () => {
    const url = 'https://startup.com';
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ type: 'company_website', password: null }),
    );
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('Welcome to startup.com — we build things. '.repeat(20));
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-2', content: 'scrape' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-2' });

    const out = await vcUrlRetrievalImpl.run(preInput(`Visit ${url} for more.`));

    expect(out.edges?.vcUrl).toHaveLength(1);
    const emission = (out.edges?.vcUrl as Array<{ data: { url: string; file: unknown; text: string } }>)[0];
    expect(emission.data.url).toBe(url);
    expect(emission.data.file).toBeNull();
    expect(emission.data.text).toContain('Welcome to startup.com');
  });

  it('emits one edge per fetched URL when multiple are discovered', async () => {
    mockAnthropicChat
      .mockResolvedValueOnce(JSON.stringify({ type: 'pitch_deck', password: null }))
      .mockResolvedValueOnce(JSON.stringify({ type: 'company_website', password: null }));

    mockIsSupportedUrl.mockImplementation((u: string) => u.includes('docsend.com'));
    mockResourceGetOrCreate.mockResolvedValueOnce({ id: 'res-a', documentId: null });
    mockPitchDeckUrlTool.mockResolvedValue({ type: 'DOCUMENT', documentId: 'doc-a' });
    mockExtractDocumentTextTool.mockResolvedValue({
      type: 'DOCUMENT_WITH_CONTENT',
      documentId: 'doc-a',
      rawTextId: 'rt-a',
    });
    mockGetById.mockResolvedValue({ id: 'rt-a', content: 'deck text' });
    mockGetWebsite.mockResolvedValue('a website body that is plenty long to pass the gate'.repeat(2));
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-b', content: 'site' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-b' });

    const out = await vcUrlRetrievalImpl.run(
      preInput('Deck: https://docsend.com/view/aaa Site: https://startup.com'),
    );

    expect(out.edges?.vcUrl).toBeDefined();
    const emissions = out.edges?.vcUrl as Array<{ data: { url: string } }>;
    const urls = emissions.map((e) => e.data.url).sort();
    expect(urls).toEqual(['https://docsend.com/view/aaa', 'https://startup.com']);
  });

  it('drops fetches that return null (e.g. too-short scrape) and emits nothing', async () => {
    const url = 'https://startup.com';
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ type: 'company_website', password: null }),
    );
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('tiny'); // < 50 chars → null

    const out = await vcUrlRetrievalImpl.run(preInput(`Visit ${url}`));
    expect(out).toEqual({});
  });
});

// ── Behavioural parity: linkedin-enrichment ───────────────────────────────

describe('fetch-url.run — the link it is given', () => {
  function input(config: Record<string, unknown>): ContextDependentInput {
    return { kind: 'context-dependent', sourceNode, config, extractedContext: {} };
  }

  it('loads exactly the url it is given, consulting no classifier', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('Gondor forges rings at scale. '.repeat(20));
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-9', content: 'scrape' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-9' });

    const out = await fetchUrlImpl.run(input({ url: 'https://gondor.fi' }));

    expect(mockGetWebsite).toHaveBeenCalledTimes(1);
    expect(mockGetWebsite).toHaveBeenCalledWith('https://gondor.fi', expect.anything());
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(out.edges?.fetchedUrl).toEqual({
      data: expect.objectContaining({ url: 'https://gondor.fi', file: null }),
    });
    expect(out.outcome).toBe('fetched');
  });

  it('reads a bare host as an https address', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('Rohan breeds fast horses. '.repeat(20));
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-10', content: 'scrape' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-10' });

    await fetchUrlImpl.run(input({ url: '  rohan.io  ' }));

    expect(mockGetWebsite).toHaveBeenCalledWith('https://rohan.io', expect.anything());
  });

  it('types the email and passcode into a gated document link', async () => {
    mockIsSupportedUrl.mockReturnValue(true);
    mockPitchDeckUrlTool.mockResolvedValue({ type: 'DOCUMENT', documentId: 'doc-2' });
    mockExtractDocumentTextTool.mockResolvedValue({
      type: 'DOCUMENT_WITH_CONTENT',
      documentId: 'doc-2',
      rawTextId: 'rt-3',
    });
    mockGetById.mockResolvedValue({ id: 'rt-3', content: 'Gated contents.' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-3', documentId: null });

    const out = await fetchUrlImpl.run(
      input({
        url: 'https://docsend.com/view/gated',
        email: 'ada@example.com',
        password: 'SUMMER24',
      }),
    );

    expect(mockPitchDeckUrlTool).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://docsend.com/view/gated',
        email: 'ada@example.com',
        password: 'SUMMER24',
      }),
    );
    expect(out.edges?.fetchedUrl).toEqual({
      data: expect.objectContaining({ file: 'doc-2', text: 'Gated contents.' }),
    });
  });

  it('carries neither email nor passcode into a plain page fetch (nothing to gate)', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('An ungated page. '.repeat(20));
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-11', content: 'scrape' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-11' });

    await fetchUrlImpl.run(
      input({ url: 'https://open.example.com', email: 'ada@example.com', password: 'x' }),
    );

    expect(mockGetWebsite).toHaveBeenCalledWith('https://open.example.com', {
      provider: 'brightdata',
    });
    expect(mockPitchDeckUrlTool).not.toHaveBeenCalled();
  });

  // A failed load and an empty page both attach nothing, and the run's trace
  // could not tell them apart — so the failure says so in its own word.
  it('says the fetch failed when the page cannot be loaded', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    mockGetWebsite.mockResolvedValue('');
    expect(await fetchUrlImpl.run(input({ url: 'https://dead.example.com' }))).toEqual({
      outcome: 'fetch_failed',
    });
  });

  // LinkedIn answers a scrape with its login wall, so the profile service —
  // the same one the LinkedIn lookup plugin reads through — is the only
  // mechanism that can see a LinkedIn page at all.
  it('reads a LinkedIn profile through the profile service, not the scraper', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    const getProfileTextByUrl = jest.fn().mockResolvedValue({
      text: 'Name: Ada Lovelace\nPosition: Founder',
    });
    services.linkedin = { getProfileTextByUrl };
    mockGetOrCreateFromContent.mockResolvedValue({ id: 'rt-li' });
    mockResourceGetOrCreate.mockResolvedValue({ id: 'res-li', documentId: null });
    mockGetById.mockResolvedValue({
      id: 'rt-li',
      content: 'Name: Ada Lovelace\nPosition: Founder',
    });

    const out = await fetchUrlImpl.run(input({ url: 'https://www.linkedin.com/in/ada-lovelace' }));

    // And it says how long it will wait. This fetch runs once per record over
    // a fan-out, while the profile service collects asynchronously and is
    // polled every five seconds — so an unbounded wait here is minutes per
    // record for a link the record merely happened to carry.
    expect(getProfileTextByUrl).toHaveBeenCalledWith('https://www.linkedin.com/in/ada-lovelace', {
      maxWaitMs: 15_000,
    });
    expect(mockGetWebsite).not.toHaveBeenCalled();
    expect(out.edges?.fetchedUrl).toEqual({
      data: expect.objectContaining({ text: 'Name: Ada Lovelace\nPosition: Founder' }),
    });
  });

  // A company page, a post, a search: the profile service reads none of them,
  // and scraping one costs tens of seconds to hand back the login wall as if
  // it were the record's content.
  it.each([
    ['https://www.linkedin.com/company/acme'],
    ['https://www.linkedin.com/posts/ada-lovelace_activity-123'],
    ['https://uk.linkedin.com/school/babbage'],
    ['https://www.linkedin.com'],
  ])('fetches nothing, and scrapes nothing, for the unreadable LinkedIn link %s', async (url) => {
    mockIsSupportedUrl.mockReturnValue(false);
    const getProfileTextByUrl = jest.fn();
    services.linkedin = { getProfileTextByUrl };

    expect(await fetchUrlImpl.run(input({ url }))).toEqual({ outcome: 'fetch_failed' });

    expect(mockGetWebsite).not.toHaveBeenCalled();
    expect(getProfileTextByUrl).not.toHaveBeenCalled();
  });

  it('fetches nothing for a LinkedIn profile when no profile service is configured', async () => {
    mockIsSupportedUrl.mockReturnValue(false);
    services.linkedin = undefined;

    expect(await fetchUrlImpl.run(input({ url: 'https://www.linkedin.com/in/ada' }))).toEqual({
      outcome: 'fetch_failed',
    });

    expect(mockGetWebsite).not.toHaveBeenCalled();
  });

  // The stage boundary skips a record whose url came back absent, so this
  // should be unreachable — but "unreachable" is the state a nullish value
  // reaching a URL builder is always in. `null` must never become the address
  // `https://null`, which resolves to a scrape that grinds to the seven-minute
  // backstop and hands back an error page as if it were the record's content.
  it.each([[null], [undefined], [''], ['   '], [42], [{ url: 'https://gondor.fi' }]])(
    'fetches nothing at all when the url is %p',
    async (url) => {
      mockIsSupportedUrl.mockReturnValue(false);

      expect(await fetchUrlImpl.run(input({ url }))).toEqual({});

      expect(mockGetWebsite).not.toHaveBeenCalled();
      expect(mockPitchDeckUrlTool).not.toHaveBeenCalled();
    },
  );

  it('throws when invoked with a pre-extraction input (wrong timing)', async () => {
    await expect(
      fetchUrlImpl.run({ kind: 'pre-extraction', sourceNode, config: { url: 'https://x.com' } }),
    ).rejects.toThrow(/context-dependent/);
  });
});

describe('linkedin-enrichment.run — behavioural parity', () => {
  function ctxInput(extractedContext: unknown): ContextDependentInput {
    return { kind: 'context-dependent', sourceNode, config: {}, extractedContext };
  }

  it('returns no properties when extractedContext is empty', async () => {
    const out = await linkedinEnrichmentImpl.run(ctxInput({}));
    expect(out).toEqual({});
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });

  it('throws when invoked with a pre-extraction input (wrong timing)', async () => {
    await expect(
      linkedinEnrichmentImpl.run({
        kind: 'pre-extraction',
        sourceNode,
        config: {},
      }),
    ).rejects.toThrow(/context-dependent/);
  });

  // The plugin exists to attach profile CONTENT. An address in hand means the
  // search can be skipped, not that there is nothing left to do — the page
  // still has to be read, and before this the run paid for the plugin and
  // received nothing.
  it('reads the page for a profile address the record already carries, without searching', async () => {
    const getProfileTextByUrl = jest.fn().mockResolvedValue({
      text: 'Name: Ada Lovelace\nPosition: Founder',
    });
    services.linkedin = { getProfileTextByUrl };

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: 'Ada Lovelace',
        profile: 'https://www.linkedin.com/in/adalovelace',
      }),
    );

    expect(out.properties).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/adalovelace',
      linkedin_profile: 'Name: Ada Lovelace\nPosition: Founder',
    });
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(mockFindLinkedIn).not.toHaveBeenCalled();
  });

  // This lookup is the deliberate one — it is the whole point of the stage,
  // and one person at a time — so it names no wait and takes the service's
  // own patience.
  it('gives the profile service no deadline of its own', async () => {
    const getProfileTextByUrl = jest.fn().mockResolvedValue({ text: 'Name: Ada Lovelace' });
    services.linkedin = { getProfileTextByUrl };

    await linkedinEnrichmentImpl.run(
      ctxInput({ name: 'Ada Lovelace', profile: 'https://www.linkedin.com/in/adalovelace' }),
    );

    expect(getProfileTextByUrl.mock.calls[0]).toEqual(['https://www.linkedin.com/in/adalovelace']);
  });

  it('contributes nothing when the address is known and the page cannot be read', async () => {
    services.linkedin = { getProfileTextByUrl: async () => ({ text: null }) };

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({ name: 'Ada Lovelace', profile: 'https://www.linkedin.com/in/adalovelace' }),
    );

    expect(out).toEqual({});
    expect(mockFindLinkedIn).not.toHaveBeenCalled();
  });

  it('does nothing at all when the profile page content is already present', async () => {
    const getProfileTextByUrl = jest.fn();
    services.linkedin = { getProfileTextByUrl };

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: 'Ada Lovelace',
        linkedin_url: 'https://www.linkedin.com/in/adalovelace',
        linkedin_profile: 'Name: Ada Lovelace\nPosition: Founder\nPast experience:\n  - Analyst',
      }),
    );

    expect(out).toEqual({});
    expect(getProfileTextByUrl).not.toHaveBeenCalled();
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(mockFindLinkedIn).not.toHaveBeenCalled();
  });

  it('recognises the profile field by the label an annotated field carries', async () => {
    const getProfileTextByUrl = jest.fn();
    services.linkedin = { getProfileTextByUrl };

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: { label: 'name', value: 'Ada Lovelace' },
        profile_text: { label: 'LinkedIn profile', value: 'Name: Ada Lovelace\nPosition: Founder' },
      }),
    );

    expect(out).toEqual({});
    expect(getProfileTextByUrl).not.toHaveBeenCalled();
  });

  // A profile field holding nothing but the address is the address.
  it('reads the page when the profile field holds only the address', async () => {
    const getProfileTextByUrl = jest.fn().mockResolvedValue({ text: 'Name: Ada Lovelace' });
    services.linkedin = { getProfileTextByUrl };

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: 'Ada Lovelace',
        linkedin_profile: 'https://www.linkedin.com/in/adalovelace',
      }),
    );

    expect(getProfileTextByUrl).toHaveBeenCalledWith('https://www.linkedin.com/in/adalovelace');
    expect(out.properties).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/adalovelace',
      linkedin_profile: 'Name: Ada Lovelace',
    });
  });

  it('emits a linkedin_url property on successful lookup', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Ada Lovelace',
        company: 'Analytical Engines Inc',
        description: 'mathematician, computing pioneer',
      }),
    );
    mockFindLinkedIn.mockResolvedValue([
      { link: 'https://www.linkedin.com/in/ada-lovelace-pioneer' },
    ]);

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: 'Ada Lovelace',
        company: 'Analytical Engines Inc',
        role: 'mathematician',
      }),
    );

    expect(out.properties).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace-pioneer',
    });
    expect(mockFindLinkedIn).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      company: 'Analytical Engines Inc',
      description: 'mathematician, computing pioneer',
    });
  });

  it('also emits the fetched profile page content as linkedin_profile', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Ada Lovelace', company: 'AC', description: null }),
    );
    mockFindLinkedIn.mockResolvedValue([{ link: 'https://www.linkedin.com/in/ada' }]);
    services.linkedin = {
      getProfileTextByUrl: async () => ({ text: 'Ada Lovelace — founder at AC, ex-Babbage.' }),
    };

    const out = await linkedinEnrichmentImpl.run(ctxInput({ name: 'Ada Lovelace' }));

    expect(out.properties).toEqual({
      linkedin_url: 'https://www.linkedin.com/in/ada',
      linkedin_profile: 'Ada Lovelace — founder at AC, ex-Babbage.',
    });
  });

  it('emits URL only when the profile page content cannot be fetched', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Ada Lovelace', company: 'AC', description: null }),
    );
    mockFindLinkedIn.mockResolvedValue([{ link: 'https://www.linkedin.com/in/ada' }]);
    services.linkedin = { getProfileTextByUrl: async () => ({ text: null }) };

    const out = await linkedinEnrichmentImpl.run(ctxInput({ name: 'Ada Lovelace' }));

    expect(out.properties).toEqual({ linkedin_url: 'https://www.linkedin.com/in/ada' });
  });

  it('keeps the person and nested company (ancestor) context separate in the identify prompt', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Arsenii', company: 'Gondor', description: 'founder, DeFi' }),
    );
    mockFindLinkedIn.mockResolvedValue([{ link: 'https://www.linkedin.com/in/arsenii' }]);

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        name: 'Arsenii',
        company: {
          name: 'Gondor',
          description:
            'The DeFi layer for prediction markets, building settlement rails and liquidity for on-chain forecasting.',
          sector: 'DeFi / prediction markets',
        },
      }),
    );

    expect(out.properties).toMatchObject({ linkedin_url: 'https://www.linkedin.com/in/arsenii' });

    const identifyCall = mockAnthropicChat.mock.calls[0][0] as { userMessage: string };
    // The nested company object is resolved to fields, not stringified.
    expect(identifyCall.userMessage).not.toContain('[object Object]');
    expect(identifyCall.userMessage).toContain('Arsenii');
    expect(identifyCall.userMessage).toContain('Gondor');
    // Own fields and organisation context are presented as distinct sections.
    expect(identifyCall.userMessage).toMatch(/person'?s own fields/i);
    expect(identifyCall.userMessage).toMatch(/organisation/i);
    // The company from the ancestor context drives the search.
    expect(mockFindLinkedIn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Arsenii', company: 'Gondor' }),
    );
  });

  it('emits nothing when the LLM cannot identify a name', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: null, company: null, description: null }),
    );

    const out = await linkedinEnrichmentImpl.run(ctxInput({ note: 'unclear sender' }));
    expect(out).toEqual({});
    expect(mockFindLinkedIn).not.toHaveBeenCalled();
  });

  it('emits nothing when web search returns no results', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Ada Lovelace', company: null, description: null }),
    );
    mockFindLinkedIn.mockResolvedValue([]);

    const out = await linkedinEnrichmentImpl.run(ctxInput({ name: 'Ada Lovelace' }));
    expect(out).toEqual({});
  });

  it('emits nothing, rather than failing the run, when the web search throws', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Ada Lovelace', company: null, description: null }),
    );
    mockFindLinkedIn.mockRejectedValue(new Error('Google Custom Search refused the request'));

    const out = await linkedinEnrichmentImpl.run(ctxInput({ name: 'Ada Lovelace' }));
    expect(out).toEqual({});
  });

  it('accepts the annotated {label, value} field shape (preferred output of #extract)', async () => {
    mockAnthropicChat.mockResolvedValueOnce(
      JSON.stringify({ name: 'Ada Lovelace', company: 'AC', description: null }),
    );
    mockFindLinkedIn.mockResolvedValue([{ link: 'https://www.linkedin.com/in/ada' }]);

    const out = await linkedinEnrichmentImpl.run(
      ctxInput({
        full_name: { label: 'Full Name', value: 'Ada Lovelace' },
        org: { label: 'Company', value: 'AC' },
      }),
    );

    expect(out.properties).toEqual({ linkedin_url: 'https://www.linkedin.com/in/ada' });
    // The identify prompt should be the label-prefixed form.
    const userMessage = mockAnthropicChat.mock.calls[0][0].userMessage as string;
    expect(userMessage).toContain('Full Name: Ada Lovelace');
    expect(userMessage).toContain('Company: AC');
  });

  it('emits nothing when the LLM identify response is unparseable', async () => {
    mockAnthropicChat.mockResolvedValueOnce('not-json');

    const out = await linkedinEnrichmentImpl.run(ctxInput({ name: 'Ada Lovelace' }));
    expect(out).toEqual({});
    expect(mockFindLinkedIn).not.toHaveBeenCalled();
  });
});

// ── Bare-domain candidate extraction ────────────────────────────────────────
// A message often names a site with no scheme ("founder of gondor.fi"); the
// scheme-anchored pass misses those. The classifier still vets each candidate,
// so the bar here is "plausible site" not "definitely fetch".
describe('_extractCandidateUrls — bare domains', () => {
  it('picks up a bare domain mentioned in prose', () => {
    expect(_extractCandidateUrls('Met Arsenii, founder of gondor.fi')).toContain(
      'https://gondor.fi',
    );
  });

  it('still picks up scheme-qualified URLs', () => {
    expect(_extractCandidateUrls('deck here: https://acme.com/deck.pdf')).toContain(
      'https://acme.com/deck.pdf',
    );
  });

  it('carries a bare domain path through', () => {
    expect(_extractCandidateUrls('see acme.com/about for more')).toContain(
      'https://acme.com/about',
    );
  });

  it('ignores abbreviations and filenames', () => {
    expect(
      _extractCandidateUrls('e.g. read report.pdf and index.js, i.e. the build.'),
    ).toEqual([]);
  });

  it('does not turn an email address into a fetch candidate', () => {
    expect(_extractCandidateUrls('reach me at arsenii@gondor.fi')).toEqual([]);
  });

  it('drops the full stop that ends a sentence after a link', () => {
    expect(_extractCandidateUrls('see https://x.notion.site/abc. Thanks')).toEqual([
      'https://x.notion.site/abc',
    ]);
    expect(_extractCandidateUrls('slides at acme.com/deck.')).toEqual(['https://acme.com/deck']);
  });

  it('drops the comma or semicolon that ends a clause after a link', () => {
    expect(_extractCandidateUrls('deck: https://x.notion.site/abc, thanks')).toEqual([
      'https://x.notion.site/abc',
    ]);
    expect(_extractCandidateUrls('see acme.com/deck; and the memo')).toEqual([
      'https://acme.com/deck',
    ]);
  });

  it('keeps commas inside a link', () => {
    expect(_extractCandidateUrls('https://acme.com/a,b;c.')).toEqual(['https://acme.com/a,b;c']);
  });

  it('keeps dots inside a link', () => {
    expect(_extractCandidateUrls('https://acme.com/deck.pdf.')).toEqual([
      'https://acme.com/deck.pdf',
    ]);
  });

  it('does not double-count a scheme-qualified host as a separate bare domain', () => {
    expect(_extractCandidateUrls('https://acme.com is the site')).toEqual(['https://acme.com']);
  });
});
