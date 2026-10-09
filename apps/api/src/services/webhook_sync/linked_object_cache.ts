// The linked_object cache: a KG node already bridged to an external record
// keeps a copy of the record's data. An inbound event naming the record owes a
// refresh, which the `linked_object_refresh` work row runs
// (linked_object_refresh.ts).
import { z } from 'zod';

import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getAutomationsQb, getKnowledgeQb } from '../../lib/kysely';
import { logger } from '../logger';
import { decryptToken } from '../../lib/credentials';
import { AttioAPIClient, attioCredsParser } from '../../adapters/attio/apiClient';
import { buildRecordData } from '../knowledge_pipeline/output_v3/adapters/attio';
import { normalizeAdapterType } from '../knowledge_pipeline/output_v3/linked_objects';
import { injectFakeBaseUrl, isTestHarnessTeam } from '../../lib/recording';

/** What one refresh needs, as plain data so it rides the work payload. */
export const linkedObjectRefreshSchema = z.object({
  teamId: z.custom<TeamId>((value) => typeof value === 'string'),
  /** The webhook subscription's provider key (`ATTIO`, …). */
  provider: z.string(),
  credentialsId: z.string(),
  externalId: z.string(),
  recordType: z.string().optional(),
});

export type LinkedObjectRefresh = z.infer<typeof linkedObjectRefreshSchema>;

function bridgedLinkedObjects(refresh: LinkedObjectRefresh) {
  return getKnowledgeQb(['linked_object'])
    .selectFrom('linked_object')
    .where('linked_object.external_id', '=', refresh.externalId)
    .where('linked_object.adapter_type', '=', normalizeAdapterType(refresh.provider))
    .where('linked_object.team_id', '=', refresh.teamId);
}

/** Whether any KG node is bridged to the record — a local read, cheap enough
 *  for the request, so only events with something to refresh get a row. */
export async function hasBridgedLinkedObjects(refresh: LinkedObjectRefresh): Promise<boolean> {
  const row = await bridgedLinkedObjects(refresh).select('linked_object.id').executeTakeFirst();
  return row !== undefined;
}

/**
 * Refresh the linked_object cache for any KG node already bridged to this
 * external record. linked_object.adapter_type is stored canonically lowercase
 * (TG-native convention); the provider is the uppercase enum, so normalise
 * before querying.
 *
 * Independent of dispatch: a structured-input movement runs even when no prior
 * linked_object exists (the movement's write creates the bridge itself).
 */
export async function refreshLinkedObjects(refresh: LinkedObjectRefresh): Promise<void> {
  const linkedObjects = await bridgedLinkedObjects(refresh)
    .select(['linked_object.id', 'linked_object.node_id', 'linked_object.external_object_type'])
    .execute();
  if (linkedObjects.length === 0) return;

  const recordData = await fetchRecordFromProvider(refresh);
  if (!recordData) return;
  for (const lo of linkedObjects) {
    await getKnowledgeQb(['linked_object'])
      .updateTable('linked_object')
      .set({
        data: recordData.data,
        external_object_type: recordData.objectTypeName ?? lo.external_object_type,
        fetched_at: new Date(),
        updated_at: new Date(),
      })
      .where('linked_object.id', '=', lo.id)
      .execute();
  }
  logger.info(
    `Webhook updated ${linkedObjects.length} linked object(s) for record ${refresh.externalId}`,
  );
}

async function fetchRecordFromProvider(
  refresh: LinkedObjectRefresh,
): Promise<{ data: Record<string, unknown>; objectTypeName?: string } | null> {
  if (refresh.provider === 'ATTIO') {
    if (!refresh.recordType) return null;
    return fetchAttioRecord(
      { recordId: refresh.externalId, objectId: refresh.recordType },
      refresh.credentialsId,
      refresh.teamId,
    );
  }

  logger.warn(`No record fetcher for provider ${refresh.provider}`);
  return null;
}

async function fetchAttioRecord(
  ref: { recordId: string; objectId: string },
  credentialsId: string,
  teamId: string,
): Promise<{ data: Record<string, unknown>; objectTypeName?: string } | null> {
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('external_service_credentials.id', '=', credentialsId as ExternalServiceCredentialsId)
    .where('external_service_credentials.team_id', '=', teamId as TeamId)
    .select(['external_service_credentials.id', 'external_service_credentials.credentials'])
    .executeTakeFirst();

  if (!cred) return null;

  const decrypted = await decryptToken(cred.credentials as Buffer, credentialsId);
  let parsed = attioCredsParser.parse(JSON.parse(decrypted));
  if (isTestHarnessTeam(teamId)) {
    parsed = attioCredsParser.parse(injectFakeBaseUrl(parsed as unknown as Record<string, unknown>, 'ATTIO'));
  }
  const client = new AttioAPIClient(parsed);

  const record = await client.getRecord({
    objectId: ref.objectId,
    recordId: ref.recordId,
  });

  const data = buildRecordData(record, ref.objectId);

  // Try to resolve a friendly object type name
  let objectTypeName: string | undefined;
  try {
    const objects = await client.listObjects();
    const matched = objects.find((o) => o.id === ref.objectId || o.slug === ref.objectId);
    objectTypeName = matched?.name;
  } catch {
    // Non-critical — skip
  }

  return { data, objectTypeName };
}
