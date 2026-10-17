// The inbound doors' contract suite (movement-engine's inbound/contract.ts)
// against the hosted express doors: the real routers, wired to the suite's
// in-memory stores, served over HTTP. The platform's own store under the same
// routers is pinned by the golden corpus (../__golden__).

import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { INBOUND_CONTRACT_CASES, memoryInboundStores, type InboundContractBackend } from 'movement-engine/public/inbound';

import { createAdapterDoorsRouter } from '../../../interfaces/rest/adapterDoors';
import { createWebhookSyncRouter } from '../../../interfaces/rest/webhookSync';

let server: Server | null = null;
let stores: ReturnType<typeof memoryInboundStores> | null = null;

function close(): Promise<void> {
  const open = server;
  server = null;
  return open ? new Promise((done) => open.close(() => done())) : Promise.resolve();
}

const backend: InboundContractBackend = {
  baseUrl: '',
  async arrange(world) {
    await close();
    stores = memoryInboundStores(world);
    const app = express();
    // Mounted as server.ts mounts them: each door brings its own parser.
    app.use('/api/public/webhook-sync', createWebhookSyncRouter(stores.store, stores.host));
    app.use('/api/public/adapter', createAdapterDoorsRouter(stores.push));
    const listening = createServer(app);
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', () => done()));
    server = listening;
    backend.baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
  },
  async observed() {
    if (!stores) throw new Error('arrange first');
    return stores.observed();
  },
};

afterAll(close);

describe('inbound doors contract — express', () => {
  it.each(INBOUND_CONTRACT_CASES.map((entry) => [entry.name, entry] as const))('%s', async (_name, entry) => {
    await entry.run(backend);
  });
});
