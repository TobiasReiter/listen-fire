// The platform's report of an Affinity write the caller walked past: the ops
// Slack alert the client and the extraction pipeline sent before Affinity
// became a module, with the same text. Installed on import.

import { reportAffinityWriteFailuresTo } from '@lf/affinity/write_failures';
import { currentContext } from '../../../context';
import { sendSlackNotification } from '../../../../lib/slack';

reportAffinityWriteFailuresTo(async ({ kind, detail }) => {
  switch (kind) {
    case 'note': {
      const ctx = currentContext();
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity error for user ${ctx.user.id} adding note (${detail})`,
        opsTitle: `Affinity error adding a note`,
      });
      return;
    }
    case 'field value':
      await sendSlackNotification({
        type: 'DEALFLOW',
        text: `:warning: Affinity error adding field value (${detail})`,
        opsTitle: 'Affinity error adding a field value',
      });
      return;
  }
});
