/**
 * Unit tests for extraction deduplication and apply-time property consolidation.
 *
 * These test the awkward cases where entities appear multiple times in an
 * extraction tree (multiple parents, compound scoping, progressive extraction)
 * and need to be merged without losing data or creating duplicates.
 */

import type { NodeTypeId } from '../../../generated/kysely/knowledge/NodeType';
import type { EdgeTypeId } from '../../../generated/kysely/knowledge/EdgeType';
import type { PropertyTypeId } from '../../../generated/kysely/knowledge/PropertyType';
import type { ResourceId } from '../../../generated/kysely/knowledge/Resource';
import type EvidenceType from '../../../generated/kysely/knowledge/EvidenceType';
import type {
  ExtractedSubgraph,
  ExtractedNode,
  ExtractedProperty,
  ExtractedEdge,
  ExtractedEvidence,
  ExtractedEdgeEvidence,
  ExtractedNodeResource,
} from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the LLM execute call used by deduplicateSubgraph
const mockExecute = jest.fn();
jest.mock('../../../lib/prompts/execute', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../../../lib/prompts/definition', () => ({
  promptDef: (def: unknown) => def,
}));

jest.mock('../../../generated/kysely/knowledge/EvidenceType', () => ({
  __esModule: true,
  default: { extraction: 'extraction', user_edit: 'user_edit', retrieval: 'retrieval' },
}));

// Mock constraint loading for the new constraint-based dedup path
const mockLoadConstraints = jest.fn();
jest.mock('../uniqueness_constraints', () => {
  const actual = jest.requireActual('../uniqueness_constraints');
  return {
    ...actual,
    loadConstraintsForNodeTypes: (...args: unknown[]) => mockLoadConstraints(...args),
  };
});

const mockQbExecute = jest.fn().mockResolvedValue([]);
const mockQb = {
  selectFrom: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  execute: mockQbExecute,
};
jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => mockQb),
  getAutomationsQb: jest.fn(() => mockQb),
}));

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../lib/credentials', () => ({
  __esModule: true,
  encryptionMasterKey: 'test-key',
}));

jest.mock('../../../lib/slack', () => ({
  sendSlackNotification: jest.fn(),
}));

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(),
}));

jest.mock('../../raw_text', () => ({
  RawTextService: { getText: jest.fn() },
}));

jest.mock('../../../lib/knowledge/relationship_context', () => ({
  buildRelationshipContextFromSubgraph: jest.fn(() => ({ entries: [] })),
  formatEntityContext: jest.fn(() => ''),
}));

// Must import after mocks are set up
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Expression } from '#shared/expression/types';
import type { ConstraintEntry } from '../uniqueness_constraints';

import { deduplicateSubgraph } from '../extract';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NT_CHARACTER = 'nt-character' as NodeTypeId;
const NT_ITEM = 'nt-item' as NodeTypeId;
const NT_SESSION = 'nt-session' as NodeTypeId;
const ET_FEATURES = 'et-features-char' as EdgeTypeId;
const ET_HELD_BY = 'et-held-by' as EdgeTypeId;
const ET_GIVEN_BY = 'et-given-by' as EdgeTypeId;
const PT_NAME = 'pt-char-name' as PropertyTypeId;
const PT_CLASS = 'pt-char-class' as PropertyTypeId;
const PT_DESCRIPTION = 'pt-char-desc' as PropertyTypeId;
const PT_ITEM_NAME = 'pt-item-name' as PropertyTypeId;
const RESOURCE_ID = 'resource-1' as ResourceId;

function node(tempId: string, nodeType: NodeTypeId): ExtractedNode {
  return { tempId, nodeType };
}

function prop(
  tempId: string,
  propertyTypeId: PropertyTypeId,
  parentTempId: string,
  value: unknown,
  evidence?: string,
): ExtractedProperty {
  return {
    tempId,
    propertyTypeId,
    parentTempId,
    value,
    evidenceDescription: evidence ?? `Evidence for ${value}`,
  };
}

function edge(src: string, tgt: string, edgeType: EdgeTypeId): ExtractedEdge {
  return { sourceTempId: src, targetTempId: tgt, edgeType };
}

function evidence(propTempId: string, description: string): ExtractedEvidence {
  return {
    targetPropertyTempId: propTempId,
    resourceId: RESOURCE_ID,
    type: 'extraction' as unknown as EvidenceType,
    description,
  };
}

function emptySubgraph(messageNode: ExtractedNode): ExtractedSubgraph {
  return {
    messageNode,
    nodes: [messageNode],
    properties: [],
    edges: [],
    evidence: [],
    edgeEvidence: [],
    nodeResources: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deduplicateSubgraph', () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 1: Same entity extracted under multiple parents
  // Session → features_character → Gandalf
  // Session → involves_item → Staff → held_by → Gandalf
  // LLM clusters them → merge nodes, deduplicate properties, keep all evidence
  // ─────────────────────────────────────────────────────────────────────────

  it('merges duplicate entities from multiple tree paths and preserves all evidence', async () => {
    const session = node('session-1', NT_SESSION);
    const gandalf1 = node('gandalf-1', NT_CHARACTER);
    const gandalf2 = node('gandalf-2', NT_CHARACTER);
    const staff = node('staff-1', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, gandalf1, gandalf2, staff],
      properties: [
        prop('p1', PT_NAME, 'gandalf-1', 'Gandalf', 'Called Gandalf in combat scene'),
        prop('p2', PT_CLASS, 'gandalf-1', 'Wizard', 'Described as wizard'),
        prop('p3', PT_NAME, 'gandalf-2', 'Gandalf the Grey', 'Full name mentioned by shopkeeper'),
        prop('p4', PT_CLASS, 'gandalf-2', 'Wizard', 'Also described as wizard'),
        prop('p5', PT_ITEM_NAME, 'staff-1', 'Staff of Power', 'Item found'),
      ],
      edges: [
        edge('session-1', 'gandalf-1', ET_FEATURES),
        edge('session-1', 'staff-1', ET_FEATURES),
        edge('staff-1', 'gandalf-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'Combat scene names character as Gandalf'),
        evidence('p2', 'Combat scene describes wizard class'),
        evidence('p3', 'Shopkeeper uses full name Gandalf the Grey'),
        evidence('p4', 'Shopkeeper also calls him a wizard'),
        evidence('p5', 'Staff of Power found in treasure room'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // LLM clusters gandalf-1 and gandalf-2 together
    mockExecute.mockResolvedValueOnce({
      clusters: [['gandalf-1', 'gandalf-2']],
    });
    // No items to cluster (only one)
    // deduplicateSubgraph only calls LLM for types with >1 node

    const result = await deduplicateSubgraph(subgraph);

    // gandalf-2 should be merged into gandalf-1
    expect(result.nodes).toHaveLength(3); // session, gandalf-1, staff
    expect(result.nodes.find((n) => n.tempId === 'gandalf-2')).toBeUndefined();
    expect(result.nodes.find((n) => n.tempId === 'gandalf-1')).toBeDefined();

    // Properties: two Name props merge (keep first), two Class props merge (keep first)
    // Plus the item name. Total: 3 properties
    const charProps = result.properties.filter((p) => p.parentTempId === 'gandalf-1');
    expect(charProps).toHaveLength(2); // Name + Class (deduplicated)
    const nameProps = charProps.filter((p) => p.propertyTypeId === PT_NAME);
    expect(nameProps).toHaveLength(1);
    const classProps = charProps.filter((p) => p.propertyTypeId === PT_CLASS);
    expect(classProps).toHaveLength(1);

    // Evidence: ALL 4 character evidence records should survive, remapped to canonical properties
    const charEvidence = result.evidence.filter(
      (e) => e.targetPropertyTempId === 'p1' || e.targetPropertyTempId === 'p2',
    );
    // p1 evidence stays as p1, p3 evidence remaps to p1 (canonical for Name)
    // p2 evidence stays as p2, p4 evidence remaps to p2 (canonical for Class)
    const nameEvidence = result.evidence.filter((e) => e.targetPropertyTempId === 'p1');
    expect(nameEvidence).toHaveLength(2); // original p1 + remapped p3

    const classEvidence = result.evidence.filter((e) => e.targetPropertyTempId === 'p2');
    expect(classEvidence).toHaveLength(2); // original p2 + remapped p4

    // Item property and evidence should be untouched
    expect(result.properties.find((p) => p.tempId === 'p5')).toBeDefined();
    expect(result.evidence.filter((e) => e.targetPropertyTempId === 'p5')).toHaveLength(1);

    // Edges should be remapped: held_by now points to gandalf-1
    const heldByEdge = result.edges.find((e) => e.edgeType === ET_HELD_BY);
    expect(heldByEdge?.targetTempId).toBe('gandalf-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 2: Three duplicates — the "three names" bug scenario
  // Same character extracted from three different tree branches.
  // All three should merge, producing exactly ONE name property with 3 evidence records.
  // ─────────────────────────────────────────────────────────────────────────

  it('merges three duplicates into one node with one property and three evidence records', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const char3 = node('char-3', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, char3],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Aragorn', 'Mentioned as Aragorn in battle'),
        prop('p2', PT_NAME, 'char-2', 'Aragorn', 'Quest giver named Aragorn'),
        prop('p3', PT_NAME, 'char-3', 'Strider', 'Known as Strider at the inn'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_GIVEN_BY),
        edge('session-1', 'char-3', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'Battle scene references Aragorn'),
        evidence('p2', 'Quest dialogue names Aragorn'),
        evidence('p3', 'Inn scene uses alias Strider'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // LLM clusters all three together
    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2', 'char-3']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // One character node remains
    const charNodes = result.nodes.filter((n) => n.nodeType === NT_CHARACTER);
    expect(charNodes).toHaveLength(1);
    expect(charNodes[0].tempId).toBe('char-1'); // canonical

    // Exactly one Name property
    const nameProps = result.properties.filter((p) => p.propertyTypeId === PT_NAME);
    expect(nameProps).toHaveLength(1);
    expect(nameProps[0].parentTempId).toBe('char-1');

    // All three evidence records survive, all pointing at the canonical property
    const nameEvidence = result.evidence.filter(
      (e) => e.targetPropertyTempId === nameProps[0].tempId,
    );
    expect(nameEvidence).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 3: LLM fails to cluster — no merges happen
  // Each entity stays separate. This is the safe failure mode.
  // ─────────────────────────────────────────────────────────────────────────

  it('leaves entities separate when LLM returns singleton clusters', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'First mention'),
        evidence('p2', 'Second mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // LLM returns each in its own cluster (no merging)
    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1'], ['char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // Both nodes survive
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(2);
    // Both properties survive
    expect(result.properties).toHaveLength(2);
    // Evidence unchanged
    expect(result.evidence).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 4: Merge with conflicting property values
  // Two entities with same property type but different values.
  // After merge, the canonical property keeps its value, but both
  // evidence records survive for later re-evaluation.
  // ─────────────────────────────────────────────────────────────────────────

  it('preserves evidence from both sides when merging entities with conflicting values', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf the Grey'),
        prop('p2', PT_CLASS, 'char-1', 'Wizard'),
        prop('p3', PT_NAME, 'char-2', 'Gandalf the White'),
        prop('p4', PT_CLASS, 'char-2', 'Wizard'),
        prop('p5', PT_DESCRIPTION, 'char-2', 'A powerful being of light'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'Early in story: called Gandalf the Grey'),
        evidence('p2', 'Described as wizard'),
        evidence('p3', 'After resurrection: Gandalf the White'),
        evidence('p4', 'Still a wizard'),
        evidence('p5', 'Described as powerful being of light'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // One node
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);

    // Three distinct properties: Name, Class, Description
    const charProps = result.properties.filter((p) => p.parentTempId === 'char-1');
    expect(charProps).toHaveLength(3);

    // The canonical Name value is from char-1 (first occurrence)
    const nameProp = charProps.find((p) => p.propertyTypeId === PT_NAME)!;
    expect(nameProp.value).toBe('Gandalf the Grey');

    // But evidence from BOTH Name extractions is preserved
    const nameEvidence = result.evidence.filter(
      (e) => e.targetPropertyTempId === nameProp.tempId,
    );
    expect(nameEvidence).toHaveLength(2);
    expect(nameEvidence.map((e) => e.description)).toContain('Early in story: called Gandalf the Grey');
    expect(nameEvidence.map((e) => e.description)).toContain('After resurrection: Gandalf the White');

    // Description only existed on char-2, should survive on the merged node
    const descProp = charProps.find((p) => p.propertyTypeId === PT_DESCRIPTION)!;
    expect(descProp.value).toBe('A powerful being of light');
    expect(descProp.parentTempId).toBe('char-1'); // remapped
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 5: Edge properties across merged nodes
  // Two characters that merge, each with edges that have properties.
  // Edge properties should be remapped and deduplicated correctly.
  // ─────────────────────────────────────────────────────────────────────────

  it('remaps edge property ownership when nodes merge', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const item = node('item-1', NT_ITEM);

    const PT_EDGE_ROLE = 'pt-edge-role' as PropertyTypeId;

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, item],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Frodo'),
        prop('p2', PT_NAME, 'char-2', 'Frodo'),
        // Edge property: char-1 holds item-1 with role "bearer"
        {
          tempId: 'ep1',
          propertyTypeId: PT_EDGE_ROLE,
          parentTempId: 'char-1',
          value: 'bearer',
          ownerEdgeKey: 'item-1:char-1:et-held-by',
        },
        // Edge property: char-2 holds item-1 with role "ring-bearer"
        {
          tempId: 'ep2',
          propertyTypeId: PT_EDGE_ROLE,
          parentTempId: 'char-2',
          value: 'ring-bearer',
          ownerEdgeKey: 'item-1:char-2:et-held-by',
        },
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_HELD_BY),
        edge('item-1', 'char-1', ET_HELD_BY),
        edge('item-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'First Frodo mention'),
        evidence('p2', 'Second Frodo mention'),
        evidence('ep1', 'Described as bearer'),
        evidence('ep2', 'Described as ring-bearer'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // After merge, both edge properties should have their ownerEdgeKey remapped
    // char-2 → char-1, so both edge keys become "item-1:char-1:et-held-by"
    const edgeProps = result.properties.filter((p) => p.ownerEdgeKey != null);

    // Should be deduplicated: same ownerEdgeKey + same propertyTypeId → keep first
    expect(edgeProps).toHaveLength(1);
    expect(edgeProps[0].ownerEdgeKey).toBe('item-1:char-1:et-held-by');
    expect(edgeProps[0].value).toBe('bearer'); // first one wins

    // Evidence for the dropped edge property should be remapped to the canonical
    const edgePropEvidence = result.evidence.filter(
      (e) => e.targetPropertyTempId === edgeProps[0].tempId,
    );
    expect(edgePropEvidence).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 6: No duplicates — subgraph passes through unchanged
  // ─────────────────────────────────────────────────────────────────────────

  it('returns subgraph unchanged when no entities share a type', async () => {
    const session = node('session-1', NT_SESSION);
    const char = node('char-1', NT_CHARACTER);
    const item = node('item-1', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char, item],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_ITEM_NAME, 'item-1', 'Staff'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'item-1', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'Named Gandalf'),
        evidence('p2', 'Staff found'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // Should not even call the LLM (each type has only one node)
    const result = await deduplicateSubgraph(subgraph);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.nodes).toHaveLength(3);
    expect(result.properties).toHaveLength(2);
    expect(result.evidence).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 7: Partial merge — some characters cluster, others don't
  // 4 characters: A+B merge, C+D stay separate
  // ─────────────────────────────────────────────────────────────────────────

  it('handles partial merges correctly', async () => {
    const session = node('session-1', NT_SESSION);
    const charA = node('char-a', NT_CHARACTER);
    const charB = node('char-b', NT_CHARACTER);
    const charC = node('char-c', NT_CHARACTER);
    const charD = node('char-d', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, charA, charB, charC, charD],
      properties: [
        prop('pa', PT_NAME, 'char-a', 'Legolas'),
        prop('pb', PT_NAME, 'char-b', 'Legolas Greenleaf'),
        prop('pc', PT_NAME, 'char-c', 'Gimli'),
        prop('pd', PT_NAME, 'char-d', 'Aragorn'),
      ],
      edges: [
        edge('session-1', 'char-a', ET_FEATURES),
        edge('session-1', 'char-b', ET_FEATURES),
        edge('session-1', 'char-c', ET_FEATURES),
        edge('session-1', 'char-d', ET_FEATURES),
      ],
      evidence: [
        evidence('pa', 'Legolas appears'),
        evidence('pb', 'Legolas Greenleaf full name'),
        evidence('pc', 'Gimli appears'),
        evidence('pd', 'Aragorn appears'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-a', 'char-b'], ['char-c'], ['char-d']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // 3 character nodes survive (a+b merged, c and d separate)
    const charNodes = result.nodes.filter((n) => n.nodeType === NT_CHARACTER);
    expect(charNodes).toHaveLength(3);
    expect(charNodes.map((n) => n.tempId).sort()).toEqual(['char-a', 'char-c', 'char-d']);

    // Legolas has 1 Name property with 2 evidence records
    const legolasProps = result.properties.filter((p) => p.parentTempId === 'char-a');
    expect(legolasProps).toHaveLength(1);
    const legolasEvidence = result.evidence.filter(
      (e) => e.targetPropertyTempId === legolasProps[0].tempId,
    );
    expect(legolasEvidence).toHaveLength(2);

    // Gimli and Aragorn each have 1 Name property with 1 evidence record
    const gimliProps = result.properties.filter((p) => p.parentTempId === 'char-c');
    expect(gimliProps).toHaveLength(1);
    const aragornProps = result.properties.filter((p) => p.parentTempId === 'char-d');
    expect(aragornProps).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 8: Node resources are remapped when nodes merge
  // ─────────────────────────────────────────────────────────────────────────

  it('remaps node resources when merging nodes', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const RESOURCE_2 = 'resource-2' as ResourceId;

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'First mention'),
        evidence('p2', 'Second mention'),
      ],
      edgeEvidence: [],
      nodeResources: [
        { targetTempId: 'char-1', resourceId: RESOURCE_ID, startOffset: null, endOffset: null },
        { targetTempId: 'char-2', resourceId: RESOURCE_2, startOffset: 10, endOffset: 50 },
      ],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // Both resources should be remapped to char-1
    expect(result.nodeResources).toHaveLength(2);
    expect(result.nodeResources.every((nr) => nr.targetTempId === 'char-1')).toBe(true);
    expect(result.nodeResources.map((nr) => nr.resourceId)).toContain(RESOURCE_ID);
    expect(result.nodeResources.map((nr) => nr.resourceId)).toContain(RESOURCE_2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 9: Edge evidence is remapped when nodes merge
  // ─────────────────────────────────────────────────────────────────────────

  it('remaps edge evidence when merging nodes', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const item = node('item-1', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, item],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('item-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'First mention'),
        evidence('p2', 'Second mention'),
      ],
      edgeEvidence: [
        {
          sourceTempId: 'item-1',
          targetTempId: 'char-2',
          edgeType: ET_HELD_BY,
          resourceId: RESOURCE_ID,
          type: 'extraction' as unknown as EvidenceType,
          description: 'Item held by character',
        },
      ],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // Edge evidence should be remapped: char-2 → char-1
    expect(result.edgeEvidence).toHaveLength(1);
    expect(result.edgeEvidence[0].targetTempId).toBe('char-1');
    expect(result.edgeEvidence[0].sourceTempId).toBe('item-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 10: Merged entity has properties that only exist on the non-canonical node
  // Canonical has Name only, non-canonical has Name + Class + Description.
  // After merge: Name deduplicated, Class and Description inherited.
  // ─────────────────────────────────────────────────────────────────────────

  it('inherits unique properties from non-canonical node during merge', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER); // brief mention, name only
    const char2 = node('char-2', NT_CHARACTER); // detailed mention, multiple props

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
        prop('p3', PT_CLASS, 'char-2', 'Wizard'),
        prop('p4', PT_DESCRIPTION, 'char-2', 'An old man in grey robes'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'Brief mention'),
        evidence('p2', 'Detailed mention'),
        evidence('p3', 'Called a wizard'),
        evidence('p4', 'Described appearance'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    const charProps = result.properties.filter((p) => p.parentTempId === 'char-1');

    // Should have 3 properties: Name (deduped), Class (inherited), Description (inherited)
    expect(charProps).toHaveLength(3);
    expect(charProps.map((p) => p.propertyTypeId).sort()).toEqual(
      [PT_CLASS, PT_DESCRIPTION, PT_NAME].sort(),
    );

    // Class and Description should have their parentTempId remapped to char-1
    const classProp = charProps.find((p) => p.propertyTypeId === PT_CLASS)!;
    expect(classProp.value).toBe('Wizard');
    expect(classProp.parentTempId).toBe('char-1');

    const descProp = charProps.find((p) => p.propertyTypeId === PT_DESCRIPTION)!;
    expect(descProp.value).toBe('An old man in grey robes');
    expect(descProp.parentTempId).toBe('char-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 11: Message node is never included in deduplication
  // ─────────────────────────────────────────────────────────────────────────

  it('never merges the message node even if it shares a type', async () => {
    // Contrived: two nodes of same type as message
    // (shouldn't happen in practice but tests boundary)
    const session = node('session-1', NT_SESSION);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session],
      properties: [],
      edges: [],
      evidence: [],
      edgeEvidence: [],
      nodeResources: [],
    };

    const result = await deduplicateSubgraph(subgraph);

    expect(result.nodes).toHaveLength(1);
    expect(result.messageNode.tempId).toBe('session-1');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Case 12: Duplicate edges are NOT deduplicated (they may represent
  // different relationships), but self-edges after merge are preserved
  // ─────────────────────────────────────────────────────────────────────────

  it('preserves edges that become self-referential after merge', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const ET_RELATED = 'et-related' as EdgeTypeId;

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf the Grey'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('char-1', 'char-2', ET_RELATED), // becomes self-edge after merge
      ],
      evidence: [
        evidence('p1', 'First mention'),
        evidence('p2', 'Second mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph);

    // The related_to edge now points char-1 → char-1 (self-edge)
    // This is expected — consolidation/apply should handle or ignore self-edges
    const relatedEdge = result.edges.find((e) => e.edgeType === ET_RELATED);
    expect(relatedEdge).toBeDefined();
    expect(relatedEdge!.sourceTempId).toBe('char-1');
    expect(relatedEdge!.targetTempId).toBe('char-1');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constraint-based deduplication (deterministic path)
  // ═══════════════════════════════════════════════════════════════════════

  const TEAM_ID = 'team-1' as TeamId;

  // Helper to build a property-based constraint entry
  function propertyConstraint(propertyTypeId: string, fuzzy?: boolean): ConstraintEntry {
    return {
      expr: { type: 'property', propertyTypeId } as Expression,
      ...(fuzzy ? { fuzzy: true } : {}),
    };
  }

  // Helper to build a traverse (edge) constraint entry
  function edgeConstraint(edgeTypeId: string, direction: 'outgoing' | 'incoming'): ConstraintEntry {
    return {
      expr: {
        type: 'traverse',
        steps: [{ type: 'edge', edgeTypeId, direction }],
      } as Expression,
    };
  }

  beforeEach(() => {
    mockLoadConstraints.mockReset();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 1: Exact property match merges nodes
  // ─────────────────────────────────────────────────────────────────────────

  it('merges nodes with matching exact property constraint', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'gandalf'), // different case, exact match is case-insensitive
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'First mention'),
        evidence('p2', 'Second mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // Constraint: exact match on Name property
    const constraints = [[propertyConstraint(PT_NAME as string)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    // Should merge — no LLM call
    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
    expect(result.nodes.find((n) => n.tempId === 'char-1')).toBeDefined();

    // Evidence preserved
    const nameEvidence = result.evidence.filter((e) => e.targetPropertyTempId === 'p1');
    expect(nameEvidence).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 2: Different property values prevent merge
  // ─────────────────────────────────────────────────────────────────────────

  it('does not merge nodes when constraint property values differ', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Aragorn'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'Gandalf mention'),
        evidence('p2', 'Aragorn mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    const constraints = [[propertyConstraint(PT_NAME as string)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(2);
    expect(result.properties).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 3: Fuzzy matching merges similar names
  // ─────────────────────────────────────────────────────────────────────────

  it('merges nodes via fuzzy constraint when names are similar', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf the Grey'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf the Gray'), // similar but not identical
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'British spelling'),
        evidence('p2', 'American spelling'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    const constraints = [[propertyConstraint(PT_NAME as string, true)]]; // fuzzy
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    // Fuzzy candidates go to LLM for confirmation
    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 4: Fuzzy does NOT merge very different names
  // ─────────────────────────────────────────────────────────────────────────

  it('does not merge via fuzzy constraint when names are too different', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Sauron'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'Gandalf mention'),
        evidence('p2', 'Sauron mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    const constraints = [[propertyConstraint(PT_NAME as string, true)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 5: Compound AND constraint — both entries must match
  // ─────────────────────────────────────────────────────────────────────────

  it('requires all entries in a compound AND constraint to match', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const char3 = node('char-3', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, char3],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p1c', PT_CLASS, 'char-1', 'Wizard'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
        prop('p2c', PT_CLASS, 'char-2', 'Wizard'),
        prop('p3', PT_NAME, 'char-3', 'Gandalf'),
        prop('p3c', PT_CLASS, 'char-3', 'Fighter'), // same name, different class
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('session-1', 'char-3', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'ev1'), evidence('p1c', 'ev1c'),
        evidence('p2', 'ev2'), evidence('p2c', 'ev2c'),
        evidence('p3', 'ev3'), evidence('p3c', 'ev3c'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // AND constraint: Name AND Class must match
    const constraints = [[
      propertyConstraint(PT_NAME as string),
      propertyConstraint(PT_CLASS as string),
    ]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    // char-1 and char-2 merge (same name + class), char-3 stays separate (different class)
    const charNodes = result.nodes.filter((n) => n.nodeType === NT_CHARACTER);
    expect(charNodes).toHaveLength(2);
    expect(charNodes.map((n) => n.tempId).sort()).toEqual(['char-1', 'char-3']);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 6: OR constraints — match on either
  // ─────────────────────────────────────────────────────────────────────────

  it('merges when any OR constraint matches', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const org1 = node('org-1', NT_ITEM); // using NT_ITEM as stand-in for org

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, org1],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Mithrandir'), // different name
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('char-1', 'org-1', ET_HELD_BY), // both chars point to same org
        edge('char-2', 'org-1', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'Gandalf mention'),
        evidence('p2', 'Mithrandir mention'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // OR constraints: match on Name OR match on outgoing edge to same target
    const constraints = [
      [propertyConstraint(PT_NAME as string)],     // OR branch 1: exact name
      [edgeConstraint(ET_HELD_BY as string, 'outgoing')], // OR branch 2: same org edge
    ];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    // Names differ, but edge constraint matches (both point to org-1) → merge
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 7: Mixed types — some with constraints, some fall back to LLM
  // ─────────────────────────────────────────────────────────────────────────

  it('uses constraints for some types and LLM fallback for others', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const item1 = node('item-1', NT_ITEM);
    const item2 = node('item-2', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, item1, item2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
        prop('p3', PT_ITEM_NAME, 'item-1', 'Staff of Power'),
        prop('p4', PT_ITEM_NAME, 'item-2', 'Staff of Power'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('session-1', 'item-1', ET_FEATURES),
        edge('session-1', 'item-2', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'ev1'), evidence('p2', 'ev2'),
        evidence('p3', 'ev3'), evidence('p4', 'ev4'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // Characters have constraints, items do NOT
    const constraints = [[propertyConstraint(PT_NAME as string)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
      // NT_ITEM not in map → falls back to LLM
    );

    // LLM merges the two items
    mockExecute.mockResolvedValueOnce({
      clusters: [['item-1', 'item-2']],
    });

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    // Characters merged by constraints
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
    // Items merged by LLM
    expect(result.nodes.filter((n) => n.nodeType === NT_ITEM)).toHaveLength(1);
    // LLM was called once (for items only)
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 8: Null property values prevent matching
  // ─────────────────────────────────────────────────────────────────────────

  it('does not merge when constraint property value is null', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        // char-2 has no Name property → resolves to null
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [evidence('p1', 'ev1')],
      edgeEvidence: [],
      nodeResources: [],
    };

    const constraints = [[propertyConstraint(PT_NAME as string)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 9: Edge-based constraint — same target means same entity
  // ─────────────────────────────────────────────────────────────────────────

  it('merges nodes based on edge constraint to same target', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const org = node('org-1', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, org],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'John Smith'),
        prop('p2', PT_NAME, 'char-2', 'John Smyth'), // fuzzy-similar name
        prop('p3', PT_ITEM_NAME, 'org-1', 'Acme Corp'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('char-1', 'org-1', ET_HELD_BY),
        edge('char-2', 'org-1', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'ev1'), evidence('p2', 'ev2'), evidence('p3', 'ev3'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    // Constraint: fuzzy Name AND same org edge
    const constraints = [[
      propertyConstraint(PT_NAME as string, true), // fuzzy name match
      edgeConstraint(ET_HELD_BY as string, 'outgoing'), // same org
    ]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    // Fuzzy candidates go to LLM for confirmation
    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // John Smith / John Smyth are fuzzy similar + same org → LLM confirms merge
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
    // The org edge should be deduplicated too
    const orgEdges = result.edges.filter((e) => e.edgeType === ET_HELD_BY);
    expect(orgEdges).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 10: Edge constraint with different targets → no merge
  // ─────────────────────────────────────────────────────────────────────────

  it('does not merge when edge constraint targets differ', async () => {
    const NT_ORG_A = 'nt-org-a' as NodeTypeId;
    const NT_ORG_B = 'nt-org-b' as NodeTypeId;
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    // Different node types so they won't trigger dedup between themselves
    const org1 = node('org-1', NT_ORG_A);
    const org2 = node('org-2', NT_ORG_B);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, org1, org2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'John'),
        prop('p2', PT_NAME, 'char-2', 'John'), // same name
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('char-1', 'org-1', ET_HELD_BY), // different orgs
        edge('char-2', 'org-2', ET_HELD_BY),
      ],
      evidence: [evidence('p1', 'ev1'), evidence('p2', 'ev2')],
      edgeEvidence: [],
      nodeResources: [],
    };

    // AND constraint: exact name AND same org
    const constraints = [[
      propertyConstraint(PT_NAME as string),
      edgeConstraint(ET_HELD_BY as string, 'outgoing'),
    ]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    // Same name but different orgs — AND fails → no merge
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 11: Transitive merge via constraints
  // A matches B, B matches C → all three should merge
  // ─────────────────────────────────────────────────────────────────────────

  it('merges transitively through constraint matches', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const char3 = node('char-3', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, char3],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf the Grey'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf the Gray'), // fuzzy match with char-1
        prop('p3', PT_NAME, 'char-3', 'Gandalf the Gray'), // exact match with char-2
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('session-1', 'char-3', ET_FEATURES),
      ],
      evidence: [
        evidence('p1', 'ev1'), evidence('p2', 'ev2'), evidence('p3', 'ev3'),
      ],
      edgeEvidence: [],
      nodeResources: [],
    };

    const constraints = [[propertyConstraint(PT_NAME as string, true)]]; // fuzzy
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    // Fuzzy candidates go to LLM — LLM confirms all three are the same
    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2', 'char-3']],
    });

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // All three should merge via LLM clustering
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
    const nameEvidence = result.evidence.filter((e) => e.targetPropertyTempId === 'p1');
    expect(nameEvidence).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 12: No teamId → LLM fallback for all types
  // ─────────────────────────────────────────────────────────────────────────

  it('falls back to LLM when no teamId is provided', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Gandalf'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
      ],
      evidence: [evidence('p1', 'ev1'), evidence('p2', 'ev2')],
      edgeEvidence: [],
      nodeResources: [],
    };

    mockExecute.mockResolvedValueOnce({
      clusters: [['char-1', 'char-2']],
    });

    // No teamId → should NOT call loadConstraintsForNodeTypes
    const result = await deduplicateSubgraph(subgraph);

    expect(mockLoadConstraints).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 13: Constraint merge preserves all merge infrastructure
  // (properties, evidence, edges, edge evidence, node resources)
  // ─────────────────────────────────────────────────────────────────────────

  it('constraint-based merge preserves full merge infrastructure', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const item = node('item-1', NT_ITEM);
    const RESOURCE_2 = 'resource-2' as ResourceId;

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, item],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_CLASS, 'char-1', 'Wizard'),
        prop('p3', PT_NAME, 'char-2', 'Gandalf'),
        prop('p4', PT_DESCRIPTION, 'char-2', 'A wise old wizard'),
        prop('p5', PT_ITEM_NAME, 'item-1', 'Staff'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('item-1', 'char-2', ET_HELD_BY),
      ],
      evidence: [
        evidence('p1', 'ev1'), evidence('p2', 'ev2'),
        evidence('p3', 'ev3'), evidence('p4', 'ev4'), evidence('p5', 'ev5'),
      ],
      edgeEvidence: [
        {
          sourceTempId: 'item-1',
          targetTempId: 'char-2',
          edgeType: ET_HELD_BY,
          resourceId: RESOURCE_ID,
          type: 'extraction' as unknown as EvidenceType,
          description: 'Staff held by character',
        },
      ],
      nodeResources: [
        { targetTempId: 'char-1', resourceId: RESOURCE_ID, startOffset: null, endOffset: null },
        { targetTempId: 'char-2', resourceId: RESOURCE_2, startOffset: 10, endOffset: 50 },
      ],
    };

    const constraints = [[propertyConstraint(PT_NAME as string)]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();

    // Nodes: session + char-1 (merged) + item
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes.find((n) => n.tempId === 'char-2')).toBeUndefined();

    // Properties: Name (deduped), Class (kept), Description (inherited), Item Name
    const charProps = result.properties.filter((p) => p.parentTempId === 'char-1');
    expect(charProps).toHaveLength(3); // Name, Class, Description
    expect(charProps.find((p) => p.propertyTypeId === PT_DESCRIPTION)?.value).toBe('A wise old wizard');

    // Evidence: Name has 2, Class has 1, Description has 1, Item has 1
    const nameEvidence = result.evidence.filter((e) => e.targetPropertyTempId === 'p1');
    expect(nameEvidence).toHaveLength(2);

    // Edge evidence: remapped to char-1
    expect(result.edgeEvidence[0].targetTempId).toBe('char-1');

    // Node resources: both remapped to char-1
    expect(result.nodeResources).toHaveLength(2);
    expect(result.nodeResources.every((nr) => nr.targetTempId === 'char-1')).toBe(true);

    // Edge: held_by remapped to char-1
    const heldBy = result.edges.find((e) => e.edgeType === ET_HELD_BY);
    expect(heldBy?.targetTempId).toBe('char-1');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constraint Case 14: Incoming edge constraint
  // ─────────────────────────────────────────────────────────────────────────

  it('merges using incoming edge constraint', async () => {
    const session = node('session-1', NT_SESSION);
    const char1 = node('char-1', NT_CHARACTER);
    const char2 = node('char-2', NT_CHARACTER);
    const item = node('item-1', NT_ITEM);

    const subgraph: ExtractedSubgraph = {
      messageNode: session,
      nodes: [session, char1, char2, item],
      properties: [
        prop('p1', PT_NAME, 'char-1', 'Gandalf'),
        prop('p2', PT_NAME, 'char-2', 'Mithrandir'),
      ],
      edges: [
        edge('session-1', 'char-1', ET_FEATURES),
        edge('session-1', 'char-2', ET_FEATURES),
        edge('item-1', 'char-1', ET_HELD_BY), // item → char-1
        edge('item-1', 'char-2', ET_HELD_BY), // item → char-2 (same source)
      ],
      evidence: [evidence('p1', 'ev1'), evidence('p2', 'ev2')],
      edgeEvidence: [],
      nodeResources: [],
    };

    // Constraint: incoming edge from same source
    const constraints = [[edgeConstraint(ET_HELD_BY as string, 'incoming')]];
    mockLoadConstraints.mockResolvedValueOnce(
      new Map([[NT_CHARACTER as string, constraints]]),
    );

    const result = await deduplicateSubgraph(subgraph, undefined, TEAM_ID);

    expect(mockExecute).not.toHaveBeenCalled();
    // Same item points to both chars via held_by → incoming edge matches → merge
    expect(result.nodes.filter((n) => n.nodeType === NT_CHARACTER)).toHaveLength(1);
  });
});
