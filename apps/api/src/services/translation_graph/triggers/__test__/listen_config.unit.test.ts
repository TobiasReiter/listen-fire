// A listen's `events` config is authored as EITHER a bare string or a list —
// the checker accepts both. Both the subscription registration and the
// dispatch-time scope filter read it through `eventConfigList`, which must
// collapse the two forms to one string[]. The bug this guards: a bare-string
// `events` used to fall through to "match/register everything", so a listen
// scoped to `create` also fired on `update`/`delete`.

import { channelScopeMatches, eventConfigList } from 'movement-engine/services/translation_graph/triggers/listen_config';

describe('eventConfigList', () => {
  it('wraps a bare-string events value in a single-element array', () => {
    expect(eventConfigList('valuations:legal_entity:create')).toEqual([
      'valuations:legal_entity:create',
    ]);
  });

  it('passes a list through, keeping only the string members', () => {
    expect(eventConfigList(['record.created', 'record.updated'])).toEqual([
      'record.created',
      'record.updated',
    ]);
    expect(eventConfigList(['ok', 42, null, 'fine'])).toEqual(['ok', 'fine']);
  });

  it('treats absent / non-string / non-array values as no selection', () => {
    expect(eventConfigList(undefined)).toEqual([]);
    expect(eventConfigList(null)).toEqual([]);
    expect(eventConfigList(42)).toEqual([]);
    expect(eventConfigList({})).toEqual([]);
  });
});

// The `channels` listen-filter decision (Slack's `listen … { channels: [...] }`,
// matched by name). The async id→name resolution is the handler's concern; this
// covers the pure admit/drop rule.
describe('channelScopeMatches', () => {
  it('admits everything when no channels are configured (unscoped listener)', () => {
    expect(channelScopeMatches({}, 'dealflow')).toBe(true);
    expect(channelScopeMatches({ events: ['message'] }, 'dealflow')).toBe(true);
    expect(channelScopeMatches({}, null)).toBe(true);
  });

  it('admits only events in a listed channel when scoped', () => {
    const config = { channels: ['dealflow', 'deals'] };
    expect(channelScopeMatches(config, 'dealflow')).toBe(true);
    expect(channelScopeMatches(config, 'deals')).toBe(true);
    expect(channelScopeMatches(config, 'random')).toBe(false);
  });

  it('drops a scoped event whose channel could not be resolved (null)', () => {
    expect(channelScopeMatches({ channels: ['dealflow'] }, null)).toBe(false);
  });

  it('tolerates a bare-string channels value (normalised like events)', () => {
    expect(channelScopeMatches({ channels: 'dealflow' }, 'dealflow')).toBe(true);
    expect(channelScopeMatches({ channels: 'dealflow' }, 'other')).toBe(false);
  });
});
