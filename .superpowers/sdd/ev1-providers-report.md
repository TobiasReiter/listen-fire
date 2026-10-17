# ev1-providers (C2) report

Done. Moved apps/api `lib/models/{providers,embedding,image,transcription,chat}` into `packages/model-providers`.

## Shape
- Package takes `env` plus a `ModelHost` ({env, recordUsage, countTokens}); no `process.env` default or read inside. `chatCallFor(name, env)` takes env only.
- Vendor SDKs (`openai`, `@google/genai`, `@anthropic-ai/sdk`, `@anthropic-ai/vertex-sdk`) are optional peers, `require`d on first use (types stay `import type`). Dev-time copies are devDependencies.
- apps/api keeps thin facades at the old paths (`lib/models/{chat.ts,embedding,image,transcription}/index.ts`), so ~12 callers are unchanged. `lib/models/host.ts` binds recordLlmUsage, countTokens, and `hostedEnv` (keeps the old getEnvVar answers: threaded key, then process env, then 'test' outside production; unset in production so the provider throws at first use naming the key).
- lf: pass keys in `env` (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_*) and a `ModelHost`; nothing built lf-side yet.

## Decisions
- Anthropic chat provider moved too (small, same seam); movement-engine's keyed variant untouched.
- Tests moved with code; embedding/image/transcription tests now inject a host (`__test__/test_host.ts`) instead of mocking llm_usage. New apps/api test for hostedEnv.
- Pricing untouched.

## Outside the stream
- apps/api/package.json (dep + build step emitting model-providers), deploy/Dockerfile (COPY manifest), pnpm-lock.yaml (new importer; genai resolution string kept as in main).
- Dockerfile does not COPY movement-engine's package.json (pre-existing; not changed).

## Tests
- packages/model-providers: 6 suites, 147 tests pass; tsc clean; build emit ok.
- apps/api: tsc (incl. oracle) clean; scoped unit set (models, services embedding, file_generation_image, web-search-fallback, file_text) 7 suites, 79 pass.
- No integration tests, no dev loop run.
