// The parser entry points with the Rust grammar behind them: the AST a caller
// gets is the TypeScript parser's shape exactly (slots are bare `{raw,
// span}`), the slot trees the WASM hands back are cached rather than parsed
// again, and refusals are the same error classes. Loaded in a registry of
// their own so the switch reads `rust` whatever this run's MOVEMENT_PARSER.
import type { ExprSlot, Statement } from '../ast';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };

type Modules = {
  parse: typeof import('../parse');
  expression: typeof import('../expression/parse_expression');
  bridge: typeof import('../../expression/bridge');
  loader: typeof import('../../wasm/loader');
};

function load(choice: string | undefined): Modules {
  const previous = process.env.MOVEMENT_PARSER;
  if (choice === undefined) delete process.env.MOVEMENT_PARSER;
  else process.env.MOVEMENT_PARSER = choice;
  try {
    let modules: Modules | undefined;
    jest.isolateModules(() => {
      modules = {
        parse: require('../parse') as Modules['parse'],
        expression: require('../expression/parse_expression') as Modules['expression'],
        bridge: require('../../expression/bridge') as Modules['bridge'],
        loader: require('../../wasm/loader') as Modules['loader'],
      };
    });
    if (modules === undefined) throw new Error('isolateModules did not run');
    return modules;
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_PARSER;
    else process.env.MOVEMENT_PARSER = previous;
  }
}

function assignSlot(statement: Statement | undefined): ExprSlot {
  if (statement?.kind !== 'assign' || statement.value.kind !== 'expr') throw new Error('expected `name = expr`');
  return statement.value.expr;
}

describe('the parser entry points on the Rust grammar', () => {
  const { parse, expression, bridge, loader } = load(undefined);

  it('is the default', () => {
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
});

describe('the parser switch', () => {
  it('runs the TypeScript grammar on MOVEMENT_PARSER=ts', () => {
    const { parse, loader } = load('ts');
    const calls = jest.spyOn(loader, 'callParser');
    parse.parseProgram('x = 1');
    expect(calls).not.toHaveBeenCalled();
    calls.mockRestore();
  });

  it('refuses a value it does not know rather than guessing', () => {
    expect(() => load('rsut')).toThrow("MOVEMENT_PARSER must be 'rust' or 'ts', not 'rsut'");
  });
});
