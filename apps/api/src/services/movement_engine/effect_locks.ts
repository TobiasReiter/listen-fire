// What keeps effects on the world correct when a run does several things at
// once (a collection op's members, a combinator's arms).
//
// The hazard is identity. A `unique by` write is a find-then-create: two flows
// writing the same key at once would each find nothing and each create the
// record. So two effects wait for each other exactly when one of them could
// change what the other finds — and run together otherwise:
//
//   - an IDENTITY write (find, then update or create) takes a lock per key it
//     searches by — (system, record type, which fields, their values) — plus a
//     lock over its record type shared with every write searching by the SAME
//     set of keys. Writes searching by different sets of keys could find each
//     other's records through a field one of them does not search by, so they
//     wait for each other; writes with a FUZZY key, or a key value that cannot
//     be compared exactly (a list, a structured value), hold the record type
//     alone, because there is no exact value to lock.
//   - an UPDATE reads the record's current values and merges into them (fill,
//     append), so it holds the record.
//   - a DELETE holds the record.
//   - a LINK or UNLINK holds the edge (from, label, to): the adapter's own
//     check for the edge being there already is a find-then-create too.
//   - a BOUND write (`bind other`) holds the correspondence it looks up, so
//     two flows binding the same counterpart create one record.
//   - a CREATE with no identity at all, and a MATCH, hold nothing: a record
//     nobody searches for cannot be found twice, and a match only reads.
//
// Beneath the run's own locks sit the CROSS-RUN locks (`write_locks/`): two
// runs, perhaps in two processes, are as dangerous to each other as two flows
// of one run. Once this run's flows have let an effect through, its segment's
// holder takes the same names, but coarser: a record, an edge, a binding as
// is, and an identity write only its record type, exclusively. Postgres
// advisory locks have no notion of "shared within a group", and one lock per
// key value would be one more lock per write for no gain once the type is
// held. The segment holds them until it ends.
//
// Over-locking only costs waiting; under-locking costs a duplicate. So every
// key here is at least as coarse as any system's own matching: the system is
// the adapter TYPE (two connections to one workspace are one system), and a
// key value is folded (case, accents, punctuation, a URL's scheme and path)
// before it is compared.

import { AsyncLocalStorage } from 'node:async_hooks';

import type { WriteLockHolder } from '../write_locks/write_locks';

import { MovementEngineError } from './errors';
import { isBlankIdentityValue, type UniquenessConstraints } from '../translation_graph/uniqueness';

/** How a flow holds a lock: on its own, or alongside every other flow
 *  holding it for the same `group`. */
export type LockMode = { kind: 'exclusive' } | { kind: 'shared'; group: string };

export interface LockRequest {
  name: string;
  mode: LockMode;
  /** Taken by this run only, never across runs: an identity write's per-key
   *  locks, which the cross-run record-type lock already covers. */
  inRunOnly?: true;
}

const EXCLUSIVE: LockMode = { kind: 'exclusive' };

function compatible(held: LockMode, wanted: LockMode): boolean {
  return held.kind === 'shared' && wanted.kind === 'shared' && held.group === wanted.group;
}

/**
 * One lock. First come, first served: a flow that could join the current
 * holders still waits behind anyone already waiting, so a steady stream of one
 * group never starves another.
 */
class Gate {
  private holders = 0;
  private holding: LockMode | undefined;
  private readonly waiting: Array<{ mode: LockMode; grant: () => void }> = [];

  /** Resolves once the lock is held. */
  acquire(mode: LockMode): Promise<void> {
    const free = this.holders === 0 || (this.holding !== undefined && compatible(this.holding, mode));
    if (free && this.waiting.length === 0) {
      this.take(mode);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push({
        mode,
        grant: () => {
          this.take(mode);
          resolve();
        },
      });
    });
  }

  release(): void {
    this.holders -= 1;
    if (this.holders > 0) return;
    this.holding = undefined;
    while (this.waiting.length > 0) {
      const next = this.waiting[0]!;
      if (this.holding !== undefined && !compatible(this.holding, next.mode)) break;
      this.waiting.shift();
      next.grant();
    }
  }

  get idle(): boolean {
    return this.holders === 0 && this.waiting.length === 0;
  }

  private take(mode: LockMode): void {
    this.holders += 1;
    this.holding = mode;
  }
}

/**
 * The run's locks. Every effect asks for all of its locks at once; they are
 * taken in name order, so two effects wanting the same locks in a different
 * order cannot each hold one the other waits for. An effect that already holds
 * a lock (the flow running inside it asking again) is not made to wait for
 * itself.
 */
export class EffectLocks {
  private readonly gates = new Map<string, Gate>();
  /** The locks the running flow holds, by name. */
  private readonly held = new AsyncLocalStorage<ReadonlyMap<string, LockMode>>();
  private readonly holder: WriteLockHolder;

  constructor(deps: { holder: WriteLockHolder }) {
    this.holder = deps.holder;
  }

  async withLocks<T>(requests: readonly LockRequest[], effect: () => Promise<T>): Promise<T> {
    const held = this.held.getStore() ?? new Map<string, LockMode>();
    const wanted = canonicalRequests(requests).filter((request) => {
      const mine = held.get(request.name);
      if (mine === undefined) return true;
      if (mine.kind === 'exclusive' || compatible(mine, request.mode)) return false;
      // Widening a lock this flow holds would wait on the other flows sharing
      // it while they may wait on this one. Nothing asks for that today.
      throw new MovementEngineError(
        'MOVENG_RUNTIME',
        `an effect asked for '${request.name}' on its own while already sharing it — the engine's effect locks are taken in the wrong order`,
      );
    });
    if (wanted.length === 0) return effect();
    const taken: Gate[] = [];
    try {
      for (const request of wanted) {
        let gate = this.gates.get(request.name);
        if (gate === undefined) {
          gate = new Gate();
          this.gates.set(request.name, gate);
        }
        await gate.acquire(request.mode);
        taken.push(gate);
      }
      // After the run's own gates, so the run's flows queue among themselves
      // first and only one of them at a time waits on another run.
      const crossRun = crossRunNames(wanted);
      if (crossRun.length > 0) await this.holder.acquire(crossRun);
      const holding = new Map(held);
      for (const request of wanted) holding.set(request.name, request.mode);
      return await this.held.run(holding, effect);
    } finally {
      for (let index = taken.length - 1; index >= 0; index--) {
        const gate = taken[index]!;
        gate.release();
        const name = wanted[index]!.name;
        if (gate.idle && this.gates.get(name) === gate) this.gates.delete(name);
      }
    }
  }
}

/** The names the segment's cross-run holder takes for `requests`: one per
 *  name, sorted. */
export function crossRunNames(requests: readonly LockRequest[]): string[] {
  const names = new Set<string>();
  for (const request of requests) if (request.inRunOnly !== true) names.add(request.name);
  return [...names].sort();
}

/** One request per name, in name order; two asks for one name in different
 *  modes become one exclusive ask, and a name any ask takes across runs is
 *  taken across runs. */
function canonicalRequests(requests: readonly LockRequest[]): LockRequest[] {
  const byName = new Map<string, LockRequest>();
  for (const request of requests) {
    const already = byName.get(request.name);
    if (already === undefined) {
      byName.set(request.name, request);
      continue;
    }
    const mode = compatible(already.mode, request.mode) ? request.mode : EXCLUSIVE;
    const inRunOnly = already.inRunOnly === true && request.inRunOnly === true;
    byName.set(request.name, { name: request.name, mode, ...(inRunOnly ? { inRunOnly } : {}) });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── The locks each kind of effect takes ──

const part = (value: string): string => JSON.stringify(value);

/** The system an effect lands in, as a lock names it: the adapter's TYPE.
 *  Two connections can reach one workspace, so the connection is not part of
 *  it. */
type LockedSystem = { adapterType: string };

/** The record an update or delete changes. */
export function recordLock(system: LockedSystem, externalId: string): LockRequest {
  return { name: `record ${part(system.adapterType)} ${part(externalId)}`, mode: EXCLUSIVE };
}

/** The edge a link or unlink asserts or severs. */
export function edgeLock(input: {
  system: LockedSystem;
  from: { recordType: string; externalId: string };
  edgeName: string;
  to: { recordType: string; externalId: string };
}): LockRequest {
  return {
    name: `edge ${part(input.system.adapterType)} ${part(input.from.externalId)} ${part(input.edgeName)} ${part(input.to.externalId)}`,
    mode: EXCLUSIVE,
  };
}

/** The correspondence a bound write looks up: `other`'s counterpart in one
 *  instance's record type. Both sides are the binding store's own keys. */
export function bindLock(other: unknown, counterpart: unknown): LockRequest {
  return { name: `bind ${stableJson(other)} ${stableJson(counterpart)}`, mode: EXCLUSIVE };
}

/**
 * The locks an identity write takes: see the file's head. `resolveRecord` is
 * what the system is searched by; `fields` is what the write would create —
 * both, because another write finds this one's record by what it WROTE.
 */
export function identityLocks(input: {
  system: LockedSystem;
  recordType: string;
  constraints: UniquenessConstraints;
  resolveRecord: Record<string, unknown>;
  fields: Record<string, unknown>;
}): LockRequest[] {
  const { constraints } = input;
  if (constraints.any.length === 0) return [];
  const typeLock = `identity ${part(input.system.adapterType)} ${part(input.recordType)}`;
  const wholeType: LockRequest[] = [{ name: typeLock, mode: EXCLUSIVE }];
  if (constraints.any.some((branch) => branch.all.some((entry) => entry.fuzzy === true))) {
    return wholeType;
  }

  const branches = constraints.any.map((branch) =>
    [...new Set(branch.all.map((entry) => entry.field))].sort(),
  );
  const keys: LockRequest[] = [];
  for (const fields of branches) {
    // Each field's possible values: what is searched by, and what is written.
    const valueSets: string[][] = [];
    let searchable = true;
    for (const field of fields) {
      const values = new Set<string>();
      for (const raw of [input.resolveRecord[field], input.fields[field]]) {
        if (isBlankIdentityValue(raw)) continue;
        const folded = foldKeyValue(raw);
        if (folded === undefined) return wholeType;
        values.add(folded);
      }
      // A key with a part missing matches nothing, so there is nothing to wait for.
      if (values.size === 0) searchable = false;
      valueSets.push([...values]);
    }
    if (!searchable) continue;
    const signature = part(fields.join(','));
    for (const combination of cartesian(valueSets)) {
      keys.push({
        name: `key ${part(input.system.adapterType)} ${part(input.recordType)} ${signature} ${stableJson(combination)}`,
        mode: EXCLUSIVE,
        inRunOnly: true,
      });
    }
  }
  if (keys.length === 0) return [];
  const group = [...new Set(branches.map((fields) => fields.join(',')))].sort().join(' | ');
  return [{ name: typeLock, mode: { kind: 'shared', group } }, ...keys];
}

/**
 * A key value folded so that any two values a system could consider the same
 * fold to the same text: case and accents gone, a URL's scheme, `www.` and path
 * gone, then everything but letters and digits gone. Coarser than any system
 * matches, which only ever makes two writes wait that need not have.
 * `undefined` for a value with no exact text (a list, a structured value).
 */
export function foldKeyValue(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') return foldText(value);
  // A parent folded into the search under its edge's name (edge-scoped
  // identity) is a record id, compared exactly.
  if (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    Object.keys(value).length === 1
  ) {
    return `@${value.id}`;
  }
  return undefined;
}

function foldText(text: string): string {
  let folded = text.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(folded);
  if (scheme !== null) folded = folded.slice(scheme[0].length);
  if (scheme !== null || /^[^\s/@]+\.[^\s/@]+\//.test(folded)) {
    folded = folded.split(/[/?#]/, 1)[0] ?? '';
  }
  folded = folded.replace(/^www\./, '');
  return folded.replace(/[^\p{L}\p{N}]/gu, '');
}

function cartesian(sets: string[][]): string[][] {
  return sets.reduce<string[][]>(
    (combinations, values) => combinations.flatMap((prefix) => values.map((value) => [...prefix, value])),
    [[]],
  );
}

/** JSON with object keys in order, so two equal values name one lock. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
