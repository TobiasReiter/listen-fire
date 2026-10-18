// At boot, how many live webhook subscriptions each built-in module's signed
// inbound still lets in unsigned. A module that declares a signing scheme gets
// the host's one rule (a missing, blank or placeholder secret refuses every
// delivery), but a subscription that existed before that rule is grandfathered
// and keeps its door's old leniency (Affinity accepted anything without a key;
// Attio and Airtable verified against an empty one) until its secret is set.
// Counts only — never a secret, a team or a subscription id.

import { sql } from 'kysely';

import { UNREGISTERED_SECRET } from 'movement-engine/public/inbound';
import { getAutomationsQb } from '../../../lib/kysely';
import { adapterModuleDefinitions } from './builtin_modules';

export async function logGrandfatheredUnsignedInbounds(): Promise<void> {
  for (const definition of adapterModuleDefinitions()) {
    const declared = definition.inbound;
    if (declared === undefined) continue;
    const provider = declared.providerKey.toUpperCase();
    const row = await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('provider', '=', provider)
      .where('grandfathered_unsigned', '=', true)
      .where('deleted_at', 'is', null)
      .where('status', '!=', 'disabled')
      .where((eb) =>
        eb.or([
          eb('webhook_secret', 'is', null),
          eb(sql<string>`btrim(webhook_secret)`, '=', ''),
          eb('webhook_secret', '=', UNREGISTERED_SECRET),
        ]),
      )
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst();
    const unsigned = Number(row?.count ?? 0);
    if (unsigned > 0) {
      console.warn(
        `[startup] ${definition.name}: ${unsigned} grandfathered ${provider} webhook subscription(s) have no usable signing secret ` +
          'and still accept deliveries unsigned; setting the secret makes them strict (signed inbound).',
      );
    }
  }
}
