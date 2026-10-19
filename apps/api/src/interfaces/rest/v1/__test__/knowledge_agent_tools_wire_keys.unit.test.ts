// Pins the wire-key → service-arg mapping introduced in a1b4d6588, which
// renamed six REST body keys (handbook/system/connection/automation) while
// leaving the underlying service arg names (bookId/adapter/credentialName/
// movementId) unchanged. Each handler here does the translation by hand — a
// typo in that translation is invisible to the route-registration/mounting
// tests in knowledge_agent_tools.unit.test.ts, so these invoke the REAL
// handlers with a body keyed on the NEW wire name and assert the mocked
// service function received the value under its ORIGINAL argument name.
//
// Sibling file (not an extension of knowledge_agent_tools.unit.test.ts)
// because that file imports `readBook` directly, unmocked, to exercise real
// handbook content — jest.mock is hoisted file-wide, so mocking the service
// modules here would silently break those real-content assertions.

const readBookMock = jest.fn(async () => ({ shelf: [] }));
jest.mock('../../../../lib/knowledge/library', () => ({
  readBook: (...args: unknown[]) => readBookMock(...(args as [])),
}));

const describeMovementInstanceMock = jest.fn(async () => ({ schema: null, notes: [] }));
jest.mock('../../../../services/translation_graph/movement/catalog', () => ({
  describeMovementInstance: (...args: unknown[]) => describeMovementInstanceMock(...(args as [])),
  movementCatalogSnapshotForTeam: jest.fn(),
  toAgentCatalogView: jest.fn(),
}));

const mintConnectLinkMock = jest.fn(async () => ({
  url: 'https://example.com/connect/tok',
  adapter: 'attio',
  displayName: 'Attio',
  serviceType: 'attio',
  connectKind: 'oauth' as const,
  credentialName: 'attio-default',
  expiresAt: new Date('2026-01-01T00:00:00.000Z'),
}));
jest.mock('../../../../services/credentials/connect_link', () => ({
  mintConnectLink: (...args: unknown[]) => mintConnectLinkMock(...(args as [])),
  mintItemPickerLink: jest.fn(),
}));

const runMovementAsyncMock = jest.fn(async () => ({
  ok: true as const,
  runId: 'run-1',
  status: 'running' as const,
  movementName: 'My Movement',
}));
jest.mock('../../../../services/translation_graph/movement/run_now', () => ({
  runMovementAsync: (...args: unknown[]) => runMovementAsyncMock(...(args as [])),
  getMovementRunStatus: jest.fn(),
  listMovementRuns: jest.fn(),
  inspectMovementRun: jest.fn(),
}));

const deleteMovementMock = jest.fn(async () => true);
// Run-by-name resolution: a hit by id wins, otherwise the team's list is
// searched by name. Default: every id resolves to itself.
const getMovementMock = jest.fn(
  async (input: { teamId: string; id: string }): Promise<{ id: string } | null> => ({ id: input.id }),
);
const listMovementsMock = jest.fn(async (_teamId: string): Promise<{ id: string; name: string }[]> => []);
jest.mock('../../../../services/translation_graph/movement/provision', () => ({
  deleteMovement: (...args: unknown[]) => deleteMovementMock(...(args as [])),
  saveMovement: jest.fn(),
  getMovement: (input: { teamId: string; id: string }) => getMovementMock(input),
  listMovements: (teamId: string) => listMovementsMock(teamId),
}));

const upgradeMovementMock = jest.fn(async (_input: unknown) => ({
  status: 'already_current' as const,
  from: { version: 5, name: 'v5' },
  to: { version: 5, name: 'v5' },
  diagnostics: [],
}));
jest.mock('../../../../services/translation_graph/movement/language_upgrade', () => ({
  upgradeMovement: (input: unknown) => upgradeMovementMock(input),
}));

const getByIdMock = jest.fn(async (): Promise<{ email: string; username: string | null }> => ({
  email: 'user@example.com',
  username: null,
}));
jest.mock('../../../../services/user', () => ({
  UserService: { getById: (...args: unknown[]) => getByIdMock(...(args as [])) },
}));

const resolveToolTeamMock = jest.fn(async (team?: string) => team ?? 'home');
const teamSetForReadsMock = jest.fn(async () => ['home']);
jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: (team?: string) => resolveToolTeamMock(team),
    // unused by the handlers under test but imported at module load
    listAccessibleTeams: jest.fn(),
    teamSetForReads: () => teamSetForReadsMock(),
    teamNames: jest.fn(),
  };
});

const abortRunMock = jest.fn();
jest.mock('../../../../services/interaction/operator', () => ({
  abortRun: (...args: unknown[]) => abortRunMock(...(args as [])),
}));

import { runWithPrincipal, type Principal } from 'principal';

import type { RequestHandler } from 'express';

import { MovementEngineError } from 'movement-engine/services/movement_engine/errors';
import {
  readBookHandler,
  describeInstanceHandler,
  connectCredentialHandler,
  runMovementHandler,
  upgradeMovementHandler,
  deleteMovementHandler,
  cancelRunHandler,
} from '../knowledge_agent_tools';

function fakeRes() {
  const res: {
    statusCode?: number;
    body?: unknown;
    contentType?: string;
    status: (n: number) => typeof res;
    json: (b: unknown) => typeof res;
    type: (t: string) => typeof res;
    send: (b: unknown) => typeof res;
  } = {
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    send(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

function fakeReq(body: unknown) {
  return { body } as never;
}

/** The user-anchored connection these handlers assume: a person acting in a
 *  team. Machine principals (no `userId`) are pinned separately in
 *  machine_principal.unit.test.ts. */
const ACTING: Principal = {
  teamId: 'home',
  userId: 'u1',
  access: 'write',
  scopes: ['*'],
  pinnedTeamId: null,
};

/**
 * Invoke a handler the way a request does: inside an ambient Principal. The
 * handlers read identity from the store `principalMiddleware` installs — they
 * used to read a `Context` this file mocked, which is exactly the coupling the
 * carve removed.
 */
function call(handler: RequestHandler, body: unknown, res: ReturnType<typeof fakeRes>) {
  return runWithPrincipal(ACTING, async () => {
    await handler(fakeReq(body), res as never, (() => {}) as never);
  });
}

beforeEach(() => {
  readBookMock.mockClear();
  describeMovementInstanceMock.mockClear();
  mintConnectLinkMock.mockClear();
  runMovementAsyncMock.mockClear();
  deleteMovementMock.mockClear();
  getByIdMock.mockClear();
  resolveToolTeamMock.mockClear();
  teamSetForReadsMock.mockReset().mockResolvedValue(['home']);
  abortRunMock.mockReset();
});

describe('POST /handbook — wire key `handbook` reaches readBook as `bookId`', () => {
  it('passes the body\'s `handbook` value as `bookId`, unmapped fields alongside', async () => {
    const res = fakeRes();
    await call(readBookHandler, { handbook: 'automations', chapter: 'foundations' }, res);

    expect(readBookMock).toHaveBeenCalledWith({
      bookId: 'automations',
      chapter: 'foundations',
      chapters: undefined,
      frontPageInsteadOfChapters: true,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /connections/describe — wire keys `system`/`connection`', () => {
  it('answers compact markdown by default, describing the same instance', async () => {
    const res = fakeRes();
    await call(describeInstanceHandler, { system: 'attio', connection: 'my-attio', team: 'T1' }, res);

    expect(describeMovementInstanceMock).toHaveBeenCalledWith({
      teamId: 'T1',
      adapter: 'attio',
      forceRefresh: true,
      credentialName: 'my-attio',
    });
    expect(res.statusCode).toBe(200);
    expect(res.contentType).toBe('text/markdown');
    expect(res.body).toEqual(expect.stringContaining('### attio'));
  });

  it('passes `system` as `adapter`', async () => {
    const res = fakeRes();
    await call(describeInstanceHandler, { system: 'attio', team: 'T1', detail: 'full' }, res);

    expect(resolveToolTeamMock).toHaveBeenCalledWith('T1');
    expect(describeMovementInstanceMock).toHaveBeenCalledWith({
      teamId: 'T1',
      adapter: 'attio',
      forceRefresh: true,
    });
    expect(res.statusCode).toBe(200);
  });

  it('passes `connection` as `credentialName`', async () => {
    const res = fakeRes();
    await describeInstanceHandler(
      fakeReq({ system: 'attio', connection: 'my-attio', team: 'T1', detail: 'full' }),
      res as never,
      (() => {}) as never,
    );

    expect(describeMovementInstanceMock).toHaveBeenCalledWith({
      teamId: 'T1',
      adapter: 'attio',
      forceRefresh: true,
      credentialName: 'my-attio',
    });
  });

  it('batches an array of systems into one call, describing each and labelling by system', async () => {
    const res = fakeRes();
    await describeInstanceHandler(
      fakeReq({ system: ['slack', 'attio'], team: 'T1', detail: 'full' }),
      res as never,
      (() => {}) as never,
    );

    expect(describeMovementInstanceMock).toHaveBeenCalledWith({
      teamId: 'T1',
      adapter: 'slack',
      forceRefresh: true,
    });
    expect(describeMovementInstanceMock).toHaveBeenCalledWith({
      teamId: 'T1',
      adapter: 'attio',
      forceRefresh: true,
    });
    expect(res.body).toEqual({
      connections: [
        { system: 'slack', schema: null, notes: [] },
        { system: 'attio', schema: null, notes: [] },
      ],
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /connections/connect — wire keys `system`/`connection`', () => {
  it('passes `system` as `adapterSlug`', async () => {
    const res = fakeRes();
    await call(connectCredentialHandler, { system: 'attio', team: 'T1' }, res);

    expect(resolveToolTeamMock).toHaveBeenCalledWith('T1');
    expect(mintConnectLinkMock).toHaveBeenCalledWith({
      teamId: 'T1',
      userId: 'u1',
      adapterSlug: 'attio',
    });
    expect(res.statusCode).toBe(200);
  });

  it('passes `connection` as `credentialName`', async () => {
    const res = fakeRes();
    await call(connectCredentialHandler, { system: 'attio', connection: 'my-attio', team: 'T1' }, res);

    expect(mintConnectLinkMock).toHaveBeenCalledWith({
      teamId: 'T1',
      userId: 'u1',
      adapterSlug: 'attio',
      credentialName: 'my-attio',
    });
  });
});

describe('POST /automations/run — wire key `automation` reaches runMovementAsync as `movementId`', () => {
  it('passes the body\'s `automation` value as `movementId`', async () => {
    const res = fakeRes();
    await call(runMovementHandler, { automation: 'mv-1', team: 'T1' }, res);

    expect(resolveToolTeamMock).toHaveBeenCalledWith('T1');
    expect(runMovementAsyncMock).toHaveBeenCalledWith({
      teamId: 'T1',
      movementId: 'mv-1',
      actor: { email: 'user@example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('resolves an automation name to its id in the resolved team', async () => {
    getMovementMock.mockRejectedValueOnce(new Error('not a uuid'));
    listMovementsMock.mockResolvedValueOnce([
      { id: 'mv-other', name: 'Other' },
      { id: 'mv-7', name: 'Nightly sync' },
    ]);
    const res = fakeRes();
    await call(runMovementHandler, { automation: 'Nightly sync', team: 'T1' }, res);

    expect(listMovementsMock).toHaveBeenCalledWith('T1');
    expect(runMovementAsyncMock).toHaveBeenCalledWith({
      teamId: 'T1',
      movementId: 'mv-7',
      actor: { email: 'user@example.com' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('reports an error and runs nothing when no automation matches', async () => {
    getMovementMock.mockResolvedValueOnce(null);
    const res = fakeRes();
    await call(runMovementHandler, { automation: 'ghost', team: 'T1' }, res);

    expect(runMovementAsyncMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toContain("No automation 'ghost'");
  });
});

describe('POST /automations/upgrade — id or name resolves to the team\'s automation id', () => {
  it('passes an id through', async () => {
    const res = fakeRes();
    await call(upgradeMovementHandler, { automation: 'mv-1', team: 'T1' }, res);
    expect(upgradeMovementMock).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'T1', id: 'mv-1' }));
    expect(res.statusCode).toBe(200);
  });

  it('resolves a name to its id', async () => {
    getMovementMock.mockRejectedValueOnce(new Error('not a uuid'));
    listMovementsMock.mockResolvedValueOnce([{ id: 'mv-7', name: 'Nightly sync' }]);
    const res = fakeRes();
    await call(upgradeMovementHandler, { automation: 'Nightly sync', team: 'T1' }, res);
    expect(upgradeMovementMock).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'T1', id: 'mv-7' }));
  });

  it('reports an error and upgrades nothing for an unknown name', async () => {
    getMovementMock.mockResolvedValueOnce(null);
    upgradeMovementMock.mockClear();
    const res = fakeRes();
    await call(upgradeMovementHandler, { automation: 'ghost', team: 'T1' }, res);
    expect(upgradeMovementMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).toContain("No automation 'ghost'");
  });
});

describe('POST /automations/delete — wire key `automation` reaches deleteMovement as `id`', () => {
  it('passes the body\'s `automation` value as `id`, scoped to the resolved team', async () => {
    const res = fakeRes();
    await call(deleteMovementHandler, { automation: 'mv-9', team: 'T2' }, res);

    expect(resolveToolTeamMock).toHaveBeenCalledWith('T2');
    expect(deleteMovementMock).toHaveBeenCalledWith({ teamId: 'T2', id: 'mv-9' });
    expect(res.body).toEqual({ deleted: true, automation: 'mv-9' });
    expect(res.statusCode).toBe(200);
  });

  it('reports { deleted: false } when the service finds nothing to delete', async () => {
    deleteMovementMock.mockResolvedValueOnce(false);
    const res = fakeRes();
    await call(deleteMovementHandler, { automation: 'missing', team: 'T2' }, res);

    expect(res.body).toEqual({ deleted: false, automation: 'missing' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /automations/cancel-run — searches the accessible teams like run-status/inspectRun', () => {
  it('skips a team that owns nothing, calls abortRun for the team that does', async () => {
    teamSetForReadsMock.mockResolvedValue(['team-a', 'team-b']);
    abortRunMock
      .mockRejectedValueOnce(new MovementEngineError('MOVENG_RUNTIME', 'run r1 not found'))
      .mockResolvedValueOnce({ runId: 'r1' });

    const res = fakeRes();
    await call(cancelRunHandler, { runId: 'r1' }, res);

    expect(abortRunMock).toHaveBeenCalledTimes(2);
    expect(abortRunMock).toHaveBeenNthCalledWith(1, {
      runId: 'r1',
      teamId: 'team-a',
      abortedBy: 'user@example.com',
    });
    expect(abortRunMock).toHaveBeenNthCalledWith(2, {
      runId: 'r1',
      teamId: 'team-b',
      abortedBy: 'user@example.com',
    });
    expect(res.body).toEqual({ runId: 'r1' });
    expect(res.statusCode).toBe(200);
  });

  it('passes the caller\'s username/email as abortedBy', async () => {
    teamSetForReadsMock.mockResolvedValue(['home']);
    getByIdMock.mockResolvedValueOnce({ email: 'op@example.com', username: 'op' });
    abortRunMock.mockResolvedValueOnce({ runId: 'r1' });

    const res = fakeRes();
    await call(cancelRunHandler, { runId: 'r1' }, res);

    expect(abortRunMock).toHaveBeenCalledWith({ runId: 'r1', teamId: 'home', abortedBy: 'op' });
    expect(res.statusCode).toBe(200);
  });

  it('a run not found in any accessible team is a clean 404', async () => {
    teamSetForReadsMock.mockResolvedValue(['team-a']);
    abortRunMock.mockRejectedValueOnce(new MovementEngineError('MOVENG_RUNTIME', 'run r1 not found'));

    const res = fakeRes();
    await call(cancelRunHandler, { runId: 'r1' }, res);

    expect(res.body).toEqual({ error: 'run r1 not found' });
    expect(res.statusCode).toBe(404);
  });
});
