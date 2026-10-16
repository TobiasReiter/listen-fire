// A hop's alias read under language version 5 (`c.email` inside the hop's
// brackets) is the field of the record the hop lands on, even where a
// variable of the same name is in scope; a bare name there is the variable.
// So `-[c:contacts WHERE c.email == email]->` keeps only the contacts whose
// email is the variable's, on both engines (the TypeScript reference, forced,
// and Rust), ORDER BY included, and the source is still asked for the field
// test (`where`, `orderBy`).

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter, GetRelatedInput } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000f5');

const schema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', email: 'text' }, edges: { contacts: { target: 'contact', readable: true } } },
    contact: { properties: { name: 'text', email: 'text', score: 'number' }, edges: {} },
    note: { properties: { body: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { body: 'text' }, resultShape: { body: 'text' }, edges: {} } },
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const event: TriggerEvent = {
  pipelineInputId: 'pi-hop-field',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'Hello', email: 'b@acme.test' },
};

const CONTACTS = [
  { id: 'k-1', name: 'Ann', email: 'a@acme.test', score: 3 },
  { id: 'k-2', name: 'Bo', email: 'b@acme.test', score: 1 },
  { id: 'k-3', name: 'Bea', email: 'b@acme.test', score: 7 },
];

type Asked = Pick<GetRelatedInput, 'fieldId' | 'where' | 'orderBy' | 'limit'>;

interface Seen {
  asked: Asked[];
  /** The note each kept contact wrote. */
  notes: unknown[];
}

/** The inbox, recording what each walk asked for and answering every contact
 *  (the engine's own filter is what the test reads), and the notes written. */
function fakeInbox({ asked, notes }: Seen): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async (input) => {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    getRelated: async (input) => {
      asked.push({ fieldId: input.fieldId, where: input.where, orderBy: input.orderBy, limit: input.limit });
      if (input.fieldId !== 'contacts') return [];
      return CONTACTS.map(({ id, ...data }) => ({ position: makeStablePosition({ adapterType: 'email', recordType: 'contact', recordId: id, data }) }));
    },
    createRecord: async (input) => {
      notes.push(input.fields.body);
      return { adapterType: 'email', externalId: `n-${notes.length}`, data: { ...input.fields } };
    },
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

const V5 = (...body: string[]) =>
  [
    'import { `@lf/email` as mail } from adapters',
    'import { dealflow_inbox } from credentials',
    'inbox = connect mail using dealflow_inbox',
    'function m(msg: <inbox-[:message]->>) {',
    '  email = msg.`email`',
    ...body,
    '}',
  ].join('\n');

async function runOn(engine: 'ts' | 'rust', source: string): Promise<Seen> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const seen: Seen = { asked: [], notes: [] };
  try {
    await runMovement({
      source,
      languageVersion: 5,
      event,
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      host: makeTestHost({ adapters: { resolve: () => fakeInbox(seen) } }),
      runId: `run-hop-field-${engine}`,
      firedAt: '2026-10-16T09:00:00.000Z',
    });
    return seen;
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** The program on both engines: the same notes and the same requests, the
 *  Rust run whole. */
async function onBoth(source: string): Promise<Seen> {
  const ts = await runOn('ts', source);
  resetRustRunStats();
  const rust = await runOn('rust', source);
  expect(rustRunStats).toMatchObject({ routed: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
  expect(rust).toEqual(ts);
  return ts;
}

/** The field test the source is sent: the alias read as a field, the
 *  variable as the value it holds. */
const emailIsTheVariable = {
  type: 'compare',
  op: 'eq',
  left: { type: 'edge_property', propertyTypeId: 'email', fieldOnly: true },
  right: { type: 'static', value: 'b@acme.test' },
};

describe("a hop's alias read under version 5 is the landed record's field", () => {
  it('`c.email == email` keeps only the contacts whose email is the variable, on both engines', async () => {
    const { notes, asked } = await onBoth(V5('  msg-[c:contacts WHERE c.email == email]-> {', '    write inbox-[:note]-> { body: c.`name` }', '  }'));
    expect(notes).toEqual(['Bo', 'Bea']);
    expect(asked).toEqual([{ fieldId: 'contacts', where: emailIsTheVariable, orderBy: undefined, limit: undefined }]);
  });

  it('the same walk bound to a name reads the field on both engines', async () => {
    const { notes, asked } = await onBoth(
      V5('  found = msg-[c:contacts WHERE c.email == email && c.score > 2]->', '  write inbox-[:note]-> { body: "${count(found)}" }'),
    );
    expect(notes).toEqual(['1']);
    expect(asked).toHaveLength(1);
  });

  it('ORDER BY an alias read sorts by the field, the source asked to sort by it, on both engines', async () => {
    const { notes, asked } = await onBoth(
      V5(
        '  score = 0',
        '  msg-[c:contacts WHERE c.email == email ORDER BY c.score DESC LIMIT 1]-> {',
        '    write inbox-[:note]-> { body: "${c.`name`} ${score}" }',
        '  }',
      ),
    );
    expect(notes).toEqual(['Bea 0']);
    expect(asked).toEqual([{ fieldId: 'contacts', where: emailIsTheVariable, orderBy: { fieldId: 'score', direction: 'desc' }, limit: 1 }]);
  });
});
