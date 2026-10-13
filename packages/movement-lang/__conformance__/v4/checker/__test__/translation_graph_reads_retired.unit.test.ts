// Four expression forms from the translation graph, retired under language
// version 3. Each read something a movement run does not have:
//   - `-[t:#transform { plugin: … }]->` lowered to a step the movement engine
//     refuses at run time — a plugin is imported and called instead;
//   - `-[#linked WHERE type = "…"]->` looked a record up by another system's
//     id — the record a write lands on is its handle;
//   - `@parent.created` / `@parent.external_id` read the parent action node's
//     result — a child is written off the parent write's handle;
//   - `@resource.<field>` was the bare field name inside a `_resources` WHERE
//     (the fix writes it) and null everywhere else.
// Under versions 1 and 2 each is accepted exactly as before.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { applyFix } from '../fixes';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: { properties: { Name: 'text', Url: 'text' }, edges: { members: { target: 'person' } } },
    person: { properties: { Name: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema } },
  plugins: { fetch_url: { args: ['url', 'timeout'], requiredArgs: ['url'] } },
});

function source(body: string): string {
  return `import { slack } from adapters
chat = slack()
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
}

function check(body: string, languageVersion: LanguageVersion = 3) {
  return checkProgram(parseProgram(source(body), { languageVersion }), catalog, { languageVersion });
}

const OURS: ReadonlySet<string> = new Set([
  C.TRANSFORM_HOP_RETIRED,
  C.LINKED_HOP_RETIRED,
  C.PARENT_READ_RETIRED,
  C.RESOURCE_READ_RETIRED,
  C.HOP_CONFIG_UNREAD,
  C.RESOURCE_WALK_UNREAD,
]);

/** The codes this file is about — other diagnostics a snippet draws belong
 *  to their own tests. */
function codes(body: string, languageVersion: LanguageVersion = 3): string[] {
  return check(body, languageVersion).map((d) => d.code).filter((c) => OURS.has(c));
}

function messages(body: string): string {
  return check(body).map((d) => d.message).join('\n');
}

const BLOCK = (head: string) => `  ${head} {\n    write chat-[:note]-> { Body: "x" }\n  }`;

describe('the #transform hop is retired', () => {
  it('is refused as a value and as a block head, with or without settings — and its settings are not refused twice', () => {
    expect(codes('  x = c-[t:#transform { plugin: "fetch_url" }]->.out')).toEqual([C.TRANSFORM_HOP_RETIRED]);
    expect(codes('  x = c-[#transform]->.out')).toEqual([C.TRANSFORM_HOP_RETIRED]);
    expect(codes(BLOCK('c-[t:#transform { plugin: "fetch_url" }]->'))).toEqual([C.TRANSFORM_HOP_RETIRED]);
  });

  it('names the plugin call to write instead, with its required arguments, when the catalog has the plugin', () => {
    const said = messages('  x = c-[t:#transform { plugin: "fetch_url" }]->.out');
    expect(said).toContain("'import { fetch_url } from plugins'");
    expect(said).toContain("'out = fetch_url(url: …)'");
  });

  it('shows an example call when the plugin is not one the catalog has', () => {
    expect(messages('  x = c-[t:#transform { plugin: "nope" }]->.out'))
      .toContain("e.g. 'import { fetch_url } from plugins', then 'page = fetch_url(url: m.u)'");
  });

  it.each([1, 2])('is accepted under version %i — unchanged', (version) => {
    expect(codes('  x = c-[t:#transform { plugin: "fetch_url" }]->.out', version)).toEqual([]);
    expect(codes(BLOCK('c-[t:#transform { plugin: "fetch_url" }]->'), version)).toEqual([]);
  });
});

describe('settings on any hop are refused under version 3', () => {
  it('says no hop takes settings — #transform no longer does', () => {
    expect(codes('  x = COUNT(c-[m:members { limit: 3 }]->)')).toEqual([C.HOP_CONFIG_UNREAD]);
    expect(messages('  x = COUNT(c-[m:members { limit: 3 }]->)')).toContain('a hop takes no settings');
  });
});

describe('the #linked hop is retired', () => {
  it('is refused in every form: rooted, rootless, and as a block head', () => {
    expect(codes('  x = c-[#linked WHERE type = "ATTIO"]->.external_id')).toEqual([C.LINKED_HOP_RETIRED]);
    expect(codes('  x = -[#linked WHERE type = "ATTIO"]->.external_id')).toEqual([C.LINKED_HOP_RETIRED]);
    expect(codes(BLOCK('c-[#linked WHERE type = "ATTIO"]->'))).toEqual([C.LINKED_HOP_RETIRED]);
    expect(codes(BLOCK('c-[m:members]->-[#linked WHERE type = "ATTIO"]->'))).toEqual([C.LINKED_HOP_RETIRED]);
  });

  it("points to the write's handle, and to a bound write", () => {
    const said = messages('  x = -[#linked WHERE type = "ATTIO"]->.external_id');
    expect(said).toContain("'rec = write crm-[:Companies]-> { … }'");
    expect(said).toContain("'write … bind other { … }'");
    expect(said).toContain('(see handbook: front#identity)');
  });

  it.each([1, 2])('is accepted under version %i — unchanged', (version) => {
    expect(codes('  x = -[#linked WHERE type = "ATTIO"]->.external_id', version)).toEqual([]);
    expect(codes('  x = c-[#linked WHERE type = "ATTIO"]->.external_id', version)).toEqual([]);
  });
});

describe('@parent reads are retired', () => {
  it('every field is refused, known or not, wherever it is read', () => {
    expect(codes('  x = @parent.created')).toEqual([C.PARENT_READ_RETIRED]);
    expect(codes('  x = @parent.external_id')).toEqual([C.PARENT_READ_RETIRED]);
    expect(codes('  x = @parent.id')).toEqual([C.PARENT_READ_RETIRED]);
    expect(codes('  write chat-[:note]-> { Body: @parent.external_id }')).toEqual([C.PARENT_READ_RETIRED]);
  });

  it("points to writing the child off the parent's handle", () => {
    const said = messages('  x = @parent.created');
    expect(said).toContain("'co = write crm-[:Companies]-> { … }', then 'write co-[:Team]-> { … }'");
    expect(said).toContain('(see handbook: front#identity)');
  });

  it.each([1, 2])('is accepted under version %i — unchanged', (version) => {
    expect(codes('  x = @parent.created', version)).toEqual([]);
    expect(codes('  x = @parent.id', version)).toEqual([]);
  });
});

describe('@resource reads are retired', () => {
  it('outside a _resources WHERE it was always null — refused, with no fix', () => {
    const found = check('  x = @resource.url').filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(1);
    expect(found[0].fix).toBeUndefined();
    expect(found[0].message).toContain('always null');
  });

  it("inside a block head's _resources WHERE, the fix writes the bare field name — and the result checks clean", () => {
    const body = BLOCK('c-[f:_resources WHERE @resource.contentType == "a"]->');
    const found = check(body).filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("write the field's bare name: 'contentType'");
    const fixed = applyFix(source(body), found[0].fix!);
    expect(fixed).toContain('c-[f:_resources WHERE contentType == "a"]-> {');
    expect(checkProgram(parseProgram(fixed, { languageVersion: 3 }), catalog, { languageVersion: 3 })).toEqual(
      check(BLOCK('c-[f:_resources WHERE contentType == "a"]->')),
    );
    expect(codes(BLOCK('c-[f:_resources WHERE contentType == "a"]->'))).toEqual([]);
  });

  it("inside a value walk's _resources WHERE, the fix writes the bare field name too", () => {
    const body = '  x = -[:_resources WHERE @resource.type == "URL"]->.url';
    const found = check(body).filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(1);
    expect(applyFix(source(body), found[0].fix!)).toContain('x = -[:_resources WHERE type == "URL"]->.url');
  });

  it('a block head whose hops break across lines is refused with the rewrite in the message, but no edit — its hops have no exact place', () => {
    const body = BLOCK('c-[f:_resources WHERE\n    @resource.url != ""]->');
    const found = check(body).filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(1);
    expect(found[0].fix).toBeUndefined();
    expect(found[0].message).toContain("write the field's bare name: 'url'");
  });

  it('fixes every read in the WHERE, each in its own place', () => {
    const body = BLOCK('c-[f:_resources WHERE @resource.type == "URL" AND @resource.url != ""]->');
    const found = check(body).filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(2);
    // Each fix is placed against the source as checked, so they apply together.
    const fixed = applyFix(source(body), { edits: found.flatMap((d) => d.fix?.edits ?? []) });
    expect(fixed).toContain('c-[f:_resources WHERE type == "URL" AND url != ""]-> {');
  });

  it('an unknown field inside the WHERE is refused with the fields a resource has, and no fix', () => {
    const found = check(BLOCK('c-[f:_resources WHERE @resource.mime == "a"]->'))
      .filter((d) => d.code === C.RESOURCE_READ_RETIRED);
    expect(found).toHaveLength(1);
    expect(found[0].fix).toBeUndefined();
    expect(found[0].message).toContain('it has name, url, type, document_url, content, contentType');
  });

  it.each([1, 2])('is accepted under version %i — unchanged', (version) => {
    expect(codes('  x = @resource.url', version)).toEqual([]);
    expect(codes(BLOCK('c-[f:_resources WHERE @resource.contentType == "a"]->'), version)).toEqual([]);
  });
});
