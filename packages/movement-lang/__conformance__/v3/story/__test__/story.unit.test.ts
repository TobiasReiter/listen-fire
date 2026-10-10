// The story projection, over one movement that exercises every construct the
// IR has a shape for: a listen, linked + position writes with edges, an ask
// (a write to an awaitable root plus the await of its resolution), a race with
// a sleep, a branch, an extraction tree, and a call.
//
// Three DIFFERENT adapter shapes on purpose — a fixture matching one adapter's
// shape cannot tell derived from hardcoded, and adapter-blindness is the whole
// claim being tested here.

import { InstanceSchema, mockCatalog } from '../../checker/catalog';
import { parseProgram } from '../../parser/parse';
import { checkProgramWithLink } from '../../checker/check';
import { type Chip, type StoryReference, type Step, type StoryIR, storyOf } from '../story';

// ── Fixtures ──

/** The trigger side: a mailbox whose events carry a change-kind axis. */
const mailSchema: InstanceSchema = {
  positions: {
    message: {
      properties: {
        body: 'text',
        subject: 'text',
        action: { kind: 'enum', options: ['message.received', 'message.sent'] },
      },
      edges: {},
    },
  },
  collections: {},
  writableRoots: {},
  eventPositions: [{ position: 'message', on: ['message.received', 'message.sent'] }],
};

/** The write side: a record graph with a parent edge and an in-place update. */
const crmSchema: InstanceSchema = {
  positions: {
    Companies: {
      properties: { Name: 'text' },
      edges: {
        Deals: { target: 'Deals', writable: true },
        Owner: { target: 'People', writable: true },
      },
    },
    Deals: { properties: { Title: 'text', Stage: 'text' }, edges: {} },
    People: { properties: { Name: 'text' }, edges: {} },
  },
  collections: { Companies: { target: 'Companies' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Companies: {
      fields: { Name: 'text' },
      resultShape: { externalId: 'text' },
      edges: {
        Deals: { target: 'Deals', writable: true },
        Owner: { target: 'People', writable: true },
      },
    },
    Deals: { fields: { Title: 'text', Summary: 'text', Stage: 'text' }, resultShape: {} },
    People: { fields: { Name: 'text' }, resultShape: {} },
  },
};

/** The pause side: a writable-only Check whose Response edge is awaitable. */
const askSchema: InstanceSchema = {
  positions: {
    response: { properties: { answer: 'boolean' }, edges: {} },
  },
  collections: { Check: { target: 'Check' } },
  supportsInPlaceUpdate: true,
  writableRoots: {
    Check: {
      fields: { prompt: 'text' },
      resultShape: { externalId: 'text', state: 'text' },
      edges: { Response: { target: 'response', awaitable: true, watchable: true, resolvesEmpty: true } },
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    mail: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      triggerConfig: ['key', 'events'],
      triggerConfigOptions: { events: ['message.received', 'message.sent'] },
      schema: mailSchema,
    },
    crm_sys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: crmSchema,
    },
    asksys: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: askSchema,
    },
  },
  credentials: {
    inbox_creds: { adapter: 'mail' },
    crm_creds: { adapter: 'crm_sys' },
    ask_creds: { adapter: 'asksys' },
  },
});

const SOURCE = `import { mail, crm_sys, asksys } from adapters
import { inbox_creds, crm_creds, ask_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)
questions = asksys(credentials: ask_creds)

movement note_owner(co: <book-[:Companies]->>) {
  seen = co.\`Name\`
}

movement intake(m: <inbox-[:message]->>) {
  facts = extract from [m.\`body\`] {
    name: <text> "the person's name"
    amount: <number> "the deal size"
    node company: "the company they are from" {
      domain: <text> "the web domain"
      node colleague: "everyone else named at that company" {
        name: <text> "their full name"
      }
    }
  }
  c = write book-[:Companies]-> { unique by (\`Name\`) Name ?: facts.name }
  d = write c-[:Deals]-> { Title: "Deal — \${facts.name}", Summary: AI("summarise the thread") }
  lead = match c-[:Owner]-> { unique by (\`Name\`) Name: "sam" }
  link c -[:Owner]-> lead
  a = write questions-[:Check]-> { prompt: "approve this deal?" }
  answer = await FIRST(a-[:Response]->)
  amount = COALESCE(facts.amount, 0)
  timing = await race([() => { await sleep(2d) }, () => { return TRUE }])
  if amount > 1000 {
    write d { Stage: "big" }
  } else {
    write d { Stage: "small" }
  }
  note_owner(co: c)
}

listen to inbox { key: "dealflow", events: ["message.received"] } fire intake
`;

function story(): StoryIR {
  const result = storyOf({ source: SOURCE, catalog, name: 'Deal intake' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

/** The steps of the movement the trigger fires, flattened one level. */
function intakeSteps(ir: StoryIR): Step[] {
  const movement = ir.flow.find((s) => s.kind === 'movement' && s.name === 'intake');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no intake movement');
  return movement.steps;
}

function stepsOfKind<K extends Step['kind']>(steps: Step[], kind: K): Array<Extract<Step, { kind: K }>> {
  return steps.filter((s): s is Extract<Step, { kind: K }> => s.kind === kind);
}

// ── The fixture itself ──

describe('the fixture program', () => {
  it('checks without errors, so the story is of a program that would run', () => {
    const errors = checkProgramWithLink(parseProgram(SOURCE), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

// ── Recording is opt-in ──

describe('recording stays off by default', () => {
  it('a plain check produces no recording at all', () => {
    expect(checkProgramWithLink(parseProgram(SOURCE), catalog).recording).toBeUndefined();
  });

  it('recordAnalysis: true produces frames, writes AND the story nodes', () => {
    const { recording } = checkProgramWithLink(parseProgram(SOURCE), catalog, {
      recordAnalysis: true,
    });
    expect(recording).toBeDefined();
    expect(recording!.writes.length).toBeGreaterThan(0);
    expect(recording!.nodes.map((n) => n.kind)).toEqual(
      expect.arrayContaining(['instance', 'listen', 'link', 'await', 'combinator', 'branch', 'extract', 'call']),
    );
  });
});

// ── The story ──

describe('storyOf — the whole IR', () => {
  it('carries the movement name and a truthful validity', () => {
    const ir = story();
    expect(ir.movement.name).toBe('Deal intake');
    expect(ir.movement.validity.status).toBe('valid');
  });

  it('renders the truth for an INVALID program rather than refusing it', () => {
    const result = storyOf({
      source: `${SOURCE}\nmovement broken(m: <inbox-[:message]->>) { write book-[:Nope]-> { Name: "x" } }`,
      catalog,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.story.movement.validity.status).toBe('invalid');
    expect(result.story.movement.validity.problems.some((p) => p.severity === 'error')).toBe(true);
    // The rest of the story is still there — a broken movement does not erase
    // the good ones.
    expect(result.story.triggers).toHaveLength(1);
  });

  it('refuses unparseable source with a typed no-story, never a partial guess', () => {
    const result = storyOf({ source: 'movement m( {{{{', catalog });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unparseable');
    expect(result.problems).toHaveLength(1);
  });

  it('names the constructed instances and their adapter types, opaquely', () => {
    expect(story().instances.map((i) => [i.name, i.adapterType])).toEqual([
      ['inbox', 'mail'],
      ['book', 'crm_sys'],
      ['questions', 'asksys'],
    ]);
  });
});

describe('triggers', () => {
  it('projects the listen with its declared event selection and address', () => {
    const [trigger] = story().triggers;
    expect(trigger.instance.name).toBe('inbox');
    expect(trigger.instance.declaredAt).toBeDefined();
    expect(trigger.adapterType).toBe('mail');
    expect(trigger.events).toEqual(['message.received']);
    expect(trigger.narrowing).toEqual({ key: 'dealflow' });
    expect(trigger.fires).toBe('intake');
    expect(trigger.firesMovement).toBe(true);
    expect(trigger.eventTypes.length).toBeGreaterThan(0);
  });
});

describe('records — the inspectRun sibling rows', () => {
  it('mirrors {binding, target, action, values} with expressions as chips', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c');
    expect(company).toBeDefined();
    expect(company!.target).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
    expect(company!.action).toBe('create');
    expect(company!.fields.Name).toEqual({
      source: 'facts.name',
      role: 'reference',
      refs: [{ name: 'facts', declaredAt: expect.anything() }],
      parts: [
        {
          kind: 'reference',
          reference: {
            source: 'facts.name',
            root: { name: 'facts', declaredAt: expect.anything() },
            field: 'name',
            // `facts` holds the extraction's synthetic ROOT — nobody named it,
            // so no entity name is claimed for it.
            origin: { kind: 'extracted' },
          },
        },
      ],
    });
    expect(company!.uniqueBy.map((c) => c.source)).toEqual(['`Name`']);
  });

  it('a position write is an UPDATE of the record it already holds', () => {
    const updates = story().records.filter((r) => r.action === 'update');
    expect(updates).toHaveLength(2);
    expect(updates.map((r) => r.fields.Stage.source)).toEqual(['"big"', '"small"']);
    expect(updates.every((r) => r.target.recordType === 'Deals')).toBe(true);
  });

  it('a match FINDS a record — a graph row that is never written, and draws no parent edge', () => {
    const ir = story();
    const found = ir.records.filter((r) => r.action === 'find');
    expect(found).toHaveLength(1);
    expect(found[0].binding).toBe('lead');
    expect(found[0].target.recordType).toBe('People');
    expect(found[0].fields.Name.source).toBe('"sam"');
    expect(found[0].uniqueBy.map((c) => c.source)).toEqual(['`Name`']);
    expect(ir.edges.filter((e) => e.kind === 'parent' && e.to.kind === 'record' && e.to.id === found[0].id)).toEqual([]);
    const step = stepsOfKind(intakeSteps(ir), 'match')[0];
    expect(step).toMatchObject({ kind: 'match', record: found[0].id, binding: 'lead' });
  });

  it('chips classify interpolation and AI apart from plain literals', () => {
    const deal = story().records.find((r) => r.binding === 'd');
    expect(deal!.fields.Title.role).toBe('interpolation');
    expect(deal!.fields.Title.refs.map((r) => r.name)).toEqual(['facts']);
    expect(deal!.fields.Summary.role).toBe('ai');
  });
});

describe('edges — the record graph', () => {
  it('a linked write contributes its parent edge', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const deal = ir.records.find((r) => r.binding === 'd')!;
    expect(ir.edges).toContainEqual({
      from: { kind: 'record', id: company.id },
      to: { kind: 'record', id: deal.id },
      edge: 'Deals',
      kind: 'parent',
    });
  });

  it('a link statement contributes a link edge to the found record', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const owner = ir.records.find((r) => r.action === 'find')!;
    expect(ir.edges).toContainEqual({
      from: { kind: 'record', id: company.id },
      to: { kind: 'record', id: owner.id },
      edge: 'Owner',
      kind: 'link',
    });
  });

  it('a link body projects as its two statements: the find, then the link onto what it found', () => {
    const TWO = 'lead = match c-[:Owner]-> { unique by (`Name`) Name: "sam" }\n  link c -[:Owner]-> lead';
    expect(SOURCE).toContain(TWO);
    const project = (source: string) => {
      const result = storyOf({ source, catalog, name: 'Deal intake' });
      if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
      const ir = result.story;
      const found = ir.records.filter((r) => r.action === 'find');
      expect(found).toHaveLength(1);
      const steps = intakeSteps(ir);
      const at = steps.findIndex((s) => s.kind === 'match');
      return {
        find: { binding: found[0].binding, fields: found[0].fields.Name.source, uniqueBy: found[0].uniqueBy.map((c) => c.source) },
        order: steps.slice(at, at + 2).map((s) => s.kind),
        link: ir.edges.filter((e) => e.kind === 'link' && e.to.kind === 'record' && e.to.id === found[0].id).map((e) => e.edge),
      };
    };
    const twoStatements = project(SOURCE);
    expect(twoStatements).toEqual({
      find: { binding: 'lead', fields: '"sam"', uniqueBy: ['`Name`'] },
      order: ['match', 'link'],
      link: ['Owner'],
    });
    expect(project(SOURCE.replace(TWO, 'lead = link c -[:Owner]-> { unique by (`Name`) Name: "sam" }'))).toEqual(twoStatements);
    // Unbound, with no unique by: the body's fields are its identity.
    expect(project(SOURCE.replace(TWO, 'link c -[:Owner]-> { Name: "sam" }'))).toEqual({
      find: { binding: undefined, fields: '"sam"', uniqueBy: ['Name'] },
      order: ['match', 'link'],
      link: ['Owner'],
    });
  });

  it("an ask's awaited resolution is a response edge off the record we raised", () => {
    const ir = story();
    const ask = ir.records.find((r) => r.binding === 'a')!;
    const response = ir.edges.find((e) => e.kind === 'response');
    expect(response).toEqual({
      from: { kind: 'record', id: ask.id },
      to: { kind: 'binding', ref: { name: 'answer', declaredAt: expect.anything() } },
      edge: 'Response',
      kind: 'response',
    });
  });
});

describe('flow — pauses and branches are step kinds, nested in place', () => {
  it('the file flow is its movements, each with its own body', () => {
    expect(story().flow.map((s) => s.kind === 'movement' && s.name)).toEqual([
      'note_owner',
      'intake',
    ]);
  });

  it('an awaitable edge off a record we raised is an ASK pause, not a plain wait', () => {
    const ir = story();
    const asks = stepsOfKind(intakeSteps(ir), 'ask');
    expect(asks).toHaveLength(1);
    expect(asks[0].edge).toBe('Response');
    expect(asks[0].binding).toBe('answer');
    expect(asks[0].record).toBe(ir.records.find((r) => r.binding === 'a')!.id);
  });

  it('a race carries its arms, and a sleep inside one is a wait', () => {
    const races = stepsOfKind(intakeSteps(story()), 'race');
    expect(races).toHaveLength(1);
    expect(races[0].combinator).toBe('race');
    expect(races[0].binding).toBe('timing');
    expect(races[0].branches).toHaveLength(2);
    expect(races[0].branches[0].steps).toEqual([
      expect.objectContaining({ kind: 'wait', wait: { kind: 'sleep', duration: '2d' } }),
    ]);
    expect(races[0].branches[1].steps).toEqual([
      expect.objectContaining({ kind: 'return' }),
    ]);
  });

  it('a branch nests its arms and its else, with the condition as a chip', () => {
    const branches = stepsOfKind(intakeSteps(story()), 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0].arms).toHaveLength(1);
    expect(branches[0].arms[0].condition.source).toBe('amount > 1000');
    expect(branches[0].arms[0].condition.refs.map((r) => r.name)).toEqual(['amount']);
    expect(branches[0].arms[0].steps.map((s) => s.kind)).toEqual(['write']);
    expect(branches[0].otherwise!.steps.map((s) => s.kind)).toEqual(['write']);
  });

  it('an arm and its otherwise carry `terminates` — false here, neither ends in ERROR', () => {
    const branches = stepsOfKind(intakeSteps(story()), 'branch');
    expect(branches[0]!.arms[0]!.terminates).toBe(false);
    expect(branches[0]!.otherwise!.terminates).toBe(false);
  });

  it('a race arm carries `terminates` too — the same fact, off the arm body', () => {
    const races = stepsOfKind(intakeSteps(story()), 'race');
    expect(races[0]!.branches[0]!.terminates).toBe(false);
    expect(races[0]!.branches[1]!.terminates).toBe(false);
  });

  it('an arm that ERRORs is `terminates: true` — projected from the checker, not re-derived', () => {
    const source = `import { mail, crm_sys } from adapters
import { inbox_creds, crm_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)

movement guarded(m: <inbox-[:message]->>) {
  if m.\`subject\` == "bad" {
    ERROR("rejected")
  } else {
    write book-[:Companies]-> { Name: "ok" }
  }
}
`;
    const result = storyOf({ source, catalog, name: 'Guarded' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'guarded');
    if (movement === undefined || movement.kind !== 'movement') throw new Error('no guarded movement');
    const branches = stepsOfKind(movement.steps, 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0]!.arms[0]!.terminates).toBe(true);
    expect(branches[0]!.otherwise!.terminates).toBe(false);
  });

  it('an arm that RETURNS is `terminates: true` from version 3 — the lane does not come back', () => {
    const source = `import { mail, crm_sys } from adapters
import { inbox_creds, crm_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)

movement guarded(m: <inbox-[:message]->>) {
  if m.\`subject\` == "bad" {
    return "rejected"
  }
  write book-[:Companies]-> { Name: "ok" }
  return "done"
}
`;
    const movementOf = (languageVersion: 2 | 3) => {
      const result = storyOf({ source, catalog, name: 'Guarded', languageVersion });
      if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
      const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'guarded');
      if (movement === undefined || movement.kind !== 'movement') throw new Error('no guarded movement');
      return movement;
    };
    const v3 = movementOf(3);
    expect(stepsOfKind(v3.steps, 'branch')[0]!.arms[0]!.terminates).toBe(true);
    // A `return` straight on the spine is a step, not a capped lane: the run's
    // own ending is still drawn.
    expect(v3.terminates).toBe(false);
    expect(stepsOfKind(movementOf(2).steps, 'branch')[0]!.arms[0]!.terminates).toBe(false);
  });

  it('an extraction carries its sources and its resolved tree', () => {
    const extracts = stepsOfKind(intakeSteps(story()), 'extract');
    expect(extracts).toHaveLength(1);
    expect(extracts[0].binding).toBe('facts');
    expect(extracts[0].from.map((c) => c.source)).toEqual(['m.`body`']);
    const tree = extracts[0].tree!;
    expect(tree.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'text'],
      ['amount', 'number'],
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(['company']);
    expect(tree.children[0].fields.map((f) => f.name)).toEqual(['domain']);
  });

  it('the tree carries the whole graph — every node, its fields, and the words the author gave each one', () => {
    const extracts = stepsOfKind(intakeSteps(story()), 'extract');
    const tree = extracts[0].tree!;

    // The root is synthetic: nobody declared it, so it describes nothing.
    expect(tree.description).toBeUndefined();
    expect(tree.fields.map((f) => [f.name, f.description])).toEqual([
      ['name', "the person's name"],
      ['amount', 'the deal size'],
    ]);

    const company = tree.children[0];
    expect(company.description).toBe('the company they are from');
    expect(company.fields).toEqual([
      expect.objectContaining({ name: 'domain', description: 'the web domain', type: 'text' }),
    ]);

    // Nesting is carried to any depth — a child's child is a node like any other.
    const colleague = company.children[0];
    expect(colleague.name).toBe('colleague');
    expect(colleague.description).toBe('everyone else named at that company');
    expect(colleague.fields.map((f) => f.description)).toEqual(['their full name']);
  });

  it('a field annotated `<text | null>` is said as written: text, or nothing', () => {
    const source = SOURCE.replace('domain: <text> "the web domain"', 'domain: <text | null> "the web domain"');
    const result = storyOf({ source, catalog, name: 'Deal intake' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const tree = stepsOfKind(intakeSteps(result.story), 'extract')[0].tree!;
    expect(tree.children[0].fields.map((f) => [f.name, f.type])).toEqual([
      ['domain', { kind: 'maybeAbsent', of: 'text' }],
    ]);
    expect(tree.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', 'text'],
      ['amount', 'number'],
    ]);
  });

  it('a call names the movement and says whether the name resolved to one', () => {
    const calls = stepsOfKind(intakeSteps(story()), 'call');
    expect(calls).toHaveLength(1);
    expect(calls[0].movement).toBe('note_owner');
    expect(calls[0].isMovement).toBe(true);
    expect(calls[0].args).toEqual([
      { name: 'co', kind: 'value', chip: expect.objectContaining({ source: 'c' }) },
    ]);
  });
});

// ── Referents ──
//
// A binding name means nothing to a reader, so every reference carries what the
// name STOOD FOR. Each assertion below is about the projection knowing which
// kind of thing that is; the words ("the", "it just created") are composed
// downstream, out of labels the owning system declared.

describe('references say what they refer to', () => {
  /** The first reference part of a chip. */
  function referenceOf(chip: Chip): StoryReference {
    const part = chip.parts.find((p) => p.kind === 'reference');
    if (part?.kind !== 'reference') throw new Error(`no reference in ${chip.source}`);
    return part.reference;
  }

  it('a parameter read is the EVENT that came in, with the declared field', () => {
    const ir = story();
    const extract = stepsOfKind(intakeSteps(ir), 'extract')[0];
    const reference = referenceOf(extract.from[0]);
    expect(reference.root.name).toBe('m');
    expect(reference.field).toBe('body');
    expect(reference.origin).toEqual({
      kind: 'event',
      target: { adapterType: 'mail', instance: 'inbox', recordType: 'message' },
    });
  });

  it('a write handle is the RECORD this flow wrote, by id', () => {
    const ir = story();
    const company = ir.records.find((r) => r.binding === 'c')!;
    const call = stepsOfKind(intakeSteps(ir), 'call')[0];
    const arg = call.args[0];
    if (arg?.kind !== 'value') throw new Error('expected a value argument');
    expect(referenceOf(arg.chip).origin).toEqual({ kind: 'record', record: company.id });
  });

  it('an extraction alias carries the name the AUTHOR gave the node', () => {
    // `facts.name` reads the synthetic root; a named node reads as itself.
    const ir = story();
    const deal = ir.records.find((r) => r.binding === 'd')!;
    expect(referenceOf(deal.fields.Title).origin).toEqual({ kind: 'extracted' });
  });

  it('a template splits at the AST — literal runs and referents, never a scan', () => {
    const deal = story().records.find((r) => r.binding === 'd')!;
    expect(deal.fields.Title.parts).toEqual([
      { kind: 'text', text: 'Deal — ' },
      expect.objectContaining({ kind: 'reference' }),
    ]);
  });

  it('a condition splits into its two sides and the operator between them', () => {
    const branch = stepsOfKind(intakeSteps(story()), 'branch')[0];
    expect(branch.arms[0].condition.parts).toEqual([
      {
        kind: 'test',
        operator: 'gt',
        // The subject is a referent; the operator is the LANGUAGE's token, and
        // the word for it is the renderer's.
        subject: [
          expect.objectContaining({
            kind: 'reference',
            reference: expect.objectContaining({ source: 'amount' }),
          }),
        ],
        against: [{ kind: 'expression', source: '1000', refs: [] }],
      },
    ]);
  });

  it('a value-position WALK carries its hops and landings, like a for-each head', () => {
    const result = storyOf({
      source: `${SOURCE.replace(
        'link c -[:Owner]-> lead',
        'link c -[:Owner]-> lead\n  owner = c-[:Owner]->.Name',
      )}`,
      catalog,
    });
    if (!result.ok) throw new Error('expected a story');
    const value = stepsOfKind(intakeSteps(result.story), 'value').find(
      (s) => s.binding === 'owner',
    );
    const reference = referenceOf(value!.value);
    expect(reference.field).toBe('Name');
    expect(reference.path).toEqual([
      { edge: 'Owner', landing: { adapterType: 'crm_sys', instance: 'book', recordType: 'People' } },
    ]);
  });

  it('an expression shown WHOLE says which names are visible inside it', () => {
    const result = storyOf({
      source: `${SOURCE.replace(
        'link c -[:Owner]-> lead',
        'link c -[:Owner]-> lead\n  pick = IF facts.amount > 1 THEN facts.name ELSE "none" END',
      )}`,
      catalog,
    });
    if (!result.ok) throw new Error('expected a story');
    const value = stepsOfKind(intakeSteps(result.story), 'value').find((s) => s.binding === 'pick');
    // Nothing splits a conditional, so its text stands — and the names in that
    // text are the ones a reader is left to make sense of.
    expect(value!.value.parts).toEqual([{ kind: 'text', text: expect.stringContaining('IF') }]);
    expect(value!.value.refs.map((r) => r.name)).toEqual(['facts']);
  });

  it('a read with a WALK in it is shown whole — a phrase would leave the walk out', () => {
    const ir = story();
    const owner = ir.records.find((r) => r.action === 'find')!;
    // `"sam"` is a literal: no reference, one text part carrying the source.
    expect(owner.fields.Name.parts).toEqual([{ kind: 'text', text: '"sam"' }]);
  });

  it('an unresolvable name stays raw — no origin is claimed for it', () => {
    const result = storyOf({
      source: `movement solo() {
  x = "\${nobody.here}"
}
`,
      catalog,
    });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow[0];
    if (movement?.kind !== 'movement') throw new Error('expected a movement');
    const value = movement.steps[0];
    if (value?.kind !== 'value') throw new Error('expected a value step');
    expect(referenceOf(value.value).origin).toBeUndefined();
  });
});

// ── Assembled nodes ──

describe('a node the author assembled shows its contents', () => {
  const ASSEMBLED = `movement take(lead: <Lead>) {
  seen = lead.Name
}

node Lead {
  Name: <text>
  Source: <text>
}

movement build() {
  l = node { Name: "Acme", Source: "inbound" }
  take(lead: l)
  take(lead: node { Name: "Other", Source: "outbound" })
}
`;

  function build(): Step[] {
    const result = storyOf({ source: ASSEMBLED, catalog });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'build');
    if (movement?.kind !== 'movement') throw new Error('expected the build movement');
    return movement.steps;
  }

  it('a named node carries its fields, not just the fact that it was bound', () => {
    const node = build()[0];
    if (node?.kind !== 'node') throw new Error('expected a node step');
    expect(node.binding).toBe('l');
    expect(Object.keys(node.node.fields)).toEqual(['Name', 'Source']);
    expect(node.node.fields.Name.source).toBe('"Acme"');
  });

  it('an INLINE node argument is carried too — a position argument is not nothing', () => {
    const calls = build().filter((s): s is Extract<Step, { kind: 'call' }> => s.kind === 'call');
    const inline = calls[1]?.args[0];
    if (inline?.kind !== 'node') throw new Error('expected a node argument');
    expect(inline.name).toBe('lead');
    expect(Object.keys(inline.node.fields)).toEqual(['Name', 'Source']);
  });

  // A pass-through entry is where the values come FROM, and that is a referent
  // like any other. Carrying only the path's text is what left a card saying
  // `facts-[c:company]->` — the one form the renderer could not put in words.
  it('a pass-through traversal entry composes a referent, not the path as text', () => {
    const source = `${SOURCE.replace(
      'note_owner(co: c)',
      'file(shape: node { Label: "x", company: facts-[c:company]-> })',
    )}
node Filing {
  Label: <text>
  node company {
    domain: <text>
  }
}

movement file(shape: <Filing>) {
  seen = shape.Label
}
`;
    const result = storyOf({ source, catalog });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const call = stepsOfKind(intakeSteps(result.story), 'call')[0];
    const arg = call?.args[0];
    if (arg?.kind !== 'node') throw new Error('expected a node argument');
    const chip = arg.node.fields.company;
    expect(chip.source).toBe('facts-[c:company]->');
    const part = chip.parts[0];
    if (part?.kind !== 'reference') throw new Error(`no reference in ${chip.source}`);
    expect(part.reference.path?.map((hop) => hop.edge)).toEqual(['company']);
    expect(part.reference.field).toBeUndefined();
    // The root is the extraction result, and the phrase downstream says so.
    expect(part.reference.origin).toEqual({ kind: 'extracted' });
  });
});

// ── Traversals ──
//
// The one authored form whose TEXT is pure syntax. Every assertion below is
// about the projection carrying STRUCTURE — hops, landings, comparisons — so a
// renderer can compose a sentence without ever seeing `-[…]->`.

const TRAVERSALS = `import { mail, crm_sys, asksys } from adapters
import { inbox_creds, crm_creds, ask_creds } from credentials

inbox = mail(credentials: inbox_creds)
book = crm_sys(credentials: crm_creds)
questions = asksys(credentials: ask_creds)

movement flows(m: <inbox-[:message]->>) {
  a = write questions-[:Check]-> { prompt: "approve this deal?" }

  book-[one:Companies WHERE \`Name\` == "acme"]-> {
    write one { Name: "acme" }
  }

  book-[two:Companies WHERE \`Name\` == "acme" AND \`Name\` != "other"]-> {
    seen_two = two.\`Name\`
  }

  book-[three:Companies WHERE \`Name\` == "acme" OR \`Name\` == "other"]-> {
    seen_three = three.\`Name\`
  }

  book-[co:Companies]->-[deal:Deals]-> {
    seen_deal = deal.\`Title\`
  }

  a-[reply:Response]-> {
    seen_reply = reply.answer
  }

  outcome = await race([() => { return await FIRST(a-[:Response]->) }, () => { await sleep(1d) }])
}

listen to inbox { key: "flows" } fire flows
`;

function groups(): Array<Extract<Step, { kind: 'group' }>> {
  const result = storyOf({ source: TRAVERSALS, catalog, name: 'Flows' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'flows');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no flows movement');
  return stepsOfKind(movement.steps, 'group');
}

describe('traversals project as structure, never as syntax', () => {
  it('the fixture checks clean, so the structure is of a program that would run', () => {
    const errors = checkProgramWithLink(parseProgram(TRAVERSALS), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });

  it('a collection hop carries its binding, its edge and the landing the CHECKER resolved', () => {
    const [simple] = groups();
    expect(simple.over.root!.name).toBe('book');
    expect(simple.over.from).toBe('graph');
    expect(simple.over.hops).toHaveLength(1);
    expect(simple.over.hops[0]!.binding).toBe('one');
    expect(simple.over.hops[0]!.edge).toBe('Companies');
    expect(simple.over.hops[0]!.landing).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
  });

  it('a simple WHERE becomes comparisons — field, operator, value chip', () => {
    const [simple] = groups();
    expect(simple.over.hops[0]!.filter).toEqual({
      kind: 'comparisons',
      all: [
        {
          field: 'Name',
          operator: 'eq',
          value: {
            source: '"acme"',
            role: 'literal',
            refs: [],
            parts: [{ kind: 'text', text: '"acme"' }],
          },
        },
      ],
    });
  });

  it('a conjunction stays comparisons — every clause, in order', () => {
    const conjunction = groups()[1]!;
    const filter = conjunction.over.hops[0]!.filter!;
    expect(filter.kind).toBe('comparisons');
    if (filter.kind !== 'comparisons') return;
    expect(filter.all.map((c) => [c.field, c.operator, c.value.source])).toEqual([
      ['Name', 'eq', '"acme"'],
      ['Name', 'neq', '"other"'],
    ]);
  });

  it('anything else is carried WHOLE as one expression chip, never flattened', () => {
    const complex = groups()[2]!;
    const filter = complex.over.hops[0]!.filter!;
    expect(filter.kind).toBe('expression');
    if (filter.kind !== 'expression') return;
    // The whole filter, as the author's own operator — an OR read as a list of
    // ANDed clauses would say the opposite of what was written.
    expect(filter.chip.source).toContain('OR');
    expect(filter.chip.role).toBe('literal');
  });

  it('a two-hop path is two hops, each with its own landing', () => {
    const chain = groups()[3]!;
    expect(chain.over.hops.map((h) => [h.binding, h.edge])).toEqual([
      ['co', 'Companies'],
      ['deal', 'Deals'],
    ]);
    expect(chain.over.hops.map((h) => h.landing?.recordType)).toEqual(['Companies', 'Deals']);
    expect(chain.over.hops.every((h) => h.filter === undefined)).toBe(true);
  });

  it('a walk off a RESULT says so — and its landing comes from a different adapter shape', () => {
    const reply = groups()[4]!;
    expect(reply.over.from).toBe('result');
    expect(reply.over.hops[0]!.edge).toBe('Response');
    expect(reply.over.hops[0]!.landing).toEqual({
      adapterType: 'asksys',
      instance: 'questions',
      recordType: 'response',
    });
  });

  it('a combinator arm walks off a RESULT the same way any body does', () => {
    // The race's own value is a positional receipt (a value, not a node), so
    // the walk that used to hang off the receipt now lives INSIDE the arm.
    const [race] = stepsOfKind(
      (() => {
        const result = storyOf({ source: TRAVERSALS, catalog, name: 'Flows' });
        if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
        const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'flows');
        if (movement === undefined || movement.kind !== 'movement') throw new Error('no flows movement');
        return movement.steps;
      })(),
      'race',
    );
    expect(race!.binding).toBe('outcome');
    expect(race!.branches).toHaveLength(2);
  });

  it('a head that cannot be read keeps the source and claims NO hops', () => {
    const source = `import { mail } from adapters
import { inbox_creds } from credentials

inbox = mail(credentials: inbox_creds)

movement broken(m: <inbox-[:message]->>) {
  nowhere-[x:Nothing]-> {
    seen = m.\`body\`
  }
}
`;
    const result = storyOf({ source, catalog, name: 'Broken' });
    if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
    const movement = result.story.flow.find((s) => s.kind === 'movement' && s.name === 'broken');
    if (movement === undefined || movement.kind !== 'movement') throw new Error('no movement');
    const [group] = stepsOfKind(movement.steps, 'group');
    expect(group!.over.from).toBeUndefined();
    expect(group!.over.hops.map((h) => h.landing)).toEqual([undefined]);
    expect(group!.over.source).toBe('nowhere-[x:Nothing]->');
  });
});

describe('serializability — the projection is the point at which identity settles', () => {
  it('a JSON round-trip loses nothing', () => {
    const ir = story();
    expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  });

  it('nothing in the IR is a live Scope, a Map, or a Set', () => {
    const offenders: string[] = [];
    const visit = (value: unknown, path: string): void => {
      if (value instanceof Map || value instanceof Set) offenders.push(`${path}: collection`);
      if (Array.isArray(value)) return value.forEach((v, i) => visit(v, `${path}[${i}]`));
      if (value !== null && typeof value === 'object') {
        if (value.constructor !== Object) offenders.push(`${path}: ${value.constructor.name}`);
        for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
      }
      if (typeof value === 'function') offenders.push(`${path}: function`);
    };
    visit(story(), 'story');
    expect(offenders).toEqual([]);
  });
});

// ── Deferred actions, folds over walks, and the receipt branch ──
//
// A second program, from the shape of a real callback+race movement: two
// deferred actions raced against a timer, a message whose payload carries their
// ids by hand, a channel found with a fold over a walk, and a branch on the
// race receipt's timer slot.

const CALLBACK_SOURCE = `import { crm_sys } from adapters
import { crm_creds } from credentials

book = crm_sys(credentials: crm_creds)

movement approve() {
  co = ONLY(book-[c:Companies WHERE \`Name\` == "Acme"]->)
  yes = callback({ write book-[:Companies]-> { Name: "approved" } })
  no = callback({ write book-[:Companies]-> { Name: "declined" } })
  write book-[:Companies]-> { Name: "asked \${yes.id} \${no.id}" }
  r = await race([
    () => { await FIRST(yes-[:Called]->) },
    () => { await FIRST(no-[:Called]->) },
    () => { await sleep(1d) },
  ])
  if AT(r, 2) == null {
    write book-[:Companies]-> { Name: "nobody answered" }
  }
}
`;

function callbackStory(): StoryIR {
  const result = storyOf({ source: CALLBACK_SOURCE, catalog, name: 'Approve' });
  if (!result.ok) throw new Error(`expected a story, got ${result.reason}`);
  return result.story;
}

function approveSteps(): Step[] {
  const movement = callbackStory().flow.find((s) => s.kind === 'movement' && s.name === 'approve');
  if (movement === undefined || movement.kind !== 'movement') throw new Error('no approve movement');
  return movement.steps;
}

describe('the callback fixture', () => {
  it('checks without errors, so the story is of a program that would run', () => {
    const errors = checkProgramWithLink(parseProgram(CALLBACK_SOURCE), catalog).diagnostics.filter(
      (d) => (d.severity ?? 'error') === 'error',
    );
    expect(errors.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
  });
});

describe('callbacks — a deferred action, with the steps that run when it is used', () => {
  it('projects a callback as its own step kind, not as a bare binding', () => {
    const [callback] = stepsOfKind(approveSteps(), 'callback');
    expect(callback).toBeDefined();
    expect(callback!.binding).toBe('yes');
    expect(callback!.movement).toBeUndefined();
  });

  it('carries the BODY as steps, projected like any other block', () => {
    const [callback] = stepsOfKind(approveSteps(), 'callback');
    const [write] = stepsOfKind(callback!.steps, 'write');
    expect(write).toBeDefined();
    // The write inside is a row of the record graph like any other, so the
    // canvas draws the same card for it.
    const record = callbackStory().records.find((r) => r.id === write!.record);
    expect(record!.target).toEqual({
      adapterType: 'crm_sys',
      instance: 'book',
      recordType: 'Companies',
    });
    expect(record!.fields.Name!.source).toBe('"approved"');
  });

  it('a reference to a callback resolves to the AUTHOR’s own name for it', () => {
    const asked = callbackStory().records.find(
      (r) => r.fields.Name?.source.includes('${yes.id}') === true,
    );
    const parts = asked!.fields.Name!.parts;
    const referenced = parts.flatMap((p) =>
      p.kind === 'reference' ? [p.reference] : [],
    );
    expect(referenced.map((r) => [r.origin, r.field])).toEqual([
      [{ kind: 'callback', name: 'yes' }, 'id'],
      [{ kind: 'callback', name: 'no' }, 'id'],
    ]);
    // Two callbacks compose two different phrases, so neither is ambiguous.
    expect(referenced.every((r) => r.ambiguous === undefined)).toBe(true);
  });

  it('a body-less callback is the same shape with nothing in it', () => {
    const source = CALLBACK_SOURCE.replace(
      'yes = callback({ write book-[:Companies]-> { Name: "approved" } })',
      'yes = callback()',
    );
    const result = storyOf({ source, catalog });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow.find((s) => s.kind === 'movement');
    if (movement?.kind !== 'movement') throw new Error('no movement');
    const [callback] = stepsOfKind(movement.steps, 'callback');
    expect(callback!.steps).toEqual([]);
  });
});

describe('race lanes — what each contender waits ON, not just the edge it waits for', () => {
  it('each callback await carries the deferred action it waits on', () => {
    const [race] = stepsOfKind(approveSteps(), 'race');
    const waits = race!.branches.map((b) => b.steps[0]);
    expect(waits.map((w) => (w?.kind === 'wait' ? w.wait : undefined))).toEqual([
      { kind: 'edge', on: { kind: 'binding', ref: expect.anything() }, edge: 'Called', origin: { kind: 'callback', name: 'yes' } },
      { kind: 'edge', on: { kind: 'binding', ref: expect.anything() }, edge: 'Called', origin: { kind: 'callback', name: 'no' } },
      { kind: 'sleep', duration: '1d' },
    ]);
  });

  it('the lanes are in the arms\' own order, which is the receipt\'s slot order', () => {
    const [race] = stepsOfKind(approveSteps(), 'race');
    const timer = race!.branches[2]!.steps[0];
    expect(timer?.kind === 'wait' && timer.wait).toEqual({ kind: 'sleep', duration: '1d' });
    expect(race!.binding).toBe('r');
  });
});

describe('a fold over a walk — the call composes over the walk’s structure', () => {
  it('ONLY(<walk>) travels as the fold plus the walk, never as raw syntax', () => {
    const [value] = stepsOfKind(approveSteps(), 'value');
    expect(value!.binding).toBe('co');
    const [part] = value!.value.parts;
    expect(part!.kind).toBe('walk');
    if (part!.kind !== 'walk') return;
    expect(part.fn).toBe('only');
    expect(part.traversal.hops).toEqual([
      {
        binding: 'c',
        edge: 'Companies',
        landing: { adapterType: 'crm_sys', instance: 'book', recordType: 'Companies' },
        filter: {
          kind: 'comparisons',
          all: [{ field: 'Name', operator: 'eq', value: expect.objectContaining({ source: '"Acme"' }) }],
        },
      },
    ]);
    // The author's own text survives, for a fold this page has no word for.
    expect(part.source).toContain('ONLY');
  });

  it('a fold over something with no recorded walk stays exactly as written', () => {
    const source = CALLBACK_SOURCE.replace(
      'ONLY(book-[c:Companies WHERE \`Name\` == "Acme"]->)',
      'ONLY([1, 2])',
    );
    const result = storyOf({ source, catalog });
    if (!result.ok) throw new Error('expected a story');
    const movement = result.story.flow.find((s) => s.kind === 'movement');
    if (movement?.kind !== 'movement') throw new Error('no movement');
    const [value] = stepsOfKind(movement.steps, 'value');
    expect(value!.value.parts).toEqual([{ kind: 'text', text: 'ONLY([1, 2])' }]);
  });
});

describe('a node declaration that extends another', () => {
  it("is shown whole — the base's fields and nested nodes first, then its own", () => {
    const source = [
      'node Entry {',
      '  name: <text>',
      '  node founder { first: <text> } order by arrival',
      '}',
      'node `Recap Entry` extends Entry { diverse_founder: <text | null> }',
    ].join('\n');
    const result = storyOf({ source, catalog });
    if (!result.ok) throw new Error('expected a story');
    expect(result.story.shapes.find((s) => s.name === 'Recap Entry')).toEqual({
      name: 'Recap Entry',
      position: 'Recap Entry',
      fields: [{ name: 'name', type: 'text' }, expect.objectContaining({ name: 'diverse_founder' })],
      children: [
        {
          name: 'founder',
          position: 'Recap Entry.founder',
          fields: [{ name: 'first', type: 'text' }],
          children: [],
        },
      ],
    });
    // The base is shown as it was written.
    expect(result.story.shapes.find((s) => s.name === 'Entry')?.fields).toEqual([
      { name: 'name', type: 'text' },
    ]);
  });
});

describe('the receipt is read by SLOT — the timeout branch is one null check', () => {
  it('the branch condition names the race binding and the slot it reads', () => {
    const [branch] = stepsOfKind(approveSteps(), 'branch');
    expect(branch!.arms[0]!.condition.source).toBe('AT(r, 2) == null');
    expect(branch!.arms[0]!.condition.refs.map((ref) => ref.name)).toEqual(['r']);
  });
});
