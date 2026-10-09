// `write org-[:People]-> { … }` against a person who already exists with
// exactly the names the write carries. The engine suppresses every field, so
// the adapter is called with an EMPTY field set and the parent org — and the
// association is the whole point of the call: matching is not associating
// (prod run 3285f127, where the run said "update, committed" and no person
// ever joined an organization).
//
// What this pins is that the pinned-id path does the association and NOTHING
// else: no PUT of the person's own unchanged fields, and no PUT at all once
// the person already belongs to the org (so a re-run is free) — and that it
// asks Affinity for the person exactly ONCE. The pinned id's existence, the
// employer check and the address check are three parts of one question about
// one record that cannot change between them.

import type { AffinityAPIClient } from '../apiClient';

import { AffinityOperations } from '../operations';
import { createNoopTracer } from '../../../services/translation_graph/adapters/affinity/shared';

const PERSON_ID = 77;
const ORG_ID = 501;

function operationsWith(organizationIds: number[]) {
  const getPersonById = jest.fn(async (id: number) => ({
    id,
    first_name: 'Ada',
    last_name: 'Lovelace',
    primary_email: null,
    emails: [],
    organization_ids: organizationIds,
  }));
  const updatePerson = jest.fn(async (id: number, payload: Record<string, unknown>) => ({
    id,
    ...payload,
  }));
  const findManyPeople = jest.fn(async () => {
    throw new Error('a pinned update must never search by name');
  });

  const client = { getPersonById, updatePerson, findManyPeople } as unknown as AffinityAPIClient;
  return { operations: new AffinityOperations(client), getPersonById, updatePerson };
}

/** The shape the adapter's update path hands over for a parent-only attach:
 *  a pinned id, the org, and no field values of any kind. */
const attachOnly = {
  searchQuery: { name: 'Ada Lovelace' },
  userText: '',
  tracer: createNoopTracer(),
  fieldConfigurations: [],
  orgId: ORG_ID,
  affinityId: PERSON_ID,
};

/** The person a call reports back — the record it read, not a fresh fetch. */
const personWith = (organizationIds: number[], emails: string[] = []) => ({
  id: PERSON_ID,
  first_name: 'Ada',
  last_name: 'Lovelace',
  primary_email: null,
  emails,
  organization_ids: organizationIds,
});

describe('createOrUpdatePerson — a pinned person with no field changes joins the parent org', () => {
  it('adds the org to organization_ids, and writes nothing else', async () => {
    const { operations, updatePerson, getPersonById } = operationsWith([42]);

    const result = await operations.createOrUpdatePerson(attachOnly);

    // The association is not just attempted — the call says it MADE it — and
    // the record it read travels back with it.
    expect(result).toEqual({
      id: PERSON_ID,
      isNew: false,
      orgAssociation: 'made',
      person: { ...personWith([42, ORG_ID]), organization_ids: [42, ORG_ID] },
    });
    // Exactly one write, and it extends the membership list rather than
    // replacing the person's own fields.
    expect(updatePerson.mock.calls).toEqual([[PERSON_ID, { organization_ids: [42, ORG_ID] }]]);
    // ONE read: the pinned id's existence, the employer check and the result
    // payload are three parts of one question about one record.
    expect(getPersonById.mock.calls).toEqual([[PERSON_ID]]);
  });

  it('sends no write at all when the person already belongs to the org', async () => {
    const { operations, updatePerson, getPersonById } = operationsWith([42, ORG_ID]);

    const result = await operations.createOrUpdatePerson(attachOnly);

    expect(result).toEqual({
      id: PERSON_ID,
      isNew: false,
      orgAssociation: 'already',
      person: personWith([42, ORG_ID]),
    });
    expect(updatePerson).not.toHaveBeenCalled();
    expect(getPersonById.mock.calls).toEqual([[PERSON_ID]]);
  });

  it('touches nothing when the write names no parent org', async () => {
    const { operations, updatePerson, getPersonById } = operationsWith([42]);

    const result = await operations.createOrUpdatePerson({ ...attachOnly, orgId: undefined });

    expect(result).toEqual({
      id: PERSON_ID,
      isNew: false,
      orgAssociation: 'none',
      person: personWith([42]),
    });
    expect(updatePerson).not.toHaveBeenCalled();
    expect(getPersonById.mock.calls).toEqual([[PERSON_ID]]);
  });

  // The address check used to open its own GET of the same person. It reads
  // the record already in hand, and the PUT it makes answers with the updated
  // one — so an authored address still costs no extra read.
  it('appends an unowned address off the same read', async () => {
    const { operations, updatePerson, getPersonById } = operationsWith([ORG_ID]);

    await operations.createOrUpdatePerson({
      ...attachOnly,
      searchQuery: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });

    expect(updatePerson.mock.calls).toEqual([[PERSON_ID, { emails: ['ada@example.com'] }]]);
    expect(getPersonById.mock.calls).toEqual([[PERSON_ID]]);
  });
});
