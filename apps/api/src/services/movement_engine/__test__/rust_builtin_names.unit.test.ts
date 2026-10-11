// The Rust engine's list of the flat built-ins (crates/movement-engine/src/
// stdlib.rs `FLAT` and `FORMS`), held to the standard library the checker
// and the TypeScript engine read (`lookupBuiltin`): admission tells an
// integration's function from a built-in by it, and a file-level call reads
// as a built-in's value by it.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { flatBuiltinNames } from 'movement-lang/checker/standard_library';

const STDLIB = path.join(__dirname, '../../../../../../crates/movement-engine/src/stdlib.rs');

function listed(source: string, name: string): string[] {
  const match = new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`).exec(source);
  if (match === null) throw new Error(`stdlib.rs has no ${name} list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the Rust engine's flat built-in names", () => {
  it("are the standard library's, every one once", () => {
    const source = readFileSync(STDLIB, 'utf8');
    const rust = [...listed(source, 'FLAT'), ...listed(source, 'FORMS')];
    expect(new Set(rust).size).toBe(rust.length);
    expect([...rust].sort()).toEqual(flatBuiltinNames().map((name) => name.toLowerCase()).sort());
  });
});
