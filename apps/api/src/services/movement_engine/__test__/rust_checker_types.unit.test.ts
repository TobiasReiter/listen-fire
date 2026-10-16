// A maybe-record handed to a position parameter (B15): from language
// version 5 the checker refuses it (MOV_CALL_ARG_MAYBE_RECORD) before the run
// opens a segment, so the Rust engine never meets it. Versions 1–4, which ran
// it, run only on the TypeScript engine (its conformance corpora).

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent } from 'movement-engine/services/translation_graph/triggers/types';
import type {
  ExtractCallLlmInput,
  ExtractCallLlmResult,
} from 'movement-engine/services/movement_engine/extraction_call';

import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { makeStablePosition, positionData } from 'movement-engine/services/translation_graph/types';
import { makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import {
  runFailureCause,
  runMovement,
  type MovementRunResult,
} from 'movement-engine/services/movement_engine/run';
import {
  resetRustRunStats,
  rustRunStats,
} from 'movement-engine/services/movement_engine/rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c6');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const companyFields = { name: 'text', stage: 'text' } as const;
const noteFields = { body: 'text', payload: 'json' } as const;
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: companyFields, edges: {} },
    note: { properties: noteFields, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: companyFields, resultShape: { externalId: 'text', ...companyFields } },
    note: { fields: noteFields, resultShape: { externalId: 'text', ...noteFields } },
  },
};

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: credentialArg, schema: emailSchema },
    attio: { constructionArgs: credentialArg, schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'node Co: "each company named" {',
  '  name: <text> "its name"',
  '  stage: <text> "its stage"',
  '}',
  'type Tier = <"gold" | "silver">',
  '',
].join('\n');

/** The companies the system lists. */
const LISTED = {
  'c-acme': { name: 'Acme', stage: 'lead' },
  'c-beta': { name: 'Beta', stage: 'won' },
};

/** The system, recording what it is asked to write. */
function fakeAttio() {
  const writes: Array<[string, unknown]> = [];
  let minted = 0;
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({
      traversal: { incoming: false, edgeProperties: false },
      resources: false,
    }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null
        ? Reflect.get(data, input.fieldId)
        : undefined;
    },
    async getRelated() {
      return Object.entries(LISTED).map(([recordId, data]) => ({
        position: makeStablePosition({
          adapterType: 'attio',
          recordType: 'company',
          recordId,
          data,
        }),
      }));
    },
    async createRecord(input) {
      writes.push(['create', input.fields]);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      writes.push(['update', { id: input.externalId, ...input.fields }]);
      return {
        adapterType: 'attio',
        externalId: input.externalId,
        data: {},
        association: containerAssociation(input),
      };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, writes };
}

function fakeEmail(): Adapter {
  return { ...fakeAttio().adapter, adapterType: 'email', getRelated: async () => [] };
}

/** The model names two companies, each quoted from the message. */
const extractLlm = {
  async call(_input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
    const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });
    return {
      parsedJson: {
        records: [
          { name: cite('Acme'), stage: cite('lead') },
          { name: cite('Beta'), stage: cite('won') },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  },
};

function webhook(): TriggerEvent {
  return {
    pipelineInputId: 'pi-rust-checker-types',
    adapterType: 'email',
    triggerType: 'webhook',
    payload: { subject: 'Acme', text: 'Acme and Beta' },
  };
}

interface Outcome {
  writes: Array<[string, unknown]>;
  result?: MovementRunResult;
  error?: string;
}

async function runOn(source: string, languageVersion: LanguageVersion): Promise<Outcome> {
  const attio = fakeAttio();
  try {
    const result = await runMovement({
      source,
      movementName: 'm',
      event: webhook(),
      teamId: TEAM_ID,
      catalog,
      languageVersion,
      host: makeTestHost({
        adapters: {
          resolve: ({ adapterType }) => (adapterType === 'attio' ? attio.adapter : fakeEmail()),
        },
        llm: { extractCall: extractLlm },
      }),
    });
    return { writes: attio.writes, result };
  } catch (error) {
    const cause = runFailureCause(error);
    return { writes: attio.writes, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

const withHelpers = (helpers: string[], ...body: string[]) =>
  [PRELUDE, ...helpers, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

describe('a maybe-record handed to a position parameter (B15)', () => {
  const HP = [
    'movement hp(r: <crm-[:company]->>) {',
    '  write crm-[:notes]-> { body: r.name }',
    '}',
  ];
  /** The value: the record where the subject is `Acme`, else `other`. */
  const either = (subject: string, other: string) =>
    `IF msg.\`subject\` = "${subject}" THEN org ELSE ${other} END`;
  const shapes = (subject: string, other: string): Array<[string, string]> => [
    [
      'written in place',
      withHelpers(
        HP,
        '  org = write crm-[:companies]-> { name: "Org" }',
        `  hp(r: ${either(subject, other)})`,
      ),
    ],
    [
      'bound to a name',
      withHelpers(
        HP,
        '  org = write crm-[:companies]-> { name: "Org" }',
        `  v = ${either(subject, other)}`,
        '  hp(r: v)',
      ),
    ],
    [
      'through COALESCE',
      withHelpers(
        HP,
        '  org = write crm-[:companies]-> { name: "Org" }',
        `  hp(r: COALESCE(${either(subject, 'NULL')}, ${other}))`,
      ),
    ],
    [
      'a closure handing it back, called in place',
      withHelpers(
        HP,
        '  org = write crm-[:companies]-> { name: "Org" }',
        `  c = () => ${either(subject, other)}`,
        '  hp(r: c())',
      ),
    ],
    [
      'a closure handing it back, bound',
      withHelpers(
        HP,
        '  org = write crm-[:companies]-> { name: "Org" }',
        `  c = () => ${either(subject, other)}`,
        '  w = c()',
        '  hp(r: w)',
      ),
    ],
  ];

  it('version 5: the checker refuses it, with no segment opened', async () => {
    const source = shapes('Acme', '"x"')[1]![1];
    resetRustRunStats();
    const outcome = await runOn(source, 5);
    expect(outcome.error ?? '').toContain('MOV_CALL_ARG_MAYBE_RECORD');
    expect(outcome.writes).toEqual([]);
    expect(rustRunStats).toMatchObject({ segments: 0, endedAtCheck: 1 });
  });
});
