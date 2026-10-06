// Records, for every whole program the statement parser is handed while a test
// corpus runs, the source, the language version it ran under, and either the
// sha256 of the canonical AST or the error it threw — the Rust parser's
// conformance oracle (../__test__/programs_regression.unit.test.ts).
//
// Appends JSON lines to $HARVEST_OUT. Run through ./jest.harvest.cjs.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OUT = process.env.HARVEST_OUT;
const PACKAGE = path.resolve(__dirname, '../..');
const PARSE = path.join(PACKAGE, 'parser/parse.ts');
const LANGUAGE_VERSION = path.join(PACKAGE, 'language_version.ts');

const testFile = path.relative(PACKAGE, expect.getState().testPath || '');
const records = [];

// Must stay identical to `canonical` in expression/__test__/lowering_fixture.ts:
// the Rust side hashes the same bytes.
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

jest.mock(PARSE, () => {
  const actual = jest.requireActual(PARSE);
  const parseProgram = (source, options) => {
    const version =
      (options && options.languageVersion) ?? require(LANGUAGE_VERSION).CURRENT_LANGUAGE_VERSION;
    let program;
    try {
      program = actual.parseProgram(source, options);
    } catch (e) {
      if (e instanceof actual.MovementParseError) {
        records.push({ source, version, error: { message: e.message, loc: { line: e.loc.line, col: e.loc.col } } });
      }
      throw e;
    }
    try {
      records.push({ source, version, ast_sha256: sha256(canonical(program)) });
    } catch {
      // A harvest failure must never change what the corpus test sees.
    }
    return program;
  };
  return { ...actual, parseProgram };
});

afterAll(() => {
  // The regression's own replay is the harvest's output, not corpus.
  if (testFile.startsWith(path.join('parser', '__test__', 'programs_regression'))) return;
  if (!OUT || records.length === 0) return;
  fs.appendFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
});
