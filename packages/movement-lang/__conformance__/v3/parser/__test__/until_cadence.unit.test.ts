// `until` takes a boolean condition and a NAMED cadence
// (`await until(<condition>, every: 5m)`). The positional comparand it once
// took is retired: a value to wait FOR is an equality inside the condition,
// where every other comparison already lives. This file pins the surface —
// the named form parses, and every positional second argument is a parse error
// carrying the respelling.

import { MovementParseError, parseProgram } from '../parse';
import { AwaitSource, MovementDeclaration, Statement } from '../ast';

function as<K extends Statement['kind']>(
  s: Statement | undefined,
  kind: K,
): Extract<Statement, { kind: K }> {
  if (!s || s.kind !== kind) throw new Error(`expected statement '${kind}', got '${s?.kind}'`);
  return s as Extract<Statement, { kind: K }>;
}

const M = (body: string) => `movement m(d: <s-[:m]->>) {\n${body}\n}`;

function untilSource(body: string): Extract<AwaitSource, { kind: 'until' }> {
  const statements: MovementDeclaration['body'] = as(
    parseProgram(M(body)).statements[0],
    'movement',
  ).body;
  const source = as(statements[0], 'await').await.source;
  if (source.kind !== 'until') throw new Error(`expected an 'until', got '${source.kind}'`);
  return source;
}

function parseError(body: string): string {
  try {
    parseProgram(M(body));
  } catch (e) {
    if (e instanceof MovementParseError) return e.message;
    throw e;
  }
  throw new Error('expected a parse error');
}

describe('await until — the cadence is named', () => {
  it('parses `every:` as the cadence', () => {
    expect(untilSource('  await until(d.state == "done", every: 5m)').every?.raw).toBe('5m');
  });

  it('parses a closure condition with a named cadence', () => {
    const source = untilSource(
      '  await until(() => { refresh d; return d.state == "done" }, every: 1h)',
    );
    expect(source.condition.kind).toBe('closure');
    expect(source.every?.raw).toBe('1h');
  });

  it('refuses the retired block-with-dot condition, naming the closure', () => {
    const message = parseError('  await until({ refresh d; ok = d.state == "done" }.ok, every: 1h)');
    expect(message).toContain('is a closure');
    expect(message).toContain('return');
  });

  it('leaves the cadence unset when only a condition is given', () => {
    expect(untilSource('  await until(d.state == "done")').every).toBeUndefined();
  });

  it('refuses the retired positional comparand, naming the equality respelling', () => {
    const message = parseError('  await until(d.state, "done", 5m)');
    expect(message).toContain('every: 5m');
    expect(message).toContain('equality in the condition');
  });

  it('refuses a positional cadence', () => {
    expect(parseError('  await until(d.state == "done", 5m)')).toContain(
      "'until' takes its cadence by name",
    );
  });

  it('refuses a misnamed cadence argument', () => {
    expect(parseError('  await until(d.state == "done", cadence: 5m)')).toContain(
      "'until' takes its cadence by name",
    );
  });
});
