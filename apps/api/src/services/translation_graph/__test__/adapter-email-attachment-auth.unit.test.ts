/**
 * The email adapter OWNS the FILE resources it emits and serves their bytes
 * from the attachment's stored handle. The handle says who stored it, and each
 * provider reaches its bytes differently:
 *
 *   • Mailgun's is a storage URL behind HTTP Basic auth (`api:<key>`) — a bare
 *     GET 401s;
 *   • Resend's is a pair of ids, because the URL it hands out dies within the
 *     hour, so a live one has to be minted at the moment the bytes are wanted;
 *   • a custom-email blob URL is on one of our own hosts and needs nothing.
 *
 * Dispatching on the HANDLE rather than on whatever this deployment is
 * configured with is what lets a deployment that switched providers still
 * redeem the attachments it already has.
 *
 * We spy on `fetch` (the adapter's only external dependency here) to read back
 * what the byte path builds.
 */

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { FileRef } from '../adapter';

import { EmailAdapter } from '../adapters/email';

const TEAM_ID = 'team-1' as TeamId;

function refFor(handle: string): { ref: FileRef } {
  // resolveFileRef only reads `ref.source.handle`; a minimal ref suffices.
  return { ref: { source: { handle } } as unknown as FileRef };
}

function authHeaderFrom(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.Authorization;
}

describe('email attachment byte auth (resolveFileRef)', () => {
  let fetchSpy: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '5' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('attaches Mailgun Basic auth when the handle is a mailgun.net storage URL', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const handle =
      'https://storage.mailgun.net/v3/domains/example.com/messages/abc/attachments/0';
    await adapter.resolveFileRef(refFor(handle));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe(handle);
    const auth = authHeaderFrom(init);
    expect(auth).toMatch(/^Basic /);
    const decoded = Buffer.from(auth!.replace('Basic ', ''), 'base64').toString();
    expect(decoded.startsWith('api:')).toBe(true);
  });

  it('sends no auth for a non-Mailgun handle (custom-email blob URL)', async () => {
    const adapter = new EmailAdapter(TEAM_ID);
    const handle = 'https://blob.example.com/inbound/xyz/attachment-0';
    await adapter.resolveFileRef(refFor(handle));

    const [, init] = fetchSpy.mock.calls[0];
    expect(authHeaderFrom(init)).toBeUndefined();
  });

  it('mints a fresh download URL for a Resend handle rather than storing one', async () => {
    fetchSpy.mockImplementation(async (input) => {
      if (String(input).includes('/attachments')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'att_2', filename: 'deck.pdf', download_url: 'https://live/att_2' }],
            has_more: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('bytes', {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '5' },
      });
    });

    const adapter = new EmailAdapter(TEAM_ID);
    await adapter.resolveFileRef(refFor('resend:re_1/att_2'));

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('/emails/receiving/re_1/attachments');
    // The bytes come from the URL that was just minted, never from the handle.
    expect(urls[urls.length - 1]).toBe('https://live/att_2');
  });

  it('follows the listing’s pages to find an attachment that is not on the first', async () => {
    const pages = [
      {
        data: [{ id: 'att_1', filename: 'a.pdf', download_url: 'https://live/att_1' }],
        has_more: true,
      },
      {
        data: [{ id: 'att_2', filename: 'b.pdf', download_url: 'https://live/att_2' }],
        has_more: false,
      },
    ];
    let page = 0;
    fetchSpy.mockImplementation(async (input) => {
      if (String(input).includes('/attachments')) {
        const body = pages[Math.min(page, pages.length - 1)];
        page += 1;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });
    });

    const adapter = new EmailAdapter(TEAM_ID);
    await adapter.resolveFileRef(refFor('resend:re_1/att_2'));

    const urls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(urls[1]).toContain('after=att_1');
    expect(urls[urls.length - 1]).toBe('https://live/att_2');
  });

  it('fails loudly when Resend no longer lists the attachment', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const adapter = new EmailAdapter(TEAM_ID);
    await expect(adapter.resolveFileRef(refFor('resend:re_1/att_gone'))).rejects.toThrow(
      /no longer lists attachment att_gone/,
    );
  });
});
