// Shared Slack adapter constants. Kept in a leaf module (no imports from
// `./index` or `./write`) so value-importers on either side stay acyclic —
// the same idiom airtable/dropbox/google_* follow with their `types.ts`.

/** Stable adapter identifier. Matches `MutationContext.source.adapterType`. */
export const SLACK_ADAPTER_TYPE = 'slack';
