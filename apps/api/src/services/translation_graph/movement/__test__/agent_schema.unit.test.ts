import type { InstanceSchema } from 'movement-lang';

import { normaliseSchemaForAgent } from '../agent_schema';

function fixture(): InstanceSchema {
  return {
    positions: {
      Company: {
        properties: { name: 'text' },
        edges: {
          // Neither promise declared. `readable` defaults TRUE, `writable`
          // defaults READ-ONLY — the write promise is explicit, so silence
          // must never come back as an affirmative claim.
          people: { target: 'Person' },
          // The write promise, declared.
          notes: { target: 'Note', writable: true },
          // Explicit opt-outs ⇒ must be preserved verbatim.
          attachments: { target: 'File', writable: false },
          // A genuine write-only edge: no read API, but it does write.
          replies: { target: 'Message', readable: false, writable: true },
        },
      },
    },
    collections: { Companies: { target: 'Company' } },
    writableRoots: {
      Company: {
        fields: { name: 'text' },
        resultShape: { externalId: 'text' },
        edges: { owner: { target: 'Person' }, tags: { target: 'Tag', writable: true } },
      },
    },
    createShapes: {
      Message: {
        fields: { body: 'text' },
        resultShape: { externalId: 'text' },
        edges: { thread: { target: 'Thread' } },
      },
    },
  };
}

describe('normaliseSchemaForAgent', () => {
  it('reports an UNDECLARED edge as readable but NOT writable, across positions, roots, and createShapes', () => {
    const out = normaliseSchemaForAgent(fixture());

    // The defect this guards: an adapter that says nothing about an edge (every
    // reference on a read-only surface like Dealroom) used to describe as
    // writable, so an authoring agent wrote into it and the checker refused.
    expect(out.positions.Company.edges.people).toEqual({
      target: 'Person',
      readable: true,
      writable: false,
    });
    expect(out.writableRoots.Company.edges?.owner).toEqual({
      target: 'Person',
      readable: true,
      writable: false,
    });
    expect(out.createShapes?.Message.edges?.thread).toEqual({
      target: 'Thread',
      readable: true,
      writable: false,
    });
  });

  it('reports a DECLARED writable edge as writable', () => {
    const out = normaliseSchemaForAgent(fixture());

    expect(out.positions.Company.edges.notes).toEqual({
      target: 'Note',
      readable: true,
      writable: true,
    });
    expect(out.writableRoots.Company.edges?.tags).toEqual({
      target: 'Tag',
      readable: true,
      writable: true,
    });
  });

  it('preserves explicit read-only / write-only opt-outs (fills only the missing side)', () => {
    const out = normaliseSchemaForAgent(fixture());

    // read-only edge: writable:false kept, readable filled true
    expect(out.positions.Company.edges.attachments).toEqual({
      target: 'File',
      writable: false,
      readable: true,
    });
    // write-only edge: readable:false kept, its declared writable kept
    expect(out.positions.Company.edges.replies).toEqual({
      target: 'Message',
      readable: false,
      writable: true,
    });
  });

  it('agrees with the checker: exactly the edges it calls writable are the ones a write may land on', () => {
    const input = fixture();
    const out = normaliseSchemaForAgent(input);

    for (const [name, edge] of Object.entries(out.positions.Company.edges)) {
      // `writableEdgesOf`'s rule, and the checker's write gate: the raw
      // schema's `writable === true` and nothing else.
      expect(edge.writable).toBe(input.positions.Company.edges[name]!.writable === true);
    }
  });

  it('preserves sibling fields (properties, collections) untouched', () => {
    const out = normaliseSchemaForAgent(fixture());
    expect(out.positions.Company.properties).toEqual({ name: 'text' });
    expect(out.collections).toEqual({ Companies: { target: 'Company' } });
    expect(out.writableRoots.Company.fields).toEqual({ name: 'text' });
  });

  it('does NOT mutate the input (it is the shared TTL-cached checker object)', () => {
    const input = fixture();
    normaliseSchemaForAgent(input);
    // The cached object keeps the sparse convention — absent-vs-present is
    // load-bearing on the compile path.
    expect(input.positions.Company.edges.people).toEqual({ target: 'Person' });
    expect('readable' in input.positions.Company.edges.people).toBe(false);
    expect('writable' in input.positions.Company.edges.people).toBe(false);
    expect(input.writableRoots.Company.edges?.owner).toEqual({ target: 'Person' });
  });

  it('omits createShapes when the input has none', () => {
    const input = fixture();
    delete input.createShapes;
    const out = normaliseSchemaForAgent(input);
    expect('createShapes' in out).toBe(false);
  });
});
