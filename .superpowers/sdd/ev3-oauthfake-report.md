# ev3-oauthfake report

Done. A fake OAuth2 provider in fake-channels, the Dropbox auth client pointed at it in the dev loop, and a proven refresh round trip.

## What landed
- `apps/fake-channels/src/routes/oauth.ts` mounted at `/oauth`: authorize (redirect with code), token (authorization_code and refresh_token grants; rotating refresh tokens, replay gives invalid_grant, configurable expiry, rotation on/off, injected failures), protected endpoint, control routes (config, mint, expire, state). `admin` knows service `oauth`.
- Fake Dropbox refuses access tokens the provider has expired (tokens it never issued still pass).
- `DropboxAuthClient` takes `fakeBaseUrl` (authorize and token URLs). `services.ts` supplies it, and a dev client id/secret when none is set, only under `MOCK_OUTPUT_ADAPTERS=true` (the switch Gmail already uses).
- Dev tooling: `pnpm dev:oauth setup`, `pnpm dev:inject oauth-expire | oauth-config`, `pnpm dev:inspect oauth` (helpers in `scripts/dev/lib/dev_oauth.ts`). `dev/loop.sh` now puts `MOCK_OUTPUT_ADAPTERS` in the profile marker so CLI processes see it.
- Docs: "Fake OAuth provider" in `docs/dev-loop.md`; CHANGELOG `### ev3-oauthfake`.

## Proof (dev:loop:agent, then shut down; compose project listen-fire-dev-agent stopped)
setup (real authorize + code exchange), then oauth-expire, then `dev:movement run oauth_refresh_proof`: ok. Exactly one refresh_token call (refresh-1 to access-2/refresh-2); the stored credential's tokens moved to the new pair with expiry +1h; folder created in fake Dropbox. With `--fail-next 1 --fail-with server_error`: the run fails "Dropbox token refresh failed", the refresh token is not spent, the next run refreshes and succeeds.

## Tests
- fake-channels `pnpm test`: 58/58 (4 new in oauth.test.ts).
- api unit `adapters/dropbox`: 24/24 (3 new). `pnpm code:type-check` in apps/api clean (engine boundary 799 = baseline).
- No integration tests run.

## Notes
- The worktree had no `apps/api/.env`; I used `.env.example` (documented inert placeholders, gitignored), not the developer's file. The agent stack's Postgres already held an older team; a leftover Gmail poll trigger logs revoked-token warnings (pre-existing, unrelated).
- Files outside the stream: `dev/loop.sh` (one marker line), `services.ts` (Dropbox block), fake-channels `dropbox.ts`, `admin.ts`, `index.ts`.
