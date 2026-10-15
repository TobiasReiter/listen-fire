/**
 * One-off: edit a KG Organisation node's Name via the KG adapter (so the
 * commit hook emits a RecordMutationEvent) and let mutation_dispatch fire
 * the K→V output TG. Used to verify K→V end-to-end.
 *
 * pnpm dev:_test_kv <node_id> <new_name>
 */
import type { TeamId } from '../../generated/kysely/core/Team';

import { getKnowledgeQb } from '../../lib/kysely';
import { createKnowledgeGraphAdapter } from '../../services/translation_graph/adapters/knowledge_graph';
import { dispatchMutationEvent } from '../../services/translation_graph/triggers/mutation_dispatch';
import { userEditContext } from 'movement-engine/services/translation_graph/mutation_context';

async function main() {
  const [nodeId, newName] = process.argv.slice(2);
  if (!nodeId || !newName) {
    console.error('Usage: pnpm dev:_test_kv <node_id> <new_name>');
    process.exit(2);
  }

  const teamId = process.env.TEST_HARNESS_TEAM_ID as TeamId;
  if (!teamId) throw new Error('TEST_HARNESS_TEAM_ID not set');

  // Look up the user (for the userEditContext actorId).
  const user = await getKnowledgeQb(['node'])
    .selectFrom('node' as never)
    .where('id', '=', nodeId as never)
    .where('team_id', '=', teamId as never)
    .select(['id'])
    .executeTakeFirst();
  if (!user) throw new Error(`node ${nodeId} not found`);

  const adapter = createKnowledgeGraphAdapter({ teamId });

  const ctx = userEditContext('00000000-0000-0000-0000-000000000000');
  const result = await adapter.updateRecord({
    recordType: 'Organisation', // not strictly used by the KG adapter, but required by the interface
    externalId: nodeId,
    fields: {
      // Field id is the Name property_type_id. Use status from dev:valuations status.
      'fa1cac26-465f-434a-bca9-6afdb64aef91': newName,
    },
    mutationContext: ctx,
  });
  console.log('updateRecord result:', JSON.stringify(result, null, 2));

  // Construct a synthetic mutation event mirroring what the commit hook
  // would produce, then dispatch. (The KG adapter's updateRecord may also
  // surface events directly; either path works for the verification.)
  const dispatch = await dispatchMutationEvent({
    event: {
      recordId: nodeId as import('../../generated/kysely/knowledge/Node').NodeId,
      nodeTypeId: '9d265cc3-576e-4cdc-acdd-aaa138e6b244', // Organisation node_type_id
      changeKind: 'update',
      changedFields: ['fa1cac26-465f-434a-bca9-6afdb64aef91'],
      context: ctx,
    },
    teamId,
  });
  console.log('dispatch result:', JSON.stringify(dispatch, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
