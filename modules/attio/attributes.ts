// Attio's attribute vocabulary and the catalogue reads a client answers.

import { z } from 'zod';

/**
 * The attribute types we map deliberately. Attio owns this vocabulary and adds
 * to it, so this is the KNOWN set, not the legal one — see the validator below.
 */
const KNOWN_ATTIO_ATTRIBUTE_TYPES = [
  'text',
  'number',
  'checkbox',
  'currency',
  'date',
  'timestamp',
  'rating',
  'status',
  'select',
  'record-reference',
  'actor-reference',
  'location',
  'domain',
  'email-address',
  'phone-number',
  'interaction',
  'personal-name',
  'file',
] as const;

/**
 * OPEN, deliberately. This vocabulary belongs to Attio, and a closed enum here
 * meant one attribute of an unrecognised type failed the whole `z.array(...)`
 * parse — so a single new attribute type anywhere in a workspace blanked the
 * ENTIRE Attio schema (`schema: null`), not just its own field. An unknown type
 * must cost exactly its own field: it parses, and `mapAttributeTypeToFieldKind`
 * routes it to the string primitive.
 *
 * Every consumer only ever COMPARES this against a known literal, so widening
 * it changes no behaviour for the types we do map.
 */
const attioAttributeTypeValidator = z.string();

const attributeConfigValidator = z.object({
  id: z.string(),
  name: z.string(),
  type: attioAttributeTypeValidator,
  isMulti: z.boolean(),
  relationshipAttributeId: z.string().optional(),
  relationshipObjectId: z.string().optional(),
  /**
   * For `record-reference` attributes, the object ids the reference is allowed
   * to land on — `config.record_reference.allowed_object_ids` on the wire.
   *
   * This is the ONLY target metadata Attio gives a record-reference created in
   * the UI: such an attribute has `relationship: null` (Attio only mints the
   * paired `relationship` for its own built-in links), so reading targets from
   * `relationshipObjectId` alone made every UI-created reference invisible.
   *
   * Absent / empty means UNRESTRICTED (the reference may point at any object),
   * which is not a target list and must not be expanded into one.
   */
  allowedObjectIds: z.array(z.string()).optional(),
  isRequired: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  isWritable: z.boolean().optional(),
  apiSlug: z.string().optional(),
  options: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

type AttioAttribute = z.infer<typeof attributeConfigValidator>;

interface AttioConfigurer {
  getWorkspaceSlug(): Promise<string>;
  listLists(): Promise<
    {
      id: string;
      name: string;
      parentObjectSlugs: string[];
      apiSlug: string | null;
    }[]
  >;
  listObjects(): Promise<{ id: string; name: string; slug: string | null }[]>;
  listAttributes(params: { objectId?: string; listId?: string }): Promise<AttioAttribute[]>;
  listAttributeOptions(params: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<{ id: string; name: string }[]>;
  listStatuses(params: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<{ id: string; name: string }[]>;
  listWorkspaceMembers(): Promise<
    { id: string; firstName: string; lastName: string; email: string }[]
  >;
}

export type { AttioConfigurer, AttioAttribute };
export { attributeConfigValidator, attioAttributeTypeValidator, KNOWN_ATTIO_ATTRIBUTE_TYPES };
