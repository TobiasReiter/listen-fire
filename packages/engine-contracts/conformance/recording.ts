// A host recording: one entry into the engine, as data — what it was handed,
// every request it made of its host in the order it made them with the answer
// each got and the requests already answered when it was made, and how it
// ended. Recorded at the segment boundary against any
// host, a recording replays against any other: an engine that is handed the
// same input and the same answers must make the same requests and end the
// same way, whatever host serves them (docs/contracts/README.md, "Conformance
// kits").

import { z } from 'zod';

import type { CatalogSnapshot } from 'movement-lang';

import type { TriggerEvent } from '../event';
import { hostMethodPaths } from '../host_families';
import type { ParkedScopeState } from '../park_state';
import type { CallbackBodyInput, ResumeInput, RunInput, SettleRaceInput } from '../run_input';
import { tenantIdSchema } from '../tenant';

/** The recording format's own version, which a reader refuses past. */
export const HOST_RECORDING_VERSION = 2;

/** JSON with every object's keys sorted and undefined members dropped: two
 *  values are the same request or the same result when these are equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) => {
    if (member === null || typeof member !== 'object' || Array.isArray(member)) return member;
    return Object.fromEntries(
      Object.entries(member)
        .filter(([, field]) => field !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The catalog, the event and a parked state are their own contracts
// (catalog-snapshot.md, park-state.md, the event schema); a recording carries
// them as they crossed and checks only that each is an object. The engine
// validates them on entry exactly as it validates any input.
const catalogSchema = z.custom<CatalogSnapshot>(
  (value) => isObject(value) && isObject(value.adapters) && isObject(value.credentials) && isObject(value.plugins),
  'a catalog snapshot',
);
const eventSchema = z.custom<TriggerEvent>(
  (value) => isObject(value) && typeof value.adapterType === 'string',
  'a trigger event',
);
const stateSchema = z.custom<ParkedScopeState>(
  (value) => isObject(value) && typeof value.address === 'string',
  'a parked scope state',
);
const languageVersionSchema = z.number().int();

const runInputSchema = z.object({
  source: z.string(),
  // Optional on the contract (absent: the current version), but a recording
  // must replay under the pin it ran with on any later release, so the
  // recorder stamps the version the entry ran under.
  languageVersion: languageVersionSchema,
  movementName: z.string().optional(),
  event: eventSchema,
  teamId: tenantIdSchema,
  firedAt: z.string().optional(),
  costCapMicrodollars: z.number().optional(),
  priorSpentMicrodollars: z.number().optional(),
  capBaselineMicrodollars: z.number().optional(),
  limitPaused: z.boolean().optional(),
  catalog: catalogSchema,
  runId: z.string().optional(),
  dryRun: z.boolean().optional(),
  suspendAt: z.array(z.string()).optional(),
  credentialIds: z.record(z.string(), z.string()).optional(),
  limits: z
    .object({
      maxSteps: z.number().optional(),
      maxTextBytes: z.number().optional(),
      maxCollectionItems: z.number().optional(),
      maxResultBytes: z.number().optional(),
    })
    .strict()
    .optional(),
  maxSegmentSeconds: z.number().optional(),
});

const resumeInputSchema = runInputSchema.extend({
  state: stateSchema,
  answer: z.unknown().optional(),
  reenter: z.boolean().optional(),
  deferRaceSettlement: z.boolean().optional(),
  parkedOnEngine: z.enum(['ts', 'rust']).optional(),
});

// Each schema names exactly its contract type's fields, so a field added to
// an entry point's input and not here fails to compile; and what it parses is
// that input, so a recording is handed to the engine as it is.
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;
export type RecordedRunInputIsTheContract = Holds<
  Exactly<keyof z.infer<typeof runInputSchema>, keyof RunInput>
>;
export type RecordedResumeInputIsTheContract = Holds<
  Exactly<keyof z.infer<typeof resumeInputSchema>, keyof ResumeInput>
>;
type Fits<A extends B, B> = A;
export type RecordedInputsFit = [
  Fits<z.infer<typeof runInputSchema>, RunInput>,
  Fits<z.infer<typeof resumeInputSchema>, ResumeInput>,
];

/** A thrown error as data: its class, the engine's code when it has one, and
 *  its message. Two failures are the same when all three are. */
export const recordedErrorSchema = z.object({
  class: z.string(),
  code: z.string().optional(),
  message: z.string(),
});

export type RecordedError = z.infer<typeof recordedErrorSchema>;

const METHODS: ReadonlySet<string> = new Set(hostMethodPaths());

const requestCommon = {
  family: z.string(),
  method: z.string(),
  args: z.unknown(),
  /** The requests (by index into `requests`) the host had already answered
   *  when this one was made, less those another of them implies: a request
   *  answered before one of these was made was answered before this one
   *  too. A replay serves this request only once it has served all of
   *  these. */
  after: z.array(z.number().int().nonnegative()),
};

const isManifestMethod = (request: { family: string; method: string }): boolean =>
  METHODS.has(`${request.family}.${request.method}`);

/** One request and what answered it: a value (absent for a method that
 *  answers nothing), or the error the host threw. `family` is a manifest
 *  family (`park.sink`), `method` one of its methods (`commitTimerPark`). */
export const recordedRequestSchema = z
  .union([
    // Strict: a looser first variant would match a thrown request and strip
    // its error.
    z.object({ ...requestCommon, error: recordedErrorSchema }).strict(),
    z.object({ ...requestCommon, answer: z.unknown().optional() }).strict(),
  ])
  .refine(isManifestMethod, 'a method of a host family on the manifest');

export type RecordedRequest = z.infer<typeof recordedRequestSchema>;

const common = {
  kit: z.literal('host'),
  version: z.literal(HOST_RECORDING_VERSION),
  /** Every method the recorded host served, by path. A family or method a
   *  host leaves out changes what the engine does (no park sink: a run that
   *  parks raises), so a replay serves exactly these. */
  methods: z.array(z.string().refine((path) => METHODS.has(path), 'a method of a host family on the manifest')),
  requests: z.array(recordedRequestSchema),
  /** The entry's result, as it crossed back. */
  result: z.unknown().optional(),
  /** Why the entry threw instead of answering. */
  failure: recordedErrorSchema.optional(),
};

/** One entry into the engine, by its entry point: `runMovement`,
 *  `resumeMovement`, `settleRaceFrame` or `fireCallbackBody`. */
export const hostRecordingSchema = z
  .discriminatedUnion('entry', [
    z.object({ ...common, entry: z.literal('run'), input: runInputSchema }),
    z.object({ ...common, entry: z.literal('resume'), input: resumeInputSchema }),
    z.object({
      ...common,
      entry: z.literal('settleRace'),
      input: resumeInputSchema.extend({ frameAddress: z.string() }),
    }),
    z.object({
      ...common,
      entry: z.literal('callbackBody'),
      input: resumeInputSchema.extend({ values: z.record(z.string(), z.unknown()), callIndex: z.number() }),
    }),
  ])
  .refine((recording) => (recording.result === undefined) !== (recording.failure === undefined), {
    message: 'a recording ends in exactly one of result and failure',
  })
  .refine(
    (recording) => recording.requests.every((request, i) => request.after.every((before) => before < i)),
    { message: "a request's `after` names only requests made before it" },
  );

export type HostRecording = z.infer<typeof hostRecordingSchema>;

export type RecordedEntry = HostRecording['entry'];

/** Each entry point's input, as its contract types it. */
export interface EntryInputs {
  run: RunInput;
  resume: ResumeInput;
  settleRace: SettleRaceInput;
  callbackBody: CallbackBodyInput;
}

/** How an entry ended: its result, or the error it threw. */
export type RecordedOutcome = { result: unknown } | { failure: RecordedError };

export function outcomeOf(recording: HostRecording): RecordedOutcome {
  return recording.failure !== undefined ? { failure: recording.failure } : { result: recording.result };
}

/** A method's path split into its manifest family and method: the family is
 *  everything before the last dot (`park.sink.recordJoin` → `park.sink`). */
export function familyAndMethod(path: string): { family: string; method: string } {
  const dot = path.lastIndexOf('.');
  if (dot < 0) throw new Error(`${path} names no family`);
  return { family: path.slice(0, dot), method: path.slice(dot + 1) };
}

export function pathOf(request: { family: string; method: string }): string {
  return `${request.family}.${request.method}`;
}
