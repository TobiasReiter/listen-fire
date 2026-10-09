// Unit tests for the ops-feed integration in TriggerRunRecorder.
// Verifies that live firings open/milestone/close the ops run, and that
// dry-run firings emit nothing (best-effort, never throwing into the firing).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementRunResult } from '../../../movement_engine/run';

import OpsEventType from '../../../../generated/kysely/public/OpsEventType';
import OpsDetailLevel from '../../../../generated/kysely/automations/OpsDetailLevel';
import OpsSeverity from '../../../../generated/kysely/public/OpsSeverity';

// ── Mocks (variables must be `mock`-prefixed for jest-hoist to work) ─────────

const mockStartOpsRun = jest.fn();
const mockAddOpsRunMessage = jest.fn();
const mockCompleteOpsRun = jest.fn();
const mockFailOpsRun = jest.fn();

jest.mock('../../../../lib/ops/run', () => ({
  startOpsRun: mockStartOpsRun,
  addOpsRunMessage: mockAddOpsRunMessage,
  completeOpsRun: mockCompleteOpsRun,
  failOpsRun: mockFailOpsRun,
}));

// getQb — stub a chainable builder that no-ops on the DB insert.
const mockExecute = jest.fn();

jest.mock('../../../../lib/kysely', () => ({
  getQb: () => ({
    insertInto: () => ({
      values: () => ({ execute: mockExecute }),
    }),
  }),
  getCoreQb: () => ({
    insertInto: () => ({
      values: () => ({ execute: mockExecute }),
    }),
  }),
  getAutomationsQb: () => ({
    insertInto: () => ({
      values: () => ({ execute: mockExecute }),
    }),
  }),
}));

// mq — stub publish so the constructor's live-signal doesn't throw.
const mockPublish = jest.fn();

jest.mock('../../../../lib/message_queue', () => ({
  mq: {
    triggerRunActivity: { activity: { publish: mockPublish } },
    triggerRuns: { recorded: { publish: mockPublish } },
  },
}));

// services/context — mocked to keep this a unit test: the real module opens a
// Prisma client and a Kysely pool at import time. Relative from this test:
// __test__ → runs → translation_graph → services → context
jest.mock('../../../context', () => ({
  unsafeCurrentContext: jest.fn().mockReturnValue(null),
  currentContext: jest.fn().mockReturnValue(null),
}));

jest.mock('../../../../lib/journey', () => ({
  recordTeamMilestone: jest.fn().mockResolvedValue(true),
  recordUserMilestone: jest.fn().mockResolvedValue(true),
}));

// ── Module under test (imported AFTER mocks are set up) ──────────────────────

import { TriggerRunRecorder } from '../trigger_run';
import { recordTeamMilestone } from '../../../../lib/journey';

// ── Test helpers ─────────────────────────────────────────────────────────────

const TEAM_ID = 'team-abc' as TeamId;

function makeEvent() {
  return {
    pipelineInputId: 'trigger:test',
    adapterType: 'attio',
    triggerType: 'webhook' as const,
    payload: {},
  };
}

function makeWriteRecord() {
  return {
    bindingName: 'company',
    adapterType: 'kg',
    recordType: 'Company',
    created: true,
    writtenValues: { name: 'Acme' },
    provenance: {},
  };
}

function makeMovementResult(writes: ReturnType<typeof makeWriteRecord>[]): MovementRunResult {
  return {
    movementName: 'Sync Companies',
    writes,
    trace: [],
    extractionSites: {},
  } as unknown as MovementRunResult;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TriggerRunRecorder ops-feed integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartOpsRun.mockResolvedValue('ops-run-1');
    mockAddOpsRunMessage.mockResolvedValue(undefined);
    mockCompleteOpsRun.mockResolvedValue(undefined);
    mockFailOpsRun.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue([]);
    mockPublish.mockResolvedValue(undefined);
  });

  describe('live firing (dryRun: false)', () => {
    it('startOpsRun() calls startOpsRun lib with AUTOMATION type', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerName: 'movement/sync/Sync Companies',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: false,
      });

      await recorder.startOpsRun();

      expect(mockStartOpsRun).toHaveBeenCalledTimes(1);
      expect(mockStartOpsRun).toHaveBeenCalledWith(
        expect.objectContaining({ type: OpsEventType.AUTOMATION }),
      );
      expect(recordTeamMilestone).toHaveBeenCalledWith(TEAM_ID, { milestone: 'first_run' });
    });

    it('recordMovementStep() calls addOpsRunMessage with level medium', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerName: 'movement/sync/Sync Companies',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: false,
      });

      await recorder.startOpsRun();
      recorder.recordMovementStep({
        movementId: 'mv-1',
        movementName: 'Sync Companies',
        result: makeMovementResult([makeWriteRecord()]),
      });

      // Let the void promise settle
      await Promise.resolve();

      expect(mockAddOpsRunMessage).toHaveBeenCalledTimes(1);
      expect(mockAddOpsRunMessage).toHaveBeenCalledWith(
        'ops-run-1',
        expect.objectContaining({ level: OpsDetailLevel.medium }),
      );
    });

    it('recordStepFailure() calls addOpsRunMessage with severity warn', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: false,
      });

      await recorder.startOpsRun();
      recorder.recordStepFailure({
        tgId: 'movement:mv-1',
        message: 'credential missing',
      });

      await Promise.resolve();

      expect(mockAddOpsRunMessage).toHaveBeenCalledWith(
        'ops-run-1',
        expect.objectContaining({
          level: OpsDetailLevel.medium,
          severity: OpsSeverity.warn,
        }),
      );
    });

    it('finish() success calls completeOpsRun', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerName: 'My Automation',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: false,
      });

      await recorder.startOpsRun();
      recorder.recordMovementStep({
        movementId: 'mv-1',
        movementName: 'Sync Companies',
        result: makeMovementResult([makeWriteRecord()]),
      });

      await recorder.finish();

      expect(mockCompleteOpsRun).toHaveBeenCalledTimes(1);
      expect(mockCompleteOpsRun).toHaveBeenCalledWith(
        'ops-run-1',
        expect.objectContaining({ summary: expect.stringContaining('My Automation') }),
      );
      expect(mockFailOpsRun).not.toHaveBeenCalled();
    });

    it('finish() on failed step calls failOpsRun', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: false,
      });

      await recorder.startOpsRun();
      recorder.recordStepFailure({ tgId: 'movement:mv-1', message: 'boom' });

      await recorder.finish();

      expect(mockFailOpsRun).toHaveBeenCalledTimes(1);
      expect(mockFailOpsRun).toHaveBeenCalledWith(
        'ops-run-1',
        expect.objectContaining({ error: 'boom' }),
      );
      expect(mockCompleteOpsRun).not.toHaveBeenCalled();
    });
  });

  describe('dry-run firing (dryRun: true)', () => {
    it('startOpsRun() does not call startOpsRun lib', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: true,
      });

      await recorder.startOpsRun();

      expect(mockStartOpsRun).not.toHaveBeenCalled();
    });

    it('records no team journey milestone for a dry run', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: true,
      });

      await recorder.startOpsRun();

      expect(recordTeamMilestone).not.toHaveBeenCalled();
    });

    it('recordMovementStep() and finish() emit nothing to the ops feed', async () => {
      const recorder = new TriggerRunRecorder({
        teamId: TEAM_ID,
        triggerId: 'trigger-1',
        triggerType: 'webhook',
        triggerEvent: makeEvent(),
        dryRun: true,
      });

      await recorder.startOpsRun();
      recorder.recordMovementStep({
        movementId: 'mv-1',
        movementName: 'Sync Companies',
        result: makeMovementResult([makeWriteRecord()]),
      });
      await recorder.finish();

      await Promise.resolve();

      expect(mockStartOpsRun).not.toHaveBeenCalled();
      expect(mockAddOpsRunMessage).not.toHaveBeenCalled();
      expect(mockCompleteOpsRun).not.toHaveBeenCalled();
      expect(mockFailOpsRun).not.toHaveBeenCalled();
    });
  });
});
