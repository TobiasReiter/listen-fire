// A project is a folder with `lf.yaml` at its root: the engine version it is
// pinned to, where its movement files live, and its externals folder. `.lf/`
// beside it holds what the host keeps (state, files, secrets) and is ignored
// by git.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { parse, stringify } from 'yaml';
import { CURRENT_LANGUAGE_VERSION, since, type LanguageVersion } from 'movement-lang';

export const PROJECT_FILE = 'lf.yaml';

/** The engine version a new project is pinned to: this release's. */
export const CURRENT_ENGINE_VERSION = '0.11.0';

const ProjectFile = z.object({
  engine: z.string().regex(/^\d+\.\d+\.\d+$/, 'engine: a semver version, e.g. 0.11.0'),
  movements: z.string().default('movements'),
  externals: z.string().default('externals'),
  /** Who events act as on this machine (`@user_*`); LF_USER / LF_USER_EMAIL override it. */
  user: z.object({ name: z.string().min(1).optional(), email: z.string().min(1).optional() }).default({}),
  /** Where this lf is reached from outside (a tunnel, a deployed host): a
   *  callback's url is under it. Unset: where `lf serve` listens. */
  publicUrl: z.url({ protocol: /^https?$/, error: 'publicUrl: an http(s) URL, e.g. https://lf.example.com' }).optional(),
});

export interface Project {
  root: string;
  /** The host's own folder: `<root>/.lf`. */
  lfDir: string;
  engine: string;
  /** The language version the pinned engine runs. */
  languageVersion: LanguageVersion;
  movementsDir: string;
  externalsDir: string;
  /** The local acting identity lf.yaml names; unset parts fall back to the OS user. */
  user: { name?: string; email?: string };
  /** lf.yaml's `publicUrl`, when it names one. */
  publicUrl?: string;
}

/**
 * The language version an engine version runs. The language version is
 * becoming the engine version (Henry, 2026-10-15); until it does, every engine
 * this release knows runs the current language version (5, Dancing Wren), and
 * an engine version newer than this release is refused.
 */
export function languageVersionOfEngine(engine: string): LanguageVersion {
  if (compareSemver(engine, CURRENT_ENGINE_VERSION) > 0) {
    throw new Error(
      `lf.yaml pins engine ${engine}, newer than this lf (${CURRENT_ENGINE_VERSION}); upgrade lf or lower the pin`,
    );
  }
  return CURRENT_LANGUAGE_VERSION;
}

/** The first language version lf runs. lf runs on the Rust engine alone,
 *  which runs version 5 and later; versions 1–4 run only on the hosted
 *  TypeScript engine. */
export const FIRST_LF_LANGUAGE_VERSION: LanguageVersion = 5;

/** Refuses a pin lf does not run, before any engine sees it: `pinned` names
 *  what carries the pin, `remedy` what to do about it. */
export function refuseBelowLf(languageVersion: LanguageVersion, { pinned, remedy }: { pinned: string; remedy: string }): void {
  if (since(languageVersion, FIRST_LF_LANGUAGE_VERSION)) return;
  throw new Error(
    `${pinned} is pinned to language version ${languageVersion}, which lf does not run (lf runs language version ${FIRST_LF_LANGUAGE_VERSION} and later): ${remedy}`,
  );
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The project whose `lf.yaml` is at `from` or the nearest folder above it. */
export function loadProject(from: string): Project {
  let dir = resolve(from);
  while (!existsSync(join(dir, PROJECT_FILE))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no ${PROJECT_FILE} here or in any folder above (run \`lf init\`)`);
    dir = parent;
  }
  const parsed = ProjectFile.safeParse(parse(readFileSync(join(dir, PROJECT_FILE), 'utf8')) ?? {});
  if (!parsed.success) {
    throw new Error(`${join(dir, PROJECT_FILE)}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const languageVersion = languageVersionOfEngine(parsed.data.engine);
  refuseBelowLf(languageVersion, { pinned: join(dir, PROJECT_FILE), remedy: 'run `lf upgrade`' });
  const lfDir = join(dir, '.lf');
  mkdirSync(lfDir, { recursive: true });
  return {
    root: dir,
    lfDir,
    engine: parsed.data.engine,
    languageVersion,
    movementsDir: join(dir, parsed.data.movements),
    externalsDir: join(dir, parsed.data.externals),
    user: {
      ...(parsed.data.user.name !== undefined ? { name: parsed.data.user.name } : {}),
      ...(parsed.data.user.email !== undefined ? { email: parsed.data.user.email } : {}),
    },
    ...(parsed.data.publicUrl !== undefined ? { publicUrl: parsed.data.publicUrl } : {}),
  };
}

/** Write `lf.yaml`, `.lf/` and its `.gitignore` entry; leave an existing project alone. */
export function initProject(dir: string): string[] {
  const root = resolve(dir);
  const made: string[] = [];
  const projectFile = join(root, PROJECT_FILE);
  if (!existsSync(projectFile)) {
    writeFileSync(
      projectFile,
      stringify({ engine: CURRENT_ENGINE_VERSION, movements: 'movements', externals: 'externals' }) +
        '# Who events act as on this machine (@user_name, @user_email). Defaults to the OS user;\n' +
        '# LF_USER and LF_USER_EMAIL override.\n' +
        '# user: { name: Your Name, email: you@example.com }\n' +
        '# Where this lf is reached from outside; a callback\'s url is under it. Defaults to\n' +
        '# where `lf serve` listens.\n' +
        '# publicUrl: https://lf.example.com\n',
    );
    made.push(PROJECT_FILE);
  }
  for (const folder of ['.lf', 'movements', 'externals']) {
    if (!existsSync(join(root, folder))) {
      mkdirSync(join(root, folder), { recursive: true });
      made.push(`${folder}/`);
    }
  }
  const gitignore = join(root, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8').split('\n') : [];
  if (!ignored.some((line) => line.trim() === '.lf/' || line.trim() === '.lf')) {
    appendFileSync(gitignore, `${ignored.length > 0 && ignored.at(-1) !== '' ? '\n' : ''}.lf/\n`);
    made.push('.gitignore entry .lf/');
  }
  return made;
}
