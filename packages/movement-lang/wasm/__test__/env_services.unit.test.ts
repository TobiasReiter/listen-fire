// The WASM artifact's environment services (the loader's import) answer as
// the committed fixture says: the fixture the native implementation is held
// to (crates/movement-engine/tests/env_services.rs), so the two agree. A
// Node whose ICU or zone data moved fails here first; regenerate the
// fixture (crates/movement-engine/tests/env/generate.ts) and move the
// crate's jiff-tzdb pin with it.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { answerEnvRequest } from '../env_services';

const fixture: Array<{ request: unknown; answer: unknown }> = JSON.parse(
  readFileSync(path.join(__dirname, '../../../../crates/movement-engine/tests/env/fixture.json'), 'utf8'),
);

describe('the environment services', () => {
  it('answer every fixture request as recorded', () => {
    const differ = fixture.filter(({ request, answer }) => {
      const got = answerEnvRequest(request).value;
      return JSON.stringify(got) !== JSON.stringify(answer);
    });
    expect(fixture.length).toBeGreaterThan(5000);
    expect(differ.map((c) => c.request)).toEqual([]);
  });

  it('refuse a request they cannot read', () => {
    expect(() => answerEnvRequest({ op: 'nope' })).toThrow('no environment service nope');
    expect(() => answerEnvRequest({ op: 'normalize', text: 'x', form: 'NFX' })).toThrow('no normalisation form NFX');
  });
});
