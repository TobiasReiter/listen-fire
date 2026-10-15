// The deploy check's sweep, over a fake movement store: which pins advance,
// which stay with their diagnostics stored and a Validation Issue emitted,
// which are refused (a preservation failure), and that a second run on the same
// release does nothing.

jest.mock('movement-engine/services/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));
jest.mock('../authoring', () => ({
  validateMovementForTeam: jest.fn(),
  assessMovementValidity: jest.fn(),
}));
jest.mock('../firing_context', () => ({ withTeamContext: jest.fn() }));
jest.mock('../store', () => ({
  advanceMovementLanguageVersion: jest.fn(),
  getMovementRow: jest.fn(),
  listAllMovementRows: jest.fn(),
  recordUpgradeCheck: jest.fn(),
  recordValidityOutcome: jest.fn(),
}));
jest.mock('../version_store', () => ({ movementSourceHash: () => 'hash' }));

import {
  CURRENT_LANGUAGE_VERSION,
  checkProgram,
  mockCatalog,
  parseProgram,
  type LanguageRelease,
  type LanguageVersion,
  type ResolveFile,
} from 'movement-lang';

import { assessMovementValidity, type AuthoringDiagnostic } from '../authoring';

import { getMovementRow, type MovementRow } from '../store';
import {
  runDeployCheck,
  upgradeMovement,
  type DeployCheckDeps,
  type DeployCheckSummary,
  type ValidateUnder,
} from '../language_upgrade';
import { DEPRECATED_VERSION, RELEASE_APPLIED, VALIDATION_ISSUE } from '../../adapters/system/types';

const RELEASE: LanguageRelease = {
  current: 2,
  supported: new Set([1, 2]),
  deprecated: new Set<LanguageVersion>(),
};

function movement(over: Partial<MovementRow> & { id: string }): MovementRow {
  return {
    teamId: 'team-1',
    name: over.id,
    source: `source of ${over.id}`,
    description: '',
    triggerId: null,
    currentVersionId: null,
    validityStatus: null,
    validityReason: null,
    validitySourceHash: null,
    validityCheckedAt: null,
    validityConsentedAt: null,
    validityCheckedAgainst: null,
    languageVersion: 1,
    upgradeDiagnostics: null,
    upgradeCheckedAgainst: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

function diagnostic(severity: AuthoringDiagnostic['severity'], message: string): AuthoringDiagnostic {
  return { code: 'X', message, severity, line: 3, col: 1, endLine: 3, endCol: 2, sourceLine: '' };
}

/** A warning the checker raised because the check is a move up: a construct
 *  whose meaning changed between the versions. */
function meaningChanged(message: string): AuthoringDiagnostic {
  return { ...diagnostic('warning', message), code: 'MOV_PLUGIN_OUTPUT_CHANGED', upgrade: true };
}

/** What each movement validates to, under each version. */
type Verdicts = Record<string, Partial<Record<LanguageVersion, AuthoringDiagnostic[]>>>;

/** An in-memory movement store behind the check's seams. */
function fakeStore(input: {
  movements: MovementRow[];
  verdicts: Verdicts;
  release?: LanguageRelease;
}) {
  const pins = new Map(input.movements.map((m) => [m.id, m.languageVersion]));
  const upgradeDiagnostics = new Map<string, AuthoringDiagnostic[]>();
  const validity = new Map<string, LanguageVersion>();
  const events: Array<{ teamId: string; kind: string; reason: string; version: string }> = [];
  const runs: Array<{ tag: string; languageRelease: string; summary: DeployCheckSummary }> = [];
  const validations: Array<Parameters<ValidateUnder>[0]> = [];

  const deps: DeployCheckDeps = {
    release: { tag: 'v0.8.0', language: input.release ?? RELEASE },
    alreadyRan: async ({ tag, languageRelease }) =>
      runs.some((r) => r.tag === tag && r.languageRelease === languageRelease),
    // Read the pins fresh, as the real store does.
    listMovements: async () =>
      input.movements.map((m) => ({ ...m, languageVersion: pins.get(m.id) ?? m.languageVersion })),
    sourceHash: (source) => `hash:${source}`,
    validate: async (validation) => {
      validations.push(validation);
      return {
        diagnostics: input.verdicts[validation.movement.id]?.[validation.languageVersion] ?? [],
        gaps: [],
      };
    },
    recordValidity: async ({ movement: m, checkedAgainst }) => {
      validity.set(m.id, checkedAgainst);
    },
    recordUpgradeCheck: async ({ movement: m, diagnostics }) => {
      upgradeDiagnostics.set(m.id, diagnostics);
    },
    advance: async ({ movement: m, to }) => {
      pins.set(m.id, to);
    },
    emit: async ({ teamId, kind, payload }) => {
      events.push({ teamId, kind: kind.typeId, reason: payload.reason, version: payload.version });
    },
    recordRun: async (run) => {
      runs.push(run);
    },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  };
  return { deps, pins, upgradeDiagnostics, validity, events, runs, validations };
}

describe('the deploy check', () => {
  it('advances a pin that validates cleanly under the current version', async () => {
    const store = fakeStore({ movements: [movement({ id: 'clean' })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('clean')).toBe(2);
    expect(store.validity.get('clean')).toBe(2);
    expect(summary?.automations).toEqual([
      expect.objectContaining({
        name: 'clean',
        outcome: 'advanced',
        from: { version: 1, name: 'Quiet Heron' },
        to: { version: 2, name: 'Bright Otter' },
      }),
    ]);
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.typeId]);
  });

  it('advances a pin whose only warning is a cost note, and prints the note', async () => {
    const note = {
      ...diagnostic('warning', "WHERE on 'Searches' runs here, not at the source"),
      code: 'MOV_HOP_WHERE_ENGINE',
    };
    const store = fakeStore({ movements: [movement({ id: 'noted' })], verdicts: { noted: { 2: [note] } } });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('noted')).toBe(2);
    expect(store.upgradeDiagnostics.get('noted')).toEqual([]);
    expect(store.events.map((e) => e.kind)).toEqual([RELEASE_APPLIED.typeId]);
    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({
        outcome: 'advanced',
        notes: "line 3: WHERE on 'Searches' runs here, not at the source",
      }),
    );
  });

  it('keeps the pin on a meaning-changed warning, stores it, and emits a Validation Issue', async () => {
    const warning = meaningChanged('extracted text is never null under this version');
    const note = diagnostic('warning', "ORDER BY on 'Messages' runs here");
    const store = fakeStore({
      movements: [movement({ id: 'warns' })],
      verdicts: { warns: { 2: [warning, note, diagnostic('info', 'just advice')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('warns')).toBe(1);
    // Only what blocks the move is stored — the cost note and the info say
    // nothing about it.
    expect(store.upgradeDiagnostics.get('warns')).toEqual([warning]);
    expect(summary?.automations[0]?.notes).toBe("line 3: ORDER BY on 'Messages' runs here");
    expect(summary?.counts).toEqual(
      expect.objectContaining({ advanced: 0, warned: 1, refused: 0 }),
    );
    const issue = store.events.find((e) => e.kind === VALIDATION_ISSUE.typeId);
    expect(issue).toEqual(
      expect.objectContaining({ version: 'Quiet Heron', teamId: 'team-1' }),
    );
    expect(issue?.reason).toContain('line 3: extracted text is never null under this version');
  });

  it('refuses a movement that fails under its own pin: logs, stores, never advances', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'broken' })],
      verdicts: { broken: { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('broken')).toBe(1);
    expect(store.validity.get('broken')).toBe(1);
    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({ outcome: 'refused', detail: 'line 3: unknown field' }),
    );
    expect(store.events.map((e) => e.kind)).toEqual([VALIDATION_ISSUE.typeId, RELEASE_APPLIED.typeId]);
  });

  it('says so when a refused movement was already failing under its pin before the release', async () => {
    const store = fakeStore({
      movements: [
        movement({
          id: 'was-broken',
          validityStatus: 'invalid',
          validityCheckedAgainst: 1,
          validitySourceHash: 'hash:source of was-broken',
        }),
      ],
      verdicts: { 'was-broken': { 1: [diagnostic('error', 'unknown field')] } },
    });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]).toEqual(
      expect.objectContaining({
        outcome: 'refused',
        detail: 'already failing before this release: line 3: unknown field',
      }),
    );
  });

  it('leaves a movement already on the current version alone', async () => {
    const store = fakeStore({ movements: [movement({ id: 'now', languageVersion: 2 })], verdicts: {} });

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations[0]?.outcome).toBe('current');
    expect(store.upgradeDiagnostics.has('now')).toBe(false);
  });

  it('does nothing the second time on the same release', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'clean' }), movement({ id: 'warns' })],
      verdicts: { warns: { 2: [meaningChanged('changed meaning')] } },
    });

    expect(await runDeployCheck(store.deps)).not.toBeNull();
    const eventsAfterFirst = store.events.length;

    expect(await runDeployCheck(store.deps)).toBeNull();
    expect(store.runs).toHaveLength(1);
    expect(store.events).toHaveLength(eventsAfterFirst);
  });

  it('emits one Release Applied per workspace, carrying the release and that workspace\'s counts', async () => {
    const store = fakeStore({
      movements: [
        movement({ id: 'a' }),
        movement({ id: 'b', teamId: 'team-2' }),
        movement({ id: 'c', teamId: 'team-2' }),
      ],
      verdicts: { c: { 2: [meaningChanged('changed meaning')] } },
    });

    await runDeployCheck(store.deps);

    const applied = store.events.filter((e) => e.kind === RELEASE_APPLIED.typeId);
    expect(applied.map((e) => e.teamId)).toEqual(['team-1', 'team-2']);
    expect(applied[1]?.reason).toContain('Release v0.8.0 applied');
    expect(applied[1]?.reason).toContain('Moved to "Bright Otter" (2): 1');
    expect(applied[1]?.reason).toContain('with warnings: 1');
  });

  it('tells a movement left on a deprecated version so', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'old' })],
      verdicts: { old: { 2: [diagnostic('error', 'retired spelling')] } },
      release: { current: 2, supported: new Set([1, 2]), deprecated: new Set([1]) },
    });

    const summary = await runDeployCheck(store.deps);

    expect(store.events.map((e) => e.kind)).toContain(DEPRECATED_VERSION.typeId);
    expect(summary?.automations[0]).toEqual(expect.objectContaining({ outcome: 'warned', deprecated: true }));
  });

  it('marks a movement it could not check unverified and carries on', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'flaky' }), movement({ id: 'clean' })],
      verdicts: {},
    });
    const validate = store.deps.validate;
    store.deps.validate = async (input) => {
      if (input.movement.id === 'flaky') throw new Error('catalog unreachable');
      return validate(input);
    };

    const summary = await runDeployCheck(store.deps);

    expect(summary?.automations.map((a) => [a.name, a.outcome])).toEqual([
      ['flaky', 'unverified'],
      ['clean', 'advanced'],
    ]);
    expect(store.pins.get('flaky')).toBe(1);
  });
});

describe('which checks are upgrade checks', () => {
  const told = (validations: Array<Parameters<ValidateUnder>[0]>) =>
    validations.map((v) => [v.movement.id, v.languageVersion, v.upgradingFrom]);

  it('the sweep tells the checker the pin when checking under the newer version, and only then', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'old' }), movement({ id: 'now', languageVersion: 2 })],
      verdicts: {},
    });

    await runDeployCheck(store.deps);

    expect(told(store.validations)).toEqual([
      ['old', 1, undefined],
      ['old', 2, 1],
      ['now', 2, undefined],
    ]);
  });

  it('an explicit upgrade tells the checker the pin it is moving from', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const validations: Array<Parameters<ValidateUnder>[0]> = [];

    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: false,
      validate: async (validation) => {
        validations.push(validation);
        return { diagnostics: [], gaps: [] };
      },
    });

    expect(result.status).toBe('needs_acknowledgement');
    expect(told(validations)).toEqual([['old', CURRENT_LANGUAGE_VERSION, 1]]);
  });
});

describe('an explicit upgrade: errors block, meaning-changed warnings are acknowledged', () => {
  const upgradeWith = async (diagnostics: AuthoringDiagnostic[]) => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    return upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: false,
      validate: async () => ({ diagnostics, gaps: [] }),
    });
  };

  it('a cost note alone is clean', async () => {
    const result = await upgradeWith([diagnostic('warning', "ORDER BY on 'Messages' runs here")]);
    expect(result).toEqual(expect.objectContaining({ status: 'needs_acknowledgement', diagnostics: [] }));
  });

  it('a meaning-changed warning is listed and awaits acknowledgement', async () => {
    const warning = meaningChanged('changed meaning');
    const result = await upgradeWith([warning, diagnostic('warning', 'a cost note')]);
    expect(result).toEqual(
      expect.objectContaining({ status: 'needs_acknowledgement', diagnostics: [warning] }),
    );
  });

  it('a meaning-changed warning moves up once acknowledged', async () => {
    jest.mocked(assessMovementValidity).mockReturnValueOnce({ status: 'valid', reason: null } as never);
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: async () => ({ diagnostics: [meaningChanged('changed meaning')], gaps: [] }),
    });
    expect(result.status).toBe('upgraded');
  });

  it('an error blocks even when acknowledged', async () => {
    jest.mocked(getMovementRow).mockResolvedValueOnce(movement({ id: 'old' }));
    const error = diagnostic('error', 'refused');
    const result = await upgradeMovement({
      teamId: 'team-1',
      id: 'old',
      acknowledge: true,
      validate: async () => ({ diagnostics: [error, meaningChanged('changed meaning')], gaps: [] }),
    });
    expect(result.status).toBe('blocked');
  });
});

describe('a meaning-changed construct inside an imported library', () => {
  // The real checker behind the validation seam: the movement is clean itself,
  // and only the library it imports uses a plugin whose output changed at 2.
  const catalog = mockCatalog({
    adapters: {
      slack: {
        constructionArgs: [],
        schema: {
          positions: {
            channel: { properties: { Name: 'text' }, edges: {} },
            note: { properties: { Body: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
          writableRoots: {
            note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
          },
        },
      },
    },
    plugins: {
      scan_web: {
        args: ['url'],
        priced: false,
        effects: { reads: ['the web'], ai: true },
        output: { kind: 'records', fields: { url: 'text', text: 'text' } },
        earlierOutputs: [{ before: 2, output: { kind: 'value', type: 'text' } }],
      },
    },
  });
  const LIBRARY = [
    'import { slack } from adapters',
    'import { scan_web } from plugins',
    'chat = slack()',
    'export movement scan_channel(c: <chat-[:channel]->>) {',
    '  pages = scan_web(url: c.`Name`)',
    '  first = FIRST(pages)',
    '  write chat-[:note]-> { Body: first.text }',
    '}',
  ].join('\n');
  const resolveFile: ResolveFile = (path) => (path === 'lib/scan' ? { source: LIBRARY } : undefined);

  const checkWithLibrary: ValidateUnder = async ({ movement: m, languageVersion, upgradingFrom }) => ({
    diagnostics: checkProgram(parseProgram(m.source, { languageVersion }), catalog, {
      languageVersion,
      resolveFile,
      ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
    }).map((d) => ({
      code: d.code,
      message: d.message,
      severity: d.severity ?? 'error',
      ...(d.upgrade === true ? { upgrade: true as const } : {}),
      line: d.span.start.line,
      col: d.span.start.col,
      endLine: d.span.end.line,
      endCol: d.span.end.col,
      sourceLine: '',
    })),
    gaps: [],
  });

  it('keeps the importer on its pin and stores the warning', async () => {
    const store = fakeStore({
      movements: [movement({ id: 'importer', source: 'import { scan_channel } from "lib/scan"\n' })],
      verdicts: {},
    });
    store.deps.validate = checkWithLibrary;

    const summary = await runDeployCheck(store.deps);

    expect(store.pins.get('importer')).toBe(1);
    expect(summary?.automations[0]?.outcome).toBe('warned');
    expect(store.upgradeDiagnostics.get('importer')).toEqual([
      expect.objectContaining({
        code: 'MOV_PLUGIN_OUTPUT_CHANGED',
        severity: 'warning',
        upgrade: true,
        message: expect.stringContaining('"lib/scan" line'),
      }),
    ]);
  });
});
