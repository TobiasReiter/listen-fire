// Language-service coverage for file imports: the snapshot's `files`
// drive import-path completions, imported-name completions, full-fidelity
// diagnostics (imports resolve offline), and best-effort analysis typing
// (an imported declaration is typed, and no longer offered as a write target).

import {
  getMovementCompletions,
  getMovementDiagnostics,
  getHoverInfo,
} from '../service';
import type { CatalogSnapshot } from '../snapshot';

const LIB = [
  'import { dropbox } from adapters',
  'import { team_drive } from credentials',
  '',
  'export node Files {',
  '  name: <text>',
  '  data: <file>',
  '}',
  '',
  'export movement files_to_dropbox(f: <Files>) {',
  '  drive = dropbox(credentials: team_drive)',
  '  write drive-[:files]-> {',
  '    name: f.`name`',
  '    data: f.`data`',
  '  }',
  '}',
].join('\n');

const snapshot: CatalogSnapshot = {
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      // An inbox fires. This fixture omitted the flag and still passed, because
      // `fromCatalogSnapshot` was rebuilding the spec field by field and
      // dropping `canFire` — so the check that reads it never ran. Absence on a
      // KNOWN spec is the positive fact "cannot fire"; once the spec was taken
      // by subtraction instead, the omission started meaning what it says.
      canFire: true,
      schemas: {
        dealflow_inbox: {
          positions: {
            message: {
              properties: { subject: 'text', text: 'text', attachment: 'file' },
              edges: {},
            },
          },
          collections: { messages: { target: 'message' } },
          writableRoots: {},
        },
      },
    },
    dropbox: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: {
        team_drive: {
          positions: { file: { properties: { name: 'text', data: 'file' }, edges: {} } },
          collections: { files: { target: 'file' } },
          writableRoots: {
            file: {
              fields: { name: 'text', data: 'file' },
              resultShape: { externalId: 'text', name: 'text', data: 'file' },
            },
          },
        },
      },
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    team_drive: { adapter: 'dropbox' },
  },
  plugins: {},
  files: {
    'lib/file-routines': { source: LIB },
    'shapes/deals': { source: 'node Deal {\n  stage: <text>\n}' },
  },
};

const complete = (source: string) =>
  getMovementCompletions(source, source.length, snapshot);

describe('import completions', () => {
  it('completes import paths from the saved movement files', () => {
    const { items } = complete('import { x } from "');
    expect(items.map(i => i.label).sort()).toEqual(['lib/file-routines', 'shapes/deals']);
    expect(items[0].insert.endsWith('"')).toBe(true);
  });

  it('filters paths by the typed prefix (slashes included)', () => {
    const { items } = complete('import { x } from "lib/');
    expect(items.map(i => i.label)).toEqual(['lib/file-routines']);
  });

  it('offers the file-source alongside the builtin namespaces', () => {
    const { items } = complete('import { x } from ');
    expect(items.map(i => i.label)).toEqual(
      expect.arrayContaining(['adapters', 'credentials', 'plugins', '"<file>"']),
    );
  });

  it("completes imported names from the file's exports", () => {
    const { items } = complete('import {  } from "lib/file-routines"'.replace('{  }', '{ '));
    // cursor inside the braces, full line carries the path
    const completions = getMovementCompletions(
      'import {  } from "lib/file-routines"',
      'import { '.length,
      snapshot,
    );
    expect(completions.items.map(i => `${i.kind}:${i.label}`).sort()).toEqual([
      'function:files_to_dropbox',
      'value:Files',
    ]);
    expect(items).toBeDefined();
  });
});

describe('diagnostics with resolved files', () => {
  const consumer = (importLine: string, body: string) =>
    [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      importLine,
      '',
      'inbox = email(credentials: dealflow_inbox)',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      body,
      '}',
      '',
      'listen to inbox fire intake',
    ].join('\n');

  it('a resolvable import produces no diagnostics', () => {
    const diagnostics = getMovementDiagnostics(
      consumer(
        'import { files_to_dropbox, Files } from "lib/file-routines"',
        '  files_to_dropbox(f: node { name: msg.`subject`, data: msg.`attachment` })',
      ),
      snapshot,
    );
    expect(diagnostics.filter(d => (d.severity ?? 'error') === 'error')).toEqual([]);
  });

  it('an unknown export is flagged with offsets', () => {
    const diagnostics = getMovementDiagnostics(
      consumer(
        'import { nothing_here } from "lib/file-routines"',
        '  x = msg.`subject`',
      ),
      snapshot,
    );
    const codes = diagnostics.map(d => d.code);
    expect(codes).toContain('MOV_IMPORT_NOT_EXPORTED');
    const flagged = diagnostics.find(d => d.code === 'MOV_IMPORT_NOT_EXPORTED');
    expect(flagged && flagged.to > flagged.from).toBe(true);
  });
});

describe('analysis typing for imported names', () => {
  const source = [
    'import { email } from adapters',
    'import { dealflow_inbox } from credentials',
    'import { Files } from "lib/file-routines"',
    '',
    'inbox = email(credentials: dealflow_inbox)',
    '',
    'movement intake(msg: <inbox-[:message]->>) {',
    '  write ',
    '}',
  ].join('\n');

  it('an imported declaration is NOT offered as a write target (the construct is retired)', () => {
    const offset = source.indexOf('write ') + 'write '.length;
    const { items } = getMovementCompletions(source, offset, snapshot);
    expect(items.map(i => i.label)).not.toContain('Files.');
  });

  it('hover knows an imported name is a declared node', () => {
    // A parseable variant (the completion fixture's dangling `write ` is
    // only valid mid-edit at the cursor's own line).
    const parseable = source.replace('  write ', '  f = node { name: msg.`subject` }');
    const offset = parseable.indexOf('Files } from');
    const hover = getHoverInfo(parseable, offset + 1, snapshot);
    expect(hover?.contents.join('\n')).toContain('declared node');
  });
});
