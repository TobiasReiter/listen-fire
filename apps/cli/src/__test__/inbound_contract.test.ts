// The inbound doors' contract suite (movement-engine's inbound/contract.ts)
// against `lf serve`: the real server over a real session (SQLite state), its
// doors reading the suite's world from the session's installs. What the
// suite's adapter reads off a delivery is injected in place of an external
// process; the store calls are observed (and the suite's faults injected)
// around lf's own stores.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { WireListenDeclarations } from 'engine-contracts';
import {
  CONTRACT_PUSH_TYPE,
  INBOUND_CONTRACT_CASES,
  type ContractObservations,
  type ContractWorld,
  type InboundAdapter,
  type InboundContractBackend,
} from 'movement-engine/public/inbound';
import type { RunningExternal } from '../externals';
import { initProject, loadProject } from '../project';
import { openSession } from '../runs';
import { serve, type Serving } from '../serve';
import type { LfInboundStores } from '../doors';

/** An install made of the world's data: no process, just what the doors read. */
function runningOf(input: { name: string } & Pick<RunningExternal, 'inbound'> & { auth?: { kind: 'bearer'; field: string } }): RunningExternal {
  return {
    external: {
      dir: '',
      manifest: { name: input.name, kind: 'adapter', protocol: 2, env: {}, ...(input.auth !== undefined ? { auth: input.auth } : {}) },
    },
    baseUrl: '',
    methods: [],
    supportedTriggers: [],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    listen: WireListenDeclarations.parse({}),
    credentials: [],
    ...(input.inbound !== undefined ? { inbound: input.inbound } : {}),
    stop: () => {},
  };
}

/** What the suite's adapter reads off a delivery. */
const Delivery = z.object({
  events: z.array(z.record(z.string(), z.unknown())).optional(),
  wake: z.array(z.string()).optional(),
  checkpoint: z.unknown().optional(),
});
const FailMarked = z.object({ fail: z.literal(true) });

function freshSeen(): ContractObservations {
  return { captured: 0, enqueued: 0, wakes: [], checkpoints: [], notified: 0 };
}

async function backendOnLf(): Promise<{ backend: InboundContractBackend; stop(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lf-inbound-contract-'));
  initProject(dir);
  let world: ContractWorld | undefined;
  let seen = freshSeen();
  const faults = () => world?.faults ?? {};

  const adapter = (adapterType: string): InboundAdapter => ({
    adapterType,
    async preprocessInbound({ raw }) {
      const body = Delivery.parse(raw);
      return { events: (body.events ?? []).map((payload) => ({ payload })), ...(body.checkpoint !== undefined ? { checkpoint: body.checkpoint } : {}) };
    },
    async wakeKeys({ raw }) {
      if (faults().wakeKeys) throw new Error('wake door down');
      return Delivery.parse(raw).wake ?? [];
    },
  });

  const decorate = (stores: LfInboundStores): LfInboundStores => {
    const enqueueWakes: LfInboundStores['store']['enqueueWakes'] = async (input) => {
      if (faults().enqueueWakes) throw new Error('wake queue unavailable');
      await stores.store.enqueueWakes(input);
      seen.wakes.push(...input.keys);
    };
    return {
      store: {
        ...stores.store,
        async capture(input) {
          if (faults().captureMarked && FailMarked.safeParse(input.event.payload).success) {
            throw new Error('receipt store unavailable');
          }
          const captured = await stores.store.capture(input);
          seen.captured += 1;
          return captured;
        },
        async enqueue(input) {
          if (faults().enqueue) throw new Error('work table unavailable');
          await stores.store.enqueue(input);
          seen.enqueued += 1;
        },
        async saveCheckpoint(input) {
          await stores.store.saveCheckpoint(input);
          seen.checkpoints.push(input.checkpoint);
        },
        enqueueWakes,
      },
      push: {
        ...stores.push,
        async capture(input) {
          const captured = await stores.push.capture(input);
          seen.captured += captured.length;
          return captured;
        },
        async enqueue(captured) {
          await stores.push.enqueue(captured);
          seen.enqueued += captured.length;
        },
        enqueueWakes,
      },
    };
  };

  const serving: Serving = await serve((hostUrl) => openSession(loadProject(dir), { ephemeral: true, start: false, hostUrl }), {
    port: 0,
    tickMs: 3_600_000,
    log: () => {},
    inbound: {
      adapterOf: ({ running }) => adapter(running.external.manifest.name),
      decorate,
      onNotify: () => {
        seen.notified += 1;
      },
    },
  });
  const { session } = serving;

  const backend: InboundContractBackend = {
    baseUrl: `http://127.0.0.1:${serving.port}`,
    async arrange(arranged) {
      world = arranged;
      seen = freshSeen();
      session.running.clear();
      session.credentials.clear();
      const externalOf = (providerKey: string) => providerKey.toLowerCase();
      for (const provider of arranged.providers) {
        session.running.set(
          externalOf(provider.providerKey),
          runningOf({
            name: externalOf(provider.providerKey),
            inbound: {
              providerKey: externalOf(provider.providerKey),
              scheme: provider.scheme,
              signatureHeaders: provider.signatureHeaders,
              ...(provider.intercepts !== undefined ? { intercepts: provider.intercepts } : {}),
            },
          }),
        );
      }
      for (const sub of arranged.subscriptions) {
        session.credentials.set(sub.id, {
          name: sub.id,
          external: externalOf(sub.providerKey),
          fields: { webhook_secret: sub.secret },
          origin: { envFields: new Set() },
        });
      }
      for (const [index, install] of arranged.pushInstalls.entries()) {
        if (!session.running.has(install.adapterType)) {
          session.running.set(install.adapterType, runningOf({ name: install.adapterType, auth: { kind: 'bearer', field: 'token' } }));
        }
        const name = `push-${index}`;
        session.credentials.set(name, { name, external: install.adapterType, fields: { token: install.credential }, origin: { envFields: new Set() } });
      }
    },
    async observed() {
      return { ...seen, wakes: [...seen.wakes], checkpoints: [...seen.checkpoints] };
    },
  };
  return { backend, stop: () => serving.stop().then(() => session.close()) };
}

/** lf has no synthetic (test-harness) subscription: every delivery is verified. */
const NOT_ON_LF = new Set(['a synthetic subscription skips the signature and drains before the ack']);

for (const entry of INBOUND_CONTRACT_CASES) {
  test(`inbound doors contract — lf serve: ${entry.name}`, { skip: NOT_ON_LF.has(entry.name) }, async () => {
    const { backend, stop } = await backendOnLf();
    try {
      await entry.run(backend);
    } finally {
      await stop();
    }
  });
}

test('the suite names every case lf skips', () => {
  for (const name of NOT_ON_LF) assert.ok(INBOUND_CONTRACT_CASES.some((c) => c.name === name), `no case "${name}"`);
});
