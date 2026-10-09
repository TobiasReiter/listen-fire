// An agent's save is its check: saveAutomation (and editAutomation, which is a
// save) validates first and stores nothing that would not go live, answering
// with the diagnostics instead. Consent — acknowledgeErrors — still ships the
// text as it stands, skipping the refusal.

import type { AuthoringDiagnostic, TeamMovementValidation } from '../../../../services/translation_graph/movement/authoring';

const validateMock = jest.fn<Promise<TeamMovementValidation>, [unknown]>();
jest.mock('../../../../services/translation_graph/movement/authoring', () => ({
  ...jest.requireActual('../../../../services/translation_graph/movement/authoring'),
  validateMovementForTeam: (input: unknown) => validateMock(input),
}));

jest.mock('../../../../services/translation_graph/movement/catalog', () => ({
  describeMovementInstance: jest.fn(),
  movementCatalogSnapshotForTeam: jest.fn(),
  toAgentCatalogView: jest.fn(),
}));

const saveMovementMock = jest.fn();
const getMovementMock = jest.fn();
jest.mock('../../../../services/translation_graph/movement/provision', () => ({
  saveMovement: (...args: unknown[]) => saveMovementMock(...args),
  getMovement: (...args: unknown[]) => getMovementMock(...args),
  deleteMovement: jest.fn(),
  listMovements: jest.fn(),
}));

const getMovementRowMock = jest.fn();
jest.mock('../../../../services/translation_graph/movement/store', () => ({
  getMovementRow: (...args: unknown[]) => getMovementRowMock(...args),
  listMovementRows: jest.fn(),
}));

jest.mock('../../../../services/translation_graph/movement/story_token', () => ({
  storyTokenForMovement: jest.fn(async () => 'tok'),
  storyTokensForMovements: jest.fn(),
  storyUrl: (token: string) => `https://example.com/story/${token}`,
}));

jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: async (team?: string) => team ?? 'home',
    listAccessibleTeams: jest.fn(),
    teamSetForReads: async () => ['home'],
    teamNames: jest.fn(),
  };
});

import type { RequestHandler } from 'express';

import { runWithPrincipal, type Principal } from 'principal';

import { editAutomationHandler, saveMovementHandler } from '../knowledge_agent_tools';

const ACTING: Principal = { teamId: 'home', userId: 'u1', access: 'write', scopes: ['*'], pinnedTeamId: null };

function fakeRes() {
  const res: {
    statusCode?: number;
    body?: Record<string, unknown>;
    status: (n: number) => typeof res;
    json: (b: Record<string, unknown>) => typeof res;
  } = {
    status(n) {
      res.statusCode = n;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
  };
  return res;
}

async function call(handler: RequestHandler, req: { body: unknown; params?: unknown }) {
  const res = fakeRes();
  await runWithPrincipal(ACTING, async () => {
    await handler(req as never, res as never, (() => {}) as never);
  });
  return res;
}

const diagnostic = (severity: AuthoringDiagnostic['severity']): AuthoringDiagnostic => ({
  code: severity === 'error' ? 'MOV_UNKNOWN_FIELD' : 'MOV_COST',
  message: severity === 'error' ? 'no field `Nmae` on People' : 'this extraction runs on every email',
  severity,
  line: 3,
  col: 5,
  endLine: 3,
  endCol: 9,
  sourceLine: '  write crm-[:People]-> { Nmae: m.From }',
});

const validation = (input: { diagnostics?: AuthoringDiagnostic[]; gaps?: TeamMovementValidation['gaps'] }) => {
  const diagnostics = input.diagnostics ?? [];
  return {
    ok: diagnostics.every((d) => d.severity !== 'error'),
    diagnostics,
    listenerCount: 1,
    firedMovements: ['Log'],
    catalogNotes: [],
    gaps: input.gaps ?? [],
  };
};

const shipped = { ok: true, movementId: 'm1', movementName: 'Log', listeners: [], infos: [], catalogNotes: [], warnings: [] };

beforeEach(() => {
  validateMock.mockReset();
  saveMovementMock.mockReset().mockResolvedValue(shipped);
  getMovementMock.mockReset();
  getMovementRowMock.mockReset();
});

describe('saveAutomation validates first', () => {
  it('saves nothing when the text has errors, and answers with the diagnostics', async () => {
    validateMock.mockResolvedValue(validation({ diagnostics: [diagnostic('error'), diagnostic('warning')] }));
    const res = await call(saveMovementHandler, { body: { source: 'broken' } });

    expect(saveMovementMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, saved: false });
    expect(res.body?.diagnostics).toEqual([diagnostic('error'), diagnostic('warning')]);
    expect(res.body?.message).toMatch(/Not saved/);
  });

  it('saves nothing when a system it uses could not be checked', async () => {
    validateMock.mockResolvedValue(validation({ gaps: [{ adapter: 'attio', detail: 'timed out' }] }));
    const res = await call(saveMovementHandler, { body: { source: 'unchecked' } });

    expect(saveMovementMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: false, saved: false });
    expect(res.body?.errors).toEqual(['couldn\'t check this automation against "attio" (timed out)']);
  });

  it('saves clean text, passing along the warnings the check still raised', async () => {
    validateMock.mockResolvedValue(validation({ diagnostics: [diagnostic('warning')] }));
    const res = await call(saveMovementHandler, { body: { source: 'clean', name: 'Log senders' } });

    expect(saveMovementMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'clean', name: 'Log senders' }));
    expect(res.body).toMatchObject({ ok: true, movementId: 'm1', storyUrl: 'https://example.com/story/tok' });
    expect(res.body?.diagnostics).toEqual([diagnostic('warning')]);
  });

  it('answers a clean save with no diagnostics key at all', async () => {
    validateMock.mockResolvedValue(validation({}));
    const res = await call(saveMovementHandler, { body: { source: 'clean' } });
    expect(res.body?.ok).toBe(true);
    expect(res.body).not.toHaveProperty('diagnostics');
  });

  it('checks a re-save under the saved automation\'s language version', async () => {
    getMovementRowMock.mockResolvedValue({ id: 'm1', languageVersion: 1 });
    validateMock.mockResolvedValue(validation({}));
    await call(saveMovementHandler, { body: { source: 'clean', id: 'm1' } });
    expect(validateMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'clean', languageVersion: 1 }));
  });

  it('ships text with errors when the user consented, without the refusal', async () => {
    const res = await call(saveMovementHandler, { body: { source: 'broken', acknowledgeErrors: true } });

    expect(validateMock).not.toHaveBeenCalled();
    expect(saveMovementMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'broken', acknowledgeErrors: true }));
    expect(res.body?.ok).toBe(true);
  });
});

describe('editAutomation is a save, and validates first too', () => {
  beforeEach(() => {
    getMovementMock.mockResolvedValue({ id: 'm1', source: 'write { Name: m.From }' });
    getMovementRowMock.mockResolvedValue({ id: 'm1', languageVersion: 2 });
  });

  it('saves nothing when the spliced text has errors', async () => {
    validateMock.mockResolvedValue(validation({ diagnostics: [diagnostic('error')] }));
    const res = await call(editAutomationHandler, {
      params: { idOrName: 'm1' },
      body: { oldString: 'Name', newString: 'Nmae' },
    });

    expect(validateMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'write { Nmae: m.From }', languageVersion: 2 }),
    );
    expect(saveMovementMock).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: false, saved: false, diagnostics: [diagnostic('error')] });
  });

  it('saves a clean edit', async () => {
    validateMock.mockResolvedValue(validation({}));
    const res = await call(editAutomationHandler, {
      params: { idOrName: 'm1' },
      body: { oldString: 'Name', newString: 'Title' },
    });
    expect(saveMovementMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1', source: 'write { Title: m.From }' }));
    expect(res.body?.ok).toBe(true);
  });
});
