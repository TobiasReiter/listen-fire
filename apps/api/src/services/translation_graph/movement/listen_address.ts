// The listen's RESOLVED ADDRESS — the position's path + the config's hops,
// names → ids, resolved by the walk at provisioning time.
//
// CHANNEL IDENTITY IS THE RESOLVED ADDRESS (plans/2026-07-10-adapter-entry-
// positions/8_event_edges.md, the leak-gate ruling). One rule answers
// three questions at once:
//
//   - WHERE the position's contribution to a subscription channel persists:
//     here, resolved once at provisioning and stored on the trigger row as a
//     DERIVED field (`trigger.resolved_address`), separate from the authored
//     `config` — authored and derived never share a bag;
//   - WHO resolves names → ids: the same walk the narrowing machinery already
//     does (`membersAt` over the adapter's declared `narrows` hops), so the
//     checker and the host derive one address and cannot drift;
//   - EQUIVALENCE across the transition: an old config-shaped row re-derives to
//     the same address (its config values ARE the ids), so
//     `canonicalAddress` keys old and new rows onto ONE channel — no
//     double-register, no churn, and vendor-unique table ids stop doing
//     identity's job by accident.
//
// A FAILED RESOLUTION IS A SAVE ERROR, never a silently-dead listen. The
// driven finding this kills: a half-scoped channel used to be minted ACTIVE
// with a null external id and zero notes (`b536a1a79`-adjacent measurement,
// 2026-07-17) — the registration silently impossible while the row claimed
// health. Provisioning now refuses to derive a trigger whose address doesn't
// resolve, and the reconciler refuses to mint a half-scoped channel
// (listen_subscriptions.ts), so that state is unrepresentable.

import type { ListenConfigKey } from 'movement-engine/public/adapter';
import type { CachedAdapterInstance } from './instance_cache';

import { hopStep, type AddressStep } from './listen_narrowing';

/** The hops that form an adapter's event address, in declaration order. */
export function addressHops(
  listenConfig: readonly ListenConfigKey[] | undefined,
): Array<ListenConfigKey & { narrows: NonNullable<ListenConfigKey['narrows']> }> {
  return (listenConfig ?? []).flatMap((key) =>
    key.narrows !== undefined ? [{ ...key, narrows: key.narrows }] : [],
  );
}

/**
 * The LEADING address hops an instance's entry position consumes — the hops a
 * positioned instance's listens (and signatures) no longer name, because the
 * construction already walked the cursor past them: `airtable(credentials: c,
 * base: "Dev Base")` consumes `base`, so the address relative to that instance
 * is `table` alone.
 *
 * LEADING only: a position can't supply a later hop without the ones before
 * it (a pinned crate with no shelf addresses nothing), so consumption stops at
 * the first hop the position doesn't pin.
 *
 */
export function positionConsumedHopKeys(input: {
  listenConfig: readonly ListenConfigKey[] | undefined;
  /** The instance's entry-position values (construction args, unquoted),
   *  keyed by position-arg name. */
  positionValues: Record<string, string>;
}): Set<string> {
  const consumed = new Set<string>();
  for (const hop of addressHops(input.listenConfig)) {
    if (input.positionValues[hop.key] === undefined) break;
    consumed.add(hop.key);
  }
  return consumed;
}

/**
 * The canonical spelling of a resolved address — the CHANNEL KEY's address
 * half. Opaque by contract: compared, never parsed. Deliberately the same
 * `k=v&…` sorted spelling `desiredChannels` always used for config-derived
 * scopes, so a pre-resolution subscription row and a resolved one key onto the
 * SAME channel (the transition is free).
 */
export function canonicalAddress(address: Record<string, string>): string {
  return Object.entries(address)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** A jsonb cell → the resolved-address map it holds, or undefined when the
 *  cell is null/malformed (a legacy row — the caller falls back to config). */
export function resolvedAddressOfJson(rawValue: unknown): Record<string, string> | undefined {
  let raw = rawValue;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const address: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') return undefined;
    address[k] = v;
  }
  return Object.keys(address).length > 0 ? address : undefined;
}

export type ListenAddressResolution =
  | { ok: true; address: Record<string, string> }
  | { ok: false; reason: string };

/** The label a position-arg value names a member by — the author types the
 *  member's display label (`base: "Dev Base"`), never its id. Mirrors the
 *  catalog's `optionLabelOf` (the same convention that produced the options
 *  enum the checker validated the arg against, so the two cannot drift). */
function memberLabel(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['Title', 'Name', 'name', 'title']) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string;
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function memberValue(data: unknown, matchField: string): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)[matchField];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve one listen's FULL address: for each declared hop, the pinned value —
 * from the listen's config (already an id; validated against the hop's
 * members), or from the instance's entry position (a display name; resolved to
 * the id the hop matches on). The walk is `membersAt` hop by hop, so a
 * two-hop address costs 1 + 1 and a hop nobody pins is never opened — and at
 * save time those hops are already in the instance cache from the checker's
 * own walk, so resolution normally costs nothing extra.
 *
 * Every declared hop must resolve or the whole address fails — a
 * partially-resolved address would key a channel that can't register, which is
 * the silently-dead state this module exists to kill.
 */
export async function resolveListenAddress(input: {
  /** The adapter's declared listen-config keys (all of them — the hops are
   *  filtered here so every caller slices identically). */
  listenConfig: readonly ListenConfigKey[] | undefined;
  /** The listen's config block, statically evaluated. */
  config: Record<string, unknown>;
  /** The instance's entry-position values (construction args, unquoted),
   *  keyed by position-arg name. The position supplies the hops the listen
   *  doesn't name. */
  positionValues: Record<string, string>;
  membersAt: CachedAdapterInstance['membersAt'];
}): Promise<ListenAddressResolution> {
  const hops = addressHops(input.listenConfig);
  if (hops.length === 0) return { ok: true, address: {} };

  const address: Record<string, string> = {};
  const steps: AddressStep[] = [];
  for (const hop of hops) {
    const configValue =
      typeof input.config[hop.key] === 'string' && (input.config[hop.key] as string).length > 0
        ? (input.config[hop.key] as string)
        : undefined;
    const positionValue = input.positionValues[hop.key];
    if (configValue === undefined && positionValue === undefined) {
      return {
        ok: false,
        reason: `the listen names no '${hop.key}' and the instance isn't positioned at one`,
      };
    }

    const members = await input.membersAt({ steps, recordType: hop.narrows.collection });
    if (members.length === 0) {
      return {
        ok: false,
        reason: `couldn't enumerate the connection's ${hop.narrows.collection} options to resolve '${hop.key}' — the connection may be unreachable`,
      };
    }

    const fromConfig =
      configValue !== undefined
        ? members.find((m) => memberValue(m.data, hop.narrows.matchField) === configValue)
        : undefined;
    if (configValue !== undefined && fromConfig === undefined) {
      const known = members
        .map((m) => memberValue(m.data, hop.narrows.matchField))
        .filter((v): v is string => v !== undefined);
      return {
        ok: false,
        reason: `'${hop.key}' "${configValue}" isn't one this connection can see — it has: ${known.join(', ')}`,
      };
    }

    // A position arg names the member by LABEL (the author types "Dev Base");
    // an id spelling is accepted too, so a listen and a construction can never
    // disagree about how a member may be named.
    const fromPosition =
      positionValue !== undefined
        ? members.find(
            (m) =>
              memberLabel(m.data) === positionValue ||
              memberValue(m.data, hop.narrows.matchField) === positionValue,
          )
        : undefined;
    if (configValue === undefined && fromPosition === undefined) {
      const known = members.map((m) => memberLabel(m.data)).filter((v): v is string => v !== undefined);
      return {
        ok: false,
        reason: `the instance is positioned at '${hop.key}' "${positionValue}", which isn't one this connection can see — it has: ${known.join(', ')}`,
      };
    }

    const configResolved = fromConfig ? memberValue(fromConfig.data, hop.narrows.matchField) : undefined;
    const positionResolved = fromPosition
      ? memberValue(fromPosition.data, hop.narrows.matchField)
      : undefined;
    if (
      configResolved !== undefined &&
      positionResolved !== undefined &&
      configResolved !== positionResolved
    ) {
      return {
        ok: false,
        reason: `the listen's '${hop.key}' "${configValue}" disagrees with the instance's position "${positionValue}" — a listen's address is relative to the instance's position, so drop the '${hop.key}' from the listen or align them`,
      };
    }

    const value = configResolved ?? positionResolved;
    if (value === undefined) {
      return {
        ok: false,
        reason: `'${hop.key}' resolved to a member with no '${hop.narrows.matchField}' — the adapter published no id for it`,
      };
    }
    address[hop.key] = value;
    steps.push(hopStep({ narrows: hop.narrows, value }));
  }
  return { ok: true, address };
}
