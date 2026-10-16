// An event address: what identifies it, and — separately — what it reads as.
//
// `movement intake(e: <at-[:`Record Change` WHERE `action` == "record.created" AND `base` == "appDevLoop" AND
// `table` == "tblDeals"]->>)` — a type annotation is an ADDRESS, and the
// signature names the FULL address.
//
// IDENTITY IS A KEY, NOT A NAME, and that separation is the whole file.
//
// The measured bug this closes is magic naming. `refinements.ts` fabricates
// `${typeName} "${selected}"` and then uses that one string as map key, as
// author-facing text, AND as a uniqueness claim — so two bases each holding a
// `Deals` produce one string, `graftPosition`'s `if (positions[name] !== undefined)
// return` reads it as "already grafted, reuse it", and base 2's descriptor is
// silently discarded. The same file already holds the honest counter-example:
// `refinementKey` is `JSON.stringify([type, canonical(expr)])` — an opaque token
// that is only ever COMPARED, never parsed, never displayed, and therefore
// cannot collide.
//
// The test is: is it PARSED, or only COMPARED? `CRM — Companies` was magic
// because `demandSeed` substring-matched it — the convention had to HOLD for the
// checker to work. So:
//
//   - `eventAddressKey` is the IDENTITY. Opaque. Derived identically by the
//     checker (resolving a signature) and the host (grafting the position it
//     names), which is what makes them unable to drift — the `refinementKey`
//     shape. NOTHING may parse it or depend on its internal structure.
//   - `eventAddressDisplay` is the DISPLAY. A separate string, carried on
//     `PositionSchema.displayName`, used only by diagnostics. It may collide,
//     be ambiguous, be re-worded — it means nothing to the machine.
//
// POSITION-PER-LISTEN FALLS OUT of this form, rather than being built. Identity
// IS the address, so two listens have two addresses → two keys → two positions,
// automatically. Nothing asks "which listen?" and there is no per-listen
// bookkeeping — exactly as `-[:Base WHERE `Name` == "CRM"]->` and `-[:Base WHERE
// `Name` == "Ops"]->` need no "per-base" mechanism. The current code needs one
// only BECAUSE a fabricated name collapses distinct addresses onto one string.
//
// Why an address is a MAP of pinned values and not the predicate it was written
// as: the two sides do not hold the same thing. A signature holds a WHERE; a
// listen holds `{ base: "appDevLoop", table: "tblDeals" }`. They agree on the
// values and nothing else, so the values are the address. That is what the
// adapter already declares with `ListenConfigKey.narrows` — the config key IS
// the hop — and why `describeRecordChange` publishes `base`/`table` as real
// event-node properties: the same values narrow both.

import type { Expression } from '@listen-fire/shared/expression/types';
import { isPurePredicate, leafReadKey, pureLeafReads } from '@listen-fire/shared/expression/filter';
import { since, type LanguageVersion } from '../language_version';
import { parseTraversalPath } from '../service/selectors';

/**
 * An event address: the event edge the signature walks, plus what it pins.
 * An empty `narrowing` is the WIDE type — `<at-[:`Record Change`]->>`, which
 * any listen delivering that event satisfies.
 */
export interface EventAddress {
  /** The event edge's name — the event NODE it lands on (`Record Change`,
   *  `Message Received`). */
  event: string;
  /** The address, as the values it pins: config key → literal. */
  narrowing: Record<string, string>;
}

/** The address's pins in one canonical order — the only ordering either side
 *  may assume, and the reason two spellings of one address are one key. */
function pinsOf(address: EventAddress): Array<[string, string]> {
  return Object.entries(address.narrowing)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * THE IDENTITY of the position an event address names — the key it lives under
 * in `InstanceSchema.positions`.
 *
 * Opaque by contract. Compare it; never parse it, never show it to an author,
 * never derive one by hand. Checker and host both come here, which is what makes
 * the two sides unable to disagree about which position a signature means.
 *
 * An address that pins nothing IS the event type — `<at-[:`Record Change`]->>`
 * and the event position the projection already minted are the same type — so
 * the wide address keys as that position rather than minting a parallel one.
 */
export function eventAddressKey(address: EventAddress): string {
  const pins = pinsOf(address);
  if (pins.length === 0) return address.event;
  return JSON.stringify([address.event, pins]);
}

/**
 * The EVENT NAME a key was minted from — the inverse of `eventAddressKey`'s
 * event half, and it lives HERE so the key stays opaque to everyone else. Its
 * consumers only ever compare it; the moment one of them pulled the name out
 * itself, the key would be a magic string that is PARSED rather than compared.
 *
 * This exists because the engine stamps an event position's `recordType` with
 * the key, and any name resolution scoped by type then has to ask which type
 * that is. An UNPINNED key already IS the event name, which is why adapters
 * whose events pin nothing (Granola, an unnarrowed Attio event) resolve
 * correctly by COINCIDENCE — and why Airtable, which always pins base and
 * table, never did.
 *
 * A string this module did not mint is returned unchanged: it is an ordinary
 * type name, and saying so is the honest answer.
 */
export function eventAddressEventName(key: string): string {
  if (!key.startsWith('[')) return key;
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') return parsed[0];
  } catch {
    // Not a key we minted — fall through to the verbatim name.
  }
  return key;
}

/**
 * THE IDENTITY of an address PREFIX — what the walk has pinned so far, and the
 * key the options for the NEXT hop are filed under
 * (`InstanceSchema.eventNarrowingValues`).
 *
 * `eventAddressKey`'s contract, one level down: opaque, derived identically by
 * the host (publishing the options) and the checker (checking a pin against
 * them), only ever COMPARED.
 *
 * The EVENT is deliberately not part of it. Which bases exist, and which tables
 * a base holds, are facts about where the walk has got to — never about whether
 * you are addressing a create or a delete. Keying by the event would file three
 * identical option sets and invite three chances to disagree.
 */
export function narrowingPrefixKey(pins: Record<string, string>): string {
  return JSON.stringify(pinsOf({ event: '', narrowing: pins }));
}

/**
 * THE DISPLAY of an event address — author-facing text, and nothing else.
 *
 * Carried separately (`PositionSchema.displayName`) so no code path can quietly
 * start depending on it. It is what a listen/signature mismatch reads out, and
 * naming the disagreement ("fires Record Change where action=record.created,
 * table=tblContacts", not "fires Record Change") is the point of the check.
 */
export function eventAddressDisplay(address: EventAddress): string {
  const pins = pinsOf(address);
  if (pins.length === 0) return address.event;
  return `${address.event} where ${pins.map(([key, value]) => `${key}=${value}`).join(', ')}`;
}

/**
 * THE SOURCE FORM of an event address — the type annotation an author would
 * WRITE for it, ready to paste.
 *
 * A third rendering beside the key and the display, and it earns its keep for
 * the same reason they are separate: a rewrite hint that shows "the exact new
 * form" is only worth showing if it compiles, and prose ("Record Change where
 * action=record.created") does not. Derived from the address, never parsed
 * back — nothing may read a program out of this string.
 */
export function eventAddressSource(instance: string, address: EventAddress, languageVersion: LanguageVersion): string {
  // Up to 4 a pin names the event's field bare; from 5 a bare name in a hop
  // is a variable, so the hop takes the alias `e` and each pin reads the
  // field through it, the pins joined by 5's `&&`.
  const v5 = since(languageVersion, 5);
  const pins = pinsOf(address);
  const field = (key: string): string => (!v5 ? `\`${key}\`` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `e.${key}` : `e.\`${key}\``);
  const where =
    pins.length === 0
      ? ''
      : ` WHERE ${pins.map(([key, value]) => `${field(key)} == ${JSON.stringify(value)}`).join(v5 ? ' && ' : ' AND ')}`;
  const alias = v5 && pins.length > 0 ? 'e' : '';
  return `<${instance}-[${alias}:\`${address.event}\`${where}]->>`;
}

/**
 * The values an address pins, or `undefined` when the WHERE is not an address.
 *
 * An address is a conjunction of `` `key` == "literal" `` — the whole grammar,
 * and exactly "canonical-address equality". Anything else (a disjunction, a
 * comparison against a runtime value, a key pinned twice to different values)
 * addresses nothing, and an address that doesn't resolve degrades to SILENCE
 * rather than to a wrong answer.
 *
 * This is not `decidableEquality` returning (which `bdd03ac5b` deleted for being
 * a syntactic special case that had to be widened one shape at a time).
 * Narrowing over MEMBERS still evaluates a predicate — only the host holds the
 * members' data. This reads an ADDRESS, where there are no members: the two
 * sides hold a WHERE and a config map, and the only thing they can agree on is
 * the values.
 */
export function addressNarrowing(
  filter: Expression | undefined,
): Record<string, string> | undefined {
  if (filter === undefined) return {};
  if (!isPurePredicate(filter)) return undefined;
  const narrowing: Record<string, string> = {};
  return collectPins(filter, narrowing) ? narrowing : undefined;
}

function collectPins(expr: Expression, into: Record<string, string>): boolean {
  if (expr.type === 'logical' && expr.op === 'and') {
    return expr.operands.every((child) => collectPins(child, into));
  }
  const pin = pinOf(expr);
  if (pin === undefined) return false;
  const existing = into[pin.key];
  if (existing !== undefined && existing !== pin.value) return false; // pins two values — addresses nothing
  into[pin.key] = pin.value;
  return true;
}

/** `` `key` == "literal" `` (either way round) → the pin it states. */
function pinOf(expr: Expression): { key: string; value: string } | undefined {
  if (expr.type !== 'compare' || expr.op !== 'eq') return undefined;
  const left = sideOf(expr.left);
  const right = sideOf(expr.right);
  if (left?.kind === 'read' && right?.kind === 'literal') {
    return { key: left.name, value: right.value };
  }
  if (right?.kind === 'read' && left?.kind === 'literal') {
    return { key: right.name, value: left.value };
  }
  return undefined;
}

function sideOf(
  expr: Expression,
): { kind: 'read'; name: string } | { kind: 'literal'; value: string } | undefined {
  if (expr.type === 'static') {
    return typeof expr.value === 'string' ? { kind: 'literal', value: expr.value } : undefined;
  }
  // A leaf read of the EVENT NODE's own property. `leafReadKey` is how the
  // shared filter unit names a read, so an address names it the same way.
  if (expr.type !== 'property' && expr.type !== 'edge_property') return undefined;
  const leaves = pureLeafReads(expr);
  if (leaves.length !== 1) return undefined;
  return { kind: 'read', name: leafReadKey(expr) };
}

/**
 * A type marker's hop text (`TypeRef.hopsRaw` / an IS marker's hops) → the
 * event address it names, or undefined when the hops aren't one.
 *
 * ONE hop, always: an event edge is not traversable, so there is nothing to
 * walk on from the event node at author time — the address names the edge and
 * pins it. The SAME reading everywhere it is read (the checker resolving a
 * signature, the pre-scan grounding a graft, the engine evaluating a runtime
 * IS), so no two consumers can disagree about what an address says.
 */
export function eventAddressOfHops(hopsRaw: string, languageVersion?: LanguageVersion): EventAddress | undefined {
  // Read as the program's own slots are: from 5 a WHERE names the event's
  // fields through the hop's alias (`e.action`), which reads as `action`.
  const steps = parseTraversalPath(hopsRaw, languageVersion);
  if (steps === undefined || steps.length !== 1) return undefined;
  const [step] = steps;
  if (step.type !== 'edge') return undefined;
  const narrowing = addressNarrowing(step.expressionFilter);
  if (narrowing === undefined) return undefined; // the WHERE isn't an address
  return { event: step.edgeTypeId, narrowing };
}

/**
 * The narrowing a LISTEN states, given the config keys the adapter declared as
 * address hops (`InstanceSchema.eventNarrowingKeys`).
 *
 * `undefined` when the listen doesn't name the WHOLE address. Every declared hop
 * named, or no narrowing — the same rule the host's walk follows, because a
 * partially-named path lands on the wrong node, which is worse than not
 * narrowing at all.
 */
export function listenNarrowing(input: {
  keys: readonly string[] | undefined;
  config: Record<string, string | undefined>;
}): Record<string, string> | undefined {
  if (input.keys === undefined || input.keys.length === 0) return {};
  const narrowing: Record<string, string> = {};
  for (const key of input.keys) {
    const value = input.config[key];
    if (value === undefined) return undefined;
    narrowing[key] = value;
  }
  return narrowing;
}
