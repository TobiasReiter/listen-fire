// The editor's view of a CALL's value — what the callee RETURNS.
//
// There is one checker and the service queries the scopes it recorded, so a
// call's value should reach hover and completions with nothing written for the
// editor at all. That is exactly what these pin: `r.` offers the returned
// node's fields, `r-[` offers its edges, and the parameter — the caller's own
// data, not something the body made — appears in neither.
//
// Two adapter shapes, so a pass can't be explained by one hardcoded shape.

import type { CatalogSnapshot } from '../snapshot';
import { getHoverInfo, getMovementCompletions } from '../service';

function snapshotFor(opts: {
  adapter: string;
  credential: string;
  collectionName: string;
  positionName: string;
  positionField: string;
  edgeName: string;
  landingName: string;
  landingField: string;
}): CatalogSnapshot {
  return {
    adapters: {
      [opts.adapter]: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        canFire: false,
        schemas: {
          [opts.credential]: {
            positions: {
              [opts.positionName]: {
                properties: { [opts.positionField]: 'text' },
                edges: { [opts.edgeName]: { target: opts.landingName, readable: true } },
              },
              [opts.landingName]: { properties: { [opts.landingField]: 'text' }, edges: {} },
            },
            collections: { [opts.collectionName]: { target: opts.positionName } },
            writableRoots: {},
          },
        },
      },
    },
    credentials: { [opts.credential]: { adapter: opts.adapter } },
    plugins: {},
  };
}

function caret(text: string): { source: string; offset: number } {
  const offset = text.indexOf('¦');
  if (offset === -1) throw new Error('no caret in fixture');
  return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

function labels(result: { items: Array<{ label: string }> }): string[] {
  return result.items.map((i) => i.label);
}

describe.each([
  {
    label: 'inbox-shaped adapter',
    adapter: 'email',
    credential: 'work_mail',
    collectionName: 'Messages',
    positionName: 'message',
    positionField: 'Subject',
    edgeName: 'Attachments',
    landingName: 'attachment',
    landingField: 'Name',
  },
  {
    label: 'differently-named adapter (proves derivation, not one hardcoded shape)',
    adapter: 'ticketing',
    credential: 'desk',
    collectionName: 'Tickets',
    positionName: 'ticket',
    positionField: 'Headline',
    edgeName: 'Notes',
    landingName: 'note',
    landingField: 'Body',
  },
])('a call value in the editor: $label', (opts) => {
  const snapshot = snapshotFor(opts);
  // `to_doc` RETURNS a node with a field (`title`) and an edge (`parts`), and
  // takes one parameter (`m`) — which is the caller's data and must NOT export.
  const header = `import { ${opts.adapter} } from adapters
import { ${opts.credential} as cred } from credentials

src = ${opts.adapter}(credentials: cred)

movement to_doc(m: <src-[:${opts.positionName}]->>) {
  return node {
    title: m.\`${opts.positionField}\`
    parts: lazy m-[a:${opts.edgeName}]->
  }
}
`;

  it('hovers the bound call as a value, not as a bare last-resort line', () => {
    const source = `${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
}
`;
    const idx = source.indexOf('doc = to_doc');
    const text = getHoverInfo(source, idx + 1, snapshot)?.contents.join(' ') ?? '';
    expect(text).toContain('to_doc');
    expect(text).not.toBe('doc — value');
  });

  it("offers the callee's SCALAR bindings after `doc.`", () => {
    const { source, offset } = caret(`${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
  x = doc.¦
}
`);
    expect(labels(getMovementCompletions(source, offset, snapshot))).toEqual(
      expect.arrayContaining(['title']),
    );
  });

  it("offers the callee's POSITION bindings after `doc-[`", () => {
    const { source, offset } = caret(`${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
  doc-[:¦
}
`);
    expect(labels(getMovementCompletions(source, offset, snapshot))).toEqual(
      expect.arrayContaining(['parts']),
    );
  });

  it("does NOT offer the callee's PARAMETER — that is the caller's own data", () => {
    const { source, offset } = caret(`${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
  x = doc.¦
}
`);
    expect(labels(getMovementCompletions(source, offset, snapshot))).not.toContain('m');
  });

  it('includes the bound call in identifier completions', () => {
    const { source, offset } = caret(`${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
  ¦
}
`);
    expect(labels(getMovementCompletions(source, offset, snapshot))).toContain('doc');
  });

  it("a traversal off the value reaches the LANDING's own fields", () => {
    const { source, offset } = caret(`${header}
movement use(e: <src-[:${opts.positionName}]->>) {
  doc = to_doc(m: e)
  doc-[p:parts]-> {
    y = p.¦
  }
}
`);
    expect(labels(getMovementCompletions(source, offset, snapshot))).toEqual(
      expect.arrayContaining([opts.landingField]),
    );
  });
});
