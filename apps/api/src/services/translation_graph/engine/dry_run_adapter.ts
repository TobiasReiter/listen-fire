// Dry-run adapter wrapper. Wraps a real target Adapter so writes are
// intercepted before they reach the external system, while reads still
// hit live data — the same "simulate the write, observe what would
// happen" shape v3 uses via output_v3/adapters/dry_run.ts.
//
// In dry-run mode the engine still:
//   • resolves entity matches against the real target (so we see whether
//     a record would be matched vs. created),
//   • reads current values for no-op detection (skips that would skip
//     for real),
//   • drives `applyActionPlan` to its normal endpoint so applied plans
//     and diagnostics line up with what a live run would record.
//
// What it doesn't do:
//   • write to external systems (create/update/delete return synthesized
//     results without side effects),
//   • emit RecordMutationEvents (no downstream cascade),
//   • insert linked_object bridges (the engine gates `ensureBridge` on
//     `ctx.dryRun`).

import { randomUUID } from 'node:crypto';

import type {
  Adapter,
  WriteInput,
  WriteResult,
  UpdateInput,
  UpdateResult,
  DeleteInput,
  DeleteResult,
  LinkRecordsInput,
  LinkRecordsResult,
  UnlinkRecordsInput,
  UnlinkRecordsResult,
} from '../adapter';

/**
 * A write the engine *would* have performed, captured during a dry run.
 * `kind: 'update'` carries the live `externalId` it would have written to
 * (matching reads still hit the real target — see file header), so the
 * caller can render "would update the existing record" vs "would create".
 */
export interface CapturedWrite {
  kind: 'create' | 'update' | 'delete' | 'link' | 'unlink';
  /**
   * Adapter that would have received the write — the wrapped target's
   * `adapterType`. With per-action target overrides (M4b) one dry run can
   * capture writes bound for several systems; this is what distinguishes
   * them in the sink output.
   */
  adapterType: string;
  recordType: string;
  fields?: Record<string, unknown>;
  externalId?: string;
  /**
   * What this record hangs off, with the edge it hangs off by — 1 for a
   * linked write, N for a tuple path, absent for a root write.
   *
   * Records connect through edges, so a rehearsal that showed only the fields
   * showed half the write: an entry added to a list is not the same claim as
   * an entry, and the organization it was added to is the other half of it.
   *
   * `rehearsed` marks a parent that does not exist — its id was minted by this
   * rehearsal a moment ago rather than read off the target — so a reader can
   * tell "added to the organization you have" from "added to the organization
   * this run would have created".
   */
  parents?: Array<{
    edgeName: string;
    recordType: string;
    externalId: string;
    rehearsed?: true;
  }>;
  /** `kind: 'link' | 'unlink'` only — the asserted (or severed) edge.
   *  `recordType` / `externalId` above are the from side; the to side
   *  rides here. */
  link?: { edgeName: string; toRecordType: string; toExternalId: string };
}

export type DryRunWriteSink = (write: CapturedWrite) => void;

/**
 * One rehearsal, shared by every adapter it wraps.
 *
 * The ids a rehearsal mints are the run's, not any one adapter's: a write
 * chained off a rehearsed parent frequently crosses systems (the organization
 * in the CRM, the entry on its list), and a per-adapter memory would report
 * that parent as real. So the memory belongs to the run.
 */
export interface DryRunRehearsal {
  sink?: DryRunWriteSink;
  /** Every externalId this rehearsal invented, so a parent link naming one can
   *  be reported as rehearsed rather than as a record that exists. */
  minted: Set<string>;
  /** Mints each invented id: a random UUID unless the host supplies its own
   *  (a test host's deterministic sequence, so a recorded rehearsal replays
   *  the same). */
  mintId: () => string;
}

export function newDryRunRehearsal(sink?: DryRunWriteSink, mintId: () => string = randomUUID): DryRunRehearsal {
  return { ...(sink !== undefined ? { sink } : {}), minted: new Set<string>(), mintId };
}

export function wrapAdapterForDryRun(adapter: Adapter, rehearsal: DryRunRehearsal): Adapter {
  const { sink } = rehearsal;
  const capturedParents = (input: WriteInput): CapturedWrite['parents'] => {
    const links = input.parentLinks ?? [];
    if (links.length === 0) return undefined;
    return links.map((link) => ({
      edgeName: link.edgeName,
      recordType: link.recordType,
      externalId: link.externalId,
      ...(rehearsal.minted.has(link.externalId) ? { rehearsed: true as const } : {}),
    }));
  };

  // Proxy with overrides on the write methods. Everything else
  // (describe, resolveEntity, getFieldValue, readRecord, capabilities,
  // adapterType, …) passes straight through to the real adapter.
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'createRecord') {
        return async (input: WriteInput): Promise<WriteResult> => {
          // Synthesize a placeholder externalId so downstream children that
          // consume `parent_result.external_id` still execute. It must be a
          // real UUID, not a tagged string: KG-target writes cast a parent /
          // edge reference to a uuid, and a non-uuid id ("dry-run-…") fails
          // that cast. A random uuid is also a valid id for string-id targets
          // (Attio, etc.), so this is safe across adapters.
          const externalId = rehearsal.mintId();
          const parents = capturedParents(input);
          rehearsal.minted.add(externalId);
          sink?.({
            kind: 'create',
            adapterType: target.adapterType,
            recordType: input.recordType,
            fields: input.fields,
            ...(parents !== undefined ? { parents } : {}),
          });
          return { adapterType: target.adapterType, externalId, data: {} };
        };
      }
      if (prop === 'updateRecord') {
        return async (input: UpdateInput): Promise<UpdateResult> => {
          // An update's `externalId` is the REAL one: matching still runs
          // against the live target under a rehearsal, so a write that found
          // its record hands the record's own id back and reads off the handle
          // work. Only a create has no id to hand back.
          const parents = capturedParents(input);
          sink?.({
            kind: 'update',
            adapterType: target.adapterType,
            recordType: input.recordType,
            fields: input.fields,
            externalId: input.externalId,
            ...(parents !== undefined ? { parents } : {}),
          });
          return {
            adapterType: target.adapterType,
            externalId: input.externalId,
            data: {},
            // Synthesized like create's externalId and link's `created: true`:
            // a rehearsal reads nothing against the live target, so it answers
            // as the write it captured would have — the association the author
            // asked for, made.
            association: parents === undefined ? ('none' as const) : ('made' as const),
          };
        };
      }
      if (prop === 'deleteRecord') {
        return async (input: DeleteInput): Promise<DeleteResult> => {
          sink?.({
            kind: 'delete',
            adapterType: target.adapterType,
            recordType: input.recordType,
            externalId: input.externalId,
          });
          return {};
        };
      }
      if (prop === 'linkRecords') {
        // Only present when the wrapped adapter genuinely implements it,
        // so the engine's capability rejection behaves identically under
        // dry run. `created: true` is synthesized like create's externalId
        // — no read against the live target decides idempotence here.
        if (typeof target.linkRecords !== 'function') return undefined;
        return async (input: LinkRecordsInput): Promise<LinkRecordsResult> => {
          sink?.({
            kind: 'link',
            adapterType: target.adapterType,
            recordType: input.from.recordType,
            externalId: input.from.externalId,
            link: {
              edgeName: input.edgeName,
              toRecordType: input.to.recordType,
              toExternalId: input.to.externalId,
            },
          });
          return { created: true };
        };
      }
      if (prop === 'unlinkRecords') {
        // Mirror of linkRecords: present only when the wrapped adapter
        // genuinely implements it; `removed: true` is synthesized — no
        // read against the live target decides idempotence here.
        if (typeof target.unlinkRecords !== 'function') return undefined;
        return async (input: UnlinkRecordsInput): Promise<UnlinkRecordsResult> => {
          sink?.({
            kind: 'unlink',
            adapterType: target.adapterType,
            recordType: input.from.recordType,
            externalId: input.from.externalId,
            link: {
              edgeName: input.edgeName,
              toRecordType: input.to.recordType,
              toExternalId: input.to.externalId,
            },
          });
          return { removed: true };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
