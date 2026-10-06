// W3-A2 — Per-test cleanup helpers.
//
// Pattern: tests create a fresh team and use `teamId`-scoped writes
// throughout. After each test, this helper truncates every row that
// references the team across both `public` and `knowledge` schemas.
//
// Deletes are issued in FK-respecting order. The set of tables comes
// from manual inspection of the wave-1 golden-path's write surface —
// extend as the harness grows. Tables not listed here will leak rows
// across tests if they're written and not cleaned.
//
// Trade-off: this is more brittle than the alternative of dropping +
// re-applying the schema between tests (~5s per test) or wrapping each
// test in a Postgres transaction with rollback (subtle pooling
// interactions with Kysely). The brief's recommendation was a
// dedicated test DB + per-team cleanup; this implements that.

import { sql } from 'kysely';

import { getKnowledgeQb, getQb } from '../../lib/kysely';
import type { TeamId } from '../../generated/kysely/core/Team';

/**
 * Tables in the `knowledge` schema scoped by `team_id`. Order matters:
 * children before parents to respect FK constraints.
 */
const KNOWLEDGE_TABLES_TEAM_SCOPED: readonly string[] = [
  // Evidence + audit-trail rows first (refer to property + node).
  'evidence',
  'extraction_fact',
  // Node-resource link (refers to node + resource).
  'node_resource',
  // Source material, which joined this schema in phase 5.4 (D48(i)). Ordered
  // after the two tables that reference `resource` and inside-out among
  // themselves: resource → document → raw_text_part → raw_text. Only
  // `resource` was ever cleaned up before, from the public list; the other
  // three were leaking team rows because no list claimed them.
  'resource',
  'document',
  'raw_text_part',
  'raw_text',
  // Property values (refer to node + property_type).
  'property',
  // Edges + nodes (refer to node_type + edge_type).
  'edge',
  'node',
  // Ontology — node/property/edge types.
  'extraction_graph_edge',
  'extraction_graph_node',
  'extraction_graph',
  'property_type',
  'edge_type',
  'node_type',
];

/**
 * Team-scoped tables outside `knowledge`, schema-qualified.
 *
 * This list IS the mechanism now. It used to lean on `team`'s inbound foreign
 * keys to sweep up whatever it did not name: a `DELETE FROM team` cascaded to
 * the wallet, the ledgers and the journey rows, and RESTRICT stopped the delete
 * dead if anything unnamed was still there. The carve dropped every one of
 * those constraints (D3), so an unnamed table now leaks silently instead of
 * failing loudly — which is why the usage rows the cascade used to reach are
 * named explicitly below.
 *
 * Still NOT covered, and deliberately: rows keyed on `user_id` rather than
 * `team_id` (`user_journey`). The harness's golden path does not write them; a
 * test that does must clean up after itself.
 */
const TABLES_TEAM_SCOPED: readonly (readonly [
  schema: string,
  table: string,
  teamColumn?: string,
])[] = [
  ['asks', 'ask'],
  // Callbacks cascade from `trigger_run` too, but they are team-scoped state a
  // test writes, so they are named here rather than left to a cascade.
  ['automations', 'callback'],
  ['automations', 'trigger_run'],
  // Work rows carry the team only as a tag (no FK), so nothing else reaps them.
  ['automations', 'work'],
  // Remote-adapter installs (the credentials_id FK is SET NULL in-schema).
  ['automations', 'remote_adapter'],
  ['automations', 'external_service_credentials'],
  ['public', 'pipeline_configuration'],
  // Usage and journey rows: these used to disappear with the team.
  ['public', 'llm_usage'],
  ['public', 'team_usage_config'],
  ['public', 'usage_alert'],
  ['public', 'usage_event'],
  ['public', 'team_journey'],
  ['public', 'signup_event'],
  ['core', 'team_membership'],
  ['core', 'team_invite'],
  // `user` names the team it prefers, not one it is scoped by (C-6).
  ['core', 'user', 'default_team_id'],
];

export async function cleanupTeam(teamId: TeamId): Promise<void> {
  // Knowledge schema first. It is self-contained now that the source-material
  // family moved in (D48(i)) — node_resource → resource no longer crosses a
  // schema line — but it still goes first, because the ordering WITHIN its own
  // list is what referential integrity depends on.
  const kqb = getKnowledgeQb([]);
  for (const table of KNOWLEDGE_TABLES_TEAM_SCOPED) {
    await sql`DELETE FROM knowledge.${sql.ref(table)} WHERE team_id = ${teamId}`.execute(
      kqb,
    );
  }

  const pqb = getQb([]);

  // Login identities hang off `user`, not off `team`, and that FK is still
  // RESTRICT in-schema — so they go before the users do.
  await sql`
    DELETE FROM core.user_email
    WHERE user_id IN (SELECT id FROM core."user" WHERE default_team_id = ${teamId})
  `.execute(pqb);

  for (const [schema, table, teamColumn] of TABLES_TEAM_SCOPED) {
    await sql`DELETE FROM ${sql.ref(schema)}.${sql.ref(table)} WHERE ${sql.ref(
      teamColumn ?? 'team_id',
    )} = ${teamId}`.execute(pqb);
  }

  // The `team` row itself — no team_id column, identified by id.
  await sql`DELETE FROM core.team WHERE id = ${teamId}`.execute(pqb);
}
