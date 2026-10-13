// `return` ALWAYS leaves the body it is in — whatever its value turned out to
// be, and however the statement finished (inline, or woken after a park). The
// checker narrows the rest of a body on that promise (an early return proves
// its guard's negation below it), so a `return` that went on to the next
// statement would run narrowed code with nothing behind the narrowing.
//
// Before, the engine read "returned" off the value: a `return` whose slot was
// left unset counted as falling through. And a resume steps PAST the statement
// it woke at — so a `return await sleep(…)` ran on from the line after it, and
// a `return` of a fan-out or a race (whose value a resume rebuilds) could not
// be finished at all.

process.env.ENCRYPTION_MASTER_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.ENCRYPTION_SALT_BASE64 ??= Buffer.alloc(16, 2).toString('base64');
process.env.DATABASE_URL_TEST ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';
process.env.DATABASE_URL_TEST_READONLY ??= 'postgresql://unit:unit@localhost:5432/unit-test-unused';

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resumeMovement, runMovement, type ParkSink } from '../run';
import type { ParkedScopeState } from '../serialize';
import { staticCatalogFromManifests } from '../../translation_graph/movement/catalog';
import { type Adapter, type RuntimeCapabilities } from '../../translation_graph/adapter';
import type { TriggerEvent } from '../../translation_graph/triggers/types';
import { positionData } from '../../translation_graph/types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = '00000000-0000-0000-0000-000000000078' as TeamId;

function makeFakeAdapter(adapterType: string) {
  const creates: Array<Record<string, unknown>> = [];
  const adapter: Adapter = {
    adapterType,
    supportedTriggers: [] as never[],
    runtimeCapabilities: (): RuntimeCapabilities => ({
      traversal: { incoming: true, edgeProperties: true },
      resources: true,
    }),
    async listEntryPoints() {
      return [];
    },
    async describe() {
      return null;
    },
    async resolveEntity() {
      return { candidates: [] };
    },
    async getFieldValue({ position, fieldId }) {
      const data = positionData(position) as Record<string, unknown> | undefined;
      return data?.[fieldId];
    },
    async getRelated() {
      return [];
    },
    async createRecord(input) {
      creates.push(input.fields);
      return { adapterType, externalId: `ext-${creates.length}`, data: { ...input.fields } };
    },
    async updateRecord() {
      throw new Error('test: no updates expected');
    },
    async deleteRecord() {
      return {};
    },
  };
  return { adapter, creates };
}

const catalog = staticCatalogFromManifests({
  credentials: { acme_main: { adapters: ['attio'] } },
});

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  '',
  'node Entry {',
  '  name: <text>',
  '  node founder {',
  '    first: <text>',
  '  }',
  '}',
  '',
].join('\n');

/** An in-memory park sink: keeps each timer park's state for the test to wake. */
function makeParkSink() {
  const timers = new Map<string, ParkedScopeState>();
  const sink: ParkSink = {
    async recordJoin() {},
    async commitTimerPark(input) {
      timers.set(input.address, JSON.parse(JSON.stringify(input.state)) as ParkedScopeState);
    },
    async commitAwaitPark() {
      throw new Error('test: no await parks expected');
    },
    async commitSuspension() {
      throw new Error('test: no suspensions expected');
    },
    async commitLimitPause() {},
    async decrementJoin() {
      return { closed: true };
    },
    async persistBranchExport() {},
    async collectBranchExports() {
      return [];
    },
    async cancelSubtrees() {},
  };
  return { sink, timers };
}

function webhookEvent(): TriggerEvent {
  return { pipelineInputId: 'pi-return', adapterType: 'email', triggerType: 'webhook', payload: {} };
}

function harness(source: string) {
  const email = makeFakeAdapter('email');
  const attio = makeFakeAdapter('attio');
  const parks = makeParkSink();
  const input = () => ({
    source: PRELUDE + source,
    movementName: 'intake',
    event: webhookEvent(),
    teamId: TEAM_ID,
    catalog,
    resolveCredentialId: (name: string) => (name === 'acme_main' ? 'cred-attio-1' : undefined),
    resolveAdapter: ({ adapterType }: { adapterType: string }) =>
      adapterType === 'email' ? email.adapter : attio.adapter,
    parkSink: parks.sink,
    dryRun: false,
  });
  return {
    attio,
    parks,
    start: () => runMovement(input()),
    /** Wake every timer, as the timer worker does: step past the sleep. */
    async wakeTimers() {
      const states = [...parks.timers.values()];
      parks.timers.clear();
      for (const state of states) await resumeMovement({ ...input(), state });
    },
  };
}

const names = (creates: Array<Record<string, unknown>>): unknown[] => creates.map((c) => c.name);

describe('a return whose value is absent still returns', () => {
  it('from an if arm: nothing below the if runs', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  none = FILTER(["a"], (x) => x == "b")',
        '  if true {',
        '    return FIRST(none)',
        '  }',
        '  write crm-[:companies]-> { name: "after the return" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(names(h.attio.creates)).toEqual([]);
  });

  it('from a traversal block iteration: the rest of that iteration does not run', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  d = node { entries: <Entry> }',
        '  write d-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  write d-[:entries]-> { unique by (`name`)',
        '    name: "Beta"',
        '  }',
        '  none = FILTER(["a"], (x) => x == "b")',
        '  d-[e:entries]-> {',
        '    if e.`name` == "Acme" {',
        '      return FIRST(none)',
        '    }',
        '    write crm-[:companies]-> { name: e.`name` }',
        '  }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(names(h.attio.creates)).toEqual(['Beta']);
  });
});

describe('a return woken after a park still returns', () => {
  it('at the top of the body: the line after the return never runs', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  write crm-[:companies]-> { name: "before" }',
        '  return await sleep(1h)',
        '  write crm-[:companies]-> { name: "after the return" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual(['before']);
  });

  it('inside an if arm: nothing below the if runs', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  if true {',
        '    return await sleep(1h)',
        '  }',
        '  write crm-[:companies]-> { name: "after the return" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual([]);
  });

  it('inside a called function: the function returns there, and its caller goes on', async () => {
    const h = harness(
      [
        'function wait_then(flag: <boolean>): <boolean> {',
        '  if flag {',
        '    return await sleep(1h)',
        '  }',
        '  write crm-[:companies]-> { name: "after the return" }',
        '  return false',
        '}',
        'movement intake(m: <inbox-[:message]->>) {',
        '  woke = wait_then(true)',
        '  write crm-[:companies]-> { name: "the caller went on" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual(['the caller went on']);
  });

  it('a returned fan-out: once its iterations wake, the body returns', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  d = node { entries: <Entry> }',
        '  write d-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  return d-[e:entries]-> {',
        '    await sleep(1h)',
        '    return e.`name`',
        '  }',
        '  write crm-[:companies]-> { name: "after the return" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual([]);
  });

  it('a returned race: once an arm wakes and wins, the body returns', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  return await race([() => {',
        '    await sleep(1h)',
        '    return "slept"',
        '  }])',
        '  write crm-[:companies]-> { name: "after the return" }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual([]);
  });
});

describe('a woken sleep binds true', () => {
  const marker = (name: string) => `if ${name} == true { write crm-[:companies]-> { name: "${name} is true" } }`;

  it('x = await sleep(…) binds true after a real timer resume', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  x = await sleep(1h)',
        '  if x == true { write crm-[:companies]-> { name: "x is true" } }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual(['x is true']);
  });

  it('a called function that returns await sleep(…) gives the caller true', async () => {
    const h = harness(
      [
        'function wait_then(flag: <boolean>): <boolean> {',
        '  if flag {',
        '    return await sleep(1h)',
        '  }',
        '  return false',
        '}',
        'movement intake(m: <inbox-[:message]->>) {',
        '  woke = wait_then(true)',
        `  ${marker('woke')}`,
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual(['woke is true']);
  });

  it('inside a MAP member, each wake binds true', async () => {
    const h = harness(
      [
        'movement intake(m: <inbox-[:message]->>) {',
        '  d = node { entries: <Entry> }',
        '  write d-[:entries]-> { unique by (`name`)',
        '    name: "Acme"',
        '  }',
        '  d-[e:entries]-> {',
        '    x = await sleep(1h)',
        '    if x == true { write crm-[:companies]-> { name: e.`name` } }',
        '  }',
        '}',
      ].join('\n'),
    );
    await h.start();
    expect(h.parks.timers.size).toBe(1);
    await h.wakeTimers();
    expect(names(h.attio.creates)).toEqual(['Acme']);
  });
});
