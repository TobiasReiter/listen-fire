// Referenced-construction detection + snapshot schema merge — the two
// halves of catalog streaming (skeleton snapshot now, instance schemas on
// demand for the pairs the source constructs).

import type { InstanceSchema } from '../../checker/catalog';
import type { CatalogSnapshot } from '../snapshot';
import { mergeInstanceSchema } from '../snapshot';
import { constructionKey, referencedConstructions, referencedListens } from '../constructions';

// A listen is a traversal of the instance's event edge, with a WHERE — and its
// config is the ONLY place that WHERE is written. Nothing else in the pre-scan
// sees it (`scanInstanceChains` yields hop chains; a listen is not one), so
// without this the event's record edge has nothing to narrow it.
describe('referencedListens', () => {
  const AIRTABLE = `
import { airtable } from adapters
import { \`Air\` } from credentials
at = airtable(credentials: \`Air\`)
movement intake(e: <at-[:\`Record Created\`]->>) { }
listen to at { base: "appDevLoop", table: "tblDeals", events: ["record.created"] } fire intake
`;

  it('grounds a listen in the construction it names, with its config', () => {
    expect(referencedListens(AIRTABLE)).toEqual([
      {
        construction: { adapter: 'airtable', credential: 'Air' },
        // The literal's VALUE, not its source text — a predicate compares
        // against what the author meant, and `events` stays raw because a list
        // is not an address.
        config: { base: 'appDevLoop', table: 'tblDeals', events: '["record.created"]' },
        movement: 'intake',
      },
    ]);
  });

  it('resolves import aliases back to the original names', () => {
    const listens = referencedListens(`
import { airtable as at_type } from adapters
import { airtable as AirCred } from credentials
at = at_type(credentials: AirCred)
listen to at { base: "appX" } fire intake
`);
    expect(listens[0]?.construction).toEqual({ adapter: 'airtable', credential: 'airtable' });
  });

  it('carries the construction args, so a positioned instance is a distinct node', () => {
    const listens = referencedListens(`
import { airtable } from adapters
import { \`Air\` } from credentials
at = airtable(credentials: \`Air\`, base: "Dev Base")
listen to at { table: "tblDeals" } fire intake
`);
    expect(listens[0]?.construction.constructionArgs).toEqual({ base: '"Dev Base"' });
  });

  it('skips a listen that grounds in no construction', () => {
    // Never a WRONG narrowing: an ungrounded listen only means no static one.
    // (A typo'd instance name is the live case; the checker names it separately.)
    expect(referencedListens(`listen to nowhere { type: "Deal" } fire intake`)).toEqual([]);
  });

  it('yields nothing for an unparseable program rather than throwing', () => {
    expect(referencedListens('at = airtable(((')).toEqual([]);
  });
});

describe('referencedConstructions — entry positions', () => {
  // A construction's entry position belongs to the CONSTRUCTION, not to
  // whether anything walks from it — a listen-driven movement names its
  // instance only in a parameter type and never traverses it.
  // plans/2026-07-10-adapter-entry-positions/2_type_space.md
  it('carries the non-credential args as authored', () => {
    const refs = referencedConstructions(`
import { airtable } from adapters
import { acme } from credentials

at = airtable(credentials: acme, base: "Sales CRM")
`);
    expect(refs).toEqual([
      { adapter: 'airtable', credential: 'acme', constructionArgs: { base: '"Sales CRM"' } },
    ]);
  });

  it('keeps two constructions of one pair at DIFFERENT positions apart', () => {
    const refs = referencedConstructions(`
import { airtable } from adapters
import { acme } from credentials

sales = airtable(credentials: acme, base: "Sales CRM")
ops   = airtable(credentials: acme, base: "Ops")
`);
    // One lens per instance: reaching a second container means a second
    // instance, so collapsing these would lose one of the two surfaces.
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.constructionArgs?.base)).toEqual(['"Sales CRM"', '"Ops"']);
  });

  it('still collapses two constructions at the SAME position', () => {
    const refs = referencedConstructions(`
import { airtable } from adapters
import { acme } from credentials

a = airtable(credentials: acme, base: "Sales CRM")
b = airtable(credentials: acme, base: "Sales CRM")
`);
    expect(refs).toHaveLength(1);
  });
});

describe('referencedConstructions', () => {
  it('detects top-level constructions with and without credentials', () => {
    const refs = referencedConstructions(`
import { email, attio } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)
`);
    expect(refs).toEqual([
      { adapter: 'email' },
      { adapter: 'attio', credential: 'acme_main' },
    ]);
  });

  it('detects constructions nested in movement / if / parallel bodies', () => {
    const refs = referencedConstructions(`
import { email, slack, attio } from adapters
import { team_chat, acme_main } from credentials

inbox = email()

movement m(item: <inbox-[:message]->>) {
  if item.\`subject\` {
    chat = slack(credentials: team_chat)
  } else {
    parallel {
      crm = attio(credentials: acme_main)
    }
  }
}
`);
    expect(refs).toEqual([
      { adapter: 'email' },
      { adapter: 'slack', credential: 'team_chat' },
      { adapter: 'attio', credential: 'acme_main' },
    ]);
  });

  it('de-duplicates repeated (adapter, credential) pairs but keeps distinct credentials apart', () => {
    const refs = referencedConstructions(`
a = attio(credentials: main)
b = attio(credentials: main)
c = attio(credentials: sandbox)
`);
    expect(refs).toEqual([
      { adapter: 'attio', credential: 'main' },
      { adapter: 'attio', credential: 'sandbox' },
    ]);
  });

  it('ignores non-identifier credential arguments', () => {
    const refs = referencedConstructions(`crm = attio(credentials: "literal")\n`);
    expect(refs).toEqual([{ adapter: 'attio' }]);
  });

  it('falls back to a lexical scan while the program is mid-edit (parse error)', () => {
    const refs = referencedConstructions(`
import { email, attio } from adapters

inbox = email()
crm = attio(credentials: acme_main)

movement broken(m: <inbox-[:message]->>) {
  write crm.
`);
    expect(refs).toContainEqual({ adapter: 'email' });
    expect(refs).toContainEqual({ adapter: 'attio', credential: 'acme_main' });
  });

  it('resolves a BACKTICK-quoted aliased credential in the lexical scan too', () => {
    // A connection's name is its verbatim row name, so any credential whose
    // name isn't identifier-shaped is imported backticked — and aliasing it is
    // the only way to then name it. The scan's import-entry reading rejected a
    // leading backtick, so mid-edit the alias resolved to itself, the host
    // looked up a connection under the LOCAL name, found none, and left the
    // instance untyped. Aliased and plain must read the same.
    const refs = referencedConstructions(`
import { slack } from adapters
import { \`Dev Loop Slack\` as slack_creds } from credentials

chat = slack(credentials: slack_creds)

movement broken(m: <chat-[:message]->>) {
  write chat.
`);
    expect(refs).toContainEqual({ adapter: 'slack', credential: 'Dev Loop Slack' });
  });

  it('never throws on arbitrary text', () => {
    expect(referencedConstructions('}{ not movement ((( source')).toEqual([]);
    expect(referencedConstructions('')).toEqual([]);
  });

  it('constructionKey distinguishes credential-free from credentialed pairs', () => {
    expect(constructionKey({ adapter: 'email' })).toBe('email::');
    expect(constructionKey({ adapter: 'attio', credential: 'main' })).toBe('attio::main');
  });
});

describe('mergeInstanceSchema', () => {
  const schema: InstanceSchema = {
    positions: { message: { properties: { subject: 'text' }, edges: {} } },
    collections: { messages: { target: 'message' } },
    writableRoots: {},
  };
  const skeleton: CatalogSnapshot = {
    adapters: {
      attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schemas: {} },
      email: { constructionArgs: [{ name: 'credentials', kind: 'position', required: false }], schemas: {} },
    },
    credentials: { acme_main: { adapter: 'attio' } },
    plugins: {},
  };

  it('adds a schema under the credential import name without mutating the input', () => {
    const merged = mergeInstanceSchema(skeleton, {
      adapter: 'attio',
      credentialName: 'acme_main',
      schema,
    });
    expect(merged.adapters.attio.schemas).toEqual({ acme_main: schema });
    expect(skeleton.adapters.attio.schemas).toEqual({});
    // Other catalog slots ride along untouched.
    expect(merged.credentials).toBe(skeleton.credentials);
    expect(merged.adapters.email).toBe(skeleton.adapters.email);
  });

  it("keys credential-free schemas under ''", () => {
    const merged = mergeInstanceSchema(skeleton, { adapter: 'email', schema });
    expect(merged.adapters.email.schemas).toEqual({ '': schema });
  });

  it('preserves previously merged schemas on the same adapter', () => {
    const once = mergeInstanceSchema(skeleton, {
      adapter: 'attio',
      credentialName: 'acme_main',
      schema,
    });
    const twice = mergeInstanceSchema(once, {
      adapter: 'attio',
      credentialName: 'sandbox',
      schema,
    });
    expect(Object.keys(twice.adapters.attio.schemas).sort()).toEqual(['acme_main', 'sandbox']);
  });

  it('creates a default adapter entry when the adapter is missing from the snapshot', () => {
    const merged = mergeInstanceSchema(
      { adapters: {}, credentials: {}, plugins: {} },
      { adapter: 'slack', credentialName: 'team_chat', schema },
    );
    expect(merged.adapters.slack).toEqual({
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schemas: { team_chat: schema },
    });
  });
});
