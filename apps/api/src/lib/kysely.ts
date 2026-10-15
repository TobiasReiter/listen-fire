import Pg from 'pg';
import {
  ExpressionBuilder,
  JSONPathBuilder,
  Kysely,
  PostgresDialect,
  StringReference,
  sql,
  ReferenceExpression,
  ExtractTypeFromReferenceExpression,
} from 'kysely';

import DB from '../generated/kysely/Database';
import AsksSchema from '../generated/kysely/asks/AsksSchema';
import AutomationsSchema from '../generated/kysely/automations/AutomationsSchema';
import CoreSchema from '../generated/kysely/core/CoreSchema';
import KnowledgeSchema from '../generated/kysely/knowledge/KnowledgeSchema';
import PublicSchema from '../generated/kysely/public/PublicSchema';
import ValuationsSchema from '../generated/kysely/valuations/ValuationsSchema';
import { getDatabaseUrl } from '../prisma';
import { logger } from 'movement-engine/services/logger';
import { unsafeCurrentContext } from '../services/context';

const { Pool } = Pg;
const databaseUrl = getDatabaseUrl(false);

const dialect = new PostgresDialect({
  pool: new Pool({
    connectionString: databaseUrl.url,
  }),
});

let qb = new Kysely({
  dialect,
  log: process.env.LOG_KYSELY_QUERIES
    ? (event) => {
        if (event.level === 'query') {
          logger.info(event.query.sql);
          logger.info(event.query.parameters);
        }
      }
    : undefined,
});
if (databaseUrl.schemaName) {
  qb = qb.withSchema(databaseUrl.schemaName);
}

const globalQb = qb;

/**
 * A schema-qualified view of a unit's tables: `valuations.legal_entity` and
 * friends. Kysely resolves `'<schema>.<table> as x'` at both the type level and
 * the SQL level, which is what lets ONE query name tables in two schemas — a
 * `withSchema()` call cannot, since it rewrites every table in the statement.
 */
type Qualified<S, P extends string> = { [K in keyof S & string as `${P}.${K}`]: S[K] };

/**
 * A query that reaches across the schema boundary spells the crossing out:
 * `getQb(['core.user', 'valuations.legal_entity'])`. Every such call is a coupling
 * the carve still owes a fix — grep `'valuations\.` to find them all.
 */
type CrossSchemaDB = DB &
  Qualified<ValuationsSchema, 'valuations'> &
  Qualified<CoreSchema, 'core'> &
  Qualified<AutomationsSchema, 'automations'> &
  Qualified<KnowledgeSchema, 'knowledge'>;

/**
 * `DB` is the INTERSECTION of every schema, so a bare `'team'` still typechecks
 * against `getQb` and then fails at runtime against a table that no longer
 * lives in `public` — the one thing the type system did not guard on any
 * previous move (9_execution.md §4), and grep was the only gate. Subtracting
 * every moved unit's table names from `getQb`'s surface turns that runtime 500
 * into a compile error.
 *
 * It found one that had already escaped: the user-context resolver was still
 * reading a bare `phone_number`, which left `public` in chunk 2C2.
 *
 * `knowledge` joined this list in phase 5.4. It had been the one moved unit
 * outside the guard — the schema moved in phase 3 but its names stayed
 * reachable through `getQb`, so a bare `'node'` still typechecked. Bringing the
 * source-material family in (D48(i)) is what made that worth closing: those
 * four tables have readers all over the repo, and grep-as-the-gate is exactly
 * the mechanism finding 12 keeps proving unreliable.
 *
 * Names a unit SHARES with public (`audit_log`) stay: those are different
 * tables that happen to agree on a name, and `getQb` still means public's.
 */
type MovedTables = Exclude<
  | keyof CoreSchema
  | keyof ValuationsSchema
  | keyof AutomationsSchema
  | keyof AsksSchema
  | keyof KnowledgeSchema,
  keyof PublicSchema
>;
type PublicFacingDB = Omit<CrossSchemaDB, MovedTables>;

function getQb<T extends readonly (keyof PublicFacingDB)[] = ['audit_log']>(
  _?: T,
): Kysely<Pick<PublicFacingDB, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb) as any;
}

function getKnowledgeQb<T extends readonly (keyof KnowledgeSchema)[] = ['node_type']>(
  _?: T,
): Kysely<Pick<KnowledgeSchema, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb).withSchema('knowledge') as any;
}

function getAsksQb<T extends readonly (keyof AsksSchema)[] = ['ask']>(
  _?: T,
): Kysely<Pick<AsksSchema, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb).withSchema('asks') as any;
}

function getAutomationsQb<T extends readonly (keyof AutomationsSchema)[] = ['movement']>(
  _?: T,
): Kysely<Pick<AutomationsSchema, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb).withSchema('automations') as any;
}

function getCoreQb<T extends readonly (keyof CoreSchema)[] = ['team']>(
  _?: T,
): Kysely<Pick<CoreSchema, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb).withSchema('core') as any;
}

function getValuationsQb<T extends readonly (keyof ValuationsSchema)[] = ['legal_entity']>(
  _?: T,
): Kysely<Pick<ValuationsSchema, T[number]>> {
  const trx = unsafeCurrentContext()?.kyselyTrx;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (trx ?? qb).withSchema('valuations') as any;
}

function sqlArray(items: string[]) {
  let out = sql<string[]>`ARRAY[]::TEXT[]`;
  for (const item of items) {
    out = sql<string[]>`(${out} || ${item}::TEXT)`;
  }

  return out;
}

function pathString<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ExpressionBuilder<any, any>,
  U extends T extends ExpressionBuilder<infer A, infer B> ? StringReference<A, B> : never,
>($: T, p: U) {
  return $.ref(p, '->>') as JSONPathBuilder<Record<string, string>>;
}

function path<
  X,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ExpressionBuilder<any, any> = ExpressionBuilder<any, any>,
  U extends T extends ExpressionBuilder<infer A, infer B>
    ? StringReference<A, B>
    : never = T extends ExpressionBuilder<infer A, infer B> ? StringReference<A, B> : never,
>($: T, p: U) {
  return $.ref(p, '->') as JSONPathBuilder<X>;
}

function jsonbBuildObject<
  T,
  U extends keyof T,
  M extends Record<string, ReferenceExpression<T, U>>,
>($: ExpressionBuilder<T, U>, map: M) {
  return $.fn<{
    [k in keyof M]: ExtractTypeFromReferenceExpression<T, U, M[k]>;
  }>(
    'JSONB_BUILD_OBJECT',
    Object.entries(map).flatMap(([k, v]) => [sql.lit(k), v]),
  );
}

function jsonbAgg<T, U extends keyof T, M extends Record<string, ReferenceExpression<T, U>>>(
  $: ExpressionBuilder<T, U>,
  map: M,
) {
  return $.fn.agg<
    {
      [k in keyof M]: ExtractTypeFromReferenceExpression<T, U, M[k]>;
    }[]
  >('JSONB_AGG', [jsonbBuildObject($, map)]);
}

export type { CrossSchemaDB, PublicFacingDB };
export {
  getQb,
  getKnowledgeQb,
  getAsksQb,
  getAutomationsQb,
  getCoreQb,
  getValuationsQb,
  globalQb,
  sqlArray,
  pathString,
  path,
  jsonbBuildObject,
  jsonbAgg,
};
