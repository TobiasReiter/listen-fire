// The "your asks" surface's read + answer over the NEW ask store — the P10
// on-system floor for the ask adapter (3_adapter_contract §B). The control
// tower already lists the legacy `interaction_request` asks (observability.ts);
// this adds the new store's records ALONGSIDE them, so the two coexist until the
// legacy path is deleted (chunk G). Open records are answerable in place through
// the same door every other surface uses; settled records show what was decided.
//
// Copy stays jargon-free — a "question", not an "ask"/"adapter"/"record".
//
// chunk F

import { getQb, getAutomationsQb } from '../../lib/kysely';
import {
  listAsksForTeam,
  getAsk,
  type AskState,
} from '../translation_graph/adapters/ask/store';
import {
  askInteractionType,
  askViewOptions,
  askViewCorrect,
  askResultType,
  type AskViewOption,
  type AskViewCorrect,
} from '../translation_graph/adapters/ask/surface_view';
import { answerAskById } from '../translation_graph/adapters/ask/answer_door';
import { resolveAutomationName } from '../../lib/automation/naming';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { AskId } from '../../generated/kysely/asks/Ask';
import type { MovementId } from '../../generated/kysely/automations/Movement';

/** One new-store question, projected for the "your asks" surface. Field names
 *  mirror the legacy `OpenAskSummary` (question / detail / interactionType /
 *  resultType / options / correct) so the same in-place answer control renders
 *  it, plus the terminal fields a settled record shows. */
export interface AskRecordSummary {
  askId: string;
  state: AskState;
  question: string;
  detail: string | null;
  interactionType: string;
  resultType: { graph: string; position?: string };
  options: AskViewOption[] | null;
  correct: AskViewCorrect | null;
  /** The recorded answer — present once the question is answered. */
  answer: unknown;
  createdAt: Date;
  /** When a run is parked waiting on this question, its automation name — so the
   *  surface can say which workflow is waiting; null in the ask's afterlife
   *  (answerable with no run waiting, F7). */
  awaitingAutomationName: string | null;
}

/** The team's new-store questions, open ones first (newest first within each
 *  group), then recently settled. Bounded — a person-facing surface. */
export async function listAskRecordsForTeam(teamId: TeamId): Promise<AskRecordSummary[]> {
  const asks = await listAsksForTeam(teamId);
  if (asks.length === 0) return [];

  // The automation waiting on each open question, if any (the correlation map,
  // ask-keyed). One read across every listed ask.
  const openIds = asks.filter((a) => a.state === 'open').map((a) => a.id);
  const automationByAsk =
    openIds.length > 0 ? await awaitingAutomationNames(openIds) : new Map<string, string>();

  const rank: Record<AskState, number> = { open: 0, answered: 1, expired: 2 };
  return asks
    .slice()
    .sort((a, b) => rank[a.state] - rank[b.state] || b.createdAt.getTime() - a.createdAt.getTime())
    .map((ask) => ({
      askId: ask.id as unknown as string,
      state: ask.state,
      question: ask.prompt,
      detail: ask.detail,
      interactionType: askInteractionType(ask),
      resultType: askResultType(ask),
      options: askViewOptions(ask) ?? null,
      correct: askViewCorrect(ask) ?? null,
      answer: ask.answer,
      createdAt: ask.createdAt,
      awaitingAutomationName: automationByAsk.get(ask.id as unknown as string) ?? null,
    }));
}

/** Answer a new-store question on the operator's behalf — clamps team ownership,
 *  then drives the ONE door, whose settle queues the wake for any run parked on
 *  the ask. The run resumes off-request, as it does for every other door: what
 *  this surface refetches is the question itself, which is answered before the
 *  door returns. */
export async function answerAskRecordForTeam(input: {
  askId: AskId;
  answer: unknown;
  teamId: TeamId;
}): Promise<{ askId: string; state: string }> {
  const ask = await getAsk(input.askId);
  if (!ask || ask.teamId !== input.teamId) {
    throw new Error('That question could not be found.');
  }
  const outcome = await answerAskById(input.askId, input.answer);
  switch (outcome.kind) {
    case 'answered':
      return { askId: outcome.ask.id as unknown as string, state: outcome.ask.state };
    case 'closed':
      return { askId: outcome.ask.id as unknown as string, state: outcome.ask.state };
    case 'invalid':
      throw new Error(outcome.message);
    case 'not_found':
    case 'not_ours':
      throw new Error('That question could not be found.');
  }
}

/** Map each ask id (of a run-awaited open question) to the automation name of
 *  the run waiting on it — via `adapter_await` (ask-keyed) → `trigger_run` →
 *  `automations.trigger`, resolved to the real movement name where one applies
 *  (`resolveAutomationName`) rather than the trigger's raw dispatch name.
 *  Asks with no waiting run are simply absent. */
async function awaitingAutomationNames(askIds: AskId[]): Promise<Map<string, string>> {
  const corr = await getAutomationsQb(['adapter_await'])
    .selectFrom('adapter_await')
    .where('adapter_type', '=', 'ask')
    .where('correlation_key', 'in', askIds as unknown as string[])
    .select(['correlation_key', 'run_id'])
    .execute();
  if (corr.length === 0) return new Map();

  const runIds = [...new Set(corr.map((c) => c.run_id as unknown as string))];
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', 'in', runIds as never)
    .select(['id', 'trigger_id'])
    .execute();
  const triggerByRun = new Map<string, string>();
  for (const r of runs) triggerByRun.set(r.id as unknown as string, r.trigger_id);

  const triggerIds = [...new Set([...triggerByRun.values()])];
  const names = new Map<string, string>();
  if (triggerIds.length > 0) {
    const trows = await getAutomationsQb(['trigger'])
      .selectFrom('trigger')
      .where('id', 'in', triggerIds as never)
      .select(['id', 'name', 'movement_id'])
      .execute();

    const movementIds = [
      ...new Set(trows.map((t) => t.movement_id).filter((id): id is MovementId => id != null)),
    ];
    const movementNameById = movementIds.length
      ? new Map(
          (
            await getAutomationsQb(['movement'])
              .selectFrom('movement')
              .where('id', 'in', movementIds)
              .select(['id', 'name'])
              .execute()
          ).map((m) => [m.id as unknown as string, m.name]),
        )
      : new Map<string, string>();

    for (const t of trows) {
      names.set(
        t.id as unknown as string,
        resolveAutomationName(
          { name: t.name, movementId: t.movement_id as unknown as string | null },
          movementNameById,
        ),
      );
    }
  }

  const out = new Map<string, string>();
  for (const c of corr) {
    const runId = c.run_id as unknown as string;
    const triggerId = triggerByRun.get(runId);
    const name = triggerId ? names.get(triggerId) : undefined;
    if (name) out.set(c.correlation_key as unknown as string, name);
  }
  return out;
}
