// What a message suggests is written in the program's own language version:
// from 5 a suggestion reads in the v5 surface (`coalesce(…)`, `!`, `if (…)`,
// `connect … using …`), and up to 4 it is byte for byte what it was. The
// rewrite is the parser's own spelling fixes (spellCode, through the WASM).

import { parseProgram } from '../../parser/parse';
import { spellCode, spellIf, spellWord } from '../../parser/surface';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text', Count: 'number' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema } },
  credentials: { acme_main: { adapters: ['slack'] } },
});

const HEAD_5 = 'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n';
const HEAD_4 = 'import { slack } from adapters\nchat = slack()\n\n';

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion });
}

function find(diagnostics: Diagnostic[], code: string): Diagnostic {
  const found = diagnostics.find((d) => d.code === code);
  if (found === undefined) throw new Error(`no ${code} in ${JSON.stringify(diagnostics)}`);
  return found;
}

describe('a message suggests the surface of its program\'s version', () => {
  it('a fallback for an absent value, and its fix', () => {
    const v5 = find(
      check(`${HEAD_5}function go(c: <chat-[:channel]->>) {\n  n = first(c-[m:Messages]->.Text)\n  write chat-[:note]-> { Body: n }\n}`, 5),
      'MOV_ABSENT_REQUIRED',
    );
    expect(v5.message).toContain(`write 'Body: coalesce(n, "unknown")'`);
    expect(v5.fix?.edits[0]?.text).toBe('coalesce(n, "unknown")');
    const v4 = find(
      check(`${HEAD_4}movement go(c: <chat-[:channel]->>) {\n  n = FIRST(c-[m:Messages]->.Text)\n  write chat-[:note]-> { Body: n }\n}`, 4),
      'MOV_ABSENT_REQUIRED',
    );
    expect(v4.message).toContain(`write 'Body: COALESCE(n, "unknown")'`);
    expect(v4.fix?.edits[0]?.text).toBe('COALESCE(n, "unknown")');
  });

  it('an operator named in prose, and an `if` it suggests', () => {
    const closures = check(`${HEAD_5}function go() {\n  f = () => 1\n  x = !f\n  y = f && f\n}`, 5).map((d) => d.message);
    expect(closures).toEqual([
      expect.stringContaining("a value negated by '!' is a closure"),
      expect.stringContaining("a value joined by '&&' is a closure"),
    ]);
    const unnamed = find(check(`${HEAD_5}function go() {\n  match chat-[:note]-> { unique by (Body), Body: "x" }\n}`, 5), 'MOV_MATCH_UNNAMED');
    expect(unnamed.message).toContain('then `if (existing != null) { … }`');
  });

  it('a credential is named after `using`', () => {
    const v5 = find(
      check(`import { acme_main as acme } from credentials\n${HEAD_5}function go() {\n  x = acme\n}`, 5),
      'MOV_CREDENTIAL_NOT_A_VALUE',
    );
    expect(v5.message).toContain("it is only named after 'using' where an adapter is connected ('connect … using acme')");
    const v4 = find(
      check(`import { acme_main as acme } from credentials\n${HEAD_4}movement go() {\n  x = acme\n}`, 4),
      'MOV_CREDENTIAL_NOT_A_VALUE',
    );
    expect(v4.message).toContain("it is only named as the 'credentials:' argument where an integration is set up");
  });

  it('a did-you-mean fix writes the built-in in the program\'s spelling', () => {
    const v5 = find(check(`${HEAD_5}function go() {\n  y = uppr("a")\n}`, 5), 'MOV_FUNCTION_UNKNOWN');
    expect(v5.message).toContain("did you mean 'Text.upper'?");
  });

  it('the phrase helpers: canonical text as it is up to 4, rewritten from 5', () => {
    for (const [old, v5] of [
      ['EXISTS(channel)', 'channel != null'],
      ['AT(t, 0)', 't[0]'],
      ['IF … THEN "Yes" ELSE "No" END', '… ? "Yes" : "No"'],
      ['if ISNULL(x) { ERROR("…") }', 'if (x == null) { fail("…") }'],
      ['await until(() => { return EXISTS(t-[:Shipment]->) }, every: 15m)', 'await until(() => { return exists(t-[:Shipment]->) }, { every: 15m })'],
      ['crm-[c:Companies WHERE LOWER(c.Name) CONTAINS "x"]->', 'crm-[c:Companies WHERE LOWER(c.Name) CONTAINS "x"]->'],
    ]) {
      expect(spellCode(old!, 4)).toBe(old);
      expect(spellCode(old!, 5)).toBe(v5);
    }
    expect([spellWord('NOT', 4), spellWord('NOT', 5)]).toEqual(['NOT', "'!'"]);
    expect([spellIf('EXISTS(co)', 4), spellIf('EXISTS(co)', 5)]).toEqual(['if EXISTS(co)', 'if (co != null)']);
  });
});
