// What a module answers to the protocol's `manifest` method — one function
// for both transports, so a module served as a process and the same module
// loaded in process declare the same thing. The answer is parsed with the
// protocol's own manifest schema, which refuses a declaration without its
// method (and the reverse) and a name declared twice: a module that gets its
// pairing wrong fails when it is first loaded, never at the first poll.

import {
  MANIFEST_PROTOCOL_VERSION,
  METHODS,
  type MethodName,
  type WireManifestResultShape,
  type WirePluginSpecShape,
} from 'engine-contracts';
import type { PluginSpec } from 'movement-lang';
import { BASE_RUNTIME_CAPABILITIES } from 'movement-engine/public/adapter';
import { pluginProgramName, pluginSpecOf } from 'movement-engine/public/plugins';

import type { AdapterModuleDefinition, AdapterModuleMethods, ModuleContext, ModuleDefinition, PluginModuleDefinition, PluginModuleMethods } from './define';

import { moduleSlug } from './define';
import { adapterProtocolMethods } from './server';

/** The module methods (beyond an adapter's) an instance implements. */
function moduleMethods(instance: object, names: readonly MethodName[]): MethodName[] {
  return names.filter((name) => typeof Reflect.get(instance, name) === 'function');
}

function adapterManifest(definition: AdapterModuleDefinition, instance: AdapterModuleMethods): unknown {
  const { manifest } = definition;
  return {
    protocolVersion: MANIFEST_PROTOCOL_VERSION,
    adapterType: instance.adapterType,
    supportedTriggers: instance.supportedTriggers,
    runtimeCapabilities: instance.runtimeCapabilities(),
    methods: [...adapterProtocolMethods(instance), ...moduleMethods(instance, ['poll', 'runPeriodic', 'refreshCredential'])],
    ...(instance.webhookEventTypeId !== undefined ? { webhookEventTypeId: instance.webhookEventTypeId } : {}),
    ...(manifest.subscribableEvents !== undefined ? { subscribableEvents: [...manifest.subscribableEvents] } : {}),
    ...(manifest.defaultSubscribedEvents !== undefined ? { defaultSubscribedEvents: [...manifest.defaultSubscribedEvents] } : {}),
    ...(manifest.listenConfig !== undefined
      ? {
          listenConfig: manifest.listenConfig.map((entry) => ({
            key: entry.key,
            ...(entry.required !== undefined ? { required: entry.required } : {}),
            ...(entry.format !== undefined ? { format: entry.format } : {}),
          })),
        }
      : {}),
    ...(definition.credentials.length > 0 ? { credentials: [...definition.credentials] } : {}),
    ...(definition.inbound !== undefined ? { inbound: definition.inbound } : {}),
    ...(definition.poll !== undefined ? { poll: definition.poll } : {}),
    ...(definition.periodic !== undefined && definition.periodic.length > 0 ? { periodic: [...definition.periodic] } : {}),
    ...declaredLimits(definition),
  };
}

function declaredLimits(definition: ModuleDefinition): { limits?: unknown[] } {
  return definition.limits !== undefined && definition.limits.length > 0 ? { limits: [...definition.limits] } : {};
}

function pluginManifest(definition: PluginModuleDefinition, instance: PluginModuleMethods): unknown {
  return {
    protocolVersion: MANIFEST_PROTOCOL_VERSION,
    adapterType: moduleSlug(definition.name),
    supportedTriggers: [],
    runtimeCapabilities: BASE_RUNTIME_CAPABILITIES,
    methods: ['manifest', ...moduleMethods(instance, ['invokePlugin', 'refreshCredential'])],
    ...(definition.credentials.length > 0 ? { credentials: [...definition.credentials] } : {}),
    ...declaredLimits(definition),
    plugins: {
      package: definition.name,
      plugins: definition.plugins.map((declaration) => ({ name: declaration.signature.name, spec: pluginSpecOf(declaration) })),
    },
  };
}

/** A module with what its `create` returned, told apart by kind. */
export type LoadedModule =
  | { kind: 'adapter'; definition: AdapterModuleDefinition; instance: AdapterModuleMethods }
  | { kind: 'plugin'; definition: PluginModuleDefinition; instance: PluginModuleMethods };

/** Pair a definition with what its `create` built. */
export function loadedModule(definition: ModuleDefinition, ctx: ModuleContext): LoadedModule {
  return definition.kind === 'adapter'
    ? { kind: 'adapter', definition, instance: definition.create(ctx) }
    : { kind: 'plugin', definition, instance: definition.create(ctx) };
}

/** The module's `manifest` answer, checked. The methods are read off what its
 *  `create` returned. */
export function moduleManifest(loaded: LoadedModule): WireManifestResultShape {
  const raw = loaded.kind === 'adapter' ? adapterManifest(loaded.definition, loaded.instance) : pluginManifest(loaded.definition, loaded.instance);
  const parsed = METHODS.manifest.result.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `module ${loaded.definition.name}: its manifest is refused: ${issue ? `${issue.path.join('.') || '(manifest)'}: ${issue.message}` : 'invalid'}`,
    );
  }
  return parsed.data;
}

/**
 * The plugins a manifest declares, as a catalog lists them for the checker:
 * keyed by the program's spelling, each tagged with the package it is
 * imported from.
 */
export function pluginSpecsOfManifest(manifest: Pick<WireManifestResultShape, 'plugins'>): Record<string, PluginSpec & { package: string }> {
  const declared = manifest.plugins;
  if (declared === undefined) return {};
  const specs: Record<string, PluginSpec & { package: string }> = {};
  for (const plugin of declared.plugins) {
    specs[pluginProgramName(plugin.name)] = { ...checkerSpec(plugin.spec), package: declared.package };
  }
  return specs;
}

/** The wire's spec as the checker's. The envelope's shape is validated by
 *  `WirePluginSpec`; the inner shapes (argument types, effects, outputs) are
 *  the checker's own vocabulary, which the checker validates as it reads the
 *  catalog. Sole sanctioned boundary `as`: a validated wire value re-entering
 *  the checker's types. */
function checkerSpec(spec: WirePluginSpecShape): PluginSpec {
  return spec as unknown as PluginSpec;
}
