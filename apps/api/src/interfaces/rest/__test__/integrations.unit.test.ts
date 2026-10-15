// GET /api/public/integrations — the public integrations grid.
//
// Key assertions:
//   - Returns the adapter's clean `description` field.
//   - Does NOT leak `authoringHints` (agent-only authoring guidance) to the caller.
//   - Hidden adapters (manual, cron, etc.) are excluded.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';
import type { AdapterManifest } from 'movement-engine/services/translation_graph/adapter';

const ATTIO_MANIFEST: AdapterManifest = {
  adapterType: 'attio',
  displayName: 'Attio',
  description: 'The Attio CRM. Read companies, people, deals, and lists.',
  authoringHints: 'For any owner field, @user_email is the best value.',
  supportedTriggers: ['webhook'],
  methods: ['createRecord', 'readRecord'],
  requiredCredentialType: 'ATTIO' as never,
};

const MANUAL_MANIFEST: AdapterManifest = {
  adapterType: 'manual',
  displayName: 'Run now',
  description: 'Trigger a movement on demand.',
  supportedTriggers: [],
  methods: [],
};

jest.mock('../../../services/translation_graph/adapters/registry', () => ({
  listAdapterManifests: () => [ATTIO_MANIFEST, MANUAL_MANIFEST],
  getBrandIcon: (slug: string) =>
    [ATTIO_MANIFEST, MANUAL_MANIFEST].find((m) => m.adapterType === slug)?.vocabulary?.icon ?? null,
}));

jest.mock('../../../lib/kysely', () => ({
  getQb: () => ({
    insertInto: () => ({ values: () => ({ execute: async () => [] }) }),
  }),
  getCoreQb: () => ({
    insertInto: () => ({ values: () => ({ execute: async () => [] }) }),
  }),
}));

import { listIntegrationsHandler } from '../integrations';

describe('GET /api/public/integrations', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get('/integrations', listIntegrationsHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns description but not authoringHints', async () => {
    const res = await fetch(`${base}/integrations`);
    expect(res.status).toBe(200);
    const body = await res.json() as { integrations: Record<string, unknown>[] };
    const attio = body.integrations.find((i) => i.slug === 'attio');
    expect(attio).toBeDefined();
    expect(attio!.description).toBe('The Attio CRM. Read companies, people, deals, and lists.');
    expect(attio).not.toHaveProperty('authoringHints');
  });

  it('excludes hidden adapters (manual, cron, kg, etc.)', async () => {
    const res = await fetch(`${base}/integrations`);
    const body = await res.json() as { integrations: Record<string, unknown>[] };
    const slugs = body.integrations.map((i) => i.slug);
    expect(slugs).not.toContain('manual');
    expect(slugs).toContain('attio');
  });
});
