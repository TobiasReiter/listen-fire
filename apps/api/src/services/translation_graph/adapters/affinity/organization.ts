// Affinity TG adapter — organization create/update/read. Lifts the v3
// `executeOrganization` flow: resolve identity (name/domain), create-or-update
// via the operations layer, then write the custom-field values. The TG engine
// already arbitrated identity (resolveEntity) and may hand us an `externalId`
// to update — so we pass it through as the operations `affinityId`.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import { attachPersonToOrganisation } from '../../../../adapters/affinity/employer_association';
import { AffinityMergedEntityError } from '../../../../adapters/affinity/apiClient';
import type {
  WriteInput,
  WriteResult,
  UpdateInput,
  UpdateResult,
  UpdateWriteResult,
} from '../../adapter';
import { writeParentLinks } from '../../adapter';
import { logger } from '../../../logger';
import {
  applyCustomReferenceParentLinks,
  buildOrgData,
  combineParentAssociation,
  type ParentLinkPass,
  createNoopTracer,
  customReferenceFieldFor,
  partitionFields,
  readCustomFieldCurrentValues,
  readOrgBuiltins,
  writeCustomFieldValues,
  type ReferenceHolderResolver,
  type WebUrlSource,
} from './shared';
import { AFFINITY_ADAPTER_TYPE, decodedFixedType } from './types';
import { UPDATE_NOT_FOUND, isHttp404 } from '../not_found';

/** Write the BUILT-IN person↔org association from the PERSON side: a person
 *  parent (`write person -[:Organizations]-> org`) means this organization
 *  joins that person's employers. The association is N×M, so we APPEND to
 *  `organization_ids` and never clobber the person's other orgs, and skip a
 *  person already linked. The mirror of `parentOrgId` in person.ts — including
 *  its exclusion: a person parent whose edge names a CUSTOM Organization-valued
 *  reference field points the PERSON at this org through that field, which
 *  `applyCustomReferenceParentLinks` writes instead. */
async function linkParentPeople(
  operations: AffinityOperations,
  options: { write: WriteInput; orgId: number },
): Promise<ParentLinkPass> {
  const client = operations.getClient();
  const pass: ParentLinkPass = { handled: 0, made: 0 };
  for (const parent of writeParentLinks(options.write)) {
    if (decodedFixedType(parent.recordType)?.entity !== 'person') continue;
    const personId = Number(parent.externalId);
    if (!Number.isInteger(personId)) continue;
    if (await customReferenceFieldFor(operations, 'person', parent.edgeName)) continue;

    pass.handled += 1;
    const person = await client.getPersonById(personId);
    const joined = await attachPersonToOrganisation(client, { person, orgId: options.orgId });
    if (joined.association === 'made') pass.made += 1;
  }
  return pass;
}

export async function createOrganization(input: {
  operations: AffinityOperations;
  web: WebUrlSource;
  write: WriteInput;
  /** Which record a parent link stands for — only the adapter can say, since a
   *  per-list entry type resolves through its live list cache. */
  holderFor: ReferenceHolderResolver;
  /** Pre-resolved Affinity org id from the engine's resolveEntity, if any. */
  affinityId?: number;
  /** What else the write says about the company, for the matcher's judge when
   *  the operations layer searches again before creating. */
  matchContext?: string;
}): Promise<UpdateWriteResult> {
  const { operations, write } = input;
  const { builtins, custom } = partitionFields('organization', write.fields);
  const { name, domain } = readOrgBuiltins(builtins);

  if (!name && input.affinityId == null) {
    throw new Error(
      'AffinityAdapter.createOrganization: no organization name — map a "name" (or "domain") field on the action.',
    );
  }

  try {
    const result = await operations.createOrUpdateOrganisation({
      searchQuery: { name: name ?? '', domain: domain ?? null, context: input.matchContext },
      userText: '',
      tracer: createNoopTracer(),
      fieldConfigurations: [],
      affinityId: input.affinityId,
    });

    // Write every custom field we're handed. The engine owns write semantics:
    // it has already read current values (`readRecord`) and dropped overwrite
    // no-ops / withheld `?:` set-if-empty fields, so whatever reaches the
    // adapter is meant to be written. A local `isNew` gate here would silently
    // refuse authored overwrites on existing records — exactly the bug.
    await writeCustomFieldValues(operations, {
      entityId: result.id,
      entityType: 'organization',
      fieldValues: custom,
    });

    // The built-in employer association written from the person side.
    const employers = await linkParentPeople(operations, { write, orgId: result.id });

    // A Person/Organization-valued custom field on the PARENT pointing at this
    // org is set here (e.g. `write person -[:Portfolio]-> org`).
    const customLinks = await applyCustomReferenceParentLinks(operations, {
      holderFor: input.holderFor,
      childExternalId: String(result.id),
      write,
    });

    const org = await operations.getClient().getOrganisationById(result.id);
    return {
      adapterType: AFFINITY_ADAPTER_TYPE,
      externalId: String(result.id),
      data: buildOrgData(org, await input.web.getWebBaseUrl()),
      association: combineParentAssociation({
        parents: writeParentLinks(write).length,
        passes: [employers, customLinks],
      }),
    };
  } catch (err) {
    if (err instanceof AffinityMergedEntityError) {
      logger.warn('[AffinityAdapter.createOrganization] entity merged', {
        oldId: err.oldId,
        newId: err.newId,
      });
    }
    throw err;
  }
}

export async function updateOrganization(input: {
  operations: AffinityOperations;
  web: WebUrlSource;
  update: UpdateInput;
  holderFor: ReferenceHolderResolver;
}): Promise<UpdateResult> {
  const affinityId = Number(input.update.externalId);
  if (!Number.isInteger(affinityId)) {
    throw new Error(
      `AffinityAdapter.updateOrganization: externalId "${input.update.externalId}" is not a numeric org id.`,
    );
  }
  // NOT-FOUND contract (3b): the update path pins `affinityId`, so the
  // operations layer fetches the org by that id (`getOrganisationById`). When
  // Affinity no longer has it, the REST client throws `Error("Affinity Error:
  // 404 ...")`. Map that to the typed signal so the engine's bind self-heal
  // re-mints, instead of letting an opaque error escape.
  let result: UpdateWriteResult;
  try {
    result = await createOrganization({
      operations: input.operations,
      web: input.web,
      write: input.update,
      holderFor: input.holderFor,
      affinityId,
    });
  } catch (err) {
    if (isHttp404(err)) return UPDATE_NOT_FOUND;
    throw err;
  }
  return { ...result, externalId: input.update.externalId };
}

export async function readOrganization(input: {
  operations: AffinityOperations;
  externalId: string;
}): Promise<Record<string, unknown> | null> {
  const id = Number(input.externalId);
  if (!Number.isInteger(id)) return null;
  let org: { name?: string | null; domain?: string | null; domains?: string[] | null };
  try {
    org = await input.operations.getClient().getOrganisationById(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404')) return null;
    throw err;
  }
  // Keyed by DISPLAY NAME — the currency the engine's write-semantics gate
  // looks current values up by (see movement_engine applyUpdate). Built-ins
  // mirror the displayNames in schema_catalog's ORG_BUILTINS; custom fields
  // come from the field-value API so `?:` and no-op suppression cover them too.
  const custom = await readCustomFieldCurrentValues(input.operations, {
    entityType: 'organization',
    entityId: id,
  });
  return {
    Name: org.name ?? null,
    Domain: org.domain ?? null,
    Domains: org.domains ?? null,
    ...custom,
  };
}
