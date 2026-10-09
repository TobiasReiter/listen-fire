/**
 * Phase 5.3 verification: drive the magic-link REQUEST affordance on
 * apps/web's /login through the real browser UI, in a clean Playwright
 * context (no injected seed cookie — dev:ui would mask exactly the thing
 * under test). Then read the emailed link out of the fake-channel outbox
 * and open it in the same clean-context style to confirm it lands
 * authenticated on /dashboard.
 *
 * Also checks the non-enumeration contract: requesting for an email with
 * no account reaches the same confirmation UI and sends no email.
 */
import { mkdirSync } from 'node:fs';

import { chromium, type BrowserContext } from 'playwright';

import { ensureDevLoopTeam, DEV_LOOP_EMAIL } from './_lib';

const WEB_BASE_URL = process.env.WEB_BASE_URL || 'http://localhost:3503';
const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:6056';
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

async function getOutbox(): Promise<OutboxMessage[]> {
  const { data } = (await (await fetch(`${FAKE_CHANNELS_URL}/email/outbox`)).json()) as {
    data: OutboxMessage[];
  };
  return data;
}

async function main() {
  const seed = await ensureDevLoopTeam();
  const email = seed.email ?? DEV_LOOP_EMAIL;
  mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // ── 1: drive the UI request, seeded email ──────────────────────────────
  await clearOutbox();
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();
  await page1.goto(`${WEB_BASE_URL}/login`, { waitUntil: 'networkidle' });

  const preCookies1 = (await ctx1.cookies()).map((c) => c.name);
  record(
    'clean context carries no seed session cookie before interacting',
    !preCookies1.includes('listen_fire_token') && !preCookies1.includes('listen_fire_authed'),
    `cookies before interaction=[${preCookies1.join(', ')}]`,
  );

  // Wait for client hydration to finish before typing — filling too early
  // (pre-hydration) sets the DOM value but React's controlled state stays
  // empty, and hydration then resets the input, leaving the disabled button
  // permanently disabled.
  await page1.waitForFunction(
    () => (document.querySelector('[data-testid="login-magic-link-request"]') as HTMLButtonElement | null)?.disabled === true,
    undefined,
    { timeout: 10_000 },
  ).catch(() => undefined);
  await page1.fill('[data-testid="login-email"]', email);
  await page1.waitForFunction(
    () => (document.querySelector('[data-testid="login-magic-link-request"]') as HTMLButtonElement | null)?.disabled === false,
    undefined,
    { timeout: 5_000 },
  );
  await page1.click('[data-testid="login-magic-link-request"]');
  await page1.waitForSelector('[data-testid="login-magic-link-sent"]', { timeout: 10_000 });
  await page1.screenshot({ path: `${SHOT_DIR}/carve-magic-link-sent.png`, fullPage: true });
  record('confirmation state renders after requesting (seeded email)', true, 'login-magic-link-sent visible');

  const outboxAfterSeeded = await getOutbox();
  const seededMsg = outboxAfterSeeded.find((m) => m.recipients.some((r) => r.email === email));
  record(
    'an email actually landed in the outbox for the seeded address',
    !!seededMsg,
    `outbox has ${outboxAfterSeeded.length} message(s); match for ${email}: ${!!seededMsg}`,
  );

  const match = seededMsg?.data.match(/https?:\/\/[^"'\s<>]*\/magic\?[^"'\s<>]*/);
  const magicUrl = match ? match[0].replace(/&amp;/g, '&') : '';
  record('magic link URL extracted from email body', !!magicUrl, magicUrl ? magicUrl.replace(/token=[^&]+/, 'token=…') : '(none found)');
  await ctx1.close();

  // ── 2: open the emailed link in a fresh clean context, land on /dashboard ──
  if (magicUrl) {
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(magicUrl, { waitUntil: 'domcontentloaded' });
    await page2
      .waitForFunction(() => !window.location.pathname.startsWith('/magic'), undefined, { timeout: 20_000 })
      .catch(() => undefined);
    await page2.waitForTimeout(1500);
    await page2.screenshot({ path: `${SHOT_DIR}/carve-magic-link-landing.png`, fullPage: true });

    const landedAt = page2.url();
    const cookies = (await ctx2.cookies()).map((c) => c.name);
    record(
      'clicking the emailed link lands authenticated on /dashboard with session cookies',
      landedAt.startsWith(`${WEB_BASE_URL}/dashboard`) &&
        cookies.includes('listen_fire_token') &&
        cookies.includes('listen_fire_authed'),
      `landedAt=${landedAt} cookies=[${cookies.join(', ')}]`,
    );
    await ctx2.close();
  } else {
    record('clicking the emailed link lands authenticated on /dashboard with session cookies', false, 'skipped: no magic URL extracted');
  }

  // ── 3: non-enumeration — an email with NO account gets same confirmation, no email sent ──
  const bogusEmail = `no-such-account-${Date.now()}@listen-fire.local`;
  await clearOutbox();
  const ctx3 = await browser.newContext();
  const page3 = await ctx3.newPage();
  await page3.goto(`${WEB_BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page3.fill('[data-testid="login-email"]', bogusEmail);
  await page3.waitForFunction(
    () => (document.querySelector('[data-testid="login-magic-link-request"]') as HTMLButtonElement | null)?.disabled === false,
    undefined,
    { timeout: 5_000 },
  );
  await page3.click('[data-testid="login-magic-link-request"]');
  const sawConfirmation = await page3
    .waitForSelector('[data-testid="login-magic-link-sent"]', { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  await page3.screenshot({ path: `${SHOT_DIR}/carve-magic-link-sent-nonexistent.png`, fullPage: true });
  record(
    'requesting for a non-existent account reaches the same confirmation state',
    sawConfirmation,
    `sawConfirmation=${sawConfirmation}`,
  );

  const outboxAfterBogus = await getOutbox();
  const bogusMsg = outboxAfterBogus.find((m) => m.recipients.some((r) => r.email === bogusEmail));
  record(
    'non-enumeration: no email sent for the non-existent account',
    !bogusMsg,
    `outbox has ${outboxAfterBogus.length} message(s); match for bogus address: ${!!bogusMsg}`,
  );
  await ctx3.close();

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
