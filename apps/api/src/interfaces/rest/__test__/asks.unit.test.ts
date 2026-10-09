// `GET/POST /api/asks/:token` — the human capability-link surface for the ask
// ADAPTER (asks-as-adapter). Every token is `ask_`-prefixed and served off the
// new store (the legacy `interaction_request`/`interaction_token` store and its
// route half were deleted in chunk G — a legacy token now 410s).
//
// The router's load-bearing properties: a GET NEVER resolves (prefetch safety —
// a link-unfurl must not fire an answer), only a POST calls the answer door; a
// param-bearing GET renders a confirm form; a family's control renders faithfully;
// closed/gone requests map to clean status codes (410). `lookupAskByToken` and
// `answerAsk` are mocked (same technique as `ask_adapter.unit.test.ts`) so the
// test pins the HTTP shell + prefetch contract without a database.

import { AddressInfo } from 'node:net';

import express from 'express';

import type { Server } from 'node:http';

const lookupAskByTokenMock = jest.fn();
const answerAskMock = jest.fn();

jest.mock('../../../services/translation_graph/adapters/ask/store', () => {
  const actual = jest.requireActual('../../../services/translation_graph/adapters/ask/store');
  return {
    ...actual,
    lookupAskByToken: (...args: unknown[]) => lookupAskByTokenMock(...args),
    answerAsk: (...args: unknown[]) => answerAskMock(...args),
  };
});

import { asksRouter } from '../asks';

describe('/api/asks/:token', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use('/api/asks', asksRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    lookupAskByTokenMock.mockReset();
    answerAskMock.mockReset();
    // Default: no ask found. A non-`ask_` (legacy) token resolves to null and
    // the route 410s; new-store tests override with an `ask_`-prefixed record.
    lookupAskByTokenMock.mockResolvedValue(null);
  });

  describe('a legacy (non-new-store) token is closed', () => {
    it('410s a legacy `tok-…` link — its store is gone (chunk G)', async () => {
      const res = await fetch(`${base}/api/asks/tok-abc`);
      const html = await res.text();
      expect(res.status).toBe(410);
      expect(html).toContain('closed');
      expect(answerAskMock).not.toHaveBeenCalled();
    });
  });

  describe('new-store bridge — Check / Choose / Select / Provide / Review / Correct / Draft / Form', () => {
    function newStoreAsk(family: string, extra: Record<string, unknown> = {}) {
      return {
        id: 'ask-1',
        teamId: 'team-1',
        family,
        answerType: null,
        prompt: 'A question',
        detail: null,
        options: null,
        rows: null,
        state: 'open',
        answer: null,
        token: 'ask_tok',
        url: 'http://x/api/asks/ask_tok',
        tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
        provenance: {},
        createdAt: new Date(),
        answeredAt: null,
        expiredAt: null,
        ...extra,
      };
    }

    it('advertises the truthful per-family result type (Check → boolean, not the old blanket string)', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Check', { prompt: 'Pursue Acme?' }));
      const res = await fetch(`${base}/api/asks/ask_check/detail`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ interactionType: 'check', resultType: { graph: 'boolean' } });
    });

    // Prefetch safety — the load-bearing property: a GET (bare or param-bearing)
    // NEVER answers; only a POST reaches the answer door.
    it('a param-bearing GET on a Check renders a confirm form and does NOT answer', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Check', { prompt: 'Pursue Acme?' }));
      const res = await fetch(`${base}/api/asks/ask_check?answer=true`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('<form method="post"');
      expect(html).toContain('value="true"');
      expect(answerAskMock).not.toHaveBeenCalled();
    });

    it('Check → a bare GET renders Approve / Decline, never answering', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Check', { prompt: 'Pursue Acme?' }));
      const res = await fetch(`${base}/api/asks/ask_check`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('value="true"');
      expect(html).toContain('value="false"');
      expect(html).toContain('Approve');
      expect(html).toContain('Decline');
      expect(answerAskMock).not.toHaveBeenCalled();
    });

    it('Provide → a typed input matching the declared answer type', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Provide', { prompt: 'Approved amount?', answerType: 'number' }),
      );
      const res = await fetch(`${base}/api/asks/ask_provide`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('type="number"');
      expect(html).toContain('name="answer"');
    });

    it('Provide<boolean> → Yes / No buttons, no free-text input', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Provide', { prompt: 'Is this a fit?', answerType: 'boolean' }),
      );
      const res = await fetch(`${base}/api/asks/ask_provide_bool`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('value="true"');
      expect(html).toContain('value="false"');
      expect(html).toContain('Yes');
      expect(html).toContain('No');
      expect(html).not.toContain('type="text"');
      expect(html).not.toContain('type="number"');
      expect(html).not.toContain('type="date"');
    });

    it('Review → a single acknowledge', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Review', { prompt: 'Review the summary' }));
      const res = await fetch(`${base}/api/asks/ask_review`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('value="ack"');
    });

    it('Choose → a button per offered option, posting exactly one', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Choose', { prompt: 'Which team?', options: ['red', 'blue'] }),
      );
      const res = await fetch(`${base}/api/asks/ask_choose`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('Which team?');
      expect(html).toContain('value="red"');
      expect(html).toContain('value="blue"');
      // A button-per-option control, not a checklist.
      expect(html).not.toContain('type="checkbox"');
      expect(answerAskMock).not.toHaveBeenCalled();
    });

    it('Select → a checkbox checklist, posting the chosen subset (possibly none)', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Select', { prompt: 'Which teams?', options: ['red', 'blue', 'green'] }),
      );
      const res = await fetch(`${base}/api/asks/ask_select`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('type="checkbox"');
      expect(html).toContain('value="red"');
      expect(html).toContain('value="blue"');
      expect(html).toContain('value="green"');
      // The hidden empty field that makes "none of these" submittable.
      expect(html).toContain('<input type="hidden" name="answer" value="">');
    });

    it('Correct → an editable table seeded from the offered rows', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Correct', {
          prompt: 'Review these',
          rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme' } }],
        }),
      );
      const res = await fetch(`${base}/api/asks/ask_correct`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('Acme');
      expect(html).toContain('row-0');
      expect(html).toContain('<script>');
    });

    it('Draft → the app-only placeholder, no rich editor here', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Draft', { prompt: 'Draft the memo' }));
      const res = await fetch(`${base}/api/asks/ask_draft`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('Listen-Fire app');
      expect(html).not.toContain('<form');
    });

    it('Form → a text input per declared field, JS-collected into one object', async () => {
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Form', { prompt: 'Decide', options: ['call', 'cap'] }));
      const res = await fetch(`${base}/api/asks/ask_form`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('data-field="call"');
      expect(html).toContain('data-field="cap"');
      expect(html).toContain('<script>');
    });

    it('POST answers a Choose ask and renders the recorded answer', async () => {
      const ask = newStoreAsk('Choose', { options: ['red', 'blue'] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...ask, state: 'answered', answer: 'red' } });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'red' }),
      });
      expect(res.status).toBe(200);
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: 'red' });
      expect(await res.text()).toContain('recorded');
    });

    it('POST answers a Select ask with the chosen subset', async () => {
      const ask = newStoreAsk('Select', { options: ['red', 'blue', 'green'] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...ask, state: 'answered', answer: ['red', 'blue'] } });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // Mirrors the checklist form: the hidden empty field plus the checked boxes.
        body: 'answer=&answer=red&answer=blue',
      });
      expect(res.status).toBe(200);
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: ['', 'red', 'blue'] });
      expect(await res.text()).toContain('recorded');
    });

    it('POST answers a Select ask with an empty selection ("none of these")', async () => {
      const ask = newStoreAsk('Select', { options: ['red', 'blue'] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...ask, state: 'answered', answer: [] } });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'answer=',
      });
      expect(res.status).toBe(200);
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: '' });
    });

    it('POST answers a Form ask with the collected field object', async () => {
      const ask = newStoreAsk('Form', { options: ['call', 'cap'] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      const answer = { call: 'Pursue', cap: '250000' };
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...ask, state: 'answered', answer } });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      expect(res.status).toBe(200);
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: answer });
    });

    it('POST answers a Correct ask with { rows, dropped } and renders a summary', async () => {
      const ask = newStoreAsk('Correct', { rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme' } }] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      const answer = { rows: [{ ephemeralId: 'row-0', fields: { name: 'Acme Inc' } }], dropped: [] };
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...ask, state: 'answered', answer } });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      expect(res.status).toBe(200);
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: answer });
      expect(await res.text()).toContain('updated');
    });

    it('a rejected (invalid) answer renders 400, never a live control fallthrough', async () => {
      const ask = newStoreAsk('Form', { options: ['call', 'cap'] });
      lookupAskByTokenMock.mockResolvedValue(ask);
      answerAskMock.mockResolvedValue({ ok: false, reason: 'invalid', message: 'missing answers for: cap' });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: { call: 'Pursue' } }),
      });
      expect(res.status).toBe(400);
    });

    it('closed state — an already-answered ask renders the recorded answer, never a live control', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Choose', { options: ['red', 'blue'], state: 'answered', answer: 'blue' }),
      );
      const res = await fetch(`${base}/api/asks/ask_tok`);
      const html = await res.text();
      expect(res.status).toBe(410);
      expect(html).toContain('blue');
      expect(html).not.toContain('<form');
      expect(answerAskMock).not.toHaveBeenCalled();
    });

    it('closed state — an expired ask 410s without a control', async () => {
      lookupAskByTokenMock.mockResolvedValue(
        newStoreAsk('Draft', { state: 'expired', expiredAt: new Date() }),
      );
      const res = await fetch(`${base}/api/asks/ask_tok`);
      expect(res.status).toBe(410);
    });

    it('closed state — a stale re-POST loses the race and 410s', async () => {
      const settled = newStoreAsk('Choose', { options: ['red', 'blue'], state: 'answered', answer: 'red' });
      lookupAskByTokenMock.mockResolvedValue(newStoreAsk('Choose', { options: ['red', 'blue'] }));
      answerAskMock.mockResolvedValue({ ok: false, reason: 'settled', ask: settled });
      const res = await fetch(`${base}/api/asks/ask_tok`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: 'blue' }),
      });
      expect(res.status).toBe(410);
      expect(await res.text()).toContain('red');
    });
  });
});
