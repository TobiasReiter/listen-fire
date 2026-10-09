import type { Expression } from '#shared/expression/types';

import PropertyValueType from '../../../generated/kysely/knowledge/PropertyValueType';
import EvaluationStrategy from '../../../generated/kysely/knowledge/EvaluationStrategy';
import PropertyCardinality from '../../../generated/kysely/knowledge/PropertyCardinality';

type EdgeFilter = {
  side: 'source' | 'target';
  property: string;
  value: string;
};

type TemplatePropertyDef = {
  key: string;
  name: string;
  description: string;
  valueType: PropertyValueType;
  evaluationStrategy: EvaluationStrategy;
  cardinality?: PropertyCardinality;
  enumValues?: string[];
};

// ── Uniqueness constraints ──

type TemplateConstraintEntry = {
  expr: Expression;
  fuzzy?: boolean;
};

type TemplateUniquenessConstraint = TemplateConstraintEntry[];

type TemplateNodeType = {
  key: string;
  name: string;
  description: string;
  category: 'message' | 'object';
  properties: TemplatePropertyDef[];
  unique?: TemplateUniquenessConstraint[];
  iconSvg?: string;
  displayNameTemplate?: string;
  displayNameExpression?: Expression;
};

type TemplateEdgeType = {
  key: string;
  outboundName: string;
  inboundName: string;
  description: string;
  source: string;
  target: string;
  required: boolean;
  filters?: EdgeFilter[];
  group?: string;
  properties?: TemplatePropertyDef[];
};

// ── Constraint expression helpers ──

function prop(propertyKey: string): Expression {
  return { type: 'property', propertyTypeId: propertyKey };
}

function edge(edgeKey: string, direction: 'outgoing' | 'incoming' = 'outgoing'): Expression {
  return {
    type: 'traverse',
    steps: [{ type: 'edge', edgeTypeId: edgeKey, direction }],
    expression: { type: 'static', value: true },
  };
}

function fuzzy(expr: Expression): TemplateConstraintEntry {
  return { expr, fuzzy: true };
}

function exact(expr: Expression): TemplateConstraintEntry {
  return { expr };
}

// ── Extraction plugins ──

type PluginHookRef = {
  pluginId: string;
  config?: Record<string, unknown>;
};

// ── Extraction graph: explicit tree of nodes connected by edges ──

type ExtractionNodeOptions = {
  instructions?: string;
  /** @deprecated Use entityPlugins instead */
  gather?: boolean;
  filters?: EdgeFilter[];
  contentPlugins?: PluginHookRef[];
  entityPlugins?: PluginHookRef[];
};

type ExtractionTreeNode = ExtractionNodeOptions & {
  edge: string;
  nodeType: string;
  children?: ExtractionTreeNode[];
};

type TemplateExtractionGraph = {
  key: string;
  name: string;
  description: string;
  messageNodeType: string;
  contentPlugins?: PluginHookRef[];
  entityPlugins?: PluginHookRef[];
  children: ExtractionTreeNode[];
};

type OntologyTemplate = {
  key: string;
  name: string;
  description: string;
  preview: string[];
  nodeTypes: TemplateNodeType[];
  edgeTypes: TemplateEdgeType[];
  extractionGraphs: TemplateExtractionGraph[];
};

export { prop, edge, fuzzy, exact };

export type {
  OntologyTemplate,
  TemplateNodeType,
  TemplateEdgeType,
  ExtractionTreeNode,
  TemplateExtractionGraph,
  TemplatePropertyDef,
  TemplateConstraintEntry,
  TemplateUniquenessConstraint,
  EdgeFilter,
  PluginHookRef,
};
