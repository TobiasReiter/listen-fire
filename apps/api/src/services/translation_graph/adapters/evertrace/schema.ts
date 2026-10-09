// The Evertrace type graph: the entry surface and every type descriptor.
//
// Rule 0 (adapters/CLAUDE.md): the shape follows the NATURAL graph, not the
// API. A workspace holds signals, saved searches and curated lists. A list owns
// its entries (single parent), so entries live under their list; a signal's
// membership is the reverse edge, not a second root. Companies and schools are
// lookup entities with root collections because the signal filters take their
// ids and nothing else can find one.
//
// Everything here is STATIC — no credential, no network — so `describe` is free
// and the walk hydrates every target rather than stubbing.

import type { SchemaEntryPoint, SchemaTypeDescriptor } from '../../types';

import { META_RECORD_TYPE } from '../../types';
import {
  EVERTRACE_COMPANIES_COLLECTION,
  EVERTRACE_COMPANY_DISPLAY_NAME,
  EVERTRACE_COMPANY_TYPE_ID,
  EVERTRACE_EDUCATIONS_EDGE,
  EVERTRACE_EDUCATIONS_EDGE_NAME,
  EVERTRACE_EDUCATION_DISPLAY_NAME,
  EVERTRACE_EDUCATION_SCHOOL_EDGE,
  EVERTRACE_EDUCATION_SCHOOL_EDGE_NAME,
  EVERTRACE_EDUCATION_TYPE_ID,
  EVERTRACE_ENTRY_LIST_EDGE,
  EVERTRACE_ENTRY_LIST_EDGE_NAME,
  EVERTRACE_ENTRY_SIGNAL_EDGE,
  EVERTRACE_ENTRY_SIGNAL_EDGE_NAME,
  EVERTRACE_EXPERIENCES_EDGE,
  EVERTRACE_EXPERIENCES_EDGE_NAME,
  EVERTRACE_EXPERIENCE_COMPANY_EDGE,
  EVERTRACE_EXPERIENCE_COMPANY_EDGE_NAME,
  EVERTRACE_EXPERIENCE_DISPLAY_NAME,
  EVERTRACE_EXPERIENCE_TYPE_ID,
  EVERTRACE_LISTS_COLLECTION,
  EVERTRACE_LIST_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRIES_EDGE,
  EVERTRACE_LIST_ENTRIES_EDGE_NAME,
  EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRY_EVENT,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_LIST_TYPE_ID,
  EVERTRACE_SCHOOLS_COLLECTION,
  EVERTRACE_SCHOOL_DISPLAY_NAME,
  EVERTRACE_SCHOOL_TYPE_ID,
  EVERTRACE_SEARCHES_COLLECTION,
  EVERTRACE_SEARCH_DISPLAY_NAME,
  EVERTRACE_SEARCH_SIGNALS_EDGE,
  EVERTRACE_SEARCH_SIGNALS_EDGE_NAME,
  EVERTRACE_SEARCH_TYPE_ID,
  EVERTRACE_SIGNALS_COLLECTION,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
  EVERTRACE_SIGNAL_EVENT,
  EVERTRACE_TAG_VALUES,
  EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE,
  EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE_NAME,
  EVERTRACE_SIGNAL_TYPE_ID,
  EVERTRACE_WORKSPACE_DISPLAY_NAME,
  EVERTRACE_WORKSPACE_TYPE_ID,
} from './types';

const SIGNALS_DESCRIPTION =
  'People whose profile has just triggered a trackable event. An unbounded ' +
  'walk covers the whole corpus, so give the WHERE a `Discovered At` lower ' +
  'bound (and a `Score` floor) to keep it fast; the filters Evertrace cannot ' +
  'take are applied after the fetch.';

/**
 * A root collection whose WHERE reaches Evertrace's own query (`filter.ts`)
 * and whose ORDER BY does not — the endpoint takes filters and no sort, so the
 * result arrives in whatever order Evertrace chose and the engine sorts it.
 *
 * `order: 'bounded'` is that fact, and the checker now reads it: an ORDER BY
 * here stays legal and carries a warning naming the fetch it costs, rather
 * than being silently blessed as a server-side sort. The adapter's own half of
 * the contract is that a `limit` is dropped whenever an `orderBy` arrives —
 * truncating before a sort we do not do would answer wrong.
 *
 */
const ROOT_QUERY = { filter: 'native', order: 'bounded', supportsLimit: true } as const;

/** An UNPAGED root collection: the whole set arrives in one call, so any WHERE
 *  and any ORDER BY are satisfied over what came back. */
const ROOT_WHOLE_SET = { filter: 'bounded', order: 'bounded', supportsLimit: true } as const;

/**
 * An edge BOUNDED by the record it leaves — one profile's roles, one list's
 * entries, one saved search's matches. What comes back is a set small enough
 * to hold, so any WHERE (an `AI()` or `EXISTS()` judgement included) and any
 * ORDER BY are satisfied over it, whatever Evertrace's own query can take.
 */
const BOUNDED_BY_PARENT = {
  filter: 'bounded',
  order: 'bounded',
  supportsLimit: true,
} as const;

/**
 * The entry surface. Types reachable ONLY through a parent (an experience, an
 * education, a list entry) publish `readable: false`: the root cannot enumerate
 * them, so a root collection would be a read that could only ever return
 * nothing. The entry stays published so the name resolver and `describe` still
 * know the type.
 *
 */
export function evertraceEntryPoints(): SchemaEntryPoint[] {
  return [
    {
      typeId: EVERTRACE_SIGNAL_TYPE_ID,
      displayName: EVERTRACE_SIGNAL_DISPLAY_NAME,
      // Signals are DISCOVERED by Evertrace, never created — the root's
      // `Signals` edge makes no write promise, so `write evertrace-[:Signals]->`
      // is refused at author time. `writable` here is what publishes the write
      // SHAPE, which is how `write <signal> { Screened: true }` reaches
      // `updateRecord`: screening and viewing are facts about a signal that a
      // person changes, so they are fields, not action nodes.
      writable: true,
      readable: true,
      collectionName: EVERTRACE_SIGNALS_COLLECTION,
      description: SIGNALS_DESCRIPTION,
    },
    // The EVENT edge onto the same node the readable collection lands on
    // (adapters/CLAUDE.md rule 9 — two edges, two promises, one node).
    {
      typeId: EVERTRACE_SIGNAL_TYPE_ID,
      displayName: EVERTRACE_SIGNAL_DISPLAY_NAME,
      writable: false,
      readable: false,
      fires: true,
      firesOn: [EVERTRACE_SIGNAL_EVENT],
      description:
        'Delivered when Evertrace discovers a new signal since the last poll. ' +
        'The signal itself — read its profile, experiences and educations.',
    },
    {
      typeId: EVERTRACE_SEARCH_TYPE_ID,
      displayName: EVERTRACE_SEARCH_DISPLAY_NAME,
      writable: true,
      readable: true,
      collectionName: EVERTRACE_SEARCHES_COLLECTION,
      description: 'The saved searches in this workspace — a filter preset over signals.',
    },
    {
      typeId: EVERTRACE_LIST_TYPE_ID,
      displayName: EVERTRACE_LIST_DISPLAY_NAME,
      writable: true,
      readable: true,
      collectionName: EVERTRACE_LISTS_COLLECTION,
      description: 'The curated lists in this workspace.',
    },
    {
      typeId: EVERTRACE_COMPANY_TYPE_ID,
      displayName: EVERTRACE_COMPANY_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: EVERTRACE_COMPANIES_COLLECTION,
      description:
        'Companies Evertrace knows, biggest first. Filter by `Name` to find one ' +
        "and read its id — that is what a signal filter's past-company slot takes.",
    },
    {
      typeId: EVERTRACE_SCHOOL_TYPE_ID,
      displayName: EVERTRACE_SCHOOL_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: EVERTRACE_SCHOOLS_COLLECTION,
      description: 'Schools Evertrace knows, biggest first. The counterpart of `Companies`.',
    },
    {
      typeId: EVERTRACE_EXPERIENCE_TYPE_ID,
      displayName: EVERTRACE_EXPERIENCE_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
    {
      typeId: EVERTRACE_EDUCATION_TYPE_ID,
      displayName: EVERTRACE_EDUCATION_DISPLAY_NAME,
      writable: false,
      readable: false,
    },
    {
      typeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
      displayName: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
      // Reached through its list or its signal, never enumerated from the root;
      // created and removed along those same edges.
      writable: false,
      readable: false,
    },
    // The EVENT edge onto that same node (rule 9 again): a membership arrives
    // as well as being walked to, and the arriving entry carries both ends, so
    // a run reads the person and the list off what it was handed.
    {
      typeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
      displayName: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
      writable: false,
      readable: false,
      fires: true,
      firesOn: [EVERTRACE_LIST_ENTRY_EVENT],
      description:
        'Delivered when a signal is added to a list. Walk `Signal` for the ' +
        'person and `List` for the list it was filed on.',
    },
  ];
}

/** The workspace meta node — what this connection IS, and the edges leaving it.
 *  The one thing no `describe` can answer, so the adapter states it. */
export const EVERTRACE_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: EVERTRACE_WORKSPACE_DISPLAY_NAME,
  description:
    'The Evertrace workspace. Walk `Signals` to pull founders Evertrace has ' +
    'already found; listen on `Signal` to be told about new ones, or on ' +
    '`List Entry` to be told when one is added to a list; `Searches` and ' +
    '`Lists` are the saved filters and curated lists you can read and edit.',
  fields: [],
  references: [
    {
      fieldId: EVERTRACE_SIGNALS_COLLECTION,
      targetTypeId: EVERTRACE_SIGNAL_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_SIGNALS_COLLECTION,
      description: SIGNALS_DESCRIPTION,
      capability: ROOT_QUERY,
    },
    {
      fieldId: `fires:${EVERTRACE_SIGNAL_TYPE_ID}`,
      targetTypeId: EVERTRACE_SIGNAL_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_SIGNAL_DISPLAY_NAME,
      fires: true,
      firesOn: [EVERTRACE_SIGNAL_EVENT],
      readable: false,
      description: 'A newly discovered signal — what a listen delivers.',
    },
    {
      fieldId: EVERTRACE_SEARCHES_COLLECTION,
      targetTypeId: EVERTRACE_SEARCH_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_SEARCHES_COLLECTION,
      description:
        'The workspace’s saved searches. Create, rename and delete them here. ' +
        'The whole set arrives in one call, so a WHERE and an ORDER BY over it ' +
        'cost nothing extra.',
      writable: true,
      capability: ROOT_WHOLE_SET,
    },
    {
      fieldId: EVERTRACE_LISTS_COLLECTION,
      targetTypeId: EVERTRACE_LIST_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_LISTS_COLLECTION,
      description:
        'The workspace’s curated lists. Create, rename and delete them here. ' +
        'The whole set arrives in one call, so a WHERE and an ORDER BY over it ' +
        'cost nothing extra.',
      writable: true,
      capability: ROOT_WHOLE_SET,
    },
    {
      fieldId: `fires:${EVERTRACE_LIST_ENTRY_TYPE_ID}`,
      targetTypeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
      fires: true,
      firesOn: [EVERTRACE_LIST_ENTRY_EVENT],
      readable: false,
      description: 'A signal just added to a list — what a listen delivers.',
    },
    {
      fieldId: EVERTRACE_COMPANIES_COLLECTION,
      targetTypeId: EVERTRACE_COMPANY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_COMPANIES_COLLECTION,
      description:
        'Companies Evertrace knows. A `Name` contains-filter reaches the lookup ' +
        'directly; everything else is applied after the fetch.',
      capability: ROOT_QUERY,
    },
    {
      fieldId: EVERTRACE_SCHOOLS_COLLECTION,
      targetTypeId: EVERTRACE_SCHOOL_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_SCHOOLS_COLLECTION,
      description: 'Schools Evertrace knows. Same shape as `Companies`.',
      capability: ROOT_QUERY,
    },
  ],
};

const SIGNAL_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_SIGNAL_TYPE_ID,
  displayName: EVERTRACE_SIGNAL_DISPLAY_NAME,
  description:
    'A person whose profile just triggered a trackable event — a new company, ' +
    'a stealth position, a departure, a patent, a grant, a paper.',
  fields: [
    { fieldId: 'fullName', displayName: 'Name', kind: 'string', writable: false, required: true, description: 'First and last name together. A WHERE on it reaches Evertrace as a case-insensitive partial match.', capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'firstName', displayName: 'First Name', kind: 'string', writable: false, required: true },
    { fieldId: 'lastName', displayName: 'Last Name', kind: 'string', writable: false, required: true },
    { fieldId: 'email', displayName: 'Email', kind: 'string', writable: false, required: false, description: 'Present only where Evertrace has found one.' },
    { fieldId: 'linkedinIdStr', displayName: 'LinkedIn ID', kind: 'string', writable: false, required: true, description: 'The LinkedIn profile slug — the person’s identity across signals.' },
    { fieldId: 'githubSlug', displayName: 'GitHub', kind: 'string', writable: false, required: false },
    { fieldId: 'twitterId', displayName: 'Twitter', kind: 'string', writable: false, required: false },
    { fieldId: 'imageUrl', displayName: 'Image URL', kind: 'string', writable: false, required: false },
    { fieldId: 'city', displayName: 'City', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'country', displayName: 'Country', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'regionName', displayName: 'Region', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'nationality', displayName: 'Nationality', kind: 'string', writable: false, required: false },
    { fieldId: 'gender', displayName: 'Gender', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'age', displayName: 'Age', kind: 'string', writable: false, required: false, description: 'Evertrace’s own wording. A WHERE on it is pushed as an age bucket ("Below 25", "25 to 29", … "Above 49").', capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'description', displayName: 'Description', kind: 'string', writable: false, required: false, description: 'One line on what triggered the signal.' },
    { fieldId: 'summary', displayName: 'Summary', kind: 'string', writable: false, required: false, description: 'Evertrace’s longer write-up of the person.' },
    { fieldId: 'score', displayName: 'Score', kind: 'number', writable: false, required: true, description: '1–10. A WHERE lower bound is pushed as a floor.', capability: { filterOperators: ['eq', 'gt', 'gte'] } },
    { fieldId: 'source', displayName: 'Source', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'stealthSign', displayName: 'Stealth Sign', kind: 'string', writable: false, required: false },
    { fieldId: 'stealthReason', displayName: 'Stealth Reason', kind: 'string', writable: false, required: false },
    { fieldId: 'profileAccuracy', displayName: 'Profile Accuracy', kind: 'string', writable: false, required: false },
    { fieldId: 'discoveredAt', displayName: 'Discovered At', kind: 'date', writable: false, required: true, description: 'When Evertrace saw the triggering event. Lower and upper bounds are pushed as a date range.', capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'] } },
    { fieldId: 'createdAt', displayName: 'Created At', kind: 'date', writable: false, required: true, description: 'When the signal row was created — what a listener’s "new since last poll" is measured on.', capability: { filterOperators: ['gt', 'gte'] } },
    { fieldId: 'tags', displayName: 'Tags', kind: 'string', cardinality: 'many', writable: false, required: false, knownValues: [...EVERTRACE_TAG_VALUES], description: 'What the person is ("Serial Founder", "YC Alumni") and what just happened to them ("New Company", "New Patent"). Both reach Evertrace from a WHERE, through different filters.', capability: { filterOperators: ['eq', 'in', 'contains'] } },
    { fieldId: 'listPresence', displayName: 'In A List', kind: 'boolean', writable: false, required: false, description: 'Whether this signal is already on any list in the workspace.' },
    { fieldId: 'screened', displayName: 'Screened', kind: 'boolean', writable: true, required: false, description: 'Set true to mark the signal screened, false to un-screen it.' },
    { fieldId: 'viewed', displayName: 'Viewed', kind: 'boolean', writable: true, required: false, description: 'Set true to mark the signal viewed. Evertrace has no un-view, so false is refused.' },
  ],
  references: [
    {
      fieldId: EVERTRACE_EXPERIENCES_EDGE,
      targetTypeId: EVERTRACE_EXPERIENCE_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_EXPERIENCES_EDGE_NAME,
      description:
        'The roles on the person’s profile, most recent first. They arrive with ' +
        'the signal, so a WHERE and an ORDER BY over them cost no extra fetch.',
      // The adapter sorts by the profile's own ordering before returning.
      sequenced: 'document',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: EVERTRACE_EDUCATIONS_EDGE,
      targetTypeId: EVERTRACE_EDUCATION_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_EDUCATIONS_EDGE_NAME,
      description:
        'The degrees on the person’s profile, most recent first. They arrive with ' +
        'the signal, so a WHERE and an ORDER BY over them cost no extra fetch.',
      sequenced: 'document',
      capability: BOUNDED_BY_PARENT,
    },
    {
      fieldId: EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE,
      targetTypeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE_NAME,
      description:
        'Where this signal already sits, oldest membership first. Filing it ' +
        'somewhere new is a write that names both ends: ' +
        '`write (list-[:Entries]->, signal-[:List Entries]->) { }`.',
      writable: true,
      // The adapter puts the memberships in `Added At` order before returning
      // them — Evertrace's own endpoint promises none.
      sequenced: 'chronological',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const EXPERIENCE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_EXPERIENCE_TYPE_ID,
  displayName: EVERTRACE_EXPERIENCE_DISPLAY_NAME,
  description: 'One role on a signal’s profile.',
  fields: [
    { fieldId: 'title', displayName: 'Title', kind: 'string', writable: false, required: false },
    { fieldId: 'companyName', displayName: 'Company Name', kind: 'string', writable: false, required: false, description: 'The company as written on the profile — `Company` is the resolved entity, when Evertrace has one.' },
    { fieldId: 'location', displayName: 'Location', kind: 'string', writable: false, required: false },
    { fieldId: 'startDate', displayName: 'Start Date', kind: 'string', writable: false, required: false, description: 'As written on the profile ("Jan 2024"), not a parsed date.' },
    { fieldId: 'endDate', displayName: 'End Date', kind: 'string', writable: false, required: false, description: 'Absent while the role is current.' },
    { fieldId: 'indexOrder', displayName: 'Order', kind: 'number', writable: false, required: true, description: 'Position on the profile, 0 first.' },
  ],
  references: [
    {
      fieldId: EVERTRACE_EXPERIENCE_COMPANY_EDGE,
      targetTypeId: EVERTRACE_COMPANY_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_EXPERIENCE_COMPANY_EDGE_NAME,
      description: 'The company Evertrace resolved this role to, when it could.',
    },
  ],
};

const EDUCATION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_EDUCATION_TYPE_ID,
  displayName: EVERTRACE_EDUCATION_DISPLAY_NAME,
  description: 'One degree on a signal’s profile.',
  fields: [
    { fieldId: 'degree', displayName: 'Degree', kind: 'string', writable: false, required: false },
    { fieldId: 'schoolName', displayName: 'School Name', kind: 'string', writable: false, required: false, description: 'As written on the profile — `School` is the resolved entity, when Evertrace has one.' },
    { fieldId: 'startDate', displayName: 'Start Date', kind: 'string', writable: false, required: false },
    { fieldId: 'endDate', displayName: 'End Date', kind: 'string', writable: false, required: false },
    { fieldId: 'indexOrder', displayName: 'Order', kind: 'number', writable: false, required: true },
  ],
  references: [
    {
      fieldId: EVERTRACE_EDUCATION_SCHOOL_EDGE,
      targetTypeId: EVERTRACE_SCHOOL_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_EDUCATION_SCHOOL_EDGE_NAME,
      description: 'The school Evertrace resolved this degree to, when it could.',
    },
  ],
};

const COMPANY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_COMPANY_TYPE_ID,
  displayName: EVERTRACE_COMPANY_DISPLAY_NAME,
  description: 'A company Evertrace tracks — the entity a role resolves to.',
  fields: [
    // `lookupSearchTerm` (filter.ts) is the only thing the companies/schools
    // lookup reads off a WHERE — an `eq` or `contains` on `Name`. Declaring it
    // here is what makes a WHERE on any OTHER field read as residual instead
    // of silently best-effort, under the root's `native` filter capability.
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'websiteUrl', displayName: 'Website', kind: 'string', writable: false, required: false },
    { fieldId: 'customerSegment', displayName: 'Customer Segment', kind: 'string', writable: false, required: false, description: 'B2B or B2C, when Evertrace has classified it.' },
    { fieldId: 'employeeCount', displayName: 'Employee Count', kind: 'number', writable: false, required: false },
    { fieldId: 'logoUrl', displayName: 'Logo URL', kind: 'string', writable: false, required: false },
    { fieldId: 'sourceUrl', displayName: 'Source URL', kind: 'string', writable: false, required: false },
  ],
  references: [],
};

const SCHOOL_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_SCHOOL_TYPE_ID,
  displayName: EVERTRACE_SCHOOL_DISPLAY_NAME,
  description: 'A school Evertrace tracks — the entity a degree resolves to.',
  fields: [
    // Same lookup as `Companies` — `lookupSearchTerm` (filter.ts) is shared
    // across both, and only ever reads `Name`.
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: false, capability: { filterOperators: ['eq', 'contains'] } },
    { fieldId: 'studentCount', displayName: 'Student Count', kind: 'number', writable: false, required: false },
    { fieldId: 'logoUrl', displayName: 'Logo URL', kind: 'string', writable: false, required: false },
    { fieldId: 'sourceUrl', displayName: 'Source URL', kind: 'string', writable: false, required: false },
  ],
  references: [],
};

const SEARCH_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_SEARCH_TYPE_ID,
  displayName: EVERTRACE_SEARCH_DISPLAY_NAME,
  description:
    'A saved search — a set of filter rows over signals, run on demand by ' +
    'walking its `Signals`.',
  fields: [
    { fieldId: 'title', displayName: 'Title', kind: 'string', writable: true, required: true, description: 'At most 50 characters.' },
    { fieldId: 'emoji', displayName: 'Emoji', kind: 'string', writable: true, required: false },
    {
      fieldId: 'filters',
      displayName: 'Filters',
      kind: 'json',
      cardinality: 'many',
      writable: true,
      required: false,
      description:
        'The filter rows, each `{ key, operator, value }` — keys include score, ' +
        'country, city, profile_tags, gender, age, past_companies, past_education, ' +
        'education_level, customer_focus, industry, region, time_range. Writing ' +
        'them REPLACES the whole set.',
    },
    { fieldId: 'createdAt', displayName: 'Created At', kind: 'date', writable: false, required: true },
    { fieldId: 'updatedAt', displayName: 'Updated At', kind: 'date', writable: false, required: true },
    { fieldId: 'visitedAt', displayName: 'Visited At', kind: 'date', writable: false, required: false, description: 'When someone last opened it in Evertrace.' },
  ],
  references: [
    {
      fieldId: EVERTRACE_SEARCH_SIGNALS_EDGE,
      targetTypeId: EVERTRACE_SIGNAL_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_SEARCH_SIGNALS_EDGE_NAME,
      description:
        'The signals this saved search currently matches, in no promised order. ' +
        'The search is what bounds them, so a WHERE and an ORDER BY here run ' +
        'over what it matched — narrow the search itself when that set is large.',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const LIST_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_LIST_TYPE_ID,
  displayName: EVERTRACE_LIST_DISPLAY_NAME,
  description: 'A curated list of signals.',
  fields: [
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'entriesCount', displayName: 'Entry Count', kind: 'number', writable: false, required: false },
    { fieldId: 'createdAt', displayName: 'Created At', kind: 'date', writable: false, required: true },
    { fieldId: 'updatedAt', displayName: 'Updated At', kind: 'date', writable: false, required: true },
  ],
  references: [
    {
      fieldId: EVERTRACE_LIST_ENTRIES_EDGE,
      targetTypeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: EVERTRACE_LIST_ENTRIES_EDGE_NAME,
      description:
        'What is on the list, oldest addition first. An `ORDER BY` on `Added At` ' +
        'is the one Evertrace can sort by itself; every other WHERE and ORDER BY ' +
        'runs over the entries once they arrive. Adding is idempotent on ' +
        '(list, signal), so re-running never duplicates a member.',
      writable: true,
      // Always fetched in creation order (`sort_by=entry_created_at`), so a
      // fold reads the entries without an ORDER BY.
      sequenced: 'chronological',
      capability: BOUNDED_BY_PARENT,
    },
  ],
};

const LIST_ENTRY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVERTRACE_LIST_ENTRY_TYPE_ID,
  displayName: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  description:
    'One signal’s membership of one list. Both ends are required, so a new ' +
    'entry is written along both edges at once: ' +
    '`write (list-[:Entries]->, signal-[:List Entries]->) { }`.',
  fields: [
    { fieldId: 'createdAt', displayName: 'Added At', kind: 'date', writable: false, required: true, description: 'When the signal went onto the list. Evertrace sorts the list’s entries by it, so an ORDER BY on it reaches the source.', capability: { orderable: true } },
  ],
  references: [
    {
      fieldId: EVERTRACE_ENTRY_SIGNAL_EDGE,
      targetTypeId: EVERTRACE_SIGNAL_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_ENTRY_SIGNAL_EDGE_NAME,
      required: true,
      description: 'The signal on the list.',
    },
    {
      fieldId: EVERTRACE_ENTRY_LIST_EDGE,
      targetTypeId: EVERTRACE_LIST_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: EVERTRACE_ENTRY_LIST_EDGE_NAME,
      required: true,
      description: 'The list it is on.',
    },
  ],
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [EVERTRACE_SIGNAL_TYPE_ID]: SIGNAL_DESCRIPTOR,
  [EVERTRACE_EXPERIENCE_TYPE_ID]: EXPERIENCE_DESCRIPTOR,
  [EVERTRACE_EDUCATION_TYPE_ID]: EDUCATION_DESCRIPTOR,
  [EVERTRACE_COMPANY_TYPE_ID]: COMPANY_DESCRIPTOR,
  [EVERTRACE_SCHOOL_TYPE_ID]: SCHOOL_DESCRIPTOR,
  [EVERTRACE_SEARCH_TYPE_ID]: SEARCH_DESCRIPTOR,
  [EVERTRACE_LIST_TYPE_ID]: LIST_DESCRIPTOR,
  [EVERTRACE_LIST_ENTRY_TYPE_ID]: LIST_ENTRY_DESCRIPTOR,
};

/** The workspace meta descriptor — the same node `edgesFrom` roots at, but
 *  addressed by type id (author-time introspection reaches it that way). */
export const EVERTRACE_WORKSPACE_DESCRIPTOR: SchemaTypeDescriptor = {
  ...EVERTRACE_ROOT,
  typeId: EVERTRACE_WORKSPACE_TYPE_ID,
};

/** `describe` over an already-resolved INTERNAL type id. Null for an id this
 *  adapter does not own. */
export function describeEvertraceType(typeId: string): SchemaTypeDescriptor | null {
  return DESCRIPTORS[typeId] ?? null;
}
