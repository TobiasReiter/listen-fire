# ev1-judge (C4) report

Done. The identity judge now lives in `packages/movement-engine/services/identity_judge/`.

- `judge.ts`: `createIdentityJudge({ askModel, jev? })` holds every decision rule (generative threshold 0.5, Jev thresholds 0.7/0.5, 40-candidate Jev bound, fallback and decline posture, budget and configuration errors rethrown, arbitration and metering).
- `prompts/*.md`: the model's system and user prompts and the two Jev questions, read by `prompts.ts` (one-pass `{{{slot}}}` fill).
- apps/api `engine/entity_match.ts` is now only wiring: Anthropic through `execute`, Jev through `lib/jev/client`; same exports, so no caller changed.
- Prompt text reaches `execute` as slot values (not as message text) so a record containing `{{{x}}}` is not re-filled, as before.

Replay: 86 cases recorded from the OLD code first (commit before the move), covering decisions, exact prompts sent, Jev requests, failures reported, boundaries, fallbacks. Fixture `identity_judge/__fixtures__/replay.json`; test `apps/api/.../engine/__test__/identity_judge_replay.unit.test.ts` (re-record with `RECORD_IDENTITY_JUDGE=1`). Replays identical on the new code.

Tests: replay + entity_match + local_write/target_where/unique_by/uniqueness unit sets: 152 passed. Type-check: packages/movement-engine and apps/api (incl. oracle) clean.

Outside the stream: `apps/api/package.json` build script gets one `cp -R` so the prompt files reach `build/node_modules/movement-engine`; one existing assertion in `entity_match.unit.test.ts` now reads the rendered user prompt instead of slot args. No public/ entry created.
