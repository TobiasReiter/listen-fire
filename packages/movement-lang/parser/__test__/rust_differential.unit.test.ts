// The Rust parser (crates/movement-parser, through wasm/loader.ts) against the
// TypeScript one, over the two corpora: every expression text in
// expression_slots.json must give the same canonical tree or the same error,
// every program in programs.json the same canonical AST hash or the same
// error, every slot tree the eager export embeds the tree the TypeScript
// expression grammar reads from that slot, and every nested call the same
// `RValue` or the same error. Lives until the TypeScript grammars are
// deleted; after that the Rust harness against the pins
// (crates/movement-parser/tests) is the oracle.
//
// Off until the Rust grammars land: MOVEMENT_PARSER_DIFFERENTIAL=1 turns it on.
import type { ExprSlot } from '../ast';
import { CURRENT_LANGUAGE_VERSION } from '../../language_version';
import { callParser } from '../../wasm/loader';
import { canonical, SLOTS } from '../expression/__test__/lowering_fixture';
import type { MExpr } from '../expression/tree';
import type { ParseOptions } from '../parse';

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

type ParseModule = typeof import('../parse');
type ExpressionModule = typeof import('../expression/parse_expression');

/** The parser entry points with the grammar `choice` behind them, whatever
 *  MOVEMENT_PARSER this run has: a fresh module registry reads the switch
 *  afresh, so each side's classes are its own. */
function parserUnder(choice: 'ts' | 'rust'): { parse: ParseModule; expression: ExpressionModule } {
  const previous = process.env.MOVEMENT_PARSER;
  process.env.MOVEMENT_PARSER = choice;
  try {
    let loaded: { parse: ParseModule; expression: ExpressionModule } | undefined;
    jest.isolateModules(() => {
      loaded = {
        parse: require('../parse') as ParseModule,
        expression: require('../expression/parse_expression') as ExpressionModule,
      };
    });
    if (loaded === undefined) throw new Error('isolateModules did not run');
    return loaded;
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_PARSER;
    else process.env.MOVEMENT_PARSER = previous;
  }
}

const TS = parserUnder('ts');
const RUST_ENTRY = parserUnder('rust');

/** Either side's outcome, already in the form the two are compared in. */
type Outcome = { ok: string } | { error: unknown };

function tsExpression(raw: string): Outcome {
  try {
    return { ok: canonical(TS.expression.parseExpression(raw)) };
  } catch (e) {
    if (e instanceof TS.expression.ExpressionSyntaxError) return { error: { message: e.message, pos: e.offset } };
    throw e;
  }
}

function tsProgram(source: string, version: number): Outcome {
  // programs.json pins versions the type does not list (99) exactly as a
  // caller would pass them; the regression test does the same. Rust gets the
  // number unchanged too, and must read it as the current version, as the
  // pin shows TypeScript does.
  const options: ParseOptions = { languageVersion: version as NonNullable<ParseOptions['languageVersion']> };
  try {
    return { ok: sha256(canonical(TS.parse.parseProgram(source, options))) };
  } catch (e) {
    if (!(e instanceof TS.parse.MovementParseError)) throw e;
    return { error: { message: e.message, loc: { line: e.loc.line, col: e.loc.col } } };
  }
}

/** One side's `parseNestedCall`, through its production entry point. */
function nestedCall(side: { parse: ParseModule }, slot: ExprSlot, at: MExpr['at'], version: number): Outcome {
  try {
    return { ok: canonical(side.parse.parseNestedCall(slot, at, version)) };
  } catch (e) {
    if (e instanceof side.parse.MovementParseError) {
      return { error: { message: e.message, loc: { line: e.loc.line, col: e.loc.col } } };
    }
    return { error: { threw: String(e) } };
  }
}

type RustError = Record<string, unknown>;

const RUST = {
  parse_expression: {
    tree: (out: unknown) => canonical(out),
    // ExpressionSyntaxError adds nothing to the message (expression/error.ts).
    error: (e: RustError) => ({ message: e.message, pos: e.pos }),
  },
  parse_program: {
    tree: (out: unknown) => sha256(canonical(out)),
    error: (e: RustError) => programError(e),
  },
} as const;

/** The Rust side, in the form its TypeScript counterpart above reports. */
function rust(fn: keyof typeof RUST, input: { source: string; version: number }): Outcome {
  const { ok, json } = callParser(fn, input.source, [input.version]);
  if (ok) return { ok: RUST[fn].tree(json) };
  const error = isRecord(json) ? json.error : undefined;
  return { error: isRecord(error) ? RUST[fn].error(error) : json };
}

/** Rust emits the base message; `MovementParseError` appends the location, so
 *  the comparison does too. */
function programError(e: RustError): unknown {
  const loc = e.loc;
  if (!isRecord(loc)) return { message: e.message, loc };
  return {
    message: `${String(e.message)} (line ${String(loc.line)}, col ${String(loc.col)})`,
    loc: { line: loc.line, col: loc.col },
  };
}

/** Each slot the eager export parsed: its text and what it embeds, as the
 *  TypeScript expression grammar's outcome would be reported. */
function embeddedSlots(value: unknown, found: { raw: string; embedded: Outcome }[] = []): typeof found {
  if (Array.isArray(value)) {
    value.forEach(child => embeddedSlots(child, found));
  } else if (isRecord(value)) {
    if (typeof value.raw === 'string' && ('tree' in value || 'error' in value)) {
      const error = value.error;
      found.push({
        raw: value.raw,
        embedded: 'tree' in value
          ? { ok: canonical(value.tree) }
          : { error: isRecord(error) ? RUST.parse_expression.error(error) : error },
      });
      return found;
    }
    Object.values(value).forEach(child => embeddedSlots(child, found));
  }
  return found;
}

/** The eager program as the plain export gives it: every slot's parse taken
 *  off again. */
function withoutSlotParses(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSlotParses);
  if (!isRecord(value)) return value;
  const slot = typeof value.raw === 'string' && ('tree' in value || 'error' in value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !slot || (key !== 'tree' && key !== 'error'))
      .map(([key, child]) => [key, withoutSlotParses(child)]),
  );
}

/** The `at` of every call in a tree — what the checker hands
 *  `parseNestedCall` for each call it hoists (checker/nested_calls.ts picks a
 *  subset of these by scope; the parse does not depend on which). */
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

/** A slot as the statement layer would capture `raw` part-way along a
 *  file's third line, so a span on the slot's first line and one on a later
 *  line each show whether the origin was applied. */
function slotAt(raw: string): ExprSlot {
  return { raw, span: { start: { line: 3, col: 5 }, end: { line: 3, col: 5 + raw.length } } };
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

/** The constructs a nested call's ARGUMENT can be that only the statement
 *  grammar reads (Review Focus 2). */
const STATEMENT_CONSTRUCTS = ['closure', 'node', 'declaration'];

describe('the differential comparison', () => {
  it('reads a Rust program error as the MovementParseError it becomes', () => {
    const ts = { error: { message: 'boom (line 2, col 3)', loc: { line: 2, col: 3 } } };
    const rs = { error: RUST.parse_program.error({ message: 'boom', loc: { line: 2, col: 3 } }) };
    expect(differs(ts, rs)).toBeUndefined();
  });

  it('runs each side on its own grammar, whatever MOVEMENT_PARSER says', () => {
    // Only the Rust grammar bounds nesting.
    const deep = `${'('.repeat(200)}1${')'.repeat(200)}`;
    expect(TS.expression.parseExpression(deep).kind).toBe('paren');
    expect(() => RUST_ENTRY.expression.parseExpression(deep)).toThrow('nesting too deep');
  });
});

if (!ENABLED) {
  console.warn('rust differential skipped; set MOVEMENT_PARSER_DIFFERENTIAL=1');
}

(ENABLED ? describe : describe.skip)('the Rust parser against the TypeScript one', () => {
  it('reads every expression text exactly as TypeScript does', () => {
    expect(SLOTS.length).toBeGreaterThan(1000);
    const drifted = SLOTS.flatMap(({ raw }) => {
      // The TypeScript expression grammar reads no version, so the Rust one
      // must give the same tree under any.
      const why = differs(
        tsExpression(raw),
        rust('parse_expression', { source: raw, version: CURRENT_LANGUAGE_VERSION }),
      );
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

  it('embeds in every eager slot the tree TypeScript reads from its text, and changes nothing else', () => {
    const programs = loadPrograms();
    let slots = 0;
    const drifted = programs.flatMap(({ source, version }) => {
      const { ok, json } = callParser('parse_program_eager', source, [version]);
      const where = `v${version} ${JSON.stringify(source.slice(0, 60))}`;
      const plain = rust('parse_program', { source, version });
      const refusal = isRecord(json) && isRecord(json.error) ? json.error : {};
      const eager: Outcome = ok
        ? { ok: sha256(canonical(withoutSlotParses(json))) }
        : { error: RUST.parse_program.error(refusal) };
      const changed = differs(plain, eager);
      if (changed !== undefined) return [`${where}: the eager program is not the plain one: ${changed}`];
      if (!ok) return [];
      return embeddedSlots(json).flatMap(({ raw, embedded }) => {
        slots += 1;
        const why = differs(tsExpression(raw), embedded);
        return why === undefined ? [] : [`${where} slot ${JSON.stringify(raw.slice(0, 60))}: ${why}`];
      });
    });
    report(`programs.json eager slots (${slots} slots)`, slots, drifted);
    expect(slots).toBeGreaterThan(1000);
    expect(drifted).toEqual([]);
  });

  it('reads every nested call exactly as TypeScript does', () => {
    const cases = SLOTS.flatMap(record => {
      const slot = slotAt(record.raw);
      let tree: MExpr | undefined;
      try {
        tree = TS.expression.parseExpression(record.raw);
      } catch (e) {
        if (!(e instanceof TS.expression.ExpressionSyntaxError)) throw e;
      }
      const inSlot = callExtents(tree).map(at => ({ slot, at }));
      // A construct only the statement grammar reads, as a call's argument,
      // on a line after the slot's first.
      const text = `x + f(\n${record.raw})`;
      const asArgument = record.entries.some(e => STATEMENT_CONSTRUCTS.includes(e))
        ? [{ slot: slotAt(text), at: { start: 4, end: text.length }, argument: true }]
        : [];
      return [...inSlot.map(c => ({ ...c, argument: false })), ...asArgument].flatMap(c =>
        record.versions.map(version => ({ ...c, version })),
      );
    });
    expect(cases.length).toBeGreaterThan(1000);
    let succeeded = 0;
    let arguments_ = 0;
    let argumentsParsed = 0;
    let embedded = 0;
    const drifted = cases.flatMap(({ slot, at, version, argument }) => {
      const where = `v${version} ${JSON.stringify(slot.raw.slice(at.start, at.end).slice(0, 60))}`;
      const ts = nestedCall(TS, slot, at, version);
      const why = differs(ts, nestedCall(RUST_ENTRY, slot, at, version));
      if (why !== undefined) return [`${where}: ${why}`];
      if ('ok' in ts) succeeded += 1;
      if (argument) arguments_ += 1;
      if (argument && 'ok' in ts) argumentsParsed += 1;
      const raw = callParser('parse_nested_call', slot.raw, [at.start, at.end, slot.span.start.line, slot.span.start.col, version]);
      if (!raw.ok) return [];
      return embeddedSlots(raw.json).flatMap(({ raw: text, embedded: parse }) => {
        embedded += 1;
        const slotWhy = differs(tsExpression(text), parse);
        return slotWhy === undefined ? [] : [`${where} slot ${JSON.stringify(text.slice(0, 60))}: ${slotWhy}`];
      });
    });
    report(
      `nested calls (${succeeded} parse; constructs as arguments: ${argumentsParsed} of ${arguments_} parse; ${embedded} embedded slots)`,
      cases.length,
      drifted,
    );
    expect(succeeded).toBeGreaterThan(500);
    expect(argumentsParsed).toBeGreaterThan(100);
    expect(drifted).toEqual([]);
  });
});
