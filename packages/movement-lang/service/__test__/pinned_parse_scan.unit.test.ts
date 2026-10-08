// The demand scan reads a program under its pin, as the engine runs it. Before
// language version 3 a collection op (`MAP(xs, f)`, `REDUCE(xs, 0, f)`, …) is
// its own form, not a call; the scan reads that form, so a v1 or v2 program
// demands the schemas it demanded when the scan parsed it as a call.

import { scanInstanceChains } from '../selectors';

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme } from credentials',
  'inbox = email()',
  'crm   = attio(credentials: acme)',
  'movement tagit(t: <text>) {',
  '  return t',
  '}',
].join('\n');

const movement = (body: string[]) =>
  [
    PRELUDE,
    'movement intake(m: <inbox-[:Email]->>) {',
    ...body.map((line) => `  ${line}`),
    '}',
  ].join('\n');

/** Each chain as `adapter@start: edge → edge`, sorted, for comparing scans. */
const paths = (source: string, languageVersion: number) =>
  scanInstanceChains(source, { languageVersion })
    .map(
      (chain) =>
        `${chain.adapter}${chain.startPosition !== undefined ? `@${chain.startPosition}` : ''}: ` +
        chain.steps.map((step) => (step.type === 'edge' ? step.edgeTypeId : '?')).join(' → '),
    )
    .sort();

// What each collection op reads — its collection, a REDUCE's starting value,
// a MAP's settings — walks an instance. The function's body is walked only
// from version 3 (closure_scan.unit.test.ts), so before it a body's writes
// demand nothing.
const ops: Record<string, { body: string[]; before3: string[]; v3: string[] }> = {
  'a bound MAP': {
    body: ['names = MAP(crm-[:Companies]->, tagit)'],
    before3: ['attio: Companies'],
    v3: ['attio: Companies'],
  },
  'a bare MAP with settings and a function': {
    body: ['MAP(crm-[:Companies]->, { concurrency: 2 }, (c) => { write crm-[:People]-> { Name: "x" } })'],
    before3: ['attio: Companies'],
    v3: ['attio: Companies', 'attio: People'],
  },
  'a REDUCE': {
    body: ['n = REDUCE(crm-[:Deals]->, COUNT(crm-[:Lists]->), (acc, d) => { return acc })'],
    before3: ['attio: Deals', 'attio: Lists'],
    v3: ['attio: Deals', 'attio: Lists'],
  },
  'a returned FILTER': {
    body: ['return FILTER(crm-[:Companies]->, tagit)'],
    before3: ['attio: Companies'],
    v3: ['attio: Companies'],
  },
};

describe('the demand scan reads a pre-version-3 collection op', () => {
  for (const [name, { body, before3, v3 }] of Object.entries(ops)) {
    it(`${name}: a v1 and a v2 program demand what the op reads`, () => {
      for (const languageVersion of [1, 2]) expect(paths(movement(body), languageVersion)).toEqual(before3);
    });

    it(`${name}: a v3 program is unchanged`, () => {
      expect(paths(movement(body), 3)).toEqual(v3);
    });
  }
});

describe('the demand scan parses under the pin', () => {
  // `extractOne` is an ordinary name before version 3 and the extraction call
  // from it, so this text is a v1 program the v3 grammar refuses. Parsed at
  // the release's version it demanded nothing at all.
  const source = [
    PRELUDE,
    'movement extractOne(c: <crm-[:Companies]->>) {',
    '  return c',
    '}',
    'movement intake(m: <inbox-[:Email]->>) {',
    '  crm-[c:Companies]-> {',
    '    found = extractOne(c: c)',
    '  }',
    '}',
  ].join('\n');

  it('a v1 program the v3 grammar refuses still demands what it walks', () => {
    for (const languageVersion of [1, 2]) expect(paths(source, languageVersion)).toEqual(['attio: Companies']);
  });

  it('under version 3 the text does not parse: nothing demanded', () => {
    expect(paths(source, 3)).toEqual([]);
  });
});
