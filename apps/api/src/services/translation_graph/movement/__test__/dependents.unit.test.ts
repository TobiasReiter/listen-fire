// File facets + dependents + dependent revalidation (files.ts):
//
//   1. FACETS — a file's kind is text-derived: listen/run ⇒ automation;
//      importable exports (file-level shapes + movements no invoker
//      consumes) ⇒ library; a file can be both; mid-edit text that doesn't
//      parse falls back to a line-level scan.
//   2. DEPENDENTS — direct importers found by scanning team sources'
//      import statements (paths resolve by row name; self excluded), plus
//      the whole-team usage index the list page reads.
//   3. REVALIDATION — after a clean save of an imported file, every direct
//      importer is re-checked through an injected validator; the result is
//      report-only (no stored status is ever touched here — there is no DB
//      write path in these helpers at all).

jest.mock('../../../../lib/kysely', () => {
  function mockChainable(): object {
    const handler: ProxyHandler<object> = {
      get(_target: object, prop: string | symbol): unknown {
        if (prop === 'execute') return async () => [];
        if (prop === 'executeTakeFirst') return async () => null;
        if (prop === 'then') return undefined;
        return () => mockChainable();
      },
    };
    return new Proxy({}, handler);
  }
  return {
    getKnowledgeQb: jest.fn(() => mockChainable()),
    getAutomationsQb: jest.fn(() => mockChainable()),
    getQb: jest.fn(() => mockChainable()),
    getCoreQb: jest.fn(() => mockChainable()),
  };
});

import type { MovementValidityStatus } from '../store';

import {
  checkMovementDependentsOf,
  movementDependentsOf,
  movementFileFacets,
  movementUsageIndex,
  type ValidateMovementSource,
} from '../files';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AUTOMATION = [
  'import { email } from adapters',
  'import { dealflow_inbox } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  '',
  'movement intake(msg: inbox.message) {',
  '  subject = msg.`subject`',
  '}',
  '',
  'listen to inbox { key: "intake" } fire intake',
].join('\n');

const LIBRARY = [
  'export node Files {',
  '  name: text',
  '  data: text',
  '}',
  '',
  'export movement files_to_dropbox(f: Files.file) {',
  '  n = f.`name`',
  '}',
].join('\n');

const HYBRID = [
  'import { email } from adapters',
  'inbox = email()',
  '',
  'export node Contact {',
  '  name: text',
  '}',
  '',
  'movement intake(msg: inbox.message) {',
  '  s = msg.`subject`',
  '}',
  '',
  'export movement tidy_contact(p: Contact.person) {',
  '  n = p.`name`',
  '}',
  '',
  'listen to inbox fire intake',
].join('\n');

const CONSUMER = [
  'import { email } from adapters',
  'import { files_to_dropbox, Files } from "lib/file-routines"',
  '',
  'inbox = email()',
  '',
  'movement intake(msg: inbox.message) {',
  '  files_to_dropbox(f: node { name: msg.`subject`, data: msg.`text` })',
  '}',
  '',
  'listen to inbox fire intake',
].join('\n');

function row(input: {
  id: string;
  name: string;
  source: string;
  validityStatus?: MovementValidityStatus | null;
}) {
  return { validityStatus: 'valid' as MovementValidityStatus, ...input };
}

// ── 1. Facets ────────────────────────────────────────────────────────────────

describe('movementFileFacets', () => {
  it('a listen-fired file with no spare exports is automation only', () => {
    expect(movementFileFacets(AUTOMATION)).toEqual({
      listenerCount: 1,
      runnableOnDemand: false,
      isAutomation: true,
      exportedMovementCount: 0,
      exportedShapeCount: 0,
      isLibrary: false,
    });
  });

  it('an invoker-less file of movements + shapes is library only', () => {
    expect(movementFileFacets(LIBRARY)).toEqual({
      listenerCount: 0,
      runnableOnDemand: false,
      isAutomation: false,
      exportedMovementCount: 1,
      exportedShapeCount: 1,
      isLibrary: true,
    });
  });

  it('a file with a listener AND spare helpers shows both facets', () => {
    const facets = movementFileFacets(HYBRID);
    expect(facets.isAutomation).toBe(true);
    expect(facets.isLibrary).toBe(true);
    expect(facets.listenerCount).toBe(1);
    // `intake` is consumed by the listen and unexported; the explicit
    // `export movement tidy_contact` + `export node Contact` are importable.
    expect(facets.exportedMovementCount).toBe(1);
    expect(facets.exportedShapeCount).toBe(1);
  });

  it('a manual listener makes the file runnable on demand and consumes its target', () => {
    const source = [
      'import { manual, attio } from adapters',
      'runs = manual()',
      'crm = attio()',
      '',
      'movement backfill(go: <runs-[:Invocation]->>) {',
      '  x = 1',
      '}',
      '',
      'listen to runs {} fire backfill',
    ].join('\n');
    const facets = movementFileFacets(source);
    expect(facets).toMatchObject({
      runnableOnDemand: true,
      isAutomation: true,
      exportedMovementCount: 0,
      isLibrary: false,
    });
  });

  it('a differently-named manual channel counts too', () => {
    const source = [
      'import { manual } from adapters',
      'go = manual()',
      '',
      'movement backfill(g: <go-[:Invocation]->>) {',
      '  x = 1',
      '}',
      '',
      'listen to go {} fire backfill',
    ].join('\n');
    expect(movementFileFacets(source).runnableOnDemand).toBe(true);
  });

  it('text that does not parse falls back to a line-level scan', () => {
    const midEdit = [
      'import { email } from adapters',
      'inbox = email(',
      '',
      'export node Contact {',
      '  name: text',
      '}',
      '',
      'movement intake(msg: inbox.message) {',
      '}',
      '',
      'listen to inbox fire intake',
    ].join('\n');
    const facets = movementFileFacets(midEdit);
    expect(facets.isAutomation).toBe(true);
    expect(facets.listenerCount).toBe(1);
    expect(facets.exportedShapeCount).toBe(1);
    expect(facets.exportedMovementCount).toBe(0); // intake is fired
  });

  it('empty text has neither facet', () => {
    expect(movementFileFacets('')).toEqual({
      listenerCount: 0,
      runnableOnDemand: false,
      isAutomation: false,
      exportedMovementCount: 0,
      exportedShapeCount: 0,
      isLibrary: false,
    });
  });
});

// ── 2. Dependents ────────────────────────────────────────────────────────────

describe('movementDependentsOf', () => {
  const rows = [
    row({ id: 'm1', name: 'lib/file-routines', source: LIBRARY }),
    row({ id: 'm2', name: 'intake-pipeline', source: CONSUMER }),
    row({ id: 'm3', name: 'unrelated', source: AUTOMATION, validityStatus: null }),
  ];

  it('finds the direct importers of a file, by name', () => {
    expect(movementDependentsOf(rows, 'lib/file-routines')).toEqual([
      { id: 'm2', name: 'intake-pipeline', validityStatus: 'valid' },
    ]);
  });

  it('a file nothing imports has no dependents', () => {
    expect(movementDependentsOf(rows, 'unrelated')).toEqual([]);
  });

  it('never reports a file as its own dependent', () => {
    const selfNamed = [
      row({ id: 'm9', name: 'lib/x', source: 'import { a } from "lib/x"' }),
    ];
    expect(movementDependentsOf(selfNamed, 'lib/x')).toEqual([]);
  });

  it('still detects imports while the importer is mid-edit (lexical fallback)', () => {
    const broken = row({
      id: 'm4',
      name: 'half-written',
      validityStatus: null,
      source: 'import { Files } from "lib/file-routines"\nmovement x(',
    });
    expect(movementDependentsOf([...rows, broken], 'lib/file-routines')).toEqual([
      { id: 'm2', name: 'intake-pipeline', validityStatus: 'valid' },
      { id: 'm4', name: 'half-written', validityStatus: null },
    ]);
  });
});

describe('movementUsageIndex', () => {
  it('maps each file name to its importers in one pass', () => {
    const rows = [
      row({ id: 'm1', name: 'lib/file-routines', source: LIBRARY }),
      row({ id: 'm2', name: 'intake-pipeline', source: CONSUMER }),
      row({
        id: 'm3',
        name: 'second-consumer',
        source: 'import { Files } from "lib/file-routines"',
      }),
    ];
    const index = movementUsageIndex(rows);
    expect(index.get('lib/file-routines')?.map((d) => d.id)).toEqual(['m2', 'm3']);
    expect(index.get('intake-pipeline')).toBeUndefined();
  });
});

// ── 3. Revalidation ──────────────────────────────────────────────────────────

describe('checkMovementDependentsOf', () => {
  const rows = [
    row({ id: 'm1', name: 'lib/file-routines', source: LIBRARY }),
    row({ id: 'm2', name: 'intake-pipeline', source: CONSUMER }),
    row({
      id: 'm3',
      name: 'second-consumer',
      source: 'import { Files } from "lib/file-routines"',
    }),
    row({ id: 'm4', name: 'unrelated', source: AUTOMATION }),
  ];

  it('re-checks every direct importer through the injected validator and reports verdicts', async () => {
    const validated: string[] = [];
    const validate: ValidateMovementSource = async ({ source }) => {
      validated.push(source);
      const broken = source.includes('files_to_dropbox');
      return {
        ok: !broken,
        diagnostics: broken
          ? [{ severity: 'error' as const }, { severity: 'error' as const }, { severity: 'info' as const }]
          : [],
      };
    };
    const results = await checkMovementDependentsOf({
      teamId: 'team-1',
      rows,
      name: 'lib/file-routines',
      validate,
    });
    expect(results).toEqual([
      { id: 'm2', name: 'intake-pipeline', ok: false, problemCount: 2 },
      { id: 'm3', name: 'second-consumer', ok: true, problemCount: 0 },
    ]);
    // Only the importers were validated — never the saved file itself or
    // unrelated files.
    expect(validated).toHaveLength(2);
  });

  it('reports nothing for a file no one imports (the common save path)', async () => {
    const validate: ValidateMovementSource = async () => {
      throw new Error('must not validate when there are no dependents');
    };
    await expect(
      checkMovementDependentsOf({ teamId: 'team-1', rows, name: 'unrelated', validate }),
    ).resolves.toEqual([]);
  });
});
