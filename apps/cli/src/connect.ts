// `lf connect <credential>`: connect an OAuth 2 credential the way its
// external's manifest declares (`credentials[].oauth2`), through the engine's
// connect flow, the same one the hosted product's OAuth flows run on. lf opens
// the provider's authorize page, takes the redirect on a loopback listener
// (RFC 8252), exchanges the code, and writes the tokens to the secrets file
// the credential is in, through the secrets family.
//
// The credential must already name its external and lf's registered app at
// the provider (`client_id`, and `client_secret` unless the provider takes a
// public client): those are the operator's, and connect only adds the tokens.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createOAuth2Connector, storeGrant, type OAuth2Declaration } from 'movement-engine/public/secrets';
import type { WireCredentialDeclarationShape } from 'engine-contracts';
import { LOCAL_TENANT } from './host';
import { scanExternals, startExternals } from './externals';
import type { Project } from './project';
import { loadSecrets, secretsOf, type Credential } from './secrets';

const CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface ConnectOptions {
  /** The loopback port the provider redirects to; 0 picks a free one. A
   *  provider that matches redirect URIs exactly needs the registered one. */
  redirectPort?: number;
  /** Open the authorize URL in the system browser (default); otherwise only
   *  print it. */
  openBrowser?: boolean;
  timeoutMs?: number;
  /** Where progress lines go. */
  print?: (line: string) => void;
}

export async function connectCredential(project: Project, name: string, options: ConnectOptions = {}): Promise<{ external: string }> {
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const credentials = loadSecrets(project);
  const credential = credentials.get(name);
  if (credential === undefined) {
    throw new Error(
      `credential "${name}" is not in the secrets. Add it first, naming its external and your app at the provider:\n` +
        `  ${name}:\n    external: <external>\n    client_id: <your app's client id>\n    client_secret: <your app's client secret>`,
    );
  }
  if (credential.origin.file === undefined) {
    throw new Error(`credential "${name}" comes from the environment only; lf connect writes the tokens to a secrets file, so add "${name}" to one first`);
  }
  const clientId = credential.fields.client_id;
  if (clientId === undefined || clientId === '') {
    throw new Error(`credential "${name}" has no client_id: add your app's client id (and client_secret) at the provider to it first`);
  }
  const clientSecret = credential.fields.client_secret;
  const oauth2 = await declaredOAuth2(project, credential, credentials);

  const listener = await loopback(options.redirectPort ?? 0);
  try {
    const connector = createOAuth2Connector({
      oauth2,
      client: { clientId, ...(clientSecret !== undefined ? { clientSecret } : {}) },
      redirectUri: listener.redirectUri,
    });
    const url = connector.begin();
    print(`open this URL to connect "${name}" (${credential.external}):\n  ${url}`);
    if (options.openBrowser !== false) openInBrowser(url);
    const back = await listener.next(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const grant = await connector.complete(back);
      await storeGrant(secretsOf(credential), name, grant);
      back.answer(200, `Connected "${name}". You can close this tab.`);
    } catch (error) {
      back.answer(400, `Connecting "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    print(`connected ${name} (${credential.external}); its tokens are in ${credential.origin.file.path}`);
    return { external: credential.external };
  } finally {
    await listener.close();
  }
}

/** The external's declaration of this credential, from its manifest answer:
 *  its one `oauth2` credential, or the one named like this credential. */
async function declaredOAuth2(project: Project, credential: Credential, credentials: Map<string, Credential>): Promise<OAuth2Declaration> {
  const external = scanExternals(project).find((e) => e.manifest.name === credential.external);
  if (external === undefined) throw new Error(`credential "${credential.name}" is for external "${credential.external}", which is not installed in ${project.externalsDir}`);
  const running = await startExternals({ project, externals: [external], credentials, tenant: LOCAL_TENANT });
  let declared: WireCredentialDeclarationShape[];
  try {
    declared = running.get(credential.external)?.credentials ?? [];
  } finally {
    for (const r of running.values()) r.stop();
  }
  const oauth2 = declared.flatMap((d) => (d.kind === 'oauth2' ? [d] : []));
  const chosen = oauth2.length === 1 ? oauth2[0] : oauth2.find((d) => d.name === credential.name);
  if (chosen === undefined) {
    throw new Error(
      oauth2.length === 0
        ? `external "${credential.external}" declares no oauth2 credential in its manifest; there is nothing to connect`
        : `external "${credential.external}" declares several oauth2 credentials (${oauth2.map((d) => d.name).join(', ')}); name the secrets entry like the one to connect`,
    );
  }
  return chosen.oauth2;
}

interface Redirect {
  state: string;
  code: string;
  answer(status: number, text: string): void;
}

/** A listener on the loopback interface for the provider's one redirect. */
async function loopback(port: number): Promise<{ redirectUri: string; next(timeoutMs: number): Promise<Redirect>; close(): Promise<void> }> {
  let deliver: ((redirect: Redirect) => void) | undefined;
  let refuse: ((error: Error) => void) | undefined;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const answer = (status: number, text: string) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`${text}\n`);
    };
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (error !== null || code === null || state === null) {
      const why = error !== null ? `the provider answered ${error}${describe(url.searchParams.get('error_description'))}` : 'the redirect carried no code or state';
      answer(400, `Connecting failed: ${why}`);
      refuse?.(new Error(`connect failed: ${why}`));
      return;
    }
    deliver?.({ state, code, answer });
  });
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('the loopback listener has no address');
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
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

function describe(text: string | null): string {
  return text !== null && text !== '' ? ` (${text})` : '';
}

/** The system's own opener; a failure to open is not fatal, the URL is printed. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}
