/**
 * The canonical adapter id: lowercase, hyphen-separated. Enum-style names
 * (`ATTIO`, `NATIVE_VALUATIONS`) collapse to the registry's ids (`attio`,
 * `native-valuations`), so a key written from either convention matches.
 */
export function normalizeAdapterType(adapterType: string): string {
  return adapterType.toLowerCase().replace(/_/g, '-');
}
