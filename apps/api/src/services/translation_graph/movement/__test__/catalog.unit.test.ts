// M5 — catalog mapping tests (pure: no DB, no adapter registry).
//
//   1. Import-name projection: credential/plugin row names → bare-identifier
//      import bindings (`importIdentifier`).
//   2. Adapter introspection output → InstanceSchema: readable/writable
//      split, field-kind mapping, reference→edge projection, collision
//      notes. Types/edges/fields are keyed by the adapter's NATURAL names
//      (entry `displayName`, field `displayName`, reference `name`).
//   3. Team ontology → kg InstanceSchema (display-named positions /
//      properties / edges; no translation map — it carries the checker
//      schema only).
//   4. Credential rows → import names (incl. the shared-credential-type
//      slug-suffix rule).
//   5. Name resolution: the SAME introspection feeds `adapterNameResolver`
//      — display names resolve to the adapter's internal ids (KG UUIDs,
//      edge outbound names) at the engine boundary. The KG is not special;
//      its resolver is built from its introspection like any adapter's.

import { unionKey } from 'movement-lang';

import type { SchemaEntryPoint, SchemaTypeDescriptor } from 'movement-engine/services/translation_graph/types';

import {
  credentialImportNames,
  fieldTypeFromDescriptor,
  importIdentifier,
  instanceSchemaFromDescriptors,
} from 'movement-engine/services/translation_graph/movement/schema_projection';
import { registeredPluginSpecs } from '../catalog';
import {
  adapterNameResolver,
  naturalName,
  AdapterNameDriftError,
} from '../../adapters/name_resolution';

// ── 1. Import-name projection ───────────────────────────────────────────────

describe('importIdentifier', () => {
  it('projects arbitrary strings into bare-identifier import bindings', () => {
    expect(importIdentifier('Dev Loop Attio')).toBe('dev_loop_attio');
    expect(importIdentifier('Funding Round')).toBe('funding_round');
    expect(importIdentifier('3rd Party')).toBe('_3rd_party');
    expect(importIdentifier('--')).toBe('_');
  });
});

describe('fieldTypeFromDescriptor', () => {
  it('maps adapter field kinds to movement field types', () => {
    expect(fieldTypeFromDescriptor({ kind: 'string' })).toBe('text');
    expect(fieldTypeFromDescriptor({ kind: 'number' })).toBe('number');
    expect(fieldTypeFromDescriptor({ kind: 'boolean' })).toBe('boolean');
    expect(fieldTypeFromDescriptor({ kind: 'date' })).toBe('date');
    expect(fieldTypeFromDescriptor({ kind: 'file' })).toBe('file');
    expect(fieldTypeFromDescriptor({ kind: 'json' })).toBe('json');
    expect(fieldTypeFromDescriptor({ kind: 'reference' })).toBeUndefined();
    expect(fieldTypeFromDescriptor({ kind: 'enum', enumValues: ['a', 'b'] })).toEqual({
      kind: 'enum',
      options: ['a', 'b'],
    });
    expect(fieldTypeFromDescriptor({ kind: 'string', cardinality: 'many' })).toEqual({
      kind: 'list',
      of: 'text',
    });
  });

  // An EMPTY option list and NO option list are different facts. Collapsing
  // them into `text` is what let `{ listName: "Absolutely No Such List" }`
  // provision valid against an object that can join zero lists.
  it('an EMPTY enum domain projects as the empty enum, not as unconstrained text', () => {
    expect(fieldTypeFromDescriptor({ kind: 'enum', enumValues: [] })).toEqual({
      kind: 'enum',
      options: [],
    });
  });

  it('an enum with no enumValues at all stays text (unknown domain, not an empty one)', () => {
    expect(fieldTypeFromDescriptor({ kind: 'enum' })).toBe('text');
  });

  // `json` used to project as `text`, which made the field claim a shape it
  // does not have — a many-cardinality one then comma-joined into
  // `[object Object], …` at run time. A structured value projects as one.
  it('a json field projects as json, and a many one as a list of json', () => {
    expect(fieldTypeFromDescriptor({ kind: 'json' })).toBe('json');
    expect(fieldTypeFromDescriptor({ kind: 'json', cardinality: 'one' })).toBe('json');
    expect(fieldTypeFromDescriptor({ kind: 'json', cardinality: 'many' })).toEqual({
      kind: 'list',
      of: 'json',
    });
  });
});

// ── 2. Introspection fixtures (mirroring the real adapters' shapes) ─────────

const field = (
  fieldId: string,
  kind: SchemaTypeDescriptor['fields'][number]['kind'],
  opts: { writable?: boolean } = {},
): SchemaTypeDescriptor['fields'][number] => ({
  fieldId,
  displayName: fieldId,
  kind,
  writable: opts.writable ?? false,
  required: false,
});

const emailEntries: SchemaEntryPoint[] = [
  { typeId: 'email:message', displayName: 'Email', writable: false, readable: true },
  { typeId: 'email:attachment', displayName: 'Attachment', writable: false, readable: true },
];
const emailDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'email:message',
    {
      typeId: 'email:message',
      displayName: 'Email',
      fields: [field('subject', 'string'), field('sender', 'string'), field('content', 'string')],
      references: [
        { fieldId: 'attachments', targetTypeId: 'email:attachment', cardinality: 'many' },
      ],
    },
  ],
  [
    'email:attachment',
    {
      typeId: 'email:attachment',
      displayName: 'Attachment',
      fields: [field('name', 'string'), field('data', 'file')],
      references: [],
    },
  ],
]);

const attioEntries: SchemaEntryPoint[] = [
  { typeId: 'attio:companies', displayName: 'Companies', writable: true, readable: true },
  { typeId: 'attio:people', displayName: 'People', writable: true, readable: true },
  {
    typeId: 'attio:webhook_event',
    displayName: 'Webhook Event',
    writable: false,
    // Nobody enumerates webhook events — the edge's whole promise is `fires`.
    readable: false,
    fires: true,
  },
];
const attioDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'attio:companies',
    {
      typeId: 'attio:companies',
      displayName: 'Companies',
      fields: [
        field('name', 'string', { writable: true }),
        field('description', 'string', { writable: true }),
        field('team_size', 'number', { writable: true }),
      ],
      references: [],
    },
  ],
  [
    'attio:people',
    {
      typeId: 'attio:people',
      displayName: 'People',
      fields: [field('name', 'string', { writable: true })],
      references: [
        { fieldId: 'parent_object', targetTypeId: 'attio:companies', cardinality: 'one' },
      ],
    },
  ],
  [
    'attio:webhook_event',
    {
      typeId: 'attio:webhook_event',
      displayName: 'Webhook Event',
      fields: [
        { fieldId: 'action', displayName: 'action', kind: 'enum', enumValues: ['record.created', 'record.updated', 'record.deleted'], writable: false, required: false },
      ],
      references: [
        { fieldId: 'Companies', targetTypeId: 'attio:companies', cardinality: 'one', requiresLiveRecord: true },
      ],
    },
  ],
]);

const slackEntries: SchemaEntryPoint[] = [
  { typeId: 'slack:message', displayName: 'Slack Message', writable: false, readable: true },
  { typeId: 'slack:channel', displayName: 'Channel', collectionName: 'Channels', writable: false, readable: true },
];
const slackDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'slack:message',
    {
      typeId: 'slack:message',
      displayName: 'Slack Message',
      fields: [
        field('text', 'string', { writable: true }),
        field('user', 'string'),
      ],
      references: [
        { fieldId: 'replies', targetTypeId: 'slack:message', cardinality: 'many', name: 'replies', writable: true },
        // The ephemeral seam's motivating case (WhatsApp typing, landed in
        // Task 7): a writable edge that performs an ACTION, not a record
        // write — no adapter sets this on slack today, but the fixture
        // exercises the projection additively regardless.
        {
          fieldId: 'typing',
          targetTypeId: 'slack:message',
          cardinality: 'many',
          name: 'typing',
          writable: true,
          ephemeral: true,
        },
      ],
    },
  ],
  [
    'slack:channel',
    {
      typeId: 'slack:channel',
      displayName: 'Channel',
      fields: [field('name', 'string')],
      references: [
        { fieldId: 'messages', targetTypeId: 'slack:message', cardinality: 'many', name: 'messages', writable: true },
      ],
    },
  ],
]);

// Single-readable fixture: one readable entry with no explicit eventPosition —
// exercises the heuristic fallback path (eventPosition = the sole entry).
const singleReadableEntries: SchemaEntryPoint[] = [
  { typeId: 'email2:message', displayName: 'Email', writable: false, readable: true },
];
const singleReadableDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'email2:message',
    {
      typeId: 'email2:message',
      displayName: 'Email',
      fields: [field('subject', 'string')],
      references: [],
    },
  ],
]);

// No-descriptor fixture: exercises the "open position" path for a readable
// entry whose describe() returned null (no descriptor in the map).
const noDescriptorEntries: SchemaEntryPoint[] = [
  { typeId: 'test:mystery', displayName: 'Mystery', writable: false, readable: true },
];

// An edge whose target `listEntryPoints` doesn't publish means two different
// things depending on how the instance's surface is produced, so the drift
// note has to ask which. plans/2026-07-10-adapter-entry-positions/2_type_space.md
describe('instanceSchemaFromDescriptors — the unpublished-edge-target note', () => {
  const container = {
    supportsInPlaceUpdate: false,
    adapterType: 'airtable',
    entries: [{ typeId: 'CRM', displayName: 'CRM', writable: false, readable: true }],
    descriptors: new Map([
      [
        'CRM',
        {
          typeId: 'CRM',
          displayName: 'CRM',
          fields: [],
          references: [
            { fieldId: 'tblCo', name: 'Companies', targetTypeId: 'CRM — Companies', cardinality: 'many' as const },
          ],
        },
      ],
    ]),
  };

  it('warns when the surface is published WHOLE — the target really is missing', () => {
    const projected = instanceSchemaFromDescriptors(container);
    expect(projected.notes.join()).toContain('listEntryPoints does not publish');
  });

  it('stays silent when the surface is WALKED — nobody has followed that edge yet', () => {
    const projected = instanceSchemaFromDescriptors({ ...container, lazilyWalked: true });
    // Otherwise it fires on every un-traversed edge, which is noise that
    // teaches readers to ignore the real drift it was built to catch.
    expect(projected.notes).toEqual([]);
  });
});

// A record can be identified by WHAT IT HANGS OFF as much as by what it
// carries: a company sits on a list once, so a list entry is identified by the
// pair (the company, the list). The company reaches the write through the
// parent's `List Entries` edge — a name the entry's own type never declares —
// so the projection has to recognise the edges that LAND on a type, or the
// whole rule is dropped and the checker is told the write has no native
// identity at all.
describe('instanceSchemaFromDescriptors — identity naming the edge a record hangs off', () => {
  const projected = () =>
    instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: true,
      adapterType: 'affinity',
      entries: [
        { typeId: 'Organization', displayName: 'Organization', writable: true, readable: true },
        {
          typeId: 'Organization List Entry',
          displayName: 'Organization List Entry',
          writable: false,
          readable: false,
        },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'Organization',
          {
            typeId: 'Organization',
            displayName: 'Organization',
            fields: [
              {
                fieldId: 'name',
                displayName: 'Name',
                kind: 'string' as const,
                writable: true,
                required: false,
              },
            ],
            references: [
              {
                fieldId: 'List Entries',
                name: 'List Entries',
                targetTypeId: 'Organization List Entry',
                cardinality: 'many' as const,
                writable: true,
              },
            ],
          },
        ],
        [
          'Organization List Entry',
          {
            typeId: 'Organization List Entry',
            displayName: 'Organization List Entry',
            fields: [
              {
                fieldId: 'listName',
                displayName: 'listName',
                kind: 'enum' as const,
                enumValues: ['Deal Pipeline'],
                writable: true,
                required: true,
              },
            ],
            references: [],
            uniquenessConstraints: {
              any: [{ all: [{ field: 'List Entries' }, { field: 'listName' }] }],
            },
          },
        ],
      ]),
    });

  it('declares the pair — the parent edge and the discriminant — as native identity', () => {
    expect(
      projected().schema.createShapes?.['Organization List Entry']?.nativeUniqueness,
    ).toEqual([['List Entries', 'listName']]);
  });

  it('says nothing about it — the rule maps, so there is no note to read', () => {
    expect(projected().notes).toEqual([]);
  });
});

// A reference that can land on SEVERAL types is one edge with a union target —
// `EdgeSchema.polymorphic` plus a `unions` entry keyed by a DERIVED structural
// address, never a fabricated name. The variants are the target types' natural
// names; the author-facing text lives in `unionDisplayNames`.
describe('instanceSchemaFromDescriptors — a multi-target reference is a union edge', () => {
  const entries = [
    { typeId: 'Funds', displayName: 'Funds', writable: true, readable: true },
    { typeId: 'People', displayName: 'People', writable: true, readable: true },
    { typeId: 'Companies', displayName: 'Companies', writable: true, readable: true },
  ];
  const typeDescriptor = (typeId: string) => ({
    typeId,
    displayName: typeId,
    fields: [
      { fieldId: 'name', displayName: 'Name', kind: 'string' as const, writable: true, required: false },
    ],
    references: [],
  });
  const projected = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'attio',
    entries,
    descriptors: new Map([
      [
        'Funds',
        {
          ...typeDescriptor('Funds'),
          references: [
            {
              fieldId: 'gps',
              name: 'GPs',
              targetTypeId: 'People',
              targetTypeIds: ['People', 'Companies'],
              cardinality: 'many' as const,
              writable: true,
            },
          ],
        },
      ],
      ['People', typeDescriptor('People')],
      ['Companies', typeDescriptor('Companies')],
    ]),
  });
  const edge = projected.schema.positions.Funds?.edges.GPs;

  it('projects the edge as polymorphic', () => {
    expect(edge?.polymorphic).toBe(true);
  });

  it('targets a DERIVED union key, registered with its members', () => {
    expect(edge?.target).toBe(unionKey(['People', 'Companies']));
    expect(projected.schema.unions?.[edge!.target]).toEqual(['Companies', 'People']);
  });

  it('the key is not a name — the author-facing text is separate', () => {
    expect(projected.schema.unionDisplayNames?.[edge!.target]).toBe('Companies | People');
  });

  it('every member is a published position — the runtime restamp is gated on it', () => {
    expect(projected.schema.positions.People).toBeDefined();
    expect(projected.schema.positions.Companies).toBeDefined();
  });

  it('a writable multi-target edge gives EVERY member a write shape', () => {
    const shapeFor = (t: string) =>
      projected.schema.writableRoots[t] ?? projected.schema.createShapes?.[t];
    expect(shapeFor('People')).toBeDefined();
    expect(shapeFor('Companies')).toBeDefined();
  });

  it('says nothing about drift — every member resolves', () => {
    expect(projected.notes).toEqual([]);
  });

  it('a one-member set (after resolution) stays an ORDINARY edge', () => {
    // Two declared targets whose natural names collide onto one type: the
    // landing is a single type, so there is no union to mint.
    const single = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'attio',
      entries: [
        { typeId: 'Funds', displayName: 'Funds', writable: true, readable: true },
        { typeId: 'people_a', displayName: 'People', writable: false, readable: true },
        { typeId: 'people_b', displayName: 'People', writable: false, readable: true },
      ],
      descriptors: new Map([
        [
          'Funds',
          {
            ...typeDescriptor('Funds'),
            references: [
              {
                fieldId: 'gps',
                name: 'GPs',
                targetTypeId: 'people_a',
                targetTypeIds: ['people_a', 'people_b'],
                cardinality: 'many' as const,
              },
            ],
          },
        ],
      ]),
    });
    expect(single.schema.positions.Funds?.edges.GPs).toEqual({ target: 'People' });
  });

  it('names EVERY unpublished member in the drift note', () => {
    const drifted = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'attio',
      entries: [{ typeId: 'Funds', displayName: 'Funds', writable: true, readable: true }],
      descriptors: new Map([
        [
          'Funds',
          {
            ...typeDescriptor('Funds'),
            references: [
              {
                fieldId: 'gps',
                name: 'GPs',
                targetTypeId: 'People',
                targetTypeIds: ['People', 'Companies'],
                cardinality: 'many' as const,
              },
            ],
          },
        ],
      ]),
    });
    expect(drifted.notes.join()).toContain("'People'");
    expect(drifted.notes.join()).toContain("'Companies'");
  });
});

// Two of the SOURCE's fields wearing one display name (an Attio object with
// both a built-in and a custom attribute titled "Name"). The projection can't
// invent a distinct name for the second without minting a nominal one, so it
// resolves deterministically and records the ambiguity for the checker to warn
// at the point of use. What it must NOT do is drop the name, blank the schema,
// or open the position.
describe('instanceSchemaFromDescriptors — colliding display names', () => {
  const collided = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'attio',
    entries: [{ typeId: 'Funds', displayName: 'Funds', writable: true, readable: true }],
    descriptors: new Map([
      [
        'Funds',
        {
          typeId: 'Funds',
          displayName: 'Funds',
          fields: [
            { fieldId: 'name', displayName: 'Name', kind: 'string' as const, writable: true, required: false },
            { fieldId: 'name_custom', displayName: 'Name', kind: 'string' as const, writable: true, required: false },
            { fieldId: 'vintage', displayName: 'Vintage', kind: 'number' as const, writable: true, required: false },
          ],
          references: [],
        },
      ],
    ]),
  });

  it('keeps the name readable — resolving to the first field', () => {
    expect(collided.schema.positions.Funds?.properties.Name).toBe('text');
  });

  it('records the ambiguity so the checker can warn at the point of use', () => {
    expect(collided.schema.positions.Funds?.ambiguousProperties).toEqual(['Name']);
  });

  it('does not open the position — the surface is fully enumerated', () => {
    // openProperties would silence every unknown-field check on this type,
    // trading one told ambiguity for a whole position's worth of silence.
    expect(collided.schema.positions.Funds?.openProperties).toBeUndefined();
  });

  it('leaves the unaffected fields alone', () => {
    expect(collided.schema.positions.Funds?.properties.Vintage).toBe('number');
  });
});

// An adapter publishes ONE type under two entries whenever a readable root
// collection and an event edge land on the same node (adapters/CLAUDE.md rule
// 9 — Granola's meetings, Evertrace's and Dealroom's rounds). That is the entry
// surface working as designed, so the projection keeps quiet; two DIFFERENT
// types wearing one name still costs the author a type they cannot address, so
// that one still speaks.
describe('instanceSchemaFromDescriptors — one name, two entries', () => {
  const roundDescriptor: SchemaTypeDescriptor = {
    typeId: 'dealroom:round',
    displayName: 'Funding Round',
    fields: [field('amount', 'number')],
    references: [],
  };

  it('stays silent when both entries are the SAME type — a collection and an event edge', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'dealroom',
      entries: [
        {
          typeId: 'dealroom:round',
          displayName: 'Funding Round',
          writable: false,
          readable: true,
          collectionName: 'Funding Rounds',
        },
        {
          typeId: 'dealroom:round',
          displayName: 'Funding Round',
          writable: false,
          readable: false,
          fires: true,
          firesOn: ['funding_round'],
        },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([['dealroom:round', roundDescriptor]]),
    });
    expect(projected.notes).toEqual([]);
    expect(projected.schema.collections).toEqual({
      'Funding Rounds': { target: 'Funding Round' },
    });
    expect(projected.schema.positions['Funding Round']?.properties.amount).toBe('number');
  });

  it('warns when two DIFFERENT types want the name — only one is addressable', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'dealroom',
      entries: [
        { typeId: 'dealroom:round', displayName: 'Funding Round', writable: false, readable: true },
        { typeId: 'dealroom:legacy_round', displayName: 'Funding Round', writable: false, readable: true },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        ['dealroom:round', roundDescriptor],
        [
          'dealroom:legacy_round',
          { ...roundDescriptor, typeId: 'dealroom:legacy_round', fields: [field('size', 'number')] },
        ],
      ]),
    });
    expect(projected.notes.join()).toContain("more than one type is named 'Funding Round'");
    expect(projected.schema.positions['Funding Round']?.properties.amount).toBe('number');
  });
});

describe('instanceSchemaFromDescriptors', () => {
  const attio = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'attio',
    entries: attioEntries,
    descriptors: attioDescriptors,
  });
  const slack = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'slack',
    entries: slackEntries,
    descriptors: slackDescriptors,
  });
  const email = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'email',
    entries: emailEntries,
    descriptors: emailDescriptors,
  });
  const singleReadable = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'email2',
    entries: singleReadableEntries,
    descriptors: singleReadableDescriptors,
  });
  const noDescriptor = instanceSchemaFromDescriptors({
    supportsInPlaceUpdate: false,
    adapterType: 'test',
    entries: noDescriptorEntries,
    descriptors: new Map(),
  });

  it('readable and fires entries become positions keyed by the natural display name', () => {
    // 'Webhook Event' carries the `fires` marker → THE EVENT IS JUST A NODE:
    // one position, no synthesized variants, no union.
    expect(Object.keys(attio.schema.positions).sort()).toEqual([
      'Companies',
      'People',
      'Webhook Event',
    ]);
    expect(attio.schema.positions['Companies'].properties).toEqual({
      name: 'text',
      description: 'text',
      team_size: 'number',
    });
  });

  it('every readable entry is a meta-position collection sharing the natural name', () => {
    // listEntryPoints IS the whole-schema rollup: each readable entry
    // point is a collection edge off the adapter's meta position, keyed
    // by the SAME natural display name as the position — `root-[c:Companies]->`
    // uses the name authors write (backtick-quoted) in parameter types.
    // The event edge mints NO collection — its whole promise is `fires`
    // (nobody enumerates the events that have happened).
    // The VALUE is where the hop lands plus what the source can do across it —
    // a root collection is an edge and declares like one (D2). These fixtures
    // pass no root descriptor, so no capability is declared and the gate stays
    // silent, exactly as it does for an undeclared record edge.
    expect(attio.schema.collections).toEqual({
      Companies: { target: 'Companies' },
      People: { target: 'People' },
    });
    expect(email.schema.collections).toEqual({
      Email: { target: 'Email' },
      Attachment: { target: 'Attachment' },
    });
    // Channel's distinct collectionName ('Channels') keys its collection
    // entry; the message type keys by its own display name.
    expect(slack.schema.collections).toEqual({
      'Slack Message': { target: 'Slack Message' },
      Channels: { target: 'Channel' },
    });
  });

  it('honours an entry`s distinct collectionName (collection key ≠ position type)', () => {
    // An entry may name its meta-root collection differently from the
    // position type it yields — Granola`s `Meeting Note` records are pulled
    // through a `meetings` collection. The position stays keyed by its
    // displayName; only the collection key changes.
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'granola',
      entries: [
        {
          typeId: 'granola:note',
          displayName: 'Meeting Note',
          writable: false,
          readable: true,
          collectionName: 'meetings',
        },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'granola:note',
          {
            typeId: 'granola:note',
            displayName: 'Meeting Note',
            fields: [field('summary', 'string')],
            references: [],
          },
        ],
      ]),
      supportsInPlaceUpdate: false,
    });
    expect(projected.schema.collections).toEqual({ meetings: { target: 'Meeting Note' } });
    expect(Object.keys(projected.schema.positions)).toEqual(['Meeting Note']);
  });

  it('writable entries become writableRoots with externalId/url + the record in the result shape', () => {
    expect(attio.schema.writableRoots['Companies']).toEqual({
      fields: { name: 'text', description: 'text', team_size: 'number' },
      // Only what the record holds: what the write DID is asked of the
      // handle's `-[:@old]->`, never projected as a field.
      resultShape: {
        externalId: 'text',
        url: 'text',
        name: 'text',
        description: 'text',
        team_size: 'number',
      },
    });
    // Slack has NO writable root — its Message type is created only along
    // edges (Channel.messages, Slack Message.replies), never top-level.
    expect(slack.schema.writableRoots).toEqual({});
    // Readable-only types contribute no writable root.
    expect(email.schema.writableRoots).toEqual({});
  });

  it('writable references project onto EdgeSchema and produce createShapes', () => {
    expect(slack.schema.positions['Channel'].edges.messages).toEqual({
      target: 'Slack Message',
      writable: true,
    });
    expect(slack.schema.positions['Slack Message'].edges.replies).toEqual({
      target: 'Slack Message',
      writable: true,
    });
    // The edge-writable type gets a write shape WITHOUT a writableRoots entry.
    expect(slack.schema.writableRoots['Slack Message']).toBeUndefined();
    // Identical content to a writableRoots literal — including 'Slack
    // Message''s own outgoing edges (its self-referencing `replies` edge),
    // since createShapes and writableRoots share the same shape contract.
    expect(slack.schema.createShapes?.['Slack Message']).toEqual({
      fields: { text: 'text' },
      // `user` is a readable-only field on Message — the write body never sets
      // it, but a write handle can READ it back (and `refresh` it), so it rides
      // the result shape alongside the written `text` (asks-as-adapter F5).
      resultShape: {
        externalId: 'text',
        url: 'text',
        user: 'text',
        text: 'text',
      },
      edges: {
        replies: { target: 'Slack Message', writable: true },
        typing: { target: 'Slack Message', writable: true, ephemeral: true },
      },
    });
  });

  it('a discriminatedWrite declaration projects a `discriminated` block on the create shape (layer 10)', () => {
    // The Attio list-membership shape: a `List` type writable along a
    // record's `Lists` edge, whose write body is a discriminated union keyed on
    // `listName`. Each list name maps to its own per-list type; the per-list
    // type's write shape is that variant. `VC Deal Flow` carries a writable
    // `Stage`, `Pipeline` carries none — proving the variant fields come from
    // the per-list types, not a hardcode.
    const listNameEnum = {
      fieldId: 'listName',
      displayName: 'listName',
      kind: 'enum' as const,
      enumValues: ['VC Deal Flow', 'Pipeline'],
      writable: true,
      readable: false,
      required: true,
    };
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'attio',
      entries: [
        { typeId: 'attio:companies', displayName: 'Companies', writable: true, readable: true },
        // The per-list types + the generic List are published entries with no
        // root promise — reached (and, for List, created) through edges.
        { typeId: 'VC Deal Flow', displayName: 'VC Deal Flow', writable: false, readable: true },
        { typeId: 'Pipeline', displayName: 'Pipeline', writable: false, readable: true },
        { typeId: 'attio:list', displayName: 'List', writable: false, readable: false },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'attio:companies',
          {
            typeId: 'attio:companies',
            displayName: 'Companies',
            fields: [field('name', 'string', { writable: true })],
            // The record's `Lists` edge — writable, targeting the generic List.
            references: [
              { fieldId: 'Lists', targetTypeId: 'attio:list', cardinality: 'many', name: 'Lists', writable: true },
            ],
          },
        ],
        [
          'VC Deal Flow',
          {
            typeId: 'VC Deal Flow',
            displayName: 'VC Deal Flow',
            fields: [
              field('Stage', 'enum', { writable: true }),
            ],
            references: [],
          },
        ],
        [
          'Pipeline',
          { typeId: 'Pipeline', displayName: 'Pipeline', fields: [], references: [] },
        ],
        [
          'attio:list',
          {
            typeId: 'attio:list',
            displayName: 'List',
            fields: [listNameEnum],
            references: [],
            discriminatedWrite: {
              discriminant: 'listName',
              variantTypes: { 'VC Deal Flow': 'VC Deal Flow', Pipeline: 'Pipeline' },
            },
          },
        ],
      ]),
    });
    // `List` is a create-edge target (no writable root) → its shape lives in
    // createShapes, now carrying the discriminated block.
    const listShape = projected.schema.createShapes?.['List'];
    expect(listShape?.discriminated?.discriminant).toBe('listName');
    // The VC Deal Flow variant carries BOTH the discriminant field and the
    // per-list Stage; Pipeline carries only the discriminant.
    const vc = listShape?.discriminated?.variants['VC Deal Flow'];
    const pipeline = listShape?.discriminated?.variants['Pipeline'];
    expect(Object.keys(vc?.fields ?? {}).sort()).toEqual(['Stage', 'listName']);
    expect(Object.keys(pipeline?.fields ?? {})).toEqual(['listName']);
    // A variant is a TYPE, so it says which position a handle from that write
    // stands on — the per-list type, which is what carries `Stage` and any
    // reference edges the list has. Attio spells the variant type as the bare
    // list name; the rule reads the declaration, not the spelling.
    expect(vc?.position).toBe('VC Deal Flow');
    expect(pipeline?.position).toBe('Pipeline');
    // The base shape is the fallback, and a write that named no list stands
    // where it always did.
    expect(listShape?.position).toBeUndefined();
    // A variant is never itself discriminated (no nesting), and the fallback
    // (the base shape) still carries the discriminant as its only field.
    expect(vc?.discriminated).toBeUndefined();
    expect(Object.keys(listShape?.fields ?? {})).toEqual(['listName']);
  });

  // An UNTAGGED write union travels field IDS; the checker checks a body
  // against surface NAMES. Both fixtures below give the two DIFFERENT spellings
  // so an identity mapping can't pass for a projection.
  it('a writeUnion declaration projects onto the write shape, mapping field ids to surface names', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'chat',
      entries: [
        { typeId: 'chat:channel', displayName: 'Channel', writable: false, readable: true },
        { typeId: 'chat:message', displayName: 'Chat Message', writable: false, readable: false },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'chat:channel',
          {
            typeId: 'chat:channel',
            displayName: 'Channel',
            fields: [],
            references: [
              { fieldId: 'messages', targetTypeId: 'chat:message', cardinality: 'many', name: 'Messages', writable: true },
            ],
          },
        ],
        [
          'chat:message',
          {
            typeId: 'chat:message',
            displayName: 'Chat Message',
            fields: [
              { fieldId: 'text', displayName: 'Message', kind: 'string', writable: true, required: false },
              { fieldId: 'file_ref', displayName: 'File', kind: 'file', writable: true, readable: false, required: false },
              { fieldId: 'blocks_json', displayName: 'Blocks', kind: 'json', cardinality: 'many', writable: true, readable: false, required: false },
            ],
            references: [],
            writeUnion: {
              variants: [
                { name: 'a file post', fields: ['text', 'file_ref'] },
                { name: 'an interactive post', fields: ['text', 'blocks_json'] },
              ],
            },
          },
        ],
      ]),
    });
    // The message is an edge-create target, so its shape lives in createShapes
    // — the union rides whichever registry holds the shape.
    expect(projected.schema.createShapes?.['Chat Message']?.writeUnion).toEqual({
      variants: [
        { name: 'a file post', fields: ['Message', 'File'] },
        { name: 'an interactive post', fields: ['Message', 'Blocks'] },
      ],
    });
    // Every variant field is a real key of the write shape — what the checker
    // compares a body's field names against.
    const shape = projected.schema.createShapes?.['Chat Message'];
    for (const variant of shape?.writeUnion?.variants ?? []) {
      for (const name of variant.fields) expect(shape?.fields[name]).toBeDefined();
    }
    expect(projected.notes).toEqual([]);
  });

  // The second shape: a top-level WRITABLE ROOT (not a create-edge), three
  // variants, and a field whose kind does not project at all — the note says so
  // rather than leaving the surface quietly narrower than the declaration.
  it('a writeUnion on a writable ROOT rides writableRoots, and an unprojectable field is noted', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'dispatch',
      entries: [
        { typeId: 'dispatch:delivery', displayName: 'Delivery', writable: true, readable: true },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'dispatch:delivery',
          {
            typeId: 'dispatch:delivery',
            displayName: 'Delivery',
            fields: [
              { fieldId: 'ref', displayName: 'Reference', kind: 'string', writable: true, required: true },
              { fieldId: 'postal_address', displayName: 'Address', kind: 'string', writable: true, required: false },
              { fieldId: 'email_to', displayName: 'Email', kind: 'string', writable: true, required: false },
              // A writable field of a kind the projection cannot map (a
              // reference kind is surfaced as an edge, never a body field).
              { fieldId: 'courier', displayName: 'Courier', kind: 'reference', writable: true, required: false },
            ],
            references: [],
            writeUnion: {
              variants: [
                { name: 'a postal delivery', fields: ['ref', 'postal_address'] },
                { name: 'an email delivery', fields: ['ref', 'email_to'] },
                { name: 'a courier delivery', fields: ['ref', 'courier'] },
              ],
            },
          },
        ],
      ]),
    });
    expect(projected.schema.writableRoots['Delivery'].writeUnion).toEqual({
      variants: [
        { name: 'a postal delivery', fields: ['Reference', 'Address'] },
        { name: 'an email delivery', fields: ['Reference', 'Email'] },
        // `Courier` never reached the write surface, so the variant is honest
        // without it — and the note names what went missing.
        { name: 'a courier delivery', fields: ['Reference'] },
      ],
    });
    expect(projected.notes.join('\n')).toContain(
      "write variant 'a courier delivery' names field 'courier', which did not project onto the write surface",
    );
  });

  it('a type declaring no writeUnion projects none (absent, not empty)', () => {
    expect(attio.schema.writableRoots['Companies'].writeUnion).toBeUndefined();
  });

  it('an ephemeral reference projects `ephemeral: true` onto its EdgeSchema (writable action-not-record — typing)', () => {
    expect(slack.schema.positions['Slack Message'].edges.typing).toEqual({
      target: 'Slack Message',
      writable: true,
      ephemeral: true,
    });
    // Additive: no adapter produces the ephemeral fact until Task 7
    // (WhatsApp) — attio's projection carries `ephemeral` nowhere.
    for (const position of Object.values(attio.schema.positions)) {
      for (const edge of Object.values(position.edges)) {
        expect(edge.ephemeral).toBeUndefined();
      }
    }
  });

  it('write-only fields and read-only / write-only edges project the duality flags (WhatsApp File)', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'wa',
      entries: [
        { typeId: 'wa:message', displayName: 'Message', writable: false, readable: true },
        { typeId: 'wa:attachment', displayName: 'Attachment', writable: false, readable: true },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'wa:message',
          {
            typeId: 'wa:message',
            displayName: 'Message',
            fields: [
              field('body', 'string', { writable: true }),
              // The send-side File: writable, but readable: false — outbound
              // media rides the send; inbound media is on the attachments edge.
              { fieldId: 'data', displayName: 'File', kind: 'file', writable: true, readable: false, required: false, description: 'A file to send.' },
            ],
            references: [
              { fieldId: 'attachments', targetTypeId: 'wa:attachment', cardinality: 'many', name: 'attachments', writable: false },
              { fieldId: 'replies', targetTypeId: 'wa:message', cardinality: 'many', name: 'replies', writable: true, readable: false },
            ],
          },
        ],
        [
          'wa:attachment',
          {
            typeId: 'wa:attachment',
            displayName: 'Attachment',
            fields: [{ fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false }],
            references: [],
          },
        ],
      ]),
    });
    const message = projected.schema.positions['Message'];
    // The send-side File is NOT a readable property — and its absence is
    // intent, not under-description: the position stays CLOSED so the read
    // errors instead of going silent.
    expect(message.properties).toEqual({ body: 'text' });
    expect(message.openProperties).toBeUndefined();
    expect(message.writeOnlyProperties).toEqual(['File']);
    // …but it stays on the write shape, doc and all.
    expect(projected.schema.createShapes?.['Message'].fields).toEqual({ body: 'text', File: 'file' });
    expect(projected.schema.createShapes?.['Message'].fieldDocs?.['File']).toContain('file to send');
    // Edge flags ride through: attachments read-only, replies write-only.
    // Layer 13: only `writable: true` projects — an absent flag IS the
    // read-only fact, so a read-only edge carries no write key at all.
    expect(message.edges.attachments).toEqual({ target: 'Attachment' });
    expect(message.edges.replies).toEqual({ target: 'Message', writable: true, readable: false });
  });

  it('writableRoots and createShapes stay disjoint — a top-level writable root is never duplicated into createShapes', () => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: false,
      adapterType: 'crm',
      entries: [
        { typeId: 'crm:list-entry', displayName: 'List Entry', writable: true, readable: true },
        // 'Company' is BOTH a top-level writable root AND a writable-edge
        // target off List Entry — it must surface only via writableRoots.
        { typeId: 'crm:company', displayName: 'Company', writable: true, readable: true },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'crm:list-entry',
          {
            typeId: 'crm:list-entry',
            displayName: 'List Entry',
            fields: [field('stage', 'string', { writable: true })],
            references: [
              {
                fieldId: 'company',
                targetTypeId: 'crm:company',
                cardinality: 'one',
                name: 'company',
                writable: true,
              },
            ],
          },
        ],
        [
          'crm:company',
          {
            typeId: 'crm:company',
            displayName: 'Company',
            fields: [field('name', 'string', { writable: true })],
            references: [],
          },
        ],
      ]),
    });
    expect(projected.schema.writableRoots['Company']).toBeDefined();
    expect(projected.schema.createShapes?.['Company']).toBeUndefined();
  });

  it('an adapter with no writable edges produces no createShapes', () => {
    // Attio declares no `writable` edges (unlike slack), and an absent flag is
    // the read-only fact — so nothing is creatable along an edge here.
    expect(attio.schema.createShapes).toBeUndefined();
  });

  it('references project to edges keyed by natural name with natural target names', () => {
    // The email message's attachments reference carries no `name`, so the
    // edge key falls back to its fieldId; the target is the target entry's
    // displayName.
    expect(email.schema.positions['Email'].edges).toEqual({
      attachments: { target: 'Attachment' },
    });
    expect(attio.schema.positions['People'].edges).toEqual({
      parent_object: { target: 'Companies' },
    });
  });

  it('a writable root surfaces its OPTIONAL linkable edges (not just requiredEdges)', () => {
    // People is writable and has an optional `parent_object` edge → Companies.
    // It must appear on the WRITE surface so an author sees the relationship
    // they can link along — the gap the run-author hit (had to write a
    // throwaway movement to learn a child was linkable off a parent). Being
    // optional, it carries NO requiredEdges, so before this it was invisible
    // when describing the write.
    expect(attio.schema.writableRoots['People'].edges).toEqual({
      parent_object: { target: 'Companies' },
    });
    expect(attio.schema.writableRoots['People'].requiredEdges).toBeUndefined();
  });

  it('a REQUIRED edge appears in both the write-surface edges and requiredEdges', () => {
    const projected = instanceSchemaFromDescriptors({
      adapterType: 'crm',
      entries: [
        { typeId: 'crm:entry', displayName: 'List Entry', writable: true, readable: true },
        { typeId: 'crm:company', displayName: 'Company', writable: true, readable: true },
      ],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'crm:entry',
          {
            typeId: 'crm:entry',
            displayName: 'List Entry',
            fields: [field('stage', 'string', { writable: true })],
            references: [
              { fieldId: 'company', targetTypeId: 'crm:company', cardinality: 'one', required: true },
            ],
          },
        ],
        [
          'crm:company',
          { typeId: 'crm:company', displayName: 'Company', fields: [field('name', 'string', { writable: true })], references: [] },
        ],
      ]),
      supportsInPlaceUpdate: false,
    });
    const root = projected.schema.writableRoots['List Entry'];
    expect(root.edges).toEqual({ company: { target: 'Company', required: true } });
    expect(root.requiredEdges).toEqual([{ edge: 'company', from: 'Company' }]);
  });

  it('entries with no descriptor project an UNDESCRIBED position — not an open one', () => {
    // The position exists; NOBODY HAS LOOKED at its surface. That is not the
    // same fact as `openProperties` ("the surface is genuinely wider than what's
    // enumerated"), and spelling both the same way is what let a read through an
    // undescribed handle compile silently and return null. Neither licenses "it
    // has no field X"; only this one errors when the handle is USED.
    expect(noDescriptor.schema.positions['Mystery']).toEqual({
      properties: {},
      edges: {},
      undescribed: true,
    });
    expect(noDescriptor.schema.positions['Mystery'].openProperties).toBeUndefined();
    expect(noDescriptor.notes).toEqual([]);
    // The attio fixture has no projection notes either.
    expect(attio.notes).toEqual([]);
  });

  it('projects the event NODE — no synthesized variants, the axis is an ordinary field', () => {
    // The event is JUST A NODE: its change kind is its own `action` enum
    // field, its record edge carries `requiresLiveRecord` (dropped by the
    // graft under a deleted pin — keyed on the pin, not on a name), and the
    // declared event surface lists the edge.
    expect(attio.schema.unions).toBeUndefined();
    const node = attio.schema.positions['Webhook Event'];
    expect(node.properties['action']).toEqual({
      kind: 'enum',
      options: ['record.created', 'record.updated', 'record.deleted'],
    });
    expect(node.edges['Companies']).toMatchObject({ target: 'Companies', requiresLiveRecord: true });
    expect(attio.schema.eventPosition).toBe('Webhook Event');
    expect(attio.schema.eventPositions).toEqual([{ position: 'Webhook Event' }]);
    // A fires entry never mints a root collection — nobody enumerates events.
    expect(attio.schema.collections).not.toHaveProperty('Webhook Event');
  });

  it('an adapter with a single readable entry still derives eventPosition (fallback)', () => {
    // granola-style: no fires marker, one readable entry → eventPosition is
    // that entry for shape conformance, but the DECLARED event surface stays
    // empty (a poll adapter's record must not seed as an occurrence).
    expect(singleReadable.schema.eventPosition).toBe('Email');
    expect(singleReadable.schema.eventPositions).toBeUndefined();
  });
});

// ── 4. Credential import names ──────────────────────────────────────────────

describe('credentialImportNames (named == identified)', () => {
  const manifests = [
    { adapterType: 'attio', requiredCredentialType: 'ATTIO' as never },
    { adapterType: 'google_sheets', requiredCredentialType: 'GOOGLE' as never },
    { adapterType: 'google_drive', requiredCredentialType: 'GOOGLE' as never },
    { adapterType: 'telegram', requiredCredentialType: 'TELEGRAM' as never },
  ];
  it('keys by the verbatim credential name', () => {
    const out = credentialImportNames({
      rows: [{ id: 'c1', name: 'Dev-loop Attio', type: 'ATTIO' }],
      manifests,
    });
    expect(out).toEqual({
      'Dev-loop Attio': { id: 'c1', rowName: 'Dev-loop Attio', adapters: ['attio'] },
    });
  });
  it('gives a multi-adapter credential type one entry carrying all its adapters', () => {
    const out = credentialImportNames({
      rows: [{ id: 'c2', name: 'Workspace', type: 'GOOGLE' }],
      manifests,
    });
    expect(out).toEqual({
      Workspace: { id: 'c2', rowName: 'Workspace', adapters: ['google_sheets', 'google_drive'] },
    });
  });
  it('single-adapter credential with a spaced name keys by the verbatim name', () => {
    const out = credentialImportNames({
      rows: [{ id: 'c3', name: 'Telegram (shared bot)', type: 'TELEGRAM' }],
      manifests,
    });
    expect(out).toEqual({
      'Telegram (shared bot)': { id: 'c3', rowName: 'Telegram (shared bot)', adapters: ['telegram'] },
    });
  });
});

// ── 5. Name resolution over the SAME introspection ──────────────────────────
//
// There is no separate translation map: the adapter-layer `AdapterNameResolver`
// is built from the SAME introspection the InstanceSchema projection consumes
// (entries + per-entry descriptors). The KG is not special — its ontology rows
// are surfaced as that same introspection shape (display name ↔ UUID, edge name
// ↔ EdgeTypeId), and resolution maps the program's natural names to the KG's
// internal ids at the engine boundary.

// The KG's introspection, mirroring the ontology fixture above (`nt-round`
// `Funding Round`, properties `Name`/`Amount`, edge `et-part` `Participants`):
const kgEntries: SchemaEntryPoint[] = [
  { typeId: 'nt-round', displayName: 'Funding Round', writable: true, readable: true },
  { typeId: 'nt-part', displayName: 'Round Participation', writable: true, readable: true },
];
const kgDescriptors = new Map<string, SchemaTypeDescriptor>([
  [
    'nt-round',
    {
      typeId: 'nt-round',
      displayName: 'Funding Round',
      fields: [
        { fieldId: 'pt-name', displayName: 'Name', kind: 'string', writable: true, required: false },
        {
          fieldId: 'pt-amount',
          displayName: 'Amount',
          kind: 'number',
          writable: true,
          required: false,
        },
      ],
      references: [
        { fieldId: 'et-part', targetTypeId: 'nt-part', cardinality: 'many', name: 'Participants' },
      ],
    },
  ],
  [
    'nt-part',
    {
      typeId: 'nt-part',
      displayName: 'Round Participation',
      fields: [
        {
          fieldId: 'pt-investor',
          displayName: 'Investor Name',
          kind: 'string',
          writable: true,
          required: false,
        },
      ],
      references: [],
    },
  ],
]);

describe('adapterNameResolver over the KG introspection', () => {
  const resolver = adapterNameResolver({ entries: kgEntries, descriptors: kgDescriptors });

  it('display names resolve to ontology UUIDs / edge names', () => {
    expect(resolver.typeId(naturalName('Funding Round'))).toBe('nt-round');
    expect(resolver.typeId(naturalName('Round Participation'))).toBe('nt-part');
    expect(resolver.fieldId(naturalName('Funding Round'), naturalName('Name'))).toBe('pt-name');
    expect(resolver.fieldId(naturalName('Funding Round'), naturalName('Amount'))).toBe('pt-amount');
    // A reference resolves to its EdgeTypeId for reads and its edge name
    // (`name` ?? fieldId — the KG's outbound_name) for writes.
    expect(resolver.edgeReadId(naturalName('Funding Round'), naturalName('Participants'))).toBe('et-part');
    expect(resolver.edgeWriteName(naturalName('Funding Round'), naturalName('Participants'))).toBe('Participants');
    expect(resolver.collectionTypeId(naturalName('Funding Round'))).toBe('nt-round');
  });

  it('the reverse map round-trips display name → UUID → display name', () => {
    expect(resolver.naturalTypeName('nt-round')).toBe('Funding Round');
    expect(resolver.naturalTypeName('nt-part')).toBe('Round Participation');
    expect(resolver.naturalTypeName(resolver.typeId(naturalName('Funding Round')))).toBe('Funding Round');
  });

  it('unknown names throw loud drift (Decision #4) — never silently mis-resolve', () => {
    expect(() => resolver.typeId(naturalName('No Such Type'))).toThrow(AdapterNameDriftError);
    expect(() => resolver.fieldId(naturalName('Funding Round'), naturalName('No Such Prop'))).toThrow(
      AdapterNameDriftError,
    );
    expect(() => resolver.edgeReadId(naturalName('Funding Round'), naturalName('No Such Edge'))).toThrow(
      AdapterNameDriftError,
    );
    expect(() => resolver.edgeWriteName(naturalName('Funding Round'), naturalName('No Such Edge'))).toThrow(
      AdapterNameDriftError,
    );
    // The non-throwing `try*` variants return undefined for the
    // property-then-edge resolution order.
    expect(resolver.tryFieldId(naturalName('Funding Round'), naturalName('No Such Prop'))).toBeUndefined();
    expect(
      resolver.tryEdgeWriteName(naturalName('Funding Round'), naturalName('No Such Edge')),
    ).toBeUndefined();
  });
});

// ── registeredPluginSpecs — required-argument projection ────────────────────
//
// `PluginSpec.requiredArgs` is projected from `TransformParam.required`
// (types.ts) — the checker's REFUSE-a-missing-required-argument gate reads
// only this. `fetch-url`'s `url` and `vc-url-retrieval`'s `text` are the
// real registered plugins that exercise both halves of the rule: a required
// AUTHOR arg projects, a required AUTO arg (engine-injected, never in the
// author-facing surface at all) does not.

describe('registeredPluginSpecs — required-argument projection', () => {
  const specs = registeredPluginSpecs();

  it('projects a required, author-supplied param into requiredArgs (fetch_url.url)', () => {
    expect(specs.fetch_url?.args).toEqual(expect.arrayContaining(['url', 'email', 'password']));
    expect(specs.fetch_url?.requiredArgs).toEqual(['url']);
  });

  it('a required AUTO param is excluded from both args and requiredArgs (vc_url_retrieval.text)', () => {
    expect(specs.vc_url_retrieval?.args).not.toContain('text');
    expect(specs.vc_url_retrieval?.requiredArgs ?? []).not.toContain('text');
  });

  it('an optional author param stays out of requiredArgs (fetch_url.email, vc_url_retrieval.email)', () => {
    expect(specs.fetch_url?.args).toContain('email');
    expect(specs.fetch_url?.requiredArgs ?? []).not.toContain('email');
    expect(specs.vc_url_retrieval?.args).toContain('email');
    expect(specs.vc_url_retrieval?.requiredArgs ?? []).not.toContain('email');
  });
});

// ── registeredPluginSpecs — what a plain call gets back ─────────────────────
//
// The plugin's own signature is the single source: the checker types
// `page = fetch_url(url: …)` from the same declaration the engine hands the
// value back against, so the two cannot disagree about what came out.

describe('registeredPluginSpecs — declared output', () => {
  const specs = registeredPluginSpecs();

  it('a page fetch hands back the text, and may hand back nothing', () => {
    expect(specs.fetch_url?.output).toEqual({
      kind: 'value',
      type: { kind: 'maybeAbsent', of: 'text' },
    });
  });

  it('research hands back a record whose every field may be unfilled', () => {
    const output = specs.research?.output;
    expect(output?.kind).toBe('record');
    const fields = output?.kind === 'record' ? output.fields : {};
    expect(Object.keys(fields).sort()).toEqual([
      'confidence',
      'dossier',
      'linkedin',
      'sources',
      'summary',
      'website',
    ]);
    for (const type of Object.values(fields)) {
      expect(type).toEqual({ kind: 'maybeAbsent', of: 'text' });
    }
  });

  it('link retrieval hands back one record per fetched link, file and text optional', () => {
    expect(specs.vc_url_retrieval?.output).toEqual({
      kind: 'records',
      fields: {
        name: 'text',
        url: 'text',
        file: { kind: 'maybeAbsent', of: 'file' },
        text: { kind: 'maybeAbsent', of: 'text' },
      },
    });
  });

  it('every bundled plugin that takes arguments of its own says what it hands back', () => {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.fedByExtraction === true) continue;
      expect([name, spec.output !== undefined]).toEqual([name, true]);
    }
  });

  it('the one plugin the extraction alone feeds stays a stage', () => {
    // No parameters and a body that reads the enclosing extract's fields —
    // there is no call an author could write, so it declares no output either.
    expect(specs.linkedin_enrichment?.fedByExtraction).toBe(true);
    expect(specs.linkedin_enrichment?.output).toBeUndefined();
  });

  it('a plugin with parameters is callable however it is SCHEDULED', () => {
    // `dataDependency` says when a stage runs, not what the plugin runs on.
    expect(specs.fetch_url?.fedByExtraction).toBeUndefined();
    expect(specs.research?.fedByExtraction).toBeUndefined();
  });

  it("the scanned text is one parameter a stage gets fed and a call writes", () => {
    expect(specs.vc_url_retrieval?.fedArgs).toEqual([{ name: 'text', required: true }]);
    expect(specs.vc_url_retrieval?.fedByExtraction).toBeUndefined();
  });
});

// FUZZY is promised per field: a descriptor names the field ids it can match
// by similarity, and the checker compares an author's `unique by` against the
// names the author writes. The projection is the one place ids become those
// names; a list that stayed as ids would reject every FUZZY on the target.
describe('instanceSchemaFromDescriptors — fuzzy resolution per field', () => {
  const projectedFuzzy = (supportsFuzzyResolution?: boolean | [string, ...string[]]) => {
    const projected = instanceSchemaFromDescriptors({
      supportsInPlaceUpdate: true,
      adapterType: 'native_valuations',
      entries: [{ typeId: 'legal_entity', displayName: 'Legal Entity', writable: true, readable: true }],
      descriptors: new Map<string, SchemaTypeDescriptor>([
        [
          'legal_entity',
          {
            typeId: 'legal_entity',
            displayName: 'Legal Entity',
            ...(supportsFuzzyResolution !== undefined ? { supportsFuzzyResolution } : {}),
            fields: [
              { fieldId: 'name', displayName: 'Name', kind: 'string' as const, writable: true, required: true },
              { fieldId: 'legal_name', displayName: 'Legal Name', kind: 'string' as const, writable: true, required: false },
              { fieldId: 'city', displayName: 'City', kind: 'string' as const, writable: true, required: false },
            ],
            references: [],
          },
        ],
      ]),
    });
    return { projected, fuzzy: projected.schema.writableRoots['Legal Entity']?.fuzzyResolution };
  };

  it('maps a list of field ids to the names an author writes', () => {
    expect(projectedFuzzy(['name', 'legal_name']).fuzzy).toEqual(['Name', 'Legal Name']);
  });

  it('keeps true as true: every field matches by similarity', () => {
    expect(projectedFuzzy(true).fuzzy).toBe(true);
  });

  it.each([
    ['false', false],
    ['absent', undefined],
  ] as const)('declares no fuzzy resolution when the flag is %s', (_label, flag) => {
    expect(projectedFuzzy(flag).fuzzy).toBeUndefined();
  });

  it('drops an id that names no field, and says so', () => {
    const { projected, fuzzy } = projectedFuzzy(['name', 'nickname']);
    expect(fuzzy).toEqual(['Name']);
    expect(projected.notes.join()).toContain("fuzzy resolution names 'nickname'");
  });
});
