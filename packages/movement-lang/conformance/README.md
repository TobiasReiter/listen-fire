# The language conformance kit

A checker conforms to the movement language when, handed the same program,
catalog snapshot and language version, it reports the same diagnostics. This
kit is the corpus that says what "the same" is, and a runner that replays it.

## Run it

```bash
# our corpus: every program the test suites check (assemble it first, below)
pnpm checks:corpus
pnpm language:conformance target/checks/checks.json

# your own corpus, in the same format
pnpm language:conformance path/to/checks.json --snapshots path/to/checks.snapshots.json
```

- Paths are read relative to where you run the command.
- `--snapshots` defaults to the corpus's sibling `<name>.snapshots.json`.
- It prints how many records replayed and drifted, then up to 20 drifted
  records (version, the start of the source, the pinned and current
  diagnostics).
- It exits 0 when nothing drifted, 1 otherwise.

The loader, the replay and the comparison are `checks_corpus.ts` here; the
checker regression test (`checker/__test__/checks_regression.unit.test.ts`)
runs the same replay over ours, when run with `CHECKS_CORPUS=1` after
`pnpm checks:corpus`.

## The corpus format

Two files of JSON lines.

`checks.json`, one record per line:

```ts
{
  source: string;          // the program text
  snapshot: string;        // the key of its catalog snapshot (below)
  version: number;         // the language version it is checked under
  parseVersion?: number;   // present when the test parsed under another version
  upgradingFrom?: number;  // present when checked as an upgrade from that version
  diagnostics: unknown[];  // the full diagnostics, in the order the checker reported them
  note?: string;           // why the snapshot cannot express the test's catalog; not replayed
  file?: string;           // the test the record came from, kept on noted records
}
```

`checks.snapshots.json`, one `{ key, snapshot }` per line. `snapshot` is a
catalog snapshot (`docs/contracts/catalog-snapshot.md`), and `key` is the
sha256 of its canonical JSON (keys sorted at every level, undefined members
dropped).

## The comparison

- A record's diagnostics and the checker's are compared as canonical JSON.
- Order is part of it: a checker must report diagnostics in the order the
  corpus pins. The ordering rule is not yet written down as a contract (an
  open deferred item), so today the order is the TypeScript checker's.
- A snapshot keeps the key order its catalog answered in, because a schema's
  field order reaches diagnostic messages ("it has: Title, Colour"). A reader
  must not sort schema keys.
- A record with a `note` is evidence, not a pin, and is never replayed.

## Making a corpus

- Ours is harvested from the test suites (see `checker/harvest/`).
- Its pin (`checker/__test__/__fixtures__/checks/`, see `checks_pin.ts`)
  holds no program text: each check names its program by a hash of the text,
  and its diagnostics by key in its version's table. The text lives in the
  test that checks it.
- `pnpm checks:corpus` in `packages/movement-lang` harvests the texts and
  writes the corpus, in the format above, to `target/checks/checks.json`
  (with `checks.snapshots.json` beside it). It then holds every pinned check
  with its text, or the command fails naming the checks it could not find.
- To pin a ruling or a fix, re-harvest (`pnpm harvest:checks`), or set
  `UPDATE_CHECKS_FIXTURE=1 CHECKS_CORPUS=1` on the checker regression test
  after `pnpm checks:corpus`, and read the diff.

## The other files here

`resolver.cjs`, `v1.setup.cjs`, `v2.setup.cjs` and `triage.setup.cjs` run an
older release's own tests verbatim under that release's language version. See
each file's header.

The host conformance kit (recorded engine runs) and the adapter kit are
described in [`docs/contracts/README.md`](../../../docs/contracts/README.md).
