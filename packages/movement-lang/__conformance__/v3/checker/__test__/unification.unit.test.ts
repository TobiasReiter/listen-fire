// The three surfaces of the one-function-sort wave (core calculus v2, wave 5).
//
//   - a PLUGIN is a function whose body isn't visible, so its DECLARED row is
//     what makes calling it ordinary — and not declaring one keeps it to the
//     `through [ … ]` stage it is legal in today;
//   - an `await` states no cadence only where the source PUSHES, and where it
//     doesn't the refusal names the form that does;
//   - a bracket predicate the source can't run is a NOTE about the fetch, not
//     a refusal — unless nothing at all narrows, which is boundedness.

import { parseProgram } from '../../parser/parse';
import { checkProgram, Diagnostic, DiagnosticCodes as C } from '../check';
import { CollectionSchema, InstanceSchema, mockCatalog } from '../catalog';
import { TypedDiagnosticCodes as T } from '../typing';
import { storyOf } from '../../story/story';

const PUSHED: InstanceSchema = {
  positions: {
    ticket: {
      properties: { Title: 'text' },
      // Resolves AND announces — the ask/Slack shape.
      edges: { Reply: { target: 'reply', readable: true, awaitable: true, watchable: true } },
    },
    reply: { properties: { Text: 'text' }, edges: {} },
  },
  collections: { tickets: { target: 'ticket' } },
  writableRoots: {},
};

const POLLED: InstanceSchema = {
  positions: {
    order: {
      properties: { Ref: 'text' },
      // Resolves, and nobody is told — the shape that has to be looked at.
      edges: { Shipment: { target: 'shipment', readable: true, awaitable: true } },
    },
    shipment: { properties: { Code: 'text' }, edges: {} },
  },
  collections: { orders: { target: 'order' } },
  writableRoots: {},
};

function diagnose(source: string, schema: InstanceSchema, plugins = {}): Diagnostic[] {
  const catalog = mockCatalog({
    adapters: { desk: { constructionArgs: [], schema } },
    plugins,
  });
  // These fixtures are about one construct each; none declares a trigger, and
  // "nothing fires this file" is not what any of them is pinning.
  return checkProgram(parseProgram(source), catalog).filter(
    (d) => d.code !== C.LISTEN_MISSING,
  );
}

const codes = (source: string, schema: InstanceSchema, plugins = {}): string[] =>
  diagnose(source, schema, plugins).map((d) => d.code);

const errors = (source: string, schema: InstanceSchema, plugins = {}): string[] =>
  diagnose(source, schema, plugins)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);

const messages = (source: string, schema: InstanceSchema, plugins = {}): string =>
  diagnose(source, schema, plugins)
    .map((d) => d.message)
    .join('\n');

// ── Plugins are functions ────────────────────────────────────────────────────

const PLUGIN_PROGRAM = (call: string): string => `import { desk } from adapters
import { scan_web } from plugins

svc = desk()

movement look(t: <svc-[:ticket]->>) {
${call}
}`;

/** A plugin that has said everything a plain call needs: what running it does,
 *  and what it hands back. The fixtures below vary one of those at a time. */
const FOUND_TEXT = {
  args: ['url'],
  effects: { reads: ['the web'], ai: true },
  output: { kind: 'value' as const, type: { kind: 'maybeAbsent' as const, of: 'text' as const } },
};

describe('a plugin is a function whose row is declared', () => {
  it('a declared row makes an ordinary call legal', () => {
    const source = PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)');
    const plugins = { scan_web: FOUND_TEXT };
    expect(errors(source, PUSHED, plugins)).toEqual([]);
  });

  it('the declared row FOLDS — the picture says the movement reads the web', () => {
    const plugins = { scan_web: FOUND_TEXT };
    const result = storyOf({
      source: PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)'),
      catalog: mockCatalog({
        adapters: { desk: { constructionArgs: [], schema: PUSHED } },
        plugins,
      }),
    });
    expect(result.ok).toBe(true);
    const movement = result.ok
      ? result.story.flow.find((step) => step.kind === 'movement')
      : undefined;
    expect(movement?.kind === 'movement' ? movement.effects.reads : undefined).toContain('the web');
    expect(movement?.kind === 'movement' ? movement.effects.ai : undefined).toBe(true);
    // A declaration is a complete claim, so folding one leaves no lower bound.
    expect(movement?.kind === 'movement' ? movement.effects.partial : undefined).toBe(false);
  });

  it('NOT declaring one leaves the row a lower bound rather than a clean sheet', () => {
    const result = storyOf({
      source: PLUGIN_PROGRAM(`  m = extract from [t.\`Title\`] through [scan_web] {
    name: "the company"
  }`),
      catalog: mockCatalog({
        adapters: { desk: { constructionArgs: [], schema: PUSHED } },
        plugins: { scan_web: { args: ['url'] } },
      }),
    });
    const movement = result.ok
      ? result.story.flow.find((step) => step.kind === 'movement')
      : undefined;
    expect(movement?.kind === 'movement' ? movement.effects.partial : undefined).toBe(true);
  });

  it('an UNDECLARED row keeps the plugin to a through-stage, and says so', () => {
    const source = PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)');
    const plugins = { scan_web: { args: ['url'] } };
    expect(errors(source, PUSHED, plugins)).toEqual([C.PLUGIN_ROW_UNDECLARED]);
    expect(messages(source, PUSHED, plugins)).toContain("through [scan_web]");
  });

  it('the stage form stays legal whether or not a row was declared', () => {
    const stage = `  m = extract from [t.\`Title\`] through [scan_web] {
    name: "the company"
  }`;
    expect(errors(PLUGIN_PROGRAM(stage), PUSHED, { scan_web: { args: ['url'] } })).toEqual([]);
    expect(
      errors(PLUGIN_PROGRAM(stage), PUSHED, {
        scan_web: { args: ['url'], effects: { reads: ['the web'] } },
      }),
    ).toEqual([]);
  });

  it('an argument the plugin does not accept reads the same either way', () => {
    const plugins = { scan_web: { ...FOUND_TEXT, effects: { reads: ['the web'] } } };
    expect(errors(PLUGIN_PROGRAM('  scan_web(depth: 2)'), PUSHED, plugins)).toEqual([
      C.THROUGH_BAD_ARG,
    ]);
  });

  it('a required argument the ordinary call omits reads the same either way', () => {
    const plugins = {
      scan_web: { ...FOUND_TEXT, requiredArgs: ['url'], effects: { reads: ['the web'] } },
    };
    const errs = errors(PLUGIN_PROGRAM('  scan_web()'), PUSHED, plugins);
    expect(errs).toEqual([C.THROUGH_ARG_MISSING]);
    expect(messages(PLUGIN_PROGRAM('  scan_web()'), PUSHED, plugins)).toContain("'url'");
  });

  it('a plugin the EXTRACTION feeds stays a stage, and the refusal says why', () => {
    const source = PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)');
    const plugins = {
      scan_web: { ...FOUND_TEXT, effects: { reads: ['the web'] }, fedByExtraction: true },
    };
    expect(errors(source, PUSHED, plugins)).toEqual([C.PLUGIN_FED_BY_EXTRACTION]);
    expect(messages(source, PUSHED, plugins)).toContain('through [scan_web]');
    // …and the very same plugin is fine as the stage it is.
    const stage = `  m = extract from [t.\`Title\`] through [scan_web] {
    name: "the company"
  }`;
    expect(errors(PLUGIN_PROGRAM(stage), PUSHED, plugins)).toEqual([]);
  });
});

// ── What a plugin hands back ─────────────────────────────────────────────────

describe('a plugin declares what it hands back, so a plain call is typed', () => {
  it('a declared VALUE output is the bound name\u2019s type', () => {
    const source = PLUGIN_PROGRAM(`  page = scan_web(url: t.\`Title\`)
  head = COALESCE(page, "") > "a"`);
    expect(errors(source, PUSHED, { scan_web: FOUND_TEXT })).toEqual([]);
  });

  it('the declared absence is REAL — an unguarded read into a plain field is refused', () => {
    const source = PLUGIN_PROGRAM(`  page = scan_web(url: t.\`Title\`)
  head = page > "a"`);
    expect(errors(source, PUSHED, { scan_web: FOUND_TEXT })).toContain(T.ABSENT_REQUIRED);
  });

  it('a declared RECORD output is read by name, and an undeclared field is not', () => {
    const plugins = {
      scan_web: {
        args: ['name'],
        effects: { reads: ['the web'], ai: true },
        output: {
          kind: 'record' as const,
          fields: {
            summary: { kind: 'maybeAbsent' as const, of: 'text' as const },
            website: { kind: 'maybeAbsent' as const, of: 'text' as const },
          },
        },
      },
    };
    const good = PLUGIN_PROGRAM(`  more = scan_web(name: t.\`Title\`)
  head = COALESCE(more.website, more.summary, "") > "a"`);
    expect(errors(good, PUSHED, plugins)).toEqual([]);

    const bad = PLUGIN_PROGRAM(`  more = scan_web(name: t.\`Title\`)
  head = COALESCE(more.headcount, "") > "a"`);
    expect(errors(bad, PUSHED, plugins).length).toBeGreaterThan(0);
  });

  it('a declared RECORDS output is a list of records: read one, read across, and never as text', () => {
    const plugins = {
      scan_web: {
        args: ['url'],
        effects: { reads: ['the web'], ai: true },
        output: {
          kind: 'records' as const,
          fields: {
            url: 'text' as const,
            text: { kind: 'maybeAbsent' as const, of: 'text' as const },
            file: { kind: 'maybeAbsent' as const, of: 'file' as const },
          },
        },
      },
    };
    const good = PLUGIN_PROGRAM(`  pages = scan_web(url: t.\`Title\`)
  first = FIRST(pages)
  head = COALESCE(first.text, JOIN(pages.url, ", ")) > "a"`);
    expect(errors(good, PUSHED, plugins)).toEqual([]);

    const unknownField = PLUGIN_PROGRAM(`  pages = scan_web(url: t.\`Title\`)
  first = FIRST(pages)
  head = COALESCE(first.headcount, "") > "a"`);
    expect(errors(unknownField, PUSHED, plugins).length).toBeGreaterThan(0);

    // The list is records, not text: comparing it as one is refused.
    const asText = PLUGIN_PROGRAM(`  pages = scan_web(url: t.\`Title\`)
  head = pages > "a"`);
    expect(errors(asText, PUSHED, plugins).length).toBeGreaterThan(0);
  });

  it('declaring no output keeps the plugin to a stage, and says which fact is missing', () => {
    const source = PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)');
    const plugins = { scan_web: { args: ['url'], effects: { reads: ['the web'] } } };
    expect(errors(source, PUSHED, plugins)).toEqual([C.PLUGIN_OUTPUT_UNDECLARED]);
    expect(messages(source, PUSHED, plugins)).toContain('hands back');
    // …and the stage form, whose output goes to the extractor, stays legal.
    const stage = `  m = extract from [t.\`Title\`] through [scan_web] {
    name: "the company"
  }`;
    expect(errors(PLUGIN_PROGRAM(stage), PUSHED, plugins)).toEqual([]);
  });

  it('an undeclared ROW is reported instead of an undeclared output — one refusal per call', () => {
    const source = PLUGIN_PROGRAM('  found = scan_web(url: t.`Title`)');
    expect(errors(source, PUSHED, { scan_web: { args: ['url'] } })).toEqual([
      C.PLUGIN_ROW_UNDECLARED,
    ]);
  });
});

// ── The argument a stage gets fed for free ───────────────────────────────────

describe('a fed argument is one parameter with two ways of being filled', () => {
  const FED = {
    args: ['email'],
    effects: { reads: ['the web'], ai: true },
    fedArgs: [{ name: 'text', required: true as const }],
    output: { kind: 'value' as const, type: { kind: 'maybeAbsent' as const, of: 'text' as const } },
  };

  it('a plain call WRITES it, and is legal', () => {
    const source = PLUGIN_PROGRAM('  pages = scan_web(text: t.`Title`)');
    expect(errors(source, PUSHED, { scan_web: FED })).toEqual([]);
  });

  it('a plain call that omits it is refused, and the refusal names the argument', () => {
    const source = PLUGIN_PROGRAM('  pages = scan_web()');
    expect(errors(source, PUSHED, { scan_web: FED })).toEqual([C.PLUGIN_FED_BY_EXTRACTION]);
    expect(messages(source, PUSHED, { scan_web: FED })).toContain("'text'");
  });

  it('a STAGE never writes it — the extraction still supplies it', () => {
    const stage = `  m = extract from [t.\`Title\`] through [scan_web] {
    name: "the company"
  }`;
    expect(errors(PLUGIN_PROGRAM(stage), PUSHED, { scan_web: FED })).toEqual([]);
    const written = `  m = extract from [t.\`Title\`] through [scan_web(text: t.\`Title\`)] {
    name: "the company"
  }`;
    expect(errors(PLUGIN_PROGRAM(written), PUSHED, { scan_web: FED })).toEqual([C.THROUGH_BAD_ARG]);
  });
});

// ── Reaching for a plugin that was never imported ────────────────────────────

describe('a registered plugin nobody imported says which line is missing', () => {
  it('names the import rather than "unknown name"', () => {
    const source = `import { desk } from adapters

svc = desk()

movement look(t: <svc-[:ticket]->>) {
  page = scan_web(url: t.\`Title\`)
}`;
    const plugins = { scan_web: FOUND_TEXT };
    expect(errors(source, PUSHED, plugins)).toContain(C.NAME_UNRESOLVED);
    expect(messages(source, PUSHED, plugins)).toContain('import { scan_web } from plugins');
  });
});

// ── Watchable edges ──────────────────────────────────────────────────────────

const AWAIT_PROGRAM = (instancePosition: string, body: string): string =>
  `import { desk } from adapters

svc = desk()

movement wait(t: <svc-[:${instancePosition}]->>) {
${body}
}`;

describe('await states a cadence exactly where the source states nothing', () => {
  it('a push-backed edge is awaited bare', () => {
    expect(errors(AWAIT_PROGRAM('ticket', '  r = await FIRST(t-[:Reply]->)'), PUSHED)).toEqual([]);
  });

  it('an edge nobody announces is refused, naming until', () => {
    const source = AWAIT_PROGRAM('order', '  s = await FIRST(t-[:Shipment]->)');
    expect(errors(source, POLLED)).toEqual([C.AWAIT_NEEDS_CADENCE]);
    expect(messages(source, POLLED)).toContain('await until(');
    expect(messages(source, POLLED)).toContain('every:');
  });

  it('…and the cadence form over that same edge is clean', () => {
    const source = AWAIT_PROGRAM(
      'order',
      '  await until(() => { return EXISTS(t-[s:Shipment]->) }, every: 15m)',
    );
    expect(codes(source, POLLED)).toEqual([]);
  });

  it('polling something the source now pushes is a WARNING, never a rewrite', () => {
    const source = AWAIT_PROGRAM(
      'ticket',
      '  await until(() => { return EXISTS(t-[r:Reply]->) }, every: 15m)',
    );
    expect(errors(source, PUSHED)).toEqual([]);
    expect(codes(source, PUSHED)).toEqual([C.UNTIL_EDGE_WATCHABLE]);
    expect(messages(source, PUSHED)).toContain('await FIRST');
  });
});

// ── The bracket residual ─────────────────────────────────────────────────────

const FILTERABLE: InstanceSchema = {
  positions: {
    deal: {
      properties: { Stage: 'text', Notes: 'text' },
      edges: {},
      propertyCapabilities: {
        Stage: { filterOperators: ['eq'] },
        // The source holds it but cannot search it.
        Notes: { filterOperators: [] },
      },
    },
  },
  // The root collection DECLARES its capability, the way the adapter's meta
  // descriptor does — the checker reads it rather than assuming one (D2).
  collections: {
    deals: { target: 'deal', capability: { filter: 'native', order: 'native', supportsLimit: true } },
  },
  writableRoots: {},
};

const RESIDUAL_PROGRAM = (where: string): string => `import { desk } from adapters

crm = desk()

movement scan() {
  crm-[d:deals WHERE ${where}]-> {
    x = d.\`Stage\`
  }
}`;

describe('a predicate the source cannot run is a note about the fetch', () => {
  it('everything pushes ⇒ silence', () => {
    expect(codes(RESIDUAL_PROGRAM('`Stage` == "Won"'), FILTERABLE)).toEqual([]);
  });

  it('part pushes, part does not ⇒ a WARNING naming the predicate that stays here', () => {
    const source = RESIDUAL_PROGRAM('`Stage` == "Won" AND `Notes` CONTAINS "urgent"');
    expect(errors(source, FILTERABLE)).toEqual([]);
    expect(codes(source, FILTERABLE)).toEqual([T.HOP_FILTER_RESIDUAL]);
    expect(messages(source, FILTERABLE)).toContain('`Notes`');
    expect(messages(source, FILTERABLE)).not.toContain('`Stage` (equals)');
  });

  it('NOTHING pushes ⇒ still a refusal — an unbounded read is not a slow one', () => {
    const source = RESIDUAL_PROGRAM('`Notes` CONTAINS "urgent"');
    expect(errors(source, FILTERABLE)).toEqual([T.HOP_FILTER_UNSUPPORTED]);
    expect(messages(source, FILTERABLE)).toContain('every record');
  });
});

// ── A root collection is an edge, and says what it can do ────────────────────
//
// The root is a NODE and its collections are its EDGES, so filter / order /
// limit across one is DECLARED by the adapter, never assumed by the checker.
// Two shapes, spelt differently at every point — adapter collection, position,
// both field names — so a rule read off one source's naming cannot pass here.

const rootShape = (input: {
  collection: string;
  position: string;
  /** A field the source can narrow and sort by. */
  pushable: string;
  /** A field the source holds but can neither narrow nor sort by. */
  residual: string;
  /** An edge OFF the position — bounded by the record it leaves. */
  child: string;
  capability?: CollectionSchema['capability'];
}): InstanceSchema => ({
  positions: {
    [input.position]: {
      properties: { [input.pushable]: 'text', [input.residual]: 'text' },
      edges: {
        [input.child]: {
          target: 'child',
          capability: { filter: 'bounded', order: 'bounded', supportsLimit: true },
        },
      },
      propertyCapabilities: {
        [input.pushable]: { filterOperators: ['eq'], orderable: true },
        [input.residual]: {},
      },
    },
    child: { properties: { [input.pushable]: 'text' }, edges: {} },
  },
  collections: {
    [input.collection]: {
      target: input.position,
      ...(input.capability !== undefined ? { capability: input.capability } : {}),
    },
  },
  writableRoots: {},
});

const ROOT_SHAPES = [
  { collection: 'Deals', position: 'deal', pushable: 'Stage', residual: 'Notes', child: 'Contacts', alias: 'd' },
  { collection: 'Signals', position: 'signal', pushable: 'Score', residual: 'Summary', child: 'Roles', alias: 's' },
] as const;

const ROOT_PROGRAM = (input: {
  collection: string;
  alias: string;
  bracket: string;
  read: string;
}): string => `import { desk } from adapters

crm = desk()

movement scan() {
  crm-[${input.alias}:\`${input.collection}\` ${input.bracket}]-> {
    x = ${input.alias}.\`${input.read}\`
  }
}`;

describe('a root collection declares its own capability', () => {
  for (const shape of ROOT_SHAPES) {
    const program = (bracket: string): string =>
      ROOT_PROGRAM({ collection: shape.collection, alias: shape.alias, bracket, read: shape.pushable });

    it(`${shape.collection}: an UNDECLARED capability gates nothing`, () => {
      // The same fact as an undeclared record edge: nobody has said what this
      // source can do, so the checker says nothing either.
      const schema = rootShape(shape);
      const source = program(`WHERE \`${shape.residual}\` == "x" ORDER BY \`${shape.residual}\``);
      expect(codes(source, schema)).toEqual([]);
    });

    it(`${shape.collection}: a NATIVE order refuses a field the source cannot sort by`, () => {
      const schema = rootShape({ ...shape, capability: { filter: 'native', order: 'native', supportsLimit: true } });
      const source = program(`WHERE \`${shape.pushable}\` == "x" ORDER BY \`${shape.residual}\``);
      expect(errors(source, schema)).toEqual([T.HOP_ORDER_UNSUPPORTED]);
    });

    it(`${shape.collection}: a BOUNDED order is legal and says the sort runs here`, () => {
      // "Filter at the source, order in the engine" — the honest declaration
      // for a queryable endpoint with no sort argument.
      const schema = rootShape({ ...shape, capability: { filter: 'native', order: 'bounded', supportsLimit: true } });
      const source = program(`WHERE \`${shape.pushable}\` == "x" ORDER BY \`${shape.residual}\``);
      expect(errors(source, schema)).toEqual([]);
      expect(codes(source, schema)).toEqual([T.HOP_ORDER_ENGINE]);
      expect(messages(source, schema)).toContain(shape.collection);
      expect(messages(source, schema)).toContain('the fetch is bigger');
    });

    it(`${shape.collection}: a half-pushed WHERE and an engine sort are both named`, () => {
      const schema = rootShape({ ...shape, capability: { filter: 'native', order: 'bounded', supportsLimit: true } });
      const source = program(
        `WHERE \`${shape.pushable}\` == "x" AND \`${shape.residual}\` == "y" ORDER BY \`${shape.pushable}\``,
      );
      expect(errors(source, schema)).toEqual([]);
      expect(codes(source, schema).sort()).toEqual([T.HOP_FILTER_RESIDUAL, T.HOP_ORDER_ENGINE].sort());
    });

    it(`${shape.collection}: the order the source already delivers costs nothing`, () => {
      // A source that answers sorted by one field in one direction satisfies
      // exactly that ORDER BY itself — nothing to sort here, so no cost to
      // name. The residual field is the natural one on purpose: a field the
      // source cannot sort BY ON REQUEST can still be the order it answers in.
      const schema = rootShape({
        ...shape,
        capability: {
          filter: 'native',
          order: 'bounded',
          supportsLimit: true,
          naturalOrder: { field: shape.residual, direction: 'desc' },
        },
      });
      expect(codes(program(`ORDER BY \`${shape.residual}\` DESC LIMIT 3`), schema)).toEqual([]);
      // The reverse direction, another field, and the ASC default are sorts
      // the source was never asked for: each still runs here and says so.
      expect(codes(program(`ORDER BY \`${shape.residual}\` ASC LIMIT 3`), schema)).toEqual([T.HOP_ORDER_ENGINE]);
      expect(codes(program(`ORDER BY \`${shape.residual}\` LIMIT 3`), schema)).toEqual([T.HOP_ORDER_ENGINE]);
      expect(codes(program(`ORDER BY \`${shape.pushable}\` DESC LIMIT 3`), schema)).toEqual([T.HOP_ORDER_ENGINE]);
    });

    it(`${shape.collection}: a bounded RECORD edge orders in silence`, () => {
      // The set is already in hand, bounded by the record the hop left — there
      // is no bigger fetch to warn about, so the warning is the ROOT's alone.
      const schema = rootShape({ ...shape, capability: { filter: 'native', order: 'bounded', supportsLimit: true } });
      const source = `import { desk } from adapters

crm = desk()

movement scan() {
  crm-[${shape.alias}:\`${shape.collection}\` WHERE \`${shape.pushable}\` == "x"]-> {
    inner = ${shape.alias}-[c:\`${shape.child}\` ORDER BY \`${shape.pushable}\`]-> {
      y = c.\`${shape.pushable}\`
    }
  }
}`;
      expect(codes(source, schema)).not.toContain(T.HOP_ORDER_ENGINE);
    });

    it(`${shape.collection}: a BOUNDED filter is legal and says the WHERE runs here`, () => {
      // The filter sibling of "a BOUNDED order is legal…" above — a source
      // with no query argument at all hands back the whole collection, and
      // the WHERE runs over it here.
      const schema = rootShape({ ...shape, capability: { filter: 'bounded', order: 'native', supportsLimit: true } });
      const source = program(`WHERE \`${shape.residual}\` == "x"`);
      expect(errors(source, schema)).toEqual([]);
      expect(codes(source, schema)).toEqual([T.HOP_FILTER_ENGINE]);
      expect(messages(source, schema)).toContain(shape.collection);
      expect(messages(source, schema)).toContain('the fetch is bigger');
    });

    it(`${shape.collection}: a bounded RECORD edge filters in silence`, () => {
      // Mirrors "a bounded RECORD edge orders in silence" — the set is
      // already in hand, bounded by the record the hop left, so there is no
      // bigger fetch to warn about and the warning is the ROOT's alone.
      const schema = rootShape({ ...shape, capability: { filter: 'native', order: 'native', supportsLimit: true } });
      const source = `import { desk } from adapters

crm = desk()

movement scan() {
  crm-[${shape.alias}:\`${shape.collection}\` WHERE \`${shape.pushable}\` == "x"]-> {
    inner = ${shape.alias}-[c:\`${shape.child}\` WHERE \`${shape.pushable}\` == "x"]-> {
      y = c.\`${shape.pushable}\`
    }
  }
}`;
      expect(codes(source, schema)).not.toContain(T.HOP_FILTER_ENGINE);
    });
  }
});
