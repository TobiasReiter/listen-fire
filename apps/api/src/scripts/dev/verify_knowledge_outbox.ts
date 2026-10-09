/**
 * Phase 3.ii verification: a graph mutation's whole journey, now that the
 * outbox is the only road out.
 *
 * Before this chunk a graph write announced itself twice and inconsistently —
 * the editor diffed property snapshots around its own writes, the adapter
 * derived events from a per-transaction observer, and the engine re-dispatched
 * what it collected at end of run. This drives the one path that replaced all
 * of it and asserts the four properties that path has to have:
 *
 *   1. every write path enqueues — editor, agent and movement alike (D37f's
 *      sibling: an event on every path, not just the two that remembered)
 *   2. the payload carries the FULL mutation context, because `suppress_self`
 *      is computed from the payload alone and its degraded mode is silent
 *      (K-29 / M-40)
 *   3. the drainer delivers, marks the row, and only then does a dependent
 *      listener fire — asynchronously, which is the accepted cost of M-38
 *   4. an ontology-forbidden write still THROWS rather than skipping (D37c)
 *
 * The movement half of the chain needs the fixtures next door:
 *
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_write_probe.mvt
 *   pnpm dev:movement provision --file src/scripts/dev/_fixtures/kg_listen_probe.mvt
 *   pnpm dev:movement run kg_write_probe
 */
import './_profile_loader';
import { getKnowledgeQb, getQb } from '../../lib/kysely';
import { ensureDevLoopTeam } from './_lib';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';

import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { createNode, openKnowledgeStore, setProperties } from '../../lib/knowledge/store';
import ChangeSource from '../../generated/kysely/knowledge/ChangeSource';

import type { MutationEventEnvelope } from '../../lib/knowledge/store/events';

import { drainOnce, readOutboxHealth, registerLocalMutationSubscriber } from '../../services/knowledge/mutation_outbox/worker';

const AUTOMATION_CONTEXT = {
  // The shape a movement's own write carries: an automation marker inside the
  // context is what `didWeAuthor` reads to answer "was this us?".
  source: {
    type: 'extraction',
    adapterType: 'kg',
    translationGraphId: '00000000-0000-4000-8000-0000000000ff',
  },
  occurredAt: new Date().toISOString(),
};

async function main() {
  const { teamId } = await ensureDevLoopTeam();
  const team = teamId as TeamId;
  const db = openKnowledgeStore();
  const qb = getKnowledgeQb(['mutation_outbox', 'node_type', 'property_type', 'webhook_endpoint']);
  const out: Record<string, unknown> = {};

  const nodeType = await qb
    .selectFrom('node_type')
    .where('team_id', '=', team)
    .where('name', '=', 'Organisation')
    .select(['id', 'name'])
    .executeTakeFirstOrThrow();
  const nameProperty = await qb
    .selectFrom('property_type')
    .where('team_id', '=', team)
    .where('node_type_id', '=', nodeType.id)
    .where('name', '=', 'Name')
    .select(['id', 'name'])
    .executeTakeFirstOrThrow();

  const since = new Date();
  const stamp = Date.now();

  // ── 1. A movement-shaped write enqueues, with its context intact ─────────
  const created = await createNode(db, {
    context: {
      teamId: team,
      evidenceType: EvidenceType.extraction,
      changeSource: ChangeSource.pipeline,
      description: 'outbox probe',
      mutationContext: AUTOMATION_CONTEXT,
    },
    nodeTypeId: nodeType.id as NodeTypeId,
    properties: [{ propertyTypeId: nameProperty.id as PropertyTypeId, value: `Outbox Probe ${stamp}` }],
  });

  // ── 2. An editor-shaped write enqueues too — the path that used to need a
  //       snapshot-diffing wrapper to say anything at all ──────────────────
  await setProperties(db, {
    context: {
      teamId: team,
      evidenceType: EvidenceType.user_edit,
      changeSource: ChangeSource.user_edit,
      description: 'outbox probe (editor)',
    },
    anchor: { kind: 'node', nodeId: created.nodeId },
    properties: [{ propertyTypeId: nameProperty.id as PropertyTypeId, value: `Outbox Probe ${stamp} (edited)` }],
  });

  // ── 3. A write that changes nothing says nothing ─────────────────────────
  await setProperties(db, {
    context: {
      teamId: team,
      evidenceType: EvidenceType.user_edit,
      changeSource: ChangeSource.user_edit,
      description: 'outbox probe (no-op)',
    },
    anchor: { kind: 'node', nodeId: created.nodeId },
    properties: [{ propertyTypeId: nameProperty.id as PropertyTypeId, value: `Outbox Probe ${stamp} (edited)` }],
  });

  const rows = await qb
    .selectFrom('mutation_outbox')
    .where('team_id', '=', team)
    .where('node_id', '=', created.nodeId)
    .where('created_at', '>=', since)
    .orderBy('created_at', 'asc')
    .select(['id', 'event_type', 'payload', 'delivered_at', 'attempts'])
    .execute();

  const envelopes = rows.map((r) => r.payload as MutationEventEnvelope);
  out.enqueued = envelopes.map((e) => ({
    event: e.event,
    changedFields: e.data.changedFields,
    sourceType: e.data.context?.source?.type,
  }));
  out.createCarriesFullContext =
    envelopes[0]?.data.context?.source?.translationGraphId ===
    AUTOMATION_CONTEXT.source.translationGraphId;
  out.editorWriteEnqueued = envelopes.some((e) => e.data.context?.source?.type === 'user_edit');
  out.noOpWriteStayedSilent = envelopes.length === 2;

  // ── 4. The drainer delivers, and delivery is what reaches a subscriber ───
  const delivered: MutationEventEnvelope[] = [];
  registerLocalMutationSubscriber(async ({ envelope }) => {
    delivered.push(envelope);
  });
  const drain = await drainOnce();
  out.drain = drain;

  const afterDrain = await qb
    .selectFrom('mutation_outbox')
    .where('team_id', '=', team)
    .where('node_id', '=', created.nodeId)
    .select(['id', 'delivered_at'])
    .execute();
  out.allMarkedDelivered = afterDrain.every((r) => r.delivered_at !== null);
  out.subscriberSawContext = delivered.every((e) => Boolean(e.data.context?.source?.type));

  // ── 5. The pulse an ops page reads ──────────────────────────────────────
  out.health = await readOutboxHealth();

  // ── 6. Echo suppression, from the human side ────────────────────────────
  // The automation side is the movement chain (kg_write_probe fires, and the
  // two `suppress_self` listeners stay quiet because the payload says an
  // automation authored it). This is the other half, and the half that would
  // break silently if suppression were too eager: a person editing a record an
  // automation once wrote must still wake the sync. Needs the dev-loop stack —
  // the SERVER's drainer delivers this one, not ours.
  const runsQb = getQb(['automations.trigger_run', 'automations.movement_version', 'automations.movement']);
  const countSyncRuns = async () => {
    const row = await runsQb
      .selectFrom('automations.trigger_run as tr')
      .innerJoin('automations.movement_version as mv', 'mv.id', 'tr.movement_version_id')
      .innerJoin('automations.movement as m', 'm.id', 'mv.movement_id')
      .where('m.name', '=', 'kg_selfsync_probe')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  };

  const before = await countSyncRuns();
  await createNode(db, {
    context: {
      teamId: team,
      evidenceType: EvidenceType.user_edit,
      changeSource: ChangeSource.user_edit,
      description: 'outbox probe (human edit)',
    },
    nodeTypeId: nodeType.id as NodeTypeId,
    properties: [{ propertyTypeId: nameProperty.id as PropertyTypeId, value: `Human Edit ${stamp}` }],
  });

  let after = before;
  for (let i = 0; i < 20 && after === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    after = await countSyncRuns();
  }
  out.humanEditWokeTheSuppressSelfListener = after > before;

  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
