// Evertrace adapter — signals (people whose public profile just changed in a
// trackable way), the saved searches that filter them, and the lists that
// curate them.
//
// Evertrace is a POLLED source: event production lives on the PollSource
// (evertrace/poll.ts), driven by the poll-source worker. This is the read and
// write half. The type graph itself is `schema.ts`; the WHERE pushdown is
// `filter.ts`; the write bodies are `write.ts`.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  Adapter,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  ReadInput,
  RelatedResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { Expression } from '#shared/expression/types';

import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeStablePosition,
  makeUnstablePosition,
  positionData,
} from 'movement-engine/services/translation_graph/types';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import { naturalName } from 'module-kit/adapter/name_resolution';
import {
  EvertraceApiError,
  type EvertraceApiClient,
  type EvertraceCompanyEntity,
  type EvertraceEducationEntity,
  type EvertraceEducationEntry,
  type EvertraceExperience,
  type EvertraceList,
  type EvertraceListEntry,
  type EvertraceSearch,
  type EvertraceSignal,
} from '../../../../adapters/evertrace/apiClient';
import { resolveEvertraceClient } from './client';
import { lookupSearchTerm, signalFilterFromWhere } from './filter';
import {
  EVERTRACE_ROOT,
  EVERTRACE_WORKSPACE_DESCRIPTOR,
  describeEvertraceType,
  evertraceEntryPoints,
} from './schema';
import {
  createEvertraceRecord,
  deleteEvertraceRecord,
  updateEvertraceRecord,
  writableTypeId,
  type EvertraceWritableTypeId,
} from './write';
import {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_COMPANIES_COLLECTION,
  EVERTRACE_COMPANY_DISPLAY_NAME,
  EVERTRACE_COMPANY_TYPE_ID,
  EVERTRACE_EDUCATIONS_EDGE,
  EVERTRACE_EDUCATION_DISPLAY_NAME,
  EVERTRACE_EDUCATION_SCHOOL_EDGE,
  EVERTRACE_EDUCATION_TYPE_ID,
  EVERTRACE_ENTRY_LIST_EDGE,
  EVERTRACE_ENTRY_SIGNAL_EDGE,
  EVERTRACE_EXPERIENCES_EDGE,
  EVERTRACE_EXPERIENCE_COMPANY_EDGE,
  EVERTRACE_EXPERIENCE_DISPLAY_NAME,
  EVERTRACE_EXPERIENCE_TYPE_ID,
  EVERTRACE_LISTS_COLLECTION,
  EVERTRACE_LIST_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRIES_EDGE,
  EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
  EVERTRACE_LIST_ENTRY_EVENT,
  EVERTRACE_LIST_ENTRY_EVENT_TAG,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_LIST_TYPE_ID,
  EVERTRACE_SCHOOLS_COLLECTION,
  EVERTRACE_SCHOOL_DISPLAY_NAME,
  EVERTRACE_SCHOOL_TYPE_ID,
  EVERTRACE_SEARCHES_COLLECTION,
  EVERTRACE_SEARCH_DISPLAY_NAME,
  EVERTRACE_SEARCH_SIGNALS_EDGE,
  EVERTRACE_SEARCH_TYPE_ID,
  EVERTRACE_SIGNALS_COLLECTION,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
  EVERTRACE_SIGNAL_EVENT,
  EVERTRACE_SIGNAL_EVENT_TAG,
  EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE,
  EVERTRACE_SUBSCRIBABLE_EVENTS,
  EVERTRACE_SIGNAL_TYPE_ID,
  EVERTRACE_WORKSPACE_TYPE_ID,
  decodeListEntryId,
  encodeListEntryId,
} from './types';

export {
  EVERTRACE_ADAPTER_TYPE,
  EVERTRACE_SIGNAL_TYPE_ID,
  EVERTRACE_SIGNAL_DISPLAY_NAME,
  EVERTRACE_SIGNAL_EVENT_TAG,
  EVERTRACE_LIST_ENTRY_EVENT_TAG,
  EVERTRACE_SIGNALS_COLLECTION,
  EVERTRACE_SEARCH_TYPE_ID,
  EVERTRACE_LIST_TYPE_ID,
  EVERTRACE_LIST_ENTRY_TYPE_ID,
  EVERTRACE_WORKSPACE_TYPE_ID,
};

/** How many rows a paged fetch asks for at a time. */
const PAGE_SIZE = 100;

const EVERTRACE_HANDBOOK_CONTENT = `Evertrace watches public profiles and raises a **signal** when someone has just changed in a way worth knowing about — a new company, a stealth position, a departure, a new patent, grant or paper. Three surfaces: pull signals it has already found, react to new ones, and keep the saved searches and curated lists the workspace works from.

### signals — pulling what Evertrace already found

\`\`\`
since = Date.addDays(@current_date, -30)
evertrace-[s:Signals WHERE s.Score >= 8 AND s.\`Discovered At\` >= since]->
\`\`\`

There is no default time window: an unbounded walk covers the whole corpus, so give the WHERE a \`Discovered At\` lower bound and a \`Score\` floor.

Evertrace takes part of the WHERE itself and the rest is applied to what comes back, so the result is the same either way — only the amount fetched changes. What reaches Evertrace: \`Name\` (a partial match), \`Score\` (a floor), \`Country\`, \`City\`, \`Region\`, \`Gender\`, \`Age\`, \`Tags\`, and \`Source\`. \`Discovered At\` narrows what comes back. \`Age\` is a bucket over there — "Below 25", "25 to 29", through "Above 49". \`Tags\` carries two vocabularies: what the person is ("YC Alumni", "Big Tech experience", "Banking experience") and which event raised the signal ("New Company", "Stealth Position", "Left Position", "New Patent", "New Grant", "New Paper"). A WHERE naming values from one of them reaches Evertrace; one mixing both is applied to what comes back.

Below a signal, \`Experiences\` and \`Educations\` are the rows of the person's profile, each resolving one hop further to the \`Company\` or \`School\` Evertrace matched it to, when it matched one.

### listening — being told about new ones

\`\`\`
listen to evertrace { search: "Stealth in Europe", pollIntervalSeconds: 600 } fire triage
\`\`\`

A listener fires once per signal created since the last look. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Signals\` when you want history. \`search\` names a saved search by its title or its id and narrows delivery to what that search matches; a date bound inside that search does not apply — the mark is what bounds delivery. \`pollIntervalSeconds\` overrides the five-minute default. A change to a signal that already exists does not fire — only a new one does. This is what a listener with no \`events\` delivers.

### listening — a signal added to a list

\`\`\`
listen to evertrace { events: ["list_entry"], list: "Pipeline" } fire file_it
\`\`\`

What arrives is the entry rather than the signal: \`Signal\` is the person, \`List\` is the list they went onto, and \`Added At\` is when. \`list\` names one list by its name or its id; leave it out and every list in the workspace delivers. The first look sets the mark and delivers nothing here too. Removing an entry and putting it back delivers again — that is a new entry.

### lists — filing a signal

A list owns its entries, so an entry lives under its list, and a signal's \`List Entries\` is that same membership seen from the other end. Both ends are required, so filing names them together:

\`\`\`
write (list-[:Entries]->, signal-[:\`List Entries\`]->) { }
\`\`\`

Adding is idempotent on the pair, so a repeat run never doubles a member. \`delete\` removes an entry. \`Lists\` and \`Searches\` are creatable, renameable and removable at the root; writing a search's \`Filters\` replaces the whole set rather than merging into it.

### lists — reading what is on one

\`\`\`
since = Date.addDays(@current_date, -7)
list-[e:Entries WHERE e.\`Added At\` >= since ORDER BY e.\`Added At\` DESC LIMIT 5]-> {
  …
}
\`\`\`

\`Added At\` is when the signal went onto the list, and it is the one thing Evertrace sorts entries by. Every other \`WHERE\` and \`ORDER BY\` runs over the list's entries once they arrive — the list is what bounds them, so a \`filter\` that calls \`ai\` over them is allowed here. A signal's \`List Entries\` reads the same memberships from the other end, and takes the same bracket.

Entries come back oldest first, so \`first\`, \`List.last\` and a bare \`LIMIT\` read them with no \`ORDER BY\`:

\`\`\`
oldest = first(list-[e:Entries]->)
Message: "Longest on the list: \${oldest-[s:Signal]->.Name}"
\`\`\`

A saved search's \`Signals\` takes the same bracket, and its own filters are what bound it — there is no order to lean on, so an \`ORDER BY\` says which one you mean.

### screening and viewing — facts about a signal

Marking a signal screened or viewed is a change to the signal itself, not a separate record:

\`\`\`
write signal { Screened: true }
\`\`\`

Evertrace has no un-view, so \`Viewed: false\` is refused; \`Screened: false\` does un-screen.

### what is deliberately not here

CSV exports, duplicating a saved search, screening and view counts, every signal sharing one LinkedIn profile, and the city lookup are each one endpoint away and not surfaced — say so rather than working around them.`;

/**
 * Static manifest. Polled source plus a real create/update/delete surface over
 * searches, lists and list memberships — so Evertrace is both a source and a
 * target. Nothing here is SUBSCRIBED to (there is no webhook): the event
 * vocabulary is the choice between the two things the poll can fetch, and the
 * `listen` options narrow each of them.
 */
export const EVERTRACE_MANIFEST: AdapterManifest = {
  adapterType: EVERTRACE_ADAPTER_TYPE,
  displayName: 'Evertrace',
  website: 'https://www.evertrace.ai',
  category: 'CRM',
  description:
    'Evertrace spots founders before they show up in startup databases — a ' +
    'signal is a person whose profile just triggered a trackable event. Pull ' +
    'signals, run on new ones, and file them into your saved searches and lists.',
  authoringHints:
    'Bound a Signals walk: there is no default lookback, so an unfiltered walk ' +
    'covers the whole corpus. A Score floor and a Discovered At lower bound are ' +
    'pushed to Evertrace; other filters are applied after the fetch. A list entry ' +
    'needs both its list and its signal, so write it along both edges at once. ' +
    'Screened and Viewed are fields on a signal, not separate records, and there ' +
    'is no un-view. A list’s Entries come back oldest first and take a WHERE, an ' +
    'ORDER BY and a LIMIT. A listener delivers new signals unless it says ' +
    'events: ["list_entry"], which delivers each signal added to a list.',
  handbookSection: {
    title: 'Evertrace — signals, saved searches and lists',
    content: EVERTRACE_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Two kinds, selected with `events`. `signal` (the default) fires once per ' +
    'signal Evertrace created since the last poll, narrowed by the `search` ' +
    'listen option (a saved search, by title or id). `list_entry` fires once ' +
    'per signal added to a list since the last poll, narrowed by the `list` ' +
    'listen option (by name or id; absent means every list in the workspace). ' +
    'Each kind keeps its own checkpoint, and the first poll of a kind sets it ' +
    'and emits nothing, so going live never replays the back catalogue. ' +
    'Updates to an existing signal do NOT fire — Evertrace offers no ' +
    'changed-since mark other than creation.',
  supportedTriggers: ['poll'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated',
    'readRecord', 'createRecord', 'updateRecord', 'deleteRecord',
  ],
  requiredCredentialType: ExternalServiceType.EVERTRACE,
  // `events` is projected from `subscribableEvents` — Evertrace has no webhook
  // to subscribe to, but the selection is what tells the one poll source which
  // of its two event edges a listen is on, and what types the listened
  // parameter. No selection is the signal alone.
  subscribableEvents: [...EVERTRACE_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [EVERTRACE_SIGNAL_EVENT],
  listenConfig: [
    { key: 'search', required: false },
    { key: 'list', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['EVERTRACE'],
  vocabulary: {
    // A stroke "E" — the mark opens with a moveto, as path data must.
    icon: {
      d: 'M8 5 H17 M8 5 V19 M8 12 H15 M8 19 H17',
      fill: false,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      [EVERTRACE_LIST_ENTRY_EVENT]: [
        { template: 'When a signal is added to the list `{list}`' },
        { template: 'When a signal is added to a list' },
      ],
      default: [{ template: 'When Evertrace finds a new signal' }],
    },
  },
};

/** Display name → this adapter's internal typeId, for the reads that need to
 *  know WHICH type a position carries (the computed-field table below). */
const TYPE_ID_BY_DISPLAY_NAME: Record<string, string> = {
  [EVERTRACE_SIGNAL_DISPLAY_NAME]: EVERTRACE_SIGNAL_TYPE_ID,
  [EVERTRACE_EXPERIENCE_DISPLAY_NAME]: EVERTRACE_EXPERIENCE_TYPE_ID,
  [EVERTRACE_EDUCATION_DISPLAY_NAME]: EVERTRACE_EDUCATION_TYPE_ID,
  [EVERTRACE_COMPANY_DISPLAY_NAME]: EVERTRACE_COMPANY_TYPE_ID,
  [EVERTRACE_SCHOOL_DISPLAY_NAME]: EVERTRACE_SCHOOL_TYPE_ID,
  [EVERTRACE_SEARCH_DISPLAY_NAME]: EVERTRACE_SEARCH_TYPE_ID,
  [EVERTRACE_LIST_DISPLAY_NAME]: EVERTRACE_LIST_TYPE_ID,
  [EVERTRACE_LIST_ENTRY_DISPLAY_NAME]: EVERTRACE_LIST_ENTRY_TYPE_ID,
};

/** Fields whose stored value is epoch MILLISECONDS but whose declared kind is
 *  `date` — read back as an ISO instant so comparisons and formatting behave
 *  like every other adapter's dates. */
const EPOCH_MS_FIELDS: Record<string, ReadonlySet<string>> = {
  [EVERTRACE_SIGNAL_TYPE_ID]: new Set(['discoveredAt', 'createdAt']),
  [EVERTRACE_SEARCH_TYPE_ID]: new Set(['createdAt', 'updatedAt', 'visitedAt']),
  [EVERTRACE_LIST_TYPE_ID]: new Set(['createdAt', 'updatedAt']),
  [EVERTRACE_LIST_ENTRY_TYPE_ID]: new Set(['createdAt']),
};

function isoOf(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

/** The fields Evertrace does not carry literally — a name spelled across two
 *  columns, tags buried in their rows, and the two membership booleans. */
function computedSignalField(fieldId: string, signal: EvertraceSignal): unknown | undefined {
  switch (fieldId) {
    case 'fullName':
      return [signal.firstName, signal.lastName].filter(Boolean).join(' ');
    case 'regionName':
      return signal.region?.name ?? null;
    case 'tags':
      return (signal.taggings ?? []).map((tagging) => tagging.key);
    case 'screened':
      return (signal.screenings ?? []).length > 0;
    case 'viewed':
      return (signal.views ?? []).length > 0;
    default:
      return undefined;
  }
}

export class EvertraceAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = EVERTRACE_ADAPTER_TYPE;
  readonly supportedTriggers = EVERTRACE_MANIFEST.supportedTriggers;

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
    /** Injectable for tests; production resolves a credentialed client from
     *  `teamId` + `credentialsId` (the same path the poll source rides). */
    private readonly clientOverride?: EvertraceApiClient,
  ) {
    super();
  }

  private async client(): Promise<EvertraceApiClient> {
    const client =
      this.clientOverride ??
      (await resolveEvertraceClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `EvertraceAdapter: no usable Evertrace credential for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Evertrace.`,
      );
    }
    return client;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return evertraceEntryPoints();
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === EVERTRACE_WORKSPACE_TYPE_ID) {
      return EVERTRACE_WORKSPACE_DESCRIPTOR;
    }
    return describeEvertraceType(await this.resolveTypeRef(typeRef));
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      at: position,
      root: EVERTRACE_ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  // ── 2. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== EVERTRACE_ADAPTER_TYPE) {
      throw new Error(
        `EvertraceAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const typeId = TYPE_ID_BY_DISPLAY_NAME[input.position.recordType ?? ''] ?? '';

    if (typeId === EVERTRACE_SIGNAL_TYPE_ID) {
      const computed = computedSignalField(fieldId, data as unknown as EvertraceSignal);
      if (computed !== undefined) return computed;
    }
    if (EPOCH_MS_FIELDS[typeId]?.has(fieldId)) return isoOf(data[fieldId]);
    return data[fieldId] ?? null;
  }

  // ── 3. Traversal ───────────────────────────────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== EVERTRACE_ADAPTER_TYPE) {
      throw new Error(
        `EvertraceAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The root's collection names cross VERBATIM (a meta position carries no
    // type to resolve an edge against), so match them before the per-type edge
    // resolver, which would drift on the typeless meta position.
    if (input.position.recordType === META_RECORD_TYPE) {
      return this.rootCollection(input);
    }

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;

    switch (edgeId) {
      case EVERTRACE_EXPERIENCES_EDGE: {
        const signal = data as unknown as EvertraceSignal;
        return [...(signal.experiences ?? [])]
          .sort((a, b) => a.indexOrder - b.indexOrder)
          .map((experience) => experiencePosition(experience));
      }
      case EVERTRACE_EDUCATIONS_EDGE: {
        const signal = data as unknown as EvertraceSignal;
        return [...(signal.educations ?? [])]
          .sort((a, b) => a.indexOrder - b.indexOrder)
          .map((education) => educationPosition(education));
      }
      case EVERTRACE_SIGNAL_LIST_ENTRIES_EDGE: {
        const signalId = typeof data['id'] === 'string' ? data['id'] : undefined;
        if (signalId === undefined) return [];
        const client = await this.client();
        const entries = await client.listSignalEntries(signalId);
        // `GET /signals/{id}/entries` promises no order, so the adapter puts one
        // on it — that ORDER is what the edge's `chronological` declares, and it
        // has to hold BEFORE a LIMIT slices.
        const direction = entrySortOrder(input.orderBy);
        const ordered = [...entries].sort((a, b) =>
          direction === 'desc' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt,
        );
        // An ORDER BY on anything but `Added At` is the engine's to run, and the
        // LIMIT goes with it (see `limitWithoutOrder`).
        const cap = pushableEntryOrder(input.orderBy) ? input.limit : undefined;
        return bounded(ordered, cap).map((entry) => listEntryPosition(entry));
      }
      case EVERTRACE_EXPERIENCE_COMPANY_EDGE: {
        const entity = (data as unknown as EvertraceExperience).entity;
        return entity ? [companyPosition(entity)] : [];
      }
      case EVERTRACE_EDUCATION_SCHOOL_EDGE: {
        const entity = (data as unknown as EvertraceEducationEntry).entity;
        return entity ? [schoolPosition(entity)] : [];
      }
      case EVERTRACE_SEARCH_SIGNALS_EDGE: {
        const searchId = typeof data['id'] === 'string' ? data['id'] : undefined;
        if (searchId === undefined) return [];
        const client = await this.client();
        // `GET /searches/{id}/signals` takes no sort, so an ORDER BY costs the
        // full fetch — and takes the LIMIT with it.
        const signals = await pageThrough(
          (page, limit) => client.listSearchSignals(searchId, { page, limit }),
          limitWithoutOrder(input),
        );
        return signals.map((signal) => signalPosition(signal));
      }
      case EVERTRACE_LIST_ENTRIES_EDGE: {
        const listId = typeof data['id'] === 'string' ? data['id'] : undefined;
        if (listId === undefined) return [];
        const client = await this.client();
        // The sort is ALWAYS asked for: an unsorted fetch would page in whatever
        // order Evertrace happened to pick, and the edge promises creation
        // order. `ORDER BY \`Added At\` DESC` flips the direction at the source,
        // so "the newest five" is one page rather than the whole list.
        const sortOrder = entrySortOrder(input.orderBy);
        const entries = await pageThrough(
          (page, limit) =>
            client.listListEntries(listId, {
              page,
              limit,
              sortBy: 'entry_created_at',
              sortOrder,
            }),
          // The LIMIT rides along only when the sort above IS the hop's order;
          // an ORDER BY on some other field leaves both to the engine.
          pushableEntryOrder(input.orderBy) ? input.limit : undefined,
        );
        return entries.map((entry) => listEntryPosition(entry));
      }
      case EVERTRACE_ENTRY_SIGNAL_EDGE: {
        const entry = data as unknown as EvertraceListEntry;
        if (entry.signal) return [signalPosition(entry.signal)];
        if (typeof entry.signalId !== 'string') return [];
        const client = await this.client();
        return [signalPosition(await client.getSignal(entry.signalId))];
      }
      case EVERTRACE_ENTRY_LIST_EDGE: {
        const entry = data as unknown as EvertraceListEntry;
        if (typeof entry.listId !== 'string') return [];
        const client = await this.client();
        return [listPosition(await client.getList(entry.listId))];
      }
      default:
        return [];
    }
  }

  /** The meta root's collections. Each pushes what Evertrace's own query takes
   *  and leaves the rest of the WHERE to the engine, so results are exact
   *  regardless of how much was pushed. None of these endpoints sorts, so an
   *  ORDER BY on a root collection means the engine orders — and the hop's
   *  LIMIT stays with it (`limitWithoutOrder`). */
  private async rootCollection(input: GetRelatedInput): Promise<RelatedResult[]> {
    const client = await this.client();
    const where: Expression | undefined = input.where;
    const cap = limitWithoutOrder(input);

    switch (input.fieldId) {
      case EVERTRACE_SIGNALS_COLLECTION: {
        const filter = signalFilterFromWhere(where);
        const signals = await pageThrough(
          (page, limit) => client.listSignals({ filter, page, limit }),
          cap,
        );
        return signals.map((signal) => signalPosition(signal));
      }
      case EVERTRACE_SEARCHES_COLLECTION: {
        // `GET /searches` is unpaged — the whole set comes back and the hop's
        // LIMIT slices it here.
        const searches = await client.listSearches();
        return bounded(searches, cap).map((search) => searchPosition(search));
      }
      case EVERTRACE_LISTS_COLLECTION: {
        const lists = await client.listLists();
        return bounded(lists, cap).map((list) => listPosition(list));
      }
      case EVERTRACE_COMPANIES_COLLECTION: {
        const search = lookupSearchTerm(where);
        const companies = await pageThrough(
          (page, limit) =>
            client.listCompanies({ page, limit, ...(search !== undefined ? { search } : {}) }),
          cap,
        );
        return companies.map((company) => companyPosition(company));
      }
      case EVERTRACE_SCHOOLS_COLLECTION: {
        const search = lookupSearchTerm(where);
        const schools = await pageThrough(
          (page, limit) =>
            client.listEducations({ page, limit, ...(search !== undefined ? { search } : {}) }),
          cap,
        );
        return schools.map((school) => schoolPosition(school));
      }
      default:
        return [];
    }
  }

  // ── 4. Writes ──────────────────────────────────────────────────────────

  /** Re-key a write body from the author's NATURAL field names to this
   *  adapter's internal ids — the per-method first-line translation the
   *  interface requires. */
  private async translateWrite<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      fields[resolver.tryFieldId(type, naturalName(key)) ?? key] = value;
    }
    return { ...input, fields };
  }

  private async requireWritableType(
    recordType: string,
    method: string,
  ): Promise<EvertraceWritableTypeId> {
    const typeId = writableTypeId(await this.resolveTypeRef(recordType));
    if (typeId === undefined) {
      throw new Error(`EvertraceAdapter.${method}: "${recordType}" has no write surface.`);
    }
    return typeId;
  }

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const typeId = await this.requireWritableType(rawInput.recordType, 'createRecord');
    const write = await this.translateWrite(rawInput);
    const client = await this.client();
    return createEvertraceRecord({ client, typeId, write });
  }

  async updateRecord(rawInput: UpdateInput): Promise<UpdateResult> {
    const typeId = await this.requireWritableType(rawInput.recordType, 'updateRecord');
    const update = await this.translateWrite(rawInput);
    const client = await this.client();
    return updateEvertraceRecord({ client, typeId, update });
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    const typeId = await this.requireWritableType(input.recordType, 'deleteRecord');
    const client = await this.client();
    return deleteEvertraceRecord({ client, typeId, del: input });
  }

  // ── 5. Read-back by id (no-op detection, bind self-heal) ───────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    const typeId = await this.resolveTypeRef(input.recordType);
    const client = await this.client();
    try {
      switch (typeId) {
        case EVERTRACE_SIGNAL_TYPE_ID:
          return toRecord(await client.getSignal(input.externalId));
        case EVERTRACE_SEARCH_TYPE_ID:
          return toRecord(await client.getSearch(input.externalId));
        case EVERTRACE_LIST_TYPE_ID:
          return toRecord(await client.getList(input.externalId));
        case EVERTRACE_LIST_ENTRY_TYPE_ID: {
          const decoded = decodeListEntryId(input.externalId);
          if (decoded === undefined) return null;
          return toRecord(await client.getListEntry(decoded.listId, decoded.entryId));
        }
        default:
          // Experiences, educations and the lookup entities have no fetch-by-id
          // behind them — nothing to read back.
          return null;
      }
    } catch (error) {
      if (error instanceof EvertraceApiError && error.status === 404) return null;
      throw error;
    }
  }

  // ── 6. Event typing ────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // The PollSource tags every event it produces, so discrimination is by tag
    // alone — a signal and a list addition are told apart by which edge the
    // listen is on, never by sniffing the payload.
    return [
      {
        tag: EVERTRACE_SIGNAL_EVENT_TAG,
        positionType: EVERTRACE_SIGNAL_TYPE_ID,
        match: { path: 'id', equals: [] },
      },
      {
        tag: EVERTRACE_LIST_ENTRY_EVENT_TAG,
        positionType: EVERTRACE_LIST_ENTRY_TYPE_ID,
        match: { path: 'id', equals: [] },
      },
    ];
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createEvertraceAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): EvertraceAdapter {
  return new EvertraceAdapter(input.teamId, input.credentialsId);
}

// ── Position minting ────────────────────────────────────────────────────────
// Signals, searches, lists and list entries are STABLE: each has a durable id
// and an endpoint that re-fetches it. Experiences and educations are not —
// they exist only inside their signal, so they carry their content inline.

function signalPosition(signal: EvertraceSignal): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_SIGNAL_DISPLAY_NAME,
      recordId: signal.id,
      data: signal,
    }),
  };
}

function searchPosition(search: EvertraceSearch): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_SEARCH_DISPLAY_NAME,
      recordId: search.id,
      data: search,
    }),
  };
}

function listPosition(list: EvertraceList): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_LIST_DISPLAY_NAME,
      recordId: list.id,
      data: list,
    }),
  };
}

function listEntryPosition(entry: EvertraceListEntry): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_LIST_ENTRY_DISPLAY_NAME,
      recordId: encodeListEntryId({ listId: entry.listId, entryId: entry.id }),
      data: entry,
    }),
  };
}

function companyPosition(company: EvertraceCompanyEntity): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_COMPANY_DISPLAY_NAME,
      recordId: company.id,
      data: company,
    }),
  };
}

function schoolPosition(school: EvertraceEducationEntity): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_SCHOOL_DISPLAY_NAME,
      recordId: school.id,
      data: school,
    }),
  };
}

function experiencePosition(experience: EvertraceExperience): RelatedResult {
  return {
    position: makeUnstablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_EXPERIENCE_DISPLAY_NAME,
      data: experience,
    }),
  };
}

function educationPosition(education: EvertraceEducationEntry): RelatedResult {
  return {
    position: makeUnstablePosition({
      adapterType: EVERTRACE_ADAPTER_TYPE,
      recordType: EVERTRACE_EDUCATION_DISPLAY_NAME,
      data: education,
    }),
  };
}

// ── Entry ordering ──────────────────────────────────────────────────────────

/** The names an author can spell a list entry's `Added At` — the one field
 *  Evertrace itself sorts entries by (`sort_by=entry_created_at`). */
const ENTRY_ADDED_AT_NAMES = new Set(['createdAt', 'Added At']);

/** True when the hop's ORDER BY is the one Evertrace sorts entries by, so the
 *  direction can travel with the fetch. */
function pushableEntryOrder(orderBy: GetRelatedInput['orderBy']): boolean {
  return orderBy === undefined || ENTRY_ADDED_AT_NAMES.has(orderBy.fieldId);
}

/**
 * Which way round the entries come back. An `ORDER BY` on `Added At` travels;
 * anything else leaves the fetch in creation order and the engine sorts what
 * came back.
 */
function entrySortOrder(orderBy: GetRelatedInput['orderBy']): 'asc' | 'desc' {
  return orderBy !== undefined && ENTRY_ADDED_AT_NAMES.has(orderBy.fieldId)
    ? orderBy.direction
    : 'asc';
}

/**
 * The LIMIT this fetch may take, per the contract on `GetRelatedInput.limit`:
 * a limit only travels alongside the sort it came with. A fetch that cannot
 * push the hop's ORDER BY returns the whole matching set and lets the engine
 * sort and slice it — n arbitrary rows sorted afterwards would answer a
 * different question.
 */
function limitWithoutOrder(input: GetRelatedInput): number | undefined {
  return input.orderBy === undefined ? input.limit : undefined;
}

// ── Paging ──────────────────────────────────────────────────────────────────

function bounded<T>(rows: T[], limit: number | undefined): T[] {
  return limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
}

/**
 * Walk a paged Evertrace endpoint. The envelope carries no total and no
 * `hasMore`, so a SHORT page is the end — that is the whole stopping rule. A
 * hop's LIMIT stops it earlier; without one the walk covers the collection,
 * which is what an unbounded query asks for.
 */
async function pageThrough<T>(
  fetchPage: (page: number, limit: number) => Promise<{ data: T[] }>,
  limit: number | undefined,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const size =
      limit !== undefined ? Math.min(PAGE_SIZE, Math.max(limit - rows.length, 0)) : PAGE_SIZE;
    if (size === 0) break;
    const { data } = await fetchPage(page, size);
    rows.push(...data);
    if (data.length < size) break;
  }
  return bounded(rows, limit);
}

/** A wire object as the flat bag `readRecord` returns. */
function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}
