// Language version 5 ("Dancing Wren"): `#` hops are retired. There are no meta
// edges — every edge is one a system declares — and a plugin is a function you
// import and call. Every `#` form the grammar accepts:
//   - `-[:#name]->` (and `-[#name]->`, and `` -[:`#name`]-> ``): the engine
//     handed it to the system as one of its own references — MOV_META_HOP_RETIRED;
//   - `-[f:#resources]->`: the old spelling of `-[f:_resources]->` — MOV_META_HOP_RETIRED;
//   - `-[t:#transform { plugin: … }]->`: MOV_TRANSFORM_HOP_RETIRED since 3, its
//     message showing the plugin as a function under 5;
//   - `-[#linked …]->`: MOV_LINKED_HOP_RETIRED since 3;
//   - `-[:#extract]->`: never accepted (the lowering refuses it under every version).
// Under version 4 every one keeps its old answer.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: { properties: { Name: 'text' }, edges: { members: { target: 'person' } } },
    person: { properties: { Name: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: { note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} } },
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema }, loose: { constructionArgs: [] } },
  plugins: {
    // Callable: declares what it does and hands back, and needs `text` written
    // where a stage would have fed it.
    vc_url_retrieval: {
      args: ['email'],
      fedArgs: [{ name: 'text', required: true }],
      effects: { reads: ['the web'], ai: true },
      output: { kind: 'records', fields: { name: 'text', url: 'text', text: 'text' } },
    },
    // A stage only: fed by the extraction, nothing of its own.
    linkedin_enrichment: { args: [], fedByExtraction: true, effects: { reads: ['the web'], ai: true } },
  },
});

const source = (body: string, param = '<chat-[:channel]->>') => `import { slack, loose } from adapters
chat = slack()
free = loose()
movement scan(c: ${param}) {
${body}
}
listen to chat fire scan`;

function check(src: string, languageVersion: LanguageVersion) {
  return checkProgram(parseProgram(src, { languageVersion }), catalog, { languageVersion }).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (src: string, v: LanguageVersion) => check(src, v).map((d) => d.code);

describe('a `#` hop under Dancing Wren (5)', () => {
  const WALKS: Array<[string, string]> = [
    ['a value', '  x = FIRST(c-[:#foo]->)'],
    ['a field read', '  x = c-[:#foo]->.Name'],
    ['a block head', '  c-[:#foo]-> {\n    y = 1\n  }'],
    ['a block head without the colon', '  c-[#foo]-> {\n    y = 1\n  }'],
    ['a backticked name', '  x = c-[:`#foo`]->.Name'],
    ['a write target', '  write c-[:#foo]-> { Body: "a" }'],
    ['a collection', '  x = COUNT(chat-[:#Channels]->)'],
    ['a walk of a system nothing describes', '  x = FIRST(free-[:#foo]->)'],
  ];

  it.each(WALKS)('is MOV_META_HOP_RETIRED in %s', (_where, body) => {
    const found = check(source(body), 5);
    expect(found.map((d) => d.code)).toContain(C.META_HOP_RETIRED);
    const said = found.find((d) => d.code === C.META_HOP_RETIRED)!.message;
    expect(said).toContain("'#' hops are retired");
    expect(said).toContain('only the edges a system declares');
  });

  it('on a system nothing describes it is the only refusal (under 4 that walk was silent)', () => {
    expect(codes(source('  x = FIRST(free-[:#foo]->)'), 5)).toEqual([C.META_HOP_RETIRED]);
    expect(codes(source('  x = FIRST(free-[:#foo]->)'), 4)).toEqual([]);
  });

  it("is refused in a parameter's type address", () => {
    expect(codes(source('  y = 1', '<chat-[:#channel]->>'), 5)).toEqual([C.META_HOP_RETIRED]);
    expect(codes(source('  y = 1', '<chat-[:channel]->-[:#members]->>'), 5)).toEqual([C.META_HOP_RETIRED]);
    expect(codes(source('  y = 1', '<chat-[:#channel]->>'), 4)).toEqual([]);
  });

  it('#resources is refused, the message naming the resource edge to write', () => {
    const body = '  c-[f:#resources]-> {\n    y = f.url\n  }';
    const found = check(source(body), 5);
    expect(found.map((d) => d.code)).toEqual([C.META_HOP_RETIRED]);
    expect(found[0].message).toContain("write '-[f:_resources]->'");
    expect(codes(source(body), 4)).toEqual([]);
  });

  it('#transform and #linked keep their own codes; #extract its parse refusal', () => {
    expect(codes(source('  x = c-[t:#transform { plugin: "vc_url_retrieval" }]->.out'), 5)).toEqual([C.TRANSFORM_HOP_RETIRED]);
    expect(codes(source('  x = c-[#linked WHERE type = "ATTIO"]->.external_id'), 5)).toEqual([C.LINKED_HOP_RETIRED]);
    expect(codes(source('  x = COUNT(c-[:#extract]->)'), 5)).toEqual([C.EXPR_PARSE]);
    expect(codes(source('  x = COUNT(c-[:#extract]->)'), 4)).toEqual([C.EXPR_PARSE]);
  });

  it('under Luminous Owl (4) a `#` hop on a described system is the unknown edge it always was', () => {
    expect(codes(source('  x = FIRST(c-[:#foo]->)'), 4)).toEqual([C.TRAVERSE_UNKNOWN_EDGE]);
  });
});

describe('the #transform hop shows the plugin as a function under Dancing Wren (5)', () => {
  const said = (plugin: string, v: LanguageVersion) =>
    check(source(`  x = c-[t:#transform { plugin: "${plugin}" }]->.out`), v)
      .filter((d) => d.code === C.TRANSFORM_HOP_RETIRED)
      .map((d) => d.message)
      .join('\n');

  it('a callable plugin: imported, called with what a stage would have fed it, its result bound', () => {
    const message = said('vc_url_retrieval', 5);
    expect(message).toContain('a plugin is a function');
    expect(message).toContain("'import { vc_url_retrieval } from plugins'");
    expect(message).toContain("'out = vc_url_retrieval(text: …)'");
  });

  it('a plugin only an extraction can feed: written as its stage', () => {
    expect(said('linkedin_enrichment', 5)).toContain("'extract from [ … ] through [linkedin_enrichment] { … }'");
  });

  it('under 4 the message is unchanged', () => {
    expect(said('vc_url_retrieval', 4)).toContain("'out = vc_url_retrieval(…)'");
  });
});

describe("a plugin's function form reaches its declared output", () => {
  it('the call is typed by the output: its records read by field', () => {
    const body = [
      '  urls = vc_url_retrieval(text: "see https://example.com")',
      '  first = FIRST(urls)',
      '  if first != null {',
      '    write chat-[:note]-> { Body: first.url }',
      '  }',
    ].join('\n');
    const src = source(body).replace('import { slack, loose } from adapters', 'import { slack, loose } from adapters\nimport { vc_url_retrieval } from plugins');
    for (const v of [4, 5] as const) expect(codes(src, v)).toEqual([]);
    // …and a field it does not hand back is refused, so the type is the output's.
    expect(codes(src.replace('first.url', 'first.nope'), 5)).not.toEqual([]);
  });
});
