// Reachability: no program the checker passes reaches an engine refusal.
//
// The Rust engine has no admission (Henry, 2026-10-16): the checker is the
// one gate before a version-5 run, so a construct the engine does not run
// must be refused at save. This runs every version-5 program the repository
// holds through the real entry (the Rust checker, then the Rust engine,
// through the shim) against a host that answers everything plainly, and fails
// on any run the check passed that then ends in:
//   - MOVENG_UNSUPPORTED (the engine refusing a construct by name), or
//   - a failure that says "the checker should have caught this", or
//   - a shim fault (an input the eval wire cannot carry).
// Any other ending (a field the plain host leaves empty, a park with nowhere
// to go) is the host's answer, not a reachability gap.
//
// The programs:
//   - the checks corpus's version-5 records: every program the language's and
//     the engine's tests hand the checker, harvested. The pin holds no program
//     text, so this runs over the corpus the harvest assembles
//     (`pnpm checks:corpus` in packages/movement-lang runs it, with
//     CHECKS_CORPUS=1);
//   - the engine oracles' programs (crates/movement-engine/tests/oracle:
//     records, handles, parallel and patterns), each respelled to version 5
//     by the upgrade tool's own rewrites.
// A program whose check fails ends at MOVENG_CHECK and is counted apart.

import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import { fromCatalogSnapshot, parseProgram, resolveFileFromSnapshot, typeNameOf, type CatalogSnapshot } from 'movement-lang';
import { loadChecks, loadSnapshots } from 'movement-lang/conformance/checks_corpus';
import { corpusFile, overCorpus, SNAPSHOT_TABLE_FILE } from 'movement-lang/conformance/checks_pin';
import { spelledFor } from 'movement-lang/checker/__test__/surface_spelling';
import { tenantIdOf } from 'engine-contracts';

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';
import { containerAssociation } from 'movement-engine/services/translation_graph/adapter';
import { positionData } from 'movement-engine/services/translation_graph/types';
import { runMovement } from 'movement-engine/services/movement_engine/run';
import { resetRustRunStats, rustRunStats } from 'movement-engine/services/movement_engine/rust_stats';
import { credentialIdsFor, makeFakeParkSink, makeTestHost } from 'movement-engine/services/movement_engine/test_host';

import { KNOWN_GAPS, reasonOf } from './reachability_gaps';

const ROOT = path.resolve(__dirname, '../../../../../..');
const ORACLES = path.join(ROOT, 'crates/movement-engine/tests/oracle');
const TEAM = tenantIdOf('00000000-0000-0000-0000-0000000000ab');

interface Candidate {
  corpus: string;
  source: string;
  catalog: CatalogSnapshot;
}

/** An adapter of any type that answers every read plainly: a field reads
 *  what the event's payload holds, a search finds nothing, a write lands. */
function plainAdapter(adapterType: string): Adapter {
  let made = 0;
  return {
    adapterType,
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: true, edgeProperties: true }, resources: true }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = positionData(position);
      return typeof data === 'object' && data !== null ? Reflect.get(data, fieldId) : undefined;
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType, externalId: `${adapterType}-${++made}`, data: {} }),
    updateRecord: async (input) => ({ adapterType, externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

function plainHost() {
  return makeTestHost({
    adapters: { resolve: ({ adapterType }) => plainAdapter(adapterType) },
    llm: {
      client: { call: async () => ({ parsedJson: { value: 'an answer', has_value: true } }) },
      extractCall: { call: async () => ({ parsedJson: {}, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } }) },
      transforms: { invoke: async () => ({ text: 'a plugin answer' }) },
      arbitrateEntities: async () => ({ index: null }),
    },
    park: {
      sink: makeFakeParkSink().sink,
      callbacks: { mint: async ({ address }) => ({ id: `cb-${address}`, url: `https://callbacks.example/${address}` }), calls: async () => [] },
    },
    files: { resolveFileText: async () => ({ text: 'the text of a file', rawTextId: 'rt-1' }) },
    lookup: { resolveActingUser: async () => ({ id: 'user-1', email: 'ada@acme.example', name: 'Ada' }) },
  });
}

/** The functions a run of `source` may enter: each one a listen fires, or,
 *  with no listen, each one whose one parameter is typed against a system
 *  the file connects (what a listen could fire). */
function entriesOf(source: string): string[] {
  let program;
  try {
    program = parseProgram(source, { languageVersion: 5 });
  } catch {
    return [];
  }
  const fired = program.statements.flatMap((s) => (s.kind === 'listen' ? [s.movement] : []));
  if (fired.length > 0) return [...new Set(fired)];
  const connected = new Set(program.statements.flatMap((s) => (s.kind === 'assign' && s.value.kind === 'construct' ? [s.name] : [])));
  return program.statements.flatMap((s) => {
    if (s.kind !== 'movement' || s.params.length !== 1) return [];
    const type = typeNameOf(s.params[0]!.type);
    return type !== undefined && type.hopsRaw !== undefined && connected.has(type.graph) ? [s.name] : [];
  });
}

const isError = (d: { severity?: string }) => d.severity === undefined || d.severity === 'error';

function checksCorpus(): Candidate[] {
  const table = loadSnapshots(SNAPSHOT_TABLE_FILE);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const record of loadChecks(corpusFile())) {
    if (record.version < 5 || record.note !== undefined || record.upgradingFrom !== undefined) continue;
    if ((record.diagnostics as Array<{ severity?: string }>).some(isError)) continue;
    const key = `${record.snapshot}\u0000${record.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const catalog = table.get(record.snapshot);
    if (catalog !== undefined) out.push({ corpus: 'checks', source: record.source, catalog });
  }
  return out;
}

/** `source` as version 5 spells it (the upgrade tool's rewrites), with its
 *  catalog's library files respelled too. */
function respelled(source: string, catalog: CatalogSnapshot): { source: string; catalog: CatalogSnapshot } | undefined {
  try {
    const files =
      catalog.files === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(catalog.files).map(([name, file]) => [name, { ...file, source: spelledFor(5, file.source, fromCatalogSnapshot({ ...catalog, files: undefined })) }]),
          );
    const spelledCatalog = files === undefined ? catalog : { ...catalog, files };
    const resolveFile = resolveFileFromSnapshot(spelledCatalog);
    return { source: spelledFor(5, source, fromCatalogSnapshot(spelledCatalog), resolveFile !== undefined ? { resolveFile } : {}), catalog: spelledCatalog };
  } catch {
    return undefined;
  }
}

function oracleCorpus(): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (corpus: string, source: string, catalog: CatalogSnapshot) => {
    const spelled = respelled(source, catalog);
    if (spelled === undefined) return;
    const key = `${JSON.stringify(spelled.catalog.files ?? null)}\u0000${spelled.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ corpus, ...spelled });
  };
  for (const file of ['records.json', 'handles.json', 'parallel.json']) {
    const oracle = JSON.parse(readFileSync(path.join(ORACLES, file), 'utf8')) as { prelude: string; catalog: CatalogSnapshot; cases: Array<{ body: string }> };
    for (const c of oracle.cases) add(`oracle ${file}`, oracle.prelude.replace('BODY', c.body), oracle.catalog);
  }
  const patterns = JSON.parse(readFileSync(path.join(ORACLES, 'patterns.json'), 'utf8')) as {
    prelude: string;
    cases: Array<{ program: { body?: string; file?: string; files?: CatalogSnapshot['files'] } }>;
  };
  const catalog = patternsCatalog();
  for (const { program } of patterns.cases) {
    const source = program.file !== undefined ? patterns.prelude + program.file : `${patterns.prelude}movement m(msg: <inbox-[:message]->>) {\n${program.body ?? ''}\n}`;
    add('oracle patterns', source, program.files !== undefined ? { ...catalog, files: program.files } : catalog);
  }
  return out;
}

/** The patterns oracle's world, as the parity harness reads it
 *  (crates/movement-checker/parity/reference.ts). */
function patternsCatalog(): CatalogSnapshot {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PATTERNS_CATALOG } = require(path.join(ORACLES, 'patterns_oracle.ts')) as { PATTERNS_CATALOG: CatalogSnapshot };
  return PATTERNS_CATALOG;
}

/** What a run ended in that a check should have refused, or undefined. */
async function gapOf(candidate: Candidate, movementName: string): Promise<string | undefined | 'unchecked'> {
  resetRustRunStats();
  let failure: string | undefined;
  try {
    await runMovement({
      source: candidate.source,
      languageVersion: 5,
      movementName,
      event: { pipelineInputId: 'pi-reach', adapterType: 'email', triggerType: 'webhook', payload: { subject: 'Acme', text: 'hello' } },
      catalog: candidate.catalog,
      teamId: TEAM,
      credentialIds: credentialIdsFor(candidate.catalog, (name) => `cred-${name}`),
      host: plainHost(),
      firedAt: '2026-10-16T09:00:00.000Z',
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  if (failure?.startsWith('MOVENG_CHECK')) return 'unchecked';
  const unsupported = Object.keys(rustRunStats.unsupported);
  if (unsupported.length > 0 && failure === undefined) return `unsupported: ${unsupported.join(', ')}`;
  if (rustRunStats.shimFaults > 0) return `shim fault — ${failure ?? ''}`;
  if (failure === undefined) return undefined;
  if (failure.includes('MOVENG_UNSUPPORTED') || failure.includes('checker should have caught')) return failure;
  return undefined;
}

(overCorpus() ? describe : describe.skip)('reachability: no checked-clean version-5 program reaches an engine refusal', () => {
  it('runs every version-5 program in the repository', async () => {
    const candidates = [...checksCorpus(), ...oracleCorpus()];
    const gaps: string[] = [];
    const reached = new Set<string>();
    const ran: Record<string, number> = {};
    for (const candidate of candidates) {
      for (const movementName of entriesOf(candidate.source)) {
        const gap = await gapOf(candidate, movementName);
        if (gap === 'unchecked') continue;
        ran[candidate.corpus] = (ran[candidate.corpus] ?? 0) + 1;
        if (gap === undefined) continue;
        const reason = reasonOf(gap);
        reached.add(reason);
        if (!KNOWN_GAPS.includes(reason)) gaps.push(`[${candidate.corpus}] ${movementName}: ${gap.slice(0, 300)}\n${candidate.source}`);
      }
    }
    // REACH_DUMP=<file> writes the gaps reached, for updating KNOWN_GAPS.
    if (process.env.REACH_DUMP !== undefined) writeFileSync(process.env.REACH_DUMP, JSON.stringify([...reached], null, 1));
    // A corpus that silently lost its programs would prove nothing.
    expect(ran).toEqual(expect.objectContaining({ checks: expect.any(Number), 'oracle patterns': expect.any(Number) }));
    expect(gaps).toEqual([]);
    expect(KNOWN_GAPS.filter((known) => !reached.has(known))).toEqual([]);
  }, 1_800_000);
});
