// The effect row — one inferred fact per function: what running it may do.
//
// Nothing here is about diagnostics: this chunk refuses no program and adds no
// syntax. What is pinned is the INFERENCE — which sites raise which effect,
// that a call folds its callee's row in, that a closure carries its own, and
// that instance identity is the graph token rather than the binding's spelling.

import { parseProgram } from '../../parser/parse';
import { checkProgram, checkProgramWithLink } from '../check';
import { effectRowOf, isPureRow, type EffectRow } from '../effects';
import { InstanceSchema, mockCatalog } from '../catalog';
import type { Scope } from '../scopes';
import { storyOf, type Step } from '../../story/story';

const crmSchema: InstanceSchema = {
  positions: {
    company: {
      properties: { Name: 'text', Stage: 'text' },
      edges: { People: { target: 'person', readable: true } },
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
    attio: { constructionArgs: [], schema: crmSchema },
    slack: { constructionArgs: [], schema: chatSchema },
  },
});

const PRELUDE = `import { attio, slack } from adapters
crm = attio()
chat = slack()
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
    const source = `movement adds(c: <crm-[:company]->>) {
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
    const source = `movement names(c: <crm-[:company]->>) {
  n = c.\`Name\`
  return n
}`;
    expect(errors(source)).toEqual([]);
    expect(isPureRow(rowOf(source, 'names'))).toBe(true);
  });
});

describe('reads and writes carry the instance they touch', () => {
  it('a movement that reads one graph and writes another says both, separately', () => {
    const source = `movement announce(c: <crm-[:company]->>) {
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
    const source = `movement first_person(c: <crm-[:company]->>) {
  p = ONLY(c-[:People]->.\`Email\`)
  return p
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'first_person')).toEqual(['crm']);
    expect(writes(source, 'first_person')).toEqual([]);
  });

  it('`delete` writes the graph the handle is in', () => {
    const source = `movement drop(c: <crm-[:company]->>) {
  delete c
}`;
    expect(errors(source)).toEqual([]);
    expect(writes(source, 'drop')).toEqual(['crm']);
  });

  it('`refresh` is a READ — it moves a snapshot to now and changes nothing', () => {
    const source = `movement recheck(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    refresh a
  }
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'recheck')).toEqual(['crm']);
    expect(writes(source, 'recheck')).toEqual([]);
  });

  it('two instances of the SAME adapter are two entries — identity is the graph, not the adapter', () => {
    const source = `other = attio()
movement both(c: <crm-[:company]->>) {
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

  it('the entry IS the graph token the type checker compares by, not the spelling', () => {
    const source = `${PRELUDE}movement one(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    n = a.\`Name\`
  }
}`;
    const scope = fileScope(source);
    const instance = scope.symbols.get('crm');
    const row = effectRowOf(scope.symbols.get('one')!)!;
    expect(row.read).toHaveLength(1);
    expect(row.read[0]!.token).toBe(instance);
  });
});

describe('ai, now and suspend are flags', () => {
  it('`extract` is an ai read', () => {
    const source = `movement pull(c: <crm-[:company]->>) {
  r = extract from [ c.\`Name\` ] {
    stage: <text> "the funding stage"
  }
  return r
}`;
    expect(errors(source)).toEqual([]);
    expect(rowOf(source, 'pull').ai).toBe(true);
  });

  it('`AI(…)` in an ordinary expression is the same effect', () => {
    const source = `movement judge(c: <crm-[:company]->>) {
  verdict = AI("is this interesting?")
  return verdict
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'judge');
    expect(row.ai).toBe(true);
    expect(row.suspend).toBe(false);
  });

  it('`@current_date` reads the clock; `@user_email` does not', () => {
    const clock = `movement dated(c: <crm-[:company]->>) {
  d = @current_date
  return d
}`;
    const person = `movement whose(c: <crm-[:company]->>) {
  who = @user_email
  return who
}`;
    expect(errors(clock)).toEqual([]);
    expect(errors(person)).toEqual([]);
    expect(rowOf(clock, 'dated').now).toBe(true);
    expect(rowOf(person, 'whose').now).toBe(false);
  });

  it('`DATE.TODAY(zone)` reads the clock too; the other helpers do not', () => {
    const today = `movement dated(c: <crm-[:company]->>) {
  d = DATE.TODAY("Europe/Berlin")
  return d
}`;
    const anchored = `movement anchored(c: <crm-[:company]->>) {
  t = DATETIME.AT("2026-06-15", "07:00", "Europe/Berlin")
  return t
}`;
    expect(errors(today)).toEqual([]);
    expect(errors(anchored)).toEqual([]);
    expect(rowOf(today, 'dated').now).toBe(true);
    expect(rowOf(anchored, 'anchored').now).toBe(false);
  });

  it('every `await` parks — `sleep` has no instance and no read', () => {
    const source = `movement waits(c: <crm-[:company]->>) {
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
  const chain = `movement leaf(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}
movement middle(c: <crm-[:company]->>) {
  leaf(c: c)
}
movement top(c: <crm-[:company]->>) {
  middle(c: c)
}`;

  it('a callee\'s row reaches its caller, and its caller\'s caller', () => {
    expect(errors(chain)).toEqual([]);
    expect(writes(chain, 'leaf')).toEqual(['chat']);
    expect(writes(chain, 'middle')).toEqual(['chat']);
    expect(writes(chain, 'top')).toEqual(['chat']);
  });

  it('a movement that calls two unions both rows', () => {
    const source = `movement reader(c: <crm-[:company]->>) {
  crm-[a:companies]-> {
    n = a.\`Name\`
  }
}
movement writer(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}
movement both(c: <crm-[:company]->>) {
  reader(c: c)
  writer(c: c)
}`;
    expect(errors(source)).toEqual([]);
    expect(reads(source, 'both')).toEqual(['crm']);
    expect(writes(source, 'both')).toEqual(['chat']);
  });

  it('a call site ABOVE the declaration gets the same row — the body is walked on demand', () => {
    const source = `movement caller(c: <crm-[:company]->>) {
  callee(c: c)
}
movement callee(c: <crm-[:company]->>) {
  write chat-[:messages]-> { Body: c.\`Name\` }
}`;
    expect(errors(source)).toEqual([]);
    expect(writes(source, 'caller')).toEqual(['chat']);
  });

  it('a callee nobody can see leaves the row a LOWER BOUND, not an empty one', () => {
    const source = `movement calls_nothing(c: <crm-[:company]->>) {
  no_such_movement(c: c)
}`;
    const row = rowOf(source, 'calls_nothing');
    expect(row.partial).toBe(true);
    expect(isPureRow(row)).toBe(false);
  });
});

describe("a closure's row rides in its type", () => {
  const closureSource = `movement holds(c: <crm-[:company]->>) {
  look = () => {
    n = ONLY(crm-[:companies]->.\`Name\`)
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
    const source = `movement waits(c: <crm-[:company]->>) {
  look = () => {
    n = ONLY(crm-[:companies]->.\`Name\`)
    return n != null
  }
  await until(look, every: 5m)
}`;
    expect(errors(source)).toEqual([]);
    const row = rowOf(source, 'waits');
    expect(row.read.map((i) => i.name)).toEqual(['crm']);
    expect(row.suspend).toBe(true);
  });
});

describe('the picture reads the row off the declaration', () => {
  it("a movement step carries its row, with instances named as the author bound them", () => {
    const source = `${PRELUDE}movement announce(c: <crm-[:company]->>) {
  crm-[co:companies]-> {
    write chat-[:messages]-> { Body: AI("a one-line summary") }
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
