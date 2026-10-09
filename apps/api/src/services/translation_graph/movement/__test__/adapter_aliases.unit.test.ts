// One adapter, three names an author may write.
//
// The name a program uses is resolved twice in this codebase — once by the
// registry, when the runtime goes to build an adapter, and once by the
// catalog, when the checker asks whether a construction names anything at all.
// If those two ever disagree, `resend(…)` becomes a movement the checker calls
// clean while nothing about it was checked. So both are asserted here, side by
// side, against the same names.

import type { TeamId } from '../../../../generated/kysely/core/Team';

import { getAdapter, resolveAdapterSlug } from '../../adapters/registry';
import { EMAIL_ADAPTER_NAMES, EmailAdapter } from '../../adapters/email';
import { staticCatalogFromManifests } from '../catalog';

const TEAM = 'team-1' as TeamId;

describe('the names inbound mail answers to', () => {
  const catalog = staticCatalogFromManifests();

  it.each([...EMAIL_ADAPTER_NAMES])('the checker accepts a construction named %s', (name) => {
    expect(catalog.adapter(name)).toBeDefined();
  });

  it('offers the same construction surface whichever name is written', () => {
    expect(catalog.adapter('resend')).toEqual(catalog.adapter('email'));
    expect(catalog.adapter('mailgun')).toEqual(catalog.adapter('email'));
  });

  it.each([...EMAIL_ADAPTER_NAMES])('the runtime builds the email adapter for %s', (name) => {
    expect(getAdapter({ adapterType: name, teamId: TEAM })).toBeInstanceOf(EmailAdapter);
  });

  it('resolves the provider names to the one canonical slug', () => {
    expect(resolveAdapterSlug('resend')).toBe('email');
    expect(resolveAdapterSlug('mailgun')).toBe('email');
  });

  it('still refuses a name nothing answers to', () => {
    expect(catalog.adapter('postmark')).toBeUndefined();
  });
});
