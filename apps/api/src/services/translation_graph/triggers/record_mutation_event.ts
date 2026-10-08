import { z } from 'zod';

import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import { mutationContextSchema } from '../mutation_context';

// ── RecordMutationEvent: post-commit, record-level event ───────────────────
// Coalesced from per-property evidence writes within a database transaction.
// Mutation triggers fire on these events (P15).

export const recordChangeKindSchema = z.enum(['create', 'update', 'delete']);

export type RecordChangeKind = z.infer<typeof recordChangeKindSchema>;

export const recordMutationEventSchema = z.object({
  recordId: z.string().uuid(),
  nodeTypeId: z.string(),
  changeKind: recordChangeKindSchema,
  // PropertyTypeIds whose canonical value changed in this transaction. For
  // 'create' events, populated initial fields. For 'delete' events, empty.
  changedFields: z.array(z.string()),
  context: mutationContextSchema,
});

// The knowledge graph's NodeId brand layered on recordId.
export type RecordMutationEvent = Omit<
  z.infer<typeof recordMutationEventSchema>,
  'recordId'
> & {
  recordId: NodeId;
};
