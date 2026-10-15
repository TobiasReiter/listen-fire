// The `llm` aggregate reaches the chat wrapper; answered here rather than on
// the network, so the test says what the evaluator does, not whether a vendor
// was reachable.
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => 'an aggregated answer'),
}));

import type { Adapter, RuntimeCapabilities, Resource } from 'movement-engine/services/translation_graph/adapter';
import type { Expression } from 'movement-engine/services/knowledge_pipeline/output_v3/expression';

import {
  evaluateExpression,
  ExpressionNotImplementedError,
  ResourceSink,
  type ExpressionEvalContext,
} from '../engine/expression';
import { RESOURCES_REFERENCE_FIELD_ID } from 'movement-engine/services/translation_graph/adapter';
import {
  type SourcePosition,
  makeStablePosition,
  makeUnstablePosition,
  isStablePosition,
  positionRecordId,
} from 'movement-engine/services/translation_graph/types';
import { KG_ADAPTER_TYPE } from '../adapters/knowledge_graph';

/** Permissive caps: all expression kinds + traversal directions allowed. */
function permissiveCaps(
  overrides: Partial<{
    incoming: boolean;
    edgeProperties: boolean;
    resources: boolean;
  }> = {},
): RuntimeCapabilities {
  return {
    traversal: {
      incoming: overrides.incoming ?? true,
      edgeProperties: overrides.edgeProperties ?? true,
    },
    resources: overrides.resources ?? true,
  };
}

/** Minimal stub adapter that returns canned field values keyed by fieldId. */
function makeStubAdapter(values: Record<string, unknown>): Adapter {
  return {
    adapterType: 'stub',
    supportedTriggers: [] as never[],
    runtimeCapabilities: () => permissiveCaps(),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ fieldId }) {
      return values[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord() {
      return { adapterType: 'stub', externalId: 'stub', data: {} };
    },
    async updateRecord() {
      return { adapterType: 'stub', externalId: 'updated', data: {}, association: 'none' };
    },
    async deleteRecord() {
      return {};
    },
  };
}

function ctx(adapter: Adapter, meta: Record<string, unknown> = {}): ExpressionEvalContext {
  const position: SourcePosition = makeStablePosition({
    adapterType: KG_ADAPTER_TYPE,
    recordType: null,
    recordId: 'node-1',
  });
  return { sourceAdapter: adapter, position, meta };
}

describe('evaluateExpression', () => {
  it('evaluates static literals', async () => {
    const c = ctx(makeStubAdapter({}));
    const expr: Expression = { type: 'static', value: 42 };
    expect(await evaluateExpression(expr, c)).toBe(42);
  });

  it('evaluates property accesses through the adapter', async () => {
    const adapter = makeStubAdapter({ name: 'Acme' });
    const expr: Expression = { type: 'property', propertyTypeId: 'name' };
    expect(await evaluateExpression(expr, ctx(adapter))).toBe('Acme');
  });

  it('evaluates meta keys', async () => {
    const c = ctx(makeStubAdapter({}), { triggerId: 'evt-1' });
    const expr: Expression = { type: 'meta', key: 'triggerId' };
    expect(await evaluateExpression(expr, c)).toBe('evt-1');
  });

  // T3 — universal meta keys resolve at evaluation time without needing
  // dispatch to populate ctx.meta. Documented in translation_agent prompt
  // (`@current_date`).
  it('resolves @current_date to today YYYY-MM-DD without dispatcher help', async () => {
    const c = ctx(makeStubAdapter({}));
    const expr: Expression = { type: 'meta', key: 'current_date' };
    const result = await evaluateExpression(expr, c);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('resolves @current_timestamp to an ISO timestamp without dispatcher help', async () => {
    const c = ctx(makeStubAdapter({}));
    const expr: Expression = { type: 'meta', key: 'current_timestamp' };
    const result = await evaluateExpression(expr, c);
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('unknown meta keys resolve to null (not undefined)', async () => {
    const c = ctx(makeStubAdapter({}));
    const expr: Expression = { type: 'meta', key: 'unknownKey' };
    expect(await evaluateExpression(expr, c)).toBeNull();
  });

  it('evaluates concat as string-joined parts (with null-skipping)', async () => {
    const adapter = makeStubAdapter({ first: 'Hello', last: 'World' });
    const expr: Expression = {
      type: 'concat',
      parts: [
        { type: 'property', propertyTypeId: 'first' },
        { type: 'static', value: ' ' },
        { type: 'property', propertyTypeId: 'last' },
      ],
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toBe('Hello World');
  });

  it('evaluates conditionals', async () => {
    const expr: Expression = {
      type: 'conditional',
      condition: { type: 'static', value: true },
      then: { type: 'static', value: 'yes' },
      else: { type: 'static', value: 'no' },
    };
    expect(await evaluateExpression(expr, ctx(makeStubAdapter({})))).toBe('yes');
  });

  it('evaluates compare', async () => {
    const expr: Expression = {
      type: 'compare',
      op: 'eq',
      left: { type: 'static', value: 5 },
      right: { type: 'static', value: 5 },
    };
    expect(await evaluateExpression(expr, ctx(makeStubAdapter({})))).toBe(true);
  });

  it('evaluates logical and/or with short-circuit', async () => {
    const adapter = makeStubAdapter({ a: true, b: false });
    expect(
      await evaluateExpression(
        {
          type: 'logical',
          op: 'and',
          operands: [
            { type: 'property', propertyTypeId: 'a' },
            { type: 'property', propertyTypeId: 'b' },
          ],
        },
        ctx(adapter),
      ),
    ).toBe(false);
    expect(
      await evaluateExpression(
        {
          type: 'logical',
          op: 'or',
          operands: [
            { type: 'property', propertyTypeId: 'a' },
            { type: 'property', propertyTypeId: 'b' },
          ],
        },
        ctx(adapter),
      ),
    ).toBe(true);
  });

  it('evaluates not', async () => {
    const expr: Expression = { type: 'not', expression: { type: 'static', value: false } };
    expect(await evaluateExpression(expr, ctx(makeStubAdapter({})))).toBe(true);
  });

  it('evaluates arithmetic with division-by-zero guard', async () => {
    expect(
      await evaluateExpression(
        {
          type: 'arithmetic',
          op: '+',
          left: { type: 'static', value: 2 },
          right: { type: 'static', value: 3 },
        },
        ctx(makeStubAdapter({})),
      ),
    ).toBe(5);
    expect(
      await evaluateExpression(
        {
          type: 'arithmetic',
          op: '/',
          left: { type: 'static', value: 1 },
          right: { type: 'static', value: 0 },
        },
        ctx(makeStubAdapter({})),
      ),
    ).toBeNull();
  });

  it('evaluates a traverse with empty steps (returns inner expression at current position)', async () => {
    const adapter = makeStubAdapter({ name: 'Acme' });
    const expr: Expression = {
      type: 'traverse',
      steps: [],
      expression: { type: 'property', propertyTypeId: 'name' },
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toBe('Acme');
  });

  it('evaluates a traverse with one outgoing edge step', async () => {
    const childPositions: SourcePosition[] = [
      makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: 'child-1' }),
      makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: 'child-2' }),
    ];
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      async getFieldValue({ position, fieldId }) {
        if (!isStablePosition(position)) return null;
        if (fieldId === 'name') return positionRecordId(position) === 'child-1' ? 'Alpha' : 'Beta';
        return null;
      },
      async getRelated() {
        return childPositions.map((p) => ({ position: p }));
      },
    };
    const expr: Expression = {
      type: 'traverse',
      steps: [{ type: 'edge', edgeTypeId: 'has_child', direction: 'outgoing' }],
      expression: { type: 'property', propertyTypeId: 'name' },
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toEqual(['Alpha', 'Beta']);
  });

  it('returns null when traverse resolves to zero positions', async () => {
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      async getRelated() {
        return [];
      },
    };
    const expr: Expression = {
      type: 'traverse',
      steps: [{ type: 'edge', edgeTypeId: 'has_child', direction: 'outgoing' }],
      expression: { type: 'static', value: 'x' },
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toBeNull();
  });

  it('walks incoming-edge traverse when adapter declares incomingEdges capability', async () => {
    const reverseTargets: SourcePosition[] = [
      makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: 'parent-1' }),
      makeStablePosition({ adapterType: KG_ADAPTER_TYPE, recordType: null, recordId: 'parent-2' }),
    ];
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      async getFieldValue({ position, fieldId }) {
        if (!isStablePosition(position)) return null;
        if (fieldId === 'name') return positionRecordId(position);
        return null;
      },
      async getRelated({ direction }) {
        expect(direction).toBe('incoming');
        return reverseTargets.map((p) => ({ position: p }));
      },
    };
    const expr: Expression = {
      type: 'traverse',
      steps: [{ type: 'edge', edgeTypeId: 'has_child', direction: 'incoming' }],
      expression: { type: 'property', propertyTypeId: 'name' },
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toEqual(['parent-1', 'parent-2']);
  });

  it('throws when incoming-edge traverse is requested but adapter lacks the capability', async () => {
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      runtimeCapabilities: () => permissiveCaps({
        incoming: false,
        edgeProperties: false,
        resources: false,
      }),
    };
    const expr: Expression = {
      type: 'traverse',
      steps: [{ type: 'edge', edgeTypeId: 'has_child', direction: 'incoming' }],
      expression: { type: 'static', value: 1 },
    };
    await expect(evaluateExpression(expr, ctx(adapter))).rejects.toThrow(
      /does not support capability 'incomingEdges'/,
    );
  });

  describe('aggregate', () => {
    function aggCtx(returnValues: unknown[] | unknown): ExpressionEvalContext {
      // Stub a traverse-able adapter where a single-step traversal yields the canned values.
      const positions = (Array.isArray(returnValues) ? returnValues : [returnValues]).map((v, i) =>
        makeStablePosition({
          adapterType: KG_ADAPTER_TYPE,
          recordType: null,
          recordId: `n-${i}-${v}`,
        }),
      );
      const adapter: Adapter = {
        ...makeStubAdapter({}),
        async getFieldValue({ position, fieldId }) {
          if (fieldId !== 'value') return null;
          if (!isStablePosition(position)) return null;
          // Decode the value back from the recordId for the test fixture.
          return (positionRecordId(position) ?? '').split('-').slice(2).join('-');
        },
        async getRelated() {
          return positions.map((p) => ({ position: p }));
        },
      };
      return ctx(adapter);
    }

    const collectExpr: Expression = {
      type: 'aggregate',
      fn: 'collect',
      expression: {
        type: 'traverse',
        steps: [{ type: 'edge', edgeTypeId: 'rel', direction: 'outgoing' }],
        expression: { type: 'property', propertyTypeId: 'value' },
      },
    };

    it('count returns array length', async () => {
      const expr: Expression = { ...collectExpr, fn: 'count' };
      expect(await evaluateExpression(expr, aggCtx(['a', 'b', 'c']))).toBe(3);
    });

    it('first returns first element', async () => {
      const expr: Expression = { ...collectExpr, fn: 'first' };
      expect(await evaluateExpression(expr, aggCtx(['a', 'b', 'c']))).toBe('a');
    });

    it('last returns last element', async () => {
      const expr: Expression = { ...collectExpr, fn: 'last' };
      expect(await evaluateExpression(expr, aggCtx(['a', 'b', 'c']))).toBe('c');
    });

    it('sum sums numeric values', async () => {
      const expr: Expression = { ...collectExpr, fn: 'sum' };
      expect(await evaluateExpression(expr, aggCtx(['1', '2', '3']))).toBe(6);
    });

    it('avg averages numeric values', async () => {
      const expr: Expression = { ...collectExpr, fn: 'avg' };
      expect(await evaluateExpression(expr, aggCtx(['2', '4', '6']))).toBe(4);
    });

    it('min and max work over numeric values', async () => {
      expect(await evaluateExpression({ ...collectExpr, fn: 'min' }, aggCtx(['5', '1', '3']))).toBe(1);
      expect(await evaluateExpression({ ...collectExpr, fn: 'max' }, aggCtx(['5', '1', '3']))).toBe(5);
    });

    it('join concatenates with separator', async () => {
      const expr: Expression = { ...collectExpr, fn: 'join', separator: ' | ' };
      expect(await evaluateExpression(expr, aggCtx(['a', 'b', 'c']))).toBe('a | b | c');
    });

    it('collect returns the array as-is', async () => {
      expect(await evaluateExpression(collectExpr, aggCtx(['a', 'b']))).toEqual(['a', 'b']);
    });

    it('count returns 0 for empty traversal', async () => {
      const expr: Expression = { ...collectExpr, fn: 'count' };
      expect(await evaluateExpression(expr, aggCtx([]))).toBe(0);
    });

    it('llm aggregation runs regardless of adapter capability (AI is a universal primitive)', async () => {
      // E3: `AI(...)` / `llm` is a universal framework primitive (a Haiku call) —
      // no per-adapter capability gate. An adapter that omits `llm` from its
      // declared kinds must NOT reject it.
      //
      const adapter: Adapter = {
        ...makeStubAdapter({}),
        runtimeCapabilities: () => permissiveCaps({
          incoming: false,
          edgeProperties: false,
          resources: false,
        }),
      };
      const expr: Expression = {
        type: 'aggregate',
        fn: 'llm',
        expression: { type: 'static', value: 'x' },
      };
      await expect(evaluateExpression(expr, ctx(adapter))).resolves.toBeDefined();
    });
  });

  describe('function', () => {
    function fctx() {
      return ctx(makeStubAdapter({}));
    }

    it('isnull', async () => {
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'isnull', args: [{ type: 'static', value: null }] },
          fctx(),
        ),
      ).toBe(true);
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'isnull', args: [{ type: 'static', value: 'x' }] },
          fctx(),
        ),
      ).toBe(false);
    });

    it('coalesce returns first non-null', async () => {
      expect(
        await evaluateExpression(
          {
            type: 'function',
            fn: 'coalesce',
            args: [
              { type: 'static', value: null },
              { type: 'static', value: 'x' },
              { type: 'static', value: 'y' },
            ],
          },
          fctx(),
        ),
      ).toBe('x');
    });

    it('trim, lower, upper, length, tostring, tonumber', async () => {
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'trim', args: [{ type: 'static', value: '  hi  ' }] },
          fctx(),
        ),
      ).toBe('hi');
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'upper', args: [{ type: 'static', value: 'hi' }] },
          fctx(),
        ),
      ).toBe('HI');
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'lower', args: [{ type: 'static', value: 'HI' }] },
          fctx(),
        ),
      ).toBe('hi');
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'length', args: [{ type: 'static', value: 'hello' }] },
          fctx(),
        ),
      ).toBe(5);
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'tostring', args: [{ type: 'static', value: 42 }] },
          fctx(),
        ),
      ).toBe('42');
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'tonumber', args: [{ type: 'static', value: '3.14' }] },
          fctx(),
        ),
      ).toBe(3.14);
    });

    it('abs, round, floor, ceil', async () => {
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'abs', args: [{ type: 'static', value: -5 }] },
          fctx(),
        ),
      ).toBe(5);
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'round', args: [{ type: 'static', value: 3.6 }] },
          fctx(),
        ),
      ).toBe(4);
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'floor', args: [{ type: 'static', value: 3.9 }] },
          fctx(),
        ),
      ).toBe(3);
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'ceil', args: [{ type: 'static', value: 3.1 }] },
          fctx(),
        ),
      ).toBe(4);
    });
  });

  // Adapter-provided field functions (e.g. Slack's SLACK_MESSAGE). The
  // parser lowercases `fn`, and the engine resolves it against
  // `ctx.fieldFunctions` only when one is in scope (a field mapping whose
  // target field advertises it).
  describe('field functions', () => {
    it('resolves a field function from ctx.fieldFunctions and passes evaluated args', async () => {
      const calls: unknown[][] = [];
      const c: ExpressionEvalContext = {
        ...ctx(makeStubAdapter({})),
        fieldFunctions: {
          slack_message: async (args) => {
            calls.push(args);
            return `composed:${String(args[0])}`;
          },
        },
      };
      const expr: Expression = {
        type: 'function',
        fn: 'slack_message',
        args: [
          { type: 'static', value: 'thank them' },
          { type: 'static', value: 'Acme' },
        ],
      };
      expect(await evaluateExpression(expr, c)).toBe('composed:thank them');
      expect(calls).toEqual([['thank them', 'Acme']]);
    });

    it('built-ins win over a same-named field function (no shadowing)', async () => {
      const c: ExpressionEvalContext = {
        ...ctx(makeStubAdapter({})),
        fieldFunctions: { trim: async () => 'WRONG' },
      };
      expect(
        await evaluateExpression(
          { type: 'function', fn: 'trim', args: [{ type: 'static', value: '  hi  ' }] },
          c,
        ),
      ).toBe('hi');
    });

    it('throws Unknown function when the name is neither a built-in nor in scope', async () => {
      await expect(
        evaluateExpression(
          { type: 'function', fn: 'slack_message', args: [{ type: 'static', value: 'x' }] },
          ctx(makeStubAdapter({})),
        ),
      ).rejects.toThrow(/Unknown function: slack_message/);
    });

    it('an in-scope field function is unknown once fieldFunctions is absent (outside its field)', async () => {
      const withFn: ExpressionEvalContext = {
        ...ctx(makeStubAdapter({})),
        fieldFunctions: { slack_message: async () => 'ok' },
      };
      const expr: Expression = {
        type: 'function',
        fn: 'slack_message',
        args: [{ type: 'static', value: 'x' }],
      };
      expect(await evaluateExpression(expr, withFn)).toBe('ok');
      await expect(evaluateExpression(expr, ctx(makeStubAdapter({})))).rejects.toThrow(
        /Unknown function: slack_message/,
      );
    });
  });

  it('returns null for resource expression outside of a resource_traverse context', async () => {
    const expr: Expression = { type: 'resource', field: 'content' };
    expect(await evaluateExpression(expr, ctx(makeStubAdapter({})))).toBeNull();
  });

  it('reads resource fields inside a resource_traverse (via the #resources reference)', async () => {
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      // Resources are reached over the uniform traversal path now: the
      // engine walks the reserved `#resources` reference via `getRelated`,
      // and each result carries the `Resource` on its `data`.
      async getRelated({ fieldId }) {
        if (fieldId !== RESOURCES_REFERENCE_FIELD_ID) return [];
        return [
          {
            position: makeUnstablePosition({
              adapterType: 'stub',
              recordType: 'stub:resource',
              data: { type: 'FILE', data: { name: 'first.pdf', url: 'http://x/1' } },
            }),
          },
          {
            position: makeUnstablePosition({
              adapterType: 'stub',
              recordType: 'stub:resource',
              data: { type: 'FILE', data: { name: 'second.pdf', url: 'http://x/2' } },
            }),
          },
        ];
      },
      // `resource` field reads are now a local lookup on the resource's `data`
      // (no bespoke getResourceFieldValue) — the engine reads it directly.
    };
    const expr: Expression = {
      type: 'resource_traverse',
      filter: { resourceType: 'FILE' },
      expression: { type: 'resource', field: 'name' },
    };
    expect(await evaluateExpression(expr, ctx(adapter))).toEqual(['first.pdf', 'second.pdf']);
  });

  it('resolves the #resources meta-edge (no longer throws) and reads resource fields', async () => {
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      async getRelated({ fieldId }) {
        if (fieldId !== RESOURCES_REFERENCE_FIELD_ID) return [];
        return [
          {
            position: makeUnstablePosition({
              adapterType: 'stub',
              recordType: 'stub:resource',
              data: { content: 'body text' },
            }),
          },
        ];
      },
      // After `#resources` moves the cursor onto resource positions, the
      // inner expression reads fields off the resource position via
      // getFieldValue — the uniform traversal path.
      async getFieldValue({ position, fieldId }) {
        const data = position.identity.data as Record<string, unknown> | undefined;
        return data?.[fieldId] ?? null;
      },
    };
    // `node -[:#resources]-> resource`, then a field read at the resource.
    const expr: Expression = {
      type: 'traverse',
      steps: [{ type: 'meta_edge', metaEdge: 'resources' }],
      expression: { type: 'property', propertyTypeId: 'content' },
    } as unknown as Expression;
    expect(await evaluateExpression(expr, ctx(adapter))).toBe('body text');
  });

  // ── Resource sink (4d_resources): node-level resource provenance ──────────
  // A resource *read* during evaluation lands on the node's sink, independent
  // of how the value then propagates. The sink is the carrier for
  // `WriteInput.resources`; `buildActionPlan` allocates one per node.

  function resourcesAdapter(): Adapter {
    return {
      ...makeStubAdapter({}),
      async getRelated({ fieldId }) {
        if (fieldId !== RESOURCES_REFERENCE_FIELD_ID) return [];
        return [
          {
            position: makeUnstablePosition({
              adapterType: 'stub',
              recordType: 'stub:resource',
              data: { externalId: 'r1', type: 'FILE', data: { name: 'first.pdf' } },
            }),
          },
          {
            position: makeUnstablePosition({
              adapterType: 'stub',
              recordType: 'stub:resource',
              data: { externalId: 'r2', type: 'FILE', data: { name: 'second.pdf' } },
            }),
          },
        ];
      },
    };
  }

  it('a resource read drops the resource onto the node sink', async () => {
    const sink = new ResourceSink();
    const c: ExpressionEvalContext = { ...ctx(resourcesAdapter()), resourceSink: sink };
    const expr: Expression = {
      type: 'resource_traverse',
      expression: { type: 'resource', field: 'name' },
    };
    await evaluateExpression(expr, c);
    expect(sink.values().map((r) => r.externalId)).toEqual(['r1', 'r2']);
  });

  it('resources survive transforms (node-level, not property-level)', async () => {
    // The value is concatenated — evidence would be dropped here, but the
    // resource still belongs to the node it contributed to.
    const sink = new ResourceSink();
    const c: ExpressionEvalContext = { ...ctx(resourcesAdapter()), resourceSink: sink };
    const expr: Expression = {
      type: 'resource_traverse',
      expression: {
        type: 'concat',
        parts: [{ type: 'resource', field: 'name' }, { type: 'static', value: '!' }],
      },
    };
    await evaluateExpression(expr, c);
    expect(sink.values().map((r) => r.externalId)).toEqual(['r1', 'r2']);
  });

  it('a resource read with no sink in scope is a harmless no-op', async () => {
    // Filters / runWhen evaluate without a sink — a consulted resource must
    // not throw and must not be attributed to any record.
    const expr: Expression = {
      type: 'resource_traverse',
      expression: { type: 'resource', field: 'name' },
    };
    expect(await evaluateExpression(expr, ctx(resourcesAdapter()))).toEqual([
      'first.pdf',
      'second.pdf',
    ]);
  });

  describe('ResourceSink dedup', () => {
    const res = (over: Partial<Resource>): Resource => ({ type: 'TEXT', ...over });

    it('dedupes by id', () => {
      const sink = new ResourceSink();
      sink.add(res({ id: 'uuid-1' as Resource['id'], name: 'a' }));
      sink.add(res({ id: 'uuid-1' as Resource['id'], name: 'a-again' }));
      expect(sink.values()).toHaveLength(1);
    });

    it('dedupes by externalId when no id', () => {
      const sink = new ResourceSink();
      sink.add(res({ externalId: 'ext-1' }));
      sink.add(res({ externalId: 'ext-1' }));
      expect(sink.values()).toHaveLength(1);
    });

    it('keeps anonymous resources (neither id nor externalId)', () => {
      const sink = new ResourceSink();
      sink.add(res({ name: 'x' }));
      sink.add(res({ name: 'y' }));
      expect(sink.values()).toHaveLength(2);
    });
  });

  it('edge_property reads from the walked edges inline properties', async () => {
    // Edge properties ride inline on the walked edges (3b §2), captured into
    // ctx.lastEdgeProperties during traversal.
    const baseCtx = ctx(makeStubAdapter({}));
    const ctxWithEdges: ExpressionEvalContext = {
      ...baseCtx,
      lastEdgeProperties: [{ strength: 0.9 }, { strength: 0.7 }],
    };
    const expr: Expression = { type: 'edge_property', propertyTypeId: 'strength' };
    expect(await evaluateExpression(expr, ctxWithEdges)).toEqual([0.9, 0.7]);
  });

  // (Removed: 'linked_object resolves through getPriorMatch' — the
  // linked_object expression case + the getPriorMatch correspondence method
  // were retired with the TG engine; linking is the engine-owned `bind` store.)

  it('edge_property throws when adapter lacks edgeProperties capability', async () => {
    const adapter: Adapter = {
      ...makeStubAdapter({}),
      runtimeCapabilities: () => permissiveCaps({
        incoming: false,
        edgeProperties: false,
        resources: false,
      }),
    };
    const expr: Expression = { type: 'edge_property', propertyTypeId: 'strength' };
    await expect(evaluateExpression(expr, ctx(adapter))).rejects.toThrow(
      /does not support capability 'edgeProperties'/,
    );
  });

  describe('multivalue', () => {
    it('at returns the indexed element from an array', async () => {
      const adapter = makeStubAdapter({ names: ['alpha', 'beta', 'gamma'] });
      const expr: Expression = {
        type: 'at',
        expression: { type: 'property', propertyTypeId: 'names' },
        index: { type: 'static', value: 1 },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBe('beta');
    });

    it('at supports negative indices (Cypher-style)', async () => {
      const adapter = makeStubAdapter({ names: ['alpha', 'beta', 'gamma'] });
      const expr: Expression = {
        type: 'at',
        expression: { type: 'property', propertyTypeId: 'names' },
        index: { type: 'static', value: -1 },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBe('gamma');
    });

    it('at returns null when index is out of bounds', async () => {
      const adapter = makeStubAdapter({ names: ['only'] });
      const expr: Expression = {
        type: 'at',
        expression: { type: 'property', propertyTypeId: 'names' },
        index: { type: 'static', value: 5 },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBeNull();
    });

    it('at on a scalar value returns it at index 0, null elsewhere', async () => {
      const adapter = makeStubAdapter({ name: 'solo' });
      const exprZero: Expression = {
        type: 'at',
        expression: { type: 'property', propertyTypeId: 'name' },
        index: { type: 'static', value: 0 },
      };
      expect(await evaluateExpression(exprZero, ctx(adapter))).toBe('solo');
      const exprOne: Expression = {
        type: 'at',
        expression: { type: 'property', propertyTypeId: 'name' },
        index: { type: 'static', value: 1 },
      };
      expect(await evaluateExpression(exprOne, ctx(adapter))).toBeNull();
    });

    it('compare.eq does set-equality when both sides are arrays', async () => {
      const adapter = makeStubAdapter({ tags: ['a', 'b', 'c'] });
      const expr: Expression = {
        type: 'compare',
        op: 'eq',
        left: { type: 'property', propertyTypeId: 'tags' },
        right: { type: 'property', propertyTypeId: 'tags' },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBe(true);
    });

    it('compare.eq with set-equality ignores order and duplicates', async () => {
      const adapter = makeStubAdapter({
        a: ['x', 'y', 'z'],
        b: ['z', 'y', 'x', 'x'],
      });
      const expr: Expression = {
        type: 'compare',
        op: 'eq',
        left: { type: 'property', propertyTypeId: 'a' },
        right: { type: 'property', propertyTypeId: 'b' },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBe(true);
    });

    it('compare.eq returns false when array sets differ', async () => {
      const adapter = makeStubAdapter({
        a: ['x', 'y'],
        b: ['x', 'z'],
      });
      const expr: Expression = {
        type: 'compare',
        op: 'eq',
        left: { type: 'property', propertyTypeId: 'a' },
        right: { type: 'property', propertyTypeId: 'b' },
      };
      expect(await evaluateExpression(expr, ctx(adapter))).toBe(false);
    });
  });
});
