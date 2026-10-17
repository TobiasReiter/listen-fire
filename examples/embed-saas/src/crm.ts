// The SaaS's own product, as the module its customers' movements reach: a
// tiny CRM with one record type, `Company { Name, Note }`, and one event a
// listen may choose, `company.created`. The records live in the SaaS's own
// store (`CompanyStore`), one tenant's apart from another's; the module only
// answers the adapter protocol over them.

import type { Adapter, AdapterManifest, DiscriminableEvent } from 'movement-engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from 'movement-engine/public/adapter';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from 'module-kit';

export const COMPANY = 'Company';
export const COMPANY_CREATED = 'company.created';

export interface Company {
  id: string;
  Name: string;
  Note?: string;
}

/** The SaaS's own records, by tenant. */
export class CompanyStore {
  private readonly byTenant = new Map<string, Company[]>();

  list(tenant: string): Company[] {
    return this.byTenant.get(tenant) ?? [];
  }

  add(tenant: string, fields: Omit<Company, 'id'>): Company {
    const companies = this.byTenant.get(tenant) ?? [];
    const company = { id: `company-${companies.length + 1}`, ...fields };
    this.byTenant.set(tenant, [...companies, company]);
    return company;
  }

  update(tenant: string, id: string, fields: Partial<Omit<Company, 'id'>>): Company | undefined {
    const company = this.list(tenant).find((c) => c.id === id);
    if (company !== undefined) Object.assign(company, fields);
    return company;
  }
}

/** The event the SaaS raises when a company is created, as a listen reads it. */
export function companyCreated(company: Company): DiscriminableEvent {
  return { payload: company, externalId: company.id, tag: COMPANY_CREATED, eventType: COMPANY_CREATED, changeType: 'create', recordType: COMPANY };
}

const MANIFEST: AdapterManifest = {
  adapterType: 'crm',
  displayName: 'CRM',
  description: "The product's own CRM.",
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'listEventTypes'],
  subscribableEvents: [COMPANY_CREATED],
  declaredCredentials: ['crm'],
  introspectedSchema: true,
};

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

function crmAdapter(ctx: ModuleContext, store: CompanyStore): AdapterModuleMethods {
  const tenant = ctx.config.tenant;
  // Every call carries the customer's API key; the CRM asks that it is there.
  const authorised = async () => {
    if (!(await ctx.credential.fields()).api_key) throw new Error('crm: no API key');
  };
  const adapter: Adapter = {
    adapterType: 'crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [{ typeId: COMPANY, displayName: COMPANY, writable: true, readable: true }],
    describe: async (typeId) =>
      typeId === COMPANY
        ? {
            typeId: COMPANY,
            displayName: COMPANY,
            fields: [
              { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
              { fieldId: 'Note', displayName: 'Note', kind: 'string', writable: true, required: false },
            ],
            references: [],
          }
        : null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async () => [],
    createRecord: async ({ recordType, fields }) => {
      await authorised();
      const company = store.add(tenant, { Name: text(fields.Name) ?? '', ...(text(fields.Note) !== undefined ? { Note: text(fields.Note) } : {}) });
      return { adapterType: 'crm', externalId: company.id, recordType, data: { ...company } };
    },
    updateRecord: async (input) => {
      const { externalId, recordType, fields } = input;
      await authorised();
      const company = store.update(tenant, externalId, {
        ...(text(fields.Name) !== undefined ? { Name: text(fields.Name) } : {}),
        ...(text(fields.Note) !== undefined ? { Note: text(fields.Note) } : {}),
      });
      if (company === undefined) return { notFound: true };
      return { adapterType: 'crm', externalId, recordType, data: { ...company }, association: containerAssociation(input) };
    },
    deleteRecord: async () => {
      throw new Error('crm: a movement may not delete a company');
    },
    listEventTypes: async () => [{ tag: COMPANY_CREATED, positionType: COMPANY }],
  };
  return adapter;
}

/** The CRM module over `store`. */
export function crmModule(store: CompanyStore) {
  return defineModule({
    kind: 'adapter',
    name: '@acme/crm',
    manifest: MANIFEST,
    credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
    create: (ctx) => crmAdapter(ctx, store),
  });
}
