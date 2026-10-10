// The `sleep <duration>` STATEMENT was removed (retired alongside the `ask`
// statement's family): the parser gate (parser/__test__/sleep.unit.test.ts)
// rejects the old form before the checker ever sees it, so the checker has no
// sleep-statement-specific validation left (`MOV_SLEEP_BAD_DURATION` is gone —
// `await sleep(…)`'s own `MOV_AWAIT_BAD_DURATION` is the one duration check
// now). What this file pins is what SURVIVES: `sleep` — now an ordinary name —
// flows through the checker with no special handling.

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
movement m(msg: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}

const codes = (body: string): string[] => check(body).map((d) => d.code);

describe('await sleep(…) — the one wait-on-the-clock form (checker)', () => {
  it('`await sleep(30s)` checks clean with no diagnostics', () => {
    expect(codes('  await sleep(30s)')).toEqual([]);
  });

  it('`await sleep(0s)` is accepted (zero duration parks immediately)', () => {
    expect(codes('  await sleep(0s)')).toEqual([]);
  });

  it('`await sleep(1h30m)` (multi-unit) checks clean', () => {
    expect(codes('  await sleep(1h30m)')).toEqual([]);
  });

  it('surrounding bindings are unaffected', () => {
    const diagnostics = check([
      '  x = msg',
      '  await sleep(10m)',
      '  write inbox-[:reply]-> { body: x }',
    ].join('\n'));
    const scopeDiags = diagnostics.filter((d) => d.code.startsWith('MOV_UNBOUND'));
    expect(scopeDiags).toEqual([]);
  });

  it('a malformed duration literal raises MOV_AWAIT_BAD_DURATION', () => {
    expect(codes('  await sleep(1x)')).toContain('MOV_AWAIT_BAD_DURATION');
  });
});

describe('the freed `sleep` name flows through the checker with no special handling', () => {
  it('`sleep` binds as an ordinary scalar and reads back clean', () => {
    expect(codes('  sleep = "a value"\n  n = sleep')).toEqual([]);
  });
});
