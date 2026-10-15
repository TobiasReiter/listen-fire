// The multi-number registry: `getMetaWhatsappApi(phoneNumberId)` selects the
// send client for a receiving number — primary vs the movements number — so a
// reply goes out from the number that received it. The module builds its
// instances from env at load, so each case loads it in isolation with a fresh
// env.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const BASE_ENV = { ...process.env };

function loadRegistry(env: Record<string, string | undefined>): typeof import('../metaApi') {
  let mod: typeof import('../metaApi') | undefined;
  jest.isolateModules(() => {
    process.env = { ...BASE_ENV, WHATSAPP_GRAPH_BASE_URL: 'https://fake.local', ...env };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../metaApi');
  });
  return mod!;
}

afterEach(() => {
  process.env = { ...BASE_ENV };
  jest.resetModules();
});

describe('getMetaWhatsappApi — number registry', () => {
  it('selects primary by default, the movements number by its id, primary (fallback) for unknown', () => {
    const { getMetaWhatsappApi } = loadRegistry({
      WHATSAPP_ACCESS_TOKEN: 'tok-primary',
      WHATSAPP_PHONE_NUMBER_ID: 'PN_PRIMARY',
      WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID: 'PN_MOVE',
    });
    expect(getMetaWhatsappApi().numberId).toBe('PN_PRIMARY');
    expect(getMetaWhatsappApi('PN_MOVE').numberId).toBe('PN_MOVE');
    expect(getMetaWhatsappApi('PN_UNKNOWN').numberId).toBe('PN_PRIMARY');
  });

  it('a same-app movements number needs only its phone id — it reuses the primary token', () => {
    const { getMetaWhatsappApi, metaWhatsappMovementsApi, movementsPhoneNumberId } = loadRegistry({
      WHATSAPP_ACCESS_TOKEN: 'tok-primary',
      WHATSAPP_PHONE_NUMBER_ID: 'PN_PRIMARY',
      WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID: 'PN_MOVE',
    });
    expect(metaWhatsappMovementsApi).not.toBeNull();
    expect(getMetaWhatsappApi('PN_MOVE').numberId).toBe('PN_MOVE');
    // The gate's source of truth agrees with the registered send client.
    expect(movementsPhoneNumberId()).toBe('PN_MOVE');
  });

  it('no movements number configured → only the primary exists, gate stays off', () => {
    const { getMetaWhatsappApi, metaWhatsappMovementsApi, movementsPhoneNumberId } = loadRegistry({
      WHATSAPP_ACCESS_TOKEN: 'tok-primary',
      WHATSAPP_PHONE_NUMBER_ID: 'PN_PRIMARY',
      WHATSAPP_MOVEMENTS_PHONE_NUMBER_ID: undefined,
    });
    expect(metaWhatsappMovementsApi).toBeNull();
    // An unknown id (e.g. a stale position) still resolves to primary, never null.
    expect(getMetaWhatsappApi('PN_MOVE').numberId).toBe('PN_PRIMARY');
    // No movements number → the gate reads null → "don't partition yet".
    expect(movementsPhoneNumberId()).toBeNull();
  });
});
