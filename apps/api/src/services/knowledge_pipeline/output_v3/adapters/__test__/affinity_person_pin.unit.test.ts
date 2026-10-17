// Regression guard for the Affinity 422 "There exists a contact with this email
// address". A person the pipeline has already written is bound in
// `linked_object`; `buildSearchStrategy` recovers that binding as a Tier 0
// match. `executePerson` used to drop it, so every write re-derived identity
// from a fuzzy name/email search — and when that search missed a person who
// demonstrably exists, the write fell through to CREATE and Affinity rejected
// it on its one-person-per-email constraint.
//
// The organization path (`executeOrganization`) always passed the pin through;
// this is the person path catching up.

jest.mock('../../resolve', () => ({
  resolveFieldMapping: jest.fn(async (mapping: { targetField: string }) =>
    mapping.targetField === '__builtin' ? '__MAPPED__' : null,
  ),
  buildLLMContext: jest.fn(async () => ''),
  resolvePreserveTags: jest.fn(async () => new Map()),
  loadResources: jest.fn(async () => null),
}));

import type { AffinityOperations } from '@listen-fire/affinity/operations';

import { createAffinityV3Adapter } from '../affinity';
import { resolveFieldMapping } from '../../resolve';

const BOUND_PERSON_ID = 777;
const EMAIL = 'ada@example.com';

/** Stands in for Affinity's actual semantics: emails are unique across people,
 *  and a create carrying an already-owned email is rejected with a 422. The
 *  search deliberately MISSES the bound person — that is the precondition the
 *  production failure proves was true (Affinity said the email exists while our
 *  search said it did not). */
function makeOperations() {
  const calls: { affinityId?: number }[] = [];
  const findMatchingPerson = jest.fn(async () => null);

  const operations = {
    findMatchingPerson,
    createOrUpdatePerson: jest.fn(async (opts: { affinityId?: number }) => {
      calls.push({ affinityId: opts.affinityId });
      if (opts.affinityId == null) {
        throw new Error(
          'Affinity Error: 422 (Unprocessable Entity): ["There exists a contact with this email address."]',
        );
      }
      return { id: opts.affinityId, isNew: false };
    }),
    updateFieldValues: jest.fn(async () => {}),
    getClient: () => ({
      getWhoami: async () => ({ tenant: { subdomain: 'test' } }),
      getPersonById: async (id: number) => ({
        id,
        first_name: 'Ada',
        last_name: 'Lovelace',
        primary_email: EMAIL,
        emails: [EMAIL],
      }),
      getFields: async () => [],
    }),
  };

  return { operations: operations as unknown as AffinityOperations, calls, findMatchingPerson };
}

function makeInput(linkedExternalId: string | null) {
  return {
    type: 'affinity:person',
    adapterConfig: {
      name: { selection: { kind: 'property' }, traversal: [], aggregation: null },
      email: { selection: { kind: 'property' }, traversal: [], aggregation: null },
    },
    fieldValues: {},
    fieldMappings: [],
    parentResult: null,
    relationship: null,
    contextNodeId: 'node-1',
    context: {},
    linkedObjects: linkedExternalId
      ? [{ externalId: linkedExternalId, nodeId: 'node-1', adapterType: 'affinity' }]
      : [],
    resource: null,
  } as unknown as Parameters<ReturnType<typeof createAffinityV3Adapter>['execute']>[0];
}

describe('Affinity v3 adapter — person write honours the linked-object pin', () => {
  beforeEach(() => {
    (resolveFieldMapping as jest.Mock).mockClear();
  });

  it('passes the bound Affinity id through to the write instead of re-searching', async () => {
    const { operations, calls, findMatchingPerson } = makeOperations();
    const adapter = createAffinityV3Adapter(operations);

    const result = await adapter.execute(makeInput(String(BOUND_PERSON_ID)));

    // Tier 0 short-circuits the fuzzy search entirely.
    expect(findMatchingPerson).not.toHaveBeenCalled();
    // …and the pin reaches the write, so no create is attempted.
    expect(calls).toEqual([{ affinityId: BOUND_PERSON_ID }]);
    expect(result.externalId).toBe(String(BOUND_PERSON_ID));
    expect(result.created).toBe(false);
  });

  it('surfaces the 422 only when there is genuinely no binding to reconcile against', async () => {
    const { operations } = makeOperations();
    const adapter = createAffinityV3Adapter(operations);

    await expect(adapter.execute(makeInput(null))).rejects.toThrow(
      'There exists a contact with this email address',
    );
  });
});
