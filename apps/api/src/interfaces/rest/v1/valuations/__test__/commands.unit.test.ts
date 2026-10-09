// REST command route test for POST /valuations/commands/add-markdown. `applyMarkdown`
// has its own unit test (lib/valuations/commands/__test__/markdown.unit.test.ts), so
// this mocks it (and the transaction entry point) and asserts only the route's own
// behaviour: body parsing, transaction entry, envelope shape, status codes.
//
// Mirrors the in-process express + node:http harness used by
// interfaces/rest/__test__/connect_intrinsic.unit.test.ts (mount the router under
// test on a real server, drive it with fetch — no supertest dependency in this repo).

import { createServer, type Server } from 'node:http';

import express from 'express';
import { Router } from 'express';

import type { AddressInfo } from 'node:net';

const applyMarkdown = jest.fn();
const applyInvestment = jest.fn();
const applyPrice = jest.fn();
const applyRound = jest.fn();
const applyWindDown = jest.fn();
const applyShareSplit = jest.fn();
const applyDividends = jest.fn();
const applyFundDistribution = jest.fn();
const applyFundDrawdown = jest.fn();
const enterTransaction = jest.fn();

jest.mock('../../../../../lib/valuations/commands/markdown', () => ({
  applyMarkdown: (input: unknown) => applyMarkdown(input),
}));

jest.mock('../../../../../lib/valuations/commands/investment', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/investment');
  return {
    ...actual,
    applyInvestment: (input: unknown) => applyInvestment(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/price', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/price');
  return {
    ...actual,
    applyPrice: (input: unknown) => applyPrice(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/round', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/round');
  return {
    ...actual,
    applyRound: (input: unknown) => applyRound(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/wind_down', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/wind_down');
  return {
    ...actual,
    applyWindDown: (input: unknown) => applyWindDown(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/share_split', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/share_split');
  return {
    ...actual,
    applyShareSplit: (input: unknown) => applyShareSplit(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/dividends', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/dividends');
  return {
    ...actual,
    applyDividends: (input: unknown) => applyDividends(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/fund_distribution', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/fund_distribution');
  return {
    ...actual,
    applyFundDistribution: (input: unknown) => applyFundDistribution(input),
  };
});

jest.mock('../../../../../lib/valuations/commands/fund_drawdown', () => {
  const actual = jest.requireActual('../../../../../lib/valuations/commands/fund_drawdown');
  return {
    ...actual,
    applyFundDrawdown: (input: unknown) => applyFundDrawdown(input),
  };
});

jest.mock('../../../../../services/context', () => ({
  currentContext: () => ({ enterTransaction: () => enterTransaction() }),
}));

import { commandsRouter } from '../commands';

let server: Server;
let baseUrl: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/commands', commandsRouter as Router);
  server = createServer(app);
  server.listen(0, () => {
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /commands/add-markdown', () => {
  it('parses a valid body, enters a transaction, calls applyMarkdown once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyMarkdown.mockResolvedValue({ eventId: 'event-1', priceIds: ['price-1', 'price-2'] });

    const body = {
      companyId: '11111111-1111-1111-8111-111111111111',
      date: '2026-07-20',
      percentage: 40,
      note: 'board pack',
    };

    const res = await fetch(`${baseUrl}/commands/add-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'event-1', priceIds: ['price-1', 'price-2'] } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyMarkdown).toHaveBeenCalledTimes(1);
    expect(applyMarkdown).toHaveBeenCalledWith(body);
  });

  it('returns 400 on a malformed body (missing percentage) without calling applyMarkdown', async () => {
    const res = await fetch(`${baseUrl}/commands/add-markdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId: '11111111-1111-1111-8111-111111111111',
        date: '2026-07-20',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyMarkdown).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-investment', () => {
  const validBody = {
    entity: 'company-1',
    investingEntity: 'fund-1',
    investingEntityName: 'Acme Fund',
    roundName: 'Series A',
    investmentDate: '2026-07-20',
    investmentAmount: '1000000',
    investmentCurrency: 'USD',
    investmentType: 'EQUITY' as const,
    numberOfShares: '1000',
    pricePerShare: '100',
    pricePerShareCurrency: 'USD',
    shareClass: 'Series A Preferred',
  };

  it('parses a valid body, enters a transaction, calls applyInvestment once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyInvestment.mockResolvedValue({ investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' });

    const res = await fetch(`${baseUrl}/commands/add-investment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyInvestment).toHaveBeenCalledTimes(1);
    expect(applyInvestment).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing entity and investingEntity) without calling applyInvestment', async () => {
    const { entity: _entity, investingEntity: _investingEntity, ...rest } = validBody;

    const res = await fetch(`${baseUrl}/commands/add-investment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rest),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyInvestment).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-price', () => {
  it('parses a valid body, enters a transaction, calls applyPrice once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyPrice.mockResolvedValue({ priceId: 'price-1' });

    const body = {
      companyId: '11111111-1111-1111-8111-111111111111',
      price: 12.5,
      currency: 'USD',
      date: '2026-07-20',
      note: 'x',
    };

    const res = await fetch(`${baseUrl}/commands/add-price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { priceId: 'price-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyPrice).toHaveBeenCalledTimes(1);
    expect(applyPrice).toHaveBeenCalledWith(body);
  });

  it('returns 400 on a malformed body (missing price) without calling applyPrice', async () => {
    const res = await fetch(`${baseUrl}/commands/add-price`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId: '11111111-1111-1111-8111-111111111111',
        currency: 'USD',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyPrice).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-round', () => {
  const validBody = {
    entity: 'company-1',
    roundName: 'Series B',
    date: '2026-07-20',
    currency: 'USD',
    pricePerShare: '10',
    valuationAmount: '5000000',
    valuationType: 'POST_MONEY' as const,
    totalRaisedAmount: '1000000',
  };

  it('parses a valid body, enters a transaction, calls applyRound once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyRound.mockResolvedValue({ eventId: 'ev-1', priceId: 'pr-1' });

    const res = await fetch(`${baseUrl}/commands/add-round`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'ev-1', priceId: 'pr-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyRound).toHaveBeenCalledTimes(1);
    expect(applyRound).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing roundName and entity) without calling applyRound', async () => {
    const { entity: _entity, roundName: _roundName, ...rest } = validBody;

    const res = await fetch(`${baseUrl}/commands/add-round`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rest),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyRound).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-wind-down', () => {
  const validBody = {
    companyId: '11111111-1111-1111-8111-111111111111',
    date: '2026-07-20',
  };

  it('parses a valid body, enters a transaction, calls applyWindDown once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyWindDown.mockResolvedValue({ eventId: 'ev-1' });

    const res = await fetch(`${baseUrl}/commands/add-wind-down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'ev-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyWindDown).toHaveBeenCalledTimes(1);
    expect(applyWindDown).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing companyId and date) without calling applyWindDown', async () => {
    const res = await fetch(`${baseUrl}/commands/add-wind-down`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyWindDown).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-share-split', () => {
  const validBody = {
    companyId: '11111111-1111-1111-8111-111111111111',
    date: '2026-07-20',
    multiple: 10,
  };

  it('parses a valid body, enters a transaction, calls applyShareSplit once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyShareSplit.mockResolvedValue({ eventId: 'ev-1' });

    const res = await fetch(`${baseUrl}/commands/add-share-split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'ev-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyShareSplit).toHaveBeenCalledTimes(1);
    expect(applyShareSplit).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing multiple) without calling applyShareSplit', async () => {
    const res = await fetch(`${baseUrl}/commands/add-share-split`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId: '11111111-1111-1111-8111-111111111111',
        date: '2026-07-20',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyShareSplit).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-dividends', () => {
  const validBody = {
    companyId: '11111111-1111-1111-8111-111111111111',
    date: '2026-07-20',
    amount: 50000,
    currency: 'USD',
    fundId: '22222222-2222-2222-8222-222222222222',
  };

  it('parses a valid body, enters a transaction, calls applyDividends once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyDividends.mockResolvedValue({ eventId: 'ev-1' });

    const res = await fetch(`${baseUrl}/commands/add-dividends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'ev-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyDividends).toHaveBeenCalledTimes(1);
    expect(applyDividends).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing fundId and amount) without calling applyDividends', async () => {
    const { fundId: _fundId, amount: _amount, ...rest } = validBody;

    const res = await fetch(`${baseUrl}/commands/add-dividends`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rest),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyDividends).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-fund-distribution', () => {
  const validBody = {
    companyId: '11111111-1111-1111-8111-111111111111',
    date: '2026-07-20',
    amount: 25000,
    currency: 'USD',
    fundId: '22222222-2222-2222-8222-222222222222',
  };

  it('parses a valid body, enters a transaction, calls applyFundDistribution once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyFundDistribution.mockResolvedValue({ eventId: 'ev-1' });

    const res = await fetch(`${baseUrl}/commands/add-fund-distribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { eventId: 'ev-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyFundDistribution).toHaveBeenCalledTimes(1);
    expect(applyFundDistribution).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing fundId) without calling applyFundDistribution', async () => {
    const { fundId: _fundId, ...rest } = validBody;

    const res = await fetch(`${baseUrl}/commands/add-fund-distribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rest),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyFundDistribution).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /commands/add-fund-drawdown', () => {
  const validBody = {
    fundId: '11111111-1111-1111-8111-111111111111',
    drawdownAmount: 100000,
    date: '2026-07-20',
    assetId: '22222222-2222-2222-8222-222222222222',
    investorId: '33333333-3333-3333-8333-333333333333',
    price: 500000,
    currency: 'USD',
  };

  it('parses a valid body, enters a transaction, calls applyFundDrawdown once, and returns 201 with its receipt', async () => {
    enterTransaction.mockResolvedValue(undefined);
    applyFundDrawdown.mockResolvedValue({ transactionId: 'tx-1', priceId: 'price-1' });

    const res = await fetch(`${baseUrl}/commands/add-fund-drawdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ data: { transactionId: 'tx-1', priceId: 'price-1' } });

    expect(enterTransaction).toHaveBeenCalledTimes(1);
    expect(applyFundDrawdown).toHaveBeenCalledTimes(1);
    expect(applyFundDrawdown).toHaveBeenCalledWith(validBody);
  });

  it('returns 400 on a malformed body (missing investorId) without calling applyFundDrawdown', async () => {
    const { investorId: _investorId, ...rest } = validBody;

    const res = await fetch(`${baseUrl}/commands/add-fund-drawdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rest),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Invalid request body');
    expect(applyFundDrawdown).not.toHaveBeenCalled();
    expect(enterTransaction).not.toHaveBeenCalled();
  });
});
