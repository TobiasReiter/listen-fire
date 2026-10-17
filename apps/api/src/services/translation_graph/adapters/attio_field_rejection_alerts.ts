// The platform's report of an Attio field the client retried a write without:
// the ops Slack alert it sent before Attio became a module, with the same
// text. Installed on import.

import { reportAttioFieldRejectionsTo } from '@listen-fire/attio/field_rejections';
import { sendSlackNotification } from '../../../lib/slack';

reportAttioFieldRejectionsTo(async ({ context, fieldKey, attributeId, fieldValue, error }) => {
  await sendSlackNotification({
    type: 'DEALFLOW',
    text: `Attio field validation error in ${context}: attribute "${fieldKey}" (ID: ${attributeId}) with value ${JSON.stringify(fieldValue)} was rejected. Retrying without this field. Error: ${error}`,
    opsTitle: `Attio rejected field "${fieldKey}" in ${context}`,
  });
});
