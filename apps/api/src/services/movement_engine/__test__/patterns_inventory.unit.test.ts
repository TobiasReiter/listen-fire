// The committed patterns oracle (crates/movement-engine/tests/oracle/
// patterns.json) read against the README's port list, without regenerating
// it: the generator holds each program to the README as it writes the file,
// but a row marked Closed later would leave the committed file's programs
// still `refused` for it until someone reran generate.ts. This fails first.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BY_CONTRACT, UNRECORDABLE, type Routes } from '../../../../../../crates/movement-engine/tests/oracle/patterns_table';
import { portListStatus, retiredReasons } from '../../../../../../crates/movement-engine/tests/oracle/port_list';

const ENGINE = path.resolve(__dirname, '../../../../../../crates/movement-engine');

interface Committed {
  patterns: Array<{ reason: string; routes: Routes }>;
  cases: Array<{ pattern: string; routes: Routes; reasons: string[] }>;
}

const committed: Committed = JSON.parse(readFileSync(path.join(ENGINE, 'tests/oracle/patterns.json'), 'utf8'));
const status = portListStatus(readFileSync(path.join(ENGINE, 'README.md'), 'utf8'));

describe('the committed patterns oracle, against the README port list', () => {
  it('refuses or declines no program for a reason the port list has retired, and holds each contract category to its reasons', () => {
    const wrong = committed.cases.flatMap((c) => retiredReasons(c.routes, c.reasons, status).map((why) => `${c.pattern}: ${why}`));
    expect(wrong).toEqual([]);
  });

  it('labels a pattern by_contract only where the port list marks it Closed, and unrecordable only for the wire refusal', () => {
    const wrong = committed.patterns.flatMap(({ reason, routes }) => {
      if (routes === 'by_contract' && (!BY_CONTRACT.includes(reason) || status.get(reason) !== 'Closed')) return [`${reason}: by_contract, not a Closed contract refusal`];
      if (routes === 'unrecordable' && !UNRECORDABLE.includes(reason)) return [`${reason}: unrecordable, not the shim's wire refusal`];
      if ((routes === 'refused' || routes === 'declined') && status.get(reason) === 'Closed') return [`${reason}: ${routes}, which the port list marks Closed`];
      return [];
    });
    expect(wrong).toEqual([]);
    // Every contract reason is labelled as such.
    expect(committed.patterns.filter((p) => BY_CONTRACT.includes(p.reason)).map((p) => p.routes)).toEqual(BY_CONTRACT.map(() => 'by_contract'));
    expect(committed.patterns.filter((p) => UNRECORDABLE.includes(p.reason)).map((p) => p.routes)).toEqual(UNRECORDABLE.map(() => 'unrecordable'));
  });
});
