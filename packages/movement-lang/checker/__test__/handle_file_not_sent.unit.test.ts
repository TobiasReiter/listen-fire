// A write handle's FILE field the write did not send holds, at run time, the
// system's own description of the file, so `READ(h.doc)` fails though the
// checker accepted it (B19). From language version 5 using such a field as a
// file is refused, with the way out: read the record back through its edge, as
// a walk read does. A field the write DID send is the program's own file and
// stays usable; versions 1 to 4 are unchanged.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';
import { SUPPORTED_LANGUAGE_VERSIONS, type LanguageVersion } from '../../language_version';
import { spelledFor } from './surface_spelling';

const driveSchema: InstanceSchema = {
  positions: {
    doc: { properties: { name: 'text', file: 'file' }, edges: {} },
  },
  collections: { docs: { target: 'doc' } },
  writableRoots: {
    doc: {
      fields: { name: 'text', file: 'file' },
      resultShape: { externalId: 'text', name: 'text', file: 'file' },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    drive: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: driveSchema },
  },
  credentials: { drive_cred: { adapter: 'drive' } },
  plugins: {
    ocr: { args: ['doc'], argTypes: { doc: 'file' }, requiredArgs: ['doc'], effects: { ai: true }, output: { kind: 'value', type: 'text' } },
  },
});

const program = (body: string[]): string =>
  [
    'import { drive } from adapters',
    'import { drive_cred } from credentials',
    'import { ocr } from plugins',
    '',
    'd = drive(credentials: drive_cred)',
    'movement m() {',
    '  f = FILE("contents", "pdf")',
    ...body,
    '}',
  ].join('\n');

const errorsUnder = (version: LanguageVersion, body: string[]): Diagnostic[] =>
  checkProgram(parseProgram(spelledFor(version, program(body), catalog), { languageVersion: version }), catalog, { languageVersion: version }).filter(
    d => (d.severity ?? 'error') === 'error',
  );

const UNSENT = ['  h = write d-[:docs]-> { name: "a" }', '  t = READ(h.`file`)'];
const SENT = ['  h = write d-[:docs]-> { name: "a", file: f }', '  t = READ(h.`file`)'];
const PASSED_ON = ['  h = write d-[:docs]-> { name: "a" }', '  t = ocr(doc: h.`file`)'];

describe('a write handle\'s unsent file field', () => {
  it.each([...SUPPORTED_LANGUAGE_VERSIONS].filter(v => v < 5))('is accepted under version %i', version => {
    expect(errorsUnder(version, UNSENT)).toEqual([]);
  });

  it('is refused under version 5, saying to read the record back through its edge', () => {
    const errors = errorsUnder(5, UNSENT);
    expect(errors.map(d => d.code)).toEqual(['MOV_HANDLE_FILE_NOT_SENT']);
    expect(errors[0]!.message).toContain('read the record back through its edge');
  });

  it('is refused under version 5 where a file is expected', () => {
    expect(errorsUnder(5, PASSED_ON).map(d => d.code)).toEqual(['MOV_HANDLE_FILE_NOT_SENT']);
  });

  it('stays usable when the write sent it', () => {
    for (const version of SUPPORTED_LANGUAGE_VERSIONS) expect(errorsUnder(version, SENT)).toEqual([]);
  });
});
