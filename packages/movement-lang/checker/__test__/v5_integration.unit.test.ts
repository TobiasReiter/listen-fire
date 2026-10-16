// The v5 surface integration's own rules, through the TypeScript checker:
// letter case counts in a call's name from 5; a WHERE's bare name is typed as
// the engine reads it (a value binding before a field) on every version; an
// alias read the scope also binds is refused under 5; and which fixes are
// marked safe to apply automatically. The Rust twin is
// crates/movement-checker/tests/v5_integration.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { spellingCheck, upgradeSource } from '../upgrade';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: { Messages: { target: 'message', readable: true, sequenced: 'chronological' } },
    },
    message: { properties: { Body: 'text', Score: 'number' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' } },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });
const HEAD4 = 'import { slack } from adapters\nchat = slack()\n\n';
const HEAD5 = 'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n';

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion });
}

function errors(source: string, languageVersion: number): string[] {
  return check(source, languageVersion)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

describe('the v5 surface integration', () => {
  it('a function call matches its name in letter case from version 5', () => {
    expect(errors(`${HEAD4}movement helper(x: <text>) {\n  return x\n}\n\nmovement go() {\n  y = Helper("a")\n}\n`, 4)).toEqual([]);
    const v5 = `${HEAD5}function helper(x: <text>) {\n  return x\n}\n\nfunction go() {\n  y = Helper("a")\n}\n`;
    expect(errors(v5, 5)).toContain('MOV_FUNCTION_UNKNOWN');
    expect(errors(v5.replace('Helper(', 'helper('), 5)).toEqual([]);
  });

  it('a WHERE name that is a variable and a field is typed as the variable the engine reads', () => {
    expect(errors(`${HEAD4}movement go(c: <chat-[:channel]->>, Score: <text>) {\n  ms = c-[m:Messages WHERE Score == "high"]->\n}\n`, 4)).toEqual([]);
    expect(errors(`${HEAD4}movement go(c: <chat-[:channel]->>) {\n  ms = c-[m:Messages WHERE Score == "high"]->\n}\n`, 4)).toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
  });

  it('an alias read whose name the scope binds is refused under 5', () => {
    expect(errors(`${HEAD5}function go(c: <chat-[:channel]->>, Body: <text>) {\n  ms = c-[m:Messages WHERE m.Body == Body]->\n}\n`, 5)).toEqual([
      'MOV_SHADOWED_NAME',
    ]);
    expect(errors(`${HEAD5}function go(c: <chat-[:channel]->>, wanted: <text>) {\n  ms = c-[m:Messages WHERE m.Body == wanted]->\n}\n`, 5)).toEqual([]);
  });

  it('only fixes that keep the meaning are marked safe', () => {
    const spelled = check(`${HEAD5}function go(t: <text>) {\n  a = UPPER(t)\n  b = ISNULL(t)\n}\n`, 5).filter((d) => d.code === 'MOV_V5_SPELLING');
    expect(spelled.find((d) => d.message.includes('UPPER'))?.fix?.safe).toBe(true);
    expect(spelled.find((d) => d.message.includes('ISNULL'))?.fix?.safe).toBeUndefined();
    const walk = check(`${HEAD5}function go(c: <chat-[:channel]->>) {\n  ms = c-[m:Messages WHERE Body == "x"]->\n}\n`, 5).filter(
      (d) => d.code === 'MOV_V5_SPELLING',
    );
    expect(walk.length).toBeGreaterThan(0);
    expect(walk.every((d) => d.fix?.safe === true)).toBe(true);
  });

  it('the upgrade applies safe fixes, holds the rest, and applies them too when asked', () => {
    const v4 = 'movement go(t: <text>) {\n  a = UPPER(t)\n  b = ISNULL(t)\n}\n';
    const held = upgradeSource(v4, spellingCheck());
    expect(held.source).toContain('Text.upper(t)');
    expect(held.source).toContain('ISNULL(t)');
    expect(held.held.map((d) => d.message)).toEqual([expect.stringContaining('ISNULL')]);
    const all = upgradeSource(v4, spellingCheck(), { all: true });
    expect(all.source).toContain('t == null');
    expect(all.held).toEqual([]);
  });
});
