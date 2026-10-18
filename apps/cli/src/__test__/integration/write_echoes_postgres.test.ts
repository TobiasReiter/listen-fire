// A run's remembered writes in the Postgres store (@lf/postgres-store's
// lf.write_echo, its third migration), over the store wire's
// `writes.remember` / `writes.remembered`: kept per writer and tenant, seen
// by a later process, gone once expired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL } from './pg';

/** Each request's result, in order, from one `lf --contract-store` process. */
function asks(team: string, requests: Array<[method: string, params: object]>): unknown[] {
  const input = requests.map(([method, params], id) => JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n');
  const bridge = spawnSync(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team], { input: `${input}\n`, encoding: 'utf8' });
  assert.equal(bridge.status, 0, bridge.stderr);
  return bridge.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const answer = JSON.parse(line) as { result?: unknown; error?: unknown };
      assert.equal(answer.error, undefined, line);
      return answer.result;
    });
}

const write = (writer: string, fingerprint: string, expiresAt: string): [string, object] => [
  'writes.remember',
  { adapter: 'attio', recordType: 'Companies', externalId: 'r1', writer, fingerprint, expiresAt },
];
const remembered = (externalId = 'r1'): [string, object] => ['writes.remembered', { adapter: 'attio', externalId, now: new Date().toISOString() }];

test('a write is remembered per writer and tenant until it expires', () => {
  const [one, other] = [freshTeam(), freshTeam()];
  try {
    asks(one.team, [
      write('listen:sync:stamp', 'f1', '2999-01-01T00:00:00.000Z'),
      write('listen:sync:stamp', 'f2', '2999-01-01T00:00:00.000Z'),
      write('listen:audit:log', 'f3', '2000-01-01T00:00:00.000Z'),
    ]);
    // A later process sees it; the expired one and another record do not show.
    assert.deepEqual(asks(one.team, [remembered(), remembered('r2')]), [[{ writer: 'listen:sync:stamp', recordType: 'Companies', fingerprint: 'f2' }], []]);
    assert.deepEqual(asks(other.team, [remembered()]), [[]]);
  } finally {
    one.clear();
    other.clear();
  }
});
