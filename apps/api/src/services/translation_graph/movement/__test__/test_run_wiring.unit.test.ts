/**
 * Movement test-run wiring tests (kill-tg SD-1).
 *
 * The automation-page "Test run" no longer rides the TG `simulate` core (the
 * TG engine retired) — it fires a SYNTHETIC event at the trigger's movement
 * and runs it through the movement engine with `dryRun: true` + a `writeSink`.
 *
 * Source-text idiom (mirrors `run_mode_gate.unit.test.ts`): pin the wiring so
 * a future refactor can't silently re-route the Test run back through the
 * dead engine. No DB / no token spend.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const READ = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', rel), 'utf-8');

describe('dryRunTrigger → movement test run', () => {
  const view = READ('interfaces/trpc/views/triggers.ts');

  it('dryRunTrigger dispatches to the movement test-run, not the TG simulate core', () => {
    expect(view).toMatch(/runMovementTestRun\(\{/);
    expect(view).not.toMatch(/\bsimulate\(\{/);
    expect(view).not.toMatch(/from '.*translation_graph\/simulate'/);
  });

  it('passes the team + trigger id (team-scoped before dispatch)', () => {
    expect(view).toMatch(/runMovementTestRun\(\{[\s\S]*?teamId,[\s\S]*?triggerId: input\.triggerId/);
  });
});

describe('runMovementTestRun substrate', () => {
  const src = READ('services/translation_graph/movement/test_run.ts');

  it('runs the movement engine in dry-run with a writeSink (no live writes)', () => {
    expect(src).toMatch(/runMovement\(\{/);
    expect(src).toMatch(/dryRun: true/);
    expect(src).toMatch(/writeSink: \(w\) => writes\.push\(w\)/);
  });

  it('stores file text in memory only (a test run leaves no raw_text rows)', () => {
    expect(src).toMatch(/rawText: inMemoryRawTextStore\(\)/);
  });

  it('never reaches the retired TG engine', () => {
    expect(src).not.toMatch(/evaluateTranslationGraph/);
    expect(src).not.toMatch(/from '.*\/engine'/);
  });

  it('builds a synthetic webhook event keyed on the trigger source adapter', () => {
    expect(src).toMatch(/triggerType: 'webhook'/);
    expect(src).toMatch(/resolveAdapterSlug\(trigger\.kind\)/);
  });

  it('returns an error (not a throw) when the trigger has no movement', () => {
    expect(src).toMatch(/trigger\.movementId === null/);
    expect(src).toMatch(/ok: false, error:/);
  });
});
