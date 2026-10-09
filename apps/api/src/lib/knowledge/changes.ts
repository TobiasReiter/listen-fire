// change recording utility
import type { NodeId } from '../../generated/kysely/knowledge/Node';
import type { PropertyId } from '../../generated/kysely/knowledge/Property';
import type { EdgeId } from '../../generated/kysely/knowledge/Edge';
import type { EvidenceId } from '../../generated/kysely/knowledge/Evidence';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import ChangeKind from '../../generated/kysely/knowledge/ChangeKind';
import ChangeSource from '../../generated/kysely/knowledge/ChangeSource';
import { getKnowledgeQb } from '../kysely';
import { currentContext, unsafeCurrentContext } from '../../services/context';
import { mq } from '../message_queue';

export { ChangeSource, ChangeKind };

/** Map the change-record's source to the resource-change channel's. */
function resourceChangeSource(
  s: ChangeSource,
): 'agent' | 'user' | 'api' | 'pipeline' {
  switch (s) {
    case ChangeSource.agent:
    case ChangeSource.mcp:
      return 'agent';
    case ChangeSource.user_edit:
      return 'user';
    case ChangeSource.api:
      return 'api';
    case ChangeSource.pipeline:
    default:
      return 'pipeline';
  }
}

/** Fire-and-forget the kg-data resource-change hint after a write lands —
 *  one per recordChanges call (natural batching), regardless of how the
 *  write was triggered. Best-effort; a publish failure never affects the
 *  write. */
function emitKgDataChange(params: RecordChangeParams[]): void {
  const first = params[0];
  if (!first) return;
  const originId = unsafeCurrentContext()?.originId;
  mq.resourceChanges.changed
    .publish({
      kind: 'kg-data',
      teamId: first.teamId as unknown as string,
      source: resourceChangeSource(first.source),
      action: 'recordChanges',
      ...(first.nodeId ? { resourceId: first.nodeId as unknown as string } : {}),
      ...(originId ? { originId } : {}),
    })
    .catch(() => {});
}

export type ChangeValue = {
  text?: string;
  textArray?: string[];
  number?: number;
  date?: string;
  boolean?: boolean;
  json?: unknown;
};

export type RecordChangeParams = {
  teamId: string;
  requestId: string;
  source: ChangeSource;
  kind: ChangeKind;
  nodeId?: string | null;
  propertyId?: string | null;
  edgeId?: string | null;
  evidenceId?: string | null;
  oldValue?: ChangeValue | null;
  newValue?: ChangeValue | null;
  createdBy?: string | null;
};

export function normalizeValue(v: ChangeValue | null | undefined): ChangeValue | null {
  if (v == null) return null;
  // Treat empty strings as null
  if (v.text !== undefined) {
    if (v.text === '' || v.text === null) return null;
    return { text: v.text };
  }
  if (v.textArray !== undefined) {
    if (v.textArray === null || v.textArray.length === 0) return null;
    return { textArray: [...v.textArray].sort() };
  }
  if (v.number !== undefined) {
    if (v.number === null) return null;
    return { number: Number(v.number) };
  }
  if (v.date !== undefined) {
    if (!v.date) return null;
    // Normalize to ISO date string for comparison
    const d = new Date(v.date);
    return { date: isNaN(d.getTime()) ? v.date : d.toISOString() };
  }
  if (v.boolean !== undefined) {
    if (v.boolean === null) return null;
    return { boolean: v.boolean };
  }
  if (v.json !== undefined) {
    if (v.json === null) return null;
    return { json: v.json };
  }
  return null;
}

export function changeValuesEqual(a: ChangeValue | null | undefined, b: ChangeValue | null | undefined): boolean {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (na === null && nb === null) return true;
  if (na === null || nb === null) return false;
  return JSON.stringify(na) === JSON.stringify(nb);
}

function resolveCreatedBy(params: RecordChangeParams): string | null {
  if (params.createdBy) return params.createdBy;
  try {
    return currentContext().user?.id ?? null;
  } catch {
    return null;
  }
}

function isNoOp(params: RecordChangeParams): boolean {
  // Only filter property_set and property_cleared — structural changes (node/edge create/remove) always record
  if (params.kind !== ChangeKind.property_set && params.kind !== ChangeKind.property_cleared) return false;
  return changeValuesEqual(params.oldValue, params.newValue);
}

export async function recordChange(params: RecordChangeParams, trx?: any): Promise<void> {
  if (isNoOp(params)) return;
  const qb = trx ?? getKnowledgeQb(['change']);
  await qb
    .insertInto('change')
    .values({
      team_id: params.teamId as TeamId,
      request_id: params.requestId,
      source: params.source,
      kind: params.kind,
      node_id: (params.nodeId as NodeId) ?? null,
      property_id: (params.propertyId as PropertyId) ?? null,
      edge_id: (params.edgeId as EdgeId) ?? null,
      evidence_id: (params.evidenceId as EvidenceId) ?? null,
      old_value: params.oldValue ?? null,
      new_value: params.newValue ?? null,
      created_by: (resolveCreatedBy(params) as UserId) ?? null,
    })
    .execute();
}

export async function recordChanges(params: RecordChangeParams[], trx?: any): Promise<void> {
  const filtered = params.filter((p) => !isNoOp(p));
  if (filtered.length === 0) return;
  params = filtered;
  const qb = trx ?? getKnowledgeQb(['change']);
  await qb
    .insertInto('change')
    .values(
      params.map((p) => ({
        team_id: p.teamId as TeamId,
        request_id: p.requestId,
        source: p.source,
        kind: p.kind,
        node_id: (p.nodeId as NodeId) ?? null,
        property_id: (p.propertyId as PropertyId) ?? null,
        edge_id: (p.edgeId as EdgeId) ?? null,
        evidence_id: (p.evidenceId as EvidenceId) ?? null,
        old_value: p.oldValue ?? null,
        new_value: p.newValue ?? null,
        created_by: (resolveCreatedBy(p) as UserId) ?? null,
      })),
    )
    .execute();
  emitKgDataChange(params);
}

/** Extract a ChangeValue from property value columns (supports snake_case DB columns and camelCase tRPC input) */
export function propertyToChangeValue(prop: {
  value_text?: string | null;
  value_text_array?: string[] | null;
  value_number?: string | number | null;
  value_date?: Date | string | null;
  value_boolean?: boolean | null;
  value_json?: unknown;
  valueText?: string | null;
  valueTextArray?: string[] | null;
  valueNumber?: string | number | null;
  valueDate?: string | null;
  valueBoolean?: boolean | null;
  valueJson?: unknown;
}): ChangeValue | null {
  const text = prop.value_text ?? prop.valueText;
  const textArray = prop.value_text_array ?? prop.valueTextArray;
  const num = prop.value_number ?? prop.valueNumber;
  const date = prop.value_date ?? prop.valueDate;
  const bool = prop.value_boolean ?? prop.valueBoolean;
  const json = prop.value_json ?? prop.valueJson;

  if (textArray != null && textArray.length > 0) return { textArray };
  if (text != null) return { text };
  if (num != null) return { number: Number(num) };
  if (date != null) {
    const d = date instanceof Date ? date.toISOString() : date;
    return { date: d };
  }
  if (bool != null) return { boolean: bool };
  if (json !== undefined && json !== null) return { json };
  return null;
}
