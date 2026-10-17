// The secrets host family: where a credential's fields are read from, written
// back to, and refreshed through, whatever stores them (a SOPS or plain file
// and the environment for lf, the encrypted credentials table for the
// platform, an embedder's vault). A store implements `SecretsBackend`; every
// shell drives it through the one `SecretsFamily` below, so the rules a
// refresh must keep are stated once:
//
// - A write-back names the version it was computed from, and is refused when
//   the stored credential has moved on (compare-and-swap), so a write never
//   silently undoes somebody else's.
// - A refresh runs at most once at a time per credential: in this process by
//   sharing the one in flight, across processes by the store's own lock. The
//   refresher runs only if the stored credential is still the one the caller
//   found stale; otherwise somebody else already refreshed it, and their
//   result is the answer. Two callers never spend the same refresh token.
// - A store that could not keep a rotated token refuses before the token is
//   spent, not after.
// - No secret value reaches a log, a warning or an error message.

import { createHash } from 'node:crypto';

/** A credential's fields, every value a string (`expires_at` an ISO time). */
export type SecretFields = Readonly<Record<string, string>>;

/** A credential as stored, with the version a write-back must name. */
export interface SecretRecord {
  readonly fields: SecretFields;
  /** Opaque; changes whenever the stored credential changes. */
  readonly version: string;
}

export type WriteBackOutcome =
  /** Stored. */
  | { kind: 'written'; record: SecretRecord }
  /** Kept for this process only: the store is read-only (the environment).
   *  `why` names the credential and the store, never a value. */
  | { kind: 'not_persisted'; record: SecretRecord; why: string }
  /** The stored credential is no longer at the expected version. */
  | { kind: 'conflict'; current: SecretRecord }
  | { kind: 'missing' };

/** What a store implements. `ref` is the store's own name for a credential:
 *  a name in a secrets file, a row id in the credentials table. */
export interface SecretsBackend {
  resolve(ref: string): Promise<SecretRecord | null>;
  /** Merge `fields` over the stored ones, if the stored version is still
   *  `expectedVersion`. Fields not named are kept. */
  writeBack(ref: string, fields: SecretFields, expectedVersion: string): Promise<WriteBackOutcome>;
  /** Run `body` holding this credential's lock against every other holder of
   *  the store, other processes included, with a view of the store that reads
   *  through any cache. Absent: the store has one process, and the family's
   *  own single flight is the lock. */
  exclusive?<T>(ref: string, body: (store: SecretsBackend) => Promise<T>): Promise<T>;
  /** Throw if a write-back of `ref` could not be stored, so a refresh is
   *  refused before it spends a refresh token whose rotation would be lost. */
  assertWritable?(ref: string): Promise<void>;
}

/** Computes the fields a refresh changes (`access_token`, `expires_at`, a
 *  rotated `refresh_token`, …) from the credential as stored. */
export type Refresher = (current: SecretRecord) => Promise<SecretFields>;

export class SecretMissing extends Error {
  constructor(readonly ref: string) {
    super(`credential "${ref}" is not stored`);
    this.name = 'SecretMissing';
  }
}

export class SecretVersionConflict extends Error {
  constructor(readonly ref: string) {
    super(`credential "${ref}" changed since it was read; the write-back was refused`);
    this.name = 'SecretVersionConflict';
  }
}

export class SecretRefreshFailed extends Error {
  constructor(
    readonly ref: string,
    detail: string,
  ) {
    super(`refreshing credential "${ref}" failed: ${detail}`);
    this.name = 'SecretRefreshFailed';
  }
}

export interface SecretsFamily {
  /** The credential, from this family's cache when it has read it before. */
  resolve(ref: string): Promise<SecretRecord>;
  /** Store `fields` over the credential at `expectedVersion`. Throws
   *  `SecretVersionConflict` when it has moved on. */
  writeBack(ref: string, fields: SecretFields, expectedVersion: string): Promise<SecretRecord>;
  /** Store `fields` over whatever is stored now: a write-back from a caller
   *  that holds no version (a client library that refreshed by itself), or one
   *  that must not be lost to a conflict (a rotated refresh token). Taken
   *  under the store's lock. */
  update(ref: string, fields: SecretFields): Promise<SecretRecord>;
  /** Refresh the credential the caller found stale at `seenVersion`; see the
   *  file comment for the single flight. */
  refresh(ref: string, options: { seenVersion: string; refresher: Refresher }): Promise<SecretRecord>;
}

export function createSecretsFamily(input: {
  backend: SecretsBackend;
  /** Where a write-back that could not be stored is reported, once per
   *  credential. Default: nowhere. */
  warn?: (message: string) => void;
}): SecretsFamily {
  const { backend } = input;
  const cache = new Map<string, SecretRecord>();
  const refreshing = new Map<string, Promise<SecretRecord>>();
  const warned = new Set<string>();

  const exclusive = <T>(ref: string, body: (store: SecretsBackend) => Promise<T>): Promise<T> =>
    backend.exclusive !== undefined ? backend.exclusive(ref, body) : body(backend);

  const fresh = async (store: SecretsBackend, ref: string): Promise<SecretRecord> => {
    const record = await store.resolve(ref);
    if (record === null) {
      cache.delete(ref);
      throw new SecretMissing(ref);
    }
    cache.set(ref, record);
    return record;
  };

  const settle = (ref: string, outcome: WriteBackOutcome, values: string[]): SecretRecord => {
    switch (outcome.kind) {
      case 'written':
        cache.set(ref, outcome.record);
        return outcome.record;
      case 'not_persisted':
        cache.set(ref, outcome.record);
        if (!warned.has(ref)) {
          warned.add(ref);
          input.warn?.(redactSecrets(outcome.why, values));
        }
        return outcome.record;
      case 'conflict':
        cache.set(ref, outcome.current);
        throw new SecretVersionConflict(ref);
      case 'missing':
        cache.delete(ref);
        throw new SecretMissing(ref);
    }
  };

  const family: SecretsFamily = {
    async resolve(ref) {
      return cache.get(ref) ?? fresh(backend, ref);
    },

    writeBack(ref, fields, expectedVersion) {
      return exclusive(ref, async (store) => settle(ref, await store.writeBack(ref, fields, expectedVersion), Object.values(fields)));
    },

    update(ref, fields) {
      return exclusive(ref, async (store) => {
        const current = await fresh(store, ref);
        return settle(ref, await store.writeBack(ref, fields, current.version), Object.values(fields));
      });
    },

    refresh(ref, { seenVersion, refresher }) {
      const inFlight = refreshing.get(ref);
      if (inFlight !== undefined) return inFlight;
      const run = exclusive(ref, async (store) => {
        await store.assertWritable?.(ref);
        const current = await fresh(store, ref);
        // Somebody refreshed it since the caller read it: theirs is the answer.
        if (current.version !== seenVersion) return current;
        let changed: SecretFields;
        try {
          changed = await refresher(current);
        } catch (error) {
          throw new SecretRefreshFailed(ref, redactSecrets(error instanceof Error ? error.message : String(error), Object.values(current.fields)));
        }
        return settle(ref, await store.writeBack(ref, changed, current.version), [...Object.values(current.fields), ...Object.values(changed)]);
      }).finally(() => refreshing.delete(ref));
      refreshing.set(ref, run);
      return run;
    },
  };
  return family;
}

// ── Using a credential for one call ─────────────────────────────────────────

/** True when `expires_at` is within `windowMs` of `now`, or unreadable. A
 *  credential that names no expiry is never stale by time. */
export function expiresWithin(fields: SecretFields, windowMs: number, now: number = Date.now()): boolean {
  const at = fields.expires_at;
  if (at === undefined) return false;
  const ms = Date.parse(at);
  return Number.isNaN(ms) || ms - now <= windowMs;
}

export const DEFAULT_REFRESH_WINDOW_MS = 30_000;

/**
 * Run one call with a credential: refreshed first when it expires within the
 * window, and refreshed once more and retried when the call fails as
 * `isUnauthorized` says. Without a refresher, the call runs as it stands.
 */
export async function withSecret<T>(
  family: SecretsFamily,
  ref: string,
  options: {
    refresher?: Refresher;
    isUnauthorized?: (error: unknown) => boolean;
    windowMs?: number;
  },
  call: (record: SecretRecord) => Promise<T>,
): Promise<T> {
  const { refresher } = options;
  let record = await family.resolve(ref);
  if (refresher === undefined) return call(record);
  if (expiresWithin(record.fields, options.windowMs ?? DEFAULT_REFRESH_WINDOW_MS)) {
    record = await family.refresh(ref, { seenVersion: record.version, refresher });
  }
  try {
    return await call(record);
  } catch (error) {
    if (options.isUnauthorized === undefined || !options.isUnauthorized(error)) throw error;
    // The record the call actually used: a credentialUpdate during the call
    // moved the cache on, and that newer token is not the one found stale.
    record = await family.refresh(ref, { seenVersion: (await family.resolve(ref)).version, refresher });
    return call(record);
  }
}

// ── Versions and redaction ─────────────────────────────────────────────────

/** A version for a store that keeps the fields themselves (a file, a vault):
 *  a hash of them, order-independent. */
export function contentVersion(fields: SecretFields): string {
  const sorted = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 32);
}

const REDACTED = '[redacted]';
/** Values this short are not worth hiding and would mangle ordinary words. */
const MIN_REDACTED_LENGTH = 4;

/** `text` with every occurrence of each value replaced, longest first. */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...values].filter((v) => v.length >= MIN_REDACTED_LENGTH).sort((a, b) => b.length - a.length)) {
    out = out.split(value).join(REDACTED);
  }
  return out;
}
