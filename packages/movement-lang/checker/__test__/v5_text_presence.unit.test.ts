// A null test on a <text> field of a record the extraction call hands back
// (`extract` / `extractOne`): a text the model did not find is "", never
// absent, so the test can only ever answer one way. From version 5 it is
// refused (MOV_PRESENCE_TEST_ON_TEXT), as the keyword's result has been since
// 2; versions 3 and 4 let it through, so a move up across 5 is warned of. The
// Rust checker's twin is crates/movement-checker/tests/v5_text_presence.rs,
// same programs, same messages.

import { parseProgram } from '../../parser/parse';
import { checkProgram } from '../check';
import { mockCatalog } from '../catalog';
import type { LanguageVersion } from '../../language_version';

const catalog = mockCatalog({ adapters: {} });

function check(body: string, languageVersion: LanguageVersion, upgradingFrom?: LanguageVersion): Array<[string, string, string]> {
  const source = `node Found: "the extraction" {
  title: <text> "the title"
  maybe: <text | null> "a title, if any"
  size: <number> "how many"
  node item: "each item" {
    label: <text> "its label"
  }
}
function go(t: <text>) {
  r = extractOne([t], Found)
${body}
}
`;
  return checkProgram(parseProgram(source, { languageVersion }), catalog, {
    languageVersion,
    ...(upgradingFrom !== undefined ? { upgradingFrom } : {}),
  })
    .filter((d) => d.code === 'MOV_PRESENCE_TEST_ON_TEXT')
    .map((d) => [d.code, d.severity ?? 'error', d.message]);
}

const REFUSED = (label: string, verdict: string, fix: string) =>
  `'${label}' is extracted text, and a text the model did not find is "" — never absent — so testing it for null is ${verdict}. Annotate it \`<text | null>\` to keep the null test, or test whether it is empty instead: ${fix}.`;

describe('under version 5', () => {
  it('a null test on a <text> field is refused, naming the emptiness test', () => {
    expect(check('  if (r != null) {\n    if (r.title != null) { }\n  }', 5)).toEqual([
      ['MOV_PRESENCE_TEST_ON_TEXT', 'error', REFUSED('r.title', 'always true', '`r.title != ""` (or `Text.length(r.title) > 0`)')],
    ]);
    expect(check('  if (r != null) {\n    if (r.title == null) { }\n  }', 5)).toEqual([
      ['MOV_PRESENCE_TEST_ON_TEXT', 'error', REFUSED('r.title', 'always false', '`r.title == ""`')],
    ]);
  });

  it('a nested node\'s <text> field is refused the same way', () => {
    expect(check('  if (r != null) {\n    r-[i:item]-> { if (i.label == null) { } }\n  }', 5)).toEqual([
      ['MOV_PRESENCE_TEST_ON_TEXT', 'error', REFUSED('i.label', 'always false', '`i.label == ""`')],
    ]);
  });

  it('a `<text | null>` field and a typed one may still be tested', () => {
    expect(check('  if (r != null) {\n    if (r.maybe != null) { }\n    if (r.size == null) { }\n  }', 5)).toEqual([]);
  });
});

describe('a record that may not be there', () => {
  it('reads `text | absent`, so the test says something and is let through', () => {
    expect(check('  if (r.title != null) { }', 5)).toEqual([]);
  });
});

describe('under version 4', () => {
  it('the test is let through, as it always was', () => {
    expect(check('  if (r != null) {\n    if (r.title != null) { }\n    r-[i:item]-> { if (i.label == null) { } }\n  }', 4)).toEqual([]);
  });
});

describe('on a move up from 4 to 5', () => {
  it('the test is an upgrade warning, which holds the pin', () => {
    expect(check('  if (r != null) {\n    if (r.title != null) { }\n  }', 5, 4)).toEqual([
      [
        'MOV_PRESENCE_TEST_ON_TEXT',
        'warning',
        'since "Dancing Wren" (5) a null test on \'r.title\' is refused: it is extracted text, and a text the model did not find is "" — never absent — so the test was always true. Annotate it `<text | null>` to keep the null test, or test whether it is empty instead: `r.title != ""` (or `Text.length(r.title) > 0`), then upgrade.',
      ],
    ]);
  });
});
