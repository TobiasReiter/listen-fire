// The orchestrator's two link flows over a recorded query builder: which rows
// each writes, and whether a code leaves the building.

type Op = { table: string; ops: Array<[string, unknown[]]> };

const recorded: Op[] = [];
// executeTakeFirst answers, in call order.
let reads: unknown[] = [];

function qbDouble() {
  let current: Op;
  const chain: Record<string, (...args: unknown[]) => unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'executeTakeFirst') return async () => reads.shift();
        if (prop === 'execute') return async () => [];
        return (...args: unknown[]) => {
          if (['selectFrom', 'insertInto', 'updateTable'].includes(prop)) {
            current = { table: String(args[0]), ops: [] };
            recorded.push(current);
          }
          if (prop === 'onConflict') {
            const builder = args[0] as (oc: unknown) => unknown;
            builder(chain);
          }
          current.ops.push([prop, args]);
          return chain;
        };
      },
    },
  );
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => qbDouble(),
}));

const sendVerificationCode = jest.fn(async (_input: { to: string; code: string }) => undefined);
jest.mock('../metaApi', () => ({
  sendVerificationCode: (input: unknown) => sendVerificationCode(input as { to: string; code: string }),
}));

const loggerInfo = jest.fn();
jest.mock('movement-engine/services/logger', () => ({
  logger: { info: (...args: unknown[]) => loggerInfo(...args) },
}));

import { confirmPhoneVerification, startPhoneVerification } from './index';

const ME = 'user-1';
const NUMBER = '+44 7700 900123';

function writesTo(table: string) {
  return recorded.filter(
    (r) => r.table === table && r.ops.some(([op]) => op === 'insertInto' || op === 'updateTable'),
  );
}

function valuesOf(op: Op): Record<string, unknown> {
  const values = op.ops.find(([name]) => name === 'values');
  return (values?.[1][0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  recorded.length = 0;
  reads = [];
  sendVerificationCode.mockClear();
  loggerInfo.mockClear();
  delete process.env.WHATSAPP_LINK_VERIFICATION;
});

afterAll(() => {
  delete process.env.WHATSAPP_LINK_VERIFICATION;
});

describe('startPhoneVerification under trust', () => {
  beforeEach(() => {
    process.env.WHATSAPP_LINK_VERIFICATION = 'trust';
  });

  it('writes a verified link and sends nothing', async () => {
    reads = [undefined]; // no owner

    const res = await startPhoneVerification({ userId: ME, phoneNumber: NUMBER });

    expect(res).toEqual({ ok: true, outcome: 'linked' });
    expect(sendVerificationCode).not.toHaveBeenCalled();
    expect(writesTo('phone_verification')).toHaveLength(0);

    const [link] = writesTo('phone_number');
    expect(link).toBeDefined();
    const values = valuesOf(link!);
    expect(values.phone_number).toBe('+447700900123');
    expect(values.user_id).toBe(ME);
    expect(values.verified_at).toBeInstanceOf(Date);
  });

  it('logs the link with the user and a masked number', async () => {
    reads = [undefined];

    await startPhoneVerification({ userId: ME, phoneNumber: NUMBER });

    expect(loggerInfo).toHaveBeenCalledWith(
      '[whatsapp/link] number linked without a code (WHATSAPP_LINK_VERIFICATION=trust)',
      { userId: ME, phoneNumber: '+*********123' },
    );
    expect(JSON.stringify(loggerInfo.mock.calls)).not.toContain('447700900123');
  });

  it('refuses a number verified to another account, as under otp', async () => {
    reads = [{ user_id: 'someone-else' }];

    const res = await startPhoneVerification({ userId: ME, phoneNumber: NUMBER });

    expect(res).toEqual({ ok: false, reason: 'number_taken' });
    expect(writesTo('phone_number')).toHaveLength(0);
  });
});

describe('startPhoneVerification under otp', () => {
  it.each([undefined, 'otp'])('stores a code and sends it (setting %s)', async (mode) => {
    if (mode !== undefined) process.env.WHATSAPP_LINK_VERIFICATION = mode;
    reads = [undefined, undefined]; // no owner, no active code

    const res = await startPhoneVerification({ userId: ME, phoneNumber: NUMBER });

    expect(res).toMatchObject({ ok: true, outcome: 'code_sent' });
    expect(sendVerificationCode).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+447700900123' }),
    );
    expect(writesTo('phone_verification')).toHaveLength(1);
    expect(writesTo('phone_number')).toHaveLength(0);
    expect(loggerInfo).not.toHaveBeenCalled();
  });

  it('refuses a number verified to another account', async () => {
    reads = [{ user_id: 'someone-else' }];

    const res = await startPhoneVerification({ userId: ME, phoneNumber: NUMBER });

    expect(res).toEqual({ ok: false, reason: 'number_taken' });
    expect(sendVerificationCode).not.toHaveBeenCalled();
  });
});

describe('confirmPhoneVerification under trust', () => {
  it('says no code is needed and touches nothing', async () => {
    process.env.WHATSAPP_LINK_VERIFICATION = 'trust';

    const res = await confirmPhoneVerification({ userId: ME, phoneNumber: NUMBER, code: '123456' });

    expect(res).toEqual({ ok: false, reason: 'no_code_needed' });
    expect(recorded).toHaveLength(0);
  });
});
