// The capability-link doors: the link's own id or token is the authorisation.
// /api/cb/<id> fires callbacks (GET never does); /api/asks/<token> answers asks.

import type { GoldenCase, RequestSpec } from '../harness';

import { GOLDEN_CALLBACK, world } from '../world';
import { define, json, post, text } from './support';

const FAR_FUTURE = new Date('2031-01-01T00:00:00Z');
const PAST = new Date('2020-01-01T00:00:00Z');
const CB = '/api/cb/cb_golden0001';

const callbackRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'cb_golden0001',
  status: 'live' as const,
  expiresAt: null,
  params: [] as { name: string; type: string }[],
  ...overrides,
});
const givenCallback = (overrides: Record<string, unknown> = {}) => {
  world.callbacks.cb_golden0001 = callbackRecord(overrides) as never;
};
const outcomeWith = (kind: string, extra: Record<string, unknown> = {}) => () => ({ kind, callback: GOLDEN_CALLBACK, ...extra });
const get = (path: string, accept?: string): RequestSpec => ({
  method: 'GET',
  path,
  headers: accept === undefined ? {} : { accept },
  body: { kind: 'none' },
});

export const callbackCases: GoldenCase[] = define('callbacks', [
  { id: 'get-unknown-id', note: 'An id this store never minted renders the invalid-link page, 404.', request: get('/api/cb/cb_missing') },
  { id: 'get-foreign-id-shape', note: 'An id without the cb_ prefix never reaches a query: the same 404.', request: get('/api/cb/anything') },
  {
    id: 'get-live-no-params',
    note: 'A live callback with no parameters renders one Confirm button that POSTs; the GET fires nothing.',
    arrange: () => givenCallback(),
    request: get(CB),
  },
  {
    id: 'get-live-with-params',
    note: 'One control per declared parameter, typed from the signature, in declaration order.',
    arrange: () =>
      givenCallback({
        params: [
          { name: 'note', type: 'text' },
          { name: 'approved', type: 'boolean' },
          { name: 'amount', type: 'number' },
          { name: 'due', type: 'date' },
          { name: 'at', type: 'datetime' },
          { name: 'extra', type: 'json' },
          { name: 'attachment', type: 'file' },
        ],
      }),
    request: get(CB),
  },
  { id: 'get-already-fired', note: 'A spent callback renders the closed page, 410.', arrange: () => givenCallback({ status: 'fired' }), request: get(CB) },
  { id: 'get-revoked', note: 'A revoked callback renders the finished-workflow page, 410.', arrange: () => givenCallback({ status: 'revoked' }), request: get(CB) },
  { id: 'get-expired', note: 'A lapsed callback renders the expired page, 410.', arrange: () => givenCallback({ expiresAt: PAST }), request: get(CB) },
  {
    id: 'get-expiry-in-future-still-live',
    note: 'A callback with a future expiry is still confirmable.',
    arrange: () => givenCallback({ expiresAt: FAR_FUTURE }),
    request: get(CB),
  },
  {
    id: 'post-recorded-json',
    note: 'A JSON caller (a BYO server) gets {outcome, message} with 200.',
    request: post(CB, json({ note: 'ok' }), { accept: 'application/json' }),
  },
  {
    id: 'post-recorded-queued',
    note: 'A fire queued behind a running step answers 202.',
    arrange: () => {
      world.fireCallback = outcomeWith('recorded', { queued: true });
    },
    request: post(CB, json({}), { accept: 'application/json' }),
  },
  {
    id: 'post-recorded-html',
    note: 'A browser form post (Accept: text/html) gets a Done page.',
    request: post(CB, { kind: 'form', fields: { note: 'ok' } }, { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }),
  },
  {
    id: 'post-values-from-query-and-body',
    note: 'Values are taken from the query string and the body, the body winning on a clash; every key passes through raw.',
    request: post(`${CB}?a=1&note=from-query`, json({ note: 'from-body', n: 2 }), { accept: 'application/json' }),
  },
  { id: 'post-not-found', note: 'An unknown id is 404.', arrange: () => { world.fireCallback = () => ({ kind: 'not_found' }); }, request: post(CB, json({}), { accept: 'application/json' }) },
  { id: 'post-closed', note: 'A settled callback is 410.', arrange: () => { world.fireCallback = outcomeWith('closed'); }, request: post(CB, json({}), { accept: 'application/json' }) },
  { id: 'post-expired', note: 'A lapsed callback is 410 with its own message.', arrange: () => { world.fireCallback = outcomeWith('expired'); }, request: post(CB, json({}), { accept: 'application/json' }) },
  {
    id: 'post-mismatch',
    note: 'A value that does not fit the signature is 400 and says exactly what was expected.',
    arrange: () => {
      world.fireCallback = outcomeWith('mismatch', { message: 'amount must be a number' });
    },
    request: post(CB, json({ amount: 'x' }), { accept: 'application/json' }),
  },
  {
    id: 'post-mismatch-html',
    note: 'The same refusal as a page.',
    arrange: () => {
      world.fireCallback = outcomeWith('mismatch', { message: 'amount must be a number' });
    },
    request: post(CB, json({ amount: 'x' }), { accept: 'text/html' }),
  },
  {
    id: 'post-firing-throws-json',
    note: 'A thrown firing is a 500 {outcome:error}; the call may already be on the ledger.',
    arrange: () => {
      world.fireCallback = () => {
        throw new Error('ledger down');
      };
    },
    request: post(CB, json({}), { accept: 'application/json' }),
  },
  {
    id: 'post-firing-throws-html',
    note: 'The same failure as a page.',
    arrange: () => {
      world.fireCallback = () => {
        throw new Error('ledger down');
      };
    },
    request: post(CB, text(''), { accept: 'text/html' }),
  },
]);

// ── asks ──────────────────────────────────────────────────────────────────

const askRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'ask-id-1',
  teamId: 'team-1',
  family: 'Choose',
  answerType: 'text',
  prompt: 'Which plan should we use?',
  detail: null,
  options: ['Basic', 'Pro'],
  rows: null,
  state: 'open',
  answer: null,
  token: 'ask_golden1',
  url: 'https://golden.example.test/api/asks/ask_golden1',
  tokenExpiresAt: FAR_FUTURE,
  provenance: {},
  callbackUrl: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  answeredAt: null,
  expiredAt: null,
  ...overrides,
});
const givenAsk = (overrides: Record<string, unknown> = {}) => {
  world.asks.ask_golden1 = askRecord(overrides);
};
const ASK = '/api/asks/ask_golden1';

export const askCases: GoldenCase[] = define('asks', [
  { id: 'get-detail-open', note: 'The JSON the web renderer fetches for an open ask.', arrange: () => givenAsk(), request: get(`${ASK}/detail`) },
  { id: 'get-detail-legacy-token', note: 'A token this store did not mint is closed: 410.', request: get('/api/asks/legacy-token/detail') },
  { id: 'get-detail-answered', note: 'An answered ask is 410 already_resolved.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: get(`${ASK}/detail`) },
  { id: 'get-detail-closed-request', note: 'A withdrawn ask is 410 (reported as expired).', arrange: () => givenAsk({ state: 'expired' }), request: get(`${ASK}/detail`) },
  { id: 'get-detail-link-lapsed', note: 'An open ask whose link lapsed is 410.', arrange: () => givenAsk({ tokenExpiresAt: PAST }), request: get(`${ASK}/detail`) },
  { id: 'get-page-choose', note: 'A Choose ask renders a button per option; the GET answers nothing.', arrange: () => givenAsk(), request: get(ASK) },
  { id: 'get-page-check', note: 'A Check ask renders Approve / Decline.', arrange: () => givenAsk({ family: 'Check', answerType: 'boolean', options: null }), request: get(ASK) },
  { id: 'get-page-provide', note: 'A Provide ask renders a typed input.', arrange: () => givenAsk({ family: 'Provide', answerType: 'text', options: null }), request: get(ASK) },
  { id: 'get-page-select', note: 'A Select ask renders a checklist.', arrange: () => givenAsk({ family: 'Select', options: ['x', 'y', 'z'] }), request: get(ASK) },
  { id: 'get-page-with-answer-param-confirms', note: 'A link carrying ?answer= renders a confirm step and never resolves (prefetch safety).', arrange: () => givenAsk(), request: get(`${ASK}?answer=Pro`) },
  { id: 'get-page-answered', note: 'An answered ask renders the recorded answer, 410.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: get(ASK) },
  { id: 'get-page-closed-request', note: 'A withdrawn ask renders the closed page, 410.', arrange: () => givenAsk({ state: 'expired' }), request: get(ASK) },
  { id: 'get-page-link-lapsed', note: 'A lapsed link renders the expired page, 410.', arrange: () => givenAsk({ tokenExpiresAt: PAST }), request: get(ASK) },
  { id: 'get-page-legacy-token', note: 'A legacy token renders the closed page, 410.', request: get('/api/asks/legacy-token') },
  { id: 'post-without-answer', note: 'A POST with no answer anywhere is 400.', arrange: () => givenAsk(), request: post(ASK, json({})) },
  {
    id: 'post-answer-json',
    note: 'A JSON answer goes through the one answer door and renders the confirmation, 200.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Pro' }) });
    },
    request: post(ASK, json({ answer: 'Pro' })),
  },
  {
    id: 'post-answer-form',
    note: 'The page forms post urlencoded.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Basic' }) });
    },
    request: post(ASK, { kind: 'form', fields: { answer: 'Basic' } }, { 'content-type': 'application/x-www-form-urlencoded' }),
  },
  {
    id: 'post-answer-in-query',
    note: 'The confirm form may carry the answer in the query string.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'answered', ask: askRecord({ state: 'answered', answer: 'Pro' }) });
    },
    request: post(`${ASK}?answer=Pro`, text('')),
  },
  {
    id: 'post-answer-invalid',
    note: 'A value that does not fit is 400 with the reason.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'invalid', message: 'not one of the offered options', ask: askRecord() });
    },
    request: post(ASK, json({ answer: 'Platinum' })),
  },
  {
    id: 'post-answer-lost-the-race',
    note: 'An ask settled between lookup and write renders its terminal page, closed-request-wins.',
    arrange: () => {
      givenAsk();
      world.askAnswer = () => ({ kind: 'closed', ask: askRecord({ state: 'answered', answer: 'Basic' }) });
    },
    request: post(ASK, json({ answer: 'Pro' })),
  },
  { id: 'post-already-answered', note: 'A POST to an answered ask is its terminal page, 410, and never reaches the answer door.', arrange: () => givenAsk({ state: 'answered', answer: 'Pro' }), request: post(ASK, json({ answer: 'Basic' })) },
  { id: 'post-legacy-token', note: 'A legacy token is closed: 410.', request: post('/api/asks/legacy-token', json({ answer: 'x' })) },
]);
