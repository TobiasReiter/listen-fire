/**
 * Safe-parse helper for runtime config blobs stored in the database.
 *
 * The pattern this replaces: 14+ sites across the codebase that call
 * `someConfigParser.parse(row.config)` and throw on invalid input. When
 * the row was hand-edited, provisioned by an older revision of code, or
 * left in an intermediate state, the throw becomes an unhandled rejection
 * (J2 dev-loop crash) or a 500 on the surrounding tRPC call.
 *
 * Pattern: every caller switches to `safeParseConfig(parser, raw, context)`.
 * Result is a discriminated union — callers handle the `{ ok: false }`
 * branch explicitly (return null / skip / surface "invalid" in the UI).
 * The helper logs at warn level with the context tag so an operator can
 * find the offending row from a Render log line.
 *
 * The shape is deliberately the same on the success branch as `z.SafeParseResult`
 * would expose (`.data`) so a future refactor onto `z.safeParse` directly is
 * trivial — but we expose `.config` (named for clarity at the call site) so a
 * grep for `safeParseConfig` always finds every site uniformly.
 *
 * Companion lint at `apps/api/src/lib/__test__/no_unsafe_runtime_config_parse.unit.test.ts`
 * walks the source tree and refuses any new `\w*[Cc]onfig(Parser|Schema)\.parse(`
 * call that isn't explicitly allowlisted (build-time / migration code).
 *
 */

import type { z } from 'zod';

import { logger } from 'movement-engine/public/log';

export type ParsedConfig<T> =
  | { ok: true; config: T }
  | { ok: false; error: string; raw: unknown };

/**
 * Parse a config blob via Zod without throwing. On error, returns a
 * structured failure + logs at warn level with the provided context.
 *
 * The `context` string is the breadcrumb an operator follows to find the
 * offending row — convention is `<surface>:<type>:<id?>` e.g.
 * `getInboundAdapter:CUSTOM_EMAIL:<pi-id>`. Keep it short and grep-friendly.
 */
export function safeParseConfig<T>(
  parser: z.ZodType<T>,
  raw: unknown,
  context: string,
): ParsedConfig<T> {
  const result = parser.safeParse(raw);
  if (result.success) {
    return { ok: true, config: result.data };
  }
  const error = flattenZodError(result.error);
  logger.warn(
    `Invalid runtime config at ${context}: ${error}. Row will be treated as invalid; ` +
      `re-configure the row from the UI to recover.`,
  );
  return { ok: false, error, raw };
}

/**
 * Render a ZodError into a single short string suitable for both a log line
 * and a user-facing banner. Zod's `.format()` is verbose and nested; this is
 * the same data flattened into `<path>: <message>` per leaf, semicolon-joined.
 */
function flattenZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
