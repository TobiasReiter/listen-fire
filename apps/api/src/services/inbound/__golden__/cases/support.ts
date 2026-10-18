import type { BodySpec, GoldenCase, RequestSpec } from '../harness';
import type { FakeSubscription, FakeTrigger } from '../world';

import { world } from '../world';
import { hmacHex } from '../secrets';

export function subscription(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  return {
    id: 'sub-1',
    team_id: 'team-1',
    provider: 'ATTIO',
    credentials_id: 'cred-1',
    webhook_secret: 'unset',
    grandfathered_unsigned: false,
    external_webhook_id: null,
    inbound_checkpoint: null,
    ...overrides,
  };
}

export function givenSubscription(overrides: Partial<FakeSubscription> = {}): FakeSubscription {
  const row = subscription(overrides);
  world.subscriptions[row.id] = row;
  return row;
}

export function givenTrigger(overrides: Partial<FakeTrigger> = {}): FakeTrigger {
  const row: FakeTrigger = {
    id: 'trigger-1',
    movementId: 'movement-1',
    kind: 'ATTIO',
    credentialsId: null,
    config: {},
    ...overrides,
  };
  world.triggers.push(row);
  return row;
}

export const json = (value: unknown): BodySpec => ({ kind: 'json', value });
export const text = (value: string): BodySpec => ({ kind: 'text', value });

/** A JSON POST whose headers may depend on the body bytes (for signing). */
export function post(path: string, body: BodySpec, headers: RequestSpec['headers'] = {}): RequestSpec {
  const withType = (given: Record<string, string>): Record<string, string> =>
    Object.keys(given).some((name) => name.toLowerCase() === 'content-type')
      ? given
      : { 'content-type': 'application/json', ...given };
  return {
    method: 'POST',
    path,
    body,
    headers: typeof headers === 'function' ? (bytes) => withType(headers(bytes)) : withType(headers),
  };
}

export const hex = (secret: string) => (body: Buffer) => hmacHex(secret, body);

export function define(door: string, cases: Omit<GoldenCase, 'door'>[]): GoldenCase[] {
  return cases.map((entry) => ({ ...entry, door }));
}
