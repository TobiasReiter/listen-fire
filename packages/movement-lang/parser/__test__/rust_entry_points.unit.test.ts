// The parser entry points with the Rust grammar behind them: the AST a caller
// gets is bare `{raw, span}` slots, the slot trees the WASM hands back are
// cached rather than parsed again, and refusals are the package's error
// classes.
import type { ExprSlot, Statement } from '../ast';
import * as parse from '../parse';
import * as expression from '../expression/parse_expression';
import * as bridge from '../../expression/bridge';
import * as loader from '../../wasm/loader';

function assignSlot(statement: Statement | undefined): ExprSlot {
  if (statement?.kind !== 'assign' || statement.value.kind !== 'expr') throw new Error('expected `name = expr`');
  return statement.value.expr;
}

describe('the parser entry points on the Rust grammar', () => {
  it('runs the WASM export', () => {
    const calls = jest.spyOn(loader, 'callParser');
    parse.parseProgram('x = 1');
    expect(calls).toHaveBeenCalledWith('parse_program_eager', 'x = 1', [expect.any(Number)]);
    calls.mockRestore();
  });

  it('hands back slots that are exactly {raw, span}, their trees already read', () => {
    const program = parse.parseProgram('x = a + 1\ny = b +');
    const [good, bad] = program.statements.map(assignSlot);
    expect(Object.keys(good)).toEqual(['raw', 'span']);
    expect(Object.keys(bad)).toEqual(['raw', 'span']);

    const calls = jest.spyOn(loader, 'callParser');
    const tree = bridge.treeOfSlot(good);
    expect(tree).toEqual(expression.parseExpression('a + 1'));
    calls.mockClear();
    expect(bridge.treeOfSlot(good)).toBe(tree);
    expect(() => bridge.treeOfSlot(bad)).toThrow(expression.ExpressionSyntaxError);
    expect(() => bridge.treeOfSlot(bad)).toThrow(expect.objectContaining({ offset: 3 }));
    expect(calls).not.toHaveBeenCalled();

    // A slot nobody parsed is read on demand.
    const handBuilt: ExprSlot = { raw: 'b', span: good.span };
    expect(bridge.treeOfSlot(handBuilt).kind).toBe('name');
    expect(calls).toHaveBeenCalledWith('parse_expression', 'b', [expect.any(Number)]);
    calls.mockRestore();
  });

  it('refuses a slot that carries a parse but not its own raw text and span', () => {
    const half = { tree: { kind: 'literal', value: 1, at: { start: 0, end: 1 } } };
    const calls = jest
      .spyOn(loader, 'callParser')
      .mockReturnValue({ ok: true, json: { statements: [{ kind: 'assign', name: 'x', value: { kind: 'expr', expr: half } }] } });
    expect(() => parse.parseProgram('x = 1')).toThrow(/^the movement parser returned a malformed slot: /);
    calls.mockRestore();
  });

  it('refuses a program with a MovementParseError carrying its location', () => {
    const thrown = (() => {
      try {
        parse.parseProgram('x = 1\n  if');
      } catch (e) {
        return e;
      }
      throw new Error('expected a refusal');
    })();
    expect(thrown).toBeInstanceOf(parse.MovementParseError);
    if (!(thrown instanceof parse.MovementParseError)) return;
    expect(thrown.message).toMatch(/ \(line 2, col \d+\)$/);
    expect(thrown.loc.line).toBe(2);
  });

  it('refuses an expression with an ExpressionSyntaxError at its offset', () => {
    expect(() => expression.parseExpression('a + & b')).toThrow(expression.ExpressionSyntaxError);
    expect(() => expression.parseExpression('a + & b')).toThrow(expect.objectContaining({ offset: 4 }));
  });

  it('reads a nested call with the file\'s spans, and refuses one with a MovementParseError', () => {
    const slot: ExprSlot = { raw: '1 + f(x)', span: { start: { line: 4, col: 9 }, end: { line: 4, col: 17 } } };
    const value = parse.parseNestedCall(slot, { start: 4, end: 8 }, 3);
    expect(value).toMatchObject({ kind: 'call', call: { callee: 'f', span: { start: { line: 4, col: 13 }, end: { line: 4, col: 17 } } } });
    expect(() => parse.parseNestedCall({ ...slot, raw: '1 + f(x' }, { start: 4, end: 7 }, 3)).toThrow(parse.MovementParseError);
  });

  it('refuses nesting deeper than the grammar bounds', () => {
    const deep = `${'('.repeat(200)}1${')'.repeat(200)}`;
    expect(() => expression.parseExpression(deep)).toThrow('nesting too deep');
  });
});
