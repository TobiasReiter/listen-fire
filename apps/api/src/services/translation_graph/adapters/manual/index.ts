// Manual adapter — the run-on-demand intrinsic, now the SINGLE on-demand
// trigger. Manual runs collapse into an adapter (3_syntax_sketch.md
// "Composition, time, queries, failure"): instead of a separate invocation
// statement, a movement that should be runnable on demand listens to a manual
// channel —
//
//   go = manual()
//   listen to go {} fire backfill
//
// "Run now" (the workbench button, the dev CLI, MCP `runMovement`) injects an
// invocation event on that channel and the firing flows through NORMAL trigger
// dispatch — uniform run_mode gating, uniform trigger_run recording. The event
// carries the initiating actor, so `@user_email` / `@actor_*` resolve to
// whoever pressed the button (extractActor below).
//
// An invocation OPTIONALLY carries text and/or files — the input a person
// types or drops straight into the movement when they run it. This folds in
// what used to be the separate `web` adapter: the invocation's text
// (`go.\`Text\``) and its `Files` edge both resolve off the same invocation
// position. The retired input-side `#resources` bundle is gone — body and
// files are accessed via explicit fields/edges only. Files' bytes are stored
// by the invocation service via `services.document.upload`, whose `objectUri`
// rides as the handle of the file's `FileRef` descriptor; the host redeems it
// via `resolveFileRef`, streaming bytes back out of document storage — the
// identical mechanism the email / whatsapp attachment uses.
//
// Source-only and credential-free; no external subscription (nothing is
// registered anywhere — the event is injected in-process by the invocation
// service).
//
// manual subsumes web
// owner-resolvable FileRef handles

import { services } from '../../../../adapters/registry';
import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  ActorCandidate,
  ActorIdentity,
  Adapter,
  AdapterManifest,
  FileRef,
  GetRelatedInput,
  RelatedResult,
  ResolveFileRefResult,
  EdgesFromResult,
} from '../../adapter';
import { fileHandle, ownedFileSource } from '../../adapter';
import { uniformWalk } from '../hop';
import { MANUAL_HANDBOOK_SECTION } from './handbook_section';
import type {
  SchemaEntryPoint,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import {
  META_RECORD_TYPE,
  makeUnstablePosition,
  positionData,
} from '../../types';
import type { TriggerEvent } from '../../triggers/types';
import { BaseAdapter } from '../base';

/** Stable adapter identifier — the trigger `kind` of manual-derived rows. */
export const MANUAL_ADAPTER_TYPE = 'manual';

/** Type id for the invocation position a Run-now seeds. Internal currency —
 *  stays lowercase; authors see `MANUAL_INVOCATION_DISPLAY_NAME`. */
export const MANUAL_INVOCATION_TYPE_ID = 'invocation';

/** Natural type name for an invocation — TitleCase, like every other graph's
 *  nodes (adapters/CLAUDE.md). The event seed keys its position by this name
 *  (the address is the natural node name, layer 8); the typeId stays stable. */
export const MANUAL_INVOCATION_DISPLAY_NAME = 'Invocation';

/** Type id for the per-file record (one position per uploaded file). Internal
 *  currency — stays lowercase; authors see `MANUAL_FILE_DISPLAY_NAME`. */
export const MANUAL_FILE_TYPE_ID = 'file';

/** Natural type name for a supplied file — TitleCase. Every fanned file
 *  position carries this name as its `recordType` (THE ONE RULE, base.ts), so
 *  field reads resolve it through the resolver; the typeId stays stable. */
export const MANUAL_FILE_DISPLAY_NAME = 'File';

/** Edge id on the invocation that fans out one position per uploaded file. */
export const MANUAL_FILES_FIELD = 'files';

/**
 * A file carried by a manual invocation. The invocation service streams the
 * bytes into document storage (`services.document.upload`) and records the
 * resulting internal `objectUri` here. The adapter surfaces `objectUri` as the
 * file resource's owner-resolvable byte handle (its `FileRef`'s handle) — the
 * same role the email attachment `key` plays.
 */
export interface ManualFile {
  /** Internal storage handle (`services.document.upload` → `objectUri`).
   *  The owner-resolvable byte handle — surfaces as the resource id. */
  objectUri: string;
  /** Display filename, including extension. */
  filename: string;
  /** MIME content-type, e.g. `application/pdf`. */
  contentType: string;
  /** Size in bytes when known. */
  size?: number;
}

/** What a Run-now injection carries as the trigger event's payload. The
 *  superset of the actor-only manual run and the former web submission: a run
 *  may OPTIONALLY carry text and/or files. */
export interface ManualInvocationPayload {
  /** When the run was requested (ISO, UTC). */
  firedAt: string;
  /** Email of the workspace member who pressed Run now, when known —
   *  drives `@actor_*` / `@user_*` resolution. */
  actorEmail?: string;
  /** Display name of the initiating member, when known. */
  actorName?: string;
  /** Free-form text typed when running the movement (optional). */
  text?: string;
  /** Files attached when running the movement — zero or more. */
  files?: ManualFile[];
  /** A stable id for this invocation, when the invocation service mints one
   *  (carried so file/text resource ids stay stable across re-fetches). */
  submissionId?: string;
}

/**
 * Static manifest. Source-only, credential-free, no subscribable events
 * (the channel needs no registration — Run-now injects in-process). A
 * manual listener takes no config: `listen to go {} fire backfill`. An
 * invocation optionally carries text + files (accessed via `Text` field
 * and `Files` edge; the retired `#resources` bundle is gone).
 */
export const MANUAL_MANIFEST: AdapterManifest = {
  adapterType: MANUAL_ADAPTER_TYPE,
  displayName: 'Run now',
  description:
    'On-demand runs. A movement listening to a manual channel runs when ' +
    'someone presses Run now — optionally with text and/or files. Backfills, ' +
    'one-off jobs, direct submissions. Built in; nothing to connect.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated',
    'getActorCandidates', 'extractActor', 'resolveFileRef',
  ],
  // `web`/`WEB` are the legacy slugs of the now-folded web adapter; they alias
  // here so stored web-trigger rows resolve to manual at runtime.
  triggerKinds: ['web', 'WEB'],
  triggerExpectation:
    'Fires only when someone explicitly runs the movement — the Run button, ' +
    'a chat submission, or an API/agent call — optionally carrying text and ' +
    'files. Nothing fires on its own; do not present a manual channel as ' +
    'automatic capture.',
  handbookSection: MANUAL_HANDBOOK_SECTION,
  vocabulary: {
    // A built-in owns no brand, but it still owns a MARK: a card that names a
    // source and shows nothing beside it reads as a source we failed to
    // identify. So this is a glyph rather than a logo — drawn as a stroke, the
    // way the rest of the product draws its icons — and it says the one thing
    // this channel is: someone presses it.
    icon: {
      d: 'M7 4.5 L19 12 L7 19.5 Z',
      fill: false,
    },
    eventPhrase: {
      // Covers the `web`/`WEB` legacy-slug alias only — the former switch's
      // WEB_QUESTION/CHROME_EXTENSION/API cases have no owning adapter (they
      // are pre-translation-graph pipeline-input kinds, not adapters) and
      // fall through to the renderer core's generic fallback instead.
      default: [{ template: 'When data is submitted directly to Listen-Fire' }],
    },
  },
};

export class ManualAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = MANUAL_ADAPTER_TYPE;
  readonly supportedTriggers = MANUAL_MANIFEST.supportedTriggers;
  /** Unstable invocation positions resolve to the invocation type. */
  readonly webhookEventTypeId = MANUAL_INVOCATION_TYPE_ID;

  // teamId is accepted for parity with other adapters; manual has no
  // per-team configuration.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly teamId: TeamId) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    // The natural names (`Invocation` / `File`, TitleCase) are the currency
    // authors, the checker, and the hover use; the internal `invocation` /
    // `file` typeIds live only in this adapter's private cache. They no longer
    // need to be identical: the event edge keys its seed by the natural node
    // NAME (the address, layer 8), fanned file positions carry the natural
    // name (THE ONE RULE, base.ts), and describe accepts either spelling — so
    // reads resolve through the resolver whichever way a position is stamped.
    return [
      {
        typeId: MANUAL_INVOCATION_TYPE_ID,
        displayName: MANUAL_INVOCATION_DISPLAY_NAME,
        writable: false,
        // Nothing enumerates Run-now presses — one is DELIVERED to the fired
        // movement. `readable: true` was the encoding's forced lie; the event
        // edge marker is what the honest spelling was blocked on. No
        // change-kind axis, so no `action` field.
        readable: false,
        fires: true,
      },
      {
        typeId: MANUAL_FILE_TYPE_ID,
        displayName: MANUAL_FILE_DISPLAY_NAME,
        writable: false,
        // A supplied file is reached ONLY via the invocation's `Files` edge —
        // the same child-type honesty as every category-1 sweep entry: the
        // position survives via reachability; the phantom root read dies.
        readable: false,
      },
    ];
  }

  /**
   * The root: a way to be run, and the invocation that arrives when someone
   * runs it. Note that `File` is NOT here — a supplied file is reached only
   * along the invocation's `Files` edge, so the walk arrives at it one hop in
   * and never advertises a root read that could not work.
   */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Run',
    description:
      'Running this automation by hand. Nothing here can be listed — there is ' +
      'no history to browse; the one way in is somebody pressing Run, which ' +
      'delivers the invocation whole.',
    fields: [],
    references: [
      {
        fieldId: MANUAL_INVOCATION_TYPE_ID,
        targetTypeId: MANUAL_INVOCATION_TYPE_ID,
        cardinality: 'one',
        direction: 'outgoing',
        name: MANUAL_INVOCATION_DISPLAY_NAME,
        fires: true,
        readable: false,
        description: 'Somebody running the automation — what a listen delivers.',
      },
    ],
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: MANUAL_ADAPTER_TYPE,
      at: position,
      root: ManualAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (typeId === MANUAL_INVOCATION_TYPE_ID) {
      return {
        typeId: MANUAL_INVOCATION_TYPE_ID,
        displayName: MANUAL_INVOCATION_DISPLAY_NAME,
        description: 'One Run-now press — when, by whom, and any text or files supplied.',
        fields: [
          { fieldId: 'firedAt', displayName: 'Fired at', kind: 'date', writable: false, required: true, description: 'When the run was requested (UTC).' },
          { fieldId: 'actorEmail', displayName: 'Run by (email)', kind: 'string', writable: false, required: false, description: 'Email of the member who pressed Run now, when known.' },
          { fieldId: 'actorName', displayName: 'Run by (name)', kind: 'string', writable: false, required: false, description: 'Name of the member who pressed Run now, when known.' },
          { fieldId: 'text', displayName: 'Text', kind: 'string', writable: false, required: false, description: 'Text supplied when running the movement (optional).' },
          // `content` is a friendly alias for the text — authors who want
          // "the body" regardless of how the run was triggered use this.
          { fieldId: 'content', displayName: 'Content', kind: 'string', writable: false, required: false, description: 'The supplied text. An alias for "Text".' },
        ],
        references: [
          {
            fieldId: MANUAL_FILES_FIELD,
            targetTypeId: MANUAL_FILE_TYPE_ID,
            cardinality: 'many',
            direction: 'outgoing',
            name: 'Files',
            // Read-only: the files came with the run request; nothing is
            // ever created along this edge.
            writable: false,
            description: 'Files supplied when running the movement (zero or more).',
          },
        ],
      };
    }
    if (typeId === MANUAL_FILE_TYPE_ID) {
      return {
        typeId: MANUAL_FILE_TYPE_ID,
        displayName: MANUAL_FILE_DISPLAY_NAME,
        fields: [
          { fieldId: 'name', displayName: 'Name', kind: 'string', writable: false, required: true },
          { fieldId: 'contentType', displayName: 'Content Type', kind: 'string', writable: false, required: true },
          { fieldId: 'size', displayName: 'Size', kind: 'number', writable: false, required: false },
          // `data` is the binary handle — the File primitive per
          // resources_currency.md, matching the email/whatsapp attachment's
          // File field so File-typed expressions route into File-typed targets.
          { fieldId: 'data', displayName: 'File', kind: 'file', writable: false, required: false },
        ],
        references: [],
      };
    }
    return null;
  }

  async getFieldValue(input: { position: SourcePosition; fieldId: string }): Promise<unknown> {
    if (input.position.adapterType !== MANUAL_ADAPTER_TYPE) {
      throw new Error(
        `ManualAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    // The program names the field by its NATURAL displayName ('Fired at',
    // 'Run by (email)', 'Text', 'Content'); the payload is keyed by the internal
    // field id. Resolve natural→internal against the position's natural type on
    // the first line (Decision #3). The dispatch layer seeds a typeless
    // invocation (`recordType: null`); treat that as the invocation type.
    const typeId = await this.resolveTypeRef(input.position.recordType ?? MANUAL_INVOCATION_TYPE_ID);
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);

    if (typeId === MANUAL_FILE_TYPE_ID) {
      const file = (positionData(input.position) ?? {}) as Partial<ManualFile>;
      // `name` is a friendly alias for `filename`.
      if (fieldId === 'name') return file.filename ?? null;
      // The `File` (`data`) field is the binary primitive — a `FileRef`
      // descriptor, the same FileRef the retired input-side `_resources`
      // bundle built. This is what
      // `go-[:Files]->.\`File\`` evaluates so file bytes reach extraction /
      // carry-forward; the owner redeems the handle in `resolveFileRef`.
      if (fieldId === 'data') return manualFileRef(file);
      return (file as Record<string, unknown>)[fieldId] ?? null;
    }

    const payload = (positionData(input.position) ?? {}) as Partial<ManualInvocationPayload>;
    // `content` is a friendly alias for the supplied text.
    if (fieldId === 'content') return payload.text ?? '';
    return (payload as Record<string, unknown>)[fieldId] ?? null;
  }

  // ── Reference traversal (files) ──────────────────────────────────────────
  // The `-[:Files]->` domain edge yields file-typed positions (the navigable
  // file nodes). The source content that fed an extraction is reached
  // explicitly off the extracted node (`extractedNode-[:_resources]->`), not
  // off the input position — input is read by hand (`go.\`Text\``, the files
  // edge).

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== MANUAL_ADAPTER_TYPE) {
      throw new Error(
        `ManualAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The `Files` edge — resolve the NATURAL edge name to this adapter's read
    // currency. The invocation seeds typeless (`recordType: null`); treat that
    // as the invocation type so a typeless seed still fans its files out.
    const edgeId = await this.resolveEdgeReadId(
      input.position.recordType ?? MANUAL_INVOCATION_TYPE_ID,
      input.fieldId,
    );
    if (edgeId === MANUAL_FILES_FIELD) {
      const payload = (positionData(input.position) ?? {}) as Partial<ManualInvocationPayload>;
      return (payload.files ?? []).map((file) => ({
        position: makeUnstablePosition({
          adapterType: MANUAL_ADAPTER_TYPE,
          // A fanned position carries the NATURAL type name (THE ONE RULE,
          // base.ts) so its field reads resolve through the resolver.
          recordType: MANUAL_FILE_DISPLAY_NAME,
          data: file,
        }),
      }));
    }

    return [];
  }

  // ── Actor parsing — the initiating member feeds @user_* / @actor_* ──

  async getActorCandidates(input: { event: TriggerEvent }): Promise<ActorCandidate[]> {
    const payload = (input.event.payload ?? {}) as Partial<ManualInvocationPayload>;
    const email = payload.actorEmail?.trim().toLowerCase();
    if (!email || !email.includes('@')) return [];
    return [
      {
        identity: { identifier: email, scheme: 'email', adapterType: this.adapterType, email },
        source: 'originator',
      },
    ];
  }

  async extractActor(input: { event: TriggerEvent }): Promise<ActorIdentity | null> {
    const payload = (input.event.payload ?? {}) as Partial<ManualInvocationPayload>;
    const email = payload.actorEmail?.trim().toLowerCase();
    if (!email || !email.includes('@')) return null;
    return {
      identifier: email,
      scheme: 'email',
      adapterType: this.adapterType,
      email,
      name: payload.actorName ?? undefined,
      label: payload.actorName ?? email,
    };
  }

  // ── Byte resolution (owner-side) ─────────────────────────────────────────
  // Manual OWNS the FILE resources it emits: the host redeems their handle
  // here. The handle is the file's storage `objectUri`
  // — the value the invocation service got back from `services.document.upload`.
  //
  // owners serve bytes
  async resolveFileRef(input: { ref: FileRef }): Promise<ResolveFileRefResult> {
    const handle = fileHandle(input.ref);
    if (!handle) {
      throw new Error(
        `${MANUAL_ADAPTER_TYPE}.resolveFileRef: FileRef has no source handle to resolve.`,
      );
    }
    const stream = await services.document.getFileNodeStream({ objectUri: handle });
    return {
      stream,
      contentType: stream.contentType ?? input.ref.contentType,
      size: stream.size ?? input.ref.size,
    };
  }
}

/**
 * The `File` primitive for a manual upload — a `FileRef` descriptor whose
 * handle is the file's storage `objectUri`, redeemed through the owner
 * (`resolveFileRef`). Returns null when the file row carries no storage
 * handle.
 */
function manualFileRef(file: Partial<ManualFile>): FileRef | null {
  if (!file.objectUri || !file.filename) return null;
  const objectUri = file.objectUri;
  return {
    __brand: 'FileRef',
    name: file.filename,
    contentType: file.contentType,
    size: file.size,
    source: ownedFileSource({ adapterType: MANUAL_ADAPTER_TYPE, handle: objectUri }),
  };
}

/** Factory matching the registry's AdapterFactory signature. */
export function createManualAdapter(input: { teamId: TeamId }): ManualAdapter {
  return new ManualAdapter(input.teamId);
}
