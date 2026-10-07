import { assertParserReady, callJson, callLowering, initParser, isParserReady, parserGeneration } from '../loader';

declare function require(id: string): unknown;
declare const __dirname: string;
declare const process: { getBuiltinModule?: unknown };

const ROUND_TRIP = {
  kind: 'string',
  quote: "'",
  parts: ['héllo 🌍'],
  at: { start: 0, end: 10 },
};

describe('the parser loader', () => {
  it('is ready as soon as the module loads under Node', () => {
    expect(isParserReady()).toBe(true);
  });

  it('round-trips source through every parse export', () => {
    expect(callJson('parse_expression', "'héllo 🌍'", [3])).toEqual(ROUND_TRIP);
    expect(callJson('parse_program', '', [3])).toEqual({ statements: [] });
    expect(callJson('parse_program_eager', 'x = 1', [3])).toEqual({
      statements: [
        {
          kind: 'assign',
          name: 'x',
          value: {
            kind: 'expr',
            expr: {
              raw: '1',
              span: { start: { line: 1, col: 5 }, end: { line: 1, col: 6 } },
              tree: { kind: 'literal', value: 1, at: { start: 0, end: 1 } },
            },
          },
          span: { start: { line: 1, col: 1 }, end: { line: 1, col: 6 } },
        },
      ],
    });
    expect(callJson('parse_nested_call', 'f(x)', [0, 4, 1, 1, 3])).toMatchObject({ kind: 'call', call: { callee: 'f' } });
    const tree = JSON.stringify(callJson('parse_expression', "'héllo 🌍'", [3]));
    expect(callLowering('lower_expression', tree, "'héllo 🌍'")).toEqual({
      ok: true,
      json: { type: 'static', value: 'héllo 🌍' },
    });
    expect(callLowering('lower_condition', tree, "'héllo 🌍'")).toEqual({
      ok: true,
      json: { kind: 'expr', expr: { type: 'static', value: 'héllo 🌍' } },
    });
  });

  it('accepts bytes as input', () => {
    expect(callJson('parse_expression', new Uint8Array([0x61]), [3])).toEqual({
      kind: 'name',
      name: { text: 'a', quoted: false, at: { start: 0, end: 1 } },
      at: { start: 0, end: 1 },
    });
  });

  it('initParser with no argument is a no-op once Node has loaded it', async () => {
    const before = parserGeneration();
    await initParser();
    expect(parserGeneration()).toBe(before);
  });

  describe('before it has loaded', () => {
    // A registry of its own, loaded with a stand-in for one of the two ways
    // the parser starts out unloaded: a browser (a `window`, so Node's disk
    // path is never tried) or a Node that cannot read the artifact.
    function loadWithout(missing: 'node' | 'disk'): typeof import('../loader') {
      const original = process.getBuiltinModule;
      if (missing === 'node') Reflect.set(globalThis, 'window', globalThis);
      else process.getBuiltinModule = undefined;
      try {
        let loader: typeof import('../loader') | undefined;
        jest.isolateModules(() => {
          loader = require('../loader') as typeof import('../loader');
        });
        if (loader === undefined) throw new Error('isolateModules did not run');
        return loader;
      } finally {
        Reflect.deleteProperty(globalThis, 'window');
        process.getBuiltinModule = original;
      }
    }

    function thrownBy(run: () => unknown): unknown {
      try {
        run();
      } catch (e) {
        return e;
      }
      throw new Error('expected a throw');
    }

    it('in a browser, throws MovementParserNotReady telling the caller to await initParser(), until it does', async () => {
      const loader = loadWithout('node');
      expect(loader.isParserReady()).toBe(false);
      const thrown = thrownBy(() => loader.callJson('parse_program', '', [3]));
      expect(thrown).toBeInstanceOf(loader.MovementParserNotReady);
      expect(thrown).toMatchObject({
        name: 'MovementParserNotReady',
        message: 'the movement parser is not ready: await initParser() before parsing',
      });

      await loader.initParser(committedArtifact());
      expect(loader.isParserReady()).toBe(true);
      expect(loader.callJson('parse_program', '', [3])).toEqual({ statements: [] });
    });

    it("in a browser, loads the parser's own artifact: it parses, lowers and checks, and runs no movement", async () => {
      const loader = loadWithout('node');
      await loader.initParser(committedArtifact('movement_parser.wasm'));
      expect(loader.callJson('parse_program', '', [3])).toEqual({ statements: [] });
      expect(loader.callLowering('lower_expression', JSON.stringify(loader.callJson('parse_expression', 'a', [3])), 'a').ok).toBe(true);
      expect(() => loader.callEvalExpression('{}', '{}')).toThrow('this movement artifact has no eval_expression()');
      expect(() => loader.openEngineSegment()).toThrow();
    });

    it('in a Node that could not read the artifact, says why, at boot and at every parse', () => {
      const loader = loadWithout('disk');
      const atBoot = thrownBy(() => loader.assertParserReady());
      expect(atBoot).toBeInstanceOf(loader.MovementParserNotReady);
      expect(atBoot).toMatchObject({
        message: expect.stringMatching(/^the movement parser did not load: .*getBuiltinModule/),
        cause: expect.any(Error),
      });
      expect(String(thrownBy(() => loader.callJson('parse_program', '', [3])))).toBe(String(atBoot));
    });

    it('passes the boot check once loaded', () => {
      expect(() => assertParserReady()).not.toThrow();
    });
  });

  describe('after a trap', () => {
    // The release artifact has no way to panic on demand, so a hand-built
    // module stands in: its parse traps on `unreachable` (what a Rust panic
    // compiles to) when the source starts with "T". An out-of-bounds pointer
    // would be the cheaper trap, but V8's signal-based bounds trap hangs
    // Node 22 on this macOS instead of throwing.
    afterAll(async () => {
      await initParser(committedArtifact());
    });

    it('throws with the panic message, then serves the next call from a fresh instance', async () => {
      await initParser(trappingModule());
      expect(callJson('parse_expression', 'ok', [3])).toEqual({ ok: true });
      const before = parserGeneration();
      expect(() => callJson('parse_expression', 'T', [3])).toThrow(
        /^movement parser crashed in parse_expression: RuntimeError: unreachable: panicked at src\/lib\.rs:1:1:\nboom$/,
      );
      expect(callJson('parse_expression', 'ok', [3])).toEqual({ ok: true });
      expect(parserGeneration()).toBe(before + 1);
    });
  });
});

/** A committed artifact: the API's (`movement.wasm`, the parser and the
 *  engine) unless named. */
function committedArtifact(file = 'movement.wasm'): Uint8Array {
  const fs = require('fs');
  if (typeof fs !== 'object' || fs === null || !('readFileSync' in fs) || typeof fs.readFileSync !== 'function') {
    throw new Error('no fs');
  }
  const bytes: unknown = fs.readFileSync(`${__dirname}/../${file}`);
  if (!ArrayBuffer.isView(bytes)) throw new Error('no bytes');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// The loader's ABI in miniature: a bump `alloc`, a no-op `dealloc`, one
// function behind all four parse exports that writes `{"ok":true}` to the
// out slots and returns status 0 — or hits `unreachable` on a leading "T" —
// one behind both lowering exports and the catalog's that always answers
// `{"ok":true}`, and a
// `last_panic` that points at a recorded panic message.
function trappingModule(): Uint8Array {
  const I32 = 0x7f;
  const json = [...'{"ok":true}'].map((c) => c.charCodeAt(0));
  const JSON_AT = 16;
  const panic = [...'panicked at src/lib.rs:1:1:\nboom'].map((c) => c.charCodeAt(0));
  // Below 64: a one-byte signed LEB128 i32.const.
  const PANIC_AT = 32;
  const vec = (items: number[][]): number[] => [items.length, ...items.flat()];
  // A section's length is unsigned LEB128: the export section is past 127 bytes.
  const leb = (n: number): number[] => (n < 0x80 ? [n] : [(n & 0x7f) | 0x80, ...leb(n >> 7)]);
  const section = (id: number, body: number[]): number[] => [id, ...leb(body.length), ...body];
  const name = (text: string): number[] => [text.length, ...[...text].map((c) => c.charCodeAt(0))];
  const fn = (index: number): number[] => [0x00, index];
  const body = (code: number[]): number[] => [code.length + 2, 0x00, ...code, 0x0b];
  const types = vec([
    [0x60, 1, I32, 1, I32], // alloc(len) -> ptr
    [0x60, 2, I32, I32, 0], // dealloc(ptr, len)
    [0x60, 5, I32, I32, I32, I32, I32, 1, I32], // parse(src, len, version, out_ptr, out_len) -> status
    [0x60, 6, I32, I32, I32, I32, I32, I32, 1, I32], // lower(tree, len, src, len, out_ptr, out_len) -> status
  ]);
  const exports = vec([
    [...name('memory'), 0x02, 0],
    [...name('alloc'), ...fn(0)],
    [...name('dealloc'), ...fn(1)],
    [...name('parse_program'), ...fn(2)],
    [...name('parse_program_eager'), ...fn(2)],
    [...name('parse_expression'), ...fn(2)],
    [...name('parse_nested_call'), ...fn(2)],
    [...name('last_panic'), ...fn(3)],
    [...name('lower_expression'), ...fn(4)],
    [...name('lower_condition'), ...fn(4)],
    [...name('catalog_query'), ...fn(4)],
  ]);
  const code = vec([
    // ptr = next; next += len
    body([0x23, 0, 0x23, 0, 0x20, 0, 0x6a, 0x24, 0]),
    body([]),
    body([
      ...[0x20, 0, 0x2d, 0, 0, 0x41, 0xd4, 0x00, 0x46, 0x04, 0x40, 0x00, 0x0b], // if src[0] == 'T' { unreachable }
      ...[0x20, 3, 0x41, JSON_AT, 0x36, 2, 0], // *out_ptr = JSON_AT
      ...[0x20, 4, 0x41, json.length, 0x36, 2, 0], // *out_len = json.length
      ...[0x41, 0], // status 0
    ]),
    body([
      ...[0x20, 0, 0x41, PANIC_AT, 0x36, 2, 0], // *out_ptr = PANIC_AT
      ...[0x20, 1, 0x41, panic.length, 0x36, 2, 0], // *out_len = panic.length
    ]),
    body([
      ...[0x20, 4, 0x41, JSON_AT, 0x36, 2, 0], // *out_ptr = JSON_AT
      ...[0x20, 5, 0x41, json.length, 0x36, 2, 0], // *out_len = json.length
      ...[0x41, 0], // status 0
    ]),
  ]);
  return new Uint8Array([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, types),
    ...section(3, vec([[0], [1], [2], [1], [3]])),
    ...section(5, vec([[0x00, 1]])),
    ...section(6, vec([[I32, 1, 0x41, 0x80, 0x02, 0x0b]])), // mut next = 256
    ...section(7, exports),
    ...section(10, code),
    ...section(
      11,
      vec([
        [0, 0x41, JSON_AT, 0x0b, json.length, ...json],
        [0, 0x41, PANIC_AT, 0x0b, panic.length, ...panic],
      ]),
    ),
  ]);
}
