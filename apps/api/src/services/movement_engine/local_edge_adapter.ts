// The ENGINE as a local node's adapter.
//
// `write deduped-[:companies]-> { unique by (FUZZY `name`), … }` writes into an
// edge of a node this run built. The destination is the run's own graph, so
// there is no system to call — but everything that makes a write a write is
// still wanted: the identity search, the arbitration, the fill/append modes,
// the create/update/noop outcomes, the per-field provenance. All of that lives
// in the write path already, above an `Adapter`. So the honest way to get it is
// not a second write path but a second ADAPTER: one whose store is the edge's
// own landings array.
//
// Two things are this module's own, because they belong to the engine rather
// than to any one call site:
//
//   • the CANDIDATE BLOCK — which landings are worth arbitrating over. An exact
//     component blocks on normalised equality; a FUZZY one blocks on shared
//     DISTINCTIVE tokens, the words left after the ones that name a KIND of
//     company rather than a company ("Actions AI" and "Faction AI" share only
//     `ai`, so they never meet; "Faction AI" and "Faction" share `faction`, so
//     the judge gets to decide on the other fields).
//   • the CAP — a block is bounded, because the judge's prompt is.
//
// Arbitration itself is NOT here: `arbitrateEntityCandidates` is the one
// decision procedure, and a landing on a local edge gets the same one a record
// in a CRM gets.

import {
  BASE_RUNTIME_CAPABILITIES,
  unsupportedAssociation,
  type Adapter,
  type ExternalRecordRef,
  type ReadInput,
  type ResolveEntityInput,
  type ResolveEntityResult,
  type UpdateInput,
  type UpdateResult,
  type WriteInput,
  type WriteResult,
} from '../translation_graph/adapter';
import type { UniquenessConstraints } from '../translation_graph/uniqueness';
import type { LockRequest } from './effect_locks';
import type { Binding, LocalLandingShape, NodeEdge } from './expression';

/** The `adapterType` a write into the run's own graph records. Compared, never
 *  parsed — it names the absence of a system, not one more of them. */
export const LOCAL_ADAPTER_TYPE = 'local';

/** How many landings one write may arbitrate over. The judge reads every
 *  candidate, so an unbounded block is an unbounded prompt; beyond this the
 *  write takes the first `n` and SAYS SO on its trace rather than silently
 *  considering fewer. */
export const LOCAL_CANDIDATE_CAP = 20;

/**
 * Words that name a KIND of thing rather than a thing. They are dropped before
 * two names are compared, because sharing one is not evidence of anything:
 * every second company in a portfolio is an `AI` or a `GmbH`.
 *
 * Legal suffixes first, then the sector words that behave identically.
 */
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  'inc',
  'ltd',
  'llc',
  'gmbh',
  'ag',
  'sas',
  'plc',
  'co',
  'corp',
  'corporation',
  'limited',
  'holdings',
  'ai',
  'labs',
  'lab',
  'technologies',
  'technology',
  'tech',
  'software',
  'robotics',
  'systems',
  'solutions',
  'group',
  'ventures',
  'capital',
  'partners',
]);

/** One landing this store owns — a position the run synthesised. */
type LocalLanding = Extract<Binding, { kind: 'nodePosition' }>;

/**
 * The edges a landing this store CREATES starts with: one empty appendable
 * edge per nested node the declaration named, each carrying its own nested
 * names so a write deeper in the tree mints the same way.
 *
 * A landing is a whole node of the declared shape, not a root with its branches
 * cut off — which is what lets `link h -[:founder]-> jane` append rather than
 * fail on an edge nothing could ever have made.
 */
function landingEdges(shape: LocalLandingShape | undefined): Record<string, NodeEdge> {
  const edges: Record<string, NodeEdge> = {};
  for (const [name, nested] of Object.entries(shape?.edges ?? {})) {
    edges[name] = { kind: 'landed', landings: [], landingShape: nested };
  }
  return edges;
}

/** A landing's field names in declaration order: what its declaration names,
 *  then anything a write carried beyond it (an ADDRESS-typed edge declares
 *  nothing, so there the writes' own order is the only order there is). */
function landingFieldOrder(declared: readonly string[], written: Record<string, unknown>): string[] {
  return [...declared, ...Object.keys(written).filter((f) => !declared.includes(f))];
}

const landingNumbers = new WeakMap<LocalLanding, number>();
let nextLandingNumber = 0;

/**
 * What an update of a landing the run holds locks: the record itself, as an
 * update of a system's record holds that record. A landing's only address is
 * being itself — its index differs per edge, and the same node can sit on two
 * — so the lock is named by the node's identity, and every update of it waits
 * for every other whichever name or edge reached it.
 */
export function localRecordLock(landing: LocalLanding): LockRequest {
  let number = landingNumbers.get(landing);
  if (number === undefined) {
    number = nextLandingNumber++;
    landingNumbers.set(landing, number);
  }
  return { name: `record ${JSON.stringify(LOCAL_ADAPTER_TYPE)} landing ${number}`, mode: { kind: 'exclusive' } };
}

/** Trim, case fold, collapse whitespace. A multi-valued field folds to its
 *  values in order, so a list and a scalar compare by the same rule. */
export function normaliseIdentityValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const flat = Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined).join(' ') : value;
  return String(flat).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Equality for an EXACT `unique by` component. An absent asserted value
 *  identifies nothing, so it matches nothing — the rule the shared exactness
 *  arbitration already applies. */
export function identityValuesEqual(a: unknown, b: unknown): boolean {
  const left = normaliseIdentityValue(a);
  return left !== '' && left === normaliseIdentityValue(b);
}

// A bare domain used as a name (`oriqx.com`, `pavoai.com` — a real prod
// shape when the display name falls back to the site) shares the word "com"
// with every other bare domain under plain punctuation stripping, and so
// blocked as a fuzzy candidate of all of them. Listing TLDs in
// `GENERIC_TOKENS` would fight that battle forever; the suffix is a label
// POSITION, not a word, so the final label is dropped by position. (`co` in
// `foo.co.uk` still goes through `GENERIC_TOKENS`, where it already is.)
const HOSTNAME_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
const HOSTNAME_TLD = '[a-z]{2,}';
const HOSTNAME_SHAPE = new RegExp(
  `^(?:[a-z][a-z0-9+.-]*://)?(?:www\\.)?(${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*)\\.(${HOSTNAME_TLD})(?:/.*)?$`,
  'i',
);

/** The registrable-domain labels of a hostname-shaped value (scheme and a
 *  leading `www` stripped, the final TLD-shaped label dropped), or `null`
 *  when the value isn't hostname-shaped — the caller then tokenises it as
 *  plain text. The TLD test (letters only, 2+ of them) keeps this from
 *  firing on an ordinary dotted token such as a version number. */
function hostnameLabels(normalisedValue: string): string[] | null {
  const match = HOSTNAME_SHAPE.exec(normalisedValue);
  return match ? match[1].split('.') : null;
}

/** The distinctive words of a value: case folded, punctuation stripped, the
 *  kind-naming ones dropped. A hostname-shaped value tokenises from its
 *  registrable-domain labels instead of the whole string (see
 *  `hostnameLabels`), so a bare domain fallback name doesn't block every
 *  other domain under the same TLD. */
export function distinctiveTokens(value: unknown): string[] {
  const normalised = normaliseIdentityValue(value);
  const labels = hostnameLabels(normalised);
  const source = labels !== null ? labels.join(' ') : normalised;
  return source
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !GENERIC_TOKENS.has(word));
}

/**
 * The FUZZY block: do these two values share a distinctive word?
 *
 * When one side has no distinctive word at all — a name that is nothing but
 * kind words — there is nothing to be similar BY, so the only honest answer is
 * exactness. Overlap would otherwise be decided by the very tokens that were
 * dropped for carrying no evidence.
 */
export function sharesDistinctiveToken(a: unknown, b: unknown): boolean {
  const left = distinctiveTokens(a);
  const right = distinctiveTokens(b);
  if (left.length === 0 || right.length === 0) return identityValuesEqual(a, b);
  const pool = new Set(left);
  return right.some((token) => pool.has(token));
}

/** Does this landing satisfy some whole AND-branch of the write's identity? */
function landingBlocks(
  constraints: UniquenessConstraints,
  asserted: Record<string, unknown>,
  data: Record<string, unknown>,
): boolean {
  return constraints.any.some(
    (branch) =>
      branch.all.length > 0 &&
      branch.all.every((entry) =>
        entry.fuzzy === true
          ? sharesDistinctiveToken(asserted[entry.field], data[entry.field])
          : identityValuesEqual(asserted[entry.field], data[entry.field]),
      ),
  );
}

/**
 * The engine's reach into a landing that is a REFERENCE — a record in a system
 * a graph literal holds (or a `link` appended), not one the run synthesised.
 * Reading it is a live read through its own system, and changing it is a
 * write to the real record, exactly as through any other name holding it.
 */
export interface LocalEdgeReferences {
  /** The referenced record's current values for these fields, read live. */
  read(landing: Binding, fieldIds: readonly string[]): Promise<Record<string, unknown>>;
  /** Update the real record behind the reference. Absent for a store that
   *  only finds (a `match`). */
  update?(landing: Binding, write: UpdateInput): Promise<UpdateResult>;
}

/** The adapter over one local edge, plus the two things the engine needs back
 *  that no adapter interface carries: which landing a write touched, and
 *  whether the candidate block was cut short. */
export interface LocalEdgeStore {
  adapter: Adapter;
  /** The landing behind a write result's id — how the engine reaches the
   *  position it just created or merged into, or the referenced record it
   *  updated. */
  landingOf(externalId: string | undefined): Binding | undefined;
  /** Whether a candidate search stopped at `LOCAL_CANDIDATE_CAP`, leaving
   *  landings unexamined. A METHOD rather than a property: it is answered by
   *  the search, which runs after the store is built, and a snapshot taken
   *  before then would read `false` for every write. */
  capped(): boolean;
}

/**
 * An adapter over `edge.landings`.
 *
 * Identity: a landing's id is its INDEX on the edge. Landings are appended and
 * never removed or reordered, so the index is stable for the life of the run —
 * and a match therefore never moves a record, which is the property the whole
 * merge depends on.
 *
 * A landing the run SYNTHESISED is this store's own: compared by its fields
 * and merged into in place. Any other landing — a graph literal's reference, a
 * `link`ed handle — is a record in a system, held as itself (TypeScript's
 * object reference). With `references` it is a candidate like any other,
 * compared by its live values, and a merge into it is an update of the real
 * record through its own system — never of a local copy, which would be a
 * write claiming to change something it never touched. Without `references`
 * such landings stay on the edge, untouched and unconsidered.
 */
export function localEdgeAdapter(input: {
  edge: Extract<NodeEdge, { kind: 'landed' }>;
  /** The edge's authored name — what a landing created here records it
   *  landed on, and diagnostics. */
  edgeName: string;
  references?: LocalEdgeReferences;
}): LocalEdgeStore {
  const { landings } = input.edge;
  const { references } = input;
  let capped = false;

  const anyLandingAt = (externalId: string | undefined): Binding | undefined => {
    if (externalId === undefined) return undefined;
    const index = Number(externalId);
    if (!Number.isInteger(index)) return undefined;
    return landings[index];
  };
  const landingAt = (externalId: string | undefined): LocalLanding | undefined => {
    const landing = anyLandingAt(externalId);
    return landing?.kind === 'nodePosition' ? landing : undefined;
  };
  /** A landing that is a reference, where this store may reach one. */
  const referenceAt = (externalId: string | undefined): Binding | undefined => {
    const landing = anyLandingAt(externalId);
    return references !== undefined && landing !== undefined && landing.kind !== 'nodePosition' ? landing : undefined;
  };

  const refFor = (index: number, data: Record<string, unknown>, recordType: string): ExternalRecordRef => ({
    adapterType: LOCAL_ADAPTER_TYPE,
    externalId: String(index),
    recordType,
    data,
  });

  /** The fields a candidate is compared and merged by: what the write asserts,
   *  and every field its identity names. */
  const fieldsOf = (resolve: ResolveEntityInput): string[] => [
    ...new Set([
      ...Object.keys(resolve.record),
      ...resolve.constraints.any.flatMap((branch) => branch.all.map((entry) => entry.field)),
    ]),
  ];

  const notASource = (what: string): Error =>
    new Error(
      `'${input.edgeName}' is an edge of a node this run built — it holds what the run wrote, so ${what} off it goes through the node's own landings, not through an adapter`,
    );

  const adapter: Adapter = {
    adapterType: LOCAL_ADAPTER_TYPE,
    supportedTriggers: [],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,

    async listEntryPoints() {
      return [];
    },
    // Nothing describes a local edge: the landing type is a checker-side fact,
    // and the run holds values whatever typed them. No descriptor means no
    // required-field gate and no cardinality coercion, which is correct — the
    // checker already validated the body against the edge's landing type.
    async describe() {
      return null;
    },

    async resolveEntity(resolve: ResolveEntityInput): Promise<ResolveEntityResult> {
      const candidates: ExternalRecordRef[] = [];
      for (let index = 0; index < landings.length; index++) {
        const landing = landings[index];
        if (landing === undefined) continue;
        let data: Record<string, unknown>;
        if (landing.kind === 'nodePosition') data = landing.fields;
        else if (references !== undefined) data = await references.read(landing, fieldsOf(resolve));
        else continue;
        if (!landingBlocks(resolve.constraints, resolve.record, data)) continue;
        candidates.push(refFor(index, data, resolve.recordType));
        if (candidates.length >= LOCAL_CANDIDATE_CAP) {
          capped = index < landings.length - 1;
          break;
        }
      }
      return { candidates };
    },

    async createRecord(write: WriteInput): Promise<WriteResult> {
      const landing: LocalLanding = {
        kind: 'nodePosition',
        landedOn: input.edgeName,
        fields: { ...write.fields },
        fieldOrder: landingFieldOrder(input.edge.landingShape?.fields ?? [], write.fields),
        fieldProvenance: {},
        edges: landingEdges(input.edge.landingShape),
      };
      landings.push(landing);
      return refFor(landings.length - 1, landing.fields, write.recordType);
    },

    async updateRecord(write: UpdateInput): Promise<UpdateResult> {
      const reference = referenceAt(write.externalId);
      if (reference !== undefined) {
        if (references?.update === undefined) throw notASource('updating a referenced record');
        const updated = await references.update(reference, write);
        if ('notFound' in updated) return updated;
        // The id stays this store's, so the engine finds the landing it hit.
        return { ...updated, adapterType: LOCAL_ADAPTER_TYPE, externalId: write.externalId, recordType: write.recordType };
      }
      const landing = landingAt(write.externalId);
      if (landing === undefined) return { notFound: true };
      // In place: the landing object IS the binding every earlier read of it
      // holds, so a merge is visible to the whole run without anything being
      // re-read or re-bound.
      Object.assign(landing.fields, write.fields);
      landing.fieldOrder = landingFieldOrder(landing.fieldOrder, write.fields);
      return {
        ...refFor(Number(write.externalId), landing.fields, write.recordType),
        association: unsupportedAssociation(write),
      };
    },

    async readRecord(read: ReadInput): Promise<Record<string, unknown> | null> {
      const reference = referenceAt(read.externalId);
      if (reference !== undefined && references !== undefined) {
        return references.read(reference, read.fieldIds ?? []);
      }
      return landingAt(read.externalId)?.fields ?? null;
    },

    async deleteRecord() {
      throw notASource('deleting a record');
    },
    async getFieldValue() {
      throw notASource('reading a field');
    },
    async getRelated() {
      throw notASource('traversing an edge');
    },
  };

  return {
    adapter,
    landingOf: (externalId) => landingAt(externalId) ?? referenceAt(externalId),
    capped: () => capped,
  };
}
