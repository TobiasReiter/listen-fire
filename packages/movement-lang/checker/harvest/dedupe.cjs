// Split from build_fixture.cjs so the dedupe rule is testable without a harvest.
// Must stay identical to `canonical` in parser/expression/__test__/lowering_fixture.ts.
function canonical(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

const beats = (a, b) => {
  if (Boolean(a.note) !== Boolean(b.note)) return Boolean(a.note);
  return canonical(a) < canonical(b);
};

module.exports = { canonical, beats };
