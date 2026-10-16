// Every program the corpora (v1, v2 and the current tests — see ../harvest)
// hand the checker, with the catalog that check consulted (as a snapshot), the
// language version and the full diagnostics, in __fixtures__/checks.json; each
// record names its snapshot by key in __fixtures__/checks.snapshots.json. This
// is the Rust checker's conformance oracle: it checks the same sources against
// the same snapshots and must emit the same diagnostics, messages and order
// included. A pin changes only with a ruling.
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
// `pnpm language:conformance` over this corpus is this test.
//
// Set UPDATE_CHECKS_FIXTURE=1 to rewrite the pins from the current checker
// (after a re-harvest, or a ruling) — then read the diff.
import { canonical, replayChecks } from '../../conformance/checks_corpus';
import { checkNow, loadChecks as load, SNAPSHOT_TABLE, writeChecks } from './checks_fixture';

declare const process: { env: Record<string, string | undefined> };
declare function require(id: string): unknown;
declare const console: { warn(...args: unknown[]): void };

const KNOWN_VERSIONS = [1, 2, 3, 4, 5];

describe('checks regression', () => {
  if (process.env.UPDATE_CHECKS_FIXTURE) {
    writeChecks(load().map(r => (r.note ? r : { ...r, diagnostics: checkNow(r) })));
  }

  it('checks every pinned program against its snapshot exactly as pinned', () => {
    const pins = load();
    expect(pins.length).toBeGreaterThan(2000);
    // The language kit's own replay (`pnpm language:conformance`), over ours.
    expect(replayChecks(pins, SNAPSHOT_TABLE).drifted).toEqual([]);
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
    const named = new Set(load().map(r => r.snapshot));
    expect([...named].filter(key => !SNAPSHOT_TABLE.has(key))).toEqual([]);
    expect([...SNAPSHOT_TABLE.keys()].filter(key => !named.has(key))).toEqual([]);
  });

  it('reports any pinned version outside the known ones', () => {
    const odd = [...new Set(load().map(r => r.version).filter(v => !KNOWN_VERSIONS.includes(v)))];
    if (odd.length > 0) console.warn(`checks.json pins unexpected language versions: ${odd.join(', ')}`);
  });
});
