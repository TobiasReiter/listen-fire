/**
 * Live verification of the `web-research` plugin — how it actually performs
 * on a set of entries you name.
 *
 * The dev loop has fakes for channels and CRMs but none for the search index,
 * so this drives the registered implementation directly against the stack's
 * real keys and prints, per entry, what became of it and what it cost. The
 * run log carries the `[transform:web-research]` trail: the queries, the
 * candidates, the confidence.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_web_research.ts [--plugin-only|--e2e-only]
 *
 * Two legs:
 *   1. nine entries — six with a line of context, three bare — straight at
 *      the plugin;
 *   2. one extraction end to end through the engine, over a two-line
 *      transcript: the entry with an address is fetched, the bare one is
 *      researched, and the resolved address has to land on it.
 */
import { BARE_HOST } from 'movement-engine/services/movement_engine/host_kit';
import './_profile_loader';

// Composition root — registers the services the fetch path reaches.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';

import { parseProgram } from 'movement-lang';

import { runInContext } from '../../services/context/utils';
import { buildExtractSpec, materializeExtract } from 'movement-engine/services/movement_engine/extraction';
import { makeAnthropicLlmClient } from '../../services/translation_graph/movement/llm_clients';
import { registryTransformInvoker } from '../../services/translation_graph/movement/transform_invoker';
import { getTransform } from '../../services/translation_graph/engine/transforms';
import { makeStablePosition } from 'movement-engine/services/translation_graph/types';
import { WebSearchService } from '../../services/web_search';
import { ensureDevLoopTeam } from './_lib';

import type { ExtractExpression, ExprSlot } from 'movement-lang';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';
import type { ContextDependentInput } from '../../services/translation_graph/engine/transforms';

// ── The test set ──────────────────────────────────────────────────────────

/** Six that arrived with a line of traction text, three that arrived bare.
 *  The contexts are short reconstructions of what a message carried — enough
 *  to anchor a search, which is the whole thing under test.
 *
 *  These are placeholders: a search index has nothing on them, so what the
 *  run reports about them is only the shape of the answer. Put the entries
 *  you actually care about here before reading anything into the result. */
const ENTRIES: Array<{ name: string; context: string }> = [
  { name: 'Hollowbrook', context: 'AI agents for insurance claims, Copenhagen' },
  { name: 'Larkfield', context: 'canteen software for schools and workplaces, Denmark' },
  { name: 'Quillbank', context: 'ambient clinical notes for doctors, London' },
  { name: 'Fernway', context: 'a coaching marketplace for managers, Amsterdam' },
  { name: 'Tessellate AI', context: 'an AI music production workstation, London' },
  { name: 'Wayfarer', context: 'AI safety infrastructure for model deployments' },
  { name: 'Marlow', context: '' },
  { name: 'Orbix', context: '' },
  { name: 'Tarrow', context: '' },
];

// ── Counting what an entry costs ──────────────────────────────────────────

const cost = { models: 0, searches: 0, fetches: 0 };

/** Count what one entry costs, at the wire. Every one of these leaves the
 *  process as an HTTP request, and counting there needs nothing of the
 *  modules in between — the module exports are getters and cannot be wrapped
 *  in place. */
function countCalls(): void {
  const send = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof send>[0], init?: Parameters<typeof send>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return '';
      }
    })();
    if (host.endsWith('anthropic.com')) cost.models += 1;
    else if (host.endsWith('googleapis.com')) cost.searches += 1;
    else if (host.includes('brightdata') || host.includes('luminati')) cost.fetches += 1;
    return send(input, init);
  };
}

function resetCost(): void {
  cost.models = 0;
  cost.searches = 0;
  cost.fetches = 0;
}

// ── Leg 1: the nine names ─────────────────────────────────────────────────

/** The built-in nine, or the `Name=context` pairs given on the command line —
 *  what a message actually said is the thing under test, so it has to be
 *  possible to try a different line without editing this file. */
function entriesFromArgv(): Array<{ name: string; context: string }> {
  const pairs = process.argv.slice(2).filter((arg) => arg.includes('='));
  if (pairs.length === 0) return ENTRIES;
  return pairs.map((pair) => {
    const at = pair.indexOf('=');
    return { name: pair.slice(0, at), context: pair.slice(at + 1) };
  });
}

async function runPlugin(userId: string | null): Promise<void> {
  const impl = getTransform('web-research');
  if (!impl) throw new Error('web-research is not registered');

  console.log('\n── the nine entries ──\n');
  console.log(
    'name'.padEnd(12),
    'outcome'.padEnd(14),
    'wall',
    ' models',
    'searches',
    'fetches',
    ' website',
  );

  for (const entry of entriesFromArgv()) {
    resetCost();
    const input: ContextDependentInput = {
      kind: 'context-dependent',
      sourceNode: makeStablePosition({
        adapterType: 'fixture',
        recordType: 'fixture.company',
        recordId: `verify-web-research-${entry.name}`,
        data: {},
      }),
      config: { name: entry.name, context: entry.context, website: '', linkedin: '' },
      extractedContext: {},
    };

    const started = Date.now();
    const output = userId
      ? await runInContext(() => impl.run(input), { id: userId })
      : await impl.run(input);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    const website = (output.properties?.website as string | undefined) ?? '';
    const text = (output.edges?.fetchedUrl as { data?: { text?: string } } | undefined)?.data?.text;
    console.log(
      entry.name.padEnd(12),
      String(output.outcome ?? 'none').padEnd(14),
      `${seconds}s`.padStart(5),
      String(cost.models).padStart(6),
      String(cost.searches).padStart(8),
      String(cost.fetches).padStart(7),
      ` ${website}${text ? ` (${text.length} chars)` : ''}`,
    );
  }
}

// ── Leg 2: one extraction, end to end ─────────────────────────────────────

const TRANSCRIPT = [
  'Two from this morning:',
  '- Northwind Analytics (northwindanalytics.com) — warehouse-native BI for retail, Manchester.',
  '- Larkfield — canteen software for schools and workplaces, Denmark. No link yet.',
].join('\n');

const PROGRAM = `
import { email } from adapters
import { fetch_url, web_research } from plugins

inbox = email()

function \`Intake\`(m: <inbox-[:Email]->>) {
  found = extract from [transcript] {
    node company: "each company named in this message" {
      name:        "the company's name"
      description: "what the message says about it"
      website:     "the company's web address, if the message gives one"
      linkedin:    "the company's LinkedIn address, if the message gives one"
    } through [
      fetch_url(url: website, email: "x@y.z"),
      web_research(name: name, context: description, website: website, linkedin: linkedin)
    ] {
      website:     "the company's web address — the resolved one, verbatim, otherwise keep the value already here"
      description: "what the company does, in a sentence, from its own page where there is one"
    }
  }
}
`;
import { registeredPluginSpecs } from '../../services/translation_graph/movement/catalog';

/** The one extract in the program, whatever the surrounding AST looks like. */
function findExtract(node: unknown): ExtractExpression | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const candidate = node as Record<string, unknown>;
  if (Array.isArray(candidate.stages) && Array.isArray(candidate.from)) {
    return candidate as unknown as ExtractExpression;
  }
  for (const value of Object.values(candidate)) {
    const found = findExtract(value);
    if (found) return found;
  }
  return undefined;
}

async function runEndToEnd(userId: string | null): Promise<void> {
  const extract = findExtract(parseProgram(PROGRAM));
  if (!extract) throw new Error('no extract in the program');

  const trace: MovementTraceEntry[] = [];
  const emission = await runInContext(
    async () =>
      materializeExtract({
        extract,
        spec: await buildExtractSpec(extract),
        runtime: {
          // Outside a run: a bare host's wall clock and random ids.
          world: BARE_HOST,
          llm: makeAnthropicLlmClient(),
          transformInvoker: registryTransformInvoker,
          plugins: registeredPluginSpecs(),
          // The only slots this program has: the `from` binding and the one
          // quoted argument.
          evalSlot: async (slot: ExprSlot) => {
            const raw = slot.raw.trim();
            const value = raw === 'transcript' ? TRANSCRIPT : raw.replace(/^"|"$/g, '');
            return { value, provenance: { origins: [] } };
          },
          trace,
        },
      }),
    { id: userId ?? '' },
  );

  console.log('\n── one extraction, end to end ──\n');
  for (const entity of emission.children.get('company') ?? []) {
    console.log(entity.fields);
  }

  // What the leg is for: the one that arrived with an address is fetched and
  // the research stands down; the bare one is researched and its address is
  // the one the stage behind it declared.
  const outcomes = trace.flatMap((entry) =>
    entry.kind === 'plugin' && entry.plugin === 'web_research' ? [entry.outcome] : [],
  );
  const bare = (emission.children.get('company') ?? []).find((e) =>
    String(e.fields.name ?? '').includes('Larkfield'),
  );
  console.log('\nweb_research outcomes:', outcomes.join(', '));
  console.log('the bare entry’s website:', bare?.fields.website ?? '(none)');

  console.log('\ntrace:');
  for (const entry of trace) {
    if (entry.kind === 'plugin') {
      console.log(
        `  plugin ${entry.plugin} on ${entry.node}: ` +
          `${entry.outcome ?? entry.skippedParam ?? 'ran'}` +
          `${entry.chars ? ` (${entry.chars} chars)` : ''}`,
      );
    }
    if (entry.kind === 'extraction') {
      console.log(
        `  extraction ${entry.node}: ${entry.skipped ?? `${entry.inputChars} chars`}` +
          `${entry.plugins ? ` [${entry.plugins.map((p) => `${p.plugin}:${p.outcome}`).join(', ')}]` : ''}`,
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const only = process.argv[2];

  // The homepage fetch goes through the shared plumbing, which stores what it
  // fetched and therefore needs a tenant. Without a reachable stack the run
  // still happens — the fetches fail, which is itself worth seeing.
  let userId: string | null = null;
  try {
    ({ userId } = await ensureDevLoopTeam());
  } catch (error) {
    console.warn(`No dev-loop team (${String(error)}) — running without one; fetches will fail.`);
  }

  countCalls();
  if (only !== '--e2e-only') await runPlugin(userId);
  if (only !== '--plugin-only') await runEndToEnd(userId);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
