// The engine's ABI through the committed artifact (packages/movement-lang/
// wasm/movement.wasm): a segment's start → pending → answer → done, raw and
// through the shim. Protocol only: the runs themselves are rust_run's and
// rust_write's. Several requests in flight at once, answered out of order,
// and a panic's trap are the executor's and abi.rs's tests (the probe entries
// that exercise them are built into test builds only), and the loader's trap
// path is movement-lang's loader test.

import { EMPTY_CATALOG_SNAPSHOT, openEngineSegment } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';

import { openRunContext } from '../run_context';
import { driveEngine, openWasmEngine, RustShimError } from '../rust_engine';
import { makeTestHost } from '../test_host';

/** A program that parses and declares nothing. */
const SOURCE = 'import { manual } from adapters';

/** A `segment` entry's input: the smallest run, which asks its host for
 *  the check first. */
function segmentStart(source: string, segmentId = 'g1'): string {
  return JSON.stringify({
    entry: 'segment',
    source,
    languageVersion: 3,
    event: ['o', 0, [['pipelineInputId', 'p'], ['adapterType', 'manual'], ['triggerType', 'webhook'], ['payload', ['o', 1, []]]]],
    segmentId,
    now: '2026-10-07T09:00:00.000Z',
    catalog: EMPTY_CATALOG_SNAPSHOT,
  });
}

describe('the Rust engine artifact', () => {
  it('round-trips start → pending → answer → done, and refuses an answer after done', () => {
    const segment = openEngineSegment();
    expect(segment.start(segmentStart(SOURCE))).toEqual({
      ok: true,
      json: { pending: [{ id: 1, family: 'check', method: 'program', args: { source: SOURCE, languageVersion: 3 } }] },
    });
    // A host error answers the request; the run ends naming it by its ref.
    expect(segment.answer(1, JSON.stringify({ error: { message: 'no checker', ref: 0 } }))).toEqual({
      ok: true,
      json: { done: { thrown: { hostError: 0 } } },
    });
    expect(segment.answer(1, '{}')).toEqual({
      ok: false,
      json: { error: { message: 'request 1 was answered after the segment finished' } },
    });
    segment.finish();
    expect(() => segment.start('{}')).toThrow('the engine segment is finished: engine_start cannot be called');
  });

  it('gives each segment an instance of its own', () => {
    const a = openEngineSegment();
    const b = openEngineSegment();
    expect(a.start(segmentStart(SOURCE)).ok).toBe(true);
    expect(b.start(segmentStart(SOURCE)).ok).toBe(true);
    expect(a.answer(1, JSON.stringify({ error: { message: 'a', ref: 3 } })).json).toEqual({ done: { thrown: { hostError: 3 } } });
    expect(b.answer(1, JSON.stringify({ error: { message: 'b', ref: 4 } })).json).toEqual({ done: { thrown: { hostError: 4 } } });
    a.finish();
    b.finish();
  });

  it('ships no probe entries', () => {
    for (const entry of ['echo', 'panic']) {
      expect(openEngineSegment().start(JSON.stringify({ entry, requests: [], message: 'x' }))).toEqual({
        ok: false,
        json: { error: { message: `no entry \`${entry}\`` } },
      });
    }
  });

  it('is driven by the shim against a host: the check is the TypeScript checker, and its failure ends the run', async () => {
    // Parses, and fails the check: no adapter `nope` in the snapshot.
    const host = makeTestHost();
    const context = await openRunContext({ host, teamId: tenantIdOf('team-1'), languageVersion: 3, spend: {} });
    await expect(
      driveEngine(openWasmEngine(), JSON.parse(segmentStart('import { nope } from adapters', context.segmentId)), {
        host,
        context,
        catalog: EMPTY_CATALOG_SNAPSHOT,
      }),
    ).rejects.toThrow(/^MOVENG_CHECK: /);
  });

  it('refuses a protocol misuse loudly through the shim', () => {
    expect(() => openWasmEngine().start({ entry: 'nope' })).toThrow('the Rust engine refused start: no entry `nope`');
    expect(() => openWasmEngine().start({ entry: 'nope' })).toThrow(RustShimError);
  });
});
