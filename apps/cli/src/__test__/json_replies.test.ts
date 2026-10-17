// The model replies lf's reader is held to. A reply the model wrapped,
// truncated or got slightly wrong is read by the TypeScript engine's
// parseJsonReply (over the npm jsonrepair); lf reads it in Rust (over the
// jsonrepair crate). The fixture pairs each reply with the TypeScript
// reading: this test holds the fixture to the TypeScript engine, and a cargo
// test (crates/lf/src/llm_calls.rs) holds lf to the fixture.
//
// Adding a case: append `{ "reply": "…" }` to the fixture and run this test
// with LF_UPDATE_FIXTURES=1, which writes every case's reading.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseJsonReply } from 'movement-engine/lib/utils/parse_json';

const FIXTURE = path.resolve(__dirname, '../../../../crates/lf/src/testdata/json_replies.json');

interface Case {
  reply: string;
  /** The reading, as JSON.stringify writes it. */
  parsed?: string;
}

test('each reply in the fixture reads as the TypeScript engine reads it', () => {
  const cases = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Case[];
  const read = cases.map((c) => ({ reply: c.reply, parsed: JSON.stringify(parseJsonReply(c.reply)) }));
  if (process.env.LF_UPDATE_FIXTURES === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify(read, null, 2)}\n`);
    return;
  }
  assert.deepEqual(cases, read);
});
