/**
 * M3 + M4 — Haiku running-state compaction with sliding-window gate.
 *
 * What this covers:
 *   1. (M3 + M4) Given a conversation where ≥1 assistant turn has aged
 *      out of the K-window since the last compaction (i.e. ≥K+1
 *      persisted assistants), `compactIfDue` calls Haiku via
 *      `anthropicChat` with the documented prompt shape and persists
 *      the returned paragraph onto
 *      `agent_conversation.metadata.runningState`. The cursor advances
 *      to the (K+1)th-from-last assistant — the one that just aged
 *      out of the recent window.
 *   2. The cursor advance lines up with the sliding window — the next
 *      compaction only sees post-cursor messages and includes the
 *      prior running state in its prompt.
 *   3. With fewer than K+1 persisted assistants, no Haiku call; the
 *      existing snapshot is returned unchanged (the recent window
 *      hasn't filled yet, so nothing has aged out).
 *   4. Haiku failure swallowed → snapshot unchanged, cursor unmoved,
 *      runner can still proceed with stale running state.
 *   5. `buildRunningStateBlock` returns '' for null and the documented
 *      header otherwise.
 *
 * Pattern: pure-stub prisma (no DB) + jest.mock the anthropic client
 * so we can assert on the Haiku call args.
 *
 */

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede any import that pulls in the service.
// ---------------------------------------------------------------------------

const mockConversationsById = new Map<string, any>();
const mockConversationUpdates: any[] = [];
const mockAnthropicChat = jest.fn();

jest.mock('../../lib/anthropic', () => ({
  anthropicChat: (...args: unknown[]) => mockAnthropicChat(...args),
}));

const mockActingTeamId = 'team-running-state';

jest.mock('../context', () => ({
  currentContext: () => ({
    // Every conversation read here is scoped to the acting team (phase 6.2);
    // the stubs honour the condition so a row belonging to another team is
    // invisible rather than merely unasked-for.
    user: { teamId: mockActingTeamId },
    prisma: {
      agentConversation: {
        findFirst: jest.fn(
          async ({ where, select }: { where: { id: string; teamId: string }; select: any }) => {
            const row = mockConversationsById.get(where.id);
            if (!row || row.teamId !== where.teamId) return null;
            // Light project so we mirror real prisma's select shape.
            const out: any = {};
            if (select.metadata) out.metadata = row.metadata;
            if (select.agentMessages) out.agentMessages = row.agentMessages;
            return out;
          },
        ),
        updateMany: jest.fn(
          async (call: { where: { id: string; teamId: string }; data: any }) => {
            const row = mockConversationsById.get(call.where.id);
            if (!row || row.teamId !== call.where.teamId) return { count: 0 };
            mockConversationUpdates.push(call);
            row.metadata = call.data.metadata;
            return { count: 1 };
          },
        ),
      },
    },
  }),
}));

jest.mock('movement-engine/services/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import {
  compactIfDue,
  buildRunningStateBlock,
  buildRecentThoughtsPrefix,
  checkTokenBudget,
  HAIKU_MODEL,
  loadRunningState,
  RECENT_WINDOW_K,
  selectRecentWindowAssistantIds,
  TOKEN_BUDGET_WARN_THRESHOLD,
} from '../agent_running_state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SeedMessageInput {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thoughts?: { thinking?: string; toolCalls?: any[] };
  sketchModel?: any;
  status?: 'in_progress';
  createdAtMs: number;
}

function seedConversation(id: string, opts: { metadata?: any; messages?: SeedMessageInput[] } = {}) {
  mockConversationsById.set(id, {
    id,
    teamId: mockActingTeamId,
    metadata: opts.metadata ?? {},
    agentMessages: (opts.messages ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      messageType: 'chat',
      metadata: m.status === 'in_progress'
        ? { status: 'in_progress' }
        : {
            ...(m.thoughts ? { thoughts: m.thoughts } : {}),
            ...(m.sketchModel ? { sketchModel: m.sketchModel } : {}),
          },
      createdAt: new Date(m.createdAtMs),
    })),
  });
}

beforeEach(() => {
  mockConversationsById.clear();
  mockConversationUpdates.length = 0;
  mockAnthropicChat.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compactIfDue — Haiku call + persistence (M3)', () => {
  it('calls Haiku with the documented prompt shape and persists the returned paragraph', async () => {
    // K=5, batched cadence → the gate fires once a full window's worth
    // of turns (K) has aged out, i.e. at 2K=10 persisted assistants.
    // Seed 10: a1..a5 age out as a batch → cursor lands at a5 → the
    // recent 5 (a6..a10) ride verbatim in the messages array next turn.
    seedConversation('conv-1', {
      metadata: {},
      messages: [
        { id: 'u1', role: 'user', content: 'forward emails to attio', createdAtMs: 1 },
        {
          id: 'a1',
          role: 'assistant',
          content: 'OK, you want emails into Attio. Connect Attio first?',
          thoughts: { thinking: 'Reflecting before proposing.' },
          createdAtMs: 2,
        },
        { id: 'u2', role: 'user', content: 'yes', createdAtMs: 3 },
        { id: 'a2', role: 'assistant', content: 'sketching the model', createdAtMs: 4 },
        { id: 'u3', role: 'user', content: 'go', createdAtMs: 5 },
        { id: 'a3', role: 'assistant', content: 'wiring it now', createdAtMs: 6 },
        { id: 'u4', role: 'user', content: 'ok?', createdAtMs: 7 },
        { id: 'a4', role: 'assistant', content: 'almost there', createdAtMs: 8 },
        { id: 'u5', role: 'user', content: 'next', createdAtMs: 9 },
        { id: 'a5', role: 'assistant', content: 'fields sketched', createdAtMs: 10 },
        { id: 'u6', role: 'user', content: 'cool', createdAtMs: 11 },
        { id: 'a6', role: 'assistant', content: 'walking the deal fields', createdAtMs: 12 },
        { id: 'u7', role: 'user', content: 'fine', createdAtMs: 13 },
        { id: 'a7', role: 'assistant', content: 'who owns new deals?', createdAtMs: 14 },
        { id: 'u8', role: 'user', content: 'default owner is ada@example.com', createdAtMs: 15 },
        {
          id: 'a8',
          role: 'assistant',
          content: 'Got it — default Deal owner is ada@example.com.',
          thoughts: {
            thinking: 'Restating the decided owner.',
            toolCalls: [{ name: 'connectIntegration', args: { adapterType: 'attio' }, result: { ok: true } }],
          },
          createdAtMs: 16,
        },
        { id: 'u9', role: 'user', content: 'looks right', createdAtMs: 17 },
        { id: 'a9', role: 'assistant', content: 'preview ready', createdAtMs: 18 },
        { id: 'u10', role: 'user', content: 'ship it', createdAtMs: 19 },
        { id: 'a10', role: 'assistant', content: 'activated', createdAtMs: 20 },
      ],
    });

    mockAnthropicChat.mockResolvedValue('Customer wants emails into Attio; default Deal owner is ada@example.com; Attio connected.');

    // Force a fold (tiny test messages never cross the real 500K budget):
    // triggerTokens:0 makes any window fold, targetTokens:0 folds everything
    // older than the recent K — landing the cursor on the K-edge (a5).
    const snapshot = await compactIfDue('conv-1', { triggerTokens: 0, targetTokens: 0 });

    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    const callArgs = mockAnthropicChat.mock.calls[0][0];
    // Model id is pinned per CLAUDE.md.
    expect(callArgs.model).toBe(HAIKU_MODEL);
    // System prompt carries the brief's verbatim setup-agent persona +
    // the verbatim "preserve decided values" rules.
    expect(callArgs.system).toMatch(/setup agent and a user/);
    expect(callArgs.system).toMatch(/Preserve any decided values verbatim/);
    expect(callArgs.system).toMatch(/One paragraph\. ~150 words max/);
    // User message carries the running-state-was-empty marker + the
    // turns that have aged out (everything up to + including the
    // cursor) + the Haiku-cue "UPDATED RUNNING STATE:" tail. The
    // recent K turns (a6..a10) ride verbatim in the messages array
    // and are intentionally NOT summarised here.
    expect(callArgs.userMessage).toMatch(/CURRENT RUNNING STATE:\s*\(empty\)/);
    expect(callArgs.userMessage).toMatch(/forward emails to attio/);
    expect(callArgs.userMessage).toMatch(/OK, you want emails into Attio/);
    expect(callArgs.userMessage).toMatch(/UPDATED RUNNING STATE:$/);
    // Per-turn thinking for the aging-out turn is included.
    expect(callArgs.userMessage).toMatch(/Reflecting before proposing/);
    // Recent-window turns (a6..a10) are NOT included — they ride
    // verbatim in the messages array on the next turn.
    expect(callArgs.userMessage).not.toMatch(/default owner is ada@example\.com/);
    expect(callArgs.userMessage).not.toMatch(/connectIntegration/);

    expect(snapshot.runningState).toBe(
      'Customer wants emails into Attio; default Deal owner is ada@example.com; Attio connected.',
    );
    // Batched M4 cadence: cursor lands on the (K+1)th-from-last
    // assistant — `a5` in this seed (a1..a10; recent window = last
    // K=5 → a6..a10; aged-out batch = a1..a5).
    expect(snapshot.compactedThrough).toBe('a5');

    // Persisted onto the metadata bag (additive — preserves any
    // sibling keys).
    expect(mockConversationUpdates).toHaveLength(1);
    expect(mockConversationUpdates[0].data.metadata).toMatchObject({
      runningState: 'Customer wants emails into Attio; default Deal owner is ada@example.com; Attio connected.',
      compactedThrough: 'a5',
    });
  });

  it('advances the cursor and includes prior running state on the next compaction', async () => {
    // Token-budget cadence: a forced fold (triggerTokens:0) lands the cursor on
    // the K-edge (a5). Then while the verbatim window stays UNDER the real
    // budget, appending a turn does NOT re-fold (the cache-stable property the
    // old batch gate protected — now enforced by the token budget, not a turn
    // count). A second forced fold advances the cursor to a10.
    const row0Messages: any[] = [];
    let t = 1;
    for (let i = 1; i <= 10; i++) {
      row0Messages.push({ id: `u${i}`, role: 'user', content: `user ${i}`, createdAtMs: t++ });
      row0Messages.push({
        id: `a${i}`,
        role: 'assistant',
        content: i === 7 ? 'first assistant naming Acme' : `assistant turn ${i}`,
        createdAtMs: t++,
      });
    }
    seedConversation('conv-2', { metadata: {}, messages: row0Messages });

    mockAnthropicChat.mockResolvedValueOnce('Round-1 summary.');
    const first = await compactIfDue('conv-2', { triggerTokens: 0, targetTokens: 0 });
    expect(first.compactedThrough).toBe('a5');

    const row = mockConversationsById.get('conv-2')!;
    const appendTurn = (i: number) => {
      row.agentMessages.push(
        {
          id: `u${i}`,
          role: 'user',
          content: `user ${i}`,
          messageType: 'chat',
          metadata: {},
          createdAt: new Date(t++),
        },
        {
          id: `a${i}`,
          role: 'assistant',
          content: `assistant turn ${i}`,
          messageType: 'chat',
          metadata: {},
          createdAt: new Date(t++),
        },
      );
    };

    // One more turn, real budget → the verbatim window is far under 500K → no
    // fold; the cursor stays put (this is the cache-stable property).
    appendTurn(11);
    const between = await compactIfDue('conv-2');
    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(between.compactedThrough).toBe('a5');

    // Four more turns, then a forced fold → cursor advances to a10.
    for (let i = 12; i <= 15; i++) appendTurn(i);

    mockAnthropicChat.mockResolvedValueOnce('Round-2 rollup including Acme.');
    const second = await compactIfDue('conv-2', { triggerTokens: 0, targetTokens: 0 });

    const round2Args = mockAnthropicChat.mock.calls[1][0];
    expect(round2Args.userMessage).toMatch(/CURRENT RUNNING STATE:\s*Round-1 summary\./);
    // a1..a5 were already in the previous round's summary — not replayed.
    expect(round2Args.userMessage).not.toMatch(/assistant turn 1\b/);
    // a7 is in the batch aging out this round.
    expect(round2Args.userMessage).toMatch(/first assistant naming Acme/);
    expect(second.compactedThrough).toBe('a10');
    expect(second.runningState).toBe('Round-2 rollup including Acme.');
  });

  it('is a no-op when fewer than 2 new assistant turns since the cursor', async () => {
    seedConversation('conv-3', {
      metadata: { runningState: 'pre-existing summary', compactedThrough: null },
      messages: [
        { id: 'm1', role: 'user', content: 'just one user msg', createdAtMs: 1 },
        { id: 'm2', role: 'assistant', content: 'lone assistant', createdAtMs: 2 },
      ],
    });

    const snapshot = await compactIfDue('conv-3');

    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(mockConversationUpdates).toHaveLength(0);
    expect(snapshot.runningState).toBe('pre-existing summary');
    expect(snapshot.compactedThrough).toBe(null);
  });

  it('ignores in-progress tombstones (does not count toward the gate)', async () => {
    seedConversation('conv-tomb', {
      metadata: {},
      messages: [
        { id: 'm1', role: 'user', content: 'u1', createdAtMs: 1 },
        { id: 'm2', role: 'assistant', content: 'a1', createdAtMs: 2 },
        // In-progress tombstone — must not count.
        { id: 'm3', role: 'assistant', content: '', status: 'in_progress', createdAtMs: 3 },
      ],
    });

    const snapshot = await compactIfDue('conv-tomb');
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(snapshot.runningState).toBe(null);
  });

  it('swallows Haiku failures — returns the prior snapshot unchanged', async () => {
    seedConversation('conv-fail', {
      metadata: { runningState: 'old summary', compactedThrough: null },
      messages: [
        { id: 'm1', role: 'user', content: 'u1', createdAtMs: 1 },
        { id: 'm2', role: 'assistant', content: 'a1', createdAtMs: 2 },
        { id: 'm3', role: 'user', content: 'u2', createdAtMs: 3 },
        { id: 'm4', role: 'assistant', content: 'a2', createdAtMs: 4 },
      ],
    });
    mockAnthropicChat.mockRejectedValue(new Error('rate limit'));

    const snapshot = await compactIfDue('conv-fail');
    expect(snapshot.runningState).toBe('old summary');
    expect(snapshot.compactedThrough).toBe(null);
    // No persist on failure — cursor + running state unchanged.
    expect(mockConversationUpdates).toHaveLength(0);
  });

  it('returns the unchanged snapshot when Haiku returns empty', async () => {
    seedConversation('conv-empty', {
      metadata: { runningState: 'kept', compactedThrough: null },
      messages: [
        { id: 'm1', role: 'user', content: 'u1', createdAtMs: 1 },
        { id: 'm2', role: 'assistant', content: 'a1', createdAtMs: 2 },
        { id: 'm3', role: 'user', content: 'u2', createdAtMs: 3 },
        { id: 'm4', role: 'assistant', content: 'a2', createdAtMs: 4 },
      ],
    });
    mockAnthropicChat.mockResolvedValue('   ');

    const snapshot = await compactIfDue('conv-empty');
    expect(snapshot.runningState).toBe('kept');
    expect(mockConversationUpdates).toHaveLength(0);
  });
});

describe('loadRunningState', () => {
  it('reads the snapshot off conversation.metadata', async () => {
    seedConversation('conv-l1', {
      metadata: { runningState: 'paragraph', compactedThrough: 'm-cur' },
      messages: [],
    });
    const snapshot = await loadRunningState('conv-l1');
    expect(snapshot.runningState).toBe('paragraph');
    expect(snapshot.compactedThrough).toBe('m-cur');
  });

  it('returns nulls for an unknown conversation', async () => {
    const snapshot = await loadRunningState('conv-missing');
    expect(snapshot.runningState).toBe(null);
    expect(snapshot.compactedThrough).toBe(null);
  });

  it('returns nulls when metadata is empty', async () => {
    seedConversation('conv-empty-meta', { metadata: {}, messages: [] });
    const snapshot = await loadRunningState('conv-empty-meta');
    expect(snapshot.runningState).toBe(null);
    expect(snapshot.compactedThrough).toBe(null);
  });
});

describe('buildRunningStateBlock', () => {
  it('returns the empty string for null', () => {
    expect(buildRunningStateBlock(null)).toBe('');
  });

  it('returns the empty string for empty input', () => {
    expect(buildRunningStateBlock('')).toBe('');
  });

  it('wraps non-empty input in the documented header + trailing rule', () => {
    const block = buildRunningStateBlock('decided Acme');
    expect(block).toMatch(/^## Where you are in this conversation\n\ndecided Acme\n\n---\n\n$/);
  });
});

// ---------------------------------------------------------------------------
// M4 sliding-window unit tests
// ---------------------------------------------------------------------------

describe('compactIfDue — sliding-window gate (M4)', () => {
  it('does not fire when fewer than K+1 persisted assistants exist', async () => {
    // K=5 → K+1=6. Seed only 5 assistant turns → recent window
    // isn't full yet → nothing has aged out → no compaction.
    const messages: SeedMessageInput[] = [];
    for (let i = 1; i <= 5; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `u${i}`, createdAtMs: i * 2 - 1 });
      messages.push({ id: `a${i}`, role: 'assistant', content: `a${i}`, createdAtMs: i * 2 });
    }
    seedConversation('conv-shortwindow', { metadata: {}, messages });

    const snapshot = await compactIfDue('conv-shortwindow');
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(snapshot.runningState).toBe(null);
    expect(snapshot.compactedThrough).toBe(null);
  });

  it('does not fold while under the token budget; folds once the window crosses it', async () => {
    // Under the 500K budget, no fold no matter how many turns age out — that is
    // the whole point of the change (keep far more context verbatim than the
    // old 5-turn batch did).
    const messages: SeedMessageInput[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `u${i}`, createdAtMs: i * 2 - 1 });
      messages.push({ id: `a${i}`, role: 'assistant', content: `a${i}`, createdAtMs: i * 2 });
    }
    seedConversation('conv-firstfire', { metadata: {}, messages });
    mockAnthropicChat.mockResolvedValue('summary');

    const early = await compactIfDue('conv-firstfire');
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(early.compactedThrough).toBe(null);

    // Even at 10 tiny assistants the window is nowhere near 500K → still no fold.
    const row = mockConversationsById.get('conv-firstfire')!;
    for (let i = 7; i <= 10; i++) {
      row.agentMessages.push(
        {
          id: `u${i}`,
          role: 'user',
          content: `u${i}`,
          messageType: 'chat',
          metadata: {},
          createdAt: new Date(i * 2 - 1 + 100),
        },
        {
          id: `a${i}`,
          role: 'assistant',
          content: `a${i}`,
          messageType: 'chat',
          metadata: {},
          createdAt: new Date(i * 2 + 100),
        },
      );
    }
    const stillUnder = await compactIfDue('conv-firstfire');
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(stillUnder.compactedThrough).toBe(null);

    // Force the window over budget → folds, landing on the K-edge (a5).
    const snapshot = await compactIfDue('conv-firstfire', { triggerTokens: 0, targetTokens: 0 });
    expect(mockAnthropicChat).toHaveBeenCalledTimes(1);
    expect(snapshot.compactedThrough).toBe('a5');
  });

  it('is idempotent — does not re-fire when the cursor already covers the aging-out assistant', async () => {
    // Same K+1=6 setup, but the cursor is already at a1 (already
    // folded in on a prior turn). Aging-out assistant is a1; cursor
    // is a1; nothing new has crossed the K-line.
    const messages: SeedMessageInput[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `u${i}`, createdAtMs: i * 2 - 1 });
      messages.push({ id: `a${i}`, role: 'assistant', content: `a${i}`, createdAtMs: i * 2 });
    }
    seedConversation('conv-idempotent', {
      metadata: { runningState: 'prior paragraph', compactedThrough: 'a1' },
      messages,
    });

    const snapshot = await compactIfDue('conv-idempotent');
    expect(mockAnthropicChat).not.toHaveBeenCalled();
    expect(snapshot.runningState).toBe('prior paragraph');
    expect(snapshot.compactedThrough).toBe('a1');
  });
});

describe('selectRecentWindowAssistantIds (M4)', () => {
  it('returns the last K persisted assistant ids', () => {
    const messages = [
      { id: 'u1', role: 'user', content: 'u1' },
      { id: 'a1', role: 'assistant', content: 'a1' },
      { id: 'u2', role: 'user', content: 'u2' },
      { id: 'a2', role: 'assistant', content: 'a2' },
      { id: 'u3', role: 'user', content: 'u3' },
      { id: 'a3', role: 'assistant', content: 'a3' },
      { id: 'u4', role: 'user', content: 'u4' },
      { id: 'a4', role: 'assistant', content: 'a4' },
      { id: 'u5', role: 'user', content: 'u5' },
      { id: 'a5', role: 'assistant', content: 'a5' },
      { id: 'u6', role: 'user', content: 'u6' },
      { id: 'a6', role: 'assistant', content: 'a6' },
    ];
    const window = selectRecentWindowAssistantIds(messages);
    expect(window.size).toBe(RECENT_WINDOW_K);
    expect([...window].sort()).toEqual(['a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('excludes in-progress tombstones from the window', () => {
    const messages = [
      { id: 'a1', role: 'assistant', content: 'a1' },
      { id: 'a2', role: 'assistant', content: 'a2' },
      { id: 'a3', role: 'assistant', content: 'a3' },
      { id: 'a4', role: 'assistant', content: 'a4' },
      { id: 'a5', role: 'assistant', content: 'a5' },
      { id: 'a6', role: 'assistant', content: 'a6' },
      { id: 'tomb', role: 'assistant', content: '', metadata: { status: 'in_progress' } },
    ];
    const window = selectRecentWindowAssistantIds(messages);
    // Tombstone excluded; a2..a6 is the K=5 window.
    expect(window.has('tomb')).toBe(false);
    expect([...window].sort()).toEqual(['a2', 'a3', 'a4', 'a5', 'a6']);
  });

  it('returns all persisted assistants when fewer than K exist', () => {
    const messages = [
      { id: 'a1', role: 'assistant', content: 'a1' },
      { id: 'a2', role: 'assistant', content: 'a2' },
    ];
    const window = selectRecentWindowAssistantIds(messages);
    expect([...window].sort()).toEqual(['a1', 'a2']);
  });
});

describe('buildRecentThoughtsPrefix (M4)', () => {
  it('returns empty string when thoughts is undefined', () => {
    expect(buildRecentThoughtsPrefix(undefined)).toBe('');
  });

  it('returns empty string when thoughts has neither thinking nor toolCalls', () => {
    expect(buildRecentThoughtsPrefix({})).toBe('');
  });

  it('wraps thinking in <prior_thinking> tags', () => {
    const out = buildRecentThoughtsPrefix({ thinking: 'I was reasoning about X.' });
    expect(out).toMatch(/<prior_thinking>\nI was reasoning about X\.\n<\/prior_thinking>/);
    expect(out).toMatch(/\n\n$/);
  });

  it('wraps tool calls in <prior_tool_calls> tags with one bullet per call', () => {
    const out = buildRecentThoughtsPrefix({
      toolCalls: [
        { name: 'connectIntegration', args: { adapterType: 'attio' }, result: { ok: true } },
        { name: 'showSampleEmail', args: {}, error: 'no emails yet' },
      ],
    });
    expect(out).toMatch(/<prior_tool_calls>/);
    expect(out).toMatch(/- connectIntegration\(/);
    expect(out).toContain('- showSampleEmail({}) ');
    expect(out).toContain('error: no emails yet');
    expect(out).toMatch(/<\/prior_tool_calls>/);
  });

  it('includes both blocks when both channels are populated', () => {
    const out = buildRecentThoughtsPrefix({
      thinking: 'reasoning',
      toolCalls: [{ name: 'showSampleEmail', args: {}, result: {} }],
    });
    expect(out).toMatch(/<prior_thinking>/);
    expect(out).toMatch(/<prior_tool_calls>/);
  });
});

describe('checkTokenBudget (M4)', () => {
  it('does not warn when total context is well under threshold', () => {
    const warnSpy = jest.fn();
    const { logger } = jest.requireMock('movement-engine/services/logger');
    logger.warn = warnSpy;
    checkTokenBudget({
      systemPrompt: 'short',
      runningState: 'tiny',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns when total estimated context crosses the threshold', () => {
    const warnSpy = jest.fn();
    const { logger } = jest.requireMock('movement-engine/services/logger');
    logger.warn = warnSpy;
    // 50K tokens ≈ 200K chars. Build a synthetic over-budget input.
    const giant = 'x'.repeat(250_000);
    checkTokenBudget({
      systemPrompt: giant,
      runningState: null,
      messages: [],
      conversationId: 'conv-over',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, payload] = warnSpy.mock.calls[0];
    expect(payload.threshold).toBe(TOKEN_BUDGET_WARN_THRESHOLD);
    expect(payload.estimatedTotalTokens).toBeGreaterThan(TOKEN_BUDGET_WARN_THRESHOLD);
    expect(payload.conversationId).toBe('conv-over');
  });
});
