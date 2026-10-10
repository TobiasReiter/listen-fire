// Checker coverage for CALL VALUES — a call's value is what the callee
// RETURNS, and nothing else.
//
// Naming is not exporting: a callee's bindings stay inside it. What is worth
// pinning is (a) that a callee with no `return` has nothing to bind, (b) that
// multi-export is an ordinary `node { … }` the callee returns, so the value
// reaches a parameter by the same STRUCTURAL road any literal does — which is
// what makes the utility idiom compose — and (c) that absence rides across the
// boundary unchanged.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { InstanceSchema, mockCatalog } from '../catalog';

const inboxSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        Subject: 'text',
        Count: 'number',
        Snoozed: { kind: 'maybeAbsent', of: 'number' },
      },
      edges: { Attachments: { target: 'attachment', readable: true } },
    },
    attachment: {
      properties: { Name: 'text', File: 'file' },
      edges: {},
    },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {},
};

const catalog = mockCatalog({
  adapters: { email: { constructionArgs: [], schema: inboxSchema } },
});

const PRELUDE = `import { email } from adapters
inbox = email()

node Doc {
  title: <text>
  node files {
    name: <text>
    blob: <file>
  }
}

movement email_to_doc(m: <inbox-[:message]->>) {
  return node {
    title: m.\`Subject\`
    files: lazy m-[a:Attachments]-> node { name: a.\`Name\`, blob: a.\`File\` }
  }
}

movement takes_doc(d: <Doc>) {
}

movement counts(m: <inbox-[:message]->>) {
  return node { n: m.\`Count\` }
}

movement title_only(m: <inbox-[:message]->>) {
  return node { title: m.\`Subject\` }
}

movement maybe(m: <inbox-[:message]->>) {
  return node { s: m.\`Snoozed\` }
}

movement effects_only(m: <inbox-[:message]->>) {
  t = m.\`Subject\`
}
`;

function check(body: string): Diagnostic[] {
  const source = `${PRELUDE}
movement main(e: <inbox-[:message]->>) {
${body}
}`;
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => (d.severity ?? 'error') === 'error',
  );
}
const codes = (body: string): string[] => check(body).map((d) => d.code);
const messages = (body: string): string => check(body).map((d) => d.message).join('\n');

describe('a call has a value', () => {
  it('it can be BOUND — the form that used to be "not an adapter type"', () => {
    expect(codes('  doc = email_to_doc(m: e)')).toEqual([]);
  });

  it('an UNBOUND call is still legal — using the value is optional', () => {
    expect(codes('  email_to_doc(m: e)')).toEqual([]);
  });

  it('a SCALAR binding of the callee reads by DOT off the value', () => {
    expect(codes('  doc = email_to_doc(m: e)\n  t = doc.title')).toEqual([]);
  });

  it('a POSITION binding of the callee traverses by ARROW off the value', () => {
    expect(
      codes('  doc = email_to_doc(m: e)\n  doc-[f:files]-> {\n    n = f.name\n  }'),
    ).toEqual([]);
  });

  it('a name the callee never returned is not there', () => {
    expect(codes('  doc = email_to_doc(m: e)\n  x = doc.nope')).toContain(C.UNKNOWN_PROPERTY);
  });

  it('a callee that returns nothing cannot be bound, and the refusal says why', () => {
    expect(codes('  x = effects_only(m: e)')).toContain(C.CALL_RETURNS_NOTHING);
    expect(messages('  x = effects_only(m: e)')).toContain('returns nothing');
  });

  it('…but calling it as a statement is fine — the value was never the point', () => {
    expect(codes('  effects_only(m: e)')).toEqual([]);
  });

  it('a callee may return a plain VALUE, which binds on the dot plane', () => {
    const source = `import { email } from adapters
inbox = email()
movement subject(m: <inbox-[:message]->>) {
  return m.\`Subject\`
}
movement main(e: <inbox-[:message]->>) {
  s = subject(m: e)
  bad = s > 3
}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain(C.COMPARE_TYPE_MISMATCH);
  });

  it('a returned field keeps its TYPE — a number stays a number', () => {
    expect(codes('  c = counts(m: e)\n  bad = c.n > "text"')).toContain(
      C.COMPARE_TYPE_MISMATCH,
    );
  });

  it('a construction is still a construction — resolution decides, not the spelling', () => {
    // Same surface form, two meanings, and only the callee says which. The
    // construction keeps constructing (its collection still traverses)…
    expect(codes('  inbox-[x:messages]-> {\n    s = x.`Subject`\n  }')).toEqual([]);
    // …and the movement no longer wears the construction's refusal.
    expect(codes('  doc = email_to_doc(m: e)')).not.toContain(C.CONSTRUCT_NOT_ADAPTER);
  });

  it('a call-bound name is NOT an instance — it cannot be listened to', () => {
    // Load-bearing: a bound call and a construction share one spelling, and
    // provisioning reads construction-shaped bindings to derive triggers. What
    // keeps a call out of that path is this refusal — it used to be
    // CONSTRUCT_NOT_ADAPTER, and it must not simply have gone away.
    const source = `import { email } from adapters
inbox = email()
movement shape(m: <inbox-[:message]->>) {
  return node { t: m.\`Subject\` }
}
doc = shape(m: inbox)
listen to doc { key: "a" } fire shape`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain(C.LISTEN_NOT_INSTANCE);
  });

  it('constructing a NON-adapter that is also not a movement still says so', () => {
    const source = `import { email } from adapters
node Doc { title: <text> }
movement main(e: <email-[:message]->>) {
  x = Doc(a: "b")
}`;
    expect(
      checkProgram(parseProgram(source), catalog).map((d) => d.code),
    ).toContain(C.CONSTRUCT_NOT_ADAPTER);
  });
});

describe('only the RETURN escapes — a callee\'s bindings stay inside it', () => {
  it("the callee's parameter name is not on its value", () => {
    // `email_to_doc`'s parameter is `m`; what it returns carries `title` and
    // `files` and nothing else.
    expect(codes('  doc = email_to_doc(m: e)\n  x = doc.m')).toContain(C.UNKNOWN_PROPERTY);
  });

  it('nor is it traversable as an edge', () => {
    expect(codes('  doc = email_to_doc(m: e)\n  doc-[x:m]-> {\n  }')).toContain(
      C.TRAVERSE_UNKNOWN_EDGE,
    );
    expect(messages('  doc = email_to_doc(m: e)\n  doc-[x:m]-> {\n  }')).toContain('files');
  });

  it('a binding the callee made but did not return is not on the value', () => {
    const source = `import { email } from adapters
inbox = email()
movement makes(m: <inbox-[:message]->>) {
  kept = m.\`Subject\`
  return node { title: m.\`Subject\` }
}
movement caller(e: <inbox-[:message]->>) {
  r = makes(m: e)
  x = r.kept
}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain(C.UNKNOWN_PROPERTY);
  });

  it('a constructed INSTANCE is not a value at all — returning one is refused', () => {
    const source = `import { email } from adapters
inbox = email()
movement makes(m: <inbox-[:message]->>) {
  return email()
}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toContain(C.RETURN_NOT_A_VALUE);
  });
});

describe('the value fits a parameter STRUCTURALLY — the utility idiom', () => {
  it('a call bound, then passed on, checks end to end', () => {
    expect(codes('  doc = email_to_doc(m: e)\n  takes_doc(d: doc)')).toEqual([]);
  });

  it('a call passed on DIRECTLY checks end to end', () => {
    expect(codes('  takes_doc(d: email_to_doc(m: e))')).toEqual([]);
  });

  it('a value that misses what the parameter declares is refused, and named', () => {
    // `counts` binds only `n` — no `title`, no `files`. The missing FIELD
    // (`title`) is what refuses it.
    expect(codes('  takes_doc(d: counts(m: e))')).toContain(C.NODE_ARG_SHAPE);
    expect(messages('  takes_doc(d: counts(m: e))')).toContain('title');
  });

  it('a value that misses only a declared EDGE conforms — edges are zero-or-more', () => {
    // `title_only` binds `title` but never `files` — an absent edge is the
    // empty set, not a missing member.
    expect(codes('  takes_doc(d: title_only(m: e))')).toEqual([]);
  });

  it("the diagnostic names the CALLEE whose value did not fit", () => {
    expect(messages('  bad = counts(m: e)\n  takes_doc(d: bad)')).toContain("'takes_doc' expects");
  });

  it('a nested call is CHECKED in its own right — a bad argument is reported', () => {
    expect(codes('  takes_doc(d: email_to_doc(nope: e))')).toContain(C.CALL_ARG_UNKNOWN);
  });
});

describe('absence rides across the boundary', () => {
  it('a maybe-absent binding exports as a maybe-absent field', () => {
    // `maybe` binds `s = m.`Snoozed``, which is `number | absent`. Reading it
    // off the call's value where a present value is REQUIRED must still fire.
    expect(codes('  r = maybe(m: e)\n  x = r.s > 3')).toContain(C.ABSENT_REQUIRED);
  });

  it('and it is REAL absence — discharging it clears the read', () => {
    expect(codes('  r = maybe(m: e)\n  x = COALESCE(r.s, 0) > 3')).toEqual([]);
  });

  it('a PRESENT binding of the callee carries no absence', () => {
    expect(codes('  c = counts(m: e)\n  x = c.n > 3')).toEqual([]);
  });
});

describe("the value is an ordinary bound name — it composes with everything", () => {
  it('a call inside a block composes with the block\'s own return', () => {
    const source = `import { email } from adapters
inbox = email()
movement shape(a: <inbox-[:attachment]->>) {
  return node { label: a.\`Name\` }
}
movement main(e: <inbox-[:message]->>) {
  blk = e-[a:Attachments]-> {
    r = shape(a: a)
    return r
  }
  x = blk.label
}`;
    expect(
      checkProgram(parseProgram(source), catalog)
        .filter((d) => (d.severity ?? 'error') === 'error')
        .map((d) => d.code),
    ).toEqual([]);
  });

  it('it passes straight through another call as a bare name', () => {
    expect(codes('  doc = email_to_doc(m: e)\n  takes_doc(d: doc)\n  takes_doc(d: doc)')).toEqual(
      [],
    );
  });
});

describe('the callee is typed once, wherever it sits', () => {
  it('a call ABOVE the declaration types the same as one below it', () => {
    // The caller is declared FIRST, so its call cannot wait for the callee's
    // own check to have happened — the value type is derived on demand.
    const bound = `import { email } from adapters
inbox = email()
movement caller(e: <inbox-[:message]->>) {
  r = later(m: e)
  x = r.ok
  y = r.nope
}
movement later(m: <inbox-[:message]->>) {
  return node { ok: m.\`Subject\` }
}`;
    const found = checkProgram(parseProgram(bound), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    // `r.ok` resolved; only `r.nope` — the name the callee never bound — failed.
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
    expect(found[0].message).toContain('nope');
  });

  it("typing a callee reports NOTHING extra — the body is diagnosed once, where it is written", () => {
    const source = `import { email } from adapters
inbox = email()
movement bad(m: <inbox-[:message]->>) {
  return node { x: m.\`NoSuchField\` }
}
movement one(e: <inbox-[:message]->>) {
  a = bad(m: e)
}
movement two(e: <inbox-[:message]->>) {
  b = bad(m: e)
}`;
    const found = checkProgram(parseProgram(source), catalog).filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(found.map((d) => d.code)).toEqual([C.UNKNOWN_PROPERTY]);
  });
});
