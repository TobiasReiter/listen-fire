// The built-in loop guard over Postgres (`url`: the memory every lf worker
// shares, in its own `lf_guard` schema) held to the loop guard contract
// suite, and shown shared: a second guard opened on the same database knows
// what the first recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopGuardContractCases } from 'movement-engine/services/loop_guard/contract';
import { RpcLoopGuard } from 'movement-engine/services/loop_guard/rpc_loop_guard';
import { lfBinary } from '../lf_bin';
import { POSTGRES_URL, psql } from './pg';

for (const contractCase of loopGuardContractCases) {
  test(`over Postgres: ${contractCase.name}`, async () => {
    const guard = new RpcLoopGuard(lfBinary(), ['--contract-guard']);
    try {
      await guard.open({ url: POSTGRES_URL });
      await contractCase.run(guard);
    } finally {
      guard.close();
    }
  });
}

test('over Postgres: another process opened on the database knows a recorded write', async () => {
  const [first, second] = [new RpcLoopGuard(lfBinary(), ['--contract-guard']), new RpcLoopGuard(lfBinary(), ['--contract-guard'])];
  try {
    await first.open({ url: POSTGRES_URL });
    await second.open({ url: POSTGRES_URL });
    const one = { adapter: 'attio', recordType: 'Companies', externalId: `shared-${Date.now()}`, writer: 'listen:sync:stamp' };
    await first.recordWrite({ ...one, record: { name: 'Acme' } });
    assert.deepEqual(await second.isEcho({ adapter: one.adapter, externalId: one.externalId, writer: one.writer }), { read: { recordType: 'Companies' } });
    assert.deepEqual(psql(`select count(*) from lf_guard.write_fingerprint where external_id = '${one.externalId}'`), [['1']]);
  } finally {
    first.close();
    second.close();
  }
});
