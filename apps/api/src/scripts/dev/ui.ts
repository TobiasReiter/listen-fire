/**
 * Dev-loop UI primitive — open a path in the running web app, inject the
 * dev-loop team's auth, drive the page (optional), screenshot, save to
 * disk. Designed for the calling agent to verify changes end-to-end
 * without an LLM in the loop (`pnpm ui:test` is the LLM-driven version).
 *
 * Subcommands:
 *
 *   pnpm dev:ui screenshot /ontology
 *   pnpm dev:ui screenshot /messages/<id> --out /tmp/m.png --wait 2000
 *   pnpm dev:ui screenshot / --admin         # apps/admin instead of apps/web
 *   pnpm dev:ui screenshot / --viewport 390x844   # phone-sized (also on interact)
 *
 *   pnpm dev:ui interact /sources/<id>/trigger/<tid> \
 *     --click 'text=Deal' \
 *     --click 'text=Fields' \
 *     --click 'text=+ Add' \
 *     --type-into 'textarea' '-[:Companies]->.' \
 *     --wait 500 \
 *     --dump '[role=listbox]' \
 *     --out /tmp/x.png
 *
 * `interact` action flags are consumed in source order, so the sequence
 * mirrors what the user would do. Returns JSON containing each action's
 * result, the final URL, and (when provided) the screenshot path.
 *
 * Selectors use Playwright's locator syntax: `text=Foo` for text match,
 * `role=button[name=Save]` for ARIA role + name, or any CSS selector.
 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { chromium, type Page, type Locator } from 'playwright';

import { ensureDevLoopTeam, DEV_LOOP_EMAIL } from './_lib';

const DEFAULT_DIR = process.env.DEV_LOOP_SCREENSHOT_DIR || '/tmp/dev-loop-ui';
const APP_BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3003';
const APP_ADMIN_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3004';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return 'true';
  return next;
}

/** `--viewport 390x844` → {width, height}; default desktop. */
function viewportFlag(args: string[]): { width: number; height: number } {
  const raw = flag(args, 'viewport');
  const m = raw?.match(/^(\d+)x(\d+)$/);
  if (m) return { width: Number(m[1]), height: Number(m[2]) };
  return { width: 1440, height: 900 };
}

async function injectAuth(page: Page, baseUrl: string, token: string, teamId: string) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  // apps/app reads tokenState; apps/admin gates on the top-level `email`.
  // We populate both shapes so a single injection authenticates either app.
  await page.evaluate(
    ({ token, email, teamId }) => {
      try {
        localStorage.setItem(
          '__LISTEN_FIRE__',
          JSON.stringify({
            email,
            tokenState: { token, email },
            users: [{ email, selectedTeamId: teamId }],
          }),
        );
      } catch {
        // localStorage may not be available pre-load; ignore
      }
    },
    { token, email: DEV_LOOP_EMAIL, teamId },
  );
  // apps/web's middleware reads listen_fire_token; apps/admin proxies it to the API
  // and reads listen_fire_team_id for team scoping.
  await page.context().addCookies([
    {
      name: 'listen_fire_token',
      value: token,
      url: baseUrl,
      httpOnly: false,
      sameSite: 'Lax',
    },
    {
      // apps/web's client checks this JS-readable presence marker (the real
      // session cookie is httpOnly) — without it the AuthProvider treats the
      // injected session as logged-out and clears it. Value is presence-only.
      name: 'listen_fire_authed',
      value: '1',
      url: baseUrl,
      httpOnly: false,
      sameSite: 'Lax',
    },
    {
      name: 'listen_fire_team_id',
      value: teamId,
      url: baseUrl,
      httpOnly: false,
      sameSite: 'Lax',
    },
  ]);
}

async function screenshot(args: string[]) {
  const path = args[0] && !args[0].startsWith('--') ? args[0] : '/';
  const useAdmin = args.includes('--admin');
  const baseUrl = useAdmin ? APP_ADMIN_URL : APP_BASE_URL;
  const out = flag(args, 'out');
  const waitMs = Number(flag(args, 'wait') ?? '1500');
  const fullPage = !args.includes('--viewport-only');
  const viewport = viewportFlag(args);

  const seed = await ensureDevLoopTeam();
  const targetUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const filename = out ?? join(
    DEFAULT_DIR,
    `${new Date().toISOString().replace(/[:.]/g, '-')}_${path.replace(/[^a-z0-9_-]+/gi, '_')}.png`,
  );
  mkdirSync(dirname(filename), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let resultUrl = '';
  let status: number | undefined;
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    await injectAuth(page, baseUrl, seed.token, seed.teamId);

    const navResponse = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = navResponse?.status();

    if (waitMs > 0) await page.waitForTimeout(waitMs);

    await page.screenshot({ path: filename, fullPage });
    resultUrl = page.url();
  } finally {
    await browser.close();
  }

  return {
    path: filename,
    target: targetUrl,
    landedAt: resultUrl,
    status,
    viewport,
    fullPage,
  };
}

// ── Interactive flows ──────────────────────────────────────────────
//
// `interact` walks process.argv looking for action flags (--click,
// --type, …) and runs them against a single browser session, in order.
// Each action records a {kind, selector, ok, ...detail} entry; the
// final stdout is JSON containing the action log + final URL + (if
// requested) a screenshot path. Failures DO NOT throw — they record
// `ok: false` with an error message and continue. That way one bad
// selector doesn't kill the whole flow and you can see how far you got.

type ActionResult = {
  kind: string;
  args: string[];
  ok: boolean;
  detail?: string;
  text?: string;        // for --dump
  textCount?: number;   // for --dump (length of the list)
  texts?: string[];     // for --dump-all
};

interface ActionContext {
  page: Page;
  results: ActionResult[];
}

async function resolveLocator(page: Page, selector: string): Promise<Locator> {
  return page.locator(selector).first();
}

async function runActions(
  page: Page,
  actions: Array<{ kind: string; args: string[] }>,
): Promise<ActionResult[]> {
  const ctx: ActionContext = { page, results: [] };
  for (const a of actions) {
    const entry: ActionResult = { kind: a.kind, args: a.args, ok: false };
    try {
      switch (a.kind) {
        case 'click': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          await loc.click({ timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'dblclick': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          await loc.dblclick({ timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'hover': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          await loc.hover({ timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'type-into': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          // `pressSequentially` so each keystroke fires — matches user
          // typing and triggers autocomplete refresh predictably.
          await loc.focus();
          await loc.pressSequentially(a.args[1], { delay: 15 });
          entry.ok = true;
          break;
        }
        case 'select': {
          // Native <select> elements: Playwright's selectOption matches by
          // value, label, or index — try label first (what a human reads).
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          await loc.selectOption({ label: a.args[1] }, { timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'fill': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 5000 });
          await loc.fill(a.args[1], { timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'press': {
          await ctx.page.keyboard.press(a.args[0]);
          entry.ok = true;
          break;
        }
        case 'wait-for': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.waitFor({ state: 'visible', timeout: 10000 });
          entry.ok = true;
          break;
        }
        case 'wait': {
          await ctx.page.waitForTimeout(Number(a.args[0]));
          entry.ok = true;
          break;
        }
        case 'dump': {
          const loc = await resolveLocator(ctx.page, a.args[0]);
          const text = await loc.textContent({ timeout: 5000 });
          entry.text = (text ?? '').trim();
          entry.ok = true;
          break;
        }
        case 'dump-all': {
          // Returns the textContent of every match — handy for reading
          // a list / dropdown / set of cards without writing a CSS
          // sub-selector for each row.
          const all = await ctx.page.locator(a.args[0]).all();
          const texts: string[] = [];
          for (const el of all) {
            const t = await el.textContent();
            texts.push((t ?? '').trim());
          }
          entry.texts = texts;
          entry.textCount = texts.length;
          entry.ok = true;
          break;
        }
        case 'eval': {
          // Run an arbitrary JS expression in the page context and
          // capture its result (JSON-serialised). Useful for inspecting
          // Zustand stores, React Query caches, or any window-attached
          // debug hooks the app exposes.
          const result = await ctx.page.evaluate((expr) => {
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const fn = new Function(`return (${expr});`);
            try {
              const val = fn();
              return JSON.stringify(val, (_k, v) => (typeof v === 'function' ? '[fn]' : v));
            } catch (err) {
              return `__error__:${err instanceof Error ? err.message : String(err)}`;
            }
          }, a.args[0]);
          entry.text = result ?? '';
          entry.ok = !(entry.text ?? '').startsWith('__error__:');
          if (!entry.ok) entry.detail = entry.text;
          break;
        }
        case 'drag': {
          // Press on an element and move by an offset — a REAL mouse drag
          // (down, several moves, up), which is the only way to exercise
          // drag-to-pan / drag-to-reorder surfaces. `--drag '<sel>' '-320,0'`
          // drags the selector's centre 320px left.
          // An empty patch of canvas has no element of its own to name, so the
          // start point may also be given as viewport coordinates: '@280,400'.
          const [dx, dy] = a.args[1].split(',').map((n) => Number(n.trim()));
          let from: { x: number; y: number };
          if (a.args[0].startsWith('@')) {
            const [x, y] = a.args[0].slice(1).split(',').map((n) => Number(n.trim()));
            from = { x, y };
          } else {
            const loc = await resolveLocator(ctx.page, a.args[0]);
            await loc.waitFor({ state: 'visible', timeout: 5000 });
            const box = await loc.boundingBox();
            if (!box) throw new Error('element has no box to drag from');
            from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          }
          await ctx.page.mouse.move(from.x, from.y);
          await ctx.page.mouse.down();
          // Several steps: a single jump can be swallowed as a click by
          // handlers that wait for movement before treating it as a drag.
          for (let step = 1; step <= 8; step++) {
            await ctx.page.mouse.move(
              from.x + ((dx || 0) * step) / 8,
              from.y + ((dy || 0) * step) / 8,
            );
          }
          await ctx.page.mouse.up();
          entry.detail = `from ${Math.round(from.x)},${Math.round(from.y)} by ${dx || 0},${dy || 0}`;
          entry.ok = true;
          break;
        }
        case 'upload': {
          // Attach a local file to a file input (visible or hidden) —
          // e.g. --upload 'input[type=file]' /tmp/note.txt
          const loc = await resolveLocator(ctx.page, a.args[0]);
          await loc.setInputFiles(a.args[1], { timeout: 5000 });
          entry.ok = true;
          break;
        }
        case 'snap': {
          // Mid-flow screenshot, named by index so multiple calls don't
          // collide.
          const path = a.args[0];
          mkdirSync(dirname(path), { recursive: true });
          await ctx.page.screenshot({ path, fullPage: true });
          entry.detail = path;
          entry.ok = true;
          break;
        }
        default:
          entry.detail = `unknown action: ${a.kind}`;
      }
    } catch (err) {
      entry.detail = err instanceof Error ? err.message : String(err);
    }
    ctx.results.push(entry);
    if (!entry.ok) {
      // Halt at first failure so subsequent actions don't operate on
      // a stale assumption (e.g. typing into a textarea that never
      // appeared). The caller sees exactly where things broke.
      break;
    }
  }
  return ctx.results;
}

// Argv parser for `interact`: walks the args and groups them into
// actions. Each action flag has a fixed arity so we know how many
// positional args to consume. `--out` and `--wait` (when used as a
// post-load wait) are special: --out is the final screenshot path,
// --initial-wait is the post-navigation settle delay.
const ACTION_ARITY: Record<string, number> = {
  '--click': 1,
  '--dblclick': 1,
  '--hover': 1,
  '--type-into': 2,
  '--fill': 2,
  '--select': 2,
  '--press': 1,
  '--wait-for': 1,
  '--wait': 1,
  '--dump': 1,
  '--dump-all': 1,
  '--snap': 1,
  '--eval': 1,
  '--upload': 2,
  '--drag': 2,
};

const ACTION_KIND: Record<string, string> = {
  '--click': 'click',
  '--dblclick': 'dblclick',
  '--hover': 'hover',
  '--type-into': 'type-into',
  '--fill': 'fill',
  '--select': 'select',
  '--press': 'press',
  '--wait-for': 'wait-for',
  '--wait': 'wait',
  '--dump': 'dump',
  '--dump-all': 'dump-all',
  '--snap': 'snap',
  '--eval': 'eval',
  '--upload': 'upload',
  '--drag': 'drag',
};

async function interact(args: string[]) {
  // First positional = path. Then global flags + action flags. Globals
  // we recognise: --out, --initial-wait, --admin.
  const path = args[0] && !args[0].startsWith('--') ? args[0] : '/';
  const startIdx = args[0] && !args[0].startsWith('--') ? 1 : 0;

  let out: string | undefined;
  let initialWaitMs = 1500;
  let useAdmin = false;
  let acceptDialogs = false;
  let viewport = { width: 1440, height: 900 };
  const actions: Array<{ kind: string; args: string[] }> = [];

  for (let i = startIdx; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') { out = args[++i]; continue; }
    if (a === '--initial-wait') { initialWaitMs = Number(args[++i]); continue; }
    if (a === '--admin') { useAdmin = true; continue; }
    if (a === '--viewport') {
      const m = args[++i]?.match(/^(\d+)x(\d+)$/);
      if (m) viewport = { width: Number(m[1]), height: Number(m[2]) };
      continue;
    }
    // Playwright DISMISSES window.confirm/alert by default, which no-ops
    // any flow behind a confirm dialog ("Run now", "Delete"). Opt in.
    if (a === '--accept-dialogs') { acceptDialogs = true; continue; }
    if (a in ACTION_ARITY) {
      const kind = ACTION_KIND[a]!;
      const arity = ACTION_ARITY[a]!;
      const vals: string[] = [];
      for (let j = 0; j < arity; j++) vals.push(args[++i]);
      actions.push({ kind, args: vals });
      continue;
    }
    throw new Error(`Unknown flag: ${a}. See ui.ts header for usage.`);
  }

  const baseUrl = useAdmin ? APP_ADMIN_URL : APP_BASE_URL;
  const seed = await ensureDevLoopTeam();
  const targetUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const browser = await chromium.launch({ headless: true });
  const log: ActionResult[] = [];
  let landedAt = '';
  let status: number | undefined;
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    if (acceptDialogs) {
      page.on('dialog', (dialog) => void dialog.accept());
    }
    await injectAuth(page, baseUrl, seed.token, seed.teamId);

    // Capture all trpc requests + responses so failed queries surface
    // in the action log even when they don't break the visible UI.
    const trpcLog: Array<{ url: string; status: number; error?: string }> = [];
    const trpcRequests: string[] = [];
    const consoleErrors: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/trpc/')) {
        trpcRequests.push(url.split('?')[0]!);
      }
    });
    page.on('response', async (resp) => {
      const url = resp.url();
      if (!url.includes('/api/trpc/')) return;
      let error: string | undefined;
      try {
        const body = await resp.text();
        const match = body.match(/"error":\s*\{[^}]*"message":"([^"]+)"/);
        if (match) error = match[1];
      } catch {
        // ignore
      }
      trpcLog.push({ url: url.split('?')[0]!, status: resp.status(), error });
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`[pageerror] ${err.message}`);
    });

    const navResponse = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = navResponse?.status();
    if (initialWaitMs > 0) await page.waitForTimeout(initialWaitMs);

    const results = await runActions(page, actions);
    log.push(...results);
    // Append trpc summary as a final synthetic entry — surfaces failed
    // queries without forcing every caller to add a `--dump` for them.
    if (trpcLog.length > 0 || trpcRequests.length > 0) {
      const trpcErrors = trpcLog.filter((r) => r.error || r.status >= 400);
      const reqOnly = trpcRequests.filter((u) => !trpcLog.some((r) => r.url === u));
      log.push({
        kind: 'trpc-summary',
        args: [],
        ok: trpcErrors.length === 0,
        detail: `${trpcRequests.length} requests, ${trpcLog.length} responses, ${trpcErrors.length} errors${reqOnly.length ? `, ${reqOnly.length} requests without response` : ''}`,
        texts: [
          ...trpcErrors.map((r) => `ERR ${r.status} ${r.url} :: ${r.error ?? ''}`),
          ...reqOnly.map((u) => `NO-RESP ${u}`),
        ],
      });
    }
    if (consoleErrors.length > 0) {
      log.push({
        kind: 'console-errors',
        args: [],
        ok: false,
        detail: `${consoleErrors.length} console errors/warnings`,
        texts: consoleErrors,
      });
    }

    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out, fullPage: true });
    }
    landedAt = page.url();
  } finally {
    await browser.close();
  }

  return {
    target: targetUrl,
    landedAt,
    status,
    out,
    actions: log,
    allOk: log.every((r) => r.ok),
  };
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (subcommand === 'screenshot' || subcommand === 'shot') {
    const out = await screenshot(rest);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (subcommand === 'interact') {
    const out = await interact(rest);
    console.log(JSON.stringify(out, null, 2));
    if (!out.allOk) process.exit(3);
    return;
  }

  console.error('Usage:');
  console.error('  pnpm dev:ui screenshot <path> [--out file.png] [--admin] [--wait <ms>]');
  console.error('  pnpm dev:ui interact <path> --click <sel> --type-into <sel> <text> ... [--out file.png]');
  console.error('Actions: --click --dblclick --hover --drag <sel> <dx,dy> --type-into --fill --press --wait-for --wait --dump --dump-all --snap');
  console.error('Selectors use Playwright syntax: text=Foo, role=button[name=Save], or any CSS selector.');
  process.exit(2);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
