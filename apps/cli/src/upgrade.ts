// `lf upgrade`: the project's movement files rewritten into the language
// version the project's engine runs, by the shared upgrade loop
// (movement-lang checker/upgrade.ts) and the Rust checker every lf run is held
// to. In lf the pin is the engine version in lf.yaml, which already runs the
// current language version, so there is no pin to move: a file in an older
// spelling is simply refused until it is rewritten. That is why this checks
// as `lf check` does (no move-up warnings) — what is left after the rewrite is
// exactly what `lf check` would then report.

import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { diagnosticSeverity, rustCheck, unifiedDiff, upgradeSource } from 'movement-lang';
import type { Session } from './runs';

export interface UpgradeReport {
  /** Lines to print, in order. */
  lines: string[];
  /** Files that changed (or, checking only, would). */
  changed: number;
  /** Diagnostics still standing after the rewrite, over every file. */
  left: number;
}

export function upgradeProject(session: Session, options: { checkOnly: boolean }): UpgradeReport {
  const lines: string[] = [];
  let changed = 0;
  let left = 0;
  for (const file of session.files) {
    const result = upgradeSource(file.source, rustCheck({ snapshot: session.catalog, languageVersion: session.project.languageVersion }));
    const shown = relative(session.project.root, file.path);
    if (result.changed) {
      changed++;
      if (options.checkOnly) lines.push(unifiedDiff({ before: file.source, after: result.source, path: shown }).trimEnd());
      else writeFileSync(file.path, result.source);
    }
    for (const d of result.remaining) {
      left++;
      lines.push(`${shown}:${d.span.start.line}:${d.span.start.col} ${diagnosticSeverity(d)} ${d.code} ${d.message}`);
    }
    if (!result.settled) {
      left++;
      lines.push(`${shown}: the rewrite did not settle — a fix keeps rewriting its own output (a bug; please report it)`);
    }
  }
  const verb = options.checkOnly ? 'would be rewritten' : 'rewritten';
  lines.push(`${session.files.length} file(s), ${changed} ${verb}, ${left} left to change by hand`);
  return { lines, changed, left };
}
