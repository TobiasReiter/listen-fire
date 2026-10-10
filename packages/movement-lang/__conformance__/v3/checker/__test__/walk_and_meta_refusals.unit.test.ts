// Three places the expression path dropped or ignored what was written, without
// a word, refused at save under language version 3:
//   - `{ … }` settings on a hop were dropped;
//   - a walk ending in `-[:_resources]->` lost its root (as a value) or the
//     hops before it (as a block head);
//   - `LLM_AGG(…)` passed the save check, then failed the run, and its
//     instruction never reached a model.
// Under versions 1 and 2 each is accepted exactly as before. The `#transform`
// and `#linked` hops and the `@parent` / `@resource` reads are retired under
// version 3 outright (translation_graph_reads_retired.unit.test.ts).

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const chatSchema: InstanceSchema = {
  positions: {
    channel: { properties: { Name: 'text', Size: 'number' }, edges: { members: { target: 'person' } } },
    person: { properties: { Name: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { Channels: { target: 'channel' }, note: { target: 'note' } },
  writableRoots: {
    note: { fields: { Body: 'text', Count: 'number' }, resultShape: { Body: 'text' }, edges: {} },
  },
};

const catalog = mockCatalog({ adapters: { slack: { constructionArgs: [], schema: chatSchema } } });

function check(body: string, languageVersion: LanguageVersion) {
  const source = `import { slack } from adapters
chat = slack()
movement scan(c: <chat-[:channel]->>) {
${body}
}
listen to chat fire scan`;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion });
}

const OURS: ReadonlySet<string> = new Set([
  C.HOP_CONFIG_UNREAD,
  C.RESOURCE_WALK_UNREAD,
  C.BUILTIN_NOT_RUN,
]);

/** The codes this file is about — other diagnostics a snippet draws (an
 *  untyped resource walk, say) belong to their own tests. */
function codes(body: string, languageVersion: LanguageVersion = 3): string[] {
  return check(body, languageVersion).map((d) => d.code).filter((c) => OURS.has(c));
}

function messages(body: string): string {
  return check(body, 3).map((d) => d.message).join('\n');
}

describe('settings on a hop are refused', () => {
  it('settings on a plain edge hop are refused, in a value and in a block head', () => {
    expect(codes('  x = COUNT(c-[m:members { limit: 3 }]->)')).toEqual([C.HOP_CONFIG_UNREAD]);
    expect(codes('  c-[m:members { limit: 3 }]-> {\n    write chat-[:note]-> { Body: m.Name }\n  }')).toEqual([C.HOP_CONFIG_UNREAD]);
    expect(messages('  x = COUNT(c-[m:members { limit: 3 }]->)')).toContain('a hop takes no settings');
  });

  it('a hop without settings is fine', () => {
    expect(codes('  x = COUNT(c-[m:members]->)')).toEqual([]);
  });

  it('before version 3 the settings are dropped — unchanged', () => {
    expect(codes('  x = COUNT(c-[m:members { limit: 3 }]->)', 2)).toEqual([]);
  });
});

describe('a walk ending in a resource hop keeps what was written', () => {
  it('as a value, a rooted resource walk is refused — its root was dropped', () => {
    expect(codes('  x = c-[:_resources]->.url')).toEqual([C.RESOURCE_WALK_UNREAD]);
    expect(codes('  x = c-[m:members]->-[:_resources]->.url')).toEqual([C.RESOURCE_WALK_UNREAD]);
    expect(messages('  x = c-[:_resources]->.url')).toContain("c-[f:_resources]-> {");
  });

  it('a rootless one drops nothing and is not this refusal', () => {
    expect(codes('  x = -[:_resources]->.url')).toEqual([]);
  });

  it('before version 3 a rooted #linked walk drops its root — unchanged', () => {
    expect(codes('  x = c-[#linked WHERE type = "ATTIO"]->.external_id', 2)).toEqual([]);
  });

  it("a one-hop block head keeps its root — the engine reads it off the head", () => {
    expect(codes('  c-[f:_resources]-> {\n    write chat-[:note]-> { Body: f.url }\n  }')).toEqual([]);
  });

  it('a block head with hops before the resource hop is refused — the resource hop was never walked', () => {
    expect(codes('  c-[m:members]->-[f:_resources]-> {\n    write chat-[:note]-> { Body: f.url }\n  }'))
      .toEqual([C.RESOURCE_WALK_UNREAD]);
  });

  it('before version 3 the root and the leading hops are dropped — unchanged', () => {
    expect(codes('  x = c-[:_resources]->.url', 2)).toEqual([]);
    expect(codes('  c-[m:members]->-[f:_resources]-> {\n    write chat-[:note]-> { Body: f.url }\n  }', 2)).toEqual([]);
  });
});

describe('LLM_AGG is refused — the movement engine cannot run it', () => {
  it('with or without its instruction, wherever it is written', () => {
    expect(codes('  x = LLM_AGG(["a", "b"])')).toEqual([C.BUILTIN_NOT_RUN]);
    expect(codes('  x = LLM_AGG(["a", "b"], "summarise")')).toEqual([C.BUILTIN_NOT_RUN]);
    expect(codes('  write chat-[:note]-> { Body: llm_agg(["a"]) }')).toEqual([C.BUILTIN_NOT_RUN]);
    expect(messages('  x = LLM_AGG(["a", "b"], "summarise")')).toContain('AI(');
  });

  it('before version 3 it is accepted — unchanged', () => {
    expect(codes('  x = LLM_AGG(["a", "b"], "summarise")', 2)).toEqual([]);
  });
});
