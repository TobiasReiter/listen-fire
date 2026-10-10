// Every break since language version 1 ("Quiet Heron", the language as of
// v0.6.0), both sides of its conditional: version 1 keeps v0.6.0's behaviour,
// version 2 has the new one, and a check for the move from 1 to 2 warns where
// version 2 would otherwise accept a program in silence while meaning
// something else. Version 1's full definition is its own corpus
// (`__conformance__/v1`); this file pins each conditional by name.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C, type CheckOptions, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema, type PluginSpec } from '../catalog';
import type { ResolveFile } from '../link';
import { changedBetween, type LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: { Name: 'text' },
      edges: {
        Members: { target: 'person', readable: true },
        Owners: { target: 'person', readable: true, writable: true },
      },
    },
    person: { properties: { Name: 'text', Age: 'number', Email: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: {
      fields: { Body: 'text', Count: 'number' },
      resultShape: { Body: 'text' },
      edges: {},
    },
  },
};

/** A plugin whose output changed at version 2, as `vc_url_retrieval`'s did:
 *  one text before, a list of records since. */
const scanWeb: PluginSpec = {
  args: ['url'],
  effects: { reads: ['the web'], ai: true },
  output: {
    kind: 'records',
    fields: { url: 'text', text: { kind: 'maybeAbsent', of: 'text' } },
  },
  earlierOutputs: [
    { before: 2, output: { kind: 'value', type: { kind: 'maybeAbsent', of: 'text' } } },
  ],
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema } },
  plugins: { scan_web: scanWeb },
});

const PRELUDE = `import { slack } from adapters
import { scan_web } from plugins
chat = slack()
`;

const V1: CheckOptions = { languageVersion: 1 };
const V2: CheckOptions = { languageVersion: 2 };
const MOVING_UP: CheckOptions = { languageVersion: 2, upgradingFrom: 1 };

function all(body: string, options: CheckOptions, fileLevel = ''): Diagnostic[] {
  const source = `${PRELUDE}${fileLevel}
movement scan(c: <chat-[:channel]->>) {
${body}
}`;
  const languageVersion: LanguageVersion = options.languageVersion ?? 2;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, options);
}
const errors = (body: string, options: CheckOptions, fileLevel?: string): string[] =>
  all(body, options, fileLevel)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
const ofSeverity = (severity: 'info' | 'warning', body: string, options: CheckOptions): string[] =>
  all(body, options)
    .filter((d) => d.severity === severity)
    .map((d) => d.code);

const EXTRACT = [
  '  r = extract from [c.`Name`] {',
  '    title: <text> "the title"',
  '    note: "a note"',
  '  }',
  '',
].join('\n');

describe('changedBetween', () => {
  it('holds when the move crosses the version that made the change', () => {
    expect(changedBetween(1, 2, 2)).toBe(true);
    expect(changedBetween(1, 3, 2)).toBe(true);
    expect(changedBetween(2, 3, 2)).toBe(false);
    expect(changedBetween(1, 1, 2)).toBe(false);
  });
});

describe('extracted text', () => {
  it('a null test on it is meaningful under 1 and refused under 2', () => {
    const body = `${EXTRACT}  if EXISTS(r.note) { write chat-[:note]-> { Body: "y" } }`;
    expect(errors(body, V1)).toEqual([]);
    expect(errors(body, V2)).toEqual(['MOV_PRESENCE_TEST_ON_TEXT']);
  });

  it('an annotated <text> read may be absent under 1 and is present under 2', () => {
    const body = `${EXTRACT}  write chat-[:note]-> { Body: r.title }`;
    expect(errors(body, V1)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(errors(body, V2)).toEqual([]);
  });

  it('`<text | null>` is no break: under both, a read may be absent and a null test is meaningful', () => {
    const nullable = EXTRACT.replace('title: <text> "the title"', 'title: <text | null> "the title"');
    for (const version of [V1, V2]) {
      expect(errors(`${nullable}  write chat-[:note]-> { Body: r.title }`, version)).toEqual(['MOV_ABSENT_REQUIRED']);
      expect(errors(`${nullable}  if EXISTS(r.title) { write chat-[:note]-> { Body: r.title } }`, version)).toEqual([]);
    }
  });

  it('an unannotated field into a number is a suggestion under 1 and refused under 2', () => {
    const body = `${EXTRACT}  write chat-[:note]-> { Body: "x", Count: r.note }`;
    expect(errors(body, V1)).toEqual([]);
    expect(ofSeverity('info', body, V1)).toContain('MOV_EXTRACT_ANNOTATE');
    expect(errors(body, V2)).toEqual(['MOV_EXTRACT_NEEDS_ANNOTATION']);
  });
});

describe('a dict literal', () => {
  it('is typed by its values under 1 (any key may miss) and by its keys under 2', () => {
    const lookup = '  d = { one: "a" }\n  write chat-[:note]-> { Body ?: AT(d, "nope") }';
    expect(errors(lookup, V1)).toEqual([]);
    expect(errors(lookup, V2)).toEqual(['MOV_DICT_UNKNOWN_KEY']);
    const plain = '  d = { one: "a" }\n  write chat-[:note]-> { Body: AT(d, "one") }';
    expect(errors(plain, V1)).toEqual(['MOV_ABSENT_REQUIRED']);
    expect(errors(plain, V2)).toEqual([]);
  });
});

describe("a declared node's field type", () => {
  it('an unknown name reads as text under 1 and is refused under 2', () => {
    const declaration = 'node Entry {\n  thesis: <Thesiss>\n}\n';
    expect(errors('  x = 1', V1, declaration)).toEqual([]);
    expect(errors('  x = 1', V2, declaration)).toEqual([C.UNKNOWN_TYPE_NAME]);
  });
});

describe('a plugin whose output changed shape', () => {
  const body = '  pages = scan_web(url: c.`Name`)\n  write chat-[:note]-> { Body ?: pages }';

  it('is typed by the shape the pin gets', () => {
    expect(errors(body, V1)).toEqual([]);
    expect(errors(body, V2).length).toBeGreaterThan(0);
    const records = '  pages = scan_web(url: c.`Name`)\n  first = FIRST(pages)\n  write chat-[:note]-> { Body ?: first.text }';
    expect(errors(records, V2)).toEqual([]);
  });

  it('warns on a check for the move up, and only then', () => {
    const records = '  pages = scan_web(url: c.`Name`)\n  first = FIRST(pages)\n  write chat-[:note]-> { Body ?: first.text }';
    expect(ofSeverity('warning', records, MOVING_UP)).toContain(C.PLUGIN_OUTPUT_CHANGED);
    expect(ofSeverity('warning', records, V2)).not.toContain(C.PLUGIN_OUTPUT_CHANGED);
    const message = all(records, MOVING_UP).find((d) => d.code === C.PLUGIN_OUTPUT_CHANGED)?.message;
    expect(message).toContain('"Bright Otter" (2)');
    expect(message).toContain('a list of records');
  });

  it('tags the warning as an upgrade diagnostic — what holds a pin, unlike an ordinary warning', () => {
    const records = '  pages = scan_web(url: c.`Name`)\n  first = FIRST(pages)\n  write chat-[:note]-> { Body ?: first.text }';
    const changed = all(records, MOVING_UP).find((d) => d.code === C.PLUGIN_OUTPUT_CHANGED);
    expect(changed?.upgrade).toBe(true);
    expect(all(records, V2).filter((d) => d.upgrade === true)).toEqual([]);
  });
});

describe('an identity key that may be ""', () => {
  const keyed = (value: string): string =>
    `${EXTRACT}  write chat-[:note]-> { unique by (\`Body\`) Body: ${value} }`;

  it('warns on a check for the move up across 2, where "" stopped matching ""', () => {
    expect(ofSeverity('warning', keyed('c.`Name`'), MOVING_UP)).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    expect(all(keyed('c.`Name`'), MOVING_UP).find((d) => d.code === C.UNIQUE_KEY_MAY_BE_BLANK)?.upgrade).toBe(true);
  });

  it('says nothing on an ordinary check', () => {
    expect(ofSeverity('warning', keyed('c.`Name`'), V2)).toEqual([]);
    expect(ofSeverity('warning', keyed('c.`Name`'), V1)).toEqual([]);
  });

  it('says nothing where the value cannot be "" or was no key under 1 either', () => {
    // A non-empty literal is never blank.
    expect(ofSeverity('warning', keyed('"Acme"'), MOVING_UP)).toEqual([]);
    // An extracted text nobody found was absent under 1 and "" under 2: no key both ways.
    expect(ofSeverity('warning', keyed('r.note'), MOVING_UP)).toEqual([]);
  });
});

describe('an identity key a guard proved not ""', () => {
  const guarded = (condition: string): string =>
    `  if ${condition} {\n    write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }\n  }`;
  const warnings = (body: string): string[] => ofSeverity('warning', body, MOVING_UP);

  it('clears the warning inside an arm whose condition proves it', () => {
    expect(warnings(guarded('c.`Name` != ""'))).toEqual([]);
    expect(warnings(guarded('"" != c.`Name`'))).toEqual([]);
    expect(warnings(guarded('LENGTH(c.`Name`) > 0'))).toEqual([]);
    expect(warnings(guarded('0 < LENGTH(c.`Name`)'))).toEqual([]);
    expect(warnings(guarded('NOT c.`Name` == ""'))).toEqual([]);
    expect(warnings(guarded('c.`Name` == "Acme"'))).toEqual([]);
    expect(warnings(guarded('c.`Name` != "" AND LENGTH(c.`Name`) < 80'))).toEqual([]);
  });

  it('clears it below an early exit on the blank value', () => {
    const body = (condition: string): string =>
      `  if ${condition} { ERROR("no name") }\n  write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }`;
    expect(warnings(body('c.`Name` == ""'))).toEqual([]);
    expect(warnings(body('LENGTH(c.`Name`) == 0'))).toEqual([]);
    expect(warnings(body('c.`Name` == "" OR c.`Name` == null'))).toEqual([]);
  });

  it('clears it for a bound value, not only a field read', () => {
    const body = '  name = c.`Name`\n  if name != "" {\n    write chat-[:note]-> { unique by (`Body`) Body: name }\n  }';
    expect(warnings(body)).toEqual([]);
  });

  it('still warns where nothing proved it', () => {
    // No guard at all.
    expect(warnings(`  write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }`)).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    // A disjunction proves neither side.
    expect(warnings(guarded('c.`Name` != "" OR c.`Age` > 3'))).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    // A negated proof proves the opposite.
    expect(warnings(guarded('NOT c.`Name` != ""'))).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    // A guard on a different read.
    expect(
      warnings(`  n = c.\`Name\`\n  if n != "" {\n    write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }\n  }`),
    ).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    // An early exit that does not always exit.
    expect(
      warnings(`  if c.\`Name\` == "" { write chat-[:note]-> { Body: "x" } }\n  write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }`),
    ).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
  });

  it('only inside the arm — the continuation of a plain if is unguarded', () => {
    const body = `${guarded('c.`Name` != ""')}\n  write chat-[:note]-> { unique by (\`Body\`) Body: c.\`Name\` }`;
    expect(warnings(body)).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
  });

  // The shape the deploy check flagged on a live movement: the suggested guard
  // must be the one that clears the warning.
  it('clears the link body the diagnostic itself suggested guarding', () => {
    const roster = [
      '  roster = node { members: [node { name: "Ada", email: "ada@example.com" }, node { name: "Bo", email: "bo@example.com" }] }',
      '  d = node { owners: ["Ada"] }',
      '  roster-[m:members]-> {',
    ];
    const guardedLink = [
      ...roster,
      '    if d.owners CONTAINS m.name AND m.email != "" {',
      '      link c -[:`Owners`]-> { Email: m.email }',
      '    }',
      '  }',
    ].join('\n');
    const unguardedLink = [
      ...roster,
      '    if d.owners CONTAINS m.name {',
      '      link c -[:`Owners`]-> { Email: m.email }',
      '    }',
      '  }',
    ].join('\n');
    expect(errors(guardedLink, MOVING_UP)).toEqual([]);
    expect(warnings(unguardedLink)).toEqual([C.UNIQUE_KEY_MAY_BE_BLANK]);
    expect(warnings(guardedLink)).toEqual([]);
  });
});

describe('a meaning-changed construct inside an imported library', () => {
  const LIBRARY = `${PRELUDE}
export movement scan_channel(c: <chat-[:channel]->>) {
  pages = scan_web(url: c.\`Name\`)
  first = FIRST(pages)
  write chat-[:note]-> { Body ?: first.text }
}`;
  const resolveFile: ResolveFile = (path) => (path === 'lib/scan' ? { source: LIBRARY } : undefined);
  const importer = 'import { scan_channel } from "lib/scan"\n';
  const check = (options: CheckOptions): Diagnostic[] =>
    checkProgram(
      parseProgram(importer, { languageVersion: options.languageVersion ?? 2 }),
      catalog,
      { ...options, resolveFile },
    );

  it("surfaces as the importer's warning on a check for the move up", () => {
    const surfaced = check(MOVING_UP).filter((d) => d.code === C.PLUGIN_OUTPUT_CHANGED);
    expect(surfaced).toEqual([
      expect.objectContaining({
        severity: 'warning',
        upgrade: true,
        message: expect.stringContaining('"lib/scan" line'),
      }),
    ]);
  });

  it('says nothing about the move on an ordinary check', () => {
    expect(check(V2).map((d) => d.code)).not.toContain(C.PLUGIN_OUTPUT_CHANGED);
    expect(check(V2).filter((d) => (d.severity ?? 'error') === 'error')).toEqual([]);
  });
});
