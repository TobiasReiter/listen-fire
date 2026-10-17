// A fake Affinity for the adapter's unit tests: the real AffinityAdapter over
// a fake client and operations that record every call, with a small seeded
// workspace (fields, lists, notes, files, opportunities, reminders,
// interactions). Shared with the platform's tests that run the adapter
// through its own projection.

import type { FileRef } from 'movement-engine/public/adapter';

import { refusingModels } from 'module-kit';
import { AffinityAdapter } from '../adapter';

/** Files the host holds, by handle: what `ctx.files.read` redeems. */
const heldFiles = new Map<string, Uint8Array>();
const testFiles = {
  put: async (): Promise<never> => {
    throw new Error('no put in this test');
  },
  read: async (ref: FileRef): Promise<Uint8Array> => {
    const source = ref.source;
    const bytes = source !== undefined && 'handle' in source && typeof source.handle === 'string' ? heldFiles.get(source.handle) : undefined;
    if (bytes === undefined) throw new Error(`no such file: ${ref.name ?? '(unnamed)'}`);
    return bytes;
  },
  expose: async (): Promise<never> => {
    throw new Error('no expose in this test');
  },
};

export function testFileStore(): { file(text: string, meta: { name: string; contentType: string }): FileRef } {
  return {
    file(text, meta) {
      const handle = `held-${heldFiles.size + 1}`;
      heldFiles.set(handle, new TextEncoder().encode(text));
      return { __brand: 'FileRef', ...meta, source: { adapterType: 'test', handle } };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake apiClient + operations
// ---------------------------------------------------------------------------

/** What the write hands the operations layer to identify a person: the full
 *  name to search on, plus the author's own split when they named those
 *  fields. */
interface PersonSearchQuery {
  name: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

interface FakeCalls {
  findMatchingOrganisation: Array<{ name: string; domain?: string | null }>;
  findMatchingPerson: Array<{ name: string; email?: string | null }>;
  createOrUpdateOrganisation: Array<{ searchQuery: { name: string; domain?: string | null }; affinityId?: number }>;
  createOrUpdatePerson: Array<{ searchQuery: PersonSearchQuery; affinityId?: number; orgId?: number }>;
  createFieldValue: Array<{ field_id: number; entity_id?: number; list_entry_id?: number; value: unknown }>;
  updateFieldValue: Array<{ id: number; value: unknown }>;
  deleteFieldValue: Array<{ id: number }>;
  getFieldValues: Array<{ organization_id?: number; person_id?: number; list_entry_id?: number }>;
  uploadEntityFile: Array<{ entityId: number; entityType?: string; fileName: string }>;
  createNote: Array<Record<string, unknown>>;
  listInteractions: Array<{ type: number; scope: Record<string, unknown>; startTime: Date; endTime: Date }>;
  createListEntry: Array<{ listId: number; entityId: number; entityType: string }>;
  updatePerson: Array<{ id: number; payload: { organization_ids?: number[] } }>;
  /** What each root enumeration was narrowed by — `undefined` = the whole
   *  workspace was walked. */
  listOrganisations: Array<{ term?: string }>;
  listPersons: Array<{ term?: string }>;
  deletes: string[];
}

// ── Read-surface fixtures (notes / files / opportunities / reminders /
// interactions / relationship strengths) ────────────────────────────────────

const NOTES: Array<{
  id: number;
  content: string;
  created_at: string;
  updated_at: string | null;
  parent_id: number | null;
  person_ids: number[];
  organization_ids: number[];
  opportunity_ids: number[];
}> = [
  {
    id: 500,
    content: 'Lunch with Jane — wants to invest',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: null,
    parent_id: null,
    person_ids: [7201],
    organization_ids: [7101],
    opportunity_ids: [],
  },
  {
    id: 501,
    content: 'Reply: circulated the memo',
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: null,
    parent_id: 500,
    person_ids: [],
    organization_ids: [],
    opportunity_ids: [],
  },
];

const FILES = [
  {
    id: 600,
    name: 'deck.pdf',
    size: 1024,
    person_id: null,
    organization_id: 7101,
    opportunity_id: null,
    uploader_id: 1,
    created_at: '2026-07-03T00:00:00.000Z',
  },
];

const OPPORTUNITIES = [
  {
    id: 700,
    name: 'Acme — Series A',
    person_ids: [7201],
    organization_ids: [7101],
    list_entries: [
      { id: 9302, list_id: 555, entity_id: 700, entity_type: 8, created_at: '2026-07-04T00:00:00.000Z' },
    ],
  },
];

const REMINDERS = [
  {
    id: 800,
    type: 1,
    reset_type: 1,
    status: 2,
    content: 'Reply to Jane',
    due_date: '2026-08-01T00:00:00.000Z',
    created_at: '2026-07-01T00:00:00.000Z',
    completed_at: null,
    reminder_days: 30,
    creator: { id: 42, first_name: 'Ian', last_name: 'Internal', primary_email: 'ian@acme.vc', emails: ['ian@acme.vc'] },
    owner: { id: 42, first_name: 'Ian', last_name: 'Internal', primary_email: 'ian@acme.vc', emails: ['ian@acme.vc'] },
    completer: null,
    person: { id: 7201, first_name: 'Jane', last_name: 'Doe', primary_email: 'jane@acme.com', emails: ['jane@acme.com'] },
    organization: null,
    opportunity: null,
  },
];

const INTERACTIONS = [
  {
    id: 900,
    type: 3,
    date: '2026-07-05T00:00:00.000Z',
    subject: 'Intro',
    direction: 1,
    from: { id: 7201, first_name: 'Jane', last_name: 'Doe', primary_email: 'jane@acme.com', emails: ['jane@acme.com'] },
    to: [{ id: 42, first_name: 'Ian', last_name: 'Internal', primary_email: 'ian@acme.vc', emails: ['ian@acme.vc'] }],
    cc: [],
  },
  {
    id: 901,
    type: 0,
    date: '2026-07-06T00:00:00.000Z',
    title: 'Kickoff call',
    attendees: ['jane@acme.com', 'ian@acme.vc'],
    start_time: '2026-07-06T00:00:00.000Z',
    end_time: null,
    notes: [500],
    persons: [
      { id: 7201, first_name: 'Jane', last_name: 'Doe', primary_email: 'jane@acme.com', emails: ['jane@acme.com'] },
    ],
  },
];

const RELATIONSHIP_STRENGTHS = [{ external_id: 7201, internal_id: 42, strength: 0.7 }];

// A hand-maintained field carries Affinity's "no provider" sentinel, NOT null:
// the v1 catalog fills `enrichment_source` in for every field. Enriched fields
// (a real provider named) sit beside them and are exactly as writable —
// Affinity accepts a field value on either.
const ORG_FIELDS = [
  { id: 100, name: 'Stage', list_id: null, enrichment_source: 'none', value_type: 7, allows_multiple: false, dropdown_options: [{ id: 1, text: 'Seed', rank: 0, color: 0 }, { id: 2, text: 'Series A', rank: 1, color: 0 }] },
  { id: 101, name: 'Employees', list_id: null, enrichment_source: 'none', value_type: 3, allows_multiple: false, dropdown_options: null },
  { id: 102, name: 'Crunchbase Rank', list_id: null, enrichment_source: 'crunchbase', value_type: 3, allows_multiple: false, dropdown_options: null },
  // List-scoped fields arrive PREFIXED — the catalog is fetched with modified
  // names, so Affinity puts the list in front of every field scoped to it. The
  // per-list type takes its own list's prefix back off; everything else here
  // keeps the name Affinity gave it.
  { id: 103, name: '[Hot Leads] List Score', list_id: 555, enrichment_source: 'none', value_type: 3, allows_multiple: false, dropdown_options: null },
  // A Person-valued custom field — an EDGE (surfaces in references[], not fields[]).
  { id: 104, name: 'Primary Contact', list_id: null, enrichment_source: 'none', value_type: 0 /* PERSON */, allows_multiple: false, dropdown_options: null },
  // A plain DROPDOWN (2). Unlike a RANKED_DROPDOWN (7), whose value arrives as
  // the whole option object, this one arrives as a bare option id.
  { id: 105, name: 'Segment', list_id: null, enrichment_source: 'none', value_type: 2, allows_multiple: false, dropdown_options: [{ id: 8, text: 'Enterprise', rank: 0, color: 0 }] },
  // Enrichment-sourced AND list-scoped: the per-list write variant carries it
  // like any other list field.
  { id: 106, name: '[Hot Leads] Affinity Score', list_id: 555, enrichment_source: 'affinity-data', value_type: 3, allows_multiple: false, dropdown_options: null },
  // An enrichment-sourced REFERENCE field: an edge the link writer serves
  // like any other reference.
  { id: 107, name: 'Enriched Contact', list_id: null, enrichment_source: 'dealroom', value_type: 0 /* PERSON */, allows_multiple: false, dropdown_options: null },
  // A list-scoped REFERENCE field: an EDGE on the per-list type, so the prefix
  // has to come off the edge's name the same way it comes off a field's.
  { id: 108, name: '[Hot Leads] Owners', list_id: 555, enrichment_source: 'none', value_type: 0 /* PERSON */, allows_multiple: true, dropdown_options: null },
  // A list-scoped field whose bare name is ALREADY taken, verbatim, by the
  // entity-level `Segment` (105). One name has to mean one field, so this one
  // keeps its prefix.
  { id: 109, name: '[Hot Leads] Segment', list_id: 555, enrichment_source: 'none', value_type: 6, allows_multiple: false, dropdown_options: null },
  // A list-scoped MULTI-value field: it reads back as the whole list, which is
  // what an append (`+:`) has to merge against.
  { id: 110, name: '[Hot Leads] Tags', list_id: 555, enrichment_source: 'none', value_type: 6, allows_multiple: true, dropdown_options: null },
];

const PERSON_FIELDS = [
  { id: 200, name: 'Title', list_id: null, enrichment_source: 'none', value_type: 6, allows_multiple: false, dropdown_options: null },
];

export function makeAdapter(input?: {
  /** The record Affinity's matcher fetched, as `findMatching…` hands it back. */
  orgMatch?: { id: number; name?: string | null; domain?: string | null; domains?: string[] | null } | null;
  personMatch?: {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    primary_email?: string | null;
    emails?: string[] | null;
  } | null;
  /** Field-value rows the fake `getFieldValues` returns (for reference-link
   *  idempotency / single-vs-multi tests). */
  fieldValues?: Array<{ id: number; field_id: number; list_entry_id: number | null; value?: unknown }>;
  /** When set, the fake `createOrUpdatePerson` throws a 404 for a pinned
   *  `affinityId` — simulates a person deleted out from under an update. */
  personUpdate404?: boolean;
  /** Employers already on the fetched person (person-side association tests). */
  personOrgIds?: number[];
  /** A membership the record already has — what makes a re-asserted write an
   *  update rather than a second entry. */
  existingListEntry?: { id: number; listId: number; entityId: number };
  /** Affinity refuses every field-value write (a 422, say). */
  failFieldValueWrites?: boolean;
  /** Affinity refuses field-value writes to just these fields, with a 422. */
  refuseFieldIds?: number[];
}): { adapter: AffinityAdapter; calls: FakeCalls } {
  const adapter = new AffinityAdapter({
    tenant: 'team-aff',
    client: async () => {
      throw new Error('this test replaces the client');
    },
    models: refusingModels('this test makes no model call'),
    files: testFiles,
    fetch,
  });
  const calls: FakeCalls = {
    findMatchingOrganisation: [],
    findMatchingPerson: [],
    createOrUpdateOrganisation: [],
    createOrUpdatePerson: [],
    createFieldValue: [],
    updateFieldValue: [],
    deleteFieldValue: [],
    getFieldValues: [],
    uploadEntityFile: [],
    createNote: [],
    listInteractions: [],
    createListEntry: [],
    updatePerson: [],
    listOrganisations: [],
    listPersons: [],
    deletes: [],
  };

  const fakeClient = {
    getWhoami: async () => ({ tenant: { id: 1, name: 'Acme', subdomain: 'acme' }, user: { id: 1, firstName: 'A', lastName: 'B', email: 'a@b.co' }, grant: { type: 't', scope: 's', createdAt: '' } }),
    getFields: async ({ type, limitToListId }: { type?: string; limitToListId?: number }) => {
      const base = type === 'PERSON' ? PERSON_FIELDS : ORG_FIELDS;
      return limitToListId ? base.filter((f) => !f.list_id || f.list_id === limitToListId) : base;
    },
    getAllLists: async () => [
      { id: 555, name: 'Hot Leads', type: 1 /* organization list */ },
      { id: 556, name: 'People List', type: 0 /* person list */ },
      { id: 557, name: 'Deals', type: 8 /* opportunity list */ },
    ],
    // Root-collection reads (layer 7 category 3): the enumerations the
    // readable entry points promise.
    listOrganisations: async ({ term }: { term?: string } = {}) => {
      calls.listOrganisations.push({ term });
      return [
        { id: 7101, name: 'Acme', domain: 'acme.com', domains: ['acme.com'], person_ids: [7201], global: false },
      ];
    },
    listPersons: async ({ term }: { term?: string } = {}) => {
      calls.listPersons.push({ term });
      return [
        { id: 7201, first_name: 'Jane', last_name: 'Doe', primary_email: 'jane@acme.com', emails: ['jane@acme.com'], organization_ids: [7101] },
      ];
    },
    getListEntries: async ({ listId }: { listId: number }) =>
      listId === 555
        ? [{ id: 9301, list_id: 555, entity_id: 7101, entity_type: 1, created_at: '2026-07-17T00:00:00.000Z' }]
        : [],
    getExistingListEntryId: async ({ list, entityId }: { list: { id: number }; entityId: number }) => {
      const e = input?.existingListEntry;
      return e && e.listId === list.id && e.entityId === entityId ? e.id : null;
    },
    getEntityListEntries: async ({ entityId }: { entityId: number }) => {
      const e = input?.existingListEntry;
      return e && e.entityId === entityId
        ? [{ id: e.id, list_id: e.listId, entity_id: e.entityId, created_at: '2026-09-01T00:00:00.000Z' }]
        : [];
    },
    getListEntry: async ({ listId, listEntryId }: { listId: number; listEntryId: number }) => ({
      id: listEntryId,
      list_id: listId,
      entity_id: input?.existingListEntry?.entityId ?? 42,
      created_at: '2026-09-01T00:00:00.000Z',
    }),
    getOrganisationById: async (id: number) => ({ id, name: 'Acme', domain: 'acme.com', domains: ['acme.com'], person_ids: [] }),
    getPersonById: async (id: number) => ({ id, first_name: 'Jane', last_name: 'Doe', primary_email: 'jane@acme.com', emails: ['jane@acme.com'], organization_ids: input?.personOrgIds ?? [] }),
    updatePerson: async (id: number, payload: { organization_ids?: number[] }) => {
      calls.updatePerson.push({ id, payload });
      return { id };
    },
    createOrganisation: async ({ name }: { name: string }) => ({ id: 999, name }),
    // Scope-aware, like the real `/field-values`: an entity-scoped query also
    // returns that entity's LIST-ENTRY rows (the caller is expected to filter
    // them out), while a list-entry query returns only that entry's rows.
    getFieldValues: async (args: { organization_id?: number; person_id?: number; list_entry_id?: number } = {}) => {
      calls.getFieldValues.push(args);
      const rows = (input?.fieldValues ?? []) as Array<{ id: number; field_id: number; list_entry_id: number | null; value?: unknown }>;
      if (args.list_entry_id != null) return rows.filter((r) => r.list_entry_id === args.list_entry_id);
      return rows;
    },
    createFieldValue: async (args: { field_id: number; entity_id?: number; list_entry_id?: number; value: unknown }) => {
      calls.createFieldValue.push(args);
      if (input?.failFieldValueWrites) throw new Error('Affinity Error: 422 (Unprocessable Entity)');
      if (input?.refuseFieldIds?.includes(args.field_id)) {
        throw new Error('Affinity Error: 422 (Unprocessable Entity): {"message":"Field is not editable"}');
      }
      return {};
    },
    updateFieldValue: async (args: { id: number; value: unknown }) => {
      calls.updateFieldValue.push(args);
      if (input?.failFieldValueWrites) throw new Error('Affinity Error: 422 (Unprocessable Entity)');
      return {};
    },
    deleteFieldValue: async (args: { id: number }) => {
      calls.deleteFieldValue.push(args);
      return {};
    },
    uploadEntityFile: async (args: { entity: { id: number }; entityType?: string; file: File }) => { calls.uploadEntityFile.push({ entityId: args.entity.id, entityType: args.entityType, fileName: args.file.name }); },
    // Read surfaces (scoped enumerations + fetch-by-id).
    listNotes: async (filter: { personId?: number; organizationId?: number; opportunityId?: number } = {}) =>
      NOTES.filter((n) => {
        if (filter.organizationId != null) return n.organization_ids.includes(filter.organizationId);
        if (filter.personId != null) return n.person_ids.includes(filter.personId);
        if (filter.opportunityId != null) return n.opportunity_ids.includes(filter.opportunityId);
        return true;
      }),
    getNoteById: async (id: number) => {
      const note = NOTES.find((n) => n.id === id);
      if (!note) throw new Error('Affinity Error: 404');
      return note;
    },
    listEntityFiles: async (filter: { personId?: number; organizationId?: number; opportunityId?: number } = {}) =>
      FILES.filter((f) => {
        if (filter.organizationId != null) return f.organization_id === filter.organizationId;
        if (filter.personId != null) return f.person_id === filter.personId;
        if (filter.opportunityId != null) return f.opportunity_id === filter.opportunityId;
        return true;
      }),
    listOpportunities: async () => OPPORTUNITIES,
    getOpportunityById: async (id: number) => {
      const opp = OPPORTUNITIES.find((o) => o.id === id);
      if (!opp) throw new Error('Affinity Error: 404');
      return opp;
    },
    listReminders: async (_filter: Record<string, number> = {}) => REMINDERS,
    getRelationshipStrengths: async ({ externalId, internalId }: { externalId: number; internalId?: number }) =>
      RELATIONSHIP_STRENGTHS.filter(
        (s) => s.external_id === externalId && (internalId == null || s.internal_id === internalId),
      ),
    listInteractions: async (args: {
      type: number;
      personId?: number;
      organizationId?: number;
      opportunityId?: number;
      startTime: Date;
      endTime: Date;
    }) => {
      const { type, startTime, endTime, ...scope } = args;
      calls.listInteractions.push({ type, scope, startTime, endTime });
      return INTERACTIONS.filter((i) => i.type === type);
    },
    deleteOrganisation: async (id: number) => { calls.deletes.push(`organization:${id}`); return { success: true }; },
    deletePerson: async (id: number) => { calls.deletes.push(`person:${id}`); return { success: true }; },
    deleteNote: async (id: number) => { calls.deletes.push(`note:${id}`); return { success: true }; },
    deleteListEntry: async (args: { listId: number; listEntryId: number }) => {
      calls.deletes.push(`list-entry:${args.listId}:${args.listEntryId}`);
      return { success: true };
    },
  };

  const fakeOperations = {
    getClient: () => fakeClient,
    findMatchingOrganisation: async (q: { name: string; domain?: string | null }) => {
      calls.findMatchingOrganisation.push(q);
      return input?.orgMatch ?? null;
    },
    findMatchingPerson: async (q: { name: string; email?: string | null }) => {
      calls.findMatchingPerson.push(q);
      return input?.personMatch ?? null;
    },
    createOrUpdateOrganisation: async (args: { searchQuery: { name: string; domain?: string | null }; affinityId?: number }) => {
      calls.createOrUpdateOrganisation.push(args);
      return { id: args.affinityId ?? 999, isNew: args.affinityId == null };
    },
    createOrUpdatePerson: async (args: { searchQuery: PersonSearchQuery; affinityId?: number; orgId?: number }) => {
      calls.createOrUpdatePerson.push(args);
      if (input?.personUpdate404 && args.affinityId != null) {
        throw new Error('Affinity Error: 404 Not Found');
      }
      const id = args.affinityId ?? 888;
      // The live person travels back with the result — the caller builds its
      // write result from it rather than re-fetching the person.
      return {
        id,
        isNew: args.affinityId == null,
        orgAssociation: args.orgId ? ('made' as const) : ('none' as const),
        person: {
          id,
          first_name: args.searchQuery.firstName ?? args.searchQuery.name?.split(' ')[0] ?? null,
          last_name: args.searchQuery.lastName ?? args.searchQuery.name?.split(' ').slice(1).join(' ') ?? null,
          primary_email: args.searchQuery.email ?? null,
          emails: args.searchQuery.email ? [args.searchQuery.email] : [],
          organization_ids: args.orgId ? [args.orgId] : [],
        },
      };
    },
    createPerson: async () => ({ id: 888 }),
    createNote: async (args: Record<string, unknown>) => {
      calls.createNote.push(args);
      return { id: 502 };
    },
    createListEntry: async (args: { listId: number; entityId: number; entityType: string }) => {
      calls.createListEntry.push(args);
      const e = input?.existingListEntry;
      return e && e.listId === args.listId && e.entityId === args.entityId
        ? { id: e.id, isNew: false }
        : { id: 9999, isNew: true };
    },
  };

  (adapter as unknown as { getApiClient: () => Promise<typeof fakeClient> }).getApiClient = async () => {
    (adapter as unknown as { web: { getWebBaseUrl: () => Promise<string> } }).web = {
      getWebBaseUrl: async () => 'https://acme.affinity.co',
    };
    return fakeClient;
  };
  (adapter as unknown as { getOperations: () => Promise<typeof fakeOperations> }).getOperations = async () => {
    await (adapter as unknown as { getApiClient: () => Promise<unknown> }).getApiClient();
    return fakeOperations;
  };

  return { adapter, calls };
}

// ---------------------------------------------------------------------------
// 1. Fixed-entity structured id (the name → id cache's pure half)
// ---------------------------------------------------------------------------
