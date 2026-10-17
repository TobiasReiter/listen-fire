// Type-level + zod-parse tests for the F2 TG-parity extensions:
//
//   - schemaRefSchema: `generic` + `generic_reference` arms (with tg_id req)
//   - expressionTypeSchema: discriminated union, including `file` primitive
//   - genericShapeSchema: properties + edges parse roundtrip
//   - transformSignatureSchema: both dataDependency timings parse
//   - adapterTypeForRef helper: kg / adapter / generic / generic_reference
//   - Position: ephemeral and persistent positions share one struct and
//     surface their payload identically (same value-bearing fields)
//
// Brief: plans/2026-05-19-tg-extraction-parity/_execution/wave-0/F2-types.md

import {
  adapterTypeForRef,
  expressionTypeSchema,
  genericShapeSchema,
  schemaRefSchema,
  transformSignatureSchema,
  makeEphemeralPosition,
  makeStablePosition,
  positionData,
  referenceTargetTypeIds,
  schemaReferenceDescriptorSchema,
  schemaTypeDescriptorSchema,
  type EphemeralNode,
  type ExpressionType,
  type GenericShape,
  type Position,
  type SchemaRef,
  type TransformSignature,
} from '../types';

describe('schemaRefSchema', () => {
  it('accepts the legacy knowledge-graph kind', () => {
    const parsed = schemaRefSchema.parse({ kind: 'knowledge-graph' });
    expect(parsed.kind).toBe('knowledge-graph');
  });

  it('accepts the legacy adapter kind', () => {
    const parsed = schemaRefSchema.parse({ kind: 'adapter', adapterType: 'slack' });
    expect(parsed.kind).toBe('adapter');
    if (parsed.kind === 'adapter') expect(parsed.adapterType).toBe('slack');
  });

  it('accepts generic kind with inline shape (property types + edges)', () => {
    const ref = {
      kind: 'generic',
      shape: {
        properties: {
          sent_at: { kind: 'timestamp' },
          sender_name: { kind: 'string' },
          content: { kind: 'string' },
        },
        edges: {
          files: {
            target: {
              kind: 'list',
              element: {
                kind: 'record',
                fields: {
                  name: { kind: 'string' },
                  contentType: { kind: 'string' },
                  data: { kind: 'file' },
                },
              },
            },
          },
        },
      },
    };
    const parsed = schemaRefSchema.parse(ref);
    expect(parsed.kind).toBe('generic');
    if (parsed.kind === 'generic') {
      expect(parsed.shape.properties.sent_at.kind).toBe('timestamp');
      expect(parsed.shape.edges.files.target.kind).toBe('list');
    }
  });

  it('accepts generic_reference with a tg_id', () => {
    const parsed = schemaRefSchema.parse({
      kind: 'generic_reference',
      tg_id: '00000000-0000-0000-0000-000000000001',
    });
    expect(parsed.kind).toBe('generic_reference');
    if (parsed.kind === 'generic_reference') {
      // tg_id carries the brand statically — runtime value is a plain string.
      expect(typeof parsed.tg_id).toBe('string');
    }
  });

  it('rejects generic_reference without tg_id', () => {
    const res = schemaRefSchema.safeParse({ kind: 'generic_reference' });
    expect(res.success).toBe(false);
  });

  it('rejects generic_reference with empty tg_id', () => {
    const res = schemaRefSchema.safeParse({ kind: 'generic_reference', tg_id: '' });
    expect(res.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const res = schemaRefSchema.safeParse({ kind: 'mystery' });
    expect(res.success).toBe(false);
  });
});

describe('expressionTypeSchema', () => {
  it('accepts each scalar primitive (incl. file)', () => {
    const kinds: ExpressionType['kind'][] = [
      'string',
      'number',
      'boolean',
      'date',
      'timestamp',
      'json',
      'file',
    ];
    for (const kind of kinds) {
      const parsed = expressionTypeSchema.parse({ kind });
      expect(parsed.kind).toBe(kind);
    }
  });

  it('accepts an enum with values', () => {
    const parsed = expressionTypeSchema.parse({
      kind: 'enum',
      values: ['draft', 'review', 'published'],
    });
    expect(parsed.kind).toBe('enum');
    if (parsed.kind === 'enum') expect(parsed.values).toEqual(['draft', 'review', 'published']);
  });

  it('accepts list of file (round-trips through parse)', () => {
    const t: ExpressionType = { kind: 'list', element: { kind: 'file' } };
    const parsed = expressionTypeSchema.parse(t);
    expect(parsed).toEqual(t);
  });

  it('accepts nested record with file field', () => {
    const t: ExpressionType = {
      kind: 'record',
      fields: {
        name: { kind: 'string' },
        contentType: { kind: 'string' },
        data: { kind: 'file' },
      },
    };
    const parsed = expressionTypeSchema.parse(t);
    expect(parsed).toEqual(t);
  });
});

describe('genericShapeSchema', () => {
  it('round-trips a representative shape', () => {
    const shape: GenericShape = {
      properties: {
        content: { kind: 'string' },
        sent_at: { kind: 'timestamp' },
      },
      edges: {
        files: {
          target: {
            kind: 'list',
            element: {
              kind: 'record',
              fields: {
                name: { kind: 'string' },
                data: { kind: 'file' },
              },
            },
          },
        },
      },
    };
    const parsed = genericShapeSchema.parse(shape);
    expect(parsed).toEqual(shape);
  });
});

describe('transformSignatureSchema', () => {
  it("parses a signature with dataDependency: 'none'", () => {
    const sig: TransformSignature = {
      name: 'url-retrieval',
      description: 'Fetch the content of URLs found in the source node.',
      params: [],
      dataDependency: 'none',
      additions: {
        edges: {
          vcUrl: {
            target: {
              kind: 'list',
              element: {
                kind: 'record',
                fields: {
                  url: { kind: 'string' },
                  text: { kind: 'string' },
                },
              },
            },
          },
        },
      },
    };
    const parsed = transformSignatureSchema.parse(sig);
    expect(parsed.dataDependency).toBe('none');
  });

  it("parses a signature with dataDependency: 'extracted_context' and typed params", () => {
    const sig: TransformSignature = {
      name: 'linkedin-enrichment',
      params: [
        {
          name: 'region',
          type: { kind: 'enum', values: ['EMEA', 'AMER', 'APAC'] },
          required: false,
          description: 'Limit search to this region.',
        },
      ],
      dataDependency: 'extracted_context',
      additions: {
        properties: {
          linkedin_url: { kind: 'string' },
        },
      },
    };
    const parsed = transformSignatureSchema.parse(sig);
    expect(parsed.dataDependency).toBe('extracted_context');
    expect(parsed.params[0]?.type.kind).toBe('enum');
  });

  it('rejects a signature with empty name', () => {
    const res = transformSignatureSchema.safeParse({
      name: '',
      params: [],
      dataDependency: 'none',
      additions: {},
    });
    expect(res.success).toBe(false);
  });

  it('rejects an unknown dataDependency value', () => {
    const res = transformSignatureSchema.safeParse({
      name: 't',
      params: [],
      dataDependency: 'eventually',
      additions: {},
    });
    expect(res.success).toBe(false);
  });
});

describe('adapterTypeForRef', () => {
  it('returns the KG adapter type for kg refs', () => {
    expect(adapterTypeForRef({ kind: 'knowledge-graph' })).toBe('kg');
  });

  it('returns the declared adapter type for adapter refs', () => {
    expect(adapterTypeForRef({ kind: 'adapter', adapterType: 'attio' })).toBe('attio');
  });

  it('returns null for generic refs (no concrete adapter)', () => {
    expect(
      adapterTypeForRef({
        kind: 'generic',
        shape: { properties: {}, edges: {} },
      }),
    ).toBeNull();
  });

  it('returns null for generic_reference refs (resolution lives in R6)', () => {
    expect(
      adapterTypeForRef({
        kind: 'generic_reference',
        tg_id: '00000000-0000-0000-0000-000000000002' as never,
      }),
    ).toBeNull();
  });
});

describe('Position — ephemeral vs persistent', () => {
  it('an ephemeral position carries data the same way a persistent one does', () => {
    // The brief: "EphemeralNode should be indistinguishable from persistent
    // nodes at the expression-evaluation level. Same shape: identity,
    // properties, outgoing edges. Field expressions read them the same way."
    //
    // After the Position struct collapse, both are the same `Position`
    // struct — there is no `kind` discriminator. An ephemeral position is
    // simply a `Position` whose `originRef` is set; the value-bearing
    // payload lives at `identity.data` for both, read via `positionData`.
    const ephemeral: EphemeralNode = makeEphemeralPosition({
      data: { company: 'Acme', amount_usd: 1_000_000 },
      originRef: { kind: 'extract', extractStepId: 'extract-1', nodeId: 'ephem-1' },
    });
    const persistent: Position = makeStablePosition({
      adapterType: 'slack',
      recordType: 'message',
      recordId: 'msg-1',
      data: { text: 'hello' },
    });
    // Both surface their payload for the evaluator via the same reader.
    expect(positionData(ephemeral)).toEqual({ company: 'Acme', amount_usd: 1_000_000 });
    expect(positionData(persistent)).toEqual({ text: 'hello' });
  });

  it('records the originating step (extract or transform) on originRef, with the synthetic nodeId', () => {
    const fromExtract: EphemeralNode = makeEphemeralPosition({
      data: {},
      originRef: { kind: 'extract', extractStepId: 'step-a', nodeId: 'e1' },
    });
    const fromTransform: EphemeralNode = makeEphemeralPosition({
      data: {},
      originRef: { kind: 'transform', transformName: 'url-retrieval', emissionIndex: 0, nodeId: 'e2' },
    });
    expect(fromExtract.originRef.kind).toBe('extract');
    expect(fromExtract.originRef.nodeId).toBe('e1');
    expect(fromTransform.originRef.kind).toBe('transform');
    expect(fromTransform.originRef.nodeId).toBe('e2');
  });
});

// Compile-time-only assertion: `SchemaRef` covers all its kinds and a
// switch can be exhaustive over them (N3-P adds `dynamic` + `static`; the
// orchestration "Add action" flow adds `unset`).
function _exhaustiveSchemaRef(ref: SchemaRef): string {
  switch (ref.kind) {
    case 'knowledge-graph':
      return 'kg';
    case 'adapter':
      return ref.adapterType;
    case 'generic':
      return 'generic';
    case 'generic_reference':
      return ref.tg_id;
    case 'dynamic':
      return ref.adapterKind;
    case 'static':
      return ref.schemaTypeId;
    case 'unset':
      return 'unset';
  }
}

// Sanity-call to keep the function "used" so tsc doesn't complain.
test('schemaRef exhaustive switch compiles', () => {
  expect(_exhaustiveSchemaRef({ kind: 'knowledge-graph' })).toBe('kg');
});

// ── N3 tightened source/target schemaRef tests ─────────────────────────────
// Per plans/2026-05-28-trigger-orchestration/_chunks/S-schema.md:
//   "Tightened sourceSchemaRef/targetSchemaRef zod rejects shapes outside
//    the new union (test added)".
//
// The new unions are intentionally narrower than the legacy
// `schemaRefSchema`:
//   - Source: dynamic | static  (no knowledge-graph, no adapter, no generic)
//   - Target: static | knowledge-graph | adapter  (no generic*)

import {
  sourceSchemaRefSchema,
  targetSchemaRefSchema,
  type SourceSchemaRef,
  type TargetSchemaRef,
} from '../types';

describe('sourceSchemaRefSchema (N3)', () => {
  it('accepts dynamic with a null credentialsId', () => {
    const parsed = sourceSchemaRefSchema.parse({
      kind: 'dynamic',
      adapterKind: 'CUSTOM_EMAIL',
      credentialsId: null,
    });
    expect(parsed.kind).toBe('dynamic');
  });

  it('accepts dynamic with a uuid credentialsId', () => {
    const parsed = sourceSchemaRefSchema.parse({
      kind: 'dynamic',
      adapterKind: 'ATTIO',
      credentialsId: '11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.kind).toBe('dynamic');
  });

  it('accepts static with a schemaTypeId', () => {
    const parsed = sourceSchemaRefSchema.parse({
      kind: 'static',
      schemaTypeId: '22222222-2222-2222-2222-222222222222',
    });
    expect(parsed.kind).toBe('static');
  });

  it('rejects legacy knowledge-graph kind (out of new union)', () => {
    const res = sourceSchemaRefSchema.safeParse({ kind: 'knowledge-graph' });
    expect(res.success).toBe(false);
  });

  it('rejects legacy adapter kind (the new spelling is `dynamic`)', () => {
    const res = sourceSchemaRefSchema.safeParse({ kind: 'adapter', adapterType: 'slack' });
    expect(res.success).toBe(false);
  });

  it('rejects dynamic without credentialsId field (must be present, possibly null)', () => {
    const res = sourceSchemaRefSchema.safeParse({ kind: 'dynamic', adapterKind: 'ATTIO' });
    expect(res.success).toBe(false);
  });

  it('rejects extra keys on dynamic (strict)', () => {
    const res = sourceSchemaRefSchema.safeParse({
      kind: 'dynamic',
      adapterKind: 'ATTIO',
      credentialsId: null,
      extra: 'nope',
    });
    expect(res.success).toBe(false);
  });
});

describe('targetSchemaRefSchema (N3)', () => {
  it('accepts static', () => {
    const parsed = targetSchemaRefSchema.parse({
      kind: 'static',
      schemaTypeId: '33333333-3333-3333-3333-333333333333',
    });
    expect(parsed.kind).toBe('static');
  });

  it('accepts knowledge-graph (no extra fields)', () => {
    const parsed = targetSchemaRefSchema.parse({ kind: 'knowledge-graph' });
    expect(parsed.kind).toBe('knowledge-graph');
  });

  it('accepts adapter with adapterKind + credentialsId', () => {
    const parsed = targetSchemaRefSchema.parse({
      kind: 'adapter',
      adapterKind: 'ATTIO',
      credentialsId: '44444444-4444-4444-4444-444444444444',
    });
    expect(parsed.kind).toBe('adapter');
  });

  it('rejects dynamic kind (sources only)', () => {
    const res = targetSchemaRefSchema.safeParse({
      kind: 'dynamic',
      adapterKind: 'ATTIO',
      credentialsId: null,
    });
    expect(res.success).toBe(false);
  });

  it('rejects adapter without credentialsId (terminals must carry credentials)', () => {
    const res = targetSchemaRefSchema.safeParse({
      kind: 'adapter',
      adapterKind: 'ATTIO',
    });
    expect(res.success).toBe(false);
  });

  it('rejects legacy adapterType key (renamed to adapterKind)', () => {
    const res = targetSchemaRefSchema.safeParse({
      kind: 'adapter',
      adapterType: 'slack',
      credentialsId: 'cred-1',
    });
    expect(res.success).toBe(false);
  });

  it('rejects knowledge-graph with extra keys (strict)', () => {
    const res = targetSchemaRefSchema.safeParse({ kind: 'knowledge-graph', extra: 1 });
    expect(res.success).toBe(false);
  });
});

// Compile-time exhaustiveness over the tightened unions.
function _exhaustiveSourceSchemaRef(ref: SourceSchemaRef): string {
  switch (ref.kind) {
    case 'dynamic':
      return ref.adapterKind;
    case 'static':
      return ref.schemaTypeId;
  }
}
function _exhaustiveTargetSchemaRef(ref: TargetSchemaRef): string {
  switch (ref.kind) {
    case 'static':
      return ref.schemaTypeId;
    case 'knowledge-graph':
      return 'kg';
    case 'adapter':
      return ref.adapterKind;
  }
}

test('tightened schemaRef exhaustive switches compile', () => {
  expect(
    _exhaustiveSourceSchemaRef({
      kind: 'static',
      schemaTypeId: '55555555-5555-5555-5555-555555555555' as never,
    }),
  ).toBe('55555555-5555-5555-5555-555555555555');
  expect(_exhaustiveTargetSchemaRef({ kind: 'knowledge-graph' })).toBe('kg');
});

// ── Multi-target references (polymorphic adapter edges) ─────────────────────
//
// `targetTypeIds` is the ADDITIVE multi-target declaration: absent means the
// reference lands on exactly one type and `targetTypeId` is the whole fact.
// Present, it is the FULL landing set — and it must contain `targetTypeId`, so
// a consumer that only reads the single field still names a real member rather
// than a type this edge cannot reach.
describe('schemaReferenceDescriptorSchema — target sets', () => {
  const base = { fieldId: 'gps', targetTypeId: 'People', cardinality: 'many' as const };

  it('a single-target reference parses unchanged and declares no target set', () => {
    const parsed = schemaReferenceDescriptorSchema.parse(base);
    expect(parsed.targetTypeIds).toBeUndefined();
    expect(referenceTargetTypeIds(parsed)).toEqual(['People']);
  });

  it('a multi-target reference parses and yields its whole landing set', () => {
    const parsed = schemaReferenceDescriptorSchema.parse({
      ...base,
      targetTypeIds: ['People', 'Companies'],
    });
    expect(referenceTargetTypeIds(parsed)).toEqual(['People', 'Companies']);
  });

  it('rejects a target set that omits targetTypeId — the single field must stay honest', () => {
    const res = schemaReferenceDescriptorSchema.safeParse({
      ...base,
      targetTypeIds: ['Companies', 'Deals'],
    });
    expect(res.success).toBe(false);
  });

  it('rejects a one-member target set — presence IS the polymorphism fact', () => {
    const res = schemaReferenceDescriptorSchema.safeParse({ ...base, targetTypeIds: ['People'] });
    expect(res.success).toBe(false);
  });

  it('de-duplicates repeated members', () => {
    const parsed = schemaReferenceDescriptorSchema.parse({
      ...base,
      targetTypeIds: ['People', 'Companies', 'People'],
    });
    expect(referenceTargetTypeIds(parsed)).toEqual(['People', 'Companies']);
  });
});

// ── Untagged write unions (writeUnion) ──────────────────────────────────────
//
// A type whose writable surface is a union of write SHAPES with no
// discriminant. The schema enforces what the checker can then trust: at least
// two variants, only writable fields of this type, and every writable field
// claimed by some variant (a variant list must not silently orphan a field).
// Field IDS, deliberately unlike the display names, so nothing can pass by
// treating the two as one.

describe('schemaTypeDescriptorSchema — writeUnion', () => {
  const writableField = (fieldId: string, displayName: string) => ({
    fieldId,
    displayName,
    kind: 'string' as const,
    writable: true,
    required: false,
  });

  /** A send-side message type: `Message` rides both shapes, `File`/`Blocks` don't. */
  const messageType = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    typeId: 'chat:message',
    displayName: 'Chat Message',
    fields: [
      writableField('text', 'Message'),
      writableField('file_ref', 'File'),
      writableField('blocks_json', 'Blocks'),
    ],
    references: [],
    writeUnion: {
      variants: [
        { name: 'a file post', fields: ['text', 'file_ref'] },
        { name: 'an interactive post', fields: ['text', 'blocks_json'] },
      ],
    },
    ...overrides,
  });

  it('a well-formed union parses, keeping variant order and field ids', () => {
    const parsed = schemaTypeDescriptorSchema.parse(messageType());
    expect(parsed.writeUnion?.variants.map((v) => v.name)).toEqual([
      'a file post',
      'an interactive post',
    ]);
    expect(parsed.writeUnion?.variants[1].fields).toEqual(['text', 'blocks_json']);
  });

  it('a type declaring no union parses unchanged', () => {
    const parsed = schemaTypeDescriptorSchema.parse(messageType({ writeUnion: undefined }));
    expect(parsed.writeUnion).toBeUndefined();
  });

  it('rejects a writable field that appears in NO variant — a silent orphan', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        writeUnion: {
          variants: [
            { name: 'a file post', fields: ['text', 'file_ref'] },
            { name: 'a plain post', fields: ['text'] },
          ],
        },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message).join('\n')).toContain(
      "writable field 'blocks_json' appears in no write variant",
    );
  });

  it('rejects a single variant — one shape is not a union', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        fields: [writableField('text', 'Message')],
        writeUnion: { variants: [{ name: 'a plain post', fields: ['text'] }] },
      }),
    );
    expect(res.success).toBe(false);
  });

  it('rejects a variant naming a field the type does not declare', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        writeUnion: {
          variants: [
            { name: 'a file post', fields: ['text', 'file_ref'] },
            { name: 'an interactive post', fields: ['text', 'blocks_json', 'attachments'] },
          ],
        },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message).join('\n')).toContain(
      "names field 'attachments', which this type does not declare",
    );
  });

  it('rejects a variant naming a READ-only field — a shape is made of settable fields', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        fields: [
          writableField('text', 'Message'),
          writableField('file_ref', 'File'),
          writableField('blocks_json', 'Blocks'),
          { ...writableField('sent_at', 'Sent At'), writable: false },
        ],
        writeUnion: {
          variants: [
            { name: 'a file post', fields: ['text', 'file_ref', 'sent_at'] },
            { name: 'an interactive post', fields: ['text', 'blocks_json'] },
          ],
        },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message).join('\n')).toContain(
      "names field 'sent_at', which is not writable",
    );
  });

  it('rejects two variants wearing one name — the error has to tell the shapes apart', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        writeUnion: {
          variants: [
            { name: 'a post', fields: ['text', 'file_ref'] },
            { name: 'a post', fields: ['text', 'blocks_json'] },
          ],
        },
      }),
    );
    expect(res.success).toBe(false);
  });

  it('rejects writeUnion alongside discriminatedWrite — nothing would decide the variant', () => {
    const res = schemaTypeDescriptorSchema.safeParse(
      messageType({
        discriminatedWrite: { discriminant: 'text', variantTypes: { a: 'A' } },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message).join('\n')).toContain(
      "writeUnion and discriminatedWrite can't both be declared",
    );
  });
});
