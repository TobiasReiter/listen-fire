// One web plugin: its declaration (the engine package's data) and its body,
// and how what a body made becomes the answer a host hands the run.

import type { CostEnvelope } from 'movement-engine/public/models';
import type { PluginAnswer } from 'module-kit';
import type { PluginDeclaration } from 'movement-engine/public/plugins';
import type { Emission } from './addresses';

import { costEnvelopeMicrodollars } from 'movement-engine/public/models';
import { tools } from './tools';

/**
 * What a plugin is called with. A plugin whose declared data dependency is
 * `none` runs before any extraction and has only its arguments; every other
 * reads the fields extracted so far as well.
 */
export type PluginInput =
  | { kind: 'pre-extraction'; config: Record<string, unknown> }
  | { kind: 'context-dependent'; config: Record<string, unknown>; extractedContext: unknown };

/**
 * What a plugin made: `properties` to attach to the record it ran on, `edges`
 * of records it emitted (each fetched page, say), how it went in its own words
 * (`outcome`), and what its own work cost when nothing it called priced it.
 */
export interface PluginOutput {
  properties?: Record<string, unknown>;
  edges?: Record<string, Emission | Emission[]>;
  outcome?: string;
  cost?: CostEnvelope;
}

export interface WebPlugin {
  declaration: PluginDeclaration;
  run(input: PluginInput): Promise<PluginOutput>;
}

/** The input a plugin's declared data dependency says it is called with. */
export function inputFor(
  plugin: WebPlugin,
  invocation: { config: Record<string, unknown>; extractedContext: unknown },
): PluginInput {
  return plugin.declaration.signature.dataDependency === 'none'
    ? { kind: 'pre-extraction', config: invocation.config }
    : { kind: 'context-dependent', config: invocation.config, extractedContext: invocation.extractedContext };
}

/**
 * What a plugin made, as the run receives it. Two ways it reaches the
 * extraction that follows: an emitted record carries the content it fetched
 * on `text` (fed to the extractor as fresh source), and `properties` are the
 * fields the next stage can read. Each emitted record also comes back as a
 * record, its stored document turned into a file value; a document that can
 * no longer be found drops the `file` and keeps the rest.
 */
export async function answerOf(output: PluginOutput): Promise<PluginAnswer> {
  const emitted = emittedRecords(output.edges);
  const text = emitted.flatMap((r) => (typeof r.text === 'string' && r.text.trim() ? [r.text] : [])).join('\n\n');
  const handles = [...new Set(emitted.flatMap((r) => (r.file !== null && r.file !== undefined ? [r.file] : [])))];
  const values = handles.length > 0 ? await tools().fileValues(handles) : [];
  const fileOf = new Map(handles.map((handle, i) => [handle, values[i]]));
  const records = emitted.map((record) => {
    const { file, ...rest } = record;
    const value = file !== null && file !== undefined ? fileOf.get(file) : undefined;
    return value !== undefined ? { ...rest, file: value } : rest;
  });

  const answer: PluginAnswer = {};
  if (text) answer.text = text;
  if (output.properties !== undefined && Object.keys(output.properties).length > 0) answer.data = { ...output.properties };
  if (records.length > 0) answer.records = records as PluginAnswer['records'];
  if (output.outcome) answer.outcome = output.outcome;
  if (output.cost !== undefined) answer.costMicrodollars = costEnvelopeMicrodollars(output.cost);
  return answer;
}

function emittedRecords(edges: PluginOutput['edges']): Array<Record<string, unknown>> {
  if (!edges) return [];
  const emitted: Array<Record<string, unknown>> = [];
  for (const emissions of Object.values(edges)) {
    for (const emission of Array.isArray(emissions) ? emissions : [emissions]) {
      if (emission.data !== null && typeof emission.data === 'object') {
        emitted.push({ ...(emission.data as Record<string, unknown>) });
      }
    }
  }
  return emitted;
}
