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

import type { PluginManifest, TransformImpl, TransformOutput } from '../registry';
import type {
  ResearchEngine,
  ResearchEngineName,
  ResearchInput,
  ResearchOptions,
  ResearchResult,
} from './contract';
import type { TransformSignature } from '../../../types';

import { runFields } from '../../../../../lib/llm_usage';
import { logger } from '../../../../logger';
import { normaliseUrl } from '../fetch_resource';
import { distinctiveContextTerms, distinctiveOrganisation } from '../search_hygiene';
import { agenticEngine } from './agentic';
import { constrainedEngine } from './constrained';
import { emptyUsage } from './contract';
import { RESEARCH_HANDBOOK_SECTION } from './research_handbook_section';
import { importIdentifier } from '../../../movement/schema_projection';

export * from './contract';
export { constrainedEngine } from './constrained';
export { agenticEngine } from './agentic';

const LOG = '[transform:research]';

// ── Signature ─────────────────────────────────────────────────────────────
//
// The addresses are three named parameters rather than one list. A plugin
// argument that is a list LITERAL of field names checks clean and then throws
// at run time — the runtime resolves a bare field name only when it is the
// WHOLE argument — so `urls: [website, linkedin]` is not a shape an author can
// write today. Recorded in 1_contract.md.

export const RESEARCH_SIGNATURE: TransformSignature = {
  name: 'research',
  description:
    'Research one person or company from whatever the record carries — a name, a line of ' +
    'context, a website, a profile address — and attach a dossier that answers what you ask, ' +
    'with its sources and a confidence.',
  params: [
    {
      name: 'name',
      type: { kind: 'string' },
      required: true,
      description:
        'The name to research. Normally a field an earlier stage extracted, so each record ' +
        'is researched from its own name.',
    },
    {
      name: 'context',
      type: { kind: 'string' },
      description:
        'What the message said about it — what it does, where it is, who is behind it. This ' +
        'is what tells the subject apart from every other use of the word, and a record with ' +
        'no address and no context is left alone rather than guessed at.',
    },
    {
      name: 'questions',
      type: { kind: 'string' },
      description:
        'What you want to find out, in your own words ("what it does, which sector, where it ' +
        'is based"). The dossier is sized to this rather than to everything the web says.',
    },
    {
      name: 'website',
      type: { kind: 'string' },
      description:
        "The record's web address, when it has one. It is read as the subject's own words, " +
        'and nothing is searched for to replace it.',
    },
    {
      name: 'linkedin',
      type: { kind: 'string' },
      description:
        "The record's profile address, when it has one. A profile address settles who the " +
        'subject is, so everything found afterwards is checked against their own headline.',
    },
    {
      name: 'url',
      type: { kind: 'string' },
      description:
        'One more address the record carries — an article, an announcement, a listing. Read ' +
        'as evidence alongside the others.',
    },
  ],
  // Name, context and addresses are fields the enclosing extract produced, so
  // this only makes sense as a stage of an extraction.
  dataDependency: 'extracted_context',
  effects: { reads: ['the web'], ai: true },
  additions: {
    properties: {
      summary: { kind: 'string' },
      confidence: { kind: 'string' },
      sources: { kind: 'string' },
      website: { kind: 'string' },
      linkedin: { kind: 'string' },
      dossier: { kind: 'string' },
    },
  },
  // The dossier, read by name. Every field is optional because every one of them
  // is filled only when the research actually found it — a subject with no
  // confident match comes back with an outcome and nothing else.
  output: {
    kind: 'record',
    fields: {
      summary: {
        type: { kind: 'string' },
        optional: true,
        description: 'A short answer to what you asked, in prose.',
      },
      confidence: {
        type: { kind: 'string' },
        optional: true,
        description: 'How sure the reading is that this is the right subject.',
      },
      sources: {
        type: { kind: 'string' },
        optional: true,
        description: 'The addresses the answer rests on, numbered, one per line.',
      },
      website: {
        type: { kind: 'string' },
        optional: true,
        description: "The subject's own web address, as resolved.",
      },
      linkedin: {
        type: { kind: 'string' },
        optional: true,
        description: "The subject's profile address, as resolved.",
      },
      dossier: {
        type: { kind: 'string' },
        optional: true,
        description: 'The long form — everything read, kept for a later question.',
      },
    },
  },
};

export const RESEARCH_PLUGIN_MANIFEST: PluginManifest = {
  pluginName: RESEARCH_SIGNATURE.name,
  importName: importIdentifier(RESEARCH_SIGNATURE.name),
  displayName: 'Research',
  description:
    'Takes whatever a record carries — a name, a line of context, a website, a ' +
    'profile address — and researches the subject on the web, answering the ' +
    'question you asked it. Hands back a short synthesis, the content it rests ' +
    'on, the addresses it resolved, and how confident the reading is.',
  params: RESEARCH_SIGNATURE.params,
  contextAdditions:
    'Adds six fields to the record: the answer, how confident it is, the ' +
    'addresses it cites, the website and profile address it resolved or ' +
    'confirmed, and the content itself. Adds nothing at all when the record ' +
    'carried no address and nothing distinctive was said about it, or when ' +
    'nothing consistent with the subject could be found.',
  additions: RESEARCH_SIGNATURE.additions,
  handbookSection: RESEARCH_HANDBOOK_SECTION,
};

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
function toOutput(result: ResearchResult): TransformOutput {
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

export const researchImpl: TransformImpl = {
  signature: RESEARCH_SIGNATURE,
  // Every fetch, search and model call it makes is paid for.
  priced: true,
  run: async (input): Promise<TransformOutput> => {
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
