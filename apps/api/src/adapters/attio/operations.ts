import { z } from 'zod';
import { formatISO, sub } from 'date-fns';

import { AttioAPIClient, AttioRecord } from './apiClient';
import { AttioAttribute, attributeConfigValidator } from './interface';
import { anthropicChat } from '../../lib/anthropic';
import { parseJson } from 'movement-engine/public/utils';
import { logger } from 'movement-engine/public/log';
import { nullishBoolean } from '../../lib/utils/nullish_boolean';
import { notNull } from '../../lib/utils/nullability';
import { matchOption } from 'movement-engine/public/utils';
import { Tracer } from '../../services/tracer';
import { safeToUrl } from '../../lib/utils/url';

export const fieldConfigurationsParser = z.array(
  z.object({
    attribute: attributeConfigValidator,
    prompt: z.string(),
    source: z.enum(['prompt', 'property']).optional(),
    propertyKey: z.string().optional(),
  }),
);

type ObjectKey = { objectId: string };
type ListKey = { listId: string };
export type ObjectKeyOrListKey = ObjectKey | ListKey;

export function isObjectKey(key: ObjectKeyOrListKey): key is ObjectKey {
  return 'objectId' in key;
}

export function isListKey(key: ObjectKeyOrListKey): key is ListKey {
  return 'listId' in key;
}

/**
 * Normalise a resolved expression value into the `string | string[]` shape
 * that downstream attribute coercion expects. Preserves array-ness so that
 * MULTI / SPLIT outputs reach a multi-select attribute as N distinct values
 * rather than a single comma-joined string. Nested arrays are flattened one
 * level; nulls inside arrays are dropped.
 */
function coerceToFieldValue(value: unknown): string | string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is NonNullable<typeof v> => v != null)
      .map((v) => String(v));
  }
  return String(value);
}

export class AttioOperations {
  constructor(private client: AttioAPIClient) {}

  getClient(): AttioAPIClient {
    return this.client;
  }

  async getFields({
    userText,
    fieldConfigs,
    objectId,
    listId,
    preResolvedValues,
  }: {
    userText: string;
    fieldConfigs: z.infer<typeof fieldConfigurationsParser>;
    objectId?: string;
    listId?: string;
    preResolvedValues?: Map<string, unknown>;
  }): Promise<{ name: string; value: string | string[] }[]> {
    const results: { name: string; value: string | string[] }[] = [];

    // Separate pre-resolved fields from prompt-based fields
    const consumedKeys = new Set<string>();
    const promptFields: z.infer<typeof fieldConfigurationsParser> = [];
    for (const field of fieldConfigs) {
      if (
        field.source === 'property' &&
        field.propertyKey &&
        preResolvedValues?.has(field.propertyKey)
      ) {
        const resolved = preResolvedValues.get(field.propertyKey);
        consumedKeys.add(field.propertyKey);
        if (resolved != null) {
          results.push({ name: field.attribute.name, value: coerceToFieldValue(resolved) });
        }
      } else {
        promptFields.push(field);
      }
    }

    // Emit any pre-resolved values not matched by a fieldConfig (v3 path:
    // fieldConfigs is empty, all values are pre-resolved keyed by attribute name)
    if (preResolvedValues) {
      for (const [key, value] of preResolvedValues) {
        if (!consumedKeys.has(key) && value != null) {
          results.push({ name: key, value: coerceToFieldValue(value) });
        }
      }
    }

    // If all fields were pre-resolved, skip LLM entirely
    if (promptFields.length === 0) return results;

    const fieldConfigurations = [];
    for (const field of promptFields) {
      if (field.attribute.type === 'select') {
        const options = await this.client.listAttributeOptions({
          objectId,
          listId,
          attributeId: field.attribute.id,
        });

        fieldConfigurations.push({
          attribute: {
            ...field.attribute,
            options,
          },
          prompt: field.prompt,
        });
      } else if (field.attribute.type === 'status') {
        const options = await this.client.listStatuses({
          objectId,
          listId,
          attributeId: field.attribute.id,
        });

        fieldConfigurations.push({
          attribute: {
            ...field.attribute,
            options,
          },
          prompt: field.prompt,
        });
      } else {
        fieldConfigurations.push({
          attribute: {
            ...field.attribute,
            options: undefined,
          },
          prompt: field.prompt,
        });
      }
    }

    const chatResponse = await anthropicChat({
      model: 'claude-sonnet-5',
      temperature: 0,
      system: `You are an intelligent function in a data extraction system.

You are given a list of fields. The user will send a document to extract data from.

<field_definitions>
${fieldConfigurations
  .map((config) => {
    return `  <field>
    <name>${config.attribute.name}</name>${config.attribute.isMulti ? `\n    <multi>true</multi>` : ''}${config.attribute.options?.length ? `\n   <options>\n${config.attribute.options.map((option) => `     ${option.name}`).join('\n')}\n</options>` : ''}
    <prompt>${config.prompt}</prompt>
  </field>`;
  })
  .join('\n')}
</field_definitions>

You extract the data from the document and return it as a JSON array of objects, one per field definition:
[
  { "name": "FIELD NAME", "thought": "Your thought process, if needed", "value": "OUTPUT OF THE PROMPT" }
]

For fields marked with multi=true, output an array of values instead of a single string:
{ "name": "MULTI-VALUE FIELD NAME", "thought": "Your thought process", "value": ["First value", "Second value"] }

If you output a value for a field with options, the value must match one of the options exactly.

Only return the JSON, nothing else. If you cannot evaluate a field, set its value to an empty string.`,
      userMessage: userText,
    });

    const singleValue = z.union([z.number().transform(String), z.string()]);
    const fieldValidator = z.object({
      name: z.string(),
      value: z.union([z.array(singleValue), singleValue]).optional(),
    });

    const parsedResponse = z.array(fieldValidator).parse(parseJson(chatResponse));

    const fields = parsedResponse.filter(
      (field): field is { name: string; value: string | string[] } =>
        field.value !== undefined &&
        (Array.isArray(field.value) ? field.value.some((v) => v.length > 0) : !!field.value),
    );
    results.push(...fields);

    return results;
  }

  async getWritableFields({
    userText,
    objectOrListKey,
    fieldConfigurations,
    preResolvedValues,
  }: {
    userText: string;
    objectOrListKey: ObjectKeyOrListKey;
    fieldConfigurations: z.infer<typeof fieldConfigurationsParser>;
    preResolvedValues?: Map<string, unknown>;
  }): Promise<{ name: string; value: unknown; attribute: AttioAttribute }[]> {
    const fields = await this.getFields({
      userText,
      objectId: isObjectKey(objectOrListKey) ? objectOrListKey.objectId : undefined,
      listId: isListKey(objectOrListKey) ? objectOrListKey.listId : undefined,
      fieldConfigs: fieldConfigurations,
      preResolvedValues,
    });

    const attributes = await this.client.listAttributes({
      objectId: isObjectKey(objectOrListKey) ? objectOrListKey.objectId : undefined,
      listId: isListKey(objectOrListKey) ? objectOrListKey.listId : undefined,
    });

    const augmentedFields = fields
      .map((field) => {
        const match = attributes.find(
          (attribute) =>
            attribute.name === field.name ||
            attribute.apiSlug === field.name ||
            attribute.name.toLowerCase() === field.name.toLowerCase(),
        );
        if (!match) {
          logger.warn(
            `[AttioOps] getWritableFields: no attribute match for field "${field.name}". Available: ${attributes.map((a) => a.name).join(', ')}`,
          );
          return null;
        }
        return {
          ...field,
          attribute: match,
        };
      })
      .filter(notNull);

    const writableFields = augmentedFields.filter((field) => field.attribute?.isWritable);

    const missingRequiredFields = attributes
      .filter((attribute) => attribute.isRequired && attribute.isWritable)
      .filter((attribute) => {
        const match = fields.find(
          (field) =>
            field.name === attribute.name ||
            field.name === attribute.apiSlug ||
            field.name.toLowerCase() === attribute.name.toLowerCase(),
        );
        return !match;
      });
    if (missingRequiredFields.length) {
      throw new Error(
        `Missing value for required fields: ${missingRequiredFields.map((field) => field.name).join(', ')}`,
      );
    }

    return Promise.all(
      writableFields.map(async (field) => ({
        ...field,
        value: await this.getValueAsAttributeType(field.value, field.attribute, objectOrListKey),
      })),
    );
  }

  transformValueForFiltering(val: unknown, attribute: AttioAttribute) {
    if (attribute.type === 'domain') {
      return { domain: { $eq: val } };
    }

    return val;
  }

  async getExistingRecordsForUniqueField({
    field,
    objectOrListKey,
  }: {
    field: { name: string; value: unknown; attribute: AttioAttribute };
    objectOrListKey: ObjectKeyOrListKey;
  }): Promise<{ id: string }[]> {
    if (!field.attribute?.isUnique) {
      return [];
    }

    const filters = Array.isArray(field.value)
      ? {
          $or: field.value.map((val) => ({
            [field.attribute.apiSlug ?? field.attribute.name]: this.transformValueForFiltering(
              val,
              field.attribute,
            ),
          })),
        }
      : {
          [field.attribute.apiSlug ?? field.attribute.name]: this.transformValueForFiltering(
            field.value,
            field.attribute,
          ),
        };

    if (isObjectKey(objectOrListKey)) {
      return this.client.filterRecords({
        objectId: objectOrListKey.objectId,
        filters,
      });
    } else if (isListKey(objectOrListKey)) {
      const entries = await this.client.filterListEntries({
        listId: objectOrListKey.listId,
        filters,
      });
      return entries.map((entry) => ({ id: entry.entryId }));
    } else {
      return [];
    }
  }

  async filterFieldValueForUniqueness({
    field,
    objectOrListKey,
  }: {
    field: { name: string; value: unknown; attribute: AttioAttribute };
    objectOrListKey: ObjectKeyOrListKey;
  }): Promise<unknown> {
    if (!field.attribute?.isUnique) {
      return field.value;
    }

    if (Array.isArray(field.value)) {
      const filteredValues = [];
      for (const value of field.value) {
        const filters = {
          [field.attribute.apiSlug ?? field.attribute.name]: this.transformValueForFiltering(
            value,
            field.attribute,
          ),
        };
        const existingRecords = isObjectKey(objectOrListKey)
          ? await this.client.filterRecords({
              objectId: objectOrListKey.objectId,
              filters,
            })
          : isListKey(objectOrListKey)
            ? await this.client.filterListEntries({
                listId: objectOrListKey.listId,
                filters,
              })
            : [];

        if (existingRecords.length) {
          continue;
        }

        filteredValues.push(value);
      }

      return filteredValues.length ? filteredValues : undefined;
    } else {
      const filters = {
        [field.attribute.apiSlug ?? field.attribute.name]: this.transformValueForFiltering(
          field.value,
          field.attribute,
        ),
      };
      const existingRecords = isObjectKey(objectOrListKey)
        ? await this.client.filterRecords({
            objectId: objectOrListKey.objectId,
            filters,
          })
        : isListKey(objectOrListKey)
          ? await this.client.filterListEntries({
              listId: objectOrListKey.listId,
              filters,
            })
          : [];

      if (existingRecords.length) {
        return undefined;
      }

      return field.value;
    }
  }

  async getExistingAndRefinedFields({
    searchQuery,
    userText,
    tracer,
    objectOrListKey,
    existingId,
    fieldConfigurations,
    preResolvedValues,
  }: {
    searchQuery?: string;
    userText: string;
    tracer: Tracer;
    objectOrListKey: ObjectKeyOrListKey;
    existingId?: string;
    fieldConfigurations: z.infer<typeof fieldConfigurationsParser>;
    preResolvedValues?: Map<string, unknown>;
  }): Promise<{ id: string | null; fieldsToAdd: { id: string; value: unknown }[] }> {
    const writableFields = await this.getWritableFields({
      userText,
      objectOrListKey,
      fieldConfigurations,
      preResolvedValues,
    });

    let existing: { id: string } | null = existingId ? { id: existingId } : null;

    if (!existing) {
      for (const field of writableFields) {
        const existingRecords = await this.getExistingRecordsForUniqueField({
          field,
          objectOrListKey,
        });
        if (existingRecords.length) {
          existing = existingRecords[0];
          break;
        }
      }
    }

    if (!existing && isObjectKey(objectOrListKey) && searchQuery) {
      tracer.add('searchQuery', searchQuery);
      const existingRecords = await this.client.searchRecords({
        objectId: objectOrListKey.objectId,
        query: searchQuery,
      });
      tracer.add('searchRecordsResult', existingRecords.length);
      existing = existingRecords[0] ?? null;
    }

    if (existing) {
      tracer.add('foundExisting', true);
      const record = isObjectKey(objectOrListKey)
        ? await this.client.getRecord({
            objectId: objectOrListKey.objectId,
            recordId: existing.id,
          })
        : await this.client.getListEntry({
            listId: objectOrListKey.listId,
            entryId: existing.id,
          });

      const fieldsExcludingUniqueClashes = [];
      for (const field of writableFields) {
        const refinedValue = await this.filterFieldValueForUniqueness({ field, objectOrListKey });
        if (!refinedValue) {
          continue;
        }

        fieldsExcludingUniqueClashes.push(field);
      }

      const fieldsToAdd = fieldsExcludingUniqueClashes
        .filter((field) =>
          Array.isArray(field.value)
            ? true
            : !((field.attribute.apiSlug ?? field.attribute.name) in record.values),
        )
        .map((field) => ({
          id: field.attribute.id,
          value: Array.isArray(field.value)
            ? field.value.filter(
                (value) =>
                  !record.values[field.attribute.apiSlug ?? field.attribute.name]?.includes(value),
              )
            : field.value,
        }));

      tracer.add('fieldsToAdd', fieldsToAdd);

      return {
        id: existing.id,
        fieldsToAdd,
      };
    } else {
      const fieldsToAdd: { id: string; value: unknown }[] = [];
      for (const field of writableFields) {
        const refinedValue = await this.filterFieldValueForUniqueness({ field, objectOrListKey });
        if (!refinedValue) {
          continue;
        }

        fieldsToAdd.push({
          id: field.attribute.id,
          value: refinedValue,
        });
      }

      tracer.add('fieldsToAdd', fieldsToAdd);

      return {
        id: null,
        fieldsToAdd,
      };
    }
  }

  async getValueAsAttributeType(
    value: string | string[],
    attribute: AttioAttribute,
    objectOrListKey?: ObjectKeyOrListKey,
  ): Promise<unknown> {
    if (attribute.isMulti) {
      const values = (Array.isArray(value) ? value : [value])
        .map((v) => v.trim())
        .filter((v) => v.length > 0);

      const processedValues = await Promise.all(
        values.map((v) =>
          this.getValueAsAttributeType(v, { ...attribute, isMulti: false }, objectOrListKey),
        ),
      );

      return processedValues.filter((v) => v !== undefined);
    } else if (Array.isArray(value)) {
      logger.warn(
        `[AttioOps] Expected single value for attribute "${attribute.name}" but got multiple. Using the first value.`,
      );
      value = value[0];
    }

    const singleValue = Array.isArray(value) ? value[0] : value;
    if (!singleValue) return undefined;

    switch (attribute.type) {
      case 'checkbox':
        return nullishBoolean.parse(singleValue) ?? undefined;
      case 'number':
      case 'currency': {
        const num = parseFloat(singleValue);
        return isNaN(num) ? undefined : num;
      }
      case 'date':
        try {
          return formatISO(new Date(singleValue), { representation: 'date' });
        } catch {
          return undefined;
        }
      case 'select': {
        const options = await this.client.listAttributeOptions({
          objectId:
            objectOrListKey && isObjectKey(objectOrListKey) ? objectOrListKey.objectId : undefined,
          listId:
            objectOrListKey && isListKey(objectOrListKey) ? objectOrListKey.listId : undefined,
          attributeId: attribute.id,
        });
        const matched = matchOption(value, options.map((o) => o.name));
        if (matched !== undefined) return matched;
        logger.warn(
          `[AttioOps] select option "${value}" not found for attribute "${attribute.name}". Available: ${options.map((o) => o.name).join(', ')}`,
        );
        return undefined;
      }
      case 'status': {
        const statuses = await this.client.listStatuses({
          objectId:
            objectOrListKey && isObjectKey(objectOrListKey) ? objectOrListKey.objectId : undefined,
          listId:
            objectOrListKey && isListKey(objectOrListKey) ? objectOrListKey.listId : undefined,
          attributeId: attribute.id,
        });
        const matched = matchOption(value, statuses.map((s) => s.name));
        if (matched !== undefined) return matched;
        logger.warn(
          `[AttioOps] status option "${value}" not found for attribute "${attribute.name}". Available: ${statuses.map((s) => s.name).join(', ')}`,
        );
        return undefined;
      }
      case 'domain': {
        const url = safeToUrl(singleValue, { log: false });
        return url ? url.hostname.replace('www.', '') : singleValue;
      }
      case 'actor-reference':
      case 'record-reference': {
        if (!attribute.relationshipObjectId) {
          logger.warn('Record reference attribute missing relationship object id', { attribute });
          return undefined;
        }

        const existingRecords = await this.client.searchRecords({
          objectId: attribute.relationshipObjectId,
          query: singleValue,
        });

        if (!existingRecords.length) {
          return undefined;
        }

        return existingRecords[0].id;
      }
      default:
        return singleValue;
    }
  }

  fieldsToObject(fields: { id: string; value: unknown }[]): Record<string, unknown> {
    return fields.reduce(
      (acc, field) => {
        if (field.value !== undefined && field.value !== null) {
          acc[field.id] = field.value;
        }
        return acc;
      },
      {} as Record<string, unknown>,
    );
  }

  async createOrUpdateObject({
    objectId,
    searchQuery,
    existingId: providedExistingId,
    userText,
    tracer,
    fieldConfigurations,
    additionalFields,
    preResolvedValues,
  }: {
    objectId: string;
    searchQuery?: string;
    existingId?: string;
    userText: string;
    tracer: Tracer;
    fieldConfigurations: z.infer<typeof fieldConfigurationsParser>;
    additionalFields?: Record<string, unknown>;
    preResolvedValues?: Map<string, unknown>;
  }): Promise<AttioRecord> {
    const { id: existingId, fieldsToAdd } = await this.getExistingAndRefinedFields({
      searchQuery,
      existingId: providedExistingId,
      userText,
      tracer,
      objectOrListKey: { objectId },
      fieldConfigurations,
      preResolvedValues,
    });

    tracer.add('existingId', existingId);

    const fields = {
      ...this.fieldsToObject(fieldsToAdd),
      ...additionalFields,
    };

    if (existingId) {
      await this.client.updateRecord({
        objectId,
        recordId: existingId,
        fields,
      });
      return this.client.getRecord({ objectId, recordId: existingId });
    } else {
      return this.client.createRecord({
        objectId,
        fields,
      });
    }
  }

  async createOrUpdateListEntry({
    listId,
    parentObjectId,
    parentRecordId,
    userText,
    tracer,
    fieldConfigurations,
    preResolvedValues,
    deduplicationWindow,
  }: {
    listId: string;
    parentObjectId: string;
    parentRecordId: string;
    userText: string;
    tracer: Tracer;
    fieldConfigurations: z.infer<typeof fieldConfigurationsParser>;
    preResolvedValues?: Map<string, unknown>;
    deduplicationWindow?: {
      years?: number;
      months?: number;
      weeks?: number;
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    };
  }): Promise<string> {
    const existingEntries = await this.client.listRecordEntries({
      objectId: parentObjectId,
      recordId: parentRecordId,
    });

    const existingEntryForRecord = existingEntries.find(
      (entry) =>
        entry.listId === listId &&
        (deduplicationWindow
          ? new Date(entry.createdAt) >= sub(new Date(), deduplicationWindow)
          : true),
    );

    const { id: existingId, fieldsToAdd } = await this.getExistingAndRefinedFields({
      userText,
      tracer,
      objectOrListKey: { listId },
      existingId: existingEntryForRecord?.entryId,
      fieldConfigurations,
      preResolvedValues,
    });

    tracer.add('existingId', existingId);

    if (existingId) {
      await this.client.updateListEntry({
        entryId: existingId,
        listId,
        fields: this.fieldsToObject(fieldsToAdd),
      });
      return existingId;
    } else {
      return this.client.addRecordToList({
        recordId: parentRecordId,
        listId,
        objectId: parentObjectId,
        fields: this.fieldsToObject(fieldsToAdd),
      });
    }
  }

  async createNote({
    parentObjectId,
    parentRecordId,
    title,
    content,
    format = 'plaintext',
  }: {
    parentObjectId: string;
    parentRecordId: string;
    title: string;
    content: string;
    format?: 'plaintext' | 'markdown';
  }): Promise<string> {
    const note = await this.client.createNote({
      parentObject: parentObjectId,
      parentRecordId,
      title,
      content,
      format,
    });
    return note.id.note_id;
  }

  async createTask({
    content,
    assignees,
    linkedRecords,
    deadlineAt,
  }: {
    content: string;
    assignees: { workspaceMemberId: string }[];
    linkedRecords: { targetObject: string; targetRecordId: string }[];
    deadlineAt?: string | null;
  }): Promise<void> {
    await this.client.createTask({
      content,
      assignees,
      linkedRecords,
      deadlineAt,
    });
  }
}
