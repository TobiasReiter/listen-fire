// The inbound doors' contract suite (movement-engine's inbound/contract.ts)
// against the Rust lf's doors: `lf --contract-doors` serves them
// over HTTP, and the suite's world is arranged, and what the doors did read
// back, over its stdio JSON-RPC bridge (`RpcStoreBackend`'s `call`). The same
// cases the doors are held to.

import { test } from 'node:test';
import { z } from 'zod';
import { INBOUND_CONTRACT_CASES, type InboundContractBackend } from 'movement-engine/public/inbound';
import { RpcStoreBackend } from 'movement-engine/services/run_host/rpc_store';
import { lfBinary } from './lf_bin';

const Observations = z.object({
  captured: z.number(),
  enqueued: z.number(),
  wakes: z.array(z.string()),
  checkpoints: z.array(z.unknown()),
  notified: z.number(),
});

async function backendOnLfHost(): Promise<{ backend: InboundContractBackend; stop(): Promise<void> }> {
  const bridge = new RpcStoreBackend(lfBinary(), ['--contract-doors']);
  const { baseUrl } = await bridge.call('doors.baseUrl', {}, z.object({ baseUrl: z.string() }));
  const backend: InboundContractBackend = {
    baseUrl,
    async arrange(world) {
      await bridge.call('doors.arrange', world, z.null());
    },
    async observed() {
      const seen = await bridge.call('doors.observed', {}, Observations);
      return { ...seen, checkpoints: [...seen.checkpoints] };
    },
  };
  return { backend, stop: () => bridge.close() };
}

/** lf has no synthetic (test-harness) subscription: every delivery is verified. */
const NOT_ON_LF = new Set(['a synthetic subscription skips the signature and drains before the ack']);

for (const entry of INBOUND_CONTRACT_CASES) {
  test(`inbound doors contract — lf: ${entry.name}`, { skip: NOT_ON_LF.has(entry.name) }, async () => {
    const { backend, stop } = await backendOnLfHost();
    try {
      await entry.run(backend);
    } finally {
      await stop();
    }
  });
}
