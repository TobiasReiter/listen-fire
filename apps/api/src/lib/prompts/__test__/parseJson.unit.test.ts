jest.mock('../../anthropic', () => ({}));
jest.mock('movement-engine/services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { parseJson } from '../../utils/parse_json';
import { parseJsonReply } from '../execute';

describe('parseJson', () => {
  // ── Clean JSON ──

  it('parses valid JSON object', () => {
    expect(parseJson('{"a":1,"b":"hello"}')).toEqual({ a: 1, b: 'hello' });
  });

  it('parses valid JSON array', () => {
    expect(parseJson('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON with whitespace', () => {
    expect(parseJson('  \n  {"key": "value"}  \n  ')).toEqual({ key: 'value' });
  });

  it('handles empty object', () => {
    expect(parseJson('{}')).toEqual({});
  });

  it('handles empty array', () => {
    expect(parseJson('[]')).toEqual([]);
  });

  it('handles deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    expect(parseJson(JSON.stringify(deep))).toEqual(deep);
  });

  // ── Markdown code blocks ──

  it('strips ```json code block', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips ``` code block without language tag', () => {
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips code block with leading/trailing whitespace', () => {
    expect(parseJson('  ```json\n  {"a":1}  \n```  ')).toEqual({ a: 1 });
  });

  it('handles prose + code block + prose', () => {
    const input = 'Here are the results:\n\n```json\n{"data": [1, 2, 3]}\n```\n\nLet me know if you need changes.';
    expect(parseJson(input)).toEqual({ data: [1, 2, 3] });
  });

  // ── Surrounding prose ──

  it('extracts JSON when LLM adds a preamble', () => {
    expect(parseJson('Here is the result:\n{"name":"Alice","age":30}')).toEqual({
      name: 'Alice',
      age: 30,
    });
  });

  it('extracts JSON when preamble contains colons', () => {
    expect(parseJson('Summary: found 3 entities. Details:\n{"entities":["a","b","c"]}')).toEqual({
      entities: ['a', 'b', 'c'],
    });
  });

  it('extracts array from preamble', () => {
    expect(parseJson('The items are: [{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('handles long preamble with colons (the K_EXTRACT failure pattern)', () => {
    const preamble = 'I analyzed the email and found the following entities: ' +
      'Company: Acme Corp (Series A). Investor: Sequoia Capital (Lead). ' +
      'The funding round details include: amount raised, valuation, and participating investors. ' +
      'Additional context: the deal was sourced through a warm introduction. ' +
      'Here is the structured extraction:\n';
    const payload = { companies: [{ name: { evidence: 'Acme Corp', value: 'Acme Corp' } }] };
    const full = preamble + JSON.stringify(payload);
    expect(preamble.length).toBeGreaterThan(300);
    expect(parseJson(full)).toEqual(payload);
  });

  // ── Common LLM malformations ──

  it('handles trailing comma in object', () => {
    expect(parseJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('handles trailing comma in array', () => {
    expect(parseJson('[1,2,3,]')).toEqual([1, 2, 3]);
  });

  it('handles single-quoted strings', () => {
    expect(parseJson("{'name':'Alice'}")).toEqual({ name: 'Alice' });
  });

  it('handles unquoted property names', () => {
    expect(parseJson('{name: "Alice", age: 30}')).toEqual({ name: 'Alice', age: 30 });
  });

  it('repairs truncated JSON', () => {
    const truncated = '{"companies":[{"name":"Acme"},{"name":"Beta"';
    const result = parseJson(truncated);
    expect(result.companies[0].name).toBe('Acme');
    expect(result.companies[1].name).toBe('Beta');
  });

  // ── Extraction-shaped payloads ──

  it('parses a realistic extraction response', () => {
    const realistic = JSON.stringify({
      subject: { evidence: 'RE: Series A funding update', value: 'Series A funding update' },
      companies: [{
        name: { evidence: '[Acme Corp] has raised a $50M Series A', value: 'Acme Corp' },
        stage: { evidence: 'raised a $50M [Series A]', value: 'Series A' },
        amount: { evidence: 'raised a [$50M] Series A', value: 50000000 },
      }],
      investors: [{
        name: { evidence: 'led by [Sequoia Capital]', value: 'Sequoia Capital' },
        role: { evidence: '[led by] Sequoia Capital', value: 'Lead' },
      }],
    });
    const parsed = parseJson(realistic);
    expect(parsed.companies[0].name.value).toBe('Acme Corp');
    expect(parsed.investors[0].name.value).toBe('Sequoia Capital');
  });

  it('parses extraction response wrapped in markdown', () => {
    const payload = { companies: [{ name: { evidence: 'test', value: 'Acme' } }] };
    expect(parseJson('```json\n' + JSON.stringify(payload, null, 2) + '\n```')).toEqual(payload);
  });

  it('parses extraction response with prose preamble', () => {
    const payload = { companies: [{ name: { evidence: 'test', value: 'Acme' } }] };
    expect(parseJson('Here is the extracted JSON:\n\n' + JSON.stringify(payload))).toEqual(payload);
  });

  // ── Strings with special characters ──

  it('handles braces and brackets inside string values', () => {
    expect(parseJson('{"evidence":"The company {Acme} raised [funding]","value":"Acme"}')).toEqual({
      evidence: 'The company {Acme} raised [funding]',
      value: 'Acme',
    });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJson('{"evidence":"He said \\"hello\\"","value":"greeting"}')).toEqual({
      evidence: 'He said "hello"',
      value: 'greeting',
    });
  });

  it('handles URLs with colons', () => {
    expect(parseJson('{"url":"https://example.com:8080/path"}')).toEqual({
      url: 'https://example.com:8080/path',
    });
  });

  it('handles unicode', () => {
    const obj = { evidence: 'Raised €50M from München-based fund', value: '€50M' };
    expect(parseJson(JSON.stringify(obj))).toEqual(obj);
  });

  it('handles newlines in strings', () => {
    const obj = { evidence: 'Line 1\nLine 2\nLine 3', value: 'test' };
    expect(parseJson(JSON.stringify(obj))).toEqual(obj);
  });

  // ── Edge cases ──

  it('handles null, boolean, and number values', () => {
    expect(parseJson('{"a":null,"b":true,"c":false,"d":-3.14,"e":1e10}')).toEqual({
      a: null, b: true, c: false, d: -3.14, e: 1e10,
    });
  });

  it('throws on empty string', () => {
    expect(() => parseJson('')).toThrow();
  });
});

describe('parseJsonReply', () => {
  // The LLM-reply variant never throws — a model reply is never
  // trustworthy enough to crash a run on (the empty-reply case
  // surfaced as jsonrepair's "Unexpected end of json string at
  // position 0" killing a movement firing).

  it('returns null for an empty reply', () => {
    expect(parseJsonReply('')).toBeNull();
  });

  it('returns null for a whitespace-only reply', () => {
    expect(parseJsonReply('  \n\t  ')).toBeNull();
  });

  it('parses valid JSON like parseJson', () => {
    expect(parseJsonReply('{"value":"x","has_value":true}')).toEqual({
      value: 'x',
      has_value: true,
    });
  });

  it('applies the same repair passes as parseJson', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('returns the raw text when nothing parses', () => {
    expect(parseJsonReply('Sorry, I cannot answer that.')).toBe(
      'Sorry, I cannot answer that.',
    );
  });
});
