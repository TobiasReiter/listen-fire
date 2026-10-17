// What one segment may consume, as a deployment sets it
// (docs/contracts/run-limits.md). The same settings lf reads: the engine's
// limits ride the segment's input; the wall clock is this host's, kept by the
// shim that drives the segment (rust_engine.ts `driveEngine`).
//
// A setting that is set but is not a positive whole number refuses, never
// reads as no limit. Read per segment, as the call depth is, so ops (and
// tests) can move a limit without a restart.

import type { SegmentLimits } from 'engine-contracts';

import { MovementEngineError } from './errors';

interface LimitSetting {
  variable: string;
  key: keyof SegmentLimits;
  what: string;
  example: number;
}

const LIMIT_SETTINGS: readonly LimitSetting[] = [
  { variable: 'MOVEMENT_MAX_STEPS', key: 'maxSteps', what: 'how many statements and expressions one segment may run', example: 10_000_000 },
  { variable: 'MOVEMENT_MAX_TEXT_BYTES', key: 'maxTextBytes', what: 'how many bytes one text may hold', example: 16_777_216 },
  { variable: 'MOVEMENT_MAX_COLLECTION_ITEMS', key: 'maxCollectionItems', what: 'how many members one list or map may hold', example: 1_000_000 },
  { variable: 'MOVEMENT_MAX_RESULT_BYTES', key: 'maxResultBytes', what: "how many bytes one segment's result may be", example: 67_108_864 },
];

export const WALL_CLOCK_ENV_VAR = 'MOVEMENT_MAX_SEGMENT_SECONDS';
export const DEFAULT_WALL_CLOCK_SECONDS = 900;

function positiveWhole(env: NodeJS.ProcessEnv, setting: Pick<LimitSetting, 'variable' | 'what' | 'example'>): number | undefined {
  const raw = env[setting.variable];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${setting.variable}="${raw}" is not a positive whole number. Set it to ${setting.what} (e.g. ${setting.variable}=${setting.example}), or leave it unset for the default.`,
    );
  }
  return n;
}

/** The deployment's engine limits; an unset one is absent (the engine's default). */
export function deploymentSegmentLimits(env: NodeJS.ProcessEnv = process.env): SegmentLimits {
  const limits: SegmentLimits = {};
  for (const setting of LIMIT_SETTINGS) {
    const n = positiveWhole(env, setting);
    if (n !== undefined) limits[setting.key] = n;
  }
  return limits;
}

/** The deployment's wall clock per segment, in seconds. */
export function deploymentWallClockSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return (
    positiveWhole(env, { variable: WALL_CLOCK_ENV_VAR, what: 'how many seconds one segment may take', example: DEFAULT_WALL_CLOCK_SECONDS }) ??
    DEFAULT_WALL_CLOCK_SECONDS
  );
}

/** Boot: refuse a limit set to nonsense, rather than letting the first run find out. */
export function assertSegmentLimitsConfigured(env: NodeJS.ProcessEnv = process.env): void {
  deploymentSegmentLimits(env);
  deploymentWallClockSeconds(env);
}

/** A run's limits: the deployment's, each overridden by the run input's own. */
export function segmentLimitsFor(input: { limits?: SegmentLimits }, env: NodeJS.ProcessEnv = process.env): SegmentLimits {
  return { ...deploymentSegmentLimits(env), ...input.limits };
}

/** The segment ran past its wall clock. */
export function wallClockExceeded(seconds: number): MovementEngineError {
  return new MovementEngineError(
    'MOVENG_LIMIT_WALL_CLOCK',
    `this segment took longer than ${seconds} seconds. The segment was stopped so one movement cannot exhaust its host; raise ${WALL_CLOCK_ENV_VAR} if it legitimately needs longer.`,
    { limit: 'wallClock', seconds },
  );
}
