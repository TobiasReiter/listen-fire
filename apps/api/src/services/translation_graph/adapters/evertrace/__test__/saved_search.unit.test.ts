// A saved search's stored rows → the `POST /signals` body. Pure translation:
// no client, no network. What these hold to is that a row this cannot express
// is REPORTED rather than dropped — the poll logs what it skipped, which is how
// Evertrace's undocumented operator vocabulary gets discovered.

import type { EvertraceSearchFilterRow } from '../../../../../adapters/evertrace/apiClient';

import { narrowsAnything, signalFilterFromSearchRows } from '../saved_search';

const row = (key: string, operator: string, value: string): EvertraceSearchFilterRow => ({
  id: `sfr-${key}`,
  searchId: 'sea-1',
  key,
  operator,
  value,
  workspaceId: 'ws',
  createdAt: 1,
  updatedAt: 1,
});

const translate = (...rows: EvertraceSearchFilterRow[]) => signalFilterFromSearchRows(rows);

describe('signalFilterFromSearchRows — keys', () => {
  it('carries every same-named key straight across', () => {
    const keys = [
      'source', 'location', 'country', 'city', 'profile_tags', 'gender', 'age',
      'past_companies', 'past_education', 'education_level', 'customer_focus',
      'industry', 'origin', 'region',
    ];
    const { filter, skipped } = translate(...keys.map((key) => row(key, 'in', `${key}-value`)));
    expect(skipped).toEqual([]);
    for (const key of keys) {
      expect(filter[key as keyof typeof filter]).toEqual([`${key}-value`]);
    }
  });

  it('files a status row as the signal kind, which is what the body calls type', () => {
    const { filter } = translate(row('status', 'in', '["Stealth Position"]'));
    expect(filter.type).toEqual(['Stealth Position']);
    expect((filter as { status?: unknown }).status).toBeUndefined();
  });

  it('drops the time rows and the watcher row without reporting them as skipped', () => {
    const { filter, skipped } = translate(
      row('time_range', 'in', '["2026-01-01","2026-02-01"]'),
      row('time_relative', 'is', 'last_7_days'),
      row('created_after', 'gte', '1700000000000'),
      row('worth_following', 'in', 'wf_usr_1'),
    );
    expect(filter).toEqual({});
    expect(skipped).toEqual([]);
    expect(narrowsAnything(filter)).toBe(false);
  });

  it('reports a key it has never met rather than guessing at it', () => {
    const { filter, skipped } = translate(row('funding_stage', 'in', 'Series A'));
    expect(filter).toEqual({});
    expect(skipped).toEqual([
      { key: 'funding_stage', operator: 'in', reason: 'no filter key of this name' },
    ]);
  });

  it('merges two rows on the same key', () => {
    const { filter } = translate(row('country', 'in', 'France'), row('country', 'in', 'Spain'));
    expect(filter.country).toEqual(['France', 'Spain']);
  });
});

describe('signalFilterFromSearchRows — values', () => {
  it('reads a JSON array, a JSON string, a comma-separated string and a bare one', () => {
    expect(translate(row('city', 'in', '["Paris","Berlin"]')).filter.city).toEqual([
      'Paris',
      'Berlin',
    ]);
    expect(translate(row('city', 'in', '"Paris"')).filter.city).toEqual(['Paris']);
    expect(translate(row('city', 'in', 'Paris, Berlin')).filter.city).toEqual(['Paris', 'Berlin']);
    expect(translate(row('city', 'in', 'Paris')).filter.city).toEqual(['Paris']);
  });

  it('falls back to the bare string when a bracketed value is not JSON after all', () => {
    expect(translate(row('city', 'in', '[Paris')).filter.city).toEqual(['[Paris']);
  });

  it('reads a score as a scalar, quoted or not', () => {
    expect(translate(row('score', 'gte', '7')).filter.score).toBe('7');
    expect(translate(row('score', 'gte', '"7"')).filter.score).toBe('7');
  });

  it('reports a row carrying no value', () => {
    const { filter, skipped } = translate(row('city', 'in', '   '), row('score', 'gte', ''));
    expect(filter).toEqual({});
    expect(skipped.map((s) => s.reason)).toEqual(['no value', 'no value']);
  });
});

describe('signalFilterFromSearchRows — operators', () => {
  it('reads every spelling of include, whatever its case', () => {
    for (const operator of ['eq', 'equals', 'in', 'is', 'includes', '=', '==', 'contains', 'any', 'IN', 'Eq']) {
      expect(translate(row('country', operator, 'France')).filter.country).toEqual(['France']);
    }
  });

  it('reads an empty operator, and an absent one, as include', () => {
    expect(translate(row('country', '', 'France')).filter.country).toEqual(['France']);
    // A stored row whose operator never arrived — the wire shape says it is
    // always there, and this holds if it is not.
    const absent = { key: 'country', value: 'France' } as EvertraceSearchFilterRow;
    expect(translate(absent).filter.country).toEqual(['France']);
  });

  it('turns an exclude into the ! prefix Evertrace negates with', () => {
    for (const operator of ['neq', 'ne', 'not', 'not_in', 'notin', 'excludes', 'is_not', '!=', '<>']) {
      expect(translate(row('country', operator, 'Japan')).filter.country).toEqual(['!Japan']);
    }
    expect(translate(row('region', 'not_in', '["Europe","Asia"]')).filter.region).toEqual([
      '!Europe',
      '!Asia',
    ]);
  });

  it('leaves an already-prefixed value alone', () => {
    expect(translate(row('city', 'not_in', '!Paris')).filter.city).toEqual(['!Paris']);
  });

  it('reports an exclude on a key with no exclude form', () => {
    const { filter, skipped } = translate(row('gender', 'not_in', 'man'));
    expect(filter).toEqual({});
    expect(skipped).toEqual([
      { key: 'gender', operator: 'not_in', reason: 'this key has no exclude form' },
    ]);
  });

  it('reports an operator it can read neither way', () => {
    const { filter, skipped } = translate(row('country', 'between', 'France'));
    expect(filter).toEqual({});
    expect(skipped).toEqual([
      { key: 'country', operator: 'between', reason: 'operator reads as neither include nor exclude' },
    ]);
  });

  it('takes a score lower bound as include, and reports an exclude on it', () => {
    for (const operator of ['gte', '>=', 'min', 'eq']) {
      expect(translate(row('score', operator, '7')).filter.score).toBe('7');
    }
    const { filter, skipped } = translate(row('score', 'not', '7'));
    expect(filter).toEqual({});
    expect(skipped[0].reason).toBe('score is a floor, so an exclude has no shape');
  });

  it('keeps the stricter of two score rows', () => {
    expect(translate(row('score', 'gte', '5'), row('score', 'gte', '8')).filter.score).toBe('8');
    expect(translate(row('score', 'gte', '8'), row('score', 'gte', '5')).filter.score).toBe('8');
  });
});

describe('narrowsAnything', () => {
  it('is false when every row was skipped, and true as soon as one lands', () => {
    const allSkipped = translate(row('country', 'between', 'France'));
    expect(narrowsAnything(allSkipped.filter)).toBe(false);
    expect(narrowsAnything(translate(row('country', 'in', 'France')).filter)).toBe(true);
  });
});
