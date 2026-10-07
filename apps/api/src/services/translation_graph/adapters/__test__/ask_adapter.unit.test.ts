// The ask adapter's record duties (asks-as-adapter §B): the family write
// (`-[:Check]->` …), the cancellation update (`{ Cancelled: true }`), and the
// promise-honest descriptor surface (families writable-not-readable; the
// awaitable `Response` edge). The store's DB functions are mocked so this pins
// the ADAPTER's routing/validation without a database; the lattice itself is
// proven against a real DB in `ask/__test__/store_lattice.integration.test.ts`
// and end-to-end in the dev loop.

const createAskMock = jest.fn();
const cancelAskMock = jest.fn();
const getAskMock = jest.fn();
const answerAskMock = jest.fn();

jest.mock('../ask/store', () => {
  const actual = jest.requireActual('../ask/store');
  return {
    ...actual,
    createAsk: (...a: unknown[]) => createAskMock(...a),
    cancelAsk: (...a: unknown[]) => cancelAskMock(...a),
    getAsk: (...a: unknown[]) => getAskMock(...a),
    answerAsk: (...a: unknown[]) => answerAskMock(...a),
  };
});

// A cancel goes through the cancel door, which queues the engine's wake.
const enqueueAwaitWakeMock = jest.fn();
jest.mock('../../../movement_engine/await_wake', () => ({
  enqueueAwaitWake: (...a: unknown[]) => enqueueAwaitWakeMock(...a),
}));
jest.mock('../../../work/drain', () => ({ notifyWork: jest.fn() }));

import { AskAdapter } from '../ask';
import { AskResponseRefused } from '../ask/answer_door';
import { UPDATE_NOT_FOUND } from '../not_found';
import { makeStablePosition, makeUnstablePosition } from '../../types';
import type { WriteInput, UpdateInput } from '../../adapter';
import type { TeamId } from '../../../../generated/kysely/core/Team';

const TEAM = 'team-1' as TeamId;

function adapter(): AskAdapter {
  return new AskAdapter(TEAM);
}

function ctx(): WriteInput['mutationContext'] {
  return {
    source: {
      type: 'agent',
      translationGraphId: 'mv-1',
      translationGraphNodeId: 'node-1',
      adapterType: 'ask',
    },
    occurredAt: new Date().toISOString(),
  };
}

function writeInput(recordType: string, fields: Record<string, unknown>): WriteInput {
  return { recordType, fields, mutationContext: ctx() };
}

const STORED = {
  id: 'ask-1',
  teamId: TEAM,
  family: 'Check',
  state: 'open',
  url: 'http://x/api/asks/ask_tok',
  token: 'ask_tok',
  prompt: 'Ship it?',
  detail: null,
};

beforeEach(() => {
  createAskMock.mockReset();
  cancelAskMock.mockReset();
  getAskMock.mockReset();
  answerAskMock.mockReset();
});

describe('the awaitable capability — the state lattice IS the resolution', () => {
  const point = { recordId: 'ask-1', edge: 'Response' };

  it('an OPEN ask resolves PENDING, keyed by the ask id (the engine parks on it)', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'open' });
    expect(await adapter().awaitable!.resolveAwait(point)).toEqual({ status: 'pending', correlationKey: 'ask-1' });
  });

  it('an ANSWERED ask resolves LANDED, carrying the typed answer under the DECLARED field name', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'answered', answer: true });
    const res = await adapter().awaitable!.resolveAwait(point);
    // The landing dict is keyed by the Response descriptor's declared field
    // name ('Answer' === displayName), so `got.Answer` — the name the checker
    // typed and the author wrote — reaches the value end-to-end. A lowercase
    // `answer` here was the founding surface-vs-store disagreement in miniature.
    // `recordType` names the landing's type — the ask's OWN family's Response
    // type ('Check Response'), so the engine binds a position the ask's
    // getFieldValue reads by the declared name.
    expect(res).toEqual({
      status: 'landed',
      correlationKey: 'ask-1',
      landings: [{ recordId: 'ask-1', recordType: 'Check Response', fields: { Answer: true } }],
    });
  });

  it('a different family lands on ITS OWN Response type', async () => {
    getAskMock.mockResolvedValue({ ...STORED, family: 'Draft', state: 'answered', answer: { note: 'x' } });
    const res = await adapter().awaitable!.resolveAwait(point);
    expect(res).toEqual({
      status: 'landed',
      correlationKey: 'ask-1',
      landings: [{ recordId: 'ask-1', recordType: 'Draft Response', fields: { Answer: { note: 'x' } } }],
    });
  });

  it('the landed answer reads back through getFieldValue under the DECLARED name', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'answered', answer: 'shipped' });
    const res = await adapter().awaitable!.resolveAwait(point);
    const landing = (res as { landings: Array<{ fields: Record<string, unknown> }> }).landings[0];
    const position = makeUnstablePosition({ adapterType: 'ask', recordType: 'Check Response', data: landing.fields });
    // The engine binds the landing as an unstable Response position; `got.Answer`
    // resolves through the adapter's read seam to the real typed answer.
    expect(await adapter().getFieldValue({ position, fieldId: 'Answer' })).toBe('shipped');
  });

  it("a Form's declared fields read back as PROPERTIES of its Response, not a json dig", async () => {
    // The type side mints one text property per declared field name
    // (`askResponseDescriptorFor`); this is the read that has to honour it.
    // `Answer` stays the stored carrier — these are views onto it.
    const answer = { Budget: '50k', Timeline: 'Q3' };
    getAskMock.mockResolvedValue({
      ...STORED, family: 'Form', options: ['Budget', 'Timeline'], state: 'answered', answer,
    });
    const res = await adapter().awaitable!.resolveAwait(point);
    const landing = (res as { landings: Array<{ fields: Record<string, unknown> }> }).landings[0];
    const position = makeUnstablePosition({
      adapterType: 'ask', recordType: 'Form Response', data: landing.fields,
    });
    const read = (fieldId: string) => adapter().getFieldValue({ position, fieldId });
    expect(await read('Budget')).toBe('50k');
    expect(await read('Timeline')).toBe('Q3');
    expect(await read('Answer')).toEqual(answer);
    // A name the form never declared reads null (the checker refuses it first).
    expect(await read('Nope')).toBeNull();
  });

  it("a Form field sharing a name with an ask's own field reads the ANSWER, not the ask", async () => {
    // `State`/`Url`/`Prompt` are the ask's fields, not the Response's — a form
    // may legitimately collect a field called 'State' and must get its answer.
    getAskMock.mockResolvedValue({
      ...STORED, family: 'Form', options: ['State'], state: 'answered', answer: { State: 'California' },
    });
    const position = makeStablePosition({
      adapterType: 'ask', recordType: 'Form Response', recordId: 'ask-1',
    });
    expect(await adapter().getFieldValue({ position, fieldId: 'State' })).toBe('California');
  });

  it('an EXPIRED ask resolves EMPTY (resolvesEmpty — the explicit cancel, F6)', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'expired' });
    expect(await adapter().awaitable!.resolveAwait(point)).toEqual({ status: 'empty' });
  });

  it('a deleted ask resolves EMPTY rather than parking forever', async () => {
    getAskMock.mockResolvedValue(null);
    expect(await adapter().awaitable!.resolveAwait(point)).toEqual({ status: 'empty' });
  });
});

describe('listEntryPoints', () => {
  it('publishes all eight families writable-but-not-readable, plus each family\'s own Response type', async () => {
    const entries = await adapter().listEntryPoints();
    const byName = Object.fromEntries(entries.map((e) => [e.displayName, e]));
    for (const family of ['Check', 'Provide', 'Choose', 'Select', 'Review', 'Correct', 'Draft', 'Form']) {
      expect(byName[family]).toMatchObject({ writable: true, readable: false });
      // No root readability in v1 — asks can't be enumerated from the root.
      expect(byName[`${family} Response`]).toMatchObject({ writable: false, readable: false });
    }
    // Pick is dropped (ruling 2026-07-30) — its idiom is composition (Choose/
    // Select over the name field, then filter downstream), not its own family.
    expect(byName.Pick).toBeUndefined();
    // The old shared type is gone — every family has its own now.
    expect(byName.Response).toBeUndefined();
  });
});

describe('describe', () => {
  it('Check exposes a writable Prompt, a readable Url/State, a write-only Cancelled, and a read/write/awaitable Response edge', async () => {
    const d = await adapter().describe('Check');
    expect(d).not.toBeNull();
    const fields = Object.fromEntries(d!.fields.map((f) => [f.displayName, f]));
    expect(fields.Prompt).toMatchObject({ writable: true, required: true });
    expect(fields.Url).toMatchObject({ writable: false });
    expect(fields.State).toMatchObject({ writable: false, kind: 'enum' });
    expect(fields.Cancelled).toMatchObject({ writable: true, readable: false });

    // Token is gone with the surface it existed for (callback-primitive layer 3).
    expect(fields.Token).toBeUndefined();

    // The Response edge is ORDINARY in every direction: readable and writable
    // synchronously, with `await` as the read that waits.
    const response = d!.references.find((r) => r.name === 'Response');
    expect(response).toMatchObject({
      awaitable: true,
      // Answering resumes the run in the same request, so it is announced —
      // which is what lets an author write a bare `await` on it.
      watchable: true,
      resolvesEmpty: true,
      readable: true,
      writable: true,
      targetTypeId: 'Check Response',
    });
  });

  it("each family's Answer is WRITABLE — the write body types against the same per-family kind the read promises", async () => {
    for (const family of ['Check', 'Provide', 'Choose', 'Select', 'Review', 'Correct', 'Draft', 'Form']) {
      const d = await adapter().describe(`${family} Response`);
      const answer = d!.fields.find((f) => f.displayName === 'Answer');
      // `Review`'s answer IS the acknowledgement, so it carries no value to require.
      expect(answer).toMatchObject({ writable: true, required: family !== 'Review' });
    }
  });

  it('each family\'s Response type carries its own honest Answer kind (chunk A — no more shared string lie)', async () => {
    const expected: Record<string, { kind: string; cardinality?: string }> = {
      Check: { kind: 'boolean' },
      Choose: { kind: 'string' },
      Select: { kind: 'string', cardinality: 'many' },
      Review: { kind: 'string' },
      Provide: { kind: 'string' },
      Correct: { kind: 'json' },
      Draft: { kind: 'json' },
      Form: { kind: 'json' },
    };
    for (const [family, expectation] of Object.entries(expected)) {
      const d = await adapter().describe(`${family} Response`);
      expect(d).not.toBeNull();
      const answer = d!.fields.find((f) => f.displayName === 'Answer');
      expect(answer).toMatchObject(expectation);
    }
  });

  it('Provide requires an Answer Type enum; Choose and Select both require Options', async () => {
    const provide = await adapter().describe('Provide');
    const at = provide!.fields.find((f) => f.displayName === 'Answer Type');
    expect(at).toMatchObject({ kind: 'enum', required: true });
    expect(at!.enumValues).toEqual(['text', 'number', 'date', 'boolean']);

    for (const family of ['Choose', 'Select']) {
      const d = await adapter().describe(family);
      const opts = d!.fields.find((f) => f.displayName === 'Options');
      expect(opts).toMatchObject({ required: true, cardinality: 'many' });
    }
  });

  it('Pick is not a family', async () => {
    expect(await adapter().describe('Pick')).toBeNull();
  });

  it('Correct requires Rows', async () => {
    const d = await adapter().describe('Correct');
    const rows = d!.fields.find((f) => f.displayName === 'Rows');
    expect(rows).toMatchObject({ required: true, cardinality: 'many', kind: 'json' });
  });

  it('Draft adds no extra field beyond Prompt/Detail', async () => {
    const d = await adapter().describe('Draft');
    expect(d!.fields.map((f) => f.displayName).sort()).toEqual(
      ['Cancelled', 'Detail', 'Prompt', 'State', 'Url'].sort(),
    );
  });

  it('Form requires Fields', async () => {
    const d = await adapter().describe('Form');
    const fields = d!.fields.find((f) => f.displayName === 'Fields');
    expect(fields).toMatchObject({ required: true, cardinality: 'many' });
  });
});

describe('createRecord', () => {
  it('routes a Check write to the store and returns the minted url + externalId', async () => {
    createAskMock.mockResolvedValue({ ...STORED });
    const result = await adapter().createRecord(writeInput('Check', { Prompt: 'Ship it?' }));

    expect(createAskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: TEAM,
        family: 'Check',
        prompt: 'Ship it?',
        provenance: expect.objectContaining({ movementId: 'mv-1', nodeId: 'node-1' }),
      }),
    );
    expect(result).toMatchObject({
      adapterType: 'ask',
      externalId: 'ask-1',
      recordType: 'Check',
      url: STORED.url,
    });
    expect(result.data).toMatchObject({ Url: STORED.url, State: 'open' });
    // `Token` is deleted (callback-primitive layer 3) — a callback id squeezes
    // into a platform payload without the ask surface carrying a second identity.
    expect(result.data.Token).toBeUndefined();
  });

  it('rejects a write with no Prompt', async () => {
    await expect(adapter().createRecord(writeInput('Check', {}))).rejects.toThrow(/Prompt/);
    expect(createAskMock).not.toHaveBeenCalled();
  });

  it('Provide passes the declared Answer Type through and rejects an unknown one', async () => {
    createAskMock.mockResolvedValue({ ...STORED });
    await adapter().createRecord(writeInput('Provide', { Prompt: 'How much?', 'Answer Type': 'number' }));
    expect(createAskMock).toHaveBeenCalledWith(expect.objectContaining({ answerType: 'number' }));

    await expect(
      adapter().createRecord(writeInput('Provide', { Prompt: 'How much?', 'Answer Type': 'currency' })),
    ).rejects.toThrow(/Answer Type/);
  });

  it.each(['Choose', 'Select'])('%s writes Options through and requires at least one offered', async (family) => {
    createAskMock.mockResolvedValue({ ...STORED });
    await adapter().createRecord(writeInput(family, { Prompt: 'Which?', Options: ['a', 'b'] }));
    expect(createAskMock).toHaveBeenCalledWith(expect.objectContaining({ family, options: ['a', 'b'] }));

    await expect(
      adapter().createRecord(writeInput(family, { Prompt: 'Which?', Options: [] })),
    ).rejects.toThrow(/Options/);
  });

  it('Correct mints an ephemeralId per offered row and requires at least one', async () => {
    createAskMock.mockResolvedValue({ ...STORED });
    await adapter().createRecord(
      writeInput('Correct', { Prompt: 'Review these', Rows: [{ name: 'Acme' }, { name: 'Beta' }] }),
    );
    expect(createAskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'Correct',
        rows: [
          { ephemeralId: 'row-0', fields: { name: 'Acme' } },
          { ephemeralId: 'row-1', fields: { name: 'Beta' } },
        ],
      }),
    );

    await expect(
      adapter().createRecord(writeInput('Correct', { Prompt: 'Review these', Rows: [] })),
    ).rejects.toThrow(/Rows/);
  });

  it('Draft requires only Prompt (no extra field)', async () => {
    createAskMock.mockResolvedValue({ ...STORED });
    await adapter().createRecord(writeInput('Draft', { Prompt: 'Draft the memo' }));
    expect(createAskMock).toHaveBeenCalledWith(expect.objectContaining({ family: 'Draft', prompt: 'Draft the memo' }));
  });

  it('Form writes its named Fields through (stored as Options) and requires at least one', async () => {
    createAskMock.mockResolvedValue({ ...STORED });
    const result = await adapter().createRecord(
      writeInput('Form', { Prompt: 'Decide', Fields: ['call', 'cap'] }),
    );
    expect(createAskMock).toHaveBeenCalledWith(expect.objectContaining({ family: 'Form', options: ['call', 'cap'] }));
    expect(result.data).toMatchObject({ Fields: ['call', 'cap'] });
    expect(result.data.Options).toBeUndefined();

    await expect(
      adapter().createRecord(writeInput('Form', { Prompt: 'Decide', Fields: [] })),
    ).rejects.toThrow(/Fields/);
  });

  it('rejects an unknown family', async () => {
    await expect(adapter().createRecord(writeInput('Nope', { Prompt: 'x' }))).rejects.toThrow(/not an ask family/);
  });

  it('rejects Pick — dropped, not a family (composition is the idiom, ruling 2026-07-30)', async () => {
    await expect(adapter().createRecord(writeInput('Pick', { Prompt: 'x' }))).rejects.toThrow(/not an ask family/);
    expect(createAskMock).not.toHaveBeenCalled();
  });
});

// ── The Response edge, both directions (callback-primitive layer 3) ─────────

function responseWrite(family: string, answer: unknown, edge = 'Response'): WriteInput {
  return {
    recordType: `${family} Response`,
    fields: answer === undefined ? {} : { Answer: answer },
    parentLinks: [{ recordType: family, externalId: 'ask-1', edgeName: edge }],
    mutationContext: ctx(),
  };
}

describe('writing the Response edge — the answer IS an ordinary edge write', () => {
  it('routes `write a-[:Response]-> { Answer: … }` to the one answer path and lands the coerced answer', async () => {
    answerAskMock.mockResolvedValue({ ok: true, ask: { ...STORED, state: 'answered', answer: true } });
    const result = await adapter().createRecord(responseWrite('Check', true));

    // The parent link carries the request's identity; the body carries the answer.
    expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: true });
    expect(result).toMatchObject({
      adapterType: 'ask',
      externalId: 'ask-1',
      // The RECORD's own family names the landing — not the type the write site
      // inferred, which the store is the authority over.
      recordType: 'Check Response',
      data: { Answer: true },
    });
  });

  it('a write to a SETTLED request fails with the closed outcome — typed, so a caller acks without matching strings', async () => {
    answerAskMock.mockResolvedValue({
      ok: false, reason: 'settled', ask: { ...STORED, state: 'answered', answer: false },
    });
    const err = await adapter().createRecord(responseWrite('Check', true)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AskResponseRefused);
    expect((err as AskResponseRefused).outcome).toMatchObject({ kind: 'closed' });
    // ONE outcome vocabulary — the same `kind`s the doors already branch on.
    expect((err as AskResponseRefused).message).toMatch(/already closed/);
  });

  it('an answer that does not fit the family is the `invalid` outcome, carrying the reason', async () => {
    answerAskMock.mockResolvedValue({
      ok: false, reason: 'invalid', message: 'expected a yes/no answer', ask: { ...STORED },
    });
    const err = await adapter().createRecord(responseWrite('Check', 'maybe')).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome).toMatchObject({
      kind: 'invalid', message: 'expected a yes/no answer',
    });
  });

  it('a vanished request is `not_found`, not a silent no-op', async () => {
    answerAskMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const err = await adapter().createRecord(responseWrite('Check', true)).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome).toEqual({ kind: 'not_found' });
  });

  it('SINGLE ANSWER: the second write of the same request is refused (the store guard, surfaced)', async () => {
    answerAskMock
      .mockResolvedValueOnce({ ok: true, ask: { ...STORED, state: 'answered', answer: true } })
      .mockResolvedValueOnce({ ok: false, reason: 'settled', ask: { ...STORED, state: 'answered', answer: true } });
    await adapter().createRecord(responseWrite('Check', true));
    const err = await adapter().createRecord(responseWrite('Check', false)).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome).toMatchObject({ kind: 'closed' });
  });

  it('every family reaches the same path with the value as authored — the family decides what it means', async () => {
    const bodies: Array<[string, unknown]> = [
      ['Check', false],
      ['Provide', 42],
      ['Choose', 'Seed'],
      ['Select', ['Seed', 'Series A']],
      ['Review', 'ack'],
      ['Correct', { rows: [], dropped: [] }],
      ['Draft', { note: 'x' }],
      ['Form', { call: 'yes', cap: 10 }],
    ];
    for (const [family, answer] of bodies) {
      answerAskMock.mockReset();
      answerAskMock.mockResolvedValue({ ok: true, ask: { ...STORED, family, state: 'answered', answer } });
      const result = await adapter().createRecord(responseWrite(family, answer));
      expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: answer });
      expect(result.recordType).toBe(`${family} Response`);
    }
  });

  it('a Review answer needs no value — the acknowledgement is the answer', async () => {
    answerAskMock.mockResolvedValue({ ok: true, ask: { ...STORED, family: 'Review', state: 'answered', answer: 'ack' } });
    const result = await adapter().createRecord(responseWrite('Review', undefined));
    expect(answerAskMock).toHaveBeenCalledWith({ id: 'ask-1', raw: undefined });
    expect(result.data).toEqual({ Answer: 'ack' });
  });

  it('refuses a Response written anywhere but along its own request edge', async () => {
    await expect(
      adapter().createRecord({
        recordType: 'Check Response', fields: { Answer: true }, mutationContext: ctx(),
      }),
    ).rejects.toThrow(/written along its own request/);
    await expect(
      adapter().createRecord(responseWrite('Check', true, 'Messages')),
    ).rejects.toThrow(/written along its own request/);
    expect(answerAskMock).not.toHaveBeenCalled();
  });
});

describe('reading the Response edge — synchronous, empty until answered', () => {
  const askPosition = () =>
    makeStablePosition({ adapterType: 'ask', recordType: 'Check', recordId: 'ask-1' });

  it('an OPEN request reads EMPTY (the read half of resolvesEmpty)', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'open' });
    expect(
      await adapter().getRelated({ position: askPosition(), fieldId: 'Response', direction: 'outgoing' }),
    ).toEqual([]);
  });

  it('a CANCELLED request reads EMPTY — nothing will ever arrive', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'expired' });
    expect(
      await adapter().getRelated({ position: askPosition(), fieldId: 'Response', direction: 'outgoing' }),
    ).toEqual([]);
  });

  it('an ANSWERED request reads its Response record — the same landing `await` would resolve to', async () => {
    getAskMock.mockResolvedValue({ ...STORED, state: 'answered', answer: true });
    const [related] = await adapter().getRelated({
      position: askPosition(), fieldId: 'Response', direction: 'outgoing',
    });
    expect(related.position).toMatchObject({
      adapterType: 'ask',
      recordType: 'Check Response',
      identity: { kind: 'stable', recordId: 'ask-1', data: { Answer: true } },
    });
    // And it reads back through the same seam an awaited landing does.
    expect(await adapter().getFieldValue({ position: related.position, fieldId: 'Answer' })).toBe(true);
  });

  it('any other edge, or the incoming direction, is refused observably', async () => {
    // A name the descriptor doesn't publish is the SHARED drift error — the
    // adapter reads its edge through the standard resolver, not a bespoke match.
    await expect(
      adapter().getRelated({ position: askPosition(), fieldId: 'Answer', direction: 'outgoing' }),
    ).rejects.toThrow(/not a known edge of 'Check'/);
    await expect(
      adapter().getRelated({ position: askPosition(), fieldId: 'Response', direction: 'incoming' }),
    ).rejects.toThrow(/outgoing only/);
  });
});

describe('updateRecord — the cancellation surface', () => {
  it('{ Cancelled: true } freezes an open ask to expired', async () => {
    cancelAskMock.mockResolvedValue({ ok: true, ask: { ...STORED, state: 'expired' } });
    const result = await adapter().updateRecord(
      { recordType: 'Check', externalId: 'ask-1', fields: { Cancelled: true }, mutationContext: ctx() } as UpdateInput,
    );
    expect(cancelAskMock).toHaveBeenCalledWith({ id: 'ask-1' });
    expect(result).toMatchObject({ externalId: 'ask-1', data: { State: 'expired' } });
    // …and wakes the run parked on it now, not at the next sweep.
    expect(enqueueAwaitWakeMock).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: 'ask', correlationKey: STORED.id }),
    );
  });

  it('rejects observably when the ask has already settled', async () => {
    cancelAskMock.mockResolvedValue({ ok: false, reason: 'settled', ask: { ...STORED, state: 'answered' } });
    await expect(
      adapter().updateRecord(
        { recordType: 'Check', externalId: 'ask-1', fields: { Cancelled: true }, mutationContext: ctx() } as UpdateInput,
      ),
    ).rejects.toThrow(/already been answered/);
  });

  it('returns the typed not-found signal when the row is gone', async () => {
    cancelAskMock.mockResolvedValue({ ok: false, reason: 'not_found' });
    const result = await adapter().updateRecord(
      { recordType: 'Check', externalId: 'ghost', fields: { Cancelled: true }, mutationContext: ctx() } as UpdateInput,
    );
    expect(result).toBe(UPDATE_NOT_FOUND);
  });

  it('rejects any update that is not the cancellation write', async () => {
    await expect(
      adapter().updateRecord(
        { recordType: 'Check', externalId: 'ask-1', fields: { Prompt: 'new' }, mutationContext: ctx() } as UpdateInput,
      ),
    ).rejects.toThrow(/only supported update/);
    expect(cancelAskMock).not.toHaveBeenCalled();
  });
});

describe('deleteRecord — asks are receipts, no delete surface (RULED)', () => {
  it('rejects, naming the reason and the alternative (cancel) — not the base class’s generic throw', async () => {
    await expect(
      adapter().deleteRecord({ recordType: 'Check', externalId: 'ask-1', mutationContext: ctx() }),
    ).rejects.toThrow(/receipts and cannot be deleted/);
    await expect(
      adapter().deleteRecord({ recordType: 'Check', externalId: 'ask-1', mutationContext: ctx() }),
    ).rejects.toThrow(/Cancelled: true/);
  });
});
