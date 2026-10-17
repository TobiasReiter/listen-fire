// Every program the corpora (the v1 to v4 conformance suites, this package's
// tests and the engine's — see ../harvest) hand the checker, with the catalog
// that check consulted (as a snapshot), the language version and the full
// diagnostics, pinned in __fixtures__/checks/ (one pair of files per version)
// with each program named by the hash of its text; each check names its
// snapshot by key in __fixtures__/checks.snapshots.json. This is the Rust
// checker's conformance oracle: it checks the same sources against the same
// snapshots and must emit the same diagnostics, messages and order included.
// A pin changes only with a ruling.
//
// The pin holds no program text (it lives in the tests; the harvest finds it
// there; the few programs no test writes any more are the one exception,
// ../../conformance/checks_pin.ts), so the replay runs over the corpus the harvest assembles:
// `pnpm checks:corpus` harvests, assembles, and runs this file with
// CHECKS_CORPUS=1. Without it, only the pin's own consistency is checked.
//
// The replay goes through `fromCatalogSnapshot`, so a record that drifts here
// while the checker is unchanged is a harvest that recorded the wrong catalog.
// Schema field order is observable in diagnostic messages ("it has: Title,
// Colour"), so the stored snapshots keep the order the catalog answered in and
// neither side may sort schema keys (the Rust catalog types included).
//
// `parseVersion` is present when the test parsed under a different version
// than it checked (a test passing `languageVersion` to one call and not the
// other); the replay parses under it, so the Program is the one the test had.
//
// A record carrying a `note` is one whose catalog no snapshot can express (the
// note says why); it is kept, as evidence, but not replayed.
//
// The replay is the language kit's (../../conformance/checks_corpus.ts), so
// `pnpm language:conformance` over the assembled corpus is this test.
//
// Set UPDATE_CHECKS_FIXTURE=1 (with CHECKS_CORPUS=1) to rewrite the pins from
// the current checker (after a ruling) — then read the diff.
import { canonical, replayChecks } from '../../conformance/checks_corpus';
import { overCorpus, pinnedVersions, readPin, readPinnedVersion, type PinnedCheck } from '../../conformance/checks_pin';
import { checkNow, loadChecks as load, SNAPSHOT_TABLE, writeChecks } from './checks_fixture';

declare const process: { env: Record<string, string | undefined> };
declare function require(id: string): unknown;
declare const console: { warn(...args: unknown[]): void };

const KNOWN_VERSIONS = [1, 2, 3, 4, 5];

let pinned: PinnedCheck[] | undefined;
const pin = (): PinnedCheck[] => (pinned ??= readPin());

describe('checks regression', () => {
  if (process.env.UPDATE_CHECKS_FIXTURE) {
    if (!overCorpus()) throw new Error('UPDATE_CHECKS_FIXTURE needs the assembled corpus: run it with CHECKS_CORPUS=1 after `pnpm checks:corpus`');
    writeChecks(load().map(r => (r.note ? r : { ...r, diagnostics: checkNow(r) })));
  }

  (overCorpus() ? it : it.skip)('checks every pinned program against its snapshot exactly as pinned', () => {
    const pins = load();
    // The corpus is the pin with its texts: every pinned check, none other.
    expect(pins.length).toBe(pin().length);
    expect(pins.length).toBeGreaterThan(2000);
    // The language kit's own replay (`pnpm language:conformance`), over ours.
    expect(replayChecks(pins, SNAPSHOT_TABLE).drifted).toEqual([]);
  });

  it('files each check under its version, names its program by hash, and keeps no unnamed diagnostics', () => {
    const versions = pinnedVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      const { checks, unused, misfiled } = readPinnedVersion(version);
      expect({ version, misfiled, unused }).toEqual({ version, misfiled: [], unused: [] });
      expect(checks.filter(c => !/^[0-9a-f]{64}$/.test(c.program))).toEqual([]);
    }
    expect(pin().length).toBeGreaterThan(2000);
  });

  it('keys every snapshot by the sha256 of its canonical form, as the harvest does', () => {
    // A hand edit to a snapshot that keeps its old key would leave two
    // catalogs able to share one key; the harvest never writes one. A second
    // key order of one catalog is keyed by the hash of its recorded form, and
    // only beside the first order under the canonical key.
    const crypto = require('crypto') as { createHash(algorithm: 'sha256'): { update(text: string): { digest(encoding: 'hex'): string } } };
    const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
    const drifted = [...SNAPSHOT_TABLE.entries()]
      .filter(([key, snapshot]) => {
        const byCanonical = sha(canonical(snapshot));
        if (byCanonical === key) return false;
        return !(sha(JSON.stringify(snapshot)) === key && SNAPSHOT_TABLE.has(byCanonical));
      })
      .map(([key]) => key);
    expect(drifted).toEqual([]);
  });

  it('names only snapshots the table holds, and the table holds no others', () => {
    const named = new Set(pin().map(r => r.snapshot));
    expect([...named].filter(key => !SNAPSHOT_TABLE.has(key))).toEqual([]);
    expect([...SNAPSHOT_TABLE.keys()].filter(key => !named.has(key))).toEqual([]);
  });

  it('reports any pinned version outside the known ones', () => {
    const odd = pinnedVersions().filter(v => !KNOWN_VERSIONS.includes(v));
    if (odd.length > 0) console.warn(`the checks pin holds unexpected language versions: ${odd.join(', ')}`);
  });
});
