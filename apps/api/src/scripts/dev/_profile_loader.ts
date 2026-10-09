/**
 * Side-effect module: discover the active dev-loop profile and merge its env
 * into `process.env` so the dev CLIs (`dev:chat`, `dev:inject`, …) target
 * the right stack without the caller having to prefix env vars.
 *
 * Resolution order:
 *   1. If `DEV_LOOP_PROFILE` is set, read `.dev-loop/profiles/<name>.json`.
 *   2. Otherwise scan `.dev-loop/profiles/*.json`, drop entries whose `pid`
 *      is no longer alive (and delete the stale file), and pick the most
 *      recently-started survivor. If multiple are alive, emit a one-line
 *      hint to stderr so the caller knows which stack they're hitting.
 *
 * A genuine shell override still wins (`API_BASE_URL=… pnpm dev:inject`), but
 * a value that merely came from `apps/api/.env` does NOT shadow the active
 * stack: the dev CLIs preload `dotenv/config` before this loader, so without
 * this distinction `.env`'s `API_BASE_URL=http://localhost:3000` would silently
 * route every CLI at the default stack even under `DEV_LOOP_PROFILE=agent2`
 * (the ":3000 footgun"). We detect the `.env`-sourced case by comparing against
 * the parsed `.env` value and let the profile override it. Malformed files are
 * ignored rather than thrown.
 *
 * Profile files are written by `dev/loop.sh` on boot and removed by the
 * cleanup trap on shutdown. A SIGKILL'd loop leaves its file behind; the
 * dead-PID prune above (and `pnpm dev:loop:status --prune`) handle that.
 */
import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const PROFILES_DIR = path.join(REPO_ROOT, '.dev-loop/profiles');
const LEGACY_FILE = path.join(REPO_ROOT, '.dev-loop/profile.json');
const ENV_FILE = path.join(REPO_ROOT, 'apps/api/.env');

/** Values as written in `apps/api/.env` (parsed, NOT applied). Used to tell a
 *  `.env`-sourced routing default apart from a genuine shell override so the
 *  active profile can win over the former without clobbering the latter. */
function readEnvFileDefaults(): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(ENV_FILE));
  } catch {
    return {};
  }
}
const ENV_FILE_DEFAULTS = readEnvFileDefaults();

interface ProfileFile {
  profile?: string;
  pid?: number;
  startedAt?: string;
  env?: Record<string, string>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === 'EPERM';
  }
}

function readProfile(filePath: string): ProfileFile | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ProfileFile;
  } catch {
    return null;
  }
}

function applyEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) {
    const current = process.env[key];
    // Set when unset, or when the current value is just the `.env` default
    // (dotenv ran first) — the active profile is the authority on where its own
    // stack lives. A value that differs from the `.env` default is a genuine
    // shell override and is left untouched.
    if (current === undefined || current === ENV_FILE_DEFAULTS[key]) {
      process.env[key] = value;
    }
  }
}

function listProfiles(): Array<{ file: string; data: ProfileFile }> {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  const out: Array<{ file: string; data: ProfileFile }> = [];
  for (const name of fs.readdirSync(PROFILES_DIR)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(PROFILES_DIR, name);
    const data = readProfile(file);
    if (data) out.push({ file, data });
  }
  return out;
}

try {
  const explicit = process.env.DEV_LOOP_PROFILE;

  if (explicit) {
    const file = path.join(PROFILES_DIR, `${explicit}.json`);
    const data = readProfile(file);
    if (data?.env) applyEnv(data.env);
  } else {
    const profiles = listProfiles();

    // Prune stale entries (pid recorded but dead).
    const alive = profiles.filter(({ file, data }) => {
      if (typeof data.pid !== 'number') return true;
      if (isPidAlive(data.pid)) return true;
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
      return false;
    });

    if (alive.length > 0) {
      alive.sort((a, b) => {
        const at = a.data.startedAt ?? '';
        const bt = b.data.startedAt ?? '';
        return bt.localeCompare(at);
      });
      const chosen = alive[0];
      if (chosen.data.env) applyEnv(chosen.data.env);
      if (alive.length > 1) {
        const names = alive.map((p) => p.data.profile ?? path.basename(p.file, '.json'));
        process.stderr.write(
          `[dev-loop] ${alive.length} profiles alive (${names.join(', ')}); using '${
            chosen.data.profile ?? path.basename(chosen.file, '.json')
          }'. Set DEV_LOOP_PROFILE=<name> to pick a different one.\n`,
        );
      }
    } else if (fs.existsSync(LEGACY_FILE)) {
      // Backwards compatibility with the previous single-slot marker.
      const data = readProfile(LEGACY_FILE);
      if (data?.env) applyEnv(data.env);
    }
  }
} catch {
  // Best effort. A broken loader must not break the CLI.
}
