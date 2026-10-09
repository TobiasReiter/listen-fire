import { emojify } from 'node-emoji';

import { OpsEvent } from '../../generated/kysely/public/OpsEvent';

const BODY_CAP = 500;

export type PushPayload = { title: string; body: string };

export function renderPushPayload(event: OpsEvent): PushPayload {
  const detail = (event.detail ?? {}) as { text?: string };
  const raw = typeof detail.text === 'string' ? detail.text : '';
  // Emojify first so shortcodes expand before we measure/cap length.
  const expanded = emojify(raw);
  // Slice by codepoint (not UTF-16 unit) so truncation never splits a surrogate pair.
  const chars = [...expanded];
  const body = chars.length > BODY_CAP ? chars.slice(0, BODY_CAP - 1).join('') + '…' : expanded;
  const title = emojify(`${event.type} · ${event.title}`);
  return { title, body };
}
