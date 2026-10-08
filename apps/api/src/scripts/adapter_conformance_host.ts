// The host double of the adapter conformance CLI: a tiny HTTP server standing
// in for Listen-Fire's side of an adapter install. It serves the two push
// doors a vendor calls (`emit`, `wake`) and a subscription callback, and
// records what arrived. It checks what a vendor controls — the credential it
// presents and the shape of the body — against the real door's own schemas.
// It cannot check what the real host does with a push.

import http from 'node:http';

import { AdapterEmitBody, AdapterWakeBody } from 'engine-contracts';

export type DoorName = 'emit' | 'wake';

export interface ReceivedPush {
  door: DoorName;
  /** The door accepted it: the credential matched and the body parsed. */
  accepted: boolean;
  /** Why not, when it was refused. */
  problem?: string;
}

export interface HostDouble {
  /** The base URL a vendor puts where it would put the host's API base URL. */
  url: string;
  /** The URL the CLI hands to `ensureEventSubscription` as the callback. */
  callbackUrl: string;
  pushes: readonly ReceivedPush[];
  /** Resolves once every door in `doors` has received a push, or after `seconds`. */
  waitForPushes: (input: { doors: readonly DoorName[]; seconds: number }) => Promise<void>;
  close: () => Promise<void>;
}

const CALLBACK_PATH = '/webhook-sync/adapter-conformance/callback';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function credentialPresented(
  headers: http.IncomingHttpHeaders,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(([name, value]) => headers[name.toLowerCase()] === value);
}

function teamHeaderProblem(headers: http.IncomingHttpHeaders, teamHeader: string): string | undefined {
  const team = headers[teamHeader];
  if (team === undefined) return undefined;
  const isUuid = typeof team === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(team);
  return isUuid ? undefined : `${teamHeader} is present but not a UUID`;
}

export async function startHostDouble(options: {
  adapterType: string;
  /** The headers the install's credential is presented in, name to value. */
  expectedCredential: Record<string, string>;
  teamHeader: string;
  /** 0 picks an ephemeral port. */
  port: number;
}): Promise<HostDouble> {
  const { adapterType, expectedCredential, teamHeader, port: requestedPort } = options;
  const pushes: ReceivedPush[] = [];
  const waiters: Array<() => void> = [];
  const record = (push: ReceivedPush): void => {
    pushes.push(push);
    for (const wake of waiters.splice(0)) wake();
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://host-double').pathname;
      const raw = await readBody(req);
      if (req.method === 'POST' && path === CALLBACK_PATH) {
        send(res, 200, { ok: true });
        return;
      }
      const door = (['emit', 'wake'] as const).find(
        (name) => path === `/api/public/adapter/${adapterType}/${name}`,
      );
      if (req.method !== 'POST' || door === undefined) {
        send(res, 404, { error: 'not_found', message: `the host double serves /api/public/adapter/${adapterType}/{emit,wake}` });
        return;
      }
      if (!credentialPresented(req.headers, expectedCredential)) {
        record({ door, accepted: false, problem: 'the credential did not match the install' });
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      const teamProblem = teamHeaderProblem(req.headers, teamHeader);
      if (teamProblem !== undefined) {
        record({ door, accepted: false, problem: teamProblem });
        send(res, 400, { error: 'bad_request', issues: [{ path: teamHeader, message: teamProblem }] });
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        record({ door, accepted: false, problem: 'the body is not JSON' });
        send(res, 400, { error: 'bad_request', issues: [{ path: '', message: 'the body is not JSON' }] });
        return;
      }
      const parsed = door === 'emit' ? AdapterEmitBody.safeParse(json) : AdapterWakeBody.safeParse(json);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
        const first = issues[0];
        record({ door, accepted: false, problem: first ? `${first.path || '(body)'}: ${first.message}` : 'malformed body' });
        send(res, 400, { error: 'bad_request', issues });
        return;
      }
      record({ door, accepted: true });
      send(res, 202, { accepted: 'events' in parsed.data ? parsed.data.events.length : parsed.data.keys.length });
    })().catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(requestedPort, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('conformance host double: the server is not listening on a TCP port.');
  }
  const url = `http://127.0.0.1:${address.port}`;

  const hasAll = (doors: readonly DoorName[]): boolean =>
    doors.every((door) => pushes.some((push) => push.door === door));

  return {
    url,
    callbackUrl: `${url}${CALLBACK_PATH}`,
    pushes,
    waitForPushes: ({ doors, seconds }) =>
      new Promise<void>((resolve) => {
        if (seconds <= 0 || hasAll(doors)) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, seconds * 1000);
        const check = (): void => {
          if (hasAll(doors)) {
            clearTimeout(timer);
            resolve();
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
