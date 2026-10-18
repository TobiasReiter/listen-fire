// The limiter slot's contract suite (movement-engine services/limiter/
// contract.ts) against lf's built-in limiter, driven over the limiter wire
// (`lf --contract-limiter`), and against a third-party limiter module filling
// a project's limiter slot (`lf --contract-limiter-slot`): lf drives the
// module as a process over the same wire, so a limiter shared by many hosts
// is just another module in the slot.

import { test } from 'node:test';
import { limiterContractCases } from 'movement-engine/services/limiter/contract';
import { RpcLimiter } from 'movement-engine/services/limiter/rpc_limiter';
import { lfBinary } from './lf_bin';
import { limiterModuleProject } from './limiter_module/project';

const bridges = [
  { over: "lf's built-in limiter", args: () => ['--contract-limiter'] },
  { over: 'a limiter module', args: () => ['--contract-limiter-slot', '--dir', limiterModuleProject()] },
];

for (const bridge of bridges) {
  for (const contractCase of limiterContractCases) {
    test(`${bridge.over}: ${contractCase.name}`, async () => {
      const limiter = new RpcLimiter(lfBinary(), bridge.args());
      try {
        await limiter.open();
        await contractCase.run(limiter);
      } finally {
        limiter.close();
      }
    });
  }
}
