// Affinity TG adapter — note + file create. Both attach to a parent entity
// (note → org or person; file → org), so neither has independent identity.
//
//   • Note  — lifts v3 `executeNote`'s non-LLM path: the `content` field is
//     written verbatim as a note on the parent. (The v3 prompt-driven note
//     generation is an authoring affordance, not adapter behaviour — under
//     TGs the author writes an expression that produces the content, so the
//     adapter just persists what it's handed.)
//   • File  — lifts v3 `executeFile`: a File-typed value (a Resource handle)
//     is fetched and uploaded to the parent organization.

import type { AffinityOperations } from '../../../../adapters/affinity/operations';
import type { FileRef, WriteInput, WriteResult } from 'movement-engine/services/translation_graph/adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';

import { singleParentLink } from 'movement-engine/services/translation_graph/adapter';
import { hasFileSource, streamFileRef } from '../../engine/files/retrieve';
import { logger } from 'movement-engine/services/logger';
import { decodedFixedType, AFFINITY_ADAPTER_TYPE } from './types';
import { createNoopTracer } from './shared';

// ── Note ─────────────────────────────────────────────────────────────────────

export async function createNote(input: {
  operations: AffinityOperations;
  write: WriteInput;
}): Promise<WriteResult> {
  const { operations, write } = input;
  // A note belongs to a single owner — the lone parent of this write: an
  // organization, person, or opportunity (`org-[:Notes]->`), or another NOTE
  // when the write rides the reply edge (`note-[:Replies]->`, v1 `parent_id`).
  const parentLink = singleParentLink(write);
  if (!parentLink) {
    throw new Error(
      'AffinityAdapter.createNote: requires a parent organization, person, opportunity, or note (a reply).',
    );
  }
  const parentDecoded = decodedFixedType(parentLink.recordType);
  const parentId = Number(parentLink.externalId);
  if (!Number.isInteger(parentId)) {
    throw new Error(
      `AffinityAdapter.createNote: parent externalId "${parentLink.externalId}" is not numeric.`,
    );
  }

  const content = typeof write.fields.content === 'string' ? write.fields.content : '';
  if (!content.trim()) {
    // Nothing to write; surface an empty result rather than a thrown error so
    // an unconfigured note action no-ops cleanly.
    return { adapterType: AFFINITY_ADAPTER_TYPE, externalId: '', data: {} };
  }

  const created = await operations.createNote({
    organizationId: parentDecoded?.entity === 'organization' ? parentId : undefined,
    personId: parentDecoded?.entity === 'person' ? parentId : undefined,
    opportunityId: parentDecoded?.entity === 'opportunity' ? parentId : undefined,
    parentNoteId: parentDecoded?.entity === 'note' ? parentId : undefined,
    content,
    tracer: createNoopTracer(),
  });

  return {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: created ? String(created.id) : '',
    data: {},
  };
}

// ── File ─────────────────────────────────────────────────────────────────────

/** The File-typed value the engine delivers — a branded `FileRef` descriptor
 *  (adapter.ts), redeemed for its bytes here on the host side, with `name` /
 *  `contentType` metadata top-level. Inline `content` is the fallback for text composed in
 *  the program body. `url` is display-only — never the bytes. */
interface FileValue extends FileRef {
  url?: string | null;
  content?: string;
}

function asFileValue(raw: unknown): FileValue | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as FileValue;
}

export async function createFile(input: {
  operations: AffinityOperations;
  /** The team whose run is writing — the `File` value is redeemed for it. */
  teamId: TeamId;
  write: WriteInput;
}): Promise<WriteResult> {
  const { operations, teamId, write } = input;
  // A file belongs to a single owning record — the lone parent: an
  // organization, person, or opportunity (POST /entity-files takes exactly
  // one of organization_id / person_id / opportunity_id).
  const parentLink = singleParentLink(write);
  const parentEntity = parentLink ? decodedFixedType(parentLink.recordType)?.entity : undefined;
  if (
    !parentLink ||
    (parentEntity !== 'organization' && parentEntity !== 'person' && parentEntity !== 'opportunity')
  ) {
    throw new Error(
      'AffinityAdapter.createFile: requires a parent organization, person, or opportunity.',
    );
  }
  const parentId = Number(parentLink.externalId);
  if (!Number.isInteger(parentId)) {
    throw new Error(
      `AffinityAdapter.createFile: parent externalId "${parentLink.externalId}" is not numeric.`,
    );
  }

  const fileValue = asFileValue(write.fields.file);
  if (!fileValue) {
    logger.warn('[AffinityAdapter.createFile] no file value mapped — skipping upload');
    return { adapterType: AFFINITY_ADAPTER_TYPE, externalId: '', data: {} };
  }

  const blob = await fetchFileBlob(fileValue, teamId);
  if (!blob) {
    logger.warn('[AffinityAdapter.createFile] could not retrieve file bytes — skipping upload', {
      name: fileValue.name,
    });
    return { adapterType: AFFINITY_ADAPTER_TYPE, externalId: '', data: {} };
  }

  const fileName = fileValue.name ?? 'file';
  const file = new File([blob.blob], encodeURIComponent(fileName), { type: blob.contentType });
  await operations
    .getClient()
    .uploadEntityFile({ entity: { id: parentId }, entityType: parentEntity, file });
  logger.info(`[AffinityAdapter.createFile] uploaded "${fileName}" to ${parentEntity} ${parentId}`);

  return {
    adapterType: AFFINITY_ADAPTER_TYPE,
    externalId: '',
    data: { name: fileName },
  };
}

async function fetchFileBlob(
  fileValue: FileValue,
  teamId: TeamId,
): Promise<{ blob: Blob; contentType: string } | null> {
  // Redeem the descriptor for its bytes and buffer them into the Blob the
  // Affinity upload needs.
  if (hasFileSource(fileValue)) {
    try {
      const resolved = await streamFileRef(fileValue, { teamId });
      const bytes = await streamToBuffer(resolved.stream);
      const contentType =
        resolved.contentType ?? fileValue.contentType ?? 'application/octet-stream';
      return { blob: new Blob([bytes], { type: contentType }), contentType };
    } catch (err) {
      logger.warn('[AffinityAdapter.createFile] file retrieval failed', {
        name: fileValue.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: inline text content composed in the program body.
  if (typeof fileValue.content === 'string') {
    return {
      blob: new Blob([fileValue.content], { type: fileValue.contentType ?? 'text/plain' }),
      contentType: fileValue.contentType ?? 'text/plain',
    };
  }

  return null;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
