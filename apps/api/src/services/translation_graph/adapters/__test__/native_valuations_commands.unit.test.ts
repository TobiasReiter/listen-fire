// Command edges (adapter layer 3): an imperative ACTION off a parent —
// `legalEntity-[:AddMarkdown]->` — routes its create to a REST *command*
// endpoint (`POST /valuations/commands/add-markdown`), not a plain entity
// create. Parallel to the down-edge parent-first creates covered by
// `native_valuations_parent_first.unit.test.ts`.

// logger → services/context → casl crashes at module load; stub it (mirrors
// the sibling tests).
jest.mock('../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// Credentials load hits the DB + decrypt; stub the two seams so requireCreds
// resolves to a fake connection without a database.
jest.mock('../../../../lib/kysely', () => {
  const qb = () => ({
    selectFrom: () => ({
      where: () => ({
        select: () => ({
          executeTakeFirstOrThrow: async () => ({ id: 'cred-1', credentials: Buffer.from('x') }),
        }),
      }),
    }),
  });
  return { getQb: qb, getCoreQb: qb, getAutomationsQb: qb };
});
jest.mock('../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify({ apiKey: 'k', baseUrl: 'http://vals.test/api/v1' }),
}));

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MutationContext } from '../../mutation_context';

import {
  NATIVE_VALUATIONS_ADAPTER_TYPE,
  createNativeValuationsAdapter,
} from '../native_valuations';
import { makeStablePosition } from '../../types';

const adapter = () =>
  createNativeValuationsAdapter({ teamId: 'team-1' as TeamId, credentialsId: 'cred-1' });

const mutationContext = {} as MutationContext;

const recordResponse = (row: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify({ data: row }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AddMarkdown — createRecord routes the command edge', () => {
  it('POSTs /valuations/commands/add-markdown with the mapped body and returns the receipt', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-md-1', priceIds: ['pr-1', 'pr-2'] }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddMarkdown',
      fields: { Date: '2026-07-20', Percentage: 40, Note: 'x' },
      mutationContext,
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'le-1', edgeName: 'AddMarkdown' }],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-markdown');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ companyId: 'le-1', date: '2026-07-20', percentage: 40, note: 'x' });

    expect(result.externalId).toBe('ev-md-1');
    expect(result.data).toEqual({ eventId: 'ev-md-1', priceIds: ['pr-1', 'pr-2'] });
  });

  it('a missing Legal Entity parent link fails loudly', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddMarkdown',
        fields: { Date: '2026-07-20', Percentage: 40 },
        mutationContext,
        parentLinks: [],
      }),
    ).rejects.toThrow(/missing the Legal Entity parent for role 'AddMarkdown' — write it via -\[:AddMarkdown\]->/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddInvestment — createRecord routes the multi-parent command edge', () => {
  it('POSTs /valuations/commands/add-investment with both parent roles and the mapped body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ investmentId: 'inv-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddInvestment',
      fields: {
        Date: '2026-07-20',
        Amount: '1000000',
        Currency: 'USD',
        Type: 'EQUITY',
        'Price Per Share': '2.50',
        'Number Of Shares': '400000',
      },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddInvestment' },
        { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'Investor' },
      ],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-investment');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      entity: 'co-1',
      investingEntity: 'fund-1',
      investmentDate: '2026-07-20',
      investmentAmount: '1000000',
      investmentCurrency: 'USD',
      investmentType: 'EQUITY',
      pricePerShare: '2.50',
      numberOfShares: '400000',
    });

    expect(result.externalId).toBe('inv-1');
  });

  it('a missing Investor parent link fails loudly, naming the Investor role', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddInvestment',
        fields: { Date: '2026-07-20', Amount: '1000000', Currency: 'USD' },
        mutationContext,
        parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddInvestment' }],
      }),
    ).rejects.toThrow(/Investor/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddInvestment — describe surfaces the action', () => {
  it("Legal Entity's references include writable AddInvestment and Investor edges", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const addInvestment = descriptor!.references.find((r) => r.name === 'AddInvestment');
    expect(addInvestment).toBeDefined();
    expect(addInvestment?.targetTypeId).toBe('AddInvestment');
    expect(addInvestment?.writable).toBe(true);

    const investor = descriptor!.references.find((r) => r.name === 'Investor');
    expect(investor).toBeDefined();
    expect(investor?.targetTypeId).toBe('AddInvestment');
    expect(investor?.writable).toBe(true);
  });

  it('AddInvestment describes its writable fields and the three readable receipt edges', async () => {
    const descriptor = await adapter().describe('AddInvestment');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Amount')).toMatchObject({ kind: 'string', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: true });
    expect(byName.get('Type')).toMatchObject({ kind: 'enum', writable: true, required: false });
    expect(byName.get('Round Name')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Price Per Share')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Number Of Shares')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Share Class')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Valuation')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Valuation Type')).toMatchObject({ kind: 'enum', writable: true, required: false });
    expect(byName.get('Total Raised')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(descriptor!.fields).toHaveLength(11);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const investment = descriptor!.references.find((r) => r.name === 'Investment');
    expect(investment).toMatchObject({ targetTypeId: 'Investment', cardinality: 'one' });
    const round = descriptor!.references.find((r) => r.name === 'Round');
    expect(round).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    const transaction = descriptor!.references.find((r) => r.name === 'Transaction');
    expect(transaction).toMatchObject({ targetTypeId: 'Transaction', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(3);
  });
});

describe('AddMarkdown — describe surfaces the action', () => {
  it("Legal Entity's references include a writable AddMarkdown edge", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const ref = descriptor!.references.find((r) => r.name === 'AddMarkdown');
    expect(ref).toBeDefined();
    expect(ref?.targetTypeId).toBe('AddMarkdown');
    expect(ref?.writable).toBe(true);
  });

  it('AddMarkdown itself describes its three writable fields and the two readable receipt edges', async () => {
    const descriptor = await adapter().describe('AddMarkdown');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Percentage')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Note')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(descriptor!.fields).toHaveLength(3);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const event = descriptor!.references.find((r) => r.name === 'Event');
    expect(event).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    const prices = descriptor!.references.find((r) => r.name === 'Prices');
    expect(prices).toMatchObject({ targetTypeId: 'Price', cardinality: 'many' });
    expect(descriptor!.references).toHaveLength(2);
  });
});

describe('AddPrice — createRecord routes the single-parent command edge', () => {
  it('POSTs /valuations/commands/add-price with the mapped body and returns the receipt', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ priceId: 'pr-3' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddPrice',
      fields: { Price: 12.5, Currency: 'USD', Date: '2026-07-20', Note: 'x' },
      mutationContext,
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddPrice' }],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-price');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ companyId: 'co-1', price: 12.5, currency: 'USD', date: '2026-07-20', note: 'x' });

    expect(result.externalId).toBe('pr-3');
    expect(result.data).toEqual({ priceId: 'pr-3' });
  });

  it('a missing Legal Entity parent link fails loudly', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddPrice',
        fields: { Price: 12.5, Currency: 'USD' },
        mutationContext,
        parentLinks: [],
      }),
    ).rejects.toThrow(/missing the Legal Entity parent for role 'AddPrice' — write it via -\[:AddPrice\]->/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddPrice — describe surfaces the action', () => {
  it("Legal Entity's references include a writable AddPrice edge", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const ref = descriptor!.references.find((r) => r.name === 'AddPrice');
    expect(ref).toBeDefined();
    expect(ref?.targetTypeId).toBe('AddPrice');
    expect(ref?.writable).toBe(true);
  });

  it('AddPrice itself describes its four writable fields and no references', async () => {
    const descriptor = await adapter().describe('AddPrice');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Price')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: true });
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: false });
    expect(byName.get('Note')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(descriptor!.fields).toHaveLength(4);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    expect(descriptor!.references).toHaveLength(0);
  });
});

describe('AddRound — createRecord routes the single-parent command edge', () => {
  it('POSTs /valuations/commands/add-round with the mapped body and returns the receipt', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-1', priceId: 'pr-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddRound',
      fields: { 'Round Name': 'Series A', Date: '2026-07-20', Currency: 'USD', 'Price Per Share': '2.50' },
      mutationContext,
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddRound' }],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-round');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      entity: 'co-1',
      roundName: 'Series A',
      date: '2026-07-20',
      currency: 'USD',
      pricePerShare: '2.50',
    });

    expect(result.externalId).toBe('ev-1');
    expect(result.data).toEqual({ eventId: 'ev-1', priceId: 'pr-1' });
  });

  it('a missing Legal Entity parent link fails loudly', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddRound',
        fields: { 'Round Name': 'Series A', Date: '2026-07-20' },
        mutationContext,
        parentLinks: [],
      }),
    ).rejects.toThrow(/missing the Legal Entity parent for role 'AddRound' — write it via -\[:AddRound\]->/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddRound — describe surfaces the action', () => {
  it("Legal Entity's references include a writable AddRound edge", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const ref = descriptor!.references.find((r) => r.name === 'AddRound');
    expect(ref).toBeDefined();
    expect(ref?.targetTypeId).toBe('AddRound');
    expect(ref?.writable).toBe(true);
  });

  it('AddRound describes its seven writable fields and the two readable receipt edges', async () => {
    const descriptor = await adapter().describe('AddRound');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Round Name')).toMatchObject({ kind: 'string', writable: true, required: true });
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: false });
    expect(byName.get('Price Per Share')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Valuation')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(byName.get('Valuation Type')).toMatchObject({ kind: 'enum', writable: true, required: false });
    expect(byName.get('Total Raised')).toMatchObject({ kind: 'string', writable: true, required: false });
    expect(descriptor!.fields).toHaveLength(7);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const round = descriptor!.references.find((r) => r.name === 'Round');
    expect(round).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    const price = descriptor!.references.find((r) => r.name === 'Price');
    expect(price).toMatchObject({ targetTypeId: 'Price', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(2);
  });
});

describe('AddRound — the receipt is walkable', () => {
  const receiptPosition = (data: { eventId?: string | null; priceId?: string | null }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddRound',
      recordId: 'ev-1',
      data,
    });

  it('rd-[:Round]-> fetches the round event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-1', type: 'FUNDING_ROUND' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-1', priceId: 'pr-1' }),
      fieldId: 'Round',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('rd-[:Price]-> fetches the round price by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'pr-1', price: 2.5 }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-1', priceId: 'pr-1' }),
      fieldId: 'Price',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/prices/pr-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Price');
  });

  it('a null priceId (no price per share given) means Price returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-1', priceId: null }),
      fieldId: 'Price',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddWindDown — createRecord routes the single-parent command edge', () => {
  it('POSTs /valuations/commands/add-wind-down with the mapped body and returns the receipt', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-wd-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddWindDown',
      fields: { Date: '2026-07-20' },
      mutationContext,
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddWindDown' }],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-wind-down');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ companyId: 'co-1', date: '2026-07-20' });

    expect(result.externalId).toBe('ev-wd-1');
    expect(result.data).toEqual({ eventId: 'ev-wd-1' });
  });

  it('a missing Legal Entity parent link fails loudly', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddWindDown',
        fields: { Date: '2026-07-20' },
        mutationContext,
        parentLinks: [],
      }),
    ).rejects.toThrow(/missing the Legal Entity parent for role 'AddWindDown' — write it via -\[:AddWindDown\]->/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddWindDown — describe surfaces the action', () => {
  it("Legal Entity's references include a writable AddWindDown edge", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const ref = descriptor!.references.find((r) => r.name === 'AddWindDown');
    expect(ref).toBeDefined();
    expect(ref?.targetTypeId).toBe('AddWindDown');
    expect(ref?.writable).toBe(true);
  });

  it('AddWindDown describes its one writable field and the one readable Event receipt', async () => {
    const descriptor = await adapter().describe('AddWindDown');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(descriptor!.fields).toHaveLength(1);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const event = descriptor!.references.find((r) => r.name === 'Event');
    expect(event).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(1);
  });
});

describe('AddWindDown — the receipt is walkable', () => {
  const receiptPosition = (data: { eventId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddWindDown',
      recordId: 'ev-wd-1',
      data,
    });

  it('wd-[:Event]-> fetches the wind-down event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-wd-1', type: 'LIQUIDATION' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-wd-1' }),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-wd-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('a missing eventId means Event returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({}),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddShareSplit — createRecord routes the single-parent command edge', () => {
  it('POSTs /valuations/commands/add-share-split with the mapped body and returns the receipt', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-ss-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddShareSplit',
      fields: { Date: '2026-07-20', Multiple: 10 },
      mutationContext,
      parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddShareSplit' }],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-share-split');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ companyId: 'co-1', date: '2026-07-20', multiple: 10 });

    expect(result.externalId).toBe('ev-ss-1');
    expect(result.data).toEqual({ eventId: 'ev-ss-1' });
  });

  it('a missing Legal Entity parent link fails loudly', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddShareSplit',
        fields: { Date: '2026-07-20', Multiple: 10 },
        mutationContext,
        parentLinks: [],
      }),
    ).rejects.toThrow(/missing the Legal Entity parent for role 'AddShareSplit' — write it via -\[:AddShareSplit\]->/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddShareSplit — describe surfaces the action', () => {
  it("Legal Entity's references include a writable AddShareSplit edge", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const ref = descriptor!.references.find((r) => r.name === 'AddShareSplit');
    expect(ref).toBeDefined();
    expect(ref?.targetTypeId).toBe('AddShareSplit');
    expect(ref?.writable).toBe(true);
  });

  it('AddShareSplit describes its two writable fields and the one readable Event receipt', async () => {
    const descriptor = await adapter().describe('AddShareSplit');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Multiple')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(descriptor!.fields).toHaveLength(2);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const event = descriptor!.references.find((r) => r.name === 'Event');
    expect(event).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(1);
  });
});

describe('AddShareSplit — the receipt is walkable', () => {
  const receiptPosition = (data: { eventId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddShareSplit',
      recordId: 'ev-ss-1',
      data,
    });

  it('ss-[:Event]-> fetches the share-split event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-ss-1', type: 'SHARE_SPLIT' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-ss-1' }),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-ss-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('a missing eventId means Event returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({}),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddMarkdown — the receipt is walkable', () => {
  const receiptPosition = () =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddMarkdown',
      recordId: 'ev-1',
      data: { eventId: 'ev-1', priceIds: ['pr-1', 'pr-2'] },
    });

  it('mk-[:Event]-> fetches the markdown event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-1', type: 'MARKDOWN' }));

    const results = await adapter().getRelated({
      position: receiptPosition(),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('mk-[:Prices]-> fetches both derived holding prices', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(recordResponse({ id: 'pr-1', price: 1 }))
      .mockResolvedValueOnce(recordResponse({ id: 'pr-2', price: 2 }));

    const results = await adapter().getRelated({
      position: receiptPosition(),
      fieldId: 'Prices',
      direction: 'outgoing',
    });

    const paths = fetchSpy.mock.calls.map((call) => new URL(String(call[0])).pathname);
    expect(paths).toEqual(['/api/v1/valuations/prices/pr-1', '/api/v1/valuations/prices/pr-2']);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.position.recordType)).toEqual(['Price', 'Price']);
  });
});

describe('AddInvestment — the receipt is walkable', () => {
  const receiptPosition = (data: { investmentId?: string; eventId?: string | null; transactionId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddInvestment',
      recordId: 'inv-1',
      data,
    });

  it('inv-[:Investment]-> fetches the investment by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'inv-1' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' }),
      fieldId: 'Investment',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/investments/inv-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Investment');
  });

  it('inv-[:Round]-> fetches the round event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-1', type: 'FUNDING_ROUND' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' }),
      fieldId: 'Round',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('inv-[:Transaction]-> fetches the transaction by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'tx-1' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' }),
      fieldId: 'Transaction',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/transactions/tx-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Transaction');
  });

  it('a null eventId (no round name given) means Round returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({ investmentId: 'inv-1', eventId: null, transactionId: 'tx-1' }),
      fieldId: 'Round',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddDividends — createRecord routes the multi-parent command edge', () => {
  it('POSTs /valuations/commands/add-dividends with both parent roles and the mapped body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-div-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddDividends',
      fields: { Date: '2026-07-20', Amount: 50000, Currency: 'USD' },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddDividends' },
        { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'Recipient' },
      ],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-dividends');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      companyId: 'co-1',
      fundId: 'fund-1',
      date: '2026-07-20',
      amount: 50000,
      currency: 'USD',
    });

    expect(result.externalId).toBe('ev-div-1');
    expect(result.data).toEqual({ eventId: 'ev-div-1' });
  });

  it('a missing Recipient parent link fails loudly, naming the Recipient role', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddDividends',
        fields: { Date: '2026-07-20', Amount: 50000, Currency: 'USD' },
        mutationContext,
        parentLinks: [{ recordType: 'Legal Entity', externalId: 'co-1', edgeName: 'AddDividends' }],
      }),
    ).rejects.toThrow(/Recipient/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddDividends — describe surfaces the action', () => {
  it("Legal Entity's references include writable AddDividends and Recipient edges", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const addDividends = descriptor!.references.find((r) => r.name === 'AddDividends');
    expect(addDividends).toBeDefined();
    expect(addDividends?.targetTypeId).toBe('AddDividends');
    expect(addDividends?.writable).toBe(true);

    const recipient = descriptor!.references.find((r) => r.name === 'Recipient');
    expect(recipient).toBeDefined();
    expect(recipient?.targetTypeId).toBe('AddDividends');
    expect(recipient?.writable).toBe(true);
  });

  it('AddDividends describes its three writable fields and the one readable Event receipt', async () => {
    const descriptor = await adapter().describe('AddDividends');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Amount')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: true });
    expect(descriptor!.fields).toHaveLength(3);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const event = descriptor!.references.find((r) => r.name === 'Event');
    expect(event).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(1);
  });
});

describe('AddDividends — the receipt is walkable', () => {
  const receiptPosition = (data: { eventId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddDividends',
      recordId: 'ev-div-1',
      data,
    });

  it('div-[:Event]-> fetches the dividend event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-div-1', type: 'DIVIDEND' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-div-1' }),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-div-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('a missing eventId means Event returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({}),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddFundDistribution — createRecord routes the multi-parent command edge', () => {
  it('POSTs /valuations/commands/add-fund-distribution with both parent roles and the mapped body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ eventId: 'ev-fd-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddFundDistribution',
      fields: { Date: '2026-07-20', Amount: 25000, Currency: 'USD' },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'AddFundDistribution' },
        { recordType: 'Legal Entity', externalId: 'inv-1', edgeName: 'Distribution Recipient' },
      ],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-fund-distribution');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      companyId: 'fund-1',
      fundId: 'inv-1',
      date: '2026-07-20',
      amount: 25000,
      currency: 'USD',
    });

    expect(result.externalId).toBe('ev-fd-1');
    expect(result.data).toEqual({ eventId: 'ev-fd-1' });
  });

  it('a missing Recipient parent link fails loudly, naming the Recipient role', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddFundDistribution',
        fields: { Date: '2026-07-20', Amount: 25000, Currency: 'USD' },
        mutationContext,
        parentLinks: [{ recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'AddFundDistribution' }],
      }),
    ).rejects.toThrow(/Recipient/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddFundDistribution — describe surfaces the action', () => {
  it("Legal Entity's references include writable AddFundDistribution and Distribution Recipient edges", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const addFundDistribution = descriptor!.references.find((r) => r.name === 'AddFundDistribution');
    expect(addFundDistribution).toBeDefined();
    expect(addFundDistribution?.targetTypeId).toBe('AddFundDistribution');
    expect(addFundDistribution?.writable).toBe(true);

    // Role-edge names off Legal Entity are globally unique — the fund's
    // recipient edge is `Distribution Recipient`, distinct from AddDividends'
    // `Recipient`, so the two don't collide in the built position.
    const recipient = descriptor!.references.find((r) => r.name === 'Distribution Recipient');
    expect(recipient).toBeDefined();
    expect(recipient?.targetTypeId).toBe('AddFundDistribution');
    expect(recipient?.writable).toBe(true);
  });

  it('AddFundDistribution describes its three writable fields and the one readable Event receipt', async () => {
    const descriptor = await adapter().describe('AddFundDistribution');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Amount')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: true });
    expect(descriptor!.fields).toHaveLength(3);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const event = descriptor!.references.find((r) => r.name === 'Event');
    expect(event).toMatchObject({ targetTypeId: 'Event', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(1);
  });
});

describe('AddFundDistribution — the receipt is walkable', () => {
  const receiptPosition = (data: { eventId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddFundDistribution',
      recordId: 'ev-fd-1',
      data,
    });

  it('fd-[:Event]-> fetches the distribution event by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'ev-fd-1', type: 'FUND_DISTRIBUTION' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ eventId: 'ev-fd-1' }),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/events/ev-fd-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Event');
  });

  it('a missing eventId means Event returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({}),
      fieldId: 'Event',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddFundDrawdown — createRecord routes the three-parent command edge', () => {
  it('POSTs /valuations/commands/add-fund-drawdown with all three parent roles and the mapped body', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ transactionId: 'tx-1', priceId: 'price-1' }, 201));

    const result = await adapter().createRecord({
      recordType: 'AddFundDrawdown',
      fields: { Date: '2026-07-20', Amount: 100000, 'Commitment Price': 500000, Currency: 'USD' },
      mutationContext,
      parentLinks: [
        { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'AddFundDrawdown' },
        { recordType: 'Legal Entity', externalId: 'inv-1', edgeName: 'Commitment Investor' },
        { recordType: 'Asset', externalId: 'asset-1', edgeName: 'Commitment Asset' },
      ],
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/commands/add-fund-drawdown');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      fundId: 'fund-1',
      investorId: 'inv-1',
      assetId: 'asset-1',
      date: '2026-07-20',
      drawdownAmount: 100000,
      price: 500000,
      currency: 'USD',
    });

    expect(result.externalId).toBe('tx-1');
    expect(result.data).toEqual({ transactionId: 'tx-1', priceId: 'price-1' });
  });

  it('a missing Commitment Asset parent link fails loudly, naming the Commitment Asset role', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddFundDrawdown',
        fields: { Date: '2026-07-20', Amount: 100000, 'Commitment Price': 500000, Currency: 'USD' },
        mutationContext,
        parentLinks: [
          { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'AddFundDrawdown' },
          { recordType: 'Legal Entity', externalId: 'inv-1', edgeName: 'Commitment Investor' },
        ],
      }),
    ).rejects.toThrow(/Commitment Asset/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a missing Commitment Investor parent link fails loudly, naming the Commitment Investor role', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    await expect(
      adapter().createRecord({
        recordType: 'AddFundDrawdown',
        fields: { Date: '2026-07-20', Amount: 100000, 'Commitment Price': 500000, Currency: 'USD' },
        mutationContext,
        parentLinks: [
          { recordType: 'Legal Entity', externalId: 'fund-1', edgeName: 'AddFundDrawdown' },
          { recordType: 'Asset', externalId: 'asset-1', edgeName: 'Commitment Asset' },
        ],
      }),
    ).rejects.toThrow(/Commitment Investor/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('AddFundDrawdown — describe surfaces the action', () => {
  it("Legal Entity's references include writable AddFundDrawdown and Commitment Investor edges", async () => {
    const descriptor = await adapter().describe('Legal Entity');
    const addFundDrawdown = descriptor!.references.find((r) => r.name === 'AddFundDrawdown');
    expect(addFundDrawdown).toBeDefined();
    expect(addFundDrawdown?.targetTypeId).toBe('AddFundDrawdown');
    expect(addFundDrawdown?.writable).toBe(true);

    // Role-edge names off Legal Entity are globally unique — `Commitment
    // Investor` is distinct from AddDividends' `Recipient` and
    // AddFundDistribution's `Distribution Recipient`.
    const commitmentInvestor = descriptor!.references.find((r) => r.name === 'Commitment Investor');
    expect(commitmentInvestor).toBeDefined();
    expect(commitmentInvestor?.targetTypeId).toBe('AddFundDrawdown');
    expect(commitmentInvestor?.writable).toBe(true);
  });

  it("Asset's references include the writable Commitment Asset edge", async () => {
    const descriptor = await adapter().describe('Asset');
    const commitmentAsset = descriptor!.references.find((r) => r.name === 'Commitment Asset');
    expect(commitmentAsset).toBeDefined();
    expect(commitmentAsset?.targetTypeId).toBe('AddFundDrawdown');
    expect(commitmentAsset?.writable).toBe(true);
  });

  it('AddFundDrawdown describes its four writable fields and the one readable Transaction receipt', async () => {
    const descriptor = await adapter().describe('AddFundDrawdown');
    expect(descriptor).not.toBeNull();
    const byName = new Map(descriptor!.fields.map((f) => [f.displayName, f]));
    expect(byName.get('Date')).toMatchObject({ kind: 'date', writable: true, required: true });
    expect(byName.get('Amount')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Commitment Price')).toMatchObject({ kind: 'number', writable: true, required: true });
    expect(byName.get('Currency')).toMatchObject({ kind: 'enum', writable: true, required: true });
    expect(byName.get('Price')).toBeUndefined();
    expect(descriptor!.fields).toHaveLength(4);
    expect(descriptor!.fields.some((f) => f.writable === false)).toBe(false);
    const transaction = descriptor!.references.find((r) => r.name === 'Transaction');
    expect(transaction).toMatchObject({ targetTypeId: 'Transaction', cardinality: 'one' });
    expect(descriptor!.references).toHaveLength(1);
  });
});

describe('AddFundDrawdown — the receipt is walkable', () => {
  const receiptPosition = (data: { transactionId?: string; priceId?: string }) =>
    makeStablePosition({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      recordType: 'AddFundDrawdown',
      recordId: 'tx-1',
      data,
    });

  it('drawdown-[:Transaction]-> fetches the drawdown transaction by id', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(recordResponse({ id: 'tx-1', closeDate: '2026-07-20' }));

    const results = await adapter().getRelated({
      position: receiptPosition({ transactionId: 'tx-1', priceId: 'price-1' }),
      fieldId: 'Transaction',
      direction: 'outgoing',
    });

    const url = new URL(String(fetchSpy.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/v1/valuations/transactions/tx-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.position.recordType).toBe('Transaction');
  });

  it('a missing transactionId means Transaction returns [] without fetching', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');

    const results = await adapter().getRelated({
      position: receiptPosition({}),
      fieldId: 'Transaction',
      direction: 'outgoing',
    });

    expect(results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
