// Affinity TG adapter — person create/update/read. Lifts the v3
// `executePerson` flow: resolve identity (name/email), create-or-update via the
// operations layer (honoring a parent organization via `parentLinks`), then
// write custom-field values.

import type { AffinityOperations } from './operations';
import type {
  WriteInput,
  WriteResult,
  UpdateInput,
  UpdateResult,
  UpdateWriteResult,
} from 'movement-engine/public/adapter';

import { AffinityMergedEntityError } from './api_client';
import { writeParentLinks } from 'movement-engine/public/adapter';
import { logger } from 'movement-engine/public/log';
import { decodedFixedType, AFFINITY_ADAPTER_TYPE } from './types';
import { UPDATE_NOT_FOUND, isHttp404 } from 'module-kit/adapter/not_found';
import {
  applyCustomReferenceParentLinks,
  buildPersonData,
  combineParentAssociation,
  createNoopTracer,
  customReferenceFieldFor,
  partitionFields,
  readCustomFieldCurrentValues,
  readPersonBuiltins,
  writeCustomFieldValues,
  type ReferenceHolderResolver,
  type WebUrlSource,
} from './shared';

/** Resolve a parent organization id for the BUILT-IN person↔org association
 *  (the person's employer). An org parent whose edge names a CUSTOM reference
 *  field (e.g. an org's "Champion" → this person) is NOT the employer
 *  association — that's set by `applyCustomReferenceParentLinks` — so it's
 *  skipped here. The built-in `People` association (and legacy edge-less links)
 *  set the employer. Mirrors the v3 `executePerson` use of
 *  `parentResult.parentRecord`. */
async function parentOrgId(
  operations: AffinityOperations,
  write: WriteInput,
): Promise<number | undefined> {
  for (const parent of writeParentLinks(write)) {
    if (decodedFixedType(parent.recordType)?.entity !== 'organization') continue;
    const id = Number(parent.externalId);
    if (!Number.isInteger(id)) continue;
    // A custom Person-valued reference on the org points the org AT this person;
    // it is not the person's employer. Skip those — they're written separately.
    if (await customReferenceFieldFor(operations, 'organization', parent.edgeName)) continue;
    return id;
  }
  return undefined;
}

export async function createPerson(input: {
  operations: AffinityOperations;
  web: WebUrlSource;
  write: WriteInput;
  /** Which record a parent link stands for — only the adapter can say, since a
   *  per-list entry type resolves through its live list cache. */
  holderFor: ReferenceHolderResolver;
  /** Pre-resolved Affinity person id from the engine's resolveEntity, if any.
   *  When set the operations layer writes this person by id instead of
   *  re-searching by name (mirrors the organization path's `affinityId`). */
  affinityId?: number;
}): Promise<UpdateWriteResult> {
  const { operations, write } = input;
  const { builtins, custom } = partitionFields('person', write.fields);
  const { name, firstName, lastName, email } = readPersonBuiltins(builtins);

  // A name is required to CREATE/search a person; an update pinned by
  // `affinityId` writes by id and may legitimately carry no name.
  if (!name && input.affinityId == null) {
    throw new Error(
      'AffinityAdapter.createPerson: no person name — map "firstName"/"lastName" or "name" on the action.',
    );
  }

  const employerOrgId = await parentOrgId(operations, write);

  try {
    const result = await operations.createOrUpdatePerson({
      searchQuery: {
        name: name ?? '',
        email: email ?? null,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
      },
      userText: '',
      tracer: createNoopTracer(),
      fieldConfigurations: [],
      orgId: employerOrgId,
      affinityId: input.affinityId,
    });

    if (!result) {
      throw new Error(
        `AffinityAdapter.createPerson: could not create person "${name}" (no name to create one from).`,
      );
    }

    // Write every custom field we're handed — the engine already applied write
    // semantics (overwrite no-op suppression, `?:` set-if-empty) before the
    // values reached us, so a local `isNew` gate would wrongly drop authored
    // overwrites on existing people. See organization.ts for the full rationale.
    await writeCustomFieldValues(operations, {
      entityId: result.id,
      entityType: 'person',
      fieldValues: custom,
    });

    // A Person/Organization-valued custom field on the PARENT pointing at this
    // person is set here (e.g. `write org -[:Champion]-> person`).
    const customLinks = await applyCustomReferenceParentLinks(operations, {
      holderFor: input.holderFor,
      childExternalId: String(result.id),
      write,
    });

    return {
      adapterType: AFFINITY_ADAPTER_TYPE,
      externalId: String(result.id),
      // The record the create-or-update already read (and each write it made
      // answered with) — never a fresh GET of the person we just handled.
      data: buildPersonData(result.person, await input.web.getWebBaseUrl()),
      association: combineParentAssociation({
        parents: writeParentLinks(write).length,
        passes: [
          // The built-in employer association covers at most the ONE org
          // parent `parentOrgId` picked out.
          {
            handled: employerOrgId === undefined ? 0 : 1,
            made: result.orgAssociation === 'made' ? 1 : 0,
          },
          customLinks,
        ],
      }),
    };
  } catch (err) {
    if (err instanceof AffinityMergedEntityError) {
      logger.warn('[AffinityAdapter.createPerson] entity merged', {
        oldId: err.oldId,
        newId: err.newId,
      });
    }
    throw err;
  }
}

export async function updatePerson(input: {
  operations: AffinityOperations;
  web: WebUrlSource;
  update: UpdateInput;
  holderFor: ReferenceHolderResolver;
}): Promise<UpdateResult> {
  const affinityId = Number(input.update.externalId);
  if (!Number.isInteger(affinityId)) {
    throw new Error(
      `AffinityAdapter.updatePerson: externalId "${input.update.externalId}" is not a numeric person id.`,
    );
  }
  // The engine already resolved identity to `externalId`; pin it so the write
  // targets THAT person rather than re-searching by name (which could match a
  // different person or create a duplicate). NOT-FOUND contract (3b): when the
  // pinned person no longer exists, `getPersonById` throws a 404 — map it to
  // the typed signal so the engine's bind self-heal re-mints, instead of
  // letting an opaque error escape (mirrors updateOrganization).
  let result: UpdateWriteResult;
  try {
    result = await createPerson({
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

export async function readPerson(input: {
  operations: AffinityOperations;
  externalId: string;
}): Promise<Record<string, unknown> | null> {
  const id = Number(input.externalId);
  if (!Number.isInteger(id)) return null;
  let person: {
    first_name?: string | null;
    last_name?: string | null;
    primary_email?: string | null;
    emails?: string[] | null;
  };
  try {
    person = await input.operations.getClient().getPersonById(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('404')) return null;
    throw err;
  }
  // Keyed by DISPLAY NAME — the engine's write-semantics gate looks current
  // values up by the name the author wrote (see movement_engine applyUpdate).
  // Built-ins mirror schema_catalog's PERSON_BUILTINS displayNames; custom
  // fields come from the field-value API so `?:`/no-op suppression cover them.
  const fullName = [person.first_name, person.last_name].filter(Boolean).join(' ') || null;
  const custom = await readCustomFieldCurrentValues(input.operations, {
    entityType: 'person',
    entityId: id,
  });
  return {
    'First name': person.first_name ?? null,
    'Last name': person.last_name ?? null,
    'Full name': fullName,
    Email: person.primary_email ?? null,
    Emails: person.emails ?? null,
    ...custom,
  };
}
