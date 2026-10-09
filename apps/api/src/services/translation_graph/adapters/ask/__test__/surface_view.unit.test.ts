// The new-store ask → surface projection: the family fixes the control and the
// answer shape (3_adapter_contract §B), so pin that mapping. Pure — no DB.

import type { AskRecord } from '../store';

import {
  askInteractionType,
  askViewOptions,
  askViewCorrect,
  askResultType,
  FAMILY_TO_INTERACTION,
} from '../surface_view';

function ask(partial: Partial<AskRecord>): AskRecord {
  return {
    id: 'ask-1' as AskRecord['id'],
    teamId: 'team-1' as AskRecord['teamId'],
    family: 'Check',
    answerType: null,
    prompt: 'Proceed?',
    detail: null,
    options: null,
    rows: null,
    state: 'open',
    answer: null,
    token: 'ask_tok',
    url: 'http://x/api/asks/ask_tok',
    tokenExpiresAt: new Date(Date.now() + 1000),
    provenance: {},
    callbackUrl: null,
    createdAt: new Date(),
    answeredAt: null,
    expiredAt: null,
    ...partial,
  };
}

describe('askInteractionType', () => {
  it('maps every family to a control kind', () => {
    for (const family of Object.keys(FAMILY_TO_INTERACTION)) {
      expect(askInteractionType(ask({ family: family as AskRecord['family'] }))).toBe(
        FAMILY_TO_INTERACTION[family as AskRecord['family']],
      );
    }
  });
});

describe('askViewOptions', () => {
  it('projects Choose/Select/Form options as { id, label, value }', () => {
    expect(askViewOptions(ask({ family: 'Choose', options: ['a', 'b'] }))).toEqual([
      { id: 'a', label: 'a', value: 'a' },
      { id: 'b', label: 'b', value: 'b' },
    ]);
  });

  it('is undefined for a family that offers no options', () => {
    expect(askViewOptions(ask({ family: 'Check' }))).toBeUndefined();
    expect(askViewOptions(ask({ family: 'Provide', answerType: 'text' }))).toBeUndefined();
  });
});

describe('askViewCorrect', () => {
  it('derives columns from the union of row field keys, first-seen order', () => {
    const view = askViewCorrect(
      ask({
        family: 'Correct',
        rows: [
          { ephemeralId: 'r1', fields: { Name: 'Acme', Stage: 'Seed' } },
          { ephemeralId: 'r2', fields: { Name: 'Beta', Owner: 'Jo' } },
        ],
      }),
    );
    expect(view?.columns).toEqual(['Name', 'Stage', 'Owner']);
    expect(view?.rows[0]).toEqual({
      ephemeralId: 'r1',
      fields: { Name: 'Acme', Stage: 'Seed' },
      label: 'Acme',
    });
  });

  it('is undefined for any non-Correct family', () => {
    expect(askViewCorrect(ask({ family: 'Check' }))).toBeUndefined();
  });
});

describe('askResultType', () => {
  it('advertises the truthful result type per family — not "string" for all', () => {
    // The founding defect: every family but Provide advertised `string` because
    // only Provide populates answerType. Each family now advertises its own type.
    expect(askResultType(ask({ family: 'Check' }))).toEqual({ graph: 'boolean' });
    expect(askResultType(ask({ family: 'Choose', options: ['a', 'b'] }))).toEqual({ graph: 'string' });
    expect(askResultType(ask({ family: 'Select', options: ['a', 'b'] }))).toEqual({
      graph: 'list of string',
    });
    expect(askResultType(ask({ family: 'Review' }))).toEqual({ graph: 'string' });
    expect(askResultType(ask({ family: 'Correct' }))).toEqual({ graph: 'record' });
    expect(askResultType(ask({ family: 'Draft' }))).toEqual({ graph: 'record' });
    expect(askResultType(ask({ family: 'Form' }))).toEqual({ graph: 'record' });
  });

  it('carries the declared Provide answer type, defaulting to text (matching coerceProvide)', () => {
    expect(askResultType(ask({ family: 'Provide', answerType: 'number' }))).toEqual({
      graph: 'number',
    });
    expect(askResultType(ask({ family: 'Provide', answerType: 'boolean' }))).toEqual({
      graph: 'boolean',
    });
    expect(askResultType(ask({ family: 'Provide', answerType: null }))).toEqual({ graph: 'text' });
  });
});
