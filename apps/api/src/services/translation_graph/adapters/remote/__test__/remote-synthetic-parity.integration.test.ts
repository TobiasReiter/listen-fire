// Remote parity for an adapter whose internal ids are NOT its names — the case
// the deleted client-side id shim got wrong. A synthetic CRM keys everything
// by opaque ids (`obj_7f3a` is displayed "Contact", `f_91` is "Email") and
// resolves names to them itself, the way every in-process adapter does. It is
// served through `createAdapterProtocolHandler` on an ephemeral http.Server
// behind a guard that fails any call whose arguments carry one of those ids,
// and driven through `createRemoteAdapter`. Every method must round-trip
// natural names; a client that translated names to ids before sending would
// trip the guard on each of them. The edge is named "Employer" and lands on
// "Company", so an edge name confused with its target type fails too.

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import type {
  DeleteInput,
  DeleteResult,
  GetFieldValueInput,
  GetRelatedInput,
  InvokeFieldFunctionInput,
  LinkRecordsInput,
  LinkRecordsResult,
  RelatedResult,
  ResolveEntityInput,
  ResolveEntityResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
  DedupRules,
  FilterTranslationResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { FieldEvidence } from 'movement-engine/services/translation_graph/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';
import type { TriggerType } from 'movement-engine/services/translation_graph/triggers/types';
import type { Expression } from '#shared/expression/types';
import type { RemoteAdapter, RemoteAdapterConfig } from '../index';
import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { BaseAdapter } from '../../base';
import { naturalName } from '../../name_resolution';
import { createAdapterProtocolHandler } from '../../../protocol/server';
import { createRemoteAdapter, fetchRemoteManifest } from '../index';
import { unsupportedAssociation, writeParentLinks } from 'movement-engine/services/translation_graph/adapter';

/** The team the adapter's calls are made for (sent as `x-listen-fire-team`). */
const CONFIG_TEAM_ID = '00000000-0000-4000-8000-0000000000c1' as TeamId;

const ADAPTER_TYPE = 'synthetic_crm';
const SECRET = 'synthetic-secret';

const CONTACT = 'obj_7f3a';
const COMPANY = 'obj_c2d1';
const EMAIL = 'f_91';
const CONTACT_NAME = 'f_92';
const COMPANY_NAME = 'f_93';
const WORKS_AT = 'ref_44';
const INTERNAL_IDS: ReadonlySet<string> = new Set([
  CONTACT,
  COMPANY,
  EMAIL,
  CONTACT_NAME,
  COMPANY_NAME,
  WORKS_AT,
]);

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [CONTACT]: {
    typeId: CONTACT,
    displayName: 'Contact',
    fields: [
      { fieldId: EMAIL, displayName: 'Email', kind: 'string', writable: true, required: false },
      { fieldId: CONTACT_NAME, displayName: 'Name', kind: 'string', writable: true, required: false },
    ],
    references: [
      {
        fieldId: WORKS_AT,
        name: 'Employer',
        targetTypeId: COMPANY,
        cardinality: 'one',
        direction: 'outgoing',
      },
    ],
  },
  [COMPANY]: {
    typeId: COMPANY,
    displayName: 'Company',
    fields: [{ fieldId: COMPANY_NAME, displayName: 'Name', kind: 'string', writable: true, required: false }],
    references: [],
  },
};

interface StoredRecord {
  typeId: string;
  fields: Record<string, unknown>;
  evidence?: Record<string, FieldEvidence>;
}

/** Keys and stores everything by internal id; speaks names only at its
 *  interface, resolving them on the first line of each method. */
class SyntheticCrm extends BaseAdapter {
  readonly adapterType = ADAPTER_TYPE;
  readonly supportedTriggers: readonly TriggerType[] = [];
  readonly records = new Map<string, StoredRecord>();
  readonly links = new Map<string, { from: string; edgeId: string; to: string }>();
  private seq = 0;

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return Object.values(DESCRIPTORS).map((d) => ({
      typeId: d.typeId,
      displayName: d.displayName,
      writable: true,
      readable: true,
    }));
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    return DESCRIPTORS[await this.resolveTypeRef(typeRef)] ?? null;
  }

  private async typeIdOf(typeName: string): Promise<string> {
    return (await this.resolver()).typeId(naturalName(typeName));
  }

  private async toInternalFields<V>(typeName: string, fields: Record<string, V>): Promise<Record<string, V>> {
    const resolver = await this.resolver({ types: [typeName] });
    const out: Record<string, V> = {};
    for (const [name, value] of Object.entries(fields)) {
      out[resolver.fieldId(naturalName(typeName), naturalName(name))] = value;
    }
    return out;
  }

  private naturalFields(typeId: string, fields: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of DESCRIPTORS[typeId]?.fields ?? []) {
      if (field.fieldId in fields) out[field.displayName] = fields[field.fieldId];
    }
    return out;
  }

  private position(externalId: string, typeName: string): SourcePosition {
    return {
      adapterType: ADAPTER_TYPE,
      recordType: typeName,
      identity: { kind: 'stable', recordId: externalId },
    };
  }

  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    const typeId = await this.typeIdOf(input.recordType);
    const record = await this.toInternalFields(input.recordType, input.record);
    const resolver = await this.resolver({ types: [input.recordType] });
    const keys = input.constraints.any.map((branch) =>
      branch.all.map((e) => resolver.fieldId(naturalName(input.recordType), naturalName(e.field))),
    );
    const candidates = [...this.records.entries()]
      .filter(([, r]) => r.typeId === typeId)
      .filter(([, r]) => keys.some((all) => all.every((k) => r.fields[k] === record[k])))
      .map(([externalId, r]) => ({
        adapterType: ADAPTER_TYPE,
        externalId,
        recordType: input.recordType,
        data: this.naturalFields(r.typeId, r.fields),
      }));
    return { candidates };
  }

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.identity.kind !== 'stable') return null;
    const record = this.records.get(input.position.identity.recordId);
    if (!record) return null;
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    return record.fields[fieldId] ?? null;
  }

  async *iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    yield* await this.getRelated(input);
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.identity.kind !== 'stable') return [];
    const from = input.position.identity.recordId;
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    const results: RelatedResult[] = [];
    for (const link of this.links.values()) {
      const target = this.records.get(link.to);
      if (link.from !== from || link.edgeId !== edgeId || !target) continue;
      const targetName = DESCRIPTORS[target.typeId]?.displayName ?? target.typeId;
      results.push({ position: this.position(link.to, targetName) });
    }
    return results;
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const typeId = await this.typeIdOf(input.recordType);
    const externalId = `rec-${++this.seq}`;
    const fields = await this.toInternalFields(input.recordType, input.fields);
    const evidence = input.evidence && (await this.toInternalFields(input.recordType, input.evidence));
    this.records.set(externalId, {
      typeId,
      fields,
      ...(evidence ? { evidence } : {}),
    });
    for (const parent of writeParentLinks(input)) {
      const resolver = await this.resolver({ types: [parent.recordType] });
      const edgeId = resolver.edgeReadId(naturalName(parent.recordType), naturalName(parent.edgeName));
      this.links.set(JSON.stringify([parent.externalId, edgeId, externalId]), {
        from: parent.externalId,
        edgeId,
        to: externalId,
      });
    }
    return {
      adapterType: ADAPTER_TYPE,
      externalId,
      recordType: input.recordType,
      data: this.naturalFields(typeId, fields),
    };
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const typeId = await this.typeIdOf(input.recordType);
    const existing = this.records.get(input.externalId);
    if (!existing || existing.typeId !== typeId) return { notFound: true };
    Object.assign(existing.fields, await this.toInternalFields(input.recordType, input.fields));
    return {
      adapterType: ADAPTER_TYPE,
      externalId: input.externalId,
      recordType: input.recordType,
      data: this.naturalFields(typeId, existing.fields),
      association: unsupportedAssociation(input),
    };
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    const typeId = await this.typeIdOf(input.recordType);
    if (this.records.get(input.externalId)?.typeId === typeId) this.records.delete(input.externalId);
    return {};
  }

  private async link(input: LinkRecordsInput): Promise<{ key: string; from: string; edgeId: string; to: string }> {
    const resolver = await this.resolver({ types: [input.from.recordType] });
    const edgeId = resolver.edgeReadId(naturalName(input.from.recordType), naturalName(input.edgeName));
    const from = input.from.externalId;
    const to = input.to.externalId;
    return { key: JSON.stringify([from, edgeId, to]), from, edgeId, to };
  }

  async linkRecords(input: LinkRecordsInput): Promise<LinkRecordsResult> {
    const { key, ...link } = await this.link(input);
    const created = !this.links.has(key);
    this.links.set(key, link);
    return { created };
  }

  async unlinkRecords(input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> {
    return { removed: this.links.delete((await this.link(input)).key) };
  }

  async invokeFieldFunction(input: InvokeFieldFunctionInput): Promise<unknown> {
    const resolver = await this.resolver({ types: [input.recordType] });
    resolver.fieldId(naturalName(input.recordType), naturalName(input.fieldId));
    return `${input.functionName}(${input.fieldId}): ${input.args.instructions} ${JSON.stringify(input.args.data)}`;
  }

  async translateFilter(input: {
    expression: Expression;
    entityType: string;
  }): Promise<FilterTranslationResult> {
    await this.typeIdOf(input.entityType);
    return { native: { entity: input.entityType }, residual: null };
  }

  async getDedupRules(input: { typeRef: string }): Promise<DedupRules | null> {
    const resolver = await this.resolver({ types: [input.typeRef] });
    // Resolving proves the name is known; the rule itself is stated in names.
    resolver.fieldId(naturalName(input.typeRef), naturalName('Email'));
    return { constraints: [{ entries: [{ propertyTypeId: 'Email', fuzzy: false }] }] };
  }
}

function internalIdsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') {
    if (INTERNAL_IDS.has(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) internalIdsIn(v, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (INTERNAL_IDS.has(k)) found.push(k);
      internalIdsIn(v, found);
    }
  }
  return found;
}

/** What the protocol server sees: the synthetic CRM, except that any call
 *  arriving with an internal id in its arguments fails. Calls the adapter
 *  makes on itself (its resolver's own `describe(typeId)`) bypass the guard. */
function wireGuarded(adapter: SyntheticCrm): SyntheticCrm {
  return new Proxy(adapter, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const leaked = internalIdsIn(args);
        if (leaked.length > 0) {
          throw new Error(`${prop} received internal ids on the wire: ${leaked.join(', ')}`);
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
}

const mutationContext = {
  source: { type: 'agent' as const, adapterType: 'kg' },
  occurredAt: '2026-10-07T00:00:00.000Z',
};

let server: http.Server;
let synthetic: SyntheticCrm;
let remote: RemoteAdapter;

beforeAll(async () => {
  synthetic = new SyntheticCrm();
  const handler = createAdapterProtocolHandler({
    adapter: wireGuarded(synthetic),
    authenticate: (headers) => headers['authorization'] === `Bearer ${SECRET}`,
  });
  server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');

  const config: RemoteAdapterConfig = {
    teamId: CONFIG_TEAM_ID,
    adapterType: ADAPTER_TYPE,
    baseUrl: `http://127.0.0.1:${address.port}/`,
    authStrategy: { kind: 'bearer' },
    credentialsId: randomUUID(),
  };
  const manifest = await fetchRemoteManifest(config, SECRET);
  remote = createRemoteAdapter({ config, secret: SECRET, cacheScopeId: randomUUID(), manifest });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('remote parity with an adapter whose ids are not its names', () => {
  it('the guard is live: an internal id on the wire fails the call', async () => {
    await expect(remote.describe(CONTACT)).rejects.toThrow(/describe received internal ids on the wire: obj_7f3a/);
  });

  it('advertises the methods the synthetic CRM implements, link and unlink included', () => {
    expect(typeof remote.linkRecords).toBe('function');
    expect(typeof remote.unlinkRecords).toBe('function');
    expect(typeof remote.translateFilter).toBe('function');
    expect(typeof remote.getDedupRules).toBe('function');
    expect(typeof remote.invokeFieldFunction).toBe('function');
    expect(remote.awaitable).toBeUndefined();
  });

  it('describe("Contact") answers the descriptor with its display names', async () => {
    const descriptor = await remote.describe('Contact');
    expect(descriptor?.displayName).toBe('Contact');
    expect(descriptor?.fields.map((f) => f.displayName)).toEqual(['Email', 'Name']);
    expect(descriptor?.references.map((r) => [r.name, r.targetTypeId])).toEqual([['Employer', COMPANY]]);
  });

  it('listEntryPoints names both types', async () => {
    const entries = await remote.listEntryPoints();
    expect(entries.map((e) => e.displayName).sort()).toEqual(['Company', 'Contact']);
  });

  let contactId: string;
  let companyId: string;

  it('createRecord writes by natural field names and answers in them', async () => {
    const contact = await remote.createRecord({
      recordType: 'Contact',
      fields: { Email: 'ada@example.com', Name: 'Ada' },
      mutationContext,
    });
    expect(contact).toMatchObject({
      recordType: 'Contact',
      data: { Email: 'ada@example.com', Name: 'Ada' },
    });
    contactId = contact.externalId;
    // Stored under the adapter's own ids — the translation happened over there.
    expect(synthetic.records.get(contactId)).toEqual({
      typeId: CONTACT,
      fields: { [EMAIL]: 'ada@example.com', [CONTACT_NAME]: 'Ada' },
    });

    const company = await remote.createRecord({
      recordType: 'Company',
      fields: { Name: 'Analytical Engines' },
      mutationContext,
    });
    companyId = company.externalId;
  });

  it('resolveEntity by "Email" finds the record and answers natural keys', async () => {
    const result = await remote.resolveEntity({
      record: { Email: 'ada@example.com' },
      recordType: 'Contact',
      candidates: [],
      constraints: { any: [{ all: [{ field: 'Email' }] }] },
    });
    expect(result.candidates).toEqual([
      expect.objectContaining({
        externalId: contactId,
        recordType: 'Contact',
        data: { Email: 'ada@example.com', Name: 'Ada' },
      }),
    ]);
  });

  it('getFieldValue("Email") reads the value', async () => {
    const position = {
      adapterType: ADAPTER_TYPE,
      recordType: 'Contact',
      identity: { kind: 'stable' as const, recordId: contactId },
    };
    expect(await remote.getFieldValue({ position, fieldId: 'Email' })).toBe('ada@example.com');
  });

  it('linkRecords over the named edge, then getRelated walks it and lands a named type', async () => {
    const link = {
      from: { recordType: 'Contact', externalId: contactId },
      edgeName: 'Employer',
      to: { recordType: 'Company', externalId: companyId },
      mutationContext,
    };
    expect(await remote.linkRecords!(link)).toEqual({ created: true });
    expect(await remote.linkRecords!(link)).toEqual({ created: false });

    const related = await remote.getRelated({
      position: { adapterType: ADAPTER_TYPE, recordType: 'Contact', identity: { kind: 'stable', recordId: contactId } },
      fieldId: 'Employer',
      direction: 'outgoing',
    });
    expect(related.map((r) => [r.position.recordType, r.position.identity])).toEqual([
      ['Company', { kind: 'stable', recordId: companyId }],
    ]);

    expect(await remote.unlinkRecords!(link)).toEqual({ removed: true });
    expect(await remote.unlinkRecords!(link)).toEqual({ removed: false });
  });

  it('createRecord carries parentLinks over the named edge and evidence keyed by natural field names', async () => {
    const company = await remote.createRecord({
      recordType: 'Company',
      fields: { Name: 'Difference Engines' },
      evidence: { Name: { quote: 'founded Difference Engines' } },
      parentLinks: [{ recordType: 'Contact', externalId: contactId, edgeName: 'Employer' }],
      mutationContext,
    });
    expect(synthetic.records.get(company.externalId)?.evidence).toEqual({
      [COMPANY_NAME]: { quote: 'founded Difference Engines' },
    });
    expect([...synthetic.links.values()]).toContainEqual({ from: contactId, edgeId: WORKS_AT, to: company.externalId });
  });

  it('iterateRelated pages over the named edge', async () => {
    const landed: (string | null)[] = [];
    for await (const r of remote.iterateRelated!({
      position: { adapterType: ADAPTER_TYPE, recordType: 'Contact', identity: { kind: 'stable', recordId: contactId } },
      fieldId: 'Employer',
      direction: 'outgoing',
    })) {
      landed.push(r.position.recordType);
    }
    expect(landed).toEqual(['Company']);
  });

  it('invokeFieldFunction names the type and field naturally', async () => {
    expect(
      await remote.invokeFieldFunction!({
        recordType: 'Contact',
        fieldId: 'Email',
        functionName: 'summarise',
        args: { instructions: 'shorten', data: ['ada'] },
      }),
    ).toBe('summarise(Email): shorten ["ada"]');
  });

  it('updateRecord writes by natural field names', async () => {
    const result = await remote.updateRecord({
      recordType: 'Contact',
      externalId: contactId,
      fields: { Name: 'Ada Lovelace' },
      mutationContext,
    });
    expect(result).toMatchObject({ data: { Email: 'ada@example.com', Name: 'Ada Lovelace' }, association: 'none' });
  });

  it('translateFilter and getDedupRules take the natural type name', async () => {
    expect(
      await remote.translateFilter!({ expression: { type: 'static', value: true }, entityType: 'Contact' }),
    ).toEqual({ native: { entity: 'Contact' }, residual: null });
    expect(await remote.getDedupRules!({ typeRef: 'Contact' })).toEqual({
      constraints: [{ entries: [{ propertyTypeId: 'Email', fuzzy: false }] }],
    });
  });

  it('deleteRecord by the natural type name removes the record', async () => {
    await remote.deleteRecord({ recordType: 'Contact', externalId: contactId, mutationContext });
    expect(synthetic.records.has(contactId)).toBe(false);
  });
});
