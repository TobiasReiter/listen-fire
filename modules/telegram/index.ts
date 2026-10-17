// `@lf/telegram`: Telegram as a module. The host hands it the install's
// credential (a bot token, and optionally a base URL), a fetch, and its record
// of who linked their Telegram account; the module builds a bot client per
// call from them, so a credential edited between calls is read by the next
// one. `ctx.config.baseUrlOverride` (the dev loop's fake) wins over the
// credential's own base URL.
//
// Which bot speaks for an install is the host's call, made in the credential
// it hands over: the platform fills a team's empty credential with its shared
// bot's token; lf hands the user's own.

import { z } from 'zod';

import { defineModule, type ModuleContext } from 'module-kit';

import { TelegramAdapter, type TelegramSources } from './adapter';
import { TELEGRAM_MANIFEST } from './manifest';
import { TelegramClient } from './write';

/** The stored credential: a bot token, blank on a credential that connects
 *  a host's shared bot, and an optional base URL. */
const telegramCredential = z.object({
  botToken: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

/** The adapter's sources over a module context. */
export function telegramSourcesFrom(ctx: ModuleContext): TelegramSources {
  return {
    client: async () => {
      let fields: unknown;
      try {
        fields = await ctx.credential.fields();
      } catch (err) {
        ctx.log.warn('[TelegramAdapter] the install has no readable credential', {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
      const parsed = telegramCredential.safeParse(fields);
      if (!parsed.success) return null;
      const { botToken, baseUrl } = parsed.data;
      if (botToken === undefined || botToken.trim().length === 0) return null;
      return new TelegramClient(botToken, ctx.config.baseUrlOverride ?? baseUrl, ctx.fetch);
    },
    missingClient: (op) =>
      `TelegramAdapter.${op}: no usable Telegram bot token for this install. ` +
      `Connect a Telegram credential holding the bot's token.`,
    identities: ctx.identities,
    ...(ctx.config.credentialRef !== undefined ? { credentialRef: ctx.config.credentialRef } : {}),
    log: ctx.log,
  };
}

export const telegramModule = defineModule({
  kind: 'adapter',
  name: '@lf/telegram',
  manifest: TELEGRAM_MANIFEST,
  // The stored payload the connect form writes: `{ botToken?, baseUrl? }`.
  credentials: [
    {
      name: 'telegram',
      kind: 'static',
      fields: [
        { name: 'botToken', label: 'Bot token (from @BotFather)', optional: true },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
      ],
    },
  ],
  // No `inbound`: a team's own bot is registered with Telegram without a
  // secret token, so its deliveries carry nothing to verify and the door's
  // unguessable URL is the secret (the frozen built-in table says so).
  // Declaring `telegram_secret_token` would refuse every one of them.
  create: (ctx) => new TelegramAdapter(telegramSourcesFrom(ctx)),
});

export default telegramModule;

export * from './adapter';
export * from './handbook_section';
export * from './inbound';
export * from './manifest';
export * from './types';
export * from './write';
