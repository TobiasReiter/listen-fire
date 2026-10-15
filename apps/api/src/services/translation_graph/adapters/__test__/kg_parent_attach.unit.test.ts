// `write parent-[:edge]-> { … }` against a node the engine MATCHED. Every
// field is suppressed, so the graph is reached with an empty property list and
// the parent — and until now nothing here attached anything: the parent links
// were consulted only to find an edge an edge-anchored field could be written
// on, so a matched node hung off nothing.
//
// What this pins: the edge is asserted through the same door `linkRecords`
// uses, the assert is idempotent (so a re-run makes nothing), and the write
// reports which of the two things happened.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MutationContext } from 'movement-engine/services/translation_graph/mutation_context';
import type { WireOntology } from '../kg_client';

// The graph's HTTP surface, faked whole: every call this file makes is a
// request, so recording them IS recording the behaviour.
const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
/** Edges that already exist, keyed `${edgeTypeId}:${sourceNodeId}:${targetNodeId}`. */
const existingEdges = new Set<string>();

jest.mock('../kg_client', () => ({
  __esModule: true,
  kgFetch: jest.fn(
    async (_creds: unknown, req: { method: string; path: string; body?: Record<string, unknown> }) => {
      calls.push({ method: req.method, path: req.path, body: req.body });
      if (req.path === '/edges' && req.method === 'POST') {
        const body = req.body as Record<string, string>;
        const key = `${body.edgeTypeId}:${body.sourceNodeId}:${body.targetNodeId}`;
        const created = !existingEdges.has(key);
        existingEdges.add(key);
        return { edgeId: `edge-${key}`, created };
      }
      return {};
    },
  ),
  kgFetchOrNull: jest.fn(
    async (_creds: unknown, req: { method: string; path: string; body?: Record<string, unknown> }) => {
      calls.push({ method: req.method, path: req.path, body: req.body });
      return { nodeId: 'child-1' };
    },
  ),
}));

// Resource persistence is the other seam entirely (`public.resource` + a
// knowledge link); this suite writes no resources, so stub it rather than drag
// the kysely surface in.
jest.mock('../knowledge_graph_resources', () => ({
  __esModule: true,
  persistKgResources: jest.fn(async () => undefined),
}));

jest.mock('../../../../generated/kysely/knowledge/EvidenceType', () => ({
  __esModule: true,
  default: { extraction: 'extraction', user_edit: 'user_edit', input_mapping: 'input_mapping' },
}));
jest.mock('../../../../generated/kysely/knowledge/ChangeSource', () => ({
  __esModule: true,
  default: { pipeline: 'pipeline', api: 'api' },
}));

import { updateKgRecord } from '../knowledge_graph_writes';

const PARENT_TYPE = 'type-organization';
const CHILD_TYPE = 'type-person';
const EDGE_TYPE = 'edge-employs';

const ONTOLOGY: WireOntology = {
  nodeTypes: [],
  propertyTypes: [],
  edgeTypes: [
    {
      id: EDGE_TYPE,
      sourceNodeTypeId: PARENT_TYPE,
      targetNodeTypeId: CHILD_TYPE,
      outboundName: 'People',
      inboundName: 'Employer',
    },
  ],
} as unknown as WireOntology;

const CONNECTION = {
  creds: { apiKey: 'k', baseUrl: 'https://graph.test' },
  ontology: ONTOLOGY,
};

const MUTATION_CONTEXT: MutationContext = {
  source: { type: 'structured_input', adapterType: 'kg' },
  occurredAt: '2026-09-09T10:00:00.000Z',
} as unknown as MutationContext;

/** The parent-only attach: a matched node, no fields, one parent. */
const attachOnly = {
  connection: CONNECTION,
  teamId: 'team-1' as TeamId,
  externalId: 'child-1',
  recordType: CHILD_TYPE,
  fields: {},
  mutationContext: MUTATION_CONTEXT,
  parentLinks: [{ recordType: PARENT_TYPE, externalId: 'parent-1', edgeName: 'People' }],
};

const edgeAsserts = () => calls.filter((c) => c.path === '/edges' && c.method === 'POST');

describe('updateKgRecord — a matched node attaches to the parent the write names', () => {
  beforeEach(() => {
    calls.length = 0;
    existingEdges.clear();
  });

  it('asserts the connecting edge once, in the direction the ontology declares', async () => {
    const result = await updateKgRecord(attachOnly);

    expect(result).toEqual({ ok: true, association: 'made' });
    expect(edgeAsserts()).toHaveLength(1);
    // The parent is the edge type's SOURCE, so the parent is the source end
    // and the matched child the target — the same reading the create path
    // makes from the same resolution.
    expect(edgeAsserts()[0].body).toMatchObject({
      edgeTypeId: EDGE_TYPE,
      sourceNodeId: 'parent-1',
      targetNodeId: 'child-1',
    });
    // Nothing of the node's own changed, so the node itself was only READ.
    expect(calls.filter((c) => c.path === '/nodes/child-1')).toEqual([
      { method: 'GET', path: '/nodes/child-1', body: undefined },
    ]);
  });

  it('a second run makes no new edge and says so', async () => {
    await updateKgRecord(attachOnly);
    calls.length = 0;

    const result = await updateKgRecord(attachOnly);

    expect(result).toEqual({ ok: true, association: 'already' });
    // The assert still runs — it is the door's idempotence, not ours — but it
    // creates nothing.
    expect(edgeAsserts()).toHaveLength(1);
  });

  // The SAME edge, named from the other end: the org is now the record being
  // updated and the person is its parent, through the edge type's INBOUND
  // name. The edge lands the same way round either way — the ontology decides
  // the ends, not which side the write happened to start from.
  it('resolves an inbound edge name to the same ends', async () => {
    const result = await updateKgRecord({
      ...attachOnly,
      recordType: PARENT_TYPE,
      externalId: 'parent-1',
      parentLinks: [{ recordType: CHILD_TYPE, externalId: 'child-1', edgeName: 'Employer' }],
    });

    expect(result).toEqual({ ok: true, association: 'made' });
    expect(edgeAsserts()[0].body).toMatchObject({
      edgeTypeId: EDGE_TYPE,
      sourceNodeId: 'parent-1',
      targetNodeId: 'child-1',
    });
  });

  it('a write with no parent asserts nothing', async () => {
    const result = await updateKgRecord({ ...attachOnly, parentLinks: [] });

    expect(result).toEqual({ ok: true, association: 'none' });
    expect(edgeAsserts()).toEqual([]);
  });
});
