import type {
  ActionNode,
  TranslationGraphRowBody,
} from '../../../services/translation_graph/types';
import type { Expression } from '../../../services/knowledge_pipeline/output_v3/expression';

import {
  resolveOntologyNamesInBody,
  type OntologyMaps,
} from './resolve-ontology-names';

function buildMaps(): OntologyMaps {
  return {
    nodeTypeKeyToId: new Map<string, string>([
      ['opportunity', 'nt-opp-uuid'],
      ['funding_round', 'nt-round-uuid'],
      ['round_participation', 'nt-part-uuid'],
    ]),
    propertyKeyToId: new Map<string, string>([
      ['opportunity.company', 'p-opp-company-uuid'],
      ['opportunity.summary', 'p-opp-summary-uuid'],
      ['funding_round.name', 'p-round-name-uuid'],
      ['round_participation.investor_name', 'p-part-investor-uuid'],
      ['round_participation.lead', 'p-part-lead-uuid'],
    ]),
    edgeKeyToId: new Map<string, string>([['participants', 'et-participants-uuid']]),
    edgeKeyToDisplayNames: new Map<
      string,
      { outboundName: string; inboundName: string }
    >([
      [
        'participants',
        { outboundName: 'Participants', inboundName: 'Participates In' },
      ],
    ]),
    passThroughTypeRefs: new Set<string>(['__generic_root__', '__generic_record__']),
  };
}

function evExtract(description: string): Expression {
  return { type: 'extract_value', description };
}

function msgContentTraverse(): Expression {
  return {
    type: 'traverse',
    aliasRoot: 'msg',
    steps: [],
    expression: { type: 'property', propertyTypeId: 'content' },
  };
}

describe('resolveOntologyNamesInBody', () => {
  test('substitutes targetTypeRef, targetField, edgeName, and uniquenessConstraint property refs', () => {
    const opportunityRoot: ActionNode = {
      kind: 'action',
      id: 'r-opp',
      targetTypeRef: 'opportunity',
      traversal: [],
      fieldMappings: [
        {
          targetField: 'company',
          expression: evExtract('company name'),
          semantics: 'overwrite',
        },
      ],
      children: [],
      uniquenessConstraints: { any: [{ all: [{ field: 'company' }] }] },
    };

    const roundParticipationChild: ActionNode = {
      kind: 'action',
      id: 'c-rp',
      targetTypeRef: 'round_participation',
      traversal: [],
      fieldMappings: [
        {
          targetField: 'investor_name',
          expression: evExtract('investor name'),
          semantics: 'overwrite',
        },
      ],
      children: [],
      uniquenessConstraints: { any: [{ all: [{ field: 'investor_name' }] }] },
    };

    const fundingRoundRoot: ActionNode = {
      kind: 'action',
      id: 'r-round',
      targetTypeRef: 'funding_round',
      traversal: [],
      fieldMappings: [
        {
          targetField: 'name',
          // Wraps an alias-rooted (`msg.content`) traversal in the
          // `data:` config of an `#extract` meta-edge. This must NOT be
          // substituted — `content` is a generic-source field.
          expression: {
            type: 'traverse',
            steps: [
              {
                type: 'meta_edge',
                metaEdge: 'extract',
                alias: 'round',
                config: {
                  description: { type: 'static', value: 'funding round' },
                  data: [msgContentTraverse()],
                },
              },
            ],
            expression: evExtract('round name'),
          },
          semantics: 'overwrite',
        },
      ],
      children: [
        {
          node: roundParticipationChild,
          relationship: { type: 'reference', edgeName: 'participants' },
        },
      ],
      uniquenessConstraints: { any: [{ all: [{ field: 'name' }] }] },
    };

    const body: TranslationGraphRowBody = {
      sourceSchemaRef: { kind: 'generic', shape: { properties: {}, edges: {} } },
      targetSchemaRef: { kind: 'knowledge-graph' },
      roots: [opportunityRoot, fundingRoundRoot],
    };

    const resolved = resolveOntologyNamesInBody(body, buildMaps());

    // Root 1 — opportunity.
    const r0 = resolved.roots[0] as ActionNode;
    expect(r0.targetTypeRef).toBe('nt-opp-uuid');
    expect(r0.fieldMappings[0].targetField).toBe('p-opp-company-uuid');
    const r0c = r0.uniquenessConstraints!.any[0].all[0];
    expect(r0c.field).toBe('p-opp-company-uuid');

    // Root 2 — funding_round.
    const r1 = resolved.roots[1] as ActionNode;
    expect(r1.targetTypeRef).toBe('nt-round-uuid');
    expect(r1.fieldMappings[0].targetField).toBe('p-round-name-uuid');

    // alias-rooted `msg.content` reference must be untouched.
    const fmExpr = r1.fieldMappings[0].expression as Expression;
    expect(fmExpr.type).toBe('traverse');
    if (fmExpr.type === 'traverse') {
      const metaStep = fmExpr.steps[0];
      expect(metaStep.type).toBe('meta_edge');
      if (metaStep.type === 'meta_edge') {
        // Alias preserved.
        expect(metaStep.alias).toBe('round');
        const dataItem = metaStep.config!.data![0] as Expression;
        expect(dataItem.type).toBe('traverse');
        if (dataItem.type === 'traverse') {
          expect(dataItem.aliasRoot).toBe('msg');
          const inner = dataItem.expression as Expression;
          expect(inner.type).toBe('property');
          if (inner.type === 'property') {
            // Untouched — generic-source field name preserved.
            expect(inner.propertyTypeId).toBe('content');
          }
        }
      }
    }

    // Root 2's children — round_participation. The template key
    // (`participants` lowercase) is rewritten to the EdgeType's
    // outbound display name (`Participants`), matching what the KG
    // adapter resolves edges by.
    expect(r1.children[0].relationship.edgeName).toBe('Participants');
    const childAction = r1.children[0].node as ActionNode;
    expect(childAction.targetTypeRef).toBe('nt-part-uuid');
    expect(childAction.fieldMappings[0].targetField).toBe('p-part-investor-uuid');

    // The child's uniqueness `field` resolves scoped to round_participation.
    const propEntry = childAction.uniquenessConstraints!.any[0].all[0];
    expect(propEntry.field).toBe('p-part-investor-uuid');
  });

  test('leaves passThrough targetTypeRefs and their fieldMappings unsubstituted', () => {
    const root: ActionNode = {
      kind: 'action',
      id: 'in-root',
      targetTypeRef: '__generic_root__',
      traversal: [],
      fieldMappings: [
        { targetField: 'sent_at', expression: { type: 'property', propertyTypeId: 'ts' }, semantics: 'overwrite' },
        { targetField: 'content', expression: { type: 'property', propertyTypeId: 'text' }, semantics: 'overwrite' },
      ],
      children: [],
    };

    const body: TranslationGraphRowBody = {
      sourceSchemaRef: { kind: 'adapter', adapterType: 'slack' },
      targetSchemaRef: { kind: 'knowledge-graph' },
      roots: [root],
    };

    const resolved = resolveOntologyNamesInBody(body, buildMaps());
    const r = resolved.roots[0] as ActionNode;
    expect(r.targetTypeRef).toBe('__generic_root__');
    expect(r.fieldMappings[0].targetField).toBe('sent_at');
    expect(r.fieldMappings[1].targetField).toBe('content');
  });

  test('rewrites edgeName to inbound display name when relationship direction is inbound', () => {
    const child: ActionNode = {
      kind: 'action',
      id: 'c',
      targetTypeRef: 'round_participation',
      traversal: [],
      fieldMappings: [],
      children: [],
    };
    const root: ActionNode = {
      kind: 'action',
      id: 'r',
      targetTypeRef: 'funding_round',
      traversal: [],
      fieldMappings: [],
      children: [
        {
          node: child,
          // `direction: 'inbound'` is not (yet) part of the schema —
          // the resolver treats it as a defensive opt-in. Cast to
          // bypass nominal typing for the test.
          relationship: {
            type: 'reference',
            edgeName: 'participants',
            direction: 'inbound',
          } as unknown as import('../../../services/translation_graph/types').NodeRelationship,
        },
      ],
    };
    const body: TranslationGraphRowBody = {
      sourceSchemaRef: { kind: 'knowledge-graph' },
      targetSchemaRef: { kind: 'knowledge-graph' },
      roots: [root],
    };

    const resolved = resolveOntologyNamesInBody(body, buildMaps());
    const r = resolved.roots[0] as ActionNode;
    expect(r.children[0].relationship.edgeName).toBe('Participates In');
  });

  test('throws when edgeName references an unknown template key', () => {
    const child: ActionNode = {
      kind: 'action',
      id: 'c',
      targetTypeRef: 'round_participation',
      traversal: [],
      fieldMappings: [],
      children: [],
    };
    const root: ActionNode = {
      kind: 'action',
      id: 'r',
      targetTypeRef: 'funding_round',
      traversal: [],
      fieldMappings: [],
      children: [
        {
          node: child,
          relationship: { type: 'reference', edgeName: 'no_such_edge' },
        },
      ],
    };
    const body: TranslationGraphRowBody = {
      sourceSchemaRef: { kind: 'knowledge-graph' },
      targetSchemaRef: { kind: 'knowledge-graph' },
      roots: [root],
    };
    expect(() => resolveOntologyNamesInBody(body, buildMaps())).toThrow(
      /unknown edge "no_such_edge"/,
    );
  });

  test('throws with a path-pointing diagnostic when a reference is unknown', () => {
    const root: ActionNode = {
      kind: 'action',
      id: 'r',
      targetTypeRef: 'gizmo', // not in maps
      traversal: [],
      fieldMappings: [],
      children: [],
    };
    const body: TranslationGraphRowBody = {
      sourceSchemaRef: { kind: 'knowledge-graph' },
      targetSchemaRef: { kind: 'knowledge-graph' },
      roots: [root],
    };
    expect(() => resolveOntologyNamesInBody(body, buildMaps())).toThrow(/gizmo/);
  });
});
