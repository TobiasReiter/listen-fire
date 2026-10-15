// The corpus files a version's triage rules out whole (`wholeFile: true`, no
// `test`): files that cannot even load, because they mock modules the current
// code has replaced. Jest never opens them, so the run lists no tests for them.
const path = require('path');

const ignoredPaths = (corpusRoot) => {
  const { triage } = require(path.join(corpusRoot, 'triage.cjs'));
  return triage
    .filter((entry) => entry.wholeFile)
    .map((entry) => path.join(corpusRoot, entry.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
};

module.exports = { ignoredPaths };
