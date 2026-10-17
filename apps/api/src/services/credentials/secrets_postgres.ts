// The platform's secrets store: the secrets family (movement-engine
// `public/secrets`) over `external_service_credentials`. The cipher, the key
// derivation context (the row id) and each type's stored payload are exactly
// what `lib/credentials` and the connect flows write, so a row this store
// writes reads back through `decryptToken` and the other way round.
//
// The version a write-back names is a hash of the stored ciphertext: every
// write draws a fresh nonce, so any change to the row changes it, and the
// compare-and-swap needs no new column. A refresh holds a transaction-scoped
// advisory lock on the credential, so two processes refreshing one credential
// make one token call: the second finds the version moved and takes the
// first's answer.

import { createHash } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { SecretFields, SecretRecord, SecretsBackend, WriteBackOutcome } from 'movement-engine/public/secrets';
import { decryptToken, encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type AutomationsSchema from '../../generated/kysely/automations/AutomationsSchema';

type CredentialsDb = Kysely<Pick<AutomationsSchema, 'external_service_credentials'>>;

type StoredPayload = Record<string, unknown>;

/**
 * How one type's stored JSON payload reads as the family's string fields and
 * takes a write-back. A write-back changes only the keys it maps to and keeps
 * every other key of the stored payload as it was, so the payload's shape
 * never changes under a refresh.
 */
export interface PayloadShape {
  toFields(payload: StoredPayload): Record<string, string>;
  withFields(payload: StoredPayload, changed: SecretFields): StoredPayload;
}

/** A payload whose secret keys are strings already: a remote module's
 *  declared credential, an API key. Keys that are not strings stay out of the
 *  fields and are kept as stored. */
export const flatPayloadShape: PayloadShape = {
  toFields(payload) {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) if (typeof value === 'string') fields[key] = value;
    return fields;
  },
  withFields(payload, changed) {
    return { ...payload, ...changed };
  },
};

/** A payload whose keys are the module's fields under other names (`table`:
 *  stored name to field name). A key not named passes through as itself; a
 *  write-back is stored under the row's own names. */
export function renamedPayloadShape(table: Readonly<Record<string, string>>): PayloadShape {
  const storedName = Object.fromEntries(Object.entries(table).map(([stored, field]) => [field, stored]));
  return {
    toFields(payload) {
      const fields: Record<string, string> = {};
      for (const [key, value] of Object.entries(flatPayloadShape.toFields(payload))) fields[table[key] ?? key] = value;
      return fields;
    },
    withFields(payload, changed) {
      const next: StoredPayload = { ...payload };
      for (const [key, value] of Object.entries(changed)) next[storedName[key] ?? key] = value;
      return next;
    },
  };
}

/**
 * The OAuth payload the Dropbox, Google and Gmail connect flows store:
 * `{ accessToken, refreshToken, expiresAt }` with `expiresAt` in epoch
 * milliseconds, beside whatever else the type keeps (Gmail's mailbox and
 * scopes). Read as the protocol's token fields, `expires_at` an ISO time.
 */
export const camelTokenPayloadShape: PayloadShape = {
  toFields(payload) {
    const fields = flatPayloadShape.toFields(payload);
    delete fields.accessToken;
    delete fields.refreshToken;
    if (typeof payload.accessToken === 'string') fields.access_token = payload.accessToken;
    if (typeof payload.refreshToken === 'string') fields.refresh_token = payload.refreshToken;
    if (typeof payload.expiresAt === 'number') fields.expires_at = new Date(payload.expiresAt).toISOString();
    return fields;
  },
  withFields(payload, changed) {
    const next: StoredPayload = { ...payload };
    for (const [key, value] of Object.entries(changed)) {
      switch (key) {
        case 'access_token':
          next.accessToken = value;
          break;
        case 'refresh_token':
          next.refreshToken = value;
          break;
        case 'expires_at': {
          const ms = Date.parse(value);
          if (Number.isNaN(ms)) throw new Error('expires_at is not an ISO time');
          next.expiresAt = ms;
          break;
        }
        default:
          next[key] = value;
      }
    }
    return next;
  },
};

function isPayload(value: unknown): value is StoredPayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function versionOf(ciphertext: Buffer): string {
  return createHash('sha256').update(ciphertext).digest('hex');
}

function lockKey(ref: string): string {
  return `secrets:external_service_credentials:${ref}`;
}

export function postgresSecrets(options: {
  shape?: PayloadShape;
  /** Only this team's credentials resolve. */
  teamId?: string;
  /** The query builder; default the request context's (its transaction, if one is open). */
  db?: () => CredentialsDb;
} = {}): SecretsBackend {
  const shape = options.shape ?? flatPayloadShape;
  const db = options.db ?? (() => getAutomationsQb(['external_service_credentials']));

  const read = async (on: CredentialsDb, ref: string): Promise<{ payload: StoredPayload; record: SecretRecord } | null> => {
    let query = on
      .selectFrom('external_service_credentials')
      .where('id', '=', ref as ExternalServiceCredentialsId)
      .select(['id', 'credentials']);
    if (options.teamId !== undefined) query = query.where('team_id', '=', options.teamId);
    const row = await query.executeTakeFirst();
    if (row === undefined) return null;
    // A shell row (no ciphertext) is refused by name inside decryptToken.
    const parsed: unknown = JSON.parse(await decryptToken(row.credentials, row.id));
    if (!isPayload(parsed)) throw new Error(`credential ${ref} does not hold a JSON object`);
    const payload = { ...parsed };
    return { payload, record: { fields: shape.toFields(payload), version: versionOf(row.credentials ?? Buffer.alloc(0)) } };
  };

  const over = (on: () => CredentialsDb, locked: boolean): SecretsBackend => {
    const backend: SecretsBackend = {
      async resolve(ref) {
        return (await read(on(), ref))?.record ?? null;
      },
      async writeBack(ref, fields, expectedVersion): Promise<WriteBackOutcome> {
        const current = await read(on(), ref);
        if (current === null) return { kind: 'missing' };
        if (current.record.version !== expectedVersion) return { kind: 'conflict', current: current.record };
        const next = shape.withFields(current.payload, fields);
        const ciphertext = await encryptToken(JSON.stringify(next), ref);
        const updated = await on()
          .updateTable('external_service_credentials')
          .set({ credentials: ciphertext, updated_at: new Date() })
          .where('id', '=', ref as ExternalServiceCredentialsId)
          .where(sql<Buffer>`sha256(credentials)`, '=', Buffer.from(expectedVersion, 'hex'))
          .executeTakeFirst();
        if (updated.numUpdatedRows === BigInt(0)) {
          const now = await read(on(), ref);
          return now === null ? { kind: 'missing' } : { kind: 'conflict', current: now.record };
        }
        return { kind: 'written', record: { fields: shape.toFields(next), version: versionOf(ciphertext) } };
      },
    };
    if (!locked) {
      backend.exclusive = async (ref, body) => {
        const outer = db();
        const run = async (trx: CredentialsDb) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(ref)}, 0))`.execute(trx);
          return body(over(() => trx, true));
        };
        // Inside an open transaction the lock is held until that one ends.
        return outer.isTransaction ? run(outer) : outer.transaction().execute(run);
      };
    }
    return backend;
  };

  return over(db, false);
}
