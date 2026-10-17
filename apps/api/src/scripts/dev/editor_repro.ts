/**
 * What does the EDITOR see? — the workbench pipeline, run server-side.
 *
 *   pnpm dev:editor-repro [--file <path>]
 *
 * `movement-workbench.tsx` does: skeleton snapshot → `catalogForSource` for the
 * whole script → `getMovementDiagnostics`. This runs that exact pipeline, so the
 * squiggles an author would see are observable without driving a browser.
 *
 * It exists because a change that hollows out the instance schema shows up here
 * as diagnostics on a program that is actually fine — which is how the
 * positioned-instance bug was caught: the editor called a script's own Sheets
 * table an unknown edge while `save` compiled the same text without complaint.
 * Run it beside `pnpm dev:movement provision --file <same file>`; the two must
 * agree, and any disagreement between them IS the bug.
 */

import './_profile_loader';
// Initialises the integration config (Google et al). Without it a Google-backed
// instance fails to introspect and the checker goes SILENT for it — which reads
// as "no problems" and would let this harness report a false all-clear on the
// exact bug it exists to catch.
import '../../services';

import fs from 'node:fs';

import { getMovementDiagnostics, referencedConstructions } from 'movement-lang';

import { movementCatalogSnapshotForTeam } from '../../services/translation_graph/movement/catalog';
import { ensureDevLoopTeam } from './_lib';

import type { TeamId } from '../../generated/kysely/core/Team';

const DEFAULT_SOURCE = `
import { email, attio } from adapters
import { \`Dev Loop Attio\` } from credentials

inbox = connect email
crm   = connect attio using \`Dev Loop Attio\`

function editor_repro(m: <inbox-[:Email]->>) {
  co = write crm-[:Companies]-> {
    unique by (\`Name\`)
    Name:        m.\`Subject\`
    Description: "Introduced by \${m.\`From\`}"
  }
  fail("\${co.externalId}")
}

listen to inbox { key: "editor-repro" } fire editor_repro
`;

async function main() {
  const fileArg = process.argv.indexOf('--file');
  const source =
    fileArg >= 0 ? fs.readFileSync(process.argv[fileArg + 1] as string, 'utf8') : DEFAULT_SOURCE;

  const { teamId } = await ensureDevLoopTeam();

  // Tier 1 — the skeleton the editor opens against.
  const skeleton = await movementCatalogSnapshotForTeam(teamId as TeamId);
  const specs = (skeleton.snapshot as unknown as { adapters?: Record<string, { canFire?: boolean }> })
    .adapters ?? {};
  console.log('  adapter specs from the catalog snapshot (canFire):');
  for (const [name, spec] of Object.entries(specs)) console.log(`    ${name}: canFire=${spec.canFire}`);

  // Tier 2 — the snapshot TYPED FOR THIS SOURCE, exactly as the workbench asks
  // for it (`catalogForSource`). One call for the whole program, so positioned
  // instances and narrowings are typed like the compiler types them.
  const typed = await movementCatalogSnapshotForTeam(teamId as TeamId, { source });
  const snapshot = typed.snapshot;

  for (const ref of referencedConstructions(source)) {
    const spec = snapshot.adapters[ref.adapter];
    const positioned =
      ref.constructionArgs !== undefined && Object.keys(ref.constructionArgs).length > 0
        ? ` at ${JSON.stringify(ref.constructionArgs)}`
        : '';
    const schemas = Object.keys(spec?.schemas ?? {});
    console.log(`  ${ref.adapter}${positioned}: schema keys ${JSON.stringify(schemas)}`);
  }
  for (const gap of typed.gaps ?? []) {
    console.log(`  GAP ${gap.adapter}: ${gap.detail}`);
  }

  const diagnostics = getMovementDiagnostics(source, snapshot);
  console.log(`\n── diagnostics the editor would show: ${diagnostics.length} ──`);
  for (const d of diagnostics) console.log(`  [${d.severity ?? 'error'}] ${d.code}: ${d.message}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
