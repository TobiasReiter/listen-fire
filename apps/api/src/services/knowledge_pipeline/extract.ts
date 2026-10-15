import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { EdgeTypeMetaMap, EdgeTypeMeta } from '../../lib/knowledge/relationship_context';
import type { NodeTypeId } from '../../generated/kysely/knowledge/NodeType';
import type { PropertyTypeId } from '../../generated/kysely/knowledge/PropertyType';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { FuzzyCandidate } from './uniqueness_constraints';
import type { ResourceId } from '../../generated/kysely/knowledge/Resource';
import type { Fact } from './facts';
import type {
  Segment,
  ExtractionTree,
  ExtractionTreeNode,
  ExtractionTreeNodeType,
  ExtractionTreeEdgeType,
  ExtractionTreePropertyDef,
  ExtractedNode,
  ExtractedProperty,
  ExtractedEdge,
  ExtractedEvidence,
  ExtractedEdgeEvidence,
  ExtractedNodeResource,
  ExtractedSubgraph,
} from './types';

import { execute } from '../../lib/prompts/execute';
import { parseJson } from '../../lib/utils/parse_json';
import { promptDef } from '../../lib/prompts/definition';
import { PromptFragment } from '../../lib/prompts/fragments';
import { anthropicChat } from '../../lib/anthropic';
import { logger } from 'movement-engine/services/logger';
import { sendSlackNotification } from '../../lib/slack';
import {
  buildRelationshipContextFromSubgraph,
  formatEntityContext,
} from '../../lib/knowledge/relationship_context';
import { getKnowledgeQb } from '../../lib/kysely';
import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';
import { findDedupGroups, loadConstraintsForNodeTypes } from './uniqueness_constraints';
import { RawTextService } from '../raw_text';


// -- Context formatting --

const classificationHeaders: Record<string, string> = {
  EMAIL: '## Email',
  DOCUMENT: '## Document',
  WEBSITE: '## Webpage',
  LINKEDIN: '## Profile',
  WHATSAPP: '## WhatsApp Message',
  CHAT_MESSAGE: '## Chat Message',
  PITCH_DECK_URL: '## Pitch Deck',
  FRAGMENT: '## Content',
};

async function loadSegmentTexts(segments: Segment[]): Promise<Map<string, string>> {
  const textMap = new Map<string, string>();
  for (const seg of segments) {
    if (seg.content) {
      textMap.set(seg.id, seg.content);
    } else if (seg.rawTextId) {
      const rawText = await RawTextService.getById(seg.rawTextId);
      textMap.set(seg.id, rawText.content);
    }
  }
  return textMap;
}

function formatSegments(segments: Segment[], textMap: Map<string, string>): string {
  return segments
    .map((seg) => {
      const header = classificationHeaders[seg.classification] ?? '## Content';
      const content = textMap.get(seg.id) ?? '(no content)';
      return `${header}\n${content}`;
    })
    .join('\n\n');
}

// -- Line-numbered formatting for two-phase extraction --

interface LineIndex {
  lines: string[];
  multiSegment: boolean;
}

function formatSegmentsNumbered(
  segments: Segment[],
  textMap: Map<string, string>,
): { text: string; lineIndex: LineIndex } {
  const allLines: string[] = [];
  const multi = segments.length > 1;
  const parts: string[] = [];

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const header = classificationHeaders[seg.classification] ?? '## Content';
    const content = textMap.get(seg.id) ?? '(no content)';
    const contentLines = content.split('\n');

    const numberedLines: string[] = [];
    // Header line (unnumbered)
    numberedLines.push(header);
    for (let li = 0; li < contentLines.length; li++) {
      const lineNum = allLines.length + 1;
      allLines.push(contentLines[li]);
      const prefix = multi ? `${si}:${lineNum}` : `${lineNum}`;
      numberedLines.push(`${prefix} ${contentLines[li]}`);
    }
    parts.push(numberedLines.join('\n'));
  }

  return {
    text: parts.join('\n\n'),
    lineIndex: { lines: allLines, multiSegment: multi },
  };
}

function sliceLineRefs(lineIndex: LineIndex, refs: [number, number][]): string {
  const sliced: string[] = [];
  for (const [start, end] of refs) {
    const s = Math.max(0, start - 1);
    const e = Math.min(lineIndex.lines.length, end);
    for (let i = s; i < e; i++) {
      sliced.push(lineIndex.lines[i]);
    }
  }
  return sliced.join('\n');
}

// -- Schema building --

function coerceEnumValue(raw: unknown, allowed: string[]): string | null {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;

  // Exact match
  if (allowed.includes(str)) return str;

  // Case-insensitive match
  const lower = str.toLowerCase();
  const caseMatch = allowed.find((v) => v.toLowerCase() === lower);
  if (caseMatch) return caseMatch;

  // Underscore/hyphen normalization (e.g. "series_a" → "Series A")
  const normalized = lower.replace(/[_-]/g, ' ');
  const normMatch = allowed.find((v) => v.toLowerCase().replace(/[_-]/g, ' ') === normalized);
  if (normMatch) return normMatch;

  // Substring containment (e.g. "AI Agents & Automation" → "AI Agents")
  const containsMatch = allowed.find(
    (v) => lower.includes(v.toLowerCase()) || v.toLowerCase().includes(lower),
  );
  if (containsMatch) return containsMatch;

  // No match — coerce to null so .nullable() accepts it rather than failing validation
  logger.warn(`Enum coercion failed: "${str}" not in [${allowed.join(', ')}]`);
  sendSlackNotification({
    type: 'SUPPORT',
    text: `[Extraction] Enum coercion failed: "${str}" not in [${allowed.join(', ')}]`,
    opsTitle: `Extraction value "${str}" didn't match any allowed option`,
  }).catch(() => {});
  return null;
}

function valueSchemaForType(valueType: string | null): z.ZodTypeAny {
  switch (valueType) {
    case 'number':
      return z.preprocess((val) => {
        if (val == null) return null;
        if (typeof val === 'number') return val;
        const str = String(val).trim().replace(/,/g, '');
        const cleaned = str
          .replace(/^[$£€]/, '')
          .replace(/%$/, '')
          .trim();
        const num = Number(cleaned);
        return isFinite(num) ? num : null;
      }, z.number().nullable());
    case 'boolean':
      return z.preprocess((val) => {
        if (val == null) return null;
        if (typeof val === 'boolean') return val;
        const str = String(val).trim().toLowerCase();
        if (str === 'true' || str === 'yes' || str === '1') return true;
        if (str === 'false' || str === 'no' || str === '0') return false;
        return null;
      }, z.boolean().nullable());
    default:
      return z.union([z.string(), z.number(), z.boolean(), z.null()]).nullable();
  }
}

function buildPropertySchema(propDefs: ExtractionTreePropertyDef[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const pd of propDefs) {
    const allowed = pd.enumValues;
    const valueSchema =
      allowed && allowed.length > 0
        ? z.preprocess(
            (val) => coerceEnumValue(val, allowed),
            z.enum(allowed as [string, ...string[]]).nullable(),
          )
        : valueSchemaForType(pd.valueType);
    shape[pd.name] = z
      .object({
        evidence: z.string().nullable(),
        value: valueSchema,
      })
      .nullable()
      .optional();
  }
  return shape;
}

function coerceArray<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.preprocess(
    (val) => (val != null && !Array.isArray(val) ? [val] : val),
    z.array(itemSchema),
  );
}

function buildChildSchema(children: ExtractionTreeNode[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const child of children) {
    const itemShape: Record<string, z.ZodTypeAny> = {
      ...buildPropertySchema(child.edgeType.propertyDefs),
      ...buildPropertySchema(child.propertyDefs),
      ...buildChildSchema(child.children),
    };
    shape[child.edgeType.outboundName] = coerceArray(z.object(itemShape).passthrough()).optional();
  }
  return shape;
}

function buildExtractionSchema(tree: ExtractionTree): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {
    ...buildPropertySchema(tree.messagePropertyDefs),
    ...buildChildSchema(tree.children),
  };
  return z.object(shape).passthrough();
}

// -- Display schema (for prompt rendering via PromptFragment.outputDef) --

function propertyDescription(pd: ExtractionTreePropertyDef): string {
  const parts = [pd.description];
  if (pd.identity) parts.push(`[${pd.identity}]`);
  if (pd.enumValues?.length) parts.push(`(allowed: ${pd.enumValues.join(', ')})`);
  if (pd.extractionInstructions) parts.push(`— ${pd.extractionInstructions}`);
  return parts.join(' ');
}

function buildDisplayPropertySchema(
  propDefs: ExtractionTreePropertyDef[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const pd of propDefs) {
    const enumValues = pd.enumValues;
    const valueSchema =
      enumValues && enumValues.length > 0
        ? z
            .enum(enumValues as [string, ...string[]])
            .nullable()
            .describe(`One of the allowed values, or null if not present`)
        : pd.valueType === 'number'
          ? z
              .number()
              .nullable()
              .describe('Numeric value only — no units or descriptive text, or null if not present')
          : pd.valueType === 'boolean'
            ? z.boolean().nullable().describe('true or false, or null if not present')
            : z.string().nullable().describe(`${pd.valueType}, or null if not present`);
    shape[pd.name] = z
      .object({
        evidence: z
          .string()
          .nullable()
          .describe(
            'Quote from the source text with enough context to be self-explanatory. Use [bracketed paraphrasing] to add surrounding context when the raw quote alone would be ambiguous. Null if value is null.',
          ),
        value: valueSchema,
      })
      .describe(propertyDescription(pd));
  }
  return shape;
}

function buildDisplayChildSchema(children: ExtractionTreeNode[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const child of children) {
    const itemShape: Record<string, z.ZodTypeAny> = {
      ...buildDisplayPropertySchema(child.edgeType.propertyDefs),
      ...buildDisplayPropertySchema(child.propertyDefs),
      ...buildDisplayChildSchema(child.children),
    };
    // Keep schema descriptions short — the entity guide provides full context
    const descParts = [child.nodeType.name];
    if (child.instructions) descParts.push(`| ${child.instructions}`);
    shape[child.edgeType.outboundName] = z.array(z.object(itemShape)).describe(descParts.join(' '));
  }
  return shape;
}

function buildDisplaySchema(tree: ExtractionTree): z.ZodObject {
  return z.object({
    ...buildDisplayPropertySchema(tree.messagePropertyDefs),
    ...buildDisplayChildSchema(tree.children),
  });
}

// -- System context (metadata about the current user, date, input channel) --

export interface SystemContext {
  userName?: string;
  userEmail?: string;
  currentDate?: string;
  inputChannelName?: string;
}

function formatSystemContext(ctx: SystemContext): string {
  const lines: string[] = [];
  if (ctx.userName)
    lines.push(`- Current User: ${ctx.userName}${ctx.userEmail ? ` (${ctx.userEmail})` : ''}`);
  else if (ctx.userEmail) lines.push(`- Current User Email: ${ctx.userEmail}`);
  if (ctx.currentDate) lines.push(`- Current Date: ${ctx.currentDate}`);
  if (ctx.inputChannelName) lines.push(`- Input Channel: ${ctx.inputChannelName}`);
  return lines.length > 0 ? `## System Context\n${lines.join('\n')}` : '';
}

// -- Entity guide (contextual info that doesn't fit in field descriptions) --

function buildEntityGuide(tree: ExtractionTree, systemContext?: SystemContext): string {
  const sections: string[] = [];

  if (systemContext) {
    const systemSection = formatSystemContext(systemContext);
    if (systemSection) sections.push(systemSection);
  }

  sections.push(`**${tree.messageType.name}**: ${tree.messageType.description}`);

  function describeNode(child: ExtractionTreeNode, depth: number) {
    const indent = '  '.repeat(depth);
    const req = child.edgeType.required ? 'required' : 'optional';
    const lines = [
      `${indent}**${child.nodeType.name}** (key: \`${child.edgeType.outboundName}\`, ${req}): ${child.nodeType.description}`,
    ];
    for (const f of child.edgeType.filters) {
      lines.push(`${indent}  Filter: only extract where ${f.property} = "${f.value}" (${f.side})`);
    }
    if (child.instructions) {
      lines.push(`${indent}  Guidance: ${child.instructions}`);
    }
    sections.push(lines.join('\n'));
    for (const nested of child.children) {
      describeNode(nested, depth + 1);
    }
  }

  for (const child of tree.children) {
    describeNode(child, 0);
  }

  return sections.join('\n\n');
}

// -- Extraction helpers --

async function chatAndParse(options: {
  system: string;
  userMessage: string;
  label: string;
  model?: Parameters<typeof anthropicChat>[0]['model'];
}): Promise<unknown> {
  const { system, userMessage, label, model = 'claude-sonnet-5' } = options;
  const raw = await anthropicChat({ system, userMessage, model, label });
  try {
    return parseJson(raw);
  } catch (err) {
    logger.warn(`JSON parse failed for ${label}, retrying with temperature=0.5`, {
      raw,
      error: err instanceof Error ? err.message : String(err),
    });
    const retryRaw = await anthropicChat({
      system,
      userMessage,
      model,
      label: `${label}_json_retry`,
      temperature: 0.5,
    });
    return parseJson(retryRaw);
  }
}

// -- Extraction execution --

function hasExtractionInstructions(tree: ExtractionTree): boolean {
  function check(children: ExtractionTreeNode[]): boolean {
    return children.some((c) => c.instructions || check(c.children));
  }
  return check(tree.children);
}

function buildExtractionSystemPrompt(tree: ExtractionTree, systemContext?: SystemContext): string {
  const displaySchema = buildDisplaySchema(tree);
  const entityGuide = buildEntityGuide(tree, systemContext);

  const hasInstructions = hasExtractionInstructions(tree);

  return PromptFragment.buildPrompt({
    identity: PromptFragment.identity,
    context: entityGuide,
    messageStructure: PromptFragment.segmentExplainer,
    task: `Extract structured data from the <USER_MESSAGE> according to the entity guide and output schema.
For each property, provide:
- \`evidence\`: a passage from the source text that supports this value — include enough surrounding context that the quote is self-explanatory to someone who hasn't read the source. When the verbatim quote alone would be ambiguous or too terse, use [bracketed paraphrasing] to fill in implied context (e.g. "[Wise is a] global payments [company]" rather than just "global payments").
- \`value\`: the extracted value
If a property value is not present, use null for both evidence and value.`,
    outputFormat: PromptFragment.outputDef(displaySchema),
    rules: [
      {
        title: 'Completeness',
        body: hasInstructions
          ? 'Extract entities and relationships according to the Guidance instructions in the entity guide. The Guidance instructions define which entities qualify for extraction — only extract entities that match the guidance criteria. An entity with only a name and null for every other property is valid when it meets the criteria.'
          : 'Extract ALL entities and relationships from the input. If a company, person, or organization is mentioned by name — even just once, even in passing — extract it. An entity with only a name and null for every other property is valid and expected. Err on the side of extracting too much rather than too little.',
      },
      {
        title: 'Unique names',
        body: 'Every entity of the same type MUST have a unique Name value. Entities with identical names are treated as the same entity and will be merged. When multiple distinct entities share a name (e.g. several "Stealth" companies, multiple people named "John"), disambiguate by appending context — the founder\'s name, the product area, or another distinguishing detail (e.g. "Stealth (John Smith)", "Stealth (construction agents)").',
      },
      {
        title: 'No fabrication',
        body: 'Do not fabricate entities or property values that are not supported by the text.',
      },
      {
        title: 'No empty entities',
        body: 'Only omit an entity if it truly has no name or identifying information at all.',
      },
      {
        title: 'Evidence',
        body: 'Every property must include an `evidence` field quoting the relevant passage from the input. Include enough context that the quote stands alone — a reader should understand what the evidence means without seeing the full source. Prefer longer, complete phrases over minimal fragments. When the relevant text is terse or lacks context, use [bracketed paraphrasing] to add the implied subject, object, or framing (e.g. "[The company] raised a $50M Series B [led by Sequoia]"). The words outside brackets must be verbatim from the source.',
      },
    ],
  });
}

// -- Two-phase extraction (skeleton + properties) --

function buildSkeletonTree(tree: ExtractionTree): ExtractionTree {
  function trimNode(node: ExtractionTreeNode): ExtractionTreeNode {
    const identityProps = node.propertyDefs.filter(
      (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
    );
    return {
      ...node,
      propertyDefs: identityProps,
      edgeType: { ...node.edgeType, propertyDefs: [] },
      children: node.children.map(trimNode),
    };
  }
  return {
    ...tree,
    children: tree.children.map(trimNode),
  };
}

function buildSkeletonChildSchema(children: ExtractionTreeNode[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const child of children) {
    const identityProps = child.propertyDefs.filter(
      (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
    );
    const itemShape: Record<string, z.ZodTypeAny> = {
      ...buildPropertySchema(identityProps),
      lines: z
        .array(z.tuple([z.number(), z.number()]))
        .describe('Line ranges where this entity is mentioned'),
      ...buildSkeletonChildSchema(child.children),
    };
    shape[child.edgeType.outboundName] = coerceArray(z.object(itemShape).passthrough()).optional();
  }
  return shape;
}

function buildSkeletonExtractionSchema(tree: ExtractionTree): z.ZodType {
  const shape: Record<string, z.ZodTypeAny> = {
    ...buildPropertySchema(tree.messagePropertyDefs),
    ...buildSkeletonChildSchema(tree.children),
  };
  return z.object(shape).passthrough();
}

function buildSkeletonDisplayChildSchema(
  children: ExtractionTreeNode[],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const child of children) {
    const identityProps = child.propertyDefs.filter(
      (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
    );
    const itemShape: Record<string, z.ZodTypeAny> = {
      ...buildDisplayPropertySchema(identityProps),
      lines: z.array(z.tuple([z.number(), z.number()])).describe('Line ranges [start, end]'),
      ...buildSkeletonDisplayChildSchema(child.children),
    };
    const descParts = [child.nodeType.name];
    if (child.instructions) descParts.push(`| ${child.instructions}`);
    shape[child.edgeType.outboundName] = z.array(z.object(itemShape)).describe(descParts.join(' '));
  }
  return shape;
}

function buildSkeletonDisplaySchema(tree: ExtractionTree): z.ZodObject {
  return z.object({
    ...buildDisplayPropertySchema(tree.messagePropertyDefs),
    ...buildSkeletonDisplayChildSchema(tree.children),
  });
}

function buildSkeletonSystemPrompt(tree: ExtractionTree, systemContext?: SystemContext): string {
  const displaySchema = buildSkeletonDisplaySchema(tree);
  const entityGuide = buildEntityGuide(tree, systemContext);
  const hasInstructions = hasExtractionInstructions(tree);

  return PromptFragment.buildPrompt({
    identity: PromptFragment.identity,
    context: entityGuide,
    messageStructure: PromptFragment.segmentExplainer,
    task: `Extract entities and relationships from the line-numbered <USER_MESSAGE>.
For each entity, provide:
- Identity properties (Name etc.) with \`evidence\` (contextual quote from the source — use [bracketed paraphrasing] if needed for clarity) and \`value\`
- \`lines\`: array of [start, end] line number ranges where this entity is mentioned
Do NOT extract detailed properties — only identity fields and line references.`,
    outputFormat: PromptFragment.outputDef(displaySchema),
    rules: [
      {
        title: 'Completeness',
        body: hasInstructions
          ? 'Extract entities according to the Guidance instructions.'
          : 'Extract ALL entities mentioned by name, even in passing. Err on the side of extracting too much.',
      },
      {
        title: 'Line references',
        body: 'The lines field must reference actual line numbers from the input. Include all ranges where the entity is mentioned.',
      },
      {
        title: 'Unique names',
        body: 'Every entity of the same type MUST have a unique Name. Entities with identical names will be merged. Disambiguate shared names by appending context (e.g. "Stealth (John Smith)", "Stealth (construction agents)").',
      },
      {
        title: 'No fabrication',
        body: 'Do not fabricate entities not supported by the text.',
      },
    ],
  });
}

interface SkeletonEntity {
  tempId: string;
  nodeType: NodeTypeId;
  nodeTypeName: string;
  lineRefs: [number, number][];
  identityValues: Record<string, unknown>;
}

function parseSkeletonResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  tree: ExtractionTree,
  resourceIds: ResourceId[],
): { subgraph: ExtractedSubgraph; entities: SkeletonEntity[] } {
  const nodes: ExtractedNode[] = [];
  const properties: ExtractedProperty[] = [];
  const edges: ExtractedEdge[] = [];
  const evidence: ExtractedEvidence[] = [];
  const edgeEvidence: ExtractedEdgeEvidence[] = [];
  const nodeResources: ExtractedNodeResource[] = [];
  const entities: SkeletonEntity[] = [];

  const messageNode: ExtractedNode = {
    tempId: randomUUID(),
    nodeType: tree.messageType.id,
  };
  nodes.push(messageNode);

  for (const resourceId of resourceIds) {
    nodeResources.push({
      targetTempId: messageNode.tempId,
      resourceId,
      startOffset: null,
      endOffset: null,
    });
  }

  expandProperties(
    response,
    tree.messagePropertyDefs,
    messageNode.tempId,
    properties,
    evidence,
    resourceIds,
  );

  function parseSkeletonChildren(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any,
    childDefs: ExtractionTreeNode[],
    parentTempId: string,
  ) {
    for (const childDef of childDefs) {
      const childArray = data?.[childDef.edgeType.outboundName];
      if (!Array.isArray(childArray)) continue;

      for (const item of childArray) {
        const identityProps = childDef.propertyDefs.filter(
          (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
        );
        if (identityProps.length > 0) {
          const hasIdentity = identityProps.some((pd) => {
            const val = item?.[pd.name];
            return val && val.value != null && val.value !== '';
          });
          if (!hasIdentity) continue;
        }

        const lineRefs: [number, number][] = Array.isArray(item.lines)
          ? item.lines.filter((r: unknown) => Array.isArray(r) && r.length === 2)
          : [];

        const tempId = randomUUID();
        nodes.push({ tempId, nodeType: childDef.nodeType.id, lineRefs });

        const childIsSource = childDef.edgeType.sourceNodeTypeId === childDef.nodeType.id;
        const [edgeSrc, edgeTgt] = childIsSource ? [tempId, parentTempId] : [parentTempId, tempId];

        edges.push({
          sourceTempId: edgeSrc,
          targetTempId: edgeTgt,
          edgeType: childDef.edgeType.id,
        });
        edgeEvidence.push({
          sourceTempId: edgeSrc,
          targetTempId: edgeTgt,
          edgeType: childDef.edgeType.id,
          resourceId: resourceIds[0] ?? null,
          type: EvidenceType.extraction,
          description: 'Extracted from input',
        });

        for (const resourceId of resourceIds) {
          nodeResources.push({
            targetTempId: tempId,
            resourceId,
            startOffset: null,
            endOffset: null,
          });
        }

        expandProperties(item, identityProps, tempId, properties, evidence, resourceIds);

        // Collect identity values for matching during property phase
        const idVals: Record<string, unknown> = {};
        for (const pd of identityProps) {
          const val = item?.[pd.name];
          if (val?.value != null) idVals[pd.propertyTypeId as string] = val.value;
        }

        entities.push({
          tempId,
          nodeType: childDef.nodeType.id,
          nodeTypeName: childDef.nodeType.name,
          lineRefs,
          identityValues: idVals,
        });

        parseSkeletonChildren(item, childDef.children, tempId);
      }
    }
  }

  parseSkeletonChildren(response, tree.children, messageNode.tempId);

  return {
    subgraph: { messageNode, nodes, properties, edges, evidence, edgeEvidence, nodeResources },
    entities,
  };
}

// Group skeleton entities by type, dedup by identity, merge line refs
function groupEntitiesForPropertyExtraction(
  entities: SkeletonEntity[],
  tree: ExtractionTree,
): Map<
  string,
  {
    nodeType: ExtractionTreeNodeType;
    propertyDefs: ExtractionTreePropertyDef[];
    instances: SkeletonEntity[];
  }
> {
  // Collect all node type definitions from the tree
  const nodeTypeDefs = new Map<
    string,
    { nodeType: ExtractionTreeNodeType; propertyDefs: ExtractionTreePropertyDef[] }
  >();
  function walkTree(children: ExtractionTreeNode[]) {
    for (const child of children) {
      if (!nodeTypeDefs.has(child.nodeType.id as string)) {
        nodeTypeDefs.set(child.nodeType.id as string, {
          nodeType: child.nodeType,
          propertyDefs: child.propertyDefs,
        });
      }
      walkTree(child.children);
    }
  }
  walkTree(tree.children);

  // Group unique entities by nodeType + identity key
  const groups = new Map<
    string,
    {
      nodeType: ExtractionTreeNodeType;
      propertyDefs: ExtractionTreePropertyDef[];
      instances: SkeletonEntity[];
    }
  >();

  for (const entity of entities) {
    const def = nodeTypeDefs.get(entity.nodeType as string);
    if (!def) continue;

    // Merge duplicates: same type + same identity values
    const identityKey = Object.entries(entity.identityValues)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v).toLowerCase().trim()}`)
      .join('&');
    const groupKey = `${entity.nodeType}:${identityKey}`;

    const existing = groups.get(groupKey);
    if (existing) {
      // Merge line refs from duplicate
      for (const ref of entity.lineRefs) {
        if (!existing.instances[0].lineRefs.some(([s, e]) => s === ref[0] && e === ref[1])) {
          existing.instances[0].lineRefs.push(ref);
        }
      }
      existing.instances.push(entity);
    } else {
      groups.set(groupKey, { ...def, instances: [entity] });
    }
  }

  return groups;
}

function buildPropertyExtractionPrompt(
  nodeTypeName: string,
  propertyDefs: ExtractionTreePropertyDef[],
  edgePropertyDefs: ExtractionTreePropertyDef[],
): string {
  const nonIdentityProps = propertyDefs.filter(
    (pd) => pd.identity !== 'unique' && pd.identity !== 'fuzzy',
  );
  const allProps = [...edgePropertyDefs, ...nonIdentityProps];
  if (allProps.length === 0) return '';

  const displaySchema = z.object(buildDisplayPropertySchema(allProps));

  return PromptFragment.buildPrompt({
    identity: PromptFragment.identity,
    context: `Extracting properties for a ${nodeTypeName} entity.`,
    messageStructure: 'Relevant text excerpts with the entity name at the top.',
    task: `Extract properties for the ${nodeTypeName} described in the text.
For each property, provide:
- \`evidence\`: direct quote from the text
- \`value\`: the extracted value
If not present, use null for both.`,
    outputFormat: PromptFragment.outputDef(displaySchema),
    rules: [{ title: 'No fabrication', body: 'Only extract values supported by the text.' }],
  });
}

async function extractPropertiesForEntities(
  groups: Map<
    string,
    {
      nodeType: ExtractionTreeNodeType;
      propertyDefs: ExtractionTreePropertyDef[];
      instances: SkeletonEntity[];
    }
  >,
  lineIndex: LineIndex,
  subgraph: ExtractedSubgraph,
  resourceIds: ResourceId[],
  tree: ExtractionTree,
): Promise<void> {
  // Collect edge property defs per node type from tree
  const edgePropsByNodeType = new Map<string, ExtractionTreePropertyDef[]>();
  function collectEdgeProps(children: ExtractionTreeNode[]) {
    for (const child of children) {
      if (child.edgeType.propertyDefs.length > 0) {
        const existing = edgePropsByNodeType.get(child.nodeType.id as string) ?? [];
        // Add any edge props not already collected
        for (const pd of child.edgeType.propertyDefs) {
          if (!existing.some((e) => e.propertyTypeId === pd.propertyTypeId)) {
            existing.push(pd);
          }
        }
        edgePropsByNodeType.set(child.nodeType.id as string, existing);
      }
      collectEdgeProps(child.children);
    }
  }
  collectEdgeProps(tree.children);

  for (const [, group] of groups) {
    const nonIdentityProps = group.propertyDefs.filter(
      (pd) => pd.identity !== 'unique' && pd.identity !== 'fuzzy',
    );
    const edgeProps = edgePropsByNodeType.get(group.nodeType.id as string) ?? [];

    if (nonIdentityProps.length === 0 && edgeProps.length === 0) continue;

    // For each unique entity, slice its lines and extract properties
    const primary = group.instances[0];
    if (primary.lineRefs.length === 0) continue;

    const entityText = sliceLineRefs(lineIndex, primary.lineRefs);
    if (!entityText.trim()) continue;

    const identityLabel = Object.values(primary.identityValues).filter(Boolean).join(', ');
    const focusedInput = `Extract properties for ${group.nodeType.name}: ${identityLabel}\n\n${entityText}`;

    logger.info('[two-phase] Property extraction for entity', {
      nodeType: group.nodeType.name,
      identity: identityLabel,
      lineRefs: primary.lineRefs,
      entityTextLength: entityText.length,
      entityTextPreview: entityText.slice(0, 300).replace(/\n/g, '\\n'),
      instanceCount: group.instances.length,
    });

    const systemPrompt = buildPropertyExtractionPrompt(
      group.nodeType.name,
      group.propertyDefs,
      edgeProps,
    );
    if (!systemPrompt) continue;

    const allProps = [...edgeProps, ...nonIdentityProps];
    const propSchema = z.object(buildPropertySchema(allProps)).passthrough();

    let parsed: unknown;
    try {
      parsed = await chatAndParse({
        system: systemPrompt,
        userMessage: focusedInput,
        label: 'knowledge_property_extraction',
      });
    } catch {
      logger.warn(`Property extraction JSON parse failed for ${identityLabel}, skipping`);
      continue;
    }

    let validated: Record<string, unknown>;
    try {
      validated = propSchema.parse(parsed) as Record<string, unknown>;
    } catch {
      logger.warn(`Property extraction validation failed for ${identityLabel}, skipping`);
      continue;
    }

    // Apply extracted properties to all instances of this entity
    for (const instance of group.instances) {
      // Find the edge for edge properties
      const entityEdge = subgraph.edges.find(
        (e) => e.sourceTempId === instance.tempId || e.targetTempId === instance.tempId,
      );
      const edgeSrc = entityEdge?.sourceTempId ?? instance.tempId;
      const edgeTgt = entityEdge?.targetTempId ?? instance.tempId;
      const edgeTypeId = entityEdge?.edgeType as string | undefined;

      if (edgeProps.length > 0 && edgeTypeId) {
        expandEdgeProperties(
          validated,
          edgeProps,
          edgeSrc,
          edgeTgt,
          edgeTypeId,
          instance.tempId,
          subgraph.properties,
          subgraph.evidence,
          resourceIds,
        );
      }

      expandProperties(
        validated,
        nonIdentityProps,
        instance.tempId,
        subgraph.properties,
        subgraph.evidence,
        resourceIds,
      );
    }
  }
}

async function extractTwoPhase(
  tree: ExtractionTree,
  segments: Segment[],
  textMap: Map<string, string>,
  resourceIds: ResourceId[],
  systemContext?: SystemContext,
): Promise<ExtractedSubgraph> {
  // Phase 1: skeleton extraction with line-numbered input
  const { text: numberedText, lineIndex } = formatSegmentsNumbered(segments, textMap);

  const skeletonSchema = buildSkeletonExtractionSchema(tree);
  const skeletonPrompt = buildSkeletonSystemPrompt(tree, systemContext);

  // Two-phase is only reached for high entity density — use Opus for the skeleton
  const model = 'claude-opus-4-6' as const;
  logger.info('Two-phase extraction: skeleton pass (Opus)');

  const parsed = await chatAndParse({
    system: skeletonPrompt,
    userMessage: numberedText,
    label: 'knowledge_skeleton_extraction',
    model,
  });

  let validated: unknown;
  try {
    validated = skeletonSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      logger.warn(`Skeleton extraction validation failed, retrying:\n${issues}`);
      const retryParsed = await chatAndParse({
        system: skeletonPrompt,
        userMessage: `${numberedText}\n\n---\n\nValidation errors:\n${issues}\n\nFix and return corrected JSON.`,
        label: 'knowledge_skeleton_extraction_retry',
        model,
      });
      validated = skeletonSchema.parse(retryParsed);
    } else {
      throw err;
    }
  }

  const { subgraph, entities } = parseSkeletonResponse(validated, tree, resourceIds);

  logger.info('Two-phase extraction: skeleton complete', {
    nodes: subgraph.nodes.length,
    edges: subgraph.edges.length,
    uniqueEntities: entities.length,
  });

  // Phase 2: property extraction per unique entity
  const groups = groupEntitiesForPropertyExtraction(entities, tree);
  const groupCount = groups.size;
  const propsNeeded = [...groups.values()].filter((g) => {
    const nonId = g.propertyDefs.filter(
      (pd) => pd.identity !== 'unique' && pd.identity !== 'fuzzy',
    );
    return nonId.length > 0;
  }).length;

  logger.info('Two-phase extraction: property pass', {
    uniqueGroups: groupCount,
    groupsNeedingProps: propsNeeded,
  });

  await extractPropertiesForEntities(groups, lineIndex, subgraph, resourceIds, tree);

  logger.info('Two-phase extraction: complete', {
    nodes: subgraph.nodes.length,
    properties: subgraph.properties.length,
  });

  return subgraph;
}

// -- Progressive extraction --

interface ExpandBranch {
  edgeType: ExtractionTreeEdgeType;
  parentNodeType: ExtractionTreeNodeType;
  fullChild: ExtractionTreeNode;
}

function splitTree(
  tree: ExtractionTree,
  dynamicExpandEdges?: Set<string>,
): {
  skeletonTree: ExtractionTree;
  expandBranches: ExpandBranch[];
} {
  const expandBranches: ExpandBranch[] = [];

  function trimChildren(
    children: ExtractionTreeNode[],
    parentNodeType: ExtractionTreeNodeType,
  ): ExtractionTreeNode[] {
    return children.map((child) => {
      const shouldExpand =
        child.expand || dynamicExpandEdges?.has(child.edgeType.outboundName);

      if (!shouldExpand) {
        return { ...child, children: trimChildren(child.children, child.nodeType) };
      }

      // Push this branch first, then recurse — ensures parents are processed before children.
      const branchIndex = expandBranches.length;
      expandBranches.push({
        edgeType: child.edgeType,
        parentNodeType,
        fullChild: child, // placeholder, updated after recursion
      });

      const trimmedChildren = trimChildren(child.children, child.nodeType);
      expandBranches[branchIndex].fullChild = { ...child, children: trimmedChildren };

      // Skeleton: keep only identity properties, drop children and edge props
      const identityProps = child.propertyDefs.filter(
        (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
      );

      return {
        ...child,
        edgeType: { ...child.edgeType, propertyDefs: [] },
        propertyDefs: identityProps,
        children: [],
      };
    });
  }

  const skeletonTree: ExtractionTree = {
    ...tree,
    children: trimChildren(tree.children, tree.messageType),
  };

  return { skeletonTree, expandBranches };
}

function getIdentityValues(
  entityTempId: string,
  subgraph: ExtractedSubgraph,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const prop of subgraph.properties) {
    if (prop.parentTempId !== entityTempId) continue;
    if (prop.value != null) {
      props[prop.propertyTypeId as string] = prop.value;
    }
  }
  return props;
}

function buildFocusContext(
  identityValues: Record<string, unknown>,
  entityTypeName: string,
  contextText: string,
): string {
  const identityParts = Object.values(identityValues).filter(Boolean);
  const identityStr = identityParts.length > 0 ? ` (${identityParts.join(', ')})` : '';

  return `## Focus Entity\nExtract details only for this ${entityTypeName}: ${identityParts[0] ?? 'unknown'}${identityParts.length > 1 ? identityStr : ''}.\nIgnore other entities of the same type.\n\n${contextText}`;
}

/**
 * Extract the structural segment of text relevant to a specific entity.
 * Splits text into segments (separated by newlines) and returns segments
 * that mention any of the entity's identity values. Falls back to the full
 * text if no identity values match.
 */
function extractEntitySection(text: string, identityValues: Record<string, unknown>): string {
  const rawValues = Object.values(identityValues).filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );

  if (rawValues.length === 0) return text;

  // Build search needles from identity + extracted values.
  // The LLM may have disambiguated names (e.g. "Stealth (Ada Lovelace)")
  // but the original text has "linkedin.com/in/ada-lovelace". We generate:
  // - Full values as-is
  // - Parenthetical content + slug variants (spaces→hyphens, no spaces)
  // - URL path segments
  // - Domain names from URLs
  const needleSet = new Set<string>();

  function addNeedle(s: string) {
    const lower = s.toLowerCase().trim();
    if (lower.length >= 4) needleSet.add(lower);
  }

  function addNameVariants(name: string) {
    addNeedle(name);
    // "Ada Lovelace" → "ada-lovelace" (LinkedIn slug style)
    addNeedle(name.replace(/\s+/g, '-'));
    // "Ada Lovelace" → "adalovelace" (no separator)
    addNeedle(name.replace(/\s+/g, ''));
  }

  for (const raw of rawValues) {
    addNeedle(raw);

    // Extract parenthetical disambiguator and generate slug variants
    const parenMatch = raw.match(/\(([^)]+)\)/);
    if (parenMatch) {
      addNameVariants(parenMatch[1]);
    }

    // For URLs, extract pathname segments and domain
    if (raw.toLowerCase().startsWith('http')) {
      try {
        const url = new URL(raw);
        addNeedle(url.hostname.replace(/^www\./, ''));
        for (const part of url.pathname.split('/')) {
          addNeedle(part);
        }
      } catch { /* not a valid URL */ }
    }

    // If value contains spaces but no parens, also generate slug variants
    // (handles names like "Alexander Wikstrom" → "alexander-wikstrom")
    if (!parenMatch && raw.includes(' ')) {
      addNameVariants(raw);
    }
  }

  const needleList = [...needleSet];
  logger.debug('[extractEntitySection] Needles', { needleList });

  // Split into structural segments: paragraphs or bullet points.
  // A segment is a non-empty line plus any continuation lines (indented or
  // non-blank lines that don't start a new bullet/emoji).
  const lines = text.split('\n');
  const segments: { start: number; end: number; text: string }[] = [];
  let segStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isBlank = line.trim() === '';
    // Detect segment starts: non-blank line after blank, or line starting with
    // bullet, emoji flag, or list marker
    const isNewSegment =
      !isBlank &&
      (segStart === -1 ||
        (i > 0 && lines[i - 1].trim() === '') ||
        /^[\s]*(?:[-•*]|[\u{1F1E6}-\u{1F1FF}]|#{1,3}\s|\d+\.\s)/u.test(line));

    if (isNewSegment) {
      if (segStart !== -1) {
        const segText = lines.slice(segStart, i).join('\n').trim();
        if (segText) segments.push({ start: segStart, end: i - 1, text: segText });
      }
      segStart = i;
    }
  }
  // Final segment
  if (segStart !== -1) {
    const segText = lines.slice(segStart).join('\n').trim();
    if (segText) segments.push({ start: segStart, end: lines.length - 1, text: segText });
  }

  if (segments.length === 0) return text;

  // Find segments mentioning any identity value
  const matched = segments.filter((seg) => {
    const lower = seg.text.toLowerCase();
    return needleList.some((needle) => lower.includes(needle));
  });

  // Also include "header" segments (like "*Speaking to*", "*Pipeline*") for context
  const headers = segments.filter(
    (seg) => /^\*[^*]+\*$/.test(seg.text.trim()) || /^#{1,3}\s/.test(seg.text.trim()),
  );

  if (matched.length === 0) {
    logger.warn('[extractEntitySection] No segments matched — falling back to full text', {
      needles: needleList,
      segmentCount: segments.length,
      segmentPreviews: segments.map((s) => s.text.slice(0, 100).replace(/\n/g, '\\n')),
    });
    return text;
  }

  const included = new Set([...matched, ...headers]);
  const result = [...included]
    .sort((a, b) => a.start - b.start)
    .map((s) => s.text)
    .join('\n\n');

  logger.info('[extractEntitySection] Scoped successfully', {
    needlesUsed: needleList,
    matchedSegments: matched.length,
    headerSegments: headers.length,
    totalSegments: segments.length,
    resultLength: result.length,
    fullTextLength: text.length,
  });

  return result;
}

function buildEntityExtractionTree(
  child: ExtractionTreeNode,
  tree: ExtractionTree,
): ExtractionTree {
  return {
    extractionGraphId: tree.extractionGraphId,
    messageType: child.nodeType,
    messagePropertyDefs: child.propertyDefs,
    messageDefaultPropertyMappings: child.defaultPropertyMappings,
    children: child.children,
    allPropertyDefsByNodeType: tree.allPropertyDefsByNodeType,
  };
}

function graftSubgraph(target: ExtractedSubgraph, source: ExtractedSubgraph, entityTempId: string) {
  const sourceTempId = source.messageNode.tempId;
  const remap = (id: string) => (id === sourceTempId ? entityTempId : id);

  // Remove Phase 1 identity-only properties for this entity
  const phase1PropTempIds = new Set(
    target.properties.filter((p) => p.parentTempId === entityTempId).map((p) => p.tempId),
  );

  if (phase1PropTempIds.size > 0) {
    target.properties = target.properties.filter((p) => !phase1PropTempIds.has(p.tempId));
    target.evidence = target.evidence.filter((e) => !phase1PropTempIds.has(e.targetPropertyTempId));
  }

  // Append source nodes (skip entity node itself)
  for (const node of source.nodes) {
    if (node.tempId === sourceTempId) continue;
    target.nodes.push(node);
  }

  // Append source properties with remapped parent and edge key
  for (const prop of source.properties) {
    let ownerEdgeKey = prop.ownerEdgeKey;
    if (ownerEdgeKey) {
      const parts = ownerEdgeKey.split(':');
      if (parts.length === 3) {
        ownerEdgeKey = `${remap(parts[0])}:${remap(parts[1])}:${parts[2]}`;
      }
    }
    target.properties.push({ ...prop, parentTempId: remap(prop.parentTempId), ownerEdgeKey });
  }

  // Append edges with remapped source entity, skipping duplicates
  const existingEdgeKeys = new Set(
    target.edges.map((e) => `${e.sourceTempId}:${e.targetTempId}:${e.edgeType}`),
  );
  for (const edge of source.edges) {
    const remapped = {
      ...edge,
      sourceTempId: remap(edge.sourceTempId),
      targetTempId: remap(edge.targetTempId),
    };
    const key = `${remapped.sourceTempId}:${remapped.targetTempId}:${remapped.edgeType}`;
    if (existingEdgeKeys.has(key)) continue;
    existingEdgeKeys.add(key);
    target.edges.push(remapped);
  }

  for (const ev of source.evidence) {
    target.evidence.push({ ...ev, targetPropertyTempId: remap(ev.targetPropertyTempId) });
  }

  for (const ev of source.edgeEvidence) {
    target.edgeEvidence.push({
      ...ev,
      sourceTempId: remap(ev.sourceTempId),
      targetTempId: remap(ev.targetTempId),
    });
  }

  for (const nr of source.nodeResources) {
    if (nr.targetTempId === sourceTempId) continue;
    target.nodeResources.push({ ...nr, targetTempId: remap(nr.targetTempId) });
  }
}

// Entity count threshold above which we upgrade to Opus for more reliable extraction.
const ENTITY_DENSITY_OPUS_THRESHOLD = 30;

// Chunk target size in chars — retained for chunked extraction fallback.
const CHUNK_TARGET_SIZE = 10000;

async function extractSingle(
  tree: ExtractionTree,
  contextText: string,
  resourceIds: ResourceId[],
  entityCount?: number,
  systemContext?: SystemContext,
): Promise<ExtractedSubgraph> {
  const useOpus = entityCount != null && entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD;
  const model = useOpus ? ('claude-opus-4-6' as const) : undefined;

  if (useOpus) {
    logger.info('[extraction] extractSingle → Opus (high entity density)', {
      entityCount,
      threshold: ENTITY_DENSITY_OPUS_THRESHOLD,
      textLength: contextText.length,
    });
  }

  return extractSingleCall(tree, contextText, resourceIds, systemContext, model);
}

async function extractSingleCall(
  tree: ExtractionTree,
  contextText: string,
  resourceIds: ResourceId[],
  systemContext?: SystemContext,
  model?: Parameters<typeof chatAndParse>[0]['model'],
): Promise<ExtractedSubgraph> {
  const schema = buildExtractionSchema(tree);
  const systemPrompt = buildExtractionSystemPrompt(tree, systemContext);

  const parsed = await chatAndParse({
    system: systemPrompt,
    userMessage: contextText,
    label: 'knowledge_extraction',
    model,
  });

  let validated: unknown;
  try {
    validated = schema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      logger.warn(`Extraction validation failed, retrying:\n${issues}`);

      const retryParsed = await chatAndParse({
        system: systemPrompt,
        userMessage: `${contextText}\n\n---\n\nYour previous response had validation errors:\n${issues}\n\nPlease fix ONLY the invalid values and return the complete corrected JSON.`,
        label: 'knowledge_extraction_retry',
        model,
      });

      validated = schema.parse(retryParsed);
    } else {
      throw err;
    }
  }

  return parseExtractionResponse(validated, tree, resourceIds);
}

// -- Chunked extraction with preamble context --

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_TARGET_SIZE) {
    logger.info('[chunking] Text fits in single chunk', {
      textLength: text.length,
      threshold: CHUNK_TARGET_SIZE,
    });
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  let chunkIndex = 0;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_TARGET_SIZE * 1.3) {
      logger.info('[chunking] Final chunk (remaining fits)', {
        chunkIndex,
        chunkLength: remaining.length,
        startsWith: remaining.slice(0, 150).replace(/\n/g, '\\n'),
        endsWith: remaining.slice(-150).replace(/\n/g, '\\n'),
      });
      chunks.push(remaining);
      break;
    }

    // Find a paragraph break near the target size
    let splitAt = remaining.lastIndexOf('\n\n', CHUNK_TARGET_SIZE);
    let splitReason = 'paragraph_break';
    if (splitAt < CHUNK_TARGET_SIZE * 0.5) {
      // No good paragraph break — try a single newline
      splitAt = remaining.lastIndexOf('\n', CHUNK_TARGET_SIZE);
      splitReason = 'newline';
    }
    if (splitAt < CHUNK_TARGET_SIZE * 0.5) {
      // No good newline — try a sentence boundary
      const upTo = remaining.slice(0, CHUNK_TARGET_SIZE);
      const lastSentence = upTo.search(/[.!?]\s+[A-Z][^.!?]*$/);
      splitAt = lastSentence > CHUNK_TARGET_SIZE * 0.3 ? lastSentence + 1 : CHUNK_TARGET_SIZE;
      splitReason = lastSentence > CHUNK_TARGET_SIZE * 0.3 ? 'sentence_boundary' : 'hard_cut';
    }

    const chunk = remaining.slice(0, splitAt).trimEnd();
    logger.info('[chunking] Split chunk', {
      chunkIndex,
      splitAt,
      splitReason,
      chunkLength: chunk.length,
      remainingLength: remaining.length - splitAt,
      startsWith: chunk.slice(0, 150).replace(/\n/g, '\\n'),
      endsWith: chunk.slice(-150).replace(/\n/g, '\\n'),
    });
    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
    chunkIndex++;
  }

  logger.info('[chunking] Split complete', {
    totalChunks: chunks.length,
    chunkSizes: chunks.map((c) => c.length),
    totalInputLength: text.length,
  });

  return chunks;
}

interface ExtractionPreamble {
  documentSummary: string;
  entitiesSeen: Map<string, string[]>; // entityName → [descriptions]
  previousChunkSummary: string;
  trailingContext: string;
}

function buildExtractionPreamble(ctx: ExtractionPreamble): string {
  let preamble = '';

  if (ctx.documentSummary) {
    preamble += `[Document context]\n${ctx.documentSummary}\n\n`;
  }

  if (ctx.entitiesSeen.size > 0) {
    preamble += '[Entities seen so far]\n';
    for (const [name, descs] of ctx.entitiesSeen) {
      preamble += `- ${name}: ${descs.join(', ')}\n`;
    }
    preamble += '\n';
  }

  if (ctx.previousChunkSummary) {
    preamble += `[Previous section]\n${ctx.previousChunkSummary}\n\n`;
  }

  if (ctx.trailingContext) {
    preamble += `[Trailing context]\n"${ctx.trailingContext}"\n\n`;
  }

  return preamble;
}

function extractTrailingContext(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(-3).join(' ').trim();
}

function updatePreambleFromSubgraph(
  ctx: ExtractionPreamble,
  subgraph: ExtractedSubgraph,
  tree: ExtractionTree,
  chunkText: string,
  chunkSummary: string,
): void {
  // Build a lookup of property type IDs to names from the tree
  const propTypeNames = new Map<string, string>();
  function collectPropNames(propDefs: ExtractionTreePropertyDef[]) {
    for (const pd of propDefs) {
      propTypeNames.set(pd.propertyTypeId as string, pd.name);
    }
  }
  function walkTree(children: ExtractionTreeNode[]) {
    for (const child of children) {
      collectPropNames(child.propertyDefs);
      collectPropNames(child.edgeType.propertyDefs);
      walkTree(child.children);
    }
  }
  collectPropNames(tree.messagePropertyDefs);
  walkTree(tree.children);

  // Build a lookup of node type IDs to names
  const nodeTypeNames = new Map<string, string>();
  nodeTypeNames.set(tree.messageType.id as string, tree.messageType.name);
  function collectNodeTypeNames(children: ExtractionTreeNode[]) {
    for (const child of children) {
      nodeTypeNames.set(child.nodeType.id as string, child.nodeType.name);
      collectNodeTypeNames(child.children);
    }
  }
  collectNodeTypeNames(tree.children);

  // Accumulate entities with their identity properties
  for (const node of subgraph.nodes) {
    if (node.tempId === subgraph.messageNode.tempId) continue;
    const nodeProps = subgraph.properties.filter(
      (p) => p.parentTempId === node.tempId && p.value != null,
    );
    if (!nodeProps.length) continue;

    // Use identity property values as the entity name
    const identityValues = nodeProps.map((p) => String(p.value)).filter(Boolean);
    const entityName = identityValues[0];
    if (!entityName) continue;

    const typeName = nodeTypeNames.get(node.nodeType as string) ?? 'entity';
    const descriptions: string[] = [`(${typeName})`];
    for (const p of nodeProps) {
      const propName = propTypeNames.get(p.propertyTypeId as string) ?? p.propertyTypeId;
      descriptions.push(`${propName}: ${p.value}`);
    }

    const existing = ctx.entitiesSeen.get(entityName) ?? [];
    for (const desc of descriptions) {
      if (!existing.includes(desc)) existing.push(desc);
    }
    ctx.entitiesSeen.set(entityName, existing);
  }

  // Update trailing context
  ctx.trailingContext = extractTrailingContext(chunkText);

  // Update previous chunk summary
  ctx.previousChunkSummary = chunkSummary;
}

function mergeSubgraphs(
  target: ExtractedSubgraph,
  source: ExtractedSubgraph,
  tree: ExtractionTree,
): void {
  // Build identity property type IDs from tree for matching
  const identityPropTypeIds = new Set<string>();
  function collectIdentityProps(children: ExtractionTreeNode[]) {
    for (const child of children) {
      for (const pd of child.propertyDefs) {
        if (pd.identity === 'unique' || pd.identity === 'fuzzy') {
          identityPropTypeIds.add(pd.propertyTypeId as string);
        }
      }
      collectIdentityProps(child.children);
    }
  }
  collectIdentityProps(tree.children);

  // Build index of existing target entities by type + identity values
  function getEntityIdentity(
    entityTempId: string,
    props: ExtractedProperty[],
  ): Map<string, string> {
    const identity = new Map<string, string>();
    for (const p of props) {
      if (p.parentTempId !== entityTempId) continue;
      if (!identityPropTypeIds.has(p.propertyTypeId as string)) continue;
      if (p.value != null) identity.set(p.propertyTypeId as string, String(p.value));
    }
    return identity;
  }

  // Map: "nodeType:identityKey=identityVal" → existing tempId
  const existingEntities = new Map<string, string>();
  for (const node of target.nodes) {
    if (node.tempId === target.messageNode.tempId) continue;
    const identity = getEntityIdentity(node.tempId, target.properties);
    if (identity.size === 0) continue;
    const key = buildMatchKey(node.nodeType as string, identity);
    existingEntities.set(key, node.tempId);
  }

  // For each source entity, either match to existing or add as new
  const tempIdRemap = new Map<string, string>();
  tempIdRemap.set(source.messageNode.tempId, target.messageNode.tempId);

  for (const node of source.nodes) {
    if (node.tempId === source.messageNode.tempId) continue;

    const identity = getEntityIdentity(node.tempId, source.properties);
    if (identity.size > 0) {
      const key = buildMatchKey(node.nodeType as string, identity);
      const existingTempId = existingEntities.get(key);
      if (existingTempId) {
        // Same entity — remap and merge properties
        tempIdRemap.set(node.tempId, existingTempId);
        continue;
      }
      // New entity — add to index
      existingEntities.set(key, node.tempId);
    }

    target.nodes.push(node);
  }

  const remap = (id: string) => tempIdRemap.get(id) ?? id;

  // Merge properties — skip duplicates (same parent + property type)
  const existingPropKeys = new Set(
    target.properties.map(
      (p) => `${p.parentTempId}:${p.propertyTypeId}${p.ownerEdgeKey ? ':' + p.ownerEdgeKey : ''}`,
    ),
  );

  for (const prop of source.properties) {
    const remappedParent = remap(prop.parentTempId);
    let ownerEdgeKey = prop.ownerEdgeKey;
    if (ownerEdgeKey) {
      const parts = ownerEdgeKey.split(':');
      if (parts.length === 3) {
        ownerEdgeKey = `${remap(parts[0])}:${remap(parts[1])}:${parts[2]}`;
      }
    }
    const propKey = `${remappedParent}:${prop.propertyTypeId}${ownerEdgeKey ? ':' + ownerEdgeKey : ''}`;
    if (existingPropKeys.has(propKey)) continue;
    existingPropKeys.add(propKey);
    target.properties.push({ ...prop, parentTempId: remappedParent, ownerEdgeKey });
  }

  // Merge edges — skip duplicates
  const existingEdgeKeys = new Set(
    target.edges.map((e) => `${e.sourceTempId}:${e.targetTempId}:${e.edgeType}`),
  );

  for (const edge of source.edges) {
    const remapped = {
      ...edge,
      sourceTempId: remap(edge.sourceTempId),
      targetTempId: remap(edge.targetTempId),
    };
    const edgeKey = `${remapped.sourceTempId}:${remapped.targetTempId}:${remapped.edgeType}`;
    if (existingEdgeKeys.has(edgeKey)) continue;
    existingEdgeKeys.add(edgeKey);
    target.edges.push(remapped);
  }

  // Merge evidence
  for (const ev of source.evidence) {
    target.evidence.push({ ...ev, targetPropertyTempId: remap(ev.targetPropertyTempId) });
  }

  for (const ev of source.edgeEvidence) {
    target.edgeEvidence.push({
      ...ev,
      sourceTempId: remap(ev.sourceTempId),
      targetTempId: remap(ev.targetTempId),
    });
  }

  for (const nr of source.nodeResources) {
    target.nodeResources.push({ ...nr, targetTempId: remap(nr.targetTempId) });
  }
}

function buildMatchKey(nodeType: string, identity: Map<string, string>): string {
  const sorted = [...identity.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v.toLowerCase().trim()}`)
    .join('&');
  return `${nodeType}:${sorted}`;
}

async function extractChunked(
  tree: ExtractionTree,
  contextText: string,
  resourceIds: ResourceId[],
  systemContext?: SystemContext,
): Promise<ExtractedSubgraph> {
  const chunks = splitTextIntoChunks(contextText);
  logger.info('[extraction] Chunked extraction starting', {
    totalChunks: chunks.length,
    totalInputChars: contextText.length,
    chunkSizes: chunks.map((c) => c.length),
  });

  if (chunks.length === 1) {
    logger.info('[extraction] Single chunk after split — falling back to single call');
    return extractSingleCall(tree, contextText, resourceIds, systemContext);
  }

  const preamble: ExtractionPreamble = {
    documentSummary: '',
    entitiesSeen: new Map(),
    previousChunkSummary: '',
    trailingContext: '',
  };

  let accumulated: ExtractedSubgraph | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const preambleText = i > 0 ? buildExtractionPreamble(preamble) : '';
    const chunkInput = preambleText + chunk;

    logger.info(`[extraction] Extracting chunk ${i + 1}/${chunks.length}`, {
      chunkChars: chunk.length,
      preambleChars: preambleText.length,
      totalInputChars: chunkInput.length,
      chunkStart: chunk.slice(0, 200).replace(/\n/g, '\\n'),
      chunkEnd: chunk.slice(-200).replace(/\n/g, '\\n'),
      ...(preambleText && { preambleText }),
    });

    const chunkSubgraph = await extractSingleCall(tree, chunkInput, resourceIds, systemContext);

    // Get a one-line summary of this chunk for the preamble
    let chunkSummary = '';
    if (i < chunks.length - 1) {
      chunkSummary = await anthropicChat({
        system: `Summarize this text section in 1-2 sentences. Be specific about entities and events.
If the text contains an email thread or conversation chain (look for reply markers like "On ... wrote:", forwarded message delimiters, or quoted text), note:
- Whether this section contains the most recent message, older replies, or a transition between the two
- Approximate dates of messages if visible in headers
- Which content is from the primary/latest message vs. quoted thread history`,
        userMessage: chunk,
        label: 'knowledge_extraction_chunk_summary',
      });
      chunkSummary = chunkSummary.trim();
    }

    logger.info(`[extraction] Chunk ${i + 1}/${chunks.length} extracted`, {
      chunkNodes: chunkSubgraph.nodes.length,
      chunkEdges: chunkSubgraph.edges.length,
      chunkProperties: chunkSubgraph.properties.length,
    });

    if (!accumulated) {
      accumulated = chunkSubgraph;
    } else {
      mergeSubgraphs(accumulated, chunkSubgraph, tree);
      logger.info(`[extraction] After merging chunk ${i + 1}`, {
        totalNodes: accumulated.nodes.length,
        totalEdges: accumulated.edges.length,
        totalProperties: accumulated.properties.length,
      });
    }

    // Update preamble for next chunk
    if (i < chunks.length - 1) {
      if (preamble.documentSummary && chunkSummary) {
        preamble.documentSummary = await anthropicChat({
          system: `Combine these two summaries into a 1-3 sentence summary of the document so far.
Preserve any information about email thread structure, temporal context (which parts are the most recent message vs. older thread history), and approximate dates of messages.`,
          userMessage: `Previous: ${preamble.documentSummary}\nNew section: ${chunkSummary}`,
          label: 'knowledge_extraction_summary_condense',
        });
        preamble.documentSummary = preamble.documentSummary.trim();
      } else if (chunkSummary) {
        preamble.documentSummary = chunkSummary;
      }

      updatePreambleFromSubgraph(preamble, chunkSubgraph, tree, chunk, chunkSummary);
    }
  }

  return accumulated!;
}

// Minimum average tuples per entity within a branch to trigger dynamic expansion.
// If a branch has multiple entities and each has this many tuples on average,
// the entities are "content-heavy" enough to warrant focused extraction.
const EXPANSION_DENSITY_THRESHOLD = 5;
const EXPANSION_MIN_ENTITIES = 2;

function computeDynamicExpandEdges(facts: Fact[]): Set<string> {
  const dynamicEdges = new Set<string>();
  // Group tagged facts by branch edge name
  const byBranch = new Map<string, Map<string, number>>();
  for (const fact of facts) {
    if (!fact.t) continue;
    let subjects = byBranch.get(fact.t);
    if (!subjects) {
      subjects = new Map();
      byBranch.set(fact.t, subjects);
    }
    subjects.set(fact.s, (subjects.get(fact.s) ?? 0) + 1);
  }

  for (const [edgeName, subjects] of byBranch) {
    const totalTuples = Array.from(subjects.values()).reduce((a, b) => a + b, 0);
    const avgPerEntity = totalTuples / subjects.size;
    const triggered =
      subjects.size >= EXPANSION_MIN_ENTITIES && avgPerEntity >= EXPANSION_DENSITY_THRESHOLD;
    logger.info('[extraction] Dynamic expansion check', {
      edgeName,
      entityCount: subjects.size,
      totalTuples,
      avgTuplesPerEntity: avgPerEntity.toFixed(1),
      minEntities: EXPANSION_MIN_ENTITIES,
      densityThreshold: EXPANSION_DENSITY_THRESHOLD,
      triggered,
      topEntities: [...subjects.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `${name} (${count})`),
    });
    if (triggered) {
      dynamicEdges.add(edgeName);
    }
  }

  return dynamicEdges;
}

interface ExtractionResult {
  subgraph: ExtractedSubgraph;
  pluginFacts: Fact[];
}

async function extractFromSegments(
  tree: ExtractionTree,
  segments: Segment[],
  resourceIds: ResourceId[],
  entityCount?: number,
  facts?: Fact[],
  systemContext?: SystemContext,
): Promise<ExtractionResult> {
  const pluginFacts: Fact[] = [];
  logger.info('[extraction] Starting', {
    segments: segments.length,
    entityCount,
    facts: facts?.length ?? 0,
    messageType: tree.messageType.name,
    children: tree.children.length,
  });

  return extractFromSegmentsInner(
    tree,
    segments,
    resourceIds,
    entityCount,
    facts,
    systemContext,
    pluginFacts,
  );
}

async function extractFromSegmentsInner(
  tree: ExtractionTree,
  segments: Segment[],
  resourceIds: ResourceId[],
  entityCount: number | undefined,
  facts: Fact[] | undefined,
  systemContext: SystemContext | undefined,
  pluginFacts: Fact[],
): Promise<ExtractionResult> {
  const textMap = await loadSegmentTexts(segments);

  // Compute which branches should be dynamically expanded based on fact density
  const dynamicExpandEdges = facts?.length ? computeDynamicExpandEdges(facts) : undefined;
  if (dynamicExpandEdges?.size) {
    logger.debug('[extraction] Dynamic expansion edges', { edges: [...dynamicExpandEdges] });
  }

  const hasProgressive = tree.children.some(
    (c) => c.expand || dynamicExpandEdges?.has(c.edgeType.outboundName),
  );

  // Two-phase extraction: skeleton + per-entity property extraction
  // Triggered by entity density when no progressive expansion is configured
  if (!hasProgressive && entityCount != null && entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD) {
    logger.info(
      '[extraction] Routing → two-phase Opus (high entity density, no progressive branches)',
      {
        entityCount,
        threshold: ENTITY_DENSITY_OPUS_THRESHOLD,
        segmentCount: segments.length,
        segmentLengths: segments.map((s) => textMap.get(s.rawTextId!)?.length ?? 0),
      },
    );
    return {
      subgraph: await extractTwoPhase(tree, segments, textMap, resourceIds, systemContext),
      pluginFacts,
    };
  }

  const useOpus = entityCount != null && entityCount >= ENTITY_DENSITY_OPUS_THRESHOLD;
  const contextText = formatSegments(segments, textMap);
  logger.info('[extraction] Routing decision', {
    hasProgressive,
    entityCount: entityCount ?? 'unknown',
    entityThreshold: ENTITY_DENSITY_OPUS_THRESHOLD,
    contextTextLength: contextText.length,
    model: useOpus ? 'opus' : 'sonnet',
    path: hasProgressive ? 'progressive (skeleton + expand)' : 'single-pass',
  });
  const allResourceIds = [...resourceIds];

  if (!hasProgressive) {
    logger.debug('[extraction] Single-pass extraction (no progressive branches)');
    return {
      subgraph: await extractSingle(tree, contextText, allResourceIds, entityCount, systemContext),
      pluginFacts,
    };
  }

  // Phase 1: skeleton extraction
  const { skeletonTree, expandBranches } = splitTree(tree, dynamicExpandEdges);
  logger.info('[extraction] Phase 1: Skeleton extraction', {
    expandBranches: expandBranches.length,
  });
  const subgraph = await extractSingle(
    skeletonTree,
    contextText,
    allResourceIds,
    entityCount,
    systemContext,
  );
  // Log full skeleton output for debugging entity identity
  const skeletonEntities = subgraph.nodes.map((n) => ({
    tempId: n.tempId.slice(0, 8),
    nodeType: n.nodeType,
    identity: getIdentityValues(n.tempId, subgraph),
  }));
  const skeletonEdgeSummary = subgraph.edges.map((e) => ({
    source: e.sourceTempId.slice(0, 8),
    target: e.targetTempId.slice(0, 8),
    edgeType: e.edgeType,
  }));
  logger.info('[extraction] Skeleton complete', {
    nodes: subgraph.nodes.length,
    edges: subgraph.edges.length,
    entities: skeletonEntities,
    edgeSummary: skeletonEdgeSummary,
  });

  // Phase 2: per-entity expansion with plugin support
  // Branches are ordered parent-first by splitTree, so parent entities are grafted
  // into the subgraph before child branches try to find their entities.
  for (const branch of expandBranches) {
    // Find entities connected via the correct edge from the correct parent type.
    // Edge direction may be inverted (child can be source or target), so check both sides.
    const parentTempIds = new Set(
      subgraph.nodes.filter((n) => n.nodeType === branch.parentNodeType.id).map((n) => n.tempId),
    );
    const childTempIds = new Set<string>();
    for (const e of subgraph.edges) {
      if (e.edgeType !== branch.edgeType.id) continue;
      if (parentTempIds.has(e.sourceTempId)) childTempIds.add(e.targetTempId);
      else if (parentTempIds.has(e.targetTempId)) childTempIds.add(e.sourceTempId);
    }
    const entities = subgraph.nodes.filter((n) => childTempIds.has(n.tempId));
    logger.info('[extraction] Phase 2: Expanding branch', {
      edge: branch.edgeType.outboundName,
      edgeTypeId: branch.edgeType.id,
      nodeType: branch.fullChild.nodeType.name,
      parentNodeType: branch.parentNodeType.name,
      parentCount: parentTempIds.size,
      matchingEdges: childTempIds.size,
      entities: entities.length,
      totalNodes: subgraph.nodes.length,
      totalEdges: subgraph.edges.length,
    });

    const entityTree = buildEntityExtractionTree(branch.fullChild, tree);

    function logEntityResult(label: string, identity: Record<string, unknown>, result: ExtractedSubgraph) {
      const childNodes = result.nodes
        .filter((n) => n.tempId !== result.messageNode.tempId)
        .map((n) => {
          const props = result.properties
            .filter((p) => p.parentTempId === n.tempId && p.value != null)
            .map((p) => `${p.propertyTypeId}=${p.value}`);
          return { nodeType: n.nodeType, props };
        });
      logger.info(`[extraction] Entity expand result: ${label}`, {
        identity,
        childNodes,
        totalNodes: result.nodes.length,
        totalEdges: result.edges.length,
        totalProperties: result.properties.length,
      });
    }

    // Expand entities in parallel — each entity's extract → plugin → re-extract
    // chain is independent. The Anthropic rate-limit queue and URL caches handle contention.
    const entityResults = await Promise.all(
      entities.map(async (entity) => {
        const identityValues = getIdentityValues(entity.tempId, subgraph);
        logger.info('[extraction] Expanding entity', {
          nodeType: branch.fullChild.nodeType.name,
          identityValues,
        });

        const focusContext = buildFocusContext(
          identityValues,
          branch.fullChild.nodeType.name,
          contextText,
        );

        logger.debug('[extraction] Entity extraction', { entity: identityValues });
        const entitySubgraph = await extractSingle(
          entityTree,
          focusContext,
          allResourceIds,
          undefined,
          systemContext,
        );
        logEntityResult('single-pass', identityValues, entitySubgraph);
        return {
          entityTempId: entity.tempId,
          subgraph: entitySubgraph,
          facts: [] as Fact[],
        };
      }),
    );

    for (const result of entityResults) {
      graftSubgraph(subgraph, result.subgraph, result.entityTempId);
      pluginFacts.push(...result.facts);
    }
  }

  logger.info('[extraction] Complete', {
    nodes: subgraph.nodes.length,
    edges: subgraph.edges.length,
    properties: subgraph.properties.length,
    pluginFacts: pluginFacts.length,
  });

  return { subgraph, pluginFacts };
}

// -- Response parsing --

function parseExtractionResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  tree: ExtractionTree,
  resourceIds: ResourceId[],
): ExtractedSubgraph {
  const nodes: ExtractedNode[] = [];
  const properties: ExtractedProperty[] = [];
  const edges: ExtractedEdge[] = [];
  const evidence: ExtractedEvidence[] = [];
  const edgeEvidence: ExtractedEdgeEvidence[] = [];
  const nodeResources: ExtractedNodeResource[] = [];

  const messageNode: ExtractedNode = {
    tempId: randomUUID(),
    nodeType: tree.messageType.id,
  };
  nodes.push(messageNode);

  for (const resourceId of resourceIds) {
    nodeResources.push({
      targetTempId: messageNode.tempId,
      resourceId,
      startOffset: null,
      endOffset: null,
    });
  }

  expandProperties(
    response,
    tree.messagePropertyDefs,
    messageNode.tempId,
    properties,
    evidence,
    resourceIds,
  );
  parseChildren(
    response,
    tree.children,
    messageNode.tempId,
    nodes,
    properties,
    edges,
    evidence,
    edgeEvidence,
    nodeResources,
    resourceIds,
  );

  return { messageNode, nodes, properties, edges, evidence, edgeEvidence, nodeResources };
}

function expandProperties(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  propDefs: ExtractionTreePropertyDef[],
  parentTempId: string,
  properties: ExtractedProperty[],
  evidence: ExtractedEvidence[],
  resourceIds: ResourceId[],
) {
  for (const pd of propDefs) {
    const propData = data?.[pd.name];
    if (!propData || propData.value == null) continue;

    const propTempId = randomUUID();

    properties.push({
      tempId: propTempId,
      propertyTypeId: pd.propertyTypeId,
      parentTempId,
      value: propData.value,
      evidenceDescription: propData.evidence,
    });

    evidence.push({
      targetPropertyTempId: propTempId,
      resourceId: resourceIds[0] ?? null,
      type: EvidenceType.extraction,
      description: propData.evidence ?? 'Extracted from input',
    });
  }
}

function expandEdgeProperties(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  propDefs: ExtractionTreePropertyDef[],
  edgeSrc: string,
  edgeTgt: string,
  edgeType: string,
  childTempId: string,
  properties: ExtractedProperty[],
  evidence: ExtractedEvidence[],
  resourceIds: ResourceId[],
) {
  const ownerEdgeKey = `${edgeSrc}:${edgeTgt}:${edgeType}`;
  for (const pd of propDefs) {
    const propData = data?.[pd.name];
    if (!propData || propData.value == null) continue;

    const propTempId = randomUUID();

    properties.push({
      tempId: propTempId,
      propertyTypeId: pd.propertyTypeId,
      parentTempId: childTempId,
      value: propData.value,
      evidenceDescription: propData.evidence,
      ownerEdgeKey,
    });

    evidence.push({
      targetPropertyTempId: propTempId,
      resourceId: resourceIds[0] ?? null,
      type: EvidenceType.extraction,
      description: propData.evidence ?? 'Extracted from input',
    });
  }
}

function parseChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  childDefs: ExtractionTreeNode[],
  parentTempId: string,
  nodes: ExtractedNode[],
  properties: ExtractedProperty[],
  edges: ExtractedEdge[],
  evidence: ExtractedEvidence[],
  edgeEvidence: ExtractedEdgeEvidence[],
  nodeResources: ExtractedNodeResource[],
  resourceIds: ResourceId[],
) {
  for (const childDef of childDefs) {
    const childArray = data?.[childDef.edgeType.outboundName];
    if (!Array.isArray(childArray)) continue;

    for (const item of childArray) {
      // Skip entities with no identity property values (e.g. nameless people)
      const identityProps = childDef.propertyDefs.filter(
        (pd) => pd.identity === 'unique' || pd.identity === 'fuzzy',
      );
      if (identityProps.length > 0) {
        const hasIdentity = identityProps.some((pd) => {
          const val = item?.[pd.name];
          return val && val.value != null && val.value !== '';
        });
        if (!hasIdentity) continue;
      }

      const tempId = randomUUID();

      nodes.push({
        tempId,
        nodeType: childDef.nodeType.id,
      });

      // Determine edge direction from the edge type's source/target definition.
      // The child's node type tells us which end of the edge it occupies.
      const childIsSource = childDef.edgeType.sourceNodeTypeId === childDef.nodeType.id;
      const [edgeSrc, edgeTgt] = childIsSource ? [tempId, parentTempId] : [parentTempId, tempId];

      edges.push({
        sourceTempId: edgeSrc,
        targetTempId: edgeTgt,
        edgeType: childDef.edgeType.id,
      });

      edgeEvidence.push({
        sourceTempId: edgeSrc,
        targetTempId: edgeTgt,
        edgeType: childDef.edgeType.id,
        resourceId: resourceIds[0] ?? null,
        type: EvidenceType.extraction,
        description: 'Extracted from input',
      });

      for (const resourceId of resourceIds) {
        nodeResources.push({
          targetTempId: tempId,
          resourceId,
          startOffset: null,
          endOffset: null,
        });
      }

      expandEdgeProperties(
        item,
        childDef.edgeType.propertyDefs,
        edgeSrc,
        edgeTgt,
        childDef.edgeType.id as string,
        tempId,
        properties,
        evidence,
        resourceIds,
      );
      expandProperties(item, childDef.propertyDefs, tempId, properties, evidence, resourceIds);
      parseChildren(
        item,
        childDef.children,
        tempId,
        nodes,
        properties,
        edges,
        evidence,
        edgeEvidence,
        nodeResources,
        resourceIds,
      );
    }
  }
}

// -- Edge type meta from extraction tree --

function buildEdgeTypeMetaFromTree(tree: ExtractionTree): EdgeTypeMetaMap {
  const meta: EdgeTypeMetaMap = new Map();
  function walk(children: ExtractionTreeNode[]) {
    for (const child of children) {
      const et = child.edgeType;
      if (!meta.has(et.id as string)) {
        meta.set(et.id as string, {
          outboundName: et.outboundName,
          inboundName: et.inboundName,
          sourceNodeTypeId: et.sourceNodeTypeId,
          targetNodeTypeId: et.targetNodeTypeId,
        });
      }
      walk(child.children);
    }
  }
  walk(tree.children);
  return meta;
}

// -- Internal deduplication --

const deduplicationPromptDef = promptDef({
  description: 'Cluster duplicate extracted entities',
  arguments: ['entities'] as const,
  messages: [
    {
      role: 'system' as const,
      content: `You are an entity deduplication system.
Given a list of extracted entities of the same type, group those that represent the same real-world entity.

Consider:
- Property values (names, identifiers)
- Relationships to other entities (shared connections strongly suggest same entity; different connections suggest distinct entities)

Return a JSON object with a "clusters" key containing an array of clusters, where each cluster is an array of entity IDs.
Example: {"clusters": [["id1", "id2"], ["id3"]]}
When uncertain, don't merge — better to have duplicates than incorrect merges.`,
    },
    {
      role: 'user' as const,
      content: '{{{entities}}}',
    },
  ],
  validator: z.object({
    clusters: z.array(z.array(z.string())),
  }),
});

async function deduplicateSubgraph(
  subgraph: ExtractedSubgraph,
  edgeTypeMeta?: EdgeTypeMetaMap,
  teamId?: TeamId,
): Promise<ExtractedSubgraph> {
  // Group entity nodes by type (skip message node)
  const nodesByType = new Map<string, ExtractedNode[]>();
  for (const node of subgraph.nodes) {
    if (node.tempId === subgraph.messageNode.tempId) continue;
    const key = node.nodeType as string;
    const arr = nodesByType.get(key) ?? [];
    arr.push(node);
    nodesByType.set(key, arr);
  }

  const mergeMap = new Map<string, string>();

  // Load uniqueness constraints for all node types present in the subgraph
  const nodeTypeIds = [...nodesByType.keys()] as NodeTypeId[];
  const constraintsByType =
    teamId && nodeTypeIds.length > 0
      ? await loadConstraintsForNodeTypes(nodeTypeIds, teamId)
      : new Map<string, any>();

  // Types that have constraints: use deterministic findDedupGroups (exact merges + fuzzy candidates)
  // Types that don't: fall back to LLM clustering
  const typesNeedingLlm: string[] = [];
  const allFuzzyCandidates: Array<FuzzyCandidate & { nodeType: string }> = [];

  for (const [nodeType, nodesOfType] of nodesByType) {
    if (nodesOfType.length <= 1) continue;

    const constraints = constraintsByType.get(nodeType);
    if (constraints?.length) {
      const { exactGroups, fuzzyCandidates } = findDedupGroups(nodesOfType, constraints, subgraph);

      for (const group of exactGroups) {
        logger.info('[dedup] exact merge', {
          nodeType,
          canonical: group.canonicalTempId.slice(0, 8),
          merged: group.mergedTempIds.map((id) => id.slice(0, 8)),
        });
        for (const merged of group.mergedTempIds) {
          mergeMap.set(merged, group.canonicalTempId);
        }
      }

      for (const fc of fuzzyCandidates) {
        allFuzzyCandidates.push({ ...fc, nodeType });
      }

      if (fuzzyCandidates.length > 0) {
        logger.info('[dedup] fuzzy candidates for LLM review', {
          nodeType,
          pairs: fuzzyCandidates.map((fc) => ({
            a: fc.tempIdA.slice(0, 8),
            b: fc.tempIdB.slice(0, 8),
            constraintIndex: fc.constraintIndex,
          })),
        });
      }
    } else {
      typesNeedingLlm.push(nodeType);
    }
  }

  // Resolve property type IDs to human-readable names for LLM context
  const propTypeIds = [
    ...new Set(
      subgraph.properties
        .filter((p) => p.value != null && !p.ownerEdgeKey)
        .map((p) => p.propertyTypeId as string),
    ),
  ] as PropertyTypeId[];
  const propTypeNames = new Map<string, string>();
  if (propTypeIds.length > 0) {
    const qb = getKnowledgeQb(['property_type']);
    const rows = await qb
      .selectFrom('property_type')
      .select(['id', 'name'])
      .where('id', 'in', propTypeIds)
      .execute();
    for (const row of rows) propTypeNames.set(row.id as string, row.name);
  }

  const emptyResolved = new Map<string, never>();
  const meta = edgeTypeMeta ?? new Map();

  // LLM review for fuzzy constraint candidates — group by node type
  if (allFuzzyCandidates.length > 0) {
    const fuzzyByType = new Map<string, FuzzyCandidate[]>();
    for (const fc of allFuzzyCandidates) {
      const arr = fuzzyByType.get(fc.nodeType) ?? [];
      arr.push(fc);
      fuzzyByType.set(fc.nodeType, arr);
    }

    for (const [nodeType, candidates] of fuzzyByType) {
      // Collect unique node tempIds involved in fuzzy pairs, remapped through exact merges
      const resolve = (id: string): string => mergeMap.get(id) ?? id;
      const involvedIds = new Set<string>();
      for (const fc of candidates) {
        involvedIds.add(resolve(fc.tempIdA));
        involvedIds.add(resolve(fc.tempIdB));
      }

      const involvedNodes = subgraph.nodes.filter((n) => involvedIds.has(n.tempId));
      if (involvedNodes.length <= 1) continue;

      const entityDescriptions = involvedNodes.map((node) => {
        const nodeProps: Record<string, unknown> = {};
        for (const prop of subgraph.properties) {
          if (prop.parentTempId === node.tempId && prop.value != null && !prop.ownerEdgeKey) {
            const label = propTypeNames.get(prop.propertyTypeId as string) ?? prop.propertyTypeId;
            nodeProps[label] = prop.value;
          }
        }

        const { entries: relationships } = buildRelationshipContextFromSubgraph({
          tempId: node.tempId,
          subgraph,
          resolved: emptyResolved,
          edgeTypeMeta: meta,
        });

        return {
          id: node.tempId,
          context: formatEntityContext({ properties: nodeProps, relationships }),
        };
      });

      const entitiesText = entityDescriptions.map((e) => `[${e.id}]\n${e.context}`).join('\n\n');

      logger.info('[dedup] LLM review for fuzzy candidates', {
        nodeType,
        entityCount: involvedNodes.length,
        entities: entityDescriptions.map((e) => ({ id: e.id.slice(0, 8), context: e.context })),
      });

      const result = await execute('knowledge_deduplicate', deduplicationPromptDef, {
        entities: entitiesText,
      });

      logger.info('[dedup] LLM fuzzy decision', {
        nodeType,
        clusters: result.clusters.map((c) => c.map((id) => id.slice(0, 8))),
      });

      for (const cluster of result.clusters) {
        if (cluster.length <= 1) continue;
        const canonical = cluster[0];
        for (let i = 1; i < cluster.length; i++) {
          mergeMap.set(cluster[i], canonical);
        }
      }
    }
  }

  // LLM fallback for types without constraints
  if (typesNeedingLlm.length > 0) {
    for (const nodeType of typesNeedingLlm) {
      const nodesOfType = nodesByType.get(nodeType)!;
      if (nodesOfType.length <= 1) continue;

      const entityDescriptions = nodesOfType.map((node) => {
        const nodeProps: Record<string, unknown> = {};
        for (const prop of subgraph.properties) {
          if (prop.parentTempId === node.tempId && prop.value != null && !prop.ownerEdgeKey) {
            const label = propTypeNames.get(prop.propertyTypeId as string) ?? prop.propertyTypeId;
            nodeProps[label] = prop.value;
          }
        }

        const { entries: relationships } = buildRelationshipContextFromSubgraph({
          tempId: node.tempId,
          subgraph,
          resolved: emptyResolved,
          edgeTypeMeta: meta,
        });

        return {
          id: node.tempId,
          context: formatEntityContext({ properties: nodeProps, relationships }),
        };
      });

      const entitiesText = entityDescriptions.map((e) => `[${e.id}]\n${e.context}`).join('\n\n');

      logger.info('[dedup] LLM clustering (no constraints)', {
        nodeType,
        entityCount: nodesOfType.length,
        entities: entityDescriptions.map((e) => ({ id: e.id.slice(0, 8), context: e.context })),
      });

      const result = await execute('knowledge_deduplicate', deduplicationPromptDef, {
        entities: entitiesText,
      });

      logger.info('[dedup] LLM clustering decision', {
        nodeType,
        clusters: result.clusters.map((c) => c.map((id) => id.slice(0, 8))),
      });

      for (const cluster of result.clusters) {
        if (cluster.length <= 1) continue;
        const canonical = cluster[0];
        for (let i = 1; i < cluster.length; i++) {
          mergeMap.set(cluster[i], canonical);
        }
      }
    }
  }

  if (mergeMap.size === 0) {
    logger.info('[dedup] no merges');
    return subgraph;
  }

  logger.info('[dedup] applying merges', {
    mergeCount: mergeMap.size,
    merges: [...mergeMap.entries()].map(([from, to]) => ({
      from: from.slice(0, 8),
      to: to.slice(0, 8),
    })),
  });

  const removedTempIds = new Set(mergeMap.keys());
  const resolve = (tempId: string): string => mergeMap.get(tempId) ?? tempId;

  const mergedNodes = subgraph.nodes.filter((n) => !removedTempIds.has(n.tempId));

  // Remap parent IDs and deduplicate: when two entities merge, they may both
  // have properties of the same type. Keep only the first occurrence per
  // (parentTempId, propertyTypeId) pair (or (ownerEdgeKey, propertyTypeId) for edge props).
  function remapEdgeKey(edgeKey: string | undefined): string | undefined {
    if (!edgeKey) return edgeKey;
    const parts = edgeKey.split(':');
    if (parts.length !== 3) return edgeKey;
    return `${resolve(parts[0])}:${resolve(parts[1])}:${parts[2]}`;
  }

  // When duplicate properties merge, remap evidence from the dropped property
  // to the surviving canonical property so no provenance is lost.
  const canonicalPropertyForKey = new Map<string, string>(); // dedupeKey → canonical tempId
  const droppedToCanonical = new Map<string, string>(); // dropped tempId → canonical tempId
  const mergedProperties: ExtractedProperty[] = [];
  for (const p of subgraph.properties) {
    const remappedEdgeKey = remapEdgeKey(p.ownerEdgeKey);
    const remapped = { ...p, parentTempId: resolve(p.parentTempId), ownerEdgeKey: remappedEdgeKey };
    const dedupeKey = remappedEdgeKey
      ? `edge:${remappedEdgeKey}:${remapped.propertyTypeId}`
      : `${remapped.parentTempId}:${remapped.propertyTypeId}`;
    const existing = canonicalPropertyForKey.get(dedupeKey);
    if (existing) {
      droppedToCanonical.set(p.tempId, existing);
      continue;
    }
    canonicalPropertyForKey.set(dedupeKey, remapped.tempId);
    mergedProperties.push(remapped);
  }

  const seenEdgeKeys = new Set<string>();
  const mergedEdges: ExtractedEdge[] = [];
  for (const e of subgraph.edges) {
    const remapped = {
      ...e,
      sourceTempId: resolve(e.sourceTempId),
      targetTempId: resolve(e.targetTempId),
    };
    const key = `${remapped.sourceTempId}:${remapped.targetTempId}:${remapped.edgeType}`;
    if (seenEdgeKeys.has(key)) continue;
    seenEdgeKeys.add(key);
    mergedEdges.push(remapped);
  }

  // Remap evidence: dropped properties → canonical property, preserving all provenance
  const mergedEvidence = subgraph.evidence.map((e) => {
    const canonicalTarget =
      droppedToCanonical.get(e.targetPropertyTempId) ?? e.targetPropertyTempId;
    return {
      ...e,
      targetPropertyTempId: resolve(canonicalTarget),
    };
  });

  const mergedEdgeEvidence = subgraph.edgeEvidence.map((e) => ({
    ...e,
    sourceTempId: resolve(e.sourceTempId),
    targetTempId: resolve(e.targetTempId),
  }));

  const mergedNodeResources = subgraph.nodeResources.map((nr) => ({
    ...nr,
    targetTempId: resolve(nr.targetTempId),
  }));

  return {
    messageNode: subgraph.messageNode,
    nodes: mergedNodes,
    properties: mergedProperties,
    edges: mergedEdges,
    evidence: mergedEvidence,
    edgeEvidence: mergedEdgeEvidence,
    nodeResources: mergedNodeResources,
  };
}

export {
  extractFromSegments,
  deduplicateSubgraph,
  buildEdgeTypeMetaFromTree,
  loadSegmentTexts,
  formatSegments,
};
export type { ExtractionResult };
