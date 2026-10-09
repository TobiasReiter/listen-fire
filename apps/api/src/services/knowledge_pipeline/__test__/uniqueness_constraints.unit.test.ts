/**
 * Unit tests for uniqueness constraints: validation, subgraph expression
 * resolution, dedup grouping, and topo ordering.
 */

// Mock heavy dependencies before importing the module under test
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(),
}));
jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { NodeId } from '../../../generated/kysely/knowledge/Node';
import type {
  ExtractedSubgraph,
  ExtractedNode,
  ExtractedProperty,
  ExtractedEdge,
} from '../types';
import type { Expression } from '#shared/expression/types';
import type { StoredUniquenessConstraints, ConstraintEntry } from '../uniqueness_constraints';

import {
  validateUniquenessConstraints,
  resolveExpressionInSubgraph,
  findDedupGroups,
  buildResolutionOrder,
  stringSimilarity,
  collectEdgeTypeIds,
  parseConstraintText,
  serializeConstraintEntries,
} from '../uniqueness_constraints';

// ── Test IDs ──

const NT_PERSON = 'nt-person' as NodeTypeId;
const NT_COMPANY = 'nt-company' as NodeTypeId;
const NT_DEAL = 'nt-deal' as NodeTypeId;
const ET_WORKS_AT = 'et-works-at' as EdgeTypeId;
const ET_DEAL_FOR = 'et-deal-for' as EdgeTypeId;
const PT_NAME = 'pt-name' as PropertyTypeId;
const PT_EMAIL = 'pt-email' as PropertyTypeId;
const PT_WEBSITE = 'pt-website' as PropertyTypeId;
const PT_ROUND_TYPE = 'pt-round-type' as PropertyTypeId;

// ── Helpers ──

function makeSubgraph(overrides: Partial<ExtractedSubgraph> = {}): ExtractedSubgraph {
  return {
    messageNode: { tempId: 'msg-1', nodeType: 'nt-msg' as NodeTypeId },
    nodes: [],
    properties: [],
    edges: [],
    evidence: [],
    edgeEvidence: [],
    nodeResources: [],
    ...overrides,
  };
}

function propExpr(propTypeId: string): Expression {
  return { type: 'property', propertyTypeId: propTypeId };
}

function edgeExpr(edgeTypeId: string, direction: 'outgoing' | 'incoming' = 'outgoing'): Expression {
  return {
    type: 'traverse',
    steps: [{ type: 'edge', edgeTypeId, direction }],
    expression: { type: 'static', value: true },
  };
}

// ── Validation ──

describe('validateUniquenessConstraints', () => {
  test('accepts valid constraints with property and edge expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [
        { expr: propExpr(PT_EMAIL as string) },
      ],
      [
        { expr: propExpr(PT_NAME as string), fuzzy: true },
        { expr: edgeExpr(ET_WORKS_AT as string) },
      ],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects LLM expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{ expr: { type: 'llm', prompt: 'match this' } }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"llm" is not allowed');
  });

  test('rejects aggregate expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{ expr: { type: 'aggregate', fn: 'count', expression: propExpr('x') } }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"aggregate" is not allowed');
  });

  test('rejects multi-step traversals', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'traverse',
          steps: [
            { type: 'edge', edgeTypeId: 'et-1', direction: 'outgoing' as const },
            { type: 'edge', edgeTypeId: 'et-2', direction: 'outgoing' as const },
          ],
          expression: { type: 'static', value: true },
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('exactly one step');
  });

  test('accepts function expressions with allowed functions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'function',
          fn: 'lower',
          args: [propExpr(PT_NAME as string)],
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
  });

  test('rejects conditional expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'conditional',
          condition: propExpr('x'),
          then: { type: 'static', value: 'a' },
          else: { type: 'static', value: 'b' },
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"conditional" is not allowed');
  });

  test('accepts empty constraints (valid but no-op)', () => {
    const result = validateUniquenessConstraints([]);
    expect(result.valid).toBe(true);
  });

  // N1: WITHIN(<dateProperty>, "<interval>") is a `function` expression
  // with `fn === 'within'`. The validator must allow it through so the
  // SQL compiler at `compileExpressionToWhere` actually runs.
  test('accepts WITHIN function expressions (N1)', () => {
    const constraints: StoredUniquenessConstraints = [
      [
        {
          expr: {
            type: 'function',
            fn: 'within',
            args: [
              propExpr('pt-first-seen'),
              { type: 'static', value: '6 months' },
            ],
          },
        },
      ],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ── collectEdgeTypeIds ──

describe('collectEdgeTypeIds', () => {
  test('extracts edge type ID from traverse expression', () => {
    const ids = collectEdgeTypeIds(edgeExpr('et-123'));
    expect(ids).toEqual(['et-123']);
  });

  test('returns empty for property expression', () => {
    const ids = collectEdgeTypeIds(propExpr('pt-1'));
    expect(ids).toEqual([]);
  });

  test('extracts from nested function args', () => {
    const ids = collectEdgeTypeIds({
      type: 'function',
      fn: 'coalesce',
      args: [edgeExpr('et-1'), propExpr('pt-1')],
    });
    expect(ids).toEqual(['et-1']);
  });
});

// ── resolveExpressionInSubgraph ──

describe('resolveExpressionInSubgraph', () => {
  test('resolves property value for a node', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
      ],
    });

    expect(resolveExpressionInSubgraph(propExpr(PT_NAME as string), 'n1', subgraph)).toBe('Alice');
    expect(resolveExpressionInSubgraph(propExpr(PT_EMAIL as string), 'n1', subgraph)).toBe('alice@co.com');
  });

  test('returns null for missing property', () => {
    const subgraph = makeSubgraph();
    expect(resolveExpressionInSubgraph(propExpr(PT_NAME as string), 'n1', subgraph)).toBeNull();
  });

  test('resolves outgoing edge traversal', () => {
    const subgraph = makeSubgraph({
      edges: [
        { sourceTempId: 'deal-1', targetTempId: 'comp-1', edgeType: ET_DEAL_FOR },
      ],
    });

    const result = resolveExpressionInSubgraph(
      edgeExpr(ET_DEAL_FOR as string, 'outgoing'),
      'deal-1',
      subgraph,
    );
    expect(result).toBe('comp-1');
  });

  test('resolves incoming edge traversal', () => {
    const subgraph = makeSubgraph({
      edges: [
        { sourceTempId: 'deal-1', targetTempId: 'comp-1', edgeType: ET_DEAL_FOR },
      ],
    });

    const result = resolveExpressionInSubgraph(
      edgeExpr(ET_DEAL_FOR as string, 'incoming'),
      'comp-1',
      subgraph,
    );
    expect(result).toBe('deal-1');
  });

  test('returns null when edge not found', () => {
    const subgraph = makeSubgraph();
    const result = resolveExpressionInSubgraph(
      edgeExpr(ET_DEAL_FOR as string, 'outgoing'),
      'n1',
      subgraph,
    );
    expect(result).toBeNull();
  });

  test('resolves static expression', () => {
    const subgraph = makeSubgraph();
    expect(resolveExpressionInSubgraph({ type: 'static', value: 42 }, 'n1', subgraph)).toBe(42);
  });

  test('resolves function expressions', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice' },
      ],
    });

    const expr: Expression = {
      type: 'function',
      fn: 'lower',
      args: [propExpr(PT_NAME as string)],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe('alice');
  });
});

// ── stringSimilarity ──

describe('stringSimilarity', () => {
  test('identical strings return 1', () => {
    expect(stringSimilarity('hello', 'hello')).toBe(1);
  });

  test('case-insensitive identical strings return 1', () => {
    expect(stringSimilarity('Hello', 'hello')).toBe(1);
  });

  test('similar strings have high similarity', () => {
    const sim = stringSimilarity('Acme Corp', 'Acme Corporation');
    expect(sim).toBeGreaterThan(0.3);
  });

  test('dissimilar strings have low similarity', () => {
    const sim = stringSimilarity('Apple', 'Banana');
    expect(sim).toBeLessThan(0.3);
  });
});

// ── findDedupGroups ──

describe('findDedupGroups', () => {
  test('groups nodes with matching exact constraint', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'alice@co.com' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
    expect(exactGroups[0].canonicalTempId).toBe('n1');
    expect(exactGroups[0].mergedTempIds).toEqual(['n2']);
  });

  test('does not group nodes with different values', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'bob@co.com' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('fuzzy matching produces candidates, not groups', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_COMPANY },
      { tempId: 'n2', nodeType: NT_COMPANY },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Acme Corp' },
        { tempId: 'p2', propertyTypeId: PT_NAME, parentTempId: 'n2', value: 'Acme Corporation' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_NAME as string), fuzzy: true }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(1);
    expect(fuzzyCandidates[0].tempIdA).toBe('n1');
    expect(fuzzyCandidates[0].tempIdB).toBe('n2');
  });

  test('does not produce candidates when fuzzy similarity is too low', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_COMPANY },
      { tempId: 'n2', nodeType: NT_COMPANY },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Apple' },
        { tempId: 'p2', propertyTypeId: PT_NAME, parentTempId: 'n2', value: 'Banana' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_NAME as string), fuzzy: true }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('groups three duplicates into one group', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
      { tempId: 'n3', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'alice@co.com' },
        { tempId: 'p3', propertyTypeId: PT_EMAIL, parentTempId: 'n3', value: 'alice@co.com' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
    expect(exactGroups[0].mergedTempIds).toHaveLength(2);
  });

  test('AND within constraint: both entries must match', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'deal-1', nodeType: NT_DEAL },
      { tempId: 'deal-2', nodeType: NT_DEAL },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-1', value: 'Series A' },
        { tempId: 'p2', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-2', value: 'Series A' },
      ],
      edges: [
        { sourceTempId: 'deal-1', targetTempId: 'comp-1', edgeType: ET_DEAL_FOR },
        { sourceTempId: 'deal-2', targetTempId: 'comp-2', edgeType: ET_DEAL_FOR },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [
        { expr: propExpr(PT_ROUND_TYPE as string), fuzzy: true },
        { expr: edgeExpr(ET_DEAL_FOR as string, 'outgoing') },
      ],
    ];

    // Different companies → edge targets don't match → no group or candidate
    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('AND within constraint with fuzzy: produces candidate when edge targets match', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'deal-1', nodeType: NT_DEAL },
      { tempId: 'deal-2', nodeType: NT_DEAL },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-1', value: 'Series A' },
        { tempId: 'p2', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-2', value: 'Series A' },
      ],
      edges: [
        { sourceTempId: 'deal-1', targetTempId: 'comp-1', edgeType: ET_DEAL_FOR },
        { sourceTempId: 'deal-2', targetTempId: 'comp-1', edgeType: ET_DEAL_FOR },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [
        { expr: propExpr(PT_ROUND_TYPE as string), fuzzy: true },
        { expr: edgeExpr(ET_DEAL_FOR as string, 'outgoing') },
      ],
    ];

    // Same company → edge targets match → fuzzy candidate (not auto-merge)
    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(1);
  });

  test('OR across constraints: matches on any exact constraint', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice Smith' },
        { tempId: 'p3', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'different@co.com' },
        { tempId: 'p4', propertyTypeId: PT_NAME, parentTempId: 'n2', value: 'Alice Smith' },
      ],
    });

    // OR: [email] OR [name]
    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
      [{ expr: propExpr(PT_NAME as string) }],
    ];

    // Emails differ but names match → exact group via second constraint
    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
  });

  test('returns empty for single node', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
    ];

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, makeSubgraph({ nodes }));
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('returns empty for no constraints', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, [], makeSubgraph({ nodes }));
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });
});

// ── buildResolutionOrder ──

describe('buildResolutionOrder', () => {
  test('puts dependency-free types before dependent types', () => {
    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_COMPANY, { constraints: [[{ expr: propExpr(PT_NAME as string), fuzzy: true }]] }],
      [NT_DEAL, { constraints: [[
        { expr: propExpr(PT_ROUND_TYPE as string), fuzzy: true },
        { expr: edgeExpr(ET_DEAL_FOR as string, 'outgoing') },
      ]] }],
    ]);

    const edgeTypes = new Map<EdgeTypeId, { sourceNodeTypeId: NodeTypeId; targetNodeTypeId: NodeTypeId }>([
      [ET_DEAL_FOR, { sourceNodeTypeId: NT_DEAL, targetNodeTypeId: NT_COMPANY }],
    ]);

    const order = buildResolutionOrder(nodeTypes, edgeTypes);
    const companyIdx = order.indexOf(NT_COMPANY);
    const dealIdx = order.indexOf(NT_DEAL);
    expect(companyIdx).toBeLessThan(dealIdx);
  });

  test('handles types with no constraints', () => {
    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_PERSON, { constraints: null }],
      [NT_COMPANY, { constraints: [[{ expr: propExpr(PT_NAME as string) }]] }],
    ]);

    const order = buildResolutionOrder(nodeTypes, new Map());
    expect(order).toHaveLength(2);
  });

  test('detects cycles and throws', () => {
    const ET_FOUNDED_BY = 'et-founded-by' as EdgeTypeId;

    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_PERSON, { constraints: [[{ expr: edgeExpr(ET_WORKS_AT as string, 'outgoing') }]] }],
      [NT_COMPANY, { constraints: [[{ expr: edgeExpr(ET_FOUNDED_BY as string, 'outgoing') }]] }],
    ]);

    const edgeTypes = new Map<EdgeTypeId, { sourceNodeTypeId: NodeTypeId; targetNodeTypeId: NodeTypeId }>([
      [ET_WORKS_AT, { sourceNodeTypeId: NT_PERSON, targetNodeTypeId: NT_COMPANY }],
      [ET_FOUNDED_BY, { sourceNodeTypeId: NT_COMPANY, targetNodeTypeId: NT_PERSON }],
    ]);

    expect(() => buildResolutionOrder(nodeTypes, edgeTypes)).toThrow('Cycle detected');
  });

  test('three-level dependency chain resolves in correct order', () => {
    const NT_ROUND = 'nt-round' as NodeTypeId;
    const ET_ROUND_AT = 'et-round-at' as EdgeTypeId;

    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_COMPANY, { constraints: [[{ expr: propExpr(PT_NAME as string), fuzzy: true }]] }],
      [NT_DEAL, { constraints: [[
        { expr: propExpr(PT_ROUND_TYPE as string) },
        { expr: edgeExpr(ET_DEAL_FOR as string, 'outgoing') },
      ]] }],
      [NT_ROUND, { constraints: [[
        { expr: propExpr('pt-round-name' as string) },
        { expr: edgeExpr(ET_ROUND_AT as string, 'outgoing') },
      ]] }],
    ]);

    const edgeTypes = new Map<EdgeTypeId, { sourceNodeTypeId: NodeTypeId; targetNodeTypeId: NodeTypeId }>([
      [ET_DEAL_FOR, { sourceNodeTypeId: NT_DEAL, targetNodeTypeId: NT_COMPANY }],
      [ET_ROUND_AT, { sourceNodeTypeId: NT_ROUND, targetNodeTypeId: NT_DEAL }],
    ]);

    const order = buildResolutionOrder(nodeTypes, edgeTypes);
    expect(order.indexOf(NT_COMPANY)).toBeLessThan(order.indexOf(NT_DEAL));
    expect(order.indexOf(NT_DEAL)).toBeLessThan(order.indexOf(NT_ROUND));
  });

  test('independent types can appear in any order', () => {
    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_PERSON, { constraints: [[{ expr: propExpr(PT_EMAIL as string) }]] }],
      [NT_COMPANY, { constraints: [[{ expr: propExpr(PT_NAME as string) }]] }],
    ]);

    const order = buildResolutionOrder(nodeTypes, new Map());
    expect(order).toHaveLength(2);
    expect(order).toContain(NT_PERSON);
    expect(order).toContain(NT_COMPANY);
  });

  test('incoming edge direction resolves dependency correctly', () => {
    // Deal's constraint uses incoming edge from Company (Company→Deal)
    const ET_HAS_DEAL = 'et-has-deal' as EdgeTypeId;
    const nodeTypes = new Map<NodeTypeId, { constraints: StoredUniquenessConstraints | null }>([
      [NT_COMPANY, { constraints: [[{ expr: propExpr(PT_NAME as string) }]] }],
      [NT_DEAL, { constraints: [[
        { expr: propExpr(PT_ROUND_TYPE as string) },
        { expr: edgeExpr(ET_HAS_DEAL as string, 'incoming') },
      ]] }],
    ]);

    const edgeTypes = new Map<EdgeTypeId, { sourceNodeTypeId: NodeTypeId; targetNodeTypeId: NodeTypeId }>([
      [ET_HAS_DEAL, { sourceNodeTypeId: NT_COMPANY, targetNodeTypeId: NT_DEAL }],
    ]);

    const order = buildResolutionOrder(nodeTypes, edgeTypes);
    // Deal depends on Company (via incoming edge) so Company first
    expect(order.indexOf(NT_COMPANY)).toBeLessThan(order.indexOf(NT_DEAL));
  });
});

// ── Edge cases: findDedupGroups ──

describe('findDedupGroups — edge cases', () => {
  test('null property values prevent matching', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        // n2 has no email property
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('case-insensitive exact matching', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'Alice@CO.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'alice@co.com' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
  });

  test('first OR constraint short-circuits — no need for second to match', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'alice@co.com' },
        { tempId: 'p3', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice' },
        { tempId: 'p4', propertyTypeId: PT_NAME, parentTempId: 'n2', value: 'Different Name' },
      ],
    });

    // OR: [email] OR [name] — email matches even though name doesn't
    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
      [{ expr: propExpr(PT_NAME as string) }],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
  });

  test('mixed: some pairs group, others do not', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_PERSON },
      { tempId: 'n2', nodeType: NT_PERSON },
      { tempId: 'n3', nodeType: NT_PERSON },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'alice@co.com' },
        { tempId: 'p3', propertyTypeId: PT_EMAIL, parentTempId: 'n3', value: 'bob@co.com' },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
    // n1 and n2 grouped, n3 separate
    const group = exactGroups[0];
    expect([group.canonicalTempId, ...group.mergedTempIds].sort()).toEqual(['n1', 'n2']);
  });

  test('compound AND constraint with incoming edge (all exact)', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'deal-1', nodeType: NT_DEAL },
      { tempId: 'deal-2', nodeType: NT_DEAL },
    ];

    const ET_HAS_DEAL = 'et-has-deal' as EdgeTypeId;

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-1', value: 'Series A' },
        { tempId: 'p2', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-2', value: 'Series A' },
      ],
      edges: [
        // Company comp-1 owns both deals (incoming from Company to Deal)
        { sourceTempId: 'comp-1', targetTempId: 'deal-1', edgeType: ET_HAS_DEAL },
        { sourceTempId: 'comp-1', targetTempId: 'deal-2', edgeType: ET_HAS_DEAL },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [
        { expr: propExpr(PT_ROUND_TYPE as string) },
        { expr: edgeExpr(ET_HAS_DEAL as string, 'incoming') },
      ],
    ];

    const { exactGroups } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(1);
  });

  test('compound AND with incoming edge — different parents prevent grouping', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'deal-1', nodeType: NT_DEAL },
      { tempId: 'deal-2', nodeType: NT_DEAL },
    ];

    const ET_HAS_DEAL = 'et-has-deal' as EdgeTypeId;

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        { tempId: 'p1', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-1', value: 'Series A' },
        { tempId: 'p2', propertyTypeId: PT_ROUND_TYPE, parentTempId: 'deal-2', value: 'Series A' },
      ],
      edges: [
        { sourceTempId: 'comp-1', targetTempId: 'deal-1', edgeType: ET_HAS_DEAL },
        { sourceTempId: 'comp-2', targetTempId: 'deal-2', edgeType: ET_HAS_DEAL },
      ],
    });

    const constraints: StoredUniquenessConstraints = [
      [
        { expr: propExpr(PT_ROUND_TYPE as string) },
        { expr: edgeExpr(ET_HAS_DEAL as string, 'incoming') },
      ],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    expect(exactGroups).toHaveLength(0);
    expect(fuzzyCandidates).toHaveLength(0);
  });

  test('mixed exact and fuzzy: exact groups + fuzzy candidates', () => {
    const nodes: ExtractedNode[] = [
      { tempId: 'n1', nodeType: NT_COMPANY },
      { tempId: 'n2', nodeType: NT_COMPANY },
      { tempId: 'n3', nodeType: NT_COMPANY },
    ];

    const subgraph = makeSubgraph({
      nodes,
      properties: [
        // n1 and n2 share exact email → exact match
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'info@acme.com' },
        { tempId: 'p2', propertyTypeId: PT_EMAIL, parentTempId: 'n2', value: 'info@acme.com' },
        // n3 has fuzzy-similar name to n1 → fuzzy candidate
        { tempId: 'p3', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Acme Corp' },
        { tempId: 'p4', propertyTypeId: PT_NAME, parentTempId: 'n3', value: 'Acme Corporation' },
      ],
    });

    // OR: [exact email] OR [fuzzy name]
    const constraints: StoredUniquenessConstraints = [
      [{ expr: propExpr(PT_EMAIL as string) }],
      [{ expr: propExpr(PT_NAME as string), fuzzy: true }],
    ];

    const { exactGroups, fuzzyCandidates } = findDedupGroups(nodes, constraints, subgraph);
    // n1 and n2 exact-grouped via email
    expect(exactGroups).toHaveLength(1);
    expect(exactGroups[0].mergedTempIds).toHaveLength(1);
    // n1↔n3 fuzzy candidate via name
    expect(fuzzyCandidates).toHaveLength(1);
  });
});

// ── Validation edge cases ──

describe('validateUniquenessConstraints — edge cases', () => {
  test('accepts compare expressions (e.g., for future use)', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'compare',
          op: 'eq',
          left: propExpr(PT_NAME as string),
          right: { type: 'static', value: 'test' },
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
  });

  test('validates deeply nested function args', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'function',
          fn: 'coalesce',
          args: [
            propExpr(PT_NAME as string),
            { type: 'function', fn: 'lower', args: [propExpr(PT_EMAIL as string)] },
          ],
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
  });

  test('rejects disallowed function nested inside allowed function', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'function',
          fn: 'lower',
          args: [
            { type: 'llm', prompt: 'sneaky' },
          ],
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"llm" is not allowed');
  });

  test('rejects disallowed function name', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'function',
          fn: 'count',
          args: [propExpr(PT_NAME as string)],
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"count" is not allowed');
  });

  test('accepts logical expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'logical',
          op: 'and',
          operands: [
            { type: 'compare', op: 'eq', left: propExpr(PT_NAME as string), right: { type: 'static', value: 'x' } },
            { type: 'compare', op: 'eq', left: propExpr(PT_EMAIL as string), right: { type: 'static', value: 'y' } },
          ],
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
  });

  test('accepts not expressions', () => {
    const constraints: StoredUniquenessConstraints = [
      [{
        expr: {
          type: 'not',
          expression: { type: 'compare', op: 'eq', left: propExpr(PT_NAME as string), right: { type: 'static', value: 'excluded' } },
        },
      }],
    ];

    const result = validateUniquenessConstraints(constraints);
    expect(result.valid).toBe(true);
  });
});

// ── resolveExpressionInSubgraph edge cases ──

describe('resolveExpressionInSubgraph — edge cases', () => {
  test('coalesce returns first non-null value', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_EMAIL, parentTempId: 'n1', value: 'alice@co.com' },
      ],
    });

    const expr: Expression = {
      type: 'function',
      fn: 'coalesce',
      args: [
        propExpr(PT_NAME as string),  // null — no name property
        propExpr(PT_EMAIL as string), // alice@co.com
      ],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe('alice@co.com');
  });

  test('trim whitespace', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: '  Alice  ' },
      ],
    });

    const expr: Expression = {
      type: 'function',
      fn: 'trim',
      args: [propExpr(PT_NAME as string)],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe('Alice');
  });

  test('upper case', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice' },
      ],
    });

    const expr: Expression = {
      type: 'function',
      fn: 'upper',
      args: [propExpr(PT_NAME as string)],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe('ALICE');
  });

  test('isnull returns true for missing property', () => {
    const subgraph = makeSubgraph();

    const expr: Expression = {
      type: 'function',
      fn: 'isnull',
      args: [propExpr(PT_NAME as string)],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe(true);
  });

  test('isnull returns false for present property', () => {
    const subgraph = makeSubgraph({
      properties: [
        { tempId: 'p1', propertyTypeId: PT_NAME, parentTempId: 'n1', value: 'Alice' },
      ],
    });

    const expr: Expression = {
      type: 'function',
      fn: 'isnull',
      args: [propExpr(PT_NAME as string)],
    };
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBe(false);
  });

  test('unsupported expression type returns null', () => {
    const subgraph = makeSubgraph();
    const expr = { type: 'meta', key: '@current_date' } as any as Expression;
    expect(resolveExpressionInSubgraph(expr, 'n1', subgraph)).toBeNull();
  });
});

// ── stringSimilarity edge cases ──

describe('stringSimilarity — edge cases', () => {
  test('empty strings', () => {
    expect(stringSimilarity('', '')).toBe(1); // identical
  });

  test('single character strings', () => {
    // Single chars produce no bigrams, so similarity = 0/0 → 0
    expect(stringSimilarity('a', 'b')).toBe(0);
  });

  test('one empty, one non-empty', () => {
    expect(stringSimilarity('', 'hello')).toBe(0);
  });

  test('substring vs full string has reasonable similarity', () => {
    const sim = stringSimilarity('Goo', 'Google');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });
});

// ── parseConstraintText ──

describe('parseConstraintText', () => {
  const propertyByName = new Map([
    ['name', PT_NAME as string],
    ['email', PT_EMAIL as string],
  ]);

  const edgeByNodeTypeName = new Map([
    ['company', { id: ET_WORKS_AT as string, direction: 'outgoing' as const }],
    ['organisation', { id: ET_DEAL_FOR as string, direction: 'incoming' as const }],
  ]);

  test('parses single property', () => {
    const result = parseConstraintText('Name', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).expr.type).toBe('property');
    expect((result.entries![0] as any).expr.propertyTypeId).toBe(PT_NAME);
  });

  test('parses fuzzy property', () => {
    const result = parseConstraintText('FUZZY(Name)', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).fuzzy).toBe(true);
    expect((result.entries![0] as any).expr.type).toBe('property');
  });

  test('parses edge expression', () => {
    const result = parseConstraintText('-[:Company]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect((result.entries![0] as any).expr.type).toBe('traverse');
    const step = (result.entries![0] as any).expr.steps[0];
    expect(step.edgeTypeId).toBe(ET_WORKS_AT);
    expect(step.direction).toBe('outgoing');
  });

  test('parses incoming edge', () => {
    const result = parseConstraintText('-[:Organisation]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    const step = (result.entries![0] as any).expr.steps[0];
    expect(step.edgeTypeId).toBe(ET_DEAL_FOR);
    expect(step.direction).toBe('incoming');
  });

  test('parses compound AND expression', () => {
    const result = parseConstraintText(
      'FUZZY(Name) AND -[:Company]->',
      propertyByName,
      edgeByNodeTypeName,
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
    expect((result.entries![0] as any).fuzzy).toBe(true);
    expect((result.entries![0] as any).expr.type).toBe('property');
    expect((result.entries![1] as any).expr.type).toBe('traverse');
  });

  test('case-insensitive AND keyword', () => {
    const result = parseConstraintText('Name and Email', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(2);
  });

  test('case-insensitive property names', () => {
    const result = parseConstraintText('name', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect((result.entries![0] as any).expr.propertyTypeId).toBe(PT_NAME);
  });

  test('case-insensitive edge names', () => {
    const result = parseConstraintText('-[:company]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
  });

  test('fails on unknown property', () => {
    const result = parseConstraintText('UnknownProp', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown property or edge');
  });

  test('fails on unknown edge target', () => {
    const result = parseConstraintText('-[:NoSuchType]->', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown edge target');
  });

  test('fails on empty string', () => {
    const result = parseConstraintText('', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Empty');
  });

  test('fails on whitespace-only string', () => {
    const result = parseConstraintText('   ', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(false);
  });

  test('case-insensitive FUZZY keyword', () => {
    const result = parseConstraintText('fuzzy(Name)', propertyByName, edgeByNodeTypeName);
    expect(result.ok).toBe(true);
    expect((result.entries![0] as any).fuzzy).toBe(true);
  });

  test('three-way AND', () => {
    const result = parseConstraintText(
      'Name AND Email AND -[:Company]->',
      propertyByName,
      edgeByNodeTypeName,
    );
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(3);
  });

  // N1: WITHIN(<dateProperty>, "<interval>") — time-window scope.
  describe('WITHIN', () => {
    const PT_FIRST_SEEN = 'pt-first-seen' as PropertyTypeId;
    const propertyByNameWithDate = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
      ['first_seen', PT_FIRST_SEEN as string],
    ]);

    test('parses WITHIN with a 6-month interval into a function expression', () => {
      const result = parseConstraintText(
        'WITHIN(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(1);
      const expr = (result.entries![0] as any).expr;
      expect(expr.type).toBe('function');
      expect(expr.fn).toBe('within');
      expect(expr.args).toHaveLength(2);
      expect(expr.args[0]).toEqual({
        type: 'property',
        propertyTypeId: PT_FIRST_SEEN,
      });
      expect(expr.args[1]).toEqual({ type: 'static', value: '6 months' });
    });

    test('accepts single-quoted intervals', () => {
      const result = parseConstraintText(
        "WITHIN(first_seen, '1 year')",
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[1].value).toBe('1 year');
    });

    test('accepts compound intervals (e.g. "1 year 3 months")', () => {
      const result = parseConstraintText(
        'WITHIN(first_seen, "1 year 3 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[1].value).toBe('1 year 3 months');
    });

    test('combines with AND alongside FUZZY property entries', () => {
      const result = parseConstraintText(
        'FUZZY(Name) AND WITHIN(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect((result.entries![0] as any).fuzzy).toBe(true);
      expect((result.entries![1] as any).expr.type).toBe('function');
      expect((result.entries![1] as any).expr.fn).toBe('within');
    });

    test('case-insensitive WITHIN keyword', () => {
      const result = parseConstraintText(
        'within(first_seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.fn).toBe('within');
    });

    test('case-insensitive property name lookup', () => {
      const result = parseConstraintText(
        'WITHIN(First_Seen, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(true);
      const expr = (result.entries![0] as any).expr;
      expect(expr.args[0].propertyTypeId).toBe(PT_FIRST_SEEN);
    });

    test('fails on unknown property', () => {
      const result = parseConstraintText(
        'WITHIN(nonexistent, "6 months")',
        propertyByNameWithDate,
        edgeByNodeTypeName,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Unknown property');
    });
  });
});

// ── serializeConstraintEntries ──

describe('serializeConstraintEntries', () => {
  const propIdToName = new Map([
    [PT_NAME as string, 'Name'],
    [PT_EMAIL as string, 'Email'],
  ]);
  const edgeIdToTargetName = new Map([
    [ET_WORKS_AT as string, 'Company'],
  ]);
  const edgeIdToSourceName = new Map([
    [ET_DEAL_FOR as string, 'Organisation'],
  ]);

  test('serializes property entry', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string) },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('Name');
  });

  test('serializes fuzzy property', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string), fuzzy: true },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('FUZZY(Name)');
  });

  test('serializes outgoing edge', () => {
    const entries: ConstraintEntry[] = [
      { expr: edgeExpr(ET_WORKS_AT as string, 'outgoing') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('-[:Company]->');
  });

  test('serializes incoming edge using source name', () => {
    const entries: ConstraintEntry[] = [
      { expr: edgeExpr(ET_DEAL_FOR as string, 'incoming') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('-[:Organisation]->');
  });

  test('serializes compound AND', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr(PT_NAME as string), fuzzy: true },
      { expr: edgeExpr(ET_WORKS_AT as string, 'outgoing') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('FUZZY(Name) AND -[:Company]->');
  });

  test('falls back to truncated ID for unknown property', () => {
    const entries: ConstraintEntry[] = [
      { expr: propExpr('unknown-property-type-id') },
    ];
    const text = serializeConstraintEntries(entries, propIdToName, edgeIdToTargetName, edgeIdToSourceName);
    expect(text).toBe('unknown-');
  });

  test('round-trip: parse → serialize → parse produces same AST', () => {
    const propertyByName = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
    ]);
    const edgeByNodeTypeName = new Map([
      ['company', { id: ET_WORKS_AT as string, direction: 'outgoing' as const }],
    ]);

    const original = 'FUZZY(Name) AND -[:Company]->';
    const parsed = parseConstraintText(original, propertyByName, edgeByNodeTypeName);
    expect(parsed.ok).toBe(true);

    const serialized = serializeConstraintEntries(
      parsed.entries!,
      propIdToName,
      edgeIdToTargetName,
      edgeIdToSourceName,
    );
    expect(serialized).toBe(original);

    // Parse again and verify same structure
    const reparsed = parseConstraintText(serialized, propertyByName, edgeByNodeTypeName);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.entries).toEqual(parsed.entries);
  });

  // N1: WITHIN serializer round-trip.
  describe('WITHIN serialization', () => {
    const PT_FIRST_SEEN = 'pt-first-seen' as PropertyTypeId;
    const propIdToNameWithDate = new Map([
      [PT_NAME as string, 'Name'],
      [PT_EMAIL as string, 'Email'],
      [PT_FIRST_SEEN as string, 'first_seen'],
    ]);
    const propertyByNameWithDate = new Map([
      ['name', PT_NAME as string],
      ['email', PT_EMAIL as string],
      ['first_seen', PT_FIRST_SEEN as string],
    ]);
    const edgeByNodeTypeNameForWithin = new Map<
      string,
      { id: string; direction: 'outgoing' | 'incoming' }
    >([['company', { id: ET_WORKS_AT as string, direction: 'outgoing' }]]);

    test('serializes a WITHIN function expression back to text', () => {
      const entries: ConstraintEntry[] = [
        {
          expr: {
            type: 'function',
            fn: 'within',
            args: [
              { type: 'property', propertyTypeId: PT_FIRST_SEEN as string },
              { type: 'static', value: '6 months' },
            ],
          },
        },
      ];
      const text = serializeConstraintEntries(
        entries,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(text).toBe('WITHIN(first_seen, "6 months")');
    });

    test('round-trips a WITHIN expression through parse → serialize', () => {
      const original = 'WITHIN(first_seen, "6 months")';
      const parsed = parseConstraintText(
        original,
        propertyByNameWithDate,
        edgeByNodeTypeNameForWithin,
      );
      expect(parsed.ok).toBe(true);
      const serialized = serializeConstraintEntries(
        parsed.entries!,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(serialized).toBe(original);
    });

    test('round-trips a compound `FUZZY(Name) AND WITHIN(...)` expression', () => {
      const original = 'FUZZY(Name) AND WITHIN(first_seen, "1 year")';
      const parsed = parseConstraintText(
        original,
        propertyByNameWithDate,
        edgeByNodeTypeNameForWithin,
      );
      expect(parsed.ok).toBe(true);
      const serialized = serializeConstraintEntries(
        parsed.entries!,
        propIdToNameWithDate,
        edgeIdToTargetName,
        edgeIdToSourceName,
      );
      expect(serialized).toBe(original);
    });
  });
});
