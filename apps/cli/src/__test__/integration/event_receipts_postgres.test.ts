// An event's receipt in the Postgres store (@lf/postgres-store's
// lf.event_receipt, its second migration): one idempotencyKey runs a listen
// once, per tenant, asked over the store wire's `events.claim`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL } from './pg';

/** Each request's result, in order, from one `lf --contract-store` process. */
function claims(team: string, asks: Array<[listen: string, key: string]>): unknown[] {
  const input = asks.map(([listen, key], id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'events.claim', params: { listen, key } })).join('\n');
  const bridge = spawnSync(lfBinary(), ['--contract-store', POSTGRES_URL, '--team', team], { input: `${input}\n`, encoding: 'utf8' });
  assert.equal(bridge.status, 0, bridge.stderr);
  return bridge.stdout
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { result: unknown }).result);
}

test('a redelivered key is refused for its listen and tenant only', () => {
  const [one, other] = [freshTeam(), freshTeam()];
  try {
    assert.deepEqual(
      claims(one.team, [
        ['listen:companies:welcome', 'delivery-1'],
        ['listen:companies:welcome', 'delivery-1'],
        ['listen:companies:audit', 'delivery-1'],
      ]),
      [true, false, true],
    );
    // A later process sees the receipt; another tenant has its own.
    assert.deepEqual(claims(one.team, [['listen:companies:welcome', 'delivery-1']]), [false]);
    assert.deepEqual(claims(other.team, [['listen:companies:welcome', 'delivery-1']]), [true]);
  } finally {
    one.clear();
    other.clear();
  }
});
