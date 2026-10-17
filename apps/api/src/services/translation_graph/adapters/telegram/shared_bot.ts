// The platform's shared Telegram bot: one bot every team may connect instead
// of bringing its own, its token in `TELEGRAM_BOT_TOKEN`. Optional by design —
// unset in most environments, and needed only when a team without its own
// bot sends.

/** The shared bot's token; null when unset or blank. Read off `process.env`
 *  directly (not the throwing `getEnvVar`) so an unset token is null. */
export function builtInBotToken(): string | null {
  const raw = process.env.TELEGRAM_BOT_TOKEN;
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length > 0 ? token : null;
}
