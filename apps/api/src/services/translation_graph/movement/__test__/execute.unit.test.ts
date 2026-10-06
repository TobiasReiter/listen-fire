// The movement firing executor (./execute.ts) — the seams (runMovement,
// the team catalog, the recorder, the store) are mocked; what's REAL is
// the firing wiring and the failure containment. Covered:
//
//   1. runMovementFiring — a clean run records ONE trigger_run movement
//      step, per-field provenance riding on the result.
//   2. runMovementFiring — a thrown engine error records a FAILED step,
//      finishes the run, and returns the error AS A VALUE (dispatch
//      never sees a throw).
//   3. movementForTrigger — loads the trigger's movement row; null when
//      the row is gone.

// Order-sensitive cycle guard (mirrors run_now.unit.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../knowledge_pipeline/output_v3/schemas');

const recordStep = jest.fn();
const recordMovementStep = jest.fn();
const recordStepFailure = jest.fn();
const finish = jest.fn(async () => undefined);
const ensureStarted = jest.fn(async () => undefined);
const markParked = jest.fn(async () => undefined);
const beginLiveTrace = jest.fn();
const endLiveTrace = jest.fn();

jest.mock('../../runs/trigger_run', () => ({
  TriggerRunRecorder: jest.fn(() => ({
    recordStep,
    recordMovementStep,
    recordStepFailure,
    finish,
    ensureStarted,
    markParked,
    beginLiveTrace,
    endLiveTrace,
    startOpsRun: jest.fn(async () => undefined),
    adoptOpsRun: jest.fn(async () => undefined),
    triggerRunId: 'run-1',
    firedAt: new Date('2026-06-15T09:00:00.000Z'),
  })),
}));

// The production engine host wires the DB, the adapter registry and the model
// clients; the engine is stubbed below, so the host it is handed is inert.
jest.mock('../engine_host', () => ({
  productionEngineHost: jest.fn(() => ({})),
}));
// The run-failure settle hits the DB.
jest.mock('../../../interaction/run_failure', () => ({
  failRunAndCancelRequests: jest.fn(async () => undefined),
}));

// The run cost meter needs no stub: the firing opens one through the `CostMeter`
// seam (D8) and nothing registers a factory here, so it gets the unit's own
// `NoopCostMeter` — always affordable, touching no wallet.

// The LLM-usage context wrapper — pass-through (just run the firing).
jest.mock('../../../../lib/llm_usage', () => ({
  LlmUsageContext: jest.fn(() => ({
    runAsync: <T>(fn: () => Promise<T>) => fn(),
  })),
}));

// The engine module is stubbed (its real import graph needs prisma + the
// adapter registry). `MovementRunFailed` is re-implemented to the same
// contract — a transparent carrier for the partial write ledger — so the
// firing's unwrapping is exercised for real. The class itself is covered in
// movement_engine/__test__/run.unit.test.ts.
jest.mock('../../../movement_engine/run', () => {
  class MovementRunFailed extends Error {
    constructor(
      cause: unknown,
      readonly partial: unknown,
    ) {
      super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
  }
  return {
    MovementRunFailed,
    runFailureCause: (error: unknown) =>
      error instanceof MovementRunFailed ? error.cause : error,
    runMovement: jest.fn(),
    resumeMovement: jest.fn(),
  };
});

jest.mock('../catalog', () => ({
  movementCatalogForTeam: jest.fn(),
}));

jest.mock('../store', () => ({
  getMovementRow: jest.fn(),
}));

// The team-Context seam a background firing runs inside — pass-through here;
// it has its own test (./firing_context.unit.test.ts).
jest.mock('../firing_context', () => ({
  withFiringContext: <T>(_firing: unknown, fn: () => Promise<T>) => fn(),
}));

jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const sendSlackNotification = jest.fn(async () => undefined);
jest.mock('../../../../lib/slack', () => ({
  sendSlackNotification: (...args: unknown[]) => sendSlackNotification(...(args as [])),
}));

// Issue aggregation (layer 2) — a live failure records into its issue
// (which owns the transition-gated alerting); a clean live run resolves.
jest.mock('../issues', () => ({
  recordMovementFailureIssue: jest.fn(async () => 'new'),
  resolveMovementIssues: jest.fn(async () => undefined),
}));

import { movementForTrigger, resumeMovementFiring, runMovementFiring } from '../execute';
import type { TriggerEvent } from '../../triggers/types';
import type { TeamId } from '../../../../generated/kysely/core/Team';

const { runMovement, resumeMovement, MovementRunFailed } = jest.requireMock(
  '../../../movement_engine/run',
) as {
  runMovement: jest.Mock;
  resumeMovement: jest.Mock;
  MovementRunFailed: new (cause: unknown, partial: unknown) => Error;
};
const { movementCatalogForTeam } = jest.requireMock('../catalog') as {
  movementCatalogForTeam: jest.Mock;
};
const { getMovementRow } = jest.requireMock('../store') as {
  getMovementRow: jest.Mock;
};
const { TriggerRunRecorder } = jest.requireMock('../../runs/trigger_run') as {
  TriggerRunRecorder: jest.Mock;
};

const TEAM = 'team-1' as TeamId;

const CLEAN_SOURCE = `import { email, attio } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)

movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}

listen to inbox { key: "intake" } fire intake
`;

const movementRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'mov-1',
  teamId: TEAM,
  name: 'intake_file',
  source: CLEAN_SOURCE,
  description: '',
  triggerId: null,
  currentVersionId: 'mv-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const event: TriggerEvent = {
  pipelineInputId: 'trigger:t-1',
  adapterType: 'email',
  triggerType: 'webhook',
  payload: { subject: 'hi' },
};

const teamCatalog = {
  catalog: { fake: true },
  resolveCredentialId: jest.fn(),
  credentialsByName: {},
  notes: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  movementCatalogForTeam.mockResolvedValue(teamCatalog);
});

describe('runMovementFiring', () => {
  it('records one movement step from MovementRunResult', async () => {
    const runResult = {
      movementName: 'intake',
      writes: [
        {
          bindingName: 'co',
          adapterType: 'attio',
          recordType: 'attio:companies',
          created: true,
          externalId: 'ext-1',
          writtenValues: { name: 'hi' },
          provenance: {
            name: [
              { kind: 'source_field', instance: 'inbox', adapterType: 'email', field: 'subject' },
            ],
          },
        },
      ],
      extractionSites: {},
    };
    runMovement.mockResolvedValue(runResult);

    const outcome = await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow() as never,
      event,
      recordingTriggerType: 'webhook',
    });

    // The catalog is built for the SAVED source and the run gets the
    // movement the listen fires (name convention). Natural-name → internal-id
    // translation is the engine's adapter-layer concern now — no map rides
    // the runMovement input.
    expect(movementCatalogForTeam).toHaveBeenCalledWith(TEAM, { source: CLEAN_SOURCE });
    expect(runMovement).toHaveBeenCalledWith(
      expect.objectContaining({
        source: CLEAN_SOURCE,
        movementName: 'intake',
        event,
        teamId: TEAM,
      }),
    );
    expect(TriggerRunRecorder).toHaveBeenCalledWith(
      // The run pins the movement's current version (P11) — the recorder
      // carries it onto the trigger_run.
      expect.objectContaining({
        triggerId: 't-1',
        triggerType: 'webhook',
        movementVersionId: 'mv-1',
      }),
    );
    expect(recordMovementStep).toHaveBeenCalledWith({
      movementId: 'mov-1',
      movementName: 'intake',
      sourceAdapterType: 'email',
      result: runResult,
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ result: runResult });
  });

  it('contains a thrown engine error: failed step recorded, error returned as a value', async () => {
    runMovement.mockRejectedValue(
      new Error('MOVENG_UNSUPPORTED: nested movement declarations are not supported…'),
    );

    const outcome = await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow() as never,
      event,
      recordingTriggerType: 'webhook',
    });

    expect(recordStepFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        tgId: 'movement:mov-1',
        message: expect.stringContaining('MOVENG_UNSUPPORTED'),
      }),
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain('MOVENG_UNSUPPORTED');
    // A live failure lands in its issue (transition-gated alerting lives
    // there — layer 2), not a per-failure ping.
    const { recordMovementFailureIssue } = jest.requireMock('../issues') as {
      recordMovementFailureIssue: jest.Mock;
    };
    expect(recordMovementFailureIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        movementId: 'mov-1',
        message: expect.stringContaining('MOVENG_UNSUPPORTED'),
      }),
    );
  });

  it('a dryRun (test run) failure stays quiet — no support notification', async () => {
    runMovement.mockRejectedValue(new Error('MOVENG_RUNTIME: boom'));

    const outcome = await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow() as never,
      event,
      recordingTriggerType: 'webhook',
      dryRun: true,
    });

    expect(outcome.error).toContain('MOVENG_RUNTIME');
    const { recordMovementFailureIssue } = jest.requireMock('../issues') as {
      recordMovementFailureIssue: jest.Mock;
    };
    // A dry-run failure records no issue (and therefore alerts nothing).
    expect(recordMovementFailureIssue).not.toHaveBeenCalled();
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });

  it('a run that failed AFTER writing records those writes on the failed step', async () => {
    // The writes already hit the external systems — they must survive into the
    // run record, or the user re-runs and collides with them.
    const partial = {
      movementName: 'intake',
      writes: [
        {
          bindingName: 'co',
          adapterType: 'attio',
          recordType: 'attio:companies',
          created: true,
          committed: true,
          externalId: 'ext-1',
          writtenValues: { name: 'hi' },
          provenance: {},
        },
      ],
      extractionSites: {},
      trace: [],
    };
    const cause = new Error('slack: 422 Unprocessable Entity');
    runMovement.mockRejectedValue(new MovementRunFailed(cause, partial));

    const outcome = await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow() as never,
      event,
      recordingTriggerType: 'webhook',
    });

    expect(recordStepFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        tgId: 'movement:mov-1',
        message: 'slack: 422 Unprocessable Entity',
        partial,
      }),
    );
    // Still a failure, and never a success step.
    expect(recordMovementStep).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toBe('slack: 422 Unprocessable Entity');
  });

  it('a clean run sends no notification', async () => {
    runMovement.mockResolvedValue({
      movementName: 'intake',
      writes: [],
    });
    await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow() as never,
      event,
      recordingTriggerType: 'webhook',
    });
    expect(sendSlackNotification).not.toHaveBeenCalled();
  });
});

describe('a firing runs under the movement\'s language version pin', () => {
  it('hands the engine the saved row\'s pin, not the current version', async () => {
    runMovement.mockResolvedValue({ movementName: 'intake', writes: [], extractionSites: {}, trace: [] });
    await runMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      movementRow: movementRow({ languageVersion: 1 }) as never,
      event,
      recordingTriggerType: 'webhook',
    });
    expect(runMovement).toHaveBeenCalledWith(expect.objectContaining({ languageVersion: 1 }));
  });
});

describe('resumeMovementFiring', () => {
  // The movement row's pin has since advanced to 2; the run started under 1.
  beforeEach(() => {
    getMovementRow.mockResolvedValue(movementRow({ languageVersion: 2 }));
  });

  const resumeInput = {
    teamId: TEAM,
    triggerId: 't-1',
    triggerName: 'movement/intake_file/intake',
    pinnedSource: CLEAN_SOURCE,
    pinnedLanguageVersion: 1,
    movementVersionId: 'mv-1',
    runId: 'run-1' as never,
    movementId: 'mov-1',
    event,
    recordingTriggerType: 'webhook' as const,
    state: { address: 'stmt 0', scopeChain: [] } as never,
  };

  it('resumes under the version the run started with, not the movement\'s pin now', async () => {
    resumeMovement.mockResolvedValue({ movementName: 'intake', writes: [], extractionSites: {}, trace: [] });
    await resumeMovementFiring({ ...resumeInput, answer: true });
    expect(resumeMovement).toHaveBeenCalledWith(expect.objectContaining({ languageVersion: 1 }));
  });

  it('a resumed run that failed after writing records those writes too', async () => {
    const partial = {
      movementName: 'intake',
      writes: [
        {
          bindingName: 'co',
          adapterType: 'attio',
          recordType: 'attio:companies',
          created: true,
          committed: true,
          externalId: 'ext-1',
          writtenValues: { name: 'hi' },
          provenance: {},
        },
      ],
      extractionSites: {},
      trace: [],
    };
    resumeMovement.mockRejectedValue(
      new MovementRunFailed(new Error('attio: 500 Internal Server Error'), partial),
    );

    const outcome = await resumeMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      pinnedSource: CLEAN_SOURCE,
      pinnedLanguageVersion: 2,
      movementVersionId: 'mv-1',
      runId: 'run-1' as never,
      movementId: 'mov-1',
      event,
      recordingTriggerType: 'webhook',
      state: { address: 'stmt 0', scopeChain: [] } as never,
      answer: true,
    });

    expect(recordStepFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        tgId: 'movement:mov-1',
        message: 'attio: 500 Internal Server Error',
        partial,
      }),
    );
    expect(finish).toHaveBeenCalledTimes(1);
    expect(outcome.result).toBeNull();
  });

  it('a resume that failed with no ledger records the failure alone (unchanged)', async () => {
    resumeMovement.mockRejectedValue(new Error('MOVENG_RUNTIME: boom'));

    await resumeMovementFiring({
      teamId: TEAM,
      triggerId: 't-1',
      triggerName: 'movement/intake_file/intake',
      pinnedSource: CLEAN_SOURCE,
      pinnedLanguageVersion: 2,
      movementVersionId: 'mv-1',
      runId: 'run-1' as never,
      movementId: 'mov-1',
      event,
      recordingTriggerType: 'webhook',
      state: { address: 'stmt 0', scopeChain: [] } as never,
    });

    const call = recordStepFailure.mock.calls[0][0] as Record<string, unknown>;
    expect(call.message).toContain('MOVENG_RUNTIME');
    expect(call.partial).toBeUndefined();
  });
});

describe('movementForTrigger', () => {
  it('returns the row; null when it is gone', async () => {
    getMovementRow.mockResolvedValue(movementRow());
    await expect(
      movementForTrigger({ teamId: TEAM, movementId: 'mov-1' }),
    ).resolves.toMatchObject({ id: 'mov-1', name: 'intake_file' });

    getMovementRow.mockResolvedValue(null);
    await expect(
      movementForTrigger({ teamId: TEAM, movementId: 'ghost' }),
    ).resolves.toBeNull();
  });
});
