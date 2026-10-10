// The `ask` STATEMENT was removed (asks-as-adapter, chunk G): the parser gate
// (parser/__test__/ask.unit.test.ts) rejects the old form before the checker
// ever sees it, so the checker has no ask-specific validation left. What this
// file pins is what SURVIVES: the `ERROR("…")` statement (which the ask
// `fallback … to ERROR` terminal used to share), and that `ask` — now an
// ordinary name — flows through the checker with no special handling.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { mockCatalog } from '../catalog';

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], triggerConfig: ['key'] },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
  },
});

const PRELUDE = `import { email } from adapters
import { dealflow_inbox } from credentials
inbox = email(credentials: dealflow_inbox)
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(d: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);

describe('ERROR statement — the surviving half of the old fallback terminal', () => {
  it("ERROR's message expression is checked (undefined name caught)", () => {
    expect(codes(`  ERROR(nonexistent_reason)`)).toContain('MOV_NAME_UNRESOLVED');
  });

  it('a literal ERROR reason checks clean', () => {
    expect(codes(`  ERROR("a clear literal reason")`)).toEqual([]);
  });
});

describe('the freed `ask` name flows through the checker with no special handling', () => {
  it('`ask` binds as an ordinary scalar and reads back clean', () => {
    expect(codes(`  ask = "a question"\n  n = ask`)).toEqual([]);
  });
});
