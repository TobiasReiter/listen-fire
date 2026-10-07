// Every expression text the corpora produce (expression_slots.json), pinned by
// the sha256 of the canonical tree it parses to (or by the error it throws), in
// __fixtures__/expression_trees.json. The lowering regression pins what a tree
// means; this pins the tree itself, offsets and spellings included. Recorded
// from the Rust grammar once the differential had shown it identical to the
// TypeScript one over these texts. A hash changes only with a ruling.
//
// Set UPDATE_EXPRESSION_TREES_FIXTURE=1 to rewrite the pins from the current
// parser (after a re-harvest, or a ruling) — then read the diff.
import { ExpressionSyntaxError, parseExpression } from '../parse_expression';
import { canonical, SLOTS } from './lowering_fixture';

declare function require(id: string): unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;

type TreeRecord = { raw: string; tree_sha256: string } | { raw: string; error: { message: string; offset: number } };

const FIXTURE = `${__dirname}/__fixtures__/expression_trees.json`;

const { createHash } = require('crypto') as {
  createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } };
};
const fs = require('fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
};

function parseNow(raw: string): TreeRecord {
  try {
    return { raw, tree_sha256: createHash('sha256').update(canonical(parseExpression(raw))).digest('hex') };
  } catch (e) {
    if (e instanceof ExpressionSyntaxError) return { raw, error: { message: e.message, offset: e.offset } };
    throw e;
  }
}

function load(): TreeRecord[] {
  return fs
    .readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as TreeRecord);
}

describe('expression trees regression', () => {
  if (process.env.UPDATE_EXPRESSION_TREES_FIXTURE) {
    fs.writeFileSync(FIXTURE, SLOTS.map(({ raw }) => JSON.stringify(parseNow(raw))).join('\n') + '\n');
  }

  it('pins every corpus expression text', () => {
    const pinned = new Set(load().map(pin => pin.raw));
    expect(SLOTS.filter(({ raw }) => !pinned.has(raw)).map(({ raw }) => raw)).toEqual([]);
  });

  it('parses every pinned text exactly as pinned', () => {
    const pins = load();
    expect(pins.length).toBeGreaterThan(1000);
    const drifted = pins
      .filter(pin => canonical(parseNow(pin.raw)) !== canonical(pin))
      .map(pin => JSON.stringify(pin.raw.slice(0, 120)));
    expect(drifted).toEqual([]);
  });
});
