// Checker tests (M2 first half): the §I worked examples (plus §E/§F/§G
// programs) check clean against a mock catalog, and every diagnostic code
// has a focused negative fixture.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { mockCatalog } from '../catalog';

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], triggerConfig: ['key'] },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }, { name: 'list', kind: 'position', required: false }]},
    slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
    affinity: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
    dropbox: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
    cron: {
      constructionArgs: [{ name: 'credentials', kind: 'position', required: false }],
      triggerConfig: ['schedule', 'timezone'],
      triggerConfigRequired: ['schedule'],
      triggerConfigFormats: { schedule: 'cron', timezone: 'timezone' },
      schema: {
        positions: { tick: { properties: { firedAt: 'text', schedule: 'text' }, edges: {} } },
        collections: {},
        writableRoots: {},
      },
    },
    // A container-shaped adapter whose required listen keys are address hops,
    // the leading one supplied by an entry-position construction arg of the
    // same name. Deliberately NOT any real adapter's shape.
    pantry: {
      constructionArgs: [
        { name: 'credentials', kind: 'credential', required: true },
        { name: 'shelf', kind: 'position', required: false },
      ],
      triggerConfig: ['shelf', 'crate', 'events'],
      triggerConfigRequired: ['shelf', 'crate'],
    },
    // A listen key that takes a list of the source system's own names — the
    // `'strings'` format. Deliberately NOT any real adapter's shape.
    postbox: {
      constructionArgs: [{ name: 'credentials', kind: 'position', required: false }],
      triggerConfig: ['slots'],
      triggerConfigFormats: { slots: 'strings' },
      schema: {
        positions: { letter: { properties: { sender: 'text' }, edges: {} } },
        collections: {},
        writableRoots: {},
      },
    },
    manual: {
      constructionArgs: [{ name: 'credentials', kind: 'position', required: false }],
      schema: {
        positions: {
          invocation: {
            properties: { firedAt: 'text', actorEmail: 'text', actorName: 'text' },
            edges: {},
          },
        },
        collections: {},
        writableRoots: {},
      },
    },
    // The knowledge graph is an ordinary adapter: imported, then constructed
    // against a connection like any other.
    kg: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }] },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    acme_workspace: { adapter: 'slack' },
    acme_affinity: { adapter: 'affinity' },
    team_drive: { adapter: 'dropbox' },
    pantry_main: { adapter: 'pantry' },
    native_knowledge: { adapter: 'kg' },
  },
  plugins: {
    scrub_sensitive: { args: [] },
    vc_url_retrieval: { args: ['urls'] },
    // Mirrors the real `fetch-url` signature (apps/api's
    // engine/transforms/fetch-url.ts): `url` required, `email`/`password`
    // optional gate credentials — the shape MOV_THROUGH_ARG_MISSING exists for.
    fetch_url: { args: ['url', 'email', 'password'], requiredArgs: ['url'] },
  },
});

// Every severity, info included — the MOV_LISTEN_MISSING suite reads this.
const checkAll = (source: string): Diagnostic[] => checkProgram(parseProgram(source), catalog);
// Error-severity diagnostics only: most fixtures declare a dispatchable
// movement without a listen, which legitimately carries an info diagnostic.
const check = (source: string): Diagnostic[] =>
  checkAll(source).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => check(source).map(d => d.code);

function expectClean(source: string): void {
  const diagnostics = check(source);
  expect(diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

const PRELUDE = [
  'import { email, attio, slack, kg } from adapters',
  'import { dealflow_inbox, acme_main, acme_workspace, native_knowledge } from credentials',
  'import { scrub_sensitive, vc_url_retrieval, fetch_url } from plugins',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
  'graph = kg(credentials: native_knowledge)',
].join('\n');

const inMovement = (body: string) =>
  `${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n${body}\n}`;

// ── Positive: the worked examples check clean ──

describe('worked examples (zero diagnostics)', () => {
  it('§I dealflow_intake', () => {
    expectClean(
      [
        'import { email, attio, slack, affinity } from adapters',
        'import { dealflow_inbox, acme_main, acme_workspace, acme_affinity } from credentials',
        '',
        'inbox = email(credentials: dealflow_inbox)',
        'crm   = attio(credentials: acme_main)',
        'team  = slack(credentials: acme_workspace)',
        'aff   = affinity(credentials: acme_affinity)',
        '',
        'company_prompt = "the company name this email is about.',
        '  Prefer the legal entity name over the brand name;',
        "  ignore the sender's own firm.\"",
        '',
        'movement dealflow_intake(msg: <inbox-[:message]->>) {',
        '',
        '  company = write crm-[:company]-> {',
        '    unique by (`domains`)',
        '    name:    AI(company_prompt)',
        '    domains: [msg-[:sender]->.`domain`]',
        '  }',
        '',
        '  await parallel([',
        '    () => {',
        '      write team-[:message]-> {',
        '        channel: "#dealflow"',
        '        text:    "New deal from ${msg-[:sender]->.`name`}: ${company.`url`}"',
        '      }',
        '    },',
        '    () => {',
        '      write aff-[:organization]-> {',
        '        unique by (`name`)',
        '        name:      company.`name`',
        '        attio_url: company.`url`',
        '      }',
        '    },',
        '  ])',
        '}',
      ].join('\n'),
    );
  });

  it('§I log_dealflow (extract tree + nested linked writes)', () => {
    expectClean(
      [
        'import { email, kg } from adapters',
        'import { dealflow_inbox, native_knowledge } from credentials',
        'import { vc_url_retrieval } from plugins',
        '',
        'inbox = email(credentials: dealflow_inbox)',
        'graph = kg(credentials: native_knowledge)',
        '',
        'movement log_dealflow(msg: <inbox-[:message]->>) {',
        '',
        '  deals = extract from [msg.`text`, msg-[:files]->.`data`] {',
        '    node company: "each company seeking investment in this message" {',
        '      name: "the company\'s name"',
        '      urls: "URLs in the message associated with this company"',
        '    } through [vc_url_retrieval(urls: urls)] {',
        '      name: "the company\'s name"',
        '',
        '      node round: "the funding round this company is raising" {',
        '        stage:  "the round\'s stage, e.g. Seed, Series A"',
        '        node investor: "each investor participating in this round" {',
        '          name: "investor name"',
        '          lead: "whether this investor is leading the round"',
        '        }',
        '      }',
        '    }',
        '  }',
        '',
        '  deals-[c:company]-> {',
        '    co = write graph-[:company]-> {',
        '      unique by (`name`)',
        '      name: c.`name`',
        '    }',
        '',
        '    c-[r:round]-> {',
        '      fr = write co-[:rounds]-> {',
        '        unique by (co AND `stage`)',
        '        stage: r.`stage`',
        '      }',
        '',
        '      r-[i:investor]-> {',
        '        write fr-[:participants]-> {',
        '          unique by (fr AND `investor_name`)',
        '          investor_name: i.`name`',
        '          lead:          i.`lead`',
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it("§E nightly_mirror (graph constructed; bare-instance param)", () => {
    expectClean(
      [
        'import { attio, kg } from adapters',
        'import { acme_main, native_knowledge } from credentials',
        '',
        'crm = attio(credentials: acme_main)',
        'graph = kg(credentials: native_knowledge)',
        '',
        'movement nightly_mirror(root: <crm>) {',
        '',
        '  root-[c:companies]-> {',
        '    write graph-[:company]-> { unique by (`domains`), name: c.`Name`, domains: c.`Domains` }',
        '  }',
        '',
        '  root-[d:deals]-> {',
        '    write graph-[:deal]-> {',
        '      unique by (`name`)',
        '      name:    d.`Name`',
        '      company: FIRST(d-[:Company]->.`Domains`)',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('§F attio_to_kg (IS conditions over a union)', () => {
    expectClean(
      [
        'import { attio, kg } from adapters',
        'import { acme_main, native_knowledge } from credentials',
        '',
        'crm = attio(credentials: acme_main)',
        'graph = kg(credentials: native_knowledge)',
        '',
        'movement attio_to_kg(rec: <crm-[:record]->>) {',
        '  if rec IS <crm-[:company]->> {',
        '    write graph-[:company]-> { unique by (`domains`), name: rec.`Name`, domains: rec.`Domains` }',
        '  } else if rec IS <crm-[:person]->> AND EXISTS(rec-[:Company]->) {',
        '    write graph-[:person]-> { name: rec.`Name`, company: rec-[:Company]->.`Name` }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('§G shapes, _resources block, and composition by call', () => {
    expectClean(
      [
        'import { email, dropbox } from adapters',
        'import { dealflow_inbox, team_drive } from credentials',
        '',
        'inbox = email(credentials: dealflow_inbox)',
        '',
        'node Files {',
        '  name: <text>',
        '  data: <file>',
        '}',
        '',
        'movement files_to_dropbox(f: <Files>) {',
        '  drive = dropbox(credentials: team_drive)',
        '  write drive-[:file]-> {',
        '    name: f.`name`',
        '    data: f.`data`',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  msg-[f:_resources]-> {',
        '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it("a bound block's returned value is readable after the block", () => {
    expectClean(
      inMovement(
        [
          '  orgs = msg-[c:mentions]-> {',
          '    return write crm-[:company]-> { unique by (`name`), name: c.`name` }',
          '  }',
          '  write team-[:message]-> { text: "urls: ${orgs.`url`}" }',
        ].join('\n'),
      ),
    );
  });

  it("a combinator's arms bind inside themselves — what comes out is the receipt", () => {
    expectClean(
      inMovement(
        [
          '  r = await parallel([',
          '    () => { return write crm-[:company]-> { name: msg.`subject` } },',
          '    () => { return write crm-[:note]-> { text: msg.`text` } },',
          '  ])',
        ].join('\n'),
      ),
    );
  });

  it('movements call later-declared movements (file-wide hoisting)', () => {
    expectClean(
      [
        PRELUDE,
        'node Lead { name: <text> }',
        'movement a(msg: <inbox-[:message]->>) {',
        '  b(l: node { name: msg.`subject` })',
        '}',
        'movement b(l: <Lead>) {',
        '  write crm-[:company]-> { name: l.`name` }',
        '}',
      ].join('\n'),
    );
  });
});

// ── Imports ──

describe('imports', () => {
  it('MOV_IMPORT_UNKNOWN for an unknown adapter / credential / plugin', () => {
    expect(codes('import { notion } from adapters')).toEqual([C.IMPORT_UNKNOWN]);
    expect(codes('import { stranger } from credentials')).toEqual([C.IMPORT_UNKNOWN]);
    expect(codes('import { transmogrify } from plugins')).toEqual([C.IMPORT_UNKNOWN]);
  });

  it('MOV_IMPORT_DUPLICATE for a name imported twice', () => {
    expect(codes('import { email, email } from adapters')).toEqual([C.IMPORT_DUPLICATE]);
    expect(
      codes('import { email } from adapters\nimport { email } from adapters'),
    ).toEqual([C.IMPORT_DUPLICATE]);
  });

  it('an aliased import binds under the alias (adapter and credential)', () => {
    expectClean(
      [
        'import { email as mail, kg as knowledge } from adapters',
        'import { dealflow_inbox as inbox_creds, native_knowledge } from credentials',
        '',
        'inbox = mail(credentials: inbox_creds)',
        'graph = knowledge(credentials: native_knowledge)',
        '',
        'movement m(msg: <inbox-[:message]->>) {',
        '  write graph-[:note]-> { text: msg.`text` }',
        '}',
      ].join('\n'),
    );
  });

  it('the original name is not in scope when aliased', () => {
    const diagnostics = check(
      [
        'import { email } from adapters',
        'import { dealflow_inbox as inbox_creds } from credentials',
        'inbox = email(credentials: dealflow_inbox)',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.NAME_UNRESOLVED]);
    expect(diagnostics[0].message).toContain("'dealflow_inbox'");
  });

  it('a local name clash is resolved by aliasing one side', () => {
    expect(codes('import { acme_main, acme_main } from credentials')).toEqual([C.IMPORT_DUPLICATE]);
    expectClean(
      [
        'import { attio } from adapters',
        'import { acme_main, acme_main as backup_creds } from credentials',
        '',
        'crm  = attio(credentials: acme_main)',
        'crm2 = attio(credentials: backup_creds)',
      ].join('\n'),
    );
  });

  it('MOV_IMPORT_UNKNOWN still cites the original name when aliased', () => {
    const diagnostics = check('import { stranger as friend } from credentials');
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_UNKNOWN]);
    expect(diagnostics[0].message).toContain("'stranger'");
  });

  it('MOV_IMPORT_FILE_UNSUPPORTED for file imports (names still usable)', () => {
    const diagnostics = check(
      [
        'import { kg } from adapters',
        'import { native_knowledge } from credentials',
        'import { Files } from "lib/file-routines"',
        'graph = kg(credentials: native_knowledge)',
        'movement m(f: <Files>) {',
        '  write graph-[:file]-> { name: f.`name` }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.IMPORT_FILE_UNSUPPORTED]);
  });

  it('MOV_USE_BEFORE_BIND when an import is used above its statement', () => {
    const diagnostics = check(
      [
        'import { email } from adapters',
        'inbox = email(credentials: dealflow_inbox)',
        'import { dealflow_inbox } from credentials',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.USE_BEFORE_BIND]);
    expect(diagnostics[0].message).toContain("'dealflow_inbox'");
  });
});

// ── No magic values ──

describe('name resolution', () => {
  it('MOV_NAME_UNRESOLVED for a bare unknown name in a field value', () => {
    const diagnostics = check(inMovement('  write team-[:message]-> { text: ghost }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.NAME_UNRESOLVED]);
    expect(diagnostics[0].message).toContain("'ghost'");
  });

  it('MOV_NAME_UNRESOLVED for an unknown traversal root inside an expression', () => {
    expect(codes(inMovement('  write team-[:message]-> { text: ghost-[:sender]->.`name` }'))).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  // A bare name nested inside a larger expression — a string interpolation, an
  // AI() prompt, a function arg — is still a variable reference and must
  // resolve, not just when it stands alone as the whole slot.
  it('MOV_NAME_UNRESOLVED for an unknown name inside a "${…}" interpolation', () => {
    expect(codes(inMovement('  write team-[:message]-> { text: "hi ${ghost}" }'))).toEqual([C.NAME_UNRESOLVED]);
  });

  it('MOV_NAME_UNRESOLVED for an interpolation reading a name out of scope (movement-local at file scope)', () => {
    expect(
      codes(`${PRELUDE}\na = "${'${ghost}'}"\nmovement m(msg: <inbox-[:message]->>) {\n  ghost = "x"\n}`),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it('MOV_NAME_UNRESOLVED for an unknown name inside an AI() prompt', () => {
    expect(codes(inMovement('  write team-[:message]-> { text: AI(ghost) }'))).toEqual([C.NAME_UNRESOLVED]);
  });

  it('MOV_NAME_UNRESOLVED for an unknown name nested in a function argument', () => {
    expect(codes(inMovement('  write team-[:message]-> { text: COALESCE(ghost, "x") }'))).toEqual([C.NAME_UNRESOLVED]);
  });

  it('a rooted field access and a valid interpolation are NOT mistaken for unknown names', () => {
    expectClean(inMovement('  prompt = msg.`subject`\n  write team-[:message]-> { text: "re: ${prompt} — ${msg.`subject`}" }'));
  });

  it('MOV_NAME_UNRESOLVED for an unknown traversal-block root', () => {
    expect(codes(inMovement('  ghost-[c:mentions]-> {\n    write team-[:message]-> { text: c.`name` }\n  }'))).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  it('MOV_NAME_UNRESOLVED for an unknown movement parameter graph', () => {
    expect(codes(`${PRELUDE}\nmovement m(msg: <ghost-[:message]->>) {\n  …\n}`)).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  it("schema-less: an unknown 'unique by' reference stays silent (can't tell field from typo)", () => {
    // Without a schema, a bare name in a `unique by` predicate could be an
    // undescribed field — so the unknown-stays-silent contract applies. Field
    // existence is enforced under a schema (see check_typed: UNIQUE_UNKNOWN_FIELD).
    expect(
      codes(inMovement('  write crm-[:company]-> { unique by (ghost AND `name`), name: msg.`subject` }')),
    ).toEqual([]);
  });

  it("MOV_NAME_UNRESOLVED for an unknown 'link' endpoint", () => {
    expect(
      codes(
        inMovement(
          ['  co = write crm-[:company]-> { name: msg.`subject` }', '  link co -[:led]-> ghost'].join(
            '\n',
          ),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it('a match over an untyped graph stays silent (unknown never false-positives)', () => {
    expect(
      codes(
        inMovement(
          [
            '  co = write crm-[:company]-> { name: msg.`subject` }',
            '  p = match co-[:portfolio]-> { unique by (`name`), name: "Fund III" }',
          ].join('\n'),
        ),
      ),
    ).toEqual([]);
  });

  it("a match's field expressions still resolve names", () => {
    expect(
      codes(
        inMovement(
          [
            '  co = write crm-[:company]-> { name: msg.`subject` }',
            '  match co-[:portfolio]-> { unique by (`name`), name: ghost.`name` }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it("MOV_NAME_UNRESOLVED for an unknown 'unlink' endpoint (mirrors 'link')", () => {
    expect(
      codes(
        inMovement(
          ['  co = write crm-[:company]-> { name: msg.`subject` }', '  unlink co -[:led]-> ghost'].join(
            '\n',
          ),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it("MOV_NAME_UNRESOLVED for an unknown 'delete' handle", () => {
    expect(codes(inMovement('  delete ghost'))).toEqual([C.NAME_UNRESOLVED]);
  });

  it('unlink and delete over bound handles check clean', () => {
    expectClean(
      inMovement(
        [
          '  co = write crm-[:company]-> { name: msg.`subject` }',
          '  note = write crm-[:note]-> { text: msg.`text` }',
          '  unlink co -[:notes]-> note',
          '  delete note',
        ].join('\n'),
      ),
    );
  });

  it('MOV_EXPR_PARSE when an expression slot does not parse', () => {
    const diagnostics = check(inMovement('  write team-[:message]-> { text: EXTRACT_VALUE("x") }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.EXPR_PARSE]);
    expect(diagnostics[0].message).toMatch(/EXTRACT_VALUE is retired/);
  });

  it('a comment with a quote or backtick inside a nested closure body does not break the expression', () => {
    const diagnostics = check(
      inMovement(
        [
          '  details = FIRST(MAP([msg], (x) => {',
          "    # research isn't cheap, so it runs only for `x` with no \"website\"",
          '    return x.`subject`',
          '  }))',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).not.toContain(C.EXPR_PARSE);
  });

  it('aliases bound inside an expression do not leak false positives', () => {
    expectClean(
      inMovement('  write team-[:message]-> { text: FIRST(msg-[s:sender]->.`name`) }'),
    );
  });
});

// ── Constructions ──

describe('constructions', () => {
  it('MOV_CONSTRUCT_NOT_ADAPTER when constructing a file-imported name', () => {
    expect(
      codes(
        [
          'import { acme_main } from credentials',
          'import { file_lib } from "lib/file-routines"',
          'x = file_lib(credentials: acme_main)',
        ].join('\n'),
      ),
    ).toEqual([C.IMPORT_FILE_UNSUPPORTED, C.CONSTRUCT_NOT_ADAPTER]);
  });

  it('MOV_CONSTRUCT_NOT_ADAPTER when constructing a non-adapter import', () => {
    expect(codes('import { acme_main } from credentials\nx = acme_main()')).toEqual([
      C.CONSTRUCT_NOT_ADAPTER,
    ]);
  });

  it('MOV_CONSTRUCT_BAD_ARG for an argument the manifest does not declare', () => {
    expect(
      codes(
        [
          'import { attio } from adapters',
          'import { acme_main } from credentials',
          'crm = attio(credentials: acme_main, nonsense: "x")',
        ].join('\n'),
      ),
    ).toEqual([C.CONSTRUCT_BAD_ARG]);
  });

  it('declared non-credential construction args are accepted', () => {
    expectClean(
      [
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        'crm = attio(credentials: acme_main, list: "Dealflow")',
      ].join('\n'),
    );
  });

  describe('enum-typed (entry-position) construction arg', () => {
    // `list` stands in for an entry-position arg (Sheets' `spreadsheet:`): the
    // catalog offers its valid values per credential.
    const posCatalog = mockCatalog({
      adapters: { attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }, { name: 'list', kind: 'position', required: false }]} },
      credentials: { acme_main: { adapter: 'attio' } },
      constructionArgOptions: ({ arg }) => (arg === 'list' ? ['Dealflow', 'Portfolio'] : undefined),
    });
    const src = (val: string) =>
      [
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        `crm = attio(credentials: acme_main, list: "${val}")`,
      ].join('\n');

    it('WARNS (never errors) on a value the connection cannot see, with a did-you-mean', () => {
      const diags = checkProgram(parseProgram(src('Nope')), posCatalog);
      const hit = diags.find((d) => d.code === C.CONSTRUCT_UNKNOWN_OPTION);
      expect(hit).toBeDefined();
      expect(hit?.severity).toBe('warning');
      expect(hit?.message).toContain('Dealflow');
    });

    it('is silent for a known value', () => {
      expect(
        checkProgram(parseProgram(src('Dealflow')), posCatalog).map((d) => d.code),
      ).not.toContain(C.CONSTRUCT_UNKNOWN_OPTION);
    });
  });

  it('MOV_CONSTRUCT_MISSING_CRED when the credential argument is absent', () => {
    expect(codes('import { attio } from adapters\ncrm = attio()')).toEqual([
      C.CONSTRUCT_MISSING_CRED,
    ]);
  });

  it('MOV_CRED_WRONG_ADAPTER for a credential of another adapter', () => {
    const diagnostics = check(
      [
        'import { slack } from adapters',
        'import { acme_main } from credentials',
        'team = slack(credentials: acme_main)',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.CRED_WRONG_ADAPTER]);
    expect(diagnostics[0].message).toMatch(/attio credential/);
  });

  it('MOV_CRED_WRONG_ADAPTER when the value is not a credential at all', () => {
    expect(
      codes(
        [
          'import { email, attio } from adapters',
          'import { dealflow_inbox } from credentials',
          'inbox = email(credentials: dealflow_inbox)',
          'crm = attio(credentials: inbox)',
        ].join('\n'),
      ),
    ).toEqual([C.CRED_WRONG_ADAPTER]);
  });
});

// ── Bound-before-read & program order ──

describe('binding order', () => {
  it('MOV_USE_BEFORE_BIND for a handle read above its write', () => {
    const diagnostics = check(
      inMovement(
        [
          '  write team-[:message]-> { text: company.`url` }',
          '  company = write crm-[:company]-> { name: msg.`subject` }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.USE_BEFORE_BIND]);
    expect(diagnostics[0].message).toContain("'company'");
  });

  it('one arm cannot read what another arm bound — they are separate closures', () => {
    expect(
      codes(
        inMovement(
          [
            '  await parallel([',
            '    () => { co = write crm-[:company]-> { name: msg.`subject` } },',
            '    () => { write team-[:message]-> { text: co.`url` } },',
            '  ])',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });
});

// ── Block scoping ──

describe('block scoping', () => {
  it('inner bindings are invisible outside an assigned block, with the return hint', () => {
    const diagnostics = check(
      inMovement(
        [
          '  orgs = msg-[c:mentions]-> {',
          '    co = write crm-[:company]-> { name: c.`name` }',
          '  }',
          '  write team-[:message]-> { text: co.`url` }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toContain(C.NAME_UNRESOLVED);
    expect(diagnostics.map(d => d.message).join('\n')).toContain('return it from the block');
  });

  it('inner bindings are invisible outside an unassigned block (no hint)', () => {
    const diagnostics = check(
      inMovement(
        [
          '  msg-[c:mentions]-> {',
          '    co = write crm-[:company]-> { name: c.`name` }',
          '  }',
          '  write team-[:message]-> { text: co.`url` }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.NAME_UNRESOLVED]);
    expect(diagnostics[0].message).toContain('traversal block');
    expect(diagnostics[0].message).not.toContain('did you mean');
  });

  it('traversal aliases are scoped to their block body', () => {
    expect(
      codes(
        inMovement(
          [
            '  msg-[c:mentions]-> {',
            '    write crm-[:company]-> { name: c.`name` }',
            '  }',
            '  write team-[:message]-> { text: c.`name` }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it('if-arm bindings are scoped to the arm', () => {
    expect(
      codes(
        inMovement(
          [
            '  if msg.`subject` CONTAINS "deal" {',
            '    co = write crm-[:company]-> { name: msg.`subject` }',
            '  }',
            '  write team-[:message]-> { text: co.`url` }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });
});

// ── Declarations & calls ──

describe('movements, shapes, calls', () => {
  it('MOV_DUPLICATE_DECL for two movements of the same name', () => {
    expect(
      codes(`${PRELUDE}\nmovement m(a: <crm-[:record]->>) {\n  …\n}\nmovement m(b: <crm-[:record]->>) {\n  …\n}`),
    ).toEqual([C.DUPLICATE_DECL]);
  });

  it('MOV_DUPLICATE_DECL for a node declaration colliding with a movement', () => {
    expect(
      codes(`${PRELUDE}\nmovement thing(a: <crm-[:record]->>) {\n  …\n}\nnode thing { x: <text> }`),
    ).toEqual([C.DUPLICATE_DECL]);
  });

  it('MOV_CALL_NOT_MOVEMENT when calling a non-movement', () => {
    expect(codes(`${PRELUDE}\nmovement m(a: <crm-[:record]->>) {\n  crm(x: "x")\n}`)).toEqual([
      C.CALL_NOT_MOVEMENT,
    ]);
  });

  it('MOV_CALL_ARITY on argument-count mismatch (the missing name is also named)', () => {
    expect(
      codes(
        [
          PRELUDE,
          'movement callee(a: <crm-[:record]->>) {',
          '  …',
          '}',
          'movement caller(b: <crm-[:record]->>) {',
          '  callee()',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.CALL_ARITY, C.CALL_ARG_MISSING]);
  });

  it('named-argument matching: unknown, missing, and duplicate names', () => {
    const withCall = (call: string) =>
      [
        PRELUDE,
        'movement callee(a: <crm-[:record]->>, b: <crm-[:record]->>) {',
        '  …',
        '}',
        'movement caller(rec: <crm-[:record]->>) {',
        `  ${call}`,
        '}',
      ].join('\n');
    // Order carries no meaning — names match.
    expect(codes(withCall('callee(b: rec, a: rec)'))).toEqual([]);
    const unknown = check(withCall('callee(a: rec, c: rec)'));
    expect(unknown.map(d => d.code)).toEqual([C.CALL_ARG_UNKNOWN, C.CALL_ARG_MISSING]);
    expect(unknown[0].message).toContain("its parameters are: a, b");
    expect(unknown[1].message).toContain("'b'");
    const duplicate = check(withCall('callee(a: rec, a: rec)'));
    expect(duplicate.map(d => d.code)).toEqual([C.CALL_ARG_DUPLICATE, C.CALL_ARG_MISSING]);
  });

  it('positional call arguments bind in declared order', () => {
    const withCall = (call: string) =>
      [
        PRELUDE,
        'movement callee(a: <crm-[:record]->>, b: <crm-[:record]->>) {',
        '  …',
        '}',
        'movement caller(rec: <crm-[:record]->>) {',
        `  ${call}`,
        '}',
      ].join('\n');
    expect(codes(withCall('callee(rec, rec)'))).toEqual([]);
    expect(codes(withCall('callee(rec)'))).toEqual([C.CALL_ARITY, C.CALL_ARG_MISSING]);
  });
});

// ── Extract descriptions are ordinary strings ──
//
// A description interpolates wherever it is written, exactly as a write field's
// value does. Before that was true, `${`Deep Dive Themes`}` reached the model as
// those eleven literal characters and the model answered null — the language
// promised interpolation and the extractor silently got source text.

describe('an extract description is a string expression', () => {
  const withDescriptions = (field: string, node = '"each company"') =>
    inMovement(
      [
        '  `Themes` = "AI Agents, Future of Work"',
        '  deals = extract from [msg.`text`] {',
        `    node company: ${node} {`,
        `      theme: ${field}`,
        '    }',
        '  }',
      ].join('\n'),
    );

  it('a description that interpolates a constant in scope is clean', () => {
    expectClean(withDescriptions('"the theme, one of: ${`Themes`}"'));
  });

  it('MOV_NAME_UNRESOLVED when a field description names nothing in scope', () => {
    const diagnostics = check(withDescriptions('"the theme, one of: ${`Dive Themes`}"'));
    expect(diagnostics.map(d => d.code)).toEqual([C.NAME_UNRESOLVED]);
    expect(diagnostics[0].message).toContain('Dive Themes');
  });

  it("MOV_NAME_UNRESOLVED when a NODE's description names nothing in scope", () => {
    expect(codes(withDescriptions('"the theme"', '"each ${vanisher} mentioned"'))).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  it("an extracted field is NOT in scope for a description — the tree's descriptions are evaluated before anything is extracted", () => {
    expect(
      codes(
        inMovement(
          [
            '  deals = extract from [msg.`text`] {',
            '    name: "the name"',
            '    theme: "the theme for ${name}"',
            '  }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.NAME_UNRESOLVED]);
  });

  it('a description with no interpolation raises nothing', () => {
    expectClean(withDescriptions('"the theme, verbatim from the list"'));
  });
});

// ── Through args (extract) ──

const extractWith = (through: string, stage2Fields: string) =>
  inMovement(
    [
      '  deals = extract from [msg.`text`] {',
      '    node company: "each company" {',
      '      name: "the name"',
      '      urls: "associated URLs"',
      `    } through [${through}] {`,
      ...stage2Fields.split('\n').map(l => `      ${l}`),
      '    }',
      '  }',
    ].join('\n'),
  );

describe('through args', () => {
  it('MOV_THROUGH_NOT_PLUGIN when the pipeline names a non-plugin', () => {
    expect(codes(extractWith('inbox', 'website: "the website"'))).toEqual([C.THROUGH_NOT_PLUGIN]);
  });

  it('MOV_NAME_UNRESOLVED when the pipeline names nothing in scope', () => {
    expect(codes(extractWith('vanisher', 'website: "the website"'))).toEqual([C.NAME_UNRESOLVED]);
  });

  it('MOV_THROUGH_BAD_ARG for an argument the plugin does not declare', () => {
    expect(codes(extractWith('vc_url_retrieval(bogus: urls)', 'website: "the website"'))).toEqual([
      C.THROUGH_BAD_ARG,
    ]);
  });

  it("MOV_THROUGH_FORWARD_REF when a through reads its own stage's field", () => {
    const diagnostics = check(
      extractWith('vc_url_retrieval(urls: website)', 'website: "the website"'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.THROUGH_FORWARD_REF]);
    expect(diagnostics[0].message).toContain("'website'");
  });

  it('prior-stage fields and inherited scope resolve in through args', () => {
    expectClean(extractWith('vc_url_retrieval(urls: urls)', 'website: "the website"'));
    expectClean(extractWith('vc_url_retrieval(urls: msg.`text`)', 'website: "the website"'));
  });

  it('MOV_THROUGH_ARG_MISSING for a required argument the call omits, naming the param and the plugin', () => {
    const diagnostics = check(extractWith('fetch_url', 'website: "the website"'));
    expect(diagnostics.map(d => d.code)).toEqual([C.THROUGH_ARG_MISSING]);
    expect(diagnostics[0].message).toContain("'fetch_url'");
    expect(diagnostics[0].message).toContain("'url'");
  });

  it('MOV_THROUGH_ARG_MISSING still fires when other (non-required) arguments are supplied', () => {
    expect(codes(extractWith('fetch_url(email: msg.`subject`)', 'website: "the website"'))).toEqual([
      C.THROUGH_ARG_MISSING,
    ]);
  });

  it('supplying the required argument clears MOV_THROUGH_ARG_MISSING', () => {
    expectClean(extractWith('fetch_url(url: urls)', 'website: "the website"'));
  });

  it('an optional argument left out stays clean — only requiredArgs are demanded', () => {
    expectClean(extractWith('fetch_url(url: urls, email: msg.`subject`)', 'website: "the website"'));
  });

  it("a child node's through may read the parent's earlier fields", () => {
    expectClean(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      urls: "associated URLs"',
          '      node round: "the round" {',
          '        stage: "the stage"',
          '      } through [vc_url_retrieval(urls: urls)] {',
          '        amount: "the amount"',
          '      }',
          '    }',
          '  }',
        ].join('\n'),
      ),
    );
  });
});

// ── Duplicate extract fields ──

describe('extract field duplicates', () => {
  it('MOV_EXTRACT_FIELD_DUPLICATE for two description fields in one node', () => {
    const diagnostics = check(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      description: "the pitch"',
          '      description: "the summary"',
          '    }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_FIELD_DUPLICATE]);
    expect(diagnostics[0].message).toContain("'description'");
  });

  it('MOV_EXTRACT_FIELD_DUPLICATE for a child node named like a field of its parent', () => {
    const diagnostics = check(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      round: "the latest round"',
          '      node round: "each funding round" { stage: "the stage" }',
          '    }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_FIELD_DUPLICATE]);
    expect(diagnostics[0].message).toContain("'round'");
  });

  it('MOV_EXTRACT_FIELD_DUPLICATE for a declared node whose child shares a field name', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'node Company: "each company" {',
        '  round: <text> "the latest round"',
        '  node round: "each funding round" { stage: <text> "the stage" }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_FIELD_DUPLICATE]);
  });

  it('a later stage may redeclare an earlier stage\'s field (transformation wins)', () => {
    expectClean(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      name: "the raw name"',
          '    } through [vc_url_retrieval(urls: name)] {',
          '      name: "the cleaned name"',
          '    }',
          '  }',
        ].join('\n'),
      ),
    );
  });
});

// ── Diagnostics carry usable spans ──

describe('diagnostic spans', () => {
  it('points at the offending line', () => {
    const source = inMovement(
      [
        '  write team-[:message]-> { text: msg.`subject` }',
        '  write team-[:message]-> { text: ghost }',
      ].join('\n'),
    );
    const [diagnostic] = check(source);
    const lines = source.split('\n');
    expect(lines[diagnostic.span.start.line - 1]).toContain('ghost');
  });
});

// ── Listen statements (trigger rows are derived from these) ──

describe('listen statements', () => {
  const INTAKE = [
    'movement intake(msg: <inbox-[:message]->>) {',
    '  write team-[:message]-> { text: msg.`subject` }',
    '}',
  ].join('\n');

  it('a listen with config checks clean', () => {
    expectClean(`${PRELUDE}\n${INTAKE}\nlisten to inbox { key: "dealflow" } fire intake`);
  });

  it('a listen with no config checks clean', () => {
    expectClean(`${PRELUDE}\n${INTAKE}\nlisten to inbox fire intake`);
  });

  it('multiple listens differing in config check clean', () => {
    expectClean(
      [
        PRELUDE,
        INTAKE,
        'listen to inbox { key: "dealflow" } fire intake',
        'listen to inbox { key: "intros" } fire intake',
      ].join('\n'),
    );
  });

  it('listening to a non-instance is MOV_LISTEN_NOT_INSTANCE', () => {
    expect(
      codes(`${PRELUDE}\n${INTAKE}\nlisten to dealflow_inbox fire intake`),
    ).toContain(C.LISTEN_NOT_INSTANCE);
    // A constructed graph instance is an instance like any other — listenable,
    // not a non-instance (listen_narrows_config covers its config vocabulary).
    expect(codes(`${PRELUDE}\n${INTAKE}\nlisten to graph fire intake`)).not.toContain(
      C.LISTEN_NOT_INSTANCE,
    );
  });

  it('listening to an unknown name is MOV_NAME_UNRESOLVED', () => {
    expect(codes(`${PRELUDE}\n${INTAKE}\nlisten to ghost fire intake`)).toContain(
      C.NAME_UNRESOLVED,
    );
  });

  it("a parameter typed against another instance is MOV_LISTEN_PARAM_MISMATCH, naming both types", () => {
    const source = [
      PRELUDE,
      'movement sync(rec: <crm-[:company]->>) {',
      '  write team-[:message]-> { text: rec.`name` }',
      '}',
      'listen to inbox fire sync',
    ].join('\n');
    const diagnostics = check(source);
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_PARAM_MISMATCH]);
    expect(diagnostics[0].message).toContain('crm-[:company]->');
    expect(diagnostics[0].message).toContain("'inbox'");
  });

  it('a movement with the wrong arity is MOV_LISTEN_PARAM_MISMATCH', () => {
    const source = [
      PRELUDE,
      'movement pair(a: <inbox-[:message]->>, b: <inbox-[:message]->>) {',
      '  write team-[:message]-> { text: a.`subject` }',
      '}',
      'listen to inbox fire pair',
    ].join('\n');
    const diagnostics = check(source);
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_PARAM_MISMATCH]);
    expect(diagnostics[0].message).toContain('2 parameters');
  });

  it('firing a non-movement is MOV_CALL_NOT_MOVEMENT', () => {
    expect(codes(`${PRELUDE}\n${INTAKE}\nlisten to inbox fire crm`)).toContain(
      C.CALL_NOT_MOVEMENT,
    );
  });

  it('firing an unknown name is MOV_NAME_UNRESOLVED', () => {
    expect(codes(`${PRELUDE}\n${INTAKE}\nlisten to inbox fire ghost`)).toContain(
      C.NAME_UNRESOLVED,
    );
  });

  it('identical (instance, config) listens are MOV_LISTEN_DUPLICATE — key order ignored', () => {
    const source = [
      PRELUDE,
      INTAKE,
      'listen to inbox { key: "dealflow" } fire intake',
      'listen to inbox { key: "dealflow" } fire intake',
    ].join('\n');
    expect(codes(source)).toEqual([C.LISTEN_DUPLICATE]);
  });

  it('a config key outside the adapter vocabulary is MOV_LISTEN_BAD_CONFIG', () => {
    const diagnostics = check(
      `${PRELUDE}\n${INTAKE}\nlisten to inbox { channel: "#x" } fire intake`,
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain("'channel'");
    expect(diagnostics[0].message).toContain('key');
  });

  it('an adapter with no trigger-config vocabulary rejects any config key', () => {
    const source = [
      PRELUDE,
      'movement sync(rec: <crm-[:company]->>) {',
      '  write team-[:message]-> { text: rec.`name` }',
      '}',
      'listen to crm { anything_goes: "x" } fire sync',
    ].join('\n');
    // A resolved adapter that declares no config vocabulary accepts NONE — an
    // unknown key is an error, not silently passed through.
    expect(codes(source)).toEqual([C.LISTEN_BAD_CONFIG]);
  });

  it('config values resolve names like any expression slot', () => {
    expect(
      codes(`${PRELUDE}\n${INTAKE}\nlisten to inbox { key: mystery } fire intake`),
    ).toContain(C.NAME_UNRESOLVED);
  });

  it("a listen inside a movement body is MOV_LISTEN_FILE_LEVEL", () => {
    expect(codes(inMovement('  listen to inbox fire m'))).toContain(C.LISTEN_FILE_LEVEL);
  });
});

// ── MOV_LISTEN_MISSING (info severity) ──

describe('MOV_LISTEN_MISSING', () => {
  it('a dispatchable movement with no listen gets an info diagnostic with a suggested line', () => {
    const diagnostics = checkAll(
      `${PRELUDE}\nmovement dealflow_intake(msg: <inbox-[:message]->>) {\n  write team-[:message]-> { text: msg.\`subject\` }\n}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(C.LISTEN_MISSING);
    expect(diagnostics[0].severity).toBe('info');
    // The suggestion is ready to paste: instance + key (the email adapter's
    // vocabulary includes 'key') + the movement name.
    expect(diagnostics[0].message).toContain(
      'listen to inbox { key: "dealflow-intake" } fire dealflow_intake',
    );
  });

  it('any listen in the file suppresses it', () => {
    const source = [
      PRELUDE,
      'movement intake(msg: <inbox-[:message]->>) {',
      '  write team-[:message]-> { text: msg.`subject` }',
      '}',
      'listen to inbox { key: "dealflow" } fire intake',
    ].join('\n');
    expect(checkAll(source)).toEqual([]);
  });

  it('a library file (no dispatchable movement) gets none', () => {
    const source = [
      'import { kg } from adapters',
      'import { native_knowledge } from credentials',
      '',
      'graph = kg(credentials: native_knowledge)',
      '',
      'node Files {',
      '  name: <text>',
      '}',
      'movement log_file(f: <Files>) {',
      '  write graph-[:note]-> { text: f.`name` }',
      '}',
    ].join('\n');
    expect(checkAll(source)).toEqual([]);
  });

  it('the suggestion omits the config block when the adapter declares no vocabulary', () => {
    const source = [
      PRELUDE,
      'movement sync(rec: <crm-[:company]->>) {',
      '  write team-[:message]-> { text: rec.`name` }',
      '}',
    ].join('\n');
    const diagnostics = checkAll(source);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('listen to crm fire sync');
  });
});

// ── Cron + manual channels (`listen` is the only invoker) ──

describe('cron and manual listeners', () => {
  it('a named cron channel with a schedule checks clean', () => {
    expectClean(
      [
        'import { cron, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team  = slack(credentials: acme_workspace)',
        'timer = cron()',
        'movement digest(t: <timer-[:tick]->>) {',
        '  write team-[:message]-> { text: t.`firedAt` }',
        '}',
        'listen to timer { schedule: "0 9 * * 1" } fire digest',
      ].join('\n'),
    );
  });

  it('a named manual construction with a matching parameter + listen checks clean', () => {
    expectClean(
      [
        'import { manual, slack } from adapters',
        'import { acme_workspace } from credentials',
        'runs = manual()',
        'team = slack(credentials: acme_workspace)',
        'movement backfill(go: <runs-[:invocation]->>) {',
        '  write team-[:message]-> { text: go.`actorEmail` }',
        '}',
        'listen to runs {} fire backfill',
      ].join('\n'),
    );
  });

  it('a bare adapter import as a position source is MOV_ADAPTER_NOT_CONSTRUCTED', () => {
    const diagnostics = check(
      [
        'import { manual, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team = slack(credentials: acme_workspace)',
        'movement backfill(go: <manual-[:invocation]->>) {',
        '  write team-[:message]-> { text: go.`actorEmail` }',
        '}',
        'listen to runs {} fire backfill',
      ].join('\n'),
    );
    const adapterErr = diagnostics.find(d => d.code === C.ADAPTER_NOT_CONSTRUCTED);
    expect(adapterErr).toBeDefined();
    expect(adapterErr?.message).toContain('construct an instance and name it first');
    expect(adapterErr?.message).toContain('go = manual()');
  });

  it('an inline manual listen is MOV_ADAPTER_NOT_CONSTRUCTED', () => {
    const diagnostics = check(
      [
        'import { manual, slack } from adapters',
        'import { acme_workspace } from credentials',
        'runs = manual()',
        'team = slack(credentials: acme_workspace)',
        'movement backfill(go: <runs-[:invocation]->>) {',
        '  write team-[:message]-> { text: go.`actorEmail` }',
        '}',
        'listen to manual() {} fire backfill',
      ].join('\n'),
    );
    const adapterErr = diagnostics.find(d => d.code === C.ADAPTER_NOT_CONSTRUCTED);
    expect(adapterErr).toBeDefined();
    expect(adapterErr?.message).toContain('construct and name it first');
  });

  it('a capitalized position type on a named instance is MOV_UNKNOWN_POSITION suggesting the resolvable id', () => {
    const diagnostics = check(
      [
        'import { manual, slack } from adapters',
        'import { acme_workspace } from credentials',
        'runs = manual()',
        'team = slack(credentials: acme_workspace)',
        'movement backfill(go: <runs-[:Invocation]->>) {',
        '  write team-[:message]-> { text: go.`actorEmail` }',
        '}',
        'listen to runs {} fire backfill',
      ].join('\n'),
    );
    const unknown = diagnostics.find(d => d.code === C.UNKNOWN_POSITION);
    expect(unknown).toBeDefined();
    expect(unknown?.message).toContain('invocation');
  });

  it('a schedule-less cron listener is MOV_LISTEN_BAD_CONFIG with the fix-it', () => {
    const diagnostics = check(
      [
        'import { cron, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team  = slack(credentials: acme_workspace)',
        'timer = cron()',
        'movement digest(t: <timer-[:tick]->>) {',
        '  write team-[:message]-> { text: t.`firedAt` }',
        '}',
        'listen to timer {} fire digest',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain("requires a 'schedule' config");
    expect(diagnostics[0].message).toContain('schedule: "0 9 * * 1"');
  });

  it('a required address hop is satisfied by the instance POSITION pinning it', () => {
    // `shelf` is required, but the construction pins the `shelf` position arg —
    // the position supplies the leading hop, so the listen names only `crate`.
    expectClean(
      [
        'import { pantry, slack } from adapters',
        'import { pantry_main, acme_workspace } from credentials',
        'team = slack(credentials: acme_workspace)',
        'p = pantry(credentials: pantry_main, shelf: "North Wall")',
        'movement intake(e: <p-[:thing]->>) {',
        '  write team-[:message]-> { text: "stocked" }',
        '}',
        'listen to p { crate: "crt_apples" } fire intake',
      ].join('\n'),
    );
  });

  it('an UNPOSITIONED instance still requires the hop on the listen', () => {
    const diagnostics = check(
      [
        'import { pantry, slack } from adapters',
        'import { pantry_main, acme_workspace } from credentials',
        'team = slack(credentials: acme_workspace)',
        'p = pantry(credentials: pantry_main)',
        'movement intake(e: <p-[:thing]->>) {',
        '  write team-[:message]-> { text: "stocked" }',
        '}',
        'listen to p { crate: "crt_apples" } fire intake',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain("requires a 'shelf' config");
  });

  it('the position supplies only ITS hop — the rest stay required', () => {
    const diagnostics = check(
      [
        'import { pantry, slack } from adapters',
        'import { pantry_main, acme_workspace } from credentials',
        'team = slack(credentials: acme_workspace)',
        'p = pantry(credentials: pantry_main, shelf: "North Wall")',
        'movement intake(e: <p-[:thing]->>) {',
        '  write team-[:message]-> { text: "stocked" }',
        '}',
        'listen to p {} fire intake',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain("requires a 'crate' config");
  });

  it('a cron listener with a valid IANA timezone checks clean', () => {
    expectClean(
      [
        'import { cron, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team  = slack(credentials: acme_workspace)',
        'timer = cron()',
        'movement digest(t: <timer-[:tick]->>) {',
        '  write team-[:message]-> { text: t.`firedAt` }',
        '}',
        'listen to timer { schedule: "0 9 * * 1", timezone: "Europe/London" } fire digest',
      ].join('\n'),
    );
  });

  it('a strings-format listen key takes a non-empty list of quoted names', () => {
    const program = (slots: string) =>
      [
        'import { postbox, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team = slack(credentials: acme_workspace)',
        'box  = postbox()',
        'movement sort_mail(l: <box-[:letter]->>) {',
        '  write team-[:message]-> { text: l.`sender` }',
        '}',
        `listen to box { slots: ${slots} } fire sort_mail`,
      ].join('\n');
    expectClean(program('["A", "B"]'));
    for (const bad of ['[]', '"A"', '["A", ""]', '[1]']) {
      const diagnostics = check(program(bad));
      expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
      expect(diagnostics[0].message).toContain("'slots' is a non-empty list of quoted, non-empty names");
    }
  });

  it('an invalid timezone is MOV_LISTEN_BAD_CONFIG naming the zone', () => {
    const diagnostics = check(
      [
        'import { cron, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team  = slack(credentials: acme_workspace)',
        'timer = cron()',
        'movement digest(t: <timer-[:tick]->>) {',
        '  write team-[:message]-> { text: t.`firedAt` }',
        '}',
        'listen to timer { schedule: "0 9 * * 1", timezone: "Narnia/Cair" } fire digest',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain('not a recognised IANA time zone');
    expect(diagnostics[0].message).toContain('Narnia/Cair');
  });

  it('an invalid cron expression is MOV_LISTEN_BAD_CONFIG naming the field', () => {
    const diagnostics = check(
      [
        'import { cron, slack } from adapters',
        'import { acme_workspace } from credentials',
        'team  = slack(credentials: acme_workspace)',
        'timer = cron()',
        'movement digest(t: <timer-[:tick]->>) {',
        '  write team-[:message]-> { text: t.`firedAt` }',
        '}',
        'listen to timer { schedule: "99 9 * * 1" } fire digest',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(diagnostics[0].message).toContain('not a valid schedule');
    expect(diagnostics[0].message).toContain('minute');
  });

  it('an inline construction in a listen is MOV_ADAPTER_NOT_CONSTRUCTED', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'movement m(msg: <inbox-[:message]->>) {',
        '  write team-[:message]-> { text: msg.`subject` }',
        '}',
        'listen to crm() {} fire m',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });

  it('a listen on a bare adapter import is MOV_ADAPTER_NOT_CONSTRUCTED', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'import { manual } from adapters',
        'movement m(msg: <inbox-[:message]->>) {',
        '  write team-[:message]-> { text: msg.`subject` }',
        '}',
        'listen to manual {} fire m',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toContain(C.ADAPTER_NOT_CONSTRUCTED);
  });

  it("the retired 'run' statement no longer parses", () => {
    expect(() => parseProgram('run backfill(root: crm)')).toThrow(
      /'run' is not a statement/,
    );
  });

  it('a named-manual movement with no listen suggests the listen line', () => {
    const source = [
      'import { manual, slack } from adapters',
      'import { acme_workspace } from credentials',
      'runs = manual()',
      'team = slack(credentials: acme_workspace)',
      'movement backfill(go: <runs-[:invocation]->>) {',
      '  write team-[:message]-> { text: go.`actorEmail` }',
      '}',
    ].join('\n');
    const infos = checkAll(source).filter(d => d.severity === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0].code).toBe(C.LISTEN_MISSING);
    expect(infos[0].message).toContain('listen to runs fire backfill');
  });
});

// ── The universal dry_run construction parameter ──

describe('dry_run construction parameter', () => {
  it('is accepted on any adapter construction', () => {
    expectClean(
      [
        PRELUDE,
        'inbox2 = email(credentials: dealflow_inbox, dry_run: true)',
        'crm2   = attio(credentials: acme_main, dry_run: false)',
      ].join('\n'),
    );
  });

  it('a non-boolean value is MOV_CONSTRUCT_BAD_ARG', () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main, dry_run: "yes")',
    ].join('\n');
    const diagnostics = check(source);
    expect(diagnostics.map(d => d.code)).toEqual([C.CONSTRUCT_BAD_ARG]);
    expect(diagnostics[0].message).toContain('boolean literal');
  });

  it('other unknown construction args are still MOV_CONSTRUCT_BAD_ARG', () => {
    const source = [
      'import { attio } from adapters',
      'import { acme_main } from credentials',
      'crm = attio(credentials: acme_main, dry_run: true, mystery: 1)',
    ].join('\n');
    expect(codes(source)).toEqual([C.CONSTRUCT_BAD_ARG]);
  });

  it('dry_run is filtered out before Catalog.instantiate', () => {
    const seen: Record<string, string>[] = [];
    const spyCatalog = mockCatalog({
      adapters: {
        attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }]},
      },
      credentials: { acme_main: { adapter: 'attio' } },
      instantiate: (_adapter, args) => {
        seen.push(args);
        return undefined;
      },
    });
    const program = parseProgram(
      [
        'import { attio } from adapters',
        'import { acme_main } from credentials',
        'crm = attio(credentials: acme_main, dry_run: true)',
      ].join('\n'),
    );
    expect(checkProgram(program, spyCatalog)).toEqual([]);
    expect(seen).toEqual([{ credentials: 'acme_main' }]);
  });
});
