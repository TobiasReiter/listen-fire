import type { Chapter } from '../types';

import {
  listAdapterCapabilities,
  type AdapterCapabilitySummary,
} from '../../../../services/translation_graph/adapters/registry';

const INTRO = `## Connecting an integration

Every integration is connected from the **Credentials** page
(\`/credentials\`) — never from
Settings. On that page, click **Add credential**, choose the system you
want, and Listen-Fire starts the right sign-in flow and stores the resulting
credential. Some systems sign you in through a secure pop-up; a few take a
key you paste. You do **not** need to know which in advance — Add
credential runs the correct flow for the system you pick, and in
conversation you can offer to start it for the user directly.

Built-in channels (inbound email addresses, the web form) also live on the
Credentials page, under "Where data comes in", and need no external sign-in.

### Integrations available to connect

Each integration below needs the credential named next to it. Adding it on
the Credentials page provisions exactly that credential.`;

const OUTRO = `When a user asks to connect one of these, offer to start the
connection for them rather than walking them through manual steps. If they
ask for one that is not listed, say it is not currently available as an
integration.`;

function renderCredentialTable(caps: AdapterCapabilitySummary[]): string {
  const connectable = caps
    .filter((c) => c.requiredCredentialType !== null)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (connectable.length === 0) return '_No connectable integrations are registered._';
  return connectable
    .map((c) => `- **${c.displayName}** — credential: \`${c.requiredCredentialType}\``)
    .join('\n');
}

export function renderConnectingIntegrations(): Chapter {
  return {
    id: 'connecting-integrations',
    title: 'Connecting integrations',
    content: `${INTRO}\n\n${renderCredentialTable(listAdapterCapabilities())}\n\n${OUTRO}`,
  };
}
