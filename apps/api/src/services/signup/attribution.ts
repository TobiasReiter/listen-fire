// Signup attribution — the acquisition channel (auth method) + marketing UTM /
// referrer, captured transiently from the signup URL (no client cookie) and
// written to `signup_event` on new-account creation. Read by the admin app.

import type { TeamId } from '../../generated/kysely/core/Team';

import { getQb } from '../../lib/kysely';
import { logger } from '../logger';

export interface SignupAttribution {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  referrer?: string | null;
}

const MAX_LEN = 512;

/** One sanitised field from untrusted input: a trimmed string capped at MAX_LEN,
 *  or null for anything non-string / empty. */
function field(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, MAX_LEN);
}

/** Parse attribution from an UNTRUSTED request body. Returns undefined when
 *  nothing usable is present. Accepts either snake_case (utm_source) or
 *  camelCase (utmSource) keys — whatever the client sends. */
export function parseAttribution(raw: unknown): SignupAttribution | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const attribution: SignupAttribution = {
    utmSource: field(r.utmSource ?? r.utm_source),
    utmMedium: field(r.utmMedium ?? r.utm_medium),
    utmCampaign: field(r.utmCampaign ?? r.utm_campaign),
    utmTerm: field(r.utmTerm ?? r.utm_term),
    utmContent: field(r.utmContent ?? r.utm_content),
    referrer: field(r.referrer),
  };
  const hasAny = Object.values(attribution).some((v) => v !== null);
  return hasAny ? attribution : undefined;
}

/**
 * Record a signup event for a NEW account. Best-effort — a failure here must
 * never break the signup (mirrors the trial-grant / activity discipline).
 */
export async function recordSignupEvent(input: {
  email: string;
  teamId: TeamId;
  channel: string;
  attribution?: SignupAttribution | null;
}): Promise<void> {
  try {
    const a = input.attribution ?? {};
    await getQb(['signup_event'])
      .insertInto('signup_event')
      .values({
        email: input.email.toLowerCase(),
        team_id: input.teamId,
        channel: input.channel,
        utm_source: a.utmSource ?? null,
        utm_medium: a.utmMedium ?? null,
        utm_campaign: a.utmCampaign ?? null,
        utm_term: a.utmTerm ?? null,
        utm_content: a.utmContent ?? null,
        referrer: a.referrer ?? null,
      })
      .execute();
  } catch (err) {
    logger.error('[signup] failed to record signup_event', {
      teamId: input.teamId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
