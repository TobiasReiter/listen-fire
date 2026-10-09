/**
 * Phase 3.iii-d verification: arbitration is asynchronous, evidenced, and loud
 * when it cannot run.
 *
 * D42 took `evaluation_strategy: llm` out of the store's write transaction. The
 * three things that has to be true afterwards, and that this drives end to end:
 *
 *   1. The write COMMITS with the incoming value and records the question.
 *      Nothing blocks on a model call; the property holds what the writer said
 *      until the arbiter says otherwise, and one queue row exists no matter how
 *      many writes arrived first (they coalesce — arbitration re-derives from
 *      the whole evidence history, so N writes is one question).
 *   2. The ruling lands as a SECOND evidenced, change-logged write, and it
 *      lands on the value the in-transaction path would have picked. The
 *      fixture is chosen so that answer is determinate: a stale figure and a
 *      current one, where "most recent, best sourced" is unambiguous. The
 *      arbiter reads exactly the candidate set the old callback read — every
 *      evidence row on the property except rulings — so a different answer here
 *      would mean the old path was order-dependent, not that the model differs.
 *   3. With no key configured the queue GROWS and says so. Attempts stay at
 *      zero (a backlog nobody could have drained must not burn itself into
 *      `unresolvable`), the heartbeat carries the reason, and `/health` reports
 *      `llmConfigured: false` beside a rising `pending`.
 *
 * Run: pnpm dev:script verify_property_arbitration
 */
import './_profile_loader';
import { getKnowledgeQb } from '../../lib/kysely';
import { ensureDevLoopTeam } from './_lib';
import { ChangeSource } from '../../lib/knowledge/changes';
import {
  createNode,
  openKnowledgeStore,
  setProperties,
} from '../../lib/knowledge/store';
import {
  arbitrateOnce,
  readArbitrationHealth,
} from '../../services/knowledge/arbitration/worker';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import EvaluationStrategy from '../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../generated/kysely/knowledge/PropertyCardinality';
import PropertyValueType from '../../generated/kysely/knowledge/PropertyValueType';
import NodeTypeCategory from '../../generated/kysely/knowledge/NodeTypeCategory';
import PropertyIdentity from '../../generated/kysely/knowledge/PropertyIdentity';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';

const NODE_TYPE = 'ArbitrationProbe';
const PROPERTY = 'Headcount';

/** Deliberately determinate: one stale, vague claim and one current, sourced
 *  one. Any competent arbiter — the old in-transaction path included — picks
 *  the second. */
const STALE = 'A 2019 blog post mentions the company was "about a dozen people".';
const CURRENT =
  "The company's 2024 annual report, page 3, states a headcount of 480 employees as of 31 December 2024.";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, detail === undefined ? '' : detail);
  }
}

async function ensureOntology(teamId: TeamId) {
  const qb = getKnowledgeQb(['node_type', 'property_type']);

  let nodeType = await qb
    .selectFrom('node_type')
    .where('team_id', '=', teamId)
    .where('name', '=', NODE_TYPE)
    .select(['id'])
    .executeTakeFirst();
  if (!nodeType) {
    nodeType = await qb
      .insertInto('node_type')
      .values({
        team_id: teamId,
        name: NODE_TYPE,
        description: 'Probe type for asynchronous property arbitration (D42).',
        category: NodeTypeCategory.object,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
  }

  let propertyType = await qb
    .selectFrom('property_type')
    .where('team_id', '=', teamId)
    .where('node_type_id', '=', nodeType.id)
    .where('name', '=', PROPERTY)
    .select(['id'])
    .executeTakeFirst();
  if (!propertyType) {
    propertyType = await qb
      .insertInto('property_type')
      .values({
        team_id: teamId,
        node_type_id: nodeType.id,
        name: PROPERTY,
        description: 'Number of employees, as most recently and best evidenced.',
        value_type: PropertyValueType.text,
        cardinality: PropertyCardinality.single,
        // K-9 has not dropped this column yet; `none` is what every live
        // creator hard-codes.
        identity: PropertyIdentity.none,
        // The declaration this whole chunk is about.
        evaluation_strategy: EvaluationStrategy.llm,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
  }

  return {
    nodeTypeId: nodeType.id as NodeTypeId,
    propertyTypeId: propertyType.id as PropertyTypeId,
  };
}

function writeContext(teamId: TeamId, description: string) {
  return {
    teamId,
    evidenceType: EvidenceType.extraction,
    changeSource: ChangeSource.pipeline,
    description,
  };
}

async function pendingRowsFor(propertyId: PropertyId) {
  return getKnowledgeQb(['property_arbitration'])
    .selectFrom('property_arbitration')
    .where('property_id', '=', propertyId)
    .where('resolved_at', 'is', null)
    .select(['id', 'attempts', 'enqueued_at', 'last_error'])
    .execute();
}

async function propertyState(propertyId: PropertyId) {
  const qb = getKnowledgeQb(['property', 'evidence', 'change']);
  const [prop, evidence, changes] = await Promise.all([
    qb
      .selectFrom('property')
      .where('id', '=', propertyId)
      .select(['value_text'])
      .executeTakeFirst(),
    qb
      .selectFrom('evidence')
      .where('property_id', '=', propertyId)
      .orderBy('created_at', 'asc')
      .select(['type', 'description'])
      .execute(),
    qb
      .selectFrom('change')
      .where('property_id', '=', propertyId)
      .orderBy('created_at', 'asc')
      .select(['kind', 'source', 'old_value', 'new_value'])
      .execute(),
  ]);
  return { value: prop?.value_text ?? null, evidence, changes };
}

async function main() {
  const seed = await ensureDevLoopTeam();
  const teamId = seed.teamId as TeamId;
  const store = openKnowledgeStore();
  const { nodeTypeId, propertyTypeId } = await ensureOntology(teamId);

  console.log('\n── 1. the write commits, and records the question ──');

  const { nodeId } = await createNode(store, {
    context: writeContext(teamId, CURRENT),
    nodeTypeId,
    properties: [{ propertyTypeId, value: '480', description: CURRENT }],
  });

  // The STALE claim lands SECOND, and deliberately: last-write-wins would leave
  // the property on the 2019 figure, so a ruling that moves it back to 480 is
  // arbitration actually arbitrating rather than agreeing with whoever wrote
  // last. It also arrives before the worker runs, which is what proves the
  // coalescing rule rather than assuming it.
  await setProperties(store, {
    context: writeContext(teamId, STALE),
    anchor: { kind: 'node', nodeId, nodeTypeId },
    properties: [{ propertyTypeId, value: '12', description: STALE }],
  });

  const propertyRow = await getKnowledgeQb(['property'])
    .selectFrom('property')
    .where('node_id', '=', nodeId)
    .where('property_type_id', '=', propertyTypeId)
    .select(['id'])
    .executeTakeFirstOrThrow();
  const propertyId = propertyRow.id as PropertyId;

  const beforeRuling = await propertyState(propertyId);
  check(
    "the write committed with the value the writer supplied — last-write-wins, for now",
    beforeRuling.value === '12',
    beforeRuling.value,
  );
  check(
    'both candidates are recorded as evidence',
    beforeRuling.evidence.length === 2 &&
      beforeRuling.evidence.every((e) => e.type === EvidenceType.extraction),
    beforeRuling.evidence,
  );
  check(
    'two writes produced two change rows, none of them a ruling',
    beforeRuling.changes.length === 2,
    beforeRuling.changes.length,
  );

  let pending = await pendingRowsFor(propertyId);
  check('two writes coalesced into ONE pending question', pending.length === 1, pending);

  const healthBefore = await readArbitrationHealth();
  check('health can arbitrate', healthBefore.llmConfigured === true);
  check('health sees the queue', healthBefore.pending >= 1, healthBefore.pending);

  console.log('\n── 2. the ruling is a second, evidenced write ──');

  const run = await arbitrateOnce();
  check('the worker resolved the question', run.resolved >= 1 && run.failed === 0, run);

  pending = await pendingRowsFor(propertyId);
  check('nothing is left pending for this property', pending.length === 0, pending);

  const afterRuling = await propertyState(propertyId);
  const rulingEvidence = afterRuling.evidence.filter(
    (e) => e.type === EvidenceType.arbitration,
  );
  check(
    'the ruling appended its own evidence, typed as arbitration',
    rulingEvidence.length === 1,
    afterRuling.evidence.map((e) => e.type),
  );
  check(
    "the ruling's reasoning is its provenance",
    (rulingEvidence[0]?.description ?? '').length > 0,
    rulingEvidence[0]?.description,
  );
  check(
    'the ruling is change-logged — a THIRD change row (D37f)',
    afterRuling.changes.length === 3,
    afterRuling.changes.length,
  );
  check(
    'that third change row records the move the ruling made',
    afterRuling.changes[2]?.kind === 'property_set' &&
      JSON.stringify(afterRuling.changes[2]?.new_value ?? '').includes('480'),
    afterRuling.changes[2],
  );
  check(
    'the final value is the one the in-transaction path would have picked — NOT the last write',
    (afterRuling.value ?? '').includes('480'),
    afterRuling.value,
  );
  console.log(`     final value: ${JSON.stringify(afterRuling.value)}`);
  console.log(`     reasoning:   ${rulingEvidence[0]?.description ?? '(none)'}`);

  console.log('\n── 3. a ruling is not evidence for the next ruling ──');

  // Re-enqueue by writing again; the arbiter must read the two SOURCES and not
  // its own verdict, or one synthesis hardens into the answer by restatement.
  await setProperties(store, {
    context: writeContext(teamId, 'An undated recruiter listing repeats the old figure of 12.'),
    anchor: { kind: 'node', nodeId, nodeTypeId },
    properties: [
      {
        propertyTypeId,
        value: '12',
        description: 'An undated recruiter listing repeats the old figure of 12.',
      },
    ],
  });
  pending = await pendingRowsFor(propertyId);
  check('a fresh write re-asks the question', pending.length === 1, pending);

  const candidates = await getKnowledgeQb(['evidence'])
    .selectFrom('evidence')
    .where('property_id', '=', propertyId)
    .where('type', '!=', EvidenceType.arbitration)
    .select(['id'])
    .execute();
  check(
    'the candidate set is the three SOURCES — the ruling is excluded',
    candidates.length === 3,
    candidates.length,
  );

  console.log('\n── 4. no key: the queue grows, loudly ──');

  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedKnowledge = process.env.KNOWLEDGE_LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.KNOWLEDGE_LLM_API_KEY;
  try {
    const degraded = await arbitrateOnce();
    check(
      'nothing was attempted and nothing failed',
      degraded.resolved === 0 && degraded.failed === 0,
      degraded,
    );
    check('the skipped backlog is reported', degraded.skipped >= 1, degraded.skipped);

    const stillPending = await pendingRowsFor(propertyId);
    check('the question is still queued', stillPending.length === 1, stillPending);
    check(
      'attempts stayed at zero — the backlog can still drain later',
      stillPending[0]?.attempts === 0,
      stillPending[0]?.attempts,
    );

    const degradedHealth = await readArbitrationHealth();
    check('health says it cannot arbitrate', degradedHealth.llmConfigured === false);
    check('health still counts the backlog', degradedHealth.pending >= 1, degradedHealth.pending);
    check(
      'the heartbeat names the reason rather than going quiet',
      (degradedHealth.lastError ?? '').includes('No LLM key'),
      degradedHealth.lastError,
    );
    console.log(`     health.lastError: ${degradedHealth.lastError}`);
  } finally {
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedKnowledge !== undefined) process.env.KNOWLEDGE_LLM_API_KEY = savedKnowledge;
  }

  console.log('\n── 5. the backlog drains once a key is back ──');
  const recovered = await arbitrateOnce();
  check('the queued question resolved on the next pass', recovered.resolved >= 1, recovered);
  const finalState = await propertyState(propertyId);
  check(
    'the arbiter still prefers the sourced current figure over the repeated stale one',
    (finalState.value ?? '').includes('480'),
    finalState.value,
  );
  console.log(`     final value: ${JSON.stringify(finalState.value)}`);

  console.log(
    failures === 0
      ? '\nAll arbitration checks passed.\n'
      : `\n${failures} arbitration check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
