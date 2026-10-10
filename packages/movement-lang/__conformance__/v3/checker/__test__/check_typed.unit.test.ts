// Checker tests (M2b, schema-typed layer): under full instance schemas the
// spec's worked examples check clean, and every typed diagnostic code has a
// focused negative fixture. The M2a suite (check.unit.test.ts) runs the same
// checker with a schema-less catalog — together they pin the "unknown stays
// silent" contract.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, Diagnostic, DiagnosticCodes as C } from '../check';
import { effectRowOf } from '../effects';
import { SchemaFieldType, InstanceSchema, mockCatalog, unionDisplay, unionKey } from '../catalog';
import { fieldAssignable } from '../typing';

const textList: SchemaFieldType = { kind: 'list', of: 'text' };

// ── Schemas ──

const emailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: { subject: 'text', text: 'text' },
      edges: { sender: { target: 'contact' }, files: { target: 'attachment' } },
    },
    contact: { properties: { name: 'text', email: 'text', domain: 'text' }, edges: {} },
    attachment: { properties: { filename: 'text', data: 'file' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

/** A union minted the way the ADAPTER PROJECTION mints one: a derived
 *  structural address over the member set, never a hand-written name. Nothing
 *  may parse it, so it is a second shape for every union rule below — the first
 *  (`record`) is spelled as a plain name. */
const RELATED_UNION = unionKey(['company', 'person']);

const attioSchema: InstanceSchema = {
  positions: {
    company: { properties: { Name: 'text', Domains: textList }, edges: {} },
    person: {
      properties: { Name: 'text', Email: 'text' },
      edges: { Company: { target: 'company' } },
    },
    deal: {
      properties: { Name: 'text' },
      edges: {
        Company: { target: 'company' },
        // A multi-target adapter reference: ONE edge, a union landing.
        Related: { target: RELATED_UNION, polymorphic: true, writable: true },
      },
    },
  },
  collections: { companies: { target: 'company' }, people: { target: 'person' }, deals: { target: 'deal' }, note: { target: 'note' } },
  // `subject` is a THREE-member union, so an `else if` chain has something
  // left to eliminate after the first test — two members would collapse to a
  // single position on the first `else` and prove nothing about progression.
  unions: {
    record: ['company', 'person'],
    subject: ['company', 'person', 'deal'],
    [RELATED_UNION]: ['company', 'person'],
  },
  unionDisplayNames: { [RELATED_UNION]: unionDisplay(['company', 'person']) },
  // Attio implements `updateRecord` — position writes (`write c { … }`) are
  // eligible against a traversed company/person.
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: {
        name: 'text',
        domains: textList,
        funding_stage: { kind: 'enum', options: ['Seed', 'Series A', 'Series B'] },
      },
      resultShape: { externalId: 'text', url: 'text', name: 'text', domains: textList },
    },
    note: {
      fields: { text: 'text' },
      resultShape: { externalId: 'text', url: 'text', text: 'text' },
    },
  },
};

const slackSchema: InstanceSchema = {
  positions: {
    message: { properties: { channel: 'text', text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: {
      fields: { channel: 'text', text: 'text' },
      resultShape: { externalId: 'text', channel: 'text', text: 'text' },
    },
  },
};

/** The message-write-unification shape: ONE message type, writable only
 *  along edges (`channel-[:messages]->`, `message-[:replies]->`) — no
 *  writableRoots entry, write shape in `createShapes`. */
const messagingSchema: InstanceSchema = {
  positions: {
    channel: {
      properties: {
        Id: 'text',
        Name: { kind: 'enum', options: ['dealflow', 'general'], open: {} },
      },
      edges: {
        messages: { target: 'message', writable: true },
        members: { target: 'user' },
      },
    },
    message: {
      properties: { Message: 'text', User: 'text', Channel: 'text', Timestamp: 'text' },
      edges: {
        // `replies` is a pure create path (no read API behind it) and
        // `files` is filled by the system itself — the WhatsApp/Slack File
        // duality shape (write-only edge / read-only edge).
        replies: { target: 'message', writable: true, readable: false },
        files: { target: 'file', writable: false },
        typing: { target: 'typing', writable: true, readable: false, ephemeral: true },
      },
      // The send-side `File` exists on the write shape only — reading it
      // off a received message is the caught-not-silent error.
      writeOnlyProperties: ['File'],
    },
    // `Name` is carried by TWO of the source's fields, so a read resolves to
    // the first — legal, but the author is told (MOV_AMBIGUOUS_PROPERTY).
    user: {
      properties: { Name: 'text', Email: 'text' },
      edges: {},
      ambiguousProperties: ['Name'],
    },
    file: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, Users: { target: 'user' } },
  writableRoots: {},
  createShapes: {
    message: {
      fields: { Message: 'text', File: 'file' },
      resultShape: { externalId: 'text', url: 'text', Message: 'text', File: 'file' },
      fieldDocs: { File: 'A file to send. A received message\'s files are on its files edge.' },
    },
    typing: {
      fields: {},
      resultShape: { externalId: 'text', url: 'text' },
    },
  },
};

const affinitySchema: InstanceSchema = {
  positions: {
    organization: { properties: { name: 'text', attio_url: 'text' }, edges: {} },
  },
  collections: { organizations: { target: 'organization' } },
  writableRoots: {
    organization: {
      fields: {
        name: 'text',
        attio_url: 'text',
        stage: { kind: 'enum', options: ['Pipeline', 'Won'] },
      },
      resultShape: { externalId: 'text', url: 'text', name: 'text', attio_url: 'text' },
      // Affinity decides identity itself (native domain/name matching) — a
      // movement can't author `unique by` on it.
      uniquenessAuthorable: false,
    },
  },
};

/** Regression fixture: a generic inbound-webhook source whose event
 *  carries a payload but no `text`, and which has no `message` position. The
 *  `payload` position is the honesty valve — a raw JSON bag the projection
 *  cannot enumerate, marked open. */
// `manual` is the unified on-demand source (the former `web` adapter folded
// into it). A generic source schema — its `event`/`payload` positions exercise
// position/property existence below.
const manualSchema: InstanceSchema = {
  positions: {
    event: {
      properties: { id: 'text', received_at: 'date' },
      edges: { body: { target: 'payload' } },
    },
    payload: { properties: {}, edges: {}, openProperties: true },
  },
  collections: { events: { target: 'event' } },
  writableRoots: {},
};

const dropboxSchema: InstanceSchema = {
  positions: {
    file: { properties: { name: 'text', data: 'file' }, edges: {} },
  },
  collections: { files: { target: 'file' } },
  writableRoots: {
    file: {
      fields: { name: 'text', data: 'file' },
      resultShape: { externalId: 'text', url: 'text', name: 'text' },
    },
  },
};

const kgSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', domains: textList },
      edges: {
        rounds: { target: 'funding_round', writable: true },
        related: { target: 'entity', polymorphic: true, writable: true },
        // The same edge shape keyed the way the ADAPTER PROJECTION keys one —
        // a derived address, so the write-side rules are proved against a key
        // that cannot be read as a name.
        linked: { target: RELATED_UNION, polymorphic: true, writable: true },
        investments: { target: 'investment', writable: true },
        // A CREATE-ONLY edge: the system makes the relationship by writing the
        // record, and cannot join one that already exists (Affinity's list
        // membership, a note's replies).
        entries: { target: 'entry', writable: true, linkable: false },
        attachments: { target: 'attachment' },
        mysteries: { target: 'mystery' },
        signals: { target: 'signal', writable: true },
      },
    },
    // Readable-only (no writableRoots entry) — the linked-write writability
    // gate's subject (an attio:file-style traversal target).
    attachment: { properties: { name: 'text' }, edges: {} },
    // An OPEN position (undescribed under the demand-scoped compile) — the
    // gate must stay SILENT here: open surface degrades to silence, never
    // wrong.
    mystery: { properties: {}, edges: {}, openProperties: true },
    person: {
      properties: { name: 'text', company: 'text' },
      edges: { signals: { target: 'signal', writable: true } },
    },
    // Created only at the convergence of a `signals` edge from EITHER kind of
    // parent — a required edge whose `from` is a union.
    signal: { properties: { text: 'text' }, edges: {} },
    investor: {
      properties: { name: 'text' },
      edges: { investments: { target: 'investment', writable: true } },
    },
    investment: { properties: { amount: 'number' }, edges: {} },
    funding_round: {
      properties: { stage: 'text', amount: 'number' },
      edges: { participants: { target: 'round_participation', writable: true } },
    },
    round_participation: { properties: { investor_name: 'text', lead: 'boolean' }, edges: {} },
    entry: { properties: { stage: 'text' }, edges: {} },
    deal: {
      properties: { name: 'text', company: 'text' },
      edges: { company: { target: 'company' } },
    },
  },
  collections: {
    companies: { target: 'company' },
    people: { target: 'person' },
    deals: { target: 'deal' },
    contact: { target: 'contact' },
    funding_round: { target: 'funding_round' },
    investor: { target: 'investor' },
    investment: { target: 'investment' },
    round_participation: { target: 'round_participation' },
    signal: { target: 'signal' }
  },
  unions: { entity: ['company', 'person'], [RELATED_UNION]: ['company', 'person'] },
  unionDisplayNames: { [RELATED_UNION]: unionDisplay(['company', 'person']) },
  supportsInPlaceUpdate: true,
  writableRoots: {
    company: {
      fields: {
        name: 'text',
        domains: textList,
        // An OPEN known-values field (the Slack-channel shape): listed live
        // values, id-shaped literals always legal, everything else a WARNING.
        channel: {
          kind: 'enum',
          options: ['general', 'dealflow'],
          open: { allowPattern: '^[CDG][A-Z0-9]{4,}$' },
        },
      },
      resultShape: {
        externalId: 'text',
        name: 'text',
        domains: textList,
        channel: {
          kind: 'enum',
          options: ['general', 'dealflow'],
          open: { allowPattern: '^[CDG][A-Z0-9]{4,}$' },
        },
      },
      // The KG resolves fuzzy uniqueness components by pg_trgm similarity.
      fuzzyResolution: true,
    },
    person: {
      fields: { name: 'text', company: 'text' },
      resultShape: { externalId: 'text', name: 'text', company: 'text' },
      // A required scalar — the create-gate's subject. A position write
      // (`write p { … }`) updates an existing person, so the gate must NOT
      // fire when it omits `name`; a create (`write graph-[:people]-> { … }`) must.
      requiredFields: ['name'],
    },
    investor: {
      fields: { name: 'text' },
      resultShape: { externalId: 'text', name: 'text' },
    },
    investment: {
      fields: { amount: 'number' },
      resultShape: { externalId: 'text', amount: 'number' },
      // The spec's multi-parent case: an investment requires BOTH scoping
      // parents (compound scope — `scopes: true` edges project here). The
      // two entries deliberately share the outbound edge NAME so the
      // satisfaction rule must distinguish them by parent TYPE.
      requiredEdges: [
        { edge: 'investments', from: 'company' },
        { edge: 'investments', from: 'investor' },
      ],
    },
    deal: {
      fields: { name: 'text', company: 'text' },
      resultShape: { externalId: 'text', name: 'text', company: 'text' },
    },
    signal: {
      fields: { text: 'text' },
      resultShape: { externalId: 'text', text: 'text' },
      requiredEdges: [{ edge: 'signals', from: RELATED_UNION }],
    },
    funding_round: {
      fields: { stage: 'text', amount: 'number' },
      resultShape: { externalId: 'text', stage: 'text', amount: 'number' },
    },
    round_participation: {
      fields: { investor_name: 'text', lead: 'boolean' },
      resultShape: { externalId: 'text', investor_name: 'text', lead: 'boolean' },
    },
    contact: {
      fields: { name: 'text', email: 'text', note: 'text' },
      resultShape: { externalId: 'text', name: 'text', email: 'text', note: 'text' },
      // Required scalar fields (descriptor `required` / KG identity
      // properties) — the create-form completeness check's subject.
      requiredFields: ['name', 'email'],
    },
  },
};

/** A CRM whose target declares its OWN identity rules — the declarative
 *  projection of e.g. Attio's per-attribute is_unique (`nativeUniqueness`). */
const hubspotSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', domain: 'text', city: 'text', nickname: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { name: 'text', domain: 'text', city: 'text', nickname: 'text' },
      // As the adapter projection declares every write shape: the write-event
      // facts ride the result beside the record's own fields.
      resultShape: {
        externalId: 'text',
        created: 'boolean',
        committed: 'boolean',
        name: 'text',
        domain: 'text',
        city: 'text',
      },
      nativeUniqueness: [['domain'], ['name', 'city']],
    },
  },
};

/** A registry that resolves only its NAME fields by similarity — the per-field
 *  shape of `fuzzyResolution`, beside the KG's every-field `true`. */
const registrySchema: InstanceSchema = {
  positions: {
    entity: { properties: { Name: 'text', 'Legal Name': 'text', City: 'text' }, edges: {} },
  },
  collections: { entities: { target: 'entity' } },
  writableRoots: {
    entity: {
      fields: { Name: 'text', 'Legal Name': 'text', City: 'text' },
      resultShape: { externalId: 'text', Name: 'text', 'Legal Name': 'text', City: 'text' },
      fuzzyResolution: ['Name', 'Legal Name'],
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    hubspot: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: hubspotSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }, { name: 'list', kind: 'position', required: false }],
      schema: attioSchema,
    },
    slack: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: slackSchema },
    affinity: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: affinitySchema,
    },
    dropbox: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: dropboxSchema,
    },
    manual: { constructionArgs: [], schema: manualSchema },
    messaging: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: messagingSchema,
    },
    kg: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: kgSchema,
    },
    registry: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: registrySchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_hubspot: { adapter: 'hubspot' },
    acme_main: { adapter: 'attio' },
    acme_workspace: { adapter: 'slack' },
    acme_affinity: { adapter: 'affinity' },
    team_drive: { adapter: 'dropbox' },
    team_chat: { adapter: 'messaging' },
    native_knowledge: { adapter: 'kg' },
    public_registry: { adapter: 'registry' },
  },
  plugins: {
    scrub_sensitive: { args: [] },
    vc_url_retrieval: { args: ['urls'] },
  },
});

// Error-severity diagnostics only: most fixtures declare a dispatchable
// movement without a listen, which legitimately carries an info-severity
// MOV_LISTEN_MISSING (covered in check.unit.test.ts).
const check = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => (d.severity ?? 'error') === 'error');
const codes = (source: string): string[] => check(source).map(d => d.code);
const infos = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => d.severity === 'info');
const warnings = (source: string): Diagnostic[] =>
  checkProgram(parseProgram(source), catalog).filter(d => d.severity === 'warning');

function expectClean(source: string): void {
  const diagnostics = check(source);
  expect(diagnostics.map(d => `${d.code}: ${d.message}`)).toEqual([]);
}

const PRELUDE = [
  'import { email, attio, slack, affinity, dropbox, messaging, kg } from adapters',
  'import { dealflow_inbox, acme_main, acme_workspace, acme_affinity, team_drive, team_chat, native_knowledge } from credentials',
  'import { scrub_sensitive, vc_url_retrieval } from plugins',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'team  = slack(credentials: acme_workspace)',
  'aff   = affinity(credentials: acme_affinity)',
  'drive = dropbox(credentials: team_drive)',
  'chan  = messaging(credentials: team_chat)',
  'graph = kg(credentials: native_knowledge)',
].join('\n');

const inMovement = (body: string) =>
  `${PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

describe('fieldAssignable (width-subtype of one field)', () => {
  const folderEnum: SchemaFieldType = { kind: 'enum', options: ['Sales', 'Eng'] };
  it('enum source widens to a text target', () => {
    expect(fieldAssignable(folderEnum, 'text')).toBe(true);
  });
  it('text source does NOT satisfy an enum target (the bug)', () => {
    expect(fieldAssignable('text', folderEnum)).toBe(false);
  });
  it('identical types pass', () => {
    expect(fieldAssignable('text', 'text')).toBe(true);
    expect(fieldAssignable(folderEnum, folderEnum)).toBe(true);
  });
  it('cross-category does not pass', () => {
    expect(fieldAssignable('number', 'text')).toBe(false);
  });
});

describe('traversal brackets may wrap across lines', () => {
  const hop = (h: string) =>
    inMovement(`  blk = ${h} {\n    write crm-[:companies]-> { unique by (\`name\`) name: a.\`name\` }\n  }`);

  it('a hop WHERE / ORDER BY / LIMIT wraps onto multiple lines without a parse error', () => {
    const wrapped =
      'graph-[a:Action WHERE `Status` == "Open" OR `Status` == "In Progress"\n' +
      '    ORDER BY `Priority` ASC\n' +
      '    LIMIT 20]->';
    expect(codes(hop(wrapped))).not.toContain('MOV_EXPR_PARSE');
  });

  it('an array literal inside a hop WHERE (IN […]) does not end the bracket early', () => {
    const arr = 'graph-[a:Action WHERE `Status` IN ["Foo", "Bar"]]->';
    expect(codes(hop(arr))).not.toContain('MOV_EXPR_PARSE');
  });
});

// ── Capability gating (adapter-capability-contract chunk 6) ──
//
// A source that DECLARES its filter/order/limit capability gets author-time
// gating; an undeclared surface stays silent. `cap` declares: a `companies`
// collection (native top-level query), per-field capability on the company
// position (Name/Stage/Created filterable, Notes NOT), and a `people` edge that
// is BOUNDED (the adapter filters it in memory, so any field works).
describe('hop capability gating', () => {
  const enumStage: SchemaFieldType = { kind: 'enum', options: ['Open', 'Won'] };
  const capSchema: InstanceSchema = {
    positions: {
      company: {
        properties: { Name: 'text', Notes: 'text', Stage: enumStage, Created: 'date' },
        edges: {
          people: {
            target: 'person',
            capability: { filter: 'bounded', order: 'bounded', supportsLimit: true },
          },
          // A reference the source resolves one hop along — what a path
          // ordering key walks (`ORDER BY x-[:Owner]->.`name``).
          Owner: { target: 'person' },
        },
        propertyCapabilities: {
          Name: { filterOperators: ['eq', 'contains'], orderable: true },
          Stage: { filterOperators: ['eq', 'neq', 'in'], orderable: true },
          Created: { filterOperators: ['within', 'gte', 'lte'], orderable: true },
          // Notes is a known field but declares NO capability → not filterable.
        },
      },
      // The person target declares `name` non-filterable on purpose: a BOUNDED
      // edge must still allow filtering it (the adapter runs the shared unit).
      person: {
        properties: { name: 'text' },
        edges: {},
        propertyCapabilities: { name: {} },
      },
    },
    // The root collection declares what the source can do across it, exactly as
    // the `people` edge above does — a root is a node and its collection is an
    // edge (D2). Undeclared would mean UNDECLARED, and the gate would go silent.
    collections: {
      companies: {
        target: 'company',
        capability: { filter: 'native', order: 'native', supportsLimit: true },
      },
    },
    writableRoots: {
      company: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } },
    },
  };
  const capCatalog = mockCatalog({
    adapters: { cap: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: capSchema } },
    credentials: { cap_cred: { adapter: 'cap' } },
  });
  const capPrelude = [
    'import { cap } from adapters',
    'import { cap_cred } from credentials',
    '',
    'c = cap(credentials: cap_cred)',
  ].join('\n');
  const capCodes = (body: string): string[] =>
    checkProgram(parseProgram(`${capPrelude}\nmovement main(msg: <c-[:company]->>) {\n${body}\n}`), capCatalog)
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);
  // A collection block: head traversal + a trivial body referencing the alias.
  const coll = (head: string) =>
    `  blk = ${head} {\n    return write c-[:companies]-> { unique by (\`Name\`) Name: x.\`Name\` }\n  }`;

  it('accepts a filterable field / orderable field / limit', () => {
    const codes = capCodes(coll('c-[x:companies WHERE `Name` == "Acme" ORDER BY `Name` LIMIT 5]->'));
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
    expect(codes).not.toContain('MOV_HOP_ORDER_UNSUPPORTED');
    expect(codes).not.toContain('MOV_HOP_LIMIT_UNSUPPORTED');
  });

  it('rejects filtering a non-filterable field', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Notes` == "x"]->'))).toContain(
      'MOV_HOP_FILTER_UNSUPPORTED',
    );
  });

  it('rejects an operator the field does not support (Stage WITHIN)', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Stage` WITHIN 30d]->'))).toContain(
      'MOV_HOP_FILTER_UNSUPPORTED',
    );
  });

  it('accepts WITHIN on a date field that supports it', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Created` WITHIN 30d]->'))).not.toContain(
      'MOV_HOP_FILTER_UNSUPPORTED',
    );
  });

  it('WITHIN on a date field is not a category mismatch (the duration rides as a string)', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Created` WITHIN 30d]->'))).not.toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
    expect(capCodes(coll('c-[x:companies WHERE `Created` WITHIN "12h"]->'))).not.toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
  });

  it('WITHIN with a non-duration literal is flagged', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Created` WITHIN "soon"]->'))).toContain(
      'MOV_COMPARE_TYPE_MISMATCH',
    );
  });

  it('rejects ordering by a non-orderable field', () => {
    expect(capCodes(coll('c-[x:companies WHERE `Name` == "a" ORDER BY `Notes`]->'))).toContain(
      'MOV_HOP_ORDER_UNSUPPORTED',
    );
  });

  it('rejects an impure filter (AI/EXISTS) on an unbounded native edge', () => {
    expect(capCodes(coll('c-[x:companies WHERE AI("is enterprise?") == "yes"]->'))).toContain(
      'MOV_HOP_FILTER_UNSUPPORTED',
    );
  });

  it('accepts a PURE param-read WHERE on an unbounded native edge (regression: t.firedAt)', () => {
    // `msg` is the bound param position (a company). `msg.\`Name\`` is a
    // zero-step alias-rooted traverse — a pure synchronous leaf read of a bound
    // value, NOT an AI()/EXISTS impurity. Comparing a filterable field to it
    // must NOT trip the "must run in app over an unbounded source" gate.
    const codes = capCodes(coll('c-[x:companies WHERE `Name` == msg.`Name`]->'));
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
  });

  it('accepts a PURE meta WHERE on an unbounded native edge (regression: @current_date)', () => {
    // `@current_date` parses to a `meta` node — a pure, engine-resolvable
    // ambient scalar, NOT an AI()/EXISTS impurity. Comparing a server-side
    // filterable date field to it (the UnsnoozeActions `Snoozed Until` <=
    // @current_date case) must NOT trip the "must run in app over an unbounded
    // source" gate. `Created` declares `lte` server-side filterable.
    const codes = capCodes(
      coll('c-[x:companies WHERE `Created` <= @current_date AND `Stage` == "Open"]->'),
    );
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
  });

  it('accepts a local `=` binding used inside a hop WHERE (no field/drift error)', () => {
    // `cutoff = @current_date` is a body-scoped scalar binding (the prelude
    // already binds the instance as `c`). Used bare in a hop WHERE
    // (`\`Created\` <= cutoff`), `cutoff` must resolve to the binding's value —
    // it is NOT a field of the company, so the checker must not flag it as an
    // unknown field. The comparison gates on the LEFT operand (`Created`, a
    // server-side `lte` field), so the WHERE checks clean. Mirrors the
    // UnsnoozeActions case (`\`Snoozed Until\` <= c`).
    const codes = capCodes(
      ['  cutoff = @current_date', coll('c-[x:companies WHERE `Created` <= cutoff]->')].join('\n'),
    );
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
    expect(codes).toHaveLength(0);
  });

  it('a BOUNDED edge accepts an impure filter (runs over the small in-hand set)', () => {
    const codes = capCodes(
      `  blk = msg-[p:people WHERE AI("x") == "y"]-> {\n    return write c-[:companies]-> { unique by (\`Name\`) Name: p.\`name\` }\n  }`,
    );
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
  });

  // An ordering key that is not a bare field of the landed record cannot be
  // handed to the source, so the sort runs here — a cost, said out loud, never
  // a refusal.
  const capDiags = (body: string): Diagnostic[] =>
    checkProgram(
      parseProgram(`${capPrelude}\nmovement main(msg: <c-[:company]->>) {\n${body}\n}`),
      capCatalog,
    );

  it('a path key on a native-order edge warns that the engine sorts, and refuses nothing', () => {
    const diags = capDiags(coll('c-[x:companies ORDER BY x-[:Owner]->.`name`]->'));
    const warned = diags.find(d => d.code === 'MOV_HOP_ORDER_ENGINE');
    expect(warned?.severity).toBe('warning');
    expect(warned?.message).toContain('runs here, not at the source');
    expect(diags.filter(d => (d.severity ?? 'error') === 'error')).toHaveLength(0);
  });

  it('a bare field key is still handed over — no warning, and the field gate applies', () => {
    expect(capDiags(coll('c-[x:companies ORDER BY `Name`]->')).map(d => d.code)).not.toContain(
      'MOV_HOP_ORDER_ENGINE',
    );
    expect(capCodes(coll('c-[x:companies ORDER BY `Notes`]->'))).toContain(
      'MOV_HOP_ORDER_UNSUPPORTED',
    );
  });

  it('a BOUNDED edge filters any field (the adapter runs the shared unit)', () => {
    // `name` is declared non-filterable on the person, but the people edge is
    // bounded — so no per-field gate applies.
    const codes = capCodes(
      `  blk = msg-[p:people WHERE \`name\` == "Bob"]-> {\n    write c-[:companies]-> { unique by (\`Name\`) Name: p.\`name\` }\n  }`,
    );
    expect(codes).not.toContain('MOV_HOP_FILTER_UNSUPPORTED');
  });
});

describe('unknown @meta key gating', () => {
  // A meta-field write value: `note: <@key>`. The contact note field is free
  // text, so any meta scalar is type-compatible — the only diagnostic in play
  // is the unknown-key gate.
  const withMeta = (key: string) =>
    inMovement(
      `  write crm-[:note]-> {\n    unique by (\`text\`)\n    text: ${key}\n  }`,
    );

  it('flags a legacy meta key with a did-you-mean suggestion (@current_user_email)', () => {
    const diags = check(withMeta('@current_user_email'));
    const meta = diags.find(d => d.code === 'MOV_META_UNKNOWN_KEY');
    expect(meta).toBeDefined();
    expect(meta!.message).toContain('@current_user_email');
    expect(meta!.message).toContain("Did you mean '@user_email'?");
  });

  it('flags a typo with the nearest canonical key (@actor_emial → @actor_email)', () => {
    const diags = check(withMeta('@actor_emial'));
    const meta = diags.find(d => d.code === 'MOV_META_UNKNOWN_KEY');
    expect(meta).toBeDefined();
    expect(meta!.message).toContain("Did you mean '@actor_email'?");
  });

  it('does not flag canonical meta keys', () => {
    for (const key of ['@user_email', '@actor_email', '@current_date', '@current_timestamp', '@user_name', '@user_id', '@actor_name', '@actor_id']) {
      expect(codes(withMeta(key))).not.toContain('MOV_META_UNKNOWN_KEY');
    }
  });
});

describe('comparison category type-check (MOV_COMPARE_TYPE_MISMATCH)', () => {
  // A schema whose company carries one field of each scalar category, all
  // server-side filterable, so a hop WHERE comparing them flows through the
  // comparison type-check. `Snoozed Until` is the spec's worked example field.
  const cmpSchema: InstanceSchema = {
    positions: {
      company: {
        properties: {
          Name: 'text',
          Count: 'number',
          Active: 'boolean',
          Stage: { kind: 'enum', options: ['Open', 'Won'] },
          'Snoozed Until': 'date',
          Tags: { kind: 'list', of: 'text' },
          Scores: { kind: 'list', of: 'number' },
        },
        edges: {},
        propertyCapabilities: {
          Name: { filterOperators: ['eq', 'contains'], orderable: true },
          Count: { filterOperators: ['eq', 'gte', 'lte'], orderable: true },
          Active: { filterOperators: ['eq'], orderable: true },
          Stage: { filterOperators: ['eq', 'neq'], orderable: true },
          'Snoozed Until': { filterOperators: ['eq', 'gte', 'lte'], orderable: true },
          Tags: { filterOperators: ['eq', 'contains'], orderable: false },
          Scores: { filterOperators: ['eq', 'contains'], orderable: false },
        },
      },
    },
    collections: { companies: { target: 'company' } },
    writableRoots: {
      company: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } },
    },
  };
  const cmpCatalog = mockCatalog({
    adapters: { cmp: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: cmpSchema } },
    credentials: { cmp_cred: { adapter: 'cmp' } },
  });
  const cmpPrelude = [
    'import { cmp } from adapters',
    'import { cmp_cred } from credentials',
    '',
    'c = cmp(credentials: cmp_cred)',
  ].join('\n');
  const cmpDiags = (where: string): Diagnostic[] =>
    checkProgram(
      parseProgram(
        `${cmpPrelude}\nmovement main(msg: <c-[:company]->>) {\n` +
          `  blk = c-[x:companies WHERE ${where}]-> {\n` +
          '    write c-[:companies]-> { unique by (`Name`) Name: x.`Name` }\n' +
          '  }\n}',
      ),
      cmpCatalog,
    ).filter(d => (d.severity ?? 'error') === 'error');
  const cmpCodes = (where: string): string[] => cmpDiags(where).map(d => d.code);

  it('a date field vs @current_date (date) does not flag a mismatch', () => {
    expect(cmpCodes('`Snoozed Until` <= @current_date')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('a date field vs a number literal flags a mismatch with a coercer hint', () => {
    const diag = cmpDiags('`Snoozed Until` <= 5').find(d => d.code === 'MOV_COMPARE_TYPE_MISMATCH');
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('date');
    expect(diag!.message).toContain('number');
    expect(diag!.message).toMatch(/DATE\(|DATETIME\(|NUMBER\(/);
  });

  it('a number field vs a text literal flags a mismatch (equality uses the same rule)', () => {
    expect(cmpCodes('`Count` == "text"')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  // Membership-shaped operators (CONTAINS, ==, IN) compare the ELEMENT of a
  // list operand, not the list as a structure — `Domains CONTAINS "x"` is the
  // handbook's own canonical filter and must not be a category mismatch.
  it('list-of-text CONTAINS a text literal is not a mismatch', () => {
    expect(cmpCodes('`Tags` CONTAINS "inbound"')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('list-of-text == a text literal is not a mismatch (sources match element-wise)', () => {
    expect(cmpCodes('`Tags` == "inbound"')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('list-of-number CONTAINS a text literal still mismatches (element category rules apply)', () => {
    expect(cmpCodes('`Scores` CONTAINS "high"')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('ordering operators stay strict: a list field < a literal is a mismatch', () => {
    expect(cmpCodes('`Tags` < "a"')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('coercing the text side to a number via NUMBER() clears a number comparison', () => {
    expect(cmpCodes('`Count` <= NUMBER(`Name`)')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('coercing a number field to a date via DATE() clears a date comparison', () => {
    expect(cmpCodes('`Snoozed Until` <= DATE(`Count`)')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('coercing a number field to a timestamp via DATETIME() clears a date comparison', () => {
    expect(cmpCodes('`Snoozed Until` <= DATETIME(`Count`)')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('NUMBER() over a number field clears a date comparison only when both are date (here: still a number, so a date field mismatches)', () => {
    expect(cmpCodes('`Snoozed Until` <= NUMBER(`Count`)')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('a date field compared to a bare NUMBER(...) is still flagged a category mismatch (typing wired)', () => {
    expect(cmpCodes('`Snoozed Until` <= NUMBER("42")')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('text vs enum compare clean (same textual category — option membership is pass 2)', () => {
    expect(cmpCodes('`Stage` == `Name`')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('a text literal vs an enum field compares clean (textual category)', () => {
    expect(cmpCodes('`Stage` == "Open"')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('an unknown operand stays permissive (no mismatch on a schema-underspecified side)', () => {
    // `Mystery` is not a known field; the read is untyped, so no definite mismatch.
    expect(cmpCodes('`Snoozed Until` <= AI("when?")')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });
});

// ── Enum-literal membership (MOV_ENUM_UNKNOWN_VALUE) ──
//
// A bare string LITERAL compared to, written into, or narrowed against an enum
// field takes on that enum's type and must be one of its options — a typo'd
// "Snozed" errors at author time with a did-you-mean, instead of silently never
// matching. Only LITERALS are membership-checked; a `text` field vs an enum
// field stays clean (the value isn't known at author time). One shared
// `checkEnumLiteral` helper backs all sites.
describe('enum-literal membership (MOV_ENUM_UNKNOWN_VALUE)', () => {
  // `Status` enum on a writable position, so the same fixture covers compare
  // (hop WHERE) AND write. Options include the spec's worked example values.
  const enumStatus: SchemaFieldType = { kind: 'enum', options: ['Snoozed', 'Open', 'Closed'] };
  const enumSchema: InstanceSchema = {
    positions: {
      ticket: {
        properties: { Title: 'text', Status: enumStatus },
        edges: {},
        propertyCapabilities: {
          Title: { filterOperators: ['eq', 'contains'], orderable: true },
          Status: { filterOperators: ['eq', 'neq', 'in'], orderable: true },
        },
      },
    },
    collections: { tickets: { target: 'ticket' } },
    supportsInPlaceUpdate: true,
    unions: { thing: ['ticket'] },
    writableRoots: {
      ticket: {
        fields: { Title: 'text', Status: enumStatus },
        resultShape: { externalId: 'text', Title: 'text', Status: enumStatus },
      },
    },
  };
  const enumCatalog = mockCatalog({
    adapters: {
      ce: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: enumSchema },
    },
    credentials: { ce_cred: { adapter: 'ce' } },
  });
  const enumPrelude = [
    'import { ce } from adapters',
    'import { ce_cred } from credentials',
    '',
    'c = ce(credentials: ce_cred)',
  ].join('\n');
  const enumDiags = (body: string): Diagnostic[] =>
    checkProgram(parseProgram(`${enumPrelude}\nmovement main(msg: <c-[:ticket]->>) {\n${body}\n}`), enumCatalog)
      .filter(d => (d.severity ?? 'error') === 'error');
  const enumCodes = (body: string): string[] => enumDiags(body).map(d => d.code);
  // A hop WHERE block (compare site).
  const whereBlk = (where: string) =>
    `  blk = c-[x:tickets WHERE ${where}]-> {\n    write x { Status: "Open" }\n  }`;

  // ── compare ──
  it('a valid enum option compares clean', () => {
    expect(enumCodes(whereBlk('`Status` == "Snoozed"'))).not.toContain('MOV_ENUM_UNKNOWN_VALUE');
  });

  it('a typo flags MOV_ENUM_UNKNOWN_VALUE with a did-you-mean', () => {
    const diag = enumDiags(whereBlk('`Status` == "Snozed"')).find(
      d => d.code === 'MOV_ENUM_UNKNOWN_VALUE',
    );
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('"Snozed"');
    expect(diag!.message).toContain('Snoozed | Open | Closed');
    expect(diag!.message).toContain('Did you mean "Snoozed"?');
  });

  it('a not-equal compare is membership-checked too', () => {
    expect(enumCodes(whereBlk('`Status` != "Snozed"'))).toContain('MOV_ENUM_UNKNOWN_VALUE');
  });

  it('the literal-on-the-left side is checked symmetrically', () => {
    expect(enumCodes(whereBlk('"Snozed" == `Status`'))).toContain('MOV_ENUM_UNKNOWN_VALUE');
  });

  it('a text FIELD vs the enum field stays clean (only literals are membership-checked)', () => {
    expect(enumCodes(whereBlk('`Status` == `Title`'))).not.toContain('MOV_ENUM_UNKNOWN_VALUE');
  });

  it('an unknown literal with no close option still errors, without a suggestion', () => {
    const diag = enumDiags(whereBlk('`Status` == "Wibble"')).find(
      d => d.code === 'MOV_ENUM_UNKNOWN_VALUE',
    );
    expect(diag).toBeDefined();
    expect(diag!.message).not.toContain('Did you mean');
  });

  // ── write / assignment ──
  it('a valid enum literal written to an enum field checks clean', () => {
    expect(enumCodes('  write c-[:tickets]-> { Title: "t", Status: "Open" }')).not.toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it('a typo written to an enum field flags MOV_ENUM_UNKNOWN_VALUE with a suggestion', () => {
    const diag = enumDiags('  write c-[:tickets]-> { Title: "t", Status: "Opan" }').find(
      d => d.code === 'MOV_ENUM_UNKNOWN_VALUE',
    );
    expect(diag).toBeDefined();
    expect(diag!.message).toContain('"Opan"');
    expect(diag!.message).toContain('Did you mean "Open"?');
  });
});

// ── An EMPTY enum domain (MOV_ENUM_EMPTY_DOMAIN) ──
//
// A closed enum with no options is the empty union — TypeScript's `never`. It
// accepts NOTHING, not everything. The regression this guards: an empty domain
// projected as `text`, so `{ listName: "Absolutely No Such List" }` provisioned
// VALID and died at run time. Silent degradation, at exactly the moment the
// author is told it's safe.
describe('empty enum domain (MOV_ENUM_EMPTY_DOMAIN)', () => {
  // Deliberately NOT Attio-shaped: a fixture that matches the reporting
  // adapter can't tell derived behaviour from hardcoded behaviour.
  const emptyEnum: SchemaFieldType = { kind: 'enum', options: [] };
  const emptySchema: InstanceSchema = {
    positions: {
      badge: {
        properties: { Label: 'text', Tier: emptyEnum },
        edges: {},
        propertyCapabilities: { Tier: { filterOperators: ['eq'], orderable: false } },
      },
    },
    collections: { badges: { target: 'badge' } },
    supportsInPlaceUpdate: true,
    unions: { thing: ['badge'] },
    writableRoots: {
      badge: {
        fields: { Label: 'text', Tier: emptyEnum },
        resultShape: { externalId: 'text', Label: 'text' },
      },
    },
  };
  const emptyCatalog = mockCatalog({
    adapters: {
      ee: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emptySchema },
    },
    credentials: { ee_cred: { adapter: 'ee' } },
  });
  const emptyDiags = (body: string): Diagnostic[] =>
    checkProgram(
      parseProgram(
        [
          'import { ee } from adapters',
          'import { ee_cred } from credentials',
          '',
          'c = ee(credentials: ee_cred)',
          'movement main(msg: <c-[:badge]->>) {',
          body,
          '}',
        ].join('\n'),
      ),
      emptyCatalog,
    ).filter(d => (d.severity ?? 'error') === 'error');
  const emptyCodes = (body: string): string[] => emptyDiags(body).map(d => d.code);

  it('a literal written into an empty-domain field is REJECTED', () => {
    expect(emptyCodes('  write c-[:badges]-> { Label: "l", Tier: "Gold" }')).toContain(
      'MOV_ENUM_EMPTY_DOMAIN',
    );
  });

  it('the message says the domain is empty, and does not send the author hunting for a typo', () => {
    const diag = emptyDiags('  write c-[:badges]-> { Label: "l", Tier: "Gold" }').find(
      d => d.code === 'MOV_ENUM_EMPTY_DOMAIN',
    );
    expect(diag).toBeDefined();
    // Names the field being written, not just the type.
    expect(diag!.message).toContain("'Tier'");
    expect(diag!.message).toContain('no values to choose from');
    expect(diag!.message).toContain('not a typo');
    expect(diag!.message).not.toContain('Did you mean');
    // The useless "expected one of: ()" must not be what the author reads.
    expect(emptyCodes('  write c-[:badges]-> { Label: "l", Tier: "Gold" }')).not.toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it('a NON-literal value is rejected too — no value could have been right', () => {
    expect(emptyCodes('  write c-[:badges]-> { Label: "l", Tier: AI("which tier?") }')).toContain(
      'MOV_ENUM_EMPTY_DOMAIN',
    );
  });

  it('a comparison against an empty-domain field is rejected (it can never match)', () => {
    expect(
      emptyCodes(
        '  blk = c-[x:badges WHERE `Tier` == "Gold"]-> {\n    write x { Label: "l" }\n  }',
      ),
    ).toContain('MOV_ENUM_EMPTY_DOMAIN');
  });

  it('a write that leaves the empty-domain field alone is unaffected', () => {
    expect(emptyCodes('  write c-[:badges]-> { Label: "l" }')).not.toContain(
      'MOV_ENUM_EMPTY_DOMAIN',
    );
  });

  it('an OPEN known-values field with nothing listed stays SILENT (unknown domain, not an empty one)', () => {
    const openSchema: InstanceSchema = {
      ...emptySchema,
      writableRoots: {
        badge: {
          fields: { Label: 'text', Tier: { kind: 'enum', options: [], open: {} } },
          resultShape: { externalId: 'text', Label: 'text' },
        },
      },
    };
    const openCatalog = mockCatalog({
      adapters: {
        ee: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: openSchema },
      },
      credentials: { ee_cred: { adapter: 'ee' } },
    });
    const codes = checkProgram(
      parseProgram(
        [
          'import { ee } from adapters',
          'import { ee_cred } from credentials',
          '',
          'c = ee(credentials: ee_cred)',
          'movement main(msg: <c-[:badge]->>) {',
          '  write c-[:badges]-> { Label: "l", Tier: "Gold" }',
          '}',
        ].join('\n'),
      ),
      openCatalog,
    ).map(d => d.code);
    expect(codes).not.toContain('MOV_ENUM_EMPTY_DOMAIN');
  });
});

describe('meta key typing', () => {
  // Compare a meta key against a typed company field through a hop WHERE: the
  // mismatch only appears when the meta key's inferred type clashes with the
  // field's category — so these assert meta keys infer the right types.
  const cmpSchema: InstanceSchema = {
    positions: {
      company: {
        properties: { Name: 'text', 'Snoozed Until': 'date' },
        edges: {},
        propertyCapabilities: {
          Name: { filterOperators: ['eq'], orderable: true },
          'Snoozed Until': { filterOperators: ['eq', 'gte', 'lte'], orderable: true },
        },
      },
    },
    collections: { companies: { target: 'company' } },
    writableRoots: {
      company: { fields: { Name: 'text' }, resultShape: { externalId: 'text', Name: 'text' } },
    },
  };
  const cmpCatalog = mockCatalog({
    adapters: { cmp: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: cmpSchema } },
    credentials: { cmp_cred: { adapter: 'cmp' } },
  });
  const cmpPrelude = [
    'import { cmp } from adapters',
    'import { cmp_cred } from credentials',
    '',
    'c = cmp(credentials: cmp_cred)',
  ].join('\n');
  const cmpCodes = (where: string): string[] =>
    checkProgram(
      parseProgram(
        `${cmpPrelude}\nmovement main(msg: <c-[:company]->>) {\n` +
          `  blk = c-[x:companies WHERE ${where}]-> {\n` +
          '    write c-[:companies]-> { unique by (`Name`) Name: x.`Name` }\n' +
          '  }\n}',
      ),
      cmpCatalog,
    )
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);

  it('@current_date is a date (compares clean to a date field)', () => {
    expect(cmpCodes('`Snoozed Until` <= @current_date')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('@current_timestamp is a datetime (temporal — compares clean to a date field)', () => {
    expect(cmpCodes('`Snoozed Until` <= @current_timestamp')).not.toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('@user_email is text (mismatch against a date field)', () => {
    expect(cmpCodes('`Snoozed Until` == @user_email')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });

  it('@current_date is text-incompatible against a text field too (date vs text)', () => {
    expect(cmpCodes('`Name` == @current_date')).toContain('MOV_COMPARE_TYPE_MISMATCH');
  });
});

describe('extract annotation suggestion', () => {
  // A field that IS annotated must not be told to "annotate it" just because
  // the annotation didn't resolve here (a missing schema / a bad borrow path):
  // the author already constrained it, and the engine re-resolves live.
  const src = inMovement(
    '  d = extract from [msg.`subject`] {\n' +
      '    node co: "a company" {\n' +
      '      nm: <crm-[:company]->.nonexistent_field> "the name"\n' +
      '    }\n' +
      '  }\n' +
      '  d-[c:co]-> {\n' +
      '    write crm-[:companies]-> { unique by (`name`) name: c.nm }\n' +
      '  }',
  );

  it('does not suggest annotating a field that already carries an annotation', () => {
    expect(infos(src).map(d => d.code)).not.toContain('MOV_EXTRACT_ANNOTATE');
  });
});

// ── Positive: the worked examples are clean under FULL schemas ──

describe('worked examples under full schemas (zero diagnostics)', () => {
  it('§I dealflow_intake', () => {
    expectClean(
      [
        PRELUDE,
        '',
        'company_prompt = "the company name this email is about.',
        '  Prefer the legal entity name over the brand name;',
        "  ignore the sender's own firm.\"",
        '',
        'movement dealflow_intake(msg: <inbox-[:message]->>) {',
        '',
        '  company = write crm-[:companies]-> {',
        '    unique by (`domains`)',
        '    name:    AI(company_prompt)',
        '    domains: [msg-[:sender]->.`domain`]',
        '  }',
        '',
        '  await parallel([',
        '    () => {',
        '      write team-[:messages]-> {',
        '        channel: "#dealflow"',
        '        text:    "New deal from ${msg-[:sender]->.`name`}: ${company.`url`}"',
        '      }',
        '    },',
        '    () => {',
        '      write aff-[:organizations]-> {',
        '        name:      company.`name`',
        '        attio_url: company.`url`',
        '      }',
        '    },',
        '  ])',
        '}',
      ].join('\n'),
    );
  });

  it('§I log_dealflow (extract tree + nested linked writes into kg)', () => {
    expectClean(
      [
        PRELUDE,
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
        '          lead: <boolean> "whether this investor is leading the round"',
        '        }',
        '      }',
        '    }',
        '  }',
        '',
        '  deals-[c:company]-> {',
        '    co = write graph-[:companies]-> {',
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
        '          lead ?:        i.`lead`',
        '        }',
        '      }',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('§E nightly_mirror (meta position, collections, typed kg writes)', () => {
    expectClean(
      [
        PRELUDE,
        '',
        'movement nightly_mirror(root: <crm>) {',
        '',
        '  root-[c:companies]-> {',
        '    write graph-[:companies]-> { unique by (`domains`), name: c.`Name`, domains: c.`Domains` }',
        '  }',
        '',
        '  root-[d:deals]-> {',
        '    write graph-[:deals]-> {',
        '      unique by (`name`)',
        '      name:    d.`Name`',
        // FIRST can come up empty (a deal with no company, a company with no
        // domain), so the field is a `?:` fill — the write omits it rather than
        // silently landing a null.
        '      company ?: ONLY(d-[:Company]->.`Domains`)',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('§F attio_to_kg (IS narrowing over the record union)', () => {
    expectClean(
      [
        PRELUDE,
        '',
        'movement attio_to_kg(rec: <crm-[:record]->>) {',
        '  if rec IS <crm-[:company]->> {',
        '    write graph-[:companies]-> { unique by (`domains`), name: rec.`Name`, domains: rec.`Domains` }',
        '  } else if rec IS <crm-[:person]->> AND EXISTS(rec-[:Company]->) {',
        '    write graph-[:people]-> { name: rec.`Name`, company: rec-[:Company]->.`Name` }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('§C _resources block + extract + a block that returns its written record', () => {
    expectClean(
      inMovement(
        [
          '  msg-[file:_resources WHERE `contentType` == "application/pdf"]-> {',
          '    write drive-[:files]-> {',
          '      name: file.`filename`',
          '      data: file.`data`',
          '    }',
          '  }',
          '',
          '  mentioned = extract from [msg.`text`] {',
          '    node company: "each company mentioned" {',
          '      name: "the company\'s name"',
          '    }',
          '  }',
          '',
          '  orgs = mentioned-[c:company]-> {',
          '    return write crm-[:companies]-> {',
          '      unique by (`name`)',
          '      name: c.`name`',
          '    }',
          '  }',
          '',
          '  write team-[:messages]-> {',
          '    channel: "#deals"',
          '    text: "Logged ${COUNT(mentioned-[:company]->)} companies. Urls: ${orgs.`url`}"',
          '  }',
        ].join('\n'),
      ),
    );
  });

  it('Layer 5 — `_resources` off an EXTRACTED node (carry the source file forward)', () => {
    // The extracted node's `_resources` is the SOURCE CONTENT that fed its
    // extraction (provenance). A movement extracts from a file, then walks the
    // extracted node's `_resources` to write the source file forward to a file
    // field — the carry-source-forward use case.
    expectClean(
      inMovement(
        [
          '  deck = extract from [msg-[:files]->.`data`] {',
          '    node company: "each company in the deck" {',
          '      name: "the company\'s name"',
          '    }',
          '  }',
          '',
          '  deck-[file:_resources WHERE `contentType` == "application/pdf"]-> {',
          '    write drive-[:files]-> {',
          '      name: file.`name`',
          '      data: file.`file`',
          '    }',
          '  }',
        ].join('\n'),
      ),
    );
  });

  it('§G node declarations and composition by call', () => {
    expectClean(
      [
        PRELUDE,
        '',
        'node Files {',
        '  name: <text>',
        '  data: <file>',
        '}',
        '',
        'node Deal {',
        '  name:   <text>',
        '  amount: <number>',
        '  node participants {',
        '    name: <text>',
        '  }',
        '}',
        '',
        'movement files_to_dropbox(f: <Files>) {',
        '  write drive-[:files]-> {',
        '    name: f.`name`',
        '    data: f.`data`',
        '  }',
        '}',
        '',
        'movement intake(msg: <inbox-[:message]->>) {',
        '  d = node { name: "Series A", amount: 5000000, participants: node { name: "Acme Ventures" } }',
        '',
        '  msg-[f:_resources]-> {',
        '    files_to_dropbox(f: node { name: f.`filename`, data: f.`data` })',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('an instance-position handle passes to a parameter of that instance', () => {
    expectClean(
      [
        PRELUDE,
        'movement sync(co: <crm-[:company]->>) {',
        '  …',
        '}',
        'movement main(msg: <inbox-[:message]->>) {',
        '  company = write crm-[:companies]-> { name: msg.`subject` }',
        '  sync(co: company)',
        '}',
      ].join('\n'),
    );
  });

  it('MOV_UNKNOWN_PROPERTY: typed positions are CLOSED — an unknown read on a handle errors, listing what it carries', () => {
    const diagnostics = check(
      inMovement(
        [
          '  company = write crm-[:companies]-> { name: msg.`subject` }',
          '  write team-[:messages]-> { channel: "#d", text: company.`not_in_result_shape` }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(diagnostics[0].message).toContain('externalId');
  });

  it('top-level extract fields are properties of the result root', () => {
    expectClean(
      inMovement(
        [
          '  info = extract from [msg.`text`] {',
          '    sentiment: "the message\'s overall sentiment"',
          '  }',
          '  write team-[:messages]-> { channel: "#d", text: info.`sentiment` }',
        ].join('\n'),
      ),
    );
    expect(
      codes(
        inMovement(
          [
            '  info = extract from [msg.`text`] {',
            '    sentiment: "the message\'s overall sentiment"',
            '  }',
            '  write team-[:messages]-> { channel: "#d", text: info.`sentimnt` }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.EXTRACT_UNKNOWN_FIELD]);
  });

  it('handle types survive being written and read inside one combinator arm', () => {
    expectClean(
      inMovement(
        [
          '  await parallel([',
          '    () => {',
          '      co = write crm-[:companies]-> { name: msg.`subject` }',
          '      write team-[:messages]-> { channel: "#d", text: "${co.`url`}" }',
          '    },',
          '    () => { write crm-[:note]-> { text: msg.`text` } },',
          '  ])',
        ].join('\n'),
      ),
    );
  });

  it('_resources positions are untyped — reads through them stay silent', () => {
    expectClean(
      inMovement(
        [
          '  msg-[f:_resources]-> {',
          '    write drive-[:files]-> { name: f.`anything_at_all`, data: f.`whatever` }',
          '  }',
        ].join('\n'),
      ),
    );
  });
});

// ── Position & property existence (strict where the schema is known) ──

// Unified on-demand source: `web()` folded into `manual()` (the merge in
// services/translation_graph/adapters/manual). The fixture binds the manual
// source's positions.
const WEB_PRELUDE = [
  'import { manual, attio } from adapters',
  'import { acme_main } from credentials',
  '',
  'input = manual()',
  'crm   = attio(credentials: acme_main)',
].join('\n');

describe('position existence (MOV_UNKNOWN_POSITION)', () => {
  it("regression: a parameter naming a position the known schema lacks errors, listing available positions", () => {
    const diagnostics = check(
      [
        WEB_PRELUDE,
        'movement SyncToAttio(item: <input-[:message]->>) {',
        '  write crm-[:companies]-> { name: item.`text` }',
        '}',
      ].join('\n'),
    );
    // Exactly one error: the parameter degrades to untyped, so item.`text`
    // does not pile a second diagnostic on top.
    expect(diagnostics.map(d => d.code)).toEqual([C.UNKNOWN_POSITION]);
    expect(diagnostics[0].message).toContain("'input' has no position type 'message'");
    expect(diagnostics[0].message).toContain('event');
  });

  it('a union name in a parameter TypeRef is a position type (no error)', () => {
    expectClean(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  write graph-[:companies]-> { name: rec.`Name` }',
        '}',
      ].join('\n'),
    );
  });

  it('an imported library movement parameter naming an absent position surfaces at the import', () => {
    // Covered structurally by imports.unit.test.ts; here the same checker
    // runs the declaration directly in a nested scope.
    expect(
      codes(
        [
          PRELUDE,
          'movement outer(msg: <inbox-[:message]->>) {',
          '  …',
          '}',
          'movement inner(x: <crm-[:organisation]->>) {',
          '  …',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.UNKNOWN_POSITION]);
  });

  it('an IS test naming an absent position errors', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  if rec IS <crm-[:organisation]->> {',
        '    write graph-[:companies]-> { name: rec.`Name` }',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.UNKNOWN_POSITION]);
    expect(diagnostics[0].message).toContain("'crm' has no position type 'organisation'");
  });

  // The meta-node is dead: a declaration IS its root node, so the old hop
  // through it names a graph that no longer exists.
  it('a type annotation that hops through a declaration is refused, with the fix', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'node Deal {',
        '  name: <text>',
        '}',
        'movement main(d: <Deal-[:item]->>) {',
        '  …',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.SHAPE_HOP_RETIRED]);
    expect(diagnostics[0].message).toContain("write '<Deal>'");
  });
});

describe('property existence (MOV_UNKNOWN_PROPERTY)', () => {
  it("regression: a typed position lacking the read field errors, listing what it has", () => {
    const diagnostics = check(
      [
        WEB_PRELUDE,
        'movement SyncToAttio(item: <input-[:event]->>) {',
        '  write crm-[:companies]-> { name: item.`text` }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(diagnostics[0].message).toContain("input.event has no field 'text'");
    expect(diagnostics[0].message).toContain('received_at');
  });

  it('openProperties is the honesty valve — reads through the raw payload bag stay silent', () => {
    expectClean(
      [
        WEB_PRELUDE,
        'movement SyncToAttio(item: <input-[:event]->>) {',
        '  write crm-[:companies]-> { name: item-[:body]->.`whatever_the_sender_posted` }',
        '}',
      ].join('\n'),
    );
  });

  it("a field no union variant declares errors, listing the variants' fields", () => {
    const diagnostics = check(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  write graph-[:companies]-> { name: rec.`Ghost` }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(diagnostics[0].message).toContain('no variant');
    expect(diagnostics[0].message).toContain('Email');
  });

  it('unknown reads error mid-expression too (interpolation)', () => {
    expect(
      codes(
        inMovement(
          '  write team-[:messages]-> { channel: "#d", text: "subject: ${msg.`subjct`}" }',
        ),
      ),
    ).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('bare property reads check identically to backticked ones', () => {
    expect(
      codes(inMovement('  write team-[:messages]-> { channel: "#d", text: msg.subjct }')),
    ).toEqual([C.UNKNOWN_PROPERTY]);
    expectClean(
      inMovement('  write team-[:messages]-> { channel: "#d", text: msg-[:sender]->.domain }'),
    );
  });
});

// ── Writes (check 2) ──

describe('typed writes', () => {
  it('MOV_WRITE_UNKNOWN_ROOT for a root the instance does not accept', () => {
    const diagnostics = check(inMovement('  write crm-[:organizations]-> { name: "Acme" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.LINKED_UNKNOWN_EDGE]);
    expect(diagnostics[0].message).toContain('companies');
  });

  it('MOV_WRITE_UNKNOWN_FIELD for a field the root does not declare', () => {
    const diagnostics = check(inMovement('  write crm-[:companies]-> { nam: "Acme" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain("'nam'");
  });

  it('MOV_WRITE_FIELD_TYPE when the expression type contradicts the field', () => {
    const diagnostics = check(
      inMovement('  write graph-[:funding_round]-> { stage: "Seed", amount: "a lot of money" }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_FIELD_TYPE]);
    expect(diagnostics[0].message).toMatch(/number/);
  });

  it('MOV_UNIQUE_UNKNOWN_FIELD for an identity component missing from the root', () => {
    expect(codes(inMovement('  write crm-[:companies]-> { unique by (`nam`), name: "Acme" }'))).toEqual([
      C.UNIQUE_UNKNOWN_FIELD,
    ]);
  });
});

// ── Position writes (`write a { … }`) — update the record bound at the
//    alias in place. A write result IS a position, so a traversal alias (or
//    a prior write result) is an update target when its adapter can update
//    records by id. ──

describe('position writes (`write a { … }`)', () => {
  it('a traversed kg node updated in place checks clean', () => {
    expectClean(inMovement('  graph-[c:companies]-> {\n    write c { name: "Renamed" }\n  }'));
  });

  it('a traversed adapter record updated in place checks clean', () => {
    expectClean(inMovement('  crm-[c:companies]-> {\n    write c { name: "Renamed" }\n  }'));
  });

  it('does NOT run the required-field create-gate (the record already exists)', () => {
    // `person` requires `name` on CREATE; an in-place update may omit it.
    expectClean(inMovement('  graph-[p:people]-> {\n    write p { company: "Acme" }\n  }'));
    // Contrast: the same omission on a CREATE is the gate's subject.
    expect(codes(inMovement('  write graph-[:people]-> { company: "Acme" }'))).toEqual([
      C.WRITE_MISSING_REQUIRED_FIELD,
    ]);
  });

  it('MOV_WRITE_POSITION_NO_UPDATE when the adapter cannot update in place', () => {
    // dropbox declares no `updateRecord` (append-only) → its schema has no
    // `supportsInPlaceUpdate`, so a position write against it is rejected.
    const diagnostics = check(inMovement('  drive-[f:files]-> {\n    write f { name: "x" }\n  }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_POSITION_NO_UPDATE]);
    expect(diagnostics[0].message).toContain('update');
  });

  it('MOV_WRITE_POSITION_UNIQUE rejects `unique by` on a position write', () => {
    const diagnostics = check(
      inMovement('  graph-[c:companies]-> {\n    write c { unique by (`name`)\n      name: "x" }\n  }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_POSITION_UNIQUE]);
  });

  it('MOV_WRITE_POSITION_NOT_RECORD when the alias is not a record position', () => {
    // `crm` resolves to the instance's meta position — not a single record.
    const diagnostics = check(inMovement('  write crm { name: "x" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_POSITION_NOT_RECORD]);
  });

  it('MOV_WRITE_UNKNOWN_FIELD still fires against the position’s writable schema', () => {
    expect(codes(inMovement('  graph-[c:companies]-> {\n    write c { nope: "x" }\n  }'))).toEqual([
      C.WRITE_UNKNOWN_FIELD,
    ]);
  });
});

// ── Bound writes (`write … bind other { … }`) — engine-owned
//    correspondence between the written record and `other`'s record. ──

describe('bound writes (`write … bind other { … }`)', () => {
  it('a create bound to a traversed source record checks clean', () => {
    expectClean(
      inMovement('  crm-[c:companies]-> {\n    write graph-[:companies]-> bind c { name: "x" }\n  }'),
    );
  });

  it('MOV_WRITE_BIND_NOT_RECORD when the bind target is not a record position', () => {
    // `crm` resolves to the instance meta position — not a single record.
    const diagnostics = check(inMovement('  write graph-[:companies]-> bind crm { name: "x" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_BIND_NOT_RECORD]);
  });

  it('MOV_WRITE_BIND_UNIQUE rejects `unique by` together with `bind`', () => {
    const diagnostics = check(
      inMovement(
        '  crm-[c:companies]-> {\n    write graph-[:companies]-> bind c { unique by (`name`)\n      name: "x" }\n  }',
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_BIND_UNIQUE]);
  });

  it('MOV_WRITE_BIND_POSITION rejects `bind` on a position write', () => {
    const diagnostics = check(
      inMovement('  graph-[c:companies]-> {\n    write c bind c { name: "x" }\n  }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_BIND_POSITION]);
  });

  it('NAME_UNRESOLVED when the bind name is not in scope', () => {
    expect(codes(inMovement('  write graph-[:companies]-> bind ghost { name: "x" }'))).toEqual([
      C.NAME_UNRESOLVED,
    ]);
  });

  it('still runs the required-field create-gate on a bound write (a create can still happen)', () => {
    // `person` requires `name` on create; a bound write may still mint a
    // fresh record (self-heal), so the gate stands.
    expect(
      codes(inMovement('  crm-[c:companies]-> {\n    write graph-[:people]-> bind c { company: "Acme" }\n  }')),
    ).toEqual([C.WRITE_MISSING_REQUIRED_FIELD]);
  });
});

// ── The instance-param door: a write/link target roots at a graph this
//    file declares (a constructed instance, kg, or a shape) — never at a
//    parameter. Instances don't pass between movements (schemas are
//    per-credential), so writing "through" a parameter is an error, not
//    a silent skip. ──

describe('the instance-param door (MOV_WRITE_TARGET_NOT_GRAPH)', () => {
  const DOOR_PHRASE = "construct the instance in this file — instances don't pass between movements";

  it('a meta-typed parameter as an instance-form write target errors', () => {
    const diagnostics = check(
      `${PRELUDE}\nmovement publish(root: <crm>) {\n  write root-[:companies]-> { name: "Acme" }\n}`,
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_TARGET_NOT_GRAPH]);
    expect(diagnostics[0].message).toContain(DOOR_PHRASE);
  });

  it('a linked write off a position param errors on an edge that position lacks', () => {
    expect(
      codes(`${PRELUDE}\nmovement main(rec: <crm-[:person]->>) {\n  write rec-[:companies]-> { name: "Acme" }\n}`),
    ).toEqual([C.LINKED_UNKNOWN_EDGE]);
  });

  it('a meta-typed parameter as a linked-write path root errors', () => {
    const diagnostics = check(
      `${PRELUDE}\nmovement publish(root: <crm>) {\n  write root-[:companies]-> { name: "Acme" }\n}`,
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_TARGET_NOT_GRAPH]);
    expect(diagnostics[0].message).toContain(DOOR_PHRASE);
  });

  it('a meta-typed parameter as a match root errors', () => {
    expect(
      codes(
        `${PRELUDE}\nmovement publish(root: <crm>) {\n  match root-[:companies]-> { unique by (\`name\`), name: "Acme" }\n}`,
      ),
    ).toEqual([C.WRITE_TARGET_NOT_GRAPH]);
  });

  it('meta-typed parameters as tuple-write path roots error per path', () => {
    expect(
      codes(
        `${PRELUDE}\nmovement publish(root: <crm>) {\n  write (root-[:companies]->, root-[:deals]->) { name: "Acme" }\n}`,
      ),
    ).toEqual([C.WRITE_TARGET_NOT_GRAPH, C.WRITE_TARGET_NOT_GRAPH]);
  });

  it('the backfill READ shape stays clean — the param is traversed, writes name own graphs', () => {
    expectClean(
      [
        PRELUDE,
        'movement nightly(root: <crm>) {',
        '  root-[c:companies]-> {',
        '    write graph-[:companies]-> { unique by (`name`), name: c.Name }',
        '  }',
        '}',
      ].join('\n'),
    );
  });
});

// ── Linked writes (check 5) ──

describe('open known-values fields (MOV_VALUE_UNLISTED)', () => {
  const write = (value: string) =>
    inMovement(`  write graph-[:companies]-> { name: "Acme", channel: ${value} }`);

  it('a known value is clean', () => {
    expectClean(write('"dealflow"'));
  });

  it('an unknown literal WARNS (never gates) with a did-you-mean', () => {
    expect(codes(write('"dealflw"'))).toEqual([]); // no ERROR — a warning never gates
    const warned = warnings(write('"dealflw"'));
    expect(warned.map(d => d.code)).toEqual(['MOV_VALUE_UNLISTED']);
    expect(warned[0].message).toContain('Did you mean "dealflow"?');
    expect(warned[0].message).toContain('may be incomplete');
  });

  it('an id-shaped literal is clean (allowPattern)', () => {
    expectClean(write('"C0123ABCD"'));
    expect(warnings(write('"C0123ABCD"'))).toEqual([]);
  });

  it('a computed value stays silent', () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { name: "Acme" }',
        '  write graph-[:companies]-> { name: "Acme", channel: "team-${co.`name`}" }',
      ].join('\n'),
    );
    expect(codes(source)).toEqual([]);
    expect(warnings(source)).toEqual([]);
  });

  it('comparisons against the open field warn on unknown literals too', () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { name: "Acme" }',
        '  if co.`channel` == "dealflw" {',
        '    write graph-[:people]-> { name: "x" }',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).toEqual([]);
    expect(warnings(source).map(d => d.code)).toEqual(['MOV_VALUE_UNLISTED']);
  });
});

describe('linked writes', () => {
  const withCompany = (rest: string) =>
    inMovement(['  co = write graph-[:companies]-> { name: "Acme" }', rest].join('\n'));

  it('MOV_LINKED_UNKNOWN_EDGE when the parent type lacks the edge', () => {
    const diagnostics = check(withCompany('  write co-[:typo]-> { stage: "Seed" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.LINKED_UNKNOWN_EDGE]);
    expect(diagnostics[0].message).toContain('rounds');
  });

  it('MOV_LINKED_NEEDS_TYPE for a polymorphic edge without an explicit type', () => {
    expect(codes(withCompany('  write co-[:related]-> { name: "Jane" }'))).toEqual([
      C.LINKED_NEEDS_TYPE,
    ]);
  });

  it('a polymorphic edge with an explicit variant type is clean', () => {
    expectClean(withCompany('  write co-[:related]-><person> { name: "Jane" }'));
  });

  it('MOV_LINKED_TYPE_MISMATCH when the explicit type contradicts a non-polymorphic edge', () => {
    const diagnostics = check(withCompany('  write co-[:rounds]-><company> { name: "x" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.LINKED_TYPE_MISMATCH]);
    expect(diagnostics[0].message).toContain('funding_round');
  });

  it('MOV_LINKED_TYPE_MISMATCH when the explicit type is not a variant of a polymorphic target', () => {
    expect(codes(withCompany('  write co-[:related]-><funding_round> { stage: "Seed" }'))).toEqual([
      C.LINKED_TYPE_MISMATCH,
    ]);
  });

  // The same three rules against a DERIVED union key — the shape the adapter
  // projection produces. The key is opaque, so nothing may read it back to the
  // author: the mismatch names the union's DISPLAY.
  it('a derived-key polymorphic edge demands the explicit type just the same', () => {
    expect(codes(withCompany('  write co-[:linked]-> { name: "Jane" }'))).toEqual([
      C.LINKED_NEEDS_TYPE,
    ]);
  });

  it('a derived-key polymorphic edge accepts an explicit variant', () => {
    expectClean(withCompany('  write co-[:linked]-><person> { name: "Jane" }'));
  });

  it('a derived-key mismatch reads out the union DISPLAY, never the key', () => {
    const diagnostics = check(
      withCompany('  write co-[:linked]-><funding_round> { stage: "Seed" }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.LINKED_TYPE_MISMATCH]);
    expect(diagnostics[0].message).toContain('company | person');
    expect(diagnostics[0].message).not.toContain('"union"');
  });

  it('the linked write lands in the parent graph — its fields check against the inferred root', () => {
    expect(codes(withCompany('  write co-[:rounds]-> { stge: "Seed" }'))).toEqual([
      C.WRITE_UNKNOWN_FIELD,
    ]);
  });

  it('MOV_WRITE_READ_ONLY_EDGE when the edge declares no write promise', () => {
    const diagnostics = check(withCompany('  write co-[:attachments]-> { name: "x" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_READ_ONLY_EDGE]);
    expect(diagnostics[0].message).toContain('attachments');
    expect(diagnostics[0].message).toContain('read-only');
  });

  it('an edge with no write promise gates even when its TARGET is open — the EDGE fact is definite', () => {
    // Layer 13: open-surface silence was about the TARGET's writability, which
    // no longer gates. The edge's own promise is always known (the adapter
    // published the edge), so its absence is a definite read-only fact.
    expect(check(withCompany('  write co-[:mysteries]-> { anything: "goes" }')).map(d => d.code))
      .toEqual([C.WRITE_READ_ONLY_EDGE]);
  });

  it('reading the readable-only target through the same edge stays clean', () => {
    expectClean(
      withCompany(
        '  co-[a:attachments]-> {\n    write graph-[:people]-> { name: a.`name` }\n  }',
      ),
    );
  });

  it('a linked handle chains: the result is typed for further linked writes', () => {
    expectClean(
      withCompany(
        [
          '  fr = write co-[:rounds]-> { stage: "Seed" }',
          '  write fr-[:participants]-> { investor_name: "Acme Ventures", lead: TRUE }',
        ].join('\n'),
      ),
    );
  });
});

describe('per-edge create capability (createShapes)', () => {
  it('a lookup-block write along a writable edge checks clean', () => {
    expectClean(inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    write ch-[:messages]-> { Message: "hello" }',
        '  }',
      ].join('\n'),
    ));
  });

  it('a reply chained off the written handle checks clean (self-referential writable edge)', () => {
    expectClean(inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    m = write ch-[:messages]-> { Message: "hello" }',
        '    write m-[:replies]-> { Message: "again" }',
        '  }',
      ].join('\n'),
    ));
  });

  it('the write body checks against the createShapes shape (unknown field errors)', () => {
    expect(codes(inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    write ch-[:messages]-> { Text: "wrong field name" }',
        '  }',
      ].join('\n'),
    ))).toEqual([C.WRITE_UNKNOWN_FIELD]);
  });

  it('an edge with no write promise gates, naming the writable edges', () => {
    const diagnostics = check(inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    write ch-[:members]-> { Name: "x" }',
        '  }',
      ].join('\n'),
    ));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_READ_ONLY_EDGE]);
    expect(diagnostics[0].message).toContain('channel-[:messages]->');
    expect(diagnostics[0].message).toContain('message-[:replies]->');
  });

  it('a meta-rooted write to an edge-anchored type errors (message is created along channel)', () => {
    // Under the edge-form grammar, `chan` isn't a bound instance and `messages`
    // isn't a meta edge of the messaging instance — the message type is created
    // along `channel-[:messages]->`, not off the instance meta position.
    const diagnostics = check(inMovement('  write chan-[:messages]-> { Message: "hi" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.LINKED_UNKNOWN_EDGE]);
  });

  it('CRM/KG linked writes check clean when the edge declares `writable: true`', () => {
    expectClean(inMovement(
      [
        '  co = write graph-[:companies]-> { name: "Acme" }',
        '  write co-[:rounds]-> { stage: "Seed" }',
      ].join('\n'),
    ));
  });
});

describe('write-only / read-only surfaces (the WhatsApp File duality)', () => {
  const inMessageBlock = (body: string) =>
    inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    ch-[m:messages]-> {',
        `      ${body}`,
        '    }',
        '  }',
      ].join('\n'),
    );

  it('MOV_WRITE_ONLY_PROPERTY when reading a write-only field, steering via the field doc', () => {
    const diagnostics = check(inMessageBlock('write graph-[:people]-> { name: m.`File` }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_ONLY_PROPERTY]);
    expect(diagnostics[0].message).toContain('write-only');
    expect(diagnostics[0].message).toContain('files edge');
  });

  it('a declared readable property on the same type still reads clean', () => {
    expectClean(inMessageBlock('write graph-[:people]-> { name: m.`Message` }'));
  });

  it('MOV_WRITE_ONLY_EDGE when a read traverses a create-only edge', () => {
    const diagnostics = check(
      inMessageBlock('m-[r:replies]-> {\n        write graph-[:people]-> { name: r.`Message` }\n      }'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_ONLY_EDGE]);
    expect(diagnostics[0].message).toContain('write …-[:replies]-> { … }');
  });

  it('MOV_WRITE_READ_ONLY_EDGE when a write targets a read-only edge, naming the create edges', () => {
    const diagnostics = check(inMessageBlock('write m-[:files]-> { Name: "x" }'));
    expect(diagnostics.map(d => d.code)).toEqual([C.WRITE_READ_ONLY_EDGE]);
    expect(diagnostics[0].message).toContain('read-only');
    expect(diagnostics[0].message).toContain('message-[:replies]->');
  });

  it('writes along a write-only (readable: false) edge stay clean — the flag gates reads only', () => {
    expectClean(inMessageBlock('write m-[:replies]-> { Message: "still fine" }'));
  });

  it('setting the write-only field IN a write stays clean — write-only, not unusable', () => {
    expectClean(inMessageBlock('write m-[:replies]-> { Message: "doc", File: FILE("contents", "pdf") }'));
  });
});

// Two of the SOURCE's fields wearing one display name. The program is fine —
// only the connected workspace can resolve the ambiguity — so this warns and
// never gates a compile.
describe('ambiguous property names', () => {
  const inMembersBlock = (body: string) =>
    inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    ch-[u:members]-> {',
        `      ${body}`,
        '    }',
        '  }',
      ].join('\n'),
    );

  const readingAmbiguous = inMembersBlock('write graph-[:people]-> { name: u.`Name` }');

  it('MOV_AMBIGUOUS_PROPERTY when reading a name two fields share', () => {
    const diagnostics = warnings(readingAmbiguous);
    expect(diagnostics.map(d => d.code)).toEqual([C.AMBIGUOUS_PROPERTY]);
    expect(diagnostics[0].message).toContain('more than one field named');
  });

  it('warns without BLOCKING — nothing at error severity', () => {
    // The author's program is fine; only their workspace can resolve the
    // collision, so this must never gate a compile.
    expectClean(readingAmbiguous);
  });

  it('the ambiguous name still resolves — it is not a dropped field', () => {
    // A dropped field would surface as MOV_UNKNOWN_PROPERTY instead.
    expect(codes(readingAmbiguous)).not.toContain(C.UNKNOWN_PROPERTY);
  });

  it('an unambiguous field on the same type warns about nothing', () => {
    expectClean(inMembersBlock('write graph-[:people]-> { name: u.`Email` }'));
    expect(warnings(inMembersBlock('write graph-[:people]-> { name: u.`Email` }'))).toEqual([]);
  });
});

describe('ephemeral edges (action-not-record — typing indicators)', () => {
  const inListener = (body: string) =>
    inMovement(
      [
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    m = write ch-[:messages]-> { Message: "hello" }',
        body,
        '  }',
      ].join('\n'),
    );

  it('an unbound ephemeral write checks clean (empty body)', () => {
    expectClean(inListener('    write m-[:typing]-> {}'));
  });

  it('binding an ephemeral write errors — nothing is created', () => {
    const diagnostics = check(inListener('    t = write m-[:typing]-> {}'));
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_EPHEMERAL_BOUND]);
    expect(diagnostics[0].message).toContain('action');
  });

  it('the write body still checks against the createShapes shape', () => {
    expect(codes(inListener('    write m-[:typing]-> { Speed: "fast" }')))
      .toEqual([C.WRITE_UNKNOWN_FIELD]);
  });

  it('passing an ephemeral write as a call argument errors too — the callee receives a handle', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'movement callee(t: <chan-[:message]->>) {',
        '  …',
        '}',
        'movement main(msg: <inbox-[:message]->>) {',
        '  chan-[ch:Channels WHERE `Name` == "general"]-> {',
        '    m = write ch-[:messages]-> { Message: "hello" }',
        '    callee(t: write m-[:typing]-> {})',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([C.WRITE_EPHEMERAL_BOUND]);
  });
});

describe('WHERE-literal known-values warning (the lookup-miss safety net)', () => {
  const lookup = (name: string) =>
    inMovement(
      [
        `  chan-[ch:Channels WHERE \`Name\` == ${name}]-> {`,
        '    write ch-[:messages]-> { Message: "hello" }',
        '  }',
      ].join('\n'),
    );

  it('a known channel name in a hop-bracket WHERE is clean', () => {
    expect(warnings(lookup('"general"'))).toEqual([]);
  });

  it('a typo-d channel name WARNS with a did-you-mean (never gates)', () => {
    expect(codes(lookup('"genral"'))).toEqual([]);
    const warned = warnings(lookup('"genral"'));
    expect(warned.map((d) => d.code)).toEqual(['MOV_VALUE_UNLISTED']);
    expect(warned[0].message).toContain('Did you mean "general"?');
  });

  it('a #-prefixed channel name WARNS (Slack lists names without the hash)', () => {
    expect(warnings(lookup('"#general"')).map((d) => d.code)).toEqual(['MOV_VALUE_UNLISTED']);
  });

  it('a computed value stays silent', () => {
    expect(warnings(lookup('"team-${msg.subject}"'))).toEqual([]);
  });
});

// ── Traversal validity (check 4) ──

describe('traversal validity', () => {
  it('MOV_TRAVERSE_UNKNOWN_EDGE on a typed block head', () => {
    const diagnostics = check(
      inMovement(
        ['  msg-[x:typo]-> {', '    write team-[:messages]-> { channel: "#d", text: "hi" }', '  }'].join(
          '\n',
        ),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
    expect(diagnostics[0].message).toContain('sender');
  });

  it('MOV_TRAVERSE_UNKNOWN_EDGE inside a field expression', () => {
    expect(
      codes(inMovement('  write team-[:messages]-> { channel: "#d", text: msg-[:typo]->.`name` }')),
    ).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });

  it('MOV_TRAVERSE_UNKNOWN_EDGE for an unknown collection on a meta position', () => {
    expect(
      codes(
        [
          PRELUDE,
          'movement main(root: <crm>) {',
          '  root-[c:typo]-> {',
          '    write team-[:messages]-> { channel: "#d", text: "x" }',
          '  }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });

  it("MOV_BLOCK_READ_BACK_RETIRED for a block's inner binding read off its value", () => {
    const diagnostics = check(
      inMovement(
        [
          '  orgs = msg-[s:sender]-> {',
          '    co = write crm-[:companies]-> { name: s.`name` }',
          '    return co',
          '  }',
          '  write team-[:messages]-> { channel: "#d", text: "${COUNT(orgs-[:co]->)}" }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toContain(C.BLOCK_READ_BACK_RETIRED);
    expect(diagnostics.map(d => d.message).join('\n')).toContain(
      'return the value from the block',
    );
  });

  it('tracks position types across multi-hop chains', () => {
    expect(
      codes(
        inMovement('  write team-[:messages]-> { channel: "#d", text: msg-[:sender]->-[:typo]->.`x` }'),
      ),
    ).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });
});

// ── Extraction (check 9) ──

describe('extract result typing', () => {
  it("MOV_EXTRACT_UNKNOWN_FIELD for the spec's c.`naem` typo", () => {
    const diagnostics = check(
      inMovement(
        [
          '  mentioned = extract from [msg.`text`] {',
          '    node company: "each company mentioned" {',
          '      name: "the company\'s name"',
          '    }',
          '  }',
          '  mentioned-[c:company]-> {',
          '    write graph-[:companies]-> { name: c.`naem` }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain('name');
  });

  it('a later stage INHERITS the earlier stage’s fields — an earlier-stage field reads back', () => {
    const diagnostics = check(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      name: "the name"',
          '      urls: "associated URLs"',
          '    } through [vc_url_retrieval(urls: urls)] {',
          '      name: "the name, corrected against the fetched pages"',
          '    }',
          '  }',
          '  deals-[c:company]-> {',
          '    write graph-[:companies]-> { name: c.`name`, domains: c.`urls` }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([]);
  });

  it('a field no stage declares is still MOV_EXTRACT_UNKNOWN_FIELD, listing every stage’s fields', () => {
    const diagnostics = check(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node company: "each company" {',
          '      urls: "associated URLs"',
          '    } through [vc_url_retrieval(urls: urls)] {',
          '      name: "the name"',
          '    }',
          '  }',
          '  deals-[c:company]-> {',
          '    write graph-[:companies]-> { name: c.`naem` }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain('urls, name');
  });

  it('an unannotated field is text, so writing it into a NUMBER field is refused, naming the annotation', () => {
    const source = inMovement(
      [
        '  deals = extract from [msg.`text`] {',
        '    node round: "the round" {',
        '      amount: "the amount raised"',
        '    }',
        '  }',
        '  deals-[r:round]-> {',
        '    write graph-[:funding_round]-> { stage: "Seed", amount: r.`amount` }',
        '    write team-[:messages]-> { channel: "#d", text: r.`amount` }',
        '  }',
      ].join('\n'),
    );
    // TypeScript's string-where-number-is-required: only the number target is
    // refused. The text target is text already.
    const diagnostics = check(source);
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_NEEDS_ANNOTATION]);
    expect(diagnostics[0].message).toContain('amount: <number> "…"');
    expect(diagnostics[0].message).toContain('graph.funding_round.amount');
    // The annotated field may not be found, so the refusal names the
    // discharge in the same breath — following it must never walk the author
    // into a second refusal it never mentioned.
    expect(diagnostics[0].message).toContain("'?:'");
    expect(infos(source).filter(d => d.code === C.EXTRACT_ANNOTATE)).toEqual([]);
  });

  it('annotation suggestions dedupe per (field, target path) across repeated writes', () => {
    const source = inMovement(
      [
        '  deals = extract from [msg.`text`] {',
        '    node company: "each company" {',
        '      stage: "the funding stage"',
        '    }',
        '  }',
        '  deals-[c:company]-> {',
        '    write aff-[:organizations]-> { name: "Acme", stage: c.`stage` }',
        '  }',
        '  deals-[c2:company]-> {',
        '    write aff-[:organizations]-> { name: "Acme", stage: c2.`stage` }',
        '  }',
      ].join('\n'),
    );
    const suggestions = infos(source).filter(d => d.code === C.EXTRACT_ANNOTATE);
    expect(suggestions).toHaveLength(1);
  });

  it('an unannotated field flowing into a TEXT target is NOT nagged (the annotation would add nothing)', () => {
    const source = inMovement(
      [
        '  deals = extract from [msg.`text`] {',
        '    node round: "the round" {',
        '      stage: "the stage"',
        '    }',
        '  }',
        '  deals-[r:round]-> {',
        '    write graph-[:funding_round]-> { stage: r.`stage` }',
        '  }',
      ].join('\n'),
    );
    expect(check(source)).toEqual([]);
    expect(infos(source).filter(d => d.code === C.EXTRACT_ANNOTATE)).toEqual([]);
  });

  it('an unannotated field flowing into an ENUM target IS nagged (its options constrain extraction)', () => {
    const source = inMovement(
      [
        '  deals = extract from [msg.`text`] {',
        '    node company: "each company" {',
        '      stage: "the funding stage"',
        '    }',
        '  }',
        '  deals-[c:company]-> {',
        '    write aff-[:organizations]-> { name: "Acme", stage: c.`stage` }',
        '  }',
      ].join('\n'),
    );
    expect(infos(source).filter(d => d.code === C.EXTRACT_ANNOTATE).map(d => d.message)).toEqual([
      expect.stringContaining('aff.organization.stage'),
    ]);
  });

  it('an explicit annotation settles the type — and contradicting writes become field-type errors', () => {
    expectClean(
      inMovement(
        [
          '  deals = extract from [msg.`text`] {',
          '    node round: "the round" {',
          '      amount: <number> "the amount raised"',
          '    }',
          '  }',
          '  deals-[r:round]-> {',
          '    write graph-[:funding_round]-> { stage: "Seed", amount ?: r.`amount` }',
          '    write team-[:messages]-> { channel: "#d", text ?: r.`amount` }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(
      codes(
        inMovement(
          [
            '  deals = extract from [msg.`text`] {',
            '    node round: "the round" {',
            '      amount: <number> "the amount raised"',
            '    }',
            '  }',
            '  deals-[r:round]-> {',
            '    write graph-[:round_participation]-> { investor_name: "x", lead ?: r.`amount` }',
            '  }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.WRITE_FIELD_TYPE]);
  });

  it('nested extract nodes type as edges; their fields check too', () => {
    expect(
      codes(
        inMovement(
          [
            '  deals = extract from [msg.`text`] {',
            '    node company: "each company" {',
            '      name: "the name"',
            '      node round: "the round" {',
            '        stage: "the stage"',
            '      }',
            '    }',
            '  }',
            '  deals-[c:company]->-[r:round]-> {',
            '    write graph-[:funding_round]-> { stage: r.`stge` }',
            '  }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.EXTRACT_UNKNOWN_FIELD]);
  });
});

// ── Borrowed types (`stage: <crm-[:company]->.funding_stage> "…"`) ──

describe('borrowed type annotations', () => {
  const extractWith = (annotation: string, rest = '') =>
    inMovement(
      [
        '  deals = extract from [msg.`text`] {',
        '    node company: "each company" {',
        '      name:  "the name"',
        `      stage: ${annotation} "the funding stage"`,
        '    }',
        '  }',
        rest,
      ].join('\n'),
    );

  it("a borrowed path types the field with the target's type (enum options included)", () => {
    // Writing the enum-typed field into a number target is a shape error —
    // proof the borrowed type reached the field.
    expect(
      codes(
        extractWith(
          '<crm-[:company]->.funding_stage>',
          [
            '  deals-[c:company]-> {',
            '    write graph-[:funding_round]-> { amount ?: c.`stage` }',
            '  }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.WRITE_FIELD_TYPE]);
  });

  it('a borrowed annotation matching its write target checks clean (no suggestion either)', () => {
    const source = extractWith(
      '<crm-[:company]->.funding_stage>',
      [
        '  deals-[c:company]-> {',
        '    write crm-[:companies]-> { name ?: c.`name`, funding_stage ?: c.`stage` }',
        '  }',
      ].join('\n'),
    );
    expect(check(source)).toEqual([]);
    // Neither field is nagged: the annotated `stage` matches its target, and
    // `name` flows into a text field, which an annotation wouldn't constrain.
    expect(infos(source).filter(d => d.code === C.EXTRACT_ANNOTATE)).toEqual([]);
  });

  it('borrowing from the kg ontology works (position properties)', () => {
    expect(check(extractWith('<graph-[:funding_round]->.stage>'))).toEqual([]);
  });

  it('MOV_EXTRACT_TYPE_CONFLICT when an annotated enum is written into an enum field with different options', () => {
    const diagnostics = check(
      extractWith(
        '<crm-[:company]->.funding_stage>',
        [
          '  deals-[c:company]-> {',
          '    write aff-[:organizations]-> { name ?: c.`name`, stage ?: c.`stage` }',
          '  }',
        ].join('\n'),
      ),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_TYPE_CONFLICT]);
    expect(diagnostics[0].message).toContain('aff.organization.stage');
    expect(diagnostics[0].message).toContain('Pipeline | Won');
  });

  it('MOV_BORROW_UNKNOWN_GRAPH for an unknown first segment', () => {
    const diagnostics = check(extractWith('<nope-[:company]->.funding_stage>'));
    expect(diagnostics.map(d => d.code)).toEqual([C.BORROW_UNKNOWN_GRAPH]);
    expect(diagnostics[0].message).toContain('nope');
  });

  it('MOV_BORROW_UNKNOWN_GRAPH when the first segment is not a graph', () => {
    expect(codes(extractWith('<msg-[:company]->.funding_stage>'))).toEqual([C.BORROW_UNKNOWN_GRAPH]);
  });

  it('MOV_BORROW_UNKNOWN_ROOT for an unknown root/position', () => {
    const diagnostics = check(extractWith('<crm-[:gizmos]->.funding_stage>'));
    expect(diagnostics.map(d => d.code)).toEqual([C.BORROW_UNKNOWN_ROOT]);
    expect(diagnostics[0].message).toContain('company');
  });

  it('MOV_BORROW_UNKNOWN_FIELD for an unknown field', () => {
    const diagnostics = check(extractWith('<crm-[:company]->.nope>'));
    expect(diagnostics.map(d => d.code)).toEqual([C.BORROW_UNKNOWN_FIELD]);
    expect(diagnostics[0].message).toContain('funding_stage');
  });

  it('a borrowed hop with no property tail is a PARSE error naming the fix', () => {
    // Stronger than the old MOV_BORROW_MALFORMED: the grammar itself now
    // requires the field tail, so the malformed path never reaches the checker.
    expect(() => codes(extractWith('<crm-[:company]->>'))).toThrow(
      /A borrowed type names a FIELD — add the property tail: <crm-\[:company\]->\.`field`>/,
    );
  });
});

// ── An annotation that CONTRADICTS its write target ──
//
// A redundant annotation is silent; a wrong one is reported at the annotation.
// The lenient write gate already reports the mismatches it can see, so this
// site owns exactly its blind spot: a target that accepts less than free text.
describe('annotation vs write target (MOV_EXTRACT_TYPE_CONFLICT)', () => {
  // Deliberately NOT shaped like the enum-vs-enum case the rule grew out of —
  // a fixture matching one shape can't tell derived from hardcoded.
  const priority: SchemaFieldType = { kind: 'enum', options: ['P0', 'P1'] };
  const trackerSchema: InstanceSchema = {
    positions: { ticket: { properties: { Title: 'text' }, edges: {} } },
    collections: { tickets: { target: 'ticket' } },
    writableRoots: {
      ticket: {
        fields: { Title: 'text', Due: 'date', Points: 'number', Priority: priority },
        resultShape: { externalId: 'text', Title: 'text' },
      },
    },
  };
  const trackerCatalog = mockCatalog({
    adapters: {
      email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
      tracker: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schema: trackerSchema,
      },
    },
    credentials: { dealflow_inbox: { adapter: 'email' }, tracker_cred: { adapter: 'tracker' } },
  });
  /** One extracted field with `annotation`, written into `field` of a ticket. */
  const trackerDiags = (annotation: string, field: string): Diagnostic[] =>
    checkProgram(
      parseProgram(
        [
          'import { email, tracker } from adapters',
          'import { dealflow_inbox, tracker_cred } from credentials',
          '',
          'inbox = email(credentials: dealflow_inbox)',
          'trk   = tracker(credentials: tracker_cred)',
          '',
          'movement main(msg: <inbox-[:message]->>) {',
          '  work = extract from [msg.`text`] {',
          '    node item: "each work item" {',
          `      value: ${annotation} "the value"`,
          '    }',
          '  }',
          '  work-[i:item]-> {',
          `    write trk-[:tickets]-> { Title: "t", ${field} ?: i.\`value\` }`,
          '  }',
          '}',
        ].join('\n'),
      ),
      trackerCatalog,
    ).filter(d => (d.severity ?? 'error') === 'error');

  it('an annotated <text> written into a DATE field conflicts (the gate would parse it silently)', () => {
    const diagnostics = trackerDiags('<text>', 'Due');
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_TYPE_CONFLICT]);
    expect(diagnostics[0].message).toContain('trk.ticket.Due');
    expect(diagnostics[0].message).toContain('date');
  });

  it('an annotated <text> written into an ENUM field conflicts (text does not satisfy an option set)', () => {
    const diagnostics = trackerDiags('<text>', 'Priority');
    expect(diagnostics.map(d => d.code)).toEqual([C.EXTRACT_TYPE_CONFLICT]);
    expect(diagnostics[0].message).toContain('P0 | P1');
  });

  it('an annotation matching its target is silent', () => {
    expect(trackerDiags('<number>', 'Points')).toEqual([]);
    expect(trackerDiags('<text>', 'Title')).toEqual([]);
  });

  it('any annotation renders into a TEXT target — silent, not a conflict', () => {
    expect(trackerDiags('<number>', 'Title')).toEqual([]);
  });

  it('a mismatch the write gate CAN see stays with the gate (no double report)', () => {
    expect(trackerDiags('<text>', 'Points').map(d => d.code)).toEqual([C.WRITE_FIELD_TYPE]);
  });
});

// ── IS narrowing (check 6) ──

describe('union narrowing', () => {
  it('MOV_NARROWING for a variant-only field read without narrowing', () => {
    const diagnostics = check(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  write graph-[:companies]-> { name: rec.`Name`, domains: rec.`Domains` }',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.NARROWING]);
    expect(diagnostics[0].message).toContain('IS');
  });

  it('MOV_NARROWING for a variant-only edge traversed without narrowing', () => {
    expect(
      codes(
        [
          PRELUDE,
          'movement main(rec: <crm-[:record]->>) {',
          '  write graph-[:people]-> { name: rec.`Name`, company: rec-[:Company]->.`Name` }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.NARROWING]);
  });

  it('a field shared by every variant needs no narrowing', () => {
    expectClean(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  write graph-[:companies]-> { name: rec.`Name` }',
        '}',
      ].join('\n'),
    );
  });

  it('narrowing applies to later conjuncts of the same condition', () => {
    expectClean(
      [
        PRELUDE,
        'movement main(rec: <crm-[:record]->>) {',
        '  if rec IS <crm-[:person]->> AND EXISTS(rec-[:Company]->) {',
        '    write graph-[:people]-> { name: rec.`Name` }',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  // A POLYMORPHIC EDGE lands on its union. It used to land on nothing — the
  // traversal typed as `undefined`, so every read past it was unchecked, which
  // is the absence of a guarantee rather than a weaker one. Resolving the
  // target through the union-aware lookup is the whole fix: every rule below is
  // the existing union machinery, applying because the hop now has a type.
  describe('through a polymorphic edge', () => {
    const inDeal = (body: string) =>
      [PRELUDE, 'movement main(d: <crm-[:deal]->>) {', body, '}'].join('\n');

    it('a field shared by every variant reads clean through the hop', () => {
      expectClean(inDeal('  write graph-[:companies]-> { name: d-[:Related]->.`Name` }'));
    });

    it('MOV_NARROWING for a variant-only field through the hop', () => {
      const diagnostics = check(
        inDeal('  write graph-[:companies]-> { domains: d-[:Related]->.`Domains` }'),
      );
      expect(diagnostics.map(d => d.code)).toEqual([C.NARROWING]);
      expect(diagnostics[0].message).toContain('IS');
    });

    it('a field NO variant carries is still an error — the hop is typed, not silent', () => {
      expect(codes(inDeal('  write graph-[:companies]-> { name: d-[:Related]->.`Nope` }'))).toEqual([
        C.UNKNOWN_PROPERTY,
      ]);
    });

    it('an IS test on the landed alias reaches that variant`s own surface', () => {
      expectClean(
        inDeal(
          [
            '  d-[r:Related]-> {',
            '    if r IS <crm-[:company]->> {',
            '      write graph-[:companies]-> { domains: r.`Domains` }',
            '    }',
            '  }',
          ].join('\n'),
        ),
      );
    });

    it('the IS arm is still typed — a field the narrowed variant lacks errors', () => {
      expect(
        codes(
          inDeal(
            [
              '  d-[r:Related]-> {',
              '    if r IS <crm-[:company]->> {',
              '      write graph-[:people]-> { name: r.`Email` }',
              '    }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.UNKNOWN_PROPERTY]);
    });
  });

  // ── else-arm elimination ──
  //
  // A failed `IS` is information, exactly as it is in TypeScript: reaching the
  // `else` proves the subject is NOT what the arms above tested. This is only
  // sound because the engine now REFUSES an `IS` it can't answer (an
  // undiscriminated event used to fall in here typed as "not that kind").
  describe('an else arm eliminates what the arms above tested', () => {
    const inRecord = (body: string) =>
      [PRELUDE, 'movement main(rec: <crm-[:record]->>) {', body, '}'].join('\n');

    it('the else sees the other variant — its variant-only field reads clean', () => {
      expectClean(
        inRecord(
          [
            '  if rec IS <crm-[:company]->> {',
            '  } else {',
            '    write graph-[:people]-> { name: rec.`Email` }',
            '  }',
          ].join('\n'),
        ),
      );
    });

    it("the ELIMINATED variant's own field is now an error in the else", () => {
      expect(
        codes(
          inRecord(
            [
              '  if rec IS <crm-[:person]->> {',
              '  } else {',
              '    write graph-[:people]-> { name: rec.`Email` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.UNKNOWN_PROPERTY]);
    });

    it('an edge only the SURVIVING variant carries is traversable in the else', () => {
      expectClean(
        inRecord(
          [
            '  if rec IS <crm-[:company]->> {',
            '  } else {',
            '    write graph-[:people]-> { name: rec-[:Company]->.`Name` }',
            '  }',
          ].join('\n'),
        ),
      );
    });

    it('an edge only the ELIMINATED variant carries is refused in the else', () => {
      expect(
        codes(
          inRecord(
            [
              '  if rec IS <crm-[:person]->> {',
              '  } else {',
              '    write graph-[:people]-> { name: rec-[:Company]->.`Name` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
    });

    // A conjunction proves NOTHING when false — only that one of its conjuncts
    // was — so it must not eliminate. Same rule the guard-clause negation
    // follows; getting this wrong would narrow on a false premise.
    it('a CONJUNCTION that failed eliminates nothing', () => {
      expect(
        codes(
          inRecord(
            [
              '  if rec IS <crm-[:company]->> AND rec.`Name` != "" {',
              '  } else {',
              '    write graph-[:people]-> { name: rec.`Email` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.NARROWING]);
    });

    // Identity is the graph TOKEN, never the spelling — `graph` also has a
    // `company`, and a failed test against it says nothing about `crm`'s union.
    it("a test against a DIFFERENT graph's same-named position eliminates nothing", () => {
      expect(
        codes(
          inRecord(
            [
              '  if rec IS <graph-[:company]->> {',
              '  } else {',
              '    write graph-[:people]-> { name: rec.`Email` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.NARROWING]);
    });

    it('elimination is scoped to the else — the union is whole again after the if', () => {
      expect(
        codes(
          inRecord(
            [
              '  if rec IS <crm-[:company]->> {',
              '  } else {',
              '    write graph-[:people]-> { name: rec.`Email` }',
              '  }',
              '  write graph-[:people]-> { name: rec.`Email` }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.NARROWING]);
    });

    // Two planes, one arm: the elimination types `rec` as the person, and the
    // presence narrowing discharges the absence `FIRST` introduced. Composition
    // — neither shadowing clobbers the other.
    it('composes with presence narrowing in the same arm', () => {
      expectClean(
        inRecord(
          [
            '  if rec IS <crm-[:company]->> {',
            '  } else {',
            '    e = ONLY(rec.`Email`)',
            '    if e != null {',
            '      write graph-[:people]-> { name: e }',
            '    }',
            '  }',
          ].join('\n'),
        ),
      );
    });
  });

  describe('an else-if chain eliminates progressively', () => {
    const inSubject = (body: string) =>
      [PRELUDE, 'movement main(rec: <crm-[:subject]->>) {', body, '}'].join('\n');

    it('one test leaves a smaller union — a two-of-three field is still ambiguous', () => {
      expect(
        codes(
          inSubject(
            [
              '  if rec IS <crm-[:company]->> {',
              '  } else {',
              '    write graph-[:people]-> { name: rec.`Email` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.NARROWING]);
    });

    it('two tests leave ONE member, and its variant-only field reads clean', () => {
      expectClean(
        inSubject(
          [
            '  if rec IS <crm-[:company]->> {',
            '  } else if rec IS <crm-[:deal]->> {',
            '  } else {',
            '    write graph-[:people]-> { name: rec.`Email` }',
            '  }',
          ].join('\n'),
        ),
      );
    });

    it("the last member's own edge is traversable once the others are eliminated", () => {
      expectClean(
        inSubject(
          [
            '  if rec IS <crm-[:company]->> {',
            '  } else if rec IS <crm-[:person]->> {',
            '  } else {',
            '    write graph-[:companies]-> { name: rec-[:Related]->.`Name` }',
            '  }',
          ].join('\n'),
        ),
      );
    });

    // The `else if`'s OWN condition sees what the arm above left, so its
    // positive test narrows the residual rather than the original union.
    it("an else-if arm's body is typed under both the elimination and its own test", () => {
      expect(
        codes(
          inSubject(
            [
              '  if rec IS <crm-[:company]->> {',
              '  } else if rec IS <crm-[:person]->> {',
              '    write graph-[:companies]-> { domains: rec.`Domains` }',
              '  }',
            ].join('\n'),
          ),
        ),
      ).toEqual([C.UNKNOWN_PROPERTY]);
    });
  });

  // Every member ruled out — the empty union, TypeScript's `never`. Reaching
  // the branch is not the error (an exhaustive chain is good code); the error
  // is at the USE, and it says the cases are covered rather than sending the
  // author to add an `IS` that could never match.
  describe('a fully eliminated union is never', () => {
    const inRecord = (body: string) =>
      [PRELUDE, 'movement main(rec: <crm-[:record]->>) {', body, '}'].join('\n');

    const exhausted = (use: string) =>
      inRecord(
        [
          '  if rec IS <crm-[:company]->> {',
          '  } else if rec IS <crm-[:person]->> {',
          '  } else {',
          `    ${use}`,
          '  }',
        ].join('\n'),
      );

    it('reading a field in the exhausted else reports the branch, not a typo', () => {
      const diagnostics = check(exhausted('write graph-[:people]-> { name: rec.`Name` }'));
      expect(diagnostics.map(d => d.code)).toEqual([C.UNREACHABLE_BRANCH]);
      expect(diagnostics[0].message).toContain('already cover every kind');
    });

    it('traversing in the exhausted else reports the same way', () => {
      expect(
        codes(exhausted('write graph-[:people]-> { name: rec-[:Company]->.`Name` }')),
      ).toEqual([C.UNREACHABLE_BRANCH]);
    });

    it('an exhausted else that USES nothing is clean — the chain itself is fine', () => {
      expectClean(exhausted('write graph-[:companies]-> { name: "covered" }'));
    });
  });

  it('narrowing is scoped to its arm — the variant field is still an error after the if', () => {
    expect(
      codes(
        [
          PRELUDE,
          'movement main(rec: <crm-[:record]->>) {',
          '  if rec IS <crm-[:company]->> {',
          '    write graph-[:companies]-> { name: rec.`Name` }',
          '  }',
          '  write graph-[:companies]-> { domains: rec.`Domains` }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.NARROWING]);
  });
});

// ── Call fit (check 7) ──

const SHAPES = [
  'node Files {',
  '  name: <text>',
  '  data: <file>',
  '}',
  'node Deal {',
  '  name: <text>',
  '}',
].join('\n');

describe('call fit', () => {
  it('MOV_CALL_ARG_TYPE when a position of the wrong graph is passed', () => {
    const diagnostics = check(
      [
        PRELUDE,
        SHAPES,
        'movement callee(f: <Files>) {',
        '  …',
        '}',
        'movement caller(msg: <inbox-[:message]->>) {',
        '  callee(f: msg)',
        '}',
      ].join('\n'),
    );
    expect(diagnostics.map(d => d.code)).toEqual([C.CALL_ARG_TYPE]);
    expect(diagnostics[0].message).toContain('Files');
  });

  it('MOV_NODE_ARG_SHAPE when a synthesised argument builds the wrong shape', () => {
    expect(
      codes(
        [
          PRELUDE,
          SHAPES,
          'movement callee(f: <Files>) {',
          '  …',
          '}',
          'movement caller(msg: <inbox-[:message]->>) {',
          '  callee(f: node { name: "Series A" })',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.NODE_ARG_SHAPE]);
  });

  it("MOV_CALL_ARG_TYPE across two instances of the same adapter — a parameter is typed against ITS instance", () => {
    expect(
      codes(
        [
          PRELUDE,
          'crm2 = attio(credentials: acme_main)',
          'movement sync(co: <crm-[:company]->>) {',
          '  …',
          '}',
          'movement main(msg: <inbox-[:message]->>) {',
          '  company = write crm2-[:companies]-> { name: msg.`subject` }',
          '  sync(co: company)',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.CALL_ARG_TYPE]);
  });

  it('an inline synthesised argument is itself checked, entry by entry', () => {
    expect(
      codes(
        [
          PRELUDE,
          SHAPES,
          'movement callee(f: <Files>) {',
          '  …',
          '}',
          'movement caller(msg: <inbox-[:message]->>) {',
          '  callee(f: node { name: msg.`nope` })',
          '}',
        ].join('\n'),
      ),
    ).toEqual([C.UNKNOWN_PROPERTY, C.NODE_ARG_SHAPE]);
  });
});

// ── Native uniqueness vs authored `unique by` ──

describe('unique by as an expression predicate (chunk 8)', () => {
  it('accepts a literal predicate clause', () => {
    expectClean(inMovement('  write crm-[:companies]-> { unique by (`name` == "Acme") name: msg.`subject` }'));
  });

  it('accepts a bare-field predicate (identify by the value being written)', () => {
    expectClean(inMovement('  write crm-[:companies]-> { unique by (`domains`) name: msg.`subject` }'));
  });

  // The compound (handle AND field) form is exercised by the linked-write
  // tests above (`unique by (co AND \`stage\`)`).

  it('rejects a predicate field the written record does not have', () => {
    expect(
      codes(inMovement('  write crm-[:companies]-> { unique by (`ghost`) name: msg.`subject` }')),
    ).toContain('MOV_UNIQUE_UNKNOWN_FIELD');
  });
});

describe('native uniqueness', () => {
  const warnings = (source: string): Diagnostic[] =>
    checkProgram(parseProgram(source), catalog).filter(d => d.severity === 'warning');
  const HUBSPOT_PRELUDE = [
    'import { email, hubspot } from adapters',
    'import { dealflow_inbox, acme_hubspot } from credentials',
    '',
    'inbox = email(credentials: dealflow_inbox)',
    'crm2  = hubspot(credentials: acme_hubspot)',
  ].join('\n');
  const inHubspotMovement = (body: string) =>
    `${HUBSPOT_PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

  it('an authored clause duplicating a native rule is an info-severity suggestion', () => {
    const source = inHubspotMovement(
      'write crm2-[:companies]-> { unique by (`domain`)\n  domain: msg.`subject` }',
    );
    expect(infos(source).map(d => d.code)).toContain(C.UNIQUE_NATIVE_REDUNDANT);
    expect(warnings(source)).toEqual([]);
    expect(codes(source)).toEqual([]);
  });

  it('a compound authored clause duplicating a compound native rule is redundant', () => {
    const source = inHubspotMovement(
      'write crm2-[:companies]-> { unique by (`city` AND `name`)\n  name: msg.`subject` }',
    );
    expect(infos(source).map(d => d.code)).toContain(C.UNIQUE_NATIVE_REDUNDANT);
    expect(warnings(source)).toEqual([]);
  });

  it('authored identity disjoint from every native rule is NOT a diagnostic (expected, surfaced as an overlay hint instead)', () => {
    const source = inHubspotMovement(
      'write crm2-[:companies]-> { unique by (`nickname`)\n  name: msg.`subject` }',
    );
    // The target ALSO matching on its native rules is the target doing its
    // job — not a conflict to warn about. MOV_UNIQUE_NATIVE_CONFLICT is gone;
    // the editor surfaces "matched natively by …" as an overlay hint.
    expect(warnings(source)).toEqual([]);
    expect(codes(source)).toEqual([]);
  });

  it('an authored field belonging to ANY native rule counts as overlap (no conflict warning)', () => {
    const source = inHubspotMovement(
      'write crm2-[:companies]-> { unique by (`name`)\n  name: msg.`subject` }',
    );
    expect(warnings(source)).toEqual([]);
    expect(infos(source).map(d => d.code)).not.toContain(C.UNIQUE_NATIVE_REDUNDANT);
  });

  it('overlapping (but not identical) authored identity is neither redundant nor conflicting', () => {
    const source = inHubspotMovement(
      'write crm2-[:companies]-> { unique by (`domain` AND `name`)\n  name: msg.`subject` }',
    );
    expect(warnings(source)).toEqual([]);
    expect(infos(source).map(d => d.code)).not.toContain(C.UNIQUE_NATIVE_REDUNDANT);
  });

  it('no authored unique by stays silent (native rules alone are not a diagnostic)', () => {
    const source = inHubspotMovement('write crm2-[:companies]-> { name: msg.`subject` }');
    expect(warnings(source)).toEqual([]);
    expect(infos(source).map(d => d.code)).not.toContain(C.UNIQUE_NATIVE_REDUNDANT);
  });

  it('targets without declared native rules stay silent (unknown never warns)', () => {
    const source = inMovement('write crm-[:companies]-> { unique by (`name`)\n  name: msg.`subject` }');
    expect(warnings(source)).toEqual([]);
  });
});

describe('FUZZY uniqueness modifier', () => {
  // The KG company root is fuzzy-capable (pg_trgm); hubspot's is exact-only.
  const FUZZY_PRELUDE = [
    'import { email, hubspot } from adapters',
    'import { dealflow_inbox, acme_hubspot } from credentials',
    '',
    'inbox = email(credentials: dealflow_inbox)',
    'crm2  = hubspot(credentials: acme_hubspot)',
  ].join('\n');
  const inFuzzy = (body: string) =>
    `${FUZZY_PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

  it('FUZZY on a fuzzy-capable target (the KG) is accepted', () => {
    const source = inFuzzy('write graph-[:companies]-> { unique by (FUZZY `name`)\n  name: msg.`subject` }');
    expect(codes(source)).not.toContain(C.UNIQUE_FUZZY_UNSUPPORTED);
  });

  it('FUZZY mixed with an exact component (comma-separated) is accepted', () => {
    const source = inFuzzy(
      'write graph-[:companies]-> { unique by (`domains`, FUZZY `name`)\n  name: msg.`subject` }',
    );
    expect(codes(source)).not.toContain(C.UNIQUE_FUZZY_UNSUPPORTED);
  });

  it('FUZZY on an exact-only target is rejected with a helpful message', () => {
    const source = inFuzzy('write crm2-[:companies]-> { unique by (FUZZY `name`)\n  name: msg.`subject` }');
    const found = check(source).filter(d => d.code === C.UNIQUE_FUZZY_UNSUPPORTED);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/similarity|fuzzy/i);
  });

  describe('per field: a target may resolve only some fields by similarity', () => {
    const inRegistry = (clause: string) =>
      [
        'import { email, registry } from adapters',
        'import { dealflow_inbox, public_registry } from credentials',
        'inbox = email(credentials: dealflow_inbox)',
        'reg   = registry(credentials: public_registry)',
        'movement main(msg: <inbox-[:message]->>) {',
        `  match reg-[:entities]-> { unique by (${clause}), Name: msg.\`subject\`, \`Legal Name\`: msg.\`subject\`, City: "Berlin" }`,
        '}',
      ].join('\n');

    it('a listed field is accepted', () => {
      expectClean(inRegistry('FUZZY `Name`'));
      expectClean(inRegistry('FUZZY `Legal Name`, `City`'));
    });

    it('an unlisted field is refused, naming it and the fields that do support it', () => {
      const found = check(inRegistry('FUZZY `City`'));
      expect(found.map((d) => d.code)).toEqual([C.UNIQUE_FUZZY_UNSUPPORTED]);
      expect(found[0].message).toContain('FUZZY isn\'t available for `City`');
      expect(found[0].message).toContain('Similarity covers `Name`, `Legal Name`');
    });

    it('`true` admits any field', () => {
      expect(
        codes(inFuzzy('write graph-[:companies]-> { unique by (FUZZY `domains`)\n  name: msg.`subject` }')),
      ).not.toContain(C.UNIQUE_FUZZY_UNSUPPORTED);
    });
  });

  it('comma is the component separator — each component is validated on its own', () => {
    // `nope` is not a hubspot field; a comma split surfaces it as an unknown
    // field (rather than the whole predicate failing to parse).
    const source = inFuzzy('write crm2-[:companies]-> { unique by (`name`, `nope`)\n  name: msg.`subject` }');
    expect(codes(source)).toContain(C.UNIQUE_UNKNOWN_FIELD);
    expect(codes(source)).not.toContain(C.EXPR_PARSE);
  });
});

describe('adapter-restricted uniqueness (uniquenessAuthorable: false)', () => {
  it('rejects `unique by` on a target that decides identity itself (Affinity)', () => {
    const source = inMovement(
      'write aff-[:organizations]-> { unique by (`name`)\n  name: msg.`subject` }',
    );
    const found = check(source).filter(d => d.code === C.UNIQUE_NOT_AUTHORABLE);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/identity|automatic/i);
  });

  it('a write WITHOUT `unique by` on such a target is clean (native matching is automatic)', () => {
    const source = inMovement('write aff-[:organizations]-> { name: msg.`subject` }');
    expect(codes(source)).not.toContain(C.UNIQUE_NOT_AUTHORABLE);
  });

  it('does not restrict targets that DO accept authored uniqueness (the KG)', () => {
    const source = inMovement('write graph-[:companies]-> { unique by (`name`)\n  name: msg.`subject` }');
    expect(codes(source)).not.toContain(C.UNIQUE_NOT_AUTHORABLE);
  });
});

describe('append operators (+: / +?:)', () => {
  it('rejects +: (append) on a scalar field', () => {
    const source = inMovement('write graph-[:companies]-> { name +: msg.`subject` }');
    const found = check(source).filter((d) => d.code === C.WRITE_APPEND_NOT_MULTI);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/list|multi/i);
  });

  it('rejects +?: (append-if-missing) on a scalar field', () => {
    const source = inMovement('write graph-[:companies]-> { name +?: msg.`subject` }');
    expect(codes(source)).toContain(C.WRITE_APPEND_NOT_MULTI);
  });

  it('accepts +: / +?: on a multi-valued (list) field', () => {
    expect(codes(inMovement('write graph-[:companies]-> { domains +: [msg.`subject`] }'))).not.toContain(
      C.WRITE_APPEND_NOT_MULTI,
    );
    expect(codes(inMovement('write graph-[:companies]-> { domains +?: [msg.`subject`] }'))).not.toContain(
      C.WRITE_APPEND_NOT_MULTI,
    );
  });
});

describe('bind against an unupdatable target (WRITE_BIND_NO_UPDATE)', () => {
  it('rejects bind on a create-only target — a bound write re-fires as an update', () => {
    // `drive` (dropbox) is create-only: no supportsInPlaceUpdate.
    const source = inMovement('write drive-[:files]-> bind msg { name: "x" }');
    const found = check(source).filter((d) => d.code === C.WRITE_BIND_NO_UPDATE);
    expect(found).toHaveLength(1);
    expect(found[0].message).toMatch(/update/i);
  });

  it('allows bind on an updatable target (the KG)', () => {
    const source = inMovement('write graph-[:companies]-> bind msg { name: msg.`subject` }');
    expect(codes(source)).not.toContain(C.WRITE_BIND_NO_UPDATE);
  });
});

// ── match — the identity half of a write, on its own ──

describe('match', () => {
  it('a clean match binds the FOUND handle, usable downstream', () => {
    expectClean(
      inMovement(
        [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          '  fr = match co-[:rounds]-> { unique by (`stage`), stage: "Seed" }',
          '  write fr-[:participants]-> {',
          '    unique by (fr AND `investor_name`)',
          '    investor_name: msg.`subject`',
          '  }',
        ].join('\n'),
      ),
    );
  });

  it('an unbound match is a plain statement (a gate)', () => {
    expectClean(
      inMovement(
        [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          '  match co-[:rounds]-> { unique by (`stage`), stage: "Seed" }',
        ].join('\n'),
      ),
    );
  });

  it('matches over a root collection, with two OR-ed clauses', () => {
    expectClean(
      inMovement(
        [
          '  co = match graph-[:companies]-> {',
          '    unique by (FUZZY `name`)',
          '    unique by (`domains`)',
          '    name: msg.`subject`',
          '  }',
          '  write co-[:rounds]-> { stage: co.name }',
        ].join('\n'),
      ),
    );
  });

  it('MOV_MATCH_NO_IDENTITY when neither the author nor the target says what identifies the record', () => {
    const found = check(inMovement('  match graph-[:companies]-> { name: msg.`subject` }'));
    expect(found.map((d) => d.code)).toEqual([C.MATCH_NO_IDENTITY]);
    expect(found[0].message).toContain("add 'unique by (…)'");
  });

  it("a target that decides identity itself needs no 'unique by' — and refuses one", () => {
    expectClean(inMovement('  match aff-[:organizations]-> { name: msg.`subject` }'));
    expect(codes(inMovement('  match aff-[:organizations]-> { unique by (`name`), name: msg.`subject` }'))).toEqual([
      C.UNIQUE_NOT_AUTHORABLE,
    ]);
  });

  it('native uniqueness is identity enough', () => {
    const source = [
      'import { email, hubspot } from adapters',
      'import { dealflow_inbox, acme_hubspot } from credentials',
      'inbox = email(credentials: dealflow_inbox)',
      'crm2  = hubspot(credentials: acme_hubspot)',
      'movement main(msg: <inbox-[:message]->>) {',
      '  match crm2-[:companies]-> { domain: msg.`subject` }',
      '}',
    ].join('\n');
    expectClean(source);
  });

  it('UNIQUE_FUZZY_UNSUPPORTED on a target that matches exactly', () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  match co-[:rounds]-> { unique by (FUZZY `stage`), stage: "Seed" }',
      ].join('\n'),
    );
    expect(codes(source)).toEqual([C.UNIQUE_FUZZY_UNSUPPORTED]);
  });

  it('MOV_UNIQUE_UNKNOWN_FIELD / MOV_WRITE_UNKNOWN_FIELD for names the found type lacks', () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  match co-[:rounds]-> { unique by (`ghost`), ghost: "Seed" }',
      ].join('\n'),
    );
    const found = check(source);
    expect(found.map((d) => d.code)).toEqual([C.UNIQUE_UNKNOWN_FIELD, C.WRITE_UNKNOWN_FIELD]);
    expect(found[1].message).toContain("a match's fields are fields of the record it finds");
  });

  it('skips the create gates: a required field may be left out', () => {
    // `person` requires `name` on CREATE; a match creates nothing.
    expectClean(inMovement('  match graph-[:people]-> { unique by (`company`), company: "Acme" }'));
    expect(codes(inMovement('  write graph-[:people]-> { unique by (`company`), company: "Acme" }'))).toContain(
      C.WRITE_MISSING_REQUIRED_FIELD,
    );
  });

  it('only LOOKS along the edge: a read-only edge is fine, where a write is refused', () => {
    const body = (verb: string) =>
      inMovement(
        [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          `  ${verb} co-[:attachments]-> { unique by (\`name\`), name: "deck.pdf" }`,
        ].join('\n'),
      );
    expectClean(body('match'));
    expect(codes(body('write'))).toContain(C.WRITE_READ_ONLY_EDGE);
  });

  it("the handle is the record: 'created' / 'committed' are a write's, not a match's", () => {
    const read = (verb: string, field: string) =>
      [
        'import { email, hubspot } from adapters',
        'import { dealflow_inbox, acme_hubspot } from credentials',
        'inbox = email(credentials: dealflow_inbox)',
        'crm2  = hubspot(credentials: acme_hubspot)',
        'movement main(msg: <inbox-[:message]->>) {',
        `  co = ${verb} crm2-[:companies]-> { domain: msg.\`subject\` }`,
        `  write crm2-[:companies]-> { domain: "x", name: co.${field} }`,
        '}',
      ].join('\n');
    for (const field of ['created', 'committed']) {
      expectClean(read('write', field));
      const found = check(read('match', field));
      expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
      expect(found[0].message).toContain(`no field '${field}'`);
    }
    expectClean(read('match', 'name'));
  });

  it("MOV_LINKED_UNKNOWN_EDGE with match phrasing when the parent's type lacks the edge", () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  match co-[:ghost_edge]-> { unique by (`stage`), stage: "Seed" }',
      ].join('\n'),
    );
    const found = check(source);
    expect(found.map(d => d.code)).toEqual([C.LINKED_UNKNOWN_EDGE]);
    expect(found[0].message).toContain('a match looks along an edge');
  });

  it('MOV_LINKED_NEEDS_TYPE for a match over a polymorphic edge; the explicit type is clean', () => {
    const co = '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }';
    expect(codes(inMovement([co, '  match co-[:related]-> { unique by (`name`), name: "Acme" }'].join('\n')))).toEqual([
      C.LINKED_NEEDS_TYPE,
    ]);
    expectClean(inMovement([co, '  p = match co-[:related]-><person> { unique by (`name`), name: "Ada" }'].join('\n')));
  });

  it('notes a READ of the graph it looks in, never a write', () => {
    const rowOf = (verb: string) => {
      const { recording } = checkProgramWithLink(
        parseProgram(inMovement(`  ${verb} graph-[:companies]-> { unique by (\`name\`), name: msg.\`subject\` }`)),
        catalog,
        { recordAnalysis: true },
      );
      const main = recording?.frames.find((frame) => frame.kind === 'file')?.scope.symbols.get('main');
      if (main === undefined) throw new Error("'main' is not declared");
      const row = effectRowOf(main);
      if (row === undefined) throw new Error("'main' has no inferred row");
      return { read: row.read.map((s) => s.name), write: row.write.map((s) => s.name) };
    };
    expect(rowOf('match')).toEqual({ read: ['graph'], write: [] });
    expect(rowOf('write')).toEqual({ read: [], write: ['graph'] });
  });
});

describe('link statements', () => {
  // A body after the arrow is a match body: `x = link p-[:E]-> { … }` is
  // `x = match p-[:E]-> { … }` then `link p -[:E]-> x`, checked as exactly that.
  const CO = '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }';

  it('a bound body with a FUZZY unique by binds the FOUND handle, usable downstream', () => {
    expectClean(
      inMovement(
        [
          CO,
          '  p = link co -[:related]-><company> { unique by (FUZZY `name`), name: "Acme" }',
          '  write p-[:rounds]-> { stage: p.name }',
        ].join('\n'),
      ),
    );
  });

  it('an unbound body is a plain statement', () => {
    expectClean(inMovement([CO, '  link co -[:related]-><company> { unique by (`name`), name: "Acme" }'].join('\n')));
  });

  it('a body with no unique by identifies by all of its fields — never MOV_MATCH_NO_IDENTITY', () => {
    const fr = '  fr = write co-[:rounds]-> { stage: "Seed" }';
    expectClean(inMovement([CO, fr, '  f = link co -[:rounds]-> { stage: "Seed" }', '  write f-[:participants]-> { investor_name: "x" }'].join('\n')));
    // The same body spelled as `match` has said nothing about identity.
    expect(codes(inMovement([CO, '  match co-[:rounds]-> { stage: "Seed" }'].join('\n')))).toEqual([C.MATCH_NO_IDENTITY]);
  });

  it('an empty body has nothing to identify the record by', () => {
    expect(codes(inMovement([CO, '  link co -[:rounds]-> {}'].join('\n')))).toEqual([C.MATCH_NO_IDENTITY]);
  });

  it('checks the body as a match: FUZZY where the target cannot, fields the found type lacks', () => {
    expect(codes(inMovement([CO, '  link co -[:rounds]-> { unique by (FUZZY `stage`), stage: "Seed" }'].join('\n')))).toEqual([
      C.UNIQUE_FUZZY_UNSUPPORTED,
    ]);
    const found = check(inMovement([CO, '  link co -[:rounds]-> { ghost: "Seed" }'].join('\n')));
    expect(found.map((d) => d.code)).toEqual([C.WRITE_UNKNOWN_FIELD]);
    expect(found[0].message).toContain("a match's fields are fields of the record it finds");
  });

  it('the found handle is a match handle: no created / committed', () => {
    const found = check(
      inMovement([CO, '  p = link co -[:related]-><company> { name: "Acme" }', '  write p-[:rounds]-> { stage: p.created }'].join('\n')),
    );
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
  });

  it('a polymorphic edge needs the type named, as a match does', () => {
    expect(codes(inMovement([CO, '  link co -[:related]-> { name: "Acme" }'].join('\n')))).toEqual([C.LINKED_NEEDS_TYPE]);
  });

  it('notes a read (the match) and a write (the edge) of the graph', () => {
    const { recording } = checkProgramWithLink(
      parseProgram(inMovement('  co = match graph-[:companies]-> { unique by (`name`), name: "x" }\n  link co -[:related]-><company> { name: "Acme" }')),
      catalog,
      { recordAnalysis: true },
    );
    const main = recording?.frames.find((frame) => frame.kind === 'file')?.scope.symbols.get('main');
    if (main === undefined) throw new Error("'main' is not declared");
    const row = effectRowOf(main);
    if (row === undefined) throw new Error("'main' has no inferred row");
    expect(row.write.map((s) => s.name)).toEqual(['graph']);
  });

  describe('a target that decides identity itself', () => {
    const listsCatalog = mockCatalog({
      adapters: {
        email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
        lists: {
          constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
          schema: {
            positions: {
              entry: { properties: { stage: 'text' }, edges: { Owners: { target: 'person', writable: true } } },
              person: { properties: { 'Full name': 'text', Email: 'text' }, edges: {} },
            },
            collections: { entries: { target: 'entry' } },
            writableRoots: {
              entry: { fields: { stage: 'text' }, resultShape: { externalId: 'text', stage: 'text' }, uniquenessAuthorable: false },
              person: {
                fields: { 'Full name': 'text', Email: 'text' },
                resultShape: { externalId: 'text', 'Full name': 'text', Email: 'text' },
                uniquenessAuthorable: false,
              },
            },
          },
        },
      },
      credentials: { dealflow_inbox: { adapter: 'email' }, team_lists: { adapter: 'lists' } },
    });
    const inLists = (body: string) =>
      [
        'import { email, lists } from adapters',
        'import { dealflow_inbox, team_lists } from credentials',
        'inbox = email(credentials: dealflow_inbox)',
        'crm = lists(credentials: team_lists)',
        'movement main(msg: <inbox-[:message]->>) {',
        '  entry = write crm-[:entries]-> { stage: "Seed" }',
        body,
        '}',
      ].join('\n');
    const errors = (source: string) =>
      checkProgram(parseProgram(source), listsCatalog).filter((d) => (d.severity ?? 'error') === 'error');

    it('takes the body as its lookup, with no unique by to refuse', () => {
      expect(errors(inLists('  link entry -[:Owners]-> { `Full name`: msg.`subject` }')).map((d) => d.code)).toEqual([]);
    });

    it("refuses a 'unique by' the author wrote, as a match does", () => {
      expect(
        errors(inLists('  link entry -[:Owners]-> { unique by (`Email`), Email: msg.`subject` }')).map((d) => d.code),
      ).toEqual([C.UNIQUE_NOT_AUTHORABLE]);
    });
  });

  it('refuses a body from a node this run built: what it finds is linked already', () => {
    const found = check(
      inMovement(
        [
          '  sent = node { messages: [] }',
          '  link sent -[:messages]-> { unique by (`text`), text: "x" }',
        ].join('\n'),
      ),
    );
    expect(found.map((d) => d.code)).toContain(C.NODE_LINK_BODY);
  });

  // A `writable` edge promises two things — create the target along it, or
  // join one that is already there — and a system can keep the first without
  // the second. It says so per edge, and the refusal lands at check time
  // rather than as a run that fails in the target's API.
  describe('an edge the system can only WRITE along refuses link and unlink', () => {
    const withRecords = (rest: string) =>
      inMovement(
        [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          '  e = write co-[:entries]-> { stage: "Seed" }',
          rest,
        ].join('\n'),
      );

    it('refuses the bare-handle link, naming the edge', () => {
      const found = check(withRecords('  link co -[:entries]-> e'));
      expect(found.map(d => d.code)).toEqual([C.LINK_UNSUPPORTED_EDGE]);
      expect(found[0].message).toContain('entries');
      expect(found[0].message).toContain('write co-[:entries]->');
    });

    it('refuses a link body too — the match finds, the link still joins', () => {
      const found = check(withRecords('  link co -[:entries]-> { stage: "Seed" }'));
      expect(found.map(d => d.code)).toEqual([C.LINK_UNSUPPORTED_EDGE]);
    });

    it('a match along it is clean — a match joins nothing', () => {
      expectClean(withRecords('  match co-[:entries]-> { unique by (`stage`), stage: "Seed" }'));
    });

    it('refuses unlink — a relationship it cannot make, it cannot sever', () => {
      const found = check(withRecords('  unlink co -[:entries]-> e'));
      expect(found.map(d => d.code)).toEqual([C.LINK_UNSUPPORTED_EDGE]);
      expect(found[0].message).toContain('unlink');
    });

    it('the WRITE along that same edge stays clean — only the join is refused', () => {
      expectClean(withRecords('  write co-[:entries]-> { stage: "Series A" }'));
    });

    it('an edge that says nothing keeps the whole promise', () => {
      expectClean(
        inMovement(
          [
            '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
            '  fr = write co-[:rounds]-> { stage: "Seed" }',
            '  link co -[:rounds]-> fr',
            '  unlink co -[:rounds]-> fr',
          ].join('\n'),
        ),
      );
    });
  });
});

// ── Tuple-path multi-parent writes ──

const TUPLE_PARENTS = [
  '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
  '  inv = write graph-[:investor]-> { unique by (`name`), name: msg.`subject` }',
].join('\n');

describe('tuple-path writes', () => {
  it('a clean tuple write at the convergence of both required parents', () => {
    expectClean(
      inMovement(
        [
          TUPLE_PARENTS,
          '  write (co-[:investments]->, inv-[:investments]->) {',
          '    unique by (co AND inv)',
          '    amount: 5',
          '  }',
        ].join('\n'),
      ),
    );
  });

  it('MOV_WRITE_TUPLE_MISMATCH when the paths infer different written types, naming both', () => {
    const source = inMovement(
      [
        TUPLE_PARENTS,
        '  write (co-[:investments]->, co-[:rounds]->) {',
        '    amount: 5',
        '  }',
      ].join('\n'),
    );
    const found = check(source);
    expect(found.map(d => d.code)).toEqual([C.WRITE_TUPLE_MISMATCH]);
    expect(found[0].message).toContain('graph.investment');
    expect(found[0].message).toContain('graph.funding_round');
  });

  it('tuple field and unique-by validation runs against the agreed type', () => {
    expect(
      codes(
        inMovement(
          [
            TUPLE_PARENTS,
            '  write (co-[:investments]->, inv-[:investments]->) {',
            '    unique by (co AND inv)',
            '    ghost: 5',
            '  }',
          ].join('\n'),
        ),
      ),
    ).toEqual([C.WRITE_UNKNOWN_FIELD]);
  });
});

// ── Required edges (descriptor `required` → create-form completeness) ──

describe('required edges', () => {
  it('an instance-target write to a type with required edges errors, listing both', () => {
    const source = inMovement(
      [TUPLE_PARENTS, '  write graph-[:investment]-> { amount: 5 }'].join('\n'),
    );
    const found = check(source);
    expect(found.map(d => d.code)).toEqual([C.WRITE_MISSING_REQUIRED_EDGE]);
    expect(found[0].message).toContain("'investments' (a company parent)");
    expect(found[0].message).toContain("'investments' (a investor parent)");
  });

  it('a linked write satisfies its own parent but still misses the other (type-keyed, not name-keyed)', () => {
    const source = inMovement(
      [TUPLE_PARENTS, '  write co-[:investments]-> { amount: 5 }'].join('\n'),
    );
    const found = check(source);
    expect(found.map(d => d.code)).toEqual([C.WRITE_MISSING_REQUIRED_EDGE]);
    expect(found[0].message).toContain('investor parent');
    expect(found[0].message).not.toContain('company parent');
  });

  it('the full tuple satisfies every required edge (covered by the clean tuple case)', () => {
    expectClean(
      inMovement(
        [
          TUPLE_PARENTS,
          '  write (co-[:investments]->, inv-[:investments]->) { amount: 5 }',
        ].join('\n'),
      ),
    );
  });

  // A required edge whose `from` is a UNION — the shape a required multi-target
  // reference projects. ANY member satisfies it, which is what the union means;
  // comparing the parent to the union's derived key alone would reject every
  // legitimate parent, and print the key at the author.
  describe('a required edge onto a union', () => {
    const withParent = (kind: 'companies' | 'people', rest: string) =>
      inMovement(
        [`  p = write graph-[:${kind}]-> { name: "Acme" }`, rest].join('\n'),
      );

    it('is satisfied by a parent of either member', () => {
      expectClean(withParent('companies', '  write p-[:signals]-> { text: "hot" }'));
      expectClean(withParent('people', '  write p-[:signals]-> { text: "hot" }'));
    });

    it('still errors when no parent establishes it, naming the union by its DISPLAY', () => {
      const found = check(inMovement('  write graph-[:signal]-> { text: "hot" }'));
      expect(found.map(d => d.code)).toEqual([C.WRITE_MISSING_REQUIRED_EDGE]);
      expect(found[0].message).toContain('company | person');
      expect(found[0].message).not.toContain('"union"');
    });
  });

  it('types without required edges stay silent', () => {
    expectClean(inMovement('  write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }'));
  });
});

// ── Required fields (scalar create-form completeness + nullable guards) ──

describe('required fields', () => {
  const warnings = (source: string): Diagnostic[] =>
    checkProgram(parseProgram(source), catalog).filter(d => d.severity === 'warning');

  it('a write that never sets a required field errors, naming it', () => {
    const found = check(inMovement('  write graph-[:contact]-> { name: msg.`subject` }'));
    expect(found.map(d => d.code)).toEqual([C.WRITE_MISSING_REQUIRED_FIELD]);
    expect(found[0].message).toContain("'email'");
    expect(found[0].message).not.toContain("'name'");
  });

  it('a write missing several required fields lists them all', () => {
    const found = check(inMovement('  write graph-[:contact]-> { note: msg.`subject` }'));
    expect(found.map(d => d.code)).toEqual([C.WRITE_MISSING_REQUIRED_FIELD]);
    expect(found[0].message).toContain("'name'");
    expect(found[0].message).toContain("'email'");
  });

  // The AI()-without-COALESCE source-regex heuristic is RETIRED (asks-as-adapter
  // chunk D, P20): typed absence propagation subsumes it. A `DATE.PARSE` that can
  // fail types `date | absent` and fires MOV_ABSENT_REQUIRED at the required-value
  // site; AI() stays untyped (silent) — no bespoke string-match warning.
  it('an unguarded AI() into a required field no longer emits the retired nullable warning', () => {
    const source = inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email: AI("the email address")',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).toEqual([]); // present — not the missing-field error
    expect(warnings(source).map(d => d.code)).not.toContain('MOV_WRITE_REQUIRED_NULLABLE');
  });

  it('an unguarded DATE.PARSE into a required field is MOV_ABSENT_REQUIRED (typed absence)', () => {
    const source = inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email: DATE.PARSE(msg.`subject`)',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).toContain(C.ABSENT_REQUIRED);
  });

  it('a `?:` fill discharges the possibly-absent DATE.PARSE cleanly', () => {
    const source = inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email ?: DATE.PARSE(msg.`subject`)',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).not.toContain(C.ABSENT_REQUIRED);
  });

  // URL.HOST(text) — same shape as DATE.PARSE: `text | absent`, absent when
  // the text doesn't parse as a URL with a host.
  it('an unguarded URL.HOST into a required field is MOV_ABSENT_REQUIRED (typed absence)', () => {
    const source = inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email: URL.HOST(msg.`subject`)',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).toContain(C.ABSENT_REQUIRED);
  });

  it('a `?:` fill discharges the possibly-absent URL.HOST cleanly', () => {
    const source = inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email ?: URL.HOST(msg.`subject`)',
        '  }',
      ].join('\n'),
    );
    expect(codes(source)).not.toContain(C.ABSENT_REQUIRED);
  });
});

describe('AI(prompt, tier)', () => {
  const withNote = (note: string): string =>
    inMovement(
      [
        '  write graph-[:contact]-> {',
        '    name: msg.`subject`',
        '    email: msg.`subject`',
        `    note: ${note}`,
        '  }',
      ].join('\n'),
    );

  it('accepts each tier, and a call with none', () => {
    expect(codes(withNote('AI("a note", "quick")'))).toEqual([]);
    expect(codes(withNote('AI("a note", "careful")'))).toEqual([]);
    expect(codes(withNote('AI("a note", "thorough")'))).toEqual([]);
    expect(codes(withNote('AI("a note")'))).toEqual([]);
    expect(codes(withNote('AI(CONCAT("about ", AI("the sender", "quick")), "thorough")')))
      .toEqual([]);
  });

  it('refuses a tier it does not have, suggesting the closest', () => {
    const diagnostics = check(withNote('AI("a note", "thourough")'));
    expect(diagnostics.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics.map(d => d.message).join('\n')).toContain('Did you mean "thorough"?');
  });

  it('refuses a word that is no tier at all', () => {
    expect(codes(withNote('AI("a note", "loud")'))).toContain(C.ENUM_UNKNOWN_VALUE);
  });

  // The tier is READ where the program is saved, so it has to be written down
  // — the rule a date format pattern lives under.
  it('refuses a computed tier, and one passed by name', () => {
    expect(codes(withNote('AI("a note", msg.`subject`)'))).toContain(C.EXPR_PARSE);
    expect(codes(withNote('AI("a note", `Preferred Tier`)'))).toContain(C.EXPR_PARSE);
  });

  it('rejects a third argument', () => {
    expect(codes(withNote('AI("a note", "careful", "extra")'))).toContain(C.EXPR_PARSE);
  });

  // The spelling that predates the tiers still runs, and still means what it
  // meant — so it is a nudge toward the word we teach, never a refusal.
  it('accepts the legacy "smart" spelling with an info nudge naming the tier', () => {
    expect(codes(withNote('AI("a note", "smart")'))).toEqual([]);
    const legacy = infos(withNote('AI("a note", "smart")'))
      .filter(d => d.code === C.AI_TIER_LEGACY);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].message).toContain('"careful"');
  });
});

describe('extract "tier" from […]', () => {
  const withExtract = (head: string): string =>
    inMovement(
      [
        `  found = ${head} from [msg.\`subject\`] {`,
        '    node company: "each company mentioned" {',
        '      name: "the company\'s name"',
        '    }',
        '  }',
        '  found-[c:company]-> {',
        '    write graph-[:contact]-> {',
        '      name ?: c.name',
        '      email: msg.`subject`',
        '    }',
        '  }',
      ].join('\n'),
    );

  it('accepts each tier, and an extract with none', () => {
    expect(codes(withExtract('extract "quick"'))).toEqual([]);
    expect(codes(withExtract('extract "careful"'))).toEqual([]);
    expect(codes(withExtract('extract "thorough"'))).toEqual([]);
    expect(codes(withExtract('extract'))).toEqual([]);
  });

  it('refuses a tier it does not have, suggesting the closest', () => {
    const diagnostics = check(withExtract('extract "quik"'));
    expect(diagnostics.map(d => d.code)).toContain(C.ENUM_UNKNOWN_VALUE);
    expect(diagnostics.map(d => d.message).join('\n')).toContain('Did you mean "quick"?');
  });

  it('nudges the legacy spelling toward the tier it means', () => {
    expect(codes(withExtract('extract "smart"'))).toEqual([]);
    expect(infos(withExtract('extract "smart"')).map(d => d.code)).toContain(C.AI_TIER_LEGACY);
  });
});

// ── The handle-into-reference-field nudge ──

describe('handle assigned to a reference-named field', () => {
  it('info-severity nudge toward the link / tuple forms', () => {
    const source = inMovement(
      [
        '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  write graph-[:deals]-> { name: msg.`subject`, company: co }',
      ].join('\n'),
    );
    expect(codes(source)).toEqual([]); // legal — `company` IS a writable field of deal
    const found = infos(source).filter(d => d.code === C.WRITE_LINK_FIELD_NUDGE);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("'company' is a relationship of graph.deal");
  });

  it('no nudge for a non-handle value in the same field', () => {
    const source = inMovement(
      '  write graph-[:deals]-> { name: msg.`subject`, company: msg.`subject` }',
    );
    expect(infos(source).map(d => d.code)).not.toContain(C.WRITE_LINK_FIELD_NUDGE);
  });
});

// ── Declared-node movement parameters ──

describe('a <Declaration> parameter types the body', () => {
  const withShape = (body: string) =>
    `${PRELUDE}
node Meeting { \`Title\`: <text> }
movement log_meeting(m: <Meeting>) {
${body}
}`;

  it('reads a declared field cleanly', () => {
    expectClean(withShape('  write crm-[:note]-> { text: m.`Title` }'));
  });

  it('flags a read of a field the declaration does not declare', () => {
    expect(codes(withShape('  write crm-[:note]-> { text: m.`Nope` }')))
      .toContain('MOV_UNKNOWN_PROPERTY');
  });
});

// ── Per-listen shape conformance ──

describe('per-listen shape conformance', () => {
  const folderEnum: SchemaFieldType = { kind: 'enum', options: ['Sales', 'Eng'] };
  const itemSchema = (props: Record<string, SchemaFieldType>): InstanceSchema => ({
    positions: { item: { properties: props, edges: {} } },
    collections: { items: { target: 'item' } },
    writableRoots: {},
    eventPosition: 'item',
  });

  const conf = mockCatalog({
    adapters: {
      full: { constructionArgs: [], schema: itemSchema({ Title: 'text', Folder: 'text' }) },
      lean: { constructionArgs: [], schema: itemSchema({ Title: 'text' }) },
      enumic: { constructionArgs: [], schema: itemSchema({ Title: 'text', Folder: folderEnum }) },
      opaque: { constructionArgs: [], schema: { positions: { item: { properties: {}, edges: {}, openProperties: true } }, collections: { items: { target: 'item' } }, writableRoots: {}, eventPosition: 'item' } },
      kg: { constructionArgs: [], schema: kgSchema },
    },
    credentials: {},
  });

  const prog = (adapter: string) => `
import { ${adapter}, kg } from adapters
src = ${adapter}()
graph = kg()
node Meeting {
  \`Title\`: <text>
  \`Folder\`: <text>
}
movement log(m: <Meeting>) { write graph-[:people]-> { name: m.\`Title\` } }
listen to src {} fire log`;

  const errorCodes = (adapter: string) =>
    checkProgram(parseProgram(prog(adapter)), conf)
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);

  it('a conforming lane is clean', () => {
    expect(errorCodes('full')).not.toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });
  it('a lane missing a declared field errors', () => {
    expect(errorCodes('lean')).toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });
  it('an enum source widens to a text declared field (clean)', () => {
    expect(errorCodes('enumic')).not.toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });
  it("an un-introspectable (open) event position is unchecked, not an error", () => {
    expect(errorCodes('opaque')).not.toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });
});

describe('per-listen shape conformance — recursive edge target checking', () => {
  // A declaration whose root reaches a nested node: the nesting IS the
  // `attendees` edge, and the nested node requires `Email`.
  const withAttendeesShape = `
node WithAttendees {
  \`Title\`: <text>
  node attendees {
    \`Email\`: <text>
  }
}
`;

  // Helper: build a two-position InstanceSchema for testing recursive checks.
  const meetingSchema = (opts: {
    meetingEdges?: Record<string, { target: string }>;
    attendeeProps?: Record<string, SchemaFieldType>;
  }): InstanceSchema => ({
    positions: {
      meeting: {
        properties: { Title: 'text' },
        edges: opts.meetingEdges ?? {},
      },
      attendee: {
        properties: opts.attendeeProps ?? {},
        edges: {},
      },
    },
    collections: { meetings: { target: 'meeting' } },
    writableRoots: {},
    eventPosition: 'meeting',
  });

  const recursiveConf = mockCatalog({
    adapters: {
      // meeting has attendees edge → attendee has Email ✓
      good: {
        constructionArgs: [],
        schema: meetingSchema({
          meetingEdges: { attendees: { target: 'attendee' } },
          attendeeProps: { Email: 'text' },
        }),
      },
      // meeting has attendees edge → attendee LACKS Email ✗ (new recursive check)
      badTarget: {
        constructionArgs: [],
        schema: meetingSchema({
          meetingEdges: { attendees: { target: 'attendee' } },
          attendeeProps: {}, // Email missing
        }),
      },
      // meeting LACKS attendees edge ✗ (existing existence check)
      missingEdge: {
        constructionArgs: [],
        schema: meetingSchema({
          meetingEdges: {},
          attendeeProps: { Email: 'text' },
        }),
      },
      kg: { constructionArgs: [], schema: kgSchema },
    },
    credentials: {},
  });

  const prog = (adapter: string) => `
import { ${adapter}, kg } from adapters
src = ${adapter}()
graph = kg()
${withAttendeesShape}
movement log(m: <WithAttendees>) { write graph-[:people]-> { name: m.\`Title\` } }
listen to src {} fire log`;

  const errorCodes = (adapter: string) =>
    checkProgram(parseProgram(prog(adapter)), recursiveConf)
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);

  it('conforming edge + target with required field is clean', () => {
    expect(errorCodes('good')).not.toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });

  it('edge exists but target position lacks required field errors (recursive check)', () => {
    // This is the key new behavior: existence-only would have passed here.
    expect(errorCodes('badTarget')).toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });

  it('missing edge errors (existing existence check still holds)', () => {
    expect(errorCodes('missingEdge')).toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });

  it('a self-referential INSTANCE edge terminates without hanging (cycle guard)', () => {
    // Declarations are trees, so the cycle can only come from the instance.
    const selfRefConf = mockCatalog({
      adapters: {
        selfref: {
          constructionArgs: [],
          schema: {
            positions: {
              n: {
                properties: { name: 'text' },
                edges: { self: { target: 'n' } },
              },
            },
            collections: { items: { target: 'n' } },
            writableRoots: {},
            eventPosition: 'n',
          },
        },
        kg: { constructionArgs: [], schema: kgSchema },
      },
      credentials: {},
    });

    const selfProg = `
import { selfref, kg } from adapters
src = selfref()
graph = kg()
node Loop {
  \`name\`: <text>
  node self {
    \`name\`: <text>
  }
}
movement log(m: <Loop>) { write graph-[:people]-> { name: m.\`name\` } }
listen to src {} fire log`;

    // Test simply completing (no infinite loop / stack overflow) proves the cycle guard works.
    const result = checkProgram(parseProgram(selfProg), selfRefConf)
      .filter(d => (d.severity ?? 'error') === 'error')
      .map(d => d.code);
    expect(result).not.toContain('MOV_LISTEN_SHAPE_MISMATCH');
  });
});

describe('alias uniqueness within a movement', () => {
  const src = (a1: string, a2: string) => `
import { manual, kg } from adapters
import { native_knowledge } from credentials
ga = manual()
gb = manual()
graph = kg(credentials: native_knowledge)
movement main(x: <ga-[:event]->>) { write graph-[:people]-> { name: x.\`id\` } }
listen as "${a1}" to ga {} fire main
listen as "${a2}" to gb {} fire main`;
  const codesFor = (a1: string, a2: string) =>
    checkProgram(parseProgram(src(a1, a2)), catalog).map(d => d.code);

  it('duplicate aliases firing the same movement error', () => {
    expect(codesFor('Same', 'Same')).toContain('MOV_LISTEN_ALIAS_DUPLICATE');
  });
  it('distinct aliases are clean of the duplicate code', () => {
    expect(codesFor('Alice', 'Bob')).not.toContain('MOV_LISTEN_ALIAS_DUPLICATE');
  });
});

describe('a write handle is a traversal head (checker agrees with the engine)', () => {
  const srcSchema: InstanceSchema = {
    positions: { ping: { properties: { at: 'text' }, edges: {} } },
    collections: { pings: { target: 'ping' } },
    writableRoots: {},
  };
  const kgSchema: InstanceSchema = {
    positions: {
      company: { properties: { name: 'text' }, edges: { contacts: { target: 'contact' } } },
      contact: { properties: { name: 'text' }, edges: {} },
      log: { properties: { text: 'text' }, edges: {} },
    },
    collections: { company: { target: 'company' }, contact: { target: 'contact' }, log: { target: 'log' } },
    writableRoots: {
      company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } },
      log: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } },
    },
  };
  const handleCatalog = mockCatalog({
    adapters: {
      src: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: srcSchema },
      kg: { constructionArgs: [], schema: kgSchema },
    },
    credentials: { src_cred: { adapter: 'src' } },
  });
  const handlePrelude = [
    'import { src, kg } from adapters',
    'import { src_cred } from credentials',
    '',
    's = src(credentials: src_cred)',
    'graph = kg()',
  ].join('\n');
  const handleCodes = (body: string): string[] =>
    // The movement param TypeRef names the POSITION (`ping`), not the collection
    // (`pings`) — same as the existing capCatalog fixture's `<c-[:company]->>`.
    checkProgram(parseProgram(`${handlePrelude}\nmovement main(p: <s-[:ping]->>) {\n${body}\n}`), handleCatalog)
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);

  it('block-head traversal off a handle checks clean', () => {
    expect(
      handleCodes(`  co = write graph-[:company]-> { name: "Acme" }
  co-[c:contacts]-> {
    write graph-[:log]-> { text: c.name }
  }`),
    ).toEqual([]);
  });

  it('expression traversal off a handle checks clean', () => {
    expect(
      handleCodes(`  co = write graph-[:company]-> { name: "Acme" }
  write graph-[:log]-> { text: "\${co-[:contacts]->.name}" }`),
    ).toEqual([]);
  });

  it('an unknown edge off a handle is still rejected', () => {
    expect(
      handleCodes(`  co = write graph-[:company]-> { name: "Acme" }
  co-[x:nope]-> {
    write graph-[:log]-> { text: "x" }
  }`),
    ).toContain(C.TRAVERSE_UNKNOWN_EDGE);
  });
});

// `READ(file)` turns an attachment into its text. The type is `text | absent`:
// a file nothing could read answers with nothing, and the REASON is on the run
// trace rather than in the type (an absence in this language carries no reason).
// The argument has to be a file — reading a piece of text is a mistake visible
// here — but a file that may itself be absent is fine: READ of nothing is
// nothing.
describe('READ(file)', () => {
  const inAttachment = (body: string) =>
    inMovement([
      '  msg-[f:files]-> {',
      `    ${body}`,
      '  }',
    ].join('\n'));

  it('types as text — a COALESCE fill writes into a text field cleanly', () => {
    expectClean(
      inAttachment('write graph-[:contact]-> { name: COALESCE(READ(f.`data`), ""), email: "a@b.c" }'),
    );
  });

  it('types as POSSIBLY ABSENT — unguarded into a required field is MOV_ABSENT_REQUIRED', () => {
    expect(
      codes(inAttachment('write graph-[:contact]-> { name: READ(f.`data`), email: "a@b.c" }')),
    ).toContain(C.ABSENT_REQUIRED);
  });

  it('a `?:` fill discharges the absence, exactly as it does for DATE.PARSE', () => {
    expect(
      codes(inAttachment('write graph-[:contact]-> { name ?: READ(f.`data`), email: "a@b.c" }')),
    ).not.toContain(C.ABSENT_REQUIRED);
  });

  it('reading something that is not a file names the type it got', () => {
    const found = check(
      inAttachment('write graph-[:contact]-> { name: COALESCE(READ(f.`filename`), ""), email: "a@b.c" }'),
    );
    expect(found.map(d => d.code)).toContain(C.READ_NOT_FILE);
    expect(found.find(d => d.code === C.READ_NOT_FILE)?.message).toContain('text');
  });

  it('reading a literal is the same mistake', () => {
    expect(
      codes(inMovement('write graph-[:contact]-> { name: COALESCE(READ("x"), ""), email: "a@b.c" }')),
    ).toContain(C.READ_NOT_FILE);
  });

  it('an untyped argument stays silent — an unknown surface is not a claim', () => {
    expectClean(
      inAttachment('write graph-[:contact]-> { name: COALESCE(READ(AI("the deck")), ""), email: "a@b.c" }'),
    );
  });
});

// `CHUNKS(text, { size | entities, overlap })` cuts a long text into pieces. The type is
// `list of text` and never `| absent`: a text that isn't there has no pieces,
// which is an empty collection rather than an absence, so the result is usable
// without a guard. The options arrive as a MAP — the first built-in to take
// one — whose keys the bridge settles (they are written down) and whose values
// the checker types, since an ordinary expression stands in each.
describe('CHUNKS(text, { size | entities, overlap })', () => {
  it('types as a collection of TEXT — a piece added up is the arithmetic error', () => {
    expect(
      codes(inMovement([
        '  pieces = CHUNKS(msg.`text`, { size: 2000, overlap: 200 })',
        '  bad = MAP(pieces, (p) => { return p + 1 })',
      ].join('\n'))),
    ).toContain(C.ARITH_NON_NUMERIC);
  });

  it('reads as a collection, so the collection ops take it with nothing in between', () => {
    expectClean(inMovement([
      '  pieces = CHUNKS(msg.`text`, { size: 2000, overlap: 200 })',
      '  loud = MAP(pieces, (p) => { return UPPER(p) })',
    ].join('\n')));
  });

  it('is never absent — an unguarded result is not MOV_ABSENT_REQUIRED', () => {
    expect(
      codes(inMovement('  pieces = CHUNKS(msg.`text`, { size: 2000 })')),
    ).not.toContain(C.ABSENT_REQUIRED);
  });

  it('a text that may itself be absent is fine — nothing to cut is no pieces', () => {
    expectClean(
      inMovement([
        '  msg-[f:files]-> {',
        '    pieces = CHUNKS(READ(f.`data`), { size: 2000 })',
        '    loud = MAP(pieces, (p) => { return UPPER(p) })',
        '  }',
      ].join('\n')),
    );
  });

  it('cutting something that is not a text names the type it got', () => {
    const found = check(
      inMovement([
        '  msg-[f:files]-> {',
        '    pieces = CHUNKS(f.`data`, { size: 2000 })',
        '  }',
      ].join('\n')),
    );
    expect(found.map(d => d.code)).toContain(C.CHUNKS_NOT_TEXT);
    expect(found.find(d => d.code === C.CHUNKS_NOT_TEXT)?.message).toContain('file');
  });

  it('a computed size is fine — only the KEYS are written down', () => {
    expectClean(inMovement('  pieces = CHUNKS(msg.`text`, { size: LENGTH(msg.`text`) / 3 })'));
  });

  it('a size that is not a number names the option and the type it got', () => {
    const found = check(inMovement('  pieces = CHUNKS(msg.`text`, { size: msg.`subject` })'));
    expect(found.map(d => d.code)).toContain(C.OPTION_INVALID);
    expect(found.find(d => d.code === C.OPTION_INVALID)?.message).toContain("'size'");
  });

  it('a size that may not answer is refused where it is written, not at the run', () => {
    // The first of a list may find nothing there, so the size is `number |
    // absent` — which at the run is a size of nothing.
    const found = check(
      inMovement('  pieces = CHUNKS(msg.`text`, { size: FIRST([1000, 2000]) })'),
    );
    expect(found.map(d => d.code)).toContain(C.OPTION_INVALID);
    expect(found.find(d => d.code === C.OPTION_INVALID)?.message).toContain('may not answer');
    // A literal index into a literal reads a slot that is always there.
    expect(
      check(inMovement('  pieces = CHUNKS(msg.`text`, { size: AT([1000, 2000], 0) })')).map(d => d.code),
    ).not.toContain(C.OPTION_INVALID);
  });

  it('an option key nobody has reaches the author as a diagnostic, not a silence', () => {
    const found = check(inMovement('  pieces = CHUNKS(msg.`text`, { size: 10, stride: 2 })'));
    expect(found.map(d => d.message).join('\n')).toContain("has no option 'stride'");
  });

  it('a call that says neither how many characters nor how many records reaches the author too', () => {
    expect(
      check(inMovement('  pieces = CHUNKS(msg.`text`, { overlap: 10 })'))
        .map(d => d.message).join('\n'),
    ).toContain("needs one of 'size' or 'entities'");
  });

  it('a count of expected records types the same way a size does', () => {
    expectClean(inMovement([
      '  pieces = CHUNKS(msg.`text`, { entities: 20 })',
      '  loud = MAP(pieces, (p) => { return UPPER(p) })',
    ].join('\n')));
  });

  it('a count of records that is not a number names the option and the type it got', () => {
    const found = check(inMovement('  pieces = CHUNKS(msg.`text`, { entities: msg.`subject` })'));
    expect(found.map(d => d.code)).toContain(C.OPTION_INVALID);
    expect(found.find(d => d.code === C.OPTION_INVALID)?.message).toContain("'entities'");
  });
});
