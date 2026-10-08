// The segment's write ledger: every write, link, unlink and delete a segment
// makes, in PROGRAM order — the order the writes take in the program's text,
// with the writes of concurrent branches (a collection op's members, a
// `race`/`parallel`'s arms) ordered by branch index — never the order they
// happened to land in. Two hosts that answer at different speeds see the same
// ledger.
//
// A write is numbered as it happens (later reads of its handle cite it by
// that number), and its place in program order is a key: the flow it ran in,
// and its position among that flow's writes and forks. A flow forked from
// another takes the fork's position and its own branch index as the head of
// its keys, so sorting the keys puts each branch's writes where the fork is,
// branch by branch. Once the segment ends the ledger is sorted by key and
// every citation renumbered to match.

import type { SummarisedOrigin } from 'engine-contracts';

import type { MovementWriteRecord } from './run';

/** Where a flow's next write falls in program order. */
export interface WriteOrder {
  /** The flow's own place: empty for a segment's main flow; for a branch,
   *  its parent's place, the fork's position in the parent, and its branch
   *  index. */
  readonly prefix: readonly number[];
  /** The position the flow's next write or fork takes. */
  next: number;
}

/** The order of a segment's main flow. */
export function rootWriteOrder(): WriteOrder {
  return { prefix: [], next: 0 };
}

/** Reserve a fork's position in `parent`: each branch it starts takes its
 *  order from the answer, by branch index. */
export function forkWriteOrder(parent: WriteOrder): (branch: number) => WriteOrder {
  const at = parent.next++;
  return (branch) => ({ prefix: [...parent.prefix, at, branch], next: 0 });
}

/** A citation of a write by number. */
type WriteCitation =
  | { kind: 'write'; writeIndex: number }
  | Extract<SummarisedOrigin, { kind: 'write' }>;

export class WriteLedger {
  private entries: Array<{ record: MovementWriteRecord; key: readonly number[] }> = [];
  private readonly citations = new Set<WriteCitation>();

  /** The number the next write takes. */
  get nextIndex(): number {
    return this.entries.length;
  }

  /** Append `record`, which `order`'s flow made. Its own origin, when it
   *  names it, is renumbered with it. */
  append(record: MovementWriteRecord, order: WriteOrder): void {
    this.entries.push({ record, key: [...order.prefix, order.next++] });
    if (record.origin !== undefined) this.citations.add(record.origin);
  }

  /** Hold `citation` (an origin or a summarised origin naming a write by
   *  number) to the ledger's final numbering. */
  cite(citation: WriteCitation): void {
    this.citations.add(citation);
  }

  /** The writes in program order, every citation renumbered to match. */
  ordered(): MovementWriteRecord[] {
    const sorted = this.entries
      .map((entry, index) => ({ ...entry, index }))
      .sort((a, b) => compareKeys(a.key, b.key));
    const renumbered = new Map<number, number>();
    sorted.forEach(({ index }, position) => renumbered.set(index, position));
    for (const citation of this.citations) {
      if (citation.kind !== 'write') continue;
      if ('writeIndex' in citation) citation.writeIndex = renumbered.get(citation.writeIndex) ?? citation.writeIndex;
      else citation.write = renumbered.get(citation.write) ?? citation.write;
    }
    this.entries = sorted.map(({ record, key }) => ({ record, key }));
    return this.entries.map(({ record }) => record);
  }
}

function compareKeys(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
