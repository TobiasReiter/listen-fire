// The no-drift guarantee: the completion service and the parser recognise a NAME
// through the SAME shared scanner (`scanName`), so the language's name grammar has
// exactly one definition and the editor's completion context cannot silently drift
// from what the parser actually accepts.

import { scanName, unwrapCredentialArg } from '../scan';
import { parseProgram } from '../parse';
import { parseExpression } from '../expression/parse_expression';
import { extractHopAliases } from '../../checker/check';
import { quoteName } from '@listen-fire/shared/expression/formula';

describe('scanName — the one name grammar', () => {
  it('accepts a bare identifier, reporting the index just past it', () => {
    expect(scanName('companies rest', 0)).toEqual({ name: 'companies', end: 9 });
  });

  it('accepts a backtick-quoted name with spaces, stripping the backticks', () => {
    const src = '`Funding Round`: x';
    const scanned = scanName(src, 0);
    expect(scanned).toEqual({ name: 'Funding Round', end: 15 });
    // `end` lands just past the closing backtick (on the ':').
    expect(src[scanned!.end]).toBe(':');
  });

  it('rejects a non-name start', () => {
    expect(scanName('  spaced', 0)).toBeNull();
    expect(scanName('123', 0)).toBeNull();
    expect(scanName(':', 0)).toBeNull();
  });

  it('rejects an unterminated backtick name (parser raises the specific error)', () => {
    expect(scanName('`open name', 0)).toBeNull();
    expect(scanName('`crosses\nline`', 0)).toBeNull();
  });
});

// ── unwrapCredentialArg ──────────────────────────────────────────────────────

describe('unwrapCredentialArg', () => {
  it('returns a bare identifier as-is', () => {
    expect(unwrapCredentialArg('dev_slack')).toBe('dev_slack');
    expect(unwrapCredentialArg('acme_main')).toBe('acme_main');
  });

  it('unwraps a backtick-quoted name, stripping the backticks', () => {
    expect(unwrapCredentialArg('`Dev-loop Attio`')).toBe('Dev-loop Attio');
    expect(unwrapCredentialArg('`Telegram (shared bot)`')).toBe('Telegram (shared bot)');
  });

  it('trims leading/trailing whitespace before unwrapping', () => {
    expect(unwrapCredentialArg('  acme_main  ')).toBe('acme_main');
    expect(unwrapCredentialArg('  `Dev-loop Attio`  ')).toBe('Dev-loop Attio');
  });

  it('returns null for a real expression (not a name token)', () => {
    expect(unwrapCredentialArg('foo()')).toBeNull();
    expect(unwrapCredentialArg('a + b')).toBeNull();
  });

  it('returns null for a partial or trailing-garbage backtick', () => {
    // Unterminated
    expect(unwrapCredentialArg('`open name')).toBeNull();
    // Trailing chars after the closing backtick
    expect(unwrapCredentialArg('`Dev-loop Attio` extra')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(unwrapCredentialArg('')).toBeNull();
    expect(unwrapCredentialArg('   ')).toBeNull();
  });
});

describe('scanName agrees with the parser for the same names', () => {
  // For each representative name, the parser reads it as the write-body field key
  // AND scanName accepts it identically — they are sourced from one definition.
  const names = ['status', '`Snoozed Until`', '`Funding Round`'];

  it.each(names)('parser readName and scanName agree on %s', spelling => {
    const program = parseProgram(`
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:company]-> {
    ${spelling}: "x"
  }
}
`);
    // What scanName reads from the bare spelling…
    const scanned = scanName(spelling, 0);
    expect(scanned).not.toBeNull();
    const verbatim = spelling.startsWith('`') ? spelling.slice(1, -1) : spelling;
    expect(scanned!.name).toBe(verbatim);
    expect(scanned!.end).toBe(spelling.length);

    // …is the verbatim field name the PARSER recorded in the AST.
    const stmt = program.statements[0];
    expect(stmt.kind).toBe('movement');
    const body = (stmt as Extract<typeof stmt, { kind: 'movement' }>).body;
    const write = body.find(s => s.kind === 'call' || s.kind === 'write') ?? body[0];
    const fieldNames = JSON.stringify(write).includes(`"${verbatim}"`);
    expect(fieldNames).toBe(true);
  });
});

// A backslash in a backtick-quoted name escapes the next character — the only
// way to put a backtick in a name — and every reader of a name reads it so.
describe('a backtick name reads one way through every reader', () => {
  it.each([
    ['an escaped backtick', '`a\\`b`', 'a`b'],
    ['an escaped backslash', '`a\\\\b`', 'a\\b'],
    ['a letter escape', '`a\\nb`', 'anb'],
  ])('%s', (_label, spelling, name) => {
    // The shared scan (the editor's completion context reads names with it).
    expect(scanName(spelling, 0)).toEqual({ name, end: spelling.length });
    // A statement head.
    const head = parseProgram(`${spelling} = 1`).statements[0];
    expect(head).toMatchObject({ kind: 'assign', name });
    // An expression.
    expect(parseExpression(spelling)).toMatchObject({ kind: 'name', name: { text: name, quoted: true } });
    // A block head's hop alias.
    expect(extractHopAliases(`-[${spelling}:companies]->`)).toEqual([name]);
    const block = parseProgram(`xs-[${spelling}:companies]-> {\n  y = 1\n}`).statements[0];
    expect(block.kind === 'block' && extractHopAliases(block.block.head.hopsRaw)).toEqual([name]);
    // A credential argument.
    expect(unwrapCredentialArg(spelling)).toBe(name);
  });

  it('quotes a name so that it reads back unchanged', () => {
    for (const name of ['a`b', 'a\\b', 'a b']) {
      expect(scanName(quoteName(name), 0)?.name).toBe(name);
    }
  });
});
