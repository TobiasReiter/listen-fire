// Which slugs a remote install may take: none a built-in answers to (slug,
// trigger kind or alias, in any casing — the install's upper-cased provider
// key included) and none of the engine's reserved await identities.

import { mayBeRemoteSlug, remoteSlugRefusal } from '../slugs';

describe('remote slugs', () => {
  it.each(['slack', 'inbound_email', 'gmail', 'kg_mutation', 'web', 'callback', 'ask', 'SLACK', 'Attio', 'custom_email', 'ſlack', 'attıo', 'aﬃnity'])(
    'refuses %s',
    (slug) => {
      expect(mayBeRemoteSlug(slug)).toBe(false);
      expect(remoteSlugRefusal(slug)).toMatch(/needs a slug of its own/);
    },
  );

  it.each(['acme_crm', 'homespun_crm'])('allows %s', (slug) => {
    expect(mayBeRemoteSlug(slug)).toBe(true);
    expect(remoteSlugRefusal(slug)).toBeNull();
  });
});
