// Off the platform there is no LinkedIn profile reader and no gated-document
// browser. An address that needs one fails, naming what is missing, instead of
// coming back as nothing (which a movement would read as an empty page).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { noCredential, pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';

import { webModule } from '../index';
import { isDocumentSourceAddress } from '../standalone';

const DECK = path.join(__dirname, '../../../packages/file-text/__test__/__fixtures__/deck.pptx');
const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const fetched: string[] = [];
const web = pluginsInProcess(webModule, {
  tenant: 't',
  credential: noCredential('none'),
  log: quiet,
  files: refusingFiles('none'),
  kv: refusingKv('none'),
  fetch: (async (url: string | URL | Request) => {
    fetched.push(String(url));
    if (String(url).endsWith('.pptx')) {
      return new Response(readFileSync(DECK), {
        status: 200,
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
      });
    }
    return new Response('<html><body>never asked</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch,
  validateResults: true,
});

const fetchUrl = (url: string) => web.invoke({ name: 'fetch-url', config: { url }, extractedContext: {} });

describe('@lf/web off the platform', () => {
  beforeEach(() => {
    fetched.length = 0;
  });

  it('refuses a LinkedIn profile address, naming the profile reader', async () => {
    await expect(fetchUrl('https://www.linkedin.com/in/someone')).rejects.toThrow(
      "@lf/web: reading the LinkedIn profile https://www.linkedin.com/in/someone needs the platform's LinkedIn profile reader, which is not available off the platform",
    );
    expect(fetched).toEqual([]);
  });

  it('refuses a gated document address, naming the document browser', async () => {
    await expect(fetchUrl('https://docsend.com/view/abc123')).rejects.toThrow(
      "needs the platform's gated-document browser and document store, which is not available off the platform",
    );
    expect(fetched).toEqual([]);
  });

  it('reads a plain PowerPoint link through the file-text package', async () => {
    const result = await fetchUrl('https://example.com/files/deck.pptx');
    expect(fetched).toEqual(['https://example.com/files/deck.pptx']);
    expect(JSON.stringify(result)).toMatch(/\S{3,}/);
    expect(JSON.stringify(result)).not.toContain('never asked');
  });

  it('knows the platform’s document sources', () => {
    expect(isDocumentSourceAddress('https://docsend.com/view/abc123')).toBe(true);
    expect(isDocumentSourceAddress('https://www.canva.com/design/DAF1/edit')).toBe(true);
    expect(isDocumentSourceAddress('https://example.com/about')).toBe(false);
  });
});
