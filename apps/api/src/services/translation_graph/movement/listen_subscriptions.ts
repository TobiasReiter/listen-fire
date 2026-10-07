// Listen-driven event-subscription diff-sync.
//
// Movement `listen` statements on adapters whose events arrive by EXTERNAL
// subscription (webhooks) need a source-side registration. This module
// keeps that registration in lockstep with the team's listens:
//
//   - the platform owns ONE `webhook_subscription` row per (adapter,
//     credential) channel, marked `provisioned_by = 'movement-listen'` —
//     the row id keys the stable callback URL
//     (`webhook_sync/urls.ts:buildWebhookTargetUrl`), so reconciliation
//     never changes inbound URLs (6_engine.md: the URL is keyed to the
//     instance, not the listen);
//   - the desired event set per channel is the union of every listen's
//     `events` config, defaulting to the manifest's full
//     `subscribableEvents` for listens that don't narrow;
//   - `Adapter.ensureEventSubscription` / `removeEventSubscription` own
//     the source-system API calls (attio: real webhook create/PATCH/
//     delete); the platform persists what the source issued (externalId +
//     HMAC secret — the webhook_sync handler verifies inbound deliveries
//     against it);
//   - a channel whose last listen disappeared is torn down: the external
//     registration removed, the row soft-deleted. Operator-created rows
//     (Settings UI; `provisioned_by` NULL) are never touched.
//
// Called from movement save/delete (provision.ts) AFTER trigger rows are
// reconciled, so the trigger table IS the desired state — the sync is
// global per team and idempotent. Failures never block a save: they come
// back as notes (the listens still hold; a later save retries).

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';
import type { WebhookSubscriptionId } from '../../../generated/kysely/automations/WebhookSubscription';
import { getQb, getAutomationsQb } from '../../../lib/kysely';
import { logger } from '../../logger';
import { buildWebhookTargetUrl, webhookProviderKey } from '../../webhook_sync/urls';
import { UNREGISTERED_SECRET } from '../../webhook_sync/remote_inbound';
import type { AdapterManifest } from '../adapter';
import { resolveAdapterSlug } from '../adapters/registry';
import { resolveAdapter } from '../adapters/resolve';
import { teamAdapterManifests } from '../adapters/team_manifests';
import { eventConfigList } from '../triggers/listen_config';
import { canonicalAddress, resolvedAddressOfJson } from './listen_address';

export const MOVEMENT_LISTEN_PROVISIONER = 'movement-listen';

/** One subscription channel's desired registration. A channel is keyed by
 *  (adapter, credential) and — for adapters that declare `subscriptionScopeKeys`
 *  — the per-channel `scope` (Airtable's `{ base, table }`). `credentialsId` is
 *  null for credential-free intrinsic channels (the cron adapter — its
 *  registration is platform-internal). */
interface DesiredChannel {
  slug: string;
  /** The webhook_subscription `provider` key (the inbound route segment) —
   *  the adapter's legacy trigger-kind alias, falling back to the slug. */
  providerKey: string;
  credentialsId: string | null;
  events: string[];
  /** Adapter-declared per-channel scope (`subscriptionScopeKeys` config
   *  values). `{}` for adapters with no scope keys. */
  scope: Record<string, string>;
}

interface SubscriptionRow {
  id: string;
  provider: string;
  credentialsId: string | null;
  externalWebhookId: string | null;
  events: string[];
  scope: Record<string, string>;
}

/** Same (key → value) scope. `{}` vs `{}` is the unscoped match. */
function sameScope(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => a[k] === b[k]);
}

/** Parse a `webhook_subscription.scope` jsonb cell into a flat string map.
 *  Tolerates a serialized string (test fakes) and a null cell (unscoped). */
function scopeOfJson(rawValue: unknown): Record<string, string> {
  let raw = rawValue;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (raw === null || typeof raw !== 'object') return {};
  const scope: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') scope[k] = v;
  }
  return scope;
}

/** The events a `webhook_subscription.subscriptions` jsonb holds
 *  (`[{ event_type }]` — the webhook_sync shape). Tolerates a serialized
 *  string (jsonb normally arrives parsed; test fakes may not parse). */
function eventsOfSubscriptionsJson(rawValue: unknown): string[] {
  let raw = rawValue;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  const events: string[] = [];
  for (const entry of raw) {
    const eventType = (entry as { event_type?: unknown } | null)?.event_type;
    if (typeof eventType === 'string') events.push(eventType);
  }
  return events;
}

function sameEventSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((e) => b.includes(e));
}

/**
 * The team's desired channels, read straight off the movement-derived
 * trigger rows (reconciliation has already saved them, so the trigger
 * table IS the desired state). Only adapters that genuinely implement the
 * subscription seam (manifest `methods` carries `ensureEventSubscription`)
 * participate — built-ins and the team's remote installs alike.
 */
async function desiredChannels(
  teamId: TeamId,
  manifestBySlug: ReadonlyMap<string, AdapterManifest>,
  notes: string[],
): Promise<DesiredChannel[]> {

  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('team_id', '=', teamId)
    .where('movement_id', 'is not', null)
    .select(['name', 'kind', 'credentials_id', 'config', 'resolved_address'])
    .execute();

  const channels = new Map<string, DesiredChannel>();
  for (const row of rows) {
    const slug = resolveAdapterSlug(row.kind);
    const manifest = manifestBySlug.get(slug);
    if (!manifest) continue;
    if (!manifest.methods.includes('ensureEventSubscription')) continue;
    // A remote install's manifest carries no vocabulary (its event names are
    // the remote's own), so the listen's selection passes through unfiltered
    // and an empty one means "everything it offers". Every built-in that
    // subscribes declares a vocabulary.
    const vocabulary = manifest.subscribableEvents;
    if (vocabulary !== undefined && vocabulary.length === 0) continue;
    // Credential-free adapters (the cron intrinsic) hold their channel
    // under a null credential; adapters that REQUIRE one can't register
    // without it.
    const credentialsId = row.credentials_id as unknown as string | null;
    if (credentialsId === null && manifest.requiredCredentialType !== undefined) {
      notes.push(
        `${slug}: a listener has no credential — cannot provision its event subscription`,
      );
      continue;
    }
    const config = (row.config ?? {}) as Record<string, unknown>;
    // `events` may be authored as a bare string or a list — normalise, then keep
    // only the ones in the adapter's vocabulary. An empty selection falls back to
    // the full vocabulary (subscribe to everything the adapter offers).
    const authored = eventConfigList(config.events);
    const requested =
      vocabulary === undefined ? authored : authored.filter((e) => vocabulary.includes(e));
    const events = requested.length > 0 || vocabulary === undefined ? requested : [...vocabulary];

    // Per-channel scope — CHANNEL IDENTITY IS THE RESOLVED ADDRESS. Each
    // `subscriptionScopeKeys` value comes from the trigger's `resolved_address`
    // (the DERIVED full address provisioning resolved: position path + config
    // hops, names→ids), falling back per key to the authored config for rows
    // saved before resolution existed — a config-shaped row's values ARE the
    // ids, so old and new rows re-derive to the SAME channel key and the
    // transition costs nothing.
    //
    // A scope that doesn't cover every declared key is REFUSED, loudly. It used
    // to collapse toward the unscoped channel and then be "caught when
    // ensureEventSubscription can't form a scope" — measured 2026-07-17, that
    // catch was SILENT: the row was minted ACTIVE with a null external id, zero
    // notes, zero registrations, and every later sync short-circuited past it.
    // A half-scoped channel must be unrepresentable, not quietly inert.
    const resolvedAddress = resolvedAddressOfJson(row.resolved_address) ?? {};
    const scope: Record<string, string> = {};
    const missingScopeKeys: string[] = [];
    for (const scopeKey of manifest.subscriptionScopeKeys ?? []) {
      const value = resolvedAddress[scopeKey] ?? config[scopeKey];
      if (typeof value === 'string' && value.length > 0) scope[scopeKey] = value;
      else missingScopeKeys.push(scopeKey);
    }
    if (missingScopeKeys.length > 0) {
      notes.push(
        `${slug}: listener '${row.name}' has no resolved '${missingScopeKeys.join("', '")}' for its event subscription — no channel was provisioned; re-save its movement to resolve the address`,
      );
      continue;
    }

    const key = `${slug}::${credentialsId ?? ''}::${canonicalAddress(scope)}`;
    const existing = channels.get(key);
    if (existing) {
      for (const event of events) {
        if (!existing.events.includes(event)) existing.events.push(event);
      }
    } else {
      channels.set(key, {
        slug,
        providerKey: webhookProviderKey(manifest),
        credentialsId,
        events,
        scope,
      });
    }
  }
  return [...channels.values()];
}

async function provisionedRows(teamId: TeamId): Promise<SubscriptionRow[]> {
  const rows = await getAutomationsQb(['webhook_subscription'])
    .selectFrom('webhook_subscription')
    .where('team_id', '=', teamId)
    .where('provisioned_by', '=', MOVEMENT_LISTEN_PROVISIONER)
    .where('deleted_at', 'is', null)
    .select(['id', 'provider', 'credentials_id', 'external_webhook_id', 'subscriptions', 'scope'])
    .execute();
  return rows.map((r) => ({
    id: r.id as unknown as string,
    provider: r.provider,
    credentialsId: (r.credentials_id as unknown as string | null) ?? null,
    externalWebhookId: r.external_webhook_id,
    events: eventsOfSubscriptionsJson(r.subscriptions),
    scope: scopeOfJson(r.scope),
  }));
}

/**
 * Bring the team's external event subscriptions in line with its listens.
 * Idempotent; every failure is contained per channel and surfaced as a
 * note (a save never fails on a flaky source API — the next save retries).
 */
export async function syncListenSubscriptions(input: { teamId: TeamId }): Promise<{
  notes: string[];
}> {
  const notes: string[] = [];
  const manifests = await teamAdapterManifests(input.teamId, notes);
  const manifestBySlug = new Map(manifests.map((m) => [m.adapterType, m]));
  // A remote install's provider key is not a registry alias, so teardown maps
  // a row's key back to its slug through the same rule that minted it.
  const slugByProviderKey = new Map(manifests.map((m) => [webhookProviderKey(m), m.adapterType]));
  const desired = await desiredChannels(input.teamId, manifestBySlug, notes);
  const existing = await provisionedRows(input.teamId);

  const rowFor = (channel: DesiredChannel): SubscriptionRow | undefined =>
    existing.find(
      (r) =>
        r.provider === channel.providerKey &&
        r.credentialsId === channel.credentialsId &&
        sameScope(r.scope, channel.scope),
    );

  // ── Ensure each desired channel's registration ──
  for (const channel of desired) {
    const row = rowFor(channel);
    if (row && sameEventSet(row.events, channel.events)) continue;
    try {
      const adapter = await resolveAdapter({
        adapterType: channel.slug,
        teamId: input.teamId,
        ...(channel.credentialsId !== null ? { credentialsId: channel.credentialsId } : {}),
      });
      if (typeof adapter.ensureEventSubscription !== 'function') {
        notes.push(
          `${channel.slug}: manifest declares ensureEventSubscription but the adapter doesn't implement it — events will not arrive`,
        );
        continue;
      }

      if (row) {
        const registration = await adapter.ensureEventSubscription({
          events: channel.events,
          callbackUrl: buildWebhookTargetUrl(channel.providerKey, row.id),
          current: {
            ...(row.externalWebhookId !== null ? { externalId: row.externalWebhookId } : {}),
            events: row.events,
          },
          ...(Object.keys(channel.scope).length > 0 ? { scope: channel.scope } : {}),
        });
        await getAutomationsQb(['webhook_subscription'])
          .updateTable('webhook_subscription')
          .set({
            subscriptions: JSON.stringify(channel.events.map((e) => ({ event_type: e }))),
            ...(registration?.externalId !== undefined
              ? { external_webhook_id: registration.externalId }
              : {}),
            ...(registration?.secret !== undefined
              ? { webhook_secret: registration.secret }
              : {}),
            status: 'active',
            updated_at: new Date(),
          })
          .where('id', '=', row.id as WebhookSubscriptionId)
          .execute();
        continue;
      }

      // New channel: mint the row first (the row id IS the stable URL),
      // then register; a failed registration removes the placeholder so
      // the next save retries cleanly.
      const subscriptionId = randomUUID();
      await getAutomationsQb(['webhook_subscription'])
        .insertInto('webhook_subscription')
        .values({
          id: subscriptionId as WebhookSubscriptionId,
          team_id: input.teamId,
          provider: channel.providerKey,
          credentials_id: channel.credentialsId as ExternalServiceCredentialsId | null,
          webhook_secret: UNREGISTERED_SECRET,
          subscriptions: JSON.stringify(channel.events.map((e) => ({ event_type: e }))),
          ...(Object.keys(channel.scope).length > 0
            ? { scope: JSON.stringify(channel.scope) as never }
            : {}),
          status: 'pending',
          provisioned_by: MOVEMENT_LISTEN_PROVISIONER,
        })
        .execute();
      try {
        const registration = await adapter.ensureEventSubscription({
          events: channel.events,
          callbackUrl: buildWebhookTargetUrl(channel.providerKey, subscriptionId),
          ...(Object.keys(channel.scope).length > 0 ? { scope: channel.scope } : {}),
        });
        await getAutomationsQb(['webhook_subscription'])
          .updateTable('webhook_subscription')
          .set({
            external_webhook_id: registration?.externalId ?? null,
            ...(registration?.secret !== undefined
              ? { webhook_secret: registration.secret }
              : {}),
            status: 'active',
            updated_at: new Date(),
          })
          .where('id', '=', subscriptionId as WebhookSubscriptionId)
          .execute();
      } catch (err) {
        await getAutomationsQb(['webhook_subscription'])
          .deleteFrom('webhook_subscription')
          .where('id', '=', subscriptionId as WebhookSubscriptionId)
          .execute();
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[ListenSubscriptions] ensure failed', {
        teamId: input.teamId,
        adapter: channel.slug,
        credentialsId: channel.credentialsId,
        error: message,
      });
      notes.push(`${channel.slug}: event-subscription provisioning failed (${message})`);
    }
  }

  // ── Tear down channels whose last listen disappeared ──
  for (const row of existing) {
    const stillDesired = desired.some(
      (c) =>
        c.providerKey === row.provider &&
        c.credentialsId === row.credentialsId &&
        sameScope(c.scope, row.scope),
    );
    if (stillDesired) continue;
    const slug = slugByProviderKey.get(row.provider) ?? resolveAdapterSlug(row.provider);
    try {
      const adapter = await resolveAdapter({
        adapterType: slug,
        teamId: input.teamId,
        ...(row.credentialsId !== null ? { credentialsId: row.credentialsId } : {}),
      });
      if (typeof adapter.removeEventSubscription === 'function') {
        await adapter.removeEventSubscription({
          callbackUrl: buildWebhookTargetUrl(row.provider, row.id),
          ...(row.externalWebhookId !== null ? { externalId: row.externalWebhookId } : {}),
          ...(Object.keys(row.scope).length > 0 ? { scope: row.scope } : {}),
        });
      }
    } catch (err) {
      // Non-fatal — mirror the Settings-UI delete: still retire locally;
      // a dangling source-side webhook posts at a row that no longer
      // verifies, and is removable by hand.
      notes.push(
        `${slug}: external deregistration failed (${err instanceof Error ? err.message : String(err)}) — subscription retired locally`,
      );
    }
    await getAutomationsQb(['webhook_subscription'])
      .updateTable('webhook_subscription')
      .set({ deleted_at: new Date(), status: 'disabled', updated_at: new Date() })
      .where('id', '=', row.id as WebhookSubscriptionId)
      .execute();
  }

  return { notes };
}
