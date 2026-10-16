// Version 5 fix-ups the handbook found (the Rust twin is
// crates/movement-checker/tests/v5_fixups.rs): a namespace member bound or
// returned whole (`t = Date.today(z)`) reads as versions 1–4 read
// `DATE.TODAY(z)`, an expression, never a call; and a type's address names
// the event's fields through its hop's alias (`e.action`), as every WHERE
// does from 5.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import { eventAddressOfHops } from '../event_address';

const catalog = mockCatalog({ adapters: {} });

function errors(source: string, languageVersion: 4 | 5): string[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => `${d.code}: ${d.message}`);
}

describe('a namespace member called whole where a value is bound', () => {
  it.each([
    'Date.today("Europe/Berlin")',
    'DateTime.at(Date.today("UTC"), "07:00", "UTC")',
    'Date.addDays(@current_date, 1)',
    'Text.regexExtract("DEAL-1", "(DEAL-\\\\d+)")',
    'Currency.numberFromFigure("£1.2m")',
    'Text.slug("a b")',
  ])('`t = %s` checks clean under 5, as its old spelling did under 4', (call) => {
    expect(errors(`function f() {\n  t = ${call}\n  return t\n}`, 5)).toEqual([]);
    expect(errors(`function f() {\n  return ${call}\n}`, 5)).toEqual([]);
  });

  it('the old spelling under 4 is unchanged', () => {
    expect(errors('movement f() {\n  t = DATE.TODAY("UTC")\n  return t\n}', 4)).toEqual([]);
  });

  it('a member the namespace does not have is still refused', () => {
    expect(errors('function f() {\n  t = Date.tomorrow("UTC")\n  return t\n}', 5).join('\n')).toMatch(/MOV_V5_UNKNOWN_MEMBER/);
  });
});

describe("an address's WHERE read through the hop's alias", () => {
  const aliased = '-[e:`Webhook Event` WHERE e.action == "record.created"]->';
  const bare = '-[:`Webhook Event` WHERE `action` == "record.created"]->';
  const address = { event: 'Webhook Event', narrowing: { action: 'record.created' } };

  it('names the same address under 5 as the bare field did under 4', () => {
    expect(eventAddressOfHops(aliased, 5)).toEqual(address);
    expect(eventAddressOfHops(bare, 4)).toEqual(address);
  });

  it('is not an address under 4, as it never was', () => {
    expect(eventAddressOfHops(aliased, 4)).toBeUndefined();
    expect(eventAddressOfHops(aliased)).toBeUndefined();
  });
});
