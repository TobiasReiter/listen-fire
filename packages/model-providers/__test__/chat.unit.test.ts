// Which provider object a chat call gets. Both vendor constructors are mocked:
// this is about which one is built, with what, and nothing reaches a network.

const anthropicCtor = jest.fn();
const vertexCtor = jest.fn();

jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    anthropicCtor(options);
    return { kind: 'anthropic', options };
  }),
}));

jest.mock('@anthropic-ai/vertex-sdk', () => ({
  __esModule: true,
  AnthropicVertex: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
    vertexCtor(options);
    return { kind: 'vertex', options };
  }),
}));

const googleAuth = jest.fn().mockReturnValue({ auth: 'google' });
jest.mock('movement-engine/lib/google_cloud', () => ({
  ...jest.requireActual('movement-engine/lib/google_cloud'),
  googleAuth: (...args: unknown[]) => googleAuth(...args),
}));

const GOOGLE = {
  GOOGLE_PRIVATE_KEY: 'pk',
  GOOGLE_CLIENT_EMAIL: 'robot@example.iam.gserviceaccount.com',
  GOOGLE_PROJECT_ID: 'a-project',
};

// Re-imported per test: the provider clients are memoised for the process.
function load() {
  let mod: typeof import('../chat') | undefined;
  jest.isolateModules(() => {
    mod = require('../chat');
  });
  if (!mod) throw new Error('module did not load');
  return mod;
}

beforeEach(() => jest.clearAllMocks());

describe('chatCallFor', () => {
  it('sends a name to Anthropic under its own name on an empty map', () => {
    const call = load().chatCallFor('claude-sonnet-5', { ANTHROPIC_API_KEY: 'sk' });
    expect(call.wireModel).toBe('claude-sonnet-5');
    expect(call.resolved.provider).toBe('anthropic');
    expect(call.client).toMatchObject({ kind: 'anthropic' });
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk' });
    expect(vertexCtor).not.toHaveBeenCalled();
  });

  it('keeps a dated name dated on the wire', () => {
    const call = load().chatCallFor('claude-haiku-4-5-20251001', { ANTHROPIC_API_KEY: 'sk' });
    expect(call.wireModel).toBe('claude-haiku-4-5-20251001');
  });

  it('sends a mapped name to Vertex under the map’s spelling', () => {
    const env = {
      ...GOOGLE,
      GOOGLE_MODEL_REGION: 'europe-west1',
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'vertex/claude-sonnet-5' }),
    };
    const call = load().chatCallFor('claude-sonnet-5', env);
    expect(call.wireModel).toBe('claude-sonnet-5');
    expect(call.resolved.provider).toBe('vertex');
    expect(call.client).toMatchObject({ kind: 'vertex' });
    expect(vertexCtor).toHaveBeenCalledWith({
      projectId: 'a-project',
      region: 'europe-west1',
      googleAuth: { auth: 'google' },
    });
    expect(anthropicCtor).not.toHaveBeenCalled();
  });

  it('addresses Claude on Google’s global endpoint by default', () => {
    load().chatCallFor('claude-opus-5', {
      ...GOOGLE,
      MODEL_MAP: JSON.stringify({ 'claude-opus-5': 'vertex/claude-opus-5' }),
    });
    expect(vertexCtor).toHaveBeenCalledWith(expect.objectContaining({ region: 'global' }));
  });

  it('sends a mapped name to Gemini under the map’s spelling', () => {
    const call = load().chatCallFor('claude-sonnet-5', {
      ...GOOGLE,
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'gemini/gemini-3-pro' }),
    });
    expect(call.wireModel).toBe('gemini-3-pro');
    expect(call.resolved.provider).toBe('gemini');
    expect(typeof call.client.messages.create).toBe('function');
    expect(anthropicCtor).not.toHaveBeenCalled();
    expect(vertexCtor).not.toHaveBeenCalled();
  });

  it('builds each provider client once', () => {
    const { chatCallFor } = load();
    chatCallFor('claude-sonnet-5', { ANTHROPIC_API_KEY: 'sk' });
    chatCallFor('claude-opus-5', { ANTHROPIC_API_KEY: 'sk' });
    expect(anthropicCtor).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that is not a chat model, at the type level', () => {
    // Never called: the assertion is that this does not compile.
    const askWhisperToChat = () =>
      // @ts-expect-error whisper-1 transcribes; it is not a ChatModelName.
      load().chatCallFor('whisper-1', {});
    expect(typeof askWhisperToChat).toBe('function');
  });

  it('sends a name mapped to openai through the OpenAI translator under the map’s spelling', () => {
    const call = load().chatCallFor('claude-sonnet-5', {
      OPENAI_API_KEY: 'k',
      MODEL_MAP: JSON.stringify({ 'claude-sonnet-5': 'openai/gpt-5' }),
    });
    expect(call.resolved.provider).toBe('openai');
    expect(call.wireModel).toBe('gpt-5');
    expect(typeof call.client.messages.create).toBe('function');
    expect(anthropicCtor).not.toHaveBeenCalled();
  });
});
