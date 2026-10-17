// What a CRM's recorded parity script is built from. A transcript is every
// answer an implementation gave, as JSON (an error is its message); two
// implementations agree when their transcripts and the requests they made
// are identical. `walkSurface` reads the adapter the way an author's
// movement would — entry points, each type, the root collections, every
// field and edge of the first record found — so a script only has to add
// the writes and the inbound its adapter has.

import type { Expression } from '#shared/expression/types';
import type { Adapter, RelatedResult } from 'movement-engine/public/adapter';
import type { SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import { makeMetaPosition } from 'movement-engine/public/catalog';

export interface TranscriptEntry {
  step: string;
  answer: unknown;
}

export const prop = (name: string): Expression => ({ type: 'property', propertyTypeId: name }) as Expression;
export const value = (v: string | number | boolean | null): Expression => ({ type: 'static', value: v }) as Expression;
export const cmp = (left: Expression, op: 'eq' | 'contains' | 'gte', right: Expression): Expression =>
  ({ type: 'compare', op, left, right }) as Expression;

/** A mutation context no adapter here reads beyond its presence. */
export const MUTATION = { source: 'parity' } as never;

function json(answer: unknown): unknown {
  return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
}

export class Transcript {
  readonly entries: TranscriptEntry[] = [];

  async step<T>(name: string, call: () => Promise<T> | T): Promise<T | undefined> {
    try {
      const answer = await call();
      this.entries.push({ step: name, answer: json(answer) });
      return answer;
    } catch (error) {
      this.entries.push({ step: name, answer: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  }
}

export const firstPosition = (results: RelatedResult[] | undefined): SourcePosition | undefined => results?.[0]?.position;

export interface WalkOptions {
  /** Types to describe beyond the entry points (child types reached by edges). */
  extraTypes?: readonly string[];
  /** Root collections to skip (one that needs a WHERE the fake cannot answer). */
  skipCollections?: readonly string[];
  /** At most this many root collections are walked into. */
  maxCollections?: number;
}

/** Read the adapter's surface; returns the first record of each root
 *  collection, by collection name, for the script's own steps. */
export async function walkSurface(
  t: Transcript,
  adapter: Adapter,
  adapterType: string,
  options: WalkOptions = {},
): Promise<Map<string, SourcePosition>> {
  const meta = makeMetaPosition(adapterType);
  const entries = (await t.step('listEntryPoints', () => adapter.listEntryPoints())) ?? [];
  await t.step('edgesFrom meta', async () => (await adapter.edgesFrom?.(meta)) ?? null);
  const described = new Map<string, SchemaTypeDescriptor | null>();
  for (const typeId of [...entries.map((e) => e.typeId), ...(options.extraTypes ?? [])]) {
    if (described.has(typeId)) continue;
    described.set(typeId, (await t.step(`describe ${typeId}`, () => adapter.describe(typeId))) ?? null);
  }
  await t.step('describe Nonexistent', () => adapter.describe('Nonexistent Type'));

  const firsts = new Map<string, SourcePosition>();
  const collections = entries
    .filter((e) => e.readable && e.fires !== true)
    .filter((e) => !(options.skipCollections ?? []).includes(e.collectionName ?? e.displayName))
    .slice(0, options.maxCollections ?? 12);
  for (const entry of collections) {
    const collection = entry.collectionName ?? entry.displayName;
    const found = await t.step(`root ${collection} LIMIT 3`, () =>
      adapter.getRelated({ position: meta, fieldId: collection, direction: 'outgoing', limit: 3 }),
    );
    const position = firstPosition(found);
    if (position === undefined) continue;
    firsts.set(collection, position);
    const descriptor = described.get(entry.typeId) ?? (await adapter.describe(position.recordType ?? entry.typeId));
    await t.step(`edgesFrom ${collection}[0]`, async () => (await adapter.edgesFrom?.(position)) ?? null);
    // Fields are addressed as an author writes them: by display name.
    for (const field of descriptor?.fields ?? []) {
      if (field.readable === false || field.kind === 'reference' || field.kind === 'file') continue;
      await t.step(`${collection}[0].${field.displayName}`, () => adapter.getFieldValue({ position, fieldId: field.displayName }));
    }
    for (const reference of descriptor?.references ?? []) {
      // Addressed as an author writes it: by the edge's name.
      const edge = reference.name ?? reference.fieldId;
      await t.step(`${collection}[0] -[${edge}]-> LIMIT 3`, () =>
        adapter.getRelated({ position, fieldId: edge, direction: reference.direction ?? 'outgoing', limit: 3 }),
      );
    }
  }
  return firsts;
}

/** The wall clock, fixed (timers left real): an adapter that windows a read
 *  by "now" asks the same question when recorded and when replayed. */
export function freezeClock(): void {
  jest.useFakeTimers({
    now: new Date('2026-10-01T09:00:00.000Z'),
    doNotFake: [
      'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
      'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
      'setTimeout', 'clearTimeout',
    ],
  });
}
