/**
 * Replay of the production reply that killed a twelve-minute extraction.
 *
 * In production, ~50 entities × 5 fields: the run failed on
 * `entry.49.flag_reason.evidence: expected string, received undefined`, was
 * asked again, and failed on `entry.45.sourced_by.evidence: expected string,
 * received object`. Every VALUE in both replies was correct.
 *
 * This drives `materializeExtract` — the real schema synthesis, the real
 * validate-then-retry loop, the real trace — over a reply carrying both shapes
 * at production scale. No stack, no network: the three runtime dependencies are
 * supplied here and the LLM client answers from a canned body.
 *
 *   pnpm --filter api exec ts-node --project tsconfig.dev.json --transpile-only \
 *     -r tsconfig-paths/register src/scripts/dev/verify_evidence_tolerance.ts
 */

import type { ExtractExpression, Span } from 'movement-lang';
import type { MovementTraceEntry } from 'movement-engine/services/movement_engine/expression';

import { BARE_HOST } from 'movement-engine/services/movement_engine/host_kit';
import {
  ROOT_EXTRACT_DESCRIPTION,
  materializeExtract,
  type ExtractNodeSpec,
} from 'movement-engine/services/movement_engine/extraction';
import { NO_PROVENANCE } from 'movement-engine/services/movement_engine/provenance';
import { bundledPluginSpecs } from 'movement-engine/public/plugins';

const span: Span = { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } };

const FIELDS = ['name', 'url', 'kind', 'sourced_by', 'flag_reason'];

const entryNode: ExtractNodeSpec = {
  name: 'entry',
  description: 'each LinkedIn or company line in the message',
  stages: [
    {
      through: [],
      fields: FIELDS.map((name) => ({ name, description: `the ${name} on the line` })),
      children: [],
    },
  ],
  exported: FIELDS,
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

/** The reply as production wrote it: healthy entities, plus the two the
 *  schema rejected — one citation missing, one written as an object. */
function productionReply(): Record<string, unknown>[] {
  const cited = (value: string) => ({ evidence: `the line reading "${value}"`, value });
  return Array.from({ length: 50 }, (_, i) => {
    const record: Record<string, unknown> = {
      name: cited(`Company${i}`),
      url: cited(`https://www.linkedin.com/company/company${i}`),
      kind: cited('company'),
      sourced_by: cited('U0TESTUSER01'),
      flag_reason: cited('fintech, London, Series A'),
    };
    if (i === 49) record.flag_reason = { value: 'fintech, London, Series A' };
    if (i === 45) {
      record.sourced_by = {
        evidence: { quote: 'posted by U0TESTUSER01', offset: 412 },
        value: 'U0TESTUSER01',
      };
    }
    return record;
  });
}

async function main(): Promise<void> {
  const asked: string[] = [];
  const trace: MovementTraceEntry[] = [];

  const emission = await materializeExtract({
    extract,
    spec,
    runtime: {
      // Outside a run: a bare host's wall clock and random ids.
      world: BARE_HOST,
      llm: {
        async call(input) {
          asked.push(input.system);
          const key = /one key — `([^`]+)`/.exec(input.system)?.[1];
          if (!key) throw new Error('no answer key in the system prompt');
          return { parsedJson: { [key]: [{ entry: productionReply() }] } };
        },
      },
      transformInvoker: {
        async invoke() {
          throw new Error('this replay invokes no plugin');
        },
      },
      plugins: bundledPluginSpecs(),
      evalSlot: async () => ({
        value: 'Fifty LinkedIn lines, posted by U0TESTUSER01.',
        provenance: NO_PROVENANCE,
      }),
      trace,
    },
  });

  const entries = emission.children.get('entry') ?? [];
  const entry = trace.find((e) => e.kind === 'extraction');

  console.log(`calls made:            ${asked.length} (2 = it still fails and retries)`);
  console.log(`entities emitted:      ${entries.length}`);
  console.log(`entity 49 flag_reason: ${JSON.stringify(entries[49]?.fields.flag_reason)}`);
  console.log(`  its citation:        ${JSON.stringify(entries[49]?.provenance.flag_reason)}`);
  console.log(`entity 45 sourced_by:  ${JSON.stringify(entries[45]?.fields.sourced_by)}`);
  console.log(`  its citation:        ${JSON.stringify(entries[45]?.provenance.sourced_by)}`);
  console.log(
    `trace evidenceCoerced: ${JSON.stringify(
      entry?.kind === 'extraction' ? entry.evidenceCoerced : undefined,
    )}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
