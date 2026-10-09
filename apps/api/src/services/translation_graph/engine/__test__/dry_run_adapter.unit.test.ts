// The dry-run wrapper: what a rehearsal captures, and how much of the write it
// shows. A rehearsed create used to arrive as a record type and a bag of
// fields, so `write org-[:`List Entries`]-> { … }` rehearsed as an entry
// belonging to nobody — which is a different claim than the one the movement
// made. Records connect through edges, so the capture carries what it hangs
// off and the edge it hangs off by, and says which of those parents this same
// rehearsal invented a moment ago.

import type { CapturedWrite } from '../dry_run_adapter';
import type { Adapter } from '../../adapter';
import type { MutationContext } from '../../mutation_context';

import { newDryRunRehearsal, wrapAdapterForDryRun } from '../dry_run_adapter';

const MUTATION = {} as MutationContext;

/** A target that throws on every write — proof the rehearsal never reached it. */
function unreachableTarget(adapterType: string): Adapter {
  const refuse = (method: string) => async () => {
    throw new Error(`${adapterType}.${method} must not run under a rehearsal`);
  };
  return {
    adapterType,
    createRecord: refuse('createRecord'),
    updateRecord: refuse('updateRecord'),
    deleteRecord: refuse('deleteRecord'),
  } as unknown as Adapter;
}

function rehearsalOf(adapterTypes: string[]) {
  const captured: CapturedWrite[] = [];
  const rehearsal = newDryRunRehearsal((write) => captured.push(write));
  const adapters = Object.fromEntries(
    adapterTypes.map((type) => [type, wrapAdapterForDryRun(unreachableTarget(type), rehearsal)]),
  );
  return { captured, adapters };
}

describe('a rehearsed write carries what it hangs off', () => {
  it('a linked create names its parent and the edge', async () => {
    const { captured, adapters } = rehearsalOf(['affinity']);

    await adapters.affinity!.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Pipeline', 'Deal Stage': 'Sourced', 'Deal Size': 5000000 },
      parentLinks: [
        { recordType: 'Organization', externalId: '9601', edgeName: 'List Entries' },
      ],
      mutationContext: MUTATION,
    });

    expect(captured).toEqual([
      {
        kind: 'create',
        adapterType: 'affinity',
        recordType: 'Organization List Entry',
        fields: { listName: 'Pipeline', 'Deal Stage': 'Sourced', 'Deal Size': 5000000 },
        parents: [{ recordType: 'Organization', externalId: '9601', edgeName: 'List Entries' }],
      },
    ]);
  });

  // A parent id that reads like any other id, for a record that does not exist,
  // is the shape a reader cannot tell apart on their own.
  it('a parent this rehearsal invented is marked rehearsed', async () => {
    const { captured, adapters } = rehearsalOf(['affinity']);

    const org = await adapters.affinity!.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Acme' },
      mutationContext: MUTATION,
    });
    await adapters.affinity!.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Pipeline' },
      parentLinks: [
        { recordType: 'Organization', externalId: org.externalId, edgeName: 'List Entries' },
      ],
      mutationContext: MUTATION,
    });

    expect(captured[0]!.parents).toBeUndefined();
    expect(captured[1]!.parents).toEqual([
      {
        recordType: 'Organization',
        externalId: org.externalId,
        edgeName: 'List Entries',
        rehearsed: true,
      },
    ]);
  });

  // The ids a rehearsal mints are the RUN's: a chained write routinely crosses
  // systems, and a per-adapter memory would report the parent as real.
  it('the rehearsed mark crosses adapters, because the rehearsal is the run’s', async () => {
    const { captured, adapters } = rehearsalOf(['attio', 'kg']);

    const company = await adapters.attio!.createRecord({
      recordType: 'companies',
      fields: { name: 'Acme' },
      mutationContext: MUTATION,
    });
    await adapters.kg!.createRecord({
      recordType: 'funding_round',
      fields: { amount: 1000 },
      parentLinks: [
        { recordType: 'companies', externalId: company.externalId, edgeName: 'raised' },
      ],
      mutationContext: MUTATION,
    });

    expect(captured[1]!.parents?.[0]?.rehearsed).toBe(true);
  });

  // Matching still runs against the live target under a rehearsal, so a write
  // that FOUND its record hands the record's own id back — reads off that
  // handle work. Only a create has no id to hand back.
  it('an update keeps the real id, and its parent is not rehearsed', async () => {
    const { captured, adapters } = rehearsalOf(['affinity']);

    const result = await adapters.affinity!.updateRecord({
      recordType: 'Organization List Entry',
      externalId: '17',
      fields: { 'Deal Stage': 'Screening' },
      parentLinks: [
        { recordType: 'Organization', externalId: '9601', edgeName: 'List Entries' },
      ],
      mutationContext: MUTATION,
    });

    expect('externalId' in result ? result.externalId : undefined).toBe('17');
    expect(captured).toEqual([
      {
        kind: 'update',
        adapterType: 'affinity',
        recordType: 'Organization List Entry',
        externalId: '17',
        fields: { 'Deal Stage': 'Screening' },
        parents: [{ recordType: 'Organization', externalId: '9601', edgeName: 'List Entries' }],
      },
    ]);
  });

  it('a root write hangs off nothing and says so by carrying no parents', async () => {
    const { captured, adapters } = rehearsalOf(['affinity']);

    await adapters.affinity!.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Acme' },
      parentLinks: [],
      mutationContext: MUTATION,
    });

    expect(captured[0]).not.toHaveProperty('parents');
  });
});
