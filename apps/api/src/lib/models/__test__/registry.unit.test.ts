import { hasCapability, isModelName, modelNames, models, parseChatModelName } from 'movement-engine/lib/models/registry';

describe('the model registry', () => {
  it('knows its own names and nothing else', () => {
    expect(isModelName('claude-sonnet-5')).toBe(true);
    expect(isModelName('whisper-1')).toBe(true);
    expect(isModelName('claude-sonnet-4-9')).toBe(false);
    expect(isModelName('')).toBe(false);
    // Inherited object keys are not model names.
    expect(isModelName('toString')).toBe(false);
    expect(isModelName('__proto__')).toBe(false);
  });

  it('gives every entry a capability and a home vendor', () => {
    expect(modelNames.length).toBe(Object.keys(models).length);
    for (const name of modelNames) {
      expect(['chat', 'transcription', 'embedding', 'image']).toContain(models[name].capability);
      expect(['anthropic', 'openai']).toContain(models[name].home);
    }
  });

  it('keeps the dated Claude name callers send today', () => {
    expect(models['claude-haiku-4-5-20251001']).toEqual({ capability: 'chat', home: 'anthropic' });
  });

  it('narrows a name by what it serves', () => {
    expect(hasCapability('whisper-1', 'transcription')).toBe(true);
    expect(hasCapability('whisper-1', 'chat')).toBe(false);
    expect(parseChatModelName('claude-sonnet-5', 'X')).toBe('claude-sonnet-5');
    expect(() => parseChatModelName('gpt-image-1', 'X')).toThrow(/X is "gpt-image-1", which is not a chat model \(it serves image\)/);
  });
});
