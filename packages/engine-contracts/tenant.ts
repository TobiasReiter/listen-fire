// Whose a run is. The engine never reads a tenant id: it names the tenant on
// the segments it opens and on the wakes it asks for, and the host answers
// every call of a segment for the tenant it was opened for. So the id is
// opaque — a branded string the host mints from its own notion of a tenant
// (a team, an account, a workspace) — and the brand keeps any other string
// from standing in for one.

import { z } from 'zod';

/** A tenant id as it crosses a wire: any non-empty string, branded on parse. */
export const tenantIdSchema = z.string().min(1).brand<'TenantId'>();

/** An opaque tenant id. Mint one with `tenantIdOf`. */
export type TenantId = z.infer<typeof tenantIdSchema>;

/** The tenant id a host's own identifier stands for. Refuses the empty
 *  string, which names no tenant. */
export function tenantIdOf(value: string): TenantId {
  return tenantIdSchema.parse(value);
}
