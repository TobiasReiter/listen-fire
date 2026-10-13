// The editor's hover/completions never reached the checker's new binding
// shape for `channel = FIRST(chat-[ch:Channels WHERE …]->)`: analysis.ts is a
// parallel AST walker (not the checker), and its `expr`-assign branch only
// called the scalar `infer()`, which returns undefined for a FIRST-over-bare-
// path (the bridge's position sentinel). That left the bound name with
// neither `posType` nor `valueType`, so hover fell to a bare last-resort line
// and completions silently dropped `channel` from every gate.
//
// Two adapter shapes (different position/edge/collection names) so a passing
// test can't be explained by one hardcoded shape happening to line up.

import type { CatalogSnapshot } from '../snapshot';
import { getHoverInfo, getMovementCompletions } from '../service';

function snapshotFor(opts: {
  adapter: string;
  credential: string;
  collectionName: string;
  positionName: string;
  positionField: string;
  edgeName: string;
  writableRoot: string;
  writableField: string;
}): CatalogSnapshot {
  const {
    adapter,
    credential,
    collectionName,
    positionName,
    positionField,
    edgeName,
    writableRoot,
    writableField,
  } = opts;
  return {
    adapters: {
      [adapter]: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        canFire: false,
        schemas: {
          [credential]: {
            positions: {
              [positionName]: {
                properties: { [positionField]: 'text' },
                edges: { [edgeName]: { target: writableRoot } },
              },
              [writableRoot]: { properties: { [writableField]: 'text' }, edges: {} },
            },
            collections: { [collectionName]: { target: positionName } },
            writableRoots: {
              [writableRoot]: {
                fields: { [writableField]: 'text' },
                resultShape: { id: 'text' },
              },
            },
          },
        },
      },
    },
    credentials: { [credential]: { adapter } },
    plugins: {},
  };
}

function caret(text: string): { source: string; offset: number } {
  const offset = text.indexOf('¦');
  if (offset === -1) throw new Error('no caret in fixture');
  return { source: text.slice(0, offset) + text.slice(offset + 1), offset };
}

function labels(result: { items: Array<{ label: string }> }): string[] {
  return result.items.map(i => i.label);
}

describe.each([
  {
    label: 'slack-shaped adapter',
    adapter: 'slack',
    credential: 'workspace_a',
    collectionName: 'Channels',
    positionName: 'channel',
    positionField: 'Name',
    edgeName: 'Messages',
    writableRoot: 'message',
    writableField: 'Message',
  },
  {
    label: 'differently-named adapter (proves derivation, not a hardcoded slack shape)',
    adapter: 'chat_widget',
    credential: 'default_room',
    collectionName: 'Rooms',
    positionName: 'room',
    positionField: 'Title',
    edgeName: 'Posts',
    writableRoot: 'post',
    writableField: 'Body',
  },
])('FIRST-binding editor support: $label', opts => {
  const snapshot = snapshotFor(opts);
  const header = `import { ${opts.adapter} } from adapters
import { ${opts.credential} as cred } from credentials

chat = ${opts.adapter}(credentials: cred)
`;
  const movement = `${header}
movement notify(evt: <chat-[:${opts.collectionName}]->>) {
  channel = FIRST(chat-[ch:${opts.collectionName} WHERE \`${opts.positionField}\` == "target"]->)
  ¦
}
`;

  it('hovers the bound name with a position hover naming the landed type and its absence', () => {
    const idx = movement.indexOf('channel =');
    const { source } = caret(movement);
    const hover = getHoverInfo(source, idx + 1, snapshot);
    const text = hover?.contents.join(' ') ?? '';
    expect(text).toContain(`chat.${opts.positionName}`);
    expect(text).toContain('which may be empty');
    // Not the bare last-resort line (`channel — value`, no type at all).
    expect(text).not.toBe(`channel — value`);
  });

  it('offers the landed position\'s edge after `channel-[`', () => {
    const { source, offset } = caret(`${header}
movement notify(evt: <chat-[:${opts.collectionName}]->>) {
  channel = FIRST(chat-[ch:${opts.collectionName} WHERE \`${opts.positionField}\` == "target"]->)
  channel-[:¦
}
`);
    const result = getMovementCompletions(source, offset, snapshot);
    expect(labels(result)).toEqual(expect.arrayContaining([opts.edgeName]));
  });

  it('offers the landed position\'s fields after `channel.`', () => {
    const { source, offset } = caret(`${header}
movement notify(evt: <chat-[:${opts.collectionName}]->>) {
  channel = FIRST(chat-[ch:${opts.collectionName} WHERE \`${opts.positionField}\` == "target"]->)
  x = channel.¦
}
`);
    const result = getMovementCompletions(source, offset, snapshot);
    expect(labels(result)).toEqual(expect.arrayContaining([opts.positionField]));
  });

  it('includes `channel` in identifier completions inside the movement body', () => {
    const { source, offset } = caret(movement);
    const result = getMovementCompletions(source, offset, snapshot);
    expect(labels(result)).toContain('channel');
  });

  // A guard clause narrows its subject for the statements AFTER it. The type
  // is therefore flow-position-dependent, and the editor asks AT a cursor:
  // before the guard the binding is still maybe-empty, after it is not.
  describe.each([
    { guard: 'channel == null', label: '`== null` guard' },
    { guard: 'NOT EXISTS(channel)', label: '`NOT EXISTS` guard' },
  ])('narrowed by a $label', ({ guard }) => {
    const guarded = `${header}
movement notify(evt: <chat-[:${opts.collectionName}]->>) {
  channel = FIRST(chat-[ch:${opts.collectionName} WHERE \`${opts.positionField}\` == "target"]->)
  if ${guard} {
    ERROR("no ${opts.positionName}")
  }
  found = channel.${opts.positionField}
}
`;
    const hoverText = (offset: number): string =>
      getHoverInfo(guarded, offset, snapshot)?.contents.join(' ') ?? '';

    it('still calls the binding maybe-empty at its own declaration', () => {
      const text = hoverText(guarded.indexOf('channel =') + 1);
      expect(text).toContain(`chat.${opts.positionName}`);
      expect(text).toContain('which may be empty');
    });

    it('still calls it maybe-empty inside the guard that tests it', () => {
      const text = hoverText(guarded.indexOf('channel', guarded.indexOf('  if ')));
      expect(text).toContain(`chat.${opts.positionName}`);
      expect(text).toContain('which may be empty');
    });

    it('shows the narrowed type after the guard', () => {
      const text = hoverText(guarded.indexOf('channel', guarded.indexOf('found =')));
      expect(text).toContain(`chat.${opts.positionName}`);
      expect(text).not.toContain('which may be empty');
    });
  });
});
