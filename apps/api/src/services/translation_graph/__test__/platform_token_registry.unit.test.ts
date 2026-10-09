import type { TeamId } from '../../../generated/kysely/core/Team';
import type { Actor } from '../mutation_context';

import {
  InMemoryPlatformTokenRegistry,
  shouldDropAsNativeEcho,
} from '../engine/platform_token_registry';

const team1 = 'team-1' as TeamId;
const team2 = 'team-2' as TeamId;

describe('InMemoryPlatformTokenRegistry', () => {
  it('recognizes registered api-token actors', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });

    const actor: Actor = { type: 'api-token', id: 'token-a' };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'attio', actor }),
    ).toBe(true);
  });

  it('does not recognize unregistered tokens', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    const actor: Actor = { type: 'api-token', id: 'token-x' };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'attio', actor }),
    ).toBe(false);
  });

  it('scopes tokens by team', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    const actor: Actor = { type: 'api-token', id: 'token-a' };
    expect(
      await registry.isPlatformOwned({ teamId: team2, adapterType: 'attio', actor }),
    ).toBe(false);
  });

  it('scopes tokens by adapter', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    const actor: Actor = { type: 'api-token', id: 'token-a' };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'gmail', actor }),
    ).toBe(false);
  });

  it('does not match user actors even with matching id', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    const actor: Actor = { type: 'user', id: 'token-a' };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'attio', actor }),
    ).toBe(false);
  });

  it('does not match actors with null id', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    const actor: Actor = { type: 'api-token', id: null };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'attio', actor }),
    ).toBe(false);
  });

  it('unregisterToken removes entries', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    await registry.unregisterToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    const actor: Actor = { type: 'api-token', id: 'token-a' };
    expect(
      await registry.isPlatformOwned({ teamId: team1, adapterType: 'attio', actor }),
    ).toBe(false);
  });
});

describe('shouldDropAsNativeEcho', () => {
  it('returns false when actor is undefined', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    expect(
      await shouldDropAsNativeEcho({ registry, teamId: team1, adapterType: 'attio', actor: undefined }),
    ).toBe(false);
  });

  it('returns true when actor matches a registered Listen-Fire-owned token', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    await registry.registerToken({ teamId: team1, adapterType: 'attio', tokenId: 'token-a' });
    const actor: Actor = { type: 'api-token', id: 'token-a' };
    expect(
      await shouldDropAsNativeEcho({ registry, teamId: team1, adapterType: 'attio', actor }),
    ).toBe(true);
  });

  it('returns false when actor is a user (correctness falls back to layered defenses)', async () => {
    const registry = new InMemoryPlatformTokenRegistry();
    const actor: Actor = { type: 'user', id: 'ada' };
    expect(
      await shouldDropAsNativeEcho({ registry, teamId: team1, adapterType: 'attio', actor }),
    ).toBe(false);
  });
});
