import { createHmac } from 'node:crypto';

import { whatsappProvider } from '../providers/whatsapp';

const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const sign = (secret: string): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('whatsappProvider.verifySignature', () => {
  it('accepts Meta’s digest keyed with the app secret', () => {
    expect(whatsappProvider.verifySignature(body, sign('app-secret'), 'app-secret')).toBe(true);
  });

  it('refuses a digest keyed with another secret', () => {
    expect(whatsappProvider.verifySignature(body, sign('other'), 'app-secret')).toBe(false);
  });

  it('refuses a missing signature', () => {
    expect(whatsappProvider.verifySignature(body, '', 'app-secret')).toBe(false);
  });

  it('refuses when there is no secret, even for a digest keyed with the empty string', () => {
    expect(whatsappProvider.verifySignature(body, sign(''), '')).toBe(false);
  });
});
