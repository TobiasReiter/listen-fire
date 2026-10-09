import { z } from 'zod';

import type { PropertyInfo, EdgeInfo } from '#shared/expression/formula';

import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { getKnowledgeQb } from '../../../../lib/kysely';
import { writeExpression, type ExpressionWriterContext } from '../../../../services/knowledge_pipeline/output_v3/expression_writer';
import { userProcedure as sharedUserProcedure } from '../../procedures';

const expressionWriterRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    generate: userProcedure
      .input(
        z.object({
          intent: z.string(),
          nodeTypeId: z.string(),
          targetFieldName: z.string().optional(),
          targetFieldType: z.string().optional(),
          targetFieldOptions: z.array(z.string()).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const qb = getKnowledgeQb(['node_type', 'property_type', 'edge_type']);

        const nodeType = await qb
          .selectFrom('node_type')
          .select(['id', 'name'])
          .where('id', '=', input.nodeTypeId as any)
          .where('team_id', '=', ctx.user.teamId as any)
          .executeTakeFirst();

        if (!nodeType) throw new Error('Node type not found');

        const teamId = ctx.user.teamId as any;

        const [propertyTypes, edgeTypes] = await Promise.all([
          qb
            .selectFrom('property_type')
            .select(['id', 'name', 'value_type', 'node_type_id'])
            .where('team_id', '=', teamId)
            .execute(),
          qb
            .selectFrom('edge_type')
            .select(['id', 'outbound_name', 'inbound_name', 'source_node_type_id', 'target_node_type_id'])
            .where('team_id', '=', teamId)
            .execute(),
        ]);

        const properties: PropertyInfo[] = propertyTypes.map(p => ({
          id: p.id,
          name: p.name,
          nodeTypeId: p.node_type_id ?? undefined,
          valueType: p.value_type ?? undefined,
        }));

        const edges: EdgeInfo[] = edgeTypes.map(e => ({
          id: e.id,
          outboundName: e.outbound_name,
          inboundName: e.inbound_name,
          sourceNodeTypeId: e.source_node_type_id,
          targetNodeTypeId: e.target_node_type_id,
        }));

        const writerCtx: ExpressionWriterContext = {
          intent: input.intent,
          subjectNodeTypeId: input.nodeTypeId,
          subjectNodeTypeName: nodeType.name,
          properties,
          edges,
          targetFieldName: input.targetFieldName,
          targetFieldType: input.targetFieldType,
          targetFieldOptions: input.targetFieldOptions,
        };

        const result = await writeExpression(writerCtx);

        if ('error' in result) {
          throw new Error(result.error);
        }

        return {
          expression: result.expression,
          formula: result.formula,
        };
      }),
  });
};

export { expressionWriterRouter };
