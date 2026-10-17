// Where a field Attio rejected, and that the write retried without, is
// reported. The module logs it (the client logs the retry too); a host with an
// operations channel (the platform's Slack alerts) installs its own reporter
// once, at load.

import { logger } from 'movement-engine/public/log';

export interface AttioFieldRejection {
  /** The write being made (`createRecord(companies)`). */
  context: string;
  fieldKey: string;
  attributeId: string;
  fieldValue: unknown;
  error: string;
}

export type AttioFieldRejectionReporter = (rejection: AttioFieldRejection) => Promise<void>;

let reporter: AttioFieldRejectionReporter = async (rejection) => {
  logger.error(`Attio rejected field "${rejection.fieldKey}" in ${rejection.context}`, { attributeId: rejection.attributeId, error: rejection.error });
};

/** Install the host's reporter in place of the log line. */
export function reportAttioFieldRejectionsTo(next: AttioFieldRejectionReporter): void {
  reporter = next;
}

export function reportAttioFieldRejected(rejection: AttioFieldRejection): Promise<void> {
  return reporter(rejection);
}
