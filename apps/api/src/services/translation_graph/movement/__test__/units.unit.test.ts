// The run host's units on the platform: from language version 5 a file
// listens to `cron` and `manual` with no import and no construction, and the
// listen still derives its trigger row (kind = the unit) and, for manual, its
// "Run now" target. Before 5 a listen names a construction, as it always has.

import { parseProgram } from 'movement-lang';
import { collectFileListeners } from 'movement-engine/public/inbound';
import { manualListenerMovements } from '../files';

const V5 = [
  'function backfill(run: <manual-[:Invocation]->>) {',
  '  return 1',
  '}',
  'listen to manual fire backfill',
  'function digest(t: <cron-[:Tick]->>) {',
  '  return 1',
  '}',
  'listen to cron { schedule: "0 9 * * 1", timezone: "Europe/London" } fire digest',
  '',
].join('\n');

describe('run host units', () => {
  it('derive a listener per unit listen from version 5', () => {
    const listeners = collectFileListeners(parseProgram(V5, { languageVersion: 5 }), { languageVersion: 5 });
    expect(listeners.map((l) => [l.adapter, l.movementName, l.credentialName, l.config])).toEqual([
      ['manual', 'backfill', undefined, {}],
      ['cron', 'digest', undefined, { schedule: '0 9 * * 1', timezone: 'Europe/London' }],
    ]);
    expect(manualListenerMovements(parseProgram(V5, { languageVersion: 5 }), { languageVersion: 5 })).toEqual(['backfill']);
  });

  it("yield to a file's own construction, and are no unit before version 5", () => {
    const own = 'import { manual } from adapters\nruns = connect manual\nfunction go(run: <runs-[:Invocation]->>) {\n  return 1\n}\nlisten to runs fire go\n';
    expect(collectFileListeners(parseProgram(own, { languageVersion: 5 }), { languageVersion: 5 }).map((l) => [l.instanceName, l.adapter])).toEqual([['runs', 'manual']]);
    const v4 = 'movement go(run: <manual-[:Invocation]->>) {\n  x = 1\n}\nlisten to manual {} fire go\n';
    expect(collectFileListeners(parseProgram(v4, { languageVersion: 4 }), { languageVersion: 4 })).toEqual([]);
    expect(manualListenerMovements(parseProgram(v4, { languageVersion: 4 }), { languageVersion: 4 })).toEqual([]);
  });
});
