/**
 * Replay of the two drifted envelopes that killed three production runs.
 *
 * A production morning-recap run: a stage-2 per-entity refinement came
 * back content-correct with the wrong packaging — the field map BARE at the top
 * level, `{ name: { evidence, value }, … }`, where the guide asked for
 * `{ "x:entry#26": [ … ] }`. Asked again, it answered with an ARRAY of those
 * maps. With 40-85 per-entity calls in a run, one drifted call killed the lot.
 *
 * This drives `materializeExtract` — the real region schema, the real
 * validate-then-retry loop, the real trace — over four entities whose
 * refinements are answered with, in order: the bare map, the bare list, the
 * label the model chose, and garbage that is never salvageable. No stack, no
 * network: the runtime dependencies are supplied here and the LLM client
 * answers from canned bodies.
 *
 *   pnpm --filter api exec ts-node --project tsconfig.dev.json --transpile-only \
 *     -r tsconfig-paths/register src/scripts/dev/verify_envelope_salvage.ts
 */

import type { ExtractExpression, Span } from 'movement-lang';
import {
  ROOT_EXTRACT_DESCRIPTION,
  materializeExtract,
  type ExtractNodeSpec,
} from '../../services/movement_engine/extraction';
import type { MovementTraceEntry } from '../../services/movement_engine/expression';
import { NO_PROVENANCE } from '../../services/movement_engine/provenance';
import { registeredPluginSpecs } from '../../services/translation_graph/movement/catalog';

const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

const cited = (value: string) => ({ evidence: `the line reading "${value}"`, value });

/** `entry` is read in two stages, as the production movement reads it: the
 *  line's own facts first, then a refinement that adds the flag reason. */
const entryNode: ExtractNodeSpec = {
  name: 'entry',
  description: 'each LinkedIn or company line in the message',
  stages: [
    {
      through: [],
      fields: [
        { name: 'name', description: 'the name on the line' },
        { name: 'url', description: 'the link on the line' },
      ],
      children: [],
    },
    {
      through: [],
      fields: [{ name: 'flag_reason', description: 'why the line was flagged' }],
      children: [],
    },
  ],
  exported: ['name', 'url', 'flag_reason'],
};

const spec: ExtractNodeSpec = {
  name: 'watch',
  description: ROOT_EXTRACT_DESCRIPTION,
  stages: [{ through: [], fields: [], children: [entryNode] }],
  exported: [],
};

const extract: ExtractExpression = {
  from: [{ raw: 'text', span }],
  stages: [{ fields: [], children: [], span }],
  span,
};

const NAMES = ['Flintt', 'Gondor', 'Rohan', 'Numenor'];

/** The refinement of one entity, packaged four different ways. Only the last
 *  is unsalvageable — the first three are the production shapes. */
function refinement(name: string, key: string): unknown {
  const answer = { flag_reason: cited(`${name} — fintech, London, Series A`) };
  switch (NAMES.indexOf(name)) {
    case 0:
      return answer; // the bare field map, exactly as production wrote it
    case 1:
      return [answer]; // the array the retry came back with
    case 2:
      return { entry: [answer] }; // the label the model chose for itself
    default:
      return { por_favor: 'nada' }; // nothing structural to read
  }
}

async function main(): Promise<void> {
  const asked: string[] = [];
  const trace: MovementTraceEntry[] = [];

  const emission = await materializeExtract({
    extract,
    spec,
    runtime: {
      llm: {
        async call(input) {
          asked.push(input.system);
          const key = /one key — `([^`]+)`/.exec(input.system)?.[1];
          if (!key) throw new Error('no answer key in the system prompt');
          // A per-entity call quotes the entity it is asking about.
          const about = NAMES.find((name) => input.userMessage.includes(`"${name}"`));
          if (!about) {
            return {
              parsedJson: {
                [key]: [{ entry: NAMES.map((name) => ({ name: cited(name), url: cited(name) })) }],
              },
            };
          }
          return { parsedJson: refinement(about, key) };
        },
      },
      transformInvoker: {
        async invoke() {
          throw new Error('this replay invokes no plugin');
        },
      },
      plugins: registeredPluginSpecs(),
      evalSlot: async () => ({
        value: `Four LinkedIn lines: ${NAMES.join(', ')}.`,
        provenance: NO_PROVENANCE,
      }),
      trace,
    },
  });

  const entries = emission.children.get('entry') ?? [];
  const extractions = trace.flatMap((e) => (e.kind === 'extraction' ? [e] : []));

  console.log(
    `calls made:       ${asked.length} (6 = one root + four refinements, the last one retried)`,
  );
  console.log(`entities kept:    ${entries.length} of ${NAMES.length}`);
  for (const entry of entries) {
    console.log(`  ${String(entry.fields.name).padEnd(9)} ${JSON.stringify(entry.fields.flag_reason)}`);
  }
  console.log('trace:');
  for (const e of extractions) {
    const notes = [
      e.envelopeRepaired ? `envelopeRepaired=${e.envelopeRepaired}` : undefined,
      e.failed ? `failed=${e.failed}` : undefined,
      e.fallback ? `fallback=${e.fallback}` : undefined,
      e.retried ? `retried` : undefined,
    ].filter((n) => n !== undefined);
    console.log(
      `  ${e.node ?? '?'} ${JSON.stringify(e.emissions)} ${notes.length > 0 ? notes.join(' ') : '—'}`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
