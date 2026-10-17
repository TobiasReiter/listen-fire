import type { GoldenCase } from '../harness';

import { adapterDoorCases, slackActionsCases, slackEventsCases, telegramSharedCases, whatsappCases } from './doors';
import { askCases, callbackCases } from './links';
import { mailgunCases, mailgunEventCases, resendCases, valuationsWebhookCases } from './mail';
import { webhookSyncCases } from './webhook_sync';

export const allCases: GoldenCase[] = [
  ...webhookSyncCases,
  ...adapterDoorCases,
  ...telegramSharedCases,
  ...slackEventsCases,
  ...slackActionsCases,
  ...whatsappCases,
  ...callbackCases,
  ...askCases,
  ...resendCases,
  ...mailgunCases,
  ...mailgunEventCases,
  ...valuationsWebhookCases,
];
