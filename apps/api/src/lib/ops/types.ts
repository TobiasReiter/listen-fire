import type { SlackNotificationType } from '../slack';

import OpsEventType from '../../generated/kysely/public/OpsEventType';
import OpsSeverity from '../../generated/kysely/public/OpsSeverity';
import OpsDetailLevel from '../../generated/kysely/automations/OpsDetailLevel';

export { OpsEventType, OpsSeverity, OpsDetailLevel };

const DETAIL_RANK: Record<OpsDetailLevel, number> = {
  [OpsDetailLevel.low]: 0,
  [OpsDetailLevel.medium]: 1,
  [OpsDetailLevel.full]: 2,
};

export function meetsDetailLevel(teamLevel: OpsDetailLevel, required: OpsDetailLevel): boolean {
  return DETAIL_RANK[teamLevel] >= DETAIL_RANK[required];
}

export type OpsEventInput = {
  type: OpsEventType;
  severity?: OpsSeverity;
  teamId?: string | null;
  title: string;
  detail?: unknown;
  entityRefs?: unknown;
};

export function shouldPush(severity: OpsSeverity): boolean {
  return severity === OpsSeverity.warn || severity === OpsSeverity.critical;
}

// SlackNotificationType members are identical strings to OpsEventType members.
export function opsTypeFromSlack(type: SlackNotificationType): OpsEventType {
  return type as unknown as OpsEventType;
}

// Slack `text` carries wiki-ish formatting that reads as noise in the feed:
// `*bold*`, `_italic_`, `~strike~`, and `<url|label>` links. Strip the markers
// but keep the words — and only unwrap emphasis at word boundaries so
// identifiers like `log_whatsapp_dealflow` survive untouched. Emoji shortcodes
// (`:tada:`) are left for the client's EmojiText to expand.
function stripSlackFormatting(line: string): string {
  return line
    .replace(/<([^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, (_m, inner: string) => inner.replace(/^[@#!]/, ''))
    .replace(/(^|\s)\*([^*]+)\*(?=\s|[.,!?:;)]|$)/g, '$1$2')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,!?:;)]|$)/g, '$1$2')
    .replace(/(^|\s)~([^~]+)~(?=\s|[.,!?:;)]|$)/g, '$1$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function deriveTitle(text?: string): string {
  if (!text) return '(no title)';
  const firstLine = stripSlackFormatting(text.split('\n')[0].trim());
  if (firstLine.length <= 120) return firstLine;

  let truncated = firstLine.slice(0, 117);
  // Don't cut inside an emoji shortcode (e.g. `:tada:`) — a dangling opening
  // colon would render as literal text instead of being emojified. If the
  // tail after the last colon has no closing colon and looks like a partial
  // shortcode, drop it back to before that colon.
  const lastColon = truncated.lastIndexOf(':');
  if (lastColon !== -1 && /^:[a-z0-9_+-]*$/.test(truncated.slice(lastColon))) {
    truncated = truncated.slice(0, lastColon).trimEnd();
  }
  return truncated + '…';
}

export function retentionCutoff(now: Date, days = 14): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
