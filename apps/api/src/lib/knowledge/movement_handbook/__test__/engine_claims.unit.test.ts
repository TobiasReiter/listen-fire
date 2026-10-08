// Lockstep guard: the handbook's engine-status prose vs the engine's own
// gate. Chapters carry machine-readable EngineClaim entries (types.ts)
// for the constructs their prose says run — or don't run yet — on the
// engine. This test runs the movement engine's static interpretability
// scan (services/movement_engine/interpretable.ts — the SAME check
// every save uses) over each claim's probe program:
//
//   - status 'runs'    → the scan must pass the probe clean; if the
//     construct returns to the unsupported list while a chapter still
//     says it works, this fails;
//   - status 'pending' → the scan must flag the probe with the claim's
//     flag; the moment an engine lift stops flagging it, this fails —
//     so closing an engine gap cannot forget the docs.
//
// Probes must parse: a non-parsing probe returns [] from the scan and
// would vacuously satisfy a 'runs' claim, so parseability is asserted
// first.
//
// Probes are read under the release's current language version: the handbook
// teaches the language a movement saved today is pinned to.

import { CURRENT_LANGUAGE_VERSION, parseProgram } from 'movement-lang';
import { listUnsupportedConstructs } from '../../../../services/movement_engine/interpretable';
import { getMovementHandbook } from '../index';
import type { EngineClaim } from '../types';
import { frontPageClaims } from '../front_page';
import { controlFormClaims } from '../language_search';

const AS_TAUGHT = { languageVersion: CURRENT_LANGUAGE_VERSION };

const claims: Array<EngineClaim & { chapter: string }> = Object.values(
  getMovementHandbook().chapters,
).flatMap((chapter): Array<EngineClaim & { chapter: string }> =>
  (chapter.engineClaims ?? []).map((claim) => ({ ...claim, chapter: chapter.id })),
).concat(
  // The handbook's front page and the language search's
  // control forms show examples too, outside any chapter; they are held the
  // same way.
  frontPageClaims().map((claim) => ({ ...claim, chapter: 'front' })),
  controlFormClaims().map((claim) => ({ ...claim, chapter: 'language-search' })),
);

describe('movement_handbook engine claims — lockstep with interpretable.ts', () => {
  it('chapters declare engine claims (the guard has something to hold)', () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  it('claimed constructs are unique across chapters', () => {
    const constructs = claims.map((c) => c.construct);
    expect(new Set(constructs).size).toBe(constructs.length);
  });

  it.each(claims.map((c) => [c.chapter, c.construct, c] as const))(
    '%s — probe for "%s" parses',
    (_chapter, _construct, claim) => {
      expect(() => parseProgram(claim.probe, AS_TAUGHT)).not.toThrow();
    },
  );

  it.each(
    claims
      .filter((c) => c.status === 'runs')
      .map((c) => [c.chapter, c.construct, c] as const),
  )('%s claims "%s" runs — the scan must agree', (_chapter, _construct, claim) => {
    expect(listUnsupportedConstructs(claim.probe, AS_TAUGHT)).toEqual([]);
  });

  it.each(
    claims.flatMap((c) =>
      c.status === 'pending' ? [[c.chapter, c.construct, c] as const] : [],
    ),
  )(
    '%s claims "%s" is still pending — the scan must still flag it (a lift here means: update the chapter)',
    (_chapter, _construct, claim) => {
      const found = listUnsupportedConstructs(claim.probe, AS_TAUGHT);
      expect(found.some((construct) => construct.includes(claim.flag))).toBe(true);
    },
  );
});
