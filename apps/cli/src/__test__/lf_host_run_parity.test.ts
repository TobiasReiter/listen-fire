// The Rust lf-host against the TypeScript lf on the run path (streams G2–G3):
// the same movements, fired and resumed against the same externals as
// processes — the example's acme_crm and the reference fake CRM — print the
// same lines, exit alike, leave the same state file (runs, trace, parked
// leaves, joins, correlations, work rows) and the same writes in the
// external. Ids and instants are the only differences allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { LF, project } from './example';
import { lfHostBinary } from './lf_host';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const CRM_STATE = '.lf/externals/acme_crm/state.json';
const API = resolve(__dirname, '../../../api');

type Host = 'ts' | 'rust';

function lfOn(host: Host, dir: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const [command, argv] = host === 'ts' ? [process.execPath, [LF, ...args]] : [lfHostBinary(), args];
  const run = spawnSync(command, argv, { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } });
  // The TypeScript engine's log line is its logger's, not the command's output.
  const out = run.stdout.split('\n').filter((line) => !line.startsWith('info: movement engine:')).join('\n');
  return { code: run.status ?? -1, out: normalized(out).replaceAll(dir, '<dir>') };
}

function normalized(text: string): string {
  return text.replace(UUID, '<id>').replace(INSTANT, '<at>');
}

/** The state file, row by row, ids and instants normalized. */
function stateOf(dir: string): string[] {
  const file = join(dir, '.lf/state.db');
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file);
  try {
    const rows = (sql: string) => db.prepare(sql).all().map((row) => normalized(JSON.stringify(row)));
    return [
      ...rows('select file, movement, status, input, outcome, cancel_requested_at from run order by started_at'),
      ...rows('select seq, entry from trace order by run_id, seq'),
      ...rows('select address, reason, status, wake_at, state from leaf order by run_id, address'),
      ...rows('select frame_address, pending, closed_by_address from join_frame order by run_id, frame_address'),
      ...rows('select frame_address, branch_address, branch_index, exports, decremented from join_branch_export order by run_id, branch_address'),
      ...rows('select address, adapter_type, correlation_key from await_correlation order by run_id, address'),
      ...rows('select kind, key, payload from work order by id'),
    ];
  } finally {
    db.close();
  }
}

function crmState(dir: string): unknown {
  const file = join(dir, CRM_STATE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

interface Step {
  args: string[];
  env?: Record<string, string>;
  /** Done to both projects before this step. */
  before?: (dir: string) => void;
}

/** Each step on a TypeScript copy and a Rust copy of the same project: the
 *  same output and exit code each time, and the same state after each. */
function parity(make: () => string, steps: Step[]): void {
  const dirs = { ts: make(), rust: make() };
  for (const step of steps) {
    step.before?.(dirs.ts);
    step.before?.(dirs.rust);
    const ts = lfOn('ts', dirs.ts, step.args, step.env);
    const rust = lfOn('rust', dirs.rust, step.args, step.env);
    assert.equal(rust.out, ts.out, `lf ${step.args.join(' ')}`);
    assert.equal(rust.code, ts.code, `lf ${step.args.join(' ')}: ${rust.out}`);
    assert.deepEqual(stateOf(dirs.rust), stateOf(dirs.ts), `the state after lf ${step.args.join(' ')}`);
    assert.deepEqual(crmState(dirs.rust), crmState(dirs.ts), `the external's writes after lf ${step.args.join(' ')}`);
  }
}

const RUN = ['run', '--event', 'events/company_created.json'];

test('run parity: the example writes, parks on its sleep, and resume finishes it', () => {
  parity(() => project(), [{ args: RUN }, { args: ['resume'] }, { args: ['resume'] }, { args: ['runs'] }]);
});

test('run parity: a park in each arm of an `all`, resumed together, joins both answers', () => {
  parity(() => project('join'), [{ args: RUN }, { args: ['resume'] }]);
});

test('run parity: an await on a comment thread parks, and resumes once the comment is there', () => {
  const comment = (dir: string) => {
    const file = join(dir, CRM_STATE);
    const crm = JSON.parse(readFileSync(file, 'utf8')) as { companies: Array<{ externalId: string; fields: { Name: string } }> };
    const thread = crm.companies.find((c) => c.fields.Name.startsWith('Discuss'));
    assert.ok(thread, JSON.stringify(crm));
    writeFileSync(file, JSON.stringify({ ...crm, comments: [{ id: 'comment-1', thread: thread.externalId, Text: 'on it' }] }));
  };
  parity(() => project('await'), [{ args: RUN }, { args: ['resume'] }, { args: ['resume'], before: comment }]);
});

/** The example with one movement in place of its own, `body` its function's. */
function reports(body: string[]): () => string {
  return () => {
    const dir = project();
    rmSync(join(dir, 'movements/companies.mvt'));
    writeFileSync(
      join(dir, 'movements/reports.mvt'),
      [
        'import { acme_crm } from adapters',
        'import { acme } from credentials',
        '',
        'crm = connect acme_crm using acme',
        '',
        'function report(company: <crm-[:Company]->>) {',
        ...body.map((line) => `  ${line}`),
        '}',
        '',
        'listen to crm { events: ["company.created"] } fire report',
        '',
      ].join('\n'),
    );
    return dir;
  };
}

test('run parity: a FILE() write crosses to the external as a URL, and a dry run captures its writes', () => {
  const written = reports(['write crm-[:Company]-> { Name: "Report ${company.Name}", Report: File.from("Hello ${company.Name}", "text") }']);
  parity(written, [{ args: RUN }, { args: [...RUN, '--dry-run'] }]);
});

test('run parity: a file a run made before it parked is a file again when it resumes', () => {
  const kept = reports(['f = File.from("Hello ${company.Name}", "text")', 'await sleep(1h)', 'write crm-[:Company]-> { Name: "Report ${company.Name}", Report: f }']);
  parity(kept, [{ args: RUN }, { args: ['resume'] }]);
});

test('run parity: a run past the call ceiling fails naming the knob, and a program the checker refuses fails with its diagnostic', () => {
  parity(() => project(), [{ args: RUN, env: { REMOTE_ADAPTER_MAX_CALLS_PER_RUN: '1' } }]);
  const misspelled = () => {
    const dir = project();
    const file = join(dir, 'movements/companies.mvt');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Name: "Welcome ${company.Name}"', 'Nme: "Welcome ${company.Name}"'));
    return dir;
  };
  parity(misspelled, [{ args: RUN }]);
});

test('run parity: the example against the reference fake CRM (apps/api), started as an external process', () => {
  const fake = () => {
    const dir = project();
    rmSync(join(dir, 'externals/acme_crm'), { recursive: true });
    mkdirSync(join(dir, 'externals/acme_crm'), { recursive: true });
    const tsNode = join(API, 'node_modules/ts-node/register/transpile-only');
    const paths = join(API, 'node_modules/tsconfig-paths/register');
    writeFileSync(
      join(dir, 'externals/acme_crm/lf-external.yaml'),
      [
        'name: acme_crm',
        'kind: adapter',
        'protocol: 2',
        `command: [${JSON.stringify(process.execPath)}, -r, ${JSON.stringify(tsNode)}, -r, ${JSON.stringify(paths)}, ${JSON.stringify(join(API, 'src/scripts/dev/fake_crm_external.ts'))}]`,
        'auth: { kind: bearer, field: token }',
        'env:',
        `  TS_NODE_PROJECT: ${JSON.stringify(join(API, 'tsconfig.dev.json'))}`,
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, '.lf/secrets.yaml'), 'acme:\n  external: acme_crm\n  token: dev-loop-acme-crm-secret\n');
    // The fake CRM declares no listen config.
    const file = join(dir, 'movements/companies.mvt');
    writeFileSync(file, readFileSync(file, 'utf8').replace('{ events: ["company.created"] }', '{}'));
    return dir;
  };
  parity(fake, [{ args: ['check'] }, { args: RUN }, { args: ['resume'] }]);
});
