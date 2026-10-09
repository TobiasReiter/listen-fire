// A refusal the funnel defers: the request goes on with no principal, and the
// access gate lets it by, so the surface that claimed it authenticates it.

import { createServer, type Server } from 'node:http';

import express from 'express';

import type { AddressInfo } from 'node:net';

jest.mock('../../../../services/principal', () => ({
  authenticateRequest: jest.fn(async () => ({ ok: false, status: 403, body: '' })),
  completeDoorAuthentication: jest.fn(),
  installContextIdentity: jest.fn(),
}));
jest.mock('../../../journey', () => ({ recordUserMilestone: jest.fn() }));

import { authorisationHandler } from '../../authorisation';
import { authenticationDeferred, createAuthenticationHandler } from '../index';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(createAuthenticationHandler({ doors: [], defer: (req) => req.path.startsWith('/deferred') }));
  app.use(authorisationHandler);
  app.use((req, res) => {
    res.status(200).json({ deferred: authenticationDeferred(req) });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a deferred authentication refusal', () => {
  it('goes on, unauthenticated, past the access gate, when the surface claims it', async () => {
    const res = await fetch(`${baseUrl}/deferred/drain`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deferred: true });
  });

  it('is answered as before everywhere else', async () => {
    const res = await fetch(`${baseUrl}/elsewhere`, { method: 'POST' });
    expect(res.status).toBe(403);
  });
});
