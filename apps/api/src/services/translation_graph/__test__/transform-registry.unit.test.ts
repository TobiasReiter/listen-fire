// Transform registry — register / lookup / list semantics plus type-level
// coverage that both TransformInput timings (`pre-extraction` and
// `context-dependent`) flow through the registered `run` signature.
//
// Brief: plans/2026-05-19-tg-extraction-parity/_execution/wave-0/F4-transform-registry.md

import type { SourcePosition, TransformSignature } from '../types';

import {
  _resetTransformRegistry,
  getTransform,
  listTransforms,
  registerTransform,
  type ContextDependentInput,
  type PreExtractionInput,
  type TransformImpl,
  type TransformInput,
  type TransformOutput,
} from '../engine/transforms';
import { makeStablePosition } from '../types';

const sourceNode: SourcePosition = makeStablePosition({
  adapterType: 'fixture',
  recordType: 'fixture.thing',
  recordId: 'rec-1',
  data: {},
});

function noneSignature(name: string): TransformSignature {
  return {
    name,
    description: `Test transform ${name} — pre-extraction.`,
    params: [
      { name: 'flag', type: { kind: 'boolean' }, required: false },
    ],
    dataDependency: 'none',
    additions: {
      properties: { extra: { kind: 'string' } },
    },
  };
}

function contextSignature(name: string): TransformSignature {
  return {
    name,
    description: `Test transform ${name} — context-dependent.`,
    params: [],
    dataDependency: 'extracted_context',
    additions: {
      edges: {
        enriched: { target: { kind: 'record', fields: { url: { kind: 'string' } } } },
      },
    },
  };
}

function makeImpl(
  signature: TransformSignature,
  run: (input: TransformInput) => Promise<TransformOutput> = async () => ({}),
): TransformImpl {
  return { signature, run };
}

describe('transform registry', () => {
  beforeEach(() => {
    _resetTransformRegistry();
  });

  describe('register + lookup + list', () => {
    it('registers a transform and looks it up by signature name', () => {
      const impl = makeImpl(noneSignature('preflight-urls'));
      registerTransform(impl);

      const found = getTransform('preflight-urls');
      expect(found).toBe(impl);
      expect(found?.signature.dataDependency).toBe('none');
    });

    it('returns undefined for unknown names', () => {
      registerTransform(makeImpl(noneSignature('known')));
      expect(getTransform('not-registered')).toBeUndefined();
    });

    it('lists every registered transform in registration order', () => {
      const a = makeImpl(noneSignature('a-transform'));
      const b = makeImpl(contextSignature('b-transform'));
      const c = makeImpl(noneSignature('c-transform'));

      registerTransform(a);
      registerTransform(b);
      registerTransform(c);

      const listed = listTransforms();
      expect(listed).toHaveLength(3);
      expect(listed.map((t) => t.signature.name)).toEqual([
        'a-transform',
        'b-transform',
        'c-transform',
      ]);
    });

    it('starts empty after reset', () => {
      registerTransform(makeImpl(noneSignature('temp')));
      _resetTransformRegistry();
      expect(listTransforms()).toEqual([]);
      expect(getTransform('temp')).toBeUndefined();
    });
  });

  describe('duplicate-name rejection', () => {
    it('throws when registering a second transform with the same name', () => {
      registerTransform(makeImpl(noneSignature('shared')));
      expect(() => registerTransform(makeImpl(contextSignature('shared')))).toThrow(
        /already registered/,
      );
    });

    it('preserves the first registration when a duplicate is rejected', () => {
      const first = makeImpl(noneSignature('shared'));
      registerTransform(first);
      expect(() => registerTransform(makeImpl(noneSignature('shared')))).toThrow();
      expect(getTransform('shared')).toBe(first);
      expect(listTransforms()).toHaveLength(1);
    });
  });

  describe('both timing signatures parse through the type system', () => {
    it('accepts a pre-extraction TransformInput at run-time', async () => {
      const calls: TransformInput[] = [];
      const impl = makeImpl(noneSignature('echo-pre'), async (input) => {
        calls.push(input);
        if (input.kind === 'pre-extraction') {
          return { properties: { extra: 'hello' } };
        }
        return {};
      });
      registerTransform(impl);

      const input: PreExtractionInput = {
        kind: 'pre-extraction',
        sourceNode,
        config: { flag: true },
      };
      const out = await getTransform('echo-pre')!.run(input);
      expect(calls).toHaveLength(1);
      expect(calls[0].kind).toBe('pre-extraction');
      expect(out.properties).toEqual({ extra: 'hello' });
    });

    it('accepts a context-dependent TransformInput at run-time', async () => {
      const calls: TransformInput[] = [];
      const impl = makeImpl(contextSignature('echo-ctx'), async (input) => {
        calls.push(input);
        if (input.kind === 'context-dependent') {
          return {
            edges: {
              enriched: { data: { url: 'https://example.com' } },
            },
          };
        }
        return {};
      });
      registerTransform(impl);

      const input: ContextDependentInput = {
        kind: 'context-dependent',
        sourceNode,
        config: {},
        extractedContext: { name: 'Ada' },
      };
      const out = await getTransform('echo-ctx')!.run(input);
      expect(calls).toHaveLength(1);
      expect(calls[0].kind).toBe('context-dependent');
      expect(out.edges?.enriched).toEqual({ data: { url: 'https://example.com' } });
    });

    it('discriminated union narrows correctly inside `run`', async () => {
      // Pure type-level assertion — compiled, executed for safety.
      const impl = makeImpl(noneSignature('narrowing'), async (input) => {
        if (input.kind === 'pre-extraction') {
          // @ts-expect-error — extractedContext is not available here.
          input.extractedContext;
          return {};
        }
        // input is narrowed to ContextDependentInput here.
        const _ctx: unknown = input.extractedContext;
        void _ctx;
        return {};
      });
      registerTransform(impl);
      await impl.run({ kind: 'pre-extraction', sourceNode, config: {} });
    });
  });
});
