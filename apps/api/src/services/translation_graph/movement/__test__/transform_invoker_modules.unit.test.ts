// A plugin on a module line runs as its module, in process: the run's
// invoker sends the call there instead of the registry, reads the module's
// answer as a registry plugin's (text, data, records, outcome, its own cost
// under its name), and a throw is no enrichment unless the run is out of
// money. A plugin no module line serves still goes to the registry.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../document', () => ({
  DocumentService: { getById: jest.fn(async () => null) },
}));

import { defineModule } from 'module-kit';
import { BudgetExhausted, NO_BUDGET_LIMIT, costSourceKey } from 'movement-engine/lib/run_cost';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { BuiltinModuleTable } from '../../adapters/builtin_modules';

import { registerTransform } from '../../engine/transforms/registry';
import { transformInvokerFor } from '../transform_invoker';

const calls: Array<{ name: string; config: Record<string, unknown> }> = [];

const shout = defineModule({
  kind: 'plugin',
  name: '@lf/shout',
  credentials: [],
  plugins: [
    {
      priced: true,
      signature: {
        name: 'shout-out',
        params: [{ name: 'text', type: { kind: 'string' }, required: true }],
        dataDependency: 'none',
        additions: {},
        output: { kind: 'value', type: { kind: 'string' } },
      },
    },
  ],
  create: () => ({
    invokePlugin: async ({ name, config }) => {
      calls.push({ name, config });
      if (config.text === 'broke') throw new Error('upstream down');
      if (config.text === 'broke the bank') throw new BudgetExhausted([]);
      return { text: String(config.text).toUpperCase(), data: { loud: true }, outcome: 'shouted', costMicrodollars: 42 };
    },
  }),
});

const TABLE: BuiltinModuleTable = { 'shout-out': { kind: 'plugin', line: 'module', load: () => shout } };
const invoker = transformInvokerFor('team-1' as TeamId, TABLE);
const call = (plugin: string, text: string) =>
  invoker.invoke({ plugin, config: { text }, extractedContext: {}, budget: NO_BUDGET_LIMIT });

describe('a plugin on a module line', () => {
  beforeEach(() => calls.splice(0));

  it('runs as its module, by either spelling, and is read as a registry plugin is', async () => {
    for (const spelling of ['shout-out', 'shout_out']) {
      expect(await call(spelling, 'hi')).toEqual({
        text: 'HI',
        data: { loud: true },
        outcome: 'shouted',
        cost: [{ source: costSourceKey({ kind: 'plugin', name: spelling }), microdollars: 42 }],
      });
    }
    expect(calls.map((c) => c.name)).toEqual(['shout-out', 'shout_out']);
  });

  it('reads a throw as no enrichment, unless the run is out of money', async () => {
    expect(await call('shout-out', 'broke')).toEqual({});
    await expect(call('shout-out', 'broke the bank')).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('leaves a plugin no module line serves to the registry', async () => {
    registerTransform({
      signature: { name: 'whisper', params: [], dataDependency: 'none', additions: {} },
      run: async () => ({ properties: { quiet: true } }),
    } as never);
    expect(await call('whisper', 'hi')).toMatchObject({ data: { quiet: true } });
    expect(calls).toEqual([]);
  });
});
