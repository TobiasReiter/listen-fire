// At boot, how many live webhook subscriptions each built-in module's signed
// inbound now refuses: a module that declares a signing scheme gets the
// host's one rule (a missing, blank or placeholder secret refuses every
// delivery), and the doors before it were more lenient (Affinity accepted
// anything without a key; Attio and Airtable verified against an empty one).
// Counts only — never a secret, a team or a subscription id.

import { sql } from 'kysely';

import { UNREGISTERED_SECRET } from 'movement-engine/public/inbound';
import { getAutomationsQb } from '../../../lib/kysely';
import { adapterModuleDefinitions } from './builtin_modules';

export async function logRefusedModuleInbounds(): Promise<void> {
  for (const definition of adapterModuleDefinitions()) {
    const declared = definition.inbound;
    if (declared === undefined) continue;
    const provider = declared.providerKey.toUpperCase();
    const row = await getAutomationsQb(['webhook_subscription'])
      .selectFrom('webhook_subscription')
      .where('provider', '=', provider)
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
    const refused = Number(row?.count ?? 0);
    if (refused > 0) {
      console.warn(
        `[startup] ${definition.name}: ${refused} live ${provider} webhook subscription(s) have no usable signing secret; ` +
          'their deliveries are now refused (signed inbound). Re-register the listen, or set the signing key, to resume them.',
      );
    }
  }
}
