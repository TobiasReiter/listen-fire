/**
 * Agent running-state compaction (M3).
 *
 * On every turn entry — before the agent's LLM call — Haiku rolls a
 * single "running state" paragraph forward across the messages +
 * persisted thoughts that landed since the last compaction. The
 * paragraph is stored on `agent_conversation.metadata.runningState` and
 * the Setup agent's system prompt injects it above the static body so
 * the model always has a tight summary of "where the conversation is
 * and what's been decided".
 *
 * Cursor: `agent_conversation.metadata.compactedThrough` is the id of
 * the last `agent_message` folded into the running state. The next
 * compaction only feeds Haiku messages newer than the cursor.
 *
 * The brief mandates `≥2 prior assistant turns since the last
 * compaction` before calling Haiku — that gate avoids no-op
 * compactions on the very first reply (and on resume turns where
 * nothing actionable accumulated). When the gate fails, the running
 * state is left as-is for this turn (whatever it was).
 *
 * Per-agent opt-in lives on `AgentConfig.enableRunningState` (see
 * `agent_registry.ts`). Setup ships with it on; other agents are off
 * by default.
 *
 */

import type { MessageThoughts } from '../lib/knowledge/agent_types';

import { anthropicChat } from '../lib/anthropic';
import { currentContext } from './context';
import { logger } from 'movement-engine/public/log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Compaction-state slot on `agent_conversation.metadata`. Lives alongside
 * any other per-conversation metadata; readers ignore unknown keys.
 */
export interface ConversationCompactionState {
  runningState?: string | null;
  compactedThrough?: string | null;
}

/**
 * Public read shape returned by `loadRunningState`. The orchestrator /
 * agent runner reads this to decide whether to inject the augmentation
 * block above the static prompt.
 */
export interface RunningStateSnapshot {
  runningState: string | null;
  compactedThrough: string | null;
}

interface CompactMessageRow {
  id: string;
  role: string;
  content: string;
  messageType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Haiku model id for the running-state compaction call. Pinned per
 * CLAUDE.md; if the model's output drifts, escalate to Sonnet rather
 * than swapping the id silently.
 *
 */
export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

/**
 * M4: sliding-window architecture. The recent window holds the last K
 * turns verbatim (with full thinking + tool-call trace) in the messages
 * array; everything older than that gets folded into the rolling
 * `runningState` paragraph by Haiku.
 *
 * A "turn" here = one persisted assistant message (tombstones don't
 * count). Compaction fires when there is at least one assistant turn
 * that has aged OUT of the recent window since the last compaction —
 * concretely: when `assistants.length >= K + 1` AND the (K+1)th-from-
 * last assistant id is past the cursor.
 *
 * Practical effect vs. M3:
 *   - M3 fired on every turn once it had ≥2 new assistants since
 *     cursor → Haiku ran roughly every turn after the first three.
 *   - M4 fires only when an OLD turn has aged out of the K-window →
 *     Haiku runs roughly every Kth turn, the cacheable `[system +
 *     runningState]` prefix stays stable in between, and the recent
 *     window rides in the messages array verbatim.
 *
 * K=5 matches the brief. Bump downward (not up) if a single turn ever
 * produces an enormous tool-call payload that pushes total context past
 * the soft guardrail.
 *
 */
export const RECENT_WINDOW_K = 5;

/**
 * Token-budget gate for folding (M4, revised). We let the verbatim window
 * accumulate up to TRIGGER before compacting, then fold the oldest aged-out
 * turns into the summary until the window is back under TARGET. Opus's 1M
 * window is what makes a 500K ceiling safe — it keeps far more recent context
 * verbatim than the old fixed 5-turn batch did, so the setup agent stops
 * "forgetting" details a handful of turns in. Mirrors the in-run tool-loop
 * compaction thresholds (lib/anthropic) so both layers reason at the same scale.
 */
export const COMPACT_TRIGGER_TOKENS = 500_000;
export const COMPACT_TARGET_TOKENS = 200_000;

/**
 * Soft token-budget guardrail. When the estimated total prefix +
 * recent-window tokens cross this line, log a warning so we notice
 * before context rot kicks in. No truncation — informational only.
 */
export const TOKEN_BUDGET_WARN_THRESHOLD = 50_000;

// ---------------------------------------------------------------------------
// Prompt
//
// Verbatim from the M3 brief — do not redesign the prompt body without
// escalation. The agent persona (`setup agent helping a user wire up a
// sync between their email inbox and their CRM`) is hard-coded to Setup
// because Setup is the only agent with `enableRunningState: true` in
// this chunk. When future agents opt in, parameterise the persona line
// from the agent config rather than fork the prompt.
//
// ---------------------------------------------------------------------------

const COMPACTION_PROMPT_HEADER =
  `You are maintaining a running summary of an ongoing conversation ` +
  `between a setup agent and a user. The setup agent helps a user wire ` +
  `up a sync between their email inbox and their CRM.

Below is the current running state (may be empty) and the new ` +
  `conversation turns since it was last updated. Update the running ` +
  `state to incorporate the new turns.

Rules:
- Preserve any decided values verbatim — names, emails, field choices, owner assignments.
- Preserve any in-progress proposals the user has been asked to confirm but hasn't yet.
- Preserve any explicit user preferences ("default Deal owner to me", "skip the model talk").
- If a value isn't already in the conversation, don't invent it.
- One paragraph. ~150 words max.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current running-state snapshot for a conversation. Returns
 * `{ runningState: null, compactedThrough: null }` for conversations
 * that have never been compacted (the orchestrator skips the
 * augmentation block in that case).
 */
export async function loadRunningState(
  conversationId: string,
): Promise<RunningStateSnapshot> {
  const ctx = currentContext();
  const prisma = ctx.prisma;
  const row = await prisma.agentConversation.findFirst({
    where: { id: conversationId, teamId: ctx.user.teamId },
    select: { metadata: true },
  });
  if (!row) return { runningState: null, compactedThrough: null };
  return readSnapshotFromMetadata(row.metadata as Record<string, unknown> | null);
}

/**
 * Compact-if-due entry point. Called by the orchestrator before each
 * agent turn for agents whose registry config has `enableRunningState:
 * true`.
 *
 * M4 gate: runs Haiku when at least one assistant turn has aged OUT of
 * the recent K-window since the last compaction. Concretely, the
 * (K+1)th-from-last persisted assistant message must (a) exist and
 * (b) be newer than the cursor. The cursor then advances to that
 * (K+1)th-from-last id — everything older has now been folded into the
 * paragraph; everything from there to the latest assistant is the
 * recent window that the orchestrator replays verbatim with full
 * thoughts.
 *
 * No-op (and no Haiku call) when:
 *
 *   - fewer than K+1 persisted assistant turns exist (recent window
 *     isn't full yet → nothing has aged out);
 *   - the (K+1)th-from-last assistant id is at or behind the cursor
 *     (we've already folded it in on a prior compaction);
 *   - all assistant messages are tombstones (content '', status
 *     'in_progress') — those don't count toward the window.
 *
 * Failures from Haiku (network / rate-limit / parse) are logged and
 * swallowed — the agent's main turn still proceeds with the stale
 * running state. The next turn will retry; the cursor doesn't advance
 * on failure.
 *
 * Returns the post-compaction snapshot (or the unchanged snapshot
 * when no compaction ran) so the caller can inject the running state
 * into the agent's system prompt without a second DB hit.
 *
 */
export async function compactIfDue(
  conversationId: string,
  opts?: { triggerTokens?: number; targetTokens?: number },
): Promise<RunningStateSnapshot> {
  const triggerTokens = opts?.triggerTokens ?? COMPACT_TRIGGER_TOKENS;
  const targetTokens = opts?.targetTokens ?? COMPACT_TARGET_TOKENS;
  const ctx = currentContext();
  const prisma = ctx.prisma;

  const conversation = await prisma.agentConversation.findFirst({
    where: { id: conversationId, teamId: ctx.user.teamId },
    select: {
      metadata: true,
      agentMessages: {
        select: {
          id: true,
          role: true,
          content: true,
          messageType: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!conversation) return { runningState: null, compactedThrough: null };

  const current = readSnapshotFromMetadata(
    conversation.metadata as Record<string, unknown> | null,
  );

  const messages = conversation.agentMessages as CompactMessageRow[];
  const persistedAssistants = messages.filter(
    (m) => m.role === 'assistant' && isPersistedAssistantMessage(m),
  );

  // Token-budget gate (M4, revised). Let the verbatim window accumulate until
  // it gets genuinely large (TRIGGER), then fold the OLDEST aged-out turns into
  // the summary, advancing the cursor just enough to bring the window back
  // under TARGET — "compaction by omission" of the verbatim detail, with the
  // decided facts preserved in the paragraph. The last RECENT_WINDOW_K turns
  // are never foldable: recent reasoning always rides verbatim.
  //
  // This replaces the old fixed K-turn batch gate. The batch gate still informs
  // the design intent it protected — a prompt prefix that stays stable across
  // many turns — because folding now fires only on the rare turn that crosses
  // a 500K ceiling, not every K turns.
  const newestFoldablePos = persistedAssistants.length - 1 - RECENT_WINDOW_K;
  if (newestFoldablePos < 0) {
    return current; // recent window isn't even full yet
  }

  // Cursor position within the persisted-assistant sequence; -1 when never
  // compacted (or the cursor row is gone) → everything counts as unfolded.
  const cursorPos = current.compactedThrough
    ? persistedAssistants.findIndex((m) => m.id === current.compactedThrough)
    : -1;
  if (newestFoldablePos <= cursorPos) {
    return current; // nothing new aged out since the cursor
  }

  // The verbatim window the orchestrator replays = everything since the cursor.
  // Fold only once it crosses the trigger.
  const verbatim = messagesSinceCursor(messages, current.compactedThrough);
  const windowTokens = estimateTokens(verbatim.map((m) => m.content).join('\n'));
  if (windowTokens <= triggerTokens) {
    return current; // plenty of headroom — keep accumulating verbatim
  }

  // Tokens of messages strictly after a given message id. Monotonically
  // decreases as the boundary advances, so the first boundary that gets the
  // remaining window under TARGET is the minimal fold.
  const tokensAfterId = (id: string): number => {
    const idx = messages.findIndex((m) => m.id === id);
    if (idx < 0) return windowTokens;
    let sum = 0;
    for (let i = idx + 1; i < messages.length; i++) sum += estimateTokens(messages[i].content);
    return sum;
  };

  let foldPos = cursorPos;
  for (let p = cursorPos + 1; p <= newestFoldablePos; p++) {
    foldPos = p;
    if (tokensAfterId(persistedAssistants[p].id) <= targetTokens) break;
  }
  if (foldPos <= cursorPos) {
    return current;
  }
  const nextCursor = persistedAssistants[foldPos].id;

  // Haiku sees every message between the prior cursor and the new
  // cursor (inclusive of the new cursor). The recent-K assistants
  // that ride verbatim in the messages array are intentionally NOT
  // summarised — the model sees them in full so it doesn't lose
  // recent reasoning to compression.
  const sinceCursor = messagesSinceCursor(messages, current.compactedThrough);
  const newCursorIdx = sinceCursor.findIndex((m) => m.id === nextCursor);
  const toCompact = newCursorIdx >= 0
    ? sinceCursor.slice(0, newCursorIdx + 1)
    : sinceCursor;

  const promptBody = formatTurnsForHaiku(toCompact);
  const userMessage = `CURRENT RUNNING STATE:\n${current.runningState ?? '(empty)'}\n\nNEW TURNS:\n${promptBody}\n\nUPDATED RUNNING STATE:`;

  let updated: string;
  try {
    const raw = await anthropicChat({
      system: COMPACTION_PROMPT_HEADER,
      userMessage,
      model: HAIKU_MODEL,
      maxTokens: 1024,
      label: 'agent_running_state',
      noContinue: true,
    });
    updated = (raw ?? '').trim();
    if (!updated) {
      logger.warn('[agent_running_state] Haiku returned empty running state', {
        conversationId,
      });
      return current;
    }
  } catch (err) {
    logger.warn('[agent_running_state] Haiku compaction failed', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return current;
  }

  await persistSnapshot(conversationId, {
    runningState: updated,
    compactedThrough: nextCursor,
  });

  return { runningState: updated, compactedThrough: nextCursor };
}

/**
 * Render the running-state augmentation block the Setup agent's system
 * prompt prepends above its static body. Returns the empty string when
 * `runningState` is null/empty (clean prompt on the first turn or when
 * compaction hasn't run yet). Caller is responsible for the rest of the
 * prompt assembly; this just produces the block.
 */
export function buildRunningStateBlock(runningState: string | null): string {
  if (!runningState) return '';
  return `## Where you are in this conversation\n\n${runningState}\n\n---\n\n`;
}

/**
 * M4: produce the "recent-thoughts" enrichment a message in the recent
 * window gets prepended to the visible assistant text. We use a
 * `<prior_thinking>` / `<prior_tool_calls>` markup wrapper rather than
 * native Anthropic `thinking` content blocks because:
 *
 *   1. Anthropic's API treats round-tripped `thinking` blocks as
 *      signed-by-the-server: feeding back a thinking block whose
 *      `signature` doesn't validate against the accompanying tool_use
 *      ids in the same assistant turn raises an error.
 *   2. We don't carry the original tool_use ids across turns (each
 *      turn's tool loop is internal), so reconstructing signed
 *      thinking + signed tool_use pairs from `metadata.thoughts` would
 *      require synthesising ids the original signature wasn't issued
 *      for. That's the trap path (a) hits — the right structural shape
 *      lives on a per-turn-internal basis only.
 *   3. Across conversation turns, prior assistant messages are
 *      end-of-turn (stop_reason='end_turn'); the API treats their
 *      thinking blocks as optional. Feeding the reasoning back as
 *      tagged text in the assistant's text content gives the model the
 *      recency benefit (it sees its own prior reasoning verbatim)
 *      without tripping the signature validator.
 *
 * The wrapper text is clear enough that the model recognises it as its
 * own prior reasoning. Empty when no thoughts were captured.
 *
 */
export function buildRecentThoughtsPrefix(thoughts: MessageThoughts | undefined): string {
  if (!thoughts) return '';
  const parts: string[] = [];
  if (thoughts.thinking) {
    parts.push(`<prior_thinking>\n${thoughts.thinking}\n</prior_thinking>`);
  }
  if (thoughts.toolCalls && thoughts.toolCalls.length > 0) {
    const rendered = thoughts.toolCalls
      .map((tc) => {
        const args = safeJsonRender(tc.args);
        if (tc.error) return `- ${tc.name}(${args}) → error: ${tc.error}`;
        const result = safeJsonRender(tc.result);
        return `- ${tc.name}(${args}) → ${result}`;
      })
      .join('\n');
    parts.push(`<prior_tool_calls>\n${rendered}\n</prior_tool_calls>`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('\n')}\n\n`;
}

/**
 * M4: identify the recent-window of persisted assistant messages —
 * the last K turns that should ride verbatim (with prior thoughts) in
 * the messages array. Returns a Set of `agent_message.id`s.
 *
 * Pure function over the persisted-message list so the orchestrator
 * can call it on the already-loaded conversation without another DB
 * hit. Tombstones / in-progress / non-chat rows are excluded — we
 * only window over real persisted assistant turns.
 *
 * Why a Set: the orchestrator walks the filtered chat history and
 * needs O(1) lookup per row to decide "enrich this one with thoughts
 * or leave it as plain text".
 *
 */
export function selectRecentWindowAssistantIds(
  messages: Array<{ id: string; role: string; content: string; metadata?: Record<string, unknown> | null }>,
): Set<string> {
  const persisted = messages.filter(
    (m) =>
      m.role === 'assistant' &&
      m.content !== '' &&
      ((m.metadata as Record<string, unknown> | null)?.status !== 'in_progress'),
  );
  const window = persisted.slice(-RECENT_WINDOW_K);
  return new Set(window.map((m) => m.id));
}

/**
 * M4: rough token-count estimate (chars / 4 — Anthropic's published
 * rule-of-thumb). Used only for the soft guardrail; no truncation
 * decisions ride on this number.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * M4: soft guardrail. Log a warning when the total estimated context
 * (system prompt + running state + recent-window messages) crosses
 * `TOKEN_BUDGET_WARN_THRESHOLD`. No truncation — this is purely
 * informational so we notice context-rot risk before it bites.
 *
 */
export function checkTokenBudget(params: {
  systemPrompt: string;
  runningState: string | null;
  messages: Array<{ role: string; content: string }>;
  conversationId?: string;
}): void {
  const systemTokens = estimateTokens(params.systemPrompt);
  const runningStateTokens = params.runningState ? estimateTokens(params.runningState) : 0;
  const messageTokens = params.messages.reduce(
    (acc, m) => acc + estimateTokens(m.content),
    0,
  );
  const total = systemTokens + runningStateTokens + messageTokens;
  if (total > TOKEN_BUDGET_WARN_THRESHOLD) {
    logger.warn('[agent_running_state] token-budget guardrail crossed', {
      conversationId: params.conversationId,
      estimatedTotalTokens: total,
      systemTokens,
      runningStateTokens,
      messageTokens,
      threshold: TOKEN_BUDGET_WARN_THRESHOLD,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readSnapshotFromMetadata(
  metadata: Record<string, unknown> | null,
): RunningStateSnapshot {
  const runningStateRaw = metadata?.runningState;
  const cursorRaw = metadata?.compactedThrough;
  return {
    runningState: typeof runningStateRaw === 'string' ? runningStateRaw : null,
    compactedThrough: typeof cursorRaw === 'string' ? cursorRaw : null,
  };
}

function messagesSinceCursor(
  all: CompactMessageRow[],
  cursor: string | null,
): CompactMessageRow[] {
  if (!cursor) return all;
  const idx = all.findIndex((m) => m.id === cursor);
  if (idx < 0) {
    // Cursor points at a message we can't find (deleted?). Replay
    // everything so we don't silently lose history.
    return all;
  }
  return all.slice(idx + 1);
}

/**
 * A persisted assistant message is one with non-empty content AND
 * (when present) status !== 'in_progress'. Tombstones with empty
 * content + `status: 'in_progress'` are excluded so we don't try to
 * summarise the turn currently being computed.
 */
function isPersistedAssistantMessage(m: CompactMessageRow): boolean {
  if (m.content === '') return false;
  const status = (m.metadata as Record<string, unknown> | null)?.status;
  return status !== 'in_progress';
}

function formatTurnsForHaiku(messages: CompactMessageRow[]): string {
  if (messages.length === 0) return '(no new turns)';

  const lines: string[] = [];
  for (const m of messages) {
    if (m.messageType !== 'chat') continue;
    if (m.role === 'user') {
      lines.push(`USER: ${m.content}`);
      continue;
    }
    if (m.role === 'assistant') {
      if (!isPersistedAssistantMessage(m)) continue;
      lines.push(`ASSISTANT: ${m.content}`);
      const thoughts = (m.metadata as Record<string, unknown> | null)?.thoughts as
        | MessageThoughts
        | undefined;
      if (thoughts?.thinking) {
        lines.push(`  (thinking) ${thoughts.thinking}`);
      }
      if (thoughts?.toolCalls && thoughts.toolCalls.length > 0) {
        const formatted = thoughts.toolCalls
          .map((tc) => {
            const argsRender = safeJsonRender(tc.args);
            if (tc.error) return `    - ${tc.name}(${argsRender}) → error: ${tc.error}`;
            const resultRender = safeJsonRender(tc.result);
            return `    - ${tc.name}(${argsRender}) → ${resultRender}`;
          })
          .join('\n');
        lines.push(`  (tools)\n${formatted}`);
      }
      const sketch = (m.metadata as Record<string, unknown> | null)?.sketchModel;
      if (sketch) {
        lines.push(`  (sketch) ${safeJsonRender(sketch)}`);
      }
    }
  }
  return lines.join('\n');
}

function safeJsonRender(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const s = JSON.stringify(value);
    if (s == null) return String(value);
    // Light truncation so a giant tool result doesn't dominate the
    // Haiku context. The full thoughts still live on the message rows
    // for replay/debug.
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(value);
  }
}

async function persistSnapshot(
  conversationId: string,
  snapshot: RunningStateSnapshot,
): Promise<void> {
  const ctx = currentContext();
  const prisma = ctx.prisma;
  const row = await prisma.agentConversation.findFirst({
    where: { id: conversationId, teamId: ctx.user.teamId },
    select: { metadata: true },
  });
  if (!row) return;
  const existing = (row.metadata as Record<string, unknown> | null) ?? {};
  const merged = {
    ...existing,
    runningState: snapshot.runningState,
    compactedThrough: snapshot.compactedThrough,
  };
  await prisma.agentConversation.updateMany({
    where: { id: conversationId, teamId: ctx.user.teamId },
    data: { metadata: merged as never },
  });
}
