// The extraction keyword's upgrade (MOV_EXTRACT_KEYWORD_RETIRED, language
// version 5) holds its meaning where the fix says it does: the keyword under
// version 4 and the checker's own rewrite of it under version 5, run on the
// TypeScript engine against a model that answers each with the same records,
// write the same things.

import { applyFix, checkProgram, fromCatalogSnapshot, mockCatalogSnapshot, parseProgram, type InstanceSchema } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import { containerAssociation, type Adapter } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { credentialIdsFor, makeTestHost } from 'movement-engine/services/movement_engine/test_host';
import { runMovement } from 'movement-engine/services/movement_engine/run';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b4');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};
const attioSchema: InstanceSchema = {
  positions: { company: { properties: { name: 'text' }, edges: {} } },
  collections: { companies: { target: 'company' } },
  writableRoots: { company: { fields: { name: 'text' }, resultShape: { externalId: 'text', name: 'text' } } },
};
const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: attioSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, acme_main: { adapters: ['attio'] } },
});

const V4 = `import { email, attio } from adapters
import { dealflow_inbox, acme_main } from credentials
inbox = email(credentials: dealflow_inbox)
crm = attio(credentials: acme_main)

movement m(msg: <inbox-[:message]->>) {
  found = extract "careful" from [msg.\`text\`] {
    node company: "each company named" {
      name: <text> "its name"
      node person: "each person at it" { name: <text> "their name" }
    }
  }
  found-[c:company]-> {
    write crm-[:companies]-> { name: c.name }
    c-[p:person]-> {
      write crm-[:companies]-> { name: "\${c.name}: \${p.name}" }
    }
  }
}
`;

/** The same program in version 5's spelling, still holding the keyword. */
const V5 = `import { \`@lf/email\` as email, \`@lf/attio\` as attio } from adapters
import { dealflow_inbox, acme_main } from credentials
inbox = connect email using dealflow_inbox
crm = connect attio using acme_main

function m(msg: <inbox-[:message]->>) {
  found = extract "careful" from [msg.\`text\`] {
    node company: "each company named" {
      name: <text> "its name"
      node person: "each person at it" { name: <text> "their name" }
    }
  }
  found-[c:company]-> {
    write crm-[:companies]-> { name: c.name }
    c-[p:person]-> {
      write crm-[:companies]-> { name: "\${c.name}: \${p.name}" }
    }
  }
}
`;

const COMPANIES = [
  { name: 'Acme', person: [{ name: 'Ada' }, { name: 'Grace' }] },
  { name: 'Initech', person: [] },
];
const cited = (value: string) => ({ evidence: 'q', value });

/** The keyword's envelope: the root's one record, its nodes beneath it. */
const KEYWORD_REPLY = {
  'x:extract_result#1': [{ company: COMPANIES.map((c) => ({ name: cited(c.name), person: c.person.map((p) => ({ name: cited(p.name) })) })) }],
};
/** extractOne's: the one record. */
const CALL_REPLY = { record: { company: COMPANIES.map((c) => ({ name: cited(c.name), person: c.person.map((p) => ({ name: cited(p.name) })) })) } };

function emailAdapter(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const data = positionData(input.position) as Record<string, unknown> | undefined;
      return data?.[input.fieldId];
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

async function writesOf(source: string, languageVersion: 4 | 5): Promise<unknown[]> {
  const previous = process.env.MOVEMENT_ENGINE;
  process.env.MOVEMENT_ENGINE = 'ts';
  const created: unknown[] = [];
  const crm: Adapter = {
    ...emailAdapter(),
    adapterType: 'attio',
    async createRecord(input) {
      created.push(input.fields);
      return { adapterType: 'attio', externalId: `co-${created.length}`, data: {} };
    },
  };
  try {
    await runMovement({
      source,
      languageVersion,
      event: { pipelineInputId: 'pi-keyword-upgrade', adapterType: 'email', triggerType: 'webhook', payload: { text: 'Acme (Ada, Grace) and Initech.' } },
      teamId: TEAM_ID,
      catalog,
      credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
      host: makeTestHost({
        adapters: { resolve: (r) => (r.adapterType === 'attio' ? crm : emailAdapter()) },
        llm: {
          client: { call: async () => ({ parsedJson: KEYWORD_REPLY }) },
          extractCall: { call: async () => ({ parsedJson: CALL_REPLY, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) },
        },
      }),
    });
  } finally {
    if (previous === undefined) delete process.env.MOVEMENT_ENGINE;
    else process.env.MOVEMENT_ENGINE = previous;
  }
  return created;
}

describe("the extraction keyword's upgrade to extractOne over a declared shape", () => {
  it('writes what the keyword wrote, when the model answers each with the same records', async () => {
    const retired = checkProgram(parseProgram(V5, { languageVersion: 5 }), fromCatalogSnapshot(catalog), { languageVersion: 5 }).find(
      (d) => d.code === 'MOV_EXTRACT_KEYWORD_RETIRED',
    );
    expect(retired?.fix).toBeDefined();
    const upgraded = applyFix(V5, retired!.fix!);
    expect(upgraded).toContain('found = extractOne([msg.`text`], FoundShape, { tier: "careful" })');
    const errors = checkProgram(parseProgram(upgraded, { languageVersion: 5 }), fromCatalogSnapshot(catalog), { languageVersion: 5 }).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    // The call's record may be absent, which the keyword's result never was:
    // the walk off it asks for its guard, which a person writes.
    expect(errors.map((d) => d.code)).toEqual(['MOV_ABSENT_REQUIRED']);
    const guarded = upgraded.replace(/\n  found-\[c:company\]-> \{\n([\s\S]*?)\n  \}\n\}/, (_, body: string) => `\n  if (found != null) {\n  found-[c:company]-> {\n${body}\n  }\n  }\n}`);
    expect(guarded).not.toEqual(upgraded);

    const before = await writesOf(V4, 4);
    expect(before).toEqual([{ name: 'Acme' }, { name: 'Acme: Ada' }, { name: 'Acme: Grace' }, { name: 'Initech' }]);
    expect(await writesOf(guarded, 5)).toEqual(before);
  });
});
