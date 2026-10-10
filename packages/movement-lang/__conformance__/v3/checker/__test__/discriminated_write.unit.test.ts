// Discriminated write shapes (plan layer 10): a create's writable body is a
// DISCRIMINATED UNION — one required discriminant field whose LITERAL value
// selects the variant, and the variant determines the rest of the shape. The
// write-side dual of read narrowing (there a WHERE's literal selects a variant;
// here a required field NAMES the target).
//
// THREE adapters exercise it so a hardcode can't pass (movement-lang/CLAUDE.md's
// second-shape rule): `attio` mirrors the proving Attio case (a `Lists`
// create-edge, discriminant `listName`, one variant with an extra `Stage`, one
// without) and `helpdesk` is a DELIBERATELY DIFFERENT shape (a `ticket` ROOT
// write, discriminant `queue`, extra field `refundAmount` REQUIRED on one
// variant only). Different edge kind (create-edge vs root), different field
// names, different required-per-variant — the mechanism must be general.
// `affinity` is the third: its variants are TYPES of their own, which is what
// the write's HANDLE stands on.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { SchemaFieldType, InstanceSchema, mockCatalog } from '../catalog';

// ── Schemas ──

const emailSchema: InstanceSchema = {
  positions: {
    message: { properties: { subject: 'text', text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const listNameEnum: SchemaFieldType = { kind: 'enum', options: ['VC Deal Flow', 'Pipeline'] };
const stageEnum: SchemaFieldType = { kind: 'enum', options: ['Diligence', 'Passed'] };

// The proving case: adding a company to a list is a create ALONG the `Lists`
// edge, and the entry values that are valid depend on WHICH list — `VC Deal
// Flow` carries `Stage`, `Pipeline` carries nothing.
const attioSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text' },
      edges: { Lists: { target: 'membership', writable: true } },
    },
    // The `Lists` edge's read target — irrelevant to the write, kept minimal.
    membership: { properties: {}, edges: {}, openProperties: true },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {},
  createShapes: {
    membership: {
      // The FALLBACK shape (the a549ef96c baseline): closed to the
      // discriminant, whose `requiredFields` make a MISSING `listName` the
      // required-field error. Used only when no variant can be selected.
      fields: { listName: listNameEnum },
      requiredFields: ['listName'],
      resultShape: { externalId: 'text' },
      discriminated: {
        discriminant: 'listName',
        variants: {
          'VC Deal Flow': {
            fields: { listName: listNameEnum, Stage: stageEnum },
            requiredFields: ['listName'],
            resultShape: { externalId: 'text' },
          },
          Pipeline: {
            fields: { listName: listNameEnum },
            requiredFields: ['listName'],
            resultShape: { externalId: 'text' },
          },
        },
      },
    },
  },
};

const queueEnum: SchemaFieldType = { kind: 'enum', options: ['Billing', 'General'] };

// The second, deliberately-different shape: a ROOT write (not a create-edge),
// discriminant `queue`, and the extra field `refundAmount` is REQUIRED on the
// `Billing` variant only — proving `requiredFields` is selected per-variant,
// not global, and that none of the machinery is `listName`/`Stage`-specific.
const helpdeskSchema: InstanceSchema = {
  positions: {
    ticket: { properties: { subject: 'text' }, edges: {} },
  },
  collections: { tickets: { target: 'ticket' } },
  writableRoots: {
    ticket: {
      fields: { queue: queueEnum },
      requiredFields: ['queue'],
      resultShape: { externalId: 'text' },
      discriminated: {
        discriminant: 'queue',
        variants: {
          Billing: {
            fields: { queue: queueEnum, refundAmount: 'number' },
            requiredFields: ['queue', 'refundAmount'],
            resultShape: { externalId: 'text' },
          },
          General: {
            fields: { queue: queueEnum },
            requiredFields: ['queue'],
            resultShape: { externalId: 'text' },
          },
        },
      },
    },
  },
};

// The THIRD shape, and the one the handle rule is about: a variant that is a
// TYPE of its own. Affinity's membership collection publishes only the
// discriminant (it is the intersection of every list); each list's own type
// carries that list's fields AND its reference edges. So a write naming a list
// hands back a handle standing on that list's type — `Owners` is reachable off
// it — while a write that names no list keeps the collection.
const crmSchema: InstanceSchema = {
  positions: {
    organization: {
      properties: { Name: 'text' },
      edges: { 'List Entries': { target: 'entry', writable: true } },
    },
    // The collection: closed, and publishing nothing but the discriminant.
    entry: { properties: { listName: 'text' }, edges: {} },
    'List Entry — Deals': {
      properties: { listName: 'text', 'Deal Stage': 'text' },
      edges: { Owners: { target: 'person', writable: true } },
    },
    'List Entry — Intros': { properties: { listName: 'text' }, edges: {} },
    person: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { organizations: { target: 'organization' }, people: { target: 'person' } },
  writableRoots: {
    person: { fields: { Name: 'text' }, resultShape: { externalId: 'text' } },
  },
  createShapes: {
    entry: {
      fields: { listName: { kind: 'enum', options: ['Deals', 'Intros'] } },
      requiredFields: ['listName'],
      resultShape: { externalId: 'text' },
      discriminated: {
        discriminant: 'listName',
        variants: {
          Deals: {
            fields: { listName: 'text', 'Deal Stage': 'text' },
            requiredFields: ['listName'],
            resultShape: { externalId: 'text', 'Deal Stage': 'text' },
            edges: { Owners: { target: 'person', writable: true } },
            position: 'List Entry — Deals',
          },
          Intros: {
            fields: { listName: 'text' },
            requiredFields: ['listName'],
            resultShape: { externalId: 'text' },
            position: 'List Entry — Intros',
          },
        },
      },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: emailSchema,
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: attioSchema,
    },
    helpdesk: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: helpdeskSchema,
    },
    affinity: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    acme_desk: { adapter: 'helpdesk' },
    acme_crm: { adapter: 'affinity' },
  },
});

const PRELUDE = [
  'import { email, attio, helpdesk, affinity } from adapters',
  'import { dealflow_inbox, acme_main, acme_desk, acme_crm } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'hd    = helpdesk(credentials: acme_desk)',
  'aff   = affinity(credentials: acme_crm)',
].join('\n');

const inMovement = (body: string): string =>
  `${PRELUDE}\nmovement m(msg: <inbox-[:message]->>) {\n${body}\n}`;

const check = (body: string): Diagnostic[] =>
  checkProgram(parseProgram(inMovement(body)), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
const codes = (body: string): string[] => check(body).map((d) => d.code);

function expectClean(body: string): void {
  expect(check(body).map((d) => `${d.code}: ${d.message}`)).toEqual([]);
}

// The company handle a `Lists` create-edge write hangs off.
const withCompany = (write: string): string =>
  `  crm-[co:companies]-> {\n    ${write}\n  }`;

// ── The create-edge case (attio `Lists`) ──

describe('discriminated create-edge write (attio `Lists`)', () => {
  it('the right variant field typechecks', () => {
    expectClean(withCompany('write co-[:Lists]-> { listName: "VC Deal Flow", Stage: "Diligence" }'));
  });

  it('the membership-only write (no extra field) still typechecks', () => {
    expectClean(withCompany('write co-[:Lists]-> { listName: "Pipeline" }'));
    expectClean(withCompany('write co-[:Lists]-> { listName: "VC Deal Flow" }'));
  });

  it('a field on the WRONG variant errors, naming the variant', () => {
    const diagnostics = check(withCompany('write co-[:Lists]-> { listName: "Pipeline", Stage: "Diligence" }'));
    expect(diagnostics.map((d) => d.code)).toContain(C.WRITE_UNKNOWN_FIELD);
    const unknown = diagnostics.find((d) => d.code === C.WRITE_UNKNOWN_FIELD);
    expect(unknown?.message).toContain('Stage');
    // The discriminant literal is in the message so "no Stage on Pipeline" reads clearly.
    expect(unknown?.message).toContain('Pipeline');
  });

  it('a missing discriminant is the required-field error', () => {
    // No `listName` in the body: no variant is selectable, so the fallback
    // shape's `requiredFields: ['listName']` reports the missing field.
    expect(codes(withCompany('write co-[:Lists]-> { }'))).toContain(C.WRITE_MISSING_REQUIRED_FIELD);
  });

  it('a discriminant that is NOT a compile-time literal is an error', () => {
    const diagnostics = check(withCompany('write co-[:Lists]-> { listName: msg.`subject` }'));
    expect(diagnostics.map((d) => d.code)).toContain(C.WRITE_DISCRIMINANT_NOT_LITERAL);
  });

  it('a typo\'d discriminant is the enum-unknown-value error', () => {
    expect(codes(withCompany('write co-[:Lists]-> { listName: "VC Deal Fllow" }'))).toContain(
      C.ENUM_UNKNOWN_VALUE,
    );
  });
});

// ── The second, distinct shape (helpdesk `ticket` ROOT write) ──

describe('discriminated root write (helpdesk `ticket` — the second shape)', () => {
  it('the right variant field typechecks', () => {
    expectClean('  write hd-[:tickets]-> { queue: "Billing", refundAmount: 42 }');
  });

  it('a field on the WRONG variant errors, naming the variant', () => {
    const diagnostics = check('  write hd-[:tickets]-> { queue: "General", refundAmount: 42 }');
    expect(diagnostics.map((d) => d.code)).toContain(C.WRITE_UNKNOWN_FIELD);
    expect(diagnostics.find((d) => d.code === C.WRITE_UNKNOWN_FIELD)?.message).toContain('General');
  });

  it('the variant\'s OWN required fields are enforced (per-variant, not global)', () => {
    // `Billing` requires `refundAmount`; omitting it is the missing-required error.
    expect(codes('  write hd-[:tickets]-> { queue: "Billing" }')).toContain(
      C.WRITE_MISSING_REQUIRED_FIELD,
    );
    // `General` requires nothing beyond the discriminant — clean.
    expectClean('  write hd-[:tickets]-> { queue: "General" }');
  });

  it('a non-literal discriminant errors here too', () => {
    expect(codes('  write hd-[:tickets]-> { queue: msg.`subject` }')).toContain(
      C.WRITE_DISCRIMINANT_NOT_LITERAL,
    );
  });

  it('a typo\'d discriminant is still the enum-unknown-value error', () => {
    expect(codes('  write hd-[:tickets]-> { queue: "Biling" }')).toContain(C.ENUM_UNKNOWN_VALUE);
  });
});

// ── The handle a discriminated write hands back ──

describe('the handle a discriminated write hands back', () => {
  const withOrg = (body: string): string =>
    `  aff-[o:organizations]-> {\n    ${body}\n  }`;

  it('stands on the variant the literal named, so its edges are reachable', () => {
    expectClean(
      withOrg(
        'entry = write o-[:`List Entries`]-> { listName: "Deals", `Deal Stage`: "Sourced" }\n' +
          '    write entry-[:Owners]-> { Name: "Daria Gneusheva" }',
      ),
    );
  });

  it('a match off the handle walks the variant\'s edge too, and links what it found', () => {
    expectClean(
      withOrg(
        'entry = write o-[:`List Entries`]-> { listName: "Deals" }\n' +
          '    owner = match entry-[:Owners]-> { unique by (`Name`), Name: "Ada" }\n' +
          '    link entry -[:Owners]-> owner',
      ),
    );
  });

  it('carries the variant\'s own fields, and only those', () => {
    expectClean(
      withOrg(
        'entry = write o-[:`List Entries`]-> { listName: "Deals", `Deal Stage`: "Sourced" }\n' +
          '    write aff-[:people]-> { Name: entry.`Deal Stage` }',
      ),
    );
    expect(
      codes(
        withOrg(
          'entry = write o-[:`List Entries`]-> { listName: "Deals" }\n' +
            '    write aff-[:people]-> { Name: entry.`Made Up` }',
        ),
      ),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('a SIBLING variant\'s edge is not on it — the narrowing is per-list', () => {
    const diagnostics = check(
      withOrg(
        'entry = write o-[:`List Entries`]-> { listName: "Intros" }\n' +
          '    write entry-[:Owners]-> { Name: "Daria Gneusheva" }',
      ),
    );
    expect(diagnostics.map((d) => d.code)).toContain(C.LINKED_UNKNOWN_EDGE);
    expect(diagnostics.find((d) => d.code === C.LINKED_UNKNOWN_EDGE)?.message).toContain(
      'List Entry — Intros',
    );
  });

  it('without a selectable variant the handle keeps the collection', () => {
    // No `listName`: nothing selects a variant, so the handle stands on the
    // membership collection — which declares no edges at all.
    const diagnostics = check(
      withOrg(
        'entry = write o-[:`List Entries`]-> { }\n' +
          '    write entry-[:Owners]-> { Name: "Daria Gneusheva" }',
      ),
    );
    expect(diagnostics.map((d) => d.code)).toContain(C.WRITE_MISSING_REQUIRED_FIELD);
    expect(diagnostics.map((d) => d.code)).toContain(C.LINKED_UNKNOWN_EDGE);
  });
});
