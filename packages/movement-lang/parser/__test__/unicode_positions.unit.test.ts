// Positions in non-ASCII source. Columns count UTF-16 code units — the
// language service places squiggles by them — so an astral-plane character
// (an emoji) is two columns and an accented letter or a CJK character one.
// These programs also feed the program harvest (../harvest), which is how the
// Rust parser is held to the same columns.
//
// None of them makes the parser QUOTE an astral character in an error: the
// TypeScript parser quotes one code unit there (half the character), which
// the Rust parser does not reproduce.

import { MovementParseError, parseProgram } from '../parse';
import type { Span, Statement } from '../ast';
import { checkProgram } from '../../checker/check';
import { mockCatalog } from '../../checker/catalog';

const span = (start: [number, number], end: [number, number]): Span => ({
  start: { line: start[0], col: start[1] },
  end: { line: end[0], col: end[1] },
});

function isKind<K extends Statement['kind']>(s: Statement | undefined, kind: K): s is Extract<Statement, { kind: K }> {
  return s?.kind === kind;
}

function only<K extends Statement['kind']>(s: Statement | undefined, kind: K): Extract<Statement, { kind: K }> {
  if (!isKind(s, kind)) throw new Error(`expected '${kind}', got '${s?.kind}'`);
  return s;
}

function slotOf(s: Statement | undefined): { raw: string; span: Span } {
  const assign = only(s, 'assign');
  if (assign.value.kind !== 'expr') throw new Error(`expected an expression, got '${assign.value.kind}'`);
  return assign.value.expr;
}

function errorOf(source: string): MovementParseError {
  try {
    parseProgram(source);
  } catch (e) {
    if (e instanceof MovementParseError) return e;
    throw e;
  }
  throw new Error('parsed');
}

describe('positions in non-ASCII source', () => {
  it('counts an emoji in a string as two columns', () => {
    const { statements } = parseProgram('x = "🌍 hello"\ny = 1');
    expect(slotOf(statements[0])).toEqual({ raw: '"🌍 hello"', span: span([1, 5], [1, 15]) });
    expect(only(statements[1], 'assign').span).toEqual(span([2, 1], [2, 6]));
  });

  it('skips comments with emoji, and counts CJK as one column each', () => {
    const { statements } = parseProgram('# 🎉 a comment with an emoji\nx = 1 # 🚀 trailing\ny = "東京 ☕"');
    // The statement ends where its terminator was found, past the trailing
    // comment; the slot stops at the value.
    expect(only(statements[0], 'assign').span).toEqual(span([2, 1], [2, 20]));
    expect(slotOf(statements[0])).toEqual({ raw: '1', span: span([2, 5], [2, 6]) });
    expect(slotOf(statements[1])).toEqual({ raw: '"東京 ☕"', span: span([3, 5], [3, 11]) });
  });

  it('reads accented names in backticks', () => {
    const { statements } = parseProgram('`Société Générale` = 1\n`naïve` = `Société Générale`');
    const first = only(statements[0], 'assign');
    expect(first.name).toBe('Société Générale');
    expect(first.span).toEqual(span([1, 1], [1, 23]));
    expect(slotOf(statements[0]).span).toEqual(span([1, 22], [1, 23]));
    expect(only(statements[1], 'assign').name).toBe('naïve');
    expect(slotOf(statements[1])).toEqual({ raw: '`Société Générale`', span: span([2, 11], [2, 29]) });
  });

  it('places write fields after an emoji edge name', () => {
    const source = [
      'movement m(c: <crm-[:companies]->>) {',
      '  write c-[:`Contacts 👥`]-> { `Prénom`: "Zoë 🌸", city: "Zürich" }',
      '}',
    ].join('\n');
    const movement = only(parseProgram(source).statements[0], 'movement');
    const { write } = only(movement.body[0], 'write');
    expect(write.target).toMatchObject({ kind: 'linked', path: { hopsRaw: '-[:`Contacts 👥`]->' } });
    expect(write.fields.map(({ name, value, span: s }) => ({ name, value, span: s }))).toEqual([
      { name: 'Prénom', value: { raw: '"Zoë 🌸"', span: span([2, 42], [2, 50]) }, span: span([2, 32], [2, 50]) },
      { name: 'city', value: { raw: '"Zürich"', span: span([2, 58], [2, 66]) }, span: span([2, 52], [2, 66]) },
    ]);
  });

  it('spans a traversal head whose WHERE holds an emoji', () => {
    const { statements } = parseProgram('m-[a:Attachments WHERE a.name == "📎 doc"]-> {\n  x = a.size\n}');
    const { block } = only(statements[0], 'block');
    expect(block.head).toEqual({
      root: { kind: 'name', name: 'm' },
      hopsRaw: '-[a:Attachments WHERE a.name == "📎 doc"]->',
      span: span([1, 1], [1, 45]),
    });
    expect(slotOf(block.body[0])).toEqual({ raw: 'a.size', span: span([2, 7], [2, 13]) });
  });

  it('spans node literal entries around an astral character', () => {
    const { statements } = parseProgram('d = node { `Résumé`: "🧾 new", count: 3 }');
    const value = only(statements[0], 'assign').value;
    if (value.kind !== 'node') throw new Error(value.kind);
    expect(value.node.entries).toEqual([
      { kind: 'value', name: 'Résumé', value: { raw: '"🧾 new"', span: span([1, 22], [1, 30]) }, span: span([1, 12], [1, 30]) },
      { kind: 'value', name: 'count', value: { raw: '3', span: span([1, 39], [1, 40]) }, span: span([1, 32], [1, 40]) },
    ]);
  });

  it('reads an emoji listen alias and an emoji ERROR message', () => {
    const source = [
      'go = manual()',
      'listen as "Équipe 🚀" to go {} fire f',
      'movement f(g: <go-[:invocation]->>) {',
      '  ERROR("échec 💥")',
      '}',
    ].join('\n');
    const { statements } = parseProgram(source);
    const listen = only(statements[1], 'listen');
    expect(listen.alias).toBe('Équipe 🚀');
    expect(listen.span).toEqual(span([2, 1], [2, 38]));
    const error = only(only(statements[2], 'movement').body[0], 'error');
    expect(error.message).toEqual({ raw: '"échec 💥"', span: span([4, 9], [4, 19]) });
  });

  it('reads emoji descriptions in an extraction', () => {
    const source = [
      'found = extract from [m.body] {',
      '  `société`: "the company 🏢"',
      '  node `personne`: "each person 👤" { nom: "their name" }',
      '}',
    ].join('\n');
    const value = only(parseProgram(source).statements[0], 'assign').value;
    if (value.kind !== 'extract') throw new Error(value.kind);
    const [stage] = value.extract.stages;
    expect(stage.fields[0]).toMatchObject({
      name: 'société',
      description: { raw: '"the company 🏢"', span: span([2, 14], [2, 30]) },
    });
    expect(stage.children[0]).toMatchObject({
      name: 'personne',
      description: { raw: '"each person 👤"', span: span([3, 20], [3, 36]) },
    });
  });

  it('keeps columns right across CRLF line ends', () => {
    const { statements } = parseProgram('x = "🌍"\r\ny = 2\r\n');
    expect(slotOf(statements[0])).toEqual({ raw: '"🌍"', span: span([1, 5], [1, 9]) });
    expect(only(statements[1], 'assign').span.start).toEqual({ line: 2, col: 1 });
  });

  it('locates an error after an emoji in UTF-16 columns', () => {
    const extra = errorOf('delete `🌍` extra');
    expect(extra.message).toBe("Unexpected 'extra' — expected the end of the statement (line 1, col 13)");
    expect(extra.loc).toEqual({ line: 1, col: 13 });

    const unterminated = errorOf('x = 1\ny = "🌍 never closed');
    expect(unterminated.loc).toEqual({ line: 2, col: 5 });

    const notText = errorOf('type Mood = <"😀" | 5>');
    expect(notText.message).toMatch(/^'Mood' is a refinement of text/);
    expect(notText.loc).toEqual({ line: 1, col: 21 });
  });

  // A U+FDD0 is the engine's in-band escape and a lone half is not valid UTF-8,
  // so both cross the parser in an altered form; each must still be one column,
  // the same as the one code unit the line holds in TypeScript.
  describe.each([
    ['a U+FDD0', '\uFDD0'],
    ['a lone low half', '\uDC00'],
    ['a lone high half', '\uD800'],
  ])('the checker spans a line holding %s as one holding a plain letter', (_name, odd) => {
    const spans = (marker: string) =>
      checkProgram(parseProgram(`y = "${marker}" + nope\nz = "${marker}" + also_nope`), mockCatalog({})).map((d) => ({
        code: d.code,
        span: d.span,
      }));

    it('reports the same code and span', () => {
      const withOdd = spans(odd);
      expect(withOdd.length).toBeGreaterThan(0);
      expect(withOdd).toEqual(spans('x'));
    });
  });
});
