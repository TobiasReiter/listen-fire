/**
 * Adapter conformance CLI: run a protocol v2 adapter server through every
 * check a vendor can fail, and report one line per check.
 *
 * Needs no dev loop and no database. It imports the protocol client and the
 * `RemoteAdapter` directly and serves a host double of its own for the push
 * doors and the subscription callback (see `adapter_conformance_host.ts`).
 *
 * Usage:
 *   pnpm adapter:conformance --url <baseUrl> --auth bearer
 *   pnpm adapter:conformance --url <baseUrl> --auth secret --auth-header <name>
 *
 * The secret is read from the environment variable named by `--secret-env`
 * (default ADAPTER_CONFORMANCE_SECRET), never from the command line.
 *
 * Flags:
 *   --url <baseUrl>               your server's protocol endpoint (required)
 *   --auth bearer|secret          how Listen-Fire presents the credential (required)
 *   --auth-header <name>          the header for `--auth secret` (default x-listen-fire-adapter-secret)
 *   --secret-env <VAR>            the env var holding the secret (default ADAPTER_CONFORMANCE_SECRET)
 *   --scratch-type <typeId>       a type the CLI may create, update and delete records of
 *   --scratch-fields '<json>'     the fields to create each scratch record with
 *   --sample-delivery '<json>'    a webhook body your server sends, for preprocessInbound and wakeKeys
 *   --host-port <n>               fixed port for the host double (default: ephemeral)
 *   --wait-for-push <seconds>     wait this long for your server to push to the doors (default 0: skip)
 *   --json                        print the report as a JSON array
 *
 * Without the scratch flags, the checks that write or read records are
 * skipped. Exits 1 if any check fails.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { PROTOCOL_VERSION } from 'engine-contracts';

import type { TeamId } from '../generated/kysely/core/Team';
import type { MutationContext } from '../services/translation_graph/mutation_context';
import {
  ADAPTER_TEAM_HEADER,
  RemoteProtocolError,
  authHeader,
  postRpc,
  type AuthStrategy,
} from '../services/translation_graph/protocol/client';
import {
  createRemoteAdapter,
  fetchRemoteManifest,
  type RemoteAdapter,
  type RemoteAdapterConfig,
  type RemoteManifest,
} from '../services/translation_graph/adapters/remote';
import { makeMetaPosition } from '../services/translation_graph/types';
import type { RelatedResult } from '../services/translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
} from '../services/translation_graph/types';
import { startHostDouble, type HostDouble } from './adapter_conformance_host';

export type CheckStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface ConformanceOptions {
  baseUrl: string;
  authStrategy: AuthStrategy;
  secret: string;
  /** The type the CLI creates, updates and deletes records of, and the fields it creates them with. */
  scratch?: { typeId: string; fields: Record<string, unknown> };
  /** A webhook body the server sends, handed to `preprocessInbound` and `wakeKeys`. */
  sampleDelivery?: unknown;
  hostPort?: number;
  /** How long to wait for the server to push to the host double; 0 skips the door checks. */
  waitForPushSeconds?: number;
  /** Called once the host double is listening, before the checks run. */
  onHostReady?: (info: { hostUrl: string }) => void;
  /** Called when the CLI starts waiting for pushes to the doors. */
  onWaitingForPush?: (info: { hostUrl: string }) => void | Promise<void>;
}

const REQUIRED_METHODS = [
  'listEntryPoints',
  'describe',
  'resolveEntity',
  'getFieldValue',
  'getRelated',
  'createRecord',
  'updateRecord',
  'deleteRecord',
] as const;

const SCRATCH_RECORD_COUNT = 3;
const MAX_PAGES = 1000;
const ADAPTER_TYPE_PLACEHOLDER = 'conformance-target';
const SCRATCH_FLAGS_NOTICE = 'pass --scratch-type <typeId> and --scratch-fields \'<json>\' to run it';

const UUID = z.uuid();

/** The CLI has no team; the header just has to be a well-formed UUID. */
function isTeamId(value: string): value is TeamId {
  return UUID.safeParse(value).success;
}

function mintTeamId(): TeamId {
  const id = randomUUID();
  if (!isTeamId(id)) throw new Error('conformance: could not mint a team id.');
  return id;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordIdOf(related: RelatedResult): string | undefined {
  return related.position.identity.kind === 'stable' ? related.position.identity.recordId : undefined;
}

class Report {
  readonly results: CheckResult[] = [];

  async run(name: string, check: () => Promise<string>): Promise<boolean> {
    try {
      this.results.push({ status: 'PASS', name, detail: await check() });
      return true;
    } catch (err) {
      this.results.push({ status: 'FAIL', name, detail: messageOf(err) });
      return false;
    }
  }

  skip(name: string, detail: string): void {
    this.results.push({ status: 'SKIP', name, detail });
  }
}

function mutationContextFor(adapterType: string): MutationContext {
  return {
    source: { type: 'structured_input', adapterType },
    occurredAt: new Date().toISOString(),
  };
}

/** The version probe `postRpc` cannot send: it hardcodes the current version. */
async function probeOlderVersion(options: {
  baseUrl: string;
  auth: Record<string, string>;
  teamId: TeamId;
}): Promise<string> {
  const res = await fetch(options.baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [ADAPTER_TEAM_HEADER]: options.teamId, ...options.auth },
    body: JSON.stringify({ protocolVersion: '1', method: 'listEntryPoints', cacheScopeId: '<none>', params: {} }),
  });
  if (!res.ok) {
    throw new Error(`answered HTTP ${res.status} to protocolVersion "1"; expected HTTP 200 with ok:false, code protocol_version`);
  }
  const body: unknown = await res.json();
  const parsed = z
    .object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) })
    .safeParse(body);
  if (!parsed.success) {
    throw new Error(`answered protocolVersion "1" with a success or an unrecognised envelope; expected ok:false, code protocol_version`);
  }
  if (parsed.data.error.code !== 'protocol_version') {
    throw new Error(`answered protocolVersion "1" with code ${parsed.data.error.code}; expected protocol_version`);
  }
  return `refused protocolVersion "1": ${parsed.data.error.message}`;
}

async function expectProtocolError(input: {
  call: () => Promise<unknown>;
  code: string;
  messageIncludes?: readonly string[];
}): Promise<string> {
  try {
    await input.call();
  } catch (err) {
    if (!(err instanceof RemoteProtocolError)) throw err;
    if (err.error.code !== input.code) {
      throw new Error(`answered code ${err.error.code} (${err.error.message}); expected ${input.code}`);
    }
    const missing = (input.messageIncludes ?? []).filter((part) => !err.error.message.includes(part));
    if (missing.length > 0) {
      throw new Error(`${input.code} message ${JSON.stringify(err.error.message)} does not name ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
    }
    return `${input.code}: ${err.error.message}`;
  }
  throw new Error(`answered ok; expected ${input.code}`);
}

interface ScratchRecord {
  externalId: string;
}

export async function runConformance(options: ConformanceOptions): Promise<CheckResult[]> {
  const { baseUrl, authStrategy, secret, scratch, sampleDelivery } = options;
  const waitForPushSeconds = options.waitForPushSeconds ?? 0;
  const teamId = mintTeamId();
  const auth = authHeader(authStrategy, secret);
  const report = new Report();

  const config: RemoteAdapterConfig = {
    adapterType: ADAPTER_TYPE_PLACEHOLDER,
    teamId,
    baseUrl,
    authStrategy,
    credentialsId: 'conformance',
  };

  let manifest: RemoteManifest | undefined;
  const manifestOk = await report.run('manifest', async () => {
    manifest = await fetchRemoteManifest(config, secret);
    return `${manifest.adapterType} answers protocol ${PROTOCOL_VERSION}; ${manifest.methods.length} methods advertised`;
  });

  await report.run('protocol-version-refusal', () => probeOlderVersion({ baseUrl, auth, teamId }));
  await report.run('error-bad-request', () =>
    expectProtocolError({
      call: () =>
        postRpc({ baseUrl, auth, teamId, method: 'describe', cacheScopeId: '<none>', params: {} }),
      code: 'bad_request',
      messageIncludes: ['describe', 'typeId'],
    }),
  );
  await report.run('error-method-not-implemented', () =>
    expectProtocolError({
      call: () =>
        postRpc({ baseUrl, auth, teamId, method: 'conformanceNoSuchMethod', cacheScopeId: '<none>', params: {} }),
      code: 'method_not_implemented',
    }),
  );

  if (!manifestOk || manifest === undefined) {
    report.skip('remaining checks', 'the manifest check failed, so nothing else can run against this server');
    return report.results;
  }
  const advertised = new Set(manifest.methods);
  const adapterType = manifest.adapterType;

  await report.run('manifest-methods', async () => {
    const missing = REQUIRED_METHODS.filter((method) => !advertised.has(method));
    if (missing.length > 0) throw new Error(`the manifest does not list the required methods ${missing.join(', ')}`);
    return `lists all ${REQUIRED_METHODS.length} required methods`;
  });

  const adapter = createRemoteAdapter({
    config: { ...config, adapterType },
    secret,
    cacheScopeId: 'adapter-conformance',
    manifest,
  });

  const host = await startHostDouble({
    adapterType,
    expectedCredential: auth,
    teamHeader: ADAPTER_TEAM_HEADER,
    port: options.hostPort ?? 0,
  });
  options.onHostReady?.({ hostUrl: host.url });

  const scratchRecords: ScratchRecord[] = [];
  try {
    const descriptors = await checkSchema({ report, adapter });
    await checkRecords({ report, adapter, advertised, descriptors, scratch, scratchRecords, adapterType });
    await checkSubscriptions({ report, adapter, advertised, host });
    await checkDelivery({ report, adapter, advertised, sampleDelivery });
    await checkDoors({ report, host, waitForPushSeconds, onWaitingForPush: options.onWaitingForPush });
  } finally {
    if (scratchRecords.length > 0 && scratch !== undefined) {
      await report.run('scratch-cleanup', async () => {
        const failures: string[] = [];
        for (const record of scratchRecords) {
          try {
            await adapter.deleteRecord({
              recordType: scratch.typeId,
              externalId: record.externalId,
              mutationContext: mutationContextFor(adapterType),
            });
          } catch (err) {
            failures.push(`${record.externalId}: ${messageOf(err)}`);
          }
        }
        if (failures.length > 0) throw new Error(`could not delete ${failures.join('; ')}`);
        return `deleted ${scratchRecords.length} remaining scratch record${scratchRecords.length === 1 ? '' : 's'}`;
      });
    }
    await host.close();
  }
  return report.results;
}

/** listEntryPoints, describe and the natural-name checks. Returns the descriptors it read. */
async function checkSchema(input: {
  report: Report;
  adapter: RemoteAdapter;
}): Promise<Map<string, SchemaTypeDescriptor>> {
  const { report, adapter } = input;
  const descriptors = new Map<string, SchemaTypeDescriptor>();
  let entryPoints: SchemaEntryPoint[] = [];

  const entriesOk = await report.run('listEntryPoints', async () => {
    entryPoints = await adapter.listEntryPoints();
    if (entryPoints.length === 0) throw new Error('listEntryPoints returned no entry points');
    const blank = entryPoints.filter((entry) => entry.displayName.trim() === '');
    if (blank.length > 0) throw new Error(`entry points without a display name: ${blank.map((e) => e.typeId).join(', ')}`);
    return entryPoints.map((entry) => entry.displayName).join(', ');
  });
  if (!entriesOk) {
    report.skip('describe', 'listEntryPoints failed');
    report.skip('natural-names', 'listEntryPoints failed');
    return descriptors;
  }

  const describeOk = await report.run('describe', async () => {
    for (const entry of entryPoints) {
      const descriptor = await adapter.describe(entry.typeId);
      if (descriptor === null) throw new Error(`describe(${JSON.stringify(entry.typeId)}) is null for a listed entry point`);
      if (descriptor.typeId !== entry.typeId) {
        throw new Error(`describe(${JSON.stringify(entry.typeId)}) answered typeId ${JSON.stringify(descriptor.typeId)}`);
      }
      descriptors.set(entry.typeId, descriptor);
    }
    const unknown = await adapter.describe('conformance-no-such-type');
    if (unknown !== null) throw new Error('describe of an unknown type must answer null');
    return `${descriptors.size} entry point${descriptors.size === 1 ? '' : 's'} described; an unknown type answers null`;
  });
  if (!describeOk) {
    report.skip('natural-names', 'describe failed');
    return descriptors;
  }

  await report.run('natural-names', async () => {
    const problems: string[] = [];
    for (const descriptor of descriptors.values()) {
      if (descriptor.displayName.trim() === '') problems.push(`${descriptor.typeId}: empty display name`);
      for (const field of descriptor.fields) {
        if (typeof field.displayName !== 'string' || field.displayName.trim() === '') {
          problems.push(`${descriptor.typeId}.${field.fieldId}: empty display name`);
        }
      }
      for (const reference of descriptor.references) {
        if (reference.name !== undefined && reference.name.trim() === '') {
          problems.push(`${descriptor.typeId}.${reference.fieldId}: empty edge name`);
        }
        const targets = reference.targetTypeIds ?? [reference.targetTypeId];
        for (const target of targets) {
          if (descriptors.has(target)) continue;
          const resolved = await adapter.describe(target);
          if (resolved === null) {
            problems.push(`${descriptor.typeId}.${reference.fieldId}: target type ${JSON.stringify(target)} does not describe`);
          } else {
            descriptors.set(target, resolved);
          }
        }
      }
    }
    if (problems.length > 0) throw new Error(problems.join('; '));
    return 'every field and edge is named, and every edge target describes';
  });
  return descriptors;
}

async function checkRecords(input: {
  report: Report;
  adapter: RemoteAdapter;
  advertised: ReadonlySet<string>;
  descriptors: ReadonlyMap<string, SchemaTypeDescriptor>;
  scratch: ConformanceOptions['scratch'];
  scratchRecords: ScratchRecord[];
  adapterType: string;
}): Promise<void> {
  const { report, adapter, advertised, descriptors, scratch, scratchRecords, adapterType } = input;
  const needsScratch = [
    'createRecord',
    'resolveEntity',
    'getRelated',
    'iterateRelatedPage',
    'getFieldValue',
    'updateRecord',
    'resolveAwait',
    'deleteRecord',
  ];
  if (scratch === undefined) {
    for (const name of needsScratch) report.skip(name, SCRATCH_FLAGS_NOTICE);
    return;
  }

  const mutationContext = mutationContextFor(adapterType);
  const created = await report.run('createRecord', async () => {
    for (let i = 0; i < SCRATCH_RECORD_COUNT; i++) {
      const result = await adapter.createRecord({
        recordType: scratch.typeId,
        fields: scratch.fields,
        mutationContext,
      });
      if (result.externalId.trim() === '') throw new Error('createRecord returned an empty externalId');
      scratchRecords.push({ externalId: result.externalId });
    }
    const ids = new Set(scratchRecords.map((r) => r.externalId));
    if (ids.size !== scratchRecords.length) throw new Error('createRecord returned the same externalId for different records');
    return `created ${scratchRecords.length} ${scratch.typeId} records`;
  });
  if (!created) {
    for (const name of needsScratch.filter((n) => n !== 'createRecord')) report.skip(name, 'createRecord failed');
    return;
  }
  const first = scratchRecords[0];
  if (first === undefined) return;
  const createdIds = new Set(scratchRecords.map((r) => r.externalId));

  await report.run('resolveEntity', async () => {
    const result = await adapter.resolveEntity({
      record: scratch.fields,
      recordType: scratch.typeId,
      candidates: [],
      constraints: { any: [] },
    });
    return `${result.candidates.length} candidate${result.candidates.length === 1 ? '' : 's'}`;
  });

  const rootInput = {
    position: makeMetaPosition(adapter.adapterType),
    fieldId: scratch.typeId,
    direction: 'outgoing' as const,
  };
  let landed: RelatedResult[] = [];
  const rootReadable = await report.run('getRelated', async () => {
    landed = await adapter.getRelated(rootInput);
    if (landed.length === 0) return 'the root read returned no records (a sink)';
    const seen = new Set(landed.map(recordIdOf));
    const missing = [...createdIds].filter((id) => !seen.has(id));
    if (missing.length > 0) throw new Error(`the root read of ${scratch.typeId} did not include the records just created: ${missing.join(', ')}`);
    return `${landed.length} ${scratch.typeId} records, including the ${createdIds.size} just created`;
  });

  if (!rootReadable) {
    report.skip('iterateRelatedPage', 'getRelated failed');
  } else if (landed.length === 0) {
    report.skip('iterateRelatedPage', 'the root read returns no records, so there is nothing to page through');
  } else if (!advertised.has('iterateRelatedPage') && !advertised.has('iterateRelated')) {
    report.skip('iterateRelatedPage', 'not listed in the manifest methods');
  } else {
    await report.run('iterateRelatedPage', async () => {
      const seenIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: unknown;
      let pages = 0;
      for (;;) {
        const page = await adapter.iterateRelatedPage!(rootInput, cursor);
        pages++;
        for (const item of page.items) {
          const id = recordIdOf(item);
          if (id !== undefined) seenIds.add(id);
        }
        if (page.nextCursor === undefined) break;
        const key = JSON.stringify(page.nextCursor);
        if (cursors.has(key)) throw new Error(`the cursor ${key} repeated; paging would never end`);
        cursors.add(key);
        cursor = page.nextCursor;
        if (pages >= MAX_PAGES) throw new Error(`still paging after ${MAX_PAGES} pages`);
      }
      const missing = [...createdIds].filter((id) => !seenIds.has(id));
      if (missing.length > 0) throw new Error(`paging never returned ${missing.join(', ')}`);
      return `${pages} page${pages === 1 ? '' : 's'}, ${seenIds.size} records, no repeated cursor`;
    });
  }

  await report.run('getFieldValue', async () => {
    const fieldId = Object.keys(scratch.fields)[0];
    if (fieldId === undefined) throw new Error('--scratch-fields names no field to read');
    const position = landed.find((r) => recordIdOf(r) === first.externalId)?.position ?? {
      adapterType,
      recordType: scratch.typeId,
      identity: { kind: 'stable' as const, recordId: first.externalId },
    };
    const value = await adapter.getFieldValue({ position, fieldId });
    return `${fieldId} = ${JSON.stringify(value) ?? 'nothing'}`;
  });

  await report.run('updateRecord', async () => {
    const result = await adapter.updateRecord({
      recordType: scratch.typeId,
      externalId: first.externalId,
      fields: scratch.fields,
      mutationContext,
    });
    if ('notFound' in result) throw new Error(`updateRecord answered notFound for the record just created (${first.externalId})`);
    if (result.externalId !== first.externalId) {
      throw new Error(`updateRecord answered externalId ${result.externalId}; expected ${first.externalId}`);
    }
    return `updated ${first.externalId}`;
  });

  if (!advertised.has('resolveAwait') || adapter.awaitable === undefined) {
    report.skip('resolveAwait', 'not listed in the manifest methods');
  } else {
    const edge = descriptors.get(scratch.typeId)?.references.find((reference) => reference.awaitable === true);
    if (edge === undefined) {
      report.skip('resolveAwait', `${scratch.typeId} declares no awaitable edge`);
    } else {
      const awaitable = adapter.awaitable;
      await report.run('resolveAwait', async () => {
        const resolution = await awaitable.resolveAwait({ recordId: first.externalId, edge: edge.fieldId });
        return `${edge.fieldId} resolves ${resolution.status}`;
      });
    }
  }

  await report.run('deleteRecord', async () => {
    await adapter.deleteRecord({ recordType: scratch.typeId, externalId: first.externalId, mutationContext });
    scratchRecords.shift();
    return `deleted ${first.externalId}`;
  });
}

async function checkSubscriptions(input: {
  report: Report;
  adapter: RemoteAdapter;
  advertised: ReadonlySet<string>;
  host: HostDouble;
}): Promise<void> {
  const { report, adapter, advertised, host } = input;
  if (!advertised.has('ensureEventSubscription') || !adapter.ensureEventSubscription) {
    report.skip('ensureEventSubscription', 'not listed in the manifest methods');
    report.skip('removeEventSubscription', 'not listed in the manifest methods');
    return;
  }
  const ensure = adapter.ensureEventSubscription.bind(adapter);
  let externalId: string | undefined;
  await report.run('ensureEventSubscription', async () => {
    const callbackUrl = host.callbackUrl;
    const one = await ensure({ events: [], callbackUrl });
    const two = await ensure({ events: [], callbackUrl });
    if (one?.secret === undefined || one.secret === '') {
      throw new Error('ensureEventSubscription returned no secret; a subscription must return the secret its deliveries are signed with');
    }
    if (two?.secret === undefined || two.secret === '') {
      throw new Error('the second ensureEventSubscription returned no secret');
    }
    if (one.externalId !== two.externalId) {
      throw new Error(`externalId changed between two calls for the same callback (${one.externalId} then ${two.externalId}); it must be idempotent`);
    }
    externalId = one.externalId;
    return `secret returned; externalId ${externalId ?? '(none)'} stable across two calls`;
  });
  // Removal runs even when the ensure check failed: a half-registered
  // callback is still the vendor's to clean up.
  if (!advertised.has('removeEventSubscription') || !adapter.removeEventSubscription) {
    report.skip('removeEventSubscription', 'not listed in the manifest methods');
    return;
  }
  const remove = adapter.removeEventSubscription.bind(adapter);
  await report.run('removeEventSubscription', async () => {
    await remove({ callbackUrl: host.callbackUrl, ...(externalId !== undefined ? { externalId } : {}) });
    return 'removed';
  });
}

async function checkDelivery(input: {
  report: Report;
  adapter: RemoteAdapter;
  advertised: ReadonlySet<string>;
  sampleDelivery: unknown;
}): Promise<void> {
  const { report, adapter, advertised, sampleDelivery } = input;
  const flagNotice = 'pass --sample-delivery \'<json>\' with a webhook body your server sends';

  if (!advertised.has('listEventTypes') || !adapter.listEventTypes) {
    report.skip('listEventTypes', 'not listed in the manifest methods');
  } else {
    const listEventTypes = adapter.listEventTypes.bind(adapter);
    await report.run('listEventTypes', async () => {
      const types = await listEventTypes();
      return `${types.length} event type${types.length === 1 ? '' : 's'}: ${types.map((t) => t.tag).join(', ')}`;
    });
  }

  if (!advertised.has('preprocessInbound') || !adapter.preprocessInbound) {
    report.skip('preprocessInbound', 'not listed in the manifest methods');
  } else if (sampleDelivery === undefined) {
    report.skip('preprocessInbound', flagNotice);
  } else {
    const preprocessInbound = adapter.preprocessInbound.bind(adapter);
    await report.run('preprocessInbound', async () => {
      const result = await preprocessInbound({ raw: sampleDelivery });
      return `${result.events.length} event${result.events.length === 1 ? '' : 's'}`;
    });
  }

  if (!advertised.has('wakeKeys') || !adapter.wakeKeys) {
    report.skip('wakeKeys', 'not listed in the manifest methods');
  } else if (sampleDelivery === undefined) {
    report.skip('wakeKeys', flagNotice);
  } else {
    const wakeKeys = adapter.wakeKeys.bind(adapter);
    await report.run('wakeKeys', async () => {
      const keys = await wakeKeys({ raw: sampleDelivery });
      if (keys.some((key) => key === '')) throw new Error('wakeKeys returned an empty key');
      return `${keys.length} key${keys.length === 1 ? '' : 's'}${keys.length > 0 ? `: ${keys.join(', ')}` : ''}`;
    });
  }
}

async function checkDoors(input: {
  report: Report;
  host: HostDouble;
  waitForPushSeconds: number;
  onWaitingForPush: ConformanceOptions['onWaitingForPush'];
}): Promise<void> {
  const { report, host, waitForPushSeconds, onWaitingForPush } = input;
  const doors = ['emit', 'wake'] as const;
  if (waitForPushSeconds <= 0) {
    for (const door of doors) {
      report.skip(`door-${door}`, `the CLI cannot make your server push; point it at ${host.url} and pass --wait-for-push <seconds>`);
    }
    return;
  }
  const waiting = host.waitForPushes({ doors, seconds: waitForPushSeconds });
  await onWaitingForPush?.({ hostUrl: host.url });
  await waiting;
  for (const door of doors) {
    const received = host.pushes.filter((push) => push.door === door);
    if (received.length === 0) {
      report.results.push({
        status: 'FAIL',
        name: `door-${door}`,
        detail: `nothing arrived at ${host.url}/api/public/adapter/<adapterType>/${door} within ${waitForPushSeconds}s`,
      });
      continue;
    }
    const refused = received.filter((push) => !push.accepted);
    report.results.push(
      refused.length > 0
        ? {
            status: 'FAIL',
            name: `door-${door}`,
            detail: `${refused.length} of ${received.length} pushes refused: ${refused[0]?.problem ?? 'unknown'}`,
          }
        : {
            status: 'PASS',
            name: `door-${door}`,
            detail: `${received.length} push${received.length === 1 ? '' : 'es'} received, all well-formed and authenticated`,
          },
    );
  }
}

// ── The command line ─────────────────────────────────────────────────────────

const AuthFlag = z.enum(['bearer', 'secret']);

const JsonObject = z.record(z.string(), z.unknown());

function parseJsonFlag(flag: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${flag} is not valid JSON`);
  }
}

interface ParsedArgs {
  url: string;
  auth: z.infer<typeof AuthFlag>;
  authHeader?: string;
  secretEnv: string;
  scratchType?: string;
  scratchFields?: string;
  sampleDelivery?: string;
  hostPort?: string;
  waitForPush?: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (!flag.startsWith('--')) throw new Error(`unexpected argument ${flag}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    values[flag.slice(2)] = value;
  }
  const known = new Set(['url', 'auth', 'auth-header', 'secret-env', 'scratch-type', 'scratch-fields', 'sample-delivery', 'host-port', 'wait-for-push']);
  const unknown = Object.keys(values).filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`unknown flag --${unknown[0]}`);
  if (values['url'] === undefined) throw new Error('--url <baseUrl> is required');
  const auth = AuthFlag.safeParse(values['auth']);
  if (!auth.success) throw new Error('--auth bearer|secret is required');
  return {
    url: values['url'],
    auth: auth.data,
    authHeader: values['auth-header'],
    secretEnv: values['secret-env'] ?? 'ADAPTER_CONFORMANCE_SECRET',
    scratchType: values['scratch-type'],
    scratchFields: values['scratch-fields'],
    sampleDelivery: values['sample-delivery'],
    hostPort: values['host-port'],
    waitForPush: values['wait-for-push'],
    json,
  };
}

function optionsFromArgs(args: ParsedArgs, env: NodeJS.ProcessEnv): ConformanceOptions {
  const secret = env[args.secretEnv];
  if (secret === undefined || secret === '') {
    throw new Error(`set the credential in the environment variable ${args.secretEnv} (the secret is never taken from the command line)`);
  }
  if ((args.scratchType === undefined) !== (args.scratchFields === undefined)) {
    throw new Error('--scratch-type and --scratch-fields go together');
  }
  const authStrategy: AuthStrategy =
    args.auth === 'bearer'
      ? { kind: 'bearer' }
      : { kind: 'shared_secret', ...(args.authHeader !== undefined ? { header: args.authHeader } : {}) };
  const scratchFields =
    args.scratchFields !== undefined ? JsonObject.parse(parseJsonFlag('--scratch-fields', args.scratchFields)) : undefined;
  const hostPort = args.hostPort !== undefined ? z.coerce.number().int().min(0).max(65535).parse(args.hostPort) : undefined;
  const waitForPushSeconds = args.waitForPush !== undefined ? z.coerce.number().min(0).parse(args.waitForPush) : undefined;
  return {
    baseUrl: args.url,
    authStrategy,
    secret,
    ...(args.scratchType !== undefined && scratchFields !== undefined
      ? { scratch: { typeId: args.scratchType, fields: scratchFields } }
      : {}),
    ...(args.sampleDelivery !== undefined
      ? { sampleDelivery: parseJsonFlag('--sample-delivery', args.sampleDelivery) }
      : {}),
    ...(hostPort !== undefined ? { hostPort } : {}),
    ...(waitForPushSeconds !== undefined ? { waitForPushSeconds } : {}),
  };
}

export function formatReport(results: readonly CheckResult[]): string {
  return results.map((r) => `${r.status} ${r.name} — ${r.detail}`).join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options = optionsFromArgs(args, process.env);
  const results = await runConformance({
    ...options,
    onHostReady: ({ hostUrl }) => {
      process.stderr.write(`host double listening at ${hostUrl} (push to ${hostUrl}/api/public/adapter/<adapterType>/{emit,wake})\n`);
    },
  });
  process.stdout.write(`${args.json ? JSON.stringify(results, null, 2) : formatReport(results)}\n`);
  const failed = results.filter((r) => r.status === 'FAIL').length;
  if (!args.json) {
    const skipped = results.filter((r) => r.status === 'SKIP').length;
    process.stdout.write(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(`adapter:conformance: ${messageOf(err)}\n`);
    process.exit(2);
  });
}
