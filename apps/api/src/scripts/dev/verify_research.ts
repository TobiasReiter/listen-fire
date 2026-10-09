/**
 * Live verification of the `research` plugin — both engines, over whatever
 * entry you name.
 *
 * The dev loop has fakes for channels and CRMs but none for the search index
 * or Anthropic's own web tools, so this drives an engine directly against the
 * stack's real keys and prints what became of the entry, what it answered, and
 * what it cost. The run log carries the `[transform:research:*]` trail.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_research.ts \
 *     --engine constrained --name Larkfield \
 *     --context "Danish school canteen ordering app" \
 *     --questions "what it does, which sector, where it is based" \
 *     [--url https://… ]…  [--model claude-sonnet-5] [--both]
 *
 * `--both` runs the two engines over the same entry, which is the comparison
 * this plugin exists to settle.
 */
import './_profile_loader';

// Composition root — registers the services the fetch path reaches.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';
import { parseChatModelName } from '../../lib/models/registry';
import { runInContext } from '../../services/context/utils';
import { research } from '../../services/translation_graph/engine/transforms/research';
import { ensureDevLoopTeam } from './_lib';

import type {
  ResearchEngineName,
  ResearchResult,
} from '../../services/translation_graph/engine/transforms/research';

// ── The entry, from the command line ──────────────────────────────────────

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function flags(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((arg, i) => {
    if (arg === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function report(engine: ResearchEngineName, result: ResearchResult): void {
  console.log(`\n── ${engine} ──\n`);
  console.log(`outcome:    ${result.outcome}`);
  console.log(`confidence: ${result.confidence ?? '(none)'}`);
  console.log(`website:    ${result.website ?? '(none)'}`);
  console.log(`linkedin:   ${result.linkedin ?? '(none)'}`);
  console.log(
    `usage:      ${result.usage.modelCalls} model calls, ` +
      `${result.usage.inputTokens} in / ${result.usage.outputTokens} out ` +
      `(+${result.usage.cacheCreationTokens} cache write, ${result.usage.cacheReadTokens} cache read), ` +
      `${result.usage.searches} searches, ${result.usage.fetches} fetches, ` +
      `${(result.usage.wallClockMs / 1000).toFixed(1)}s`,
  );
  if (result.summary) console.log(`\nsummary:\n${result.summary}`);
  if (result.sources?.length) {
    console.log(`\nsources:\n${result.sources.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
  }
  if (result.dossier) console.log(`\ndossier:\n${result.dossier}`);
}

async function main() {
  const name = flag('name');
  if (!name) throw new Error('--name is required');

  const input = {
    name,
    context: flag('context') ?? '',
    questions: flag('questions') ?? '',
    urls: flags('url'),
  };
  const modelFlag = flag('model');
  const model = modelFlag === undefined ? undefined : parseChatModelName(modelFlag, '--model');
  const engines: ResearchEngineName[] = has('both')
    ? ['constrained', 'agentic']
    : [(flag('engine') as ResearchEngineName) ?? 'constrained'];

  // The page fetch goes through the shared plumbing, which stores what it
  // fetched and therefore needs a tenant. Without a reachable stack the run
  // still happens — the fetches fail, which is itself worth seeing.
  let userId: string | null = null;
  try {
    ({ userId } = await ensureDevLoopTeam());
  } catch (error) {
    console.warn(`No dev-loop team (${String(error)}) — running without one; fetches will fail.`);
  }

  console.log(`entry: ${name}`);
  console.log(`context: ${input.context || '(none)'}`);
  console.log(`questions: ${input.questions || '(none)'}`);
  console.log(`urls: ${input.urls.length ? input.urls.join(', ') : '(none)'}`);

  for (const engine of engines) {
    const call = () => research(input, { engine, ...(model ? { model } : {}) });
    const result = userId ? await runInContext(call, { id: userId }) : await call();
    report(engine, result);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
