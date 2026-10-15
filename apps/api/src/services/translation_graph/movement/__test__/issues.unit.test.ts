// movement_issue aggregation — fingerprint stability + alert transitions
// (new / regression / threshold / counted). DB + Slack mocked; the REAL
// fingerprint + transition logic runs.

jest.mock('../../../../lib/kysely', () => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = { movement_issue: [] };
  const matches = (row: Row, wheres: Array<[string, string, unknown]>) =>
    wheres.every(([col, op, val]) => (op === '=' ? row[col] === val : false));
  function builder(table: string, mode: 'select' | 'insert' | 'update') {
    const wheres: Array<[string, string, unknown]> = [];
    let patch: Row = {};
    let values: Row = {};
    const rows = () => tables[table].filter((r) => matches(r, wheres));
    const execute = async (): Promise<Row[]> => {
      if (mode === 'insert') {
        tables[table].push({ id: `iss-${tables[table].length + 1}`, ...values });
        return [];
      }
      if (mode === 'update') {
        for (const row of rows()) Object.assign(row, patch);
        return [];
      }
      return rows().slice();
    };
    const api = {
      where: (col: string, op: string, val: unknown) => (wheres.push([col, op, val]), api),
      select: () => api,
      set: (p: Row) => ((patch = p), api),
      values: (v: Row) => ((values = v), api),
      execute,
      executeTakeFirst: async () => (await execute())[0],
    };
    return api;
  }
  return {
    getKnowledgeQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
    }),
    getAutomationsQb: () => ({
      selectFrom: (t: string) => builder(t, 'select'),
      insertInto: (t: string) => builder(t, 'insert'),
      updateTable: (t: string) => builder(t, 'update'),
    }),
    __tables: tables,
    __reset: () => {
      tables.movement_issue = [];
    },
  };
});

jest.mock('../../../../lib/slack', () => ({ sendSlackNotification: jest.fn(async () => {}) }));
jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { sendSlackNotification } from '../../../../lib/slack';
import {
  fingerprintFailure,
  recordMovementFailureIssue,
  resolveMovementIssues,
  ISSUE_COUNT_ALERT_THRESHOLD,
} from '../issues';

const db = jest.requireMock('../../../../lib/kysely') as {
  __tables: Record<string, Array<Record<string, unknown>>>;
  __reset: () => void;
};
const slackMock = sendSlackNotification as jest.Mock;

const OCCURRENCE = {
  teamId: 'team-1',
  movementId: 'mov-1',
  movementName: 'log_whatsapp_dealflow',
  triggerName: 'movement/dealflow/log',
};

beforeEach(() => {
  db.__reset();
  slackMock.mockClear();
});

describe('fingerprintFailure', () => {
  it('same failure with different ids/lines/quotes → same fingerprint', () => {
    const a = fingerprintFailure(
      "MOVENG_CHECK: 'df' has no edge 'ResearchQuery' (line 15) — id 969f43a2-e534-4e76-b1d3-98a8f11d71f3",
    );
    const b = fingerprintFailure(
      "MOVENG_CHECK: 'df' has no edge 'Research Query!' (line 42) — id 1cdff492-1387-40a3-86e2-64b8056842ce",
    );
    expect(a.failureClass).toBe('MOVENG_CHECK');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('a different failure class → a different issue', () => {
    const check = fingerprintFailure('MOVENG_CHECK: boom');
    const runtime = fingerprintFailure('fetch failed: connection refused');
    expect(runtime.failureClass).toBe('runtime');
    expect(check.fingerprint).not.toBe(runtime.fingerprint);
  });
});

describe('recordMovementFailureIssue transitions', () => {
  it('first occurrence → new issue + alert; repeats count silently', async () => {
    const first = await recordMovementFailureIssue({ ...OCCURRENCE, runId: 'r1', message: 'MOVENG_CHECK: bad edge' });
    expect(first).toBe('new');
    expect(slackMock).toHaveBeenCalledTimes(1);

    const second = await recordMovementFailureIssue({ ...OCCURRENCE, runId: 'r2', message: 'MOVENG_CHECK: bad edge' });
    expect(second).toBe('counted');
    expect(slackMock).toHaveBeenCalledTimes(1); // no per-occurrence alert
    expect(db.__tables.movement_issue).toHaveLength(1);
    expect(db.__tables.movement_issue[0].count).toBe(2);
  });

  it('crossing the threshold alerts once per episode', async () => {
    for (let i = 1; i <= ISSUE_COUNT_ALERT_THRESHOLD + 2; i++) {
      await recordMovementFailureIssue({ ...OCCURRENCE, runId: `r${i}`, message: 'MOVENG_CHECK: bad edge' });
    }
    // 1 new-issue alert + 1 threshold alert; the +2 extra occurrences stay quiet.
    expect(slackMock).toHaveBeenCalledTimes(2);
    expect(slackMock.mock.calls[1][0].text).toContain(`${ISSUE_COUNT_ALERT_THRESHOLD} failures`);
  });

  it('resolve → reopen is a regression alert', async () => {
    await recordMovementFailureIssue({ ...OCCURRENCE, runId: 'r1', message: 'MOVENG_CHECK: bad edge' });
    await resolveMovementIssues({ movementId: OCCURRENCE.movementId });
    expect(db.__tables.movement_issue[0].state).toBe('resolved');

    const outcome = await recordMovementFailureIssue({ ...OCCURRENCE, runId: 'r2', message: 'MOVENG_CHECK: bad edge' });
    expect(outcome).toBe('regression');
    expect(db.__tables.movement_issue[0].state).toBe('open');
    expect(slackMock).toHaveBeenCalledTimes(2); // new + regression
    expect(slackMock.mock.calls[1][0].text).toContain('REGRESSED');
  });
});
