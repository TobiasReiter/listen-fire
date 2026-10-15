// What ONE call at a node hands an agent.
//
// The walk contract says a single call describes the node, its properties, and
// its edges — each edge carrying what it LANDS ON, minus the landing's own
// onward edges. These tests pin that promise at the projection boundary, where
// the adapter's descriptor vocabulary becomes the agent's.

import { walkedNodeFrom, type WalkedDescribedNode, type WalkedNodeShape } from '../walk';
/** Narrow an edge's landing to a DESCRIBED one. The union makes this explicit
 *  at every call site, which is the point — a reader cannot reach for fields
 *  without first deciding whether it is holding a stub. */
function describedTarget(target: WalkedNodeShape | undefined): WalkedDescribedNode {
  if (!target || target.stub === true) throw new Error('expected a described target, got a stub');
  return target;
}

import { makeUnstablePosition } from 'movement-engine/services/translation_graph/types';

import type { EdgesFromResult } from 'movement-engine/services/translation_graph/adapter';
import type { SchemaFieldDescriptor } from 'movement-engine/services/translation_graph/types';

const field = (over: Partial<SchemaFieldDescriptor>): SchemaFieldDescriptor => ({
  fieldId: 'subject',
  displayName: 'Subject',
  kind: 'string',
  writable: false,
  required: false,
  ...over,
});

const at = (recordType: string, data: unknown = {}) =>
  makeUnstablePosition({ adapterType: 'demo', recordType, data });

const rootHop = (): EdgesFromResult => ({
  descriptor: {
    typeId: 'meta',
    displayName: 'Email',
    description: 'An email connection. Nothing here can be listed.',
    fields: [],
    references: [
      {
        fieldId: 'email',
        targetTypeId: 'email',
        cardinality: 'one',
        name: 'Email',
        fires: true,
        readable: false,
        description: 'An email arriving.',
      },
    ],
  },
  targetPositions: { email: at('email') },
  targetNodes: {
    email: {
      typeId: 'email',
      displayName: 'Email',
      fields: [field({}), field({ fieldId: 'to', displayName: 'To', writable: true, required: true })],
    },
  },
});

describe('walkedNodeFrom — one call at a node', () => {
  it('the node states itself, not just its edges', () => {
    const node = walkedNodeFrom({ hop: rootHop(), at: '' });
    expect(node.name).toBe('Email');
    expect(node.description).toMatch(/cannot be listed|can be listed/i);
  });

  it('an edge makes its three promises explicit — an agent reads truth, not a default', () => {
    const [edge] = walkedNodeFrom({ hop: rootHop(), at: '' }).edges;
    expect(edge.name).toBe('Email');
    // Absent `writable` is NO write promise; absent `readable` would be true,
    // but this edge opts out explicitly. `fires` is the third promise.
    expect(edge.readable).toBe(false);
    expect(edge.writable).toBe(false);
    expect(edge.fires).toBe(true);
  });

  it('an edge carries what it LANDS ON — the agent can write without another call', () => {
    const [edge] = walkedNodeFrom({ hop: rootHop(), at: '' }).edges;
    expect(edge.target?.name).toBe('Email');
    expect(describedTarget(edge.target).properties.To).toEqual(
      expect.objectContaining({ type: 'text', writable: true, required: true }),
    );
  });

  it('but never the landing\'s own edges — that is what makes exploring cost one hop', () => {
    const [edge] = walkedNodeFrom({ hop: rootHop(), at: '' }).edges;
    expect(edge.target).not.toHaveProperty('edges');
  });

  it('an edge whose target was not hydrated says nothing rather than saying empty', () => {
    const hop = rootHop();
    delete hop.targetNodes;
    const [edge] = walkedNodeFrom({ hop, at: '' }).edges;
    // "We did not tell you" is a different fact from "it has no properties" —
    // the lookahead may be scaled back to a stub without lying.
    expect(edge.target).toBeUndefined();
  });

  it('every edge hands back the address to walk it — the caller echoes, never constructs', () => {
    const node = walkedNodeFrom({ hop: rootHop(), at: '' });
    expect(node.position).toBe('');
    expect(node.edges[0]?.position).toBe('-[:`Email`]->');
  });

  it('an address composes onto the one already walked', () => {
    const node = walkedNodeFrom({ hop: rootHop(), at: '-[:`Base`]->' });
    expect(node.edges[0]?.position).toBe('-[:`Base`]->-[:`Email`]->');
  });

  it('a polymorphic edge carries its members, each with the narrowing that reaches it', () => {
    const hop: EdgesFromResult = {
      descriptor: {
        typeId: 'meta',
        displayName: 'Airtable',
        fields: [],
        references: [
          { fieldId: 'Base', targetTypeId: 'Base', cardinality: 'many', name: 'Base' },
        ],
      },
      targetPositions: {
        'base:1': at('Base', { Name: 'CRM' }),
        'base:2': at('Base', { Name: 'Ops' }),
      },
    };
    const [edge] = walkedNodeFrom({ hop, at: '' }).edges;
    expect(edge.members?.map((m) => m.name)).toEqual(['CRM', 'Ops']);
    // The member's address is the narrowing an author would write, so the
    // string that explores is the string that goes in the movement source.
    expect(edge.members?.[0]?.position).toBe('-[:Base WHERE `Name` == "CRM"]->');
    // What a WHERE may test — visible without a second call.
    expect(edge.narrowBy).toEqual(['Name']);
  });

  it('a leaf reports no edges, which is a real answer', () => {
    const node = walkedNodeFrom({
      hop: { descriptor: { typeId: 'a', displayName: 'Attachment', fields: [], references: [] } },
      at: '-[:`Attachments`]->',
    });
    expect(node.edges).toEqual([]);
    expect(node.position).toBe('-[:`Attachments`]->');
  });
});
