// Skips the corpus tests a version's triage list rules out.
//
// A corpus is an older release's tests verbatim, so a test that asserted an
// internal shape that has since been refactored — with no difference an author
// could see through validate, run, story or MCP output — cannot be edited to
// match. It is listed instead, by file and title, with its reason, in
// `__conformance__/v<n>/triage.cjs` beside the corpus, and skipped here (a
// table-driven one by its title template, all its rows). A list
// entry that names no test in its file fails the run, so the list cannot rot.
const path = require('path');

const CORPUS_ROOT = /^(.*[\\/]__conformance__[\\/]v\d+)[\\/](.*)$/;

const testPath = expect.getState().testPath;
const match = testPath && testPath.match(CORPUS_ROOT);
if (match) {
  const [, root, relative] = match;
  const file = relative.split(path.sep).join('/');
  const { triage } = require(path.join(root, 'triage.cjs'));
  const ruledOut = new Set(triage.filter((entry) => entry.file === file).map((entry) => entry.test));
  if (ruledOut.size > 0) {
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
      // (`'under language version %i, …'`), every row of it at once.
      const each = (...table) => (name, ...rest) => {
        if (ruledOut.has(name)) {
          seen.add(name);
          return original.skip.each(...table)(name, ...rest);
        }
        return original.each(...table)(name, ...rest);
      };
      return Object.assign(wrapped, original, { each });
    };
    global.it = wrap(global.it);
    global.test = wrap(global.test);
    global.describe = wrap(global.describe);
    afterAll(() => {
      const stale = [...ruledOut].filter((name) => !seen.has(name));
      if (stale.length > 0) {
        throw new Error(`triage.cjs names tests ${file} does not define: ${stale.join(' | ')}`);
      }
    });
  }
}
