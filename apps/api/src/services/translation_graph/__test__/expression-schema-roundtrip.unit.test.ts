// R13 — Round-trip coverage for F3's Expression AST variants through the
// storage zod schema.
//
// Background: G1-v4 surfaced "Gap G" — F3 (commit c56300d2b) extended the
// shared Expression discriminated union with new variants (`extract_value`,
// `alias_ref`, `list`, plus `traverse.aliasRoot`, `EdgeStep.alias`, and a
// new `MetaEdgeStep` traversal variant), but the storage-side zod
// `expressionSchema` and `traversalStepSchema` were never extended in
// lock-step. `parseRowBodyLenient` silently nulled bodies containing the
// new variants, which surfaced downstream as the misleading
// `composition.runComposition: referenced mapping … not found` error.
//
// This suite exercises *every* F3-added variant through the JSON
// serialise → parse round-trip path that storage uses, so the next time
// the shared union grows a variant without a matching zod arm the gap is
// caught at the unit level instead of at the gate.

// Pre-existing zod-circular-deps in the wider codebase trip when this
// suite loads under ts-jest in the natural import order:
//
//   1. `output_v3/schemas.ts:2` imports `webhookGraphOutputConfigInputSchema`
//      from `adapters/webhook/graphOutput`, whose cycle through
//      `pipeline/outbound/common` → `dealflow_pipeline/configuration` →
//      `slack/webApi/output` → `pipeline/outbound/configSchema` loops
//      back to `configSchema.ts:118` (TDZ on
//      `webhookGraphOutputConfigSchema.optional()`).
//
//   2. `output_v3/schemas.ts:290` calls `expressionSchema.optional()` at
//      module-init time, while `output_v3/expression.ts:6` synchronously
//      imports `traversalStepSchema` from schemas.ts. Whichever module is
//      entered first leaves the other's binding undefined.
//
// Both issues are latent in production (the actual server entry point
// loads expression.ts in a path that lets it fully bind before schemas.ts
// runs filterConditionSchema). To exercise the real schemas inside jest
// we need to:
//   (a) neutralise the graph-output detour (problem 1), and
//   (b) hand-load expression.ts first so its `expressionSchema` binding
//       is populated before schemas.ts evaluates filterConditionSchema
//       (problem 2).
//
// jest.mock + require() handles both; we then re-export the loaded
// values for the test bodies.

// Order-sensitive cycle (problem 2): `output_v3/schemas.ts` line 290
// (`filterConditionSchema`) reads `expressionSchema.optional()` at
// module-init time, while `output_v3/expression.ts:6` synchronously
// requires `traversalStepSchema` from schemas.ts.
//   - If schemas.ts is entered first: it requires expression.ts at line 3,
//     expression.ts runs to completion (its own require of schemas hits
//     the in-progress export but only uses traversalStepSchema inside
//     `z.lazy`, so no TDZ), expression.ts populates `expressionSchema`,
//     control returns to schemas.ts line 290 — `expressionSchema.optional()`
//     resolves cleanly.
//   - If expression.ts is entered first (jest's natural import order):
//     it requires schemas.ts which proceeds to line 290 with
//     `expressionSchema = undefined` — TDZ.
//
// Workaround: pre-require schemas.ts via require() so it sets the load
// order before any ES `import` statements (jest hoists imports above
// require() calls *unless* the import is dynamic). We then re-require
// the modules to grab their public values.
//
// This pattern matches sibling tests' workarounds for the same
// pre-existing latent cycle (see composition.unit.test.ts and
// adapter-attio.unit.test.ts), but it doesn't stub schemas — we want
// the real round-trip behaviour.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import type { Expression } from 'movement-engine/services/knowledge_pipeline/output_v3/expression';
import type { TranslationGraphRowBody } from 'movement-engine/services/translation_graph/types';
import type { z as _z } from 'zod';

const schemasModule = require('movement-engine/services/knowledge_pipeline/output_v3/schemas');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const expressionModule = require('movement-engine/services/knowledge_pipeline/output_v3/expression');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const typesModule = require('movement-engine/services/translation_graph/types');


// Surface the loaded module values to the test bodies with proper types.
const expressionSchema = expressionModule.expressionSchema as _z.ZodTypeAny;
const traversalStepSchema = schemasModule.traversalStepSchema as _z.ZodTypeAny;
const filterExpressionSchema =
  schemasModule.filterExpressionSchema as _z.ZodTypeAny;
const translationGraphRowBodySchema =
  typesModule.translationGraphRowBodySchema as _z.ZodTypeAny;
const parseRowBodyLenient = typesModule.parseRowBodyLenient as (
  value: unknown,
) => TranslationGraphRowBody | null;

/** Serialise → parse through JSON to mirror the JSONB storage path. */
function jsonRoundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('R13 — expression schema round-trip for F3 AST variants', () => {
  describe('new leaf variants', () => {
    it('round-trips `extract_value` through expressionSchema', () => {
      const expr: Expression = {
        type: 'extract_value',
        description: 'investment opportunity in this dealflow message',
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('round-trips `alias_ref` through expressionSchema', () => {
      const expr: Expression = { type: 'alias_ref', name: 'opp' };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('round-trips `list` with mixed-variant elements through expressionSchema', () => {
      const expr: Expression = {
        type: 'list',
        elements: [
          { type: 'static', value: 'one' },
          { type: 'alias_ref', name: 'msg' },
          { type: 'extract_value', description: 'company name' },
        ],
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('round-trips `object` with nested list / object values', () => {
      const expr: Expression = {
        type: 'object',
        entries: [
          { key: 'type', value: { type: 'static', value: 'section' } },
          {
            key: 'text',
            value: {
              type: 'object',
              entries: [{ key: 'text', value: { type: 'alias_ref', name: 'msg' } }],
            },
          },
          { key: 'elements', value: { type: 'list', elements: [{ type: 'static', value: 1 }] } },
        ],
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });
  });

  describe('traverse extensions', () => {
    it('round-trips `traverse` with `aliasRoot` (empty steps — dot-chain shape)', () => {
      // Shape emitted by F3 parser for `opp.company` and `msg.content`.
      const expr: Expression = {
        type: 'traverse',
        aliasRoot: 'msg',
        steps: [],
        expression: { type: 'property', propertyTypeId: 'content' },
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('round-trips `traverse` with `aliasRoot` + non-empty steps (alias-rooted walk)', () => {
      // Shape emitted by F3 parser for `msg-[:Author]->.email`.
      const expr: Expression = {
        type: 'traverse',
        aliasRoot: 'msg',
        steps: [
          { type: 'edge', edgeTypeId: 'author', direction: 'outgoing' },
        ],
        expression: { type: 'property', propertyTypeId: 'email' },
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('round-trips an anonymous `traverse` (no aliasRoot) — pre-F3 shape still valid', () => {
      const expr: Expression = {
        type: 'traverse',
        steps: [
          { type: 'edge', edgeTypeId: 'company', direction: 'outgoing' },
        ],
        expression: { type: 'property', propertyTypeId: 'name' },
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });
  });

  describe('EdgeStep.alias', () => {
    it('round-trips an EdgeStep with `alias` through traversalStepSchema', () => {
      // Shape emitted by F3 parser for `-[name:Edge]->`.
      const step = {
        type: 'edge' as const,
        edgeTypeId: 'works_at',
        direction: 'outgoing' as const,
        alias: 'employer',
      };
      const parsed = traversalStepSchema.parse(jsonRoundTrip(step));
      expect(parsed).toEqual(step);
    });

    it('round-trips an EdgeStep without `alias` (anonymous walk)', () => {
      const step = {
        type: 'edge' as const,
        edgeTypeId: 'works_at',
        direction: 'outgoing' as const,
      };
      const parsed = traversalStepSchema.parse(jsonRoundTrip(step));
      expect(parsed).toEqual(step);
    });
  });

  describe('MetaEdgeStep', () => {
    it('round-trips a `#extract` meta-edge step with expression-typed config', () => {
      // Shape emitted by F3 parser for
      //   -[opp:#extract { description: "...", data: [msg.content] }]->
      const step = {
        type: 'meta_edge' as const,
        metaEdge: 'extract' as const,
        alias: 'opp',
        config: {
          description: {
            type: 'static' as const,
            value: 'investment opportunity',
          },
          data: [
            {
              type: 'traverse' as const,
              aliasRoot: 'msg',
              steps: [],
              expression: {
                type: 'property' as const,
                propertyTypeId: 'content',
              },
            },
          ],
        },
      };
      const parsed = traversalStepSchema.parse(jsonRoundTrip(step));
      expect(parsed).toEqual(step);
    });

    it('round-trips a `#transform` meta-edge step with `plugin` config', () => {
      // Shape emitted by F3 parser for
      //   -[urls:#transform { plugin: "vc-url-retrieval" }]->
      const step = {
        type: 'meta_edge' as const,
        metaEdge: 'transform' as const,
        alias: 'urls',
        config: {
          plugin: { type: 'static' as const, value: 'vc-url-retrieval' },
          extra: {
            mode: { type: 'static' as const, value: 'eager' },
          },
        },
      };
      const parsed = traversalStepSchema.parse(jsonRoundTrip(step));
      expect(parsed).toEqual(step);
    });

    it('round-trips a `#resources` meta-edge step with structured filter', () => {
      const step = {
        type: 'meta_edge' as const,
        metaEdge: 'resources' as const,
        filter: {
          resourceType: 'FILE' as const,
          mimeType: 'application/pdf',
        },
      };
      const parsed = traversalStepSchema.parse(jsonRoundTrip(step));
      expect(parsed).toEqual(step);
    });

    it('round-trips a MetaEdgeStep nested inside a `traverse` expression', () => {
      // This is the shape the G1 seed produces for every #extract-rooted
      // fieldMapping: traverse { steps: [meta_edge], expression: extract_value }.
      const expr: Expression = {
        type: 'traverse',
        steps: [
          {
            type: 'meta_edge',
            metaEdge: 'extract',
            alias: 'opp',
            config: {
              description: {
                type: 'static',
                value: 'investment opportunity in this dealflow message',
              },
              data: [
                {
                  type: 'traverse',
                  aliasRoot: 'msg',
                  steps: [],
                  expression: { type: 'property', propertyTypeId: 'content' },
                },
              ],
            },
          },
        ],
        expression: { type: 'extract_value', description: 'company name' },
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });
  });

  describe('negative cases', () => {
    it('rejects an unknown discriminator value with a sensible zod error', () => {
      const bad = { type: 'not_a_real_variant', payload: 'whatever' };
      const result = expressionSchema.safeParse(bad);
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' | ');
        // zod's union-mismatch error is verbose but always references the
        // input or the union — the important guarantee is that *some*
        // error fires, not that the wording is exact.
        expect(messages.length).toBeGreaterThan(0);
      }
    });

    it('rejects a malformed `extract_value` (missing description)', () => {
      const bad = { type: 'extract_value' };
      const result = expressionSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });

    it('rejects a MetaEdgeStep with an invalid metaEdge enum value', () => {
      const bad = {
        type: 'meta_edge',
        metaEdge: 'nope',
        config: {},
      };
      const result = traversalStepSchema.safeParse(bad);
      expect(result.success).toBe(false);
    });
  });

  // W3-F5 — the dedicated `alias_fanout` step was removed; `#extract` is
  // a traversal by nature. These tests pin the new grammar (one-step
  // `#extract`) and confirm the legacy variant no longer round-trips.
  describe('#extract is a traversal (W3-F5)', () => {
    it('rejects the legacy alias_fanout step at the zod schema layer', () => {
      const legacy = { type: 'alias_fanout', alias: 'investor' };
      const result = traversalStepSchema.safeParse(legacy);
      expect(result.success).toBe(false);
    });

    it('round-trips a one-step `#extract` traversal inside a TG body', () => {
      const body = {
        sourceSchemaRef: { kind: 'knowledge-graph' as const },
        targetSchemaRef: { kind: 'knowledge-graph' as const },
        roots: [
          {
            kind: 'action' as const,
            id: 'round-participation',
            targetTypeRef: 'round_participation',
            traversal: [
              {
                type: 'meta_edge' as const,
                metaEdge: 'extract' as const,
                alias: 'investor',
                config: {
                  description: {
                    type: 'static' as const,
                    value: 'each investor in this round',
                  },
                },
              },
            ],
            fieldMappings: [
              {
                targetField: 'investor_name',
                expression: { type: 'extract_value' as const, description: 'investor name' },
                semantics: 'overwrite' as const,
              },
            ],
            children: [],
          },
        ],
      };
      const parsed = translationGraphRowBodySchema.parse(jsonRoundTrip(body));
      expect(parsed).toEqual(body);
    });
  });

  describe('parseRowBodyLenient — visible warning on failure', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('warns and returns null when the body is not an object', () => {
      const result = parseRowBodyLenient('not an object');
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
      expect(message).toContain('parseRowBodyLenient');
    });

    it('warns with zod issue summary when the schema rejects the body', () => {
      // Body has the right top-level shape but an Expression-typed slot
      // contains an unknown discriminator value — this is the exact
      // shape of the Gap G failure.
      const body = {
        sourceSchemaRef: { kind: 'knowledge-graph' },
        targetSchemaRef: { kind: 'knowledge-graph' },
        roots: [
          {
            kind: 'action',
            id: 'r1',
            targetTypeRef: 'opportunity',
            traversal: [],
            children: [],
            fieldMappings: [
              {
                targetField: 'company',
                expression: {
                  type: 'totally-unknown-variant',
                  description: 'should fail',
                },
              },
            ],
          },
        ],
      };
      const result = parseRowBodyLenient(body);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      const [message, payload] = warnSpy.mock.calls[0] ?? [];
      expect(String(message)).toContain('translationGraphRowBodySchema');
      expect(payload).toMatchObject({
        issueCount: expect.any(Number),
      });
      const cast = payload as { issueCount: number };
      expect(cast.issueCount).toBeGreaterThan(0);
    });

    it('accepts a body containing every F3 variant (regression for Gap G)', () => {
      // Mirrors the wave-1 golden-path seed's `buildStandaloneBody` shape
      // — if this parses cleanly we know `composition.runComposition`
      // won't re-trigger the Gap G "mapping not found" misdirection.
      const body: unknown = {
        sourceSchemaRef: { kind: 'knowledge-graph' },
        targetSchemaRef: { kind: 'knowledge-graph' },
        roots: [
          {
            kind: 'action',
            id: 'r1',
            targetTypeRef: 'opportunity',
            traversal: [],
            children: [],
            fieldMappings: [
              {
                targetField: 'company',
                expression: {
                  type: 'traverse',
                  steps: [
                    {
                      type: 'meta_edge',
                      metaEdge: 'extract',
                      alias: 'opp',
                      config: {
                        description: {
                          type: 'static',
                          value: 'investment opportunity in this dealflow message',
                        },
                        data: [
                          {
                            type: 'traverse',
                            aliasRoot: 'msg',
                            steps: [],
                            expression: { type: 'property', propertyTypeId: 'content' },
                          },
                        ],
                      },
                    },
                  ],
                  expression: { type: 'extract_value', description: 'company name' },
                },
              },
            ],
          },
        ],
      };
      const result = parseRowBodyLenient(jsonRoundTrip(body));
      expect(result).not.toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
      // Confirm the new variants survived round-trip intact rather than
      // getting normalised away.
      const root = (result as TranslationGraphRowBody).roots[0] as {
        fieldMappings: Array<{ expression: Expression }>;
      };
      const expr = root.fieldMappings[0]?.expression;
      expect(expr?.type).toBe('traverse');
      // Just narrow enough to satisfy the type-checker — we deep-tested
      // round-trip behaviour above; this is a sanity check on top.
      const traverse = expr as Extract<Expression, { type: 'traverse' }>;
      expect(traverse.expression.type).toBe('extract_value');
    });
  });

  describe('schema surface sanity', () => {
    // Tripwire: if F3 (or a future chunk) adds another Expression variant
    // to the shared union, this list won't change automatically — but the
    // round-trip suite above WILL fail for the new variant, which is the
    // signal a fresh round-trip test is needed here.
    it('expressionSchema covers every F3-added variant', () => {
      const f3Variants: Array<{ type: string; example: Expression }> = [
        { type: 'extract_value', example: { type: 'extract_value', description: 'x' } },
        { type: 'alias_ref', example: { type: 'alias_ref', name: 'x' } },
        { type: 'list', example: { type: 'list', elements: [] } },
        {
          type: 'traverse.aliasRoot',
          example: {
            type: 'traverse',
            aliasRoot: 'x',
            steps: [],
            expression: { type: 'static', value: null },
          },
        },
      ];
      for (const { example } of f3Variants) {
        expect(expressionSchema.safeParse(example).success).toBe(true);
      }
    });
  });

  // INV3 (trial3-fix 2026-06-01): the `within` recency-window function.
  //
  // THE BLIND SPOT this closes: `setNodeUniquenessConstraints` builds a
  // `{ type:'function', fn:'within', args:[<property>, <static interval>] }`
  // expression, and the uniqueness validator (`ALLOWED_FUNCTIONS`), the SQL
  // compiler, and the Attio adapter all consume it — but this *persisted*
  // `expressionSchema` function-enum never listed `'within'`. So a within
  // constraint validated at the authoring tool, then failed the TG-body
  // Zod parse on save, rolling back the whole batch. INV's hand-built unit
  // test mocked `saveTranslationGraph`, so it never hit this real parse;
  // the agent's real `executePlan` path did. This round-trips the exact
  // shape through the storage serialise→parse path that broke.
  describe('within recency-window function (INV3)', () => {
    it('round-trips a `within` function expression through expressionSchema', () => {
      const expr: Expression = {
        type: 'function',
        fn: 'within',
        args: [
          { type: 'property', propertyTypeId: 'created_at' },
          { type: 'static', value: '6 months' },
        ],
      };
      const parsed = expressionSchema.parse(jsonRoundTrip(expr));
      expect(parsed).toEqual(expr);
    });

    it('accepts `within` via safeParse (the persisted-schema arm the save path runs)', () => {
      const expr: Expression = {
        type: 'function',
        fn: 'within',
        args: [
          { type: 'property', propertyTypeId: 'created_at' },
          { type: 'static', value: '1 year 3 months' },
        ],
      };
      expect(expressionSchema.safeParse(jsonRoundTrip(expr)).success).toBe(true);
    });
  });
});

// Suppress unused-import diagnostics — these are part of the public
// surface this test guards against future drift on.
void filterExpressionSchema;
void translationGraphRowBodySchema;
