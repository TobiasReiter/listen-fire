// The loop guard slot's contract suite (movement-engine services/loop_guard/
// contract.ts) against lf's built-in guard, driven over the guard wire
// (`lf --contract-guard`), and against a third-party guard module filling a
// project's loopGuard slot (`lf --contract-guard-slot`): lf drives the module
// as a process over the same wire. The built-in over Postgres, its shared
// memory, is in integration/loop_guard_postgres.test.ts.

import { test } from 'node:test';
import { loopGuardContractCases } from 'movement-engine/services/loop_guard/contract';
import { RpcLoopGuard } from 'movement-engine/services/loop_guard/rpc_loop_guard';
import { lfBinary } from './lf_bin';
import { guardModuleProject } from './loop_guard_module/project';

const bridges = [
  { over: "lf's built-in guard", args: () => ['--contract-guard'] },
  { over: 'a loop guard module', args: () => ['--contract-guard-slot', '--dir', guardModuleProject()] },
];

for (const bridge of bridges) {
  for (const contractCase of loopGuardContractCases) {
    test(`${bridge.over}: ${contractCase.name}`, async () => {
      const guard = new RpcLoopGuard(lfBinary(), bridge.args());
      try {
        await guard.open();
        await contractCase.run(guard);
      } finally {
        guard.close();
      }
    });
  }
}
