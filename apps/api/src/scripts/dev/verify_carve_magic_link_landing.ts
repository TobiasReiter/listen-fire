/**
 * Phase 5.2b e2e: the passwordless login path, rebuilt on apps/web.
 *
 * Drives the REAL chain — request a link, read the email the fake channel
 * actually received, open its URL in a CLEAN browser context (no injected
 * cookie, no seeded localStorage: the link itself has to do the authenticating)
 * and check where we land and what session cookies exist afterwards.
 *
 * Five claims:
 *   1. the emailed link points at the WEB app, not the deleted apps/app
 *   2. clicking it lands an authenticated session on /dashboard
 *   3. the same link a second time shows the expired/used error state
 *   4. a hostile `redirectUrl` is ignored (open-redirect guard)
 */
import { mkdirSync } from 'node:fs';

import { chromium, type BrowserContext } from 'playwright';

import { ensureDevLoopTeam, DEV_LOOP_EMAIL } from './_lib';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const WEB_BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3003';
const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';
const SHOT_DIR = process.env.DEV_LOOP_SCREENSHOT_DIR || '/tmp/dev-loop-ui';

interface OutboxMessage {
  id: string;
  recipients: Array<{ email: string }>;
  subject: string;
  data: string;
}

const results: Array<{ claim: string; ok: boolean; detail: string }> = [];
function record(claim: string, ok: boolean, detail: string) {
  results.push({ claim, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}\n      ${detail}`);
}

async function clearOutbox() {
  await fetch(`${FAKE_CHANNELS_URL}/email/outbox`, { method: 'DELETE' });
}

/** Ask for a magic link and return the URL the recipient actually received. */
async function requestMagicLinkUrl(email: string): Promise<string> {
  await clearOutbox();
  const res = await fetch(`${API_BASE_URL}/api/public/auth/requestMagicLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`requestMagicLink ${res.status}`);

  const { data } = (await (
    await fetch(`${FAKE_CHANNELS_URL}/email/outbox`)
  ).json()) as { data: OutboxMessage[] };
  const message = data.find((m) => m.recipients.some((r) => r.email === email));
  if (!message) throw new Error(`no email reached ${email} (outbox has ${data.length})`);

  const match = message.data.match(/https?:\/\/[^"'\s<>]*\/magic\?[^"'\s<>]*/);
  if (!match) throw new Error(`no magic URL in email body:\n${message.data.slice(0, 600)}`);
  return match[0].replace(/&amp;/g, '&');
}

/** Open a URL with NO prior session and report where it landed + what cookies exist. */
async function visitClean(
  context: BrowserContext,
  url: string,
  shot: string,
): Promise<{ landedAt: string; cookies: string[]; errorShown: boolean }> {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Either we get redirected into the app, or the error state renders.
  await page
    .waitForFunction(
      () =>
        !window.location.pathname.startsWith('/magic') ||
        !!document.querySelector('[data-testid="magic-error"]'),
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${shot}`, fullPage: true });

  const landedAt = page.url();
  const cookies = (await context.cookies()).map((c) => c.name);
  const errorShown = (await page.locator('[data-testid="magic-error"]').count()) > 0;
  return { landedAt, cookies, errorShown };
}

async function main() {
  const seed = await ensureDevLoopTeam();
  const email = seed.email ?? DEV_LOOP_EMAIL;
  const browser = await chromium.launch({ headless: true });

  // ── 1 + 2: the emailed link points at the web app and signs you in ────────
  const magicUrl = await requestMagicLinkUrl(email);
  record(
    'emailed magic link targets the WEB app',
    magicUrl.startsWith(`${WEB_BASE_URL}/magic?`),
    `${magicUrl.replace(/token=[^&]+/, 'token=…')}  (expected prefix ${WEB_BASE_URL}/magic?)`,
  );

  const fresh = await browser.newContext();
  const first = await visitClean(fresh, magicUrl, 'magic-success.png');
  record(
    'clicking the link lands an authenticated session',
    first.landedAt.startsWith(`${WEB_BASE_URL}/dashboard`) &&
      first.cookies.includes('listen_fire_token') &&
      first.cookies.includes('listen_fire_authed'),
    `landedAt=${first.landedAt} cookies=[${first.cookies.join(', ')}]`,
  );
  await fresh.close();

  // ── 3: single-use — the same link again is expired ────────────────────────
  const reused = await browser.newContext();
  const second = await visitClean(reused, magicUrl, 'magic-expired.png');
  record(
    'a used link shows the expired/invalid state',
    second.errorShown && !second.cookies.includes('listen_fire_token'),
    `errorShown=${second.errorShown} landedAt=${second.landedAt} cookies=[${second.cookies.join(', ')}]`,
  );
  await reused.close();

  // ── 4: open-redirect guard ────────────────────────────────────────────────
  const hostileUrl = `${await requestMagicLinkUrl(email)}&redirectUrl=${encodeURIComponent(
    'https://evil.example.com/steal',
  )}`;
  const hostile = await browser.newContext();
  const third = await visitClean(hostile, hostileUrl, 'magic-open-redirect.png');
  record(
    'a foreign redirectUrl is ignored',
    third.landedAt.startsWith(`${WEB_BASE_URL}/dashboard`) && !third.landedAt.includes('evil.example'),
    `landedAt=${third.landedAt}`,
  );
  await hostile.close();

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} claims passed`);
  console.log(`screenshots in ${SHOT_DIR}`);
  if (failed.length) throw new Error(`${failed.length} claim(s) failed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
