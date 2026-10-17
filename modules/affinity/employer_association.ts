// Affinity's built-in person↔organization association — who a person works
// for. It is no field on either record: it is the person's `organization_ids`,
// which is why it needs a module of its own. Every other Affinity relationship
// IS a field, and is made by looking one up and writing it.
//
// ONE implementation, deliberately. `write org-[:People]-> { … }` onto a person
// the engine matched and `link org -[:People]-> p` are the same act with the
// same two records in hand; two spellings of it would be two things that could
// come to mean different things.

/**
 * A person as the Affinity API returns one. Named because it TRAVELS: the
 * create-or-update read hands its record on to the write it feeds, so the same
 * person is never fetched twice in one write.
 */
export interface AffinityPersonRecord {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  primary_email?: string | null;
  emails?: string[] | null;
  organization_ids?: number[] | null;
}

/** The one thing this file asks of a client. Structural, so it is satisfied by
 *  the real client and by any stand-in without either being named here. */
export interface PersonWriter {
  updatePerson(
    id: number,
    payload: { organization_ids?: number[] },
  ): Promise<unknown>;
}

/**
 * Join a person to an organization. The association is N×M, so the org is
 * APPENDED and the person's other employers survive. Idempotent: a person
 * already there is left alone and nothing is sent.
 *
 * Takes the person RECORD, not an id, so a caller that has already read it does
 * not read it again — and hands back the record as it now stands, folded from
 * what was actually sent.
 */
export async function attachPersonToOrganisation(
  client: PersonWriter,
  input: { person: AffinityPersonRecord; orgId: number },
): Promise<{ association: 'made' | 'already'; person: AffinityPersonRecord }> {
  if (input.person.organization_ids?.includes(input.orgId)) {
    return { association: 'already', person: input.person };
  }
  const organization_ids = [...(input.person.organization_ids ?? []), input.orgId];
  await client.updatePerson(input.person.id, { organization_ids });
  return { association: 'made', person: { ...input.person, organization_ids } };
}

/** Leave an organization — the exact inverse, idempotent in the same way: a
 *  person who never belonged reports `removed: false` and sends nothing. */
export async function detachPersonFromOrganisation(
  client: PersonWriter,
  input: { person: AffinityPersonRecord; orgId: number },
): Promise<{ removed: boolean; person: AffinityPersonRecord }> {
  const current = input.person.organization_ids ?? [];
  if (!current.includes(input.orgId)) return { removed: false, person: input.person };
  const organization_ids = current.filter((id) => id !== input.orgId);
  await client.updatePerson(input.person.id, { organization_ids });
  return { removed: true, person: { ...input.person, organization_ids } };
}
