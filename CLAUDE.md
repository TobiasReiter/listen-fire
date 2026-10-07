# CLAUDE.md

Working notes for Claude Code in this repository. Personal working style lives
in your user-level `~/.claude/CLAUDE.md`; this file is this repo's specifics.

## Git Workflow

This repo is **trunk-and-worktrees**: commit directly to `main`. Do NOT create
a feature branch before committing routine work — that built-in "branch first on
the default branch" reflex does not apply here. (Isolation, when needed, comes
from git worktrees, not long-lived branches.)

Never amend commits. Always create new commits on top. Pushed commits must never be rewritten.

## The dev loop (verify changes end-to-end)

The stack and fake third-party services let you verify any change without
external dependencies. **Do not read `docs/dev-loop.md` up front** — the cheat
sheet below covers normal use; open the relevant section of
`docs/dev-loop.md` only when a command fails or you need injection/inspection
details.

- `pnpm dev:loop:agent` — **agents boot the stack with this**, not `pnpm dev:loop`. Runs on the 3500-range, because the 3000-range is reserved for a developer's own instance, and has its own docker compose project (`listen-fire-dev-agent`) and its own Postgres/Redis ports (9434/6381), isolated from the developer's stack and from unrelated compose projects on the same host. Still, **only one `dev:loop:agent` stack runs at a time** — parallel implementation jobs must serialize their end-to-end verification. Dev CLIs auto-detect the active stack via `.dev-loop/profiles/<profile>.json`.
- `pnpm dev:seed` — provision the dev-loop team
- `pnpm dev:chat <agent> "<msg>"` — converse with knowledge agents (query/ontology/output)
- `pnpm dev:ui screenshot <path>` — full-page screenshot you can `Read`
- `pnpm dev:inject {raw,attio-webhook,slack-event}` — fire synthetic inbound events
- `pnpm dev:inspect` — read fake-channels state (Attio records, email outbox, …)
- `pnpm dev:graph` — read knowledge graph state · `pnpm dev:link` — bridge KG node to fake external record
- `pnpm ui:test "<brief>"` — full LLM-driven UI exploration with screenshots
- `tail -F .dev-loop/loop.log` — API + dev-server logs
- Zombie stack: `pnpm dev:loop:agent --force-kill` when ports are held by a dead pid

If a change touches an integration or an agent path, verify it through the dev
loop before reporting done. If the tooling can't verify a kind of change,
extend the tooling.

## Language work (movement-lang)

Changing the parser, checker, or type model? **Read
`packages/movement-lang/CLAUDE.md` first.** It carries the two questions that
have repeatedly turned a feature into a deletion — *"what is the simplest way to
solve this using the structure of the graph?"* and *"what would TypeScript
do?"* — plus the corollaries that keep costing us when ignored (structural not
nominal; a magic string is one that's PARSED rather than compared; silent
degradation is the absence of a guarantee, not a weaker one).

## Language versions (breaking changes never break a saved movement)

Every saved movement is pinned to the language version it was written against (an integer with a two-word name, e.g. 1 "Quiet Heron" = the language as of v0.6.0). The pin governs syntax AND semantics, and every layer honours it:

- A breaking change — a spelling retired, a construct's meaning changed, a plugin's output reshaped, an engine rule tightened — lands as a version conditional (`since(v, n)` / `before(v, n)` on the compile or run context's `languageVersion`) at the point of difference in the parser, checker, engine, plugin or adapter. Never a forked parser, never a second engine.
- The old behaviour is proved by the older version's own test corpus run against the current code under that version. Add a version = add its fixtures; remove a version = delete its conditionals and its fixtures.
- Any construct whose meaning changed gets a checker diagnostic under the new version, so "validates clean under the new version" can never hide a silent behaviour change.
- A release names the versions it supports and deprecates. Unsupported: validate and run refuse, loudly. Deprecated: runs, with a warning.
- The pin moves only by the deploy check (auto-advance when clean under the newer version) or an explicit upgrade; never by an ordinary edit.
- The CHANGELOG entry for a break says which version introduces it and why.

Plan: `plans/language-versioning-2026-09-29/` (gitignored, on Henry's machine).

## TypeScript & Code Quality

This project uses TypeScript strictly. Before submitting changes:
1. Run `pnpm code:type-check` to verify no type errors
2. Use the project's custom authorized Prisma client patterns — check existing code for relation names and transaction patterns before writing new queries
3. Never guess at icon names, component props, API parameter shapes, or third-party endpoint/auth details — read the actual type definitions or API docs first
4. Exhaustive branching on enumerable values uses `neverAsAny(value)` from `@/lib/utils/types` in the default case

## Done vs shippable (two-tier verification)

Unit test sets are now seconds (jest compiles without type-checking, on half
the cores: the apps/api movement_engine unit set went from 1,048 s to 27 s) and
a full `pnpm -r code:type-check` is about a minute with caches cleared. Broad
runs still do not block the inner loop:

- **Done** (subagent tier): the change should be right — reasoned through,
  consistent with surrounding code. The ceiling is the scoped test SET for the
  area you touched (`pnpm test:unit --testPathPattern '<area-dir-or-file>'`, or
  `--findRelatedTests <changed-file>` for a shared module), plus the type-check
  of the packages you touched. Integration tests stay on one worker and share
  one test DB, so run them one job at a time.
  Nothing broader blocks a subagent reporting done.

- **Shippable** (top-level tier, batched): before pushing or releasing, run the
  ship gate once — full `pnpm -r code:type-check` and the chunk's test set, in
  parallel (independent processes). End-to-end dev-loop verification also lives
  here, not in the inner loop.
- **Gate failure → dispatch a fix-up agent** with just the failure evidence
  (error output + suspect files), not the builder's history. Bounded retries:
  two fix-up rounds, then escalate to a maintainer with the evidence.
- Local main may carry done-but-ungated commits; the invariant is **never push
  ungated**. Gate per shippable chunk, not per week — batch size is what keeps
  failure attribution cheap.

**Standing prohibitions** (each caused an incident on a prior chunk):
- Never run unscoped `pnpm test:unit` (kills the whole jest cache, runs hundreds of tests).
- Never wait on a jest run by polling its pid in a shell loop — use `run_in_background` and wait for the completion notification.

## CI philosophy + local health check

CI gates only **prod-safety**: typecheck, the bounded smoke set (`api-test`
workflow), and DB schema/audit triggers. Lint and knip are local hygiene, not
CI gates. Full local sweep: `pnpm health` (stamps `HEALTH.md` on green); quick
pre-push hygiene: `pnpm verify:local`. If `HEALTH.md`'s stamp is >7 days old
when starting substantive work, mention it — don't run the sweep unprompted.

## Codegen Workflows

### Database migrations

1. Edit `schema.sql` with the desired changes
2. `pnpm -r schema:generate <migration-name>` — creates migration file
3. Edit the new migration if needed (e.g., data backfills)
4. `pnpm -r schema:apply` — applies migrations, regenerates Prisma + Kysely types (idempotent)

### tRPC types

After changing tRPC routers in `apps/api`, regenerate the shared type package so `apps/web` can see the changes:

```bash
pnpm -r codegen:trpc
```
