// C9 — Application target.
//
// Resources no longer persist here. Per `4d_resources.md` they ride
// `WriteInput.resources` and the target adapter persists them as part of the
// record's own create/update; facts attach to each `Resource.facts` at
// extraction time (C2). What remains is the handle to the target adapter that
// in-batch dedup (W6-D1) needs for `getDedupRules`.

import type { Adapter } from 'movement-engine/services/translation_graph/adapter';

export interface ApplyTarget {
  /** Adapter that owns the target side of the TG (KG / Attio / etc.).
   *  In-batch dedup reads its `getDedupRules`; writes go through the
   *  per-action create/update, not through this. */
  adapter: Adapter;
}
