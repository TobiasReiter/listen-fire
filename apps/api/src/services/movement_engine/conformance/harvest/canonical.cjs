// The harvest's dedupe key: must stay identical to `canonicalJson` in
// packages/engine-contracts/conformance/recording.ts.
function canonical(value) {
  return JSON.stringify(value, (_key, member) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return member;
    return Object.fromEntries(
      Object.entries(member)
        .filter(([, field]) => field !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

module.exports = { canonical };
