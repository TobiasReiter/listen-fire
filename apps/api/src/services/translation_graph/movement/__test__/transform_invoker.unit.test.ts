// The production `through` / plugin-call invoker (`transform_invoker.ts`):
// dispatch by the plugin's declared timing, and translation of its output.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// The invoker looks stored documents up; these plugins store none.
jest.mock('../../../document', () => ({
  DocumentService: { getById: jest.fn(async () => null) },
}));

import {
  registerTransform,
  type TransformImpl,
  type TransformInput,
} from '../../engine/transforms/registry';
import { registryTransformInvoker } from '../transform_invoker';
import { NO_BUDGET_LIMIT } from 'movement-engine/lib/run_cost';

// ── registryTransformInvoker: kind dispatch + output translation ────────────
// The production invoker the host hands the engine. Guards the
// regression where every plugin was dispatched as `context-dependent` and only
// `properties` were read — which silently no-op'd pre-extraction, edge-emitting
// plugins like vc_url_retrieval (they throw on the wrong kind, and their
// fetched text rides on edges, not properties).
describe('registryTransformInvoker dispatch', () => {
  const seenKind: Record<string, TransformInput['kind'] | undefined> = {};

  beforeAll(() => {
    const preImpl: TransformImpl = {
      signature: {
        name: '__test_pre',
        description: 'pre-extraction fake',
        params: [],
        dataDependency: 'none',
        additions: {},
      },
      run: async (input) => {
        seenKind.pre = input.kind;
        return {
          edges: {
            fetched: [
              { data: { url: 'https://x', text: 'PAGE ONE' } },
              { data: { url: 'https://y', text: 'PAGE TWO' } },
            ],
          },
        };
      },
    };
    const ctxImpl: TransformImpl = {
      signature: {
        name: '__test_ctx',
        description: 'context-dependent fake',
        params: [],
        dataDependency: 'extracted_context',
        additions: { properties: { added: { kind: 'string' } } },
      },
      run: async (input) => {
        seenKind.ctx = input.kind;
        return { properties: { added: 'value' } };
      },
    };
    const throwImpl: TransformImpl = {
      signature: {
        name: '__test_throw',
        description: 'always throws',
        params: [],
        dataDependency: 'none',
        additions: {},
      },
      run: async () => {
        throw new Error('boom');
      },
    };
    // A plugin that attached nothing but has something to say about why.
    const outcomeImpl: TransformImpl = {
      signature: {
        name: '__test_outcome',
        description: 'reports an outcome and attaches nothing',
        params: [],
        dataDependency: 'extracted_context',
        additions: {},
      },
      run: async () => ({ outcome: 'no_match' }),
    };
    // A plugin that prices its own work.
    const pricedImpl: TransformImpl = {
      signature: {
        name: '__test_priced',
        description: 'reports what it cost',
        params: [],
        dataDependency: 'extracted_context',
        additions: {},
      },
      run: async () => ({ outcome: 'fetched', cost: { quantity: 2, unit: 'request', unitPriceMicrodollars: 1_500 } }),
    };
    registerTransform(preImpl);
    registerTransform(ctxImpl);
    registerTransform(throwImpl);
    registerTransform(outcomeImpl);
    registerTransform(pricedImpl);
  });

  it('dispatches a pre-extraction plugin with pre-extraction input and pipes its edge-text into result.text', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_pre',
      config: { content: 'source' },
      extractedContext: {},
      budget: NO_BUDGET_LIMIT,
    });
    expect(seenKind.pre).toBe('pre-extraction');
    expect(result.text).toBe('PAGE ONE\n\nPAGE TWO');
    expect(result.data).toBeUndefined();
  });

  it('dispatches a context-dependent plugin with context-dependent input and returns its properties as data', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_ctx',
      config: {},
      extractedContext: { name: 'Ada' },
      budget: NO_BUDGET_LIMIT,
    });
    expect(seenKind.ctx).toBe('context-dependent');
    expect(result.data).toEqual({ added: 'value' });
    expect(result.text).toBeUndefined();
  });

  it('carries a plugin’s declared outcome back with its result', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_outcome',
      config: {},
      extractedContext: {},
      budget: NO_BUDGET_LIMIT,
    });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('answers a plugin’s own cost envelope as a cost line under the plugin’s name', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_priced',
      config: {},
      extractedContext: {},
      budget: NO_BUDGET_LIMIT,
    });
    expect(result).toEqual({ outcome: 'fetched', cost: [{ source: 'plugin:__test_priced', microdollars: 3_000 }] });
  });

  it('turns a throwing plugin into an empty result rather than failing the run', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__test_throw',
      config: { content: 'source' },
      extractedContext: {},
      budget: NO_BUDGET_LIMIT,
    });
    expect(result).toEqual({});
  });

  it('returns an empty result for an unknown plugin', async () => {
    const result = await registryTransformInvoker.invoke({
      plugin: '__does_not_exist',
      config: {},
      extractedContext: {},
      budget: NO_BUDGET_LIMIT,
    });
    expect(result).toEqual({});
  });
});
