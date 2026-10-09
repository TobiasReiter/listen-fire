import type { DefaultModelUse } from '../map';

import {
  assertCallable,
  assertModelMapConfigured,
  availableChatModels,
  chatModelAvailability,
  modelKeyWarning,
  parseModelMap,
  providerCredentialsPresent,
  providerServes,
  resolveModel,
} from '../map';

const GOOGLE = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

const mapOf = (entries: Record<string, string>) => JSON.stringify(entries);

describe('parsing MODEL_MAP', () => {
  it('reads unset, empty and blank as no map at all', () => {
    expect(parseModelMap(undefined).size).toBe(0);
    expect(parseModelMap('').size).toBe(0);
    expect(parseModelMap('   ').size).toBe(0);
  });

  it('reads provider and wire model', () => {
    const map = parseModelMap(mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5@x' }));
    expect(map.get('claude-sonnet-5')).toEqual({ provider: 'vertex', wireModel: 'claude-sonnet-5@x' });
  });

  it('keeps everything after the first slash as the wire model', () => {
    const map = parseModelMap(mapOf({ 'claude-haiku-4-5': 'gemini/publishers/google/gemini-3.8-flash' }));
    expect(map.get('claude-haiku-4-5')).toEqual({
      provider: 'gemini',
      wireModel: 'publishers/google/gemini-3.8-flash',
    });
  });

  it('refuses JSON that does not parse', () => {
    expect(() => parseModelMap('{nope')).toThrow(/MODEL_MAP is not valid JSON/);
  });

  it('refuses anything but an object of strings', () => {
    expect(() => parseModelMap('["claude-sonnet-5"]')).toThrow(/JSON object whose values are strings/);
    expect(() => parseModelMap('{"claude-sonnet-5": 3}')).toThrow(/values are strings/);
  });

  it('refuses a key that is not a registry name, naming it', () => {
    expect(() => parseModelMap(mapOf({ 'claude-sonnet-9': 'anthropic/claude-sonnet-9' }))).toThrow(
      /MODEL_MAP key "claude-sonnet-9" is not a model name/,
    );
  });

  it('refuses a provider outside the four', () => {
    expect(() => parseModelMap(mapOf({ 'claude-sonnet-5': 'bedrock/claude-sonnet-5' }))).toThrow(
      /MODEL_MAP\["claude-sonnet-5"\] is "bedrock\/claude-sonnet-5"/,
    );
  });

  it('refuses an uppercase provider rather than quietly not matching it', () => {
    expect(() => parseModelMap(mapOf({ 'claude-haiku-4-5': 'Gemini/gemini-3.8-flash' }))).toThrow(
      /MODEL_MAP\["claude-haiku-4-5"\]/,
    );
  });

  it('refuses whitespace anywhere in the value', () => {
    for (const value of ['gemini/gemini-3.8-flash ', ' gemini/gemini-3.8-flash', 'gemini/ x']) {
      expect(() => parseModelMap(mapOf({ 'claude-haiku-4-5': value }))).toThrow(/MODEL_MAP\["claude-haiku-4-5"\]/);
    }
  });

  it('refuses a value with no wire model', () => {
    expect(() => parseModelMap(mapOf({ 'claude-haiku-4-5': 'gemini/' }))).toThrow(/MODEL_MAP\["claude-haiku-4-5"\]/);
    expect(() => parseModelMap(mapOf({ 'claude-haiku-4-5': 'gemini' }))).toThrow(/MODEL_MAP\["claude-haiku-4-5"\]/);
  });
});

describe('resolving a name', () => {
  it('sends an unmapped name to its home vendor under its own name', () => {
    expect(resolveModel('claude-sonnet-5', {})).toEqual({
      preferred: 'claude-sonnet-5',
      provider: 'anthropic',
      wireModel: 'claude-sonnet-5',
    });
    expect(resolveModel('whisper-1', { MODEL_MAP: '' })).toEqual({
      preferred: 'whisper-1',
      provider: 'openai',
      wireModel: 'whisper-1',
    });
  });

  it('follows the map where it speaks, and only there', () => {
    const env = { MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }) };
    expect(resolveModel('claude-sonnet-5', env).provider).toBe('vertex');
    expect(resolveModel('claude-opus-5', env).provider).toBe('anthropic');
  });

  it('reads a changed map rather than a remembered one', () => {
    expect(
      resolveModel('text-embedding-3-small', {
        MODEL_MAP: mapOf({ 'text-embedding-3-small': 'gemini/g' }),
      }).provider,
    ).toBe('gemini');
    expect(resolveModel('text-embedding-3-small', {}).provider).toBe('openai');
  });
});

describe('the capability table', () => {
  it('lets the Claude doors serve chat only', () => {
    for (const provider of ['anthropic', 'vertex'] as const) {
      expect(providerServes(provider, 'chat')).toBe(true);
      expect(providerServes(provider, 'transcription')).toBe(false);
      expect(providerServes(provider, 'embedding')).toBe(false);
      expect(providerServes(provider, 'image')).toBe(false);
    }
  });

  it('lets openai and gemini serve all four', () => {
    for (const provider of ['openai', 'gemini'] as const) {
      for (const capability of ['chat', 'transcription', 'embedding', 'image'] as const) {
        expect(providerServes(provider, capability)).toBe(true);
      }
    }
  });
});

describe('credentials', () => {
  it('asks each provider for its own', () => {
    expect(providerCredentialsPresent('anthropic', { ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(providerCredentialsPresent('anthropic', {})).toBe(false);
    expect(providerCredentialsPresent('openai', { OPENAI_API_KEY: 'k' })).toBe(true);
    expect(providerCredentialsPresent('openai', {})).toBe(false);
    expect(providerCredentialsPresent('vertex', GOOGLE)).toBe(true);
    expect(providerCredentialsPresent('gemini', GOOGLE)).toBe(true);
    expect(providerCredentialsPresent('gemini', { GOOGLE_PROJECT_ID: 'p' })).toBe(false);
  });
});

describe('boot validation', () => {
  it('accepts an empty map with no keys at all', () => {
    expect(() => assertModelMapConfigured({})).not.toThrow();
  });

  it('accepts a home vendor key that nothing uses', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        ANTHROPIC_API_KEY: 'unused',
        MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
      }),
    ).not.toThrow();
  });

  it('refuses a key that is not a registry name', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'gpt-6': 'openai/gpt-6' }) }),
    ).toThrow(/MODEL_MAP key "gpt-6"/);
  });

  it('refuses an unknown provider', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-opus-5': 'azure/claude-opus-5' }) }),
    ).toThrow(/MODEL_MAP\["claude-opus-5"\]/);
  });

  it('refuses a provider that does not serve the capability', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({ 'whisper-1': 'vertex/whisper-1' }),
      }),
    ).toThrow(/MODEL_MAP\["whisper-1"\].*vertex does not serve transcription.*openai, gemini/);
  });

  it('refuses a mapped provider with no credentials, naming what to set', () => {
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }) }),
    ).toThrow(/MODEL_MAP\["claude-sonnet-5"\] sends it to vertex.*GOOGLE_PRIVATE_KEY/);
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-sonnet-5': 'openai/gpt-5' }) }),
    ).toThrow(/set OPENAI_API_KEY/);
    expect(() =>
      assertModelMapConfigured({ MODEL_MAP: mapOf({ 'claude-opus-5': 'anthropic/claude-opus-5' }) }),
    ).toThrow(/set ANTHROPIC_API_KEY/);
  });
});

describe('calling a name with nothing behind it', () => {
  it('names the map line to add when silence sent it to a vendor with no key', () => {
    const env = { NODE_ENV: 'production' };
    expect(() => assertCallable(resolveModel('gpt-image-1', env), env)).toThrow(
      /"gpt-image-1" is not in MODEL_MAP.*OPENAI_API_KEY.*"gpt-image-1": "<provider>\/<wire model>"/,
    );
  });

  it('leaves development to the vendor clients and their defaults', () => {
    expect(() => assertCallable(resolveModel('gpt-image-1', {}), {})).not.toThrow();
  });

  it('passes a vendor that has its key', () => {
    const env = { NODE_ENV: 'production', OPENAI_API_KEY: 'k' };
    expect(() => assertCallable(resolveModel('gpt-image-1', env), env)).not.toThrow();
  });
});

describe('which chat models a deployment can reach', () => {
  // The same movement is valid on one deployment and not another: it is the
  // deployment's map and keys that answer, not the language.
  it('answers per deployment', () => {
    const anthropicOnly = { NODE_ENV: 'production', ANTHROPIC_API_KEY: 'k' };
    const vertexOnly = {
      NODE_ENV: 'production',
      ...GOOGLE,
      MODEL_MAP: mapOf({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
    };
    expect(chatModelAvailability('claude-opus-5', anthropicOnly)).toEqual({ available: true, model: 'claude-opus-5' });
    expect(chatModelAvailability('claude-sonnet-5', vertexOnly)).toEqual({ available: true, model: 'claude-sonnet-5' });
    const opus = chatModelAvailability('claude-opus-5', vertexOnly);
    expect(opus.available).toBe(false);
    expect(opus.available ? '' : opus.reason).toMatch(/goes to anthropic, which has no credentials.*ANTHROPIC_API_KEY/);
    expect(availableChatModels(vertexOnly)).toEqual(['claude-sonnet-5']);
    expect(availableChatModels(anthropicOnly)).toContain('claude-opus-5');
    expect(availableChatModels(anthropicOnly)).not.toContain('whisper-1');
  });

  it('refuses a name the registry does not know, listing the chat models', () => {
    const answer = chatModelAvailability('claude-sonnet-9', { ANTHROPIC_API_KEY: 'k' });
    expect(answer.available ? '' : answer.reason).toMatch(/"claude-sonnet-9" is not a model name.*claude-sonnet-5/);
  });

  it('refuses a model that is not a chat model', () => {
    const answer = chatModelAvailability('whisper-1', { OPENAI_API_KEY: 'k' });
    expect(answer.available ? '' : answer.reason).toMatch(/not a chat model \(it serves transcription\)/);
  });

  // Exactly what a call would do, so validation never accepts a name the call
  // refuses, nor refuses one it accepts.
  it('agrees with the call: development reaches every chat model', () => {
    expect(chatModelAvailability('claude-opus-5', {}).available).toBe(true);
  });
});

describe('boot validation of embedding widths', () => {
  it('accepts a Gemini-only map for both embedding columns', () => {
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({
          'text-embedding-3-large': 'gemini/gemini-embedding-001',
          'text-embedding-3-small': 'gemini/gemini-embedding-001',
        }),
      }),
    ).not.toThrow();
  });

  it('refuses a model too narrow for the column its name fills, naming the column and both numbers', () => {
    // raw_text stores 3072; text-embedding-3-small tops out at 1536. Refused,
    // never shortened or padded into the index.
    expect(() =>
      assertModelMapConfigured({
        OPENAI_API_KEY: 'k',
        MODEL_MAP: mapOf({ 'text-embedding-3-large': 'openai/text-embedding-3-small' }),
      }),
    ).toThrow(
      /MODEL_MAP\["text-embedding-3-large"\].*1 to 1536 dimensions.*knowledge\.raw_text\.embedding.*stores 3072/,
    );
  });

  it('refuses a wire model its provider file does not list, since nothing knows its width', () => {
    // text-embedding-005 yields 768: a 3072 column pointed at it must be
    // refused at boot, and an unlisted model is refused before its width is
    // even guessed at.
    expect(() =>
      assertModelMapConfigured({
        ...GOOGLE,
        MODEL_MAP: mapOf({ 'text-embedding-3-large': 'gemini/text-embedding-005' }),
      }),
    ).toThrow(/MODEL_MAP\["text-embedding-3-large"\] is "gemini\/text-embedding-005", an embedding model the gemini provider does not list/);
  });
});

describe('the boot warning for models nobody configured', () => {
  // Mirrors how server.ts builds each use: resolve the name, then ask the
  // provider (not the raw vendor keys) whether it is configured.
  const use = (name: 'claude-sonnet-5' | 'claude-opus-5', env: NodeJS.ProcessEnv): DefaultModelUse => {
    const resolved = resolveModel(name, env);
    return { resolved, configured: providerCredentialsPresent(resolved.provider, env) };
  };

  it('stays quiet when a MODEL_MAP sends everything to a Gemini that has its service account', () => {
    const env = {
      ...GOOGLE,
      MODEL_MAP: mapOf({ 'claude-sonnet-5': 'gemini/gemini-3.8-flash', 'claude-opus-5': 'gemini/gemini-3.8-flash' }),
    };
    expect(modelKeyWarning([use('claude-sonnet-5', env), use('claude-opus-5', env)], env)).toBeNull();
  });

  it('warns naming anthropic when nothing at all is set', () => {
    const env = {};
    const warning = modelKeyWarning([use('claude-sonnet-5', env), use('claude-opus-5', env)], env);
    expect(warning).toMatch(/anthropic/);
    expect(warning).toMatch(/ANTHROPIC_API_KEY/);
    expect(warning).toMatch(/MODEL_MAP/);
  });

  it('warns naming openai when the default agent model is mapped there without a key', () => {
    const env = { MODEL_MAP: mapOf({ 'claude-sonnet-5': 'openai/gpt-5' }), ANTHROPIC_API_KEY: 'k' };
    const warning = modelKeyWarning([use('claude-sonnet-5', env), use('claude-opus-5', env)], env);
    expect(warning).toMatch(/openai/);
    expect(warning).toMatch(/OPENAI_API_KEY/);
    expect(warning).not.toMatch(/anthropic/);
  });

  it('mentions every unconfigured provider once, not once per use', () => {
    const env = {};
    const warning = modelKeyWarning([use('claude-sonnet-5', env), use('claude-opus-5', env)], env);
    expect(warning?.match(/anthropic/g)).toHaveLength(1);
  });
});
