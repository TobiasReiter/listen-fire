// What the editor gained when the language service stopped keeping its own
// binding-typing walker and started querying the checker's recorded scopes.
//
// Every case here was silently broken before: the shadow walker opened no
// frame for a race branch, a callback body or an inline block (so nothing
// bound inside them existed for completions), knew no `await` binding shape,
// never applied IS narrowing, never selected a discriminated write's variant,
// and gave every `if` arm the STATEMENT's span — so a cursor in the first arm
// resolved against the LAST arm's frame.

import type { CatalogSnapshot } from '../snapshot';
import type { SchemaFieldType, InstanceSchema } from '../../checker/catalog';
import { getHoverInfo, getMovementCompletions } from '../service';

const queue: SchemaFieldType = { kind: 'enum', options: ['Billing', 'General'] };

const OPS: InstanceSchema = {
  positions: {
    ticket: {
      properties: { subject: 'text', requester: 'text' },
      edges: { Reply: { target: 'reply', awaitable: true, watchable: true }, Owner: { target: 'agent' } },
    },
    agent: { properties: { fullName: 'text', rota: 'text' }, edges: {} },
    reply: { properties: { body: 'text', channel: 'text' }, edges: {} },
    note: { properties: { body: 'text', code: 'number' }, edges: {} },
  },
  collections: { tickets: { target: 'ticket' }, agents: { target: 'agent' }, notes: { target: 'note' } },
  unions: { party: ['ticket', 'agent'] },
  writableRoots: {
    note: {
      fields: { body: 'text', code: 'number' },
      resultShape: { externalId: 'text' },
    },
    // A discriminated create: `queue` selects the rest of the shape, so the
    // field list inside the body depends on the literal already authored.
    ticket: {
      fields: { queue },
      requiredFields: ['queue'],
      resultShape: { externalId: 'text' },
      discriminated: {
        discriminant: 'queue',
        variants: {
          Billing: {
            fields: { queue, refundAmount: 'number' },
            requiredFields: ['queue'],
            resultShape: { externalId: 'text' },
          },
          General: {
            fields: { queue, escalationNote: 'text' },
            requiredFields: ['queue'],
            resultShape: { externalId: 'text' },
          },
        },
      },
    },
  },
};

const snapshot: CatalogSnapshot = {
  adapters: {
    helpdesk: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      canFire: true,
      schemas: { ops_main: OPS },
    },
  },
  credentials: { ops_main: { adapter: 'helpdesk' } },
  plugins: {},
};

const HEADER = `import { helpdesk } from adapters
import { ops_main } from credentials

ops = helpdesk(credentials: ops_main)
`;

function caret(text: string): { source: string; offset: number } {
  const offset = text.indexOf('¦');
  if (offset === -1) throw new Error('no caret in fixture');
  return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

function labelsAt(text: string): string[] {
  const { source, offset } = caret(text);
  return getMovementCompletions(source, offset, snapshot).items.map(i => i.label);
}

/** Hover on the LAST occurrence of `token` (a use site, never the binder). */
function hoverAtUse(source: string, token: string): string {
  const at = source.lastIndexOf(token);
  if (at === -1) throw new Error(`no '${token}' in fixture`);
  return getHoverInfo(source, at + 1, snapshot)?.contents.join('\n') ?? '';
}

describe('race arms are scopes the editor can stand inside', () => {
  const source = `${HEADER}
movement triage(t: <ops-[:ticket]->>) {
  outcome = await race([
    () => {
      answer = await FIRST(t-[:Reply]->)
      write ops-[:notes]-> { body: answer.body }
      ¦
    },
    () => {
      late = await sleep(2d)
    },
  ])
}
`;

  it('offers a name bound earlier in the same arm', () => {
    expect(labelsAt(source)).toEqual(expect.arrayContaining(['answer', 't']));
  });

  it('does NOT offer the sibling arm\'s binding', () => {
    expect(labelsAt(source)).not.toContain('late');
  });

  it('types the awaited binding as the landed position', () => {
    expect(hoverAtUse(caret(source).source, 'answer')).toContain('ops.reply');
  });

  it('reads fields off the awaited binding', () => {
    expect(
      labelsAt(source.replace('    ¦\n', '    x = answer.¦\n')),
    ).toEqual(expect.arrayContaining(['body', 'channel']));
  });
});

describe('callback bodies are scopes with their fire-time parameters', () => {
  const source = `${HEADER}
movement notify(t: <ops-[:ticket]->>) {
  cb = callback((amount: <number>) => {
    logged = write ops-[:notes]-> { body: t.\`subject\`, code: amount }
    ¦
  })
}
`;

  it('offers a name bound in the body and the captured enclosing name', () => {
    expect(labelsAt(source)).toEqual(expect.arrayContaining(['logged', 't']));
  });

  it('types the fire-time parameter by its declared scalar type', () => {
    expect(hoverAtUse(caret(source).source, 'amount')).toContain('number');
  });

  it('the callback body\'s binding does not leak to the enclosing movement', () => {
    const after = source.replace('    ¦\n', '').replace('  })\n', '  })\n  ¦\n');
    expect(labelsAt(after)).not.toContain('logged');
  });
});

describe('closure bodies are scopes', () => {
  const source = `${HEADER}
movement check(t: <ops-[:ticket]->>) {
  done = () => {
    latest = await FIRST(t-[:Reply]->)
    ¦
    return latest.\`body\` == "yes"
  }
}
`;

  it('offers names bound inside the closure, and the captured enclosing name', () => {
    expect(labelsAt(source)).toEqual(expect.arrayContaining(['latest', 't']));
  });

  it('types a binding made inside the closure', () => {
    expect(hoverAtUse(caret(source).source, 'latest')).toContain('ops.reply');
  });

  it('the closure binding does not leak to the enclosing body', () => {
    const after = source.replace('    ¦\n', '').replace('  }\n}\n', '  }\n  ¦\n}\n');
    expect(labelsAt(after)).not.toContain('latest');
  });
});

describe('IS narrowing reaches the editor inside the arm', () => {
  const source = `${HEADER}
movement route(p: <ops-[:party]->>) {
  if p IS <ops-[:ticket]->> {
    write ops-[:notes]-> { body: p.\`subject\` }
  } else {
    write ops-[:notes]-> { body: p.\`rota\` }
  }
}
`;

  it('hovers the narrowed variant inside the arm', () => {
    const at = source.indexOf('p.`subject`');
    expect(getHoverInfo(source, at, snapshot)?.contents.join('\n')).toContain('ops.ticket');
  });

  // The else eliminates what the arm above tested, so a two-member union
  // leaves exactly one member — and the editor gets that for free, because
  // hover reads the scopes the checker records rather than walking its own.
  it('the else arm hovers the REMAINING variant, not the whole union', () => {
    const at = source.indexOf('p.`rota`');
    const contents = getHoverInfo(source, at, snapshot)?.contents.join('\n');
    expect(contents).toContain('ops.agent');
    expect(contents).not.toContain('ops.party');
  });

  it("property completions in the else arm are the remaining variant's", () => {
    const inElse = source.replace('body: p.`rota`', 'body: p.¦');
    const items = labelsAt(inElse);
    expect(items).toContain('rota');
    expect(items).not.toContain('subject');
  });

  it('property completions inside the arm are the narrowed variant\'s', () => {
    const narrowed = source.replace('body: p.`subject`', 'body: p.¦');
    const items = labelsAt(narrowed);
    expect(items).toContain('subject');
    expect(items).not.toContain('rota');
  });
});

describe('a discriminated write body completes the SELECTED variant', () => {
  const body = (literal: string) => `${HEADER}
movement open(a: <ops-[:agent]->>) {
  write ops-[:tickets]-> {
    queue: "${literal}"
    ¦
  }
}
`;

  it('offers the Billing variant\'s field when the discriminant says Billing', () => {
    const items = labelsAt(body('Billing'));
    expect(items).toContain('refundAmount');
    expect(items).not.toContain('escalationNote');
  });

  it('offers the General variant\'s field when the discriminant says General', () => {
    const items = labelsAt(body('General'));
    expect(items).toContain('escalationNote');
    expect(items).not.toContain('refundAmount');
  });
});

describe('each if arm has its OWN extent', () => {
  // Every arm used to carry the whole statement's span, so the innermost
  // frame at any cursor inside the `if` was whichever arm was recorded LAST
  // — the else. A cursor in the first arm saw the else's bindings.
  const source = `${HEADER}
movement branchy(t: <ops-[:ticket]->>) {
  if t.\`subject\` == "a" {
    first = await FIRST(t-[:Reply]->)
    ¦
  } else {
    second = await FIRST(t-[:Reply]->)
  }
}
`;

  it('the first arm resolves the first arm\'s bindings', () => {
    expect(labelsAt(source)).toContain('first');
  });

  it('the first arm does not resolve the else arm\'s bindings', () => {
    expect(labelsAt(source)).not.toContain('second');
  });

  it('the else arm resolves its own, not the first arm\'s', () => {
    const inElse = source
      .replace('    ¦\n', '')
      .replace('    second = await FIRST(t-[:Reply]->)\n', '    second = await FIRST(t-[:Reply]->)\n    ¦\n');
    const items = labelsAt(inElse);
    expect(items).toContain('second');
    expect(items).not.toContain('first');
  });
});
