import { sweepOpsEvents } from '../lib/ops/retention';
import { logger } from 'movement-engine/public/log';

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
