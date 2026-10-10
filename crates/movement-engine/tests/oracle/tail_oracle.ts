// The TypeScript engine's runtime accidents (behaviours that come from V8,
// Node or zod rather than from the language's design), each written by the
// TypeScript's own code for tests/tail_oracle.rs to hold the Rust engine to.
// One file per accident, each from its own seed; written by generate.ts;
// deterministic.
//
//   - file_bound.json: a source file's text bounded for the prompt
//     (extraction.ts `boundFileText`) under a seeded `EXTRACTION_FILE_CHARS`,
//     fractional ones included: the content, the marker, and the `chars`
//     the trace reports.

import type { FileRef } from '../../../../apps/api/src/services/translation_graph/adapter';
import { boundFileText, maxFileChars } from '../../../../apps/api/src/services/movement_engine/extraction';

type Rand = () => number;
type Write = (name: string, text: string) => void;

/** Every accident's oracle, each from its own seed. */
export async function writeTailOracles(seeded: (seed: number) => Rand, write: Write): Promise<void> {
  writeFileBoundOracle(seeded(20261012), write);
}

const lines = (cases: unknown[]): string => `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`;

// ── file_bound.json ───────────────────────────────────────────────────────────

/** A deployment's setting as written: whole, fractional, exponent and hex
 *  forms, and the ones `maxFileChars` replaces with its default. */
function fileCharsSetting(rand: Rand): string {
  const whole = Math.floor(rand() * 12);
  const forms = [
    () => String(whole),
    () => String(whole + [0.5, 0.25, 0.1, 0.999, 1e-9, 0.75][Math.floor(rand() * 6)]!),
    () => `${whole}.${Math.floor(rand() * 1000)}`,
    () => `${(whole + 0.5) / 10}e1`,
    () => ` ${whole}.5 `,
    () => '0x8',
    () => ['0', '-2.5', 'Infinity', 'abc', '', '1e400'][Math.floor(rand() * 6)]!,
  ];
  return forms[Math.floor(rand() * forms.length)]!();
}

const FILE_UNITS = ['a', 'b', ' ', '\n', 'é', 'ß', '中', '1', '.'];

function writeFileBoundOracle(rand: Rand, write: Write): void {
  const ref: FileRef = { __brand: 'FileRef', name: 'f.pdf' };
  const cases: unknown[] = [];
  const saved = process.env.EXTRACTION_FILE_CHARS;
  try {
    for (let i = 0; i < 600; i++) {
      const setting = fileCharsSetting(rand);
      process.env.EXTRACTION_FILE_CHARS = setting;
      const ceiling = maxFileChars();
      if (ceiling >= 50_000) continue;
      const length = Math.floor(rand() * 16);
      let text = '';
      for (let u = 0; u < length; u++) text += FILE_UNITS[Math.floor(rand() * FILE_UNITS.length)]!;
      const bounded = boundFileText({ text, ref });
      cases.push({ setting, ceiling, text, ...bounded });
    }
  } finally {
    if (saved === undefined) delete process.env.EXTRACTION_FILE_CHARS;
    else process.env.EXTRACTION_FILE_CHARS = saved;
  }
  write('file_bound.json', lines(cases));
  console.log(`file_bound.json: ${cases.length} cases`);
}
