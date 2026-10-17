// The hosted environment keeps what `getEnvVar` used to answer for the vendor
// keys: a placeholder outside production, nothing inside it.

import { hostedEnv } from '../host';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe('hostedEnv', () => {
  it('keeps a threaded key over the process environment', () => {
    process.env.OPENAI_API_KEY = 'from-process';
    expect(hostedEnv({ OPENAI_API_KEY: 'threaded' }).OPENAI_API_KEY).toBe('threaded');
  });

  it('falls back to the process environment, then a placeholder outside production', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.NODE_ENV = 'development';
    process.env.OPENAI_API_KEY = 'from-process';
    const env = hostedEnv({});
    expect(env.OPENAI_API_KEY).toBe('from-process');
    expect(env.ANTHROPIC_API_KEY).toBe('test');
  });

  it('leaves a missing key unset in production, so the provider refuses by name', () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.NODE_ENV = 'production';
    expect(hostedEnv({}).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('prefers the OpenAI fallback key over the process environment', () => {
    process.env.OPENAI_API_KEY = 'from-process';
    expect(hostedEnv({ OPENAI_API_KEY_FALLBACK_OR_DEV: 'fb' }).OPENAI_API_KEY).toBe('fb');
  });
});
