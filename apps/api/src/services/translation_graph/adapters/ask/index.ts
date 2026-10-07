// The ask adapter — asks-as-adapter, layer 3B. An ORDINARY adapter that happens
// to hold the awaitable capability; its entire specialness is its record
// semantics. It replaces the old `ask` LANGUAGE STATEMENT: instead of a bespoke
// checker/interpreter path, an author constructs `ask()` like any adapter and
// writes a question along a family edge —
//
//   asks = ask()
//   write asks-[:Check]-> { Prompt: "Ship it?" }
//
// Positions = FAMILIES (`Check`, `Provide`, `Choose`, `Select`, `Review`,
// `Correct`, `Draft`, `Form`). The family fixes the answer's type (the surface
// control and the stored answer can never disagree — the founding incident,
// structurally gone). Each written record
// exposes the author's immutable fields, a readable `Url` (the ONLY delivery
// affordance — the adapter renders nothing, sends nothing), a readable `State`,
// and a write-only `Cancelled` surface (the ordinary position-write update form
// `write a { Cancelled: true }`) that freezes the record to `expired`.
//
// The `Response` edge is an ORDINARY edge that happens to be AWAITABLE: readable
// and writable SYNCHRONOUSLY, with `await` demoted to "the read that waits"
// (callback-primitive layer 3). Writing it — `write a-[:Response]-> { Answer:
// TRUE }` — is how an answer arrives from anywhere, a callback body included,
// and the answer semantics (coerce against the family, single answer,
// closed-request-wins) are enforced AT that write, in `answer_door.ts`. Reading
// it yields nothing until the request is answered. No root readability in v1
// (AGREED, ruling 2026-07-28): asks are pure one-shots, so the families are
// writable-but-not-readable — a program cannot enumerate open asks.
//
// Credential-free, team-scoped intrinsic (like `manual` / `cron`); the record
// store lives in `store.ts`.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { AskId } from '../../../../generated/kysely/asks/Ask';
import type {
  Adapter,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from '../../adapter';
import { singleParentLink, unsupportedAssociation } from '../../adapter';
import { UPDATE_NOT_FOUND } from '../not_found';
import type {
  SchemaEntryPoint,
  SchemaFieldDescriptor,
  SchemaReferenceDescriptor,
  SchemaTypeDescriptor,
  SourcePosition,
} from '../../types';
import { META_RECORD_TYPE, makeStablePosition, positionData } from '../../types';
import { BaseAdapter } from '../base';
import { uniformWalk } from '../hop';
import type {
  AwaitableCapability,
  AwaitPoint,
  AwaitResolution,
} from '../../awaitable';
import {
  ASK_FAMILIES,
  ASK_ANSWER_TYPES,
  cancelAsk,
  createAsk,
  getAsk,
  isAskAnswerType,
  isAskFamily,
  type AskAnswerType,
  type AskFamily,
  type AskProvenance,
  type AskRowSpec,
} from './store';
import { AskResponseRefused, writeAskResponse } from './answer_door';
import { ASK_ADAPTER_TYPE } from './type';

export { ASK_ADAPTER_TYPE } from './type';

/** The awaitable edge's name — literal in both `responseEdge()` and
 *  `resolveAwait`'s dispatch, so it's one constant rather than two agreeing
 *  string literals. Unlike the LANDING type (per-family, below), the edge
 *  itself is the same name on every family — `await x-[:Response]->` reads
 *  the same regardless of which family `x` is. */
const RESPONSE_EDGE_NAME = 'Response';

/** The same edge's internal reference id — what the read-side name resolver
 *  translates `Response` INTO, so `getRelated` compares against one constant
 *  rather than re-stating the descriptor's `fieldId` as a literal. */
const RESPONSE_EDGE_FIELD_ID = 'response';

/** The per-family Response type id — where a resolution along the awaitable
 *  `Response` edge lands. Each family gets its OWN type (chunk A, asks-as-
 *  adapter layer 5): the answer's real shape is the family's, so the landing
 *  type must be too — `Check Response` isn't `Choose Response`. Published so
 *  the name resolver + `describe` know each type; reached ONLY by awaiting the
 *  edge (never a root read). */
function responseTypeId(family: AskFamily): string {
  return `${family} Response`;
}

/** The inverse — which family's Response type a written/traversed type names.
 *  A COMPARISON against the eight names, never a parse of the string. */
function responseTypeFamily(typeId: string): AskFamily | undefined {
  return ASK_FAMILIES.find((family) => responseTypeId(family) === typeId);
}

/** The Response record's single field — the typed answer. ONE constant so the
 *  descriptor's `fieldId`/`displayName`, the landing dict the engine binds, and
 *  `getFieldValue`'s dispatch cannot drift: an author reads the DECLARED name
 *  (`got.Answer`) and the landing is keyed by that same name end-to-end. (The
 *  founding incident was surface-vs-store disagreement; a lowercase `answer`
 *  landing under an `Answer` descriptor was the same class of bug in miniature.) */
const RESPONSE_ANSWER_FIELD = 'Answer';

/** Field display names — the natural names an author writes. Internal ids
 *  match (the adapter routes on the family + these names directly). */
const FIELD = {
  prompt: 'Prompt',
  detail: 'Detail',
  answerType: 'Answer Type',
  options: 'Options',
  rows: 'Rows',
  fields: 'Fields',
  url: 'Url',
  state: 'State',
  cancelled: 'Cancelled',
} as const;

export const ASK_MANIFEST: AdapterManifest = {
  adapterType: ASK_ADAPTER_TYPE,
  displayName: 'Ask',
  description:
    'Ask a person a question mid-run and wait for their answer. A written ask ' +
    'yields a private link that renders the right control — approve/decline, a ' +
    'typed value, a choice, an editable table, or an acknowledgement — and ' +
    'records the answer back against the run. Built in; nothing to connect.',
  authoringHints:
    'Write a question along its family edge: `-[:Check]->` (yes/no), ' +
    '`-[:Provide]->` (a typed value — set `Answer Type` to text/number/date/' +
    'boolean), `-[:Choose]->` (exactly one of `Options`), `-[:Select]->` ' +
    '(a subset of `Options`, possibly none), `-[:Correct]->` (review/edit ' +
    '`Rows` — records the changed fields and any dropped), `-[:Draft]->` (a ' +
    'structured answer the person composes), `-[:Form]->` (several named ' +
    '`Fields` answered together as one object), `-[:Review]->` (an ' +
    'acknowledgement). Each write yields a `Url` to deliver (Slack, email, …) ' +
    '— the adapter never delivers it for you. Cancel an open ask with ' +
    '`write a { Cancelled: true }`.',
  supportedTriggers: [],
  methods: [
    'listEntryPoints', 'describe', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord',
  ],
};

// ── Field / descriptor helpers ─────────────────────────────────────────────

function commonWrittenFields(): SchemaFieldDescriptor[] {
  return [
    {
      fieldId: FIELD.prompt, displayName: FIELD.prompt, kind: 'string',
      writable: true, required: true,
      description: 'The question to put to the person (immutable once written).',
    },
    {
      fieldId: FIELD.detail, displayName: FIELD.detail, kind: 'string',
      writable: true, required: false,
      description: 'Optional elaboration shown under the question.',
    },
  ];
}

/** The fields every family's record exposes once written — the delivery link,
 *  the live state, and the write-only cancellation surface. */
function recordSurfaceFields(): SchemaFieldDescriptor[] {
  return [
    {
      fieldId: FIELD.url, displayName: FIELD.url, kind: 'string',
      writable: false, required: false,
      description: 'The private link to deliver — the only way a person answers this ask.',
    },
    {
      fieldId: FIELD.state, displayName: FIELD.state, kind: 'enum',
      writable: false, required: false, enumValues: ['open', 'answered', 'expired'],
      description: 'Where the ask sits in its lattice: open, answered, or expired.',
    },
    {
      fieldId: FIELD.cancelled, displayName: FIELD.cancelled, kind: 'boolean',
      writable: true, readable: false, required: false,
      description:
        'Write `{ Cancelled: true }` to expire an open ask. Rejected once the ask ' +
        'has settled (answered or already expired).',
    },
  ];
}

/**
 * The `Response` edge — the whole point of the ask model, and an ORDINARY edge
 * in every direction (callback-primitive layer 3):
 *
 *  - **writable**: the answer arrives as a write (`write a-[:Response]-> {
 *    Answer: TRUE }`) from anywhere movement code runs, a callback body
 *    included. Every other door is a wrapper over that same write.
 *  - **readable**: an unanswered request reads EMPTY; an answered one reads its
 *    Response record. `readable: false` used to make a bare read observably
 *    refused, which was the right call while `await` was the ONLY way in — now
 *    it would be a capability we simply declined to publish.
 *  - **awaitable**: `await` is demoted to "the read that waits" — the same edge,
 *    read with wait-until-at-least-one-exists behaviour. `resolvesEmpty` says an
 *    explicit cancel resolves awaiters EMPTY rather than parking them forever.
 *
 * Targets the FAMILY's own Response type — every family shares the edge's name
 * (`Response`) but not its landing type.
 */
function responseEdge(family: AskFamily): SchemaReferenceDescriptor {
  return {
    fieldId: RESPONSE_EDGE_FIELD_ID,
    name: RESPONSE_EDGE_NAME,
    targetTypeId: responseTypeId(family),
    cardinality: 'one',
    direction: 'outgoing',
    awaitable: true,
    // Answering an ask resumes the run that raised it, in the same request
    // (`answerAskRecordForTeam` → `resumeAwaitsForCorrelation`) — the wake is
    // delivered, so an await here needs no cadence.
    watchable: true,
    resolvesEmpty: true,
    readable: true,
    writable: true,
    // Answers are read back in the order they landed — the store appends and
    // the read hands that back (R2: an await landing is arrival-ordered).
    sequenced: 'arrival',
    ...(RESPONSE_GENERIC_OVER[family] !== undefined
      ? { genericOver: RESPONSE_GENERIC_OVER[family] }
      : {}),
    description:
      "The person's answer. Read it to see whether one has arrived yet, `await` it " +
      'to wait for one, or WRITE it to record one.',
  };
}

/**
 * The families whose answer type is decided BY THE ASK ITSELF, and the body
 * field that decides it (chunk B). `Choose`/`Select` answer within the very
 * `Options` they offered — nothing weaker is the truth — and `Provide` answers
 * the scalar its `Answer Type` names.
 *
 * The three `onNonLiteral` answers are three different facts, one per family:
 *
 *  - `Answer Type` is `'error'` because `createRecord` already refuses a
 *    non-literal (it must be one of `ASK_ANSWER_TYPES`), so a computed one fails
 *    at run time either way and the author would rather hear it now.
 *  - `Options` says NOTHING: options built from a query are a normal thing to
 *    write, and the answer is then honestly plain text — the base type was the
 *    whole promise, and it is kept.
 *  - `Fields` is `'warn'`. `Form`'s literals fix the landing's SHAPE rather than
 *    its scalar — a form declaring `["Budget","Timeline"]` answers a node
 *    carrying a `Budget` and a `Timeline` property, which needs no record
 *    FieldType (the old objection) because the structure lives on the NODE.
 *    Computed names run fine, so this is no error; but the author has just
 *    traded readable fields for one opaque object, and trading in silence is how
 *    a guarantee disappears.
 *
 * Everything else (`Check`, `Review`, `Correct`, `Draft`) has one answer type
 * per family and nothing to be generic over.
 */
const RESPONSE_GENERIC_OVER: Partial<
  Record<AskFamily, { field: string; onNonLiteral?: 'error' | 'warn' }>
> = {
  Choose: { field: FIELD.options },
  Select: { field: FIELD.options },
  Provide: { field: FIELD.answerType, onNonLiteral: 'error' },
  Form: { field: FIELD.fields, onNonLiteral: 'warn' },
};

/** Per-family extra writable fields — Provide names its answer type,
 *  Choose/Select name their options, Correct names the rows to review, Form
 *  names the fields it collects; Check, Review, and Draft add nothing. */
function familyExtraFields(family: AskFamily): SchemaFieldDescriptor[] {
  if (family === 'Provide') {
    return [{
      fieldId: FIELD.answerType, displayName: FIELD.answerType, kind: 'enum',
      writable: true, required: true, enumValues: [...ASK_ANSWER_TYPES],
      description: 'The type of value to collect: text, number, date, or boolean.',
    }];
  }
  if (family === 'Choose') {
    return [{
      fieldId: FIELD.options, displayName: FIELD.options, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The options to choose from — the answer is exactly one of these.',
    }];
  }
  if (family === 'Select') {
    return [{
      fieldId: FIELD.options, displayName: FIELD.options, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The options to choose from — the answer is the subset picked (possibly none).',
    }];
  }
  if (family === 'Correct') {
    return [{
      fieldId: FIELD.rows, displayName: FIELD.rows, kind: 'json',
      cardinality: 'many', writable: true, required: true,
      description:
        'The records to review — each a plain object of field name to current ' +
        'value. The answer reports which rows changed and which were dropped.',
    }];
  }
  if (family === 'Form') {
    return [{
      fieldId: FIELD.fields, displayName: FIELD.fields, kind: 'string',
      cardinality: 'many', writable: true, required: true,
      description: 'The named fields this form collects — the answer supplies a value for every one.',
    }];
  }
  return [];
}

const FAMILY_BLURB: Record<AskFamily, string> = {
  Check: 'A yes/no decision — the answer is a boolean.',
  Provide: 'A typed value the person supplies (text, number, date, or boolean).',
  Choose: 'One named option chosen from a supplied list.',
  Select: 'A subset of a supplied list, possibly none.',
  Review: 'An awareness prompt — the answer is an acknowledgement.',
  Correct: 'Editable records to review — the answer is which rows changed and which were dropped.',
  Draft: 'A structured artifact the person composes — the answer is the drafted shape.',
  Form: 'Several named fields answered together as one unit.',
};

function familyDescriptor(family: AskFamily): SchemaTypeDescriptor {
  return {
    typeId: family,
    displayName: family,
    description: FAMILY_BLURB[family],
    fields: [
      ...commonWrittenFields(),
      ...familyExtraFields(family),
      ...recordSurfaceFields(),
    ],
    references: [responseEdge(family)],
  };
}

/**
 * Each family's `Answer` field, straight from `coerceAnswer` (store.ts) — the
 * runtime truth this descriptor used to lie about. This is the BASE type per
 * family: what an ask of this family answers when the construction site tells
 * us nothing more. An ask that DID (literal `Options`, a literal `Answer Type`)
 * narrows it further through `askResponseDescriptorFor` below — the base is
 * what a computed-options ask honestly gets.
 */
const ASK_ANSWER_SPEC: Record<AskFamily, Pick<SchemaFieldDescriptor, 'kind' | 'cardinality'> & { description: string }> = {
  Check: {
    kind: 'boolean',
    description: '`true` if they approved, `false` if they declined.',
  },
  Choose: {
    kind: 'string',
    description:
      'The option they chose — one of the offered `Options` (typed as those exact options when the ask lists them literally).',
  },
  Select: {
    kind: 'string',
    cardinality: 'many',
    description:
      'The subset of `Options` they chose, possibly empty (typed as those exact options when the ask lists them literally).',
  },
  Review: {
    kind: 'string',
    description: "An acknowledgement (`'ack'`) — Review carries no other answer shape.",
  },
  Provide: {
    kind: 'string',
    description:
      'The value they supplied, typed by the declared `Answer Type` (text/number/date/boolean).',
  },
  Correct: {
    kind: 'json',
    description:
      '`{ rows, dropped }` — the edited rows and the ids of any they dropped, as one structured object.',
  },
  Draft: {
    kind: 'json',
    description: 'The structured artifact they composed.',
  },
  Form: {
    kind: 'json',
    description:
      'One object carrying a value for every named `Field` (when the ask lists ' +
      'its `Fields` literally, each is also a property of its own — read ' +
      '`` r.`Budget` `` rather than digging into this object).',
  },
};

/**
 * The per-family Response type — where a read, an `await` or a WRITE of the
 * Response edge lands.
 *
 * `Answer` is writable, and that one flag is the whole write side: the same
 * per-family kind the read promises is what the checker holds a write body to,
 * so `Answer: "maybe"` on a `Check` is a type error at the write for exactly the
 * reason it would be a type error at the read. `required` everywhere but
 * `Review`, whose answer IS the acknowledgement and carries no value.
 */
function responseDescriptor(family: AskFamily): SchemaTypeDescriptor {
  const typeId = responseTypeId(family);
  const answer = ASK_ANSWER_SPEC[family];
  return {
    typeId,
    displayName: typeId,
    description: `The answer to a ${family} ask — read it, await it, or write it to answer.`,
    fields: [
      {
        fieldId: RESPONSE_ANSWER_FIELD, displayName: RESPONSE_ANSWER_FIELD, kind: answer.kind,
        ...(answer.cardinality !== undefined ? { cardinality: answer.cardinality } : {}),
        writable: true, required: family !== 'Review',
        description: answer.description,
      },
    ],
    references: [],
  };
}

/** `Provide`'s `Answer Type` literal → the kind the answer actually is. The two
 *  vocabularies are separate on purpose (`text` is the author-facing word for
 *  the descriptor's `string`), so the mapping is written out rather than
 *  assumed — and being exhaustive over `AskAnswerType`, adding an answer type
 *  without deciding its kind is a compile error, not a silent `text`. */
const PROVIDE_ANSWER_KIND: Record<AskAnswerType, SchemaFieldDescriptor['kind']> = {
  text: 'string',
  number: 'number',
  date: 'date',
  boolean: 'boolean',
};

/**
 * The Response type ONE ask's own construction literals fix — the per-instance
 * narrowing of `responseDescriptor` (asks-as-adapter layer 5, chunk B).
 *
 * THE TYPE IS ITS DERIVATION: two `Choose` asks offering the same options in
 * the same order have the same response type, so this is a pure function of
 * (family, values) with no identity of its own. The host's pre-pass grafts the
 * result into a copy of the instance schema under `genericLandingKey`, and the
 * checker looks it up — nothing here reaches the runtime, which already returns
 * the right values (`coerceAnswer`) and needs no second copy of the type.
 *
 * `Choose` closes the answer door to exactly what was offered (an enum, not
 * "text that happens to be one of these"); `Select` inherits `many` from the
 * base, so the same override reads `list<enum>`. `Form` is the one that widens
 * the node rather than the scalar: one READ-ONLY text property per declared
 * field name, which is exactly the shape `coerceForm` already enforces (one
 * object, a value for every name, no more and no less, every value text). `null`
 * for a family with nothing to be generic over, or values that name nothing real
 * — the base type stands, which is the honest answer when we can't see further.
 */
export function askResponseDescriptorFor(input: {
  family: string;
  values: readonly string[];
}): SchemaTypeDescriptor | null {
  const { family, values } = input;
  if (!isAskFamily(family) || values.length === 0) return null;
  const base = responseDescriptor(family);
  const answer = base.fields.find((f) => f.fieldId === RESPONSE_ANSWER_FIELD);
  if (answer === undefined) return null;

  if (family === 'Choose' || family === 'Select') {
    return {
      ...base,
      fields: [{ ...answer, kind: 'enum', enumValues: [...values] }],
    };
  }
  if (family === 'Provide') {
    const [declared] = values;
    // A typo'd / unknown answer type is MOV_ENUM_UNKNOWN_VALUE's to report off
    // the field's own enum — synthesizing nothing here leaves the base type and
    // exactly one diagnostic.
    if (values.length !== 1 || declared === undefined || !isAskAnswerType(declared)) return null;
    return {
      ...base,
      fields: [{ ...answer, kind: PROVIDE_ANSWER_KIND[declared] }],
    };
  }
  if (family === 'Form') {
    // `Answer` STAYS — it is the whole object the runtime stores, and the only
    // field a `write a-[:Response]-> { … }` can set (`writeResponse` answers
    // through it), so removing it would make a literal-Fields form unanswerable
    // from movement code and break every existing `a.Answer` read.
    const fields = new Map<string, SchemaFieldDescriptor>([[RESPONSE_ANSWER_FIELD, answer]]);
    for (const name of values) {
      // First occurrence wins, and a field named `Answer` never displaces the
      // object itself — one name, one meaning. Values are text because that is
      // all `coerceForm` promises; typed form fields are a separate change.
      if (fields.has(name)) continue;
      fields.set(name, {
        fieldId: name, displayName: name, kind: 'string',
        writable: false, required: false,
        description: `The answer given for '${name}'.`,
      });
    }
    return { ...base, fields: [...fields.values()] };
  }
  return null;
}

export class AskAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = ASK_ADAPTER_TYPE;
  readonly supportedTriggers = ASK_MANIFEST.supportedTriggers;

  constructor(private readonly teamId: TeamId) {
    super();
  }

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      // The four families — writable positions on the root. `readable: false`:
      // no root readability in v1, so a program can write an ask but never
      // enumerate open ones (AGREED, ruling 2026-07-28).
      ...ASK_FAMILIES.map((family) => ({
        typeId: family,
        displayName: family,
        scope: 'self-configured' as const,
        writable: true,
        readable: false,
      })),
      // Each family's own Response node — reached only by awaiting its edge.
      // Published so the resolver + describe know it; no root promise.
      ...ASK_FAMILIES.map((family) => ({
        typeId: responseTypeId(family),
        displayName: responseTypeId(family),
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      })),
    ];
  }

  /** The root: the four ways to ask, each landing on its family record. */
  private static readonly ROOT: SchemaTypeDescriptor = {
    typeId: META_RECORD_TYPE,
    displayName: 'Ask',
    description:
      'Asking a person a question mid-run. Write along a family edge to raise an ' +
      'ask; there is nothing to list here — an ask is a one-shot, delivered by ' +
      'its link and answered once.',
    fields: [],
    references: ASK_FAMILIES.map((family) => ({
      fieldId: family,
      name: family,
      targetTypeId: family,
      cardinality: 'one' as const,
      direction: 'outgoing' as const,
      writable: true,
      // No enumeration of asks from the root (no root readability, v1).
      readable: false,
      description: FAMILY_BLURB[family],
    })),
  };

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: ASK_ADAPTER_TYPE,
      at: position,
      root: AskAdapter.ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    const typeId = await this.resolveTypeRef(typeRef);
    if (isAskFamily(typeId)) return familyDescriptor(typeId);
    const responseFamily = responseTypeFamily(typeId);
    if (responseFamily !== undefined) return responseDescriptor(responseFamily);
    return null;
  }

  /**
   * The READ side of the Response edge, synchronously (callback-primitive layer
   * 3). An unanswered — or cancelled — request yields NOTHING; an answered one
   * yields its Response record, the same landing `resolveAwait` hands the engine
   * when it wakes a parked run. `await` differs only in waiting for it.
   */
  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    // The natural edge name in, this adapter's own reference id out — the
    // standard traversal-read translation, so a name the descriptor doesn't
    // publish is the shared drift error rather than a bespoke one.
    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    if (edgeId !== RESPONSE_EDGE_FIELD_ID) {
      throw new Error(
        `AskAdapter.getRelated: '${input.fieldId}' is not an edge on an ask — the only one is '${RESPONSE_EDGE_NAME}'.`,
      );
    }
    if (input.direction !== 'outgoing') {
      throw new Error(
        `AskAdapter.getRelated: '${RESPONSE_EDGE_NAME}' is outgoing only — an answer is not enumerable from the other end.`,
      );
    }
    if (input.position.identity.kind !== 'stable') {
      throw new Error(
        `AskAdapter.getRelated: '${RESPONSE_EDGE_NAME}' is read off a written ask, which carries its identity; this position does not.`,
      );
    }
    const ask = await getAsk(input.position.identity.recordId as AskId);
    // Gone, still open, or cancelled — there is no answer to hand back. This is
    // the read half of `resolvesEmpty`, and the reason the landing's fields type
    // as possibly-absent.
    if (!ask || ask.state !== 'answered') return [];
    return [
      {
        position: makeStablePosition({
          adapterType: ASK_ADAPTER_TYPE,
          recordType: responseTypeId(ask.family),
          recordId: ask.id,
          data: { [RESPONSE_ANSWER_FIELD]: ask.answer },
        }),
      },
    ];
  }

  /**
   * Field reads off a written ask handle. The delivery `Url` and the writable
   * fields ride the write-result shape directly; `State` and the written fields
   * are read LIVE from the store here (so `State` reflects the current lattice
   * position, not a write-time snapshot). Falls back to the position's inline
   * data when the ask row is gone.
   */
  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== ASK_ADAPTER_TYPE) {
      throw new Error(
        `AskAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const field = input.fieldId;
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const record =
      input.position.identity.kind === 'stable'
        ? await getAsk(input.position.identity.recordId as AskId)
        : null;

    // A Form's Response carries one property per declared field — the same
    // narrowing `askResponseDescriptorFor` types, resolved here so the promise is
    // real rather than a descriptor that reads null. `Answer` remains the one
    // stored carrier (`coerceForm` guarantees a value for every declared name);
    // these are views onto it, taken BEFORE the shared switch so a form field
    // called `State` reads the answer, never the ask's lattice position.
    const positionType = input.position.recordType;
    if (
      positionType !== null &&
      responseTypeFamily(positionType) === 'Form' &&
      field !== RESPONSE_ANSWER_FIELD
    ) {
      const answered =
        record?.state === 'answered' ? record.answer : data[RESPONSE_ANSWER_FIELD];
      if (answered !== null && typeof answered === 'object' && !Array.isArray(answered)) {
        return (answered as Record<string, unknown>)[field] ?? null;
      }
      return null;
    }

    switch (field) {
      case RESPONSE_ANSWER_FIELD:
        // Read off a Response position — live from the store when the position
        // is the ask's own (a synchronous read of the edge), from the inline
        // landing when the engine bound one at a resolved `await`.
        return record?.state === 'answered' ? record.answer : (data[RESPONSE_ANSWER_FIELD] ?? null);
      case FIELD.url:
        return record?.url ?? data[FIELD.url] ?? null;
      case FIELD.state:
        return record?.state ?? data[FIELD.state] ?? null;
      case FIELD.prompt:
        return record?.prompt ?? data[FIELD.prompt] ?? null;
      case FIELD.detail:
        return record?.detail ?? data[FIELD.detail] ?? null;
      case FIELD.answerType:
        return record?.answerType ?? data[FIELD.answerType] ?? null;
      case FIELD.options:
        return record?.options ?? data[FIELD.options] ?? null;
      case FIELD.rows:
        return record?.rows ?? data[FIELD.rows] ?? null;
      case FIELD.fields:
        // Form's `Fields` rides the SAME store column as Options — a
        // different displayName over one generic "offered strings" slot.
        return record?.options ?? data[FIELD.fields] ?? null;
      default:
        return data[field] ?? null;
    }
  }

  /**
   * ANSWERING — `write a-[:Response]-> { Answer: … }` (callback-primitive layer
   * 3). Ordinary movement code, so a callback body needs nothing special; the
   * answer semantics are the store's lattice transition, reached through the one
   * `writeAskResponse` every other door also goes through.
   *
   * A refusal (closed request, unfit answer, vanished record) is a THROW,
   * because a write has no other failure channel — but a typed one carrying the
   * outcome, so a caller acks from `.outcome.kind` rather than a message match.
   */
  private async writeResponse(input: WriteInput): Promise<WriteResult> {
    const parent = singleParentLink(input);
    if (parent === undefined || parent.edgeName !== RESPONSE_EDGE_NAME) {
      throw new Error(
        `AskAdapter.createRecord(${input.recordType}): an answer is written along its own request's ` +
          "edge — `write a-[:Response]-> { Answer: … }`; there is no other way to reach one.",
      );
    }

    const outcome = await writeAskResponse({
      askId: parent.externalId as AskId,
      answer: input.fields[RESPONSE_ANSWER_FIELD],
    });
    if (outcome.kind !== 'answered') throw new AskResponseRefused(outcome);

    // The ask's OWN family names the landing — the record is the truth about
    // what was asked, not the type the write site inferred.
    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: outcome.ask.id,
      recordType: responseTypeId(outcome.ask.family),
      data: { [RESPONSE_ANSWER_FIELD]: outcome.ask.answer },
    };
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    if (responseTypeFamily(input.recordType) !== undefined) return this.writeResponse(input);
    const family = input.recordType;
    if (!isAskFamily(family)) {
      throw new Error(
        `AskAdapter.createRecord: '${family}' is not an ask family (${ASK_FAMILIES.join(', ')}).`,
      );
    }
    const fields = input.fields;
    const prompt = readString(fields[FIELD.prompt]);
    if (prompt === undefined || prompt.trim() === '') {
      throw new Error(`AskAdapter.createRecord(${family}): 'Prompt' is required.`);
    }
    const detail = readString(fields[FIELD.detail]) ?? null;

    let answerType: AskAnswerType | null = null;
    if (family === 'Provide') {
      const raw = readString(fields[FIELD.answerType]);
      if (raw === undefined || !isAskAnswerType(raw)) {
        throw new Error(
          `AskAdapter.createRecord(Provide): 'Answer Type' must be one of ${ASK_ANSWER_TYPES.join(', ')}.`,
        );
      }
      answerType = raw;
    }

    let options: string[] | null = null;
    if (family === 'Choose' || family === 'Select') {
      options = readStringList(fields[FIELD.options]);
      if (options.length === 0) {
        throw new Error(`AskAdapter.createRecord(${family}): 'Options' must list at least one choice.`);
      }
    }

    let formFields: string[] | null = null;
    if (family === 'Form') {
      formFields = readStringList(fields[FIELD.fields]);
      if (formFields.length === 0) {
        throw new Error(`AskAdapter.createRecord(Form): 'Fields' must name at least one field to collect.`);
      }
      // Form's declared field names ride the SAME store column as
      // Choose/Select's options — both are "a list of offered strings", just
      // answered differently (one chosen vs. one value per name).
      options = formFields;
    }

    let rows: AskRowSpec[] | null = null;
    if (family === 'Correct') {
      const raw = readJsonRecordList(fields[FIELD.rows]);
      if (raw.length === 0) {
        throw new Error(`AskAdapter.createRecord(Correct): 'Rows' must list at least one record to review.`);
      }
      rows = raw.map((r, i) => ({ ephemeralId: `row-${i}`, fields: r }));
    }

    const ask = await createAsk({
      teamId: this.teamId,
      family,
      prompt,
      detail,
      answerType,
      options,
      rows,
      provenance: provenanceFrom(input),
    });

    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: ask.id,
      recordType: family,
      url: ask.url,
      data: {
        [FIELD.url]: ask.url,
        [FIELD.state]: ask.state,
        [FIELD.prompt]: ask.prompt,
        [FIELD.detail]: ask.detail,
        ...(answerType !== null ? { [FIELD.answerType]: answerType } : {}),
        ...(family !== 'Form' && options !== null ? { [FIELD.options]: options } : {}),
        ...(formFields !== null ? { [FIELD.fields]: formFields } : {}),
        ...(rows !== null ? { [FIELD.rows]: rows } : {}),
      },
    };
  }

  /**
   * The cancellation surface — `write a { Cancelled: true }`. Freezes an open
   * ask to `expired`; rejects OBSERVABLY on a settled record (F17 — one
   * consistent outcome). A missing row returns the typed not-found signal so the
   * engine's bind self-heal behaves; a non-cancel update is an error (Cancelled
   * is the only writable surface after create).
   */
  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const family = input.recordType;
    if (!isAskFamily(family)) {
      throw new Error(
        `AskAdapter.updateRecord: '${family}' is not an ask family (${ASK_FAMILIES.join(', ')}).`,
      );
    }
    const cancelled = input.fields[FIELD.cancelled];
    if (cancelled !== true && cancelled !== 'true') {
      throw new Error(
        `AskAdapter.updateRecord(${family}): the only supported update is { Cancelled: true }.`,
      );
    }

    const outcome = await cancelAsk({ id: input.externalId as AskId });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') return UPDATE_NOT_FOUND;
      // Settled — reject observably.
      throw new Error(
        `AskAdapter.updateRecord(${family}): cannot cancel — this ask has already ` +
          `${outcome.ask?.state === 'answered' ? 'been answered' : 'expired'}.`,
      );
    }
    return {
      adapterType: ASK_ADAPTER_TYPE,
      externalId: outcome.ask.id,
      recordType: family,
      url: outcome.ask.url,
      data: {
        [FIELD.state]: outcome.ask.state,
        [FIELD.url]: outcome.ask.url,
      },
      // An ask is raised, never re-homed: cancelling one is the only update,
      // and it attaches nothing.
      association: unsupportedAssociation(input),
    };
  }

  /**
   * Asks are receipts, not editable records — there is deliberately no delete
   * surface (RULED). Deleting one would orphan its `adapter_await` correlation
   * (and any run still parked on its Response edge) instead of settling it; an
   * open ask that no longer belongs is cancelled (`write a { Cancelled: true }`
   * → `updateRecord`, which resolves any awaiter EMPTY), never removed. This
   * override exists only to name the reason — `BaseAdapter.deleteRecord`
   * already throws, but with the generic "not a write target" message, which
   * would read as a gap to fill rather than a closed door.
   */
  async deleteRecord(_input: DeleteInput): Promise<DeleteResult> {
    throw new Error(
      'AskAdapter.deleteRecord: ask records are receipts and cannot be deleted — cancel an ' +
        'open ask instead (write a { Cancelled: true }).',
    );
  }

  /**
   * The AWAITABLE capability (asks-as-adapter §A) — the engine consumption of
   * the `Response` edge's `awaitable`/`resolvesEmpty` flags. A pending ask
   * correlates on its own id; the state lattice IS the resolution:
   *   - open      → `pending`  (park, armed, keyed by the ask id)
   *   - answered  → `landed`   (the Response node carrying the typed answer)
   *   - expired   → `empty`    (resolvesEmpty — an explicit cancel settles the
   *                             awaiter empty immediately, F6)
   * The adapter reports what has arrived; the engine applies the await's WHERE
   * and owns the park/resume. F17 — the lattice's optimistic guards already
   * serialise cancel-vs-answer into one consistent record state.
   */
  readonly awaitable: AwaitableCapability = {
    resolveAwait: async (point: AwaitPoint): Promise<AwaitResolution> => {
      if (point.edge !== RESPONSE_EDGE_NAME) {
        // The only awaitable edge is Response; anything else is a caller bug.
        throw new Error(`AskAdapter.resolveAwait: '${point.edge}' is not an awaitable edge.`);
      }
      const ask = await getAsk(point.recordId as AskId);
      if (!ask) {
        // The ask row is gone (deleted). Nothing will ever resolve it — settle
        // empty so the awaiter completes rather than parking forever.
        return { status: 'empty' };
      }
      switch (ask.state) {
        case 'open':
          return { status: 'pending', correlationKey: ask.id };
        case 'expired':
          return { status: 'empty' };
        case 'answered':
          return {
            status: 'landed',
            correlationKey: ask.id,
            landings: [
              {
                recordId: ask.id,
                // The landing's TYPE is the ask's OWN family's Response type —
                // the engine binds this as the position's recordType, so a
                // read of `r.Answer` dispatches to the right descriptor.
                recordType: responseTypeId(ask.family),
                fields: { [RESPONSE_ANSWER_FIELD]: ask.answer },
              },
            ],
          };
      }
    },
  };
}

// ── Field-value coercion off the write body ─────────────────────────────────

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => readString(v)).filter((v): v is string => v !== undefined && v.trim() !== '');
  }
  const single = readString(value);
  return single !== undefined && single.trim() !== '' ? [single] : [];
}

/** `Correct`'s `Rows` write value — an array of plain objects (a record's
 *  field name → current value each). Non-object entries are dropped rather
 *  than rejected wholesale (tolerant of a stray null/scalar in the array). */
function readJsonRecordList(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

/** Movement / run / node ids as INFO — never identity (F16). Pulled from the
 *  write's mutation context. */
function provenanceFrom(input: WriteInput): AskProvenance {
  const source = input.mutationContext.source;
  const p: AskProvenance = {};
  if (source.translationGraphId !== undefined) p.movementId = source.translationGraphId;
  if (source.translationGraphNodeId !== undefined) p.nodeId = source.translationGraphNodeId;
  if (source.adapterType !== undefined) p.adapterType = source.adapterType;
  return p;
}

/** Factory matching the registry's AdapterFactory signature. Credential-free. */
export function createAskAdapter(input: { teamId: TeamId }): AskAdapter {
  return new AskAdapter(input.teamId);
}
