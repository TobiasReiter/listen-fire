// research — what does this person or company do?
//
// One plugin for the whole question. An entry carries whatever it carries — a
// name, a line of text, a website, a profile address — and the caller says
// what it wants to find out; the plugin works out which of those is which and
// returns a dossier sized to the question.
//
// It replaces the three plugins an author previously had to choose between and
// wire so they stood down for each other. A link is an input now, not a reason
// to do nothing.
//
// The gate that costs nothing sits HERE rather than in either engine: an entry
// with no address and nothing distinctive said about it is refused before any
// engine is asked, so a bare name in a message costs the same nothing whichever
// engine is running. Every other decision belongs to the engine.

import type { PluginOutput, WebPlugin } from '../plugin';
import type {
  ResearchEngine,
  ResearchEngineName,
  ResearchInput,
  ResearchOptions,
  ResearchResult,
} from './contract';

import { normaliseUrl } from '../addresses';
import { logger, runFields, tools } from '../tools';
import { distinctiveContextTerms, distinctiveOrganisation } from '../search_hygiene';
import { agenticEngine } from './agentic';
import { constrainedEngine } from './constrained';
import { emptyUsage } from './contract';
import { RESEARCH_PLUGIN } from 'movement-engine/public/plugins';

export * from './contract';
export { constrainedEngine } from './constrained';
export { agenticEngine } from './agentic';

const LOG = '[transform:research]';


// ── Engine selection ──────────────────────────────────────────────────────

const ENGINES: Record<ResearchEngineName, ResearchEngine> = {
  constrained: constrainedEngine,
  agentic: agenticEngine,
};

/** The engine a run uses when the caller does not name one. Agentic by
 *  ruling (2026-09-10: it answers more of what the caller wants to know); an
 *  unset variable means the default, never a missing-configuration error. The
 *  comparison harness names the engine per call and ignores this. */
export function configuredEngine(): ResearchEngineName {
  return process.env.RESEARCH_ENGINE === 'constrained' ? 'constrained' : 'agentic';
}

/**
 * Research one entry, refusing before any spend when there is nothing to go
 * on. The engine is a parameter so the harness can run both over one entry;
 * everything else is the same question either way.
 */
export async function research(
  input: ResearchInput,
  options: ResearchOptions & { engine?: ResearchEngineName } = {},
): Promise<ResearchResult> {
  const run = runFields();
  const name = input.name.trim();
  const context = (input.context ?? '').trim();
  const urls = (input.urls ?? []).flatMap((u) => {
    const normalised = normaliseUrl(u);
    return normalised ? [normalised] : [];
  });

  // The gate. A placeholder is not a name to search for; a name with no
  // address and nothing distinctive said about it returns the world, and the
  // wrong answer is worse than none.
  const searchable = distinctiveOrganisation(name);
  const anchored =
    urls.length > 0 ||
    (searchable != null && distinctiveContextTerms(context, name).length > 0);
  if (!anchored) {
    logger.info(`${LOG} no_anchor`, {
      name,
      outcome: 'no_anchor',
      reason: searchable ? 'nothing distinctive in the context' : 'no distinctive name',
      ...run,
    });
    return { outcome: 'no_anchor', usage: emptyUsage() };
  }

  const engineName = options.engine ?? configuredEngine();
  return ENGINES[engineName]({ ...input, name, context, urls }, options);
}

// ── The plugin ────────────────────────────────────────────────────────────

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** The dossier as properties. Only what was found lands — an entry with
 *  nothing to say attaches nothing, and the outcome on the run record is what
 *  says why. */
function toOutput(result: ResearchResult): PluginOutput {
  const properties: Record<string, string> = {};
  if (result.summary) properties.summary = result.summary;
  if (result.confidence) properties.confidence = result.confidence;
  if (result.sources?.length) {
    properties.sources = result.sources.map((s, i) => `${i + 1}. ${s}`).join('\n');
  }
  if (result.website) properties.website = result.website;
  if (result.linkedin) properties.linkedin = result.linkedin;
  if (result.dossier) properties.dossier = result.dossier;

  return Object.keys(properties).length
    ? { properties, outcome: result.outcome }
    : { outcome: result.outcome };
}

export const researchPlugin: WebPlugin = {
  declaration: RESEARCH_PLUGIN,
  run: async (input): Promise<PluginOutput> => {
    if (input.kind !== 'context-dependent') {
      throw new Error(`research: expected context-dependent input, got ${input.kind}`);
    }
    const result = await research({
      name: text(input.config.name),
      context: text(input.config.context),
      questions: text(input.config.questions),
      urls: [text(input.config.website), text(input.config.linkedin), text(input.config.url)].filter(
        Boolean,
      ),
    });
    return toOutput(result);
  },
};
