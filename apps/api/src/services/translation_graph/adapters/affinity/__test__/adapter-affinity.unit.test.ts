// Unit tests for the Affinity TG adapter — pure helpers + mocked
// operations/apiClient (no network, no LLM). Covers:
//   1. type-id codec round-trip + rejection of foreign/malformed ids.
//   2. describe — built-in + custom field mapping, read-only (enrichment)
//      fields surfaced writable:false, org↔person references.
//   3. resolveEntity — org matches by domain/name (findMatchingOrganisation);
//      person matches by email (findMatchingPerson); bridge wins over search.
//   4. createRecord(organization) — built-in/custom field split + read-only
//      custom field filtered from writes.
//
// Module-scope deps that crash at load (credentials master key, the affinity
// apiClient's registry/token chain, openai, the broken output_v3 zod chain)
// are stubbed exactly as the Airtable adapter test does.

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => '{}',
  encryptToken: async () => '',
}));

jest.mock('../../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// The real Affinity apiClient pulls in the adapters registry / slack chain
// that crashes at module load in jest. The adapter under test references
// `AffinityAPIClient` + `getAffinityClient` (never called — getApiClient is
// overridden) and `AffinityMergedEntityError` (an instanceof guard). Stub all.
jest.mock('../../../../../adapters/affinity/apiClient', () => ({
  AffinityAPIClient: class {},
  getAffinityClient: () => ({}),
  AffinityMergedEntityError: class extends Error {},
  valueType: { PERSON: 0, ORGANIZATION: 1, DROPDOWN: 2, NUMBER: 3, DATE: 4, LOCATION: 5, TEXT: 6, RANKED_DROPDOWN: 7 },
  INTERACTION_TYPE: { MEETING: 0, CALL: 1, CHAT_MESSAGE: 2, EMAIL: 3 },
  locationFieldValue: { parse: (v: unknown) => v },
}));

jest.mock('../../../../../adapters/affinity/operations', () => ({
  AffinityOperations: class {},
}));

jest.mock('../../../../../adapters/registry', () => ({
  services: { document: { getFile: async () => null } },
}));

jest.mock('../../../../../lib/anthropic', () => ({
  anthropicChat: async () => '{}',
}));

// types.ts transitively loads the broken output_v3/schemas zod chain. Stub at
// the leaf — the adapter consumes it only at type level.
jest.mock('../../../../knowledge_pipeline/output_v3/schemas', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret, extend: ret, merge: ret,
    pick: ret, omit: ret, partial: ret, describe: ret, or: ret, and: ret, min: ret,
  });
  return {
    traversalStepSchema: stub,
    fieldRefSchema: stub,
    expressionSchema: stub,
    filterExpressionSchema: stub,
    webhookGraphOutputConfigSchema: stub,
  };
});

jest.mock('../../../../knowledge_pipeline/uniqueness_constraints', () => {
  const stub: Record<string, unknown> = {};
  const ret = () => stub;
  Object.assign(stub, {
    optional: ret, nullable: ret, default: ret, array: ret,
    parse: (v: unknown) => v, safeParse: (v: unknown) => ({ success: true, data: v }),
    refine: ret, transform: ret,
  });
  return {
    isEdgeToEntry: (entry: { kind?: string }) => entry?.kind === 'edge_to',
    storedUniquenessConstraintsSchema: stub,
  };
});

import {
  checkProgram,
  fromCatalogSnapshot,
  parseProgram,
  scanInstanceChains,
  type CatalogSnapshot,
} from 'movement-lang';

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import type { ResolveEntityInput } from '../../../adapter';
import type { Expression } from '#shared/expression/types';
import type { SourcePosition } from '../../../types';

import { installMemoryDocumentStore } from '../../../engine/files/__test__/memory_document_store';
import { AffinityAdapter, AFFINITY_MANIFEST } from '../index';
import { decodedFixedType, listScopedFieldDisplayNames } from '../types';
import { instanceSchemaFromDescriptors } from '../../../movement/schema_projection';
import { refineInstanceSchema } from '../../../movement/refinements';
import {
  isStablePosition,
  makeMetaPosition,
  makeStablePosition,
  positionData,
  positionLabel,
  positionRecordId,
} from '../../../types';


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

function makeAdapter(input?: {
  orgMatch?: { id: number } | null;
  personMatch?: { id: number } | null;
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
  const adapter = new AffinityAdapter({ teamId: 'team-aff' as TeamId, credentialsId: 'creds-1' });
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

describe('Affinity fixed-entity structured id', () => {
  it('resolves each fixed entity NAME to its structured id', () => {
    // The five fixed entities resolve PURELY from their pretty names — no
    // encoded `affinity:<entity>` string, no introspection.
    expect(decodedFixedType('Organization')).toEqual({ entity: 'organization' });
    expect(decodedFixedType('Person')).toEqual({ entity: 'person' });
    expect(decodedFixedType('List Entry')).toEqual({ entity: 'list-entry' });
    expect(decodedFixedType('Note')).toEqual({ entity: 'note' });
    expect(decodedFixedType('File')).toEqual({ entity: 'file' });
  });

  it('returns null for an unknown name, a foreign id, or a per-list name', () => {
    // Per-list entry names (`List Entry — <list>`) carry a listId only the live
    // catalog knows — they are NOT resolved by the pure fixed-entity helper.
    expect(decodedFixedType('List Entry — Hot Leads')).toBeNull();
    expect(decodedFixedType('affinity:organization')).toBeNull(); // the encoded id is retired
    expect(decodedFixedType('attio:companies')).toBeNull();
    expect(decodedFixedType('Bogus')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. describe
// ---------------------------------------------------------------------------

describe('AffinityAdapter.describe', () => {
  it('maps organization built-ins, custom fields, enrichment read-only flag, and the people reference', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('Organization');
    expect(descriptor).not.toBeNull();
    expect(descriptor!.displayName).toBe('Organization');

    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    // built-ins
    expect(byId.get('name')!.kind).toBe('string');
    expect(byId.get('name')!.writable).toBe(true);
    expect(byId.get('domain')!.writable).toBe(true);
    expect(byId.get('domains')!.writable).toBe(false);
    // custom: ranked dropdown → enum with options
    expect(byId.get('100')!.kind).toBe('enum');
    expect(byId.get('100')!.enumValues).toEqual(['Seed', 'Series A']);
    // custom: number
    expect(byId.get('101')!.kind).toBe('number');
    // A hand-maintained field (the "no provider" sentinel) IS writable — the
    // whole point of the rule; only a real provider closes a field.
    expect(byId.get('100')!.writable).toBe(true);
    expect(byId.get('101')!.writable).toBe(true);
    // an enriched field is writable too — Affinity accepts the value
    expect(byId.get('102')!.writable).toBe(true);
    // list-scoped field is excluded from the entity-level describe
    expect(byId.has('103')).toBe(false);
    // a Person-valued custom field is an EDGE, not a scalar field
    expect(byId.has('104')).toBe(false);

    // references: built-in `people` + the Person-valued custom field `Primary
    // Contact` (an FK is an edge by default — surfaced here so the movement
    // schema projection treats it as a writable edge rather than dropping it).
    const refsById = new Map(descriptor!.references.map((r) => [r.fieldId, r]));
    expect(refsById.get('people')!.targetTypeId).toBe('Person');
    expect(refsById.get('104')!.targetTypeId).toBe('Person');
    expect(refsById.get('104')!.name).toBe('Primary Contact');
    expect(refsById.get('104')!.cardinality).toBe('one');
    expect(refsById.get('104')!.writable).toBe(true);
    // An enrichment-sourced reference is an edge like any other, and writable.
    expect(refsById.get('107')!.writable).toBe(true);

    // identity is the TG layer's concern — no invented native constraints …
    expect(descriptor!.uniquenessConstraints).toBeUndefined();
    // … but org resolution IS fuzzy (findMatchingOrganisation), so FUZZY is allowed.
    expect(descriptor!.supportsFuzzyResolution).toBe(true);
  });

  it('maps person built-ins + the organizations reference, and advertises fuzzy resolution', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('Person');
    expect(descriptor).not.toBeNull();
    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('email')!.writable).toBe(true);
    expect(byId.get('emails')!.writable).toBe(false);
    expect(byId.get('200')!.kind).toBe('string'); // custom TEXT
    expect(descriptor!.references[0].fieldId).toBe('organizations');
    expect(descriptor!.references[0].targetTypeId).toBe('Organization');
    expect(descriptor!.supportsFuzzyResolution).toBe(true);
  });

  it('returns null for a foreign / unknown typeId', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('attio:companies')).toBeNull();
    expect(await adapter.describe('affinity:bogus')).toBeNull();
  });

  it('ONE `List Entries` edge carries BOTH promises, landing on the per-entity collection', async () => {
    const { adapter } = makeAdapter();
    const org = await adapter.describe('Organization');
    const listEntries = org!.references.filter((r) => r.name === 'List Entries');
    // Exactly one — the read/write duality is gone, not merely hidden.
    expect(listEntries).toHaveLength(1);
    expect(listEntries[0]).toMatchObject({
      targetTypeId: 'Organization List Entry',
      writable: true,
    });
    // The retired write-only edge is GONE, not left dangling alongside.
    expect(org!.references.find((r) => r.name === 'Lists')).toBeUndefined();
  });

  it('an opportunity reads its list entries but cannot be written onto a list', async () => {
    const { adapter } = makeAdapter();
    const opportunity = await adapter.describe('Opportunity');
    const edge = opportunity!.references.find((r) => r.name === 'List Entries');
    expect(edge).toMatchObject({ targetTypeId: 'Opportunity List Entry', writable: false });
    // No write shape at all — an absent discriminatedWrite, not an empty one.
    const collection = await adapter.describe('Opportunity List Entry');
    expect(collection!.discriminatedWrite).toBeUndefined();
  });

  it('the collection filters its listName enum + variants to the record kind (layer 12)', async () => {
    const { adapter } = makeAdapter();
    // Hot Leads (555) is an org list; People List (556) a person list.
    const orgList = await adapter.describe('Organization List Entry');
    const listNameField = orgList!.fields.find((f) => f.fieldId === 'listName');
    // READABLE now as well as writable: it is the one field every member shares,
    // and the same word narrows the read and discriminates the write.
    expect(listNameField).toMatchObject({ kind: 'enum', writable: true, readable: true, required: true });
    expect(listNameField!.enumValues).toEqual(['Hot Leads']); // org lists only
    expect(orgList!.discriminatedWrite).toEqual({
      discriminant: 'listName',
      variantTypes: { 'Hot Leads': 'List Entry — Hot Leads' },
    });

    const personList = await adapter.describe('Person List Entry');
    expect(personList!.fields.find((f) => f.fieldId === 'listName')!.enumValues).toEqual(['People List']);
  });

  it('the collection publishes the INTERSECTION only — no per-list field leaks onto it (layer 11)', async () => {
    const { adapter } = makeAdapter();
    const orgList = await adapter.describe('Organization List Entry');
    // `listName` is common to every member; nothing list-scoped is.
    expect(orgList!.fields.map((f) => f.fieldId)).toEqual(['listName']);
    expect(orgList!.references).toEqual([]);
  });

  it('write org-[:List Entries]-> { listName } resolves the list and attaches the parent org', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Hot Leads' },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(calls.createListEntry).toEqual([
      expect.objectContaining({ listId: 555, entityId: 42, entityType: 'organization' }),
    ]);
    expect(result.externalId).toBe('9999');
  });

  it('a list-entry write names its fields the way the LIST shows them', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Hot Leads', 'List Score': 42 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    // Resolved through the per-list type's display-name map to field 103 —
    // the field Affinity spells `[Hot Leads] List Score`.
    expect(calls.createFieldValue).toEqual([
      expect.objectContaining({ field_id: 103, value: 42, list_entry_id: 9999 }),
    ]);
  });

  it("Affinity's own spelling of the same field still writes it", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Hot Leads', '[Hot Leads] List Score': 42 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue).toEqual([
      expect.objectContaining({ field_id: 103, value: 42 }),
    ]);
  });

  it('an enrichment-sourced list field is written like any other', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Hot Leads', 'Affinity Score': 9 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue).toEqual([
      expect.objectContaining({ field_id: 106, value: 9, list_entry_id: 9999 }),
    ]);
  });

  it('a membership write with no listName errors, naming the field', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: 'Organization List Entry',
        fields: {},
        parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/listName/);
  });

  it('the generic (un-narrowed) List Entry publishes NO parent up-hop — the intersection of its members is empty (layer 11)', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('List Entry');
    // Each list is typed, so each per-list member up-hops to a DIFFERENT,
    // distinctly-named parent; the union's directly-accessible surface is their
    // intersection, which is empty. You learn the parent by narrowing to a list.
    expect(descriptor!.references.map((r) => r.name)).toEqual([]);
  });

  it('a per-list List Entry publishes its ONE parent up-hop, from the list type (org list → Organization)', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('List Entry — Hot Leads');
    expect(descriptor!.references.map((r) => r.name)).toEqual(
      expect.arrayContaining(['Organization']),
    );
  });

  it('the per-list type drops its OWN list prefix from field and edge names alike', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('List Entry — Hot Leads');
    const fieldNames = descriptor!.fields.map((f) => f.displayName);
    // The name the list shows, not the name the catalog spells.
    expect(fieldNames).toContain('List Score');
    expect(fieldNames).not.toContain('[Hot Leads] List Score');
    // An edge is named by the same rule — one list, one spelling.
    const owners = descriptor!.references.find((r) => r.fieldId === '108');
    expect(owners).toMatchObject({ name: 'Owners', targetTypeId: 'Person', writable: true });

    // A bare name another field already carries verbatim keeps its prefix:
    // `Segment` is an organization field, so the list's own field cannot claim
    // that name without two fields answering to it.
    expect(fieldNames).toContain('[Hot Leads] Segment');
    expect(fieldNames).not.toContain('Segment');
  });

  it('Organization keeps the names it publishes today — nothing is stripped there', async () => {
    const { adapter } = makeAdapter();
    const org = await adapter.describe('Organization');
    expect(org!.fields.map((f) => f.displayName)).toEqual(
      expect.arrayContaining(['Stage', 'Employees', 'Segment']),
    );
    // Its list-scoped fields were never on it in the first place.
    expect(org!.fields.map((f) => f.displayName)).not.toContain('List Score');
  });

  it('scopes the attached surfaces to organizations as edges (Notes/Files/List Entries/Interactions/Reminders)', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe('Organization');
    const refNames = descriptor!.references.map((r) => r.name);
    expect(refNames).toEqual(
      expect.arrayContaining(['People', 'Notes', 'Files', 'List Entries', 'Interactions', 'Reminders']),
    );
    const byName = new Map(descriptor!.references.map((r) => [r.name, r]));
    // Notes/Files create along the hop; the enumerate-only surfaces say so.
    expect(byName.get('Notes')!.writable).toBe(true);
    expect(byName.get('Files')!.writable).toBe(true);
    expect(byName.get('Interactions')!.writable).toBe(false);
    expect(byName.get('Reminders')!.writable).toBe(false);
    // ONE edge, both promises (rule 6): the read/write duality is collapsed.
    expect(byName.get('List Entries')!.writable).toBe(true);
    expect(byName.get('List Entries')!.targetTypeId).toBe('Organization List Entry');
  });

  // Layer 13: `writable` is EXPLICIT — absent means read-only. Each promise
  // below names the code path that honours it.
  it('promises the org↔person association writable from BOTH sides (it is N×M)', async () => {
    const { adapter } = makeAdapter();

    // createPerson's `parentOrgId` → createOrUpdatePerson({ orgId }) appends to
    // the person's organization_ids (N×M link, never a clobber).
    const org = await adapter.describe('Organization');
    expect(org!.references.find((r) => r.name === 'People')!.writable).toBe(true);

    // The reverse hop is the same association: createOrganization's
    // `linkParentPeople` appends the org to the person parent's employers.
    const person = await adapter.describe('Person');
    const organizations = person!.references.find((r) => r.name === 'Organizations')!;
    expect(organizations.writable).toBe(true);
  });

  it('promises Person/Organization-valued CUSTOM reference fields writable', async () => {
    const { adapter } = makeAdapter();
    // `applyCustomReferenceParentLinks` matches the write's edgeName back to
    // the field and creates/updates the field value pointing at the child.
    const org = await adapter.describe('Organization');
    const primaryContact = org!.references.find((r) => r.fieldId === '104')!;
    expect(primaryContact.name).toBe('Primary Contact');
    expect(primaryContact.writable).toBe(true);
  });

  it('carries the write promises through to the CHECKER projection, not just describe()', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const projection = instanceSchemaFromDescriptors({
      adapterType: 'affinity',
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
    const orgEdges = projection.schema.positions.Organization!.edges;
    expect(orgEdges.People).toMatchObject({ target: 'Person', writable: true });
    expect(orgEdges['Primary Contact']).toMatchObject({ target: 'Person', writable: true });
    expect(projection.schema.positions.Person!.edges.Organizations).toMatchObject({
      target: 'Organization',
      writable: true,
    });
  });

  it('publishes Relationship Strengths on Person only, read-only', async () => {
    const { adapter } = makeAdapter();
    const person = await adapter.describe('Person');
    const strengths = person!.references.find((r) => r.name === 'Relationship Strengths');
    expect(strengths).toBeDefined();
    expect(strengths!.writable).toBe(false);
    expect(strengths!.targetTypeId).toBe('Relationship Strength');
    const org = await adapter.describe('Organization');
    expect(org!.references.find((r) => r.name === 'Relationship Strengths')).toBeUndefined();
  });

  it('describes the new read surfaces with label enums (Reminder, Interaction, Relationship Strength, Opportunity)', async () => {
    const { adapter } = makeAdapter();

    const reminder = await adapter.describe('Reminder');
    const reminderFields = new Map(reminder!.fields.map((f) => [f.fieldId, f]));
    expect(reminderFields.get('type')!.enumValues).toEqual(['One-time', 'Recurring']);
    expect(reminderFields.get('status')!.enumValues).toEqual(['Completed', 'Active', 'Overdue']);
    expect(reminder!.fields.every((f) => !f.writable)).toBe(true);

    const interaction = await adapter.describe('Interaction');
    const interactionFields = new Map(interaction!.fields.map((f) => [f.fieldId, f]));
    expect(interactionFields.get('type')!.enumValues).toEqual(['Meeting', 'Call', 'Chat message', 'Email']);
    expect(interactionFields.get('direction')!.enumValues).toEqual(['Sent', 'Received']);

    const strength = await adapter.describe('Relationship Strength');
    expect(strength!.fields.map((f) => f.fieldId)).toEqual(['strength']);
    expect(strength!.references.map((r) => r.fieldId)).toEqual(['internal_person']);

    const opportunity = await adapter.describe('Opportunity');
    expect(opportunity!.fields.map((f) => f.fieldId)).toEqual(['name']);
    expect(opportunity!.references.map((r) => r.name)).toEqual(
      expect.arrayContaining(['People', 'Organizations', 'Notes', 'Files', 'Reminders', 'Interactions']),
    );
  });

  it('publishes Replies (writable) and Parent Note on Note', async () => {
    const { adapter } = makeAdapter();
    const note = await adapter.describe('Note');
    const byName = new Map(note!.references.map((r) => [r.name, r]));
    expect(byName.get('Replies')!.writable).toBe(true);
    expect(byName.get('Replies')!.targetTypeId).toBe('Note');
    expect(byName.get('Parent Note')!.writable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2a. Entry-point promises — per-entity, straight from the v1 API
// ---------------------------------------------------------------------------

describe('AffinityAdapter.listEntryPoints promises', () => {
  it('publishes honest readable/writable per entity', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const byId = new Map(entries.map((e) => [e.typeId, e]));
    // Workspace-wide enumerations exist → readable.
    expect(byId.get('Organization')).toMatchObject({ readable: true, writable: true });
    expect(byId.get('Person')).toMatchObject({ readable: true, writable: true });
    expect(byId.get('Opportunity')).toMatchObject({ readable: true, writable: false });
    // Notes and files are OWNED by their record (rule 0): GET /notes and
    // GET /entity-files enumerate workspace-wide, but a note/file has no
    // orphan existence (createNote/createFile throw without a parent), so a
    // flat root list is the API's shape, not the natural graph. Retired in
    // BOTH directions; reads and creates live on `record-[:Notes|Files]->`.
    expect(byId.get('Note')).toMatchObject({ readable: false, writable: false });
    expect(byId.get('File')).toMatchObject({ readable: false, writable: false });
    // Reminders CAN be untagged (no parent record), so the root is their only
    // complete surface — kept readable (rule 9: also `record-[:Reminders]->`).
    expect(byId.get('Reminder')).toMatchObject({ readable: true, writable: false });
    // No workspace-wide API behind these → not root-readable. The generic
    // List Entry root WRITE has always thrown too ("no listId") — the
    // explorer's write-only-root flag caught the stale promise, so both are
    // now false; writes live on the record's `List Entries` edge.
    expect(byId.get('List Entry')).toMatchObject({ readable: false, writable: false });
    expect(byId.get('Interaction')).toMatchObject({ readable: false, writable: false });
    expect(byId.get('Relationship Strength')).toMatchObject({ readable: false, writable: false });
    // Per-list roots are READ-ONLY (layer 12): a root enumerates the list's
    // entries, but the entry create needs a parent record — membership is
    // written from the record via `List Entries`, not from the list root.
    expect(byId.get('List Entry — Hot Leads')).toMatchObject({ readable: true, writable: false });
    // The per-entity list-entry collections carry NO root promise: both the
    // read and the write are the record edge's, and access lives where access
    // is real. Published so the edge target resolves and `membersOf` has a
    // recordType to match.
    expect(byId.get('Organization List Entry')).toMatchObject({ readable: false, writable: false });
    expect(byId.get('Person List Entry')).toMatchObject({ readable: false, writable: false });
    expect(byId.get('Opportunity List Entry')).toMatchObject({ readable: false, writable: false });
  });
});

// ---------------------------------------------------------------------------
// 2c. edgesFrom — the meta-graph walk
// ---------------------------------------------------------------------------

describe('AffinityAdapter.edgesFrom', () => {
  const metaPosition = { adapterType: 'affinity', recordType: 'meta', identity: { kind: 'unstable' as const, data: undefined } };

  it('the root hop publishes every entry THAT PROMISES SOMETHING, with the SAME promises', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const hop = await adapter.edgesFrom(metaPosition);

    // The root's edges are the entries it can back. An entry that is neither
    // readable nor writable is a position-only type — a real type, reached
    // through its parent — and a root edge to it is a relationship a movement
    // could do nothing with.
    //
    // The COLLECTIONS are the exception that makes this subtle: they promise
    // neither read nor write directly, because their promises live on the
    // members they narrow to. Dropping them would delete the narrowing surface,
    // so they are asserted present explicitly rather than left to the filter.
    const backed = entries.filter((e) => e.readable || e.writable || e.fires === true);
    const collections = ['Organization List Entry', 'Person List Entry', 'Opportunity List Entry'];
    expect(hop!.descriptor.references.map((r) => r.name).sort()).toEqual(
      [...backed.map((e) => e.displayName), ...collections].sort(),
    );

    // Position-only types are absent from the ROOT and reachable from a parent.
    for (const name of ['Note', 'File', 'Interaction', 'Relationship Strength']) {
      expect(hop!.descriptor.references.map((r) => r.name)).not.toContain(name);
    }
    const org = await adapter.edgesFrom({
      adapterType: 'affinity',
      recordType: 'Organization',
      identity: { kind: 'unstable' as const, data: undefined },
    });
    expect(org!.descriptor.references.map((r) => r.name)).toContain('Notes');

    // "The entry list and the walk are the same node's edges, and must not
    // disagree" — asserted on every edge the root does publish, because a drift
    // here is silent.
    for (const reference of hop!.descriptor.references) {
      const entry = entries.find((e) => e.displayName === reference.name)!;
      expect({ readable: reference.readable, writable: reference.writable }).toEqual({
        readable: entry.readable,
        writable: entry.writable,
      });
    }
  });

  it('files per-list members under the collection their KIND owns — an org never sees a person list', async () => {
    const { adapter } = makeAdapter();
    const hop = await adapter.edgesFrom(metaPosition);
    const members = Object.values(hop!.targetPositions!).filter((p) =>
      String(p.recordType).endsWith('List Entry'),
    );

    const orgMembers = members.filter((p) => p.recordType === 'Organization List Entry');
    const personMembers = members.filter((p) => p.recordType === 'Person List Entry');
    expect(orgMembers.map((p) => (p.identity as { data: { Name: string } }).data.Name)).toEqual(['Hot Leads']);
    expect(personMembers.map((p) => (p.identity as { data: { Name: string } }).data.Name)).toEqual(['People List']);
  });

  // The two SILENT failure modes. Neither throws when broken — narrowing just
  // quietly stops working — so both are pinned here.
  it('a member position\'s recordType equals the type its edge targets (or membersOf matches nothing)', async () => {
    const { adapter } = makeAdapter();
    const org = await adapter.describe('Organization');
    const edgeTarget = org!.references.find((r) => r.name === 'List Entries')!.targetTypeId;

    const hop = await adapter.edgesFrom(metaPosition);
    const orgMembers = Object.values(hop!.targetPositions!).filter(
      (p) => p.recordType === edgeTarget,
    );
    expect(orgMembers.length).toBeGreaterThan(0);
  });

  it('a member position carries a literal listName (or selectMember bails before evaluating)', async () => {
    const { adapter } = makeAdapter();
    const hop = await adapter.edgesFrom(metaPosition);
    const member = Object.values(hop!.targetPositions!).find(
      (p) => p.recordType === 'Organization List Entry',
    )!;
    const data = (member.identity as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ listName: 'Hot Leads', Name: 'Hot Leads', Id: '555' });
  });

  it('walking to a member describes THAT list\'s own entry fields', async () => {
    const { adapter } = makeAdapter();
    const hop = await adapter.edgesFrom(metaPosition);
    const member = Object.values(hop!.targetPositions!).find(
      (p) => p.recordType === 'Organization List Entry',
    )!;

    const listHop = await adapter.edgesFrom(member);
    // Hot Leads' own list-scoped field (`List Score`, list_id 555) — reached by
    // narrowing, never published on the collection itself.
    expect(listHop!.descriptor.fields.map((f) => f.displayName)).toContain('List Score');
  });

  it('an unrecognised position returns null so the caller falls back to describe', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.edgesFrom({
      adapterType: 'affinity',
      recordType: null,
      identity: { kind: 'unstable', data: undefined },
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2b. List entry → parent record back-edge
// ---------------------------------------------------------------------------

describe('AffinityAdapter.getRelated — list entry → parent record', () => {
  // Positions land ALREADY narrowed to their per-list type (option A), so each
  // publishes the ONE parent up-hop its list kind implies.
  const entryPosition = (listName: string, entityType: number) =>
    makeStablePosition({
      adapterType: 'affinity',
      recordType: `List Entry — ${listName}`,
      recordId: '13',
      data: { list_entry_id: 13, entity_type: entityType, entity_id: 42 },
    });

  it('resolves the parent organization from an organization list (type 1)', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({
      position: entryPosition('Hot Leads', 1),
      fieldId: 'Organization',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(isStablePosition(related[0].position)).toBe(true);
    expect(related[0].position.recordType).toBe('Organization');
    expect(positionRecordId(related[0].position)).toBe('42');
  });

  it('resolves the parent person from a person list (type 0)', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({
      position: entryPosition('People List', 0),
      fieldId: 'Person',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe('Person');
  });

  it('a per-list type publishes only its list-kind parent — naming another parent is unknown (drift)', async () => {
    const { adapter } = makeAdapter();
    // An organization list's entry type carries no `Person` up-hop — under
    // layer 11 the wrong parent isn't even nameable, so it drifts rather than
    // silently yielding [].
    await expect(
      adapter.getRelated({
        position: entryPosition('Hot Leads', 1),
        fieldId: 'Person',
        direction: 'outgoing',
      }),
    ).rejects.toThrow(/not a known edge/);
  });
});

// ---------------------------------------------------------------------------
// 2b'. preprocessInbound narrows list-entry events to their per-list type
// (option A) — so the landed event position publishes the one parent up-hop,
// which the generic `List Entry` (empty intersection, layer 11) cannot.
// ---------------------------------------------------------------------------

describe('AffinityAdapter.preprocessInbound — list-entry event narrowing', () => {
  it('narrows a list_entry.* event via the body list_id', async () => {
    const { adapter } = makeAdapter();
    const { events } = await adapter.preprocessInbound({
      raw: {
        type: 'list_entry.created',
        body: { id: 13, list_id: 555, entity_id: 42, entity_type: 1, created_at: '2026-07-18T00:00:00Z' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('List Entry — Hot Leads');
  });

  it('narrows a field_value.* event by resolving field_id → list_id through the field catalog', async () => {
    const { adapter } = makeAdapter();
    // Field 103 (`List Score`) is list-scoped to list 555 (Hot Leads); the
    // field_value body carries no list_id, so it's resolved via the catalog.
    const { events } = await adapter.preprocessInbound({
      raw: {
        type: 'field_value.updated',
        body: { id: 77, field_id: 103, entity_type: 1, entity_id: 42, list_entry_id: 13, value: 5 },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('List Entry — Hot Leads');
  });

  it('leaves the event on the generic type when the list cannot be determined', async () => {
    const { adapter } = makeAdapter();
    // An opportunity-list field value (entity_type 8): the field catalog only
    // covers org/person, so list_id can't be resolved — a graceful degrade to
    // the generic type rather than a fabricated narrowing.
    const { events } = await adapter.preprocessInbound({
      raw: {
        type: 'field_value.updated',
        body: { id: 78, field_id: 900, entity_type: 8, entity_id: 700, list_entry_id: 13, value: 'x' },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('List Entry');
  });

  it('passes a non-list-entry event through untouched', async () => {
    const { adapter } = makeAdapter();
    const { events } = await adapter.preprocessInbound({
      raw: { type: 'organization.updated', body: { id: 7101, name: 'Acme' } },
    });
    expect(events).toHaveLength(1);
    expect(events[0].recordType).toBe('Organization');
  });
});

// ---------------------------------------------------------------------------
// 2c. Root collection reads (layer 7 category 3) — the META position is
// handled BEFORE the stable-position guard, so the readable roots the entry
// list publishes actually enumerate instead of throwing "expects a stable
// Affinity record position".
// ---------------------------------------------------------------------------

describe('AffinityAdapter.getRelated — root collection reads', () => {
  const meta = makeMetaPosition('affinity');

  it('enumerates organizations from the root, with canonical data + person_ids', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({ position: meta, fieldId: 'Organization', direction: 'outgoing' });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe('Organization');
    expect(positionRecordId(related[0].position)).toBe('7101');
    const data = positionData(related[0].position) as Record<string, unknown>;
    expect(data.name).toBe('Acme');
    expect(data.domain).toBe('acme.com');
    expect(data.person_ids).toEqual([7201]);
  });

  it('a root-listed organization supports the onward People hop', async () => {
    const { adapter } = makeAdapter();
    const [org] = await adapter.getRelated({ position: meta, fieldId: 'Organization', direction: 'outgoing' });
    const people = await adapter.getRelated({ position: org.position, fieldId: 'People', direction: 'outgoing' });
    expect(people).toHaveLength(1);
    expect(people[0].position.recordType).toBe('Person');
  });

  it('enumerates persons from the root', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({ position: meta, fieldId: 'Person', direction: 'outgoing' });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe('Person');
    const data = positionData(related[0].position) as Record<string, unknown>;
    expect(data.email).toBe('jane@acme.com');
    expect(data.organization_ids).toEqual([7101]);
  });

  it('enumerates a per-list root (`List Entry — <list>`) from its one list', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({
      position: meta,
      fieldId: 'List Entry — Hot Leads',
      direction: 'outgoing',
    });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe('List Entry — Hot Leads');
    expect(positionRecordId(related[0].position)).toBe('9301');
    // The entry body rides the position, so the parent back-edge can route on
    // entity_type/entity_id without another fetch.
    const data = positionData(related[0].position) as Record<string, unknown>;
    expect(data.entity_type).toBe(1);
    expect(data.entity_id).toBe(7101);
  });

  it('the generic `List Entry` root refuses the read — entries enumerate per list', async () => {
    // The v1 API has no workspace-wide list-entry enumeration; the old
    // per-list fan-out fabricated one (explorer review, 2026-07-17).
    const { adapter } = makeAdapter();
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'List Entry', direction: 'outgoing' }),
    ).rejects.toThrow('enumerate per list');
  });

  it('the Note root is RETIRED — notes live under their record (rule 0)', async () => {
    // GET /notes still enumerates workspace-wide, but a note is owned by its
    // record (createNote throws parentless), so the flat root is retired and
    // the read redirects loudly to the record edge.
    const { adapter } = makeAdapter();
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'Note', direction: 'outgoing' }),
    ).rejects.toThrow('notes live under their record');
  });

  it('the File root is RETIRED — files live under their record (rule 0)', async () => {
    // Same placement as Attio's File: a file is owned by the record it was
    // uploaded to. The root redirects loudly to the record edge.
    const { adapter } = makeAdapter();
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'File', direction: 'outgoing' }),
    ).rejects.toThrow('files live under their record');
  });

  it('enumerates opportunities and reminders from the root', async () => {
    const { adapter } = makeAdapter();
    const opps = await adapter.getRelated({ position: meta, fieldId: 'Opportunity', direction: 'outgoing' });
    expect(opps).toHaveLength(1);
    expect(opps[0].position.recordType).toBe('Opportunity');
    expect((positionData(opps[0].position) as Record<string, unknown>).name).toBe('Acme — Series A');

    const reminders = await adapter.getRelated({ position: meta, fieldId: 'Reminder', direction: 'outgoing' });
    expect(reminders).toHaveLength(1);
    const data = positionData(reminders[0].position) as Record<string, unknown>;
    // Wire enums land as their labels — the descriptor's own vocabulary.
    expect(data.type).toBe('Recurring');
    expect(data.status).toBe('Overdue');
    expect(data.reset_type).toBe('Email');
  });

  // ── The hop's WHERE, pushed to Affinity's `term` search ──────────────────
  //
  // A root read is the workspace, and Affinity's only narrowing verb on it is
  // `term` — ONE substring, matched against an organization's name and domain
  // (a person's name and emails). A substring match returns a SUPERSET of an
  // equality on any of those fields, which is the only direction that is safe
  // to push: the engine filters what comes back, but nothing recovers records
  // we never fetched.

  const eq = (field: string, value: string): Expression => ({
    type: 'compare',
    op: 'eq',
    left: { type: 'property', propertyTypeId: field },
    right: { type: 'static', value },
  });

  it('pushes an equality on Domain to the `term` search, bare value and all', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: eq('Domain', 'veltha.ai'),
    });
    expect(calls.listOrganisations).toEqual([{ term: 'veltha.ai' }]);
  });

  it('pushes an equality on Name, and on a person\'s Email', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: eq('Name', 'Acme'),
    });
    await adapter.getRelated({
      position: meta,
      fieldId: 'Person',
      direction: 'outgoing',
      where: eq('Email', 'jane@acme.com'),
    });
    expect(calls.listOrganisations).toEqual([{ term: 'Acme' }]);
    expect(calls.listPersons).toEqual([{ term: 'jane@acme.com' }]);
  });

  it('pushes the shape a bracket WHERE actually produces — an edge-property field', async () => {
    // `crm-[o:Organization WHERE `Domain` == host]->` parses its bare field
    // name as an EDGE property, and the engine closes the right operand over
    // the scope before the fetch. That is the shape production sends.
    const { adapter, calls } = makeAdapter();
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: {
        type: 'compare',
        op: 'eq',
        left: { type: 'edge_property', propertyTypeId: 'Domain' },
        right: { type: 'static', value: 'veltha.ai' },
      },
    });
    expect(calls.listOrganisations).toEqual([{ term: 'veltha.ai' }]);
  });

  it('narrows by ONE conjunct of an AND and leaves the rest to the engine', async () => {
    // `term` takes a single value, so the domain narrows the fetch and the name
    // is satisfied by the engine's post-filter over what comes back.
    const { adapter, calls } = makeAdapter();
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: {
        type: 'logical',
        op: 'and',
        operands: [eq('Domain', 'veltha.ai'), eq('Name', 'Veltha')],
      },
    });
    expect(calls.listOrganisations).toEqual([{ term: 'veltha.ai' }]);
  });

  it('walks the whole workspace for a WHERE Affinity cannot search by', async () => {
    // Not an equality, not a field `term` matches, no WHERE at all — each
    // leaves the read unnarrowed rather than pushing something that could
    // return LESS than the predicate admits.
    const { adapter, calls } = makeAdapter();
    await adapter.getRelated({ position: meta, fieldId: 'Organization', direction: 'outgoing' });
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: eq('Domains', 'veltha.ai'),
    });
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: { type: 'compare', op: 'contains', left: { type: 'property', propertyTypeId: 'Name' }, right: { type: 'static', value: 'Vel' } },
    });
    await adapter.getRelated({
      position: meta,
      fieldId: 'Organization',
      direction: 'outgoing',
      where: {
        type: 'logical',
        op: 'or',
        operands: [eq('Domain', 'veltha.ai'), eq('Name', 'Veltha')],
      },
    });
    expect(calls.listOrganisations).toEqual([{}, {}, {}, {}]);
  });

  it('edge-only surfaces refuse the root read honestly; unknown names degrade to empty', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'Interaction', direction: 'outgoing' }),
    ).rejects.toThrow('enumerate per record');
    await expect(
      adapter.getRelated({ position: meta, fieldId: 'Relationship Strength', direction: 'outgoing' }),
    ).rejects.toThrow('enumerate per person');
    expect(
      await adapter.getRelated({ position: meta, fieldId: 'Bogus Collection', direction: 'outgoing' }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2d. Record-scoped read surfaces — the attached edges (explorer
// review): org/person/opportunity → Notes / Files / List Entries /
// Interactions / Reminders, person → Relationship Strengths, note → Replies /
// Parent, and the embedded-person hops.
// ---------------------------------------------------------------------------

describe('AffinityAdapter.getRelated — record-scoped surfaces', () => {
  const orgPosition = makeStablePosition({
    adapterType: 'affinity',
    recordType: 'Organization',
    recordId: '7101',
    data: { name: 'Acme', domain: 'acme.com', person_ids: [7201] },
  });
  const personPosition = makeStablePosition({
    adapterType: 'affinity',
    recordType: 'Person',
    recordId: '7201',
    data: { name: 'Jane Doe', email: 'jane@acme.com', organization_ids: [7101] },
  });

  it('org → Notes reads the org-scoped notes', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({ position: orgPosition, fieldId: 'Notes', direction: 'outgoing' });
    expect(related).toHaveLength(1);
    expect(related[0].position.recordType).toBe('Note');
    expect(positionRecordId(related[0].position)).toBe('500');
  });

  it('org → Files reads the org-scoped files', async () => {
    const { adapter } = makeAdapter();
    const related = await adapter.getRelated({ position: orgPosition, fieldId: 'Files', direction: 'outgoing' });
    expect(related).toHaveLength(1);
    expect((positionData(related[0].position) as Record<string, unknown>).name).toBe('deck.pdf');
  });

  it('org → Interactions makes one call per interaction type over ≤ a year, typed landings', async () => {
    const { adapter, calls } = makeAdapter();
    const related = await adapter.getRelated({
      position: orgPosition,
      fieldId: 'Interactions',
      direction: 'outgoing',
    });
    // Four typed calls (meeting/call/chat/email), all org-scoped.
    expect(calls.listInteractions.map((c) => c.type).sort()).toEqual([0, 1, 2, 3]);
    for (const call of calls.listInteractions) {
      expect(call.scope).toEqual({ organizationId: 7101 });
      const rangeMs = call.endTime.getTime() - call.startTime.getTime();
      expect(rangeMs).toBeLessThanOrEqual(365 * 24 * 60 * 60 * 1000);
    }
    // One meeting + one email in the fixtures; labels on the landing.
    expect(related).toHaveLength(2);
    const byId = new Map(related.map((r) => [positionRecordId(r.position), r]));
    const meeting = positionData(byId.get('0:901')!.position) as Record<string, unknown>;
    expect(meeting.type).toBe('Meeting');
    expect(meeting.title).toBe('Kickoff call');
    const email = positionData(byId.get('3:900')!.position) as Record<string, unknown>;
    expect(email.type).toBe('Email');
    expect(email.direction).toBe('Received');
  });

  it('org → List Entries lands per-list-typed entries stamped with the parent identity', async () => {
    const { adapter } = makeAdapter();
    // The fake getOrganisationById returns no list_entries by default — a
    // membership-less org reads as empty, honestly.
    const empty = await adapter.getRelated({ position: orgPosition, fieldId: 'List Entries', direction: 'outgoing' });
    expect(empty).toEqual([]);
  });

  it('person → Relationship Strengths reads the computed strengths, and the Internal Person hop resolves', async () => {
    const { adapter } = makeAdapter();
    const strengths = await adapter.getRelated({
      position: personPosition,
      fieldId: 'Relationship Strengths',
      direction: 'outgoing',
    });
    expect(strengths).toHaveLength(1);
    expect(strengths[0].position.recordType).toBe('Relationship Strength');
    const data = positionData(strengths[0].position) as Record<string, unknown>;
    expect(data.strength).toBe(0.7);

    const internal = await adapter.getRelated({
      position: strengths[0].position,
      fieldId: 'Internal Person',
      direction: 'outgoing',
    });
    expect(internal).toHaveLength(1);
    expect(internal[0].position.recordType).toBe('Person');
    expect(positionRecordId(internal[0].position)).toBe('42');
  });

  it('note → Replies filters the workspace notes on parent_id; reply → Parent Note resolves back', async () => {
    const { adapter } = makeAdapter();
    const [parentNote] = await adapter.getRelated({ position: orgPosition, fieldId: 'Notes', direction: 'outgoing' });
    const replies = await adapter.getRelated({
      position: parentNote.position,
      fieldId: 'Replies',
      direction: 'outgoing',
    });
    expect(replies).toHaveLength(1);
    expect(positionRecordId(replies[0].position)).toBe('501');

    const parent = await adapter.getRelated({
      position: replies[0].position,
      fieldId: 'Parent Note',
      direction: 'outgoing',
    });
    expect(parent).toHaveLength(1);
    expect(positionRecordId(parent[0].position)).toBe('500');
    // A top-level note has no parent — empty, not an error.
    expect(
      await adapter.getRelated({ position: parentNote.position, fieldId: 'Parent Note', direction: 'outgoing' }),
    ).toEqual([]);
  });

  it('opportunity → People/Organizations resolve from the link ids; reminder hops ride the embedded objects', async () => {
    const { adapter } = makeAdapter();
    const [opp] = await adapter.getRelated({ position: makeMetaPosition('affinity'), fieldId: 'Opportunity', direction: 'outgoing' });
    const people = await adapter.getRelated({ position: opp.position, fieldId: 'People', direction: 'outgoing' });
    expect(people.map((p) => positionRecordId(p.position))).toEqual(['7201']);
    const orgs = await adapter.getRelated({ position: opp.position, fieldId: 'Organizations', direction: 'outgoing' });
    expect(orgs.map((o) => positionRecordId(o.position))).toEqual(['7101']);

    const [reminder] = await adapter.getRelated({ position: makeMetaPosition('affinity'), fieldId: 'Reminder', direction: 'outgoing' });
    const tagged = await adapter.getRelated({ position: reminder.position, fieldId: 'Person', direction: 'outgoing' });
    expect(tagged.map((p) => positionRecordId(p.position))).toEqual(['7201']);
    const owner = await adapter.getRelated({ position: reminder.position, fieldId: 'Owner', direction: 'outgoing' });
    expect(owner.map((p) => positionRecordId(p.position))).toEqual(['42']);
    // No organization tagged on this reminder — empty, not an error.
    expect(
      await adapter.getRelated({ position: reminder.position, fieldId: 'Organization', direction: 'outgoing' }),
    ).toEqual([]);
  });

  it('interaction → People folds the embedded participants without a refetch', async () => {
    const { adapter } = makeAdapter();
    const interactions = await adapter.getRelated({
      position: orgPosition,
      fieldId: 'Interactions',
      direction: 'outgoing',
    });
    const email = interactions.find((r) => positionRecordId(r.position) === '3:900')!;
    const people = await adapter.getRelated({ position: email.position, fieldId: 'People', direction: 'outgoing' });
    // from (7201) + to (42), deduped.
    expect(people.map((p) => positionRecordId(p.position)).sort()).toEqual(['42', '7201']);
  });

  it('an opportunity list (type 8) entry resolves its Opportunity parent — and no other parent is nameable', async () => {
    const { adapter } = makeAdapter();
    const entryPosition = makeStablePosition({
      adapterType: 'affinity',
      recordType: 'List Entry — Deals',
      recordId: '9302',
      data: { entity_type: 8, entity_id: 700 },
    });
    const opp = await adapter.getRelated({ position: entryPosition, fieldId: 'Opportunity', direction: 'outgoing' });
    expect(opp).toHaveLength(1);
    expect(opp[0].position.recordType).toBe('Opportunity');
    // Only the Opportunity up-hop is published on an opportunity list's type.
    await expect(
      adapter.getRelated({ position: entryPosition, fieldId: 'Organization', direction: 'outgoing' }),
    ).rejects.toThrow(/not a known edge/);
  });
});

// ---------------------------------------------------------------------------
// 2e. Writes along the scoped edges — a note reply and non-org file parents
// ---------------------------------------------------------------------------

describe('AffinityAdapter note replies + scoped note/file writes', () => {
  it('creates a reply when the write parent is a NOTE (parent_id path)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Note',
      fields: { Content: 'Threaded reply' },
      parentLinks: [{ recordType: 'Note', externalId: '500', edgeName: 'Replies' }],
      mutationContext: {} as never,
    });
    expect(calls.createNote).toHaveLength(1);
    expect(calls.createNote[0]).toMatchObject({ parentNoteId: 500, content: 'Threaded reply' });
    expect(calls.createNote[0].organizationId).toBeUndefined();
  });

  it('creates a note on an opportunity parent', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Note',
      fields: { Content: 'On the deal' },
      parentLinks: [{ recordType: 'Opportunity', externalId: '700', edgeName: 'Notes' }],
      mutationContext: {} as never,
    });
    expect(calls.createNote[0]).toMatchObject({ opportunityId: 700, content: 'On the deal' });
  });

  it('uploads a file to a person parent with the person_id key', async () => {
    const { adapter, calls } = makeAdapter();
    const store = installMemoryDocumentStore();
    await adapter.createRecord({
      recordType: 'File',
      fields: {
        File: store.file('bytes', { name: 'notes.txt', contentType: 'text/plain' }),
      },
      parentLinks: [{ recordType: 'Person', externalId: '7201', edgeName: 'Files' }],
      mutationContext: {} as never,
    });
    expect(calls.uploadEntityFile).toEqual([{ entityId: 7201, entityType: 'person', fileName: 'notes.txt' }]);
  });
});

// ---------------------------------------------------------------------------
// 3. resolveEntity
// ---------------------------------------------------------------------------

describe('AffinityAdapter.resolveEntity', () => {
  it('matches an organization by domain/name via findMatchingOrganisation', async () => {
    const { adapter, calls } = makeAdapter({ orgMatch: { id: 42 } });
    const input: ResolveEntityInput = {
      // NATURAL currency: type displayName + field displayNames. The adapter
      // resolves them to its internal typeId / field ids on the first line.
      record: { Name: 'Acme', Domain: 'acme.com' },
      recordType: 'Organization',
      candidates: [],
      constraints: { any: [] } as unknown as ResolveEntityInput['constraints'],
    };
    const result = await adapter.resolveEntity(input);
    expect(calls.findMatchingOrganisation).toEqual([{ name: 'Acme', domain: 'acme.com' }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].externalId).toBe('42');
    expect(result.candidates[0].data.Domain).toBe('acme.com');
  });

  it('returns no candidates when the org has no match (engine then creates)', async () => {
    const { adapter } = makeAdapter({ orgMatch: null });
    const result = await adapter.resolveEntity({
      record: { Name: 'Nobody' },
      recordType: 'Organization',
      candidates: [],
      constraints: { any: [] } as unknown as ResolveEntityInput['constraints'],
    });
    expect(result.candidates).toHaveLength(0);
  });

  it('matches a person by email via findMatchingPerson', async () => {
    const { adapter, calls } = makeAdapter({ personMatch: { id: 77 } });
    const result = await adapter.resolveEntity({
      record: { 'Full name': 'Jane Doe', Email: 'jane@acme.com' },
      recordType: 'Person',
      candidates: [],
      constraints: { any: [] } as unknown as ResolveEntityInput['constraints'],
    });
    expect(calls.findMatchingPerson).toEqual([{ name: 'Jane Doe', email: 'jane@acme.com' }]);
    expect(result.candidates[0].externalId).toBe('77');
    expect(result.candidates[0].data.Email).toBe('jane@acme.com');
  });

  it('prefers a linked_object bridge over a natural-key search', async () => {
    const { adapter, calls } = makeAdapter({ orgMatch: { id: 42 } });
    const result = await adapter.resolveEntity({
      record: { Name: 'Acme', Domain: 'acme.com' },
      recordType: 'Organization',
      candidates: [
        {
          node_id: 'node-1',
          external_id: '900',
          // `external_object_type` is the stored linked_object record-type label
          // — a pretty NAME now (the same currency the position's `recordType`
          // carries), so the bridge matches on the natural name.
          external_object_type: 'Organization',
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: { any: [] } as unknown as ResolveEntityInput['constraints'],
    });
    expect(calls.findMatchingOrganisation).toHaveLength(0); // bridge short-circuits
    // The bridge candidate carries the external id; the KG node is no longer
    // surfaced per-candidate (the engine derives the bridge from externalId).
    expect(result.candidates[0].externalId).toBe('900');
  });
});

// ---------------------------------------------------------------------------
// 4. createRecord(organization) — built-in/custom split
// ---------------------------------------------------------------------------

describe('AffinityAdapter.createRecord(organization)', () => {
  it('splits built-ins from custom fields and writes enriched custom fields too', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      // NATURAL currency: type displayName + field displayNames. Built-ins use
      // their displayName (`Name`/`Domain`); custom fields use the field's
      // published `name` displayName (`Stage`/`Employees`/`Crunchbase Rank`),
      // NOT the numeric internal id. The adapter resolves each to its internal
      // field id before the write builder runs.
      recordType: 'Organization',
      fields: {
        Name: 'Acme',
        Domain: 'acme.com',
        Stage: 'Series A', // → field 100, ranked dropdown → option id 2
        Employees: '250', // → field 101, number → 250
        'Crunchbase Rank': '5', // → field 102, enriched field → written
      },
      mutationContext: {} as never,
    });

    // built-ins drove createOrUpdateOrganisation
    expect(calls.createOrUpdateOrganisation).toHaveLength(1);
    // The custom text fields ride along as the matcher judge's context,
    // labelled by the names the author wrote.
    expect(calls.createOrUpdateOrganisation[0].searchQuery).toEqual({
      name: 'Acme',
      domain: 'acme.com',
      context: 'Stage: Series A\nEmployees: 250\nCrunchbase Rank: 5',
    });

    // custom field writes: ranked dropdown resolved to option id, number coerced;
    // the enriched field 102 written like the rest.
    const written = new Map(calls.createFieldValue.map((c) => [c.field_id, c.value]));
    expect(written.get(100)).toBe(2); // 'Series A' → option id 2
    expect(written.get(101)).toBe(250);
    expect(written.get(102)).toBe(5);

    expect(result.externalId).toBe('999');
    expect(result.data!.url).toBe('https://acme.affinity.co/companies/999');
    expect(result.data!.name).toBe('Acme');
  });
});

// ---------------------------------------------------------------------------
// 5. updateRecord(person) — pins the resolved id (no name re-search) + 404
// ---------------------------------------------------------------------------

describe('AffinityAdapter.updateRecord(person)', () => {
  it('pins the engine-resolved externalId instead of re-searching by name', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.updateRecord({
      recordType: 'Person',
      externalId: '12345',
      fields: { Email: 'jane@acme.com' }, // no name on this update
      mutationContext: {} as never,
    });
    // The write was pinned to 12345 — NEVER routed through a name search that
    // could match a different person or create a duplicate.
    expect(calls.findMatchingPerson).toHaveLength(0);
    expect(calls.createOrUpdatePerson).toHaveLength(1);
    expect(calls.createOrUpdatePerson[0].affinityId).toBe(12345);
    expect('notFound' in result).toBe(false);
    expect((result as { externalId: string }).externalId).toBe('12345');
  });

  it('maps a 404 (record deleted externally) to the not-found signal', async () => {
    const { adapter } = makeAdapter({ personUpdate404: true });
    const result = await adapter.updateRecord({
      recordType: 'Person',
      externalId: '999999',
      fields: { Email: 'gone@acme.com' },
      mutationContext: {} as never,
    });
    expect(result).toEqual({ notFound: true });
  });
});

// ---------------------------------------------------------------------------
// 5b. Write semantics — the engine owns overwrite/`?:`; the adapter writes
//     what it's handed (no local isNew gate), and readRecord surfaces current
//     values by display name (incl. custom fields) so the gate can work.
// ---------------------------------------------------------------------------

describe('AffinityAdapter write semantics', () => {
  it('overwrites an existing custom field value on update (no local isNew gate)', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 5, field_id: 101, list_entry_id: null, value: 100 }],
    });
    await adapter.updateRecord({
      recordType: 'Organization',
      externalId: '42',
      fields: { Employees: '250' }, // field 101 — already has value 100
      mutationContext: {} as never,
    });
    // Previously the adapter skipped existing values on update (forceOverwrite =
    // isNew = false); now it writes what the engine handed it.
    expect(calls.updateFieldValue).toContainEqual({ id: 5, value: 250 });
  });

  it('readRecord returns current values keyed by display name, including custom fields', async () => {
    const { adapter } = makeAdapter({
      fieldValues: [{ id: 9, field_id: 200, list_entry_id: null, value: 'VP Eng' }],
    });
    const current = await adapter.readRecord({
      recordType: 'Person',
      externalId: '77',
      fieldIds: ['Email', 'Title'],
    });
    // Display-name keys — the currency the engine's write-semantics gate uses.
    expect(current).toMatchObject({
      'First name': 'Jane',
      'Email': 'jane@acme.com',
      Title: 'VP Eng', // custom field 200 surfaced by display name
    });
  });
});

describe('AffinityAdapter list-entry upsert on (record, list)', () => {
  it('publishes (record, list) as the membership\'s identity', async () => {
    const { adapter } = makeAdapter();
    const collection = await adapter.describe('Organization List Entry');
    expect(collection!.uniquenessConstraints).toEqual({
      any: [{ all: [{ field: 'List Entries' }, { field: 'listName' }] }],
    });
    // A collection nothing can be added to claims no identity to add against.
    const opportunities = await adapter.describe('Opportunity List Entry');
    expect(opportunities!.uniquenessConstraints).toBeUndefined();
  });

  it('resolves a record already on the list to the entry it already has', async () => {
    const { adapter } = makeAdapter({ existingListEntry: { id: 8801, listId: 555, entityId: 42 } });
    const resolved = await adapter.resolveEntity({
      recordType: 'Organization List Entry',
      // The engine folds the write's parent in under the edge it came through.
      record: { listName: 'Hot Leads', 'List Entries': { id: '42' } },
      candidates: [],
      constraints: { any: [{ all: [{ field: 'List Entries' }, { field: 'listName' }] }] },
    });
    expect(resolved.candidates).toEqual([
      expect.objectContaining({ externalId: '8801' }),
    ]);
  });

  it('resolves nothing for a record that is not on the list — the write creates', async () => {
    const { adapter } = makeAdapter({ existingListEntry: { id: 8801, listId: 556, entityId: 42 } });
    const resolved = await adapter.resolveEntity({
      recordType: 'Organization List Entry',
      record: { listName: 'Hot Leads', 'List Entries': { id: '42' } },
      candidates: [],
      constraints: { any: [{ all: [{ field: 'List Entries' }, { field: 'listName' }] }] },
    });
    expect(resolved.candidates).toEqual([]);
  });

  it('updates the entry in place, without re-asserting the membership', async () => {
    const { adapter, calls } = makeAdapter({
      existingListEntry: { id: 8801, listId: 555, entityId: 42 },
      fieldValues: [{ id: 21, field_id: 103, list_entry_id: 8801, value: 7 }],
    });
    const result = await adapter.updateRecord({
      recordType: 'Organization List Entry',
      externalId: '8801',
      // `listName` never reaches the update: the engine suppressed it as
      // unchanged. The entry's list comes off the record's membership rows.
      fields: { 'List Score': 42 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(result).toMatchObject({ externalId: '8801' });
    expect(calls.updateFieldValue).toContainEqual({ id: 21, value: 42 });
    expect(calls.createListEntry).toEqual([]);
  });

  it('an update carrying the list name writes the fields and not the name', async () => {
    // `listName` names the list the write is addressed to, not a value on the
    // entry — and it survives to the adapter whenever the entry carries no
    // values yet, because an entry with nothing on it names no list for the
    // engine to compare against.
    const { adapter, calls } = makeAdapter({
      existingListEntry: { id: 8801, listId: 555, entityId: 42 },
    });
    await adapter.updateRecord({
      recordType: 'Organization List Entry',
      externalId: '8801',
      fields: { listName: 'Hot Leads', 'List Score': 42 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue).toEqual([
      { field_id: 103, entity_id: 42, list_entry_id: 8801, value: 42 },
    ]);
  });

  it('reads an entry the record no longer has as gone, so a bound write re-mints', async () => {
    const { adapter } = makeAdapter({ existingListEntry: { id: 8801, listId: 555, entityId: 42 } });
    expect(
      await adapter.updateRecord({
        recordType: 'Organization List Entry',
        externalId: '9999',
        fields: { 'List Score': 42 },
        parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
        mutationContext: {} as never,
      }),
    ).toEqual({ notFound: true });
  });

  it('writes the authored value onto an entry that already existed (a plain `:` is not inverted)', async () => {
    const { adapter, calls } = makeAdapter({
      existingListEntry: { id: 8801, listId: 555, entityId: 42 },
      fieldValues: [{ id: 21, field_id: 103, list_entry_id: 8801, value: 7 }],
    });
    // Even reached as a CREATE (the membership deduped inside the adapter), the
    // value the engine handed us lands: the old `forceOverwrite: isNew` gate
    // silently turned a `:` into "only if the entry is brand new".
    await adapter.createRecord({
      recordType: 'Organization List Entry',
      fields: { listName: 'Hot Leads', 'List Score': 42 },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
      mutationContext: {} as never,
    });
    expect(calls.updateFieldValue).toContainEqual({ id: 21, value: 42 });
  });
});

describe('AffinityAdapter field writes fail loudly', () => {
  it('a field name that resolves to nothing is a bug, and says so', async () => {
    const { adapter } = makeAdapter();
    // The checker guarantees every authored field is on the variant, so a name
    // with no field behind it means the published schema and the workspace
    // disagree — not a value to walk past.
    await expect(
      adapter.createRecord({
        recordType: 'Organization List Entry',
        fields: { listName: 'Hot Leads', 'Utter Nonsense': 'x' },
        parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/Utter Nonsense/);
  });

  it('a field Affinity refuses fails the write, naming the entry and every field that missed', async () => {
    const { adapter, calls } = makeAdapter({ failFieldValueWrites: true });
    await expect(
      adapter.createRecord({
        recordType: 'Organization List Entry',
        fields: { listName: 'Hot Leads', 'List Score': 42, Tags: 'Robotics' },
        parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'List Entries' }],
        mutationContext: {} as never,
      }),
    ).rejects.toThrow(/list entry 9999.*/);
    // Both fields were attempted — one refusal does not decide the others.
    expect(calls.createFieldValue).toHaveLength(2);
  });

  it('ONE field Affinity refuses fails the write naming that field and its reason; the others land', async () => {
    const { adapter, calls } = makeAdapter({ refuseFieldIds: [102] });
    const write = adapter.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Acme', Employees: '250', 'Crunchbase Rank': '5' },
      mutationContext: {} as never,
    });
    await expect(write).rejects.toThrow(
      /could not write field "Crunchbase Rank" \(Affinity Error: 422 .*Field is not editable.*\) on organization 999/,
    );
    await expect(write).rejects.not.toThrow(/Employees/);
    // The refused field did not stop the one Affinity accepted.
    expect(calls.createFieldValue.map((c) => c.field_id)).toEqual([101, 102]);
  });
});

describe('AffinityAdapter reference edges on a list entry', () => {
  it('lands `Owners` on the ENTRY, against the record the entry stands for', async () => {
    const { adapter, calls } = makeAdapter({
      existingListEntry: { id: 8801, listId: 555, entityId: 42 },
    });
    // `write entry-[:Owners]-> person` — the entry holds the reference. The
    // edge is named the way the list names it (prefix off), and the value hangs
    // off the entry while still being addressed against the organization.
    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe' },
      parentLinks: [
        { recordType: 'List Entry — Hot Leads', externalId: '8801', edgeName: 'Owners' },
      ],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue).toContainEqual({
      field_id: 108,
      entity_id: 42,
      list_entry_id: 8801,
      value: 888,
    });
  });

  it('reads the linked owner back off the entry, under the same name', async () => {
    const { adapter } = makeAdapter({
      fieldValues: [{ id: 31, field_id: 108, list_entry_id: 8801, value: 888 }],
    });
    expect(
      await adapter.readRecord({ recordType: 'List Entry — Hot Leads', externalId: '8801' }),
    ).toMatchObject({ Owners: [888] });
  });

  it('a rehearsed entry holds nothing — its handle carries no Affinity id', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe' },
      parentLinks: [
        {
          recordType: 'List Entry — Hot Leads',
          externalId: 'c0ffee00-0000-4000-8000-000000000000',
          edgeName: 'Owners',
        },
      ],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue).toEqual([]);
  });
});

describe('AffinityAdapter link / unlink an existing record', () => {
  const MUTATION = {} as never;

  it('links a person onto an entry\'s multi-valued `Owners`, addressed by entry AND record', async () => {
    const { adapter, calls } = makeAdapter();
    expect(
      await adapter.linkRecords({
        from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
        edgeName: 'Owners',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).toEqual({ created: true });
    expect(calls.createFieldValue).toEqual([
      { field_id: 108, entity_id: 42, list_entry_id: 8801, value: 888 },
    ]);
  });

  it('a person already on the field is a no-op', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 31, field_id: 108, list_entry_id: 8801, value: 888 }],
    });
    expect(
      await adapter.linkRecords({
        from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
        edgeName: 'Owners',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).toEqual({ created: false });
    expect(calls.createFieldValue).toEqual([]);
    expect(calls.updateFieldValue).toEqual([]);
  });

  it('a multi-valued field APPENDS — an owner already there keeps its row', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 31, field_id: 108, list_entry_id: 8801, value: 777 }],
    });
    await adapter.linkRecords({
      from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
      edgeName: 'Owners',
      to: { recordType: 'Person', externalId: '888' },
      mutationContext: MUTATION,
    });
    expect(calls.createFieldValue).toHaveLength(1);
    expect(calls.updateFieldValue).toEqual([]);
    expect(calls.deleteFieldValue).toEqual([]);
  });

  it('a SINGLE-valued field on an organization replaces in place', async () => {
    // `Primary Contact` (104) is single-valued and unscoped, so the org holds
    // it: an existing row is PUT to the new person rather than deleted first.
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 41, field_id: 104, list_entry_id: null, value: 777 }],
    });
    expect(
      await adapter.linkRecords({
        from: { recordType: 'Organization', externalId: '42' },
        edgeName: 'Primary Contact',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).toEqual({ created: true });
    expect(calls.updateFieldValue).toEqual([{ id: 41, value: 888 }]);
    expect(calls.createFieldValue).toEqual([]);
    expect(calls.deleteFieldValue).toEqual([]);
  });

  it('a single-valued field with nothing on it is created', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.linkRecords({
      from: { recordType: 'Organization', externalId: '42' },
      edgeName: 'Primary Contact',
      to: { recordType: 'Person', externalId: '888' },
      mutationContext: MUTATION,
    });
    expect(calls.createFieldValue).toEqual([{ field_id: 104, entity_id: 42, value: 888 }]);
  });

  it('unlink deletes the row naming that record, and only that one', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [
        { id: 31, field_id: 108, list_entry_id: 8801, value: 777 },
        { id: 32, field_id: 108, list_entry_id: 8801, value: 888 },
      ],
    });
    expect(
      await adapter.unlinkRecords({
        from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
        edgeName: 'Owners',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).toEqual({ removed: true });
    expect(calls.deleteFieldValue).toEqual([{ id: 32 }]);
  });

  it('unlinking what was never linked is a quiet no-op', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 31, field_id: 108, list_entry_id: 8801, value: 777 }],
    });
    expect(
      await adapter.unlinkRecords({
        from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
        edgeName: 'Owners',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).toEqual({ removed: false });
    expect(calls.deleteFieldValue).toEqual([]);
  });

  it('an edge that is not a writable reference on the from side is an error', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.linkRecords({
        from: { recordType: 'List Entry — Hot Leads', externalId: '8801' },
        edgeName: 'Utter Nonsense',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).rejects.toThrow(/Utter Nonsense/);
  });

  // The built-in person↔organization association, joined between two records
  // that already exist. `write org-[:People]-> { … }` onto a matched person and
  // `link org -[:People]-> p` are the same act, so they run the same code —
  // and here that shows as the same PUT.
  describe('the built-in person↔organization association', () => {
    it('links a person to an organization, keeping their other employers', async () => {
      const { adapter, calls } = makeAdapter({ personOrgIds: [7101] });
      expect(
        await adapter.linkRecords({
          from: { recordType: 'Organization', externalId: '42' },
          edgeName: 'People',
          to: { recordType: 'Person', externalId: '888' },
          mutationContext: MUTATION,
        }),
      ).toEqual({ created: true });
      expect(calls.updatePerson).toEqual([
        { id: 888, payload: { organization_ids: [7101, 42] } },
      ]);
      // No field value anywhere — the association is not a field.
      expect(calls.createFieldValue).toEqual([]);
    });

    it('reads the same association from the PERSON side', async () => {
      const { adapter, calls } = makeAdapter({ personOrgIds: [] });
      await adapter.linkRecords({
        from: { recordType: 'Person', externalId: '888' },
        edgeName: 'Organizations',
        to: { recordType: 'Organization', externalId: '42' },
        mutationContext: MUTATION,
      });
      expect(calls.updatePerson).toEqual([{ id: 888, payload: { organization_ids: [42] } }]);
    });

    it('is idempotent — an employer already there sends nothing', async () => {
      const { adapter, calls } = makeAdapter({ personOrgIds: [42] });
      expect(
        await adapter.linkRecords({
          from: { recordType: 'Organization', externalId: '42' },
          edgeName: 'People',
          to: { recordType: 'Person', externalId: '888' },
          mutationContext: MUTATION,
        }),
      ).toEqual({ created: false });
      expect(calls.updatePerson).toEqual([]);
    });

    it('unlink drops that employer and keeps the rest', async () => {
      const { adapter, calls } = makeAdapter({ personOrgIds: [7101, 42] });
      expect(
        await adapter.unlinkRecords({
          from: { recordType: 'Organization', externalId: '42' },
          edgeName: 'People',
          to: { recordType: 'Person', externalId: '888' },
          mutationContext: MUTATION,
        }),
      ).toEqual({ removed: true });
      expect(calls.updatePerson).toEqual([{ id: 888, payload: { organization_ids: [7101] } }]);
    });

    it('unlinking an employer that was never there is a quiet no-op', async () => {
      const { adapter, calls } = makeAdapter({ personOrgIds: [7101] });
      expect(
        await adapter.unlinkRecords({
          from: { recordType: 'Organization', externalId: '42' },
          edgeName: 'People',
          to: { recordType: 'Person', externalId: '888' },
          mutationContext: MUTATION,
        }),
      ).toEqual({ removed: false });
      expect(calls.updatePerson).toEqual([]);
    });

    // The association is NAMED, not inferred from "this edge is no custom
    // reference field" — a custom reference between the same two types (an
    // enriched one here) is a field value, never an employer link.
    it('an enriched reference between the same two types lands as its field, not as an employer', async () => {
      const { adapter, calls } = makeAdapter();
      await adapter.linkRecords({
        from: { recordType: 'Organization', externalId: '42' },
        edgeName: 'Enriched Contact',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      });
      expect(calls.createFieldValue).toEqual([
        expect.objectContaining({ field_id: 107, value: 888 }),
      ]);
      expect(calls.updatePerson).toEqual([]);
    });
  });

  it('an entry reached through the membership COLLECTION cannot say which list it is on', async () => {
    // The collection is reached by naming a list in a body; only a list's own
    // type pins one. Nothing to hold the reference, so it is refused by name.
    const { adapter } = makeAdapter();
    await expect(
      adapter.linkRecords({
        from: { recordType: 'Organization List Entry', externalId: '8801' },
        edgeName: 'Owners',
        to: { recordType: 'Person', externalId: '888' },
        mutationContext: MUTATION,
      }),
    ).rejects.toThrow(/Organization List Entry/);
  });
});

describe('AffinityAdapter list-entry read-back', () => {
  it('reads an entry\'s values under the bare names its list publishes', async () => {
    const { adapter } = makeAdapter({
      fieldValues: [
        { id: 11, field_id: 103, list_entry_id: 9999, value: 42 },
        { id: 12, field_id: 110, list_entry_id: 9999, value: 'Robotics' },
        { id: 13, field_id: 110, list_entry_id: 9999, value: 'Supply Chain' },
      ],
    });
    const current = await adapter.readRecord({
      recordType: 'List Entry — Hot Leads',
      externalId: '9999',
    });
    expect(current).toEqual({
      'List Score': 42,
      // `allows_multiple` reads as the whole list — what `+:` merges against.
      Tags: ['Robotics', 'Supply Chain'],
      listName: 'Hot Leads',
    });
  });

  it('names the list from the entry\'s own values when the type pins none', async () => {
    const { adapter } = makeAdapter({
      fieldValues: [{ id: 11, field_id: 103, list_entry_id: 9999, value: 42 }],
    });
    // The membership collection is reached through the record's edge, so it
    // never pins a list — but field 103 belongs to exactly one.
    const current = await adapter.readRecord({
      recordType: 'Organization List Entry',
      externalId: '9999',
    });
    expect(current).toEqual({ 'List Score': 42, listName: 'Hot Leads' });
  });

  it('reads an entry with nothing on it as empty, not as unreadable', async () => {
    const { adapter } = makeAdapter({ fieldValues: [] });
    expect(
      await adapter.readRecord({ recordType: 'Organization List Entry', externalId: '9999' }),
    ).toEqual({});
  });

  it('reads a REHEARSED entry as nothing — its handle carries no Affinity id', async () => {
    const { adapter } = makeAdapter();
    expect(
      await adapter.readRecord({
        recordType: 'List Entry — Hot Leads',
        externalId: 'c0ffee00-0000-4000-8000-000000000000',
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Custom record-reference writes — a Person/Org-valued field is an EDGE,
//    written via parentLinks (the parent's reference set to the new child).
// ---------------------------------------------------------------------------

describe('AffinityAdapter custom-reference edge writes', () => {
  it('sets the parent org\'s "Primary Contact" reference to a linked person', async () => {
    const { adapter, calls } = makeAdapter();
    // `write org -[:Primary Contact]-> person` — person is the child; the org
    // (parent) holds the reference. The edge name is the field's natural
    // displayName; the adapter resolves it to the numeric field id (104).
    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe', Email: 'jane@acme.com' },
      parentLinks: [
        { recordType: 'Organization', externalId: '42', edgeName: 'Primary Contact' },
      ],
      mutationContext: {} as never,
    });
    // The org's reference field (104) is set to the newly-created person (888).
    const ref = calls.createFieldValue.find((c) => c.field_id === 104);
    expect(ref).toBeDefined();
    expect(ref!.entity_id).toBe(42);
    expect(ref!.value).toBe(888);
  });

  it('is idempotent — skips a reference that already points at the child', async () => {
    const { adapter, calls } = makeAdapter({
      fieldValues: [{ id: 7, field_id: 104, list_entry_id: null, value: 888 }],
    });
    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe' },
      parentLinks: [
        { recordType: 'Organization', externalId: '42', edgeName: 'Primary Contact' },
      ],
      mutationContext: {} as never,
    });
    expect(calls.createFieldValue.find((c) => c.field_id === 104)).toBeUndefined();
    expect(calls.updateFieldValue.find((c) => c.id === 7)).toBeUndefined();
  });

  it('does NOT treat a custom-reference org parent as the built-in employer association', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe' },
      parentLinks: [
        { recordType: 'Organization', externalId: '42', edgeName: 'Primary Contact' },
      ],
      mutationContext: {} as never,
    });
    // The org went into the reference field, NOT the person's org association.
    expect(calls.createOrUpdatePerson[0].orgId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. The built-in org↔person association, written from the PERSON side —
//    `write person -[:Organizations]-> org` (the N×M mirror of the org side).
// ---------------------------------------------------------------------------

describe('AffinityAdapter person→organization association writes', () => {
  it('APPENDS the written org to the person parent\'s employers', async () => {
    const { adapter, calls } = makeAdapter({ personOrgIds: [7101] });
    await adapter.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Beta Corp', Domain: 'beta.com' },
      parentLinks: [{ recordType: 'Person', externalId: '7201', edgeName: 'Organizations' }],
      mutationContext: {} as never,
    });
    // Existing employers survive — the association is many-to-many.
    expect(calls.updatePerson).toEqual([
      { id: 7201, payload: { organization_ids: [7101, 999] } },
    ]);
  });

  it('is idempotent — a person already linked to the org is left alone', async () => {
    const { adapter, calls } = makeAdapter({ personOrgIds: [999] });
    await adapter.createRecord({
      recordType: 'Organization',
      fields: { Name: 'Beta Corp' },
      parentLinks: [{ recordType: 'Person', externalId: '7201', edgeName: 'Organizations' }],
      mutationContext: {} as never,
    });
    expect(calls.updatePerson).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. createRecord(file) — FileRef upload to the parent organization
// ---------------------------------------------------------------------------

describe('AffinityAdapter.createRecord(file)', () => {
  it('redeems the FileRef for its bytes and uploads them to the parent org', async () => {
    const { adapter, calls } = makeAdapter();
    const store = installMemoryDocumentStore();
    await adapter.createRecord({
      recordType: 'File',
      fields: {
        File: store.file('pdf-bytes', { name: 'deck.pdf', contentType: 'application/pdf' }),
      },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'People' }],
      mutationContext: {} as never,
    });
    expect(calls.uploadEntityFile).toEqual([
      { entityId: 42, entityType: 'organization', fileName: 'deck.pdf' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// deleteRecord — Affinity v1 first-class deletes (2026-07-05)
// ---------------------------------------------------------------------------

describe('AffinityAdapter.deleteRecord', () => {
  const ctx = { mutationContext: {} as never };

  it('deletes organizations, persons, and notes by numeric id', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.deleteRecord({ recordType: 'Organization', externalId: '42', ...ctx });
    await adapter.deleteRecord({ recordType: 'Person', externalId: '7', ...ctx });
    await adapter.deleteRecord({ recordType: 'Note', externalId: '9', ...ctx });
    expect(calls.deletes).toEqual(['organization:42', 'person:7', 'note:9']);
  });

  it('deletes a list entry through its per-list type (list id from the structured id)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.deleteRecord({ recordType: 'List Entry — Hot Leads', externalId: '13', ...ctx });
    expect(calls.deletes).toEqual(['list-entry:555:13']);
  });

  it('rejects files, non-numeric ids, and unknown types loudly', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.deleteRecord({ recordType: 'File', externalId: '1', ...ctx }),
    ).rejects.toThrow('not deletable');
    await expect(
      adapter.deleteRecord({ recordType: 'Organization', externalId: 'abc', ...ctx }),
    ).rejects.toThrow('not a numeric');
    await expect(
      adapter.deleteRecord({ recordType: 'attio:companies', externalId: '1', ...ctx }),
    ).rejects.toThrow('unrecognised recordType');
  });
});

// ── Expression reads of custom fields ───────────────────────────────────────
// `getFieldValue` is the expression read path (`co.`Stage``). Affinity records
// are SPLIT: built-ins land inline on the position, custom values live behind
// `/field-values`. The base adapter reads only the inline data, so before the
// override every custom field read as null — SILENTLY, because the name
// resolves against the descriptor and merely isn't in the data.

describe('AffinityAdapter.getFieldValue — custom fields', () => {
  const ctx = { mutationContext: {} as never };

  /** Org 7101 has Stage = "Series A" at the entity level, plus a LIST-SCOPED
   *  List Score on its entry 9301. Employees has no row at all. Values use the
   *  real wire shapes: a RANKED_DROPDOWN (Stage) arrives as the whole option
   *  object, a plain DROPDOWN (Segment) as a bare option id. */
  const FIELD_VALUES = [
    { id: 1, field_id: 100, list_entry_id: null, value: { id: 2, rank: 1, text: 'Series A' } },
    { id: 2, field_id: 103, list_entry_id: 9301, value: 42 },
    { id: 3, field_id: 105, list_entry_id: null, value: 8 },
  ];

  const orgPosition = makeStablePosition({
    adapterType: 'affinity',
    recordType: 'Organization',
    recordId: '7101',
    // Built-ins land keyed by descriptor fieldId, exactly as `canonicalOrgData`
    // builds them — that is what makes the inline (no-fetch) read resolve.
    data: { name: 'Acme', domain: 'acme.com', domains: ['acme.com'] },
  });

  it('reads a custom field off the record — not null (the bug)', async () => {
    const { adapter } = makeAdapter({ fieldValues: FIELD_VALUES });
    expect(await adapter.getFieldValue({ position: orgPosition, fieldId: 'Stage' })).toBe('Series A');
  });

  it('decodes a dropdown to its LABEL, the same label describe published as an enumValue', async () => {
    const { adapter } = makeAdapter({ fieldValues: FIELD_VALUES });
    const descriptor = await adapter.describe('Organization');
    const stage = descriptor?.fields.find((f) => f.displayName === 'Stage');
    const value = await adapter.getFieldValue({ position: orgPosition, fieldId: 'Stage' });
    expect(stage?.enumValues).toContain(value);
    expect(value).not.toBe(2);
  });

  it('decodes a plain DROPDOWN from its bare option id too, not just the ranked option object', async () => {
    const { adapter } = makeAdapter({ fieldValues: FIELD_VALUES });
    expect(await adapter.getFieldValue({ position: orgPosition, fieldId: 'Segment' })).toBe('Enterprise');
  });

  it('a field with no value reads null — an empty value and a missing fetch must not look the same', async () => {
    const { adapter } = makeAdapter({ fieldValues: FIELD_VALUES });
    expect(await adapter.getFieldValue({ position: orgPosition, fieldId: 'Employees' })).toBeNull();
  });

  // "Three custom fields off one record cost ONE /field-values request" is
  // still true and still guarded — but it is no longer the ADAPTER that makes
  // it true, so it can no longer be shown with a stand-in client. The adapter
  // used to keep a per-instance map of decoded values, cleared wholesale on any
  // write through that instance; the run's read memo now answers the repeat at
  // the client, evicted by the write that actually invalidated it. The property
  // is asserted against the real client in
  // adapters/affinity/__test__/request_cache.unit.test.ts.
  it('asks about the record, not about each field', async () => {
    const { adapter, calls } = makeAdapter({ fieldValues: FIELD_VALUES });
    await Promise.all([
      adapter.getFieldValue({ position: orgPosition, fieldId: 'Stage' }),
      adapter.getFieldValue({ position: orgPosition, fieldId: 'Employees' }),
      adapter.getFieldValue({ position: orgPosition, fieldId: 'Crunchbase Rank' }),
    ]);
    // Every ask names the ORGANIZATION — none of them narrows to a field, which
    // is what made this one question the memo can answer once.
    expect(calls.getFieldValues).toEqual([
      { organization_id: 7101 },
      { organization_id: 7101 },
      { organization_id: 7101 },
    ]);
  });

  it('built-ins resolve from the inline data with NO fetch at all', async () => {
    const { adapter, calls } = makeAdapter({ fieldValues: FIELD_VALUES });
    expect(await adapter.getFieldValue({ position: orgPosition, fieldId: 'Name' })).toBe('Acme');
    expect(await adapter.getFieldValue({ position: orgPosition, fieldId: 'Domain' })).toBe('acme.com');
    expect(calls.getFieldValues).toHaveLength(0);
  });

  it('an entity read never picks up its own list entries\' list-scoped values', async () => {
    const { adapter } = makeAdapter({ fieldValues: FIELD_VALUES });
    // `List Score` is a list-scoped field; at the entity scope it is not the
    // org's value even though `?organization_id=` returns the row.
    await expect(
      adapter.getFieldValue({ position: orgPosition, fieldId: 'List Score' }),
    ).rejects.toThrow();
  });

  it('a list entry reads its OWN list-scoped values, by list-entry scope', async () => {
    const { adapter, calls } = makeAdapter({ fieldValues: FIELD_VALUES });
    const entry = makeStablePosition({
      adapterType: 'affinity',
      recordType: 'List Entry — Hot Leads',
      recordId: '9301',
      data: {},
    });
    expect(await adapter.getFieldValue({ position: entry, fieldId: 'List Score' })).toBe(42);
    expect(calls.getFieldValues).toEqual([{ list_entry_id: 9301 }]);
  });

  it('a write invalidates the cache — a read-after-write is not served the pre-write value', async () => {
    const { adapter, calls } = makeAdapter({ fieldValues: FIELD_VALUES });
    await adapter.getFieldValue({ position: orgPosition, fieldId: 'Stage' });
    await adapter.updateRecord({
      recordType: 'Organization',
      externalId: '7101',
      fields: { Name: 'Acme' },
      ...ctx,
    });
    await adapter.getFieldValue({ position: orgPosition, fieldId: 'Stage' });
    expect(calls.getFieldValues.filter((c) => c.organization_id === 7101).length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 12. An authored first/last split reaches the create intact.
//     `write org -[:Founders]-> { `First name`: …, `Last name`: … }` joined the
//     halves into one string and made a model guess them apart again; on "Hong
//     Yan Hank Wu" it guessed nothing and killed a 128-record run.
// ---------------------------------------------------------------------------

describe('AffinityAdapter.createRecord(person) — the authored name split', () => {
  it('carries `First name` and `Last name` through to the create', async () => {
    const { adapter, calls } = makeAdapter();

    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'First name': 'Hong Yan Hank', 'Last name': 'Wu' },
      parentLinks: [{ recordType: 'Organization', externalId: '42', edgeName: 'Founders' }],
      mutationContext: {} as never,
    });

    expect(calls.createOrUpdatePerson).toHaveLength(1);
    expect(calls.createOrUpdatePerson[0].searchQuery).toEqual(
      expect.objectContaining({
        // Matching still searches the joined name…
        name: 'Hong Yan Hank Wu',
        // …while the create gets the halves the author actually wrote.
        firstName: 'Hong Yan Hank',
        lastName: 'Wu',
      }),
    );
  });

  it('leaves the halves unset when the write supplies one undivided name', async () => {
    const { adapter, calls } = makeAdapter();

    await adapter.createRecord({
      recordType: 'Person',
      fields: { 'Full name': 'Jane Doe' },
      mutationContext: {} as never,
    });

    expect(calls.createOrUpdatePerson[0].searchQuery).toEqual(
      expect.objectContaining({ name: 'Jane Doe', firstName: null, lastName: null }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8b. The display-name rule on its own (the collision branches)
// ---------------------------------------------------------------------------

describe('listScopedFieldDisplayNames', () => {
  const field = (id: number, name: string, list_id: number | null) => ({
    id,
    name,
    list_id,
    enrichment_source: null,
    value_type: 6,
    allows_multiple: false,
    dropdown_options: null,
  });

  it("takes the list's own prefix off its own fields, and answers for nothing else", () => {
    const names = listScopedFieldDisplayNames({
      catalog: [
        field(1, '[Pipeline] Deal Stage', 7),
        field(2, 'Industry', null),
        field(3, '[Portfolio] Ownership %', 8),
      ],
      listId: 7,
      listName: 'Pipeline',
    });
    expect([...names]).toEqual([[1, 'Deal Stage']]);
  });

  it('leaves a field Affinity did not prefix alone', () => {
    const names = listScopedFieldDisplayNames({
      catalog: [field(1, 'Deal Stage', 7)],
      listId: 7,
      listName: 'Pipeline',
    });
    expect(names.get(1)).toBe('Deal Stage');
  });

  it('keeps the prefix on BOTH fields whose bare names would collide', () => {
    const names = listScopedFieldDisplayNames({
      catalog: [field(1, '[Pipeline] Owner', 7), field(2, '[Pipeline] Owner', 7)],
      listId: 7,
      listName: 'Pipeline',
    });
    expect(names.get(1)).toBe('[Pipeline] Owner');
    expect(names.get(2)).toBe('[Pipeline] Owner');
  });

  it('keeps the prefix when some other field already carries that name verbatim', () => {
    const names = listScopedFieldDisplayNames({
      catalog: [field(1, '[Pipeline] Industry', 7), field(2, 'Industry', null)],
      listId: 7,
      listName: 'Pipeline',
    });
    expect(names.get(1)).toBe('[Pipeline] Industry');
  });

  it("strips only THIS list's prefix — another list's bracket is part of the name", () => {
    const names = listScopedFieldDisplayNames({
      catalog: [field(1, '[Portfolio] Ownership %', 7)],
      listId: 7,
      listName: 'Pipeline',
    });
    expect(names.get(1)).toBe('[Portfolio] Ownership %');
  });
});

// ---------------------------------------------------------------------------
// 9. The list-entry write, through the REAL projection and the REAL checker
// ---------------------------------------------------------------------------
//
// `describe` publishing a writable field is only half the promise: what an
// author meets is the checker, over the catalog a save builds. So this runs the
// REAL adapter (listEntryPoints + describe) through the REAL projection and
// then through `checkProgram` — the same three layers a save walks.
//
// movement-lang's own jest is broken locally, so the language layer is
// exercised through apps/api's ts-jest (per repo convention).

describe('write org-[:List Entries]-> reaches the checker', () => {
  async function affinitySnapshot(): Promise<CatalogSnapshot> {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'affinity',
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
    return {
      adapters: {
        affinity: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          canFire: true,
          triggerConfig: ['events'],
          triggerConfigOptions: { events: [...(AFFINITY_MANIFEST.subscribableEvents ?? [])] },
          schemas: { affinity_creds: schema },
        },
      },
      credentials: { affinity_creds: { adapters: ['affinity'] } },
      plugins: {},
    };
  }

  const PRELUDE = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)
`;

  async function errorsFor(body: string): Promise<Array<{ code: string; message: string }>> {
    const source = `${PRELUDE}
movement sync() {
  crm-[org:\`Organization\` WHERE \`Domain\` == "acme.com"]-> {
${body}
  }
}`;
    return checkProgram(parseProgram(source), fromCatalogSnapshot(await affinitySnapshot()))
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => ({ code: d.code, message: d.message }));
  }

  it("carries the LIST's own fields into the write variant, so the acceptance write validates clean", async () => {
    expect(
      await errorsFor(
        '    write org-[:`List Entries`]-> { listName: "Hot Leads", `List Score`: 42 }',
      ),
    ).toEqual([]);
  });

  it('the membership-only write still validates (a list field is optional)', async () => {
    expect(
      await errorsFor('    write org-[:`List Entries`]-> { listName: "Hot Leads" }'),
    ).toEqual([]);
  });

  it('a made-up field is still MOV_WRITE_UNKNOWN_FIELD', async () => {
    const found = await errorsFor(
      '    write org-[:`List Entries`]-> { listName: "Hot Leads", `Utter Nonsense`: "x" }',
    );
    expect(found.map((d) => d.code)).toContain('MOV_WRITE_UNKNOWN_FIELD');
  });

  it('an ENRICHED list field is in the variant, so writing it validates clean', async () => {
    expect(
      await errorsFor(
        '    write org-[:`List Entries`]-> { listName: "Hot Leads", `Affinity Score`: 9 }',
      ),
    ).toEqual([]);
  });

  it("the OTHER list's field is still rejected on this list (the variant is per-list)", async () => {
    const found = await errorsFor(
      '    write org-[:`List Entries`]-> { listName: "Hot Leads", `Ownership %`: 5 }',
    );
    expect(found.map((d) => d.code)).toContain('MOV_WRITE_UNKNOWN_FIELD');
  });

  it('hand-maintained ORGANIZATION custom fields are writable too', async () => {
    expect(
      await errorsFor('    write crm-[:`Organization`]-> { Name: "Acme", Stage: "Seed" }'),
    ).toEqual([]);
  });

  it('an enrichment-sourced organization field validates clean', async () => {
    expect(
      await errorsFor('    write crm-[:`Organization`]-> { Name: "Acme", `Crunchbase Rank`: 5 }'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. An organisation's entries on one list, read inside EXISTS(…)
// ---------------------------------------------------------------------------
//
// The org's `List Entries` edge lands on the per-entity collection, whose
// members are the workspace's lists, so a WHERE naming the list narrows the hop
// to that list's own entry type — whether the path heads a block or sits inside
// `EXISTS(…)`. The second form was refused on Project A (`… has no field 'Deal
// Created' — it has: listName`): the host never saw the path inside EXISTS, so
// nothing narrowed. This runs the real adapter, the real meta walk's members,
// the real host narrowing pass and the real checker, as a save does.

describe('an org\'s list entries narrowed by list inside EXISTS reach the checker', () => {
  async function refinedSnapshot(source: string): Promise<CatalogSnapshot> {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (
        await Promise.all(
          entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const),
        )
      ).flatMap(([typeId, d]) => (d ? [[typeId, d] as const] : [])),
    );
    const { schema } = instanceSchemaFromDescriptors({
      adapterType: 'affinity',
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
    // The paths the meta walk files, by name — what `instance_cache` keeps.
    const root = await adapter.edgesFrom(makeMetaPosition('affinity'));
    const targetByFieldId = new Map(
      (root?.descriptor.references ?? []).map((r) => [r.fieldId, r.targetTypeId] as const),
    );
    const positionsByName = new Map<string, SourcePosition>();
    for (const [fieldId, position] of Object.entries(root?.targetPositions ?? {})) {
      positionsByName.set(targetByFieldId.get(fieldId) ?? positionLabel(position) ?? fieldId, position);
    }
    const refined = await refineInstanceSchema({
      instance: {
        adapterType: 'affinity',
        schema,
        entryPoints: entries.map((e) => ({
          typeId: e.typeId,
          displayName: e.displayName,
          writable: e.writable ?? false,
          readable: e.readable ?? false,
        })),
        describeType: async (name) => {
          const position = positionsByName.get(name);
          return position
            ? ((await adapter.edgesFrom(position))?.descriptor ?? null)
            : adapter.describe(name);
        },
        membersOf: async (recordType) =>
          [...positionsByName.entries()]
            .filter(([, position]) => position.recordType === recordType)
            .map(([name, position]) => ({ name, data: position.identity.data })),
      },
      chains: scanInstanceChains(source),
    });
    return {
      adapters: {
        affinity: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          canFire: true,
          triggerConfig: ['events'],
          triggerConfigOptions: { events: [...(AFFINITY_MANIFEST.subscribableEvents ?? [])] },
          schemas: { affinity_creds: refined.schema },
        },
      },
      credentials: { affinity_creds: { adapters: ['affinity'] } },
      plugins: {},
    };
  }

  /** Project A's shape: a library function testing a match's entries. */
  async function errorsFor(line: string): Promise<Array<{ code: string; message: string }>> {
    const source = `import { affinity } from adapters
import { affinity_creds } from credentials

crm = affinity(credentials: affinity_creds)

export node Deal {
  name: <text>
}

export function \`Probe Deal\`(d: <Deal>) {
  floor = 3
${line}
  return 1
}`;
    return checkProgram(parseProgram(source), fromCatalogSnapshot(await refinedSnapshot(source)))
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => ({ code: d.code, message: d.message }));
  }

  const HOP =
    'crm-[o:`Organization` WHERE `Name` == d.name]->-[le:`List Entries` WHERE `listName` == "Hot Leads" AND `List Score` >= floor]->';

  it('a list\'s own field validates beside the list name, inside EXISTS', async () => {
    expect(await errorsFor(`  hit = EXISTS(${HOP})`)).toEqual([]);
    expect(await errorsFor(`  if EXISTS(${HOP}) {\n    return 0\n  }`)).toEqual([]);
  });

  it('and inside COUNT, which already carried its hops', async () => {
    expect(await errorsFor(`  n = COUNT(${HOP})`)).toEqual([]);
  });

  it('a field no list declares is refused against THAT list, not the collection', async () => {
    const [diagnostic, ...rest] = await errorsFor(
      '  hit = EXISTS(crm-[o:`Organization` WHERE `Name` == d.name]->-[le:`List Entries` WHERE `listName` == "Hot Leads" AND `Made Up` >= floor]->)',
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toContain('Organization List Entry "Hot Leads"');
    expect(diagnostic.message).toContain('List Score');
  });

  it('without the list name, a list\'s field is refused with the narrowing test to add', async () => {
    const [diagnostic, ...rest] = await errorsFor(
      '  hit = EXISTS(crm-[o:`Organization` WHERE `Name` == d.name]->-[le:`List Entries` WHERE `List Score` >= floor]->)',
    );
    expect(rest).toEqual([]);
    expect(diagnostic.code).toBe('MOV_UNKNOWN_PROPERTY');
    expect(diagnostic.message).toBe(
      "crm.Organization List Entry has no field 'List Score' — it has: listName. If it is a field of one Organization List Entry only, narrow the hop that lands here to it: test `Name` == \"…\" (or `Id`, `listName`) in its WHERE",
    );
  });
});
