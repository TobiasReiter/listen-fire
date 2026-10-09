// Validates the full valuations tool surface: every tool's input schema is
// extractable from its procedure and clears the friendly-name/boot guards, and
// a representative write round-trips through the caller.

import { randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { UserId } from '../../../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../../../lib/kysely';
import { Context } from '../../../../services/context';
import { buildMcpServer, createMcpRouter } from '../../server';
import { valuationsTools } from '..';
import { valuationsWriteTools } from '../writes';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import EventType from '../../../../generated/kysely/valuations/EventType';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { userPrincipal } from '../../../../services/principal';
import { valuationQueryInput } from '../../../../lib/valuations/query';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

let teamId: TeamId;
let userId: UserId;
let companyId: string;

async function run<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId, teamId }));
  return ctx.runAsync(fn);
}

beforeAll(async () => {
  teamId = randomUUID() as TeamId;
  userId = randomUUID() as UserId;
  companyId = randomUUID();
  await getCoreQb(['team']).insertInto('team').values(anyVals({ id: teamId, name: `tools-${teamId.slice(0, 8)}` })).execute();
  await getCoreQb(['user']).insertInto('user').values(anyVals({ id: userId, default_team_id: teamId, username: `tools-${userId.slice(0, 8)}` })).execute();
  await getCoreQb(['user_email']).insertInto('user_email').values(anyVals({ id: randomUUID(), user_id: userId, email: `tools-${userId.slice(0, 8)}@test-vc-firm.com`, is_primary: true })).execute();
  await getValuationsQb(['legal_entity']).insertInto('legal_entity').values(anyVals({ id: companyId, team_id: teamId, name: 'Priceable Co', slug: `priceable-${companyId.slice(0, 8)}`, type: LegalEntityType.COMPANY })).execute();
  await getValuationsQb(['asset']).insertInto('asset').values(anyVals({ id: randomUUID(), team_id: teamId, issued_by_legal_entity_id: companyId, name: 'Shares', properties: {}, type: AssetType.EQUITY })).execute();
});

afterAll(async () => {
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', teamId).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', teamId).execute();
  await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', teamId).execute();
  await getValuationsQb(['valuations_change_outbox']).deleteFrom('valuations_change_outbox').where('team_id', '=', teamId).execute();
  await getCoreQb(['user_email']).deleteFrom('user_email').where('user_id', '=', userId).execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', teamId).execute();
});

describe('valuations tool surface', () => {
  it('registers every tool (schemas extracted, guards pass)', () => {
    expect(() => createMcpRouter({ name: 'test', domain: 'valuations', tools: valuationsTools })).not.toThrow();
    expect(Object.keys(valuationsTools).length).toBeGreaterThan(35);
    // Spot-check a couple of extracted schemas.
    expect(Object.keys(valuationsTools.addMarkdown.inputSchema)).toEqual(
      expect.arrayContaining(['companyId', 'date', 'percentage']),
    );
    expect(valuationsTools.addMarkdown.annotations.destructiveHint).toBe(true);
    expect(valuationsTools.getPriceAssetOptions.annotations.readOnlyHint).toBe(true);
  });

  // The list is the only thing a client ever sees, and the SDK builds every
  // tool's JSON Schema inside the handler that serves it — so one unconvertible
  // input (a `z.date()` read off a procedure) takes down the WHOLE list, as a
  // JSON-RPC error inside an HTTP 200. Asserting on our registration objects
  // would have proved nothing: they were all fine. Ask a real client instead.
  it('serves the whole surface to a real client', async () => {
    const server = buildMcpServer(
      { name: 'test', domain: 'valuations', tools: valuationsTools },
      async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-host', version: '1.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(Object.keys(valuationsTools)));
      // The date filters are published as the strings a client can send.
      const query = listed.tools.find((tool) => tool.name === 'queryValuations');
      expect((query?.inputSchema.properties as Record<string, unknown>).asOfDate).toEqual({
        type: 'string',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('a write tool (addPrice) round-trips through the caller', async () => {
    // The mutation runs in the caller's transaction, which commits when the
    // context closes — so assert against the committed row after run() returns.
    await run(async () => {
      const result = (await valuationsWriteTools.addPrice.handler!({
        companyId,
        price: 12.5,
        currency: 'USD',
        date: '2024-03-01',
      })) as { content: { text: string }[]; isError?: boolean };
      if (result.isError) throw new Error(result.content[0].text);
    });

    const inserted = await getValuationsQb(['price'])
      .selectFrom('price')
      .select(['price', 'currency'])
      .where('team_id', '=', teamId)
      .where('legal_entity_id', '=', companyId as never)
      .executeTakeFirst();
    expect(inserted?.price).toBeCloseTo(12.5, 2);
    expect(inserted?.currency).toBe(CurrencyIsoCode.USD);
  });

  describe('queryValuations', () => {
    // The tool publishes a string because that is all a client can send, but
    // the procedure is also called in-process with real `Date`s — both must
    // still land on the same parsed `Date`.
    it('takes its dates as an ISO string or as a Date', () => {
      const fromString = valuationQueryInput.parse({ currency: 'USD', asOfDate: '2024-03-01' });
      const fromDate = valuationQueryInput.parse({ currency: 'USD', asOfDate: new Date('2024-03-01') });
      expect(fromString.asOfDate).toEqual(new Date('2024-03-01'));
      expect(fromDate.asOfDate).toEqual(new Date('2024-03-01'));
      expect(() => valuationQueryInput.parse({ currency: 'USD', asOfDate: 'not a date' })).toThrow();
    });

    // A share-for-share deal, mirroring
    // ../../../trpc/views/__test__/csvExportAtoms.integration.test.ts: $50k for
    // 20 A-shares, then Company B acquires Company A for 15 B-shares plus $5k
    // cash, then a $4k dividend from B on the stock it issued in the swap. The
    // held B-shares are a degree-1 lot walked out of the original investment.
    const VALUATION_DATE = '2022-12-31';
    const A_SHARE_PRICE = 3000;
    const B_SHARE_PRICE = 2000;
    const SHARES_HELD = 15 * B_SHARE_PRICE;

    let queryTeamId: TeamId;
    let queryUserId: UserId;
    let fundId: string;
    let investmentId: string;
    let companyAId: string;
    let companyBId: string;
    const usdAssetIds: string[] = [];

    beforeAll(async () => {
      queryTeamId = randomUUID() as TeamId;
      queryUserId = randomUUID() as UserId;
      fundId = randomUUID();
      companyAId = randomUUID();
      companyBId = randomUUID();
      const usdAssetId = randomUUID();
      const aShares = randomUUID();
      const bShares = randomUUID();

      await getCoreQb(['team']).insertInto('team').values(anyVals({ id: queryTeamId, name: `query-${queryTeamId.slice(0, 8)}` })).execute();
      await getValuationsQb(['legal_entity']).insertInto('legal_entity').values([
        anyVals({ id: fundId, team_id: queryTeamId, name: 'Our Fund', type: LegalEntityType.FUND, is_own_investing_entity: true }),
        anyVals({ id: companyAId, team_id: queryTeamId, name: 'Company A', type: LegalEntityType.COMPANY }),
        anyVals({ id: companyBId, team_id: queryTeamId, name: 'Company B', type: LegalEntityType.COMPANY }),
      ]).execute();
      await getValuationsQb(['asset']).insertInto('asset').values([
        anyVals({ id: usdAssetId, team_id: queryTeamId, issued_by_legal_entity_id: fundId, name: 'USD', properties: {}, type: AssetType.CURRENCY }),
        anyVals({ id: aShares, team_id: queryTeamId, issued_by_legal_entity_id: companyAId, name: 'A Shares', properties: {}, type: AssetType.EQUITY }),
        anyVals({ id: bShares, team_id: queryTeamId, issued_by_legal_entity_id: companyBId, name: 'B Shares', properties: {}, type: AssetType.EQUITY }),
      ]).execute();
      usdAssetIds.push(usdAssetId);
      await getValuationsQb(['currency_asset']).insertInto('currency_asset').values(
        anyVals({ id: randomUUID(), asset_id: usdAssetId, iso_code: CurrencyIsoCode.USD, name: 'US Dollar', symbol: '$', pair_order: 1 }),
      ).execute();

      investmentId = randomUUID();
      await getValuationsQb(['investment']).insertInto('investment').values(
        anyVals({ id: investmentId, team_id: queryTeamId, investor_profile_id: fundId, investment_profile_id: companyAId, invested_at: '2022-01-01' }),
      ).execute();

      const tx1 = randomUUID();
      await getValuationsQb(['transaction']).insertInto('transaction').values(
        anyVals({ id: tx1, team_id: queryTeamId, close_date: '2022-01-01', investment_id: investmentId }),
      ).execute();
      await getValuationsQb(['asset_transfer']).insertInto('asset_transfer').values([
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx1, date: '2022-01-01', asset_id: usdAssetId, num_assets: 50000, from_legal_entity_id: fundId, to_legal_entity_id: companyAId }),
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx1, date: '2022-01-01', asset_id: aShares, num_assets: 20, from_legal_entity_id: companyAId, to_legal_entity_id: fundId }),
      ]).execute();

      const tx2 = randomUUID();
      await getValuationsQb(['transaction']).insertInto('transaction').values(
        anyVals({ id: tx2, team_id: queryTeamId, close_date: '2022-06-01' }),
      ).execute();
      await getValuationsQb(['asset_transfer']).insertInto('asset_transfer').values([
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx2, date: '2022-06-01', asset_id: aShares, num_assets: 20, from_legal_entity_id: fundId, to_legal_entity_id: companyBId }),
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx2, date: '2022-06-01', asset_id: bShares, num_assets: 15, from_legal_entity_id: companyBId, to_legal_entity_id: fundId }),
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx2, date: '2022-06-01', asset_id: usdAssetId, num_assets: 5000, from_legal_entity_id: companyBId, to_legal_entity_id: fundId }),
      ]).execute();

      await getValuationsQb(['legal_entity']).updateTable('legal_entity').set(anyVals({ acquired_by_legal_entity_id: companyBId })).where('id', '=', companyAId as never).execute();

      const tx3 = randomUUID();
      await getValuationsQb(['transaction']).insertInto('transaction').values(
        anyVals({ id: tx3, team_id: queryTeamId, close_date: '2022-08-01', due_to_rights_from_asset_id: bShares }),
      ).execute();
      await getValuationsQb(['asset_transfer']).insertInto('asset_transfer').values(
        anyVals({ id: randomUUID(), team_id: queryTeamId, transaction_id: tx3, date: '2022-08-01', asset_id: usdAssetId, num_assets: 4000, from_legal_entity_id: companyBId, to_legal_entity_id: fundId }),
      ).execute();

      const exitEventId = randomUUID();
      await getValuationsQb(['event']).insertInto('event').values(
        anyVals({ id: exitEventId, team_id: queryTeamId, legal_entity_id: companyAId, name: 'Acquisition exit', type: EventType.DISTRIBUTION, date: '2022-06-01' }),
      ).execute();
      await getValuationsQb(['investment']).insertInto('investment').values(
        anyVals({ id: randomUUID(), team_id: queryTeamId, investor_profile_id: fundId, investment_profile_id: companyBId, invested_at: '2022-06-01', event_id: exitEventId }),
      ).execute();

      await getValuationsQb(['price']).insertInto('price').values([
        anyVals({ id: randomUUID(), team_id: queryTeamId, date: '2022-01-02', price: A_SHARE_PRICE, currency: CurrencyIsoCode.USD, asset_id: aShares, legal_entity_id: companyAId, type: 'FROM_ASSET_HOLDER' }),
        anyVals({ id: randomUUID(), team_id: queryTeamId, date: '2022-06-02', price: B_SHARE_PRICE, currency: CurrencyIsoCode.USD, asset_id: bShares, legal_entity_id: companyBId, type: 'FROM_ASSET_HOLDER' }),
      ]).execute();
    });

    afterAll(async () => {
      await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['asset_transfer']).deleteFrom('asset_transfer').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['transaction']).deleteFrom('transaction').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['investment']).deleteFrom('investment').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', queryTeamId).execute();
      for (const id of usdAssetIds) {
        await getValuationsQb(['currency_asset']).deleteFrom('currency_asset').where('asset_id', '=', id as never).execute();
      }
      await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['legal_entity']).updateTable('legal_entity').set(anyVals({ acquired_by_legal_entity_id: null })).where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['legal_entity']).deleteFrom('legal_entity').where('team_id', '=', queryTeamId).execute();
      await getValuationsQb(['valuations_change_outbox']).deleteFrom('valuations_change_outbox').where('team_id', '=', queryTeamId).execute();
      await getCoreQb(['team']).deleteFrom('team').where('id', '=', queryTeamId).execute();
    });

    async function callTool(args: Record<string, unknown>): Promise<{ rows: { groupKey: Record<string, unknown>; cashPaid: number; cashReceived: number; heldValue: number }[] }> {
      const ctx = new Context();
      ctx.bindPrincipal(userPrincipal({ userId: queryUserId, teamId: queryTeamId }));
      return ctx.runAsync(async () => {
        const result = (await valuationsTools.queryValuations.handler!(args)) as {
          content: { text: string }[];
          isError?: boolean;
        };
        if (result.isError) throw new Error(result.content[0].text);
        return JSON.parse(result.content[0].text);
      });
    }

    it('is registered on the tool surface', () => {
      expect(valuationsTools.queryValuations).toBeDefined();
      expect(valuationsTools.queryValuations.annotations.readOnlyHint).toBe(true);
      expect(Object.keys(valuationsTools.queryValuations.inputSchema)).toEqual(
        expect.arrayContaining(['investments', 'degree', 'leafType', 'groupBy', 'currency', 'asOfDate']),
      );
    });

    it('grouped by company, files the acquirer shares under the acquired company at degree 1', async () => {
      const byCompany = await callTool({
        investments: { ids: [investmentId] },
        groupBy: ['company'],
        currency: 'USD',
        asOfDate: VALUATION_DATE,
      });
      expect(byCompany.rows).toHaveLength(1);
      expect(byCompany.rows[0].groupKey.company).toMatchObject({ id: companyAId });
      expect(byCompany.rows[0].heldValue).toBeCloseTo(SHARES_HELD, 6);

      const byCompanyAndDegree = await callTool({
        investments: { ids: [investmentId] },
        leafType: 'held',
        groupBy: ['company', 'degree'],
        currency: 'USD',
        asOfDate: VALUATION_DATE,
      });
      const degreeOne = byCompanyAndDegree.rows.find((r) => r.groupKey.degree === 1);
      if (!degreeOne) throw new Error('expected a degree-1 row for the swapped-in shares');
      expect(degreeOne.groupKey.company).toMatchObject({ id: companyAId });
      expect(degreeOne.heldValue).toBeCloseTo(SHARES_HELD, 6);
    });

    it('grouped by trackedEntity, files the shares under the acquirer holding them now', async () => {
      const byTrackedEntity = await callTool({
        investments: { ids: [investmentId] },
        leafType: 'held',
        groupBy: ['trackedEntity'],
        currency: 'USD',
        asOfDate: VALUATION_DATE,
      });
      // A fully-swapped-out degree-0 lot leaves a zero-value residual row under
      // its own tracked entity — the assertion that matters is that the value
      // itself lands on the acquirer's line, once, not split or duplicated.
      const acquirerRow = byTrackedEntity.rows.find(
        (r) => (r.groupKey.trackedEntity as { id: string } | undefined)?.id === companyBId,
      );
      if (!acquirerRow) throw new Error('expected a row tracking Company B');
      expect(acquirerRow.heldValue).toBeCloseTo(SHARES_HELD, 6);
      const totalHeld = byTrackedEntity.rows.reduce((sum, r) => sum + r.heldValue, 0);
      expect(totalHeld).toBeCloseTo(SHARES_HELD, 6);
    });
  });
});
