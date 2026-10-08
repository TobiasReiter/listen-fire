// The credential type an adapter manifest names. A manifest carries it as a
// plain string (the adapter contract carries no database enum); this host
// knows the types its credential store holds.

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

const CREDENTIAL_TYPES: ReadonlySet<string> = new Set(Object.values(ExternalServiceType));

export function isCredentialType(value: string): value is ExternalServiceType {
  return CREDENTIAL_TYPES.has(value);
}

/** The type a manifest names, or null when it names none. A type the
 *  credential store does not hold is refused. */
export function credentialTypeOf(declared: string | undefined): ExternalServiceType | null {
  if (declared === undefined) return null;
  if (!isCredentialType(declared)) {
    throw new Error(`adapter manifest names an unknown credential type '${declared}'`);
  }
  return declared;
}
