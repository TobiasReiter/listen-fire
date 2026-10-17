// `lf` — run movements locally from a project folder.
//
//   lf init [dir]
//   lf check
//   lf upgrade [--check] [--all]
//   lf run --event <file.json> [--dry-run]
//   lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]…
//   lf resume [<run-id>]
//   lf serve [--port N]
//   lf runs
//   lf call <callback-id> [--body <values.json>]
//   lf cancel <run-id> [--reason <text>]
//   lf connect [<module>] [--url <server url>]
//   lf credential add --module <module> [<name>] [--credential <declared>] [redirect options]
//   lf credential update <name> [--no-reauthorize] [redirect options]
//   lf credential delete <name>
//   lf credential list
//     redirect options: --redirect-port N  --no-browser  --headless  --public
//
// Every command takes --ephemeral (state in a temporary file) and --dir <project>.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DiscriminableEvent } from 'movement-engine/services/translation_graph/adapter';
import { initProject, loadProject } from './project';
import {
  callCallback,
  cancelRun,
  DEFAULT_PORT,
  EventFile,
  fireEvent,
  openSession,
  resumeAll,
  resumeRun,
  type RunOutcome,
  type Session,
} from './runs';
import { connectModule, knownModules } from './connect';
import { addCredential, deleteCredential, listCredentials, updateCredential, type RedirectChoice } from './credentials';
import { terminalPrompter } from './prompt';
import { receiveWebhook } from './doors';
import { serve } from './serve';
import { MissingCredentialsError } from './secrets';
import { checkFile } from './sources';
import { upgradeProject } from './upgrade';
import { neverAsAny } from 'movement-engine/lib/utils/types';

const USAGE = `usage: lf <init|check|upgrade|run|resume|serve|runs|call|cancel|connect|credential> [options]
  lf init [dir]
  lf check
  lf upgrade [--check] [--all]   rewrite the movement files into the current language version by the fixes that keep their meaning (--all: every fix offered; --check: print the diff, write nothing)
  lf run --event <file.json> [--dry-run]
  lf run --webhook <external> --body <file> [--install <credential>] [--header k:v]...
  lf resume [<run-id>]
  lf serve [--port N]
  lf runs
  lf call <callback-id> [--body <values.json>]   call a callback, as its url's POST does (the values: a JSON object)
  lf cancel <run-id> [--reason <text>]           cancel a run: settled failed now, or at its next statement if another lf is stepping it
  lf connect [<module>] [--url <server url>]     set a module up: install it, its server and webhook secrets, its OAuth app (no module: list the ones known)
  lf credential add --module <module> [<name>] [--credential <declared>]   a user credential for the module: sign in at the provider, or its fields
  lf credential update <name> [--no-reauthorize]   sign in again and edit its fields
  lf credential delete <name>
  lf credential list
    signing in: --redirect-port N (the port your app registered)  --no-browser  --headless (paste the redirect back)  --public (through lf serve at publicUrl)
options: --dir <project folder>  --ephemeral (state in a temporary file)`;

async function main(argv: string[]): Promise<number> {
  const { values: values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: process.cwd() },
      ephemeral: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      event: { type: 'string' },
      webhook: { type: 'string' },
      body: { type: 'string' },
      install: { type: 'string' },
      header: { type: 'string', multiple: true, default: [] },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      reason: { type: 'string' },
      'redirect-port': { type: 'string' },
      'no-browser': { type: 'boolean', default: false },
      headless: { type: 'boolean', default: false },
      public: { type: 'boolean', default: false },
      'no-reauthorize': { type: 'boolean', default: false },
      module: { type: 'string' },
      credential: { type: 'string' },
      url: { type: 'string' },
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
        const report = upgradeProject(session, { checkOnly: values.check, all: values.all });
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
    case 'call': {
      const id = rest[0];
      if (id === undefined) {
        process.stderr.write('lf call needs a callback id\n');
        return 2;
      }
      const supplied: unknown = values.body !== undefined ? JSON.parse(readFileSync(values.body, 'utf8')) : {};
      if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
        process.stderr.write('lf call --body: the file must hold a JSON object of values\n');
        return 2;
      }
      const project = loadProject(values.dir);
      const session = await openSession(project, { ephemeral: false, start: true });
      try {
        const called = await callCallback(session, { id, values: { ...supplied } });
        switch (called.call.kind) {
          case 'recorded':
            process.stdout.write(
              called.queued
                ? `callback ${id}: recorded; its run is being stepped by another lf process, which runs the body next\n`
                : `callback ${id}: recorded\n`,
            );
            return report(called.outcomes, { quietWhenEmpty: true });
          case 'mismatch':
            process.stdout.write(`callback ${id}: refused — ${called.call.message}\n`);
            return 1;
          case 'not_found':
            process.stdout.write(`callback ${id}: no such callback\n`);
            return 1;
          case 'closed':
            process.stdout.write(`callback ${id}: closed — it was already used, or its run has finished\n`);
            return 1;
          case 'expired':
            process.stdout.write(`callback ${id}: expired\n`);
            return 1;
          default:
            return neverAsAny(called.call);
        }
      } finally {
        session.close();
      }
    }
    case 'cancel': {
      const runId = rest[0];
      if (runId === undefined) {
        process.stderr.write('lf cancel needs a run id\n');
        return 2;
      }
      const project = loadProject(values.dir);
      // Settling a run starts no segment: no externals.
      const session = await openSession(project, { ephemeral: false, start: false });
      try {
        const cancelled = await cancelRun(session, { runId, reason: values.reason ?? null });
        process.stdout.write(
          cancelled.kind === 'cancelled'
            ? `run ${runId} cancelled\n`
            : `run ${runId}: cancel requested; another lf process is stepping it, and it stops at its next statement\n`,
        );
        return 0;
      } finally {
        session.close();
      }
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
    case 'connect': {
      const project = loadProject(values.dir);
      const ref = rest[0];
      if (ref === undefined) {
        const known = knownModules(project);
        process.stdout.write(known.length > 0 ? `${known.join('\n')}\n` : `no modules known here; install one: lf connect <package or name>\n`);
        return 0;
      }
      const prompter = terminalPrompter();
      try {
        await connectModule(project, ref, { prompter, ...(values.url !== undefined ? { url: values.url } : {}) });
      } finally {
        prompter.close();
      }
      return 0;
    }
    case 'credential': {
      const project = loadProject(values.dir);
      const [action, name] = rest;
      if (action === 'list') {
        const lines = listCredentials(project);
        process.stdout.write(lines.length > 0 ? `${lines.join('\n')}\n` : 'no credentials\n');
        return 0;
      }
      if (values.headless && values.public) {
        process.stderr.write('lf credential: --headless and --public are two ways back from the provider; pick one\n');
        return 2;
      }
      const port = values['redirect-port'];
      if (port !== undefined && !/^\d+$/.test(port)) {
        process.stderr.write(`--redirect-port: a port number, not "${port}"\n`);
        return 2;
      }
      const redirect: RedirectChoice = {
        how: values.headless ? 'headless' : values.public ? 'public' : 'loopback',
        ...(port !== undefined ? { port: Number(port) } : {}),
        openBrowser: !values['no-browser'] && !values.headless,
      };
      const prompter = terminalPrompter();
      try {
        switch (action) {
          case 'add':
            if (values.module === undefined) {
              process.stderr.write('lf credential add needs --module <module>\n');
              return 2;
            }
            await addCredential(project, {
              module: values.module,
              ...(name !== undefined ? { name } : {}),
              ...(values.credential !== undefined ? { declared: values.credential } : {}),
              redirect,
              prompter,
            });
            return 0;
          case 'update':
            if (name === undefined) {
              process.stderr.write('lf credential update needs a credential name\n');
              return 2;
            }
            await updateCredential(project, {
              name,
              ...(values.credential !== undefined ? { declared: values.credential } : {}),
              reauthorize: !values['no-reauthorize'],
              redirect,
              prompter,
            });
            return 0;
          case 'delete':
            if (name === undefined) {
              process.stderr.write('lf credential delete needs a credential name\n');
              return 2;
            }
            await deleteCredential(project, { name, prompter });
            return 0;
          default:
            process.stderr.write(`lf credential: add, update, delete or list, not "${action ?? ''}"\n`);
            return 2;
        }
      } finally {
        prompter.close();
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

function report(outcomes: RunOutcome[], options: { quietWhenEmpty?: boolean } = {}): number {
  if (outcomes.length === 0 && options.quietWhenEmpty !== true) process.stdout.write('no listen matched\n');
  for (const o of outcomes) {
    process.stdout.write(
      `${o.entry === 'called' ? 'called' : 'run'} ${o.runId} ${o.file}:${o.movement} ${o.status} — ${o.writes} write(s), ${o.traceEntries} trace entr${o.traceEntries === 1 ? 'y' : 'ies'}${o.error ? `\n  ${o.error}` : ''}\n`,
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
