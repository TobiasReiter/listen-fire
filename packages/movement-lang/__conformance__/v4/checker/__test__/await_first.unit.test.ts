// Checker coverage for `await FIRST(<walk>)` — layer 13 C1.
//
// The model: await is the same read, PARKED — `ONLY(walk)` is `T | null`,
// `await FIRST(walk)` is `T` (the park strips the "not yet" arm), legal only
// where the final edge can end the wait (awaitable). The bare `await <walk>`
// spelling is retired: still parses, refused with the rewrite.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const askSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { Subject: 'text' },
      edges: { Checks: { target: 'check', readable: true } },
    },
    check: {
      properties: { Label: 'text' },
      edges: {
        Answer: { target: 'answer', readable: true, awaitable: true, watchable: true },
        Versions: { target: 'version', readable: true },
      },
    },
    answer: { properties: { Text: 'text' }, edges: {} },
    version: { properties: { Label: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: askSchema } },
});

function check(body: string): Diagnostic[] {
  const source = `import { email } from adapters
inbox = email()

movement m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('await FIRST — the parked read', () => {
  it('parses and checks clean over an awaitable edge, and the landing reads', () => {
    expect(
      codes('  c = ONLY(e-[k:Checks]->)\n  w = await FIRST(c-[:Answer]->)\n  t = w.`Text`'),
    ).toEqual([]);
  });

  it('the unbound statement form is legal too', () => {
    expect(codes('  c = ONLY(e-[k:Checks]->)\n  await FIRST(c-[:Answer]->)')).toEqual([]);
  });

  it('a WHERE rides inside the head unchanged', () => {
    expect(
      codes(
        '  c = ONLY(e-[k:Checks]->)\n  w = await FIRST(c-[ans:Answer WHERE ans.`Text` == "yes"]->)',
      ),
    ).toEqual([]);
  });

  it('FIRST over a non-awaitable edge is refused — the wait could never end', () => {
    expect(
      codes('  c = ONLY(e-[k:Checks]->)\n  w = await FIRST(c-[:Versions]->)'),
    ).toContain(C.AWAIT_NOT_AWAITABLE);
  });
});

describe('the bare walk under await is retired', () => {
  it('refused, and the message carries the rewrite', () => {
    const out = messages('  c = ONLY(e-[k:Checks]->)\n  w = await c-[:Answer]->');
    expect(codes('  c = ONLY(e-[k:Checks]->)\n  w = await c-[:Answer]->')).toContain(
      C.AWAIT_BARE_WALK,
    );
    expect(out).toContain('await FIRST(');
  });

  it('the refusal does not cascade — the binding still types for recovery', () => {
    const out = codes(
      '  c = ONLY(e-[k:Checks]->)\n  w = await c-[:Answer]->\n  t = w.`Text`',
    );
    expect(out).toContain(C.AWAIT_BARE_WALK);
    expect(out).not.toContain('MOV_UNKNOWN_PROPERTY');
  });

  it('sleep and until are untouched by the retirement', () => {
    expect(codes('  expired = await sleep(2d)')).toEqual([]);
  });
});
