// 4-layer validator

import type { OutputV3Config, TreeNode, ActionNode, BranchNode } from '../schemas';
import type { OntologySummary, ValidationError, ValidationWarning, ValidationResult } from './types';

import { outputV3ConfigSchema } from '../schemas';

// Known adapter action types and their required config fields
const ADAPTER_CONFIG_REQUIREMENTS: Record<string, { required: string[]; optional: string[] }> = {
  'attio:object': { required: ['objectId'], optional: ['parentReferenceField'] },
  'attio:list-entry': { required: ['listId'], optional: ['deduplicationWindow'] },
  'attio:note': { required: [], optional: [] },
  'attio:task': { required: [], optional: ['assignees', 'deadlineOffsetDays'] },
  'slack:message': { required: ['channelId'], optional: [] },
  'slack:thread-reply': { required: [], optional: [] },
  'airtable:record': { required: ['baseId', 'tableId'], optional: ['linkToParentField'] },
  'google_sheets:row': { required: ['spreadsheetId', 'sheetId'], optional: [] },
  'google_sheets:table-row': { required: ['spreadsheetId', 'tableId'], optional: [] },
  'affinity:organization': { required: [], optional: [] },
  'affinity:person': { required: [], optional: [] },
  'affinity:list-entry': { required: ['listId'], optional: ['deduplicationWindow'] },
  'affinity:note': { required: [], optional: [] },
  'affinity:file': { required: [], optional: ['prettyDeckNames', 'fileTypes'] },
  'webhook:request': { required: [], optional: [] },
  'native:search': { required: [], optional: [] },
};

// Adapter types that require a parent record
const REQUIRES_PARENT: Set<string> = new Set([
  'attio:list-entry',
  'attio:note',
  'attio:task',
  'slack:thread-reply',
]);

function validate(config: OutputV3Config, ontology: OntologySummary): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Layer 1: Schema
  schemaValidation(config, errors);

  // Layer 2: Structural
  structuralValidation(config, ontology, errors);

  // Layer 3: Semantic
  semanticValidation(config, ontology, errors);

  // Layer 4: Warnings
  warningChecks(config, ontology, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// -- Layer 1: Schema validation via Zod --

function schemaValidation(config: OutputV3Config, errors: ValidationError[]): void {
  const result = outputV3ConfigSchema.safeParse(config);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
  }
}

// -- Layer 2: Structural — per-node checks --

function structuralValidation(config: OutputV3Config, ontology: OntologySummary, errors: ValidationError[]): void {
  // Trigger validation
  const trigger = config.trigger;
  if (trigger.type === 'extraction') {
    if (!trigger.messageNodeTypeId) {
      errors.push({ path: 'trigger', message: 'Extraction trigger requires a messageNodeTypeId' });
    } else if (!ontology.nodeTypes.find((nt) => nt.id === trigger.messageNodeTypeId)) {
      errors.push({ path: 'trigger', message: `Message node type "${trigger.messageNodeTypeId}" not found in ontology` });
    }
  } else if (trigger.type === 'mutation') {
    if (!trigger.nodeTypeId) {
      errors.push({ path: 'trigger', message: 'Mutation trigger requires a nodeTypeId' });
    } else if (!ontology.nodeTypes.find((nt) => nt.id === trigger.nodeTypeId)) {
      errors.push({ path: 'trigger', message: `Node type "${trigger.nodeTypeId}" not found in ontology` });
    }
  }

  // Empty tree
  if (config.actionTree.roots.length === 0) {
    errors.push({ path: 'actionTree', message: 'Action tree has no root nodes' });
  }

  // Walk tree
  for (const root of config.actionTree.roots) {
    validateTreeNode(root, ontology, errors, null);
  }
}

function validateTreeNode(
  node: TreeNode,
  ontology: OntologySummary,
  errors: ValidationError[],
  parentAction: ActionNode | null,
): void {
  if (node.kind === 'action') {
    validateActionNode(node, ontology, errors, parentAction);
  } else if (node.kind === 'branch') {
    validateBranchNode(node, ontology, errors, parentAction);
  }
}

function validateActionNode(
  node: ActionNode,
  ontology: OntologySummary,
  errors: ValidationError[],
  parentAction: ActionNode | null,
): void {
  if (!node.type) {
    errors.push({ nodeId: node.id, message: 'Action node has no type' });
  }

  if (!node.knowledgeNodeTypeId) {
    errors.push({ nodeId: node.id, message: 'Action node has no knowledgeNodeTypeId — set traversal first' });
  } else if (!ontology.nodeTypes.find((nt) => nt.id === node.knowledgeNodeTypeId)) {
    errors.push({ nodeId: node.id, message: `knowledgeNodeTypeId "${node.knowledgeNodeTypeId}" not found in ontology` });
  }

  // Validate traversal steps
  for (let i = 0; i < node.traversal.length; i++) {
    const step = node.traversal[i];
    if (step.type === 'edge') {
      const edgeType = ontology.edgeTypes.find((e) => e.id === step.edgeTypeId);
      if (!edgeType) {
        errors.push({ nodeId: node.id, message: `Traversal step ${i}: edge type "${step.edgeTypeId}" not found` });
      }
    }
  }

  // Check parent requirement
  if (REQUIRES_PARENT.has(node.type) && !parentAction) {
    errors.push({ nodeId: node.id, message: `"${node.type}" requires a parent action node` });
  }

  // Child attio:object must have parentReferenceField to link back to the parent record
  if (node.type === 'attio:object' && parentAction && !node.adapterConfig.parentReferenceField) {
    errors.push({
      nodeId: node.id,
      message: 'Child "attio:object" requires "parentReferenceField" in adapter config to link back to the parent record',
    });
  }

  // Recurse into children
  for (const child of node.children) {
    validateTreeNode(child.node, ontology, errors, node);
  }
}

function validateBranchNode(
  node: BranchNode,
  ontology: OntologySummary,
  errors: ValidationError[],
  parentAction: ActionNode | null,
): void {
  if (!node.match && !node.noMatch) {
    errors.push({ nodeId: node.id, message: 'Branch node has no match or noMatch child' });
  }

  if (node.match) validateTreeNode(node.match, ontology, errors, parentAction);
  if (node.noMatch) validateTreeNode(node.noMatch, ontology, errors, parentAction);
}

// -- Layer 3: Semantic — cross-reference checks --

function semanticValidation(config: OutputV3Config, ontology: OntologySummary, errors: ValidationError[]): void {
  for (const root of config.actionTree.roots) {
    semanticCheckTree(root, ontology, errors);
  }
}

function semanticCheckTree(node: TreeNode, ontology: OntologySummary, errors: ValidationError[]): void {
  if (node.kind === 'action') {
    semanticCheckAction(node, ontology, errors);
    for (const child of node.children) {
      semanticCheckTree(child.node, ontology, errors);
    }
  } else if (node.kind === 'branch') {
    if (node.match) semanticCheckTree(node.match, ontology, errors);
    if (node.noMatch) semanticCheckTree(node.noMatch, ontology, errors);
  }
}

function semanticCheckAction(node: ActionNode, ontology: OntologySummary, errors: ValidationError[]): void {
  // Adapter config requirements
  const adapterReqs = ADAPTER_CONFIG_REQUIREMENTS[node.type];
  if (adapterReqs) {
    for (const field of adapterReqs.required) {
      if (node.adapterConfig[field] == null || node.adapterConfig[field] === '') {
        errors.push({
          nodeId: node.id,
          message: `Adapter config for "${node.type}" requires "${field}"`,
        });
      }
    }
  }

  // Field mapping selection validation
  for (let i = 0; i < node.fieldMappings.length; i++) {
    const mapping = node.fieldMappings[i];
    // Expression-based mappings skip legacy selection validation
    if (mapping.expression) continue;
    const sel = mapping.selection;
    if (!sel) continue;

    if (sel.mode === 'property' && node.knowledgeNodeTypeId) {
      // Validate propertyTypeId exists on the resolved node type (after walking mapping traversal)
      const resolvedTypeId = resolveTraversalEndType(node.knowledgeNodeTypeId, mapping.traversal, ontology);
      if (resolvedTypeId) {
        const prop = ontology.propertyTypes.find(
          (p) => p.id === sel.propertyTypeId && p.node_type_id === resolvedTypeId,
        );
        if (!prop && sel.propertyTypeId) {
          errors.push({
            nodeId: node.id,
            message: `Field mapping ${i}: property "${sel.propertyTypeId}" not found on node type "${resolvedTypeId}"`,
          });
        }
      }
    }

    if (sel.mode === 'edge_property') {
      // Edge properties belong to an edge type — validate the mapping's traversal ends with an edge step
      const lastEdgeStep = [...mapping.traversal].reverse().find((s) => s.type === 'edge');
      if (lastEdgeStep && lastEdgeStep.type === 'edge') {
        const prop = ontology.propertyTypes.find(
          (p) => p.id === sel.propertyTypeId && p.edge_type_id === lastEdgeStep.edgeTypeId,
        );
        if (!prop && sel.propertyTypeId) {
          errors.push({
            nodeId: node.id,
            message: `Field mapping ${i}: edge property "${sel.propertyTypeId}" not found on edge type "${lastEdgeStep.edgeTypeId}"`,
          });
        }
      }
    }
  }

  // Traversal direction consistency
  let currentTypeId = node.knowledgeNodeTypeId;
  for (let i = node.traversal.length - 1; i >= 0; i--) {
    // Walk backwards to check each step ends where the previous one starts
    // (This is validated as part of resolveNodeTypeFromTraversal, but we add explicit errors here)
    const step = node.traversal[i];
    if (step.type === 'edge') {
      const edgeType = ontology.edgeTypes.find((e) => e.id === step.edgeTypeId);
      if (edgeType) {
        if (step.direction === 'outgoing' && edgeType.target_node_type_id !== currentTypeId) {
          errors.push({
            nodeId: node.id,
            message: `Traversal step ${i}: edge "${edgeType.outbound_name}" target is "${edgeType.target_node_type_id}" but expected "${currentTypeId}"`,
          });
        }
        if (step.direction === 'incoming' && edgeType.source_node_type_id !== currentTypeId) {
          errors.push({
            nodeId: node.id,
            message: `Traversal step ${i}: edge "${edgeType.inbound_name}" source is "${edgeType.source_node_type_id}" but expected "${currentTypeId}"`,
          });
        }
        // Move to the other end for next iteration
        currentTypeId = step.direction === 'outgoing' ? edgeType.source_node_type_id : edgeType.target_node_type_id;
      }
    }
  }
}

function resolveTraversalEndType(
  startTypeId: string,
  steps: { type: string; edgeTypeId?: string; direction?: string }[],
  ontology: OntologySummary,
): string | null {
  let current = startTypeId;
  for (const step of steps) {
    if (step.type === 'linkBack') continue;
    if (step.type === 'edge' && step.edgeTypeId) {
      const edgeType = ontology.edgeTypes.find((e) => e.id === step.edgeTypeId);
      if (!edgeType) return null;
      if (step.direction === 'outgoing') {
        current = edgeType.target_node_type_id;
      } else {
        current = edgeType.source_node_type_id;
      }
    }
  }
  return current;
}

// -- Layer 4: Warnings (non-blocking) --

function warningChecks(config: OutputV3Config, ontology: OntologySummary, warnings: ValidationWarning[]): void {
  for (const root of config.actionTree.roots) {
    warningCheckTree(root, ontology, warnings);
  }
}

function warningCheckTree(node: TreeNode, ontology: OntologySummary, warnings: ValidationWarning[]): void {
  if (node.kind === 'action') {
    warningCheckAction(node, ontology, warnings);
    for (const child of node.children) {
      warningCheckTree(child.node, ontology, warnings);
    }
  } else if (node.kind === 'branch') {
    warningCheckBranch(node, warnings);
    if (node.match) warningCheckTree(node.match, ontology, warnings);
    if (node.noMatch) warningCheckTree(node.noMatch, ontology, warnings);
  }
}

function warningCheckAction(node: ActionNode, ontology: OntologySummary, warnings: ValidationWarning[]): void {
  if (node.fieldMappings.length === 0) {
    warnings.push({ nodeId: node.id, message: 'Action node has no field mappings' });
  }

  // Dead-end traversal: resolved type has no properties
  if (node.knowledgeNodeTypeId) {
    const props = ontology.propertyTypes.filter((p) => p.node_type_id === node.knowledgeNodeTypeId);
    if (props.length === 0 && node.traversal.length > 0) {
      warnings.push({
        nodeId: node.id,
        message: `Traversal resolves to a node type with no properties`,
      });
    }
  }

  // Missing identity fields when adapter supports dedup
  const adapterPrefix = node.type.split(':')[0];
  if (['attio', 'airtable'].includes(adapterPrefix)) {
    const hasIdentity = node.fieldMappings.some((m) => m.identity && m.identity !== 'none');
    if (!hasIdentity && node.fieldMappings.length > 0) {
      warnings.push({
        nodeId: node.id,
        message: 'No identity fields set — adapter supports deduplication but no fields are marked for it',
      });
    }
  }
}

function warningCheckBranch(node: BranchNode, warnings: ValidationWarning[]): void {
  if (!node.match || !node.noMatch) {
    warnings.push({
      nodeId: node.id,
      message: `Branch only has ${node.match ? 'match' : 'noMatch'} path — consider adding both`,
    });
  }
}

export { validate, ADAPTER_CONFIG_REQUIREMENTS, REQUIRES_PARENT };
