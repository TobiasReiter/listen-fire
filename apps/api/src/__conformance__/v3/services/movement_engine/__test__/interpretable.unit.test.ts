// The dry interpretability check (movement_engine/interpretable.ts) —
// the save gate's engine half: a source using constructs the engine
// lacks is refused at save time with the constructs NAMED, instead of
// failing firings later. Pure AST scan; no DB, no adapter registry.

import { listUnsupportedConstructs } from '../interpretable';

const PRELUDE = `
import { email, attio, kg } from adapters
import { acme_main } from credentials

inbox = email()
crm   = attio(credentials: acme_main)
graph = kg()
`;

describe('listUnsupportedConstructs', () => {
  it('a movement on the supported slice (writes, if, PARALLEL, extract, blocks) passes clean', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  parallel {
    co = write crm-[:companies]-> {
      unique by (\`name\`)
      name: m.\`subject\`
    }
    note = write crm-[:note]-> {
      text: m.\`sender\`
    }
  }
  if m.\`subject\` CONTAINS "deal" {
    write co-[:notes]-> {
      text: "flagged"
    }
  }
  deals = extract from [m.\`subject\`] {
    name: "the deal name"
  }
}

listen to inbox { key: "intake" } fire intake
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('movement calls (composition) pass — including declaration-typed callees and synthesised args', () => {
    const source = `${PRELUDE}
node Files {
  name: <text>
  data: <text>
}

movement helper(f: <Files>) {
  write crm-[:companies]-> { name: f.\`name\` }
}

movement intake(m: <inbox-[:message]->>) {
  helper(f: node { name: m.\`subject\`, data: m.\`subject\` })
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('still scans call arguments (an unsupported expression inside a synthesised arg is named)', () => {
    const source = `${PRELUDE}
node Files {
  name: <text>
}

movement helper(f: <Files>) {
  write crm-[:companies]-> { name: f.\`name\` }
}

movement intake(m: <inbox-[:message]->>) {
  helper(f: node { name: KG_EXISTS("MATCH (n) RETURN n", m.\`subject\`) })
}
`;
    expect(
      listUnsupportedConstructs(source).some((c) =>
        c.includes('query the graph with a traversal instead'),
      ),
    ).toBe(true);
  });

  it('EXISTS() quantifiers pass (runtime exists since E6), including hop and final WHEREs', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  if EXISTS(m-[:files]-> WHERE \`name\` CONTAINS "pdf") {
    write crm-[:companies]-> { name: EXISTS(m-[:files]->) }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('manual-channel backfills pass — instance-rooted block heads + the named manual instance parameter', () => {
    const source = `import { manual, attio } from adapters
import { acme_main } from credentials
runs = manual()
crm = attio(credentials: acme_main)
movement backfill(go: <runs-[:Invocation]->>) {
  crm-[c:companies]-> {
    write crm-[:companies]-> { name: c.\`name\` }
  }
}

listen to runs {} fire backfill
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('standalone edge statements pass (E7 — the Adapter.linkRecords seam)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  a = write crm-[:companies]-> { name: m.\`subject\` }
  b = write crm-[:people]-> { name: m.\`sender\` }
  link a -[:employs]-> b
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('unlink and delete statements pass (the unlinkRecords / deleteRecord seams)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  a = write crm-[:companies]-> { name: m.\`subject\` }
  b = write crm-[:people]-> { name: m.\`sender\` }
  unlink a -[:employs]-> b
  delete b
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it("'?:' set-if-empty fields pass (write-path semantics, no new expression kinds)", () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    unique by (\`name\`)
    name:     m.\`subject\`
    owner ?: m.\`sender\`
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('AI() expressions and bare-name value reads pass (run through the LlmClient seam / env reads)', () => {
    const source = `${PRELUDE}
company_prompt = "normalise the company name in this subject line"

movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: AI(company_prompt)
    summary: AI("summarise this")
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('graph-rooted movements pass (a constructed graph is a root like any other)', () => {
    const source = `${PRELUDE}
movement sweep(round: <graph-[:funding_round]->>) {
  write crm-[:companies]-> { name: round.\`name\` }
}

listen to graph { type: "funding_round" } fire sweep
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('a movement seeded from an unknown graph root stays flagged', () => {
    const source = `${PRELUDE}
movement sweep(round: <ghost-[:funding_round]->>) {
  write crm-[:companies]-> { name: round.\`name\` }
}
`;
    expect(listUnsupportedConstructs(source)).toContain(
      "a movement seeded from 'ghost' (not a constructed instance or shape)",
    );
  });

  it('multi-parameter movements pass (library callees take any arity; entry arity is checker territory), and IS conditions pass', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>, extra: <inbox-[:message]->>) {
  if m IS inbox.message {
    write crm-[:companies]-> { name: m.\`subject\` }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('every parameter of a multi-parameter movement is root-checked (unknown roots stay flagged)', () => {
    const source = `${PRELUDE}
movement pair(m: <inbox-[:message]->>, round: <ghost-[:funding_round]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([
      "a movement seeded from 'ghost' (not a constructed instance or shape)",
    ]);
  });

  it('names file-level extract / blocks / writes', () => {
    const source = `${PRELUDE}
r = extract from ["a fixed document"] {
  name: "the name"
}

movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
    expect(listUnsupportedConstructs(source)).toContain('file-level extract expressions');
  });

  it('names file-level matches and links — the engine runs neither outside a movement body', () => {
    const source = `${PRELUDE}
co = match crm-[:companies]-> { unique by (\`name\`), name: "Acme" }

movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual(['file-level matches']);
    const linked = source.replace(
      'co = match crm-[:companies]-> { unique by (`name`), name: "Acme" }',
      'co = link crm -[:companies]-> { name: "Acme" }',
    );
    expect(listUnsupportedConstructs(linked)).toEqual(['file-level links']);
  });

  it('names a file-level call spelled as a construction — a plugin or a movement, not an adapter', () => {
    const plugin = `${PRELUDE}
import { fetch_url } from plugins
page = fetch_url(url: "https://example.com")

movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
    expect(listUnsupportedConstructs(plugin)).toEqual(['file-level calls']);
    const movement = plugin
      .replace('import { fetch_url } from plugins\n', '')
      .replace('page = fetch_url(url: "https://example.com")', 'page = intake(m: "x")');
    expect(listUnsupportedConstructs(movement)).toEqual(['file-level calls']);
    // The PRELUDE's own constructions (`crm = attio(…)`) are constructions.
    expect(listUnsupportedConstructs(plugin.replace(/page = .*\n/, ''))).toEqual([]);
  });

  it('built-in pure function calls (COALESCE, TRIM, …) pass — the evaluator mirrors them', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: COALESCE(m.\`subject\`, "unknown")
    text: UPPER(TRIM(m.\`subject\`))
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('non-built-in functions pass inside adapter-write fields (the write path binds the field\'s advertised functions at runtime)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: DOMAIN_OF(m.\`subject\`) }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('names non-built-in functions outside a write field (no adapter functions can ever be in scope there)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  if DOMAIN_OF(m.\`subject\`) == "acme.dev" {
    write crm-[:companies]-> { name: m.\`subject\` }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([
      'non-built-in function calls (DOMAIN_OF())',
    ]);
  });

  it('a call nested in an expression (version 3) is the binding it means, and scans as one', () => {
    const source = `${PRELUDE}
movement double(n: <number>) {
  return n * 2
}

movement intake(m: <inbox-[:message]->>) {
  if double(LENGTH(m.\`subject\`)) > 4 AND COUNT(MAP([1], (v) => v)) == 1 {
    write crm-[:companies]-> { name: UPPER(m.\`subject\`) }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
    // What a nested call runs is still scanned: its closure's body here.
    const inner = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  if COUNT(MAP([m.\`subject\`], (v) => DOMAIN_OF(v))) == 1 {
    write crm-[:companies]-> { name: m.\`subject\` }
  }
}
`;
    expect(listUnsupportedConstructs(inner)).toEqual(['non-built-in function calls (DOMAIN_OF())']);
  });

  it('a closure bound to a name is a function: its call nested in an expression runs (version 3)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  inc = (v: <number>) => v + 1
  if inc(LENGTH(m.\`subject\`)) > 4 {
    write crm-[:companies]-> { name: m.\`subject\` }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it('names non-built-in functions in SHAPE-write fields (shapes have no adapter to bind functions from)', () => {
    const source = `${PRELUDE}
node Files {
  name: <text>
}

movement helper(f: <Files>) {
  write crm-[:companies]-> { name: f.\`name\` }
}

movement intake(m: <inbox-[:message]->>) {
  helper(f: node { name: DOMAIN_OF(m.\`subject\`) })
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([
      'non-built-in function calls (DOMAIN_OF())',
    ]);
  });

  it('meta values (@user_email, @current_date, @actor_name) pass — the frozen key families are mirrored', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  if @current_date == "2026-06-11" {
    write crm-[:companies]-> {
      name:    m.\`subject\`
      owner ?: @user_email
      text:    "filed by \${@actor_name}"
    }
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });

  it("names '@parent.*' and '@resource.*' reads (TG-shaped sources a movement run doesn't have)", () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> {
    name: @parent.created
    text: @resource.name
  }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([
      "'@parent.*' reads (read the parent write's handle instead)",
      "'@resource.*' reads (traverse -[:_resources]-> instead)",
    ]);
  });

  it("a head's EXPRESSION root is an expression slot, and is scanned as one", () => {
    // The hops carry no interpretability question; the root does, because it
    // is an expression like any other — and an unscanned one would reach a
    // firing instead of the save gate.
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  rows = [m]
  AT(rows, KG_VALUE("MATCH (n) RETURN n.i", m.\`subject\`))-[c:companies]-> {
    write crm-[:note]-> { text: c.\`name\` }
  }
}
`;
    expect(listUnsupportedConstructs(source).filter((c) => c.startsWith('KG_VALUE()'))).toHaveLength(
      1,
    );
  });

  it('a non-parsing source returns [] (parse diagnostics own that failure)', () => {
    expect(listUnsupportedConstructs('movement {{{{')).toEqual([]);
  });

  it('deduplicates repeated constructs', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: KG_VALUE("MATCH (n) RETURN n.name", m.\`subject\`) }
  write crm-[:people]->  { name: KG_VALUE("MATCH (n) RETURN n.name", m.\`subject\`) }
}
`;
    const found = listUnsupportedConstructs(source);
    expect(found.filter((c) => c.startsWith('KG_VALUE()'))).toHaveLength(1);
  });

  // Chunk 2 turned the engine on: the store, the router and the resume-at-entry
  // path exist, so `callback(…)` is an INTERPRETABLE construct. What a callback
  // DEFERS is still scanned — a body that cannot run is a movement that cannot
  // run, whenever it runs.
  describe('callback — interpretable; its body is still scanned', () => {
    it('a movement minting a callback is not flagged', () => {
      const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  cb = callback({ write crm-[:companies]-> { name: m.\`subject\` } })
  write crm-[:note]-> { text: cb.\`id\` }
}
`;
      expect(listUnsupportedConstructs(source)).toEqual([]);
    });

    it('the named form and the body-less form are equally interpretable', () => {
      const named = `${PRELUDE}
movement helper(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}

movement intake(m: <inbox-[:message]->>) {
  cb = callback(helper(m: m))
}
`;
      const bodyless = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  cb = callback()
}
`;
      expect(listUnsupportedConstructs(named)).toEqual([]);
      expect(listUnsupportedConstructs(bodyless)).toEqual([]);
    });

    it("a callback BODY's own unsupported constructs are still named", () => {
      const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  cb = callback({ write crm-[:companies]-> { name: @parent.created } })
}
`;
      expect(listUnsupportedConstructs(source)).toEqual([
        "'@parent.*' reads (read the parent write's handle instead)",
      ]);
    });

    it('a movement using no callback is unaffected', () => {
      const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
      expect(listUnsupportedConstructs(source)).toEqual([]);
    });
  });

  it('the `function` spelling of a movement declaration scans exactly like `movement`', () => {
    const source = `${PRELUDE}
function intake(m: <inbox-[:message]->>) {
  write crm-[:companies]-> { name: m.\`subject\` }
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
    // …and its parameters are root-checked the same way.
    const bad = `${PRELUDE}
function sweep(round: <ghost-[:funding_round]->>) {
  write crm-[:companies]-> { name: round.\`name\` }
}
`;
    expect(listUnsupportedConstructs(bad)).toEqual([
      "a movement seeded from 'ghost' (not a constructed instance or shape)",
    ]);
  });

  it('an ERROR() statement is NOT flagged (it runs — fails the run with a reason)', () => {
    const source = `${PRELUDE}
movement intake(m: <inbox-[:message]->>) {
  ERROR("stop here")
}
`;
    expect(listUnsupportedConstructs(source)).toEqual([]);
  });
});
