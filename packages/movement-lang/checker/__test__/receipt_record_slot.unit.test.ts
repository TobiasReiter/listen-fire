// Language version 5 (Dancing Wren): a `parallel` / `race` receipt's slot
// holding the record an arm handed back reads as that record (`AT(r, i).Name`),
// as a list literal's member does. Before 5 the slot read null at run time
// while the checker accepted the field read. The type is the same on both
// sides, so a move up across 5 warns a read of such a receipt
// (`MOV_RECEIPT_RECORD_SLOT`); a receipt whose arms hand back values does not.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { TypedDiagnosticCodes } from '../typing';
import { InstanceSchema, SchemaFieldType, mockCatalog } from '../catalog';

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const crmSchema: InstanceSchema = {
  positions: {
    company: { properties: { Name: 'text', Domains: textList }, edges: {} },
    note: { properties: { title: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' }, notes: { target: 'note' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: { Name: 'text', Domains: textList },
      resultShape: { externalId: 'text', url: 'text', Name: 'text', Domains: textList },
    },
    note: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', url: 'text', title: 'text' },
    },
  },
};

/** A graph whose types declare fields literally named `created` and
 *  `committed` — one on the write's result, one only on the position. */
const graphSchema: InstanceSchema = {
  positions: {
    meeting: { properties: { title: 'text', created: 'date' }, edges: {} },
    minute: { properties: { title: 'text', committed: 'text' }, edges: {} },
  },
  collections: { meetings: { target: 'meeting' }, minutes: { target: 'minute' } },
  writableRoots: {
    meeting: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', title: 'text', created: 'date' },
    },
    minute: {
      fields: { title: 'text' },
      resultShape: { externalId: 'text', title: 'text' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: crmSchema },
    kg: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: graphSchema },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    native_knowledge: { adapter: 'kg' },
  },
});

const PRELUDE = [
  'import { email, attio, kg } from adapters',
  'import { dealflow_inbox, acme_main, native_knowledge } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'graph = kg(credentials: native_knowledge)',
].join('\n');

const inMovement = (body: string) =>
  `${PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

// Info severity dropped: the fixture movement declares no listen, which
// legitimately carries MOV_LISTEN_MISSING.
const under = (version: number, body: string) =>
  checkProgram(parseProgram(inMovement(body)), catalog, { languageVersion: version }).filter((d) => d.severity !== 'info');

const RECEIPT = [
  '  r = await parallel([',
  '    () => {',
  '      a = write crm-[:companies]-> { unique by (`Name`), Name: "Acme" }',
  '      return a',
  '    },',
  '    () => 2,',
  '  ])',
].join('\n');

const crossing = (from: number, to: number, body: string) =>
  checkProgram(parseProgram(inMovement(body)), catalog, { languageVersion: to, upgradingFrom: from })
    .filter((d) => d.code === TypedDiagnosticCodes.RECEIPT_RECORD_SLOT);

describe("a combinator receipt's record slot", () => {
  it('crossing 5, a field read off the slot is a move-up warning naming the receipt', () => {
    const d = crossing(4, 5, [RECEIPT, '  n = AT(r, 0).Name'].join('\n'));
    expect(d).toHaveLength(1);
    expect(d[0].upgrade).toBe(true);
    expect(d[0].severity).toBe('warning');
    expect(d[0].message).toContain("through 'r'");
  });
  it('crossing 5, the slot bound to a name and a null check warn too', () => {
    expect(crossing(4, 5, [RECEIPT, '  h = AT(r, 0)', '  n = h.Name'].join('\n'))).toHaveLength(1);
    expect(crossing(4, 5, [RECEIPT, '  n = AT(r, 0) == null'].join('\n'))).toHaveLength(1);
  });
  it('a race receipt warns as well', () => {
    expect(crossing(4, 5, [RECEIPT.replace('parallel', 'race'), '  n = AT(r, 0)'].join('\n'))).toHaveLength(1);
  });
  it('a receipt whose arms hand back values is silent crossing 5', () => {
    const values = ['  r = await parallel([', '    () => "one",', '    () => 2,', '  ])', '  n = AT(r, 0)'].join('\n');
    expect(crossing(4, 5, values)).toEqual([]);
  });
  it('an arm that hands back a LIST of records reads the same on 4 and 5, so it is silent', () => {
    const listed = [
      '  r = await parallel([',
      '    () => {',
      '      a = write crm-[:companies]-> { unique by (`Name`), Name: "Acme" }',
      '      return [a, a]',
      '    },',
      '    () => 2,',
      '  ])',
      '  n = AT(r, 0)',
    ].join('\n');
    expect(crossing(4, 5, listed)).toEqual([]);
  });
  it('is reported once per receipt, however many times it is read', () => {
    const d = crossing(4, 5, [RECEIPT, '  n = AT(r, 0).Name', '  m = AT(r, 0) == null', '  k = AT(r, 1)'].join('\n'));
    expect(d).toHaveLength(1);
  });
  it('silent under 4 and 5 without a move up, and on a move up that does not cross 5', () => {
    const src = [RECEIPT, '  n = AT(r, 0).Name'].join('\n');
    for (const languageVersion of [4, 5]) {
      expect(under(languageVersion, src).filter((d) => d.code === TypedDiagnosticCodes.RECEIPT_RECORD_SLOT)).toEqual([]);
    }
    expect(crossing(3, 4, src)).toEqual([]);
  });
  it('the read checks clean under 4 (what the run reads is what changed)', () => {
    expect(under(4, [RECEIPT, '  n = AT(r, 0).Name'].join('\n')).filter((d) => (d.severity ?? 'error') === 'error')).toEqual([]);
  });
  it('under 5 parallel itself is retired, and its rewrite reads the slot as the record, clean', () => {
    const errors = (body: string) => under(5, body).filter((d) => (d.severity ?? 'error') === 'error');
    expect(errors([RECEIPT, '  n = AT(r, 0).Name'].join('\n')).map((d) => d.code)).toEqual(['MOV_PARALLEL_RETIRED']);
    const joined = RECEIPT.replace('r = await parallel([', 'r = all(').replace('  ])', '  )');
    expect(errors([joined, '  n = AT(r, 0).Name'].join('\n'))).toEqual([]);
  });
});
