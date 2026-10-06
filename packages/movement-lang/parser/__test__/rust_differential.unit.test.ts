// The Rust parser (crates/movement-parser, through wasm/loader.ts) against the
// TypeScript one, over the two corpora: every expression text in
// expression_slots.json must give the same canonical tree or the same error,
// and every program in programs.json the same canonical AST hash or the same
// error. Lives until the TypeScript grammars are deleted; after that the Rust
// harness against the pins (crates/movement-parser/tests) is the oracle.
//
// Off until the Rust grammars land: MOVEMENT_PARSER_DIFFERENTIAL=1 turns it on.
import { CURRENT_LANGUAGE_VERSION } from '../../language_version';
import { callJson } from '../../wasm/loader';
import { canonical, SLOTS } from '../expression/__test__/lowering_fixture';
import { ExpressionSyntaxError, parseExpression } from '../expression/parse_expression';
import { MovementParseError, parseProgram, type ParseOptions } from '../parse';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;
declare const console: {
  warn(...args: unknown[]): void;
  log(...args: unknown[]): void;
};

const ENABLED = process.env.MOVEMENT_PARSER_DIFFERENTIAL === '1';
const SHOWN = 20;

const { createHash } = require('crypto') as {
  createHash(algorithm: 'sha256'): {
    update(data: string): { digest(encoding: 'hex'): string };
  };
};
const fs = require('fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
};

/** Either side's outcome, already in the form the two are compared in. */
type Outcome = { ok: string } | { error: unknown };

function tsExpression(raw: string): Outcome {
  try {
    return { ok: canonical(parseExpression(raw)) };
  } catch (e) {
    if (e instanceof ExpressionSyntaxError) return { error: { message: e.message, pos: e.offset } };
    throw e;
  }
}

function tsProgram(source: string, version: number): Outcome {
  // programs.json pins versions the type does not list (99) exactly as a
  // caller would pass them; the regression test does the same.
  const options: ParseOptions = { languageVersion: version as NonNullable<ParseOptions['languageVersion']> };
  try {
    return { ok: sha256(canonical(parseProgram(source, options))) };
  } catch (e) {
    if (!(e instanceof MovementParseError)) throw e;
    return { error: { message: e.message, loc: { line: e.loc.line, col: e.loc.col } } };
  }
}

const RUST = {
  parse_expression: { errorFields: ['message', 'pos'], tree: (out: unknown) => canonical(out) },
  parse_program: { errorFields: ['message', 'loc'], tree: (out: unknown) => sha256(canonical(out)) },
} as const;

/** The Rust side, in the form its TypeScript counterpart above reports. */
function rust(fn: keyof typeof RUST, input: { source: string; version: number }): Outcome {
  const out = callJson(fn, input.source, [input.version]);
  if (!isRecord(out) || !('error' in out)) return { ok: RUST[fn].tree(out) };
  const error = out.error;
  if (!isRecord(error)) return { error };
  return { error: Object.fromEntries(RUST[fn].errorFields.map(field => [field, error[field]])) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function differs(ts: Outcome, rs: Outcome): string | undefined {
  const a = canonical(ts);
  const b = canonical(rs);
  return a === b ? undefined : `ts ${a.slice(0, 160)} | rust ${b.slice(0, 160)}`;
}

function report(corpus: string, total: number, drifted: string[]): void {
  console.log(
    [`rust differential, ${corpus}: ${total - drifted.length} agree, ${drifted.length} differ of ${total}`]
      .concat(drifted.slice(0, SHOWN).map(line => `  ${line}`))
      .concat(drifted.length > SHOWN ? [`  … and ${drifted.length - SHOWN} more`] : [])
      .join('\n'),
  );
}

type ProgramRecord = { source: string; version: number };

function isProgramRecord(value: unknown): value is ProgramRecord {
  return isRecord(value) && typeof value.source === 'string' && typeof value.version === 'number';
}

function loadPrograms(): ProgramRecord[] {
  return fs
    .readFileSync(`${__dirname}/__fixtures__/programs.json`, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line, i) => {
      const record: unknown = JSON.parse(line);
      if (!isProgramRecord(record)) throw new Error(`programs.json line ${i + 1} is not {source, version, …}`);
      return record;
    });
}

if (!ENABLED) {
  console.warn('rust differential skipped; set MOVEMENT_PARSER_DIFFERENTIAL=1');
}

(ENABLED ? describe : describe.skip)('the Rust parser against the TypeScript one', () => {
  it('reads every expression text exactly as TypeScript does', () => {
    expect(SLOTS.length).toBeGreaterThan(1000);
    const drifted = SLOTS.flatMap(({ raw }) => {
      // The TypeScript expression grammar reads no version, so the Rust one
      // must give the same tree under any.
      const why = differs(tsExpression(raw), rust('parse_expression', { source: raw, version: CURRENT_LANGUAGE_VERSION }));
      return why === undefined ? [] : [`${JSON.stringify(raw.slice(0, 80))}: ${why}`];
    });
    report('expression_slots.json', SLOTS.length, drifted);
    expect(drifted).toEqual([]);
  });

  it('parses every program exactly as TypeScript does', () => {
    const programs = loadPrograms();
    expect(programs.length).toBeGreaterThan(1000);
    const drifted = programs.flatMap(({ source, version }) => {
      const why = differs(tsProgram(source, version), rust('parse_program', { source, version }));
      return why === undefined ? [] : [`v${version} ${JSON.stringify(source.slice(0, 80))}: ${why}`];
    });
    report('programs.json', programs.length, drifted);
    expect(drifted).toEqual([]);
  });
});
