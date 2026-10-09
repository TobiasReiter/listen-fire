// Cleanup poller for `exposed_file` — the short-lived S3-backed file exposures
// minted by `exposeFile` (translation_graph/engine/files/expose.ts). Once a row
// is past its `expires_at`, the bytes should go: we delete the S3 object and the
// row. A periodic work row (`exposed_file_sweep`) on the automations drain.
//
// S3 delete failures leave the row in place so the next sweep retries (the
// presign route already refuses an expired row, so the bytes are unreachable in
// the meantime). The id is the capability — never logged.

import { sql } from 'kysely';

import type { WorkHandler } from '../work/kinds';

import { getAutomationsQb, getQb } from '../../lib/kysely';
import { MINUTE } from '../../constants';
import { logger } from '../logger';
import { services } from '../../adapters/registry';
import { registerWorkKinds } from '../work/drain';

const SWEEP_INTERVAL = 5 * MINUTE;
const SWEEP_BATCH = 100;

async function sweepExpiredFiles(): Promise<void> {
  const expired = await getAutomationsQb(['exposed_file'])
    .selectFrom('exposed_file')
    .select(['id', 'object_uri'])
    .where('expires_at', '<', sql<Date>`now()`)
    .limit(SWEEP_BATCH)
    .execute();

  if (expired.length === 0) return;

  logger.debug(`[exposed-file] sweeping ${expired.length} expired exposure(s)`);

  for (const file of expired) {
    try {
      await services.document.delete(file.object_uri);
    } catch (error) {
      // Leave the row for the next sweep to retry the S3 delete.
      logger.warn('[exposed-file] S3 delete failed — will retry next sweep', { error });
      continue;
    }
    await getAutomationsQb(['exposed_file']).deleteFrom('exposed_file').where('id', '=', file.id).execute();
  }
}

const exposedFileSweepHandler: WorkHandler = {
  async run() {
    await sweepExpiredFiles();
  },
};

// This unit's own periodic kind: the sweep that deletes expired exposures.

declare module '../work/kinds' {
  interface UnitWorkKinds {
    exposed_file_sweep: true;
  }
}

function registerExposedFileWork(): void {
  registerWorkKinds([{ kind: 'exposed_file_sweep', handler: exposedFileSweepHandler, intervalMs: SWEEP_INTERVAL }]);
}

export { SWEEP_INTERVAL as EXPOSED_FILE_SWEEP_INTERVAL, registerExposedFileWork, sweepExpiredFiles };
