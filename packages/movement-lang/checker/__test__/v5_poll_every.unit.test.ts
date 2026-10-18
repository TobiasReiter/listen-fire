// A polled source's listen sets its own poll interval. Language versions 1-4
// spell it `pollIntervalSeconds: 300`; from version 5 it is the setting
// `every: 5m`, as `until`'s cadence is. Twin of the Rust checker's tests/listens.rs.

import { parseProgram } from '../../parser/parse';
import { checkProgram, DiagnosticCodes as C } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({
  adapters: {
    feed: {
      constructionArgs: [],
      triggerConfig: ['pollIntervalSeconds'],
      schema: {
        positions: { Note: { properties: {}, edges: {} } },
        collections: {},
        writableRoots: {},
        eventPosition: 'Note',
      },
    },
  },
  credentials: {},
});

function codes(listen: string, languageVersion: LanguageVersion): string[] {
  const [connect, movement] = languageVersion >= 5 ? ['connect feed', 'function'] : ['feed()', 'movement'];
  const source = `import { feed } from adapters\nf = ${connect}\n${movement} seen(n: <f-[:Note]->>) {}\n${listen}`;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, { languageVersion })
    .filter(d => (d.severity ?? 'error') === 'error')
    .map(d => d.code);
}

describe('a polled listen\'s own interval', () => {
  it('is `every: <duration>` from version 5', () => {
    expect(codes('listen to f { every: 5m } fire seen', 5)).toEqual([]);
    expect(codes('listen to f { every: 5 } fire seen', 5)).toEqual([C.LISTEN_BAD_CONFIG]);
  });

  it('is `pollIntervalSeconds` before 5, and respelled with the fix under 5', () => {
    expect(codes('listen to f { pollIntervalSeconds: 300 } fire seen', 4)).toEqual([]);
    expect(codes('listen to f { every: 5m } fire seen', 4)).toEqual([C.LISTEN_BAD_CONFIG]);
    expect(codes('listen to f { pollIntervalSeconds: 300 } fire seen', 5)).toEqual(['MOV_V5_SPELLING']);
  });
});
