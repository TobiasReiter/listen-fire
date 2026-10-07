// The callback vocabulary the engine and the host share: what a fire-time
// parameter may be, and what one recorded fire looks like. Engine-side so the
// interpreter can name it without importing the host's callback store.

/** The correlation map's `adapter_type` for a callback await.
 *  A RESERVED engine identity, not a system: the map is keyed on opaque text and
 *  its reaps are adapter-agnostic by construction, so a callback await gets the
 *  run-death / race-loss cleanup for free. */
export const CALLBACK_AWAIT_TYPE = 'callback';

/** The scalar types a fire-time parameter may declare — the checker already
 *  refuses anything else (a platform cannot hand us a record position). */
export const CALLBACK_PARAM_TYPES = [
  'text', 'number', 'boolean', 'date', 'datetime', 'json', 'file',
] as const;
export type CallbackParamType = (typeof CALLBACK_PARAM_TYPES)[number];

export function isCallbackParamType(value: string): value is CallbackParamType {
  return (CALLBACK_PARAM_TYPES as readonly string[]).includes(value);
}

/** One fire-time parameter, in DECLARATION order — the signature the door
 *  validates against and the confirm page renders a control for. */
export interface CallbackParamSpec {
  name: string;
  type: CallbackParamType;
}

/** One recorded fire. `At` and the parameter names are the `Called` landing's
 *  fields verbatim (the checker derives the same shape at the construction
 *  site), so the ledger IS what a read of `cb-[:Called]->` sees. */
export interface CallbackCall {
  /** ISO-8601 — the landing's `At`. */
  at: string;
  values: Record<string, unknown>;
}
