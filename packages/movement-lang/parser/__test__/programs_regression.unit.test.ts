// Every whole program the corpora (v1, v2 and the current tests — see
// ../harvest) hand the statement parser, pinned by the sha256 of its canonical
// AST (or by the error it throws), in __fixtures__/programs.json. This is the
// Rust parser's conformance oracle: it parses the same sources and hashes the
// same canonical JSON. A hash changes only with a ruling.
//
// The parse also hands back each slot's tree, cached beside the slot; the
// last two tests hold that cache to what the expression grammar reads from
// the slot's text, for whole programs and for nested calls.
//
// Set UPDATE_PROGRAMS_FIXTURE=1 to rewrite the pins from the current parser
// (after a re-harvest, or a ruling) — then read the diff.
import { treeOfSlot } from '../../expression/bridge';
import type { ExprSlot } from '../ast';
import { canonical, SLOTS } from '../expression/__test__/lowering_fixture';
import { ExpressionSyntaxError, parseExpression } from '../expression/parse_expression';
import type { MExpr } from '../expression/tree';
import { MovementParseError, parseNestedCall, parseProgram, type ParseOptions } from '../parse';

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

/** Every `{raw, span}` in a parsed value — each slot, a duration's text too. */
function slotsIn(value: unknown, found: ExprSlot[] = []): ExprSlot[] {
  if (Array.isArray(value)) {
    value.forEach(child => slotsIn(child, found));
  } else if (isRecord(value)) {
    // The slot object itself: its cached tree is keyed by identity.
    if (isSlot(value)) found.push(value);
    else Object.values(value).forEach(child => slotsIn(child, found));
  }
  return found;
}

/** Each slot in `value` whose cached tree is not what its text parses to. */
function staleSlots(value: unknown, where: string): string[] {
  return slotsIn(value).flatMap(slot => {
    const cached = outcome(() => treeOfSlot(slot));
    const fresh = outcome(() => parseExpression(slot.raw));
    return cached === fresh ? [] : [`${where} slot ${JSON.stringify(slot.raw.slice(0, 60))}: ${cached} | ${fresh}`];
  });
}

function outcome(read: () => MExpr): string {
  try {
    return canonical(read());
  } catch (e) {
    if (e instanceof ExpressionSyntaxError) return canonical({ message: e.message, offset: e.offset });
    throw e;
  }
}

/** The `at` of every call in a tree — what the checker hands `parseNestedCall`
 *  for each call it hoists. */
function callExtents(tree: unknown, found: MExpr['at'][] = []): MExpr['at'][] {
  if (Array.isArray(tree)) {
    tree.forEach(child => callExtents(child, found));
  } else if (isRecord(tree)) {
    if (tree.kind === 'call' && isRecord(tree.at) && typeof tree.at.start === 'number' && typeof tree.at.end === 'number') {
      found.push({ start: tree.at.start, end: tree.at.end });
    }
    Object.values(tree).forEach(child => callExtents(child, found));
  }
  return found;
}

function isSlot(value: Record<string, unknown>): value is Record<string, unknown> & ExprSlot {
  return Object.keys(value).length === 2 && typeof value.raw === 'string' && isRecord(value.span);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  it('caches on every slot of every program the tree its text parses to', () => {
    let slots = 0;
    const stale = load().flatMap(({ source, version }) => {
      let program: unknown;
      try {
        program = parseProgram(source, { languageVersion: version });
      } catch (e) {
        if (e instanceof MovementParseError) return [];
        throw e;
      }
      slots += slotsIn(program).length;
      return staleSlots(program, `v${version} ${JSON.stringify(source.slice(0, 60))}`);
    });
    expect(slots).toBeGreaterThan(10_000);
    expect(stale).toEqual([]);
  });

  it('caches on every slot of every nested call the tree its text parses to', () => {
    let parsed = 0;
    const stale = SLOTS.flatMap(record => {
      // Part-way along a file's third line, as the statement layer captures one.
      const slot: ExprSlot = { raw: record.raw, span: { start: { line: 3, col: 5 }, end: { line: 3, col: 5 + record.raw.length } } };
      let tree: MExpr | undefined;
      try {
        tree = parseExpression(record.raw);
      } catch (e) {
        if (!(e instanceof ExpressionSyntaxError)) throw e;
      }
      return callExtents(tree).flatMap(at =>
        record.versions.flatMap(version => {
          let value: unknown;
          try {
            value = parseNestedCall(slot, at, version);
          } catch (e) {
            if (e instanceof MovementParseError) return [];
            throw e;
          }
          parsed += 1;
          return staleSlots(value, `v${version} ${JSON.stringify(record.raw.slice(at.start, at.end).slice(0, 60))}`);
        }),
      );
    });
    expect(parsed).toBeGreaterThan(400);
    expect(stale).toEqual([]);
  });
});
