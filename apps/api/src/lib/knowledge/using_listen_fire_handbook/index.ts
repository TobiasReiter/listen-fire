import type { IntentEntry, UsingListenFireHandbook } from './types';

import { gettingAround } from './chapters/getting_around';
import { connectBuildAutomate } from './chapters/connect_build_automate';
import { renderConnectingIntegrations } from './chapters/connecting_integrations';

const INTENT_INDEX: IntentEntry[] = [
  { intent: 'Find where a feature or page lives in the app', chapter: 'getting-around' },
  { intent: 'Connect an integration (CRM, email, etc.)', chapter: 'connecting-integrations' },
  { intent: 'Understand how connecting, building an automation, and automating relate', chapter: 'connect-build-automate' },
];

export type { UsingListenFireHandbook } from './types';

/** Built fresh per call so the connecting chapter reflects the live
 *  adapter manifests rather than a value frozen at module load. */
export function getUsingListenFireHandbook(): UsingListenFireHandbook {
  return {
    chapters: {
      'getting-around': gettingAround,
      'connecting-integrations': renderConnectingIntegrations(),
      'connect-build-automate': connectBuildAutomate,
    },
    intentIndex: INTENT_INDEX,
  };
}
