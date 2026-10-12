// chunks.json: `CHUNKS`'s cut as movement-lang's own chunk.ts makes it
// (`readChunkSpec`, `chunkText`) and density.ts's estimate of each piece,
// which tests/chunks_oracle.rs holds crates/movement-engine/src/chunks.rs to.
//
// Henry's ruling (2026-10-12): the size mode is compared exactly, on any text
// (surrogate pairs and lone halves included); the entities mode, whose
// `\p{Lu}`/`\p{L}`/`\p{N}` the Rust engine reads from its own tables, on ASCII
// text only. Each case is a seeded text, the options as a run worked them out,
// and either the error sentence or the pieces with each one's estimate.
// Written by generate.ts; deterministic.

import { chunkText, readChunkSpec } from '../../../../packages/movement-lang/expression/chunk';
import { estimateEntities } from '../../../../packages/movement-lang/expression/density';

type Rand = () => number;

const ASCII_LINES = [
  'Acme Corp raised a seed round from Example Ventures.',
  'See https://acme.com/about and www.beta.io for more.',
  '- Jane Doe, CEO',
  '* item two',
  '12) numbered entry',
  '[src] Tagged Line Here',
  '',
  '   ',
  'plain prose with no names at all',
  'Visit Acme.co.uk, acme.community, and HTTP://Gamma.dev/x?y=1.',
  'Ada Lovelace and Grace Hopper met Alan Turing in Bletchley Park',
  'e.g. Inc. v1.2.3 are not links',
  '\tindented text\twith tabs',
  'a'.repeat(120),
  'Word Word word Word Word',
];

const OTHER_LINES = ['Zoë Ölund met Ærø Group', '😀 emoji 😀 pair', 'lone \ud800 half', 'Σίσυφος Ltd'];

export function chunksCases(rand: Rand): unknown[] {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const text = (lines: readonly string[]) => {
    const n = 1 + Math.floor(rand() * 12);
    return Array.from({ length: n }, () => pick(lines)).join(pick(['\n', '\n', '\n\n', '\n \n', ' ']));
  };
  const cases: unknown[] = [];
  const cuts: unknown[] = [
    { size: 1 }, { size: 7 }, { size: 20 }, { size: 33.9 }, { size: 80, overlap: 10 }, { size: 5, overlap: 4 }, { size: 64, overlap: 3 },
    { entities: 1 }, { entities: 2, overlap: 30 }, { entities: 3 }, { entities: 1, overlap: 200 }, { entities: 5.5 },
  ];
  const refusals: unknown[] = [
    { size: 5, overlap: 5 }, { size: 0 }, { size: -1 }, { size: '10' }, { size: null }, { entities: 0 }, { size: 10, entities: 2 },
    {}, { size: 10, overlap: -1 }, { size: 10, overlap: 'x' }, { entities: true },
  ];
  for (let i = 0; i < 600; i++) {
    const asked = pick(rand() < 0.85 ? cuts : refusals) as { size?: unknown; entities?: unknown; overlap?: unknown };
    const entitiesMode = asked.entities !== undefined;
    const value = text(entitiesMode ? ASCII_LINES : [...ASCII_LINES, ...OTHER_LINES]);
    const read = readChunkSpec(asked);
    if ('error' in read) {
      cases.push({ text: value, options: asked, error: read.error });
      continue;
    }
    const pieces = chunkText(value, read.spec);
    cases.push({
      text: value,
      options: asked,
      pieces,
      ...(read.spec.mode === 'entities' ? { estimates: pieces.map((p) => estimateEntities(p)) } : {}),
    });
  }
  return cases;
}

export function writeChunksOracle(rand: Rand, write: (name: string, text: string) => void): void {
  const cases = chunksCases(rand);
  write('chunks.json', `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`);
  console.log(`chunks.json: ${cases.length} cases`);
}
