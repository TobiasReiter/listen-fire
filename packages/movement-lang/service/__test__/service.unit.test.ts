// Language-service tests: one per completion context, plus diagnostics
// mapping and hover. The `¦` marker is the cursor.

import type { CatalogSnapshot } from '../snapshot';
import { fromCatalogSnapshot } from '../snapshot';
import {
  getHoverInfo,
  getMovementCompletions,
  getMovementDiagnostics,
  PARSE_DIAGNOSTIC_CODE,
} from '../service';
import { scanName } from '../../parser/scan';

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
              properties: {
                subject: 'text',
                text: 'text',
                priority: { kind: 'enum', options: ['Low', 'High'] },
                'Sender Name': 'text',
              },
              edges: { sender: { target: 'contact' }, files: { target: 'attachment' } },
            },
            contact: { properties: { name: 'text', domain: 'text' }, edges: {} },
            attachment: { properties: { filename: 'text', data: 'file' }, edges: {} },
          },
          collections: { messages: { target: 'message' } },
          writableRoots: {},
        },
      },
    },
    attio: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      // Attio reports record changes, so a listen on it is legal. Carried here
      // because the snapshot round-trip below is what USED to drop it.
      canFire: true,
      // The generalised "+" connect affordance: an adapter-declared action
      // the editor appends to instance-schema-driven suggestion slots.
      connectActions: [{ kind: 'demo-picker', label: 'Connect a record source' }],
      schemas: {
        acme_main: {
          positions: {
            company: {
              properties: { name: 'text', domains: { kind: 'list', of: 'text' }, url: 'text' },
              edges: {},
              // chunk 6: `url` declares no filter capability → suggestions omit it
              // inside a hop WHERE; `name`/`domains` are filterable.
              propertyCapabilities: {
                name: { filterOperators: ['eq', 'contains'], orderable: true },
                domains: { filterOperators: ['in'] },
              },
            },
            person: { properties: { name: 'text', email: 'text' }, edges: { company: { target: 'company' } } },
          },
          collections: { companies: { target: 'company' }, people: { target: 'person' } },
          unions: { record: ['company', 'person'] },
          writableRoots: {
            company: {
              fields: {
                name: 'text',
                domains: { kind: 'list', of: 'text' },
                funding_stage: { kind: 'enum', options: ['Seed', 'Series A'] },
              },
              resultShape: { externalId: 'text', url: 'text', name: 'text' },
              // Overlaps the fixtures' `unique by (`domains`)` without
              // duplicating it, so existing clean-program tests stay clean.
              nativeUniqueness: [['name', 'domains']],
            },
            person: {
              fields: { name: 'text', email: 'text' },
              resultShape: { externalId: 'text', url: 'text' },
            },
          },
        },
      },
    },
  },
  credentials: {
    dealflow_inbox: { adapter: 'email' },
    acme_main: { adapter: 'attio' },
    'Acme Prod': { adapter: 'attio' },
  },
  plugins: {
    vc_url_retrieval: { args: ['urls'] },
    scrub_sensitive: { args: [] },
  },
};

const HEADER = `import { email, attio } from adapters
import { dealflow_inbox, acme_main } from credentials

inbox = email(credentials: dealflow_inbox)
crm = attio(credentials: acme_main)
`;

function caret(text: string): { source: string; offset: number } {
  const offset = text.indexOf('¦');
  if (offset === -1) throw new Error('no caret in fixture');
  return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

function completionsAt(text: string) {
  const { source, offset } = caret(text);
  return getMovementCompletions(source, offset, snapshot);
}

function labels(result: { items: Array<{ label: string }> }): string[] {
  return result.items.map(i => i.label);
}

describe('snapshot round-trip', () => {
  it('survives JSON serialization and resolves schemas by credential', () => {
    const wired: CatalogSnapshot = JSON.parse(JSON.stringify(snapshot));
    const catalog = fromCatalogSnapshot(wired);
    // The spec comes back WHOLE — every `AdapterSpec` member the snapshot
    // carries, minus the snapshot-only `schemas`/`schemaNotes`.
    //
    // This used to assert the exact object `{ constructionArgs }`, which is to
    // say it asserted the accessor's field-by-field rebuild DROPPING everything
    // else. `canFire` was the casualty that mattered: absent-on-a-known-spec is
    // the positive fact "cannot fire", so every listen in the editor reported
    // MOV_LISTEN_CANNOT_FIRE while the same check passed server-side.
    const attioSpec = catalog.adapter('attio');
    expect(attioSpec?.constructionArgs).toEqual([
      { name: 'credentials', kind: 'credential', required: true },
    ]);
    expect(attioSpec?.canFire).toBe(true);
    expect(attioSpec).not.toHaveProperty('schemas');
    expect(attioSpec).not.toHaveProperty('schemaNotes');
    expect(catalog.credential('acme_main')).toEqual({ adapters: ['attio'] });
    expect(catalog.plugin('vc_url_retrieval')).toEqual({ args: ['urls'] });
    const schema = catalog.instantiate('attio', { credentials: 'acme_main' });
    expect(Object.keys(schema?.writableRoots ?? {})).toEqual(['company', 'person']);
    // An unresolvable credential leaves the instance UNTYPED. It used to fall
    // back to any schema the adapter had ("same service type ⇒ same
    // vocabulary"), but a schema belongs to one (adapter, credential,
    // position) — so that answered with a different connection's surface, and
    // being plausible, it hid the credential failure behind type errors in a
    // healthy movement.
    expect(catalog.instantiate('attio', { credentials: 'mystery' })).toBeUndefined();
    expect(catalog.instantiate('unknown', {})).toBeUndefined();
  });
});

describe('getMovementDiagnostics — an unresolvable credential', () => {
  // The whole reason the fallback had to go: it made a credential failure
  // arrive as type errors about a healthy movement, pointing the author at
  // fields that were never wrong.
  it('reports the credential, and does NOT type the body against another connection', () => {
    const source = `${HEADER.replace(/acme_main/g, 'mystery')}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: AI("the company name")
  }
}

listen to inbox fire intake
`;
    const messages = getMovementDiagnostics(source, snapshot).map((d) => d.message);
    // The one true problem is named...
    expect(messages.some((m) => /mystery/.test(m))).toBe(true);
    // ...and nothing invents complaints about `crm`'s shape from a schema that
    // belongs to a different credential.
    expect(messages.some((m) => /companies|writable|position type/i.test(m))).toBe(false);
  });
});

describe('getMovementDiagnostics', () => {
  it('returns no diagnostics for a valid program', () => {
    const source = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`domains\`)
    name: AI("the company name")
    domains: [msg-[:sender]->.\`domain\`]
  }
}

listen to inbox fire intake
`;
    expect(getMovementDiagnostics(source, snapshot)).toEqual([]);
  });

  it('surfaces MOV_LISTEN_MISSING as an info-severity diagnostic', () => {
    const source = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: msg.\`subject\`
  }
}
`;
    const diagnostics = getMovementDiagnostics(source, snapshot);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe('MOV_LISTEN_MISSING');
    expect(diagnostics[0].severity).toBe('info');
    expect(diagnostics[0].to).toBeGreaterThan(diagnostics[0].from);
  });

  it('maps checker spans to character offsets', () => {
    const source = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: mystery
  }
}
`;
    const diagnostics = getMovementDiagnostics(source, snapshot);
    expect(diagnostics.length).toBeGreaterThan(0);
    const unresolved = diagnostics.find(d => d.code === 'MOV_NAME_UNRESOLVED');
    expect(unresolved).toBeDefined();
    expect(unresolved!.message).toContain('mystery');
    expect(unresolved!.to).toBeGreaterThan(unresolved!.from);
    expect(source.slice(unresolved!.from, unresolved!.to)).toContain('mystery');
  });

  it('reports a parse failure as a single spanned diagnostic', () => {
    const diagnostics = getMovementDiagnostics('movement {', snapshot);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe(PARSE_DIAGNOSTIC_CODE);
    expect(diagnostics[0].to).toBeGreaterThan(diagnostics[0].from);
  });
});

describe('completions: hop WHERE fields are capability-aware (chunk 6)', () => {
  it('offers only the fields the source can filter, inside a collection hop WHERE', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  blk = crm-[c:companies WHERE ¦]-> {
  }
}`);
    const names = labels(result);
    expect(names).toContain('name');
    expect(names).toContain('domains');
    // `url` declares no filter capability → it must NOT be offered here.
    expect(names).not.toContain('url');
  });

  it('still resolves with a partial field already typed', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  blk = crm-[c:companies WHERE na¦]-> {
  }
}`);
    expect(labels(result)).toContain('name');
    expect(labels(result)).not.toContain('url');
  });

  it('does not offer fields after a comparison operator (a value is expected there)', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  blk = crm-[c:companies WHERE \`name\` == ¦]-> {
  }
}`);
    // Not the field list — the WHERE field path must bow out at a value slot.
    expect(labels(result)).not.toContain('domains');
  });
});

describe('completions: statement keywords', () => {
  it('offers file-level keywords at the top level', () => {
    const result = completionsAt(`${HEADER}\n¦`);
    expect(labels(result)).toEqual(expect.arrayContaining(['import', 'movement', 'node']));
  });

  it('offers body keywords and in-scope names inside a movement', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  ¦
}
`);
    const all = labels(result);
    expect(all).toEqual(expect.arrayContaining(['write', 'if', 'parallel', 'link']));
    expect(all).toContain('msg');
  });

  it('filters keywords by the typed prefix', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  par¦
}
`);
    expect(labels(result)).toEqual(['parallel']);
  });
});

describe('completions: imports', () => {
  it('offers adapter names inside an adapters import', () => {
    const result = completionsAt('import { ¦ } from adapters\n');
    expect(labels(result)).toEqual(['email', 'attio']);
  });

  it('offers credential names with their adapter as detail', () => {
    const result = completionsAt('import { ¦ } from credentials\n');
    expect(labels(result)).toEqual(['dealflow_inbox', 'acme_main', 'Acme Prod']);
    expect(result.items[0].detail).toBe('email credential');
  });

  it('backtick-quotes imported credential names that need it', () => {
    const result = completionsAt('import { ¦ } from credentials\n');
    expect(result.items.find(i => i.label === 'acme_main')?.insert).toBe('acme_main');
    expect(result.items.find(i => i.label === 'Acme Prod')?.insert).toBe('`Acme Prod`');
  });

  it('offers plugin names inside a plugins import', () => {
    const result = completionsAt('import { ¦ } from plugins\n');
    expect(labels(result)).toEqual(['vc_url_retrieval', 'scrub_sensitive']);
  });

  it('skips names already imported on the line', () => {
    const result = completionsAt('import { email, ¦ } from adapters\n');
    expect(labels(result)).toEqual(['attio']);
  });

  it('offers the three namespaces after from', () => {
    const result = completionsAt('import { email } from ¦');
    expect(labels(result)).toEqual(['adapters', 'credentials', 'plugins']);
  });
});

describe('completions: construction credential argument', () => {
  it('offers only credentials compatible with the adapter being constructed', () => {
    const result = completionsAt(`${HEADER}other = attio(credentials: ¦)\n`);
    expect(labels(result)).toContain('acme_main');
    expect(labels(result)).not.toContain('dealflow_inbox');
  });

  it('offers the matching credential for a different adapter', () => {
    const result = completionsAt(`${HEADER}other = email(credentials: ¦)\n`);
    expect(labels(result)).toContain('dealflow_inbox');
    expect(labels(result)).not.toContain('acme_main');
  });

  it('does not offer credentials for a non-credential argument', () => {
    const result = completionsAt(`${HEADER}other = attio(dry_run: ¦)\n`);
    expect(labels(result)).not.toContain('acme_main');
  });

  it('backtick-quotes a spaced credential name in the value position', () => {
    const source = `import { attio } from adapters
import { \`Acme Prod\` } from credentials

crm = attio(credentials: ¦)
`;
    const { source: src, offset } = caret(source);
    const result = getMovementCompletions(src, offset, snapshot);
    expect(result.items.find(i => i.label === 'Acme Prod')?.insert).toBe('`Acme Prod`');
  });

  it('replaces an open backtick when completing a spaced credential', () => {
    const source = `import { attio } from adapters
import { \`Acme Prod\` } from credentials

crm = attio(credentials: \`Acme ¦)
`;
    const { source: src, offset } = caret(source);
    const result = getMovementCompletions(src, offset, snapshot);
    expect(result.items.find(i => i.label === 'Acme Prod')?.insert).toBe('`Acme Prod`');
    expect(src.slice(result.from, offset)).toBe('`Acme ');
  });
});

// A dash-slugged adapter is NAMED backtick-quoted, and its credential may carry
// `@`, `.`, `'` (e.g. `Toni@acme.example's Listen-Fire Valuations`). Completions must still
// fire off the backtick callee — otherwise the credential never gets suggested
// at the point of construction.
describe('completions: dash-slugged adapter with special-char credential', () => {
  const dashSnapshot: CatalogSnapshot = {
    adapters: {
      'native-valuations': {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schemas: {},
      },
    },
    credentials: { "Toni@acme.example's Listen-Fire Valuations": { adapter: 'native-valuations' } },
    plugins: {},
  };
  const DASH_HEADER =
    'import { `native-valuations` } from adapters\n' +
    "import { `Toni@acme.example's Listen-Fire Valuations` } from credentials\n";
  const at = (text: string) => {
    const { source, offset } = caret(text);
    return getMovementCompletions(source, offset, dashSnapshot);
  };

  it('suggests the special-char credential in the import list (backtick-wrapped)', () => {
    const item = at('import { ¦ } from credentials').items.find(
      i => i.label === "Toni@acme.example's Listen-Fire Valuations",
    );
    expect(item?.insert).toBe("`Toni@acme.example's Listen-Fire Valuations`");
  });

  it('offers `credentials:` as a construction arg off a backtick callee', () => {
    expect(labels(at(`${DASH_HEADER}v = \`native-valuations\`(¦)\n`))).toContain('credentials');
  });

  it('suggests the credential in the value position off a backtick callee', () => {
    const item = at(`${DASH_HEADER}v = \`native-valuations\`(credentials: ¦)\n`).items.find(
      i => i.label === "Toni@acme.example's Listen-Fire Valuations",
    );
    expect(item?.insert).toBe("`Toni@acme.example's Listen-Fire Valuations`");
  });
});

describe('completions: write targets', () => {
  it('offers writable roots after instance-dot, plus the adapter\'s connect action', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  company = write crm.¦
}
`);
    expect(labels(result)).toEqual(['company', 'person', '+ Connect a record source']);
    expect(result.items[0].detail).toContain('name');
    // The "+" entry carries the connectAction the editor dispatches by kind —
    // it inserts no text; the editor routes it to the handler registry.
    const connect = result.items.find(i => i.connectAction);
    expect(connect?.connectAction).toEqual({
      kind: 'demo-picker',
      adapter: 'attio',
      credential: 'acme_main',
    });
    expect(connect?.insert).toBe('');
  });

  it('offers writable instances and handles after write', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  company = write crm-[:companies]-> {
    name: "x"
  }
  write ¦
}
`);
    const all = labels(result);
    expect(all).toContain('crm.');
    expect(all).toContain('company'); // the handle — start a linked write
    expect(all).not.toContain('inbox.'); // no writable roots
  });
});

describe('completions: write bodies', () => {
  it('offers missing target fields and unique by inside a write body', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: "Acme"
    ¦
  }
}
`);
    const all = labels(result);
    expect(all).toContain('domains');
    expect(all).not.toContain('name'); // already declared
    expect(all).toContain('unique by (…)');
  });

  it('completes a partial field name via the blanked-line fallback', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    dom¦
  }
}
`);
    expect(labels(result)).toEqual(['domains']);
  });

  it('offers backticked fields and bound handles inside unique by', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  company = write crm-[:companies]-> {
    name: "Acme"
  }
  write crm-[:people]-> {
    unique by (¦
  }
}
`);
    const all = labels(result);
    expect(all).toContain('`name`');
    expect(all).toContain('`email`');
    expect(all).toContain('company');
  });
});

describe('completions: traversals', () => {
  it('offers typed edges after -[: on a movement parameter', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  msg-[:¦
}
`);
    const all = labels(result);
    expect(all).toEqual(expect.arrayContaining(['sender', 'files', '_resources']));
    expect(result.items.find(i => i.label === 'sender')?.insert).toBe('sender]->');
    expect(result.items.find(i => i.label === '_resources')?.insert).toBe('_resources]->');
  });

  it('offers edges after a chained hop', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  msg-[:sender]->-[:¦
}
`);
    // contact has no edges; only the meta _resources affordance remains
    expect(labels(result)).toEqual(['_resources']);
  });

  it('offers extracted entity names when traversing an extract result', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] {
    node company: "each company mentioned" {
      name: "the company name"
    }
  }
  deals-[c:¦
}
`);
    expect(labels(result)).toEqual(['company']);
  });

  it('offers collections when traversing a bare instance (meta position)', () => {
    const result = completionsAt(`${HEADER}
movement mirror(root: <crm>) {
  root-[c:¦
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['companies', 'people']));
  });
});

describe('completions: property reads', () => {
  it('offers bare properties after a typed chain (backticks only for spaced names)', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: msg-[:sender]->.¦
  }
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['name', 'domain']));
    // Bare is the default style for identifier-safe names (2026-06-11).
    expect(result.items[0].insert).toBe('name');
  });

  it('offers handle result-shape fields after a write handle', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  company = write crm-[:companies]-> {
    name: "Acme"
  }
  write crm-[:people]-> {
    name: company.¦
  }
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['externalId', 'url', 'name']));
  });
});

describe('completions: borrowed type annotations', () => {
  it('offers roots/positions to borrow from after `field: <instance>-[:`', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] {
    node company: "each company" {
      stage: <crm-[:¦
    }
  }
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['company', 'person']));
    const company = result.items.find(i => i.label === 'company');
    expect(company?.insert).toBe('company]->.');
    expect(company?.detail).toContain('borrow');
  });

  it('offers the borrowable fields (typed) after `field: <instance>-[:root]->.`', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] {
    node company: "each company" {
      stage: <crm-[:company]->.¦
    }
  }
}
`);
    expect(labels(result)).toEqual(
      expect.arrayContaining(['name', 'domains', 'funding_stage']),
    );
    const stage = result.items.find(i => i.label === 'funding_stage');
    expect(stage?.detail).toContain('enum (Seed | Series A)');
    expect(stage?.detail).toContain('borrowed from crm-[:company]->');
  });

  it('does not offer borrowed paths inside a write body (a dotted name there is an expression)', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: crm.¦
  }
}
`);
    expect(labels(result)).not.toContain('funding_stage');
    expect(result.items.find(i => i.detail?.includes('borrow'))).toBeUndefined();
  });
});

describe('completions: expressions delegate to the formula engine', () => {
  it('offers functions and in-scope names in a field value', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: ¦
  }
}
`);
    const all = labels(result);
    expect(all).toContain('AI()');
    expect(all).toContain('CONCAT()');
    expect(all).toContain('msg');
    expect(all).not.toContain('EXTRACT_VALUE()'); // retired in the movement language
  });

  it('completes inside string interpolation', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: "deal from \${¦}"
  }
}
`);
    expect(labels(result)).toContain('msg');
  });

  it('offers IS in an if condition after a subject', () => {
    const result = completionsAt(`${HEADER}
movement route(rec: <crm-[:record]->>) {
  if rec ¦
}
`);
    expect(labels(result)).toContain('IS');
  });

  it('offers position types after IS graph-hop', () => {
    const result = completionsAt(`${HEADER}
movement route(rec: <crm-[:record]->>) {
  if rec IS <crm-[:¦
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['record', 'company', 'person']));
  });

  // A backtick-quoted field name carries spaces/punctuation, but the value
  // after the colon is still an expression — completions there must be
  // identical to a bare field's. The parser treats `` `Snoozed Until` `` and a
  // bare `Status` as the same name token; the completion context must too.
  describe('quoted field names complete identically to bare ones', () => {
    const bareValue = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    Status: ¦
  }
}
`;
    const quotedValue = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    \`Snoozed Until\`: ¦
  }
}
`;
    const quotedAt = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    \`Snoozed Until\`: @¦
  }
}
`;

    it('offers completions in a quoted field value (the bug: none today)', () => {
      const all = labels(completionsAt(quotedValue));
      expect(all).toContain('AI()');
      expect(all).toContain('CONCAT()');
      expect(all).toContain('msg'); // in-scope symbol
      expect(all).toContain('@actor_email'); // @-meta key
    });

    it('offers the @-meta keys after typing @ in a quoted field value', () => {
      const all = labels(completionsAt(quotedAt));
      expect(all).toEqual(
        expect.arrayContaining([
          '@current_date',
          '@user_email',
          '@actor_email',
          '@actor_name',
        ]),
      );
    });

    it('yields the same completion set whether the field name is quoted or bare', () => {
      const bare = labels(completionsAt(bareValue)).sort();
      const quoted = labels(completionsAt(quotedValue)).sort();
      expect(quoted).toEqual(bare);
    });

    // No-drift pin: the field-value cursor-context must recognise a key as a NAME
    // through the SAME scanner the parser uses (`scanName`), not a copied grammar.
    // We assert the service offers value completions for keys scanName accepts
    // (spaced backtick + bare) and the spelling scanName reports is what flows.
    it.each([
      ['`Snoozed Until`', 'Snoozed Until'],
      ['Status', 'Status'],
      // Escapes read as the parser reads them: an escaped backtick, an
      // escaped backslash, a letter escape.
      ['`Snoozed\\`Until`', 'Snoozed`Until'],
      ['`Snoozed\\\\Until`', 'Snoozed\\Until'],
      ['`Snoozed\\Until`', 'SnoozedUntil'],
    ])('recognises field key %s exactly as scanName does', (spelling, verbatim) => {
      // The parser's scanner accepts this key and reports the verbatim name.
      const scanned = scanName(spelling, 0);
      expect(scanned).toEqual({ name: verbatim, end: spelling.length });

      // The service's field-value context recognises the same key → value
      // completions flow (the in-scope `msg` symbol appears).
      const all = labels(
        completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    ${spelling}: ¦
  }
}
`),
      );
      expect(all).toContain('msg');
    });
  });
});

// A scalar binding (`price = msg.\`subject\``) has a fieldType but no posType —
// it's a plain value, not a graph position. Expression-position gates (rvalue
// start, and the operator/rvalue context inside a formula) must offer it like
// any other in-scope name; statement start must not, because nothing can
// traverse or write off a scalar.
describe('completions: scalar bindings in expression position', () => {
  it('offers a scalar binding after an operator inside an expression', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  price = msg.\`subject\`
  total = price * ¦
}
`);
    expect(labels(result)).toContain('price');
  });

  it('offers a scalar binding at rvalue start (`x = ¦`)', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  price = msg.\`subject\`
  total = ¦
}
`);
    expect(labels(result)).toContain('price');
  });

  it('does NOT offer a scalar binding at statement start', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  price = msg.\`subject\`
  ¦
}
`);
    expect(labels(result)).not.toContain('price');
  });

  it('labels an offered scalar with its type', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  price = msg.\`subject\`
  total = ¦
}
`);
    expect(result.items.find(i => i.label === 'price')?.detail).toBe('text');
  });

  it('renders a maybe-absent scalar\'s type honestly', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  d = DATE.PARSE(msg.\`subject\`)
  total = ¦
}
`);
    expect(result.items.find(i => i.label === 'd')?.detail).toBe('date (or absent)');
  });
});

describe('hover: value-binding types', () => {
  function hoverAt(text: string) {
    const { source, offset } = caret(text);
    return getHoverInfo(source, offset, snapshot);
  }

  it('shows the inferred scalar type of an expression binding', () => {
    const h = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  ¦p = msg.\`subject\`
}
`);
    expect(h?.contents.join(' ')).toContain('text');
  });

  it('shows an enum binding\'s options as the value hint', () => {
    const h = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  ¦pr = msg.\`priority\`
}
`);
    const text = h?.contents.join(' ') ?? '';
    expect(text).toContain('Low');
    expect(text).toContain('High');
  });

  it('describes a binding as a "value", not "binding" jargon', () => {
    const text = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  ¦p = msg.\`subject\`
}
`)?.contents.join(' ') ?? '';
    expect(text).toContain('value');
    expect(text).not.toContain('binding');
  });

  it('lists a parameter\'s fields on separate lines', () => {
    const joined = hoverAt(`${HEADER}
movement m(¦msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { unique by (\`name\`) name: msg.\`subject\` }
}
`)?.contents.join('\n') ?? '';
    expect(joined).toMatch(/Fields:\n\s+subject/);
  });

  it('an extract binding lists its child nodes as Edges (not "Entities")', () => {
    const joined = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  ¦d = extract from [msg.\`subject\`] {
    summary: "a one-line summary"
    node company: "the company" {
      name: "its name"
    }
  }
}
`)?.contents.join('\n') ?? '';
    expect(joined).toMatch(/Edges:\n\s+company/);
    expect(joined).not.toContain('Entities');
  });

  it('a movement hover uses the movement\'s own parameter names', () => {
    const src = `${HEADER}
movement greet(note: <inbox-[:message]->>) {
}
movement caller(msg: <inbox-[:message]->>) {
  greet(note: msg)
}
`;
    const text = getHoverInfo(src, src.indexOf('greet(note:') + 1, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('greet(note: <inbox-[:message]->>)');
  });

  it('hovers a write-body field key (name:) with its type', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    na¦me: "x"
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('field of crm.company');
    expect(text).toContain('text');
  });

  it('hovers construction-arg labels (credentials, dry_run)', () => {
    const src = 'import { attio } from adapters\nimport { acme_main } from credentials\ncrm = attio(credentials: acme_main, dry_run: true)\n';
    const hov = (i: number) => getHoverInfo(src, i, snapshot)?.contents.join(' ') ?? '';
    expect(hov(src.indexOf('credentials: acme_main') + 1)).toContain('credential to authenticate');
    expect(hov(src.indexOf('dry_run') + 1)).toContain('rehearse');
  });

  it('an instance hover documents dry run', () => {
    const src = `${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { unique by (\`name\`) name: "x" }
}
`;
    const text = getHoverInfo(src, src.indexOf('crm-[:companies]') + 1, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('dry_run');
  });

  it('hovers an import source distinctly from the imported value, and import-from vs extract-from', () => {
    const src = 'import { attio } from adapters\nimport { writePersonToAttio } from "writePersonToAttio"\n';
    const hov = (i: number) => getHoverInfo(src, i, snapshot)?.contents.join(' ') ?? '';
    expect(hov(src.indexOf('adapters') + 1)).toContain('adapter-type catalogue');
    // the quoted file path is a movement file, NOT the imported movement value
    expect(hov(src.indexOf('"writePersonToAttio"') + 3)).toContain('movement file');
    // `from` in an import differs from `from` in an extract
    expect(hov(src.indexOf('from adapters') + 1)).toContain('where these imports come from');
  });

  it('hovers language keywords (movement / extract / listen / fire)', () => {
    const src = `${HEADER}
movement m(msg: <inbox-[:message]->>) {
  d = extract from [msg.\`subject\`] { node co: "a co" { name: "n" } }
}
listen to inbox fire m
`;
    const at = (token: string, occ = 0) => {
      let i = -1;
      for (let n = 0; n <= occ; n++) i = src.indexOf(token, i + 1);
      return getHoverInfo(src, i + 1, snapshot)?.contents.join(' ') ?? '';
    };
    expect(at('movement')).toContain('unit of work');
    expect(at('extract')).toContain('materialise');
    expect(at('listen')).toContain('events');
    expect(at('fire')).toContain('movement to run');
  });

  it('hovers a backticked multi-word field (msg.`Sender Name`)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { unique by (\`name\`) name: msg.\`Sender ¦Name\` }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('Sender Name');
    expect(text).toContain('text');
  });

  it('shows an object type / write target shape (crm.company)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:comp¦anies]-> { unique by (\`name\`) name: "x" }
}
`);
    const joined = getHoverInfo(source, offset, snapshot)?.contents.join('\n') ?? '';
    expect(joined).toContain('object type');
    expect(joined).toMatch(/Fields:\n\s+name/);
  });

  it('hovers a nested borrowed-type field (<crm-[:company]->.name>)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  d = extract from [msg.\`subject\`] {
    node co: "a co" {
      nm: <crm.company.na¦me> "the name"
    }
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('field of crm.company');
    expect(text).toContain('text');
  });

  it('shows a hint for a parameter field access (bare msg.subject)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name: msg.sub¦ject
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('subject');
    expect(text).toContain('text');
  });

  // Fix 4: a backtick-quoted write-field key gets the same overlay hint a
  // bare-identifier key does — the field is the same, only the quoting differs.
  it('hovers a backtick-quoted write-field key (`domains`:) with its type', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    \`doma¦ins\`: msg.\`subject\`
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('field of crm.company');
    expect(text).toContain('list of text');
  });

  // Fix 4 (operator coverage): all four write operators keep the preceding
  // key's hover — `:` (fill), `?:` (set-if-empty), `+:` (append), `+?:`
  // (append-missing). `+?:` was the one that dropped the hint.
  it.each([
    ['fill `:`', '`domains`: msg.`subject`'],
    ['set-if-empty `?:`', '`domains` ?: msg.`subject`'],
    ['append `+:`', '`domains` +: [msg.`subject`]'],
    ['append-missing `+?:`', '`domains` +?: [msg.`subject`]'],
  ])('hovers a backticked key followed by %s', (_label, line) => {
    const cursorLine = line.replace('`domains`', '`doma¦ins`');
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    ${cursorLine}
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('field of crm.company');
    expect(text).toContain('list of text');
  });

  // And a BARE key with `+?:` (the operator regression isn't backtick-specific).
  it('hovers a bare write-field key followed by +?:', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    doma¦ins +?: [msg.\`subject\`]
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('field of crm.company');
    expect(text).toContain('list of text');
  });

  // Fix 3 (surfacing): the write target's native identity rules show as an
  // overlay hint on the write — on the field key and on the target object —
  // instead of the retired MOV_UNIQUE_NATIVE_CONFLICT warning.
  it('shows the native-uniqueness rule on a write-field key', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`url\`)
    na¦me: msg.\`subject\`
  }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('Matched natively by');
    expect(text).toContain('`name` + `domains`');
  });

  it('shows the native-uniqueness rule on the write-target object', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:comp¦anies]-> { unique by (\`url\`) name: msg.\`subject\` }
}
`);
    const joined = getHoverInfo(source, offset, snapshot)?.contents.join('\n') ?? '';
    expect(joined).toContain('object type');
    expect(joined).toContain('Matched natively by');
    expect(joined).toContain('`name` + `domains`');
  });

  // Fix 5: a traversal hop's edge name surfaces an overlay hint — the edge off
  // the source position and its target type.
  it('hovers a traversal edge off a parameter (msg-[s:sender]->)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  msg-[s:send¦er]-> { p = s.\`name\` }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('sender');
    expect(text).toContain('contact');
  });

  it('hovers a collection edge off a bare instance (crm-[c:companies]->)', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  crm-[c:compa¦nies]-> { write crm-[:companies]-> { unique by (\`name\`) name: c.\`name\` } }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('companies');
    expect(text).toContain('company');
  });

  // Fix 5 + Fix 3: a write target reached through a traversal
  // (`write crm-[:people]->-[:company]-> { … }`) still surfaces the edge hint, and
  // the traversal write target carries its native rule.
  it('hovers the edge of a write traversal target', () => {
    const { source, offset } = caret(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  p = write crm-[:people]-> { unique by (\`email\`) name: msg.\`subject\` }
  write p-[:comp¦any]-> { unique by (\`url\`) name: msg.\`subject\` }
}
`);
    const text = getHoverInfo(source, offset, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('company');
  });
});

describe('meta-fields (@-prefixed ambient values)', () => {
  function hoverAt(text: string) {
    const { source, offset } = caret(text);
    return getHoverInfo(source, offset, snapshot);
  }

  it('offers the meta-fields as completions in an expression position', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name: @¦
  }
}
`);
    const all = labels(result);
    expect(all).toContain('@actor_email');
    expect(all).toContain('@user_email');
    expect(all).toEqual(
      expect.arrayContaining([
        '@current_date',
        '@current_timestamp',
        '@user_name',
        '@user_id',
        '@actor_name',
        '@actor_id',
      ]),
    );
    // TG-only meta-keys must NOT pollute movement completions — movements have
    // no parent action node, KG identity, or input channel in scope.
    for (const tgOnly of ['@id', '@parent.created', '@parent.external_id', '@input_channel_name']) {
      expect(all).not.toContain(tgOnly);
    }
  });

  it('hovers @actor_email with its description', () => {
    const text = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name: @actor_em¦ail
  }
}
`)?.contents.join(' ') ?? '';
    expect(text).toContain('@actor_email');
    expect(text.toLowerCase()).toContain('triggered the event');
  });

  it('hovers @current_date with its description', () => {
    const text = hoverAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name: @current_da¦te
  }
}
`)?.contents.join(' ') ?? '';
    expect(text).toContain('@current_date');
    expect(text).toContain('YYYY-MM-DD');
  });
});

describe('stdlib: coercers and namespaced families surface in the editor', () => {
  function hoverAt(text: string) {
    const { source, offset } = caret(text);
    return getHoverInfo(source, offset, snapshot);
  }

  const exprFixture = (tail: string) => `${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name: ${tail}
  }
}
`;

  it('offers DATE as BOTH a coercer function and a namespace gateway', () => {
    const all = labels(completionsAt(exprFixture('¦')));
    expect(all).toContain('DATE(…)'); // the bare coercer
    expect(all).toContain('DATE.'); // the namespace gateway
  });

  it('offers DATETIME and NUMBER as both, CURRENCY/TEXT as namespaces only', () => {
    const all = labels(completionsAt(exprFixture('¦')));
    expect(all).toContain('DATETIME(…)');
    expect(all).toContain('DATETIME.');
    expect(all).toContain('NUMBER(…)');
    expect(all).toContain('NUMBER.');
    expect(all).toContain('CURRENCY.');
    expect(all).toContain('TEXT.');
    // CURRENCY / TEXT have no bare coercer.
    expect(all).not.toContain('CURRENCY(…)');
    expect(all).not.toContain('TEXT(…)');
  });

  it('after `DATETIME.` offers the DATETIME family members', () => {
    expect(labels(completionsAt(exprFixture('DATETIME.¦')))).toContain('AT');
  });

  it('hover on DATETIME before `(` mentions the coercer AND the namespace duality', () => {
    const text = hoverAt(exprFixture('DATETIM¦E(msg.\`text\`)'))?.contents.join(' ') ?? '';
    expect(text.toLowerCase()).toContain('full timestamp');
    expect(text.toLowerCase()).toContain('namespace');
    expect(text).toContain('DATETIME.at');
  });

  it('hover on DATETIME.AT shows its signature — not the bare AT(list, index)', () => {
    const text =
      hoverAt(exprFixture('DATETIME.A¦T(msg.\`text\`, "07:00", "UTC")'))?.contents.join(' ') ?? '';
    expect(text).toContain('DATETIME.AT(date, time, zone)');
  });

  it('after `DATE.` offers the DATE family members and NOT the full function list', () => {
    const result = completionsAt(exprFixture('DATE.¦'));
    const all = labels(result);
    expect(all).toEqual(expect.arrayContaining(['PARSE', 'ADD_DAYS', 'FORMAT_ISO']));
    expect(all).not.toContain('AI()'); // not the delegated formula list
    expect(all).not.toContain('CONCAT()');
    expect(all).not.toContain('msg'); // not in-scope symbols
  });

  it('`DATE.par` filters the members to PARSE', () => {
    const all = labels(completionsAt(exprFixture('DATE.par¦')));
    expect(all).toContain('PARSE');
    expect(all).not.toContain('ADD_DAYS');
    expect(all).not.toContain('FORMAT_ISO');
  });

  it('after `CURRENCY.` offers the CURRENCY family members', () => {
    const all = labels(completionsAt(exprFixture('CURRENCY.¦')));
    expect(all).toEqual(
      expect.arrayContaining(['GET_NUMBER_FROM_FIGURE', 'GET_CODE_FROM_FIGURE']),
    );
  });

  it('an unknown namespace does NOT produce stdlib member completions', () => {
    const result = completionsAt(exprFixture('NOPE.¦'));
    const all = labels(result);
    expect(all).not.toContain('PARSE');
    expect(all).not.toContain('GET_NUMBER_FROM_FIGURE');
  });

  it('hover on DATE before `(` mentions the coercer AND the namespace duality', () => {
    const text = hoverAt(exprFixture('DAT¦E(msg.\`text\`)'))?.contents.join(' ') ?? '';
    expect(text.toLowerCase()).toContain('calendar day');
    expect(text.toLowerCase()).toContain('namespace');
    expect(text).toContain('DATE.parse');
  });

  it('hover on DATE before `.` shows the family members', () => {
    const text = hoverAt(exprFixture('DAT¦E.PARSE(msg.\`text\`)'))?.contents.join(' ') ?? '';
    expect(text).toContain('PARSE');
    expect(text).toContain('ADD_DAYS');
    expect(text).toContain('FORMAT_ISO');
  });

  it('hover on a member shows its signature and summary', () => {
    const text = hoverAt(exprFixture('DATE.PAR¦SE(msg.\`text\`)'))?.contents.join(' ') ?? '';
    expect(text).toContain('DATE.PARSE');
    expect(text.toLowerCase()).toContain('iso date');
  });

  it('hover on NUMBER before `(` mentions the coercer AND the namespace duality', () => {
    const text = hoverAt(exprFixture('NUMB¦ER(msg.\`text\`)'))?.contents.join(' ') ?? '';
    expect(text.toLowerCase()).toContain('coerce a value to a number');
    expect(text.toLowerCase()).toContain('namespace');
    expect(text).toContain('NUMBER.format');
  });
});

describe('completions: enum values', () => {
  it('offers an enum field\'s options inside a string value', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    funding_stage: "¦"
  }
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['Seed', 'Series A']));
  });

  it('inside a string, the option inserts bare (no extra quotes)', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    funding_stage: "¦"
  }
}
`);
    expect(result.items.find(i => i.label === 'Seed')?.insert).toBe('Seed');
  });

  it('offers an enum field\'s options in a bare value, quoting the insert', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    funding_stage: ¦
  }
}
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['Seed', 'Series A']));
    expect(result.items.find(i => i.label === 'Seed')?.insert).toBe('"Seed"');
  });

  it('does not offer enum options for a non-enum (text) field value', () => {
    const result = completionsAt(`${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: "¦"
  }
}
`);
    expect(labels(result)).not.toContain('Seed');
  });
});

describe('completions: misc contexts', () => {
  it('offers plugin names inside through [', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] through [¦
}
`);
    expect(labels(result)).toEqual(['vc_url_retrieval', 'scrub_sensitive']);
  });

  it('offers position types in a movement parameter type', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:¦
`);
    expect(labels(result)).toEqual(expect.arrayContaining(['message', 'contact', 'attachment']));
  });

  it('position-type inserts close the hop and the type marker', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:¦
`);
    expect(result.items.find(i => i.label === 'message')?.insert).toBe('message]->>');
  });

  it('graph completions in a type slot insert the opening bracket when not yet typed', () => {
    const bare = completionsAt(`${HEADER}
movement intake(msg: ¦
`);
    expect(bare.items.find(i => i.label === '<inbox-[:')?.insert).toBe('<inbox-[:');
    const bracketed = completionsAt(`${HEADER}
movement intake(msg: <¦
`);
    expect(bracketed.items.find(i => i.label === '<inbox-[:')?.insert).toBe('inbox-[:');
  });

  it('borrowed-field inserts close the type marker', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  deals = extract from [msg.\`text\`] {
    node company: "each company" {
      stage: <crm-[:company]->.¦
    }
  }
}
`);
    expect(result.items.find(i => i.label === 'funding_stage')?.insert).toBe('`funding_stage`>');
  });

  it('offers construction and rvalue keywords after =', () => {
    const result = completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  x = ¦
}
`);
    const all = labels(result);
    expect(all).toContain('write');
    expect(all).toContain('extract from');
    expect(all).toContain('email(credentials: …)');
  });

  it('offers nothing inside a comment', () => {
    const result = completionsAt(`${HEADER}
# a comment about wri¦
`);
    expect(result.items).toEqual([]);
  });

  // The editor finds a comment with the parser's own scan, so it agrees with
  // the parser on what is prose.
  describe('a comment is where the parser sees one', () => {
    const at = (line: string) =>
      completionsAt(`${HEADER}
movement intake(msg: <inbox-[:message]->>) {
${line}
}
`);

    it("a # inside a ' string is not a comment", () => {
      expect(labels(at("  x = CONCAT('a # b', ¦"))).toContain('msg');
    });

    it('a # directly inside a hop is not a comment', () => {
      expect(at('  x = msg-[#linked WHERE ¦').items).not.toEqual([]);
      expect(at('  x = msg-[ #linked WHERE ¦').items).not.toEqual([]);
    });

    it('a # inside a list is a comment', () => {
      expect(at('  xs = [# the ids we wri¦').items).toEqual([]);
    });

    it('a # after a closing bracket is a comment', () => {
      expect(at('  y = msg-[:sender]-> # who wro¦').items).toEqual([]);
      expect(at('  y = [1, 2] # two wri¦').items).toEqual([]);
    });
  });
});

describe('getHoverInfo', () => {
  const program = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  company = write crm-[:companies]-> {
    unique by (\`domains\`)
    name: AI("the company name")
  }
  write crm-[:people]-> {
    name: company.\`name\`
  }
}
`;

  it('types a movement parameter', () => {
    const offset = program.indexOf('msg-') !== -1 ? program.indexOf('msg-') : program.lastIndexOf('msg');
    const hover = getHoverInfo(program, program.lastIndexOf('msg') + 1, snapshot);
    expect(hover).toBeDefined();
    expect(hover!.contents[0]).toContain('inbox.message');
    expect(hover!.contents.join('\n')).toContain('subject');
    expect(offset).toBeGreaterThan(0);
  });

  it('describes a constructed instance', () => {
    const hover = getHoverInfo(program, program.indexOf('crm = ') + 1, snapshot);
    expect(hover).toBeDefined();
    expect(hover!.contents[0]).toContain('attio instance');
    expect(hover!.contents.join('\n')).toContain('company');
  });

  it('types a write handle where it is read', () => {
    const hover = getHoverInfo(program, program.indexOf('company.`name`') + 2, snapshot);
    expect(hover).toBeDefined();
    expect(hover!.contents[0]).toContain('crm.company handle');
    expect(hover!.contents.join('\n')).toContain('externalId');
  });

  it('returns undefined for a genuinely unknown name (not a symbol, field, or keyword)', () => {
    const src = `${HEADER}
movement m(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { unique by (\`name\`) name: zzz_unknown_zzz }
}
`;
    expect(getHoverInfo(src, src.indexOf('zzz_unknown_zzz') + 2, snapshot)).toBeUndefined();
  });

  it("hovering 'unique by' shows the target's native identity rules", () => {
    const hover = getHoverInfo(program, program.indexOf('unique by') + 2, snapshot);
    expect(hover).toBeDefined();
    expect(hover!.contents[0]).toContain('identity for this write');
    expect(hover!.contents.join('\n')).toContain('`name` + `domains`');
    expect(hover!.contents.join('\n')).toContain('natively');
  });

  it("hovering 'unique by' on a target without native rules says so", () => {
    const personProgram = `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:people]-> {
    unique by (\`email\`)
    name: msg.\`subject\`
  }
}
`;
    const hover = getHoverInfo(personProgram, personProgram.indexOf('unique by') + 2, snapshot);
    expect(hover).toBeDefined();
    expect(hover!.contents.join('\n')).toContain('no native identity rules');
  });

  it("hovering 'unique' outside a write body falls through to symbols", () => {
    expect(getHoverInfo('x = "unique"\n', 6, snapshot)).toBeUndefined();
  });
});

describe('completions: listen statements', () => {
  it("offers 'listen' at the file level", () => {
    const result = completionsAt(`${HEADER}\nli¦`);
    expect(labels(result)).toEqual(['listen']);
  });

  it("offers 'to' after 'listen'", () => {
    const result = completionsAt(`${HEADER}\nlisten ¦`);
    expect(labels(result)).toEqual(['to']);
  });

  it("offers constructed instances after 'listen to'", () => {
    const result = completionsAt(`${HEADER}\nlisten to ¦`);
    expect(labels(result)).toEqual(expect.arrayContaining(['inbox', 'crm']));
  });

  it("offers 'fire' after the instance", () => {
    const result = completionsAt(`${HEADER}\nlisten to inbox ¦`);
    expect(labels(result)).toEqual(['fire']);
  });

  it("offers 'fire' after the config block", () => {
    const result = completionsAt(`${HEADER}\nlisten to inbox { key: "dealflow" } ¦`);
    expect(labels(result)).toEqual(['fire']);
  });

  it("offers movement names after 'fire'", () => {
    const result = completionsAt(
      `${HEADER}
movement intake(msg: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: msg.\`subject\` }
}

listen to inbox fire ¦`,
    );
    expect(labels(result)).toEqual(['intake']);
  });

  it('offers the adapter trigger-config vocabulary inside the config block', () => {
    const withVocabulary: CatalogSnapshot = JSON.parse(JSON.stringify(snapshot));
    withVocabulary.adapters.email.triggerConfig = ['key'];
    const { source, offset } = caret(`${HEADER}\nlisten to inbox { ¦`);
    const result = getMovementCompletions(source, offset, withVocabulary);
    expect(result.items.map(i => i.label)).toEqual(['key']);
  });
});

describe('completions: run retirement', () => {
  it("no longer offers 'run' at the file level", () => {
    const result = completionsAt(`${HEADER}\nru¦`);
    expect(labels(result)).toEqual([]);
  });
});

describe('completions: construction args', () => {
  it('offers the adapter construction args plus dry_run after the open paren', () => {
    const result = completionsAt(`${HEADER}\nmirror = attio(¦`);
    expect(labels(result)).toEqual(['credentials', 'dry_run']);
    expect(result.items[1].insert).toBe('dry_run: true');
  });

  it('omits args already given', () => {
    const result = completionsAt(`${HEADER}\nmirror = attio(credentials: acme_main, ¦`);
    expect(labels(result)).toEqual(['dry_run']);
  });

  it('filters by the typed prefix', () => {
    const result = completionsAt(`${HEADER}\nmirror = attio(dr¦`);
    expect(labels(result)).toEqual(['dry_run']);
  });

  it('falls through to expression completions for non-adapter callees', () => {
    const result = completionsAt(`${HEADER}\nx = unknown_thing(¦`);
    expect(labels(result)).not.toContain('dry_run');
  });
});
