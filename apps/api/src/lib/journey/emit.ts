import type { OpsEventInput } from '../ops/types';

import { logger } from 'movement-engine/services/logger';
import { emitOpsEvent } from '../ops/emit';

/** Emit a journey feed event without ever throwing into the caller. A lost
 *  notification is survivable; a lost milestone is not — and the milestone is
 *  already committed by the time we get here. */
export async function emitOpsEventSafely(input: OpsEventInput): Promise<void> {
  try {
    await emitOpsEvent(input);
  } catch (e) {
    logger.warn('journey: ops event emit failed (milestone still recorded)', {
      title: input.title,
      error: e,
    });
  }
}
