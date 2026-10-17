import { createHmac } from 'node:crypto';

import { verifyAsProvider } from '../../inbound/__test__/verify_as_provider';

const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const sign = (secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('WhatsApp signature verification', () => {
  it('accepts Meta’s digest keyed with the app secret', () => {
    expect(verifyAsProvider('INBOUND_WHATSAPP', body, sign('app-secret'), 'app-secret')).toBe(true);
  });

  it('refuses a digest keyed with another secret', () => {
    expect(verifyAsProvider('INBOUND_WHATSAPP', body, sign('other'), 'app-secret')).toBe(false);
  });

  it('refuses a missing signature', () => {
    expect(verifyAsProvider('INBOUND_WHATSAPP', body, '', 'app-secret')).toBe(false);
  });

  it('refuses when there is no secret, even for a digest keyed with the empty string', () => {
    expect(verifyAsProvider('INBOUND_WHATSAPP', body, sign(''), '')).toBe(false);
  });
});
