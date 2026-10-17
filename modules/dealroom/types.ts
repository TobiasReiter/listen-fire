// Dealroom adapter — the names and ids the rest of the package shares.
//
// The ONE rule (adapters/base.ts): a position's `recordType` is the pretty
// DISPLAY NAME; the `dealroom:*` typeIds below are this adapter's private
// currency and never ride a position.

export const DEALROOM_ADAPTER_TYPE = 'dealroom';

/** The database meta node a movement obtains by constructing the adapter. */
export const DEALROOM_DATABASE_TYPE_ID = 'dealroom:database';
export const DEALROOM_DATABASE_DISPLAY_NAME = 'Dealroom';

export const DEALROOM_COMPANY_TYPE_ID = 'dealroom:company';
export const DEALROOM_COMPANY_DISPLAY_NAME = 'Company';

export const DEALROOM_INVESTOR_TYPE_ID = 'dealroom:investor';
export const DEALROOM_INVESTOR_DISPLAY_NAME = 'Investor';

export const DEALROOM_PERSON_TYPE_ID = 'dealroom:person';
export const DEALROOM_PERSON_DISPLAY_NAME = 'Person';

export const DEALROOM_FUNDING_ROUND_TYPE_ID = 'dealroom:funding_round';
export const DEALROOM_FUNDING_ROUND_DISPLAY_NAME = 'Funding Round';

export const DEALROOM_TEAM_MEMBER_TYPE_ID = 'dealroom:team_member';
export const DEALROOM_TEAM_MEMBER_DISPLAY_NAME = 'Team Member';

export const DEALROOM_ROUND_INVESTOR_TYPE_ID = 'dealroom:round_investor';
export const DEALROOM_ROUND_INVESTOR_DISPLAY_NAME = 'Round Investor';

export const DEALROOM_FUND_TYPE_ID = 'dealroom:fund';
export const DEALROOM_FUND_DISPLAY_NAME = 'Fund';

// ── Root collections (the meta-node edges an author traverses) ───────────────

export const DEALROOM_COMPANIES_COLLECTION = 'Companies';
export const DEALROOM_INVESTORS_COLLECTION = 'Investors';
export const DEALROOM_PEOPLE_COLLECTION = 'People';
export const DEALROOM_FUNDING_ROUNDS_COLLECTION = 'Funding Rounds';

// ── Edges below the root: read id (private) ↔ natural name (what authors write)
// Rule 5: an edge never carries the system name — the instance already says
// which system you are in.

export const DEALROOM_COMPANY_ROUNDS_EDGE = 'company_funding_rounds';
export const DEALROOM_COMPANY_ROUNDS_EDGE_NAME = 'Funding Rounds';
export const DEALROOM_COMPANY_INVESTORS_EDGE = 'company_investors';
export const DEALROOM_COMPANY_INVESTORS_EDGE_NAME = 'Investors';
export const DEALROOM_COMPANY_TEAM_EDGE = 'company_team';
export const DEALROOM_COMPANY_TEAM_EDGE_NAME = 'Team';
export const DEALROOM_COMPANY_SIMILAR_EDGE = 'company_similar';
export const DEALROOM_COMPANY_SIMILAR_EDGE_NAME = 'Similar Companies';

export const DEALROOM_INVESTOR_INVESTMENTS_EDGE = 'investor_investments';
export const DEALROOM_INVESTOR_INVESTMENTS_EDGE_NAME = 'Investments';
export const DEALROOM_INVESTOR_ROUNDS_EDGE = 'investor_funding_rounds';
export const DEALROOM_INVESTOR_ROUNDS_EDGE_NAME = 'Funding Rounds';
export const DEALROOM_INVESTOR_CO_INVESTORS_EDGE = 'investor_co_investors';
export const DEALROOM_INVESTOR_CO_INVESTORS_EDGE_NAME = 'Co-Investors';
export const DEALROOM_INVESTOR_FUNDS_EDGE = 'investor_funds';
export const DEALROOM_INVESTOR_FUNDS_EDGE_NAME = 'Funds';
export const DEALROOM_INVESTOR_TEAM_EDGE = 'investor_team';
export const DEALROOM_INVESTOR_TEAM_EDGE_NAME = 'Team';

export const DEALROOM_PERSON_COMPANIES_EDGE = 'person_companies';
export const DEALROOM_PERSON_COMPANIES_EDGE_NAME = 'Companies';

export const DEALROOM_TEAM_MEMBER_PERSON_EDGE = 'team_member_person';
export const DEALROOM_TEAM_MEMBER_PERSON_EDGE_NAME = 'Person';

export const DEALROOM_ROUND_COMPANY_EDGE = 'round_company';
export const DEALROOM_ROUND_COMPANY_EDGE_NAME = 'Company';
export const DEALROOM_ROUND_INVESTORS_EDGE = 'round_investors';
export const DEALROOM_ROUND_INVESTORS_EDGE_NAME = 'Investors';
export const DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE = 'round_investor_investor';
export const DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE_NAME = 'Investor';

// ── The `events:` vocabulary ────────────────────────────────────────────────
// One kind: a funding round Dealroom has just recorded. `created_utc` is the
// only "new since" the API offers on a round, and it is the only event anybody
// asked for — a new COMPANY on Dealroom is a catalogue event, and the same
// question is a `Companies` walk with a `Created At` bound.

export const DEALROOM_FUNDING_ROUND_EVENT = 'funding_round';

export const DEALROOM_SUBSCRIBABLE_EVENTS = [DEALROOM_FUNDING_ROUND_EVENT] as const;

/** The discriminator a polled funding-round event carries. */
export const DEALROOM_FUNDING_ROUND_EVENT_TAG = 'dealroom:funding_round';

/**
 * The opaque checkpoint the PollSource persists. Creation is the one
 * "changed since" mark Dealroom offers on a round, so this is the newest
 * `created_utc` already delivered, in epoch milliseconds. Absent is a trigger
 * that has never polled — the first poll sets it and emits nothing.
 */
export interface DealroomCheckpoint {
  createdAfter?: number;
}

/**
 * A team member's identity IS the pair (parent, person): the sub-resource item's
 * `id` is the PERSON's id, so two companies sharing a founder would otherwise
 * mint the same node for two different positions. The pair travels as one
 * string through the `externalId` seam, encoded and decoded here so no call site
 * re-invents the separator. `Round Investor` is the same shape for the same
 * reason — its `id` is the investor's.
 */
export function encodePairId(input: { parentId: string; childId: string }): string {
  return `${input.parentId}:${input.childId}`;
}

/** The inverse of {@link encodePairId}. Splits at the FIRST separator —
 *  undefined when the value is not a pair. */
export function decodePairId(
  externalId: string,
): { parentId: string; childId: string } | undefined {
  const at = externalId.indexOf(':');
  if (at <= 0 || at === externalId.length - 1) return undefined;
  return { parentId: externalId.slice(0, at), childId: externalId.slice(at + 1) };
}
