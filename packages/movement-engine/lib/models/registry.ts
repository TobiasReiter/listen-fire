// Every model name the code may ask for, closed and enumerable.
//
// A name here is a PREFERENCE, not an address: the model map (`map.ts`) decides
// which vendor answers it on this deployment and what that vendor calls it. A
// name the map says nothing about goes to its home vendor under its own name,
// which is why an empty map reproduces a deployment that never heard of maps.
//
// Dated names stay dated where that is what callers send today: the registry
// name is also the wire name on the home vendor, so undating one would change
// what reaches Anthropic's API for every deployment at once.

export type Capability = 'chat' | 'transcription' | 'embedding' | 'image';

/** Where a name goes when the map is silent about it. */
export type HomeVendor = 'anthropic' | 'openai';

export interface RegistryEntry {
  capability: Capability;
  home: HomeVendor;
}

export const models = {
  'claude-fable-5-1': { capability: 'chat', home: 'anthropic' },
  'claude-opus-5': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-8': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-7': { capability: 'chat', home: 'anthropic' },
  'claude-opus-4-6': { capability: 'chat', home: 'anthropic' },
  'claude-sonnet-5': { capability: 'chat', home: 'anthropic' },
  'claude-haiku-4-5': { capability: 'chat', home: 'anthropic' },
  'claude-haiku-4-5-20251001': { capability: 'chat', home: 'anthropic' },
  'whisper-1': { capability: 'transcription', home: 'openai' },
  'text-embedding-3-large': { capability: 'embedding', home: 'openai' },
  'text-embedding-3-small': { capability: 'embedding', home: 'openai' },
  'gpt-image-1': { capability: 'image', home: 'openai' },
} as const satisfies Record<string, RegistryEntry>;

export type ModelName = keyof typeof models;

export function isModelName(s: string): s is ModelName {
  return Object.prototype.hasOwnProperty.call(models, s);
}

export const modelNames: readonly ModelName[] = Object.keys(models).filter(isModelName);

/** The names that serve one capability. Each capability's entry point takes
 *  its own, so asking the transcriber for a chat model is a type error rather
 *  than a request some vendor refuses at run time. */
export type ModelNameFor<C extends Capability> = {
  [K in ModelName]: (typeof models)[K]['capability'] extends C ? K : never;
}[ModelName];

export type ChatModelName = ModelNameFor<'chat'>;
export type TranscriptionModelName = ModelNameFor<'transcription'>;
export type EmbeddingModelName = ModelNameFor<'embedding'>;
export type ImageModelName = ModelNameFor<'image'>;

export function hasCapability<C extends Capability>(name: ModelName, capability: C): name is ModelNameFor<C> {
  return models[name].capability === capability;
}

export const chatModelNames: readonly ChatModelName[] = modelNames.filter(
  (name): name is ChatModelName => hasCapability(name, 'chat'),
);

/** A model name from outside the code — an env var, a CLI flag — refused with
 *  its source named when it is not one the registry knows. */
export function parseModelName(value: string, source: string): ModelName {
  if (isModelName(value)) return value;
  throw new Error(`${source} is "${value}", which is not a model name this code uses. Known names: ${modelNames.join(', ')}.`);
}

/** {@link parseModelName}, and refused too when the name is not a chat model. */
export function parseChatModelName(value: string, source: string): ChatModelName {
  const name = parseModelName(value, source);
  if (hasCapability(name, 'chat')) return name;
  throw new Error(`${source} is "${value}", which is not a chat model (it serves ${models[name].capability}).`);
}
