/**
 * K-26: the upsert's match runs inside the upsert's own transaction.
 *
 * While the uniqueness search lived on the automations side it opened its own
 * handle, so "match then write" was two transactions with an unlocked window
 * between them. Folding the REQUEST into one endpoint narrowed the window to a
 * single round trip but did not close it — two callers could still both find
 * nothing and both create. The search now takes the caller's handle.
 *
 * This fires N simultaneous upserts of the SAME natural key and asserts exactly
 * one node exists afterwards. A race is not proven by one green run, so it runs
 * several rounds; what it CAN prove is the absence of the wide window, and a
 * regression that reopened it would fail this quickly and repeatedly.
 */
import './_profile_loader';

import { randomUUID } from "node:crypto";

import { ensureDevLoopTeam } from './_lib';
import { getAutomationsQb, getKnowledgeQb } from '../../lib/kysely';
import { loadKgCredentials } from '../../services/translation_graph/adapters/kg_client';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';

const CONCURRENCY = 6;
const ROUNDS = 3;

async function main() {
  const seed = await ensureDevLoopTeam();
  const credRow = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', seed.teamId)
    .where('type', '=', ExternalServiceType.NATIVE_KNOWLEDGE)
    .select(['id'])
    .executeTakeFirstOrThrow();
  const creds = await loadKgCredentials(credRow.id as string);

  const orgType = await getKnowledgeQb(['node_type'])
    .selectFrom('node_type')
    .where('team_id', '=', seed.teamId)
    .where('name', '=', 'Organisation')
    .select(['id'])
    .executeTakeFirstOrThrow();
  const nameProp = await getKnowledgeQb(['property_type'])
    .selectFrom('property_type')
    .where('team_id', '=', seed.teamId)
    .where('node_type_id', '=', orgType.id)
    .where('name', '=', 'Name')
    .select(['id'])
    .executeTakeFirstOrThrow();

  const rounds: { name: string; created: number; matched: number; conflicts: number; nodes: number }[] = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    // A random PREFIX, not a suffix: the ontology's rule for this type is
    // fuzzy, so two names sharing a long literal prefix are the same key and
    // later rounds would 409 against earlier rounds' rows rather than testing
    // anything.
    const name = `${randomUUID().slice(0, 8)} Race Probe`;
    const upsert = () =>
      fetch(`${creds.baseUrl}/api/v1/knowledge/graph/nodes/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({
          nodeTypeId: orgType.id,
          record: { [nameProp.id as string]: name },
          properties: [{ propertyTypeId: nameProp.id, value: name }],
          evidence: { type: EvidenceType.user_edit, description: 'upsert race probe' },
          team: seed.teamId,
        }),
      });

    const settled = await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        const res = await upsert();
        return { status: res.status, body: (await res.json()) as { created?: boolean } };
      }),
    );

    const nodes = await getKnowledgeQb(['property'])
      .selectFrom('property')
      .where('property.team_id', '=', seed.teamId)
      .where('property.property_type_id', '=', nameProp.id)
      .where('property.value_text', '=', name)
      .select(['property.node_id'])
      .execute();

    // Each round starts clean. The type's rule is FUZZY, so a survivor from an
    // earlier round matches the next round's key and every upsert after the
    // first would report `matched` against it — the assertion would still hold,
    // and it would have stopped testing the create path.
    await getKnowledgeQb(['node'])
      .deleteFrom('node')
      .where('node.team_id', '=', seed.teamId)
      .where('node.id', 'in', nodes.map((n) => n.node_id as never))
      .execute();

    rounds.push({
      name,
      created: settled.filter((s) => s.status === 200 && s.body.created === true).length,
      matched: settled.filter((s) => s.status === 200 && s.body.created === false).length,
      // A concurrent pair that BOTH saw the other's row is an honest refusal,
      // not a duplicate — the endpoint writes nothing rather than guessing.
      conflicts: settled.filter((s) => s.status === 409).length,
      nodes: new Set(nodes.map((n) => n.node_id)).size,
    });
  }

  const duplicated = rounds.filter((r) => r.nodes !== 1);
  console.log(JSON.stringify({ concurrency: CONCURRENCY, rounds, exactlyOneNodeEveryRound: duplicated.length === 0 }, null, 2));
  process.exit(duplicated.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
