/**
 * R chunk (2026-05-28) — trigger-first dispatch lockstep tests.
 *
 * Pins the source-level shape of the routing rewire so future refactors
 * can't silently drop the trigger-first behaviour:
 *
 *   1. `router.ts` exports `dispatchTriggerByIdEvent` and it threads a
 *      `loadTriggerEntriesByTriggerId` call into the engine pipeline.
 *   2. `webhook_sync/handler.ts` calls `findTriggersByKind` ahead of the
 *      legacy pipeline_input scan, and routes hits through
 *      `dispatchTriggerByIdEvent`.
 *   3. `mutation_dispatch.ts` calls `findTriggersByKind` with
 *      `kinds: ['KG_MUTATION']` ahead of the legacy pipeline_output
 *      container scan.
 *   4. `interfaces/rest/private.ts` looks up `findTriggerByInboundKey`
 *      with the inbound-email kinds before falling back to the legacy
 *      `pipeline_input.config.key` scan.
 *   5. `tg_table.ts` exports the three new dispatcher-facing helpers
 *      (`loadTriggerById`, `findTriggerByInboundKey`,
 *      `findTriggersByKind`) alongside the trigger-id-keyed entry
 *      loaders P shipped.
 *   6. Legacy `loadInputTriggerEntries` / `loadOutputTriggerEntries`
 *      shims still exist as no-op return-empty contracts (the brief's
 *      stated fallback path for legacy pipeline_input/output flows).
 *
 * Reads source files directly — same idiom as `materialise-bridge.unit
 * .test.ts`. Avoids spinning up a full DB; the integration claim runs
 * through `dev:loop` end-to-end (see the chunk brief's acceptance gate).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

describe('R — trigger-first dispatch wiring', () => {
  describe('tg_table.ts — new dispatcher helpers', () => {
    const src = READ('services/translation_graph/storage/tg_table.ts');

    it('exports loadTriggerById', () => {
      expect(src).toMatch(/export async function loadTriggerById\(/);
    });

    it('exports findTriggerByInboundKey', () => {
      expect(src).toMatch(/export async function findTriggerByInboundKey\(/);
    });

    it('exports findTriggersByKind', () => {
      expect(src).toMatch(/export async function findTriggersByKind\(/);
    });

    it('N3-C: the legacy pipeline_input/output shims are gone', () => {
      // Pre-N3-C the shims lived as no-ops here. N3-C dropped them
      // entirely — the trigger substrate is the only dispatch surface,
      // so coupling code in tg_table.ts shouldn't reach back into
      // legacy keying.
      expect(src).not.toMatch(/export async function loadInputTriggerEntries\(/);
      expect(src).not.toMatch(/export async function loadOutputTriggerEntries\(/);
    });

    it('findTriggerByInboundKey scopes by team + kinds + config->>key', () => {
      // The inbound resolver MUST scope on team_id AND kind IN (…) AND
      // config->>'key' = ?. Pin all three conditions to prevent a
      // narrowing miss (e.g. dropping team scope on a refactor).
      const fnRange = extractFunction(src, 'findTriggerByInboundKey');
      expect(fnRange).toMatch(/team_id/);
      expect(fnRange).toMatch(/'kind', 'in'/);
      expect(fnRange).toMatch(/config->>'key'/);
    });

    it('findTriggerByInboundKey resolves kind aliases (Model A slugs match legacy kinds)', () => {
      // Model A: `trigger.kind` is the adapter slug ('email'), but the
      // inbound email router still keys lookups by legacy channel kinds
      // ('CUSTOM_EMAIL', …). The resolver must expand each requested kind
      // to slug + siblings — same contract as findTriggersByKind — or a
      // plus-addressed email silently falls through to the default
      // INBOUND_EMAIL input.
      const fnRange = extractFunction(src, 'findTriggerByInboundKey');
      expect(fnRange).toMatch(/resolveAdapterSlug/);
      expect(fnRange).toMatch(/siblingKindsForAdapter/);
    });
  });

  describe('router.ts — dispatchTriggerByIdEvent entry point', () => {
    const src = READ('services/translation_graph/triggers/router.ts');

    it('exports dispatchTriggerByIdEvent', () => {
      expect(src).toMatch(/export async function dispatchTriggerByIdEvent\(/);
    });

    it('fires movement-derived triggers via runMovementFiring', () => {
      // kill-tg (plans/2026-06-14-kill-tg): the TG execution engine and its
      // orchestration walk were retired. The dispatcher now has a single
      // execution path — a movement-derived trigger (movementId !== null)
      // fires through `runMovementFiring`.
      const fnRange = extractFunction(src, 'dispatchTriggerByIdEvent');
      expect(fnRange).toMatch(/triggerRow\.movementId !== null/);
      expect(fnRange).toMatch(/runMovementFiring\(/);
    });

    it('drops a non-movement (legacy TG) trigger — TG dispatch retired', () => {
      // kill-tg: a trigger with no movementId was a legacy TG-orchestration
      // binding. With the executor gone there is nothing to dispatch — the
      // dispatcher returns a `no_movement` drop rather than walking a DAG.
      const fnRange = extractFunction(src, 'dispatchTriggerByIdEvent');
      expect(fnRange).toMatch(/droppedReason: 'no_movement'/);
      // The orchestration walk is gone.
      expect(fnRange).not.toMatch(/runOrchestration\(/);
      expect(src).not.toMatch(/runOrchestrationTgStep/);
    });

    it('does NOT re-dispatch mutation events in process (M-38: the outbox is the only path)', () => {
      // A firing's writes reach dependent automations through the adapter's own
      // inbound event channel — the engine never re-dispatches them itself.
      expect(src).not.toMatch(/dispatchEmittedEvents/);
    });

    it('echo-drops via platformTokenRegistry at entry (Layer 14.4)', () => {
      const fnRange = extractFunction(src, 'dispatchTriggerByIdEvent');
      expect(fnRange).toMatch(/shouldDropAsNativeEcho\(/);
    });

    it('receipt notification is handled by the ops feed run (notifyTriggerReceivedEvent removed)', () => {
      // 2026-06-26: the Slack receipt heartbeat was replaced by the ops feed
      // run opened via TriggerRunRecorder.startOpsRun() — the recorder's run
      // open is the "received" signal now, so the legacy notifyTriggerReceivedEvent
      // function and its call site have been removed from router.ts.
      expect(src).not.toMatch(/notifyTriggerReceivedEvent/);
    });
  });

  describe('webhook_sync/handler.ts — trigger-first webhook dispatch', () => {
    // Capture-then-ack (2026-07-30) moved the trigger query + receipt store
    // into `captureProviderTriggerEvents` — the pre-ack half — leaving
    // `dispatchToProviderTriggers` as the combined call the Listen-Fire Slack
    // events route uses, which queues a work row per receipt. The guarantees
    // below are unchanged; they just live one function down.
    const src = READ('services/webhook_sync/handler.ts');

    it('imports findTriggersByKind', () => {
      expect(src).toMatch(/findTriggersByKind/);
    });

    it('captures via the trigger substrate — the only dispatch entry', () => {
      // N3-C: the trigger-substrate path is the only dispatch entry.
      // The legacy `loadInputTriggerEntriesByPipelineInputIds` scan
      // was retired; the file now declares an inert local stub so the
      // legacy webhook path keeps compiling as a structural no-op.
      expect(src.indexOf('captureProviderTriggerEvents(')).toBeGreaterThan(-1);
      // …and the inline doors' combined entry still routes through it.
      const fnRange = extractFunction(src, 'dispatchToProviderTriggers');
      expect(fnRange).toMatch(/captureProviderTriggerEvents\(/);
      expect(fnRange).toMatch(/enqueueCapturedEvents\(/);
    });

    it('capture scopes triggers by the subscription provider key', () => {
      const fnRange = extractFunction(src, 'captureProviderTriggerEvents');
      expect(fnRange).toMatch(/findTriggersByKind\(\{/);
      expect(fnRange).toMatch(/kinds:\s*\[subscription\.provider\]/);
    });

    it('capture honours credentials_id scope when set on the trigger', () => {
      const fnRange = extractFunction(src, 'captureProviderTriggerEvents');
      // The scope guard is phrased negatively (skip when the trigger is scoped
      // to a credential that doesn't match this subscription's).
      expect(fnRange).toMatch(/credentialsId != null/);
      expect(fnRange).toMatch(/credentialsId !== subscription\.credentials_id/);
    });
  });

  describe('mutation_dispatch.ts — KG_MUTATION trigger-first dispatch', () => {
    const src = READ('services/translation_graph/triggers/mutation_dispatch.ts');

    it('dispatchKgMutationTriggers is the only mutation dispatch path', () => {
      // N3-C: the legacy `loadPipelineOutputContainers` walk + the
      // pipeline_output-keyed container loop were retired. The
      // trigger-substrate dispatch (KG_MUTATION trigger rows) is the
      // single surface for mutation events.
      const triggerCallIdx = src.indexOf('dispatchKgMutationTriggers({');
      expect(triggerCallIdx).toBeGreaterThan(-1);
      expect(src).not.toMatch(/loadPipelineOutputContainers\(/);
    });

    it('queries triggers with kind=KG_MUTATION', () => {
      const fnRange = extractFunction(src, 'dispatchKgMutationTriggers');
      expect(fnRange).toMatch(/kinds:\s*\['KG_MUTATION'\]/);
    });

    it("matches event change_kind against the listen's `events:` vocabulary", () => {
      // D40: a listen selects change kinds in the platform's uniform `record.*`
      // currency, the same one attio and airtable use; the engine event carries
      // the shorter verb form ('create'/'update'/'delete'). Pin the mapping so a
      // refactor can't silently desync the two.
      expect(src).toMatch(/CHANGE_KIND_TO_EVENT/);
      expect(src).toMatch(/create:\s*'record\.created'/);
      expect(src).toMatch(/update:\s*'record\.updated'/);
      expect(src).toMatch(/delete:\s*'record\.deleted'/);
    });

    it('still reads the participle vocabulary pre-D40 rows persist', () => {
      // A trigger provisioned before D40 holds the store's own currency. It
      // keeps filtering exactly as it did until its movement is re-saved.
      expect(src).toMatch(/CHANGE_KIND_TO_PARTICIPLE/);
      expect(src).toMatch(/create:\s*'created'/);
    });

    it('filters triggers by the watched type — by name, and by id on older rows', () => {
      const fnRange = extractFunction(src, 'mutationTriggerConfigMatches');
      expect(fnRange).toMatch(/node_type_id/);
      expect(fnRange).toMatch(/event\.nodeTypeId/);
      expect(fnRange).toMatch(/surface\.typeName\(\)/);
    });
  });

  describe('the inbound email door — where the routing decision is made', () => {
    const door = READ('services/translation_graph/adapters/email/inbound_door.ts');
    const handler = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '..', 'interfaces', 'rest', 'private.ts'),
      'utf-8',
    );

    it('resolves the trigger in the door, not in the handler', () => {
      // Carve M-41/D32: admission and routing are one decision, made once,
      // before the request has an identity. A second lookup in the handler is
      // a second answer to the same question.
      expect(door).toMatch(/findTriggerByInboundKey\(/);
      expect(handler).not.toMatch(/findTriggerByInboundKey\(/);
      expect(handler).toMatch(/req\.inboundEmailRoute/);
    });

    it('scans inbound-email kinds (CUSTOM_EMAIL, MAILGUN, INBOUND_EMAIL) in the lookup', () => {
      // The kinds list must cover every adapter the inbound mailgun
      // endpoint accepts. Pin them so adding a new email adapter
      // forces a conscious update here.
      expect(door).toMatch(
        /INBOUND_EMAIL_TRIGGER_KINDS = \['CUSTOM_EMAIL',\s*'MAILGUN',\s*'INBOUND_EMAIL'\]/,
      );
    });

    it('tries each of the sender’s teams and refuses to guess between two', () => {
      expect(door).toMatch(/matches\.length > 1/);
    });

    it('no longer falls back to the retired pipeline_input scan', () => {
      expect(handler).not.toMatch(/PipelineInputType\.CUSTOM_EMAIL/);
      expect(handler).not.toMatch(/routes_to_pipeline_input_id/);
      expect(handler).toMatch(/dropped_inbound_email/);
    });
  });
});

/**
 * Pull the body of a named function out of a source file so per-function
 * assertions don't accidentally match unrelated text. Walks braces from
 * the function-body's opening `{` (the one preceded by `):` or `=>`,
 * not the parameter-destructure `{`).
 */
function extractFunction(src: string, name: string): string {
  const declRe = new RegExp(
    `(?:async\\s+function\\s+${name}|function\\s+${name}|const\\s+${name}\\s*=\\s*(?:async\\s*)?\\()`,
  );
  const m = declRe.exec(src);
  if (!m) {
    throw new Error(`extractFunction: ${name} not found`);
  }
  const start = m.index;
  // Find the body opener — walk char-by-char tracking the type-level
  // depth in angle brackets (`Promise<...>`) and paren depth, so we
  // skip braces nested in either. The body `{` is the first `{` at
  // paren depth 0 + angle depth 0.
  let i = start;
  let parenDepth = 0;
  let angleDepth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') parenDepth += 1;
    else if (c === ')') parenDepth -= 1;
    else if (c === '<' && parenDepth === 0) angleDepth += 1;
    else if (c === '>' && parenDepth === 0) angleDepth = Math.max(0, angleDepth - 1);
    else if (c === '{' && parenDepth === 0 && angleDepth === 0) break;
    i += 1;
  }
  if (i >= src.length) return src.slice(start, start + 500);
  if (i < 0) return src.slice(start, start + 500);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}
