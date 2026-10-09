// The ask store's state lattice against a REAL DB (asks-as-adapter §B). Proves
// the two terminal transitions and the optimistic guards that make them safe:
//
//   open → answered   (answerAsk); a second answer loses as `settled`
//   open → expired    (cancelAsk / the explicit cancel); answering an expired
//                     ask loses as `settled`; cancelling a settled ask loses too
//
// F16: every createAsk is a fresh row (no dedupe surface). The token minted at
// write resolves the record for the link surface.

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../../../../generated/kysely/core/Team';

import { getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import {
  ASK_TOKEN_PREFIX,
  answerAsk,
  cancelAsk,
  createAsk,
  getAsk,
  lookupAskByToken,
} from '../store';

describe('ask store — state lattice (real DB)', () => {
  let teamId: TeamId;

  beforeEach(async () => {
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `ask-store-${teamId.slice(0, 8)}` } as any)
      .execute();
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it('createAsk mints an ask_-prefixed token resolvable by the link surface', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    expect(ask.state).toBe('open');
    expect(ask.token.startsWith(ASK_TOKEN_PREFIX)).toBe(true);
    expect(ask.url).toContain(`/api/asks/${ask.token}`);

    const byToken = await lookupAskByToken(ask.token);
    expect(byToken?.id).toBe(ask.id);
    // A token this store did not mint is not ours.
    expect(await lookupAskByToken('legacy-token')).toBeNull();
  });

  it('every write creates — no dedupe surface (F16)', async () => {
    const a = await createAsk({ teamId, family: 'Check', prompt: 'same' });
    const b = await createAsk({ teamId, family: 'Check', prompt: 'same' });
    expect(a.id).not.toBe(b.id);
  });

  it('open → answered stores the typed answer; a second answer loses as settled', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });

    const first = await answerAsk({ id: ask.id, raw: 'true' });
    expect(first).toMatchObject({ ok: true });
    if (first.ok) {
      expect(first.ask.state).toBe('answered');
      expect(first.ask.answer).toBe(true);
      expect(first.ask.answeredAt).not.toBeNull();
    }

    const second = await answerAsk({ id: ask.id, raw: 'false' });
    expect(second).toMatchObject({ ok: false, reason: 'settled' });

    const persisted = await getAsk(ask.id);
    expect(persisted?.state).toBe('answered');
    expect(persisted?.answer).toBe(true); // the first answer stands
  });

  it('open → expired via cancel; answering an expired ask loses as settled', async () => {
    const ask = await createAsk({ teamId, family: 'Provide', prompt: 'How much?', answerType: 'number' });

    const cancelled = await cancelAsk({ id: ask.id });
    expect(cancelled).toMatchObject({ ok: true });
    if (cancelled.ok) {
      expect(cancelled.ask.state).toBe('expired');
      expect(cancelled.ask.expiredAt).not.toBeNull();
    }

    const late = await answerAsk({ id: ask.id, raw: '42' });
    expect(late).toMatchObject({ ok: false, reason: 'settled' });
  });

  it('cancelling an already-answered ask loses as settled (both transitions terminal)', async () => {
    const ask = await createAsk({ teamId, family: 'Review', prompt: 'Heads up' });
    await answerAsk({ id: ask.id, raw: 'ack' });

    const cancelled = await cancelAsk({ id: ask.id });
    expect(cancelled).toMatchObject({ ok: false, reason: 'settled' });
    expect(cancelled.ok ? null : cancelled.ask?.state).toBe('answered');
  });

  it('an invalid answer is rejected and leaves the ask open', async () => {
    const ask = await createAsk({ teamId, family: 'Choose', prompt: 'Which?', options: ['a', 'b'] });
    const bad = await answerAsk({ id: ask.id, raw: 'z' });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid' });
    expect((await getAsk(ask.id))?.state).toBe('open');

    const good = await answerAsk({ id: ask.id, raw: 'b' });
    expect(good).toMatchObject({ ok: true });
    expect(good.ok && good.ask.answer).toBe('b');
  });
});
