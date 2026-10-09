// Mock resolve.ts to avoid DB import chain
jest.mock('../../output_v3/resolve', () => ({
  resolveFieldMapping: jest.fn(),
  walkEdge: jest.fn(),
  selectValues: jest.fn(),
  aggregate: jest.fn(),
  traverseWithEdges: jest.fn(),
  resolveMetaKey: jest.fn(),
  resolveTempToReal: jest.fn(),
  loadResources: jest.fn(),
  selectResourceField: jest.fn(),
}));

jest.mock('../../../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { NodeData } from '../../output_v3/filter';
import type { FieldRef } from '../../output_v3/schemas';

import { resolveFieldRef } from '../../output_v3/filter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNodeData(overrides?: Partial<NodeData>): NodeData {
  return {
    properties: {
      'pt-name': 'Acme Corp',
      'pt-stage': 'Series A',
      'pt-amount': 5000000,
      'pt-active': true,
    },
    edgeProperties: {
      'pt-weight': 0.9,
      'pt-label': 'primary',
    },
    linkedObjects: [
      {
        adapter: 'attio',
        actionNodeId: 'action-1',
        externalId: 'rec-attio-001',
        data: { record_url: 'https://attio.com/rec-001', status: 'active' },
      },
    ],
    _old: {
      'pt-name': 'Acme Inc',
      'pt-stage': 'Seed',
      'pt-amount': 1000000,
    },
    _oldEdgeProperties: {
      'pt-weight': 0.5,
    },
    _parentResult: null,
    _meta: {
      source: 'extraction',
      pipeline_run_id: 'run-123',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveFieldRef
// ---------------------------------------------------------------------------

describe('resolveFieldRef', () => {
  const data = makeNodeData();

  it('resolves node_property', () => {
    const ref: FieldRef = { type: 'node_property', propertyTypeId: 'pt-name' };
    expect(resolveFieldRef(ref, data)).toBe('Acme Corp');
  });

  it('resolves node_property with old=true', () => {
    const ref: FieldRef = { type: 'node_property', propertyTypeId: 'pt-name', old: true };
    expect(resolveFieldRef(ref, data)).toBe('Acme Inc');
  });

  it('returns null for missing node_property', () => {
    const ref: FieldRef = { type: 'node_property', propertyTypeId: 'pt-nonexistent' };
    expect(resolveFieldRef(ref, data)).toBeNull();
  });

  it('resolves edge_property', () => {
    const ref: FieldRef = { type: 'edge_property', propertyTypeId: 'pt-weight' };
    expect(resolveFieldRef(ref, data)).toBe(0.9);
  });

  it('resolves edge_property with old=true', () => {
    const ref: FieldRef = { type: 'edge_property', propertyTypeId: 'pt-weight', old: true };
    expect(resolveFieldRef(ref, data)).toBe(0.5);
  });

  it('resolves linked_object external_id', () => {
    const ref: FieldRef = { type: 'linked_object', adapter: 'attio', actionNodeId: 'action-1', field: 'external_id' };
    expect(resolveFieldRef(ref, data)).toBe('rec-attio-001');
  });

  it('resolves linked_object data field', () => {
    const ref: FieldRef = { type: 'linked_object', adapter: 'attio', actionNodeId: 'action-1', field: 'status' };
    expect(resolveFieldRef(ref, data)).toBe('active');
  });

  it('returns null for unmatched linked_object', () => {
    const ref: FieldRef = { type: 'linked_object', adapter: 'slack', actionNodeId: 'action-1', field: 'external_id' };
    expect(resolveFieldRef(ref, data)).toBeNull();
  });

  it('resolves meta', () => {
    const ref: FieldRef = { type: 'meta', key: 'source' };
    expect(resolveFieldRef(ref, data)).toBe('extraction');
  });

  it('returns null for missing meta key', () => {
    const ref: FieldRef = { type: 'meta', key: 'nonexistent' };
    expect(resolveFieldRef(ref, data)).toBeNull();
  });

  it('returns null when _old is null', () => {
    const ref: FieldRef = { type: 'node_property', propertyTypeId: 'pt-name', old: true };
    expect(resolveFieldRef(ref, makeNodeData({ _old: null }))).toBeNull();
  });

  it('returns null when _meta is null', () => {
    const ref: FieldRef = { type: 'meta', key: 'source' };
    expect(resolveFieldRef(ref, makeNodeData({ _meta: null }))).toBeNull();
  });

  it('resolves parent_result created', () => {
    const ref: FieldRef = { type: 'parent_result', field: 'created' };
    const data = makeNodeData({ _parentResult: { created: true, externalId: 'ext-1' } });
    expect(resolveFieldRef(ref, data)).toBe(true);
  });

  it('resolves parent_result external_id', () => {
    const ref: FieldRef = { type: 'parent_result', field: 'external_id' };
    const data = makeNodeData({ _parentResult: { created: false, externalId: 'ext-1' } });
    expect(resolveFieldRef(ref, data)).toBe('ext-1');
  });

  it('returns null when _parentResult is null', () => {
    const ref: FieldRef = { type: 'parent_result', field: 'created' };
    expect(resolveFieldRef(ref, makeNodeData())).toBeNull();
  });
});
