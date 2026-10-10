// "read-only" was one message standing for three different facts, and only one
// of them was about the source. A bare Google Sheets tab with a blank row 1
// described no writable fields, which the projection turns into a missing write
// shape and the checker reported as "'sheets' fills it itself" — sending the
// author to look for a capability we already shipped, instead of at row 1.

import { checkProgram } from '../check';
import { parseProgram } from '../../parser/parse';
import { fromCatalogSnapshot } from '../../service/snapshot';
import type { CatalogSnapshot } from '../../service/snapshot';
import type { InstanceSchema } from '../catalog';

const program = (edge: string) => `
import { sheets } from adapters
import { probe } from credentials

s = sheets(credentials: probe)

movement m() {
  write s-[:\`${edge}\`]-> {
    A: "x"
  }
}
`;

const snapshotOf = (schema: InstanceSchema): CatalogSnapshot => ({
  adapters: {
    sheets: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { probe: schema },
    },
  },
  credentials: { probe: { adapters: ['sheets'] } },
  plugins: {},
});

const errorsFor = (schema: InstanceSchema, edge: string): string[] =>
  checkProgram(parseProgram(program(edge)), fromCatalogSnapshot(snapshotOf(schema)))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.message);

describe('a read-only edge names WHY it is read-only', () => {
  it('a described target with no fields says so — not that the instance fills it', () => {
    // The Sheets case: the tab exists, the system would accept an append, but
    // row 1 was blank so there is nothing to set.
    const schema: InstanceSchema = {
      positions: { 'Sheet1 (sheet)': { properties: {}, edges: {} } },
      collections: { 'Sheet1 (sheet)': { target: 'Sheet1 (sheet)' } },
      writableRoots: {},
    };
    const [message] = errorsFor(schema, 'Sheet1 (sheet)');
    expect(message).toContain('has no fields to write');
    expect(message).not.toContain('fills it itself');
  });

  it('a target nobody described says THAT, rather than claiming it is read-only', () => {
    // "I haven't looked" and "you may not write here" are different facts, and
    // collapsing them is this language's recurring bug class.
    const schema: InstanceSchema = {
      positions: { Thing: { properties: {}, edges: {}, undescribed: true } },
      collections: { Thing: { target: 'Thing' } },
      writableRoots: {},
    };
    const [message] = errorsFor(schema, 'Thing');
    expect(message).toContain('nothing has described');
    expect(message).not.toContain('fills it itself');
  });

  it('a genuinely read-only collection still says the instance fills it', () => {
    // The original message was not wrong — it was over-applied. A target the
    // instance really does populate keeps it.
    const schema: InstanceSchema = {
      positions: { Company: { properties: { Name: 'text' }, edges: {} } },
      collections: { Companies: { target: 'Company' } },
      writableRoots: {},
    };
    const [message] = errorsFor(schema, 'Companies');
    expect(message).toContain('fills it itself');
  });

  it('a writable edge is still accepted — the gate itself is unchanged', () => {
    const schema: InstanceSchema = {
      positions: { 'Sheet1 (sheet)': { properties: { A: 'text' }, edges: {} } },
      collections: { 'Sheet1 (sheet)': { target: 'Sheet1 (sheet)' } },
      writableRoots: {
        'Sheet1 (sheet)': { fields: { A: 'text' }, resultShape: { externalId: 'text' } },
      },
    };
    expect(errorsFor(schema, 'Sheet1 (sheet)')).toEqual([]);
  });
});
