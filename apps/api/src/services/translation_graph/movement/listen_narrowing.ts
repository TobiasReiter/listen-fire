// Event-address narrowing, host side — the positions a movement's SIGNATURE
// names, walked and grafted.
//
// A LISTEN IS SHORTHAND FOR A WHERE, and a SIGNATURE NAMES THE FULL ADDRESS.
// `movement intake(e: <at-[:`Record Created` WHERE `base` == "appDevLoop" AND
// `table` == "tblDeals"]->>)` declares the type it accepts; `listen to at {
// base: "appDevLoop", table: "tblDeals", … } fire intake` produces one. A listen
// whose address differs is a type error — the same rule as any call, where an
// argument must match a parameter. Nothing here is special to events.
//
// So this module grafts what the SIGNATURES name, not what the listens watch.
// The listens are checked against the result; they are not what brings it into
// being. That inversion is the fix for two MEASURED live bugs (`b536a1a79`):
//
//   - the retarget was keyed on the META TYPE (`edge.target !== from`), so once
//     listen 1 pointed `record` at Deals, listen 2 found no edge still on the
//     meta type and NO-OPPED. The first listen won and the second movement read
//     the first's table. Now each address gets its OWN copy of the event
//     variants, so there is no shared edge to win.
//   - the graft was keyed on the table's DISPLAY NAME, which is unique only
//     within a base, and `graftPosition` short-circuits on `if (positions[name]
//     !== undefined) return` — so two bases each with a `Deals` silently
//     DISCARDED the second descriptor. Now identity is `eventAddressKey`, an
//     opaque token over the whole address, and the display is a separate field
//     that is allowed to collide because nothing keys on it.
//
// Both bugs were one defect: a fabricated NAME doing an identity's job. Position
// -per-listen then falls out rather than being built — two addresses are two
// keys are two positions, exactly as `-[:Base WHERE `Name` == "CRM"]->` and
// `-[:Base WHERE `Name` == "Ops"]->` need no "per-base" mechanism.
//
// Three properties this file still exists to hold:
//
//   - THE ADDRESS IS A PATH, and the adapter declares it (`ListenConfigKey.
//     narrows`). Read as one hop, "narrowed by (base, table)" would have to know
//     the valid pairs — a `listTables` per base, the 1+N that started this plan.
//     As a path the base resolves first (1 call), then only that base's tables
//     (1 call). Never 1+N.
//   - IT IS THE SAME WALK A MOVEMENT DOES. `walkTo` is `walkPath` + `stepTo`,
//     the machinery the polymorphic-narrowing hop already runs; the WHERE is a
//     real `Expression` evaluated by the shared filter unit. No second walker,
//     no second semantics.
//   - IT DEGRADES TO SILENCE. An address that doesn't resolve grafts nothing,
//     the signature then resolves to no position, and the checker stays quiet —
//     never states something wrongly.

import {
  EVENT_ACTION_FIELD,
  RECORD_DELETED_ACTION,
  eventAddressDisplay,
  eventAddressKey,
  isEnumType,
  narrowingPrefixKey,
  type EdgeSchema,
  type EventAddressRef,
  type InstanceSchema,
  type PositionSchema,
} from 'movement-lang';

import type { Expression } from '#shared/expression/types';
import type { ListenConfigKey } from 'movement-engine/services/translation_graph/adapter';
import type { SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';
import type { CachedAdapterInstance } from './instance_cache';

import { instanceSchemaFromDescriptors } from 'movement-engine/services/translation_graph/movement/schema_projection';

export interface EventNarrowingInput {
  adapterType: string;
  schema: InstanceSchema;
  /** The adapter's declared listen-config keys — the `narrows` ones form the
   *  address, in declaration order. */
  listenConfig: readonly ListenConfigKey[];
  /** The event addresses the program's movement SIGNATURES declare against this
   *  instance (`referencedEventAddresses`). */
  addresses: readonly EventAddressRef[];
  /** The full node list, for the descriptor→position projection. */
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
  /** Walk a path from the meta node (`CachedAdapterInstance.walkTo`). */
  walkTo: CachedAdapterInstance['walkTo'];
  /** The members one hop on from a path (`CachedAdapterInstance.membersAt`) —
   *  what an address may legally pin at that hop. */
  membersAt: CachedAdapterInstance['membersAt'];
}

/** One hop of an address, as the walk it stands for. */
export type AddressStep = { type: 'edge'; edgeTypeId: string; expressionFilter: Expression };

/**
 * The hop a `narrows` key IS, pinned to one value.
 *
 * The same AST a `WHERE` in the source parses to, so the shared filter unit
 * evaluates it by the one semantics — no author-time special case. `property`
 * is what `pureLeafReads`/`leafReadKey` key the member's data read by, so
 * `selectMember` finds `Id` in the position the adapter published and compares
 * it to the address's value.
 *
 * Exported for `listen_address.ts` — resolving a listen's full address at
 * provisioning is THE SAME WALK, so it must be the same step.
 */
export function hopStep(input: { narrows: NonNullable<ListenConfigKey['narrows']>; value: string }): AddressStep {
  return {
    type: 'edge',
    edgeTypeId: input.narrows.collection,
    expressionFilter: {
      type: 'compare',
      op: 'eq',
      left: { type: 'property', propertyTypeId: input.narrows.matchField },
      right: { type: 'static', value: input.value },
    },
  };
}

/**
 * The schema with one narrowed event position per signature address. THE EVENT
 * IS JUST A NODE: each grafted position is a COPY OF THE EVENT NODE the
 * address names, its `record` edge landing on the table the hop pins walk to,
 * its `requiresLiveRecord` edges dropped when the `action` pin is the deleted
 * kind. An address that leaves the node's `action` axis unpinned grafts a
 * union over its per-action narrowings — so an `IS` test (an intersection:
 * subject pins ∪ test pins) always lands on a grafted variant. Nothing is
 * synthesized eagerly and nothing is named: every key is the canonical
 * address, minted on demand from what the program references.
 *
 * Copy-on-write: the input schema is shared cache state. No event edges, no
 * addresses, or nothing resolvable ⇒ the input schema comes back unchanged.
 */
export async function narrowEventPositions(
  input: EventNarrowingInput,
): Promise<{ schema: InstanceSchema; notes: string[] }> {
  const notes: string[] = [];
  const hops = input.listenConfig.filter((key) => key.narrows !== undefined);
  const eventNames = new Set((input.schema.eventPositions ?? []).map((e) => e.position));
  if (input.addresses.length === 0 || eventNames.size === 0) {
    return { schema: input.schema, notes };
  }
  // The type the record edge narrows FROM: where a hop address lands. An event
  // edge pointing at it is what each grafted copy retargets.
  const narrowedFrom = hops[hops.length - 1]?.narrows?.collection;

  let schema = input.schema;

  // What may legally be pinned at each hop — the address's variance surface,
  // and where a typo dies. Published whether or not the record graft below
  // succeeds: a typo'd address is EXACTLY the case that grafts nothing, so
  // making the options wait on the graft would hide the error behind its own
  // symptom.
  if (hops.length > 0) {
    const values = await narrowingValues({
      hops,
      addresses: input.addresses,
      membersAt: input.membersAt,
    });
    if (Object.keys(values).length > 0) {
      schema = { ...schema, eventNarrowingValues: values };
    }
  }

  const walked = new Map<string, string | null>();

  for (const address of input.addresses) {
    if (!eventNames.has(address.event)) continue; // not an event edge — nothing to graft
    const source = schema.positions[address.event];
    if (source === undefined) continue; // the node isn't described — silence, never a guess

    const actionType = source.properties[EVENT_ACTION_FIELD];
    const actionEnum =
      !Array.isArray(actionType) && isEnumType(actionType) ? actionType.options : undefined;

    // Split the pins: the declared address hops walk; an `action` pin narrows
    // the node's own axis. A pin on anything else addresses nothing this
    // machinery can vouch for — no graft, and the signature stays silent.
    const { [EVENT_ACTION_FIELD]: actionPin, ...restPins } = address.narrowing;
    const hopPins: Record<string, string> = {};
    let alien = false;
    for (const [key, value] of Object.entries(restPins)) {
      if (hops.some((hop) => hop.key === key)) hopPins[key] = value;
      else alien = true;
    }
    if (alien) continue;
    if (actionPin !== undefined && (actionEnum === undefined || !actionEnum.includes(actionPin))) {
      // Pins a kind the node's axis doesn't offer — `never`, or a typo that
      // already died at the enum (`checkAddressPins`). Grafts nothing.
      continue;
    }

    // A WIDE address over a node with no action axis IS the node the
    // projection already minted — nothing to graft.
    if (Object.keys(address.narrowing).length === 0 && actionEnum === undefined) continue;

    const addressKey = eventAddressKey({ event: address.event, narrowing: address.narrowing });
    if (
      (schema.unions?.[addressKey] !== undefined)
      || (addressKey !== address.event && schema.positions[addressKey] !== undefined)
    ) {
      continue; // this exact address is already grafted — the SAME address, not a name clash
    }

    // The record position, keyed by the walk that reaches it. Two signatures
    // pinning one table share it; two bases each with a `Deals` do not.
    let recordTarget: string | undefined;
    if (Object.keys(hopPins).length > 0) {
      const steps = addressOf({ hops, narrowing: hopPins });
      if (!steps) continue; // the address doesn't name every hop — no narrowing
      const recordKey = `${input.adapterType}::record::${JSON.stringify(steps)}`;
      if (!walked.has(recordKey)) {
        try {
          const descriptor = await input.walkTo(steps);
          walked.set(recordKey, descriptor ? descriptor.displayName : null);
          if (descriptor) {
            const position = projectRecordPosition({
              adapterType: input.adapterType,
              entryPoints: input.entryPoints,
              descriptor,
              key: recordKey,
            });
            if (position === undefined) {
              walked.set(recordKey, null);
            } else {
              schema = { ...schema, positions: { ...schema.positions, [recordKey]: position } };
            }
          }
        } catch (err) {
          walked.set(recordKey, null);
          notes.push(
            `${input.adapterType}: walking to the table '${address.movement}' is typed against failed (${err instanceof Error ? err.message : String(err)}) — the event's record is not narrowed`,
          );
        }
      }
      if (walked.get(recordKey) == null) continue; // landed nowhere — degrade to silence
      recordTarget = recordKey;
    }

    schema = graftAddress({
      schema,
      source,
      address,
      addressKey,
      ...(actionEnum !== undefined ? { actionEnum } : {}),
      ...(narrowedFrom !== undefined ? { from: narrowedFrom } : {}),
      ...(recordTarget !== undefined ? { to: recordTarget } : {}),
    });
  }

  return { schema, notes };
}

/**
 * The address, as the walk it stands for. Every declared hop must be pinned or
 * there is no address — a partially-named path would walk to the wrong node,
 * which is worse than not narrowing.
 */
function addressOf(input: {
  hops: readonly ListenConfigKey[];
  narrowing: Record<string, string>;
}): AddressStep[] | undefined {
  const steps: AddressStep[] = [];
  for (const hop of input.hops) {
    const value = input.narrowing[hop.key];
    const narrows = hop.narrows;
    if (value === undefined || narrows === undefined) return undefined;
    steps.push(hopStep({ narrows, value }));
  }
  return steps.length > 0 ? steps : undefined;
}

/**
 * What may legally be pinned at each address hop, keyed by the PREFIX it is
 * legal under — `InstanceSchema.eventNarrowingValues`, the surface that turns
 * `` `table` == "tblDaels" `` into an enum error with a did-you-mean instead of
 * silence.
 *
 * THE VARIANCE IS THE MODEL. This is the address's own walk, one hop shorter:
 * the options for `table` under `{ base: X }` are the members reachable at
 * `-[:Base WHERE `Id` == "X"]->`. So it costs nothing the record graft wasn't
 * already paying — the root hop for the bases, X's hop for X's tables — and a
 * base no signature names is never opened. That is what keeps diagnosing a typo
 * off the `listTables`-per-base fanout.
 *
 * Descent stops at a pin this hop doesn't offer: a typo'd base makes its tables
 * unknowable, so they are not published and the checker says nothing about them
 * either. One error, at the hop that is actually wrong.
 *
 * A hop that yields NO members publishes nothing. Empty means "we couldn't see",
 * not "nothing is legal", and an empty enum would turn a blind walk into an
 * accusation against every value.
 *
 */
async function narrowingValues(input: {
  hops: readonly ListenConfigKey[];
  addresses: readonly EventAddressRef[];
  membersAt: EventNarrowingInput['membersAt'];
}): Promise<Record<string, Record<string, string[]>>> {
  const values: Record<string, Record<string, string[]>> = {};
  // One walk per (prefix, hop) however many signatures share it — two movements
  // on one table ask the same question once.
  const optionsAt = new Map<string, string[]>();

  for (const address of input.addresses) {
    const pinned: Record<string, string> = {};
    const steps: AddressStep[] = [];
    for (const hop of input.hops) {
      const narrows = hop.narrows;
      if (narrows === undefined) break;
      const prefix = narrowingPrefixKey(pinned);
      const memo = `${prefix}::${hop.key}`;
      let options = optionsAt.get(memo);
      if (options === undefined) {
        const members = await input.membersAt({ steps, recordType: narrows.collection });
        options = members.flatMap((member) => {
          const value = (member.data as Record<string, unknown> | undefined)?.[narrows.matchField];
          return typeof value === 'string' ? [value] : [];
        });
        optionsAt.set(memo, options);
      }
      if (options.length === 0) break;
      (values[prefix] ??= {})[hop.key] = options;

      const value = address.narrowing[hop.key];
      if (value === undefined || !options.includes(value)) break;
      pinned[hop.key] = value;
      steps.push(hopStep({ narrows, value }));
    }
  }
  return values;
}

/** Project the landed descriptor into a position, under an OPAQUE key with the
 *  table's own name carried as display. The author never writes this key — the
 *  record edge is the only way in — and the name it reads as is free to repeat
 *  across bases precisely because nothing keys on it. */
function projectRecordPosition(input: {
  adapterType: string;
  entryPoints: { typeId: string; displayName: string; writable: boolean; readable: boolean }[];
  descriptor: SchemaTypeDescriptor;
  key: string;
}): PositionSchema | undefined {
  const syntheticTypeId = `${input.key}::type`;
  const projected = instanceSchemaFromDescriptors({
    adapterType: input.adapterType,
    entries: [
      ...input.entryPoints,
      { typeId: syntheticTypeId, displayName: input.key, readable: true, writable: false },
    ],
    descriptors: new Map([[syntheticTypeId, input.descriptor]]),
    supportsInPlaceUpdate: false,
  });
  const position = projected.schema.positions[input.key];
  if (position === undefined) return undefined;
  return { ...position, displayName: input.descriptor.displayName };
}

/**
 * One address → its own event position(s): a copy of the EVENT NODE with the
 * record edge retargeted at the table the hop pins walk to, the
 * `requiresLiveRecord` edges dropped under a deleted `action` pin, and — when
 * the address leaves an existing action axis unpinned — a union over the
 * per-action narrowings, so `IS` lands on a grafted variant. All keyed by the
 * canonical address, so two addresses never share an edge — which is what the
 * retired meta-type `retarget` got wrong.
 */
function graftAddress(input: {
  schema: InstanceSchema;
  /** The event node's own (projection-minted) position — what every copy copies. */
  source: PositionSchema;
  address: EventAddressRef;
  addressKey: string;
  /** The node's `action` enum options, when it declares that axis. */
  actionEnum?: readonly string[];
  /** The meta type the record edge points at before narrowing (`Table`). */
  from?: string;
  /** The walked record position's key, when the address pinned the hops. */
  to?: string;
}): InstanceSchema {
  const { event, narrowing } = input.address;
  const positions = { ...input.schema.positions };
  const unions = { ...(input.schema.unions ?? {}) };
  const unionDisplayNames = { ...(input.schema.unionDisplayNames ?? {}) };

  const copyFor = (pins: Record<string, string>): PositionSchema => {
    const recordGone = pins[EVENT_ACTION_FIELD] === RECORD_DELETED_ACTION;
    const edges: Record<string, EdgeSchema> = {};
    for (const [edgeName, edge] of Object.entries(input.source.edges)) {
      // The one real behaviour the retired delete VARIANT carried, keyed on
      // the pin: the record is gone, so an edge that must hydrate it goes.
      if (recordGone && edge.requiresLiveRecord === true) continue;
      edges[edgeName] =
        input.to !== undefined && edge.target === input.from
          ? { ...edge, target: input.to }
          : edge;
    }
    return {
      ...input.source,
      edges,
      displayName: eventAddressDisplay({ event, narrowing: pins }),
    };
  };

  if (input.actionEnum === undefined || narrowing[EVENT_ACTION_FIELD] !== undefined) {
    // The address pins the whole axis (or the node has none): one position.
    positions[input.addressKey] = copyFor(narrowing);
  } else {
    // The axis is left open: the address is the union of its action
    // narrowings, each its own grafted position — which is what lets a body's
    // `IS` (subject pins ∪ test pins) resolve without restating the address.
    const variantKeys: string[] = [];
    for (const action of input.actionEnum) {
      const pins = { ...narrowing, [EVENT_ACTION_FIELD]: action };
      const key = eventAddressKey({ event, narrowing: pins });
      variantKeys.push(key);
      if (positions[key] === undefined) positions[key] = copyFor(pins);
    }
    unions[input.addressKey] = variantKeys;
    if (input.addressKey !== event) {
      unionDisplayNames[input.addressKey] = eventAddressDisplay(input.address);
    }
  }

  return {
    ...input.schema,
    positions,
    ...(Object.keys(unions).length > 0 ? { unions } : {}),
    ...(Object.keys(unionDisplayNames).length > 0 ? { unionDisplayNames } : {}),
  };
}
