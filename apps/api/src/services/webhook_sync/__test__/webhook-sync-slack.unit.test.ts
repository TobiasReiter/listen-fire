/**
 * Unit tests for the Slack WebhookProvider (I1).
 *
 * Covers the surface the I1 brief requires:
 *
 *   1. `parseEvents` on the wave-1 golden-path fixture produces exactly
 *      one normalised `WebhookEvent` whose `rawPayload` is the inner Slack
 *      event (so the source-side SlackAdapter can read text/user/channel/
 *      files directly off the source position's `data`).
 *   2. `parseEvents` returns [] for `url_verification` and unknown
 *      envelope types — those aren't dispatchable events.
 *   3. `verifySignature` accepts a payload signed with the documented
 *      Slack scheme (`v0=` + HMAC-SHA256(secret, `v0:{ts}:{rawBody}`))
 *      and rejects tampered ones.
 *   4. End-to-end fixture round-trip: parseEvents produces a
 *      `rawPayload` shape the registered SlackAdapter consumes via
 *      `getFieldValue` (body/scalars) and the explicit `files` edge
 *      (attachments) without throwing — the provider's normalisation is
 *      wire-compatible with the adapter that consumes events from
 *      `routeTrigger`.
 *   5. The provider is registered under the 'SLACK' key.
 *
 * Deliberately doesn't bring up the full `handleInboundWebhook` path —
 * that would require a DB + a trigger_entry row. The fixture + adapter
 * round-trip is the strongest claim a unit test can make: anything that
 * gets past `parseEvents` is shaped the way the TG runtime expects.
 */

import crypto from "node:crypto";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { slackProvider, parseSlackEvents } from '../providers/slack';
// Avoid importing '../providers' (the aggregate index) because it pulls in
// the attio provider at module load, which requires ENCRYPTION_MASTER_KEY
// at import time. We verify the registration structurally instead by
// reading the source — see "registered under the SLACK key" below.
import {
  SlackAdapter,
  SLACK_ADAPTER_TYPE,
} from '../../translation_graph/adapters/slack';
import {
  type SourcePosition,
  makeStablePosition,
} from 'movement-engine/services/translation_graph/types';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'translation_graph',
  '__fixtures__',
  'wave-1-golden-path',
  'synthetic-slack-message.json',
);

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'));
}

function fixtureRawBody(): Buffer {
  // Deterministic body — exactly what would arrive over the wire. Used
  // for HMAC tests so the signature math is reproducible.
  return Buffer.from(readFileSync(FIXTURE_PATH, 'utf-8'), 'utf-8');
}

describe('slackProvider — registration', () => {
  it('is registered under the SLACK provider key', () => {
    // Structural check (avoids importing the aggregate provider registry,
    // which transitively loads attio.ts → lib/credentials.ts → demands
    // ENCRYPTION_MASTER_KEY at unit-test time). The contract we care about
    // is that webhook_sync/providers/index.ts maps the literal 'SLACK' to
    // the slackProvider — grep the source for that pairing.
    const src = readFileSync(
      join(__dirname, '..', 'providers', 'index.ts'),
      'utf-8',
    );
    expect(src).toMatch(/SLACK:\s*slackProvider/);
  });

  it('is manual-mode (canRegisterViaApi=false) with operator setup instructions', () => {
    expect(slackProvider.canRegisterViaApi).toBe(false);
    expect(slackProvider.setupInstructions).toBeTruthy();
    expect(slackProvider.setupInstructions).toMatch(/Signing Secret/);
  });

  it('exposes the slack default event types', () => {
    expect(slackProvider.defaultEventTypes).toContain('message');
  });
});

describe('slackProvider.parseEvents — golden-path fixture', () => {
  it('produces exactly one WebhookEvent from the synthetic slack message fixture', () => {
    const events = parseSlackEvents(loadFixture());
    expect(events).toHaveLength(1);
  });

  it('normalises Slack record/event ids into the framework shape', () => {
    const [event] = parseSlackEvents(loadFixture());
    expect(event.eventType).toBe('message');
    expect(event.recordId).toBe('1747836000.000100');
    expect(event.objectId).toBe('slack:message');
    expect(event.actor).toBeUndefined();
    expect(event.changedFields).toBeUndefined();
  });

  it('forwards the inner event as rawPayload (not the envelope)', () => {
    const [event] = parseSlackEvents(loadFixture());
    expect(event.rawPayload).toMatchObject({
      type: 'message',
      user: 'U_ALICE',
      channel: 'C_DEALFLOW',
      ts: '1747836000.000100',
      text: expect.stringContaining('Acme AI'),
      files: expect.any(Array),
    });
  });
});

describe('slackProvider.parseEvents — non-dispatchable envelopes', () => {
  it('returns [] for url_verification (handled by the REST layer)', () => {
    const events = parseSlackEvents({
      type: 'url_verification',
      challenge: 'abc-123',
    });
    expect(events).toEqual([]);
  });

  it('returns [] for app_rate_limited', () => {
    const events = parseSlackEvents({
      type: 'app_rate_limited',
      api_app_id: 'A123',
    });
    expect(events).toEqual([]);
  });

  it('returns [] for malformed payloads', () => {
    expect(parseSlackEvents({})).toEqual([]);
    expect(parseSlackEvents(null)).toEqual([]);
    expect(parseSlackEvents('not-an-object')).toEqual([]);
  });

  it('returns [] for event_callback without an event field', () => {
    expect(
      parseSlackEvents({ type: 'event_callback', team_id: 'T1' }),
    ).toEqual([]);
  });
});

describe('slackProvider.verifySignature — Slack v0 HMAC scheme', () => {
  const SECRET = 'slack-signing-secret';

  function signWith(rawBody: Buffer, secret: string, timestamp: string): string {
    const base = `v0:${timestamp}:${rawBody.toString('utf-8')}`;
    const digest = crypto.createHmac('sha256', secret).update(base).digest('hex');
    return `${timestamp}:v0=${digest}`;
  }

  it('accepts a correctly signed request', () => {
    const rawBody = fixtureRawBody();
    const ts = '1700000000';
    const header = signWith(rawBody, SECRET, ts);
    expect(slackProvider.verifySignature(rawBody, header, SECRET)).toBe(true);
  });

  it('accepts a signature without the `v0=` prefix (raw hex)', () => {
    const rawBody = fixtureRawBody();
    const ts = '1700000000';
    const base = `v0:${ts}:${rawBody.toString('utf-8')}`;
    const digest = crypto.createHmac('sha256', SECRET).update(base).digest('hex');
    const header = `${ts}:${digest}`;
    expect(slackProvider.verifySignature(rawBody, header, SECRET)).toBe(true);
  });

  it('rejects when the body has been tampered with', () => {
    const ts = '1700000000';
    const header = signWith(fixtureRawBody(), SECRET, ts);
    const tampered = Buffer.from(fixtureRawBody().toString('utf-8') + ' '); // extra byte
    expect(slackProvider.verifySignature(tampered, header, SECRET)).toBe(false);
  });

  it('rejects when the secret is wrong', () => {
    const rawBody = fixtureRawBody();
    const ts = '1700000000';
    const header = signWith(rawBody, SECRET, ts);
    expect(slackProvider.verifySignature(rawBody, header, 'wrong-secret')).toBe(false);
  });

  it('rejects when the timestamp is missing from the packed header', () => {
    const rawBody = fixtureRawBody();
    expect(slackProvider.verifySignature(rawBody, '', SECRET)).toBe(false);
    expect(slackProvider.verifySignature(rawBody, ':v0=deadbeef', SECRET)).toBe(false);
  });
});

describe('slackProvider — wire-compatibility with SlackAdapter', () => {
  // End-to-end shape claim: the rawPayload produced by parseEvents is
  // exactly what the engine-side SlackAdapter expects to see on a source
  // position's `data` field. If this round-trip works without throwing
  // and the adapter reads the documented scalars + resources, an event
  // arriving via /api/public/webhook-sync/slack/<sub-id> would land at
  // `routeTrigger` with a payload the engine can evaluate.

  function buildSourcePositionFromEvent(rawPayload: unknown, recordId: string): SourcePosition {
    // The live inbound path lands a source position CARRYING ITS TYPE: the
    // event seed stamps the discriminated event's `positionType`, and the
    // engine prefers the program's declared natural type name.
    //
    // This said the position arrives with `recordType: null`, sourcing that to
    // `webhook_sync/handler.ts` — which mints no source position at all, and
    // may never have. The claim outlived whatever made it true, and a fixture
    // asserting an untyped position kept passing by exercising a shape the
    // live path doesn't produce.
    //
    // Field/edge names are the natural display names ('Message', 'User', …),
    // not the internal field ids.
    return makeStablePosition({
      adapterType: SLACK_ADAPTER_TYPE,
      recordType: 'Message',
      recordId,
      data: rawPayload,
    });
  }

  it("the provider's rawPayload feeds the adapter's getFieldValue cleanly", async () => {
    const [event] = parseSlackEvents(loadFixture());
    const adapter = new SlackAdapter('team-1' as TeamId);
    const position = buildSourcePositionFromEvent(event.rawPayload, event.recordId);

    expect(await adapter.getFieldValue({ position, fieldId: 'Message' })).toMatch(
      /Acme AI/,
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'User' })).toBe('U_ALICE');
    expect(await adapter.getFieldValue({ position, fieldId: 'Channel' })).toBe(
      'C_DEALFLOW',
    );
    expect(await adapter.getFieldValue({ position, fieldId: 'Timestamp' })).toBe(
      '2025-05-21T14:00:00.000Z',
    );
  });

  it("the provider's rawPayload exposes the body as a field and the file via the explicit `files` edge", async () => {
    const [event] = parseSlackEvents(loadFixture());
    const adapter = new SlackAdapter('team-1' as TeamId);
    const position = buildSourcePositionFromEvent(event.rawPayload, event.recordId);

    // The body is a plain field read — no resource bundle. (The input-side
    // `_resources` reference was retired: `_resources` is now extraction
    // provenance, reached off an extracted node, never off the input.)
    expect(await adapter.getFieldValue({ position, fieldId: 'Message' })).toMatch(/Acme AI/);

    // The attachment is reached as a `slack:file` record off the explicit
    // `files` edge — the lossless replacement for the old `_resources` bundle.
    const files = await adapter.getRelated({
      position,
      // The NATURAL edge name. The adapter interface trades in display names;
      // the internal id `files` is not something a caller may name.
      fieldId: 'Files',
      direction: 'outgoing',
    });
    const fileRecords = files.map(
      (r) => r.position.identity.data as { contentType: string | null; url: string | null },
    );
    // One FILE attachment from the fixture's `files[0]`.
    expect(fileRecords).toHaveLength(1);
    expect(fileRecords[0]?.contentType).toBe('application/pdf');
    expect(fileRecords[0]?.url).toContain('files.slack.com');
  });
});
