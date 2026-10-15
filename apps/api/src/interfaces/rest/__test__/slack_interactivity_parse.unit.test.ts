// The block-action recognition seam — what a tap turned out to be.
// Load-bearing: a mis-parse silently drops what the person did, so pin every
// payload shape an author's wiring can produce (a callback id today, a
// `"${a.Url}?answer=…"` link on the legacy movements still running), and every
// Slack payload shape (button `value` vs static_select `selected_option.value`)
// it can arrive in — plus the TAP-TIME shapes (datepicker/timepicker/text
// input), whose value doesn't exist until the tap and so rides `action_id`
// instead: field names (`selected_date`, `selected_time`, dispatch-triggered
// `value`) verified against @slack/bolt-js's block-action payload types
// (src/types/actions/block-action.ts) since @slack/web-api ships no
// interactivity-payload types of its own.

import { logger } from 'movement-engine/services/logger';
import {
  blockActionValue,
  parseAskAction,
  resolveAskAction,
  resolveBlockAction,
} from '../slackInteractivity';

describe('parseAskAction', () => {
  it('parses a full ask answer URL (token off the path, answer off the query)', () => {
    expect(
      parseAskAction('http://localhost:3500/api/asks/ask_abc123?answer=true'),
    ).toEqual({ token: 'ask_abc123', answer: 'true' });
  });

  it('parses a bare token?answer form', () => {
    expect(parseAskAction('ask_xyz?answer=false')).toEqual({
      token: 'ask_xyz',
      answer: 'false',
    });
  });

  it('url-decodes the answer value', () => {
    expect(
      parseAskAction('https://api.example.com/api/asks/ask_9?answer=option%20two'),
    ).toEqual({ token: 'ask_9', answer: 'option two' });
  });

  it('returns null when the token is not a new-store ask token', () => {
    expect(parseAskAction('https://example.com/other/thing?answer=true')).toBeNull();
  });

  it('returns null when there is no answer param', () => {
    expect(parseAskAction('http://localhost/api/asks/ask_abc')).toBeNull();
  });

  it('returns null for an unrelated block action value', () => {
    expect(parseAskAction('approve_expense_42')).toBeNull();
  });
});

describe('blockActionValue', () => {
  it('reads a button action off its own `value`', () => {
    expect(blockActionValue({ value: 'https://api/asks/ask_x?answer=true' })).toBe(
      'https://api/asks/ask_x?answer=true',
    );
  });

  it('reads a static_select action off `selected_option.value`, not `value`', () => {
    expect(
      blockActionValue({ selected_option: { value: 'https://api/asks/ask_y?answer=Seed' } }),
    ).toBe('https://api/asks/ask_y?answer=Seed');
  });

  it('prefers the action`s own `value` when (implausibly) both are present', () => {
    expect(
      blockActionValue({ value: 'https://api/asks/ask_x?answer=true', selected_option: { value: 'other' } }),
    ).toBe('https://api/asks/ask_x?answer=true');
  });

  it('is undefined for an action with neither shape (some other block action)', () => {
    expect(blockActionValue({})).toBeUndefined();
  });

  it('is undefined when selected_option.value is not a string', () => {
    expect(blockActionValue({ selected_option: {} })).toBeUndefined();
  });
});

describe('resolveAskAction', () => {
  // ── pre-wired (today's button/select wiring), via `value` ────────────────
  it('resolves a button whose value is a full answer link', () => {
    expect(
      resolveAskAction({ action_id: 'approve_expense_42', value: 'http://localhost:3500/api/asks/ask_abc?answer=true' }),
    ).toEqual({ token: 'ask_abc', answer: 'true' });
  });

  it('resolves a static_select whose selected_option.value is a full answer link', () => {
    expect(
      resolveAskAction({
        action_id: 'ask_answer_0',
        selected_option: { value: 'http://localhost:3500/api/asks/ask_sel?answer=Seed' },
      }),
    ).toEqual({ token: 'ask_sel', answer: 'Seed' });
  });

  // ── tap-time: bare link in action_id, value supplied by the tap ──────────
  it('datepicker: action_id carries the bare link, selected_date is the answer', () => {
    expect(
      resolveAskAction({
        action_id: 'http://localhost:3500/api/asks/ask_date1',
        selected_date: '2026-08-15',
      }),
    ).toEqual({ token: 'ask_date1', answer: '2026-08-15' });
  });

  it('datepicker: bare token action_id (no host/path) also resolves', () => {
    expect(resolveAskAction({ action_id: 'ask_date2', selected_date: '2026-08-16' })).toEqual({
      token: 'ask_date2',
      answer: '2026-08-16',
    });
  });

  it('timepicker: action_id carries the bare link, selected_time is the answer', () => {
    expect(resolveAskAction({ action_id: 'ask_time1', selected_time: '14:30' })).toEqual({
      token: 'ask_time1',
      answer: '14:30',
    });
  });

  it('plain_text_input: dispatch_action payload shape — action_id link + entered `value`', () => {
    // Slack's dispatch-triggered plain_text_input block_actions payload puts
    // the entered text on the action's own `value` (@slack/bolt-js
    // PlainTextInputAction) — the same field name a button's pre-wired link
    // rides, which is exactly why the pre-wired parse must fail closed (the
    // entered text isn't an ask link) before falling through to action_id.
    expect(resolveAskAction({ action_id: 'ask_text1', value: 'my entered answer' })).toEqual({
      token: 'ask_text1',
      answer: 'my entered answer',
    });
  });

  it('select keyed off action_id: bare token action_id + selected_option.value as the tap-time answer', () => {
    expect(
      resolveAskAction({ action_id: 'ask_sel2', selected_option: { value: 'Seed' } }),
    ).toEqual({ token: 'ask_sel2', answer: 'Seed' });
  });

  // ── action_id carrying its own fixed answer ───────────────────────────────
  it('action_id WITH ?answer= is honoured directly (no tap-time value needed)', () => {
    expect(resolveAskAction({ action_id: 'ask_fixed?answer=true' })).toEqual({
      token: 'ask_fixed',
      answer: 'true',
    });
  });

  // ── precedence ─────────────────────────────────────────────────────────
  it('precedence: a pre-wired value wins over a (different) ask token on action_id', () => {
    expect(
      resolveAskAction({
        action_id: 'ask_from_action_id',
        value: 'http://localhost:3500/api/asks/ask_from_value?answer=true',
      }),
    ).toEqual({ token: 'ask_from_value', answer: 'true' });
  });

  // ── non-ask / malformed ───────────────────────────────────────────────────
  it('non-ask action_id (no token prefix) is ignored silently — the ordinary block action', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    expect(resolveAskAction({ action_id: 'approve_expense_42' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an ask-shaped action_id with no tap-time value logs loudly and is ignored', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    // e.g. a plain button mistakenly wired with a bare token on action_id
    // instead of a `?answer=` link on `value`.
    expect(resolveAskAction({ action_id: 'ask_garbled' })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no tap-time value'), expect.anything());
    warn.mockRestore();
  });

  it('an action with neither a parseable value nor an action_id is ignored', () => {
    expect(resolveAskAction({})).toBeNull();
  });
});

// ── Recognition, post-callback ────────────────────────────────────────────
//
// `resolveBlockAction` is the door's ONE entry point: the callback prefix
// first, on both slots, then the legacy ask link. The precedence is the whole
// migration story — a re-authored movement's callback id must never be read as
// anything else, and a movement not yet re-authored must keep working.
describe('resolveBlockAction — callback recognition beats legacy, legacy still works', () => {
  it('a button whose value is a callback id resolves to a callback, no supplied value', () => {
    expect(resolveBlockAction({ action_id: 'ship_it', value: 'cb_abc123' })).toEqual({
      kind: 'callback',
      id: 'cb_abc123',
    });
  });

  it('a static_select option carrying a callback id resolves it off selected_option', () => {
    expect(
      resolveBlockAction({ action_id: 'tier', selected_option: { value: 'cb_seed' } }),
    ).toEqual({ kind: 'callback', id: 'cb_seed' });
  });

  it('a datepicker carries the id on action_id and the picked date rides along', () => {
    expect(resolveBlockAction({ action_id: 'cb_date1', selected_date: '2026-08-15' })).toEqual({
      kind: 'callback',
      id: 'cb_date1',
      suppliedValue: '2026-08-15',
    });
  });

  it('a timepicker does the same with selected_time', () => {
    expect(resolveBlockAction({ action_id: 'cb_time1', selected_time: '14:30' })).toEqual({
      kind: 'callback',
      id: 'cb_time1',
      suppliedValue: '14:30',
    });
  });

  it('a dispatch-triggered text input supplies its entered `value`', () => {
    expect(resolveBlockAction({ action_id: 'cb_text1', value: 'what I typed' })).toEqual({
      kind: 'callback',
      id: 'cb_text1',
      suppliedValue: 'what I typed',
    });
  });

  it('a callback id on action_id with nothing captured supplies nothing (the router refuses if it wanted one)', () => {
    expect(resolveBlockAction({ action_id: 'cb_bare' })).toEqual({
      kind: 'callback',
      id: 'cb_bare',
    });
  });

  it('PRECEDENCE: a pre-wired callback id wins over a callback id on action_id', () => {
    expect(resolveBlockAction({ action_id: 'cb_from_action_id', value: 'cb_from_value' })).toEqual({
      kind: 'callback',
      id: 'cb_from_value',
    });
  });

  it('PRECEDENCE: a callback id beats a legacy ask link sitting on the other slot', () => {
    expect(
      resolveBlockAction({
        action_id: 'ask_legacy?answer=true',
        value: 'cb_current',
      }),
    ).toEqual({ kind: 'callback', id: 'cb_current' });
  });

  it('LEGACY: a pre-wired ask answer link still resolves, after the prefix check declines', () => {
    expect(
      resolveBlockAction({
        action_id: 'ask_answer_0',
        value: 'http://localhost:3500/api/asks/ask_abc?answer=true',
      }),
    ).toEqual({ kind: 'ask', token: 'ask_abc', answer: 'true' });
  });

  it('LEGACY: the tap-time action_id pairing still resolves', () => {
    expect(resolveBlockAction({ action_id: 'ask_date2', selected_date: '2026-08-16' })).toEqual({
      kind: 'ask',
      token: 'ask_date2',
      answer: '2026-08-16',
    });
  });

  it('an ordinary block action is neither, and flows on untouched', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation();
    expect(resolveBlockAction({ action_id: 'approve_expense_42', value: 'expense_42' })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
