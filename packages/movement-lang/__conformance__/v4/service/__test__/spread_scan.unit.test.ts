// The narrowing pre-scan runs before the checker, so it never knows what fields
// a `...e` spread stands for. It does not need to: every line a spread stands
// for is a one-field read off `e`, which grounds no hop chain and is never a
// literal a body-decided landing keys on. These tests pin that a spread and its
// written-out lines scan the same.

import { scanInstanceChains } from '../selectors';

const PRELUDE = [
  'import { email, attio } from adapters',
  'import { acme_main } from credentials',
  'inbox = email()',
  'crm = attio(credentials: acme_main)',
  'node Deal { name: <text>; stage: <text> }',
].join('\n');

/** What the scan hands the host, less the write body it carries for landings. */
const selections = (source: string) =>
  scanInstanceChains(source).map(({ writeBody: _body, ...chain }) => chain);

describe('the narrowing pre-scan over a spread', () => {
  it('scans an extracted record spread the same as its written-out lines', () => {
    const at = (body: string) =>
      [
        PRELUDE,
        'movement m(msg: <inbox-[:message]->>) {',
        '  found = extract from [msg.`text`] { node entry: "each" { name: "n"; stage: "s" } }',
        '  found-[e:entry]-> {',
        `    write crm-[:companies WHERE \`Name\` == "x"]-> { ${body} }`,
        '  }',
        '}',
      ].join('\n');
    const spread = selections(at('?...e'));
    expect(spread.length).toBeGreaterThan(0);
    expect(spread).toEqual(selections(at('name ?: e.name, stage ?: e.stage')));
  });

  it('scans a spread of a system record the same too — it grounds no chain of its own', () => {
    const at = (body: string) =>
      [
        PRELUDE,
        'movement m(msg: <inbox-[:message]->>) {',
        '  crm-[c:companies]-> {',
        `    write crm-[:companies]-> { ${body} }`,
        '  }',
        '}',
      ].join('\n');
    expect(selections(at('...c'))).toEqual(selections(at('name: c.name')));
  });
});
