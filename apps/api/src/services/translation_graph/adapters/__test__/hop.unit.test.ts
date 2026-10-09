// The walk for a UNIFORM adapter — one implementation, sixteen adapters.
//
// A uniform adapter has no containers to enter: its type ids locate every node
// in its meta graph, so the whole walk is derivable from the root's edges plus
// `describe`. Writing that out sixteen times would be sixteen chances to
// disagree about what an edge promises — and, worse, sixteen places to edit
// when the lookahead is scaled back to a stub.

import { uniformWalk, hydrateTargets } from '../hop';
import { stubTargetOf, type DescribedTargetNode, type EdgeTargetNode } from '../../adapter';

/** Narrow to a described target, failing loudly if it turned out to be a stub.
 *  The union forces this at every call site, which is the point: a consumer
 *  cannot reach for fields without first deciding what it is holding. */
const described = (target: EdgeTargetNode | undefined): DescribedTargetNode => {
  if (!target || target.stub === true) throw new Error('expected a described target, got a stub');
  return target;
};
import { META_RECORD_TYPE, makeUnstablePosition } from '../../types';

import type { SchemaTypeDescriptor } from '../../types';

const ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: 'Demo',
  description: 'A demo connection.',
  fields: [],
  references: [
    { fieldId: 'thing', targetTypeId: 'demo:thing', cardinality: 'many', name: 'Things' },
  ],
};

const THING: SchemaTypeDescriptor = {
  typeId: 'demo:thing',
  displayName: 'Thing',
  fields: [{ fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: true }],
  references: [
    { fieldId: 'part', targetTypeId: 'demo:part', cardinality: 'many', name: 'Parts' },
    { fieldId: 'other', targetTypeId: 'demo:part', cardinality: 'one', name: 'Chief Part' },
  ],
};

const PART: SchemaTypeDescriptor = {
  typeId: 'demo:part',
  displayName: 'Part',
  fields: [{ fieldId: 'code', displayName: 'Code', kind: 'string', writable: false, required: true }],
  references: [],
};

const BY_ID: Record<string, SchemaTypeDescriptor> = {
  'demo:thing': THING,
  'demo:part': PART,
};

function walker() {
  const described: string[] = [];
  const describe = async (typeId: string) => {
    described.push(typeId);
    return BY_ID[typeId] ?? null;
  };
  const at = (recordType: string) =>
    uniformWalk({
      adapterType: 'demo',
      at: makeUnstablePosition({ adapterType: 'demo', recordType, data: {} }),
      root: ROOT,
      describe,
    });
  return { at, described };
}

describe('uniformWalk', () => {
  it('the meta position lands on the ROOT — no describe can answer for it', async () => {
    const { at } = walker();
    const hop = await at(META_RECORD_TYPE);
    expect(hop!.descriptor.displayName).toBe('Demo');
    expect(hop!.descriptor.references.map((r) => r.name)).toEqual(['Things']);
  });

  it('every edge arrives with BOTH how to get there and what is there', async () => {
    const { at } = walker();
    const hop = await at(META_RECORD_TYPE);
    // Same key for both maps, so a caller never correlates two vocabularies.
    expect(hop!.targetPositions?.thing?.recordType).toBe('demo:thing');
    expect(hop!.targetNodes?.thing?.displayName).toBe('Thing');
  });

  it('the landing carries its fields but NOT its onward edges', async () => {
    const { at } = walker();
    const target = described((await at(META_RECORD_TYPE))!.targetNodes!.thing);
    expect(target.fields.map((f) => f.displayName)).toEqual(['Name']);
    // `Thing` genuinely has edges; withholding them is what prices a hop.
    expect(target).not.toHaveProperty('references');
  });

  it('walking on gives the withheld edges', async () => {
    const { at } = walker();
    const hop = await at('demo:thing');
    expect(hop!.descriptor.references.map((r) => r.name)).toEqual(['Parts', 'Chief Part']);
    expect(hop!.targetNodes?.part?.displayName).toBe('Part');
  });

  it('two edges onto one type cost ONE describe, not two', async () => {
    const { at, described } = walker();
    await at('demo:thing');
    // `Parts` and `Chief Part` both land on Part. The lookahead is already the
    // expensive read in this design; paying for it twice per node is the
    // fan-out the walk exists to avoid.
    expect(described.filter((t) => t === 'demo:part')).toEqual(['demo:part']);
  });

  it('a leaf reports no edges and withholds nothing', async () => {
    const { at } = walker();
    const hop = await at('demo:part');
    expect(hop!.descriptor.references).toEqual([]);
    // Absent, not empty: there is nothing being withheld here.
    expect(hop!.targetNodes).toBeUndefined();
    expect(hop!.targetPositions).toBeUndefined();
  });

  it('a position the adapter cannot describe reaches nothing', async () => {
    const { at } = walker();
    expect(await at('demo:unknown')).toBeNull();
  });

  it('a container-shaped adapter gets the lookahead without giving up its own fan-out', async () => {
    // Airtable, Sheets and Affinity build their hops by hand — they walk
    // containers, which nothing generic can derive. The LOOKAHEAD is the part
    // that is mechanical everywhere, so it is separable: hand it a descriptor
    // and a describe, keep your own paths.
    const targets = await hydrateTargets({ descriptor: THING, describe: async (id) => BY_ID[id] ?? null });
    expect(targets?.part?.displayName).toBe('Part');
    expect(targets?.other?.displayName).toBe('Part');
    expect(targets?.part).not.toHaveProperty('references');
  });

  it('an adapter may STUB a target it judges too expensive to describe', async () => {
    const { described } = walker();
    const describe = async (typeId: string) => BY_ID[typeId] ?? null;
    const hop = await uniformWalk({
      adapterType: 'demo',
      at: makeUnstablePosition({ adapterType: 'demo', recordType: META_RECORD_TYPE, data: {} }),
      root: ROOT,
      describe,
      // A wide root is where the lookahead becomes the whole graph — Attio
      // pays an attribute fetch per object. Whose call that is belongs to the
      // adapter, which is the only thing that knows what a fetch costs.
      // The adapter names its own stub — the framework has only an internal
      // type id, which is not what an agent should be reading.
      stubTarget: (r) => stubTargetOf({ typeId: r.targetTypeId, displayName: 'Thing' }),
    });
    const target = hop!.targetNodes!.thing;
    // Named, so the agent knows what is over there and can decide to go.
    expect(target.displayName).toBe('Thing');
    // ...and SAYING it is a stub, so "hop to see the fields" is never confused
    // with "this node has no fields". Silence dressed as an answer is the
    // failure mode; an explicit marker is not inferable from an empty list.
    expect(target.stub).toBe(true);
    expect(target).not.toHaveProperty('fields');
    // The whole point: stubbing costs nothing to produce.
    expect(described).toEqual([]);
  });

  it('a described target says it is NOT a stub — the reader never has to infer', async () => {
    const { at } = walker();
    const target = (await at(META_RECORD_TYPE))!.targetNodes!.thing;
    expect(target.stub).toBeUndefined();
    expect(described(target).fields).toBeDefined();
  });

  it('stubbing is per EDGE, not per adapter', async () => {
    const hop = await uniformWalk({
      adapterType: 'demo',
      at: makeUnstablePosition({ adapterType: 'demo', recordType: 'demo:thing', data: {} }),
      root: ROOT,
      describe: async (typeId: string) => BY_ID[typeId] ?? null,
      // `Parts` is a collection worth describing; `Chief Part` is not.
      stubTarget: (r) =>
        r.name === 'Chief Part' ? stubTargetOf({ typeId: r.targetTypeId, displayName: 'Part' }) : undefined,
    });
    expect(hop!.targetNodes?.part?.stub).toBeUndefined();
    expect(hop!.targetNodes?.other?.stub).toBe(true);
  });

  it('an edge whose target cannot be described still says how to get there', async () => {
    const hop = await uniformWalk({
      adapterType: 'demo',
      at: makeUnstablePosition({ adapterType: 'demo', recordType: META_RECORD_TYPE, data: {} }),
      root: {
        typeId: META_RECORD_TYPE,
        displayName: 'Demo',
        fields: [],
        references: [{ fieldId: 'ghost', targetTypeId: 'demo:ghost', cardinality: 'one', name: 'Ghost' }],
      },
      describe: async () => null,
    });
    // Reaching a node and describing it are different facts. The path stands;
    // the lookahead is simply absent, which is the honest report.
    expect(hop!.targetPositions?.ghost?.recordType).toBe('demo:ghost');
    expect(hop!.targetNodes).toBeUndefined();
  });
});
