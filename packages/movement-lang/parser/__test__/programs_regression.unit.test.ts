// Every whole program the corpora (v1, v2 and the current tests — see
// ../harvest) hand the statement parser, pinned by the sha256 of its canonical
// AST (or by the error it throws), in __fixtures__/programs.json. This is the
// Rust parser's conformance oracle: it parses the same sources and hashes the
// same canonical JSON. A hash changes only with a ruling.
//
// Set UPDATE_PROGRAMS_FIXTURE=1 to rewrite the pins from the current parser
// (after a re-harvest, or a ruling) — then read the diff.
import { canonical } from '../expression/__test__/lowering_fixture';
import { MovementParseError, parseProgram, type ParseOptions } from '../parse';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;
declare const console: { warn(...args: unknown[]): void };

type ProgramRecord =
  | { source: string; version: number; ast_sha256: string }
  | { source: string; version: number; error: { message: string; loc: { line: number; col: number } } };

const FIXTURE = `${__dirname}/__fixtures__/programs.json`;
const KNOWN_VERSIONS = [1, 2, 3];

const { createHash } = require('crypto') as {
  createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
};
const fs = require('fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
};

function parseNow(source: string, version: number): ProgramRecord {
  // The corpus pins `languageVersion: 99` too: the number goes to the parser
  // exactly as a caller's would.
  const options: ParseOptions = { languageVersion: version as NonNullable<ParseOptions['languageVersion']> };
  try {
    const ast = parseProgram(source, options);
    return { source, version, ast_sha256: createHash('sha256').update(canonical(ast)).digest('hex') };
  } catch (e) {
    if (e instanceof MovementParseError) {
      return { source, version, error: { message: e.message, loc: { line: e.loc.line, col: e.loc.col } } };
    }
    throw e;
  }
}

function load(): ProgramRecord[] {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as ProgramRecord);
}

describe('programs regression', () => {
  if (process.env.UPDATE_PROGRAMS_FIXTURE) {
    const rows = load().map(r => parseNow(r.source, r.version));
    fs.writeFileSync(FIXTURE, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }

  it('parses every pinned program exactly as pinned', () => {
    const pins = load();
    expect(pins.length).toBeGreaterThan(1000);
    const drifted = pins
      .filter(pin => JSON.stringify(parseNow(pin.source, pin.version)) !== JSON.stringify(pin))
      .map(pin => `v${pin.version}: ${JSON.stringify(pin.source.slice(0, 120))}`);
    expect(drifted).toEqual([]);
  });

  it('reports any pinned version outside the known ones', () => {
    const odd = [...new Set(load().map(r => r.version).filter(v => !KNOWN_VERSIONS.includes(v)))];
    if (odd.length > 0) console.warn(`programs.json pins unexpected language versions: ${odd.join(', ')}`);
  });
});
