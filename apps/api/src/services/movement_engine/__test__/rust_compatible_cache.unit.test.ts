// `check.compatible` checks the program it asks about against the catalog
// of the segment asking, and keeps what it checked for that segment alone:
// two runs of one source over two tenants' catalogs never share a check.

import { mockCatalogSnapshot } from 'movement-lang';

import { checkedProgram } from 'movement-engine/services/movement_engine/rust_host';

const SOURCE = [
  'import { email } from adapters',
  'import { tenant_a } from credentials',
  'inbox = email(credentials: tenant_a)',
  'node Lead { name: <text> }',
  'movement m(msg: <inbox-[:message]->>) {',
  '  x = 1',
  '}',
].join('\n');

const catalogOf = (credential: string) =>
  mockCatalogSnapshot({
    adapters: { email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }] } },
    credentials: { [credential]: { adapters: ['email'] } },
  });

describe("check.compatible's checked programs", () => {
  it("are kept per segment, and checked against that segment's catalog: another tenant's run is never answered from one", () => {
    const first = { catalog: catalogOf('tenant_a'), checked: new Map() };
    const a = checkedProgram(first, SOURCE, 3);
    expect(checkedProgram(first, SOURCE, 3)).toBe(a);
    expect(first.checked.size).toBe(1);
    // The same source over a catalog without its credential fails its check
    // there, where a process-wide cache keyed on the source alone handed back
    // the first tenant's program.
    const second = { catalog: catalogOf('tenant_b'), checked: new Map() };
    expect(() => checkedProgram(second, SOURCE, 3)).toThrow(/MOVENG_CHECK/);
    expect(second.checked.size).toBe(0);
    const third = { catalog: catalogOf('tenant_a'), checked: new Map() };
    expect(checkedProgram(third, SOURCE, 3)).not.toBe(a);
  });
});
