// The Response EDGE WRITE against a real DB (callback-primitive layer 3).
//
// `write a-[:Response]-> { Answer: … }` is how an answer arrives — from a
// callback body, from anywhere movement code runs — and the answer semantics
// live at that write: the family coerces the value, the first answer stands,
// and a settled request refuses. Everything else is a wrapper: this proves
// `answerAskByToken` (the link page, the platform doors, MCP submit) drives the
// SAME transition, so there is one semantics rather than two that agree today.
//
// The store's own lattice is proven next door in `store_lattice`; what is new
// here is the ADAPTER reaching it through the write path.

// The wake reaches the engine through the `AskSettledNotifier` seam (A-5), so
// the composed wiring is registered here exactly as the composition root
// registers it — proving the seam carries the behaviour rather than that the
// door still names the engine. What it leaves is the engine's queued wake row.

import { randomUUID } from 'node:crypto';

import { getAutomationsQb, getCoreQb } from '../../../../../lib/kysely';
import { cleanupTeam } from '../../../../../test/harness/cleanup';
import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { AskAdapter } from '../index';
import { notifyEngineOfSettledAsks } from '../../../../asks/in_process_notifier';
import { AskResponseRefused, answerAskByToken } from '../answer_door';
import { createAsk, getAsk, cancelAsk, type AskFamily, type AskRecord } from '../store';
import type { WriteInput } from '../../../adapter';

function ctx(): WriteInput['mutationContext'] {
  return {
    source: { type: 'agent', translationGraphId: 'mv-1', adapterType: 'ask' },
    occurredAt: new Date().toISOString(),
  };
}

/** The write the engine performs for `write a-[:Response]-> { Answer: … }`:
 *  the landing type as the record type, the request as the parent link. */
function responseWrite(ask: AskRecord, answer: unknown): WriteInput {
  return {
    recordType: `${ask.family} Response`,
    fields: { Answer: answer },
    parentLinks: [{ recordType: ask.family, externalId: ask.id, edgeName: 'Response' }],
    mutationContext: ctx(),
  };
}

describe('the Response edge write (real DB)', () => {
  let teamId: TeamId;
  let adapter: AskAdapter;

  const wakeRows = async (): Promise<unknown[]> =>
    (
      await getAutomationsQb(['work'])
        .selectFrom('work')
        .where('team_id', '=', teamId)
        .where('kind', '=', 'wake_await')
        .select('payload')
        .execute()
    ).map((row) => row.payload);

  beforeEach(async () => {
    notifyEngineOfSettledAsks();
    teamId = randomUUID() as TeamId;
    await getCoreQb(['team'])
      .insertInto('team')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values({ id: teamId, name: `ask-write-${teamId.slice(0, 8)}` } as any)
      .execute();
    adapter = new AskAdapter(teamId);
  });

  afterEach(async () => {
    await cleanupTeam(teamId);
  });

  it.each([
    ['Check', 'true', true],
    ['Review', 'anything', 'ack'],
    ['Draft', { note: 'x' }, { note: 'x' }],
  ] as Array<[AskFamily, unknown, unknown]>)(
    'a %s answer is coerced by its FAMILY at the write, not taken as given',
    async (family, raw, stored) => {
      const ask = await createAsk({ teamId, family, prompt: 'q' });
      const result = await adapter.createRecord(responseWrite(ask, raw));

      expect(result).toMatchObject({ externalId: ask.id, recordType: `${family} Response` });
      expect(result.data.Answer).toEqual(stored);
      expect((await getAsk(ask.id))?.answer).toEqual(stored);
      expect((await getAsk(ask.id))?.state).toBe('answered');
      // The settle queued the engine's wake for this ask, durably.
      expect(await wakeRows()).toEqual([{ adapterType: 'ask', teamId, correlationKey: ask.id }]);
    },
  );

  it('a Choose answers within the options it offered; anything else is refused and leaves it open', async () => {
    const ask = await createAsk({ teamId, family: 'Choose', prompt: 'Which?', options: ['Seed', 'Series A'] });

    const err = await adapter.createRecord(responseWrite(ask, 'Sead')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AskResponseRefused);
    expect((err as AskResponseRefused).outcome.kind).toBe('invalid');
    expect((await getAsk(ask.id))?.state).toBe('open');

    await adapter.createRecord(responseWrite(ask, 'Seed'));
    expect((await getAsk(ask.id))?.answer).toBe('Seed');
  });

  it('SINGLE ANSWER + CLOSED-REQUEST-WINS: the second write is refused and the first answer stands', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    await adapter.createRecord(responseWrite(ask, true));

    const err = await adapter.createRecord(responseWrite(ask, false)).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome).toMatchObject({ kind: 'closed' });
    expect((await getAsk(ask.id))?.answer).toBe(true);
  });

  it('a CANCELLED request is closed to writes too — one terminal state, one outcome', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    await cancelAsk({ id: ask.id });

    const err = await adapter.createRecord(responseWrite(ask, true)).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome).toMatchObject({ kind: 'closed' });
    expect((await getAsk(ask.id))?.state).toBe('expired');
  });

  it('the READ is symmetric: empty before the write, the answer record after', async () => {
    const ask = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const position = { adapterType: 'ask', recordType: 'Check', identity: { kind: 'stable' as const, recordId: ask.id } };

    expect(await adapter.getRelated({ position, fieldId: 'Response', direction: 'outgoing' })).toEqual([]);

    await adapter.createRecord(responseWrite(ask, true));
    const [related] = await adapter.getRelated({ position, fieldId: 'Response', direction: 'outgoing' });
    expect(related.position.recordType).toBe('Check Response');
    expect(await adapter.getFieldValue({ position: related.position, fieldId: 'Answer' })).toBe(true);
  });

  it('`answerAskByToken` is a WRAPPER over the same write — same transition, same outcome vocabulary', async () => {
    const viaToken = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });
    const viaWrite = await createAsk({ teamId, family: 'Check', prompt: 'Ship it?' });

    const outcome = await answerAskByToken(viaToken.token, 'true');
    await adapter.createRecord(responseWrite(viaWrite, 'true'));

    expect(outcome).toMatchObject({ kind: 'answered' });
    const [a, b] = [await getAsk(viaToken.id), await getAsk(viaWrite.id)];
    expect(a?.state).toBe(b?.state);
    expect(a?.answer).toEqual(b?.answer);

    // …and the closed outcome is the same one the write throws, by the same name.
    expect(await answerAskByToken(viaToken.token, 'false')).toMatchObject({ kind: 'closed' });
    const err = await adapter.createRecord(responseWrite(viaWrite, 'false')).catch((e: unknown) => e);
    expect((err as AskResponseRefused).outcome.kind).toBe('closed');

    // A token this store never minted is `not_ours`, so the link page can fall
    // through to the legacy resolver — unchanged by the rework.
    expect(await answerAskByToken('legacy-token', 'true')).toEqual({ kind: 'not_ours' });
  });
});
