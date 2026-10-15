// The AWAITABLE capability (asks-as-adapter chunk B, layer 3 §A; protocol v2).
// An adapter that advertises awaitable edges answers one question: "is this
// edge resolved yet, and if not, what key should wake it?" The engine owns
// everything stateful — the correlation row from that key to its park, the
// park itself, resume, WHERE evaluation, and dropping the row when the park
// ends. No run identity crosses into the adapter, so the capability works the
// same in process and over the wire. The second question, "which keys does
// this inbound payload wake?", is `Adapter.wakeKeys`.
//
// This is a NARROW, delivery-orthogonal capability (P12): it is NOT rendering,
// delivery, uniqueness, or streams (`fires` owns those).

/** What a live check-now (`await x-[:E]->`) resolves to right now. */
export type AwaitResolution =
  /** Nothing has landed yet — the engine parks the leaf (armed) and correlates
   *  the park to `correlationKey`, the key a later wake names (Slack:
   *  `channel:thread_ts`; ask: the ask id). */
  | { status: 'pending'; correlationKey: string }
  /** The edge resolves to ≥1 landing — the engine binds them (after applying
   *  the await's WHERE) and continues inline. Each landing carries the fields
   *  the resumed body reads (`r.answer`). `correlationKey` is the key to keep
   *  waiting on should no landing pass the WHERE (a thread with replies, none of
   *  them the one asked for). */
  | { status: 'landed'; landings: AwaitLanding[]; correlationKey: string }
  /** A `resolvesEmpty` settlement (an ask explicitly cancelled → expired, F6):
   *  the await completes immediately with an EMPTY match — downstream blocks run
   *  zero times. Only legal on an edge declared `resolvesEmpty`. */
  | { status: 'empty' };

/** One landing along an awaited edge — the node the resolution carries. */
export interface AwaitLanding {
  /** The landing record's id, when it has one (correlation, not stability —
   *  absent is fine). */
  recordId?: string;
  /** The landing node's NATURAL type name (`Response` for an ask, `Message` for
   *  a Slack reply). The engine binds a position of this type, so the resumed
   *  body's field reads AND the await's WHERE resolve through the adapter's own
   *  `getFieldValue` for that type. Absent ⇒ a fields-less/empty node. */
  recordType?: string;
  /** The landing's fields, keyed by whatever `getFieldValue` for `recordType`
   *  reads (the ask keys `Answer`; Slack rides the raw message payload its
   *  message reads already key by). Never pre-translated to the author's names
   *  — the engine reads them back through the adapter, same path as any read. */
  fields: Record<string, unknown>;
}

/** The identity of one awaited edge instance — the head record + the edge. */
export interface AwaitPoint {
  /** The head record the edge walks from (the written ask's id). */
  recordId: string;
  /** The awaited edge's name (`Response`). */
  edge: string;
  /** Everything a normal traversal of the head gets — the head's inline position
   *  data. An adapter whose correlation identity is
   *  NOT the bare `recordId` reads it here: Slack's `Replies` correlates on the
   *  channel + thread, which ride the write handle's data, not its `ts`. Absent
   *  for a head with no inline data. */
  headData?: Record<string, unknown>;
}

export interface AwaitableCapability {
  /**
   * Live check-now: does this awaited edge currently resolve, and to what?
   * Called at the `await` (continue-inline vs park), once more right after
   * parking (a wake that landed between the two would otherwise be lost), and
   * on every resume (re-enter). The engine applies the await's WHERE to `landed`
   * landings; the adapter only reports what has arrived.
   */
  resolveAwait(point: AwaitPoint): Promise<AwaitResolution>;
}

/** An adapter that advertises awaitable edges exposes this capability. Absent ⇒
 *  the adapter has no awaitable edges (bare adapters). */
export interface MaybeAwaitable {
  awaitable?: AwaitableCapability;
}
