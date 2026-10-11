// Which mail provider this deployment's email runs through.
//
// A movement author never picks one: the fields, the edges and the attachments
// are the same whichever company carried the message. The provider decides
// three deployment-level things — the door mail arrives at, how attachment
// bytes are reached, and which API sends outbound mail — so it is resolved
// once, at boot, from what is configured.
//
// Resend wins when both are configured. Not because it is better, but because
// a deployment must have exactly ONE answer to "where does mail come in": two
// live inbound doors on one address means the same message arriving twice, and
// a rule that says "whichever" is a rule that says "sometimes both".
//
// Attachment bytes are the one place the boot answer is NOT the right one. A
// handle stored last week names the provider that stored it, and a deployment
// that has just switched providers still has to be able to redeem it — so
// bytes are served by the provider the HANDLE names, not by the configured
// one. Silent 401s on old attachments is exactly what the old
// `endsWith('mailgun.net')` special-case produced when anything else appeared.

import type { ResolveFileRefResult } from '../../adapter';

import { fetchUrlToStream } from '../../engine/files/fetch-stream';
import { getEnvVar } from '../../../../lib/utils/environment';
import { mintAttachmentDownloadUrl, parseResendAttachmentHandle } from './resend';
import { FileOutsideTeamError } from '../../engine/files/file_outside_team';

type EmailProviderSlug = 'mailgun' | 'resend';

interface EmailProvider {
  readonly slug: EmailProviderSlug;
  /** Where this provider's inbound deliveries land. */
  readonly callbackPath: string;
  /** Whether a stored attachment handle is one this provider minted. */
  owns(handle: string): boolean;
  /** The bytes behind one of its handles. */
  fetchAttachment(handle: string): Promise<ResolveFileRefResult>;
}

/**
 * Mailgun stores inbound attachments behind its own API, and a bare GET 401s:
 * fetching one takes HTTP Basic auth with the same key the inbound webhook is
 * authenticated by. The handle IS the storage URL.
 */
const MAILGUN_PROVIDER: EmailProvider = {
  slug: 'mailgun',
  callbackPath: '/api/mailgun/callback',
  owns(handle) {
    try {
      const url = new URL(handle);
      return url.protocol === 'https:' && (url.hostname === 'mailgun.net' || url.hostname.endsWith('.mailgun.net'));
    } catch {
      return false;
    }
  },
  async fetchAttachment(handle) {
    const key = getEnvVar('MAILGUN_API_KEY', { devDefault: 'fake_mailgun_key' });
    return fetchUrlToStream(handle, {
      headers: { Authorization: `Basic ${Buffer.from(`api:${key}`).toString('base64')}` },
    });
  },
};

/**
 * Resend's handles are a pair of ids, because the URL it hands out dies after
 * an hour — shorter than the life of a stored trigger event. The URL is minted
 * at the moment the bytes are wanted, and the download itself needs no auth.
 */
const RESEND_PROVIDER: EmailProvider = {
  slug: 'resend',
  callbackPath: '/api/resend/callback',
  owns(handle) {
    return parseResendAttachmentHandle(handle) !== null;
  },
  async fetchAttachment(handle) {
    const ref = parseResendAttachmentHandle(handle);
    if (ref === null) {
      throw new Error(`Not a Resend attachment handle: ${handle}`);
    }
    return fetchUrlToStream(await mintAttachmentDownloadUrl(ref));
  },
};

const EMAIL_PROVIDERS: readonly EmailProvider[] = [RESEND_PROVIDER, MAILGUN_PROVIDER];

/**
 * The provider this deployment's `email` runs through. Mailgun is the answer
 * when nothing is configured, which is not a fallback so much as the shape of
 * the old world: its door then fails closed in production for want of a key,
 * and in development the test harness supplies one.
 */
function resolveEmailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  if (env.RESEND_API_KEY) return RESEND_PROVIDER;
  return MAILGUN_PROVIDER;
}

/** Whether both providers are configured — a state worth saying out loud. */
function emailProvidersOverlap(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY) && Boolean(env.MAILGUN_API_KEY);
}

/**
 * The bytes behind a stored attachment handle, from the provider that stored
 * it. Every inbound email arrives through one of the providers — Mailgun's
 * form, whose attachment `url` is its storage URL and becomes the handle
 * (`normaliseInboundEmailPayload`), or Resend's id pair
 * (`resendAttachmentHandle`) — so a handle no provider claims was not issued
 * to this adapter, and is refused by name, never fetched.
 */
async function fetchEmailAttachment(handle: string): Promise<ResolveFileRefResult> {
  const owner = EMAIL_PROVIDERS.find((provider) => provider.owns(handle));
  if (owner !== undefined) return owner.fetchAttachment(handle);
  throw new FileOutsideTeamError('handle', 'email');
}

export {
  EMAIL_PROVIDERS,
  MAILGUN_PROVIDER,
  RESEND_PROVIDER,
  emailProvidersOverlap,
  fetchEmailAttachment,
  resolveEmailProvider,
  type EmailProvider,
  type EmailProviderSlug,
};
