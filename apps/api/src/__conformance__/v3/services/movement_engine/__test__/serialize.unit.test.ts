// Scope serialize / rehydrate round-trips (async user interaction §4.1).
//
// For each binding bucket: serialize → JSON stringify/parse → rehydrate yields an
// equivalent binding MODULO live refs (the adapter is re-resolved, a FileRef's
// retrieve() rebound, the instance schema re-fetched — none of those survive the
// wire, by design). The rehydration context is mocked, with one real-ish path
// (the document-store FileRef reviver wired to a stub store).

import { Readable } from 'node:stream';

import type { FileRef, Resource } from '../../translation_graph/adapter';
import type { SourcePosition } from '../../translation_graph/types';
import type { Binding, DeferredWalk, SourceRead, WriteRecord } from '../expression';
import { Environment } from '../expression';
import type { ExtractEmission } from '../extraction';
import {
  assertJsonSerializable,
  assertParkRead,
  newParkReader,
  newParkWriter,
  rehydrateBinding,
  serializeBinding,
  serializeScopeChain,
  type BindingDescriptor,
  type FileRefDescriptor,
  type RehydrationContext,
} from '../serialize';
import { MovementEngineError } from '../errors';

// ── A fake adapter / source-read the registry "re-resolves" to ──
const fakeAdapter = { adapterType: 'attio' } as unknown as SourceRead['adapter'];

function makeCtx(overrides: Partial<RehydrationContext> = {}): RehydrationContext {
  const sourceRead: SourceRead = { adapter: fakeAdapter, instanceName: 'crm' };
  return {
    resolveInstance: async (identity) => ({
      kind: 'instance',
      name: identity.name,
      adapterSlug: identity.adapterSlug,
      ...(identity.credentialName !== undefined ? { credentialName: identity.credentialName } : {}),
      ...(identity.constructionConfig !== undefined
        ? { constructionConfig: identity.constructionConfig }
        : {}),
      // The schema is RE-FETCHED live — the mock supplies a fresh one.
      schema: { types: {} } as never,
    }),
    resolveSourceRead: async () => sourceRead,
    reviveFileRef: (d: FileRefDescriptor): FileRef => ({
      __brand: 'FileRef',
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.contentType !== undefined ? { contentType: d.contentType } : {}),
      ...(d.size !== undefined ? { size: d.size } : {}),
      ...(d.source !== undefined ? { source: d.source } : {}),
      retrieve: async () => ({ stream: Readable.from(Buffer.from('revived')), contentType: d.contentType }),
    }),
    resolveCodeRef: (name) => ({ kind: 'value', value: `code-ref:${name}` }),
    ...overrides,
  };
}

const SPAN = { start: { line: 1, col: 1 }, end: { line: 1, col: 2 } };

/** serialize → wire round-trip → rehydrate. */
async function roundTrip(binding: Binding, ctx = makeCtx()): Promise<Binding> {
  const descriptor = serializeBinding(binding);
  const wired: BindingDescriptor = JSON.parse(JSON.stringify(descriptor));
  return rehydrateBinding(wired, ctx);
}

describe('serializeBinding / rehydrateBinding (§4.1)', () => {
  // ── Bucket 1 — pure data, serialise as-is ──
  describe('Bucket 1 — pure data', () => {
    it('the event marker round-trips', async () => {
      expect(await roundTrip({ kind: 'event' })).toEqual({ kind: 'event' });
    });

    it('value (scalar + provenance) round-trips', async () => {
      const binding: Binding = { kind: 'value', value: { n: 42, s: 'hi', arr: [1, 2] } };
      expect(await roundTrip(binding)).toEqual(binding);
    });

    it('a walk read for a field keeps that it is many values — a spread after a park reads them', async () => {
      const binding: Binding = { kind: 'value', value: 'only.pdf', many: true };
      expect(await roundTrip(binding)).toEqual(binding);
    });

    it('handle (a WriteRecord — already-happened write) round-trips', async () => {
      const handle: WriteRecord = {
        adapterType: 'attio',
        recordType: 'company',
        externalId: 'rec_123',
        created: true,
        committed: true,
        writtenValues: { name: 'Acme' },
        provenance: {},
        bindingName: 'co',
      };
      const binding: Binding = {
        kind: 'handle',
        handle,
        targetType: 'company',
        graph: { kind: 'instance', instance: { kind: 'instance', name: 'crm', adapterSlug: 'attio' } },
      };
      // The instance identity is re-resolved through the seam, which re-fetches
      // the schema live rather than carrying it over the wire — so the round
      // trip matches on identity, not on the whole binding.
      expect(await roundTrip(binding)).toMatchObject({
        kind: 'handle',
        handle,
        targetType: 'company',
        graph: { kind: 'instance', instance: { name: 'crm', adapterSlug: 'attio' } },
      });
    });

    it('extractRoot / extractPosition (materialised emission, never re-run) round-trip', async () => {
      const emission: ExtractEmission = {
        nodeName: 'extract result',
        fields: { amount: 1000 },
        provenance: {},
        // Layer-5 source resources ride the emission; the FILE resource's
        // `fileRef` closure is stripped on the wire and revived on rehydrate.
        resources: [
          {
            type: 'FILE',
            name: 'deck.pdf',
            fileRef: {
              __brand: 'FileRef',
              name: 'deck.pdf',
              retrieve: async () => {
                throw new Error('not called in this test');
              },
              source: { ownerAdapterType: 'dropbox', handle: 'h-deck' },
            },
            data: { name: 'deck.pdf', type: 'FILE' },
          },
        ],
        children: new Map([
          [
            'company',
            [
              {
                nodeName: 'company',
                fields: { name: 'Acme' },
                provenance: {},
                resources: [],
                children: new Map(),
              },
            ],
          ],
        ]),
      };
      const out = await roundTrip({ kind: 'extractRoot', emission });
      expect(out.kind).toBe('extractRoot');
      if (out.kind !== 'extractRoot') throw new Error('unreachable');
      // The Map children survive (flattened to a record on the wire, rebuilt).
      expect(out.emission.fields).toEqual({ amount: 1000 });
      const kids = out.emission.children.get('company');
      expect(kids?.[0].fields).toEqual({ name: 'Acme' });
      // The source FILE resource survives — its fileRef is revived to a live
      // closure through the seam (Bucket 2).
      expect(out.emission.resources[0].name).toBe('deck.pdf');
      expect(typeof out.emission.resources[0].fileRef?.retrieve).toBe('function');
    });

    it('sourcePosition data half (position + edgeProperties) round-trips', async () => {
      const position: SourcePosition = {
        adapterType: 'attio',
        recordType: 'company',
        identity: { kind: 'stable', recordId: 'rec_1' },
      };
      const binding: Binding = {
        kind: 'sourcePosition',
        position,
        edgeProperties: { role: 'lead' },
      };
      const out = await roundTrip(binding);
      expect(out).toEqual(binding);
    });

    it('shapePosition round-trips', async () => {
      const binding: Binding = {
        kind: 'shapePosition',
        shape: 'Files',
        node: 'file',
        fields: { name: 'deck.pdf' },
        fieldProvenance: {},
      };
      expect(await roundTrip(binding)).toEqual(binding);
    });
  });

  // ── Bucket 2 — live refs rebound on rehydrate ──
  describe('Bucket 2 — live refs', () => {
    it('instance re-resolves the live adapter + re-fetches schema (identity survives, schema is fresh)', async () => {
      const binding: Binding = {
        kind: 'instance',
        name: 'crm',
        adapterSlug: 'attio',
        credentialName: 'acme_main',
        constructionConfig: { base: 'b1' },
        schema: { types: { stale: true } } as never,
      };
      const ctx = makeCtx();
      const out = await roundTrip(binding, ctx);
      expect(out.kind).toBe('instance');
      if (out.kind !== 'instance') throw new Error('unreachable');
      // Identity survives the wire …
      expect(out.name).toBe('crm');
      expect(out.adapterSlug).toBe('attio');
      expect(out.credentialName).toBe('acme_main');
      expect(out.constructionConfig).toEqual({ base: 'b1' });
      // … the schema is the freshly re-fetched one, NOT the stale serialised value.
      expect(out.schema).toEqual({ types: {} });
    });

    it('sourcePosition.read rebinds the live adapter from the instance name', async () => {
      const position: SourcePosition = {
        adapterType: 'attio',
        recordType: 'company',
        identity: { kind: 'stable', recordId: 'rec_1' },
      };
      const liveRead: SourceRead = {
        adapter: fakeAdapter,
        instanceName: 'crm',
        edgeFieldId: () => 'field_x',
      };
      const ctx = makeCtx({ resolveSourceRead: async () => liveRead });
      const out = await roundTrip({ kind: 'sourcePosition', position, read: { adapter: fakeAdapter, instanceName: 'crm' } }, ctx);
      expect(out.kind).toBe('sourcePosition');
      if (out.kind !== 'sourcePosition') throw new Error('unreachable');
      // The read came back as a LIVE ref (with its closure), not the serialised stub.
      expect(out.read?.instanceName).toBe('crm');
      expect(out.read?.adapter).toBe(fakeAdapter);
      expect(typeof out.read?.edgeFieldId).toBe('function');
    });

    it("resource's FileRef has its retrieve() rebound (closure does not survive the wire)", async () => {
      let originalCalled = false;
      const fileRef: FileRef = {
        __brand: 'FileRef',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        size: 10,
        retrieve: async () => {
          originalCalled = true;
          return { stream: Readable.from(Buffer.from('orig')) };
        },
        source: { ownerAdapterType: 'document-store', handle: 'doc://abc' },
      };
      const resource: Resource = { type: 'FILE', name: 'deck.pdf', fileRef };
      const out = await roundTrip({ kind: 'resource', resource });
      expect(out.kind).toBe('resource');
      if (out.kind !== 'resource') throw new Error('unreachable');
      const revived = out.resource.fileRef;
      expect(revived?.name).toBe('deck.pdf');
      expect(revived?.source).toEqual({ ownerAdapterType: 'document-store', handle: 'doc://abc' });
      // It's a FRESH retrieve() (the reviver's), not the original closure.
      expect(typeof revived?.retrieve).toBe('function');
      await revived?.retrieve?.();
      expect(originalCalled).toBe(false);
    });
  });

  // ── Bucket 3 — code refs re-resolved from the re-parsed program ──
  describe('Bucket 3 — code refs', () => {
    it('a node declaration re-resolves by name from the AST (declaration not serialised)', async () => {
      const root = { name: 'Files', fields: [], children: [] };
      const declaration = { kind: 'shape', name: 'Files', root } as never;
      const descriptor = serializeBinding({ kind: 'shape', declaration });
      expect(descriptor).toEqual({ kind: 'shape', name: 'Files' });
      const ctx = makeCtx({
        resolveCodeRef: (name) => ({
          kind: 'shape',
          declaration: { kind: 'shape', name, root: { ...root, name } } as never,
        }),
      });
      const out = await rehydrateBinding(descriptor, ctx);
      expect(out.kind).toBe('shape');
      if (out.kind !== 'shape') throw new Error('unreachable');
      expect(out.declaration.name).toBe('Files');
    });

    it('movement re-resolves by name from the AST', async () => {
      const declaration = { kind: 'movement', name: 'enrich', params: [], body: [] } as never;
      const descriptor = serializeBinding({ kind: 'movement', declaration });
      expect(descriptor).toEqual({ kind: 'movement', name: 'enrich' });
    });

    it('opaque import carries its slot name for re-resolution', async () => {
      // The bare serialiser has no slot name; the scope walk patches it. Here we
      // assert the descriptor shape + that rehydrate routes through resolveCodeRef.
      const descriptor = serializeBinding({ kind: 'opaque', what: 'import' });
      expect(descriptor.kind).toBe('opaque');
      const ctx = makeCtx({ resolveCodeRef: (name) => ({ kind: 'opaque', what: `import:${name}` }) });
      const out = await rehydrateBinding({ kind: 'opaque', what: 'import', name: 'attio' }, ctx);
      expect(out).toEqual({ kind: 'opaque', what: 'import:attio' });
    });

    it('a synthesised node keeps its entries and its LANDED edges', async () => {
      const binding: Binding = {
        kind: 'nodePosition',
        fields: { title: 'Acme' },
        fieldOrder: ['title'],
        fieldProvenance: {},
        edges: {
          people: { kind: 'landed', landings: [{ kind: 'value', value: 'ada' }] },
        },
      };
      const out = await roundTrip(binding);
      expect(out).toEqual(binding);
    });

    it('a landing keeps the edge it landed on — what makes it a record to update after a resume', async () => {
      const landing: Binding = {
        kind: 'nodePosition',
        landedOn: 'entries',
        fields: { name: 'Acme' },
        fieldOrder: ['name'],
        fieldProvenance: {},
        edges: {},
      };
      const out = await roundTrip(landing);
      expect(out).toEqual(landing);
    });

    it("a landed edge keeps its landings' ORDER — what `order by arrival` promises", async () => {
      const binding: Binding = {
        kind: 'nodePosition',
        fields: {},
        fieldOrder: [],
        fieldProvenance: {},
        edges: {
          companies: {
            kind: 'landed',
            landings: [
              { kind: 'value', value: 'Acme' },
              { kind: 'value', value: 'Beta' },
              { kind: 'value', value: 'Gamma' },
            ],
          },
        },
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'nodePosition') throw new Error('unreachable');
      const edge = out.edges.companies;
      if (edge.kind !== 'landed') throw new Error('expected a landed edge');
      expect(edge.landings.map((l) => (l.kind === 'value' ? l.value : undefined))).toEqual([
        'Acme',
        'Beta',
        'Gamma',
      ]);
    });

    it("a node's field order survives the park's jsonb, which reorders keys", async () => {
      const descriptor = serializeBinding({
        kind: 'nodePosition',
        fields: { name: 'Acme', raised: 5 },
        fieldOrder: ['name', 'stage', 'raised'],
        fieldProvenance: {},
        edges: {},
      });
      if (descriptor.kind !== 'nodePosition') throw new Error('unreachable');
      // What jsonb hands back: the same keys, shortest first.
      const out = await rehydrateBinding(
        { ...descriptor, fields: { raised: 5, name: 'Acme' } },
        makeCtx(),
      );
      if (out.kind !== 'nodePosition') throw new Error('unreachable');
      expect(out.fieldOrder).toEqual(['name', 'stage', 'raised']);
      expect(Object.keys(out.fields)).toEqual(['name', 'raised']);
    });

    it('a park written before field order was kept still mints nested edges', async () => {
      const out = await rehydrateBinding(
        {
          kind: 'nodePosition',
          fields: {},
          fieldProvenance: {},
          edges: {
            entries: { kind: 'landed', landings: [], landingShape: { founder: { profile: {} } } },
          },
        },
        makeCtx(),
      );
      if (out.kind !== 'nodePosition') throw new Error('unreachable');
      expect(out.fieldOrder).toEqual([]);
      const edge = out.edges.entries;
      expect(edge?.kind === 'landed' && edge.landingShape).toEqual({
        fields: [],
        edges: { founder: { fields: [], edges: { profile: { fields: [], edges: {} } } } },
      });
    });

    describe('a run-built node keeps its identity across the park', () => {
      const node = (title: string): Extract<Binding, { kind: 'nodePosition' }> => ({
        kind: 'nodePosition',
        fields: { title },
        fieldOrder: ['title'],
        fieldProvenance: {},
        edges: { x: { kind: 'landed', landings: [] } },
      });
      const landingsOf = (binding: Binding | undefined, edge = 'x'): Binding[] => {
        if (binding?.kind !== 'nodePosition') throw new Error('expected a node');
        const found = binding.edges[edge];
        if (found?.kind !== 'landed') throw new Error('expected a landed edge');
        return found.landings;
      };

      it('a node reached twice is written once and comes back as one object', async () => {
        const shared = node('n');
        const binding: Binding = { kind: 'tuple', slots: [shared, shared] };
        const descriptor = serializeBinding(binding);
        if (descriptor.kind !== 'tuple') throw new Error('unreachable');
        expect(descriptor.slots[1]).toEqual({ kind: 'nodeRef', id: 0 });

        const out = await roundTrip(binding);
        if (out.kind !== 'tuple') throw new Error('unreachable');
        expect(out.slots[0]).toBe(out.slots[1]);
        expect(out.slots[0]).toEqual(shared);
      });

      it('a self-cycle and a two-node cycle serialise finitely and rehydrate as cycles', async () => {
        const self = node('self');
        landingsOf(self).push(self);
        const a = node('a');
        const b = node('b');
        landingsOf(a).push(b);
        landingsOf(b).push(a);

        const outSelf = await roundTrip(self);
        expect(landingsOf(outSelf)[0]).toBe(outSelf);

        const outA = await roundTrip(a);
        const outB = landingsOf(outA)[0];
        expect(landingsOf(outB)[0]).toBe(outA);
        expect(outB).not.toBe(outA);
      });

      it('scopes written by one park share one table: two names for one node stay one node', async () => {
        const shared = node('n');
        const root = new Environment();
        root.declare('n', shared);
        const child = root.child();
        child.declare('alias', shared);
        const chain = JSON.parse(JSON.stringify(serializeScopeChain(child.chainFromRoot())));
        expect(chain[1].bindings.alias).toEqual({ kind: 'nodeRef', id: 0 });

        const park = newParkReader();
        const ctx = makeCtx();
        const n = await rehydrateBinding(chain[0].bindings.n, ctx, park);
        const alias = await rehydrateBinding(chain[1].bindings.alias, ctx, park);
        assertParkRead(park);
        expect(alias).toBe(n);
      });

      it('a reference read before the node it names (jsonb reorders keys) still resolves to it', async () => {
        const writer = newParkWriter();
        const shared = node('n');
        const first = serializeBinding(shared, writer);
        const second = serializeBinding(shared, writer);
        expect(second).toEqual({ kind: 'nodeRef', id: 0 });

        const park = newParkReader();
        const ctx = makeCtx();
        const ref = await rehydrateBinding(second, ctx, park);
        const def = await rehydrateBinding(first, ctx, park);
        assertParkRead(park);
        expect(ref).toBe(def);
        expect(ref).toEqual(shared);
      });

      it('a reference to a node the state never wrote is refused, not resumed as an empty node', async () => {
        await expect(rehydrateBinding({ kind: 'nodeRef', id: 7 }, makeCtx())).rejects.toThrow(/never wrote/);
      });

      it('a park written before nodes kept their identity still resumes, each sighting its own node', async () => {
        // The old shape: no `id`, the same node written out in full twice.
        const old: BindingDescriptor = {
          kind: 'tuple',
          slots: [0, 1].map(() => ({
            kind: 'nodePosition',
            fields: { title: 'n' },
            fieldOrder: ['title'],
            fieldProvenance: {},
            edges: {
              x: {
                kind: 'landed',
                landings: [{ kind: 'nodePosition', fields: { title: 'child' }, fieldProvenance: {}, edges: {} }],
              },
            },
          })),
        };
        const out = await rehydrateBinding(JSON.parse(JSON.stringify(old)), makeCtx());
        if (out.kind !== 'tuple') throw new Error('unreachable');
        expect(out.slots[0]).toEqual(out.slots[1]);
        expect(out.slots[0]).not.toBe(out.slots[1]);
        expect(landingsOf(out.slots[0])[0]).toEqual({
          kind: 'nodePosition',
          fields: { title: 'child' },
          fieldOrder: ['title'],
          fieldProvenance: {},
          edges: {},
        });
      });
    });

    it('a DEFERRED edge serialises the WALK, never landings', async () => {
      const walk: DeferredWalk = {
        head: { root: { kind: 'name', name: 'msg' }, hopsRaw: '-[a:files]->', span: SPAN },
        captured: new Map<string, Binding>([['msg', { kind: 'event' }]]),
      };
      const binding: Binding = {
        kind: 'nodePosition',
        fields: {},
        fieldOrder: [],
        fieldProvenance: {},
        edges: { files: { kind: 'deferred', walk } },
      };
      const descriptor = serializeBinding(binding);
      if (descriptor.kind !== 'nodePosition') throw new Error('unreachable');
      const edge = descriptor.edges.files;
      if (edge.kind !== 'deferred') throw new Error('expected a deferred edge');
      // The walk, and nothing it walked to: after a resume the source is read
      // again, which is the point of `lazy` (layer 8 ruling 3).
      expect(edge.walk.head.hopsRaw).toBe('-[a:files]->');
      expect(edge.walk.captured).toEqual({ msg: { kind: 'event' } });
      expect(JSON.stringify(descriptor)).not.toContain('landings');

      const out = await roundTrip(binding);
      if (out.kind !== 'nodePosition') throw new Error('unreachable');
      const back = out.edges.files;
      if (back.kind !== 'deferred') throw new Error('expected a deferred edge');
      expect(back.walk.head).toEqual(walk.head);
      expect(back.walk.captured.get('msg')).toEqual({ kind: 'event' });
    });

    it('a lazy binding round-trips as its walk plus the scope it captured', async () => {
      const binding: Binding = {
        kind: 'lazyWalk',
        walk: {
          head: { root: { kind: 'name', name: 'crm' }, hopsRaw: '-[c:Companies WHERE c.`Name` == "x"]->', span: SPAN },
          captured: new Map<string, Binding>([
            ['crm', { kind: 'instance', name: 'crm', adapterSlug: 'attio' }],
            ['target', { kind: 'value', value: 'x' }],
          ]),
        },
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'lazyWalk') throw new Error('unreachable');
      expect(out.walk.head.hopsRaw).toBe('-[c:Companies WHERE c.`Name` == "x"]->');
      expect(out.walk.captured.get('target')).toEqual({ kind: 'value', value: 'x' });
      // The instance came back through the registry, schema re-fetched.
      expect(out.walk.captured.get('crm')?.kind).toBe('instance');
    });

    it('a MAPPED walk carries its tail literal across — the recipe, not the result', async () => {
      // Per-item synthesis parks as AST: the walk plus the mapping that renames
      // each landing. A resume re-walks AND re-maps, so nothing synthesised
      // needs preserving (and none of it is here).
      const mapping = {
        entries: [
          {
            kind: 'value' as const,
            name: 'blob',
            value: { raw: 'a.`File`', span: SPAN },
            span: SPAN,
          },
        ],
        span: SPAN,
      };
      const binding: Binding = {
        kind: 'lazyWalk',
        walk: {
          head: { root: { kind: 'name', name: 'msg' }, hopsRaw: '-[a:files]->', span: SPAN },
          captured: new Map<string, Binding>([['msg', { kind: 'event' }]]),
          mapping,
        },
      };
      const descriptor = serializeBinding(binding);
      if (descriptor.kind !== 'lazyWalk') throw new Error('unreachable');
      expect(descriptor.walk.mapping).toEqual(mapping);
      expect(() => JSON.stringify(descriptor)).not.toThrow();

      const out = await roundTrip(binding);
      if (out.kind !== 'lazyWalk') throw new Error('unreachable');
      expect(out.walk.mapping).toEqual(mapping);
    });

    it('an EXPRESSION-rooted walk parks as its recipe — the expression, and what it reads', async () => {
      // A parked lazy walk stores the WALK, never its answer, and a head rooted
      // at an expression is no different: the expression rides across as the
      // slot the parser captured, and the names it reads ride in the capture.
      // The run that resumes evaluates it again, against the scope it kept.
      const binding: Binding = {
        kind: 'lazyWalk',
        walk: {
          head: {
            root: { kind: 'expression', expr: { raw: 'AT(rows, 0)', span: SPAN } },
            hopsRaw: '-[a:files]->',
            span: SPAN,
          },
          captured: new Map<string, Binding>([['rows', { kind: 'value', value: [] }]]),
        },
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'lazyWalk') throw new Error('unreachable');
      expect(out.walk.head.root).toEqual({
        kind: 'expression',
        expr: { raw: 'AT(rows, 0)', span: SPAN },
      });
      expect([...out.walk.captured.keys()]).toEqual(['rows']);
    });

    it('an UNMAPPED walk carries no mapping key at all', async () => {
      const binding: Binding = {
        kind: 'lazyWalk',
        walk: {
          head: { root: { kind: 'name', name: 'msg' }, hopsRaw: '-[a:files]->', span: SPAN },
          captured: new Map<string, Binding>([['msg', { kind: 'event' }]]),
        },
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'lazyWalk') throw new Error('unreachable');
      expect(out.walk.mapping).toBeUndefined();
    });

    it('blockMeta is recursive — its contained bindings serialise per the rules', async () => {
      const inner: Binding = { kind: 'value', value: 7 };
      const binding: Binding = {
        kind: 'blockMeta',
        edges: new Map([['rows', [inner, { kind: 'event' }]]]),
      };
      const out = await roundTrip(binding);
      expect(out.kind).toBe('blockMeta');
      if (out.kind !== 'blockMeta') throw new Error('unreachable');
      const rows = out.edges.get('rows');
      expect(rows?.[0]).toEqual({ kind: 'value', value: 7 });
      expect(rows?.[1]).toEqual({ kind: 'event' });
    });

    it("a block's returned records are recursive too", async () => {
      const binding: Binding = {
        kind: 'positions',
        landings: [{ kind: 'value', value: 'a' }, { kind: 'event' }],
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'positions') throw new Error('unreachable');
      expect(out.landings).toEqual([{ kind: 'value', value: 'a' }, { kind: 'event' }]);
    });

    it('a CLOSURE parks as its body plus its capture, and comes back whole', async () => {
      const closure = {
        params: [{ name: 'n', type: { graph: 'number', span: SPAN }, span: SPAN }],
        body: [
          {
            kind: 'return' as const,
            value: { kind: 'expr' as const, expr: { raw: 'n', span: SPAN } },
            span: SPAN,
          },
        ],
        span: SPAN,
      };
      const binding: Binding = {
        kind: 'closure',
        closure,
        captured: new Map<string, Binding>([
          ['msg', { kind: 'event' }],
          ['t', { kind: 'value', value: 'hello' }],
        ]),
      };
      const out = await roundTrip(binding);
      if (out.kind !== 'closure') throw new Error('unreachable');
      // The BODY rides across as itself — a closure has no name to re-resolve by.
      expect(out.closure).toEqual(closure);
      expect(out.captured.get('msg')).toEqual({ kind: 'event' });
      expect(out.captured.get('t')).toEqual({ kind: 'value', value: 'hello' });
    });
  });

  // ── The JSON-serialisability guard (the value boundary) ──
  describe('JSON guard', () => {
    it('rejects a non-serialisable value LOUDLY at park (a closure)', () => {
      const binding: Binding = { kind: 'value', value: () => 42 };
      expect(() => serializeBinding(binding)).toThrow(MovementEngineError);
      expect(() => serializeBinding(binding)).toThrow(/not JSON-serialisable/);
    });

    it('rejects a circular value LOUDLY', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => assertJsonSerializable(circular, 'test')).toThrow(MovementEngineError);
    });

    it('passes a plain serialisable value through (round-tripped)', () => {
      expect(assertJsonSerializable({ a: 1, b: [2, 3] }, 'test')).toEqual({ a: 1, b: [2, 3] });
    });
  });

  // ── Scope chain serialisation (§4.6) ──
  describe('serializeScopeChain (§4.6)', () => {
    it('captures each env OWN bindings root-first; opaque imports keyed by slot name', () => {
      const root = new Environment();
      root.declare('graph', { kind: 'instance', name: 'graph', adapterSlug: 'kg' });
      root.declare('crm', { kind: 'instance', name: 'crm', adapterSlug: 'attio' });
      root.declare('mailer', { kind: 'opaque', what: 'import' });
      const child = root.child();
      child.declare('msg', { kind: 'value', value: 'hello' });

      const chain = serializeScopeChain(child.chainFromRoot());
      expect(chain).toHaveLength(2);
      // Root scope.
      expect(chain[0].bindings.graph).toMatchObject({
        kind: 'instance',
        instance: { name: 'graph', adapterSlug: 'kg' },
      });
      expect(chain[0].bindings.crm).toMatchObject({ kind: 'instance', instance: { name: 'crm', adapterSlug: 'attio' } });
      // The opaque import's re-resolution name is its slot key.
      expect(chain[0].bindings.mailer).toEqual({ kind: 'opaque', what: 'import', name: 'mailer' });
      // Child scope.
      expect(chain[1].bindings.msg).toEqual({ kind: 'value', value: 'hello' });
    });
  });
});

// ── Bucket 3 — a VALUE that holds records ──
//
// A record is a value, so a value can hold one: a `MAP` whose function returned
// the member, a list literal of records, a `GROUPBY` dict. Those records do NOT
// survive `JSON.stringify` — an extraction result's children are a `Map`, a file
// ref is a closure — so the value travels record by record, each through its own
// descriptor, and a resumed run holds positions again.
describe('a value that holds records', () => {
  function emissionNamed(name: string): ExtractEmission {
    return {
      nodeName: 'extract result',
      fields: { headline: name },
      provenance: {},
      resources: [],
      children: new Map([
        [
          'company',
          [{ nodeName: 'company', fields: { name }, provenance: {}, resources: [], children: new Map() }],
        ],
      ]),
    };
  }

  it("a MAP's answer of extract roots comes back as extract roots, children and all", async () => {
    const binding: Binding = {
      kind: 'value',
      value: [
        { kind: 'extractRoot', emission: emissionNamed('Acme') },
        { kind: 'extractRoot', emission: emissionNamed('Globex') },
      ],
    };
    const out = await roundTrip(binding);
    if (out.kind !== 'value' || !Array.isArray(out.value)) throw new Error('unreachable');
    expect(out.value).toHaveLength(2);
    for (const [index, name] of ['Acme', 'Globex'].entries()) {
      const member = out.value[index] as Binding;
      expect(member.kind).toBe('extractRoot');
      if (member.kind !== 'extractRoot') throw new Error('unreachable');
      // The `Map` children are the proof: a blind JSON round-trip leaves `{}`,
      // and a block walking the resumed value would find nothing there.
      expect(member.emission.children.get('company')?.[0].fields).toEqual({ name });
    }
  });

  it("a GROUPBY's dict of records keeps each group's records", async () => {
    const binding: Binding = {
      kind: 'value',
      value: { Infra: [{ kind: 'extractRoot', emission: emissionNamed('Acme') }] },
    };
    const out = await roundTrip(binding);
    if (out.kind !== 'value') throw new Error('unreachable');
    const group = (out.value as Record<string, unknown[]>).Infra[0] as Binding;
    expect(group.kind).toBe('extractRoot');
    if (group.kind !== 'extractRoot') throw new Error('unreachable');
    expect(group.emission.children.get('company')?.[0].fields).toEqual({ name: 'Acme' });
  });

  it('a value holding no records travels as it always did — data, with the JSON guard', async () => {
    const binding: Binding = { kind: 'value', value: { rows: [1, 2], name: 'hi' } };
    expect(serializeBinding(binding).kind).toBe('value');
    expect(await roundTrip(binding)).toEqual(binding);
  });
});

describe('a value that holds files', () => {
  const attachment = (): FileRef => ({
    __brand: 'FileRef',
    name: 'memo.pdf',
    contentType: 'application/pdf',
    retrieve: async () => ({ stream: Readable.from(Buffer.from('original')) }),
    source: { ownerAdapterType: 'email', handle: 'att-key-1' },
  });

  async function bytesOf(ref: unknown): Promise<string> {
    if (typeof ref !== 'object' || ref === null || !('retrieve' in ref) || typeof ref.retrieve !== 'function') {
      throw new Error('test: not a readable file');
    }
    const { stream } = await (ref as Required<Pick<FileRef, 'retrieve'>>).retrieve();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks).toString('utf8');
  }

  it('parks each file in its wire form — handle, no channel — and gives the channel back on resume', async () => {
    const binding: Binding = { kind: 'value', value: ['the body', attachment()] };
    const descriptor = serializeBinding(binding);
    expect(descriptor).toEqual({
      kind: 'value',
      value: [
        'the body',
        {
          __brand: 'FileRef',
          name: 'memo.pdf',
          contentType: 'application/pdf',
          source: { ownerAdapterType: 'email', handle: 'att-key-1' },
        },
      ],
    });
    const wired = JSON.parse(JSON.stringify(descriptor)) as BindingDescriptor;
    const out = await rehydrateBinding(wired, makeCtx());
    if (out.kind !== 'value' || !Array.isArray(out.value)) throw new Error('unreachable');
    expect(out.value[0]).toBe('the body');
    expect(await bytesOf(out.value[1])).toBe('revived');
  });

  it('a file beside records, and a file in a synthesised record, both come back readable', async () => {
    const binding: Binding = {
      kind: 'value',
      value: [
        { kind: 'extractRoot', emission: { nodeName: 'x', fields: {}, provenance: {}, resources: [], children: new Map() } },
        attachment(),
      ],
    };
    expect(serializeBinding(binding).kind).toBe('recordValue');
    const out = await roundTrip(binding);
    if (out.kind !== 'value' || !Array.isArray(out.value)) throw new Error('unreachable');
    expect(await bytesOf(out.value[1])).toBe('revived');

    const node: Binding = {
      kind: 'nodePosition',
      fields: { name: 'Acme', deck: attachment() },
      fieldOrder: ['name', 'deck'],
      fieldProvenance: {},
      edges: {},
    };
    const back = await roundTrip(node);
    if (back.kind !== 'nodePosition') throw new Error('unreachable');
    expect(await bytesOf(back.fields.deck)).toBe('revived');
  });

  it('any other closure inside a value is refused at park, not dropped in silence', () => {
    const binding: Binding = { kind: 'value', value: { name: 'x', compute: () => 1 } };
    expect(() => serializeBinding(binding)).toThrow(/'compute' is a function/);
  });
});
