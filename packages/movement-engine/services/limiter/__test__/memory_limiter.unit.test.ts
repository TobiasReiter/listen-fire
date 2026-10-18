// The in-process limiter (`@lf/memory-limiter`) held to the contract every
// limiter is held to (contract.ts), and the in-process wait over it.

import { limiterContractCases } from '../contract';
import { acquireOrWait, limitRequest, MemoryLimiter } from '../limiter';

describe('MemoryLimiter', () => {
  for (const contractCase of limiterContractCases) {
    it(contractCase.name, () => contractCase.run(new MemoryLimiter()));
  }

  it('wakes a waiter as soon as a permit is released', async () => {
    const limiter = new MemoryLimiter();
    const request = limitRequest({ module: '@acme/crm', team: 't' }, [{ scope: 'module', concurrent: 1 }]);
    const first = await acquireOrWait(limiter, request);
    const started = Date.now();
    setTimeout(() => void first.release(), 30);
    await acquireOrWait(limiter, request);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('counts a credential limit per credential, and a module limit across them', () => {
    const alice = { module: '@acme/crm', install: 'crm', credential: 'alice', team: 't' };
    const bob = { ...alice, credential: 'bob' };
    const perCredential = [{ scope: 'credential' as const, calls: 1, per: '1m' }];
    expect(limitRequest(alice, perCredential).limits[0]?.key).not.toBe(limitRequest(bob, perCredential).limits[0]?.key);
    const perModule = [{ scope: 'module' as const, concurrent: 1 }];
    expect(limitRequest(alice, perModule).limits[0]?.key).toBe(limitRequest(bob, perModule).limits[0]?.key);
    expect(limitRequest(alice, perCredential).limits[0]).toMatchObject({ calls: 1, perMs: 60_000 });
  });
});
