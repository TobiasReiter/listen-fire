// `GET /api/files/blob/:id` — the exposed-file capability route. Looks the row
// up by its unguessable id, 302-redirects to a presigned S3 URL scoped to the
// isolation prefix. Expired / missing → 410; an object outside the prefix → 500.
//
// The DB (getAutomationsQb) and the S3 provider (services.document) are mocked; the real
// express router runs over an ephemeral server so the path runs end to end.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

interface Row {
  object_uri: string;
  expires_at: Date;
}
const rows = new Map<string, Row>();

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: (_col: string, _op: string, id: string) => ({
          executeTakeFirst: async () => rows.get(id),
        }),
      }),
    }),
  }),
}));

const getDownloadUrlMock = jest.fn(async () => 'https://s3.example/presigned?sig=abc');
jest.mock('../../../adapters/registry', () => ({
  services: { document: { getDownloadUrl: getDownloadUrlMock } },
}));

import { filesRouter } from '../files';

describe('GET /api/files/blob/:id', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use('/api/files', filesRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    rows.clear();
    getDownloadUrlMock.mockClear();
  });

  it('302-redirects a live exposure to its presigned S3 URL', async () => {
    rows.set('blob-1', {
      object_uri: 's3://bucket/exposed/uuid/deck.pdf',
      expires_at: new Date(Date.now() + 60_000),
    });
    const res = await fetch(`${base}/api/files/blob/blob-1`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://s3.example/presigned?sig=abc');
    expect(getDownloadUrlMock).toHaveBeenCalledWith({
      objectUri: 's3://bucket/exposed/uuid/deck.pdf',
    });
  });

  it('410 for an unknown id', async () => {
    const res = await fetch(`${base}/api/files/blob/nope`, { redirect: 'manual' });
    expect(res.status).toBe(410);
  });

  it('410 for an expired exposure', async () => {
    rows.set('blob-old', {
      object_uri: 's3://bucket/exposed/uuid/deck.pdf',
      expires_at: new Date(Date.now() - 1),
    });
    const res = await fetch(`${base}/api/files/blob/blob-old`, { redirect: 'manual' });
    expect(res.status).toBe(410);
    expect(getDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('500 (never presigns) when the object lies outside the isolation prefix', async () => {
    rows.set('blob-bad', {
      object_uri: 's3://bucket/secret/credentials.json',
      expires_at: new Date(Date.now() + 60_000),
    });
    const res = await fetch(`${base}/api/files/blob/blob-bad`, { redirect: 'manual' });
    expect(res.status).toBe(500);
    expect(getDownloadUrlMock).not.toHaveBeenCalled();
  });

  it('502 when presigning the (in-prefix) object fails — no redirect leaks', async () => {
    rows.set('blob-presign-fail', {
      object_uri: 's3://bucket/exposed/uuid/deck.pdf',
      expires_at: new Date(Date.now() + 60_000),
    });
    getDownloadUrlMock.mockRejectedValueOnce(new Error('s3 down'));
    const res = await fetch(`${base}/api/files/blob/blob-presign-fail`, { redirect: 'manual' });
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
  });
});
