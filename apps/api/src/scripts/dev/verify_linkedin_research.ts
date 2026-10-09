/**
 * Live verification of the `linkedin-research` plugin — the "see how it
 * performs" run the contract calls for.
 *
 * The dev loop has fakes for channels and CRMs but none for the search index
 * or the profile service, so this drives the registered implementation
 * directly against the carve stack's real keys and prints what came back
 * alongside the wall clock. The run log (`.dev-loop/loop.log`, or stderr here)
 * carries the `[transform:linkedin-research]` trail: each query, the result
 * counts, whether the profile service ran, and the confidence.
 *
 *   npx ts-node --project tsconfig.dev.json --transpile-only \
 *     -r dotenv/config -r tsconfig-paths/register \
 *     src/scripts/dev/verify_linkedin_research.ts <profile address>
 *
 * The address is an argument and never a literal in this file: it names a real
 * person, and their address does not belong in the repository.
 *
 */
import './_profile_loader';

// Composition root — this is what registers `services.linkedin` when
// BRIGHT_DATA_ACCESS_TOKEN is set. Without it the plugin falls back to the
// search index alone, which is a legitimate run but not the one this checks.
import '../../services';
import '../../services/translation_graph/engine/transforms/register-bundled';
import { services } from '../../adapters/registry';
import { runInContext } from '../../services/context/utils';
import { getTransform } from '../../services/translation_graph/engine/transforms';
import { makeStablePosition } from '../../services/translation_graph/types';
import { ensureDevLoopTeam } from './_lib';

import type { ContextDependentInput } from '../../services/translation_graph/engine/transforms';

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: verify_linkedin_research.ts <linkedin profile address>');
    process.exit(1);
  }

  const impl = getTransform('linkedin-research');
  if (!impl) throw new Error('linkedin-research is not registered');

  const input: ContextDependentInput = {
    kind: 'context-dependent',
    sourceNode: makeStablePosition({
      adapterType: 'fixture',
      recordType: 'fixture.person',
      recordId: 'verify-linkedin-research',
      data: {},
    }),
    config: { url },
    extractedContext: {},
  };

  // The supporting-page fetch goes through the shared plumbing, which stores
  // what it fetched and therefore needs a tenant. Without a reachable stack
  // the run still happens — the fetches degrade and the answer rests on
  // snippets alone, which is worth seeing rather than refusing to run.
  let userId: string | null = null;
  try {
    ({ userId } = await ensureDevLoopTeam());
  } catch (error) {
    console.warn(`No dev-loop team (${String(error)}) — running without one; fetches will fail.`);
  }

  console.log(`profile service configured: ${services.linkedin ? 'yes' : 'no'}`);

  const started = Date.now();
  const output = userId
    ? await runInContext(() => impl.run(input), { id: userId })
    : await impl.run(input);
  const elapsedMs = Date.now() - started;

  const properties = output.properties ?? {};
  console.log(`\nwall time: ${(elapsedMs / 1000).toFixed(1)}s`);
  if (Object.keys(properties).length === 0) {
    console.log('attached nothing — see the [transform:linkedin-research] log trail above');
    return;
  }
  for (const [name, value] of Object.entries(properties)) {
    console.log(`\n── ${name} ──\n${String(value)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
