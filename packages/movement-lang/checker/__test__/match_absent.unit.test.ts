// Language version 4 ("Luminous Owl"): a named `match` is the record found OR
// absent, and the block carries on either way; an unnamed match and a link's
// match body — the two forms whose only job was to end the scope on a miss —
// are refused, and moving a program up across 4 warns at every bound match
// whose miss now continues. Under 3 every one of these is the old gate.
//
// The schemas below are copied from check_typed.unit.test.ts (only the systems
// these cases reach) so this file stands on its own.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { InstanceSchema, SchemaFieldType, mockCatalog, unionDisplay, unionKey } from '../catalog';

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

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }, { name: 'list', kind: 'position', required: false }],
      schema: attioSchema,
    },
    kg: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: kgSchema,
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    native_knowledge: { adapter: 'kg' },
  },
});

const PRELUDE = [
  'import { email, attio, kg } from adapters',
  'import { dealflow_inbox, acme_main, native_knowledge } from credentials',
  '',
  'inbox = email(credentials: dealflow_inbox)',
  'crm   = attio(credentials: acme_main)',
  'graph = kg(credentials: native_knowledge)',
].join('\n');

const inMovement = (body: string) =>
  `${PRELUDE}\nmovement main(msg: <inbox-[:message]->>) {\n${body}\n}`;

// Info severity dropped: the fixture movement declares no listen, which
// legitimately carries MOV_LISTEN_MISSING.
const under = (version: number, body: string) =>
  checkProgram(parseProgram(inMovement(body)), catalog, { languageVersion: version }).filter((d) => d.severity !== 'info');
const errors = (version: number, body: string) =>
  under(version, body).filter((d) => (d.severity ?? 'error') === 'error').map((d) => d.code);

const NAMED = [
  '  existing = match crm-[:companies]-> { unique by (`name`), name: "Nope Ltd" }',
];

describe('a match under language version 4', () => {
  it('under 4 a named match is maybe-absent: an unguarded field read where a value is required is MOV_ABSENT_REQUIRED', () => {
    expect(errors(4, [...NAMED, '  write crm-[:companies]-> { name: existing.name }'].join('\n')))
      .toEqual([C.ABSENT_REQUIRED]);
  });
  it('under 4 the == null / != null / EXISTS guards narrow it, exactly as FIRST', () => {
    for (const guard of ['existing != null', 'EXISTS(existing)', 'NOT (existing == null)']) {
      expect(errors(4, [...NAMED, `  if ${guard} {`, '    write crm-[:companies]-> { name: existing.name }', '  }'].join('\n'))).toEqual([]);
    }
    expect(errors(4, [...NAMED, '  verb = IF existing == null THEN "absent" ELSE "found" END'].join('\n'))).toEqual([]);
  });
  it('under 3 the same unguarded read is clean (the handle was never absent)', () => {
    expect(errors(3, [...NAMED, '  write crm-[:companies]-> { name: existing.name }'].join('\n'))).toEqual([]);
  });
  it('under 4 an unnamed match is MOV_MATCH_UNNAMED and the message shows the named form', () => {
    const diags = under(4, '  match crm-[:companies]-> { unique by (`name`), name: "Acme" }');
    expect(diags.map((d) => d.code)).toEqual([C.MATCH_UNNAMED]);
    expect(diags[0].message).toContain('existing = match');
    expect(diags[0].message).toContain('!= null');
  });
  it('under 3 an unnamed match is still a clean gate', () => {
    expect(errors(3, '  match crm-[:companies]-> { unique by (`name`), name: "Acme" }')).toEqual([]);
  });
  it('under 4 a link with a match body is MOV_LINK_MATCH_BODY_RETIRED, the message showing the named match and the guard; under 3 it is clean', () => {
    const body = [
      '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
      '  link co -[:rounds]-> { unique by (`stage`), stage: "Seed" }',
    ].join('\n');
    const d = under(4, body);
    expect(d.map((x) => x.code)).toEqual([C.LINK_MATCH_BODY_RETIRED]);
    expect(d[0].message).toContain('= match');
    expect(d[0].message).toContain('!= null');
    expect(errors(3, body)).toEqual([]);
  });
  describe('a link onto a match handle', () => {
    const FOUND = [
      '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
      '  fr = match graph-[:funding_round]-> { unique by (`stage`), stage: "Seed" }',
    ];
    const LINK = '  link co -[:rounds]-> fr';
    it('under 4, unguarded, is MOV_ABSENT_REQUIRED naming the guard', () => {
      const d = under(4, [...FOUND, LINK].join('\n'));
      expect(d.map((x) => x.code)).toEqual([C.ABSENT_REQUIRED]);
      expect(d[0].message).toContain('if fr != null { link co -[:rounds]-> fr }');
    });
    it('under 4, tested first, is clean', () => {
      expect(errors(4, [...FOUND, '  if fr != null {', `  ${LINK}`, '  }'].join('\n'))).toEqual([]);
    });
    it('under 4, from a match handle, is MOV_ABSENT_REQUIRED too', () => {
      const body = [
        '  c = match graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  r = write graph-[:funding_round]-> { unique by (`stage`), stage: "Seed" }',
        '  link c -[:rounds]-> r',
      ].join('\n');
      expect(errors(4, body)).toEqual([C.ABSENT_REQUIRED]);
    });
    it('under 3, unguarded, is clean (the handle was never absent)', () => {
      expect(errors(3, [...FOUND, LINK].join('\n'))).toEqual([]);
    });
    it('under 4 an EXISTS guard narrows it clean', () => {
      expect(errors(4, [...FOUND, '  if EXISTS(fr) {', `  ${LINK}`, '  }'].join('\n'))).toEqual([]);
    });
    // The rule is structural: what is refused is a link end that may be absent,
    // whatever made it so — a FIRST is the same `T | absent` a match now is.
    it('an unguarded FIRST(…) at a link is refused under 4 and clean under 3', () => {
      const body = [
        '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
        '  other = write graph-[:companies]-> { unique by (`name`), name: "Other" }',
        '  fr = FIRST(co-[r:rounds ORDER BY `stage`]->)',
        '  link other -[:rounds]-> fr',
      ].join('\n');
      expect(errors(4, body)).toEqual([C.ABSENT_REQUIRED]);
      expect(errors(3, body)).toEqual([]);
    });
  });

  // Reaching the `else` proves the condition false, so what that falsity
  // proves present holds inside it — TypeScript's else-arm narrowing. This
  // only accepts more programs, so it holds under every version.
  describe('the else arm of a null test', () => {
    const PAIR = [
      '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
      '  fr = match graph-[:funding_round]-> { unique by (`stage`), stage: "Seed" }',
      '  other = match graph-[:companies]-> { unique by (`name`), name: "Other" }',
    ];
    it('sees the found record present: the named-match pattern is clean under 4 and 3', () => {
      const body = [
        ...NAMED,
        '  if existing == null {',
        '  } else {',
        '    write crm-[:companies]-> { name: existing.name }',
        '  }',
      ].join('\n');
      expect(errors(4, body)).toEqual([]);
      expect(errors(3, body)).toEqual([]);
    });
    it('narrows a link end', () => {
      expect(errors(4, [...PAIR, '  if fr == null {', '  } else {', '    link co -[:rounds]-> fr', '  }'].join('\n'))).toEqual([]);
    });
    it('narrows a FIRST value and a field read off a FIRST record', () => {
      expect(
        errors(4, [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          '  v = FIRST(co.domains)',
          '  if v == null {',
          '  } else {',
          '    write graph-[:companies]-> { unique by (`name`), name: v }',
          '  }',
        ].join('\n')),
      ).toEqual([]);
      expect(
        errors(4, [
          '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
          '  r = FIRST(co-[x:rounds ORDER BY `stage`]->)',
          '  if r.stage == null {',
          '  } else {',
          '    write graph-[:companies]-> { unique by (`name`), name: r.stage }',
          '  }',
        ].join('\n')),
      ).toEqual([]);
    });
    it('of an OR narrows both sides; of an AND narrows neither', () => {
      const withCondition = (condition: string) =>
        [...PAIR, `  if ${condition} {`, '  } else {', '    link other -[:rounds]-> fr', '  }'].join('\n');
      expect(errors(4, withCondition('fr == null OR other == null'))).toEqual([]);
      expect(errors(4, withCondition('fr == null AND other == null'))).toEqual([C.ABSENT_REQUIRED]);
    });
    it('keeps the guard clause working: a failing arm narrows what follows', () => {
      expect(errors(4, [...PAIR, '  if fr == null { ERROR("no round") }', '  link co -[:rounds]-> fr'].join('\n'))).toEqual([]);
    });
  });

  describe('an unlink of a match handle', () => {
    const FOUND = [
      '  co = write graph-[:companies]-> { unique by (`name`), name: msg.`subject` }',
      '  fr = match graph-[:funding_round]-> { unique by (`stage`), stage: "Seed" }',
    ];
    const UNLINK = '  unlink co -[:rounds]-> fr';
    it('under 4, unguarded, is MOV_ABSENT_REQUIRED naming the guard', () => {
      const d = under(4, [...FOUND, UNLINK].join('\n'));
      expect(d.map((x) => x.code)).toEqual([C.ABSENT_REQUIRED]);
      expect(d[0].message).toContain('if fr != null { unlink co -[:rounds]-> fr }');
    });
    it('under 4, tested first, is clean', () => {
      expect(errors(4, [...FOUND, '  if fr != null {', `  ${UNLINK}`, '  }'].join('\n'))).toEqual([]);
    });
    it('under 3, unguarded, is clean', () => {
      expect(errors(3, [...FOUND, UNLINK].join('\n'))).toEqual([]);
    });
  });
  it('crossing 4 every bound match carries the upgrade warning; validating under 4 without upgradingFrom does not', () => {
    const crossing = checkProgram(parseProgram(inMovement(NAMED.join('\n'))), catalog, { languageVersion: 4, upgradingFrom: 3 });
    const w = crossing.find((d) => d.code === C.MATCH_MISS_CONTINUES);
    expect(w?.severity).toBe('warning');
    expect(w?.upgrade).toBe(true);
    expect(under(4, NAMED.join('\n')).some((d) => d.code === C.MATCH_MISS_CONTINUES)).toBe(false);
    expect(checkProgram(parseProgram(inMovement(NAMED.join('\n'))), catalog, { languageVersion: 3, upgradingFrom: 2 }).some((d) => d.code === C.MATCH_MISS_CONTINUES)).toBe(false);
  });
});
