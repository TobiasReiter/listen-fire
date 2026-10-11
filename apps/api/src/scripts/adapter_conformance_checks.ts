// The adapter conformance checks and their report. The command line lives in
// `adapter_conformance.ts`; the host double in `adapter_conformance_host.ts`.

import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { PROTOCOL_VERSION } from 'engine-contracts';
import { canonicalJson } from 'engine-contracts/conformance';

import type { TeamId } from '../generated/kysely/core/Team';
import type { MutationContext } from '../services/translation_graph/mutation_context';
import type { RelatedResult } from '../services/translation_graph/adapter';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
} from '../services/translation_graph/types';

import {
  ADAPTER_TEAM_HEADER,
  RemoteProtocolError,
  RemoteTransportError,
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
import { isUuid, startHostDouble, type HostDouble } from './adapter_conformance_host';

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
  /** The address the host double binds; 127.0.0.1 unless your server runs on another machine. */
  hostBind?: string;
  /** How long to wait for the server to push to the host double; 0 skips the door checks. */
  waitForPushSeconds?: number;
  /** Called once the host double is listening, before the checks run. */
  onHostReady?: (info: { hostUrl: string; adapterType: string }) => void;
  /** Called when the CLI starts waiting for pushes to the doors. */
  onWaitingForPush?: (info: { hostUrl: string; adapterType: string }) => void | Promise<void>;
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

/** The CLI has no team; the header just has to be a well-formed UUID. */
function isTeamId(value: string): value is TeamId {
  return isUuid(value);
}

function mintTeamId(): TeamId {
  const id = randomUUID();
  if (!isTeamId(id)) throw new Error('conformance: could not mint a team id.');
  return id;
}

/** Duck-typed: an error thrown inside another realm (a test sandbox) is not `instanceof Error`. */
function errorLike(err: unknown): { message: string; cause?: unknown } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const message: unknown = Reflect.get(err, 'message');
  return typeof message === 'string' ? { message, cause: Reflect.get(err, 'cause') } : undefined;
}

export function messageOf(err: unknown): string {
  return errorLike(err)?.message ?? String(err);
}

/** Every transport failure names the URL it was talking to; `fetch failed` and a bare HTTP status do not. */
function describeFailure(err: unknown, baseUrl: string): string {
  if (errorLike(err)?.message === 'fetch failed') {
    const cause = errorLike(err)?.cause;
    return `could not reach ${baseUrl}: ${cause !== undefined ? messageOf(cause) : 'no response'}`;
  }
  if (err instanceof RemoteTransportError) return `${err.message} at ${baseUrl}`;
  return messageOf(err);
}

function recordIdOf(related: RelatedResult): string | undefined {
  return related.position.identity.kind === 'stable' ? related.position.identity.recordId : undefined;
}

class Report {
  readonly results: CheckResult[] = [];

  constructor(private readonly baseUrl: string) {}

  async run(name: string, check: () => Promise<string>): Promise<boolean> {
    try {
      this.pass(name, await check());
      return true;
    } catch (err) {
      this.fail(name, describeFailure(err, this.baseUrl));
      return false;
    }
  }

  pass(name: string, detail: string): void {
    this.results.push({ status: 'PASS', name, detail });
  }

  fail(name: string, detail: string): void {
    this.results.push({ status: 'FAIL', name, detail });
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
  /** What this record was created with. */
  fields: Record<string, unknown>;
}

/**
 * The first string field gets ` #<n>` appended, so a uniqueness rule on the
 * vendor's side cannot merge the scratch records into one. Returns the field
 * it varied (or the first field, when none is a string).
 */
function scratchFieldsFor(fields: Record<string, unknown>, index: number): { fields: Record<string, unknown>; fieldId: string | undefined } {
  const entries = Object.entries(fields);
  const varied = entries.find(([, value]) => typeof value === 'string');
  if (varied === undefined) return { fields, fieldId: entries[0]?.[0] };
  const [fieldId, value] = varied;
  return { fields: { ...fields, [fieldId]: `${String(value)} #${index}` }, fieldId };
}

export async function runConformance(options: ConformanceOptions): Promise<CheckResult[]> {
  const { baseUrl, authStrategy, secret, scratch, sampleDelivery } = options;
  const waitForPushSeconds = options.waitForPushSeconds ?? 0;
  const teamId = mintTeamId();
  const auth = authHeader(authStrategy, secret);
  const report = new Report(baseUrl);

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

  let host: HostDouble;
  try {
    host = await startHostDouble({
      adapterType,
      expectedCredential: auth,
      teamHeader: ADAPTER_TEAM_HEADER,
      bind: options.hostBind ?? '127.0.0.1',
      port: options.hostPort ?? 0,
    });
  } catch (err) {
    report.fail('host-double', `could not start the host double: ${messageOf(err)}`);
    report.skip('remaining checks', 'they need the host double (subscription callback and push doors)');
    return report.results;
  }
  options.onHostReady?.({ hostUrl: host.url, adapterType });

  const scratchRecords: ScratchRecord[] = [];
  try {
    const descriptors = await checkSchema({ report, adapter });
    await checkRecords({ report, adapter, advertised, descriptors, scratch, scratchRecords, adapterType });
    await checkSubscriptions({ report, adapter, advertised, host });
    await checkDelivery({ report, adapter, advertised, sampleDelivery });
    await checkDoors({ report, host, adapterType, waitForPushSeconds, onWaitingForPush: options.onWaitingForPush });
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
    'files-declared',
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
    for (let i = 1; i <= SCRATCH_RECORD_COUNT; i++) {
      const fields = scratchFieldsFor(scratch.fields, i).fields;
      const result = await adapter.createRecord({ recordType: scratch.typeId, fields, mutationContext });
      if (result.externalId.trim() === '') throw new Error('createRecord returned an empty externalId');
      scratchRecords.push({ externalId: result.externalId, fields });
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
  } else if (adapter.iterateRelatedPage === undefined) {
    report.skip('iterateRelatedPage', 'not listed in the manifest methods');
  } else {
    const iteratePage = adapter.iterateRelatedPage.bind(adapter);
    await report.run('iterateRelatedPage', async () => {
      const seenIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: unknown;
      let pages = 0;
      for (;;) {
        const page = await iteratePage(rootInput, cursor);
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
    const fieldId = scratchFieldsFor(scratch.fields, 1).fieldId;
    if (fieldId === undefined) throw new Error('--scratch-fields names no field to read');
    const position = landed.find((r) => recordIdOf(r) === first.externalId)?.position ?? {
      adapterType,
      recordType: scratch.typeId,
      identity: { kind: 'stable' as const, recordId: first.externalId },
    };
    const value = await adapter.getFieldValue({ position, fieldId });
    const expected = first.fields[fieldId];
    // A server may hand an object field back in any key order; its values
    // must still match exactly.
    if (canonicalJson(value) !== canonicalJson(expected)) {
      throw new Error(`field ${fieldId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value) ?? 'nothing'}`);
    }
    return `${fieldId} = ${JSON.stringify(value)}, as written`;
  });

  // A file reaches Listen-Fire only at a field the catalog declares a file:
  // anywhere else the same descriptor is data, so a server that answers one
  // there has a field it should declare `kind: 'file'`.
  await report.run('files-declared', async () => {
    const descriptor = descriptors.get(scratch.typeId) ?? (await adapter.describe(scratch.typeId));
    if (descriptor === null) throw new Error(`describe(${JSON.stringify(scratch.typeId)}) is null`);
    const position = landed.find((r) => recordIdOf(r) === first.externalId)?.position ?? {
      adapterType,
      recordType: scratch.typeId,
      identity: { kind: 'stable' as const, recordId: first.externalId },
    };
    const undeclared: string[] = [];
    let files = 0;
    for (const field of descriptor.fields) {
      if (field.readable === false) continue;
      const value = await adapter.getFieldValue({ position, fieldId: field.displayName });
      const spelled = (Array.isArray(value) ? value : [value]).some(
        (member) => member !== null && typeof member === 'object' && Reflect.get(member, '__brand') === 'FileRef',
      );
      if (field.kind === 'file') files++;
      else if (spelled) undeclared.push(field.displayName);
    }
    if (undeclared.length > 0) {
      throw new Error(
        `${undeclared.join(', ')} answered a file at a field not declared kind 'file': Listen-Fire reads it as data — declare the field a file`,
      );
    }
    return files === 0
      ? `${scratch.typeId} declares no file field, and no field answers one`
      : `${files} file field${files === 1 ? '' : 's'} declared; no other field answers a file`;
  });

  await report.run('updateRecord', async () => {
    const result = await adapter.updateRecord({
      recordType: scratch.typeId,
      externalId: first.externalId,
      fields: first.fields,
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
  adapterType: string;
  waitForPushSeconds: number;
  onWaitingForPush: ConformanceOptions['onWaitingForPush'];
}): Promise<void> {
  const { report, host, adapterType, waitForPushSeconds, onWaitingForPush } = input;
  const doors = ['emit', 'wake'] as const;
  const doorUrl = (door: string): string => `${host.url}/api/public/adapter/${adapterType}/${door}`;
  if (waitForPushSeconds <= 0) {
    for (const door of doors) {
      report.skip(`door-${door}`, `the CLI cannot make your server push; point it at ${doorUrl(door)} and pass --wait-for-push <seconds>`);
    }
    return;
  }
  const waiting = host.waitForPushes({ doors, seconds: waitForPushSeconds });
  await onWaitingForPush?.({ hostUrl: host.url, adapterType });
  await waiting;
  const strays = host.pushes.filter((push) => push.door === null);
  for (const door of doors) {
    const name = `door-${door}`;
    const received = host.pushes.filter((push) => push.door === door);
    if (received.length === 0) {
      const strayNote = strays.length > 0 ? `; pushes arrived at other paths: ${[...new Set(strays.map((s) => s.path))].join(', ')}` : '';
      report.fail(name, `nothing arrived at ${doorUrl(door)} within ${waitForPushSeconds}s${strayNote}`);
      continue;
    }
    const refused = received.filter((push) => !push.accepted);
    if (refused.length > 0) {
      report.fail(name, `${refused.length} of ${received.length} pushes refused: ${refused[0]?.problem ?? 'unknown'}`);
    } else {
      report.pass(name, `${received.length} push${received.length === 1 ? '' : 'es'} received, all well-formed and authenticated`);
    }
  }
}

export function formatReport(results: readonly CheckResult[]): string {
  return results.map((r) => `${r.status} ${r.name} — ${r.detail}`).join('\n');
}
