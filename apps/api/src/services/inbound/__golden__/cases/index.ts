import type { GoldenCase } from '../harness';

import { adapterDoorCases, slackActionsCases, slackEventsCases, telegramSharedCases, whatsappCases } from './doors';
import { webhookSyncCases } from './webhook_sync';

export const allCases: GoldenCase[] = [
  ...webhookSyncCases,
  ...adapterDoorCases,
  ...telegramSharedCases,
  ...slackEventsCases,
  ...slackActionsCases,
  ...whatsappCases,
];
