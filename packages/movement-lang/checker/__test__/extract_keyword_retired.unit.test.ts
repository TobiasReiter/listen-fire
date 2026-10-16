// The extraction keyword under language version 5 (Henry's ruling,
// 2026-10-16): refused as MOV_EXTRACT_KEYWORD_RETIRED, with the rewrite to a
// declared shape and `extractOne` where it is mechanical, and no rewrite for a
// `through […]` stage. Versions 1–4 are unchanged.

import { parseProgram } from '../../parser/parse';
import { checkProgram, type Diagnostic } from '../check';
import { mockCatalog, type InstanceSchema } from '../catalog';
import { applyFix } from '../fixes';

const chatSchema: InstanceSchema = {
  positions: {
    message: { properties: { Text: 'text' }, edges: {} },
    note: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { note: { target: 'note' } },
  writableRoots: { note: { fields: { Body: 'text' }, resultShape: { Body: 'text' }, edges: {} } },
};

const catalog = mockCatalog({
  adapters: { slack: { constructionArgs: [], schema: chatSchema } },
  plugins: { fetchUrl: { args: ['url'], priced: true, output: { kind: 'value', type: 'text' } } },
});

const RETIRED = 'MOV_EXTRACT_KEYWORD_RETIRED';

function check(source: string, languageVersion: number): Diagnostic[] {
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion }).filter((d) => (d.severity ?? 'error') === 'error');
}

const V5_PRELUDE = 'import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n';
const V4_PRELUDE = 'import { slack } from adapters\nchat = slack()\n\n';

/** Every MOV_EXTRACT_KEYWORD_RETIRED fix applied, one per pass, as the upgrade loop applies them. */
function upgraded(source: string): string {
  let text = source;
  for (let pass = 0; pass < 10; pass++) {
    const retired = check(text, 5).find((d) => d.code === RETIRED && d.fix !== undefined);
    if (retired?.fix === undefined) return text;
    text = applyFix(text, retired.fix);
  }
  throw new Error('the fixes did not settle');
}

const TREE = `${V5_PRELUDE}function go(m: <chat-[:message]->>) {
  found = extract "careful" from [m.Text, "the subject"] {
    node company: "each company named" {
      name: <text> "its name"
      \`Big Co\`: <text | null> "x"
      node person: "each person" { name: "their name" }
    }
  }
  found-[c:company]-> {
    write chat-[:note]-> { Body: c.name }
  }
}
`;

describe('the extraction keyword under language version 5', () => {
  it('is refused, and the fix declares the tree and calls extractOne over the same content and tier', () => {
    const retired = check(TREE, 5).filter((d) => d.code === RETIRED);
    expect(retired).toHaveLength(1);
    expect(retired[0].message).toContain("writes 'found = extractOne(content, FoundShape, { tier: \"careful\" })'");
    expect(retired[0].message).toContain('(see handbook: front#extraction)');
    // Never applied on its own: the record may be absent, and the call's prompt differs.
    expect(retired[0].fix?.safe).toBeUndefined();
    expect(upgraded(TREE)).toBe(`${V5_PRELUDE}node FoundShape: "the relevant information in the content" {
  node company: "each company named" {
    name: <text> "its name"
    \`Big Co\`: <text | null> "x"
    node person: "each person" {
      name: <text> "their name"
    }
  }
}

function go(m: <chat-[:message]->>) {
  found = extractOne([m.Text, "the subject"], FoundShape, { tier: "careful" })
  found-[c:company]-> {
    write chat-[:note]-> { Body: c.name }
  }
}
`);
    expect(check(upgraded(TREE), 5)).toEqual([]);
  });

  it('names each shape after its binding, numbered past a name the file already holds', () => {
    const source = `${V5_PRELUDE}node XShape { a: <text> }

function go(m: <chat-[:message]->>) {
  x = extract from [m.Text] { node co: "each" { name: <text> "n" } }
  found_cos = extract from [m.Text] { node co: "each" { name: <text> "n" } }
}

function again(m: <chat-[:message]->>) {
  x = extract from [m.Text] { node co: "each" { name: <text> "n" } }
}
`;
    const text = upgraded(source);
    expect(text).toContain('x = extractOne([m.Text], XShape2)');
    expect(text).toContain('found_cos = extractOne([m.Text], FoundCosShape)');
    expect(text).toContain('x = extractOne([m.Text], XShape3)');
    expect(check(text, 5).filter((d) => d.code === RETIRED)).toEqual([]);
  });

  it("keeps a declaration whose words interpolate in the body, where they are read; a field read off the record then needs a fallback", () => {
    const source = `${V5_PRELUDE}function go(m: <chat-[:message]->>) {
  y = extract from [m.Text] { topic: "the topic of \${m.Text}" }
  write chat-[:note]-> { Body: y.topic }
}
`;
    const text = upgraded(source);
    expect(text).toBe(`${V5_PRELUDE}function go(m: <chat-[:message]->>) {
  node YShape: "the relevant information in the content" {
    topic: <text> "the topic of \${m.Text}"
  }
  y = extractOne([m.Text], YShape)
  write chat-[:note]-> { Body: y.topic }
}
`);
    // The keyword's result was always there; the one record may be absent.
    expect(check(text, 5).map((d) => d.code)).toEqual(['MOV_ABSENT_REQUIRED']);
  });

  it('writes a declared node out in place, its words the use site’s', () => {
    const source = `${V5_PRELUDE}node Lead: "a lead" {
  name: <text> "its name"
  node contact { email: <text | null> }
}

function go(m: <chat-[:message]->>) {
  found = extract from [m.Text] {
    node lead: <Lead> "each lead in the message"
  }
}
`;
    const text = upgraded(source);
    expect(text).toContain(`node FoundShape: "the relevant information in the content" {
  node lead: "each lead in the message" {
    name: <text> "its name"
    node contact {
      email: <text | null>
    }
  }
}`);
    expect(check(text, 5)).toEqual([]);
  });

  it('has no rewrite for a through stage, and says why', () => {
    for (const tree of [
      'found = extract from [m.Text] through [fetchUrl(m.Text)] { summary: "s" }',
      'found = extract from [m.Text] { node co: "each" { site: <text> "w" } through [fetchUrl(site)] { summary: "s" } }',
    ]) {
      const source = `import { fetchUrl } from plugins\n${V5_PRELUDE}function go(m: <chat-[:message]->>) {\n  ${tree}\n}\n`;
      const retired = check(source, 5).filter((d) => d.code === RETIRED);
      expect(retired).toHaveLength(1);
      expect(retired[0].fix).toBeUndefined();
      expect(retired[0].message).toContain("No rewrite keeps a 'through […]' stage's meaning");
    }
  });

  it('is refused in a return too', () => {
    const source = `${V5_PRELUDE}function go(m: <chat-[:message]->>) {\n  return extract from [m.Text] { node co: "each" { name: <text> "n" } }\n}\n`;
    expect(upgraded(source)).toContain('return extractOne([m.Text], ExtractedShape)');
  });
});

describe('the extraction keyword under language versions 1–4', () => {
  it('is checked as it always was', () => {
    const source = `${V4_PRELUDE}movement go(m: <chat-[:message]->>) {
  found = extract from [m.Text] {
    node company: "each company named" { name: <text> "its name" }
  }
  found-[c:company]-> {
    write chat-[:note]-> { Body: c.name }
  }
}
`;
    for (const version of [3, 4]) expect(check(source, version)).toEqual([]);
  });
});
