// Skips the corpus tests a version's triage list rules out.
//
// A corpus is an older release's tests verbatim, so a test that asserted an
// internal shape that has since been refactored — with no difference an author
// could see through validate, run, story or MCP output — cannot be edited to
// match. It is listed instead, by file and title, with its reason, in
// `__conformance__/v<n>/triage.cjs` beside the corpus, and skipped here (a
// table-driven one by its title template: all its rows, or with `rows` — a
// predicate on a row — only the rows it picks). An entry marked
// `wholeFile: true` (no `test`) rules out a file that cannot load at all; it is
// ignored by the jest config (`triage_files.cjs`), not here. A list
// entry that names no test in its file fails the run, so the list cannot rot.
const path = require('path');

const CORPUS_ROOT = /^(.*[\\/]__conformance__[\\/]v\d+)[\\/](.*)$/;

const testPath = expect.getState().testPath;
const match = testPath && testPath.match(CORPUS_ROOT);
if (match) {
  const [, root, relative] = match;
  const file = relative.split(path.sep).join('/');
  const { triage } = require(path.join(root, 'triage.cjs'));
  const entries = triage.filter((entry) => entry.file === file && !entry.wholeFile);
  const ruledOut = new Set(entries.filter((entry) => entry.rows === undefined).map((entry) => entry.test));
  const ruledRows = new Map();
  for (const entry of entries.filter((entry) => entry.rows !== undefined)) {
    ruledRows.set(entry.test, [...(ruledRows.get(entry.test) ?? []), entry.rows]);
  }
  if (entries.length > 0) {
    const seen = new Set();
    const wrap = (original) => {
      const wrapped = (name, ...rest) => {
        if (ruledOut.has(name)) {
          seen.add(name);
          return original.skip(name, ...rest);
        }
        return original(name, ...rest);
      };
      // A table-driven test or describe is named by its title template
      // (`'under language version %i, …'`), every row of it at once — or,
      // with `rows`, only the rows that predicate picks (a table over the
      // current release's versions whose newest row is not this version's).
      const each = (...table) => (name, ...rest) => {
        if (ruledOut.has(name)) {
          seen.add(name);
          return original.skip.each(...table)(name, ...rest);
        }
        const picks = ruledRows.get(name);
        if (picks !== undefined && table.length === 1 && Array.isArray(table[0])) {
          const ruled = table[0].filter((row) => picks.some((pick) => pick(row)));
          if (ruled.length > 0) {
            seen.add(name);
            original.skip.each(ruled)(name, ...rest);
            const kept = table[0].filter((row) => !ruled.includes(row));
            if (kept.length > 0) original.each(kept)(name, ...rest);
            return undefined;
          }
        }
        return original.each(...table)(name, ...rest);
      };
      return Object.assign(wrapped, original, { each });
    };
    global.it = wrap(global.it);
    global.test = wrap(global.test);
    global.describe = wrap(global.describe);
    afterAll(() => {
      const stale = [...ruledOut, ...ruledRows.keys()].filter((name) => !seen.has(name));
      if (stale.length > 0) {
        throw new Error(`triage.cjs names tests ${file} does not define: ${stale.join(' | ')}`);
      }
    });
  }
}
