// The rule every inbound door shares when it has no signing secret. It used to
// be "reject in production, allow everywhere else", which left every staging box
// and review app with an unauthenticated ingress that fires real automations.

const warn = jest.fn();

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: (...args: unknown[]) => warn(...args), error: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  warn.mockReset();
  jest.resetModules();
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Fresh module per case: the one-shot warning is per-process state. */
async function authorize(door = 'test/door') {
  const { authorizeUnsignedWebhook } = await import('../unsigned_webhooks');
  return authorizeUnsignedWebhook(door);
}

it('refuses when no secret is configured and nothing opted in', async () => {
  process.env.NODE_ENV = 'development';
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;

  expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
});

it('refuses in production even with the bypass set — the bypass is not a production switch', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
  expect(warn).not.toHaveBeenCalled();
});

it('allows outside production when the bypass is explicitly set', async () => {
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  expect(await authorize()).toEqual({ authorized: true });
});

it('warns loudly, naming itself and the door, and only once per door', async () => {
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = 'true';

  const { authorizeUnsignedWebhook } = await import('../unsigned_webhooks');
  authorizeUnsignedWebhook('slack/events');
  authorizeUnsignedWebhook('slack/events');
  authorizeUnsignedWebhook('telegram/builtin');

  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls[0][0]).toContain('ALLOW_UNSIGNED_WEBHOOKS');
  expect(warn.mock.calls[0][0]).toContain('slack/events');
  expect(warn.mock.calls[1][0]).toContain('telegram/builtin');
});

it('takes only the literal `true` — a truthy-looking value is not consent', async () => {
  process.env.NODE_ENV = 'development';

  for (const value of ['1', 'TRUE', 'yes', '']) {
    process.env.ALLOW_UNSIGNED_WEBHOOKS = value;
    expect(await authorize()).toEqual({ authorized: false, reason: 'no_secret' });
  }
});
