// A plugin as data, and the checker's view of it.
//
// What a plugin accepts, what it hands back, what it may do and whether it may
// cost money is a fact about the plugin, not about the host that runs it: the
// checker reads it (through the catalog snapshot), the engine reads it (the
// same snapshot's `plugins`), and the host that implements it must agree. So
// it lives here, in the engine package, as data. Running a plugin stays the
// host's (`llm.transforms.invoke`): a host serves the plugins it implements
// and refuses the rest by name.

import { maybeAbsent, type PluginOutput, type PluginSpec, type SchemaFieldType } from 'movement-lang';

import type {
  ExpressionType,
  TransformOutputKind,
  TransformSignature,
} from '../translation_graph/types';

import { neverAsAny } from '../../lib/utils/types';

/**
 * One plugin's declaration: its signature (name, parameters, scheduling
 * dependency, declared effects and output) and whether invoking it may cost
 * money. A priced plugin is not started once its run has spent the cost cap
 * (`MOVEMENT_MAX_RUN_COST_USD`).
 */
export interface PluginDeclaration {
  signature: TransformSignature;
  priced: boolean;
}

/** The name a program writes for a plugin: movement identifiers can't carry
 *  dashes, so `vc-url-retrieval` is written `vc_url_retrieval`. */
export function pluginProgramName(registeredName: string): string {
  return registeredName.replace(/-/g, '_');
}

/** The declaration a program's name (or the registered one) refers to. */
export function pluginDeclarationNamed(
  declarations: readonly PluginDeclaration[],
  name: string,
): PluginDeclaration | undefined {
  const spelled = pluginProgramName(name);
  return declarations.find((d) => pluginProgramName(d.signature.name) === spelled);
}

/** Every declaration's checker surface, keyed the way a program spells it. */
export function pluginSpecsOf(declarations: readonly PluginDeclaration[]): Record<string, PluginSpec> {
  const plugins: Record<string, PluginSpec> = {};
  for (const declaration of declarations) {
    plugins[pluginProgramName(declaration.signature.name)] = pluginSpecOf(declaration);
  }
  return plugins;
}

/**
 * A plugin's declaration as the checker's plugin surface — ONE projection, so
 * the static catalog, the live one and the editor snapshot cannot disagree
 * about what a plugin accepts or what it does.
 *
 * `auto` params are what a `through [ … ]` stage is FED — the engine fills them
 * from the extract source — so they stay out of `args` and `requiredArgs`,
 * which are what a STAGE may write. They ride `fedArgs` instead, because a
 * plain call has no stage behind it and writes them itself.
 *
 * The effect row rides through verbatim, and so does the declared output —
 * absent stays absent either way, which is what keeps a plugin nobody has
 * described to `through [ … ]` stages. Whether invoking it may cost money
 * rides as `priced`, which the engine reads to refuse a priced plugin once the
 * run has spent its cap.
 */
export function pluginSpecOf(declaration: PluginDeclaration): PluginSpec {
  const { signature } = declaration;
  const authorParams = signature.params.filter((p) => !p.auto);
  const requiredArgs = authorParams.filter((p) => p.required === true).map((p) => p.name);
  // Two different facts, kept apart because they have different answers.
  //
  // An `auto` param is one parameter with two ways of being filled: inside a
  // stage the engine feeds it from the `from [ … ]` source, and a plain call
  // writes it itself. So it stays out of `args` (a stage may not write it) and
  // rides `fedArgs` (a plain call must).
  const fedArgs = signature.params
    .filter((p) => p.auto === true)
    .map((p) => ({ name: p.name, ...(p.required === true ? { required: true as const } : {}) }));
  // `fedByExtraction` is the stronger fact: the plugin reads the fields the
  // enclosing extract has produced and takes nothing of its own, so there is
  // no call an author could write. A plugin with parameters is not this,
  // whatever its scheduling dependency says — `dataDependency` says WHEN it
  // runs, not what it runs on.
  const fedByExtraction =
    signature.dataDependency === 'extracted_context' && authorParams.length === 0;
  const earlierOutputs = (signature.output?.previously ?? []).map((entry) => ({
    before: entry.before,
    output: pluginOutputOf(entry.output),
  }));
  // Every argument's declared type, the auto-fed ones included: a plain call
  // writes those itself.
  const argTypes = Object.fromEntries(
    signature.params.map((p) => [p.name, fieldTypeOfExpressionType(p.type)]),
  );
  return {
    args: authorParams.map((p) => p.name),
    priced: declaration.priced,
    argTypes,
    ...(requiredArgs.length ? { requiredArgs } : {}),
    ...(signature.effects !== undefined ? { effects: signature.effects } : {}),
    ...(fedArgs.length ? { fedArgs } : {}),
    ...(fedByExtraction ? { fedByExtraction: true } : {}),
    ...(signature.output !== undefined ? { output: pluginOutputOf(signature.output) } : {}),
    ...(earlierOutputs.length > 0 ? { earlierOutputs } : {}),
  };
}

/**
 * A declared plugin output as the checker's own type vocabulary. The signature
 * speaks `ExpressionType` + `optional`; the checker speaks `SchemaFieldType` +
 * `maybeAbsent`, which is the same two facts under the names the rest of the
 * language already uses. ONE projection, so what the engine hands back and what
 * the checker typed cannot disagree.
 */
function pluginOutputOf(output: TransformOutputKind): PluginOutput {
  switch (output.kind) {
    case 'value':
      return { kind: 'value', type: outputFieldType(output) };
    case 'record':
      return { kind: 'record', fields: outputFieldTypes(output.fields) };
    case 'records':
      return { kind: 'records', fields: outputFieldTypes(output.fields) };
    default:
      return neverAsAny(output);
  }
}

function outputFieldTypes(
  fields: Record<string, { type: ExpressionType; optional?: boolean }>,
): Record<string, SchemaFieldType> {
  const out: Record<string, SchemaFieldType> = {};
  for (const [name, field] of Object.entries(fields)) out[name] = outputFieldType(field);
  return out;
}

function outputFieldType(field: { type: ExpressionType; optional?: boolean }): SchemaFieldType {
  const base = fieldTypeOfExpressionType(field.type);
  if (field.optional !== true) return base;
  // `maybeAbsent` widens to undefined only for an undefined input, which a
  // projected base type never is.
  return maybeAbsent(base) ?? base;
}

/**
 * `ExpressionType` → `SchemaFieldType`. Deliberately narrow: a plugin's inputs
 * and outputs are scalars, lists of them, and nothing else. A `record` inside one would be a
 * node, and a node needs a graph to belong to — a plugin output that wants one
 * is a `record` output at the top, whose fields are these.
 */
function fieldTypeOfExpressionType(type: ExpressionType): SchemaFieldType {
  switch (type.kind) {
    case 'string':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
      return 'datetime';
    case 'file':
      return 'file';
    case 'enum':
      return { kind: 'enum', options: [...type.values] };
    case 'list':
      return { kind: 'list', of: fieldTypeOfExpressionType(type.element) };
    case 'json':
    case 'record':
      // Structured data nothing further describes — the data top type, which is
      // exactly what `json` means. A caller passes it through unchanged.
      return 'json';
    default:
      return neverAsAny(type);
  }
}
