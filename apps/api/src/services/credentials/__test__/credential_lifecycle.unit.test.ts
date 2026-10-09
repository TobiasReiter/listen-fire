import type { TeamId } from '../../../generated/kysely/core/Team';

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const mockIdentify = jest.fn();
const mockRegisterToken = jest.fn();
const mockUnregisterToken = jest.fn();
const mockRevoke = jest.fn();

jest.mock('../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (p: unknown) => p,
}));

// The real attio apiClient pulls a heavy (casl) load chain; stub the two
// symbols the lifecycle consumes.
jest.mock('../../../adapters/attio/apiClient', () => ({
  attioCredsParser: { parse: (d: unknown) => d },
  AttioAPIClient: jest.fn().mockImplementation(() => ({ identifyApiTokenId: mockIdentify })),
}));

jest.mock('../../translation_graph/adapters/attio', () => ({
  ATTIO_ADAPTER_TYPE: 'attio',
}));

jest.mock('../../translation_graph/adapters/native_valuations', () => ({
  NATIVE_VALUATIONS_ADAPTER_TYPE: 'native-valuations',
  nativeValuationsCredsParser: { parse: (d: unknown) => d },
}));

jest.mock('../../translation_graph/engine/platform_token_registry_db', () => ({
  platformTokenRegistry: {
    registerToken: (...args: unknown[]) => mockRegisterToken(...args),
    unregisterToken: (...args: unknown[]) => mockUnregisterToken(...args),
  },
}));

jest.mock('../../api_key', () => ({
  ApiKeyService: { revoke: (...args: unknown[]) => mockRevoke(...args) },
}));

import { credentialLifecycle } from '../credential_lifecycle';

const teamId = 'team-1' as TeamId;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('credentialLifecycle', () => {
  it('returns undefined for a type with no lifecycle concern', () => {
    expect(credentialLifecycle(ExternalServiceType.GOOGLE)).toBeUndefined();
    expect(credentialLifecycle(ExternalServiceType.SLACK)).toBeUndefined();
  });

  describe('Attio', () => {
    const hooks = () => {
      const lc = credentialLifecycle(ExternalServiceType.ATTIO);
      if (!lc) throw new Error('expected Attio lifecycle');
      return lc;
    };

    it('onCreate registers the probed token and stamps apiTokenId', async () => {
      mockIdentify.mockResolvedValue('tok_123');
      const result = await hooks().onCreate!({
        credentials: { accessToken: 'at' },
        teamId,
      });
      expect(mockRegisterToken).toHaveBeenCalledWith({
        teamId,
        adapterType: 'attio',
        tokenId: 'tok_123',
      });
      expect(result).toEqual({ accessToken: 'at', apiTokenId: 'tok_123' });
    });

    it('onCreate is best-effort: no token id → no register, creds unchanged', async () => {
      mockIdentify.mockResolvedValue(null);
      const result = await hooks().onCreate!({
        credentials: { accessToken: 'at' },
        teamId,
      });
      expect(mockRegisterToken).not.toHaveBeenCalled();
      expect(result).toEqual({ accessToken: 'at' });
    });

    it('onCreate swallows probe failures and returns the original creds', async () => {
      mockIdentify.mockRejectedValue(new Error('boom'));
      const result = await hooks().onCreate!({
        credentials: { accessToken: 'at' },
        teamId,
      });
      expect(mockRegisterToken).not.toHaveBeenCalled();
      expect(result).toEqual({ accessToken: 'at' });
    });

    it('onUpdate unregisters the prior token before re-registering', async () => {
      mockIdentify.mockResolvedValue('tok_new');
      const result = await hooks().onUpdate!({
        credentials: { accessToken: 'at2' },
        teamId,
        prior: { accessToken: 'at1', apiTokenId: 'tok_old' },
      });
      expect(mockUnregisterToken).toHaveBeenCalledWith({
        teamId,
        adapterType: 'attio',
        tokenId: 'tok_old',
      });
      expect(mockRegisterToken).toHaveBeenCalledWith({
        teamId,
        adapterType: 'attio',
        tokenId: 'tok_new',
      });
      expect(result).toEqual({ accessToken: 'at2', apiTokenId: 'tok_new' });
    });

    it('onDelete unregisters when an apiTokenId is present', async () => {
      await hooks().onDelete!({ credentials: { apiTokenId: 'tok_x' }, teamId });
      expect(mockUnregisterToken).toHaveBeenCalledWith({
        teamId,
        adapterType: 'attio',
        tokenId: 'tok_x',
      });
    });

    it('onDelete is a no-op when no apiTokenId was captured', async () => {
      await hooks().onDelete!({ credentials: { accessToken: 'at' }, teamId });
      expect(mockUnregisterToken).not.toHaveBeenCalled();
    });
  });

  describe('Listen-Fire Valuations', () => {
    const lc = () => {
      const l = credentialLifecycle(ExternalServiceType.NATIVE_VALUATIONS);
      if (!l) throw new Error('expected Valuations lifecycle');
      return l;
    };

    it('has no create/update hook (the mint flow owns registration)', () => {
      expect(lc().onCreate).toBeUndefined();
      expect(lc().onUpdate).toBeUndefined();
    });

    it('onDelete unregisters and revokes the minted api-key', async () => {
      await lc().onDelete!({ credentials: { apiKey: 'k', apiKeyId: 'key_1' }, teamId });
      expect(mockUnregisterToken).toHaveBeenCalledWith({
        teamId,
        adapterType: 'native-valuations',
        tokenId: 'key_1',
      });
      expect(mockRevoke).toHaveBeenCalledWith('key_1');
    });

    it('onDelete is a no-op for a manually-wired key with no apiKeyId', async () => {
      await lc().onDelete!({ credentials: { apiKey: 'k' }, teamId });
      expect(mockUnregisterToken).not.toHaveBeenCalled();
      expect(mockRevoke).not.toHaveBeenCalled();
    });
  });
});
