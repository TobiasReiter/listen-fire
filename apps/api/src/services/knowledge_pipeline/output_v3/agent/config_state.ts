// Config state container

import { randomUUID } from "node:crypto";

import type {
  OutputV3Config,
  TreeNode,
  ActionNode,
  BranchNode,
  FieldMapping,
  TraversalStep,
  FilterExpression,
} from '../schemas';
import type { OntologySummary } from './types';

type NodeRelationship = ActionNode['children'][number]['relationship'];

class ConfigState {
  config: OutputV3Config;
  private nodeIndex: Map<string, TreeNode> = new Map();
  private parentIndex: Map<string, string> = new Map();
  private ontology: OntologySummary;

  constructor(ontology: OntologySummary, initial?: OutputV3Config) {
    this.ontology = ontology;
    this.config = initial ?? {
      version: 3,
      trigger: { type: 'extraction', messageNodeTypeId: '' },
      actionTree: { roots: [] },
    };
    this.rebuildIndex();
  }

  // -- Trigger --

  setTrigger(trigger: OutputV3Config['trigger']): void {
    this.config.trigger = trigger;
  }

  // -- Tree mutations --

  addRootAction(nodeType: string): string {
    const id = randomUUID();
    const node: ActionNode = {
      kind: 'action',
      id,
      type: nodeType,
      knowledgeNodeTypeId: '',
      traversal: [],
      adapterConfig: {},
      fieldMappings: [],
      children: [],
    };
    this.config.actionTree.roots.push(node);
    this.nodeIndex.set(id, node);
    // Auto-resolve knowledgeNodeTypeId from trigger context (empty traversal = trigger's node type)
    node.knowledgeNodeTypeId = this.resolveNodeTypeFromTraversal(id, []);
    return id;
  }

  addChildAction(parentId: string, nodeType: string): string {
    const parent = this.getActionNode(parentId);
    if (!parent) throw new Error(`Action node "${parentId}" not found`);

    const id = randomUUID();
    const node: ActionNode = {
      kind: 'action',
      id,
      type: nodeType,
      knowledgeNodeTypeId: '',
      traversal: [],
      adapterConfig: {},
      fieldMappings: [],
      children: [],
    };
    parent.children.push({
      node,
      relationship: { type: 'reference' },
    });
    this.nodeIndex.set(id, node);
    this.parentIndex.set(id, parentId);
    // Auto-resolve knowledgeNodeTypeId from parent context (empty traversal = parent's node type)
    node.knowledgeNodeTypeId = this.resolveNodeTypeFromTraversal(id, []);
    return id;
  }

  addBranch(parentId?: string): string {
    const id = randomUUID();
    const node: BranchNode = {
      kind: 'branch',
      id,
      filter: { traversal: [], selection: { mode: 'property', propertyTypeId: '' }, operator: 'exists' },
    };

    if (parentId) {
      const parent = this.getActionNode(parentId);
      if (!parent) throw new Error(`Action node "${parentId}" not found`);
      parent.children.push({
        node,
        relationship: { type: 'reference' },
      });
      this.parentIndex.set(id, parentId);
    } else {
      this.config.actionTree.roots.push(node);
    }

    this.nodeIndex.set(id, node);
    return id;
  }

  setBranchChild(branchId: string, path: 'match' | 'noMatch', nodeType: string): string {
    const branch = this.getBranchNode(branchId);
    if (!branch) throw new Error(`Branch node "${branchId}" not found`);

    const id = randomUUID();
    const node: ActionNode = {
      kind: 'action',
      id,
      type: nodeType,
      knowledgeNodeTypeId: '',
      traversal: [],
      adapterConfig: {},
      fieldMappings: [],
      children: [],
    };

    branch[path] = node;
    this.nodeIndex.set(id, node);
    this.parentIndex.set(id, branchId);
    // Auto-resolve knowledgeNodeTypeId from inherited context (empty traversal = parent's type)
    node.knowledgeNodeTypeId = this.resolveNodeTypeFromTraversal(id, []);
    return id;
  }

  removeNode(nodeId: string): void {
    const node = this.nodeIndex.get(nodeId);
    if (!node) throw new Error(`Node "${nodeId}" not found`);

    // Remove from parent's children or from roots
    const parentId = this.parentIndex.get(nodeId);
    if (parentId) {
      const parent = this.nodeIndex.get(parentId);
      if (parent?.kind === 'action') {
        parent.children = parent.children.filter((c) => c.node.id !== nodeId);
      } else if (parent?.kind === 'branch') {
        if (parent.match?.id === nodeId) parent.match = undefined;
        if (parent.noMatch?.id === nodeId) parent.noMatch = undefined;
      }
    } else {
      this.config.actionTree.roots = this.config.actionTree.roots.filter((r) => r.id !== nodeId);
    }

    // Clean up indexes for removed subtree
    this.removeFromIndex(node);
  }

  // -- Mode --

  setMode(nodeId: string, mode: 'assert' | 'read'): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    node.mode = mode === 'assert' ? undefined : mode;
  }

  // -- Traversal --

  setTraversal(nodeId: string, steps: TraversalStep[]): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    node.traversal = steps;
    node.knowledgeNodeTypeId = this.resolveNodeTypeFromTraversal(nodeId, steps);
  }

  // -- Adapter config --

  setAdapterConfig(nodeId: string, key: string, value: unknown): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    // Normalize parentReferenceField: the LLM provides a slug string, but the
    // adapter expects { fieldId: string }.
    if (key === 'parentReferenceField' && typeof value === 'string') {
      node.adapterConfig[key] = { fieldId: value };
    } else {
      node.adapterConfig[key] = value;
    }
  }

  // -- Field mappings --

  addFieldMapping(nodeId: string, mapping: FieldMapping): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    node.fieldMappings.push(mapping);
  }

  updateFieldMapping(nodeId: string, index: number, partial: Partial<FieldMapping>): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    if (index < 0 || index >= node.fieldMappings.length) {
      throw new Error(`Field mapping index ${index} out of bounds`);
    }
    node.fieldMappings[index] = { ...node.fieldMappings[index], ...partial };
  }

  removeFieldMapping(nodeId: string, index: number): void {
    const node = this.getActionNode(nodeId);
    if (!node) throw new Error(`Action node "${nodeId}" not found`);
    if (index < 0 || index >= node.fieldMappings.length) {
      throw new Error(`Field mapping index ${index} out of bounds`);
    }
    node.fieldMappings.splice(index, 1);
  }

  // -- Branch filter --

  setFilter(branchId: string, filter: FilterExpression): void {
    const branch = this.getBranchNode(branchId);
    if (!branch) throw new Error(`Branch node "${branchId}" not found`);
    branch.filter = filter;
  }

  // -- Relationship --

  setRelationship(parentId: string, childId: string, relationship: NodeRelationship): void {
    const parent = this.getActionNode(parentId);
    if (!parent) throw new Error(`Action node "${parentId}" not found`);
    const child = parent.children.find((c) => c.node.id === childId);
    if (!child) throw new Error(`Child "${childId}" not found under "${parentId}"`);
    child.relationship = relationship;
  }

  // -- Lookups --

  getNode(nodeId: string): TreeNode | undefined {
    return this.nodeIndex.get(nodeId);
  }

  getActionNode(nodeId: string): ActionNode | undefined {
    const node = this.nodeIndex.get(nodeId);
    return node?.kind === 'action' ? node : undefined;
  }

  getBranchNode(nodeId: string): BranchNode | undefined {
    const node = this.nodeIndex.get(nodeId);
    return node?.kind === 'branch' ? node : undefined;
  }

  getParentId(nodeId: string): string | undefined {
    return this.parentIndex.get(nodeId);
  }

  // -- Auto-resolve knowledgeNodeTypeId from traversal --

  private resolveNodeTypeFromTraversal(nodeId: string, steps: TraversalStep[]): string {
    // Start from the trigger's node type or parent action's resolved type
    let currentNodeTypeId = this.getStartingNodeType(nodeId);
    if (!currentNodeTypeId) return '';

    for (const step of steps) {
      if (step.type === 'linkBack') continue;
      if (step.type === 'edge') {
        const edgeType = this.ontology.edgeTypes.find((e) => e.id === step.edgeTypeId);
        if (!edgeType) return '';

        if (step.direction === 'outgoing') {
          if (edgeType.source_node_type_id !== currentNodeTypeId) return '';
          currentNodeTypeId = edgeType.target_node_type_id;
        } else {
          if (edgeType.target_node_type_id !== currentNodeTypeId) return '';
          currentNodeTypeId = edgeType.source_node_type_id;
        }
      }
    }

    return currentNodeTypeId;
  }

  private getStartingNodeType(nodeId: string): string {
    // Walk up to find the starting node type:
    // - If this node has a parent action, use parent's resolved knowledgeNodeTypeId
    // - Otherwise use the trigger's node type
    const parentId = this.parentIndex.get(nodeId);
    if (parentId) {
      const parent = this.nodeIndex.get(parentId);
      if (parent?.kind === 'action') return parent.knowledgeNodeTypeId;
      if (parent?.kind === 'branch') {
        // Branch inherits from its parent
        return this.getStartingNodeType(parentId);
      }
    }

    // Root level — use trigger
    const trigger = this.config.trigger;
    if (trigger.type === 'extraction') return trigger.messageNodeTypeId;
    if (trigger.type === 'mutation') return trigger.nodeTypeId;
    return '';
  }

  // -- Index management --

  private rebuildIndex(): void {
    this.nodeIndex.clear();
    this.parentIndex.clear();
    for (const root of this.config.actionTree.roots) {
      this.indexTree(root, undefined);
    }
  }

  private indexTree(node: TreeNode, parentId: string | undefined): void {
    this.nodeIndex.set(node.id, node);
    if (parentId) this.parentIndex.set(node.id, parentId);

    if (node.kind === 'action') {
      for (const child of node.children) {
        this.indexTree(child.node, node.id);
      }
    } else if (node.kind === 'branch') {
      if (node.match) this.indexTree(node.match, node.id);
      if (node.noMatch) this.indexTree(node.noMatch, node.id);
    }
  }

  private removeFromIndex(node: TreeNode): void {
    this.nodeIndex.delete(node.id);
    this.parentIndex.delete(node.id);

    if (node.kind === 'action') {
      for (const child of node.children) {
        this.removeFromIndex(child.node);
      }
    } else if (node.kind === 'branch') {
      if (node.match) this.removeFromIndex(node.match);
      if (node.noMatch) this.removeFromIndex(node.noMatch);
    }
  }
}

export { ConfigState };
