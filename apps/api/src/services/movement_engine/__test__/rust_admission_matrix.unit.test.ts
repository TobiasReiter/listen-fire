// The binding × consumer matrix's programs, read by the Rust engine's
// admission alone (a segment started and finished unanswered: the parse and
// the walk, no host call). The matrix's every program carries the same
// helper movements, and before admission walked only what the entry reaches
// one helper's plugin call refused every cell (`name_not_value`) whatever
// the cell held. Here: a helper a cell's body never names adds no reason, and
// the reasons beyond each first one are reported, not hidden.
//
// Set ADMISSION_REPORT=1 to print each version's first-reason and
// every-reason tables.

import { openEngineSegment, type LanguageVersion } from 'movement-lang';

import { WireOut } from '../rust_wire';
import { cellId, cells, type Cell } from './binding_consumer_matrix.cells';
import { catalog, programFor } from './binding_consumer_matrix.program';

const VERSIONS: LanguageVersion[] = [1, 2, 3, 4];

/** The most cells admission may refuse, by version (PLAN-08A Task 1,
 *  2026-10-12): the count measured then (v1 and v2 `block_multi_hop` 2 and
 *  `plugin_call_form` 1; v3 and v4 `node_spread_path` 4, `block_multi_hop` 3
 *  and `plugin_call_form` 1). Each task that closes one of these reasons
 *  lowers its ceiling; a ceiling never rises. Zero refusals is every one 0. */
const REFUSED_CEILING: Partial<Record<LanguageVersion, number>> = { 1: 3, 2: 3, 3: 8, 4: 8 };

/** Every helper movement the matrix's skeleton declares, by name. */
const HELPER = /^movement (?!run_cell\b)(\w+)\(/;

/** What admission says of `source`: every reason, or none (admitted, and
 *  asking for its check). */
function reasonsOf(source: string, version: LanguageVersion): string[] {
  const segment = openEngineSegment();
  try {
    const step = segment.start(
      JSON.stringify({
        entry: 'segment',
        source,
        languageVersion: version,
        movementName: 'run_cell',
        event: new WireOut().value({ pipelineInputId: 'pi-matrix', adapterType: 'email', triggerType: 'webhook', payload: {} }),
        segmentId: 'admission',
        now: '2026-10-09T00:00:00.000Z',
        catalog,
        serves: [],
      }),
    );
    if (!step.ok || typeof step.json !== 'object' || step.json === null) throw new Error(`the engine's start: ${JSON.stringify(step.json)}`);
    if ('pending' in step.json) return [];
    const done: unknown = Reflect.get(step.json, 'done');
    const refused: unknown = typeof done === 'object' && done !== null ? Reflect.get(done, 'refused') : undefined;
    const reasons: unknown = typeof done === 'object' && done !== null ? Reflect.get(done, 'reasons') : undefined;
    if (typeof refused !== 'string' || !Array.isArray(reasons) || !reasons.every((r): r is string => typeof r === 'string')) {
      throw new Error(`admission ended in ${JSON.stringify(done)}`);
    }
    expect(reasons[0]).toBe(refused);
    return reasons;
  } finally {
    segment.finish();
  }
}

/** `source` without the helper movements `body` never names. */
function withoutUnnamedHelpers(source: string, body: string[]): string {
  const text = body.join('\n');
  const lines = source.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const helper = HELPER.exec(lines[i])?.[1];
    if (helper === undefined || text.includes(helper)) {
      kept.push(lines[i]);
      continue;
    }
    // A movement's body is indented; its closing brace is not.
    while (i < lines.length && lines[i] !== '}') i += 1;
    if (i === lines.length) throw new Error(`helper ${helper} has no closing brace at column 0`);
  }
  return kept.join('\n');
}

function count(into: Record<string, number>, reasons: readonly string[]): void {
  for (const reason of reasons) into[reason] = (into[reason] ?? 0) + 1;
}

const sorted = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));

describe.each(VERSIONS)('the binding × consumer matrix under language version %i, at admission', (version) => {
  const ran: Cell[] = cells().filter((cell) => cell.since <= version);

  it('walks no helper movement a cell does not name', () => {
    const differ = ran
      .map((cell) => {
        const source = programFor(cell, version);
        return { cell: cellId(cell), whole: reasonsOf(source, version), helpersDropped: reasonsOf(withoutUnnamedHelpers(source, cell.body), version) };
      })
      .filter(({ whole, helpersDropped }) => JSON.stringify(whole) !== JSON.stringify(helpersDropped));
    expect(differ).toEqual([]);
  });

  it('reports every reason a refused cell holds, not only its first', () => {
    const first: Record<string, number> = {};
    const every: Record<string, number> = {};
    let refused = 0;
    for (const cell of ran) {
      const reasons = reasonsOf(programFor(cell, version), version);
      expect(new Set(reasons).size).toBe(reasons.length);
      if (reasons.length === 0) continue;
      refused += 1;
      count(first, reasons.slice(0, 1));
      count(every, reasons);
    }
    if (process.env.ADMISSION_REPORT === '1') {
      // eslint-disable-next-line no-console
      console.log(`matrix v${version}: ${ran.length} cells, ${refused} refused\nfirst reason: ${JSON.stringify(sorted(first))}\nevery reason: ${JSON.stringify(sorted(every))}`);
    }
    // Every reason a cell is refused for first is reported for it too, and
    // a reason is reported at least as often as it comes first.
    for (const [reason, n] of Object.entries(first)) expect(every[reason]).toBeGreaterThanOrEqual(n);
    // A version no ceiling names may refuse nothing.
    expect(refused).toBeLessThanOrEqual(REFUSED_CEILING[version] ?? 0);
  });
});
