// The in-memory run host backend held to the contract every backend is held
// to (contract.ts): the live state families and the core's rules over them.

import { runHostContractCases } from '../contract';
import { memoryRunHostStore } from '../memory_store';

const TEAM = '00000000-0000-4000-8000-0000000000a1';

describe('memoryRunHostStore', () => {
  for (const contractCase of runHostContractCases) {
    it(contractCase.name, async () => {
      const store = memoryRunHostStore();
      let runs = 0;
      await contractCase.run({ store, teamId: TEAM, newRun: async () => `run-${++runs}` });
    });
  }
});
