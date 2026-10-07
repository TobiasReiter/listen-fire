// The engine's ABI through the committed artifact (packages/movement-lang/
// wasm/movement.wasm): a segment's start → pending → answer → done, with the
// program-less `echo` entry, raw and through the shim; and a trap's panic
// message. Protocol only: no language semantics run here.

import { openEngineSegment } from 'movement-lang';

import type { TeamId } from '../../../generated/kysely/core/Team';

import { makeTestHost } from '../host';
import { driveEngine, openWasmEngine, RustShimError } from '../rust_engine';

describe('the Rust engine artifact', () => {
  it('round-trips start → two pending at once → answers out of order → done', () => {
    const segment = openEngineSegment();
    const started = segment.start(
      JSON.stringify({
        entry: 'echo',
        requests: [
          { family: 'echo', method: 'first', args: { n: 1 } },
          { family: 'echo', method: 'second', args: ['é🌍'] },
        ],
      }),
    );
    expect(started).toEqual({
      ok: true,
      json: {
        pending: [
          { id: 1, family: 'echo', method: 'first', args: { n: 1 } },
          { id: 2, family: 'echo', method: 'second', args: ['é🌍'] },
        ],
      },
    });
    expect(segment.answer(2, JSON.stringify({ error: { message: 'no second' } }))).toEqual({
      ok: true,
      json: { pending: [] },
    });
    expect(segment.answer(1, JSON.stringify({ value: 'one' }))).toEqual({
      ok: true,
      json: { done: { answers: [{ value: 'one' }, { error: { message: 'no second' } }] } },
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
    const echo = JSON.stringify({ entry: 'echo', requests: [{ family: 'echo', method: 'm' }] });
    expect(a.start(echo).ok).toBe(true);
    expect(b.start(echo).ok).toBe(true);
    expect(a.answer(1, '{}').json).toEqual({ done: { answers: [{}] } });
    expect(b.answer(1, JSON.stringify({ value: 2 })).json).toEqual({ done: { answers: [{ value: 2 }] } });
    a.finish();
    b.finish();
  });

  it('throws a panic with its message and ends the segment', () => {
    const segment = openEngineSegment();
    expect(() => segment.start(JSON.stringify({ entry: 'panic', message: 'boom 7' }))).toThrow(
      /^movement engine crashed in engine_start: RuntimeError: unreachable: panicked at crates\/movement-engine\/src\/lib\.rs:\d+:\d+:\nboom 7$/,
    );
    expect(() => segment.answer(1, '{}')).toThrow('the engine segment is trapped');
    segment.finish();
    // The next segment starts clean.
    expect(openEngineSegment().start(JSON.stringify({ entry: 'echo', requests: [] })).json).toEqual({
      done: { answers: [] },
    });
  });

  it('is driven by the shim against a host', async () => {
    const done = await driveEngine(
      openWasmEngine(),
      {
        entry: 'echo',
        requests: [
          { family: 'adapters', method: 'credentialId', args: { credentialName: 'crm' } },
          { family: 'adapters', method: 'credentialId', args: { credentialName: 'none' } },
        ],
      },
      {
        teamId: 'team-1' as TeamId,
        host: makeTestHost({ adapters: { credentialId: (name) => (name === 'crm' ? 'cred-1' : undefined) } }),
      },
    );
    expect(done).toEqual({ answers: [{ value: 'cred-1' }, {}] });
  });

  it('refuses a protocol misuse loudly through the shim', () => {
    expect(() => openWasmEngine().start({ entry: 'nope' })).toThrow('the Rust engine refused start: no entry `nope`');
    expect(() => openWasmEngine().start({ entry: 'nope' })).toThrow(RustShimError);
  });
});
