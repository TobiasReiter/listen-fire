// `lf drain`, the scale-from-zero worker, over a Postgres store: runs
// parked on the example's hour-long sleep, then two workers draining the
// one queue at once, judged two hours on. Every run is resumed exactly
// once: by one worker, its follow-up written once, its work row gone.
// The workers run from their own copies of the project, as two machines
// would, so each one's external keeps its own writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companies, project } from '../example';
import { polls, withFeed } from '../feed';
import { lfBinary } from '../lf_bin';
import { freshTeam, POSTGRES_URL, psql } from './pg';

const RUNS = 6;
const TWO_HOURS_MS = String(2 * 60 * 60_000);

function lfHost(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(lfBinary(), args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => resolveRun({ code: code ?? -1, out }));
  });
}

test('two drain workers resume every parked run exactly once', async () => {
  const { team, clear } = freshTeam();
  const store = ['--store', POSTGRES_URL, '--team', team];
  try {
    const dir = project();
    const fired: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const run = spawnSync(lfBinary(), ['run', '--event', 'events/company_created.json', ...store], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      const id = /^run (\S+) companies:welcome parked/m.exec(run.stdout)?.[1];
      assert.ok(id !== undefined, run.stdout);
      fired.push(id);
    }
    assert.deepEqual(psql(`select count(*) from lf.work where team_id = '${team}' and kind = 'resume_timer'`), [[String(RUNS)]]);

    const machines = [dir, join(mkdtempSync(join(tmpdir(), 'lf-drain-')), 'p')];
    cpSync(dir, machines[1]!, { recursive: true });
    const drained = await Promise.all(
      machines.map((machine) => lfHost(machine, ['drain', ...store, '--until-idle', '--max-seconds', '120'], { LF_CLOCK_AHEAD_MS: TWO_HOURS_MS })),
    );
    for (const worker of drained) assert.equal(worker.code, 0, worker.out);

    const resumed = drained.flatMap((worker) => [...worker.out.matchAll(/^run (\S+) companies:welcome completed/gm)].map((m) => m[1]));
    assert.deepEqual([...resumed].sort(), [...fired].sort(), `each run resumed once:\n${drained.map((w) => w.out).join('\n---\n')}`);
    const followUps = machines.flatMap((machine) => companies(machine).filter((name) => name.startsWith('Follow up')));
    assert.equal(followUps.length, RUNS, 'each follow-up written once');
    assert.deepEqual(psql(`select status, count(*) from lf.trigger_run where team_id = '${team}' group by status`), [['success', String(RUNS)]]);
    assert.deepEqual(psql(`select count(*) from lf.work where team_id = '${team}'`), [['0']]);
    assert.deepEqual(psql(`select count(*) from lf.parked_run p join lf.trigger_run r on r.id = p.run_id where r.team_id = '${team}'`), [['0']]);

    // The trace is kept on the run's row, so a run another worker resumed
    // reports the whole of it, as the same run over the SQLite file does.
    const traced = drained.flatMap((worker) => [...worker.out.matchAll(/^run \S+ companies:welcome completed .* (\d+) trace entr/gm)].map((m) => m[1]));
    const local = project();
    assert.equal(spawnSync(lfBinary(), ['run', '--event', 'events/company_created.json'], { cwd: local, encoding: 'utf8' }).status, 0);
    const resumedLocally = spawnSync(lfBinary(), ['resume'], { cwd: local, encoding: 'utf8', env: { ...process.env, LF_CLOCK_AHEAD_MS: TWO_HOURS_MS } });
    const sqliteTrace = /^run \S+ companies:welcome completed .* (\d+) trace entr/m.exec(resumedLocally.stdout)?.[1];
    assert.ok(sqliteTrace !== undefined && Number(sqliteTrace) > 0, resumedLocally.stdout);
    assert.deepEqual(traced, Array(RUNS).fill(sqliteTrace), drained.map((w) => w.out).join('\n---\n'));
  } finally {
    clear();
  }
});

test('a poll pool and a run pool on one store split the work by kind', async () => {
  const { team, clear } = freshTeam();
  const store = ['--store', POSTGRES_URL, '--team', team];
  try {
    const dir = withFeed(project());
    const fired: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = spawnSync(lfBinary(), ['run', '--event', 'events/company_created.json', ...store], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      const id = /^run (\S+) companies:welcome parked/m.exec(run.stdout)?.[1];
      assert.ok(id !== undefined, run.stdout);
      fired.push(id);
    }
    // Each pool on its own machine (its own copy of the project), as two fleets would be.
    const runMachine = join(mkdtempSync(join(tmpdir(), 'lf-pool-')), 'p');
    cpSync(dir, runMachine, { recursive: true });
    const pools: Array<[string, string]> = [
      [dir, 'poll_listen'],
      [runMachine, 'resume_timer,wake_await,fire_event,fire_callback,cron'],
    ];
    const [pollPool, runPool] = await Promise.all(
      pools.map(([machine, kinds]) =>
        lfHost(machine, ['drain', ...store, '--kinds', kinds, '--until-idle', '--max-seconds', '120'], { LF_CLOCK_AHEAD_MS: TWO_HOURS_MS }),
      ),
    );
    // The notes movement fails by design, naming each note: so the poll pool exits 1.
    assert.equal(pollPool!.code, 1, pollPool!.out);
    assert.equal(runPool!.code, 0, runPool!.out);

    // The poll pool polled the feed once and ran its notes; it resumed no run.
    assert.deepEqual(polls(dir), [null]);
    assert.match(pollPool!.out, /notes:seen/);
    assert.doesNotMatch(pollPool!.out, /companies:welcome/);
    // The run pool resumed every parked run, and polled nothing.
    assert.deepEqual(polls(runMachine), []);
    const resumed = [...runPool!.out.matchAll(/^run (\S+) companies:welcome completed/gm)].map((m) => m[1]);
    assert.deepEqual([...resumed].sort(), [...fired].sort(), runPool!.out);
    assert.doesNotMatch(runPool!.out, /notes:seen/);
    // What is left is the feed's next poll, due an interval on.
    assert.deepEqual(psql(`select kind from lf.work where team_id = '${team}'`), [['poll_listen']]);
  } finally {
    clear();
  }
});

test('drain --until-idle exits at once when nothing is due', async () => {
  const { team, clear } = freshTeam();
  try {
    const started = Date.now();
    const worker = await lfHost(project(), ['drain', '--store', POSTGRES_URL, '--team', team, '--until-idle']);
    assert.equal(worker.code, 0, worker.out);
    assert.equal(worker.out, '');
    assert.ok(Date.now() - started < 30_000);
  } finally {
    clear();
  }
});

test('drain --max-seconds stops a worker that would otherwise poll forever', async () => {
  const { team, clear } = freshTeam();
  try {
    const started = Date.now();
    const worker = await lfHost(project(), ['drain', '--store', POSTGRES_URL, '--team', team, '--max-seconds', '2']);
    assert.equal(worker.code, 0, worker.out);
    const took = Date.now() - started;
    assert.ok(took >= 2_000 && took < 30_000, `took ${took}ms`);
  } finally {
    clear();
  }
});
