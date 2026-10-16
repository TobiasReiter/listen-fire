// `lf` — run movements locally from a project folder.
//
//   lf init [dir]
//   lf check
//   lf upgrade [--check]
//   lf run --event <file.json> [--dry-run]
//   lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]…
//   lf resume [<run-id>]
//   lf serve [--port N]
//   lf runs
//
// Every command takes --ephemeral (state in a temporary file) and --dir <project>.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';
import { initProject, loadProject } from './project';
import { EventFile, fireEvent, openSession, receiveWebhook, resumeAll, resumeRun, type RunOutcome, type Session } from './runs';
import { serve } from './serve';
import { MissingCredentialsError } from './secrets';
import { checkFile } from './sources';
import { upgradeProject } from './upgrade';

const USAGE = `usage: lf <init|check|upgrade|run|resume|serve|runs> [options]
  lf init [dir]
  lf check
  lf upgrade [--check]   rewrite the movement files into the current language version (--check: print the diff, write nothing)
  lf run --event <file.json> [--dry-run]
  lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]...
  lf resume [<run-id>]
  lf serve [--port N]
  lf runs
options: --dir <project folder>  --ephemeral (state in a temporary file)`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: process.cwd() },
      ephemeral: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      event: { type: 'string' },
      webhook: { type: 'string' },
      body: { type: 'string' },
      install: { type: 'string' },
      header: { type: 'string', multiple: true, default: [] },
      port: { type: 'string', default: '4400' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined && !values.help ? 2 : 0;
  }

  switch (command) {
    case 'init': {
      const made = initProject(rest[0] ?? values.dir);
      process.stdout.write(made.length > 0 ? `made ${made.join(', ')}\n` : 'already a project\n');
      return 0;
    }
    case 'check': {
      const session = await checkingSession(values.dir);
      if (session === undefined) return 1;
      try {
        let errors = 0;
        for (const file of session.files) {
          for (const d of checkFile({ file, catalog: session.catalog, languageVersion: session.project.languageVersion })) {
            if (d.severity === 'error') errors++;
            process.stdout.write(`${file.path}:${d.line}:${d.column} ${d.severity} ${d.code} ${d.message}\n`);
          }
        }
        process.stdout.write(`${session.files.length} file(s), ${errors} error(s)\n`);
        return errors > 0 ? 1 : 0;
      } finally {
        session.close();
      }
    }
    case 'upgrade': {
      const session = await checkingSession(values.dir);
      if (session === undefined) return 1;
      try {
        const report = upgradeProject(session, { checkOnly: values.check });
        for (const line of report.lines) process.stdout.write(`${line}\n`);
        return report.left > 0 || (values.check && report.changed > 0) ? 1 : 0;
      } finally {
        session.close();
      }
    }
    case 'run': {
      const project = loadProject(values.dir);
      const session = await openSession(project, { ephemeral: values.ephemeral, start: true });
      try {
        let outcomes: RunOutcome[];
        if (values.event !== undefined) {
          const file = EventFile.parse(JSON.parse(readFileSync(values.event, 'utf8')));
          outcomes = await fireEvent(session, {
            external: file.external,
            event: file.event as DiscriminableEvent,
            dryRun: values['dry-run'],
          });
        } else if (values.webhook !== undefined && values.body !== undefined) {
          outcomes = await receiveWebhook(session, {
            external: values.webhook,
            ...(values.install !== undefined ? { install: values.install } : {}),
            rawBody: readFileSync(values.body),
            headers: headersOf(values.header),
          });
        } else {
          process.stderr.write('lf run needs --event <file> or --webhook <external> --body <file>\n');
          return 2;
        }
        return report(outcomes);
      } finally {
        session.close();
      }
    }
    case 'resume': {
      const project = loadProject(values.dir);
      const session = await openSession(project, { ephemeral: false, start: true });
      try {
        const outcomes = rest[0] !== undefined ? [await resumeRun(session, rest[0])] : await resumeAll(session);
        if (outcomes.length === 0) process.stdout.write('no parked runs\n');
        return report(outcomes);
      } finally {
        session.close();
      }
    }
    case 'serve': {
      const project = loadProject(values.dir);
      const serving = await serve((hostUrl) => openSession(project, { ephemeral: values.ephemeral, start: true, hostUrl }), {
        port: Number(values.port),
      });
      process.stdout.write(`lf serving on http://127.0.0.1:${serving.port}/hooks/<external>/<install>\n`);
      const stop = () => {
        void serving.stop().then(() => {
          serving.session.close();
          process.exit(0);
        });
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return new Promise<number>(() => {});
    }
    case 'runs': {
      const project = loadProject(values.dir);
      const session = await openSession(project, { ephemeral: false, start: false });
      try {
        for (const run of session.state.runs()) {
          process.stdout.write(`${run.id} ${run.started_at} ${run.file}:${run.movement} ${run.status}\n`);
        }
        return 0;
      } finally {
        session.close();
      }
    }
    default:
      process.stderr.write(`unknown command "${command}"\n${USAGE}\n`);
      return 2;
  }
}

/** A session to check the project's files against (the externals started,
 *  for their schemas), or undefined when a credential the files name is
 *  missing — printed as the check's errors. */
async function checkingSession(dir: string): Promise<Session | undefined> {
  const project = loadProject(dir);
  try {
    return await openSession(project, { ephemeral: true, start: true });
  } catch (error) {
    if (!(error instanceof MissingCredentialsError)) throw error;
    for (const m of error.missing) process.stdout.write(`${m.file}:${m.line}:${m.column} error MISSING_CREDENTIAL ${m.message}\n`);
    process.stdout.write(`${error.missing.length} error(s)\n`);
    return undefined;
  }
}

function headersOf(pairs: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf(':');
    if (at <= 0) throw new Error(`--header ${pair}: expected name:value`);
    headers[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
  }
  return headers;
}

function report(outcomes: RunOutcome[]): number {
  if (outcomes.length === 0) process.stdout.write('no listen matched\n');
  for (const o of outcomes) {
    process.stdout.write(
      `run ${o.runId} ${o.file}:${o.movement} ${o.status} — ${o.writes} write(s), ${o.traceEntries} trace entr${o.traceEntries === 1 ? 'y' : 'ies'}${o.error ? `\n  ${o.error}` : ''}\n`,
    );
    for (const w of o.captured ?? []) {
      process.stdout.write(`  dry run, not written: ${JSON.stringify(w)}\n`);
    }
  }
  return outcomes.some((o) => o.status === 'failed') ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`lf: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
