// GET /api/public/capabilities — what this deployment runs, for a frontend that
// must hide what is not here. Derived from the SAME two functions the server-side
// product gate and the identity composition root read, so it can never drift.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

import { capabilitiesFrom, capabilitiesHandler } from '../capabilities';

describe('capabilitiesFrom', () => {
  it('reports every product for the composed deployment', () => {
    expect(capabilitiesFrom({ LISTEN_FIRE_PRINCIPAL: 'core', API_BASE_URL: 'https://listen-fire.example.com' })).toEqual({
      products: ['core', 'valuations', 'automations', 'knowledge', 'asks'],
      identity: 'core',
      mcp: {
        automation: 'https://listen-fire.example.com/api/v1/mcp/automation',
        knowledge: 'https://listen-fire.example.com/api/v1/mcp/knowledge',
        valuations: 'https://listen-fire.example.com/api/v1/mcp/valuations',
      },
    });
  });

  it('reports exactly the mounted products, in declaration order', () => {
    expect(
      capabilitiesFrom({
        LISTEN_FIRE_PRINCIPAL: 'static',
        LISTEN_FIRE_PRODUCTS: 'asks , knowledge',
        API_BASE_URL: 'https://listen-fire.example.com',
      }),
    ).toEqual({
      products: ['knowledge', 'asks'],
      identity: 'static',
      mcp: { knowledge: 'https://listen-fire.example.com/api/v1/mcp/knowledge' },
    });
  });

  it('fails rather than reporting a composition the process could not boot', () => {
    expect(() =>
      capabilitiesFrom({ LISTEN_FIRE_PRINCIPAL: 'static', LISTEN_FIRE_PRODUCTS: 'core' }),
    ).toThrow(/cannot be combined with the `core` product/);
  });

  it('omits an MCP url for a unit that has no connector at all', () => {
    expect(
      capabilitiesFrom({
        LISTEN_FIRE_PRINCIPAL: 'static',
        LISTEN_FIRE_PRODUCTS: 'asks',
        API_BASE_URL: 'https://listen-fire.example.com',
      }).mcp,
    ).toEqual({});
  });

  it('strips a trailing slash from API_BASE_URL before building connector URLs', () => {
    expect(
      capabilitiesFrom({
        LISTEN_FIRE_PRINCIPAL: 'static',
        LISTEN_FIRE_PRODUCTS: 'valuations',
        API_BASE_URL: 'https://listen-fire.example.com/',
      }).mcp,
    ).toEqual({ valuations: 'https://listen-fire.example.com/api/v1/mcp/valuations' });
  });

  it('falls back to a localhost origin outside production when API_BASE_URL is unset', () => {
    expect(
      capabilitiesFrom({ LISTEN_FIRE_PRINCIPAL: 'static', LISTEN_FIRE_PRODUCTS: 'automations' }).mcp,
    ).toEqual({ automation: 'http://localhost:3000/api/v1/mcp/automation' });
  });

  it('refuses to report a connector URL it cannot build in production', () => {
    expect(() =>
      capabilitiesFrom({
        LISTEN_FIRE_PRINCIPAL: 'static',
        LISTEN_FIRE_PRODUCTS: 'automations',
        NODE_ENV: 'production',
      }),
    ).toThrow(/API_BASE_URL environment variable is required/);
  });
});

describe('GET /api/public/capabilities', () => {
  let server: Server;
  let base: string;

  // jest runs this suite with maxWorkers: 1, so an unrestored env mutation
  // here would leak into whichever suite the worker loads next.
  const original = {
    principal: process.env.LISTEN_FIRE_PRINCIPAL,
    products: process.env.LISTEN_FIRE_PRODUCTS,
    apiBaseUrl: process.env.API_BASE_URL,
  };

  beforeAll(async () => {
    process.env.LISTEN_FIRE_PRINCIPAL = 'static';
    process.env.LISTEN_FIRE_PRODUCTS = 'knowledge';
    process.env.API_BASE_URL = 'https://listen-fire.example.com';
    const app = express();
    app.get('/api/public/capabilities', capabilitiesHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (original.principal === undefined) delete process.env.LISTEN_FIRE_PRINCIPAL;
    else process.env.LISTEN_FIRE_PRINCIPAL = original.principal;
    if (original.products === undefined) delete process.env.LISTEN_FIRE_PRODUCTS;
    else process.env.LISTEN_FIRE_PRODUCTS = original.products;
    if (original.apiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = original.apiBaseUrl;
  });

  it('answers the products, the identity mode, and the mounted MCP connector URLs', async () => {
    const res = await fetch(`${base}/api/public/capabilities`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      products: ['knowledge'],
      identity: 'static',
      mcp: { knowledge: 'https://listen-fire.example.com/api/v1/mcp/knowledge' },
    });
  });
});
