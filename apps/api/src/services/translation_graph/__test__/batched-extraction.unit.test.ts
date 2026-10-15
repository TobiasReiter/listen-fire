// Wave-1 R2 batched-extraction pipeline tests.
//
// Covers the C1-C9 pipeline with a deterministic fake LLM:
//   - Bundle assembly aggregates string + resource data correctly
//   - Synthetic schema build derives EntityShape + entity guide
//   - Single LLM call for a #extract with multiple EXTRACT_VALUE siblings
//   - Nested #extract with inherited data: batched into one call
//   - Compound-scoped child resolves topologically (parent first)
//   - Validation-failure retry exercises the feedback path
//   - Snapshot test for prompt shape (guards against silent regressions)
//
// Brief: plans/2026-05-19-tg-extraction-parity/_execution/wave-1/R2-batched-extraction.md

import { z } from 'zod';

import type {
  ExtractInvocation,
  ExtractValueInvocation,
} from '../engine/evaluator/batcher';
import type { Resource } from 'movement-engine/services/translation_graph/adapter';

import {
  BatchedExtractionBatcher,
  assembleBundle,
  buildSyntheticSchema,
  rebindResults,
  type LlmClient,
  type LlmCallInput,
  type LlmCallResult,
  type TransformDispatcher,
} from '../engine/batched_extraction';
import {
  buildSkeletonPrompt,
  buildFullExtractionPrompt,
  runFullExtraction,
  runSkeletonPass,
} from '../engine/batched_extraction/phases';
import { ENTITY_DENSITY_OPUS_THRESHOLD } from '../engine/batched_extraction/schema_synthesis';
import { positionData } from 'movement-engine/services/translation_graph/types';

// ── Test helpers ──────────────────────────────────────────────────────────

class FakeLlm implements LlmClient {
  public readonly calls: LlmCallInput[] = [];
  constructor(
    /** Sequence of canned JSON responses. Each `call` pops the next.
     *  Tests can also opt for `responder` for callsite-conditional
     *  responses. */
    private readonly responses: unknown[] = [],
    private readonly responder?: (input: LlmCallInput, idx: number) => unknown,
  ) {}

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    this.calls.push(input);
    const idx = this.calls.length - 1;
    const r = this.responder ? this.responder(input, idx) : this.responses[idx];
    return { parsedJson: r };
  }
}

function makeRootExtract(overrides: Partial<ExtractInvocation> = {}): ExtractInvocation {
  return {
    siteId: 'x:root#1',
    description: 'Extract the main entity from the message',
    data: ['hello world'],
    outputSchema: z.record(z.string(), z.unknown()),
    scope: { ancestorAliases: {} },
    ...overrides,
  };
}

function makeExtractValue(overrides: Partial<ExtractValueInvocation> = {}): ExtractValueInvocation {
  return {
    siteId: 'ev#1',
    parentExtractSiteId: 'x:root#1',
    description: 'The title',
    fieldType: { kind: 'string' },
    ...overrides,
  };
}

function fakeResource(id: string, content: string): Resource {
  return {
    externalId: id,
    type: 'TEXT',
    name: id,
    content,
  };
}

// ── Bundle assembly ───────────────────────────────────────────────────────

describe('assembleBundle (C1)', () => {
  it('emits TEXT segments for string data in declared order', () => {
    const root = makeRootExtract({ data: ['first', 'second'] });
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [],
    });
    expect(bundle.segments.map((s) => s.content)).toEqual(['first', 'second']);
    expect(bundle.segments.every((s) => s.classification === 'TEXT')).toBe(true);
  });

  it('emits a segment per resource with content, dedupes resources', () => {
    const r1 = fakeResource('r1', 'body of r1');
    const r2 = fakeResource('r2', 'body of r2');
    const root = makeRootExtract({ data: [r1, r2, r1, 'plain text'] });
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [],
    });
    expect(bundle.resources.map((r) => r.externalId)).toEqual(['r1', 'r2']);
    expect(bundle.segments).toHaveLength(3); // r1 + r2 + plain text
  });

  it('carries nested extract invocations + extract-value invocations', () => {
    const root = makeRootExtract();
    const nested = makeRootExtract({
      siteId: 'x:child#2',
      scope: { parentExtractSiteId: root.siteId, ancestorAliases: {} },
      data: ['child data'],
    });
    const ev = makeExtractValue();
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [nested],
      extractValueInvocations: [ev],
    });
    expect(bundle.extractInvocations).toHaveLength(2);
    expect(bundle.extractValueInvocations).toHaveLength(1);
  });
});

// ── Synthetic schema build ────────────────────────────────────────────────

describe('buildSyntheticSchema (C4)', () => {
  it('builds an entity per #extract with declared EXTRACT_VALUE fields', () => {
    const root = makeRootExtract();
    const ev1 = makeExtractValue({ siteId: 'ev#1', description: 'the title' });
    const ev2 = makeExtractValue({ siteId: 'ev#2', description: 'the body' });
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev1, ev2],
    });
    const schema = buildSyntheticSchema({ bundle });
    expect(schema.entityCount).toBe(1);
    expect(schema.entities[root.siteId]).toBeDefined();
    expect(schema.entities[root.siteId].fields).toHaveLength(2);
    expect(schema.entities[root.siteId].fields.map((f) => f.name)).toEqual(['the_title', 'the_body']);
  });

  it('validates an LLM response shaped per the synthetic schema', () => {
    const root = makeRootExtract();
    const ev = makeExtractValue();
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev],
    });
    const schema = buildSyntheticSchema({ bundle });

    // Valid response: W3-F5 — every `#extract` site is array-shaped.
    const validResponse = {
      [root.siteId]: [{
        the_title: { evidence: 'Title quoted from source', value: 'hello' },
      }],
    };
    expect(() => schema.responseSchema.parse(validResponse)).not.toThrow();

    // Invalid response: number where string expected
    const invalidResponse = {
      [root.siteId]: [{
        the_title: { evidence: 'q', value: 42 }, // value should be string
      }],
    };
    expect(() => schema.responseSchema.parse(invalidResponse)).toThrow();
  });
});

// ── Empty-source guard ────────────────────────────────────────────────────

describe('extraction over an empty source', () => {
  // Regression: a dry-run preview whose source produced no segments renders
  // to an empty user message. Sending that to Anthropic fails with
  // `400 messages.0: user messages must have non-empty content`. Extraction
  // over an empty source must yield nothing WITHOUT issuing an invalid LLM
  // call.
  function emptyBundle() {
    const root = makeRootExtract({ data: [] });
    const ev = makeExtractValue();
    return assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev],
    });
  }

  it('runFullExtraction short-circuits without calling the LLM', async () => {
    const bundle = emptyBundle();
    expect(bundle.segments).toHaveLength(0); // precondition: nothing to render
    const schema = buildSyntheticSchema({ bundle });
    const llm = new FakeLlm([]);

    const result = await runFullExtraction({ bundle, schema, llm });

    expect(llm.calls).toHaveLength(0);
    expect(result.resultsBySite).toEqual({});
  });

  it('runSkeletonPass short-circuits without calling the LLM', async () => {
    const bundle = emptyBundle();
    const schema = buildSyntheticSchema({ bundle });
    const llm = new FakeLlm([]);

    const result = await runSkeletonPass({ bundle, schema, llm });

    expect(llm.calls).toHaveLength(0);
    expect(result.identitiesBySite).toEqual({});
    expect(result.extractedContextBySite).toEqual({});
  });
});

// ── Batcher pipeline orchestration ────────────────────────────────────────

describe('BatchedExtractionBatcher (full pipeline)', () => {
  it('runs ONE LLM call for a #extract with multiple EXTRACT_VALUE siblings', async () => {
    // W3-F5 — `#extract` is a traversal; every response slot is an array.
    const llm = new FakeLlm([
      {
        'x:root#1': [{
          title: { evidence: 'quoted title', value: 'My Title' },
          body: { evidence: 'quoted body', value: 'Long body text' },
        }],
      },
    ]);
    const batcher = new BatchedExtractionBatcher({ llm });

    // Register the root extract + two EXTRACT_VALUE invocations.
    const root = makeRootExtract({ data: ['some message text'] });
    const nodeP = batcher.registerExtract(root);
    const v1P = batcher.registerExtractValue(
      makeExtractValue({ siteId: 'ev#title', description: 'title' }),
    );
    const v2P = batcher.registerExtractValue(
      makeExtractValue({ siteId: 'ev#body', description: 'body' }),
    );

    const [nodes, v1, v2] = await Promise.all([nodeP, v1P, v2P]);

    expect(llm.calls).toHaveLength(1);
    expect(v1.value).toBe('My Title');
    expect(v2.value).toBe('Long body text');
    expect(nodes).toHaveLength(1);
    expect(positionData(nodes[0])).toMatchObject({ title: 'My Title', body: 'Long body text' });
  });

  it('batches nested #extract with inherited data into one call', async () => {
    const llm = new FakeLlm([
      {
        'x:root#1': [{ headline: { evidence: 'q', value: 'big news' } }],
        'x:child#2': [{ detail: { evidence: 'q', value: 'sub-detail' } }],
      },
    ]);
    const batcher = new BatchedExtractionBatcher({ llm });

    const root = makeRootExtract({ data: ['article text'] });
    const child: ExtractInvocation = {
      siteId: 'x:child#2',
      description: 'Sub-entity',
      data: [], // inherits parent's data via the evaluator
      outputSchema: z.record(z.string(), z.unknown()),
      scope: { parentExtractSiteId: root.siteId, ancestorAliases: {} },
    };

    const rootNode = batcher.registerExtract(root);
    const childNode = batcher.registerExtract(child);
    const v1 = batcher.registerExtractValue(
      makeExtractValue({ siteId: 'ev#1', description: 'headline', parentExtractSiteId: root.siteId }),
    );
    const v2 = batcher.registerExtractValue(
      makeExtractValue({ siteId: 'ev#2', description: 'detail', parentExtractSiteId: child.siteId }),
    );

    const [rNodes, cNodes, h, d] = await Promise.all([rootNode, childNode, v1, v2]);

    expect(llm.calls).toHaveLength(1);
    expect(rNodes).toHaveLength(1);
    expect(cNodes).toHaveLength(1);
    expect(rNodes[0].originRef.nodeId).toBe('ephemeral:x:root#1');
    expect(cNodes[0].originRef.nodeId).toBe('ephemeral:x:child#2');
    expect(h.value).toBe('big news');
    expect(d.value).toBe('sub-detail');
  });

  it('retries the LLM call when validation fails, feeding back the errors', async () => {
    const llm = new FakeLlm(
      [],
      (_input, idx) => {
        if (idx === 0) {
          // First response: invalid (value is wrong type)
          return { 'x:root#1': [{ title: { evidence: 'q', value: 999 } }] };
        }
        // Retry: valid
        return { 'x:root#1': [{ title: { evidence: 'q', value: 'fixed' } }] };
      },
    );
    const batcher = new BatchedExtractionBatcher({ llm });
    const root = makeRootExtract();
    const nodeP = batcher.registerExtract(root);
    const valueP = batcher.registerExtractValue(makeExtractValue({ description: 'title' }));

    const [, v] = await Promise.all([nodeP, valueP]);

    expect(llm.calls).toHaveLength(2);
    // Retry message includes the validation issues
    expect(llm.calls[1].userMessage).toMatch(/previous response had validation errors/i);
    expect(llm.calls[1].label).toMatch(/_retry$/);
    expect(v.value).toBe('fixed');
  });

  it('routes to Opus when entity count crosses the density threshold', async () => {
    // Build a bundle with > ENTITY_DENSITY_OPUS_THRESHOLD invocations
    const root = makeRootExtract();
    const nested: ExtractInvocation[] = [];
    for (let i = 0; i < ENTITY_DENSITY_OPUS_THRESHOLD; i++) {
      nested.push({
        siteId: `x:n#${i}`,
        description: `entity ${i}`,
        data: [],
        outputSchema: z.record(z.string(), z.unknown()),
        scope: { parentExtractSiteId: root.siteId, ancestorAliases: {} },
      });
    }
    const responses: Record<string, unknown> = {};
    for (const inv of [root, ...nested]) responses[inv.siteId] = [{}];

    // The skeleton pass fires (entity count is at threshold), so 2 calls.
    const llm = new FakeLlm([responses, responses]);
    const batcher = new BatchedExtractionBatcher({ llm });
    const all: Promise<unknown>[] = [batcher.registerExtract(root)];
    for (const n of nested) all.push(batcher.registerExtract(n));
    await Promise.all(all);

    // Skeleton pass + full pass when threshold is crossed
    expect(llm.calls.length).toBe(2);
    // Both calls use the opus model
    expect(llm.calls.every((c) => c.model === 'opus')).toBe(true);
  });

  it('topological resolution order — parent #extract resolves before child', async () => {
    const order: string[] = [];
    const llm = new FakeLlm([
      {
        'x:root#1': [{ title: { evidence: 'q', value: 'root-val' } }],
        'x:child#2': [{ sub: { evidence: 'q', value: 'child-val' } }],
      },
    ]);
    const batcher = new BatchedExtractionBatcher({
      llm,
      onApplied: ({ rebind }) => {
        order.push(...rebind.applicationOrder);
      },
    });
    const root = makeRootExtract();
    const child: ExtractInvocation = {
      siteId: 'x:child#2',
      description: 'child',
      data: [],
      outputSchema: z.record(z.string(), z.unknown()),
      scope: { parentExtractSiteId: root.siteId, ancestorAliases: {} },
    };
    await Promise.all([
      batcher.registerExtract(root),
      batcher.registerExtract(child),
    ]);
    expect(order).toEqual([root.siteId, child.siteId]);
  });
});

// ── Rebinding ─────────────────────────────────────────────────────────────

describe('rebindResults (C8)', () => {
  it('produces ephemeral nodes + scalar values + property evidence', () => {
    const root = makeRootExtract();
    const ev = makeExtractValue();
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev],
    });
    const schema = buildSyntheticSchema({ bundle });

    const fullResult = {
      resultsBySite: {
        [root.siteId]: [{
          the_title: { evidence: 'verbatim quote', value: 'Resolved Title' },
        }],
      },
      modelUsed: 'sonnet' as const,
    };
    const result = rebindResults({ bundle, schema, fullResult });
    expect(result.nodesBySite[root.siteId]).toBeDefined();
    expect(result.nodesBySite[root.siteId]).toHaveLength(1);
    expect(result.valuesBySite[ev.siteId]).toBe('Resolved Title');
    // Single-emission EXTRACT_VALUE evidence rides on evidenceBySite,
    // keyed by the extract_value site id (3b §3.3). description → quote.
    expect(result.evidenceBySite[ev.siteId]?.quote).toBe('verbatim quote');
    // The same per-field evidence is also projected onto the (single)
    // ephemeral node so per-position re-evaluation can read it.
    expect(result.nodesBySite[root.siteId][0].evidence?.the_title?.quote).toBe(
      'verbatim quote',
    );
  });

  it('stamps each ephemeral with the bundle resources it was extracted from (R2)', () => {
    // 4d_resources: the whole record derives from the bundle's resources, so
    // every ephemeral the bundle produces carries them as node-level
    // provenance — buildActionPlan seeds these onto the ResourceSink.
    const r1 = fakeResource('r1', 'body of r1');
    const root = makeRootExtract({ data: [r1, 'plain text'] });
    const ev = makeExtractValue();
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev],
    });
    const schema = buildSyntheticSchema({ bundle });
    const fullResult = {
      resultsBySite: {
        [root.siteId]: [
          { the_title: { evidence: 'q1', value: 'A' } },
          { the_title: { evidence: 'q2', value: 'B' } },
        ],
      },
      modelUsed: 'sonnet' as const,
    };
    const result = rebindResults({ bundle, schema, fullResult });
    const ephemerals = result.nodesBySite[root.siteId];
    expect(ephemerals).toHaveLength(2);
    // Both emissions carry the bundle's (single) resource.
    for (const e of ephemerals) {
      expect(e.resources?.map((r) => r.externalId)).toEqual(['r1']);
    }
  });

  it('null-defaults values for EXTRACT_VALUE sites the LLM omitted', () => {
    const root = makeRootExtract();
    const ev1 = makeExtractValue({ siteId: 'ev#a' });
    const ev2 = makeExtractValue({ siteId: 'ev#b', description: 'other' });
    const bundle = assembleBundle({
      rootSiteId: root.siteId,
      rootInvocation: root,
      nestedExtractInvocations: [],
      extractValueInvocations: [ev1, ev2],
    });
    const schema = buildSyntheticSchema({ bundle });
    const result = rebindResults({
      bundle,
      schema,
      fullResult: { resultsBySite: {}, modelUsed: 'sonnet' },
    });
    expect(result.valuesBySite['ev#a']).toBeNull();
    expect(result.valuesBySite['ev#b']).toBeNull();
  });
});

// ── Snapshot of prompt shape ──────────────────────────────────────────────

describe('Prompt-shape snapshots', () => {
  // Representative TG: one root #extract with two EXTRACT_VALUE
  // sub-invocations of different types (string + enum), and one
  // nested #extract.
  function makeRepresentativeBundle() {
    const root = makeRootExtract({
      siteId: 'x:msg#1',
      description: 'Extract the main message entity',
      data: ['Subject: Hello\n\nBody: Important news from the team.'],
    });
    const nested: ExtractInvocation = {
      siteId: 'x:org#2',
      description: 'Extract any organisations mentioned',
      data: [],
      outputSchema: z.record(z.string(), z.unknown()),
      scope: { parentExtractSiteId: root.siteId, ancestorAliases: {} },
    };
    const evTitle: ExtractValueInvocation = {
      siteId: 'ev#title',
      parentExtractSiteId: root.siteId,
      description: 'the subject line of the message',
      fieldType: { kind: 'string' },
    };
    const evSentiment: ExtractValueInvocation = {
      siteId: 'ev#sentiment',
      parentExtractSiteId: root.siteId,
      description: 'the overall sentiment',
      fieldType: { kind: 'enum', values: ['positive', 'neutral', 'negative'] },
      enumOptions: ['positive', 'neutral', 'negative'],
    };
    return {
      bundle: assembleBundle({
        rootSiteId: root.siteId,
        rootInvocation: root,
        nestedExtractInvocations: [nested],
        extractValueInvocations: [evTitle, evSentiment],
      }),
    };
  }

  it('snapshot — full extraction system prompt', () => {
    const { bundle } = makeRepresentativeBundle();
    const schema = buildSyntheticSchema({ bundle });
    const prompt = buildFullExtractionPrompt(schema, undefined);
    expect(prompt).toMatchSnapshot();
  });

  it('snapshot — skeleton system prompt', () => {
    const { bundle } = makeRepresentativeBundle();
    const schema = buildSyntheticSchema({ bundle });
    const prompt = buildSkeletonPrompt(schema);
    expect(prompt).toMatchSnapshot();
  });

  it('snapshot — entity guide for the representative bundle', () => {
    const { bundle } = makeRepresentativeBundle();
    const schema = buildSyntheticSchema({ bundle });
    expect(schema.entityGuide).toMatchSnapshot();
  });
});

// ── Transform dispatcher integration ──────────────────────────────────────

describe('Transform dispatcher integration', () => {
  it('runs pre-extraction transforms before the LLM call', async () => {
    const dispatcherCalls: string[] = [];
    const dispatcher: TransformDispatcher = {
      async runPreExtraction({ bundle }) {
        dispatcherCalls.push('pre');
        return [{ additionalContent: `[transform added text for ${bundle.rootSiteId}]` }];
      },
      async runContextDependent() {
        dispatcherCalls.push('context');
        return [];
      },
      hasContextDependentTransforms() {
        return false;
      },
    };
    const llm = new FakeLlm([{ 'x:root#1': [{}] }]);
    const batcher = new BatchedExtractionBatcher({ llm, transformDispatcher: dispatcher });
    await batcher.registerExtract(makeRootExtract());
    expect(dispatcherCalls).toEqual(['pre']);
    // The LLM should see the augmented content
    expect(llm.calls[0].userMessage).toContain('[transform added text for x:root#1]');
  });

  it('runs context-dependent transforms AFTER the skeleton pass', async () => {
    const order: string[] = [];
    const dispatcher: TransformDispatcher = {
      async runPreExtraction() {
        order.push('pre');
        return [];
      },
      async runContextDependent() {
        order.push('context');
        return [{ additionalContent: 'enriched data' }];
      },
      hasContextDependentTransforms() {
        return true; // forces the skeleton pass
      },
    };
    const llm = new FakeLlm(
      [],
      (_input, idx) => {
        order.push(idx === 0 ? 'skeleton' : 'full');
        return { 'x:root#1': [{}] };
      },
    );
    const batcher = new BatchedExtractionBatcher({ llm, transformDispatcher: dispatcher });
    await batcher.registerExtract(makeRootExtract());
    expect(order).toEqual(['pre', 'skeleton', 'context', 'full']);
  });
});
