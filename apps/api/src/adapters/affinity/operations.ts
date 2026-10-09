import { z } from 'zod';
import { sub } from 'date-fns';

import { AffinityAPIClient, fieldsValidator, locationFieldValue, valueType } from './apiClient';
import {
  findMatchingOrganisation as findMatchingOrganisationCommon,
  normalizeEmail,
  ownsEmail,
  splitNameByLastToken,
} from './common';
import { anthropicChat, anthropicChatStructured } from '../../lib/anthropic';
import { parseJson } from '../../lib/utils/parse_json';
import { logger } from '../../services/logger';
import { sendSlackNotification } from '../../lib/slack';
import { notNull } from '../../lib/utils/nullability';
import { Tracer } from '../../services/tracer';
import { fieldConfigurationSchema, AffinityFieldConfiguration } from './nodes/shared';
import type { ParentAssociation } from '../../services/translation_graph/adapter';
import {
  attachPersonToOrganisation,
  type AffinityPersonRecord,
} from './employer_association';

export type { AffinityPersonRecord };

type AffinityField = z.infer<typeof fieldsValidator>;

/** The judge's verdict in {@link AffinityOperations.findMatchingPerson}: the id of
 *  the matching person, or null when none of the candidates is one. */
const bestPersonMatchSchema = z.object({ id: z.number().nullable() });

export class AffinityOperations {
  constructor(private client: AffinityAPIClient) {}

  getClient(): AffinityAPIClient {
    return this.client;
  }

  async extractFields({
    userText,
    fieldConfigurations,
  }: {
    userText: string;
    fieldConfigurations: AffinityFieldConfiguration[];
  }): Promise<{ fieldId: number; fieldName: string; value: string }[]> {
    if (!fieldConfigurations.length) {
      return [];
    }

    const fields = await this.client.getFields({ type: 'ORGANIZATION' });

    const configurationsWithOptions = fieldConfigurations.map((config) => {
      const matchingField = fields.find((f) => f.id === config.fieldId);
      return {
        ...config,
        dropdownOptions: matchingField?.dropdown_options,
        allowsMultiple: matchingField?.allows_multiple,
      };
    });

    const chatResponse = await anthropicChat({
      label: 'affinity.extractFieldValues',
      system: `You are an intelligent function in a data extraction system.

You are given a list of fields. The user will send a document to extract data from.

<field_definitions>
${configurationsWithOptions
  .map((config) => {
    return `  <field>
    <id>${config.fieldId}</id>
    <name>${config.fieldName}</name>${config.dropdownOptions?.length ? `\n    <options>${config.dropdownOptions.map((option) => option.text).join(', ')}</options>` : ''}
    <value_format>${config.allowsMultiple ? 'multi-value (comma-separated-string)' : 'string'}</value_format>
    <prompt>${config.prompt}</prompt>
  </field>`;
  })
  .join('\n')}
</field_definitions>

You extract the data from the document and return it as a JSON array of objects, one per field definition:
[
  { "id": FIELD_ID, "name": "FIELD NAME", "value": "OUTPUT OF THE PROMPT" }
]

Only return the JSON, nothing else. If you cannot evaluate a field, set its value to an empty string.`,
      userMessage: userText,
    });

    const fieldValidator = z.object({
      id: z.number(),
      name: z.string(),
      value: z.union([z.number().transform((val) => val.toString()), z.string()]),
    });

    const parsedResponse = z.array(fieldValidator).parse(parseJson(chatResponse));

    return parsedResponse
      .filter((field) => !!field.value)
      .map((field) => ({
        fieldId: field.id,
        fieldName: field.name,
        value: field.value,
      }));
  }

  async findMatchingOrganisation({
    name,
    domain,
    context,
  }: {
    name: string;
    domain?: string | null;
    context?: string;
  }): Promise<{ id: number } | null> {
    const match = await findMatchingOrganisationCommon(this.client, { name, domain, context });
    return match ? { id: match.id } : null;
  }

  async findMatchingPerson({
    name,
    email,
  }: {
    name: string;
    email?: string | null;
  }): Promise<{ id: number } | null> {
    const wanted = normalizeEmail(email);
    // A whitespace-only address normalizes away to nothing. Skipping the branch
    // matters: `normalizeEmail` returns null for BOTH sides, and a null===null
    // compare would "match" the first person who happens to have no email.
    if (wanted) {
      const people = await this.client.findManyPeople({ search: wanted });
      const person = people.find((person) => normalizeEmail(person.primary_email) === wanted);
      if (person) return { id: person.id };

      const personByOtherEmails = people.find((person) =>
        person.emails?.some((candidate) => normalizeEmail(candidate) === wanted),
      );
      if (personByOtherEmails) return { id: personByOtherEmails.id };
    }

    const nameWithoutAffixes = await anthropicChat({
      label: 'affinity.stripNameAffixes',
      // Stripping "Dr." off a name is a rewrite, not a judgement — the deepest
      // reasoning the default model would otherwise buy is all latency.
      effort: 'low',
      system: `You are a helpful assistant that removes any affixes from a name.

Example:
Input: "John Doe, M.D."
Output: "John Doe"

Example:
Input: "Dr. John Doe PHD"
Output: "John Doe"

Return the output as a JSON object with schema { "name": string }.

Expect the user to provide a name. If for any reason the name cannot be processed, return null.`,
      userMessage: name,
    });

    const parsedNameWithoutAffixes = z
      .object({ name: z.string().nullable() })
      .nullable()
      .parse(parseJson(nameWithoutAffixes));
    if (!parsedNameWithoutAffixes?.name) {
      return null;
    }

    const nameClean = parsedNameWithoutAffixes.name;
    const people = await this.client.findManyPeople({ search: nameClean });
    const person = people.find(
      (person) => `${person.first_name} ${person.last_name}` === nameClean,
    );
    if (person) return { id: person.id };

    const bestPersonMatch = await anthropicChatStructured({
      system: `You are a helpful assistant that determines the best match for a name.

Here's the name we're matching: ${name}${email ? `\nHere's their email: ${email}` : ''}

Expect the user to provide an array of objects with schema { "id": number, "name": string, "emails": string[] }.

If you can't find a match, or if it's unlikely that any of the provided people are a match, report an id of null.`,
      userMessage: JSON.stringify(
        people.map((person) => ({
          id: person.id,
          name: `${person.first_name} ${person.last_name}`,
          emails: person.emails,
        })),
      ),
      schema: bestPersonMatchSchema,
      toolName: 'best_person_match',
      toolDescription: 'Report the id of the best-matching person, or null if none of them match.',
      model: 'claude-sonnet-5',
      label: 'affinity.findMatchingPerson',
    });

    if (bestPersonMatch.id == null) {
      return null;
    }

    const match = people.find((person) => person.id === bestPersonMatch.id);
    return match ? { id: match.id } : null;
  }

  /** Resolve the first/last pair Affinity's `POST /persons` demands.
   *
   *  Order matters. An author who named `First name`/`Last name` has already
   *  answered the question, and re-deriving their answer from a joined string
   *  can only lose information — that round trip is what turned "Hong Yan
   *  Hank" + "Wu" into a model shrug and a dead 128-record run. The model is
   *  consulted only for a write that supplies one undivided name, and the
   *  last-token rule catches it when it declines.
   *
   *  Null means there is no name at all — the one case a caller must handle. */
  private async personNameParts({
    name,
    firstName,
    lastName,
  }: {
    name: string;
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<{ firstName: string; lastName: string } | null> {
    // Either half authored is an answer: the author named the field, so honour
    // the half they gave and leave the other blank rather than guessing.
    if (firstName || lastName) {
      return { firstName: firstName ?? '', lastName: lastName ?? '' };
    }

    const byLastToken = splitNameByLastToken(name);
    if (!byLastToken.firstName) return null;

    const splitNameString = await anthropicChat({
      label: 'affinity.splitName',
      effort: 'low',
      system: `You are a helpful assistant that splits a name into first name and last name.

Example:
Input: "John Doe"
Output: { "first_name": "John", "last_name": "Doe" }

Example:
Input: "Dr. John Doe M.D."
Output: { "first_name": "John", "last_name": "Doe" }

Example:
Input: "John Doe, M.D."
Output: { "first_name": "John", "last_name": "Doe" }

Return the output as a JSON object with schema { "first_name": string, "last_name": string }.

Expect the user to provide a name. If for any reason the name cannot be split into a first name and last name, return null.`,
      userMessage: name,
    });

    const splitName = z
      .object({ first_name: z.string().nullable(), last_name: z.string().nullable() })
      .nullable()
      .parse(parseJson(splitNameString));
    if (!splitName?.first_name || !splitName?.last_name) {
      logger.warn('Affinity name split fell back to the last-token rule', {
        name,
        splitName,
        fallback: byLastToken,
      });
      return byLastToken;
    }

    return { firstName: splitName.first_name, lastName: splitName.last_name };
  }

  async createPerson({
    name,
    firstName,
    lastName,
    email,
    orgId,
  }: {
    name: string;
    /** The author's own split, when the write named `First name`/`Last name`. */
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    orgId?: number;
  }): Promise<AffinityPersonRecord | null> {
    const parts = await this.personNameParts({ name, firstName, lastName });
    if (!parts) {
      logger.warn('Skipping Affinity createPerson: no name to create a person from', { email });
      return null;
    }

    try {
      const person = await this.client.createPerson({
        firstName: parts.firstName,
        lastName: parts.lastName,
        email,
        orgId,
      });
      return person;
    } catch (e) {
      logger.error('Affinity createPerson API call failed', {
        name,
        firstName: parts.firstName,
        lastName: parts.lastName,
        email,
        orgId,
        error: e instanceof Error ? e.message : e,
      });
      throw e;
    }
  }

  async createOrUpdateOrganisation({
    searchQuery,
    userText,
    tracer,
    fieldConfigurations,
    affinityId,
  }: {
    searchQuery: { name: string; domain?: string | null; context?: string };
    userText: string;
    tracer: Tracer;
    fieldConfigurations: AffinityFieldConfiguration[];
    affinityId?: number;
  }): Promise<{ id: number; isNew: boolean }> {
    // First check if we already have an affinity ID, or find by name/domain
    const existingOrgId = affinityId
      ? affinityId
      : (await this.findMatchingOrganisation(searchQuery))?.id;

    tracer.add('foundExistingOrg', !!existingOrgId);

    let org: { id: number };
    if (existingOrgId) {
      org = { id: existingOrgId };
      tracer.add('orgAction', 'useExisting');

      // Check if we need to update the domain
      const existingOrg = await this.client.getOrganisationById(existingOrgId);
      // Affinity refuses a name or domain change on a global organization;
      // writing its fields and list entries is what adopts it.
      if (!existingOrg.domain && searchQuery.domain && !existingOrg.global) {
        tracer.add('orgSubAction', 'updateDomain');
        await this.client.updateOrganisation({
          id: existingOrgId,
          domain: searchQuery.domain,
        });
      }
    } else {
      tracer.add('orgAction', 'create');
      const newOrg = await this.client.createOrganisation({
        name: searchQuery.name,
        domain: searchQuery.domain,
      });
      if (!newOrg) {
        throw new Error('Failed to create organization');
      }
      org = newOrg;
    }

    tracer.add('orgId', org.id);

    const isNew = !existingOrgId;

    if (fieldConfigurations.length) {
      await this.updateFieldValues({
        entityId: org.id,
        entityType: 'organization',
        userText,
        fieldConfigurations,
        tracer,
        forceOverwrite: isNew,
      });
    }

    return { id: org.id, isNew };
  }

  async createOrUpdatePerson({
    searchQuery,
    userText,
    tracer,
    fieldConfigurations,
    orgId,
    affinityId,
  }: {
    searchQuery: {
      name: string;
      email?: string | null;
      /** The author's own first/last split, when the write named those fields.
       *  Carried alongside `name` because MATCHING still searches on the full
       *  name; only the create needs the halves. */
      firstName?: string | null;
      lastName?: string | null;
    };
    userText: string;
    tracer: Tracer;
    fieldConfigurations: AffinityFieldConfiguration[];
    orgId?: number;
    /**
     * Pinned person id — supplied when the caller has already resolved
     * identity (an update by a bound external id). When set, we use this
     * person directly and NEVER re-search by name: a name search could match a
     * different person or spawn a duplicate, silently corrupting the binding.
     * The id's existence is confirmed via `getPersonById`, so a deleted record
     * surfaces as a 404 the caller maps to the not-found signal.
     */
    affinityId?: number;
  }): Promise<{
    id: number;
    isNew: boolean;
    orgAssociation: ParentAssociation;
    /** The live person, as the API last reported it. Handed back so the caller
     *  builds its result from the record this call already read, rather than
     *  fetching the same person again a moment later. */
    person: AffinityPersonRecord;
  } | null> {
    // A name is required only when we have to SEARCH for the person — a pinned
    // update writes by id and may carry no name (e.g. updating one field).
    if (affinityId == null && !searchQuery.name.trim()) {
      logger.warn('Skipping createOrUpdatePerson: no name provided', {
        email: searchQuery.email,
      });
      return null;
    }

    const existingPerson =
      affinityId != null ? { id: affinityId } : await this.findMatchingPerson(searchQuery);
    tracer.add('foundExistingPerson', !!existingPerson);

    let person: AffinityPersonRecord;
    // What became of the employer association this call was asked to make.
    // The caller reports it to the engine, which is what lets a matched person
    // whose own fields never changed say "attached" and mean it.
    let orgAssociation: ParentAssociation = orgId ? 'already' : 'none';
    if (existingPerson) {
      tracer.add('personAction', 'useExisting');

      // ONE read of the live person answers every question this branch asks of
      // it: does the pinned id still exist (a deleted record 404s here, which
      // the caller maps to the not-found signal), is the org already among the
      // employers, does the person already own the incoming address — and it is
      // the record the caller hands back. It used to be three GETs of the same
      // record moments apart, plus a fourth for the result payload; the person
      // cannot change between them, and each write below answers with the
      // updated record anyway.
      person = await this.client.getPersonById(existingPerson.id);

      // Each write below folds what it SENT back onto the record in hand — we
      // know what we wrote, so the snapshot stays current without depending on
      // what the PUT chooses to echo.
      if (orgId) {
        const joined = await attachPersonToOrganisation(this.client, { person, orgId });
        person = joined.person;
        orgAssociation = joined.association;
      }

      // Compare normalized, or a differently-cased spelling of an address the
      // person already owns gets appended as though it were a second address —
      // observed against fake-channels, and on the real API this same PUT is a
      // 422 when the address belongs to someone else.
      const authoredEmail = searchQuery.email?.trim();
      const incomingEmail = normalizeEmail(authoredEmail);
      if (authoredEmail && incomingEmail && !ownsEmail(person.emails, incomingEmail)) {
        // Trimmed, but with the authored capitalisation intact.
        const emails = [...(person.emails ?? []), authoredEmail];
        await this.client.updatePerson(person.id, { emails });
        person = { ...person, emails };
      }
    } else {
      tracer.add('personAction', 'create');
      const newPerson = await this.createPerson({
        name: searchQuery.name,
        firstName: searchQuery.firstName,
        lastName: searchQuery.lastName,
        email: searchQuery.email,
        orgId,
      });
      // Only a nameless write reaches here now — an unsplittable name falls
      // back to the last-token rule rather than giving up.
      if (!newPerson) return null;
      person = newPerson;
      // A person created WITH an org joins it in the same call.
      if (orgId) orgAssociation = 'made';
    }

    tracer.add('personId', person.id);

    const isNew = !existingPerson;

    if (fieldConfigurations.length) {
      await this.updateFieldValues({
        entityId: person.id,
        entityType: 'person',
        userText,
        fieldConfigurations,
        tracer,
        forceOverwrite: isNew,
      });
    }

    return { id: person.id, isNew, orgAssociation, person };
  }


  async createListEntry({
    listId,
    entityId,
    entityType,
    deduplicationWindow,
    tracer,
  }: {
    listId: number;
    entityId: number;
    entityType: 'organization' | 'person';
    deduplicationWindow?: {
      years?: number;
      months?: number;
      weeks?: number;
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    };
    tracer: Tracer;
  }): Promise<{ id: number; isNew: boolean } | null> {
    const list = await this.client.getListById(listId);
    tracer.add('listName', list.name);

    const startDate = deduplicationWindow ? sub(new Date(), deduplicationWindow) : undefined;
    const existingEntryId = await this.client.getExistingListEntryId({
      list,
      entityId,
      entityType,
      startDate,
    });

    if (existingEntryId) {
      tracer.add('listEntryAction', 'useExisting');
      tracer.add('listEntryId', existingEntryId);
      return { id: existingEntryId, isNew: false };
    }

    tracer.add('listEntryAction', 'create');
    const listEntryId = await this.client.createListEntry({
      list,
      org: { id: entityId },
    });
    tracer.add('listEntryId', listEntryId);

    return listEntryId ? { id: listEntryId, isNew: true } : null;
  }

  async createNote({
    organizationId,
    personId,
    opportunityId,
    parentNoteId,
    content,
    type,
    tracer,
  }: {
    organizationId?: number;
    personId?: number;
    opportunityId?: number;
    /** Create the note as a REPLY to an existing note (POST /notes
     *  `parent_id`) — entity associations are the parent's, per the API. */
    parentNoteId?: number;
    content: string;
    type?: number;
    tracer: Tracer;
  }): Promise<{ id: number } | null> {
    if (!content.trim()) {
      tracer.add('noteAction', 'skipped_empty');
      return null;
    }

    if (organizationId == null && personId == null && opportunityId == null && parentNoteId == null) {
      logger.warn('AffinityOperations.createNote: no parent entity or parent note — skipping');
      tracer.add('noteAction', 'skipped_no_parent');
      return null;
    }

    const note = await this.client.createNote({
      ...(organizationId != null ? { organization_ids: [organizationId] } : {}),
      ...(personId != null ? { person_ids: [personId] } : {}),
      ...(opportunityId != null ? { opportunity_ids: [opportunityId] } : {}),
      ...(parentNoteId != null ? { parent_id: parentNoteId } : {}),
      content,
      type,
    });
    tracer.add('noteAction', note ? 'created' : 'failed');
    return note ? { id: note.id } : null;
  }

  private async updateFieldValues({
    entityId,
    entityType,
    userText,
    fieldConfigurations,
    listEntryId,
    tracer,
    forceOverwrite = false,
  }: {
    entityId: number;
    entityType: 'organization' | 'person';
    userText: string;
    fieldConfigurations: AffinityFieldConfiguration[];
    listEntryId?: number;
    tracer: Tracer;
    forceOverwrite?: boolean;
  }): Promise<void> {
    const extractedFields = await this.extractFields({
      userText,
      fieldConfigurations,
    });

    tracer.add('extractedFields', extractedFields);

    const allFields = await this.client.getFields({
      type: entityType === 'organization' ? 'ORGANIZATION' : 'PERSON',
    });

    const fieldValueArgs: Parameters<typeof this.client.getFieldValues>[0] =
      entityType === 'organization' ? { organization_id: entityId } : { person_id: entityId };

    const existingFieldValues = await this.client.getFieldValues(fieldValueArgs);
    const existingFieldIds = new Set(existingFieldValues.map((v) => v.field_id));

    const fieldsToCreate = extractedFields.filter((field) => !existingFieldIds.has(field.fieldId));
    const fieldsToOverwrite = extractedFields.filter((field) => {
      if (!existingFieldIds.has(field.fieldId)) return false;
      if (forceOverwrite) return true;
      const config = fieldConfigurations.find((c) => c.fieldId === field.fieldId);
      return config?.overrideExisting;
    });

    tracer.add('fieldsToCreateCount', fieldsToCreate.length);
    tracer.add('fieldsToOverwriteCount', fieldsToOverwrite.length);

    const overwriteFieldValueIds = new Map<number, number>();
    for (const fieldValue of fieldsToOverwrite) {
      const existingValue = existingFieldValues.find((v) => v.field_id === fieldValue.fieldId);
      if (existingValue) {
        overwriteFieldValueIds.set(fieldValue.fieldId, existingValue.id);
      }
    }

    const allFieldsToWrite = [...fieldsToCreate, ...fieldsToOverwrite];

    for (const fieldValue of allFieldsToWrite) {
      const fieldDef = allFields.find((f) => f.id === fieldValue.fieldId);
      if (!fieldDef) continue;

      const splitValues = fieldDef.allows_multiple
        ? fieldValue.value.split(/,\s*/)
        : [fieldValue.value];

      for (const value of splitValues) {
        if (!value.trim()) continue;

        const resolvedValue = await this.resolveFieldApiValue({ fieldDef, value });
        if (resolvedValue === null) continue;

        // Dealflow's extraction write is fire-and-forget: one field Affinity
        // refuses must not lose the rest of an extraction. The client itself
        // reports the failure now, so the decision to walk past it is made
        // HERE, where it belongs, and is not imposed on every other caller.
        try {
          const existingValueId = overwriteFieldValueIds.get(fieldDef.id);
          if (existingValueId) {
            await this.client.updateFieldValue({ id: existingValueId, value: resolvedValue });
            overwriteFieldValueIds.delete(fieldDef.id);
          } else {
            await this.client.createFieldValue({
              field_id: fieldDef.id,
              value: resolvedValue,
              list_entry_id: fieldDef.list_id && listEntryId ? listEntryId : undefined,
              entity_id: entityId,
            });
          }
        } catch (err) {
          logger.error(err);
          await sendSlackNotification({
            type: 'DEALFLOW',
            text: `:warning: Affinity error adding field value (field: ${fieldDef.id}, entity: ${entityId}, list_entry: ${listEntryId ?? '—'}, value: ${String(resolvedValue)})`,
            opsTitle: 'Affinity error adding a field value',
          });
        }
      }
    }
  }

  private async resolveFieldApiValue({
    fieldDef,
    value,
  }: {
    fieldDef: AffinityField;
    value: string;
  }): Promise<unknown | null> {
    if (fieldDef.value_type === valueType.PERSON) {
      let matchingPerson = await this.findMatchingPerson({ name: value });
      if (!matchingPerson) {
        matchingPerson = await this.createPerson({ name: value });
      }
      return matchingPerson ? matchingPerson.id : null;
    } else if (fieldDef.value_type === valueType.ORGANIZATION) {
      let matchingOrg = await this.findMatchingOrganisation({ name: value });
      if (!matchingOrg) {
        const newOrg = await this.client.createOrganisation({ name: value });
        matchingOrg = newOrg ? { id: newOrg.id } : null;
      }
      return matchingOrg ? matchingOrg.id : null;
    } else if (
      fieldDef.value_type === valueType.DROPDOWN ||
      fieldDef.value_type === valueType.TEXT
    ) {
      return value;
    } else if (fieldDef.value_type === valueType.RANKED_DROPDOWN) {
      const option = fieldDef.dropdown_options?.find((opt) => opt.text === value);
      return option ? option.id : null;
    } else if (fieldDef.value_type === valueType.DATE) {
      return new Date(value).toISOString();
    } else if (fieldDef.value_type === valueType.LOCATION) {
      const formattedLocation = await anthropicChat({
        label: 'affinity.formatLocation',
        effort: 'low',
        system: `You are a location formatter. You will be given a location and you must format it into a string that can be used in a location field.
Output a JSON object with the following keys:
- street_address
- city
- state
- country
- continent

The corresponding values must be a string if an appropriate value appears in the user's input, or null otherwise.

Output: strictly this JSON format. Do not include any additional text.`,
        userMessage: value,
      });
      return locationFieldValue.parse(parseJson(formattedLocation));
    } else if (fieldDef.value_type === valueType.NUMBER) {
      return Number(value);
    }
    return null;
  }
}
