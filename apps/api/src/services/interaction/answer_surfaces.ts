// The answer SURFACES — the shared view projection + the agent's MCP answer
// path for the ask ADAPTER's records. The link page's own token verification
// lives in the router (interfaces/rest/asks.ts) on the new store directly; this
// module supplies the family→view projection those surfaces render, and the
// MCP `answerForTeam` door that resolves an ask the calling team owns through
// the ONE answer door (the same transition the link page + Slack buttons drive).

import type { AskId } from '../../generated/kysely/asks/Ask';
import type { TeamId } from '../../generated/kysely/core/Team';

import { getAsk as getNewStoreAsk, listAsksForTeam as listNewStoreAsks, type AskRecord } from '../translation_graph/adapters/ask/store';
import { getAutomationsQb, getQb } from '../../lib/kysely';
import { answerAskById } from '../translation_graph/adapters/ask/answer_door';
import {
  askInteractionType,
  askViewOptions,
  askViewCorrect,
  askResultType,
} from '../translation_graph/adapters/ask/surface_view';

/** The result of resolving an answer through the ONE answer door — the ask id
 *  (as the surfaces' request handle), the run (if any) that was awaiting, and
 *  the recorded answer. */
export interface AnswerResult {
  requestId: AskId;
  runId: string;
  answer: unknown;
}

/** The interaction constructors whose answer is a value the author/system can
 *  enumerate ahead of time — so a `?answer=` query param IS a complete answer
 *  (3d's table: decisional + awareness types). Anything constructive
 *  (`Provide` freeform, `Select`, `Correct`, `Draft`) must open a UI and is NOT
 *  resolvable by a bare param; those return `paramResolvable: false`. */
const PARAM_RESOLVABLE = new Set(['check', 'choose', 'pick', 'review', 'notify']);

export function isParamResolvable(interactionType: string): boolean {
  return PARAM_RESOLVABLE.has(interactionType.toLowerCase());
}

/** The constructive interaction types the web `/a/<token>` page renders with a
 *  rich control (chunk 6b: `Provide` typed input, `Select` checklist; chunk 6c:
 *  `Correct` editable table; asks-as-adapter fast-follow: `Form`'s named-field
 *  control). `Draft` has a clear placeholder until a later chunk. The
 *  decisional / awareness types are param-resolvable and ALSO render here (the
 *  universal fallback surface). */
const RICH_RENDERABLE = new Set(['provide', 'select', 'correct', 'form']);

export function isRichRenderable(interactionType: string): boolean {
  return RICH_RENDERABLE.has(interactionType.toLowerCase());
}

/** The view of an ask that a surface renders / acts on. */
export interface AskView {
  requestId: AskId;
  teamId: TeamId;
  interactionType: string;
  resultType: { graph: string; position?: string };
  args: Record<string, unknown>;
  status: string;
  /** Whether a `?answer=` param can fully resolve this ask (vs. needing a UI). */
  paramResolvable: boolean;
  /** Whether the web universal renderer has a rich control for this type
   *  (Provide / Select). Drives the bare-link redirect to `/a/<token>`. */
  richRenderable: boolean;
}

/** What was answered on a closed ask — carried on a terminal lookup so the
 *  link page can show the recorded answer instead of a dead end. */
export interface RecordedAnswer {
  interactionType: string;
  answer: unknown;
}

/** One record of a `Correct` ask, as the web editable table renders + submits
 *  it. `ephemeralId` is the interaction-scoped row id the answer references;
 *  `fields` is the record's editable columns → current values (jargon-free: a
 *  record with editable fields). */
export interface AskCorrectRow {
  ephemeralId: string;
  fields: Record<string, unknown>;
  /** A human label for the row (a `name`/`label`/`title` field if present),
   *  shown as the row's heading — display only. */
  label: string;
}

/** A `Correct` ask's editable graph, as the web table renders it: the editable
 *  column names (the union of the rows' field keys, in first-seen order) and the
 *  rows. */
export interface AskCorrect {
  columns: string[];
  rows: AskCorrectRow[];
}

/** One option of a `Select` ask, as the web checklist renders + submits it.
 *  `id` is a stable ephemeral identifier within this ask; `label` is the
 *  human-facing text; `value` is the durable answer payload the chosen subset
 *  binds as the ask's result `r` on resume. */
export interface AskOption {
  id: string;
  label: string;
  value: unknown;
}

/** The ask detail the web `/a/<token>` page renders. Jargon-free, UI-shaped: the
 *  question (`title`), optional `detail`, the interaction kind that selects the
 *  control, the result type that types a `Provide` input, and the `options` a
 *  `Select` checklist offers. */
export interface AskDetail {
  interactionType: string;
  resultType: { graph: string; position?: string };
  title: string;
  detail?: string;
  /** `Select` only — the offered options as a checklist. */
  options?: AskOption[];
  /** `Correct` only — the records to review as an editable table. */
  correct?: AskCorrect;
  /** Whether the web page can render a rich control for this type (Provide /
   *  Select / Correct). Draft falls back to a placeholder. */
  richRenderable: boolean;
  paramResolvable: boolean;
}

/** Pull the offered options out of an ask's stored `args` (the park sink
 *  serialised them as `[{ id, label, value }]` under `options`, §5 storage —
 *  "serialized options (ephemeral node ids)"). Tolerant: an args shape without a
 *  well-formed options array yields no options (the page renders an empty-set
 *  notice rather than crashing). */
export function readAskOptions(args: Record<string, unknown>): AskOption[] | undefined {
  const raw = args.options;
  if (!Array.isArray(raw)) return undefined;
  const options: AskOption[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string') continue;
    options.push({
      id: rec.id,
      label: typeof rec.label === 'string' ? rec.label : rec.id,
      value: 'value' in rec ? rec.value : rec.id,
    });
  }
  return options;
}

/** Pull the materialised `Correct` graph out of an ask's stored `args` (the park
 *  sink serialised it under `correct` as `{ type, rows: [{ ephemeralId, fields
 *  }] }`). Derives the editable columns from the union of the rows' field keys
 *  (first-seen order) and a display label per row. Tolerant: a malformed shape
 *  yields no graph (the page renders an empty-set notice). */
export function readAskCorrect(args: Record<string, unknown>): AskCorrect | undefined {
  const raw = args.correct;
  if (raw === null || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.rows)) return undefined;
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: AskCorrectRow[] = [];
  for (const item of rec.rows) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.ephemeralId !== 'string') continue;
    const fields = r.fields !== null && typeof r.fields === 'object' ? (r.fields as Record<string, unknown>) : {};
    for (const key of Object.keys(fields)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
    rows.push({ ephemeralId: r.ephemeralId, fields, label: correctRowLabel(fields) });
  }
  return { columns, rows };
}

/** A human-facing heading for a Correct row — a `name`/`label`/`title` field if
 *  present, else the first non-empty field value, else empty. */
function correctRowLabel(fields: Record<string, unknown>): string {
  for (const key of ['name', 'Name', 'label', 'Label', 'title', 'Title']) {
    const v = fields[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  for (const v of Object.values(fields)) {
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number') return String(v);
  }
  return '';
}

/** Project a verified open ask into the web detail shape. */
export function toAskDetail(ask: AskView): AskDetail {
  const title =
    typeof ask.args.title === 'string' && ask.args.title.trim() !== ''
      ? ask.args.title
      : 'A response is needed';
  const detail = typeof ask.args.detail === 'string' ? ask.args.detail : undefined;
  const kind = ask.interactionType.toLowerCase();
  const options = kind === 'select' ? readAskOptions(ask.args) : undefined;
  const correct = kind === 'correct' ? readAskCorrect(ask.args) : undefined;
  return {
    interactionType: ask.interactionType,
    resultType: ask.resultType,
    title,
    ...(detail !== undefined ? { detail } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(correct !== undefined ? { correct } : {}),
    richRenderable: isRichRenderable(ask.interactionType),
    paramResolvable: ask.paramResolvable,
  };
}

/**
 * The MCP / agent path: answer an ask the calling team owns (no token — authed
 * by the MCP session). Resolves through the ONE answer door (the same transition
 * the link page and Slack buttons drive), which validates team ownership + the
 * answer against the family before flipping the record `answered`.
 */
export async function answerForTeam(input: {
  teamId: TeamId;
  requestId: AskId;
  answer: unknown;
}): Promise<
  | { ok: true; result: AnswerResult }
  | { ok: false; reason: 'not_found' | 'already_resolved' | 'invalid'; message?: string }
> {
  const newAsk = await getNewStoreAsk(input.requestId as unknown as AskId);
  if (!newAsk) return { ok: false, reason: 'not_found' };
  if (newAsk.teamId !== input.teamId) return { ok: false, reason: 'not_found' };
  const outcome = await answerAskById(newAsk.id, input.answer);
  switch (outcome.kind) {
    case 'answered':
      return {
        ok: true,
        result: {
          requestId: outcome.ask.id as unknown as AskId,
          runId: (await awaitingRunIdForAsk(outcome.ask.id)) ?? '',
          answer: outcome.ask.answer,
        },
      };
    case 'closed':
      return { ok: false, reason: 'already_resolved' };
    case 'invalid':
      return { ok: false, reason: 'invalid', message: outcome.message };
    case 'not_found':
    case 'not_ours':
      return { ok: false, reason: 'not_found' };
  }
}

/** The open asks for a team — the agent's poll-discovery surface (the agent
 *  never uses a link; it polls its job's open asks and answers structurally).
 *  The ask adapter's open records only (the legacy store is gone). */
export async function listOpenAsksForTeam(teamId: TeamId): Promise<AskView[]> {
  return (await listNewStoreAsks(teamId))
    .filter((a) => a.state === 'open')
    .map(newStoreAskToView);
}

/** Project a new-store ask record into the shared `AskView` the surfaces
 *  consume. The ask id stands in for the legacy `requestId` (both are the
 *  handle a surface answers against — see `answerForTeam`, which routes a
 *  new-store id to its door). */
function newStoreAskToView(ask: AskRecord): AskView {
  const interactionType = askInteractionType(ask);
  const options = askViewOptions(ask);
  const correct = askViewCorrect(ask);
  return {
    requestId: ask.id as unknown as AskId,
    teamId: ask.teamId,
    interactionType,
    resultType: askResultType(ask),
    args: {
      title: ask.prompt,
      ...(ask.detail != null ? { detail: ask.detail } : {}),
      ...(options !== undefined ? { options } : {}),
      ...(correct !== undefined ? { correct } : {}),
    },
    status: 'open',
    paramResolvable: isParamResolvable(interactionType),
    richRenderable: isRichRenderable(interactionType),
  };
}

/** The run (if any) currently parked on a new-store ask's Response edge — the
 *  correlation map keyed on the ask id. Null when no run is waiting (the ask's
 *  afterlife — an answer still lands as data). */
async function awaitingRunIdForAsk(askId: AskId): Promise<string | null> {
  const row = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', 'ask')
    .where('correlation_key', '=', askId as unknown as string)
    .select('run_id')
    .executeTakeFirst();
  return row ? (row.run_id as unknown as string) : null;
}

