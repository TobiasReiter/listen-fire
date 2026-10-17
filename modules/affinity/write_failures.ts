// Where a write Affinity refused, and that its caller walks past, is
// reported. The module logs it; a host with an operations channel (the
// platform's Slack alerts) installs its own reporter once, at load.

import { logger } from 'movement-engine/public/log';

export interface AffinityWriteFailure {
  /** What was being written. */
  kind: 'note' | 'field value';
  /** The ids involved, as one line (`field: 3, entity: 9601, …`). */
  detail: string;
}

export type AffinityWriteFailureReporter = (failure: AffinityWriteFailure) => Promise<void>;

let reporter: AffinityWriteFailureReporter = async (failure) => {
  logger.error(`Affinity refused a ${failure.kind} write`, { detail: failure.detail });
};

/** Install the host's reporter in place of the log line. */
export function reportAffinityWriteFailuresTo(next: AffinityWriteFailureReporter): void {
  reporter = next;
}

export function reportAffinityWriteFailure(failure: AffinityWriteFailure): Promise<void> {
  return reporter(failure);
}
