// A run on the Rust engine is checked by the Rust checker: before its segment
// opens (`checkPinnedInRust`) and by the engine itself as the segment starts
// (`nativeCheck`), never by asking its host for the TypeScript's check
// (`check.program`). A run on the TypeScript engine keeps the TypeScript
// checker. The engine's requests are read off the artifact's segments.

import { fromCatalogSnapshot, mockCatalogSnapshot, type InstanceSchema, type LanguageVersion } from 'movement-lang';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import { tenantIdOf } from 'engine-contracts';

import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import { makeTestHost } from '../test_host';
import { runFailureCause, runMovement } from '../run';
import { MovementEngineError } from '../errors';

const asked: string[] = [];
const checkers = { rust: 0, typescript: 0 };

jest.mock('movement-lang', () => {
  const actual = jest.requireActual('movement-lang');
  const note = (step: { ok: boolean; json: unknown }) => {
    const pending = (step.json as { pending?: Array<{ family: string; method: string }> }).pending ?? [];
    for (const request of pending) asked.push(`${request.family}.${request.method}`);
    return step;
  };
  return {
    ...actual,
    checkSourceInRust: (...args: unknown[]) => {
      checkers.rust += 1;
      return actual.checkSourceInRust(...args);
    },
    checkProgramWithLink: (...args: unknown[]) => {
      checkers.typescript += 1;
      return actual.checkProgramWithLink(...args);
    },
    openEngineSegment: () => {
      const segment = actual.openEngineSegment();
      return {
        ...segment,
        start: (inputJson: string) => note(segment.start(inputJson)),
        answer: (id: number, answerJson: string) => note(segment.answer(id, answerJson)),
      };
    },
  };
});

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000c7');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const catalog = mockCatalogSnapshot({
  adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema } },
  credentials: { dealflow_inbox: { adapters: ['email'] } },
});

const email: Adapter = {
  adapterType: 'email',
  supportedTriggers: [],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async () => undefined,
  getRelated: async () => [],
  createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
  updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
  deleteRecord: async () => ({}),
};

const PRELUDE = ['import { email } from adapters', 'import { dealflow_inbox } from credentials', 'inbox = email(credentials: dealflow_inbox)', ''].join('\n');

async function run(languageVersion: LanguageVersion, body: string) {
  asked.length = 0;
  checkers.rust = 0;
  checkers.typescript = 0;
  try {
    const result = await runMovement({
      // Written once, in the spelling versions 1–4 read; a version 5 run reads it as the upgrade tool respells it.
      source: spelledFor(languageVersion, `${PRELUDE}movement m(msg: <inbox-[:message]->>) {\n${body}\n}`, fromCatalogSnapshot(catalog)),
      event: { pipelineInputId: 'pi-native-check', adapterType: 'email', triggerType: 'webhook', payload: {} },
      teamId: TEAM_ID,
      catalog,
      languageVersion,
      host: makeTestHost({ adapters: { resolve: () => email } }),
    });
    return { result };
  } catch (error) {
    return { error };
  }
}

describe('the check a run is held to', () => {
  it('is the Rust checker for a version 5 run: the engine checks natively and never asks its host', async () => {
    const outcome = await run(5, '  x = 1\n  return x');
    expect(outcome).toEqual({ result: expect.objectContaining({ movementName: 'm', writes: [] }) });
    expect(asked).not.toContain('check.program');
    expect(checkers).toEqual({ rust: 1, typescript: 0 });
  });

  it('is the TypeScript checker for a version 4 run, which runs on the TypeScript engine', async () => {
    const outcome = await run(4, '  x = 1\n  return x');
    expect(outcome).toEqual({ result: expect.objectContaining({ movementName: 'm', writes: [] }) });
    expect(checkers).toEqual({ rust: 0, typescript: 1 });
    // No Rust segment at all.
    expect(asked).toEqual([]);
  });

  it('refuses a version 5 program by the Rust checker before the engine starts', async () => {
    const outcome = await run(5, '  return nowhere');
    const cause = runFailureCause(outcome.error);
    expect(cause).toBeInstanceOf(MovementEngineError);
    expect(cause).toMatchObject({ code: 'MOVENG_CHECK', message: expect.stringContaining('MOV_NAME_UNRESOLVED') });
    expect(checkers).toEqual({ rust: 1, typescript: 0 });
    expect(asked).toEqual([]);
  });
});
