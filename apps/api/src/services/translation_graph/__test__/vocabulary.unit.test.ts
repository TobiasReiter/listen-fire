/**
 * Unit tests for `resolveEventPhrase` — the adapter-blind template resolver
 * behind `AdapterManifest.vocabulary.eventPhrase`. Pure string substitution
 * against trigger/listen config; no adapter-specific interpretation.
 *
 */

import type { AdapterEventPhraseVocabulary } from '../adapter';

import { resolveEventPhrase } from '../vocabulary';

describe('resolveEventPhrase', () => {
  it('returns null when the manifest declares no eventPhrase vocabulary', () => {
    expect(resolveEventPhrase(undefined, { key: 'dealflow' })).toBeNull();
  });

  it('renders the first template whose slot resolves from config', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      default: [
        { template: 'When an email arrives at `{address}`' },
        { template: 'When an email arrives tagged `{key}`' },
        { template: 'When an email arrives' },
      ],
    };
    expect(resolveEventPhrase(vocab, { address: 'deals@inbox.example.com' })).toBe(
      'When an email arrives at `deals@inbox.example.com`',
    );
  });

  it('falls through to the next candidate when an earlier slot is unresolved', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      default: [
        { template: 'When an email arrives at `{address}`' },
        { template: 'When an email arrives tagged `{key}`' },
        { template: 'When an email arrives' },
      ],
    };
    expect(resolveEventPhrase(vocab, { key: 'dealflow' })).toBe(
      'When an email arrives tagged `dealflow`',
    );
  });

  it('falls through to the bare candidate when no slot resolves', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      default: [
        { template: 'When an email arrives at `{address}`' },
        { template: 'When an email arrives tagged `{key}`' },
        { template: 'When an email arrives' },
      ],
    };
    expect(resolveEventPhrase(vocab, {})).toBe('When an email arrives');
  });

  it('prefers a per-event template list over default when config selects that event', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      'record.created': [{ template: 'When a record is created in Attio' }],
      default: [{ template: 'When a record changes in Attio' }],
    };
    expect(resolveEventPhrase(vocab, { events: ['record.created'] })).toBe(
      'When a record is created in Attio',
    );
  });

  it('falls back to default when the configured event has no matching key', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      'record.created': [{ template: 'When a record is created in Attio' }],
      default: [{ template: 'When a record changes in Attio' }],
    };
    expect(resolveEventPhrase(vocab, { events: ['record.deleted'] })).toBe(
      'When a record changes in Attio',
    );
  });

  it('returns null when nothing renders (no default, no matching event)', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      'record.created': [{ template: 'When a record is created in Attio' }],
    };
    expect(resolveEventPhrase(vocab, {})).toBeNull();
  });

  it('tolerates malformed config without throwing', () => {
    const vocab: AdapterEventPhraseVocabulary = {
      default: [{ template: 'When an email arrives' }],
    };
    expect(resolveEventPhrase(vocab, null)).toBe('When an email arrives');
    expect(resolveEventPhrase(vocab, 'garbage')).toBe('When an email arrives');
  });
});
