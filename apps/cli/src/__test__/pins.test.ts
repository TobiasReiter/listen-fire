// lf runs on the Rust engine alone, which runs language version 5 and later:
// a pin below 5 is refused by name, with what to do, before any engine sees it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_LANGUAGE_VERSION } from 'movement-lang';
import { FIRST_LF_LANGUAGE_VERSION, loadProject, refuseBelowLf } from '../project';
import { project } from './example';

test('a pin below 5 is refused, saying to run lf upgrade', () => {
  for (const version of [1, 2, 3, 4]) {
    assert.throws(
      () => refuseBelowLf(version, { pinned: 'lf.yaml', remedy: 'run `lf upgrade`' }),
      new RegExp(`^Error: lf\\.yaml is pinned to language version ${version}, which lf does not run \\(lf runs language version 5 and later\\): run \`lf upgrade\`$`),
    );
  }
});

test('5 and later pass', () => {
  assert.equal(FIRST_LF_LANGUAGE_VERSION, 5);
  for (const version of [5, CURRENT_LANGUAGE_VERSION]) refuseBelowLf(version, { pinned: 'lf.yaml', remedy: 'run `lf upgrade`' });
});

test('a project this lf writes loads at the current version', () => {
  assert.equal(loadProject(project()).languageVersion, CURRENT_LANGUAGE_VERSION);
});
