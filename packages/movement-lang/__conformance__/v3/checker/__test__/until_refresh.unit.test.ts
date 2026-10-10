// Checker coverage for asks-as-adapter chunk D: `await until(…)` (cadence floor,
// read-only purity) and `refresh <handle>` (stable-head requirement). EXISTS /
// COUNT polymorphism is exercised through the quorum until condition.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

// A tiny writable "ask" graph: a Check root whose handle carries readable
// fields (a refresh target) and an awaitable Response edge; the read positions
// carry the edges COUNT/EXISTS walk in the quorum condition.
const askSchema: InstanceSchema = {
  positions: {
    check: {
      properties: { state: 'text', answer: 'boolean' },
      edges: { responses: { target: 'response' } },
    },
    response: { properties: { answer: 'boolean' }, edges: { detail: { target: 'detail' } } },
    detail: { properties: { note: 'text' }, edges: {} },
  },
  collections: { checks: { target: 'check' }, Check: { target: 'Check' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Check: {
      fields: { prompt: 'text' },
      resultShape: { externalId: 'text', url: 'text', state: 'text', answer: 'boolean' },
      edges: {
        Response: { target: 'response', awaitable: true, watchable: true, resolvesEmpty: true },
      },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    asksys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: askSchema,
    },
  },
  credentials: { ask_creds: { adapter: 'asksys' } },
});

const PRELUDE = `import { asksys } from adapters
import { ask_creds } from credentials
questions = asksys(credentials: ask_creds)
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(d: <questions-[:check]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error');
}
const codes = (body: string): string[] => check(body).map((d) => d.code);

describe('await until — checker', () => {
  it('a valid recurring poll (closure condition, named cadence) is clean', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  r = await until(() => { refresh a; return a.state == "answered" }, every: 5m)',
      ),
    ).toEqual([]);
  });

  it('the retired block-with-dot condition is a parse error naming the closure', () => {
    expect(() =>
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  r = await until({ refresh a; ok = a.state == "answered" }.ok, every: 5m)',
      ),
    ).toThrow(/is a closure/);
  });

  it('a condition closure that takes a parameter is refused — nothing supplies it', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  r = await until((n: <number>) => { return a.state == "answered" }, every: 5m)',
      ),
    ).toContain(C.AWAIT_IMPURE_CONDITION);
  });

  it('a cadence below the 1m floor is MOV_UNTIL_CADENCE_TOO_SHORT', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  await until(() => { refresh a; return a.state == "answered" }, every: 30s)',
      ),
    ).toContain(C.UNTIL_CADENCE_TOO_SHORT);
  });

  it('a 1m cadence is exactly on the floor and clean of the cadence error', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  await until(() => { refresh a; return a.state == "answered" }, every: 1m)',
      ),
    ).not.toContain(C.UNTIL_CADENCE_TOO_SHORT);
  });

  it('a write inside the condition is MOV_AWAIT_IMPURE_CONDITION', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  await until(() => { b = write questions-[:Check]-> { prompt: "x" }; return a.state == "answered" }, every: 5m)',
      ),
    ).toContain(C.AWAIT_IMPURE_CONDITION);
  });

  it('a nested await inside the condition is MOV_AWAIT_IMPURE_CONDITION', () => {
    expect(
      codes(
        '  a = write questions-[:Check]-> { prompt: "ok?" }\n' +
          '  await until(() => { x = await a-[:Response]->; return a.state == "answered" }, every: 5m)',
      ),
    ).toContain(C.AWAIT_IMPURE_CONDITION);
  });

  it('the quorum narrowing form (COUNT / EXISTS over sets) type-checks', () => {
    expect(
      codes(
        '  await until(COUNT(d-[x:responses WHERE EXISTS(x-[:detail]->)]->) >= COUNT(d-[:responses]->) * 2/3, every: 10m)',
      ),
    ).toEqual([]);
  });
});

describe('refresh — checker', () => {
  it('refresh on a write handle is clean', () => {
    expect(codes('  a = write questions-[:Check]-> { prompt: "ok?" }\n  refresh a')).toEqual([]);
  });

  it('refresh on the event payload is MOV_REFRESH_UNSTABLE', () => {
    expect(codes('  refresh d')).toContain(C.REFRESH_UNSTABLE);
  });

  it('refresh on an extracted node is MOV_REFRESH_UNSTABLE', () => {
    expect(
      codes('  ex = extract from [d.`state`] {\n    company: "the company"\n  }\n  refresh ex'),
    ).toContain(C.REFRESH_UNSTABLE);
  });

  it('refresh on an unbound name is a resolution error', () => {
    expect(codes('  refresh nope').length).toBeGreaterThan(0);
  });
});

describe('empty-write warning', () => {
  const warnings = (body: string): string[] => {
    const source = `${PRELUDE}\nmovement m(d: <questions-[:check]->>) {\n${body}\n}`;
    return checkProgram(parseProgram(source), catalog)
      .filter((x) => x.severity === 'warning')
      .map((x) => x.code);
  };

  it('a write whose only field is a `?:` fill of a possibly-absent value warns', () => {
    // `d.detail` off the maybe-empty-free path is present, so drive absence
    // through DATE.PARSE (types `date | absent`).
    expect(warnings('  write questions-[:Check]-> { prompt ?: DATE.PARSE(d.`state`) }')).toContain(
      'MOV_WRITE_MAY_BE_EMPTY',
    );
  });

  it('a write with a present (non-absent) field does not warn', () => {
    expect(warnings('  write questions-[:Check]-> { prompt: "hi" }')).not.toContain(
      'MOV_WRITE_MAY_BE_EMPTY',
    );
  });
});
