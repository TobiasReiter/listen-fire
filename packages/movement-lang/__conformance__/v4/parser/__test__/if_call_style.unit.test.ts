// `IF(cond, a, b)` — IF called like a spreadsheet function. The language writes
// it `IF … THEN … ELSE … END`, and the refusal says so, with the rewrite,
// wherever it is written. It used to surface as whatever the statement scanner
// tripped over next ("Unbalanced '}' in for the field …").

import { parseProgram } from '../parse';
import { parseExpression } from '../expression/parse_expression';
import { callStyleIfMessage } from '../scan';

const REWRITE = /IF is written 'IF … THEN … ELSE … END', not called like a function — write 'IF m\.Body == "a" THEN "b" ELSE "c" END'/;

function parse(body: string): () => unknown {
  return () =>
    parseProgram(`import { email } from adapters
inbox = email()
movement m1(m: <inbox-[:message]->>) {
${body}
}`);
}

describe('IF called like a function', () => {
  it('is refused with the rewrite, as a binding value', () => {
    expect(parse('  x = IF(m.Body == "a", "b", "c")')).toThrow(REWRITE);
  });

  it('is refused with the rewrite, as a written field', () => {
    expect(parse('  write inbox-[:message]-> { Subject: IF(m.Body == "a", "b", "c") }')).toThrow(REWRITE);
  });

  it('is refused with the rewrite, nested inside another call', () => {
    expect(() => parseExpression('UPPER(IF(m.Body == "a", "b", "c"))')).toThrow(REWRITE);
  });

  it('names the form when the argument count is not three', () => {
    expect(callStyleIfMessage('IF(a, b)', 2)).toMatch(/write 'IF <condition> THEN <value> ELSE <otherwise> END'/);
  });

  it('leaves a parenthesised condition alone', () => {
    expect(callStyleIfMessage('IF (a OR b) THEN 1 ELSE 2 END', 3)).toBeUndefined();
    expect(parse('  x = IF (m.Body == "a" OR m.Body == "b") THEN "b" ELSE "c" END')).not.toThrow();
    expect(() => parseExpression('IF (a, b) THEN 1 ELSE 2 END')).toThrow(/not called like a function/);
  });
});
