// Main's language changes from v0.10.2 to v0.10.9 (the main merge's port
// list), each as one program run on both engines. A construct the Rust
// engine does not run is refused on its own parse, by a reason that names it,
// and the run is the TypeScript engine's: the result is that engine's, and
// right. A rule the Rust parser mirrors (the backtick-name escape, a `#`
// comment inside brackets) runs whole in Rust, and agrees.

import { mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import type { MovementTransformInvoker } from '../extraction';
import type { ExtractCallLlmInput, ExtractCallLlmResult } from '../extraction_call';

import { containerAssociation } from '../../translation_graph/adapter';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { makeStablePosition, positionData } from '../../translation_graph/types';
import { makeTestHost } from '../test_host';
import { runFailureCause, runMovement, type MovementRunResult } from '../run';
import { resetRustEvalStats, resetRustRunStats, rustRunStats } from '../rust_stats';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c3');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const companyFields = { name: 'text', stage: 'text' } as const;
const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: companyFields, edges: { notes: { target: 'note', writable: true } } },
    note: { properties: { body: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  writableRoots: {
    company: { fields: companyFields, resultShape: { externalId: 'text', ...companyFields } },
    note: { fields: { body: 'text' }, resultShape: { externalId: 'text', body: 'text' } },
  },
  supportsInPlaceUpdate: true,
};

const credentialArg = [{ name: 'credentials', kind: 'credential' as const, required: true }];
const fetchUrl = staticCatalogFromManifests({ credentials: {} }).plugin('fetch_url');
const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: credentialArg, schema: emailSchema },
    attio: { constructionArgs: credentialArg, schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
  plugins: fetchUrl !== undefined ? { fetch_url: fetchUrl } : {},
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { dealflow_inbox, acme_main } from credentials',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  '',
].join('\n');

const SHAPE = ['node Co {', '  name: <text> "its name"', '}', ''].join('\n');

/** The companies the system lists. */
const LISTED = { 'c-acme': { name: 'Acme', stage: 'lead' }, 'c-beta': { name: 'Beta', stage: 'lead' } };

/** The system, recording what it is asked to write. */
function fakeAttio() {
  const writes: Array<[string, unknown]> = [];
  let minted = 0;
  const adapter: Adapter = {
    adapterType: 'attio',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, input.fieldId) : undefined;
    },
    async getRelated() {
      return Object.entries(LISTED).map(([recordId, data]) => ({
        position: makeStablePosition({ adapterType: 'attio', recordType: 'company', recordId, data }),
      }));
    },
    async createRecord(input) {
      writes.push(['create', input.fields]);
      minted += 1;
      return { adapterType: 'attio', externalId: `attio-${minted}`, data: { ...input.fields } };
    },
    async updateRecord(input) {
      writes.push(['update', { id: input.externalId, ...input.fields }]);
      return { adapterType: 'attio', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
  return { adapter, writes };
}

function fakeEmail(): Adapter {
  return {
    ...fakeAttio().adapter,
    adapterType: 'email',
    getRelated: async () => [],
  };
}

const extractLlm = {
  async call(_input: ExtractCallLlmInput): Promise<ExtractCallLlmResult> {
    const cite = (value: unknown) => ({ value, evidence: { item: 0, quote: 'q' } });
    return {
      parsedJson: { records: [{ name: cite('Acme') }, { name: cite('Beta') }] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    };
  },
};

/** `fetch_url` hands back the url it was given, so a call's argument shows. */
const transforms: MovementTransformInvoker = {
  async invoke({ config }) {
    return { text: `page of ${String(config.url)}` };
  },
};

function webhook(): TriggerEvent {
  return { pipelineInputId: 'pi-rust-language-changes', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'acme.dev' } };
}

interface Outcome {
  writes: Array<[string, unknown]>;
  result?: MovementRunResult;
  error?: string;
}

/** The versions every program compares under: these changes landed before
 *  version 4, and version 4 changed what a match's miss, a write handle's
 *  reads and `write h { … }` mean, so both are held to both engines. */
const COMPARED_VERSIONS: readonly LanguageVersion[] = [3, 4];

async function runOn(engine: 'ts' | 'rust', source: string, languageVersion: LanguageVersion): Promise<Outcome> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = engine;
  const attio = fakeAttio();
  try {
    const result = await runMovement({
      source,
      event: webhook(),
      teamId: TEAM_ID,
      catalog,
      languageVersion,
      host: makeTestHost({
        adapters: { resolve: ({ adapterType }) => (adapterType === 'attio' ? attio.adapter : fakeEmail()) },
        llm: { extractCall: extractLlm, transforms },
      }),
    });
    return { writes: attio.writes, result };
  } catch (error) {
    const cause = runFailureCause(error);
    return { writes: attio.writes, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
}

/** A run's result as a caller reads it, the minted ids aside. */
function seen(outcome: Outcome) {
  return {
    writes: outcome.writes,
    error: outcome.error,
    result: outcome.result?.writes.map((w) => [w.recordType, w.outcome, w.writtenValues]),
    trace: outcome.result?.trace,
  };
}

/** What the Rust engine does with a program: runs it whole, or refuses it
 *  on its own parse for a reason. */
type OnRust = { runsWhole: true } | { refused: string } | { declined: string };

/**
 * `source` on both engines: the TypeScript run leaves `writes`; the Rust run
 * goes as `onRust` says and leaves the same.
 */
async function onBoth(source: string, onRust: OnRust, writes: Array<[string, unknown]>) {
  for (const languageVersion of COMPARED_VERSIONS) {
    const ts = await runOn('ts', source, languageVersion);
    expect(ts.error).toBeUndefined();
    expect(ts.writes).toEqual(writes);
    resetRustEvalStats();
    resetRustRunStats();
    const rust = await runOn('rust', source, languageVersion);
    if ('runsWhole' in onRust) {
      expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 1, notAdmitted: {}, declined: {} });
    } else if ('declined' in onRust) {
      // Past the check, before anything the host keeps.
      expect(rustRunStats).toMatchObject({ routed: 1, admitted: 1, ranWhole: 0, notAdmitted: {}, declined: { [onRust.declined]: 1 } });
    } else {
      expect(rustRunStats).toMatchObject({ routed: 1, admitted: 0, ranWhole: 0, notAdmitted: { [onRust.refused]: 1 }, declined: {}, hostCalls: {} });
    }
    expect(seen(rust)).toEqual(seen(ts));
  }
}

const movement = (...body: string[]) => [PRELUDE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');
const shaped = (...body: string[]) => [PRELUDE, SHAPE, 'movement m(msg: <inbox-[:message]->>) {', ...body, '}'].join('\n');

describe("main's language changes on both engines", () => {
  it('write m.k { … } (39197a6903): refused, the record the member holds updated by the TypeScript engine', async () => {
    await onBoth(
      movement('  crm-[c:companies]-> {', '    held = { k: c }', '    write held.k { stage: "seen" }', '  }'),
      // The map holding the record is held as a value (chunk 7A Task 3); the
      // write from its member is not this engine's yet.
      { refused: 'write_position_member_path' },
      [
        ['update', { id: 'c-acme', stage: 'seen' }],
        ['update', { id: 'c-beta', stage: 'seen' }],
      ],
    );
  });

  it('...m.k in a write (286561483a): run whole in Rust; in a graph literal, refused by name', async () => {
    await onBoth(
      movement('  n = node { name: msg.`subject`, stage: "lead" }', '  held = { k: n }', '  write crm-[:companies]-> { ...held.k, stage: "won" }'),
      // The spread's lines read the record the map holds (chunk 7A Task 3).
      { runsWhole: true },
      [['create', { name: 'Acme', stage: 'won' }]],
    );
    await onBoth(
      movement('  held = { k: { name: msg.`subject` } }', '  g = graph { ...held.k, stage: "new" }', '  write crm-[:companies]-> { name: g.name, stage: g.stage }'),
      { refused: 'node_spread_path' },
      [['create', { name: 'Acme', stage: 'new' }]],
    );
  });

  it('write e { … } on a record the run built (ea1cc6ce92): updated in place, run whole in Rust (chunk 7A Task 2)', async () => {
    await onBoth(
      shaped(
        '  kept = node { entries: <Co> order by arrival }',
        '  a = write kept-[:entries]-> { name: msg.`subject` }',
        '  write kept-[:entries]-> { name: "Beta" }',
        '  write a { name: "${a.name} Inc" }',
        '  kept-[e:entries]-> {',
        '    write e { name: "${e.name}!" }',
        '  }',
        '  kept-[e:entries]-> {',
        '    write crm-[:companies]-> { name: e.name }',
        '  }',
      ),
      { runsWhole: true },
      [
        ['create', { name: 'Acme Inc!' }],
        ['create', { name: 'Beta!' }],
      ],
    );
  });

  it('a collection op inside an expression (71527fa792): refused by name', async () => {
    await onBoth(
      movement('  names = { all: MAP([msg.`subject`, "beta"], (s) => UPPER(s)) }', '  write crm-[:companies]-> { name: COALESCE(AT(names.all, 1), "none") }'),
      { refused: 'expression_closure' },
      [['create', { name: 'BETA' }]],
    );
  });

  it('one binding for a record, held in a list (405b9c0cf2, 5b7c0011dc): refused, the record read through the list', async () => {
    await onBoth(
      movement('  rows = crm-[c:companies]-> {', '    return c', '  }', '  held = { entries: rows }', '  write crm-[:notes]-> { body: "${COUNT(held.entries)} ${FIRST(held.entries).name}" }'),
      // A field read off a fold's answer does not lower here yet: the check
      // passes it, so it is declined after the check (chunk 7A Task 6).
      { declined: 'expression_does_not_lower' },
      [['create', { body: '2 Acme' }]],
    );
  });

  it('m.k.inner (6f95615ae1): the nested key read, run whole in Rust (chunk 7A Task 3)', async () => {
    await onBoth(
      movement('  held = { k: { inner: msg.`subject` } }', '  write crm-[:companies]-> { name: held.k.inner }'),
      { runsWhole: true },
      [['create', { name: 'Acme' }]],
    );
  });

  it('extracted records updated in place (e03887cc3b): refused, updated by the TypeScript engine', async () => {
    await onBoth(
      shaped(
        '  found = extract([msg.`text`], Co)',
        '  MAP(found, (c) => {',
        '    write c { name: "${c.name}!" }',
        '  })',
        '  MAP(found, (c) => {',
        '    write crm-[:companies]-> { name: c.name }',
        '  })',
      ),
      { refused: 'rvalue:extractCall' },
      [
        ['create', { name: 'Acme!' }],
        ['create', { name: 'Beta!' }],
      ],
    );
  });

  it('a call in place as a plugin argument (f623a80f70): refused, the inner call run by the TypeScript engine', async () => {
    await onBoth(
      ['import { fetch_url } from plugins', movement('  page = fetch_url(url: fetch_url(url: msg.`text`))', '  write crm-[:companies]-> { name: COALESCE(page, "none") }')].join('\n'),
      { refused: 'plugin_call_form' },
      [['create', { name: 'page of page of acme.dev' }]],
    );
  });

  it('a plugin called plainly runs whole on the Rust engine (chunk 6A Task 3b), its value bound as its declared output', async () => {
    await onBoth(
      ['import { fetch_url } from plugins', movement('  page = fetch_url(url: msg.`text`)', '  write crm-[:companies]-> { name: COALESCE(page, "none") }')].join('\n'),
      { runsWhole: true },
      [['create', { name: 'page of acme.dev' }]],
    );
  });

  it('EXISTS over a local graph (e03887cc3b): run whole in Rust (chunk 7A Task 2)', async () => {
    await onBoth(
      movement('  g = graph { name: "root", notes: { body: "Brief" } }', '  if EXISTS(g-[:notes]->) {', '    write crm-[:companies]-> { name: "has notes" }', '  }'),
      { runsWhole: true },
      [['create', { name: 'has notes' }]],
    );
  });

  it('a backslash escapes the next character in a backtick name (b2d941dcc4): mirrored, run whole in Rust', async () => {
    await onBoth(
      movement('  `a\\`b` = msg.`subject`', '  `c\\\\d` = "${`a\\`b`}!"', '  write crm-[:companies]-> { name: `c\\\\d` }'),
      { runsWhole: true },
      [['create', { name: 'Acme!' }]],
    );
  });

  it('a body rebinding a file-level value: refused by name, failed by the TypeScript engine', async () => {
    const source = [PRELUDE, 'tag = "x"', 'movement m(msg: <inbox-[:message]->>) {', '  tag = 1', '}'].join('\n');
    for (const languageVersion of COMPARED_VERSIONS) {
      const ts = await runOn('ts', source, languageVersion);
      expect(ts.error).toContain('MOV_SHADOWED_NAME');
      resetRustEvalStats();
      resetRustRunStats();
      const rust = await runOn('rust', source, languageVersion);
      expect(rustRunStats).toMatchObject({ routed: 1, admitted: 0, ranWhole: 0, notAdmitted: { name_shadowed: 1 }, declined: {}, hostCalls: {} });
      expect(seen(rust)).toEqual(seen(ts));
    }
  });

  it('a # comment inside brackets is skipped (2ee8959ba6, 48009be49a, 51bca6a37b): mirrored, run whole in Rust', async () => {
    await onBoth(
      movement('  write crm-[:companies]-> { name: UPPER( # a "quoted" {aside} (', '    msg.`subject`) }'),
      { runsWhole: true },
      [['create', { name: 'ACME' }]],
    );
  });
});
