// What a priced host call may spend and what it reports it spent: the money
// vocabulary both sides of the engine/host seam speak. Money is integer
// microdollars (a millionth of a US dollar).

/** What a priced host call may spend: the run's cap less what the run has
 *  spent against it, or null when the run has no cap. Zero or less ⇒ the run
 *  has spent its cap, and the call's first priced step is refused. */
export interface Budget {
  remainingMicrodollars: number | null;
}

/** One thing a priced host call spent money on: its source key
 *  (`<kind>:<name>`, e.g. `model:claude-sonnet-5`) and what it cost, in whole
 *  microdollars. */
export interface CostLine {
  source: string;
  microdollars: number;
}
