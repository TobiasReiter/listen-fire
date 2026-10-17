// Imported first by the replay test: some doors read their secrets when their
// module loads (the WhatsApp router), so the environment must be set before
// any of them is imported.

import { SECRETS } from './secrets';

process.env.API_BASE_URL = 'https://golden.example.test';
process.env.SLACK_MOVEMENTS_SIGNING_SECRET = SECRETS.slackApp;
process.env.TELEGRAM_WEBHOOK_SECRET = SECRETS.telegramShared;
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'golden-whatsapp-verify-token';
process.env.WHATSAPP_WEBHOOK_SECRET = SECRETS.whatsappApp;
process.env.RESEND_WEBHOOK_SECRET = SECRETS.resend;
delete process.env.ALLOW_UNSIGNED_WEBHOOKS;

/** The environment each case starts from; cases that change it restore it. */
export const BASELINE_ENV = {
  SLACK_MOVEMENTS_SIGNING_SECRET: SECRETS.slackApp,
  TELEGRAM_WEBHOOK_SECRET: SECRETS.telegramShared,
  RESEND_WEBHOOK_SECRET: SECRETS.resend,
} as const;

export function withEnv(changes: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(changes)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
