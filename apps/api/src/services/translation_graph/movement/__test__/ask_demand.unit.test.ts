// The DEMAND-SCOPED compile path over the ask adapter (2026-07-30).
//
// `generic_landings.unit.test.ts` next door describes the adapter's WHOLE
// surface up front, so it proves the graft and nothing about demand. The live
// save path never does that: it describes only what the program's text names
// plus the closure along the program's chains, and a type nobody demanded
// projects UNDESCRIBED — the checker then refuses every read on it.
//
// This file is that loop (the real `demandSeed` / `closeDemandOverChains` /
// projection over the real `AskAdapter`, one describe per demanded type), so a
// landing the closure fails to reach is an error here rather than a save-time
// surprise. It is the regression that motivated it: per-family Response types
// (`Check Response`) stopped appearing verbatim in program text, the accidental
// substring match that had been carrying them died, and the chain closure had
// never seen an `await` at all — so EVERY ask family's base answer read
// `MOV_UNDESCRIBED_POSITION`.

import {
  parseProgram,
  checkProgram,
  fromCatalogSnapshot,
  scanInstanceChains,
  type CatalogSnapshot,
  type InstanceSchema,
} from 'movement-lang';
import { AskAdapter } from '../../adapters/ask';
import { instanceSchemaFromDescriptors } from '../schema_projection';
import { graftGenericLandings } from '../generic_landings';
import { closeDemandOverChains, demandSeed } from '../demand';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { SchemaTypeDescriptor } from '../../types';

const PRELUDE = 'import { questions } from adapters\nqa = questions()\n';

const programFor = (body: string): string => `${PRELUDE}\nmovement m() {\n${body}\n}`;

/**
 * The catalog's inner loop, verbatim in shape: seed the demand set from the
 * program text, describe ONLY what it holds, project, close over the chains,
 * repeat until a round adds nothing. Then the construction-site graft, which
 * runs over the same chains once the schema has settled.
 */
async function demandScopedSchema(body: string): Promise<InstanceSchema> {
  const adapter = new AskAdapter('team-1' as TeamId);
  const entries = await adapter.listEntryPoints();
  const source = programFor(body);
  const chains = scanInstanceChains(source);
  const demanded = demandSeed({ entries, sources: [source] });
  const typeIdByName = new Map(entries.map((e) => [e.displayName, e.typeId]));

  let projection = instanceSchemaFromDescriptors({
    adapterType: 'ask',
    entries,
    descriptors: new Map(),
    supportsInPlaceUpdate: true,
  });
  for (let round = 0; round < 8; round++) {
    const descriptors = new Map<string, SchemaTypeDescriptor>();
    for (const typeId of demanded) {
      const descriptor = await adapter.describe(typeId);
      if (descriptor) descriptors.set(typeId, descriptor);
    }
    projection = instanceSchemaFromDescriptors({
      adapterType: 'ask',
      entries,
      descriptors,
      supportsInPlaceUpdate: true,
    });
    let grew = false;
    for (const name of closeDemandOverChains({ schema: projection.schema, chains })) {
      const demand = typeIdByName.get(name) ?? name;
      if (!demanded.has(demand)) {
        demanded.add(demand);
        grew = true;
      }
    }
    if (!grew) break;
  }

  return graftGenericLandings({
    instance: { adapterType: 'ask', schema: projection.schema, entryPoints: entries },
    chains,
  }).schema;
}

async function codesFor(body: string): Promise<string[]> {
  const snapshot: CatalogSnapshot = {
    adapters: {
      questions: { constructionArgs: [], schemas: { '': await demandScopedSchema(body) } },
    },
    credentials: {},
    plugins: {},
  };
  return checkProgram(parseProgram(programFor(body)), fromCatalogSnapshot(snapshot))
    .filter((d) => (d.severity ?? 'error') === 'error')
    .map((d) => d.code);
}

describe('an awaited landing is demanded because the program AWAITS it', () => {
  it("a bare Check's answer is a boolean the checker can read and test", async () => {
    const CHECK = '  a = write qa-[:Check]-> { Prompt: "Ship it?" }\n  cr = await FIRST(a-[:Response]->)';
    expect(await codesFor(`${CHECK}\n  if cr.Answer { }`)).toEqual([]);
    // The proof it is TYPED, not merely tolerated: the base landing is a
    // boolean, so arithmetic on it is the category error — never the "nobody
    // described this" error that the regression produced.
    const arithmetic = await codesFor(`${CHECK}\n  if cr.Answer + 1 > 2 { }`);
    expect(arithmetic).not.toContain('MOV_UNDESCRIBED_POSITION');
    expect(arithmetic.length).toBeGreaterThan(0);
  });

  it('every family whose landing no literal fixes is still reached', async () => {
    // None of these bodies carry the literals the construction-site graft needs
    // (that graft synthesizes the position locally and would MASK the hole), so
    // each depends entirely on the awaited chain demanding the base landing.
    const bodies: Record<string, string> = {
      Check: '{ Prompt: "?" }',
      Review: '{ Prompt: "?" }',
      Draft: '{ Prompt: "?" }',
      Form: '{ Prompt: "?", Fields: ["Name", "Email"] }',
    };
    for (const [family, body] of Object.entries(bodies)) {
      const codes = await codesFor(
        `  a = write qa-[:${family}]-> ${body}\n  r = await FIRST(a-[:Response]->)\n  x = r.Answer`,
      );
      expect({ family, codes }).toEqual({ family, codes: [] });
    }
  });

  it('a dynamic-options Choose lands the BASE text answer — undecidable, not undescribed', async () => {
    const codes = await codesFor(
      '  o = "Seed"\n  c = write qa-[:Choose]-> { Prompt: "Which?", Options: [o] }\n' +
        '  r = await FIRST(c-[:Response]->)\n  answer = COALESCE(r.Answer, "")\n' +
        '  if answer == "anything at all" { }',
    );
    expect(codes).toEqual([]);
  });

  it('the construction-site graft still wins where the write fixes the type', async () => {
    const CHOOSE =
      '  c = write qa-[:Choose]-> { Prompt: "Which?", Options: ["Seed", "Series A"] }\n' +
      '  r = await FIRST(c-[:Response]->)';
    expect(await codesFor(`${CHOOSE}\n  if r.Answer { }`)).toEqual([]);
    expect(await codesFor(`${CHOOSE}\n  if r.Answer == "Seed" { }`)).not.toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
    expect(await codesFor(`${CHOOSE}\n  if r.Answer == "Sead" { }`)).toContain(
      'MOV_ENUM_UNKNOWN_VALUE',
    );
  });

  it("a race arm's await is demanded too — an arm is program the run executes", async () => {
    const codes = await codesFor(
      '  r = race(\n' +
        '    () => {\n      a = write qa-[:Check]-> { Prompt: "Ship it?" }\n      return await FIRST(a-[:Response]->)\n    },\n' +
        '    () => { await sleep(2d) },\n' +
        '  )',
    );
    expect(codes).toEqual([]);
  });
});
