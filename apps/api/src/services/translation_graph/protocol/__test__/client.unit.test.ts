import {
  authHeader,
  postRpc,
  RemoteTransportError,
  RemoteProtocolError,
} from '../client';
import { PROTOCOL_VERSION } from 'engine-contracts';
import type { TeamId } from '../../../../generated/kysely/core/Team';

function mockFetchOnce(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = jest.fn(impl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).fetch = fn;
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (global as any).fetch;
});

describe('authHeader', () => {
  it('bearer strategy → Authorization: Bearer <secret>', () => {
    expect(authHeader({ kind: 'bearer' }, 's3cr3t')).toEqual({
      Authorization: 'Bearer s3cr3t',
    });
  });

  it('shared_secret strategy → default header', () => {
    expect(authHeader({ kind: 'shared_secret' }, 's3cr3t')).toEqual({
      'x-listen-fire-adapter-secret': 's3cr3t',
    });
  });

  it('shared_secret strategy → custom header', () => {
    expect(authHeader({ kind: 'shared_secret', header: 'x-my-secret' }, 's3cr3t')).toEqual({
      'x-my-secret': 's3cr3t',
    });
  });
});

const TEAM = '00000000-0000-4000-8000-0000000000a1' as TeamId;

describe('postRpc', () => {
  it('POSTs the canonical envelope + auth header and returns result on ok:true', async () => {
    const fetchMock = mockFetchOnce(() =>
      jsonResponse({ ok: true, result: { typeId: 'email:message' } }),
    );

    const result = await postRpc({
      baseUrl: 'https://adapter.example/rpc',
      auth: authHeader({ kind: 'bearer' }, 'tok'),
      teamId: TEAM,
      method: 'describe',
      cacheScopeId: 'scope-1',
      params: { typeId: 'email:message' },
    });

    expect(result).toEqual({ typeId: 'email:message' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://adapter.example/rpc');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    // Every call names the team whose install is calling.
    expect((init.headers as Record<string, string>)['x-listen-fire-team']).toBe(TEAM);
    expect(PROTOCOL_VERSION).toBe('2');
    expect(JSON.parse(init.body as string)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      method: 'describe',
      cacheScopeId: 'scope-1',
      params: { typeId: 'email:message' },
    });
  });

  it('throws RemoteProtocolError carrying error.code on ok:false', async () => {
    mockFetchOnce(() =>
      jsonResponse({
        ok: false,
        error: { code: 'method_not_implemented', message: 'no', retryable: false },
      }),
    );

    await expect(
      postRpc({
        baseUrl: 'https://x/rpc',
        auth: {},
        teamId: TEAM,
        method: 'snapshot',
        cacheScopeId: 's',
        params: {},
      }),
    ).rejects.toMatchObject({
      name: 'RemoteProtocolError',
      method: 'snapshot',
      error: { code: 'method_not_implemented' },
    });

    try {
      mockFetchOnce(() =>
        jsonResponse({
          ok: false,
          error: { code: 'boom', message: 'no', retryable: false },
        }),
      );
      await postRpc({ baseUrl: 'https://x/rpc', auth: {}, teamId: TEAM, method: 'm', cacheScopeId: 's', params: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteProtocolError);
      expect((e as RemoteProtocolError).error.code).toBe('boom');
    }
  });

  it('throws RemoteTransportError (retryable, carries status) on non-2xx', async () => {
    mockFetchOnce(() => jsonResponse({ whatever: true }, 503));

    try {
      await postRpc({
        baseUrl: 'https://x/rpc',
        auth: authHeader({ kind: 'shared_secret' }, 'k'),
        teamId: TEAM,
        method: 'poll',
        cacheScopeId: 's',
        params: {},
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteTransportError);
      const te = e as RemoteTransportError;
      expect(te.status).toBe(503);
      expect(te.method).toBe('poll');
      expect(te.retryable).toBe(true);
    }
  });

  it('throws when the response envelope is malformed', async () => {
    mockFetchOnce(() => jsonResponse({ garbage: 1 }));
    await expect(
      postRpc({ baseUrl: 'https://x/rpc', auth: {}, teamId: TEAM, method: 'm', cacheScopeId: 's', params: {} }),
    ).rejects.toThrow();
  });

  it('rejects a bare-array body (no { ok, result } envelope) with a message naming the method', async () => {
    // A homespun adapter that returns a bare array as the whole HTTP body
    // (skipping the envelope) should get a clear, method-scoped error — not a
    // naked "expected object, received array" Zod dump.
    mockFetchOnce(() => jsonResponse([]));
    await expect(
      postRpc({
        baseUrl: 'https://x/rpc',
        auth: {},
        teamId: TEAM,
        method: 'resolveEntity',
        cacheScopeId: 's',
        params: {},
      }),
    ).rejects.toThrow(/resolveEntity/);
  });
});
