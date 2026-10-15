/**
 * Unit tests for R8 — resource-lifecycle fact extraction.
 *
 * Covers:
 *   1. `extractFactsForResource` runs the underlying LLM extraction the
 *      first time it's called on a Resource.
 *   2. A second call on the same Resource value returns the cached
 *      result without re-issuing the LLM call.
 *   3. Concurrent invocations coalesce on the same in-flight promise
 *      (no double LLM call).
 *   4. Short / empty content short-circuits to `[]` without calling out.
 *   5. A stub bundle assembler (mimicking R2 C1 + C2) surfaces the
 *      cached facts via `getCachedFactsForResource`.
 */

const mockAnthropicChat = jest.fn();
jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: (...args: unknown[]) => mockAnthropicChat(...args),
}));

jest.mock('../../../lib/prompts/execute', () => ({
  parseJson: (raw: string) => JSON.parse(raw),
}));

jest.mock('../../../lib/utils/environment', () => ({
  getEnvVar: () => 'test-key',
}));

jest.mock('../../../lib/llm_usage', () => ({
  recordLlmUsage: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: jest.fn(() => ({
    insertInto: jest.fn().mockReturnThis(),
    selectFrom: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import type { Resource, Fact } from 'movement-engine/services/translation_graph/adapter';

import {
  extractFactsForResource,
  getCachedFactsForResource,
  _resetResourceFactCache,
  resetChunkContexts,
} from '../facts';

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    externalId: 'res_test_1',
    type: 'TEXT',
    name: 'sample',
    content:
      'Sarah Chen from Sequoia introduced Acme Corp, which is raising a $5M Series A. ' +
      'The company was founded in 2021 and now has 42 employees.',
    ...overrides,
  };
}

function mockExtractionResponse(facts: Fact[], summary = 'A test summary.') {
  mockAnthropicChat.mockResolvedValueOnce(
    JSON.stringify({ facts, summary }),
  );
}

beforeEach(() => {
  mockAnthropicChat.mockReset();
  resetChunkContexts();
});

describe('extractFactsForResource', () => {
  it('runs extraction the first time and returns facts', async () => {
    const resource = makeResource();
    mockExtractionResponse([
      { s: 'Sarah Chen', p: 'affiliated_with', o: 'Sequoia' },
      { s: 'Acme Corp', p: 'round_type', o: 'Series A' },
    ]);

    const facts = await extractFactsForResource(resource);

    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ s: 'Sarah Chen', p: 'affiliated_with', o: 'Sequoia' });
  });

  it('returns cached facts on a second invocation without re-calling the LLM', async () => {
    const resource = makeResource({ externalId: 'res_test_2' });
    mockExtractionResponse([{ s: 'Acme', p: 'round_type', o: 'Series A' }]);

    const first = await extractFactsForResource(resource);
    const second = await extractFactsForResource(resource);

    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(second).toHaveLength(1);
  });

  it('coalesces concurrent invocations onto a single LLM call', async () => {
    const resource = makeResource({ externalId: 'res_test_3' });

    let resolveLlm: (raw: string) => void = () => {};
    mockAnthropicChat.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveLlm = resolve;
        }),
    );

    const p1 = extractFactsForResource(resource);
    const p2 = extractFactsForResource(resource);

    resolveLlm(
      JSON.stringify({
        facts: [{ s: 'Sarah Chen', p: 'role', o: 'Partner' }],
        summary: 'x',
      }),
    );

    const [f1, f2] = await Promise.all([p1, p2]);
    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(f1).toEqual(f2);
    expect(f1).toHaveLength(1);
  });

  it('short-circuits empty or trivially short content without calling the LLM', async () => {
    const empty = makeResource({ externalId: 'res_empty', content: undefined });
    const short = makeResource({ externalId: 'res_short', content: 'too short' });

    const emptyFacts = await extractFactsForResource(empty);
    const shortFacts = await extractFactsForResource(short);

    expect(emptyFacts).toEqual([]);
    expect(shortFacts).toEqual([]);
    expect(mockAnthropicChat).not.toHaveBeenCalled();
  });

  it('surfaces extraction errors as empty facts and caches the empty result', async () => {
    const resource = makeResource({ externalId: 'res_test_err' });
    mockAnthropicChat.mockRejectedValueOnce(new Error('LLM exploded'));

    const facts = await extractFactsForResource(resource);
    expect(facts).toEqual([]);

    // Second call returns the cached empty result; no re-call.
    const again = await extractFactsForResource(resource);
    expect(again).toEqual([]);
    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
  });

  it('treats distinct Resource objects with the same id as independent cache entries', async () => {
    // Cache is keyed by Resource object identity (WeakMap), not by id —
    // this matches the in-memory lifecycle: each newly-created Resource
    // gets its own extraction.
    const a = makeResource({ externalId: 'res_shared_id' });
    const b = makeResource({ externalId: 'res_shared_id' });

    // Each extractFacts call → 1 LLM call for facts. The second call
    // may also issue a condense-summary LLM call because the underlying
    // chunkContexts map keys by resourceId; we mock that with a generic
    // fallback below.
    mockExtractionResponse([{ s: 'A', p: 'p', o: 'o' }]);
    mockExtractionResponse([{ s: 'B', p: 'p', o: 'o' }]);
    mockAnthropicChat.mockResolvedValue('condensed summary');

    const fa = await extractFactsForResource(a);
    const fb = await extractFactsForResource(b);

    expect(fa[0].s).toBe('A');
    expect(fb[0].s).toBe('B');
    // Two extraction LLM calls — the cache did NOT collapse the two
    // distinct Resource objects together.
    expect(fa).not.toBe(fb);
  });
});

describe('getCachedFactsForResource', () => {
  it('returns undefined for a Resource that has not been processed', () => {
    const resource = makeResource({ externalId: 'res_uncached' });
    expect(getCachedFactsForResource(resource)).toBeUndefined();
  });

  it('returns the cached facts after extraction has run', async () => {
    const resource = makeResource({ externalId: 'res_cache_lookup' });
    mockExtractionResponse([{ s: 'X', p: 'p', o: 'Y' }]);
    await extractFactsForResource(resource);

    const cached = getCachedFactsForResource(resource);
    expect(cached).toBeDefined();
    expect(cached).toHaveLength(1);
    expect(cached![0]).toMatchObject({ s: 'X', p: 'p', o: 'Y' });
  });
});

describe('bundle assembler stub (mimics R2 C1 + C2)', () => {
  // C1: bundle assembler walks the source positions and collects the
  // resources attached to them. C2: for each resource, it surfaces the
  // facts already cached by the lifecycle hook. We model both in a tiny
  // local stub so we can assert that the cache is wired correctly
  // without pulling in the full TG engine.

  interface Bundle {
    resources: Array<{ resource: Resource; facts: Fact[] }>;
  }

  async function assembleBundle(resources: Resource[]): Promise<Bundle> {
    // C2: ensure every resource has had the lifecycle hook run.
    await Promise.all(resources.map((r) => extractFactsForResource(r)));
    // Then surface the cached facts via the read-side accessor.
    return {
      resources: resources.map((r) => ({
        resource: r,
        facts: getCachedFactsForResource(r) ?? [],
      })),
    };
  }

  it('surfaces facts produced by the lifecycle hook through the bundle', async () => {
    const r1 = makeResource({ externalId: 'bundle_r1' });
    const r2 = makeResource({
      externalId: 'bundle_r2',
      content:
        'Initech raised a $20M Series B led by Acme Ventures in 2024. ' +
        'CEO Peter Gibbons announced 80 new hires.',
    });

    mockExtractionResponse([
      { s: 'Sarah Chen', p: 'affiliated_with', o: 'Sequoia' },
    ]);
    mockExtractionResponse([
      { s: 'Initech', p: 'round_type', o: 'Series B' },
      { s: 'Peter Gibbons', p: 'role', o: 'CEO' },
    ]);

    const bundle = await assembleBundle([r1, r2]);

    expect(bundle.resources).toHaveLength(2);
    expect(bundle.resources[0].facts).toHaveLength(1);
    expect(bundle.resources[1].facts).toHaveLength(2);
    expect(bundle.resources[1].facts.map((f) => f.s)).toEqual(
      expect.arrayContaining(['Initech', 'Peter Gibbons']),
    );
  });

  it('reusing the same Resource across bundle assemblies hits the cache', async () => {
    const resource = makeResource({ externalId: 'bundle_reuse' });
    mockExtractionResponse([{ s: 'A', p: 'p', o: 'B' }]);

    const bundle1 = await assembleBundle([resource]);
    const bundle2 = await assembleBundle([resource]);

    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(bundle1.resources[0].facts).toEqual(bundle2.resources[0].facts);
  });
});

describe('_resetResourceFactCache', () => {
  it('clears the cache for a single Resource so extraction can re-run', async () => {
    const resource = makeResource({ externalId: 'res_reset' });
    mockExtractionResponse([{ s: 'A', p: 'p', o: 'B' }]);
    // Generic fallback for any subsequent condense-summary calls inside
    // extractFacts's chunk-context bookkeeping.
    mockAnthropicChat.mockResolvedValue('condensed');
    const first = await extractFactsForResource(resource);
    expect(first[0]).toMatchObject({ s: 'A', p: 'p', o: 'B' });

    _resetResourceFactCache(resource);

    mockExtractionResponse([{ s: 'C', p: 'p', o: 'D' }]);
    const second = await extractFactsForResource(resource);
    expect(second[0]).toMatchObject({ s: 'C', p: 'p', o: 'D' });
    expect(second).not.toBe(first);
  });
});
