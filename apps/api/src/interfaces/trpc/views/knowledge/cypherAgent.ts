import { z } from 'zod';

import type { Kysely } from 'kysely';

import { trpc } from '../../trpc';
import { currentContext } from '../../../../services/context';
import { anthropicChat } from '../../../../lib/anthropic';
import { getSchema, stripCypherComments, executeCypher } from '../../../../lib/knowledge/cypher';
import { parseAnyCypher, ParseError } from '../../../../lib/knowledge/cypher/parser';
import { getKnowledgeQb } from '../../../../lib/kysely';
import { userProcedure as sharedUserProcedure } from '../../procedures';

function backtickIfNeeded(name: string): string {
  return /\s/.test(name) ? `\`${name}\`` : name;
}

function buildSchemaContext(schema: Awaited<ReturnType<typeof getSchema>>): string {
  const lines: string[] = ['## Your Knowledge Graph Schema\n'];

  lines.push('### Node Types\n');
  for (const nt of schema.nodeTypes) {
    const label = backtickIfNeeded(nt.name);
    const props = nt.properties
      .map((p) => {
        let desc = `  - ${backtickIfNeeded(p.name)} (${p.type}`;
        if (p.enumValues && p.enumValues.length > 0) {
          desc += `, values: ${p.enumValues.map((v) => `"${v}"`).join(' | ')}`;
        }
        desc += ')';
        return desc;
      })
      .join('\n');
    lines.push(`**${label}**`);
    if (props) lines.push(props);
    lines.push('');
  }

  lines.push('### Relationship Types\n');
  for (const et of schema.edgeTypes) {
    const rel = backtickIfNeeded(et.name);
    const src = backtickIfNeeded(et.source);
    const tgt = backtickIfNeeded(et.target);
    const props = et.properties.map((p) => `  - ${backtickIfNeeded(p.name)} (${p.type})`).join('\n');
    lines.push(`**${rel}**: (${src}) → (${tgt})`);
    if (props) lines.push(props);
    lines.push('');
  }

  return lines.join('\n');
}

const SYSTEM_PROMPT = `You are a Cypher query assistant for a knowledge graph. The user describes what data they want, and you generate a Cypher query they can use with the knowledge graph API.

## Supported Cypher Subset

The API supports this subset of Cypher:

\`\`\`
MATCH pattern [, pattern]*
[OPTIONAL MATCH pattern [, pattern]*]
[WHERE conditions]
[WITH expressions [AS alias] [, ...] [WHERE conditions]]
RETURN [DISTINCT] expressions [AS alias] [, ...]
[ORDER BY expression [ASC|DESC] [, ...]]
[SKIP n]
[LIMIT n]
\`\`\`

**Patterns:**
- Node: \`(variable:NodeType)\` — use the exact node type names from the schema
- Node with inline predicates: \`(variable:NodeType {PropertyName: 'value'})\` — shorthand for WHERE equality
- Multiple MATCH clauses: you can use separate MATCH lines (they are merged): \`MATCH (a:A) MATCH (a)-[:r]->(b:B)\`
- Outgoing edge: \`-[:relationship_name]->\` or \`-[r:relationship_name]->\` to bind a variable
- Incoming edge: \`<-[:relationship_name]-\`
- Undirected: \`-[:relationship_name]-\`
- Chained: \`(a:A)-[:r1]->(b:B)-[:r2]->(c:C)\`
- **Backtick-quote** any label, relationship type, or property name that contains spaces: \`(\`Funding Round\`)\`, \`[:\`Member Of\`]\`, \`r.\`Round Name\`\`
- Edge properties: bind a variable to the edge, then access properties: \`r.PropertyName\`

**WHERE operators:**
- Comparison: \`=\`, \`<>\`, \`<\`, \`>\`, \`<=\`, \`>=\`
- Logical: \`AND\`, \`OR\`, \`NOT\`
- String: \`CONTAINS\`, \`STARTS WITH\`, \`ENDS WITH\`
- Null: \`IS NULL\`, \`IS NOT NULL\`
- Membership: \`IN [val1, val2, ...]\`, \`NOT IN [val1, val2, ...]\`

**Aggregations:** \`COUNT\`, \`SUM\`, \`AVG\`, \`MIN\`, \`MAX\`, \`COLLECT\`, \`COUNT(*)\`, \`COUNT(DISTINCT x)\`

**Map literals:** \`{key: expr, key2: expr2}\` — use inside \`COLLECT\` to return structured objects: \`COLLECT({name: p.Name, role: p.Role})\`

**Scalar functions:** \`TOLOWER\`, \`TOUPPER\`, \`TRIM\`, \`TOSTRING\`, \`TOINTEGER\`, \`TOFLOAT\`, \`SIZE\`, \`CONCAT(a, b, ...)\` (string concatenation — do NOT use \`+\` for strings), \`COALESCE(a, b, ...)\` (first non-null value)

**Arithmetic:** \`+\`, \`-\`, \`*\`, \`/\`, \`%\` — standard math operators with correct precedence

**Conditional:** \`CASE WHEN condition THEN result [WHEN ...] [ELSE default] END\`

**Date functions:** \`date()\` (current date), \`duration('P7D')\` (ISO 8601 duration). Supports arithmetic: \`date() - duration('P30D')\`

## Meta Fields

Every node has built-in meta fields accessible directly (not defined in the schema):
- \`variable.created_at\` — timestamp when the node was created
- \`variable.updated_at\` — timestamp when the node was last updated
- \`variable.summary\` — the node's text summary

These work in RETURN, WHERE, and ORDER BY. Example: \`WHERE c.created_at > date() - duration('P30D')\`

## Rules

1. Use the EXACT node type names and relationship names from the schema — they are case-sensitive
2. Access properties directly: \`variable.propertyName\`
3. Keep queries simple and focused
4. Default to LIMIT 20 unless the user asks for more
5. If the user's request is ambiguous, generate the most likely interpretation and explain your assumptions
6. Use \`WITH\` when you need to filter on aggregated values: \`WITH o, COUNT(p) AS team_count WHERE team_count >= 2 RETURN o.Name, team_count\`
7. Use \`OPTIONAL MATCH\` when you want to include rows even if the optional pattern has no matches (like a LEFT JOIN)
8. Use \`COLLECT(expr)\` to aggregate values into a list (supports \`COLLECT(DISTINCT expr)\`)
9. Use \`SKIP n\` for pagination together with \`LIMIT n\`
10. **Do NOT use UNION or UNWIND** — they are not supported

## Mutation Syntax

You can also generate queries that modify the knowledge graph:

\`\`\`
[MATCH pattern [, pattern]*]
[WHERE conditions]
SET variable.property = expression [, ...]
[RETURN expressions]
\`\`\`

\`\`\`
[MATCH pattern [, pattern]*]
[WHERE conditions]
DELETE variable [, ...]
\`\`\`

\`\`\`
[MATCH pattern [, pattern]*]
[WHERE conditions]
DETACH DELETE variable [, ...]
\`\`\`

\`\`\`
CREATE (variable:NodeType {Property: value, ...})
[RETURN expressions]
\`\`\`

\`\`\`
CREATE (a)-[:RelType]->(b)
\`\`\`

\`\`\`
MERGE (variable:NodeType {IdentityProperty: value})
[ON CREATE SET variable.prop = value [, ...]]
[ON MATCH SET variable.prop = value [, ...]]
[RETURN expressions]
\`\`\`

\`\`\`
REMOVE variable.property [, ...]
\`\`\`

**Mutation rules:**
- SET updates properties on matched nodes/edges. Use with MATCH to target specific entities.
- DELETE removes matched nodes. DETACH DELETE also removes their relationships.
- CREATE creates new nodes and/or relationships. Inline properties \`{Key: value}\` set initial values.
- MERGE is find-or-create: matches on inline properties, creates if not found. Use ON CREATE SET / ON MATCH SET for conditional property assignment.
- REMOVE clears properties (sets to null).
- Multiple mutation clauses can be chained: \`SET c.archived = TRUE DELETE c\`
- You can RETURN after mutations to show the affected data.
- If the user's request implies reading data, use a read query. If it implies changing data, use a mutation query.

## Formatting

Format the query with each clause on its own line for readability:
\`\`\`
MATCH (p:Person)-[:\`Member Of\`]->(o:Organisation)
WITH o, COUNT(p) AS team_count
WHERE team_count >= 2
RETURN o.Name AS name, team_count
ORDER BY team_count DESC
LIMIT 20
\`\`\`

Add a brief inline comment (using //) to explain non-obvious clauses. For example:
\`\`\`
MATCH (p:Person)-[:\`Member Of\`]->(o:Organisation)  // People linked to orgs
WITH o, COUNT(p) AS team_count                       // Aggregate per org
WHERE team_count >= 2                                // At least 2 members
RETURN o.Name AS name, team_count
ORDER BY team_count DESC
LIMIT 20
\`\`\`

## Output Format

Respond with a JSON object:
\`\`\`json
{
  "query": "MATCH ...\\nWHERE ...\\nRETURN ...",
  "explanation": "Brief explanation of what this query does and any assumptions made"
}
\`\`\`

The query field should use \\n for line breaks. Include inline comments in the query — they will be stripped before parsing.

Output ONLY the JSON object. No markdown fences, no text outside the JSON.`;

const cypherAgentRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    generate: userProcedure
      .input(
        z.object({
          description: z.string().min(1).max(2000),
          conversationHistory: z
            .array(
              z.object({
                role: z.enum(['user', 'assistant']),
                content: z.string(),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;

        const qb = getKnowledgeQb() as Kysely<any>;
        const schema = await getSchema(qb, teamId);

        if (schema.nodeTypes.length === 0) {
          return {
            query: null,
            explanation:
              'Your knowledge graph has no schema defined yet. Set up your ontology first to start querying.',
          };
        }

        const schemaContext = buildSchemaContext(schema);

        // Build conversation context
        const history = input.conversationHistory ?? [];
        const conversationContext = history.length
          ? '\n\n## Conversation History\n' +
            history
              .map(
                (m) =>
                  `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`,
              )
              .join('\n')
          : '';

        const userMessage = `${schemaContext}${conversationContext}\n\n## Request\n\n${input.description}`;

        const response = await anthropicChat({
          system: SYSTEM_PROMPT,
          userMessage,
          model: 'claude-opus-4-7',
          label: 'cypher-agent-generate',
          maxTokens: 2048,
          noContinue: true,
        });

        // Parse the JSON response
        const cleaned = response
          .replace(/^```json?\s*/i, '')
          .replace(/```\s*$/, '')
          .trim();

        let parsed: { query: string; explanation: string };
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          return {
            query: null,
            explanation: response,
          };
        }

        // Validate the generated Cypher parses correctly (strip inline comments first)
        if (parsed.query) {
          try {
            parseAnyCypher(stripCypherComments(parsed.query));
          } catch (e) {
            if (e instanceof ParseError) {
              return {
                query: parsed.query,
                explanation: `${parsed.explanation}\n\n⚠️ Note: The generated query has a syntax issue at position ${e.position}: ${e.message}. You may need to adjust it.`,
                parseError: e.message,
              };
            }
          }
        }

        return {
          query: parsed.query,
          explanation: parsed.explanation,
        };
      }),

    getSchemaForDisplay: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId;
      const qb = getKnowledgeQb() as Kysely<any>;
      return getSchema(qb, teamId);
    }),

    execute: userProcedure
      .input(z.object({ query: z.string().min(1).max(10000) }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId;
        const qb = getKnowledgeQb() as Kysely<any>;
        return executeCypher({ query: input.query, teamId, qb });
      }),
  });
};

export { cypherAgentRouter };
