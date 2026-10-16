// The effect row — one inferred fact per function: what running it may do.
//
// Nothing here is about diagnostics: this chunk refuses no program and adds no
// syntax. What is pinned is the INFERENCE — which sites raise which effect,
// that a call folds its callee's row in, that a closure carries its own, and
// that instance identity is the graph token rather than the binding's spelling.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink, instanceRefOf } from '../check';
import { effectRowOf, isPureRow, type EffectRow } from '../effects';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { Scope } from '../scopes';
import { storyOf, type Step } from '../../story/story';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Stage: 'text' },
      edges: { People: { target: 'person', readable: true } },
      // The system deletes a company (`delete c` is checked against it).
      deletable: true,
    },
    person: { properties: { Email: 'text' }, edges: {} },
  },
  collections: { companies: { target: 'company' } },
  writableRoots: {
    company: {
      fields: { Name: 'text', Stage: 'text' },
      resultShape: { externalId: 'text' },
      edges: {},
    },
  },
};

const chatSchema: InstanceSchema = {
  positions: {
    message: { properties: { Body: 'text' }, edges: {} },
  },
  collections: { messages: { target: 'message' } },
  writableRoots: {
    message: {
      fields: { Body: 'text' },
      resultShape: { externalId: 'text' },
      edges: {},
    },
  },
};

const catalog = mockCatalog({
  adapters: {
    attio: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: false }], schema: crmSchema },
    slack: { constructionArgs: [], schema: chatSchema },
  },
  credentials: { second_crm: { adapter: 'attio' } },
});

const PRELUDE = `import { attio, slack } from adapters
crm = connect attio
chat = connect slack
`;

/** The checker's file scope — where a declaration's symbol, and so its row,
 *  lives. The recording is the surface the language service reads too. */
function fileScope(source: string): Scope {
  const { recording } = checkProgramWithLink(parseProgram(source), catalog, {
    recordAnalysis: true,
  });
  const file = recording?.frames.find((frame) => frame.kind === 'file');
  if (file === undefined) throw new Error('the check recorded no file frame');
  return file.scope;
}

function rowOf(source: string, movement: string): EffectRow {
  const scope = fileScope(`${PRELUDE}${source}`);
  const symbol = scope.symbols.get(movement);
  if (symbol === undefined) throw new Error(`'${movement}' is not declared`);
  const row = effectRowOf(symbol);
  if (row === undefined) throw new Error(`'${movement}' has no inferred row`);
  return row;
}

const reads = (source: string, movement: string): string[] =>
  rowOf(source, movement).read.map((instance) => instance.name);
const writes = (source: string, movement: string): string[] =>
  rowOf(source, movement).write.map((instance) => instance.name);

const errors = (source: string): string[] =>
  checkProgram(parseProgram(`${PRELUDE}${source}`), catalog)
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);

describe('a row is inferred for every declaration, and refuses nothing', () => {
  it('a function that only computes has an empty row, and an empty row is pure', () => {
    const source = `function adds(c: <crm-[:company]->>) {
  n = 1 + 2
  return n
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'adds');
    expect(row).toEqual({
      read: [],
      write: [],
      ai: false,
      now: false,
      suspend: false,
      partial: false,
    });
    expect(isPureRow(row)).toBe(true);
  });

  it('reading a field of the event is not a read — the value is already in hand', () => {
    const source = `function names(c: <crm-[:company]->>) {
  n = c.\`Name\`
  return n
}`;
    expect(errors(source)).toEqual([]);
    expect(isPureRow(rowOf(source, 'names'))).toBe(true);
  });
});

describe('reads and writes carry the instance they touch', () => {
  it('a movement that reads one graph and writes another says both, separately', () => {
    const source = `function announce(c: <crm-[:company]->>) {
  crm-[co:companies]-> {
    write chat-[:messages]-> {
      Body: co.\`Name\`
    }
  }
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'announce')).toEqual(['crm']);
    expect(writes(source, 'announce')).toEqual(['chat']);
  });

  it('a traversal in an expression reads too — one walk, whichever side it is written on', () => {
    const source = `function first_person(c: <crm-[:company]->>) {
  p = only(c-[:People]->.\`Email\`)
  return p
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'first_person')).toEqual(['crm']);
    expect(writes(source, 'first_person')).toEqual([]);
  });

  it('`delete` writes the graph the handle is in', () => {
    const source = `function drop(c: <crm-[:company]->>) {
  delete c
}`;
    expect(errors(source)).toEqual([]);
    expect(writes(source, 'drop')).toEqual(['crm']);
  });

  it('`refresh` is a READ — it moves a snapshot to now and changes nothing', () => {
    const source = `function recheck(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    refresh a
  }
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'recheck')).toEqual(['crm']);
    expect(writes(source, 'recheck')).toEqual([]);
  });

  it('two systems of the SAME adapter are two entries — identity is the system, not the adapter', () => {
    const source = `import { second_crm } from credentials
other = connect attio using second_crm
function both(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    write chat-[:messages]-> { Body: a.\`Name\` }
  }
  other-[b:companies]-> {
    write chat-[:messages]-> { Body: b.\`Name\` }
  }
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'both')).toEqual(['crm', 'other']);
  });

  it('two names for the SAME system are one entry — a system is its address, not its name (B12)', () => {
    const source = `same = connect attio
function both(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    write chat-[:messages]-> { Body: a.\`Name\` }
  }
  same-[b:companies]-> {
    write chat-[:messages]-> { Body: b.\`Name\` }
  }
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'both')).toEqual(['crm']);
  });

  it('the entry IS the graph token the type checker compares by, not the spelling', () => {
    const source = `${PRELUDE}function one(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    n = a.\`Name\`
  }
}`;
    const scope = fileScope(source);
    const instance = scope.symbols.get('crm');
    const row = effectRowOf(scope.symbols.get('one')!)!;
    expect(row.read).toHaveLength(1);
    expect(row.read[0]!.token).toBe(instanceRefOf(instance!)!.token);
  });
});

describe('ai, now and suspend are flags', () => {
  it('`extract` is an ai read', () => {
    const source = `function pull(c: <crm-[:company]->>) {
  r = extract from [ c.\`Name\` ] {
    stage: <text> "the funding stage"
  }
  return r
}`;
    expect(errors(source)).toEqual([]);
    expect(rowOf(source, 'pull').ai).toBe(true);
  });

  it('`AI(…)` in an ordinary expression is the same effect', () => {
    const source = `function judge(c: <crm-[:company]->>) {
  verdict = ai("is this interesting?")
  return verdict
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'judge');
    expect(row.ai).toBe(true);
    expect(row.suspend).toBe(false);
  });

  it('`@current_date` reads the clock; `@user_email` does not', () => {
    const clock = `function dated(c: <crm-[:company]->>) {
  d = @current_date
  return d
}`;
    const person = `function whose(c: <crm-[:company]->>) {
  who = @user_email
  return who
}`;
    expect(errors(clock)).toEqual([]);
    expect(errors(person)).toEqual([]);
    expect(rowOf(clock, 'dated').now).toBe(true);
    expect(rowOf(person, 'whose').now).toBe(false);
  });

  it('`DATE.TODAY(zone)` reads the clock too; the other helpers do not', () => {
    const today = `function dated(c: <crm-[:company]->>) {
  d = Date.today("Europe/Berlin")
  return d
}`;
    const anchored = `function anchored(c: <crm-[:company]->>) {
  t = DateTime.at("2026-06-15", "07:00", "Europe/Berlin")
  return t
}`;
    expect(errors(today)).toEqual([]);
    expect(errors(anchored)).toEqual([]);
    expect(rowOf(today, 'dated').now).toBe(true);
    expect(rowOf(anchored, 'anchored').now).toBe(false);
  });

  it('every `await` parks — `sleep` has no instance and no read', () => {
    const source = `function waits(c: <crm-[:company]->>) {
  await sleep(2d)
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'waits');
    expect(row.suspend).toBe(true);
    expect(row.read).toEqual([]);
    expect(row.write).toEqual([]);
  });
});

describe('the row is bottom-up over the call graph', () => {
  const chain = `function leaf(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}
function middle(c: <crm-[:company]->>) {
  leaf(c)
}
function top(c: <crm-[:company]->>) {
  middle(c)
}`;

  it('a callee\'s row reaches its caller, and its caller\'s caller', () => {
    expect(errors(chain)).toEqual([]);
    expect(writes(chain, 'leaf')).toEqual(['chat']);
    expect(writes(chain, 'middle')).toEqual(['chat']);
    expect(writes(chain, 'top')).toEqual(['chat']);
  });

  it('a movement that calls two unions both rows', () => {
    const source = `function reader(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    n = a.\`Name\`
  }
}
function writer(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}
function both(c: <crm-[:company]->>) {
  reader(c)
  writer(c)
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'both')).toEqual(['crm']);
    expect(writes(source, 'both')).toEqual(['chat']);
  });

  it('a call site ABOVE the declaration gets the same row — the body is walked on demand', () => {
    const source = `function caller(c: <crm-[:company]->>) {
  callee(c)
}
function callee(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}`;
    expect(errors(source)).toEqual([]);
    expect(writes(source, 'caller')).toEqual(['chat']);
  });

  it('a callee nobody can see leaves the row a LOWER BOUND, not an empty one', () => {
    const source = `function calls_nothing(c: <crm-[:company]->>) {
  no_such_movement(c)
}`;
    const row = rowOf(source, 'calls_nothing');
    expect(row.partial).toBe(true);
    expect(isPureRow(row)).toBe(false);
  });
});

describe("a closure's row rides in its type", () => {
  const closureSource = `function holds(c: <crm-[:company]->>) {
  look = () => {
    n = only(crm-[:companies]->.\`Name\`)
    return n != null
  }
  return c
}`;

  it('CAPTURING a closure adds nothing to the function that wrote it', () => {
    expect(errors(closureSource)).toEqual([]);
    expect(isPureRow(rowOf(closureSource, 'holds'))).toBe(true);
  });

  it("the closure's own type carries what calling it would do", () => {
    const { recording } = checkProgramWithLink(
      parseProgram(`${PRELUDE}${closureSource}`),
      catalog,
      { recordAnalysis: true },
    );
    const body = recording!.frames.find((frame) => frame.kind === 'movement');
    const closure = body!.scope.symbols.get('look');
    if (closure?.posType?.kind !== 'closure') throw new Error('`look` is not typed as a closure');
    expect(closure.posType.effects.read.map((i) => i.name)).toEqual(['crm']);
  });

  it('CALLING it is what adds the row — an `until` condition is called every tick', () => {
    const source = `function waits(c: <crm-[:company]->>) {
  look = () => {
    n = only(crm-[:companies]->.\`Name\`)
    return n != null
  }
  await until(look, { every: 5m })
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'waits');
    expect(row.read.map((i) => i.name)).toEqual(['crm']);
    expect(row.suspend).toBe(true);
  });
});

describe('the picture reads the row off the declaration', () => {
  it("a movement step carries its row, with instances named as the author bound them", () => {
    const source = `${PRELUDE}function announce(c: <crm-[:company]->>) {
  crm-[co:companies]-> {
    write chat-[:messages]-> { Body: ai("a one-line summary") }
  }
  await sleep(1d)
}`;
    const result = storyOf({ source, catalog });
    if (!result.ok) throw new Error('the story did not project');
    const movement = result.story.flow.find(
      (step): step is Extract<Step, { kind: 'movement' }> => step.kind === 'movement',
    );
    expect(movement?.effects).toEqual({
      reads: ['crm'],
      writes: ['chat'],
      ai: true,
      now: false,
      suspend: true,
      partial: false,
    });
  });
});
