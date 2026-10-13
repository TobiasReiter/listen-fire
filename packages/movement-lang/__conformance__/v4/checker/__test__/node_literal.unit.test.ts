// Checker coverage for `node { … }` — in-memory node synthesis, wave 1.
//
// The literal's TYPE IS ITS STRUCTURE: a checker-local node with no graph
// behind it. So the two things worth pinning are (a) that the entry's KIND
// decides field vs edge with nothing marking it (ruling 1), and (b) that a
// synthesised argument reaches a parameter STRUCTURALLY, where a real
// instance's position still reaches it nominally.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

// The event source: a message with a subject, a maybe-absent field, and an
// attachment edge (so a traversal-typed read is available to type an entry).
const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Body: 'text',
        Count: 'number',
        Snoozed: { kind: 'maybeAbsent', of: 'number' },
      },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: {
      properties: { Name: 'text', File: 'file', Pages: { kind: 'maybeAbsent', of: 'number' } },
      edges: {
        Versions: { target: 'version', readable: true },
        Answer: { target: 'answer', readable: true, awaitable: true, watchable: true },
      },
    },
    version: { properties: { Label: 'text' }, edges: {} },
    answer: { properties: { Text: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

// A second graph, so a nominal (instance) parameter is available too.
const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { name: 'text', size: 'number' },
      edges: { owner: { target: 'person', readable: true } },
    },
    person: { properties: { email: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: {
    email: { constructionArgs: [], schema: inboxSchema },
    crm: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
  },
  credentials: { crm_creds: { adapter: 'crm' } },
});

const PRELUDE = `import { email, crm } from adapters
import { crm_creds } from credentials
inbox = email()
book = crm(credentials: crm_creds)

node Deal {
  title: <text>
  amount: <number>
  node company {
    name: <text>
  }
}

movement takes_deal(d: <Deal>) {
}

movement takes_company(c: <book-[:company]->>) {
}

node Doc {
  title: <text>
  node files {
    Name: <text>
    File: <file>
  }
}

movement takes_doc(d: <Doc>) {
}

node Renamed {
  title: <text>
  node files {
    blob: <file>
  }
}

movement takes_renamed(d: <Renamed>) {
}

node \`Multi Words\` {
  title: <text>
  node \`Nested Edge\` {
    label: <text>
  }
}

movement takes_multi(d: <\`Multi Words\`>) {
}
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('the literal types itself', () => {
  it('a two-entry literal binds cleanly and its fields read by DOT', () => {
    expect(codes('  d = node { title: e.`Subject`, amount: e.`Count` }\n  x = d.title')).toEqual(
      [],
    );
  });

  it('an entry the literal never wrote is not readable', () => {
    expect(codes('  d = node { title: e.`Subject` }\n  x = d.nope')).toContain(
      C.UNKNOWN_PROPERTY,
    );
  });

  it('the SAME name twice is refused — one name, one meaning', () => {
    expect(codes('  d = node { title: e.`Subject`, title: e.`Body` }')).toContain(
      C.NODE_ENTRY_DUPLICATE,
    );
  });
});

describe('the entry KIND decides field vs edge (ruling 1)', () => {
  it('a nested literal is an EDGE — traversed by arrow, not read by dot', () => {
    expect(
      codes('  d = node { title: "x", company: node { name: e.`Subject` } }\n  d-[c:company]-> {\n    y = c.name\n  }'),
    ).toEqual([]);
  });

  it('a backtick-quoted nested entry is traversable by its backtick edge name', () => {
    expect(
      codes(
        '  d = node { title: "x", `Nested Edge`: node { label: "y" } }\n'
          + '  d-[x:`Nested Edge`]-> {\n    y = x.label\n  }',
      ),
    ).toEqual([]);
  });

  it('reading a synthesised edge by DOT is refused', () => {
    expect(
      codes('  d = node { company: node { name: "acme" } }\n  x = d.company'),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('traversing a VALUE entry is refused', () => {
    expect(codes('  d = node { title: "x" }\n  d-[t:title]-> {\n    y = t.z\n  }')).toContain(
      'MOV_TRAVERSE_UNKNOWN_EDGE',
    );
  });

  it('a PLURAL edge lands on one type — every landing readable through it', () => {
    expect(
      codes(
        '  d = node { files: [node { name: "a" }, node { name: "b" }] }\n' +
          '  d-[f:files]-> {\n    y = f.name\n  }',
      ),
    ).toEqual([]);
  });

  it('landings that disagree about an entry TYPE are told, not silently merged', () => {
    expect(
      codes('  d = node { files: [node { n: "a" }, node { n: 3 }] }'),
    ).toContain(C.NODE_LANDING_MISMATCH);
  });

  it('an entry only SOME landings carry is not readable through the edge', () => {
    expect(
      codes(
        '  d = node { files: [node { n: "a", extra: "x" }, node { n: "b" }] }\n' +
          '  d-[f:files]-> {\n    y = f.extra\n  }',
      ),
    ).toContain(C.UNKNOWN_PROPERTY);
  });
});

describe('a NODE in a field slot is refused (2026-08-05 ruling)', () => {
  it('a bound node as an entry value is an error, not a silent untyped field', () => {
    expect(codes('  d = node { btn: e }')).toContain(C.NODE_ENTRY_NODE_VALUE);
  });

  it('a synthesised node bound earlier is refused the same way', () => {
    expect(codes('  h = node { z: "x" }\n  d = node { btn: h }')).toContain(
      C.NODE_ENTRY_NODE_VALUE,
    );
  });

  it('a backtick-named node binding is refused through the parsed route', () => {
    expect(
      codes('  `my doc` = node { z: "x" }\n  d = node { btn: `my doc` }'),
    ).toContain(C.NODE_ENTRY_NODE_VALUE);
  });

  it('FIRST over a bare walk picks a node — refused in a field slot', () => {
    expect(codes('  d = node { f: ONLY(e-[a:Attachments]->) }')).toContain(
      C.NODE_ENTRY_NODE_VALUE,
    );
  });

  it('a scalar entry from the same source stays clean', () => {
    expect(codes('  d = node { t: e.`Subject` }')).toEqual([]);
  });
});

describe('a bare-name binding of a node is an ALIAS (2026-08-05 ruling)', () => {
  it('the alias carries the type — its fields read', () => {
    expect(codes('  f = e\n  t = f.`Subject`')).toEqual([]);
  });

  it('and a wrong field through the alias is refused — the type rode along', () => {
    expect(codes('  f = e\n  t = f.`Nope`')).toContain(C.UNKNOWN_PROPERTY);
  });

  it("an alias RETURNED from a block types the block's value", () => {
    expect(
      codes('  x = e-[a:Attachments]-> {\n    btn = a\n    return btn\n  }\n  x-[v:Versions]-> {\n    n = v.`Label`\n  }'),
    ).toEqual([]);
  });

  it('a wrong field through the chain is refused — no more silent dark', () => {
    expect(
      codes('  x = e-[a:Attachments]-> {\n    btn = a\n    return btn\n  }\n  n = x.`Nope`'),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('await through the chain reaches a real awaitable edge cleanly', () => {
    expect(
      codes('  x = e-[a:Attachments]-> {\n    btn = a\n    return btn\n  }\n  w = await FIRST(x-[ans:Answer]->)'),
    ).toEqual([]);
  });

  it('await through the chain onto a non-awaitable edge is now caught', () => {
    expect(
      codes('  x = e-[a:Attachments]-> {\n    btn = a\n    return btn\n  }\n  w = await FIRST(x-[v:Versions]->)'),
    ).toContain(C.AWAIT_NOT_AWAITABLE);
  });

  it('a scalar rebind stays a scalar binding — unaffected', () => {
    expect(codes('  s = e.`Subject`\n  s2 = s')).toEqual([]);
  });
});

describe('a node literal is effect-free', () => {
  // The grammar admits no statement forms as entry values, so the refusal is
  // the parser's and names the acting word. A program carrying one never
  // reaches the checker — which is the enforcement, stated here so the
  // guarantee has a test.
  it('a write inside a literal never parses', () => {
    expect(() =>
      parseProgram(
        `${PRELUDE}\nmovement m(e: <inbox-[:message]->>) {\n  d = node { r: write book-[:company]-> { name: "x" } }\n}`,
      ),
    ).toThrow(/only computes/);
  });
});

describe('call-site conformance — structural for a synthesised argument', () => {
  it('a literal carrying everything the DECLARATION declares fits', () => {
    expect(
      codes(
        '  takes_deal(d: node { title: e.`Subject`, amount: e.`Count`, company: node { name: "acme" } })',
      ),
    ).toEqual([]);
  });

  it('extra entries are fine — the callee cannot see them', () => {
    expect(
      codes(
        '  takes_deal(d: node { title: "x", amount: 3, spare: "unused", company: node { name: "acme" } })',
      ),
    ).toEqual([]);
  });

  it('a missing declared field is refused, and named', () => {
    expect(codes('  takes_deal(d: node { title: "x", company: node { name: "acme" } })')).toContain(
      C.NODE_ARG_SHAPE,
    );
    expect(
      messages('  takes_deal(d: node { title: "x", company: node { name: "acme" } })'),
    ).toMatch(/no `amount`/);
  });

  it('a declared field of the wrong TYPE is refused, and named', () => {
    expect(
      codes('  takes_deal(d: node { title: "x", amount: "not a number", company: node { name: "y" } })'),
    ).toContain(C.NODE_ARG_SHAPE);
    expect(
      messages('  takes_deal(d: node { title: "x", amount: "not a number", company: node { name: "y" } })'),
    ).toMatch(/`amount` is text, not number/);
  });

  it('a missing declared edge conforms — edges are zero-or-more, absence is the empty set', () => {
    expect(codes('  takes_deal(d: node { title: "x", amount: 3 })')).toEqual([]);
  });

  it('a nested landing missing the edge target’s field is refused', () => {
    expect(
      codes('  takes_deal(d: node { title: "x", amount: 3, company: node { other: "y" } })'),
    ).toContain(C.NODE_ARG_SHAPE);
  });

  it('a backtick-quoted declaration types a parameter a conforming literal satisfies', () => {
    // `Multi Words` / `Nested Edge` carry spaces; the backtick is the same
    // mechanism a field or edge name already wears, so a literal built with
    // matching backtick names conforms exactly like a bare declaration would.
    expect(
      codes(
        '  takes_multi(d: node { title: "x", `Nested Edge`: node { label: "y" } })',
      ),
    ).toEqual([]);
  });

  it('a missing field is still refused by name through the backtick-named declaration', () => {
    expect(
      codes('  takes_multi(d: node { `Nested Edge`: node { label: "y" } })'),
    ).toContain(C.NODE_ARG_SHAPE);
    expect(
      messages('  takes_multi(d: node { `Nested Edge`: node { label: "y" } })'),
    ).toMatch(/no `title`/);
  });

  it('an INSTANCE-typed parameter is satisfied structurally too', () => {
    expect(
      codes('  takes_company(c: node { name: "acme", size: 4, owner: node { email: "a@b.c" } })'),
    ).toEqual([]);
    // The `owner` edge is absent but every declared FIELD is there — an
    // absent edge is the empty set, not a missing member, so this conforms.
    expect(codes('  takes_company(c: node { name: "acme", size: 4 })')).toEqual([]);
    // A missing FIELD still refuses.
    expect(codes('  takes_company(c: node { name: "acme" })')).toContain(C.NODE_ARG_SHAPE);
  });
});

describe('real-instance arguments still check NOMINALLY', () => {
  it('the event position passed to a matching parameter is clean', () => {
    const source = `${PRELUDE}
movement takes_message(msg: <inbox-[:message]->>) {
}
movement m(e: <inbox-[:message]->>) {
  takes_message(msg: e)
}`;
    expect(
      checkProgram(parseProgram(source), catalog).filter((d) => (d.severity ?? 'error') === 'error'),
    ).toEqual([]);
  });

  it('a position from the WRONG graph is still MOV_CALL_ARG_TYPE, not the structural code', () => {
    const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
  takes_company(c: e)
}`;
    const found = checkProgram(parseProgram(source), catalog)
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => d.code);
    expect(found).toContain(C.CALL_ARG_TYPE);
    expect(found).not.toContain(C.NODE_ARG_SHAPE);
  });

  // The retirement (wave 4). A write to a declaration was the old composition
  // vehicle; it is refused where a program is CHECKED, and the refusal spells
  // out the literal that replaces it — including the entries already written,
  // so the correction is the program the author meant.
  it('the declaration-WRITE construct is refused, and the message writes out the replacement', () => {
    const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
  lead = write Deal-[:item]-> { title: e.\`Subject\`, amount: e.\`Count\` }
  takes_deal(d: lead)
}`;
    const found = checkProgram(parseProgram(source), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(found.map((d) => d.code)).toEqual([C.WRITE_SHAPE_RETIRED]);
    expect(found[0].message).toContain('node { title: …, amount: … }');
    expect(found[0].message).toContain("'Deal' is a declared node");
  });

  it('the refusal fires on the inline-argument form too', () => {
    const source = `${PRELUDE}
movement m(e: <inbox-[:message]->>) {
  takes_deal(d: write Deal-[:item]-> { title: e.\`Subject\`, amount: e.\`Count\` })
}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toEqual([C.WRITE_SHAPE_RETIRED]);
  });

  // The annotation survives the construct: `node Deal { … }` is still what a
  // parameter names, and a synthesised argument is still checked against it.
  it('the DECLARATION still types a parameter a node literal satisfies', () => {
    expect(codes('  takes_deal(d: node { title: "x", amount: 1, company: node { name: "acme" } })'))
      .toEqual([]);
  });
});

describe('absence flows through an entry', () => {
  // Nothing special happens here, and that IS the finding: an entry is typed by
  // ordinary expression typing, so a maybe-absent expression makes a
  // maybe-absent FIELD and the absence is policed where the value is USED.
  it('a maybe-absent entry stays maybe-absent through the node', () => {
    expect(codes('  d = node { when: e.`Snoozed` }\n  x = d.when > 3')).toContain(
      'MOV_ABSENT_REQUIRED',
    );
  });

  it('the same entry read straight off the source is refused identically', () => {
    expect(codes('  x = e.`Snoozed` > 3')).toContain('MOV_ABSENT_REQUIRED');
  });

  it('discharging the absence at the entry clears the use site', () => {
    expect(codes('  d = node { when: COALESCE(e.`Snoozed`, 0) }\n  x = d.when > 3')).toEqual([]);
  });

  it('a present entry is not made absent by the synthesis', () => {
    expect(codes('  d = node { when: e.`Count` }\n  x = d.when > 3')).toEqual([]);
  });
});

describe('pass-through edges — a traversal-sourced entry (wave 2)', () => {
  it('the edge lands the SOURCE positions, under their own field names', () => {
    expect(
      codes('  d = node { title: "x", files: e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`Name`\n  }'),
    ).toEqual([]);
  });

  it('a name the source does not carry is refused — nothing was renamed', () => {
    expect(
      codes('  d = node { files: e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`blob`\n  }'),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('the landing keeps its own EDGES too — the walk continues through it', () => {
    expect(
      codes(
        '  d = node { files: e-[a:Attachments]-> }\n' +
          '  d-[f:files]-> {\n    f-[v:Versions]-> {\n      y = v.`Label`\n    }\n  }',
      ),
    ).toEqual([]);
  });

  it('`lazy` types identically — laziness is evaluation time, not type', () => {
    const eager = '  d = node { title: "x", files: e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`Name`\n  }';
    const lazy = '  d = node { title: "x", files: lazy e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`Name`\n  }';
    expect(codes(lazy)).toEqual(codes(eager));
    expect(codes(lazy)).toEqual([]);
  });

  it('a bad read through the edge is bad in BOTH forms, identically', () => {
    const eager = '  d = node { files: e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`nope`\n  }';
    const lazy = '  d = node { files: lazy e-[a:Attachments]-> }\n  d-[f:files]-> {\n    y = f.`nope`\n  }';
    expect(codes(lazy)).toEqual(codes(eager));
    expect(codes(lazy)).toContain(C.UNKNOWN_PROPERTY);
  });

  it('a WHERE on the entry hop is typed exactly as a block head\'s is', () => {
    const inEntry = codes('  d = node { files: lazy e-[a:Attachments WHERE a.`nope` == "x"]-> }');
    const inHead = codes('  e-[a:Attachments WHERE a.`nope` == "x"]-> {\n  }');
    expect(inEntry).toEqual(inHead);
  });
});

describe('a pass-through edge at the call site', () => {
  it('fits a parameter whose landing declares the SOURCE names', () => {
    expect(codes('  takes_doc(d: node { title: "x", files: lazy e-[a:Attachments]-> })')).toEqual([]);
  });

  it('a parameter expecting RENAMED landings is refused, and names the missing one', () => {
    expect(
      codes('  takes_renamed(d: node { title: "x", files: lazy e-[a:Attachments]-> })'),
    ).toContain(C.NODE_ARG_SHAPE);
    expect(
      messages('  takes_renamed(d: node { title: "x", files: lazy e-[a:Attachments]-> })'),
    ).toMatch(/no files → `blob`/);
  });

  it('the eager form is checked the same way', () => {
    expect(codes('  takes_doc(d: node { title: "x", files: e-[a:Attachments]-> })')).toEqual([]);
    expect(codes('  takes_renamed(d: node { title: "x", files: e-[a:Attachments]-> })')).toContain(
      C.NODE_ARG_SHAPE,
    );
  });
});

// ── Wave 3 — per-item synthesis (`-> node { … }`) ───────────────────────────

describe('the per-item tail is typed in the LANDING’s scope', () => {
  const MAPPED = '  d = node { files: lazy e-[a:Attachments]-> node { blob: a.`File` } }';

  it('the hop’s alias names the landing, and its fields read there', () => {
    expect(codes(`${MAPPED}\n  d-[f:files]-> {\n    y = f.blob\n  }`)).toEqual([]);
  });

  it('a name the LANDING does not carry is the ordinary unknown-property error', () => {
    expect(
      codes('  d = node { files: lazy e-[a:Attachments]-> node { blob: a.`nope` } }'),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('the SOURCE names are gone through the edge — the mapping is what it exposes', () => {
    expect(codes(`${MAPPED}\n  d-[f:files]-> {\n    y = f.\`Name\`\n  }`)).toContain(
      C.UNKNOWN_PROPERTY,
    );
  });

  it('the alias is out of scope OUTSIDE the tail', () => {
    const outside = codes(`${MAPPED}\n  y = a.\`Name\``);
    expect(outside).not.toEqual([]);
    expect(messages(`${MAPPED}\n  y = a.\`Name\``)).toMatch(/'a'/);
  });

  it('the eager form types identically — the tail is about renaming, not timing', () => {
    const eager = '  d = node { files: e-[a:Attachments]-> node { blob: a.`File` } }\n  d-[f:files]-> {\n    y = f.blob\n  }';
    expect(codes(eager)).toEqual(codes(`${MAPPED}\n  d-[f:files]-> {\n    y = f.blob\n  }`));
    expect(codes(eager)).toEqual([]);
  });

  it('tails nest — a mapped landing may map its own hop in turn', () => {
    expect(
      codes(
        '  d = node { files: e-[a:Attachments]-> node { blob: a.`File`, versions: a-[v:Versions]-> node { label: v.`Label` } } }\n' +
          '  d-[f:files]-> {\n    f-[w:versions]-> {\n      y = w.label\n    }\n  }',
      ),
    ).toEqual([]);
  });

  it('absence flows through the landing scope, exactly as it does anywhere', () => {
    expect(
      codes(
        '  d = node { files: e-[a:Attachments]-> node { pages: a.`Pages` } }\n' +
          '  d-[f:files]-> {\n    y = f.pages > 3\n  }',
      ),
    ).toContain('MOV_ABSENT_REQUIRED');
  });

  it('discharging it at the entry clears the use site', () => {
    expect(
      codes(
        '  d = node { files: e-[a:Attachments]-> node { pages: COALESCE(a.`Pages`, 0) } }\n' +
          '  d-[f:files]-> {\n    y = f.pages > 3\n  }',
      ),
    ).toEqual([]);
  });

  it('a `lazy` BINDING takes the tail too, and binds the mapped landings', () => {
    expect(
      codes('  f = lazy e-[a:Attachments]-> node { blob: a.`File` }\n  y = f.blob'),
    ).toEqual([]);
  });
});

describe('a per-item edge at the call site — the refusal flips', () => {
  it('a parameter declaring RENAMED landings ACCEPTS the mapped edge', () => {
    expect(
      codes(
        '  takes_renamed(d: node { title: "x", files: lazy e-[a:Attachments]-> node { blob: a.`File` } })',
      ),
    ).toEqual([]);
  });

  it('and the eager form fits it identically', () => {
    expect(
      codes(
        '  takes_renamed(d: node { title: "x", files: e-[a:Attachments]-> node { blob: a.`File` } })',
      ),
    ).toEqual([]);
  });

  it('the PASS-THROUGH refusal is untouched — unmapped landings still miss `blob`', () => {
    expect(
      codes('  takes_renamed(d: node { title: "x", files: lazy e-[a:Attachments]-> })'),
    ).toContain(C.NODE_ARG_SHAPE);
  });

  it('a mapping that renames AWAY what the parameter wants is refused, and named', () => {
    // Renaming cuts both ways: the source's own names no longer reach a callee
    // written against them.
    expect(
      codes(
        '  takes_doc(d: node { title: "x", files: lazy e-[a:Attachments]-> node { blob: a.`File` } })',
      ),
    ).toContain(C.NODE_ARG_SHAPE);
    expect(
      messages(
        '  takes_doc(d: node { title: "x", files: lazy e-[a:Attachments]-> node { blob: a.`File` } })',
      ),
    ).toMatch(/no files → `Name`/);
  });

  it('a mapped entry of the wrong TYPE is refused where a renaming alone is not', () => {
    expect(
      codes(
        '  takes_renamed(d: node { title: "x", files: lazy e-[a:Attachments]-> node { blob: a.`Name` } })',
      ),
    ).toContain(C.NODE_ARG_SHAPE);
  });
});

describe('`lazy` on an ordinary binding', () => {
  it('binds the landed position, exactly as the walk would', () => {
    expect(codes('  f = lazy e-[a:Attachments]->\n  y = f.`Name`')).toEqual([]);
  });

  it('an unknown read off it is the ordinary unknown-property error', () => {
    expect(codes('  f = lazy e-[a:Attachments]->\n  y = f.`nope`')).toContain(C.UNKNOWN_PROPERTY);
  });

  it('a block head off it walks on into the source graph', () => {
    expect(
      codes('  f = lazy e-[a:Attachments]->\n  f-[v:Versions]-> {\n    y = v.`Label`\n  }'),
    ).toEqual([]);
  });

  it('reads the same as the eager block-head alias does', () => {
    expect(codes('  f = lazy e-[a:Attachments]->\n  y = f.`nope`')).toEqual(
      codes('  e-[a:Attachments]-> {\n    y = a.`nope`\n  }'),
    );
  });

  it('FIRST over a lazy walk carries the same absence the eager walk carries', () => {
    const eager = '  v = ONLY(e-[a:Attachments]->-[b:Versions]->)\n  y = v.`Label` == "a"';
    const lazy =
      '  f = lazy e-[a:Attachments]->\n  v = ONLY(f-[b:Versions]->)\n  y = v.`Label` == "a"';
    expect(codes(lazy)).toEqual(codes(eager));
  });

  it('and the absence it carries is REAL — discharging it clears both', () => {
    const eager = '  v = ONLY(e-[a:Attachments]->-[b:Versions]->)\n  if v == null {\n  } else {\n    y = v.`Label` == "a"\n  }';
    const lazy =
      '  f = lazy e-[a:Attachments]->\n  v = ONLY(f-[b:Versions]->)\n  if v == null {\n  } else {\n    y = v.`Label` == "a"\n  }';
    expect(codes(eager)).toEqual([]);
    expect(codes(lazy)).toEqual([]);
  });
});
