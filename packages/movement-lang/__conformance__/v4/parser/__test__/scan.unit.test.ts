// The no-drift guarantee: the completion service and the checker recognise a NAME
// through `scanName`, and the parser (the Rust grammar, crates/movement-parser/src/
// scan.rs) through its own copy. The last block below holds the two to the same
// answers, so the editor's completion context cannot silently drift from what the
// parser actually accepts.

import { MovementParseError, parseProgram } from '../parse';
import { scanName, unwrapCredentialArg, type ScannedName } from '../scan';
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
  // The Rust scanner cannot be called on its own, so it is driven through
  // parseProgram: the spelling is a write-body field key at column 5 with its
  // value straight after the colon. What the parser does there says what its
  // scanner read:
  //   - the field parses: the name is the field's, and the value's column
  //     says where the name ended;
  //   - "Expected ':' after the field name 'x'": the scanner stopped early,
  //     at the reported column, having read x;
  //   - any other refusal at the key's own column: the scanner read no name.
  const KEY_COL = 5;

  function parserScan(spelling: string): ScannedName | null {
    let program;
    try {
      program = parseProgram(`movement intake(msg: <inbox-[:message]->>) {
  write crm-[:company]-> {
    ${spelling}:"x"
  }
}
`);
    } catch (e) {
      if (!(e instanceof MovementParseError)) throw e;
      const stopped = /^Expected ':' after the field name '(.*)', found /s.exec(e.message);
      if (stopped) return { name: stopped[1], end: e.loc.col - KEY_COL };
      expect(e.loc).toEqual({ line: 3, col: KEY_COL });
      return null;
    }
    const movement = program.statements[0];
    if (movement?.kind !== 'movement') throw new Error('expected a movement');
    const write = movement.body[0];
    if (write?.kind !== 'write') throw new Error('expected a write');
    const field = write.write.fields[0];
    // The value starts one past the colon that follows the name.
    return { name: field.name, end: field.value.span.start.col - KEY_COL - 1 };
  }

  const spellings = [
    'status',
    '`Snoozed Until`',
    '`Funding Round`',
    '`open name',
    '`crosses\nline`',
    '1abc',
    'café',
    '`Café Ünïcode`',
    '`🚀 Launch`',
  ];

  it.each(spellings)('reads %j as scanName does', spelling => {
    expect(parserScan(spelling)).toEqual(scanName(spelling, 0));
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
