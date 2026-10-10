// File imports (3_syntax_sketch.md §H) — the linker + checker resolution.
//
// With an injected `resolveFile`, `import { … } from "<file>"` resolves:
// the library is parsed + checked in its own scope, imported movements are
// callable (call-fit against their params), imported shapes are usable as
// parameter types, aliasing rebinds locally, and every failure
// mode — unresolved path, unknown export, cycle, non-library file,
// library-internal errors — surfaces as a precise diagnostic on the
// importing file. Without a resolver the M2 opaque behavior stands
// (covered by check.unit.test.ts).

import { parseProgram } from '../../parser/parse';
import {
  checkProgram,
  checkProgramWithLink,
  Diagnostic,
  DiagnosticCodes as C,
} from '../check';
import { mockCatalog } from '../catalog';
import { fileExports, linkImports, type ResolveFile } from '../link';

const catalog = mockCatalog({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['key'],
      schema: {
        positions: {
          message: {
            properties: { subject: 'text', text: 'text' },
            edges: { files: { target: 'attachment' } },
          },
          attachment: {
            properties: { filename: 'text', data: 'file' },
            edges: {},
          },
        },
        collections: { messages: { target: 'message' } },
        writableRoots: {},
        eventPosition: 'message',
      },
    },
    dropbox: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: {
          file: { properties: { name: 'text', data: 'file' }, edges: {} },
        },
        collections: { files: { target: 'file' } },
        writableRoots: {
          file: {
            fields: { name: 'text', data: 'file' },
            resultShape: { externalId: 'text', name: 'text', data: 'file' },
          },
        },
      },
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: {
        positions: {
          company: { properties: { name: 'text', size: 'number' }, edges: {} },
        },
        collections: { companies: { target: 'company' } },
        writableRoots: {
          company: {
            fields: {
              name: 'text',
              size: 'number',
              funding_stage: { kind: 'enum', options: ['Seed', 'Series A'] },
            },
            resultShape: { externalId: 'text', name: 'text' },
          },
        },
      },
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    team_drive: { adapter: 'dropbox' },
    acme_main: { adapter: 'attio' },
    'Dev-loop Granola': { adapter: 'attio' }, // spaced name, single adapter
    workspace: { adapters: ['dropbox', 'attio'] }, // one credential, two adapters
  },
});

// ── Fixtures ──

// The §G library: a node declaration + a movement constructing its own target.
const FILES_LIB = [
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

const FILES: Record<string, string> = { 'lib/file-routines': FILES_LIB };

const resolverOver =
  (files: Record<string, string>): ResolveFile =>
  path =>
    files[path] !== undefined ? { source: files[path] } : undefined;

const resolveFile = resolverOver(FILES);

const check = (source: string, resolve: ResolveFile = resolveFile): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog, { resolveFile: resolve }).filter(
    d => (d.severity ?? 'error') === 'error',
  );
const codes = (source: string, resolve: ResolveFile = resolveFile): string[] =>
  check(source, resolve).map(d => d.code);

function expectClean(source: string, resolve: ResolveFile = resolveFile): void {
  expect(check(source, resolve).map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

// The §G consumer: traversal block + call with a synthesised node argument.
const CONSUMER = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  'import { files_to_dropbox, Files } from "lib/file-routines"',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  '',
  'movement intake(msg: <inbox-[:message]->>) {',
  '  msg-[f:_resources]-> {',
  '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
  '  }',
  '}',
  '',
  'listen to inbox { key: "intake" } fire intake',
].join('\n');

// ── The linker (structure) ──

describe('linkImports', () => {
  it('resolves exports, keyed by local (aliased) name', () => {
    const link = linkImports(parseProgram(CONSUMER), resolveFile);
    expect(link.problems).toEqual([]);
    expect([...link.imports.keys()].sort()).toEqual(['Files', 'files_to_dropbox']);
    const movement = link.imports.get('files_to_dropbox');
    expect(movement?.kind).toBe('movement');
    expect(movement?.file.path).toBe('lib/file-routines');
    expect(link.files.get('lib/file-routines')?.program.statements.length).toBeGreaterThan(0);
  });

  it('links nested libraries transitively and shares diamonds', () => {
    const files = {
      ...FILES,
      'lib/outer': [
        'import { files_to_dropbox } from "lib/file-routines"',
        'import { Files } from "lib/file-routines"',
        '',
        'export movement relay(f: <Files>) {',
        '  files_to_dropbox(f: f)',
        '}',
      ].join('\n'),
    };
    const consumer = [
      'import { relay } from "lib/outer"',
      'import { Files } from "lib/file-routines"',
    ].join('\n');
    const link = linkImports(parseProgram(consumer), resolverOver(files));
    expect(link.problems).toEqual([]);
    const outer = link.files.get('lib/outer');
    expect(outer?.imports.get('files_to_dropbox')?.kind).toBe('movement');
    // Diamond: both routes land on the SAME LinkedFile object.
    expect(outer?.imports.get('Files')?.file).toBe(link.files.get('lib/file-routines'));
  });

  it('fileExports lists the export-prefixed movements and declarations', () => {
    const withUnexported = [
      FILES_LIB,
      '',
      'movement private_helper(f: <Files>) {',
      '  n = f.`name`',
      '}',
    ].join('\n');
    const exports = fileExports(parseProgram(withUnexported));
    expect(exports.map(e => `${e.kind}:${e.name}`)).toEqual([
      'shape:Files',
      'movement:files_to_dropbox',
    ]);
  });
});

// ── Clean resolution ──

describe('resolved imports', () => {
  it('§G consumer + library check clean', () => {
    expectClean(CONSUMER);
  });

  it('aliasing rebinds locally (import { files_to_dropbox as send })', () => {
    expectClean(
      CONSUMER.replace(
        'import { files_to_dropbox, Files } from "lib/file-routines"',
        'import { files_to_dropbox as send, Files } from "lib/file-routines"',
      ).replace('files_to_dropbox(f: node', 'send(f: node'),
    );
  });

  it('an imported declaration types the synthesised argument (missing entries flagged)', () => {
    const diagnostics = check(
      CONSUMER.replace('{ name: f.`filename`, data: f.`data` }', '{ nope: "x" }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.NODE_ARG_SHAPE]);
    expect(diagnostics[0].message).toContain('name');
  });

  it('call-fit types against the LIBRARY scope: arity + argument type', () => {
    // Two arguments to a one-param movement: arity, an unknown second
    // argument name, plus the first argument (the event) not fitting
    // Files.file.
    expect(codes(CONSUMER.replace('files_to_dropbox(f: node', 'files_to_dropbox(f: msg, x: node')))
      .toEqual([C.CALL_ARITY, C.CALL_ARG_UNKNOWN, C.CALL_ARG_TYPE]);
    // The event position is not a Files.file — graph identity crosses the
    // file boundary through the import's graphToken.
    expect(
      codes(
        CONSUMER.replace(
          'files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
          'files_to_dropbox(f: msg)',
        ),
      ),
    ).toEqual([C.CALL_ARG_TYPE]);
  });

  it('a node synthesised against the imported declaration fits the imported movement', () => {
    expectClean(
      [
        'import { email } from adapters',
        'import { dealflow_inbox } from credentials',
        'import { files_to_dropbox, Files } from "lib/file-routines"',
        '',
        'inbox = email(credentials: dealflow_inbox)',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  blob = msg-[:files]->.`data`',
        '  f = node { name: msg.`subject`, data: blob }',
        '  files_to_dropbox(f: f)',
        '}',
      ].join('\n'),
    );
  });

  it('listen can fire an imported movement (conformance mismatch still reported)', () => {
    const source = [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      'import { files_to_dropbox } from "lib/file-routines"',
      '',
      'inbox = email(credentials: dealflow_inbox)',
      '',
      'listen to inbox fire files_to_dropbox',
    ].join('\n');
    // files_to_dropbox requires <Files> (name + data fields); the email
    // message event position has neither — the conformance check flags it.
    expect(codes(source)).toContain(C.LISTEN_SHAPE_MISMATCH);
    expect(codes(source)).not.toContain(C.LISTEN_PARAM_MISMATCH);
  });
});

// ── Failure modes ──

describe('failure modes', () => {
  it('unresolved path → MOV_IMPORT_FILE_UNRESOLVED (names opaque, no cascade)', () => {
    const diagnostics = check(CONSUMER, () => undefined);
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_FILE_UNRESOLVED]);
    expect(diagnostics[0].message).toContain('"lib/file-routines"');
  });

  it('unknown export → MOV_IMPORT_NOT_EXPORTED naming the available exports', () => {
    const diagnostics = check(
      CONSUMER.replace('files_to_dropbox, Files', 'files_to_dropbox, Files, nope').replace(
        /$/,
        '',
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_NOT_EXPORTED]);
    expect(diagnostics[0].message).toBe(
      '"lib/file-routines" does not export \'nope\' — a file\'s exports are the declarations marked `export`: Files, files_to_dropbox',
    );
  });

  it('declared-but-unexported name → MOV_IMPORT_NOT_EXPORTED suggesting `export`', () => {
    const lib = FILES_LIB.replace(
      'export movement files_to_dropbox',
      'movement files_to_dropbox',
    );
    const diagnostics = check(CONSUMER, resolverOver({ 'lib/file-routines': lib }));
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_NOT_EXPORTED]);
    expect(diagnostics[0].message).toBe(
      '"lib/file-routines" does not export \'files_to_dropbox\' — "lib/file-routines" declares \'files_to_dropbox\' but doesn\'t export it; add `export` before its declaration',
    );
  });

  it('a file exporting nothing says so', () => {
    const lib = FILES_LIB.replace(/^export /gm, '');
    const diagnostics = check(
      'import { nope } from "lib/file-routines"',
      resolverOver({ 'lib/file-routines': lib }),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_NOT_EXPORTED]);
    expect(diagnostics[0].message).toBe(
      '"lib/file-routines" does not export \'nope\' — a file\'s exports are the declarations marked `export` (it exports none)',
    );
  });

  it('a library that does not parse → MOV_IMPORT_FILE_INVALID', () => {
    expect(
      codes(CONSUMER, resolverOver({ 'lib/file-routines': 'movement {{{{' })),
    ).toContain(C.IMPORT_FILE_INVALID);
  });

  it('a library parse error names its position once', () => {
    const message = check(CONSUMER, resolverOver({ 'lib/file-routines': 'movement {{{{' })).find(d => d.code === C.IMPORT_FILE_INVALID)?.message ?? '';
    expect(message.match(/\(line \d+/g)).toHaveLength(1);
  });

  it('a file with its own listeners is importable — export is the gate', () => {
    const automation = [
      'import { email } from adapters',
      'import { dealflow_inbox } from credentials',
      FILES_LIB,
      'inbox = email(credentials: dealflow_inbox)',
      'movement archive(msg: <inbox-[:message]->>) {',
      '  msg-[f:_resources]-> {',
      '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
      '  }',
      '}',
      'listen to inbox { key: "archive" } fire archive',
    ].join('\n');
    expectClean(CONSUMER, resolverOver({ 'lib/file-routines': automation }));
  });

  it('cycles → MOV_IMPORT_CYCLE naming the chain', () => {
    const files = {
      'lib/a': 'import { b_thing } from "lib/b"\nexport node AThing {\n  name: <text>\n}',
      'lib/b': 'import { AThing } from "lib/a"\nexport movement b_thing(x: <AThing>) {\n  y = x.`name`\n}',
    };
    const diagnostics = check('import { AThing } from "lib/a"', resolverOver(files));
    const cycle = diagnostics.find(d => d.code === C.IMPORT_CYCLE);
    expect(cycle?.message).toContain('lib/a → lib/b → lib/a');
  });

  it("library-internal errors surface prefixed with the import path, at the import site", () => {
    const broken = [
      'import { dropbox } from adapters',
      'import { team_drive } from credentials',
      '',
      'export movement send(f: <nowhere-[:file]->>) {',
      '  drive = dropbox(credentials: team_drive)',
      '  write drive-[:files]-> { name: oops }',
      '}',
    ].join('\n');
    const diagnostics = check(
      'import { send } from "lib/broken"',
      resolverOver({ 'lib/broken': broken }),
    );
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const d of diagnostics) {
      expect(d.message).toMatch(/^"lib\/broken" line \d+: /);
      expect(d.span.start.line).toBe(1); // the import statement's line
    }
    expect(diagnostics.map(d => d.code)).toContain(C.NAME_UNRESOLVED);
  });

  it('library errors surface once, not per import statement', () => {
    const diagnostics = check(
      [
        'import { send } from "lib/broken"',
        'import { send as send2 } from "lib/broken"',
      ].join('\n'),
      resolverOver({ 'lib/broken': 'export movement send(f: <nowhere-[:x]->>) {\n  y = f.`a`\n}' }),
    );
    expect(diagnostics.filter(d => d.code === C.NAME_UNRESOLVED)).toHaveLength(1);
  });
});

// ── checkProgramWithLink (the engine seam) ──

describe('checkProgramWithLink', () => {
  it('returns the resolved link alongside clean diagnostics', () => {
    const { diagnostics, link } = checkProgramWithLink(parseProgram(CONSUMER), catalog, {
      resolveFile,
    });
    expect(diagnostics.filter(d => (d.severity ?? 'error') === 'error')).toEqual([]);
    expect(link?.imports.get('files_to_dropbox')?.kind).toBe('movement');
  });

  it('returns no link without a resolver (M2 opaque behavior)', () => {
    const { diagnostics, link } = checkProgramWithLink(parseProgram(CONSUMER), catalog);
    expect(link).toBeUndefined();
    expect(diagnostics.map(d => d.code)).toContain(C.IMPORT_FILE_UNSUPPORTED);
  });
});

// ── Shape-field borrowing (same dotted paths as extract annotations) ──

describe('shape-field borrowed types', () => {
  const withShape = (fieldType: string, write: string) =>
    [
      'import { email, attio } from adapters',
      'import { dealflow_inbox, acme_main } from credentials',
      '',
      'inbox = email(credentials: dealflow_inbox)',
      'crm   = attio(credentials: acme_main)',
      '',
      'node Deal {',
      `  size: ${fieldType}`,
      '}',
      '',
      'movement takes_round(d: <Deal>) {',
      '}',
      '',
      'movement intake(msg: <inbox-[:message]->>) {',
      `  takes_round(d: node { size: ${write} })`,
      '}',
    ].join('\n');

  it('a borrowed field type constrains what fits the declaration', () => {
    // crm.company.size is a number — a text entry doesn't fit the parameter.
    expect(codes(withShape('<crm-[:company]->.size>', 'msg.`subject`'))).toEqual([
      C.NODE_ARG_SHAPE,
    ]);
    expect(codes(withShape('<crm-[:company]->.size>', '41 + 1'))).toEqual([]);
  });

  it('borrows resolve through writable roots (enums live on the write surface)', () => {
    // The borrowed field arrives as the WRITE surface's enum, which is what the
    // conformance message names — proof the borrow resolved there rather than
    // reporting an unknown field off the read surface.
    const diagnostics = check(withShape('<crm-[:company]->.funding_stage>', 'msg.`subject`'));
    expect(diagnostics.map(d => d.code)).toEqual([C.NODE_ARG_SHAPE]);
    expect(diagnostics[0].message).toContain('enum (Seed | Series A)');
  });

  it('bad borrowed paths report MOV_BORROW_* at the declared field', () => {
    const diagnostics = check(withShape('<crm-[:company]->.nope>', 'msg.`subject`'));
    expect(diagnostics.map(d => d.code)).toEqual([C.BORROW_UNKNOWN_FIELD]);
    expect(codes(withShape('<crm-[:nope]->.size>', 'msg.`subject`'))).toEqual([
      C.BORROW_UNKNOWN_ROOT,
    ]);
    expect(codes(withShape('<nope-[:company]->.size>', 'msg.`subject`'))).toEqual([
      C.BORROW_UNKNOWN_GRAPH,
    ]);
  });

  it('borrowed declared fields work inside imported libraries too', () => {
    const lib = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'export node Deal {',
      '  stage: <crm_for_types-[:company]->.funding_stage>',
      '}',
      '',
      'crm_for_types = attio(credentials: acme_main)',
      '',
      'movement log_deal(d: <Deal>) {',
      '  s = d.`stage`',
      '}',
    ].join('\n');
    // The declaration comes before the construction it borrows from —
    // resolution happens at the declaration's source position, so this is a
    // use-before-bind in the LIBRARY, surfaced prefixed.
    const diagnostics = check(
      'import { Deal } from "lib/deals"',
      resolverOver({ 'lib/deals': lib }),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.USE_BEFORE_BIND]);

    const ordered = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      '',
      'crm_for_types = attio(credentials: acme_main)',
      '',
      'export node Deal {',
      '  stage: <crm_for_types-[:company]->.funding_stage>',
      '}',
      '',
      'movement log_deal(d: <Deal>) {',
      '  s = d.`stage`',
      '}',
    ].join('\n');
    expectClean('import { Deal } from "lib/deals"', resolverOver({ 'lib/deals': ordered }));
  });
});

// ── Backtick credential args + multi-adapter credentials ──

describe('credential arg shapes', () => {
  it('resolves a backtick-quoted credential arg', () => {
    expectClean(
      [
        'import { `Dev-loop Granola` } from credentials',
        'import { attio } from adapters',
        'crm = attio(credentials: `Dev-loop Granola`)',
        'movement m(c: <crm-[:company]->>) {}',
      ].join('\n'),
    );
  });

  it('accepts a multi-adapter credential for any of its adapters', () => {
    expectClean(
      [
        'import { workspace } from credentials',
        'import { attio } from adapters',
        'crm = attio(credentials: workspace)',
        'movement m(c: <crm-[:company]->>) {}',
      ].join('\n'),
    );
  });

  it('rejects a credential whose adapter set excludes the construction adapter', () => {
    expect(
      codes(
        [
          'import { acme_main } from credentials', // attio-only
          'import { dropbox } from adapters',
          'd = dropbox(credentials: acme_main)',
          'movement m(f: <d-[:file]->>) {}',
        ].join('\n'),
      ),
    ).toContain(C.CRED_WRONG_ADAPTER);
  });
});

// A dash-slugged adapter (`native-valuations`) can only be NAMED backtick-quoted.
// The construction callee accepts a backtick name, so it's constructable
// directly — not only via an `as` alias.
describe('dash-slugged adapter construction (backtick callee)', () => {
  const dashCatalog = mockCatalog({
    adapters: {
      'native-valuations': {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: {
          positions: { entity: { properties: { name: 'text' }, edges: {} } },
          collections: { entities: { target: 'entity' } },
          writableRoots: {},
          eventPosition: 'entity',
        },
      },
    },
    credentials: { vals_cred: { adapter: 'native-valuations' } },
  });
  const dashCodes = (source: string): string[] =>
    checkProgram(parseProgram(source), dashCatalog)
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);

  it('constructs directly via the backtick callee with no diagnostics', () => {
    expect(
      dashCodes(
        [
          'import { `native-valuations` } from adapters',
          'import { vals_cred } from credentials',
          'vals = `native-valuations`(credentials: vals_cred)',
          'movement m(e: <vals-[:entity]->>) {}',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('still flags a missing credential on the backtick construction', () => {
    expect(
      dashCodes(
        [
          'import { `native-valuations` } from adapters',
          'vals = `native-valuations`()',
          'movement m(e: <vals-[:entity]->>) {}',
        ].join('\n'),
      ),
    ).toContain(C.CONSTRUCT_MISSING_CRED);
  });

  it('resolves a credential whose name carries @ . and an apostrophe', () => {
    const catalog = mockCatalog({
      adapters: {
        'native-valuations': {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          schema: {
            positions: { entity: { properties: { name: 'text' }, edges: {} } },
            collections: { entities: { target: 'entity' } },
            writableRoots: {},
          },
        },
      },
      credentials: { "Toni@acme.example's Listen-Fire Valuations": { adapter: 'native-valuations' } },
    });
    const diags = checkProgram(
      parseProgram(
        [
          'import { `native-valuations` } from adapters',
          "import { `Toni@acme.example's Listen-Fire Valuations` } from credentials",
          "vals = `native-valuations`(credentials: `Toni@acme.example's Listen-Fire Valuations`)",
          'movement m(e: <vals-[:entity]->>) {}',
        ].join('\n'),
      ),
      catalog,
    ).filter(d => (d.severity ?? 'error') === 'error');
    expect(diags).toEqual([]);
  });
});
