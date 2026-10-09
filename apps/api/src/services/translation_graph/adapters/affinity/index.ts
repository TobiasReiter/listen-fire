// Affinity TG adapter — implements the translation-graph `Adapter` contract
// for Affinity as a write target plus the reads that support it. Affinity has a
// v3 OUTPUT only (no v3 input), so parity = the target side: organization,
// person, list-entry, note, and file writes, with org/person reads + identity
// resolution. Source side (2026-07-05): Affinity pushes full-entity webhook
// deliveries; `preprocessInbound` maps them to record events (see inbound.ts)
// and `ensureEventSubscription` auto-registers the webhook on listen.
//
// Lazy-loads team credentials from external_service_credentials, constructs the
// Affinity API client + operations wrapper on first use, and redirects to
// fake-channels for the dev-loop test-harness team (mirrors Attio / Airtable).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { ExternalServiceCredentialsId } from '../../../../generated/kysely/automations/ExternalServiceCredentials';
import type {
  Adapter,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  GetFieldValueInput,
  GetRelatedInput,
  LinkRecordsInput,
  LinkRecordsResult,
  ParentLink,
  RelatedResult,
  ReadInput,
  ResolveEntityInput,
  ResolveEntityResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';
import type { TriggerType } from '../../triggers/types';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import type { Expression } from '#shared/expression/types';

import { decryptToken } from '../../../../lib/credentials';
import { getAutomationsQb } from '../../../../lib/kysely';
import { isTestHarnessTeam, injectFakeBaseUrl } from '../../../../lib/recording';
import { logger } from '../../../logger';
import { isAdapterCallCeilingExceeded } from '../../segment_scope';
import {
  AffinityAPIClient,
  getAffinityClient,
  INTERACTION_TYPE,
} from '../../../../adapters/affinity/apiClient';
import { AffinityOperations } from '../../../../adapters/affinity/operations';
import { AFFINITY_HANDBOOK_SECTION } from './handbook_section';
import { AFFINITY_SUBSCRIBABLE_EVENTS, parseAffinityEvents } from './inbound';
import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import { singleParentLink } from '../../adapter';
import {
  META_RECORD_TYPE,
  isStablePosition,
  makeStablePosition,
  positionData,
  positionRecordId,
} from '../../types';
import { BaseAdapter } from '../base';
import { targetStubs, typeAddressedPositions } from '../hop';
import { naturalName } from '../name_resolution';
import {
  AFFINITY_ADAPTER_TYPE,
  AFFINITY_ENTITY_TYPE,
  affinityAdapterCredsParser,
  decodedFixedType,
  ENTITY_DISPLAY_NAMES,
  listCatalogType,
  listEntityKind,
  listNameFromPerListType,
  perListTypeName,
  LIST_ENTRY_COLLECTION_DISPLAY_NAMES,
  type AffinityFieldMeta,
  type DecodedTypeId,
  type ListEntityKind,
} from './types';
import {
  attachPersonToOrganisation,
  detachPersonFromOrganisation,
} from '../../../../adapters/affinity/employer_association';
import {
  listEntryPoints as catalogListEntryPoints,
  describe as catalogDescribe,
  cachedFields,
  invalidateFieldCache,
  loadPerListTypes,
  AFFINITY_LIST_ENTRIES_EDGE,
  AFFINITY_LIST_NAME_FIELD,
  AFFINITY_ORGANIZATIONS_EDGE,
  AFFINITY_PEOPLE_EDGE,
  AFFINITY_EMPLOYER_EDGE_IDS,
} from './schema_catalog';

import { flattenAndConjuncts } from '#shared/expression/filter';


/** Whether an edge name is one of the two the built-in person↔organization
 *  association is published under — the display name from either side, or the
 *  internal id an older saved program may have spelled it by. Compared against
 *  the catalog's own constants; nothing here parses a name. */
function isEmployerEdge(edgeName: string): boolean {
  return (
    edgeName === AFFINITY_PEOPLE_EDGE ||
    edgeName === AFFINITY_ORGANIZATIONS_EDGE ||
    (AFFINITY_EMPLOYER_EDGE_IDS as readonly string[]).includes(edgeName)
  );
}
import { resolveEntity as doResolveEntity } from './resolve';
import { UPDATE_NOT_FOUND } from '../not_found';
import {
  assertCustomReference,
  canonicalFileData,
  canonicalInteractionData,
  canonicalNoteData,
  canonicalOpportunityData,
  canonicalOrgData,
  canonicalPersonData,
  canonicalRelationshipStrengthData,
  canonicalReminderData,
  makeWebBaseUrlResolver,
  readCustomFieldValues,
  referenceFieldOn,
  severCustomReference,
  type AffinityCustomFieldScope,
  type AffinityReferenceHolder,
  type ReferenceHolderResolver,
  type AffinityCustomFieldValue,
  type WebUrlSource,
  organisationMatchContext,
} from './shared';
import {
  createOrganization,
  updateOrganization,
  readOrganization,
} from './organization';
import { createPerson, updatePerson, readPerson } from './person';
import { createListEntry, updateListEntry, type ListEntryLocation } from './list_entry';
import { createNote, createFile } from './note_file';

export { AFFINITY_ADAPTER_TYPE } from './types';

/**
 * Static manifest. Target-only on the write side plus inbound webhooks; a real
 * `createRecord`/`updateRecord` makes it writable, and Affinity v1 has
 * first-class deletes (org/person/list-entry/note) so `deleteRecord` is real
 * too — `delete <handle>` works against Affinity records.
 *
 */
export const AFFINITY_MANIFEST: AdapterManifest = {
  adapterType: AFFINITY_ADAPTER_TYPE,
  displayName: 'Affinity',
  website: 'https://www.affinity.co',
  category: 'CRM',
  description:
    'The Affinity CRM. Read organizations, people, opportunities, and lists — ' +
    'plus the history on each record (notes, files, reminders, interactions, ' +
    'relationship strengths) — and create or update records from your movements.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'getRelated',
    'createRecord', 'updateRecord', 'deleteRecord', 'readRecord',
    'linkRecords', 'unlinkRecords',
    'preprocessInbound', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  handbookSection: AFFINITY_HANDBOOK_SECTION,
  requiredCredentialType: ExternalServiceType.AFFINITY,
  triggerKinds: ['AFFINITY'],
  introspectedSchema: true,
  // The `listen to <affinity> { events: [...] }` vocabulary — folded into the
  // POST /webhooks registration. Affinity allows at most THREE webhook
  // subscriptions per instance, so all of a credential's listens share ONE
  // registration (the default adapter+credential channel — no scope keys).
  subscribableEvents: [...AFFINITY_SUBSCRIBABLE_EVENTS],
  triggerExpectation:
    'Listen-Fire registers the Affinity webhook automatically when a listener goes ' +
    'live (Affinity allows at most 3 webhook subscriptions per instance — ' +
    'Listen-Fire uses one). Events arrive per change: organization/person/' +
    'opportunity/list entry/note/reminder created/updated/deleted and ' +
    'field-value changes — a field_value event surfaces as an UPDATE of the ' +
    'record it sits on (the list entry for deal-stage moves). Do not promise ' +
    'file or list-metadata triggers — those events are not mapped. ' +
    'Field-level precision comes from filtering on the event payload ' +
    '(field_id/value), not from the subscription.',
  vocabulary: {
    icon: {
      d: "M36.2425 20.7692C36.2418 21.1012 36.2 21.4318 36.118 21.7535L38.1678 23.8166C42.1219 27.8365 42.0939 34.2895 38.1051 38.2749C34.1162 42.2603 27.6577 42.2883 23.6345 38.3376L21.6018 36.3067C20.9344 36.4836 20.2323 36.4836 19.5649 36.3067L17.5451 38.3269C13.5318 42.3373 7.02457 42.3378 3.01071 38.3279C-1.00315 34.3181-1.00363 27.8163 3.00964 23.8059L5.28054 21.5348C5.17894 21.0251 5.17894 20.5004 5.28054 19.9907L3.01178 17.7217C0.415654 15.1274-0.598046 11.3463 0.352536 7.80279C1.30312 4.25924 4.07356 1.49156 7.62028 0.542315C11.167-0.406933 14.9511 0.606461 17.5473 3.20076L19.3266 4.97862C20.1441 4.71219 21.0259 4.71745 21.8401 4.99363L23.6366 3.19862C27.6599-0.752113 34.1184-0.724137 38.1072 3.2613C42.0961 7.24674 42.1241 13.6997 38.17 17.7196L36.1137 19.7741C36.1991 20.0989 36.2424 20.4333 36.2425 20.7692ZM26.4135 5.98842L24.4818 7.91854C24.5467 8.2057 24.5798 8.49913 24.5805 8.79353C24.5808 9.21316 24.5141 9.63014 24.383 10.0288L31.2472 16.8807C31.5683 16.7978 31.8987 16.756 32.2303 16.7564C32.6258 16.7559 33.0193 16.8137 33.3979 16.9279L35.3791 14.9463C37.7845 12.461 37.7514 8.50761 35.3046 6.06287C32.8577 3.61814 28.901 3.58501 26.4135 5.98842ZM24.4521 31.4274L31.2283 24.6548C31.9434 24.8416 32.6966 24.8245 33.4026 24.6055L35.3859 26.5871C37.7913 29.0725 37.7582 33.0258 35.3113 35.4706C32.8645 37.9153 28.9078 37.9484 26.4203 35.545L24.4199 33.5441C24.5261 33.1789 24.5803 32.8006 24.5808 32.4204C24.5809 32.0852 24.5376 31.7515 24.4521 31.4274ZM21.7277 28.5837L28.3816 21.9355L28.3837 21.9398C28.1505 21.1766 28.1505 20.3612 28.3837 19.598L21.483 12.7031C20.893 12.845 20.2781 12.8487 19.6864 12.7138L12.9961 19.3942C13.3195 20.28 13.3195 21.2514 12.9961 22.1371L19.4353 28.5709C20.1844 28.3522 20.9811 28.3566 21.7277 28.5837ZM16.7583 10.0723L16.7551 10.0755C16.5154 9.3679 16.4808 8.60699 16.6553 7.88053L14.76 5.98686C12.2725 3.58345 8.31578 3.61658 5.86896 6.06132C3.42214 8.50605 3.38898 12.4594 5.79444 14.9448L7.85714 17.0036C8.54324 16.7504 9.2859 16.691 10.0036 16.832L16.7551 10.0755L16.7562 10.0787L16.7583 10.0723ZM10.0035 24.7069C9.2862 24.8478 8.54394 24.7899 7.85714 24.5396L5.79444 26.5877C3.38898 29.0731 3.42214 33.0264 5.86896 35.4711C8.31578 37.9159 12.2725 37.949 14.76 35.5456L16.7175 33.5876C16.6031 33.2093 16.5452 32.8162 16.5458 32.4209C16.5455 32.0704 16.5917 31.7214 16.6832 31.383L10.0035 24.7069Z",
      fill: true,
      viewBox: "0 0 42 42",
    },
    eventPhrase: {
      // No per-event phrasing today (organization/person/opportunity/list
      // entry/note/reminder create/update/delete all shared one generic
      // sentence in the former switch) — `default` mirrors that.
      default: [{ template: 'When a record changes in Affinity' }],
    },
  },
};

/**
 * The fields Affinity's `term` search actually matches, by fieldId — the
 * currency the name resolver hands back.
 *
 * `term` is Affinity's ONE narrowing verb on a workspace read: a single
 * substring, matched against an organization's name and domain, or a person's
 * first name, last name and email addresses. That match returns a SUPERSET of
 * an equality on any of those fields, which is the only direction a pushdown
 * may err — the engine filters what comes back, but nothing recovers records
 * we never fetched.
 *
 * Deliberately absent: `Domains` and `Emails` (equality against a multi-valued
 * field is a different question, and pushing it would guess at which one), and
 * a person's `Full name` — Affinity documents `term` as an email address, a
 * first name or a last name, so a two-word full name may match nobody, and
 * under-fetching is the one failure this must not have.
 */
const ORGANIZATION_TERM_FIELD_IDS: ReadonlySet<string> = new Set(['name', 'domain']);
const PERSON_TERM_FIELD_IDS: ReadonlySet<string> = new Set(['firstName', 'lastName', 'email']);


export class AffinityAdapter extends BaseAdapter {
  readonly adapterType = AFFINITY_ADAPTER_TYPE;
  /** Lists hold their own per-list field surface, fetched list by list.
   *  So a full-surface describe is refused and the author walks in instead. */
  readonly walksContainers = true;

  readonly supportedTriggers = AFFINITY_MANIFEST.supportedTriggers;

  /** No synthetic event positions — unstable positions never resolve here. */
  readonly webhookEventTypeId = undefined;

  private apiClient: AffinityAPIClient | null = null;
  private operations: AffinityOperations | null = null;
  private web: WebUrlSource | null = null;
  private readonly teamId: TeamId;
  private readonly credentialsId: string;

  constructor(input: { teamId: TeamId; credentialsId: string }) {
    super();
    this.teamId = input.teamId;
    this.credentialsId = input.credentialsId;
  }

  // ── Inbound (source side) ────────────────────────────────────────────────

  /** THE raw→events seam: pure mapping of Affinity's `{type, body, sent_at}`
   *  deliveries (see ./inbound.ts) — no pull needed, Affinity pushes the
   *  full entity and field_value bodies carry their parent identifiers. */
  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: import('../../adapter').DiscriminableEvent[] }> {
    // `parseAffinityEvents` is the PURE map (no credential); it types list-entry
    // events as the generic `List Entry`. But the generic publishes no parent
    // up-hop (layer 11 — a polymorphic type's surface is the intersection of its
    // members), so an event must arrive already NARROWED to its per-list type,
    // which carries the one parent up-hop the list's kind implies. The event
    // knows its list, so we narrow here at the source (credentialed) rather than
    // offering a traverse-then-narrow path — one correct way, and cheaper.
    const parsed = parseAffinityEvents(input.raw);
    const events = await Promise.all(parsed.map((e) => this.narrowListEntryEvent(e)));
    return { events };
  }

  /** Re-type a generic `List Entry` event to its per-list type (`List Entry —
   *  <list>`), so its landed position publishes the one correct parent up-hop.
   *  Non-list-entry events pass through untouched. */
  private async narrowListEntryEvent(
    event: import('../../adapter').DiscriminableEvent,
  ): Promise<import('../../adapter').DiscriminableEvent> {
    if (event.recordType !== ENTITY_DISPLAY_NAMES['list-entry']) return event;
    const listId = await this.listIdForEvent(event);
    if (listId == null) return event;
    const perListName = (await this.perListNamesByListId()).get(listId);
    return perListName ? { ...event, recordType: perListName } : event;
  }

  /** The list a `List Entry` event belongs to. `list_entry.*` bodies carry
   *  `list_id` directly; `field_value.*` bodies carry `field_id` + `entity_type`
   *  but no `list_id`, so we resolve it through the (warm) field catalog —
   *  fields are list-scoped. Returns null when the list can't be determined
   *  (e.g. an opportunity-list field value, or an uncatalogued list). */
  private async listIdForEvent(
    event: import('../../adapter').DiscriminableEvent,
  ): Promise<number | null> {
    const body = (event.payload ?? {}) as Record<string, unknown>;
    if (typeof body.list_id === 'number') return body.list_id;

    const fieldId = body.field_id;
    if (typeof fieldId !== 'number') return null;
    const catalogType =
      body.entity_type === AFFINITY_ENTITY_TYPE.ORGANIZATION
        ? 'ORGANIZATION'
        : body.entity_type === AFFINITY_ENTITY_TYPE.PERSON
          ? 'PERSON'
          : null;
    if (!catalogType) return null;
    const fields = await cachedFields({
      client: await this.getApiClient(),
      type: catalogType,
    });
    return fields.find((f) => f.id === fieldId)?.list_id ?? null;
  }

  /** Register (or diff-sync) the credential's ONE webhook subscription via
   *  POST /webhooks — Affinity caps subscriptions at 3 per instance, so every
   *  listen on this credential shares this registration. No secret comes
   *  back: Affinity's HMAC key is account-level (the profile API tab), not
   *  issued per subscription. */
  async ensureEventSubscription(
    input: import('../../adapter').EnsureEventSubscriptionInput,
  ): Promise<import('../../adapter').EventSubscriptionRegistration | undefined> {
    const client = await this.getApiClient();
    if (input.current?.externalId !== undefined) {
      const unchanged =
        input.current.events.length === input.events.length &&
        input.current.events.every((e) => input.events.includes(e));
      if (unchanged) return undefined;
      await client.updateWebhookSubscription({
        id: input.current.externalId,
        subscriptions: input.events,
      });
      return { externalId: input.current.externalId };
    }
    const created = await client.createWebhookSubscription({
      webhookUrl: input.callbackUrl,
      subscriptions: input.events,
    });
    return { externalId: String(created.id) };
  }

  async removeEventSubscription(
    input: import('../../adapter').RemoveEventSubscriptionInput,
  ): Promise<void> {
    if (input.externalId === undefined) return;
    const client = await this.getApiClient();
    await client.deleteWebhookSubscription(input.externalId);
  }

  // ── Name → structured-identifier cache ───────────────────────────────────
  // The framework names a type only by its pretty `displayName` — that IS the
  // `recordType` every position carries and the `typeId` `listEntryPoints` /
  // `describe` publish. The adapter's read/write/traverse logic routes on the
  // `DecodedTypeId` (`{ entity, listId? }`). These helpers are the PRIVATE map
  // between the two: the five FIXED entity types resolve PURELY (their names are
  // compile-time constants) before the introspected per-list cache, which is
  // memoized per instance from the same list catalog `listEntryPoints` reads.
  // Every method recovers its structured id from the recordType NAME here, on
  // its first line — never by parsing an `affinity:<entity>` magic string.

  private perListCache?: Promise<Map<string, DecodedTypeId>>;

  private perListTypes(): Promise<Map<string, DecodedTypeId>> {
    if (this.perListCache === undefined) {
      this.perListCache = (async () => {
        const client = await this.getApiClient();
        return loadPerListTypes({ client, teamId: this.teamId });
      })();
      // A failed introspection mustn't poison the instance — drop the cache so
      // the next call retries (mirrors the resolver's eviction policy).
      this.perListCache.catch(() => {
        this.perListCache = undefined;
      });
    }
    return this.perListCache;
  }

  /** Resolve a type's pretty NAME to its structured id, or undefined when the
   *  name isn't a known type (the caller decides graceful-empty vs hard error).
   *  Fixed entities resolve purely; a `List Entry — <list>` name resolves via
   *  the introspected per-list cache. */
  private async structuredIdFor(name: string): Promise<DecodedTypeId | undefined> {
    const fixed = decodedFixedType(name);
    if (fixed) return fixed;
    return (await this.perListTypes()).get(name);
  }

  /** The write variant: a name that doesn't resolve is a hard error (the
   *  movement targets a type this connection can't see — drift). */
  private async requireStructuredId(name: string, method: string): Promise<DecodedTypeId> {
    const decoded = await this.structuredIdFor(name);
    if (!decoded) {
      throw new Error(`AffinityAdapter.${method}: unrecognised recordType "${name}".`);
    }
    return decoded;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  /** Forget the workspace's shape — the client's field catalog, lists and
   *  whoami, and this instance's own per-list type map, which is derived from
   *  them. Reached from the authoring refresh and from a (re)connected
   *  credential; a run never calls it. */
  async invalidateSchemaCache(): Promise<void> {
    this.perListCache = undefined;
    invalidateFieldCache(await this.getApiClient());
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    const client = await this.getApiClient();
    return catalogListEntryPoints({ client, teamId: this.teamId });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    // The type is named by its displayName (`Organization`, `List Entry —
    // Pipeline`), which IS the entry `typeId` now — `resolveTypeRef` is a
    // pass-through for a known name. Recover the structured id from that name
    // via the cache; an unknown name (drift / foreign id) → null.
    const name = await this.resolveTypeRef(typeRef);
    const decoded = await this.structuredIdFor(name);
    if (!decoded) return null;
    const client = await this.getApiClient();
    return catalogDescribe({ client, teamId: this.teamId, decoded, displayName: name });
  }

  /**
   * Walk the meta-graph. Affinity is uniform in every dimension but ONE: its
   * lists are genuinely per-list typed (`Pipeline` has `Deal Stage`, `Portfolio`
   * has `Ownership %`), so two lists are two TYPES, not two instances of one.
   * That is the schema-variance rule's variable case, and it is the whole reason
   * this adapter walks at all.
   *
   * Three positions answer:
   *   - the ROOT, whose edges mirror `listEntryPoints` (they are the same node's
   *     edges and must not disagree) and whose `targetPositions` carry both the
   *     named entity types and the polymorphic per-list members;
   *   - a per-entity list-entry COLLECTION member (a single list), which
   *     describes that list's own entry fields;
   *   - every other type, a leaf — `{ descriptor }` with no paths on, byte-for-
   *     byte what `describe` returns.
   *
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    if (position.recordType === META_RECORD_TYPE) return this.rootHop();

    // A list-entry collection MEMBER: one Affinity list, its id on the position.
    // This is the narrowed landing — `positionsByName` filed it under the bare
    // list name, and narrowing routes straight back here.
    const listsFor = position.recordType
      ? decodedFixedType(position.recordType)?.listsFor
      : undefined;
    if (listsFor && isStablePosition(position)) {
      const listId = Number(positionRecordId(position));
      if (!Number.isInteger(listId)) return null;
      const perListName = (await this.perListNamesByListId()).get(listId);
      if (!perListName) return null;
      const descriptor = await this.describe(perListName);
      return descriptor ? { descriptor, ...this.onwardFrom(descriptor) } : null;
    }

    // Every other type is a leaf of the META-graph: its edges lead to other
    // types, but reaching those is `describe`/traversal's business, not a
    // deeper container hop.
    if (position.recordType === null) return null;
    const descriptor = await this.describe(position.recordType);
    return descriptor ? { descriptor, ...this.onwardFrom(descriptor) } : null;
  }

  /**
   * What a non-root node offers onward: a STUB per edge (describes are
   * API-backed, so hydrating a node's whole frontier is never free) and, on
   * every edge, THE ADDRESS THAT WALKS IT.
   *
   * Below the root Affinity is type-addressed — an `Organization`'s edges land
   * on types located by name alone — so the addresses mint exactly as
   * `uniformWalk`'s do. They were previously absent, which is not "a cheaper
   * answer" but the walk stopping dead at depth one: a stub says "one hop
   * resolves this" while publishing no hop to take.
   */
  private onwardFrom(descriptor: SchemaTypeDescriptor): Pick<EdgesFromResult, 'targetNodes' | 'targetPositions'> {
    if (descriptor.references.length === 0) return {};
    return {
      ...targetStubs(descriptor),
      targetPositions: typeAddressedPositions({ adapterType: this.adapterType, descriptor }),
    };
  }

  /**
   * The root's edges — one per published entry point, plus the paths on.
   *
   * `targetPositions` files two DIFFERENT ways, and the difference is the whole
   * mechanism (`filePaths`): a key that matches a reference's `fieldId` files
   * under that reference's `targetTypeId` (the named types); a key that matches
   * NO reference files under `positionLabel(position)` — the position's `Name`.
   * The per-list members use the second form deliberately, so each list files
   * under its bare name (`"Pipeline"`) with no reference row of its own. That is
   * what makes `List Entries` ONE polymorphic edge with many members rather than
   * a named edge per list.
   */
  private async rootHop(): Promise<EdgesFromResult> {
    const allEntries = await this.listEntryPoints();
    const lists = await this.listsByEntityKind();

    // THE ROOT PUBLISHES ONLY EDGES IT CAN BACK.
    //
    // `Note`, `File`, `Interaction`, `Relationship Strength` and the generic
    // `List Entry` are position-only types: real types, reached through their
    // parent (`Organization-[:Notes]->`), with nothing the root itself offers —
    // their entries declare neither `readable` nor `writable`. Publishing a root
    // edge for them stated a relationship a movement could do nothing with:
    // you cannot read it, cannot write it, and it is not delivered.
    //
    // The collections (`Organization List Entry` …) look identical on a
    // read/write test and must NOT be dropped: their promises live on the
    // MEMBERS they narrow to, which is what a polymorphic edge is.
    const entries = allEntries.filter(
      (entry) =>
        entry.readable ||
        entry.writable ||
        entry.fires === true ||
        decodedFixedType(entry.typeId)?.listsFor !== undefined,
    );

    // A collection is NOT a walk destination in its own right — you reach it by
    // narrowing to one of its members, and its members carry its `recordType`.
    // Minting a named path for it too would file a phantom member under the
    // collection's own name (`membersOf` matches purely on `recordType`), and
    // narrowing would silently consider it a candidate list.
    const namedPaths = entries
      .filter((entry) => decodedFixedType(entry.typeId)?.listsFor === undefined)
      .map((entry) => [
        entry.typeId,
        makeStablePosition({
          adapterType: this.adapterType,
          recordType: entry.displayName,
          recordId: entry.externalId ?? entry.typeId,
          data: { Name: entry.displayName },
        }),
      ]);

    // The polymorphic members: every list, filed under the COLLECTION its kind
    // owns. `recordType` must equal the type name the collection edge resolves
    // to, or `membersOf` matches nothing and narrowing silently no-ops. `data`
    // must carry a literal `listName`, or `selectMember` bails before evaluating
    // the predicate. Both are silent failures, so both are asserted in tests.
    const memberPaths = [...lists.entries()].flatMap(([kind, ofKind]) =>
      ofKind.map((list) => [
        `list:${list.id}`,
        makeStablePosition({
          adapterType: this.adapterType,
          recordType: LIST_ENTRY_COLLECTION_DISPLAY_NAMES[kind],
          recordId: String(list.id),
          data: { Name: list.name, Id: String(list.id), listName: list.name },
        }),
      ]),
    );

    const descriptor: SchemaTypeDescriptor = {
      typeId: META_RECORD_TYPE,
      displayName: META_RECORD_TYPE,
      fields: [],
      // The entry list and the walk are the same node's edges. Promises are
      // copied from the entries rather than restated, so they cannot drift.
      references: entries.map((entry) => ({
        fieldId: entry.typeId,
        name: entry.displayName,
        targetTypeId: entry.typeId,
        cardinality: 'many' as const,
        readable: entry.readable,
        writable: entry.writable,
      })),
    };

    // The root STUBS its landings (ruling 2026-07-19). Hydrating them was tried
    // and measured at 1 upstream call → 9: the whole root frontier fetched to
    // answer "what is in this connection". A stub plus a walkable address is
    // strictly cheaper, because it costs one call for the ONE edge you follow
    // rather than nine for the edges you don't.
    //
    // That trade only holds because the addresses are now published (see
    // `onwardFrom`). While they were missing, a stub was a dead end and
    // hydrating was the only way to see anything — which is how a walkability
    // bug came to look like a hydration decision.
    //
    // Built from ONE descriptor: this used to restate the reference list a
    // second time to build the stubs, which is two statements of one fact and
    // exactly how a walk drifts from the node it describes.
    return {
      descriptor,
      targetPositions: Object.fromEntries([...namedPaths, ...memberPaths]),
      ...targetStubs(descriptor),
    };
  }

  /** Every Affinity list, grouped by the entity kind its `type` names. An
   *  untyped list (a `type` we don't map) belongs to no collection and is
   *  dropped — it has no parent kind to hang off. */
  private async listsByEntityKind(): Promise<Map<ListEntityKind, { id: number; name: string }[]>> {
    const grouped = new Map<ListEntityKind, { id: number; name: string }[]>();
    for (const [name, decoded] of await this.perListTypes()) {
      const kind = listEntityKind(decoded.listType);
      if (!kind || decoded.listId === undefined) continue;
      const bare = listNameFromPerListType(name);
      grouped.set(kind, [...(grouped.get(kind) ?? []), { id: decoded.listId, name: bare }]);
    }
    return grouped;
  }

  // ── 2. Entity resolution ───────────────────────────────────────────────

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    // The engine names the record type / `record` keys / constraint fields by
    // this adapter's NATURAL names. Two first-line translations: (a) the type
    // NAME → its structured id (`{ entity }`) via the cache, which selects the
    // org/person identity reader; (b) each `record` key + constraint `field`
    // property-first (`tryFieldId`), else edge (`tryEdgeWriteName`), else leave
    // as-is (an edge-valued `{ id }` entry keeps its value). `recordType` itself
    // STAYS the natural name — the bridge stage matches it against the persisted
    // `external_object_type` label, which is also a name now.
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;
    const decoded = await this.structuredIdFor(naturalTypeName);

    const renameKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ??
      resolver.tryEdgeWriteName(naturalName(naturalTypeName), naturalName(field)) ??
      field;

    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.record)) record[renameKey(k)] = v;

    // A membership write names its list in the body, not on the type, so the
    // collection type cannot say WHICH membership to look for. Narrow it to the
    // list's own identity first — the same re-homing the create does.
    const forResolve = await this.narrowedListEntryType(decoded, record);

    const constraints = {
      any: input.constraints.any.map((branch) => ({
        all: branch.all.map((entry) => ({ ...entry, field: renameKey(entry.field) })),
      })),
    };

    const operations = await this.getOperations();
    return doResolveEntity({
      operations,
      decoded: forResolve,
      resolve: { ...input, record, constraints },
      ...(forResolve?.entity === 'organization'
        ? { organisationContext: await this.organisationMatchContext(naturalTypeName, input.record) }
        : {}),
    });
  }

  /** The judge's context for an organization match, read off the write's
   *  NATURAL field names (the labels the author wrote) — built-ins excluded
   *  by their internal ids. */
  private async organisationMatchContext(
    naturalTypeName: string,
    fields: Record<string, unknown>,
  ): Promise<string | undefined> {
    const resolver = await this.resolver({ types: [naturalTypeName] });
    return organisationMatchContext(
      Object.entries(fields).map(([label, value]) => ({
        label,
        value,
        fieldId: resolver.tryFieldId(naturalName(naturalTypeName), naturalName(label)) ?? label,
      })),
    );
  }

  /** The list-pinned identity behind a membership write: the collection type
   *  plus the `listName` its body names. Anything else passes through. */
  private async narrowedListEntryType(
    decoded: DecodedTypeId | undefined,
    record: Record<string, unknown>,
  ): Promise<DecodedTypeId | undefined> {
    if (decoded?.entity !== 'list-entry' || decoded.listId != null) return decoded;
    const listName = record[AFFINITY_LIST_NAME_FIELD];
    if (typeof listName !== 'string' || listName.trim() === '') return decoded;
    return (await this.perListTypes()).get(perListTypeName(listName.trim())) ?? decoded;
  }

  // ── 3. Field-level access ──────────────────────────────────────────────
  // Affinity record positions carry the entity's flat field map on
  // `position.data`. Scalar reads are a direct lookup (BaseAdapter default);
  // references walk org↔person via the API.

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        'AffinityAdapter.getRelated only supports outgoing direction (org→people, person→orgs).',
      );
    }
    const position = input.position;
    if (position.adapterType !== this.adapterType) {
      throw new Error(
        `AffinityAdapter.getRelated expects ${this.adapterType} positions; got ${position.adapterType}`,
      );
    }
    // A ROOT collection read — the records a readable entry point enumerates
    // (`crm-[o:Organization]-> …`). Handled BEFORE the stable-position guard:
    // a meta position is not a record, and rejecting it there is exactly how
    // these reads used to throw on the very types the root published readable
    // (7_readable_means_readable.md — every clean adapter orders META first).
    if (position.recordType === META_RECORD_TYPE) {
      return this.listRootCollection(input.fieldId, input.where);
    }
    if (!isStablePosition(position) || position.recordType === null) {
      throw new Error('AffinityAdapter.getRelated expects a stable Affinity record position with a known type.');
    }
    // The position's `recordType` is the NATURAL type name on every hop — the
    // landings this adapter emits stamp the linked type's name too, so there's
    // no encoded id to normalize. Recover its structured id from the cache; the
    // NATURAL edge name resolves to this adapter's read currency (the reference
    // `fieldId` — `people` / `organizations` / `notes` / …); a drift on a
    // mistyped edge throws loudly.
    const naturalType = position.recordType;
    const resolver = await this.resolver({ types: [naturalType] });
    const edgeId = resolver.edgeReadId(naturalName(naturalType), naturalName(input.fieldId));

    const decoded = await this.structuredIdFor(naturalType);
    if (!decoded) return [];

    const client = await this.getApiClient();
    const data = positionData(position) as Record<string, unknown> | null | undefined;
    const recordId = Number(positionRecordId(position));

    switch (decoded.entity) {
      case 'organization': {
        if (edgeId === 'people') return this.personsById(idArray(data?.person_ids), client);
        const attached = await this.attachedSurfaceRelated({
          parent: 'organization',
          parentId: recordId,
          edgeId,
          client,
        });
        if (attached) return attached;
        break;
      }
      case 'person': {
        if (edgeId === 'organizations') {
          return this.organizationsById(idArray(data?.organization_ids), client);
        }
        if (edgeId === 'relationship_strengths') {
          const strengths = await client.getRelationshipStrengths({ externalId: recordId });
          return strengths.map((s) => ({
            position: makeStablePosition({
              adapterType: this.adapterType,
              recordType: ENTITY_DISPLAY_NAMES['relationship-strength'],
              // There is at most one strength per (internal, external) pair —
              // the pair IS the record key. Opaque: compared, never parsed.
              recordId: `${s.external_id}:${s.internal_id}`,
              data: canonicalRelationshipStrengthData(s),
            }),
          }));
        }
        const attached = await this.attachedSurfaceRelated({
          parent: 'person',
          parentId: recordId,
          edgeId,
          client,
        });
        if (attached) return attached;
        break;
      }
      case 'opportunity': {
        if (edgeId === 'people') return this.personsById(idArray(data?.person_ids), client);
        if (edgeId === 'organizations') {
          return this.organizationsById(idArray(data?.organization_ids), client);
        }
        const attached = await this.attachedSurfaceRelated({
          parent: 'opportunity',
          parentId: recordId,
          edgeId,
          client,
        });
        if (attached) return attached;
        break;
      }
      // List entry → the record it sits on. The entry body carries
      // `entity_type` (0 = person, 1 = organization, 8 = opportunity) +
      // `entity_id`; the traversed edge resolves ONLY when it matches — a
      // person-list entry's `Organization` hop (or an entry whose parent we
      // can't read) honestly yields [].
      case 'list-entry': {
        if (edgeId === 'organization' || edgeId === 'person' || edgeId === 'opportunity') {
          return this.listEntryParent({ data, edge: edgeId, client });
        }
        break;
      }
      case 'note': {
        if (edgeId === 'replies') {
          // Replies carry no entity associations (only the parent note does),
          // so the scoped GETs can't reach them — filter the workspace page
          // on parent_id instead.
          const notes = await client.listNotes();
          return notes
            .filter((n) => n.parent_id === recordId)
            .map((n) => this.noteLanding(n));
        }
        if (edgeId === 'parent') {
          const parentId = data?.parent_id;
          if (typeof parentId !== 'number') return [];
          const parent = await client.getNoteById(parentId);
          return [this.noteLanding(parent)];
        }
        if (edgeId === 'organizations') {
          return this.organizationsById(idArray(data?.organization_ids), client);
        }
        if (edgeId === 'people') return this.personsById(idArray(data?.person_ids), client);
        if (edgeId === 'opportunities') {
          return this.opportunitiesById(idArray(data?.opportunity_ids), client);
        }
        break;
      }
      case 'file': {
        const fileParent = async (
          id: unknown,
          fetchLanding: (id: number) => Promise<RelatedResult | null>,
        ): Promise<RelatedResult[]> => {
          if (typeof id !== 'number') return [];
          const landing = await fetchLanding(id);
          return landing ? [landing] : [];
        };
        if (edgeId === 'organization') {
          return fileParent(data?.organization_id, async (id) => ({
            position: await this.orgLanding(id, client),
          }));
        }
        if (edgeId === 'person') {
          return fileParent(data?.person_id, async (id) => ({
            position: await this.personLanding(id, client),
          }));
        }
        if (edgeId === 'opportunity') {
          return fileParent(data?.opportunity_id, async (id) => ({
            position: await this.opportunityLanding(id, client),
          }));
        }
        break;
      }
      case 'reminder': {
        const embedded = (value: unknown): number | undefined => {
          const id = (value as { id?: unknown } | null | undefined)?.id;
          return typeof id === 'number' ? id : undefined;
        };
        if (edgeId === 'person' || edgeId === 'owner') {
          const id = embedded(edgeId === 'owner' ? data?.owner : data?.person);
          if (id === undefined) return [];
          return [{ position: await this.personLanding(id, client) }];
        }
        if (edgeId === 'organization') {
          const id = embedded(data?.organization);
          if (id === undefined) return [];
          return [{ position: await this.orgLanding(id, client) }];
        }
        if (edgeId === 'opportunity') {
          const id = embedded(data?.opportunity);
          if (id === undefined) return [];
          return [{ position: await this.opportunityLanding(id, client) }];
        }
        break;
      }
      case 'interaction': {
        if (edgeId === 'people') {
          // The landing already carries every involved person embedded
          // (attendee `persons`, email from/to/cc, folded by
          // canonicalInteractionData) — no refetch.
          const persons = Array.isArray(data?.persons) ? data.persons : [];
          return persons
            .filter((p): p is { id: number } => typeof (p as { id?: unknown })?.id === 'number')
            .map((p) => ({
              position: makeStablePosition({
                adapterType: this.adapterType,
                recordType: ENTITY_DISPLAY_NAMES.person,
                recordId: String(p.id),
                data: canonicalPersonData(p as Parameters<typeof canonicalPersonData>[0]),
              }),
            }));
        }
        if (edgeId === 'notes') {
          const results: RelatedResult[] = [];
          for (const id of idArray(data?.notes)) {
            try {
              results.push(this.noteLanding(await client.getNoteById(id)));
            } catch (err) {
              if (isAdapterCallCeilingExceeded(err)) throw err;
              logger.warn('[AffinityAdapter.getRelated] failed to fetch interaction note', { id, err });
            }
          }
          return results;
        }
        break;
      }
      case 'relationship-strength': {
        if (edgeId === 'internal_person') {
          const internalId = data?.internal_id;
          if (typeof internalId !== 'number') return [];
          return [{ position: await this.personLanding(internalId, client) }];
        }
        break;
      }
    }

    throw new Error(
      `AffinityAdapter.getRelated: field "${input.fieldId}" is not a reference on ${position.recordType}.`,
    );
  }

  // ── Landing builders (canonical, fieldId-keyed data + link ids) ──────────

  private async orgLanding(id: number, client: AffinityAPIClient): Promise<SourcePosition> {
    const org = await client.getOrganisationById(id);
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType: ENTITY_DISPLAY_NAMES.organization,
      recordId: String(org.id),
      data: { ...canonicalOrgData(org), person_ids: org.person_ids ?? [] },
    });
  }

  private async personLanding(id: number, client: AffinityAPIClient): Promise<SourcePosition> {
    const person = await client.getPersonById(id);
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType: ENTITY_DISPLAY_NAMES.person,
      recordId: String(person.id),
      data: { ...canonicalPersonData(person), organization_ids: person.organization_ids ?? [] },
    });
  }

  private async opportunityLanding(id: number, client: AffinityAPIClient): Promise<SourcePosition> {
    const opp = await client.getOpportunityById(id);
    return makeStablePosition({
      adapterType: this.adapterType,
      recordType: ENTITY_DISPLAY_NAMES.opportunity,
      recordId: String(opp.id),
      data: canonicalOpportunityData(opp),
    });
  }

  private noteLanding(note: Parameters<typeof canonicalNoteData>[0]): RelatedResult {
    return {
      position: makeStablePosition({
        adapterType: this.adapterType,
        recordType: ENTITY_DISPLAY_NAMES.note,
        recordId: String(note.id),
        data: canonicalNoteData(note),
      }),
    };
  }

  private async personsById(ids: number[], client: AffinityAPIClient): Promise<RelatedResult[]> {
    const results: RelatedResult[] = [];
    for (const id of ids) {
      try {
        results.push({ position: await this.personLanding(id, client) });
      } catch (err) {
        if (isAdapterCallCeilingExceeded(err)) throw err;
        logger.warn('[AffinityAdapter.getRelated] failed to fetch person', { id, err });
      }
    }
    return results;
  }

  private async organizationsById(ids: number[], client: AffinityAPIClient): Promise<RelatedResult[]> {
    const results: RelatedResult[] = [];
    for (const id of ids) {
      try {
        results.push({ position: await this.orgLanding(id, client) });
      } catch (err) {
        if (isAdapterCallCeilingExceeded(err)) throw err;
        logger.warn('[AffinityAdapter.getRelated] failed to fetch organization', { id, err });
      }
    }
    return results;
  }

  private async opportunitiesById(ids: number[], client: AffinityAPIClient): Promise<RelatedResult[]> {
    const results: RelatedResult[] = [];
    for (const id of ids) {
      try {
        results.push({ position: await this.opportunityLanding(id, client) });
      } catch (err) {
        if (isAdapterCallCeilingExceeded(err)) throw err;
        logger.warn('[AffinityAdapter.getRelated] failed to fetch opportunity', { id, err });
      }
    }
    return results;
  }

  /**
   * The record-attached read surfaces every top-level entity scopes — notes,
   * files, list entries, interactions, reminders — resolved against ONE
   * parent (org / person / opportunity), the way the v1 API scopes them.
   * Returns undefined when the edge isn't one of these (the caller falls
   * through to its own edges / the drift error).
   */
  private async attachedSurfaceRelated(input: {
    parent: 'organization' | 'person' | 'opportunity';
    parentId: number;
    edgeId: string;
    client: AffinityAPIClient;
  }): Promise<RelatedResult[] | undefined> {
    const { parent, parentId, edgeId, client } = input;
    const scope =
      parent === 'organization'
        ? { organizationId: parentId }
        : parent === 'person'
          ? { personId: parentId }
          : { opportunityId: parentId };

    if (edgeId === 'notes') {
      const notes = await client.listNotes(scope);
      return notes.map((n) => this.noteLanding(n));
    }

    if (edgeId === 'files') {
      const files = await client.listEntityFiles(scope);
      return files.map((f) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: ENTITY_DISPLAY_NAMES.file,
          recordId: String(f.id),
          data: canonicalFileData(f),
        }),
      }));
    }

    if (edgeId === 'reminders') {
      const reminders = await client.listReminders(scope);
      return reminders.map((r) => ({
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordType: ENTITY_DISPLAY_NAMES.reminder,
          recordId: String(r.id),
          data: canonicalReminderData(r),
        }),
      }));
    }

    if (edgeId === 'interactions') {
      // GET /interactions takes ONE type per request and a ≤1-year range —
      // four calls (meeting / call / chat / email) over the trailing year.
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 364 * 24 * 60 * 60 * 1000);
      const results: RelatedResult[] = [];
      for (const type of Object.values(INTERACTION_TYPE)) {
        const interactions = await client.listInteractions({ type, ...scope, startTime, endTime });
        for (const interaction of interactions) {
          results.push({
            position: makeStablePosition({
              adapterType: this.adapterType,
              recordType: ENTITY_DISPLAY_NAMES.interaction,
              // An interaction id is unique only per type ("the combination
              // of ID and type is unique") — the pair is the record key.
              // Opaque: compared, never parsed.
              recordId: `${interaction.type}:${interaction.id}`,
              data: canonicalInteractionData(interaction),
            }),
          });
        }
      }
      return results;
    }

    if (edgeId === 'list_entries') {
      // The entity GET carries its own list memberships inline.
      const entries =
        parent === 'organization'
          ? (await client.getOrganisationById(parentId)).list_entries
          : parent === 'person'
            ? (await client.getPersonById(parentId)).list_entries
            : (await client.getOpportunityById(parentId)).list_entries;
      const perListNames = await this.perListNamesByListId();
      const entityType =
        parent === 'organization'
          ? AFFINITY_ENTITY_TYPE.ORGANIZATION
          : parent === 'person'
            ? AFFINITY_ENTITY_TYPE.PERSON
            : AFFINITY_ENTITY_TYPE.OPPORTUNITY;
      return ((entries ?? []) as { id: number; list_id: number }[]).map((entry) => {
        const perListName = perListNames.get(entry.list_id);
        return {
          position: makeStablePosition({
            adapterType: this.adapterType,
            // The PER-LIST name when the catalog knows the list — the most
            // specific type, so a chained hop resolves list-scoped fields.
            recordType: perListName ?? ENTITY_DISPLAY_NAMES['list-entry'],
            recordId: String(entry.id),
            // The parent hop routes on entity_type/entity_id — stamp them from
            // the parent we just walked from (the inline entries omit them).
            // `listName` is stamped because the collection declares it READABLE:
            // it is the one field every member shares, and the same word narrows
            // the read and discriminates the write.
            data: {
              ...entry,
              entity_type: entityType,
              entity_id: parentId,
              ...(perListName
                ? { [AFFINITY_LIST_NAME_FIELD]: listNameFromPerListType(perListName) }
                : {}),
            },
          }),
        };
      });
    }

    return undefined;
  }

  /** Reverse of the per-list name cache: listId → `List Entry — <list>`. */
  private async perListNamesByListId(): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    for (const [name, decoded] of await this.perListTypes()) {
      if (decoded.listId !== undefined) map.set(decoded.listId, name);
    }
    return map;
  }

  /**
   * The `term` this root read can be narrowed by, or `undefined` for the whole
   * workspace.
   *
   * Only a top-level AND-ed `` `Field` == "literal" `` on a term-searchable
   * field pushes, and only ONE of them, because `term` takes a single value:
   * from `` `Domain` == x AND `Name` == y `` the domain narrows the fetch and
   * the engine satisfies the name over what comes back. Anything else — a
   * range, an OR, a field Affinity does not search — leaves the read
   * unnarrowed and the walk pages the workspace.
   */
  private async termFromWhere(input: {
    typeName: string;
    where: Expression | undefined;
    fieldIds: ReadonlySet<string>;
  }): Promise<string | undefined> {
    if (input.where === undefined) return undefined;
    const resolver = await this.resolver({ types: [input.typeName] });
    for (const conjunct of flattenAndConjuncts(input.where)) {
      if (conjunct.type !== 'compare' || conjunct.op !== 'eq') continue;
      // The bracket-WHERE grammar parses a bare field name as an EDGE property
      // (`WHERE \`Domain\` == …`); a slot-parsed one arrives as a plain property.
      // Both name a field of the record being filtered.
      const field =
        conjunct.left.type === 'property' || conjunct.left.type === 'edge_property'
          ? conjunct.left.propertyTypeId
          : undefined;
      if (field === undefined || conjunct.right.type !== 'static') continue;
      if (typeof conjunct.right.value !== 'string') continue;
      const fieldId = resolver.tryFieldId(naturalName(input.typeName), naturalName(field));
      if (fieldId !== undefined && input.fieldIds.has(fieldId)) return conjunct.right.value;
    }
    return undefined;
  }

  /**
   * The root's collection reads, by entry-point name — one per entry the
   * root publishes `readable`, each backed by the v1 API's own
   * workspace-wide enumeration: organizations / persons / opportunities /
   * notes / entity files / reminders (all single default page). A per-list
   * entry type enumerates its ONE list (`GET /lists/{id}/list-entries`); the
   * generic `List Entry` has no workspace-wide API behind it, so the read
   * says so instead of fanning out. Interactions and relationship strengths
   * are edge-only (the API requires a record scope) — an unknown or
   * unreadable name degrades honestly.
   *
   * `where` is the hop's predicate, pushed so the read can be NARROWED at the
   * source instead of paging the workspace (`GetRelatedInput.where`). Only the
   * organization and person reads can use it, and only through `term` — see
   * `termFromWhere`. LIMIT is deliberately not honoured: this read is followed
   * by filters (the global-dataset filter here, the engine's WHERE after it),
   * so a fetch truncated at n answers with fewer than n records that match.
   */
  private async listRootCollection(
    edgeName: string,
    where?: Expression,
  ): Promise<RelatedResult[]> {
    const decoded = await this.structuredIdFor(edgeName);
    // An unknown collection degrades to empty, like every other unresolved
    // name here — the checker owns the author-facing diagnostic.
    if (!decoded) return [];
    const client = await this.getApiClient();
    switch (decoded.entity) {
      case 'organization': {
        const orgs = await client.listOrganisations({
          term: await this.termFromWhere({
            typeName: ENTITY_DISPLAY_NAMES.organization,
            where,
            fieldIds: ORGANIZATION_TERM_FIELD_IDS,
          }),
        });
        return orgs.map((org) => ({
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: ENTITY_DISPLAY_NAMES.organization,
            recordId: String(org.id),
            // Canonical (fieldId-keyed) so downstream field reads resolve;
            // `person_ids` rides along so the `People` edge can hop on.
            data: { ...canonicalOrgData(org), person_ids: org.person_ids ?? [] },
          }),
        }));
      }
      case 'person': {
        const persons = await client.listPersons({
          term: await this.termFromWhere({
            typeName: ENTITY_DISPLAY_NAMES.person,
            where,
            fieldIds: PERSON_TERM_FIELD_IDS,
          }),
        });
        return persons.map((person) => ({
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: ENTITY_DISPLAY_NAMES.person,
            recordId: String(person.id),
            data: {
              ...canonicalPersonData(person),
              organization_ids: person.organization_ids ?? [],
            },
          }),
        }));
      }
      case 'opportunity': {
        const opportunities = await client.listOpportunities();
        return opportunities.map((opp) => ({
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: ENTITY_DISPLAY_NAMES.opportunity,
            recordId: String(opp.id),
            data: canonicalOpportunityData(opp),
          }),
        }));
      }
      case 'note':
        // Retired root (rule 0): notes are owned by their record. GET /notes
        // still enumerates workspace-wide, but a flat root list is the API's
        // shape, not the natural graph — reads AND creates live on the record.
        throw new Error(
          'AffinityAdapter.getRelated: notes live under their record — hop ' +
            "an organization's / person's / opportunity's `Notes` edge " +
            '(`<record>-[:Notes]->`).',
        );
      case 'file':
        // Retired root (rule 0): files are owned by their record — same
        // placement as Attio's File. Read or upload one on the record's edge.
        throw new Error(
          'AffinityAdapter.getRelated: files live under their record — hop ' +
            "an organization's / person's / opportunity's `Files` edge " +
            '(`<record>-[:Files]->`).',
        );
      case 'reminder': {
        const reminders = await client.listReminders();
        return reminders.map((r) => ({
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordType: ENTITY_DISPLAY_NAMES.reminder,
            recordId: String(r.id),
            data: canonicalReminderData(r),
          }),
        }));
      }
      case 'list-entry': {
        // A per-list type reads its ONE list. The generic `List Entry` has
        // no workspace-wide enumeration in the v1 API — entries are rows OF
        // a list — so the root read refuses honestly instead of fabricating
        // a per-list fan-out.
        if (decoded.listId === undefined) {
          throw new Error(
            'AffinityAdapter.getRelated: list entries enumerate per list — read a list\'s own ' +
              'root (`List Entry — <list>`) or a record\'s `List Entries` edge.',
          );
        }
        const entries = await client.getListEntries({ listId: decoded.listId });
        return entries.map((entry) => ({
          position: makeStablePosition({
            adapterType: this.adapterType,
            // The PER-LIST name — the most specific type the catalog
            // knows, so a chained hop resolves its list-scoped fields.
            recordType: edgeName,
            recordId: String(entry.id),
            data: entry,
          }),
        }));
      }
      case 'interaction':
        throw new Error(
          'AffinityAdapter.getRelated: interactions enumerate per record — read an ' +
            "organization's / person's / opportunity's `Interactions` edge.",
        );
      case 'relationship-strength':
        throw new Error(
          'AffinityAdapter.getRelated: relationship strengths enumerate per person — read a ' +
            "person's `Relationship Strengths` edge.",
        );
    }
  }

  /** Resolve a list entry's parent record (org/person/opportunity) from its
   *  body's `entity_type` + `entity_id`. Honest: a type mismatch, a missing
   *  id, or a failed fetch all yield [] rather than a fabricated parent. */
  private async listEntryParent(input: {
    data: Record<string, unknown> | null | undefined;
    edge: 'organization' | 'person' | 'opportunity';
    client: AffinityAPIClient;
  }): Promise<RelatedResult[]> {
    const { data, edge, client } = input;
    const entityType = typeof data?.entity_type === 'number' ? data.entity_type : undefined;
    const rawId = data?.entity_id;
    const id = typeof rawId === 'number' ? rawId : typeof rawId === 'string' ? Number(rawId) : NaN;
    // Affinity entity_type (Field Entity Types): 0 = person, 1 = organization,
    // 8 = opportunity.
    const wantType =
      edge === 'organization'
        ? AFFINITY_ENTITY_TYPE.ORGANIZATION
        : edge === 'person'
          ? AFFINITY_ENTITY_TYPE.PERSON
          : AFFINITY_ENTITY_TYPE.OPPORTUNITY;
    if (entityType !== wantType || !Number.isInteger(id)) return [];
    try {
      if (edge === 'organization') return [{ position: await this.orgLanding(id, client) }];
      if (edge === 'person') return [{ position: await this.personLanding(id, client) }];
      return [{ position: await this.opportunityLanding(id, client) }];
    } catch (err) {
      if (isAdapterCallCeilingExceeded(err)) throw err;
      logger.warn('[AffinityAdapter.getRelated] failed to fetch list-entry parent', { edge, id, err });
      return [];
    }
  }

  // ── 5. Writes ───────────────────────────────────────────────────────────

  /**
   * Translate a write/update's FIELD names from the engine's NATURAL currency
   * to this adapter's internal currency, on the first line of each write
   * method: each `fields` / `evidence` key (built-in field displayName,
   * custom-field displayName) → internal field id; each parent slot's
   * `edgeName` → this adapter's write-edge currency. `recordType` (and each
   * parent's `recordType`) STAYS the natural type name — the write methods
   * route via the structured-id cache, and the per-entity builders read the
   * parent's entity from its natural name (`decodedFixedType`), not by decoding
   * a string. The per-entity write builders then consume internal field keys
   * exactly as before.
   */
  private async translateWrite<T extends WriteInput>(input: T): Promise<T> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const naturalTypeName = input.recordType;

    const renameFieldKey = (field: string): string =>
      resolver.tryFieldId(naturalName(naturalTypeName), naturalName(field)) ?? field;

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input.fields)) fields[renameFieldKey(k)] = v;

    const evidence = input.evidence
      ? Object.fromEntries(
          Object.entries(input.evidence).map(([k, v]) => [renameFieldKey(k), v]),
        )
      : input.evidence;

    const translateParent = (parent: ParentLink): ParentLink => {
      // `recordType` stays the parent's natural name (the builders read its
      // entity via `decodedFixedType`); only the edge name needs the write
      // currency, resolved against the parent's own type.
      const edgeName =
        resolver.tryEdgeWriteName(naturalName(parent.recordType), naturalName(parent.edgeName)) ??
        parent.edgeName;
      return { ...parent, edgeName };
    };

    return {
      ...input,
      fields,
      ...(evidence !== undefined ? { evidence } : {}),
      ...(input.parentLinks
        ? { parentLinks: input.parentLinks.map(translateParent) }
        : {}),
    };
  }

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const input = await this.translateWrite(rawInput);
    // `recordType` is the NATURAL type name — recover its structured id from the
    // cache; an unknown type is a hard error.
    const decoded = await this.requireStructuredId(rawInput.recordType, 'createRecord');
    const operations = await this.getOperations();
    const web = this.getWeb();

    switch (decoded.entity) {
      case 'organization':
        return createOrganization({
          operations,
          web,
          write: input,
          holderFor: this.holderFor,
          matchContext: await this.organisationMatchContext(rawInput.recordType, rawInput.fields),
        });
      case 'person':
        return createPerson({ operations, web, write: input, holderFor: this.holderFor });
      case 'list-entry':
        // A write along `<org/person>-[:List Entries]->` names its list in the
        // body; resolve it to the pinned per-list create. A per-list type is
        // read-only as a ROOT, so the only writable list-entry surface is the
        // record's edge.
        return decoded.listsFor
          ? this.createListMembership(input)
          : createListEntry({ operations, write: input, decoded });
      case 'note':
        return createNote({ operations, write: input });
      case 'file':
        return createFile({ operations, teamId: this.teamId, write: input });
      case 'opportunity':
        // POST /opportunities exists but requires the target list (an
        // opportunity lives on exactly one list) — not wired; the entry says
        // `writable: false`, so this is drift-shaped, not author-reachable.
        throw new Error(
          'AffinityAdapter.createRecord: opportunities are created on their Affinity list — not writable here.',
        );
      case 'reminder':
      case 'interaction':
      case 'relationship-strength':
        throw new Error(
          `AffinityAdapter.createRecord: "${rawInput.recordType}" is a read-only surface.`,
        );
    }
  }

  /**
   * `write <org/person>-[:Lists]-> { listName: "Pipeline", … }` — add the write's
   * parent record to the NAMED list. The list is named in the body (a required
   * enum), not pinned by the type, so we resolve it to its per-list identity and
   * re-home onto `createListEntry` (the record is the lone parent). Entry-field
   * keys are re-resolved against the RESOLVED per-list type — `translateWrite`
   * only knew the membership type's `listName`, so the list-scoped fields arrive
   * un-renamed and must be keyed to the target list's own field ids.
   */
  private async createListMembership(input: WriteInput): Promise<WriteResult> {
    const rawListName = input.fields[AFFINITY_LIST_NAME_FIELD];
    if (typeof rawListName !== 'string' || rawListName.trim() === '') {
      throw new Error(
        `AffinityAdapter.createRecord: adding a record to a list needs the list named — set ` +
          `"${AFFINITY_LIST_NAME_FIELD}" to the list's name ` +
          `(write <record>-[:List Entries]-> { ${AFFINITY_LIST_NAME_FIELD}: "Pipeline" }).`,
      );
    }
    const listName = rawListName.trim();
    const perListName = perListTypeName(listName);
    const decoded = (await this.perListTypes()).get(perListName);
    if (decoded?.listId == null) {
      throw new Error(
        `AffinityAdapter.createRecord: no Affinity list named "${listName}" — ` +
          `check the "${AFFINITY_LIST_NAME_FIELD}" value against your lists.`,
      );
    }
    const resolver = await this.resolver({ types: [perListName] });
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input.fields)) {
      if (key === AFFINITY_LIST_NAME_FIELD) continue;
      fields[resolver.tryFieldId(naturalName(perListName), naturalName(key)) ?? key] = value;
    }
    const operations = await this.getOperations();
    return createListEntry({ operations, write: { ...input, fields }, decoded });
  }

  async updateRecord(rawInput: UpdateInput): Promise<UpdateResult> {
    const input = await this.translateWrite(rawInput);
    const decoded = await this.requireStructuredId(rawInput.recordType, 'updateRecord');
    const operations = await this.getOperations();
    const web = this.getWeb();

    switch (decoded.entity) {
      case 'organization':
        return updateOrganization({ operations, web, update: input, holderFor: this.holderFor });
      case 'person':
        return updatePerson({ operations, web, update: input, holderFor: this.holderFor });
      // An entry the engine resolved by (record, list) is UPDATED in place —
      // the values it hands us have already been merged against what the entry
      // carries. Re-running the membership create would only re-derive the id
      // we were given.
      case 'list-entry': {
        const entry = await this.locateListEntry(decoded, input);
        if (!entry) return UPDATE_NOT_FOUND;
        return updateListEntry({ operations, update: input, entry });
      }
      // note / file have no in-place update — re-asserting one APPENDS, and
      // the appended record hangs off the parent the write named, so the
      // association is made by the same act that writes the note.
      case 'note':
        return { ...(await createNote({ operations, write: input })), association: 'made' };
      case 'file':
        return { ...(await createFile({ operations, teamId: this.teamId, write: input })), association: 'made' };
      case 'opportunity':
      case 'reminder':
      case 'interaction':
      case 'relationship-strength':
        throw new Error(
          `AffinityAdapter.updateRecord: "${rawInput.recordType}" is a read-only surface.`,
        );
    }
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    const decoded = await this.structuredIdFor(input.recordType);
    if (!decoded) {
      throw new Error(`AffinityAdapter.deleteRecord: unrecognised recordType "${input.recordType}".`);
    }
    const id = Number(input.externalId);
    if (!Number.isInteger(id)) {
      throw new Error(
        `AffinityAdapter.deleteRecord: externalId "${input.externalId}" is not a numeric Affinity id.`,
      );
    }
    const client = (await this.getOperations()).getClient();
    switch (decoded.entity) {
      case 'organization':
        await client.deleteOrganisation(id);
        return {};
      case 'person':
        await client.deletePerson(id);
        return {};
      case 'note':
        await client.deleteNote(id);
        return {};
      case 'list-entry': {
        if (decoded.listId === undefined) {
          throw new Error(
            'AffinityAdapter.deleteRecord: list entries delete through their per-list type (`List Entry — <list>`).',
          );
        }
        await client.deleteListEntry({ listId: decoded.listId, listEntryId: id });
        return {};
      }
      case 'file':
        // No delete endpoint for entity files in Affinity v1.
        throw new Error('AffinityAdapter.deleteRecord: Affinity files are not deletable.');
      case 'opportunity':
      case 'reminder':
      case 'interaction':
      case 'relationship-strength':
        // The v1 API deletes opportunities/reminders/interactions, but these
        // are read-only surfaces here — deleting a deal or logged history
        // from an automation is not a promise this adapter makes.
        throw new Error(
          `AffinityAdapter.deleteRecord: "${input.recordType}" is a read-only surface.`,
        );
    }
  }

  // ── 5b. Link / unlink two existing records ──────────────────────────────

  /**
   * `link entry -[:Owners]-> person`, `link org -[:People]-> person` — assert a
   * relationship between two records that both already exist. Affinity has two
   * kinds, and both are reachable here:
   *
   *   - a CUSTOM REFERENCE field: Affinity models these as fields rather than
   *     as a relationship table, so the link IS a field value. WHO HOLDS the
   *     field is the whole question — a company or a person holds its own
   *     unscoped fields; a list entry holds its list's, and a value on an entry
   *     is addressed by the entry AND the company the entry stands for. That is
   *     one question, asked exactly where a linked write asks it (`holderFor`),
   *     so the two spellings cannot drift.
   *   - the BUILT-IN person↔organization association, which is no field at all:
   *     it is the person's `organization_ids`, and it runs the same
   *     `attachPersonToOrganisation` a linked write onto a matched person runs,
   *     for the same reason.
   *
   * Idempotent either way: a relationship already there reports
   * `created: false` and sends nothing.
   */
  async linkRecords(input: LinkRecordsInput): Promise<LinkRecordsResult> {
    const resolved = await this.resolveLink(input, 'linkRecords');
    if (resolved.kind === 'employer') {
      const { operations, personId, orgId } = resolved;
      const client = operations.getClient();
      const person = await client.getPersonById(personId);
      const { association } = await attachPersonToOrganisation(client, { person, orgId });
      return { created: association === 'made' };
    }
    const { operations, holder, fieldDef, targetId } = resolved;
    const created = await assertCustomReference(operations, { holder, fieldDef, targetId });
    return { created };
  }

  /**
   * `unlink entry -[:Owners]-> person` — the inverse, over the same two kinds.
   * Affinity has no "clear this field" verb, so a custom reference's value rows
   * naming the target are deleted: one target leaves a multi-valued reference,
   * a single-valued one is emptied. The built-in association drops the org from
   * the person's employers and keeps the rest. A relationship that was never
   * there reports `removed: false` and sends nothing, which is the quiet no-op
   * `unlink` promises.
   */
  async unlinkRecords(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> {
    const resolved = await this.resolveLink(input, 'unlinkRecords');
    if (resolved.kind === 'employer') {
      const { operations, personId, orgId } = resolved;
      const client = operations.getClient();
      const person = await client.getPersonById(personId);
      const { removed } = await detachPersonFromOrganisation(client, { person, orgId });
      return { removed };
    }
    const { operations, holder, fieldDef, targetId } = resolved;
    const removed = await severCustomReference(operations, { holder, fieldDef, targetId });
    return { removed };
  }

  /**
   * WHICH of Affinity's two relationships this link is, resolved to the facts
   * that one needs.
   *
   *   - a CUSTOM REFERENCE field: the record that HOLDS the field, the field
   *     the edge names on it, and the Affinity id being pointed at;
   *   - the BUILT-IN employer association between a person and an
   *     organization, which is no field at all — it is the person's
   *     `organization_ids`, written from either side.
   *
   * A custom reference wins where both could read: exactly the exclusion the
   * linked-write path makes (`customReferenceFieldFor`), so `link` and
   * `write …-[:edge]->` split the two relationships the same way.
   *
   * Every remaining failure is loud. A standalone link has nowhere else to go,
   * so an edge that names neither relationship is the author's mistake.
   */
  private async resolveLink(
    input: LinkRecordsInput,
    method: 'linkRecords' | 'unlinkRecords',
  ): Promise<
    | {
        kind: 'reference';
        operations: AffinityOperations;
        holder: AffinityReferenceHolder;
        fieldDef: AffinityFieldMeta;
        targetId: number;
      }
    | { kind: 'employer'; operations: AffinityOperations; personId: number; orgId: number }
  > {
    const targetId = Number(input.to.externalId);
    if (!Number.isInteger(targetId)) {
      throw new Error(
        `AffinityAdapter.${method}: "${input.to.externalId}" is not a numeric Affinity id.`,
      );
    }
    const toDecoded = await this.structuredIdFor(input.to.recordType);
    if (toDecoded?.entity !== 'organization' && toDecoded?.entity !== 'person') {
      throw new Error(
        `AffinityAdapter.${method}: an Affinity relationship reaches a person or an ` +
          `organization — "${input.to.recordType}" is neither.`,
      );
    }
    const edgeName = naturalName(input.edgeName);
    const operations = await this.getOperations();
    const holder = await this.holderFor({
      recordType: input.from.recordType,
      externalId: input.from.externalId,
      edgeName,
    });
    const fieldDef = holder ? await referenceFieldOn(operations, holder, edgeName) : null;
    if (holder && fieldDef) {
      return { kind: 'reference', operations, holder, fieldDef, targetId };
    }

    // The built-in association: a person and an organization, either way
    // round, along the edge the catalog publishes it under. NAMED rather than
    // inferred by exclusion — "anything that is not a custom reference field"
    // would turn a misspelt or unknown edge into a silent employer link.
    const fromDecoded = await this.structuredIdFor(input.from.recordType);
    const fromId = Number(input.from.externalId);
    if (Number.isInteger(fromId) && isEmployerEdge(edgeName)) {
      if (fromDecoded?.entity === 'organization' && toDecoded.entity === 'person') {
        return { kind: 'employer', operations, personId: targetId, orgId: fromId };
      }
      if (fromDecoded?.entity === 'person' && toDecoded.entity === 'organization') {
        return { kind: 'employer', operations, personId: fromId, orgId: targetId };
      }
    }

    if (!holder) {
      throw new Error(
        `AffinityAdapter.${method}: "${input.from.recordType}" ${input.from.externalId} holds no ` +
          `reference fields — a link is a field value on a company, a person, or a list entry ` +
          `(an entry through its own list's type), or the association between a person and an ` +
          `organization.`,
      );
    }
    throw new Error(
      `AffinityAdapter.${method}: "${input.edgeName}" is not a writable ${toDecoded.entity} ` +
        `reference field on "${input.from.recordType}" — a link points one of the from-side's ` +
        `own reference fields at an existing record.`,
    );
  }


  // ── 5c. Expression reads ────────────────────────────────────────────────

  /**
   * Read one field at a position. Affinity records are SPLIT across two
   * sources: the built-ins (`Name`, `Domain`, …) land inline on the position,
   * while custom-field values live behind `/field-values` and are not on the
   * record at all. The base implementation reads only the inline data, so
   * without this override every custom field read as null — and did so
   * SILENTLY, because the name resolves against the descriptor (no drift) and
   * merely isn't in the data.
   *
   * The descriptor ids discriminate the two: a custom field's id is its numeric
   * Affinity field id (`String(field.id)` in schema_catalog), a built-in's is a
   * name. So built-ins still resolve inline with NO fetch.
   */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    if (!/^\d+$/.test(fieldId)) return super.getFieldValue(input);

    const scope = await this.customFieldScopeFor(input.position);
    if (!scope) return super.getFieldValue(input);

    const values = await this.customFieldValuesFor(scope);
    // Match on the id we just resolved, not on the display name — exact, and
    // free of any name-normalisation drift between resolver and catalog.
    const entry = [...values.values()].find((e) => String(e.field.id) === fieldId);
    if (!entry) {
      // The field exists on the type but has no value on this record. That is a
      // real empty, distinct from the missing fetch this override removed.
      return null;
    }
    // `allows_multiple` is declared `cardinality: 'many'` by the descriptor, so
    // it reads as the full list; a single-value field reads as its one value.
    return entry.field.allows_multiple ? entry.values : (entry.values[entry.values.length - 1] ?? null);
  }

  /**
   * A record's custom-field values, decoded.
   *
   * Nothing is memoised HERE any more. Both halves of the answer are already
   * per-run memos of their own — the field catalog on the client (per
   * credential, five minutes) and the `/field-values` read in the run scope —
   * so this decodes what is already in the process. The map this replaced was
   * a third cache over the same two reads, cleared wholesale on any write
   * through this adapter instance, which threw away every OTHER record's
   * values to keep one record honest.
   */
  private async customFieldValuesFor(
    scope: AffinityCustomFieldScope,
  ): Promise<Map<string, AffinityCustomFieldValue>> {
    const operations = await this.getOperations();
    const catalogType = scope.kind === 'list-entry' ? scope.catalogType : undefined;
    return readCustomFieldValues(operations, scope, {
      catalog: await cachedFields({
        client: await this.getApiClient(),
        type:
          catalogType ??
          (scope.kind === 'entity' && scope.entityType === 'organization'
            ? 'ORGANIZATION'
            : 'PERSON'),
      }),
    });
  }

  /**
   * Which record's custom values a position reads — its OWN, never a parent's.
   *
   * A list entry reads its LIST-SCOPED values only. We deliberately do NOT fall
   * back to the parent organization's/person's fields (ruled
   * 2026-07-18): a list entry already carries exactly one typed parent up-hop,
   * so `le.`Name`` reachable directly AND via that hop would be two routes to
   * one datum — the duality this campaign has been deleting. They are also two
   * records with distinct ids and lifecycles (removing an entry from a list
   * does not delete the company), which would make `write le.`Name`` a genuine
   * footgun. Read the parent's fields by hopping to the parent.
   */
  private async customFieldScopeFor(
    position: GetFieldValueInput['position'],
  ): Promise<AffinityCustomFieldScope | null> {
    if (position.recordType === null) return null;
    const decoded = await this.structuredIdFor(position.recordType);
    if (!decoded) return null;

    const recordId = Number(positionRecordId(position));
    if (!Number.isInteger(recordId)) return null;

    if (decoded.entity === 'organization' || decoded.entity === 'person') {
      return { kind: 'entity', entityType: decoded.entity, entityId: recordId };
    }
    if (decoded.entity === 'list-entry') {
      // Only a per-list entry type pins the list kind its fields are named
      // from; a generic `List Entry` cannot commit to one. Mirrors the same
      // mapping in schema_catalog's per-list describe, so the fields we read
      // are exactly the fields we published.
      const catalogType = listCatalogType(decoded);
      if (!catalogType) return null;
      return {
        kind: 'list-entry',
        listEntryId: recordId,
        catalogType,
        listId: decoded.listId,
        listName: decoded.listName,
      };
    }
    return null;
  }

  // ── 6. No-op detection read ─────────────────────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    // `recordType` is the NATURAL type name — recover its structured id from the
    // cache. An unknown type reads as "nothing here" (null).
    const decoded = await this.structuredIdFor(input.recordType);
    if (!decoded) return null;
    const operations = await this.getOperations();
    if (decoded.entity === 'organization') {
      return readOrganization({ operations, externalId: input.externalId });
    }
    if (decoded.entity === 'person') {
      return readPerson({ operations, externalId: input.externalId });
    }
    if (decoded.entity === 'list-entry') {
      return this.readListEntry(decoded, input.externalId);
    }
    return null;
  }

  /**
   * A list entry's own values, keyed by the name the entry's list publishes
   * (bare, the list's redundant prefix off). This is what hands the engine its
   * write semantics on a re-asserted membership: `?:` fills only what is empty
   * and an unchanged value writes nothing, both of which need to know what is
   * on the entry NOW. Without it every re-run read as "written from empty".
   *
   * The list is either pinned by the type (`List Entry — <list>`) or, on the
   * per-record membership collection, read off the entry's own value rows —
   * each row's field belongs to exactly one list. An entry with no values names
   * no list, and it does not need to: an entry with nothing on it has nothing
   * to compare against, which is exactly what an empty read says.
   */
  private async readListEntry(
    decoded: DecodedTypeId,
    externalId: string,
  ): Promise<Record<string, unknown> | null> {
    const listEntryId = Number(externalId);
    // A REHEARSED entry carries a synthetic handle, not an Affinity id. Nothing
    // to read, and nothing written yet to read against.
    if (!Number.isInteger(listEntryId)) return null;
    const catalogType = listCatalogType(decoded);
    if (!catalogType) return null;

    const client = await this.getApiClient();
    const [values, catalog] = await Promise.all([
      client.getFieldValues({ list_entry_id: listEntryId }),
      cachedFields({ client, type: catalogType }),
    ]);
    const list = await this.listOfEntry(decoded, values, catalog);
    const grouped = await readCustomFieldValues(
      await this.getOperations(),
      { kind: 'list-entry', listEntryId, catalogType, ...(list ?? {}) },
      { catalog, values },
    );

    const record: Record<string, unknown> = {};
    for (const [name, entry] of grouped) {
      // `allows_multiple` publishes as `cardinality: 'many'`, so it reads as
      // the whole list — which is what an append (`+:`) merges against.
      record[name] = entry.field.allows_multiple
        ? entry.values
        : (entry.values[entry.values.length - 1] ?? null);
    }
    if (list) record[AFFINITY_LIST_NAME_FIELD] = list.listName;
    return record;
  }

  /**
   * Where an entry actually lives: the LIST it sits on and the RECORD it stands
   * for. A list-scoped field value is posted against both, and neither is
   * recoverable from the entry's id alone — Affinity addresses an entry only
   * under its list.
   *
   * A list's own type pins the list; the membership collection does not, so the
   * list comes off the parent record's membership rows, which is also what
   * proves the entry is still that record's. An entry that has left the record
   * reads as gone (the not-found contract), so a bound write re-mints rather
   * than writing into a stranger's row.
   */
  private async locateListEntry(
    decoded: DecodedTypeId,
    update: UpdateInput,
  ): Promise<ListEntryLocation | null> {
    const listEntryId = Number(update.externalId);
    if (!Number.isInteger(listEntryId)) {
      throw new Error(
        `AffinityAdapter.updateRecord: externalId "${update.externalId}" is not a numeric list-entry id.`,
      );
    }
    const client = await this.getApiClient();
    const parent = this.parentEntityOf(update);

    if (decoded.listId != null) {
      const listName = decoded.listName;
      // No parent link (an entry written by id): the entry itself names the
      // record it stands for.
      const entity =
        parent ??
        (await (async () => {
          const row = await client.getListEntry({ listId: decoded.listId!, listEntryId });
          const kind = listEntityKind(decoded.listType);
          if (kind !== 'organization' && kind !== 'person') return null;
          return { entityId: row.entity_id, entityType: kind };
        })());
      if (!entity) return null;
      return { listEntryId, listId: decoded.listId, listName, ...entity };
    }

    if (!parent) {
      throw new Error(
        'AffinityAdapter.updateRecord: an entry on the membership collection is identified by the ' +
          'record it belongs to — write it through that record\'s `List Entries` edge.',
      );
    }
    const membership = (await client.getEntityListEntries(parent)).find(
      (row) => row.id === listEntryId,
    );
    if (!membership) return null;
    const list = await this.listById(membership.list_id);
    return { listEntryId, listId: membership.list_id, listName: list?.listName, ...parent };
  }

  /**
   * Which record a parent link stands for, when that record HOLDS a custom
   * reference pointed at the write's child (`write org-[:Champion]-> person`,
   * `write entry-[:Owners]-> person`). Only the adapter can answer: a per-list
   * entry type's name resolves through the live list cache, and a list-scoped
   * value is addressed by the entry AND the record the entry stands for.
   */
  private readonly holderFor: ReferenceHolderResolver = async (parent) => {
    const id = Number(parent.externalId);
    // A REHEARSED parent carries a synthetic handle, not an Affinity id.
    if (!Number.isInteger(id)) return null;
    const decoded = await this.structuredIdFor(parent.recordType);
    if (!decoded) return null;
    if (decoded.entity === 'organization' || decoded.entity === 'person') {
      return { kind: 'entity', entityType: decoded.entity, entityId: id };
    }
    if (decoded.entity !== 'list-entry') return null;
    const catalogType = listCatalogType(decoded);
    // Only a LIST's own type says which list's fields the entry holds; the
    // membership collection is reached by naming a list in a write body, and a
    // reference lands on a position, which always carries the narrowed type.
    if (!catalogType || decoded.listId == null) return null;
    const row = await (await this.getApiClient()).getListEntry({
      listId: decoded.listId,
      listEntryId: id,
    });
    return {
      kind: 'list-entry',
      listEntryId: id,
      listId: decoded.listId,
      listName: decoded.listName,
      catalogType,
      entityId: row.entity_id,
    };
  };

  /** The organization or person a write's lone parent link names. */
  private parentEntityOf(
    write: Pick<WriteInput, 'parentLinks'>,
  ): { entityId: number; entityType: 'organization' | 'person' } | undefined {
    const parent = singleParentLink(write);
    if (!parent) return undefined;
    const entity = decodedFixedType(parent.recordType)?.entity;
    if (entity !== 'organization' && entity !== 'person') return undefined;
    const entityId = Number(parent.externalId);
    return Number.isInteger(entityId) ? { entityId, entityType: entity } : undefined;
  }

  /** The list an entry sits on: pinned by a per-list type, else named by the
   *  entry's own field values (every list-scoped field belongs to one list). */
  private async listOfEntry(
    decoded: DecodedTypeId,
    values: { field_id: number }[],
    catalog: { id: number; list_id: number | null }[],
  ): Promise<{ listId: number; listName: string } | undefined> {
    if (decoded.listId != null && decoded.listName !== undefined) {
      return { listId: decoded.listId, listName: decoded.listName };
    }
    const byId = new Map(catalog.map((f) => [f.id, f]));
    const listId = values
      .map((v) => byId.get(v.field_id)?.list_id)
      .find((id): id is number => id != null);
    if (listId == null) return undefined;
    return this.listById(listId);
  }

  /** A list's id and name off the per-list type cache — the same catalog row
   *  the type names itself from, so a field named here and a field named by
   *  `describe` can't disagree. */
  private async listById(listId: number): Promise<{ listId: number; listName: string } | undefined> {
    for (const decoded of (await this.perListTypes()).values()) {
      if (decoded.listId === listId && decoded.listName !== undefined) {
        return { listId, listName: decoded.listName };
      }
    }
    return undefined;
  }

  // ── Internal: lazy client + operations + web-url construction ────────────

  private getWeb(): WebUrlSource {
    if (!this.web) throw new Error('AffinityAdapter: web resolver not initialised (call getApiClient first).');
    return this.web;
  }

  private async getOperations(): Promise<AffinityOperations> {
    if (this.operations) return this.operations;
    const client = await this.getApiClient();
    this.operations = new AffinityOperations(client);
    return this.operations;
  }

  private async getApiClient(): Promise<AffinityAPIClient> {
    if (this.apiClient) return this.apiClient;

    const row = await getAutomationsQb(['external_service_credentials'])
      .selectFrom('external_service_credentials')
      .where('id', '=', this.credentialsId as ExternalServiceCredentialsId)
      .where('team_id', '=', this.teamId)
      .select(['id', 'credentials'])
      .executeTakeFirst();

    if (!row) {
      throw new Error(
        `Affinity credentials ${this.credentialsId} not found for team ${this.teamId}. Either the credential was deleted, or the consumer is misconfigured.`,
      );
    }

    const decrypted = await decryptToken(row.credentials, row.id);
    let payload: unknown;
    try {
      payload = JSON.parse(decrypted);
    } catch (err) {
      logger.error('[AffinityAdapter] credential payload is not valid JSON', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Affinity credentials ${row.id} are malformed (not valid JSON).`);
    }

    // Route dev-loop team traffic to fake-channels (mirrors Attio / Airtable).
    const rawPayload = isTestHarnessTeam(this.teamId)
      ? injectFakeBaseUrl(payload as Record<string, unknown>, 'AFFINITY')
      : payload;

    const parsed = affinityAdapterCredsParser.safeParse(rawPayload);
    if (!parsed.success) {
      logger.error('[AffinityAdapter] credential payload failed validation', {
        teamId: this.teamId,
        credentialsId: row.id,
        error: parsed.error.message,
      });
      throw new Error(`Affinity credentials ${row.id} are malformed (${parsed.error.message}).`);
    }

    this.apiClient = getAffinityClient(parsed.data.apiKey, parsed.data.baseUrl);
    this.web = makeWebBaseUrlResolver(this.apiClient);
    return this.apiClient;
  }
}

function idArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => Number(v)).filter((n) => Number.isInteger(n));
}

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function createAffinityAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): AffinityAdapter {
  if (!input.credentialsId) {
    throw new Error(
      'Affinity adapter requires credentialsId — wire pipeline_output.credentials_id (out-flow) through getAdapter.',
    );
  }
  return new AffinityAdapter({
    teamId: input.teamId,
    credentialsId: input.credentialsId,
  });
}

// Satisfy the structural Adapter contract at module scope (compile-time check).
const _typecheck: (input: { teamId: TeamId; credentialsId?: string }) => Adapter =
  createAffinityAdapter;
void _typecheck;
