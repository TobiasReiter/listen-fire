import { sweepOpsEvents } from '../lib/ops/retention';
import { logger } from 'movement-engine/services/logger';

async function main() {
  const deleted = await sweepOpsEvents();
  logger.info(`ops retention sweep complete: ${deleted} deleted`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error('ops retention sweep failed', e);
    process.exit(1);
  });
