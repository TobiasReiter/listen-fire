// Where the provider sends the person back after they sign in, for `lf
// credential add` / `update` of an OAuth 2 credential. Three ways, because lf
// runs on a laptop, on a headless box over ssh, and deployed behind a URL:
//
//   loopback (default)  lf listens on 127.0.0.1 for the one redirect
//                       (RFC 8252); the redirect URI is
//                       http://127.0.0.1:<port>/callback.
//   headless            lf prints the authorize URL and reads back the URL
//                       the browser was sent to (it fails to load; it is
//                       copied from the address bar). Same redirect URI, so
//                       the port must be the registered one.
//   public              the redirect URI is <publicUrl>/oauth/callback, which
//                       `lf serve` answers by leaving the redirect in .lf/oauth
//                       for the waiting command to pick up.
//
// The provider's app must register the redirect URI used: `lf connect
// <module>` prints them.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { createOAuth2Connector, type OAuth2ClientApp, type OAuth2Declaration, type OAuth2Grant } from 'movement-engine/public/secrets';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import type { Prompter } from './prompt';

export const LOOPBACK_CALLBACK_PATH = '/callback';
export const PUBLIC_CALLBACK_PATH = '/oauth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PICKUP_POLL_MS = 200;

export type RedirectMode =
  | { kind: 'loopback'; port: number; openBrowser: boolean }
  | { kind: 'headless'; port: number }
  | { kind: 'public'; publicUrl: string; lfDir: string };

export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}`;
}

export function publicRedirectUri(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${PUBLIC_CALLBACK_PATH}`;
}

interface Redirect {
  state: string;
  code: string;
  /** Tell the browser how it went (loopback only). */
  answer(status: number, text: string): void;
}

/** Sign the person in at the provider and exchange the code: the tokens. */
export async function authorizeAtProvider(input: {
  oauth2: OAuth2Declaration;
  client: OAuth2ClientApp;
  mode: RedirectMode;
  prompter: Prompter;
  /** What is being connected, for the lines printed. */
  label: string;
  timeoutMs?: number;
}): Promise<OAuth2Grant> {
  const { mode, prompter, label } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listener = mode.kind === 'loopback' ? await loopback(mode.port) : undefined;
  try {
    const redirectUri = (() => {
      switch (mode.kind) {
        case 'loopback':
          return listener?.redirectUri ?? loopbackRedirectUri(mode.port);
        case 'headless':
          return loopbackRedirectUri(mode.port);
        case 'public':
          return publicRedirectUri(mode.publicUrl);
        default:
          return neverAsAny(mode);
      }
    })();
    const connector = createOAuth2Connector({ oauth2: input.oauth2, client: input.client, redirectUri });
    const state = randomBytes(32).toString('base64url');
    const url = connector.begin({ state });
    prompter.print(`open this URL to sign in for ${label}:\n  ${url}`);
    let back: Redirect;
    switch (mode.kind) {
      case 'loopback':
        if (mode.openBrowser) openInBrowser(url);
        if (listener === undefined) throw new Error('the loopback listener did not start');
        back = await listener.next(timeoutMs);
        break;
      case 'headless':
        back = redirectFrom(await prompter.ask('paste the URL your browser was sent back to (it will not load; copy it from the address bar)'));
        break;
      case 'public':
        prompter.print(`waiting for the provider to send you back to ${redirectUri} (lf serve must be running there)`);
        back = await pickUp({ lfDir: mode.lfDir, state, timeoutMs });
        break;
      default:
        return neverAsAny(mode);
    }
    if (back.state !== state) {
      back.answer(400, 'This sign-in is not the one lf is waiting for.');
      throw new Error('the redirect carried another sign-in\'s state; start again');
    }
    try {
      const grant = await connector.complete(back);
      back.answer(200, `Signed in for ${label}. You can close this tab.`);
      return grant;
    } catch (error) {
      back.answer(400, `Signing in for ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  } finally {
    await listener?.close();
  }
}

/** The code and state in a redirect URL, or the provider's refusal. */
function redirectFrom(pasted: string): Redirect {
  let url: URL;
  try {
    url = new URL(pasted);
  } catch {
    throw new Error('that is not a URL; paste the whole address the browser was sent to');
  }
  return redirectOf(url.searchParams, () => {});
}

function redirectOf(query: URLSearchParams, answer: Redirect['answer']): Redirect {
  const error = query.get('error');
  const code = query.get('code');
  const state = query.get('state');
  if (error !== null || code === null || state === null) {
    const why = error !== null ? `the provider answered ${error}${describe(query.get('error_description'))}` : 'the redirect carried no code or state';
    answer(400, `Signing in failed: ${why}`);
    throw new Error(`signing in failed: ${why}`);
  }
  return { state, code, answer };
}

function describe(text: string | null): string {
  return text !== null && text !== '' ? ` (${text})` : '';
}

/** A listener on the loopback interface for the provider's one redirect. */
async function loopback(port: number): Promise<{ redirectUri: string; next(timeoutMs: number): Promise<Redirect>; close(): Promise<void> }> {
  let deliver: ((redirect: Redirect) => void) | undefined;
  let refuse: ((error: Error) => void) | undefined;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== LOOPBACK_CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const answer = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${text}\n`);
    };
    let redirect: Redirect;
    try {
      redirect = redirectOf(url.searchParams, answer);
    } catch (error) {
      refuse?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    deliver?.(redirect);
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('the loopback listener has no address');
  return {
    redirectUri: loopbackRedirectUri(address.port),
    next: (timeoutMs) =>
      new Promise<Redirect>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`no redirect came back within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
        deliver = (redirect) => {
          clearTimeout(timer);
          ok(redirect);
        };
        refuse = (error) => {
          clearTimeout(timer);
          fail(error);
        };
      }),
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// ── The public redirect, through lf serve ──────────────────────────────────
// The waiting command leaves a marker named by the state's hash; `lf serve`
// writes a redirect only where a marker waits, so its route cannot be used to
// write arbitrary files, and the state itself never names a file.

function pickupDir(lfDir: string): string {
  return join(lfDir, 'oauth');
}

function pickupName(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

const PickedUp = z.object({ query: z.string() });

async function pickUp(input: { lfDir: string; state: string; timeoutMs: number }): Promise<Redirect> {
  const dir = pickupDir(input.lfDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, pickupName(input.state));
  writeFileSync(`${base}.waiting`, '', { mode: 0o600 });
  const started = Date.now();
  try {
    for (;;) {
      if (existsSync(`${base}.json`)) {
        const { query } = PickedUp.parse(JSON.parse(readFileSync(`${base}.json`, 'utf8')));
        return redirectOf(new URLSearchParams(query), () => {});
      }
      if (Date.now() - started > input.timeoutMs) throw new Error(`no redirect came back within ${Math.round(input.timeoutMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, PICKUP_POLL_MS));
    }
  } finally {
    rmSync(`${base}.waiting`, { force: true });
    rmSync(`${base}.json`, { force: true });
  }
}

/** `lf serve`'s answer to GET /oauth/callback?…: hand the redirect to the
 *  command waiting for its state. */
export function deliverPublicRedirect(lfDir: string, query: string): { status: number; text: string } {
  const state = new URLSearchParams(query).get('state');
  if (state === null || state === '') return { status: 400, text: 'This redirect carries no state.' };
  const base = join(pickupDir(lfDir), pickupName(state));
  if (!existsSync(`${base}.waiting`)) return { status: 404, text: 'No `lf credential` command is waiting for this sign-in; start it again.' };
  writeFileSync(`${base}.json`, JSON.stringify({ query }), { mode: 0o600 });
  return { status: 200, text: 'lf has the sign-in. Return to the terminal where `lf credential` is waiting.' };
}

/** The system's own opener; a failure to open is not fatal, the URL is printed. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
