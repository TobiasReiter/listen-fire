import * as db from '@prisma/client';
import { z } from 'zod';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { sql } from 'kysely';
import { formatDate } from 'date-fns';

import { ProfileService } from '../../../../services/profiles/profile';
import {
  getQb,
  jsonbAgg,
  jsonbBuildObject,
  pathString,
  getValuationsQb,
} from '../../../../lib/kysely';
import { trpc } from '../../trpc';
import { isReportableInvestment } from '../reportableInvestments';
import { currentContext } from '../../../../services/context';
import { getCurrencyAsset } from '../../../../lib/datasources/asset';
import { topVcs } from './topVcs';
import { getCompanyAcquisitions } from './acquisitions';
import { notNull, notUndefined } from '../../../../lib/utils/nullability';
import { getInvestmentsValuation } from '../../../../lib/valuations/valuation';
import { deriveInvestmentStatus } from '../../../../lib/valuations/valuation/status';
import {
  ClassifiedTransactionFlow,
  getClassifiedTransactionFlows,
  getInventoryForInvestments,
} from '../../../../lib/valuations/inventory';
import { startCase } from 'movement-engine/lib/utils/string';
import { prismaClient } from '../../../../prisma';
import { CurrencyAsset } from '../../../../lib/datasources/currency';
import { convertConvertible } from '../../../../lib/convertible';
import {
  transformHoldings,
  transformHoldingsForDisplay,
} from '../../../../lib/valuations/inventory/utils';
import { LegalEntity } from '../../../../lib/datasources/legal_entity';
import { MessageCollector, ProcessMessage } from '../../../../lib/valuations/messages';
import { AssetKey, InvestingEntityKey } from '../../../../lib/valuations/inventory/types';
import { neverAsAny } from 'movement-engine/lib/utils/types';
import { LegalEntityId } from '../../../../generated/kysely/valuations/LegalEntity';
import { logFundingChange, formatCurrency } from '../../../../lib/funding-changelog';
import { applyMarkdown } from '../../../../lib/valuations/commands/markdown';
import {
  applyInvestment,
  resolveInvestmentEntities,
} from '../../../../lib/valuations/commands/investment';
import { applyPrice } from '../../../../lib/valuations/commands/price';
import { applyRound, resolveRoundEntities } from '../../../../lib/valuations/commands/round';
import { applyWindDown } from '../../../../lib/valuations/commands/wind_down';
import { applyShareSplit } from '../../../../lib/valuations/commands/share_split';
import { applyDividends } from '../../../../lib/valuations/commands/dividends';
import { applyFundDistribution } from '../../../../lib/valuations/commands/fund_distribution';
import { applyFundDrawdown } from '../../../../lib/valuations/commands/fund_drawdown';
import { TeamId } from '../../../../generated/kysely/core/Team';
import { EventId } from '../../../../generated/kysely/valuations/Event';
import EventType from '../../../../generated/kysely/valuations/EventType';
import { PriceId } from '../../../../generated/kysely/valuations/Price';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import { AssetId } from '../../../../generated/kysely/valuations/Asset';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import CompanyLegalStatus from '../../../../generated/kysely/valuations/CompanyLegalStatus';
import ConvertibleType from '../../../../generated/kysely/valuations/ConvertibleType';
import ValuationType from '../../../../generated/kysely/valuations/ValuationType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../../../generated/kysely/valuations/PriceType';
import NoteType from '../../../../generated/kysely/valuations/NoteType';
import { NoteId } from '../../../../generated/kysely/valuations/Note';
import { UserId } from '../../../../generated/kysely/core/User';

const currencyOptions = Object.values(CurrencyIsoCode) as unknown as readonly [
  keyof typeof CurrencyIsoCode,
  ...Array<keyof typeof CurrencyIsoCode>,
];

const companyRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    getAllPortfolios: procedure.query(async () => {
      const ctx = currentContext();
      return ctx.prisma.legalEntity.findMany({
        where: { isPortfolio: true, teamId: ctx.user.teamId },
        orderBy: { name: 'asc' },
      });
    }),
    convertTransaction: procedure
      .input(
        z.object({
          transactionId: z.string(),
          assetId: z.string(),
          conversionDate: z.string(),
          conversionPrice: z.string(),
          interest: z.string().optional(),
          numShares: z.string(),
          shareClass: z.string(),
          currency: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const conversionTransaction = await convertConvertible(
          {
            currency: input.currency as CurrencyIsoCode,
            transactionId: input.transactionId,
            conversionDate: new Date(input.conversionDate),
            conversionPrice: parseFloat(input.conversionPrice),
            interest: input.interest ? parseFloat(input.interest) : undefined,
            firstShares: {
              assetLegalName: input.shareClass,
              numAssets: parseFloat(input.numShares),
            },
          },
          ctx,
        );

        // Log changelog — look up company from the asset
        const convertedAsset = await ctx.prisma.asset.findFirst({
          where: { id: input.assetId, teamId: ctx.user.teamId },
          select: { issuedByLegalEntityId: true },
        });
        if (convertedAsset?.issuedByLegalEntityId) {
          const convDetails: string[] = [];
          convDetails.push(`Shares: ${input.numShares} ${input.shareClass}`);
          convDetails.push(
            `Conversion price: ${formatCurrency(input.conversionPrice, input.currency)}/share`,
          );
          if (input.interest) convDetails.push(`Accrued interest: ${input.interest}`);
          await logFundingChange({
            legalEntityId: convertedAsset.issuedByLegalEntityId,
            category: 'Convert Convertible',
            description: `Converted convertible\n${convDetails.join('\n')}`,
            eventDate: input.conversionDate,
          });
        }

        return conversionTransaction;
      }),
    getOverview: procedure
      .input(
        z.object({
          slug: z.string(),
          config: z
            .object({
              currency: z.enum(currencyOptions).nullish(),
              valuationDate: z.string().datetime().nullish(),
            })
            .nullish(),
        }),
      )
      .query(async ({ input: { slug, config } }) => {
        const ctx = currentContext();

        const company = await getValuationsQb(['legal_entity', 'investment', 'event', 'transaction'])
          .selectFrom('legal_entity as le')
          .leftJoin('legal_entity as acquirer', 'acquirer.id', 'le.acquired_by_legal_entity_id')
          .select(($) => [
            'le.id',
            'le.name',
            'le.legal_name',
            'le.legal_status',
            'le.also_known_as as otherNames',
            'le.slug',
            'le.personal_website',
            'le.short_description',
            'le.description',
            'le.country',
            'le.type',
            jsonbBuildObject($, {
              id: 'acquirer.id',
              name: 'acquirer.name',
              image_url: 'acquirer.image_url',
              slug: 'acquirer.slug',
            }).as('acquirer'),
            // Investments into this company made by an entity of OURS — a
            // fund we run or another portfolio company. The `is_portfolio`-only
            // test this used to carry made a fund's own investments invisible
            // here while every sibling procedure counted them; `jsonArrayFrom`
            // also coalesces to `[]`, which the declared type always claimed
            // and a bare JSONB_AGG never delivered.
            jsonArrayFrom(
              $.selectFrom('investment as i')
                .innerJoin('legal_entity as investor', 'investor.id', 'i.investor_profile_id')
                .select(['i.id', 'i.invested_at as date'])
                .whereRef('i.investment_profile_id', '=', 'le.id')
                .where('i.team_id', '=', ctx.user.teamId as TeamId)
                // These ids are what the page's invested / value / realised
                // figures are computed from, so an acquisition-consideration
                // position must not be among them — its value already reaches
                // this page through the acquired company's line.
                .where(($$) => isReportableInvestment($$, { event: 'event', investment: 'i' }))
                .where(($$) =>
                  $$.or([
                    $$('investor.is_portfolio', '=', true),
                    $$('investor.is_own_investing_entity', '=', true),
                  ]),
                ),
            ).as('investments'),
          ])
          .where('le.slug', '=', slug)
          .where('le.team_id', '=', ctx.user.teamId as TeamId)
          .executeTakeFirst();

        if (!company) {
          return null;
        }

        // Same rule as the figures above: a consideration position is not a
        // date we invested in this company, so the acquirer's page must not
        // date itself from the acquisition it was paid in.
        const firstInvested = await getValuationsQb(['investment', 'event', 'transaction'])
          .selectFrom('investment')
          .select('investment.invested_at')
          .where('investment.investment_profile_id', '=', company.id)
          .where(($) => isReportableInvestment($, { event: 'event' }))
          .orderBy('investment.invested_at', 'asc')
          .executeTakeFirst();

        const [
          investingEntities,
          latestRound,
          {
            totalValuationDateValue,
            retainedValue,
            realizedCashTransactionDateValue,
            investedTransactionDateValue,
            holdsRetainedAssets,
          },
          holdings,
          acquisitions,
        ] = await Promise.all([
          ProfileService.getInvestingEntities(company.id),
          ProfileService.getLatestRoundWithValuation(company.id, {
            targetCurrency: (config?.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
            fxDate: config?.valuationDate ? new Date(config.valuationDate) : new Date(),
          }),
          getInvestmentsValuation({
            investments: company.investments,
            targetCurrency: (config?.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
            asOfDate: config?.valuationDate ? new Date(config.valuationDate) : new Date(),
            fxDate: config?.valuationDate ? new Date(config.valuationDate) : new Date(),
          }),
          getInventoryForInvestments({
            investmentIds: company.investments.map((i) => i.id),
          }),
          getCompanyAcquisitions({
            companyId: company.id,
            teamId: ctx.user.teamId as TeamId,
            currency: (config?.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
            asOfDate: config?.valuationDate ? new Date(config.valuationDate) : new Date(),
            fxDate: config?.valuationDate ? new Date(config.valuationDate) : new Date(),
          }),
        ]);

        const moic = investedTransactionDateValue
          ? totalValuationDateValue / investedTransactionDateValue
          : null;
        let totalShares = 0;
        for (const assetData of holdings.values()) {
          for (const [_, assetHolding] of assetData.getManyByType('EQUITY')) {
            const { fromInvestment } = assetHolding.sum();
            totalShares += fromInvestment;
          }
        }

        return {
          ...company,
          investingEntities: investingEntities.map((e) => {
            return {
              id: e.id,
              name: e.name,
            };
          }),
          invested: investedTransactionDateValue,
          value: retainedValue,
          realizedValue: realizedCashTransactionDateValue,
          status: deriveInvestmentStatus(holdsRetainedAssets),
          latestRound,
          totalShares,
          firstInvested: firstInvested?.invested_at?.toISOString() ?? null,
          moic,
          holdings: transformHoldingsForDisplay(holdings),
          // Positions taken here as payment for another company being
          // acquired. Never part of the figures above.
          acquisitions,
        };
      }),
    addDividends: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string(),
          amount: z.number(),
          currency: z.string(),
          fundId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyDividends(input);

        return true;
      }),
    addFundDistribution: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string(),
          amount: z.number(),
          currency: z.string(),
          fundId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyFundDistribution(input);
      }),
    removeMarkdown: procedure
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const event = await getValuationsQb(['event'])
          .selectFrom('event')
          .select(['legal_entity_id', 'date', 'data'])
          .where('id', '=', input.id as EventId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .executeTakeFirst();

        await getValuationsQb(['price'])
          .deleteFrom('price')
          .where(($) =>
            $.and([
              $('team_id', '=', ctx.user.teamId as TeamId),
              $('event_id', '=', input.id as EventId),
            ]),
          )
          .execute();
        await getValuationsQb(['event'])
          .deleteFrom('event')
          .where(($) =>
            $.and([
              $('team_id', '=', ctx.user.teamId as TeamId),
              $('id', '=', input.id as EventId),
            ]),
          )
          .execute();

        if (event) {
          const pct = (event.data as { percentage?: number } | null)?.percentage;
          await logFundingChange({
            legalEntityId: event.legal_entity_id,
            category: 'Remove Markdown',
            description: `Removed markdown${pct != null ? ` of ${pct}%` : ''}`,
            eventDate: event.date,
          });
        }

        return true;
      }),
    removePrice: procedure
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const price = await getValuationsQb(['price'])
          .selectFrom('price')
          .select(['legal_entity_id', 'price', 'currency', 'date'])
          .where('id', '=', input.id as PriceId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .executeTakeFirst();

        await getValuationsQb(['price'])
          .deleteFrom('price')
          .where(($) =>
            $.and([
              $('team_id', '=', ctx.user.teamId as TeamId),
              $('id', '=', input.id as PriceId),
            ]),
          )
          .execute();

        if (price?.legal_entity_id) {
          await logFundingChange({
            legalEntityId: price.legal_entity_id,
            category: 'Remove Price',
            description: `Removed price of ${formatCurrency(price.price, price.currency)}`,
            eventDate: price.date,
          });
        }

        return true;
      }),
    updatePrice: procedure
      .input(
        z.object({
          id: z.string(),
          date: z.string().datetime().optional(),
          price: z.number().optional(),
          currency: z.nativeEnum(CurrencyIsoCode).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const existing = await getValuationsQb(['price'])
          .selectFrom('price')
          .select(['legal_entity_id', 'price', 'currency', 'date'])
          .where('id', '=', input.id as PriceId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .executeTakeFirst();

        const updateObj: {
          date?: Date;
          price?: number;
          currency?: CurrencyIsoCode;
        } = {};
        if (input.date !== undefined) {
          updateObj.date = new Date(input.date);
        }
        if (input.price !== undefined) {
          updateObj.price = input.price;
        }
        if (input.currency !== undefined) {
          updateObj.currency = input.currency;
        }

        await getValuationsQb(['price'])
          .updateTable('price')
          .set(updateObj)
          .where(($) =>
            $.and([
              $('team_id', '=', ctx.user.teamId as TeamId),
              $('id', '=', input.id as PriceId),
            ]),
          )
          .executeTakeFirst();

        if (existing?.legal_entity_id) {
          const upHeadline = 'Updated price';
          const upDetails: string[] = [];
          if (input.price !== undefined)
            upDetails.push(
              `New price: ${formatCurrency(input.price, input.currency ?? existing.currency)} (was ${formatCurrency(existing.price, existing.currency)})`,
            );
          if (input.date !== undefined) upDetails.push(`Date updated`);
          await logFundingChange({
            legalEntityId: existing.legal_entity_id,
            category: 'Update Price',
            description:
              upDetails.length > 0 ? `${upHeadline}\n${upDetails.join('\n')}` : upHeadline,
            eventDate: input.date ?? existing.date,
          });
        }

        return true;
      }),
    addPrice: procedure
      .input(
        z.object({
          companyId: z.string(),
          assetId: z.string().optional(),
          price: z.number(),
          currency: z.nativeEnum(CurrencyIsoCode),
          date: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyPrice(input);

        return { success: true };
      }),
    getPriceAssetOptions: procedure
      .input(
        z.object({
          companyId: z.string(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        const investments = await getValuationsQb(['investment', 'legal_entity'])
          .selectFrom('investment')
          .innerJoin('legal_entity', 'investment.investor_profile_id', 'legal_entity.id')
          .where(($) =>
            $.and([
              $('investment.team_id', '=', ctx.user.teamId as TeamId),
              $('investment.investment_profile_id', '=', input.companyId as LegalEntityId),
              $.or([
                $('legal_entity.is_portfolio', '=', true),
                $('legal_entity.is_own_investing_entity', '=', true),
              ]),
            ]),
          )
          .select(['investment.id'])
          .execute();

        const holdings = await getInventoryForInvestments({
          investmentIds: investments.map((i) => i.id),
          asOfDate: new Date(),
        });

        const assets: Map<
          string,
          {
            assetName: string;
            assetType: string;
          }
        > = new Map();
        holdings.values().forEach((holdings) => {
          holdings.entries().forEach(([assetKey]) => {
            const assetId = assetKey.split(':')[0];
            const assetName = assetKey.split(':')[1];
            const assetType = assetKey.split(':')[2];

            if (!assets.has(assetId) && assetType !== 'EQUITY' && assetType !== 'CURRENCY') {
              assets.set(assetId, {
                assetName,
                assetType,
              });
            }
          });
        });

        return Array.from(assets.entries()).map(([assetId, asset]) => ({
          value: assetId,
          label: `${asset.assetName} (${asset.assetType})`,
        }));
      }),
    updateAssetTransfer: procedure
      .input(
        z.array(
          z.object({
            transferId: z.string(),
            fundId: z.string().optional(),
            numAssets: z.string().optional(),
            currency: z.nativeEnum(db.CurrencyIsoCode).optional().nullable(),
            assetName: z.string().optional(),
            date: z.string().optional(),
            type: z.nativeEnum(db.AssetType).optional(),
            assetId: z.string(),
            //convertible
            convertibleAssetId: z.string().optional(),
            conversionPrice: z.string().optional(),
            interestAmount: z.string().optional(),
            interestRate: z.string().optional(),
            discountRate: z.string().optional(),
            maturityDate: z.string().optional(),
            valuationCapCurrency: z.nativeEnum(db.CurrencyIsoCode).optional().nullable(),
            valuationCap: z.string().optional(),
            convertibleType: z.nativeEnum(db.ConvertibleType).optional(),
          }),
        ),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        // Every write below addresses a row by an id the CLIENT supplied, and
        // `update` takes only a unique where — so there is nowhere to hang a
        // tenant condition on the writes themselves. The ability used to refuse
        // another team's transfer at each one; establishing ownership once, up
        // front, is the same guarantee in the one place a reader will look for
        // it, and it fails the whole batch rather than half-applying it.
        const transferIds = input.map((t) => t.transferId);
        const convertibleAssetIds = input.map((t) => t.convertibleAssetId).filter(notUndefined);
        const [ownedTransfers, ownedConvertibles] = await Promise.all([
          ctx.prisma.assetTransfer.findMany({
            where: { teamId: ctx.user.teamId, id: { in: transferIds } },
            select: { id: true },
          }),
          ctx.prisma.asset.findMany({
            where: { teamId: ctx.user.teamId, id: { in: convertibleAssetIds } },
            select: { id: true },
          }),
        ]);
        const ownedTransferIds = new Set(ownedTransfers.map((t) => t.id));
        const ownedConvertibleIds = new Set(ownedConvertibles.map((a) => a.id));
        for (const id of transferIds) {
          if (!ownedTransferIds.has(id)) throw new Error(`Could not find asset transfer ${id}`);
        }
        for (const id of convertibleAssetIds) {
          if (!ownedConvertibleIds.has(id)) throw new Error(`Could not find asset ${id}`);
        }

        const currencyAssetTable = new CurrencyAsset(ctx);
        for (const transfer of input) {
          if (transfer.convertibleAssetId) {
            await ctx.prisma.asset.update({
              where: { id: transfer.convertibleAssetId },
              data: {
                conversionPrice: transfer.conversionPrice
                  ? parseFloat(transfer.conversionPrice)
                  : undefined,
                annualisedInterestRate: transfer.interestRate
                  ? parseFloat(transfer.interestRate)
                  : undefined,
                interest: transfer.interestAmount ? parseFloat(transfer.interestAmount) : undefined,
                maturityDate: transfer.maturityDate ? new Date(transfer.maturityDate) : undefined,
                discountRate: transfer.discountRate ? parseFloat(transfer.discountRate) : undefined,
                valuationCap: transfer.valuationCap ? parseFloat(transfer.valuationCap) : undefined,
                convertibleCurrency: transfer.valuationCapCurrency ?? undefined,
                convertibleType: transfer.convertibleType ?? undefined,
              },
            });
            await ctx.prisma.assetTransfer.update({
              where: { id: transfer.transferId },
              data: {
                numAssets: transfer.numAssets ? parseFloat(transfer.numAssets) : undefined,
                asset: {
                  update: {
                    name: transfer.assetName,
                  },
                },
                transaction: {
                  update: {
                    closeDate: transfer.date ? new Date(transfer.date) : undefined,
                  },
                },
              },
            });
            const eventToUpdate = await ctx.prisma.event.findFirst({
              where: {
                teamId: ctx.user.teamId,
                transactions: {
                  some: {
                    assetTransfers: {
                      some: {
                        id: transfer.transferId,
                        teamId: ctx.user.teamId,
                      },
                    },
                  },
                },
              },
            });
            if (eventToUpdate) {
              await ctx.prisma.event.update({
                where: {
                  id: eventToUpdate.id,
                },
                data: {
                  valuation: transfer.valuationCap ? parseFloat(transfer.valuationCap) : undefined,
                  valuationCurrency: transfer.valuationCapCurrency ?? undefined,
                },
              });
            }
          } else if (transfer.type === 'CURRENCY') {
            if (transfer.currency) {
              const currency = await currencyAssetTable.getByIsoCode(transfer.currency);
              await ctx.prisma.assetTransfer.update({
                where: { id: transfer.transferId },
                data: { assetId: currency.assetId },
              });
            }

            await ctx.prisma.assetTransfer.update({
              where: { id: transfer.transferId },
              data: {
                numAssets: transfer.numAssets ? parseFloat(transfer.numAssets) : undefined,
                asset: {
                  update: {
                    name: transfer.assetName,
                  },
                },
                transaction: {
                  update: {
                    closeDate: transfer.date ? new Date(transfer.date) : undefined,
                  },
                },
              },
            });
          } else {
            await ctx.prisma.assetTransfer.update({
              where: { id: transfer.transferId },
              data: {
                numAssets: transfer.numAssets ? parseFloat(transfer.numAssets) : undefined,
                asset: {
                  update: {
                    name: transfer.assetName,
                  },
                },
                transaction: {
                  update: {
                    closeDate: transfer.date ? new Date(transfer.date) : undefined,
                  },
                },
              },
            });
          }
        }

        // Log changelog — look up company from first transfer's asset
        if (input.length > 0) {
          const firstTransfer = await ctx.prisma.assetTransfer.findFirst({
            where: { id: input[0].transferId, teamId: ctx.user.teamId },
            select: {
              asset: { select: { issuedByLegalEntityId: true } },
              transaction: { select: { event: { select: { legalEntityId: true } } } },
            },
          });
          const companyId =
            firstTransfer?.transaction?.event?.legalEntityId ??
            firstTransfer?.asset?.issuedByLegalEntityId;
          if (companyId) {
            await logFundingChange({
              legalEntityId: companyId,
              category: 'Update Transaction',
              description: `Updated transaction details`,
              eventDate: input[0].date,
            });
          }
        }

        return true;
      }),
    updateRoundInfo: procedure
      .input(
        z.object({
          roundName: z.nativeEnum(db.EquityRoundType).optional(),
          companyId: z.string(),
          eventId: z.string(),
          date: z.string(),
          currency: z.nativeEnum(db.CurrencyIsoCode).optional(),
          amount: z.number().optional(),
          valuation: z.number().optional(),
          valuationType: z.nativeEnum(db.ValuationType).optional(),
          pricePerShare: z.number().optional(),
          pricePerShareCurrency: z.nativeEnum(db.CurrencyIsoCode).optional(),
          investmentRoundType: z.nativeEnum(db.InvestmentRoundType).optional(),
          coInvestors: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                type: z.enum(['NATURAL_PERSON', 'FUND']),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        if (input.pricePerShare && input.pricePerShareCurrency) {
          const price = await ctx.prisma.price.findFirst({
            where: {
              teamId: ctx.user.teamId,
              eventId: input.eventId,
            },
            orderBy: {
              date: 'desc',
            },
          });
          if (price) {
            await ctx.prisma.price.update({
              where: { id: price.id },
              data: {
                price: input.pricePerShare,
                currency: input.pricePerShareCurrency,
                legalEntityId: input.companyId,
              },
            });
          } else {
            if (input.pricePerShareCurrency) {
              await ctx.prisma.price.create({
                data: {
                  legalEntityId: input.companyId,
                  price: input.pricePerShare,
                  currency: input.pricePerShareCurrency,
                  date: new Date(input.date),
                  teamId: ctx.user.teamId,
                  eventId: input.eventId,
                  type: db.PriceType.FROM_PRICED_ROUND,
                },
              });
            }
          }
        }
        const round = await ctx.prisma.event.update({
          where: { id: input.eventId, teamId: ctx.user.teamId },
          data: {
            raisedAmount: input.amount,
            raisedCurrency: input.currency,
            valuation: input.valuation,
            valuationType: input.valuationType,
            valuationCurrency: input.currency,
            roundType: input.roundName,
            name: startCase(input.roundName ?? '') ?? undefined,
            investmentRoundType: input.investmentRoundType,
          },
        });

        if (round.investmentRoundType === 'CONVERTIBLE') {
          const convertibleAssets = await ctx.prisma.asset.findMany({
            where: {
              teamId: ctx.user.teamId,
              issuedByLegalEntityId: input.companyId,
              type: db.AssetType.CONVERTIBLE,
              assetTransfers: {
                some: {
                  transaction: {
                    eventId: input.eventId,
                    teamId: ctx.user.teamId,
                  },
                },
              },
            },

            include: {
              assetTransfers: {
                where: {
                  transaction: {
                    eventId: input.eventId,
                    teamId: ctx.user.teamId,
                  },
                },
                include: {
                  transaction: true,
                },
              },
            },
          });
          const convertibleAssetIds = convertibleAssets.map((a) => a.id);
          await ctx.prisma.asset.updateMany({
            where: {
              id: { in: convertibleAssetIds },
              teamId: ctx.user.teamId,
            },
            data: {
              valuationCap: input.valuation,
              convertibleCurrency: input.currency,
            },
          });
        }

        if (input.coInvestors?.length) {
          // First, get existing co-investors for this event
          const existingInvestments = await getValuationsQb(['investment', 'legal_entity'])
            .selectFrom('investment')
            .innerJoin('legal_entity', 'legal_entity.id', 'investment.investor_profile_id')
            .select('investor_profile_id')
            .where('event_id', '=', input.eventId as EventId)
            .where('investment_profile_id', '=', input.companyId as LegalEntityId)
            .where('investment.team_id', '=', ctx.user.teamId as TeamId)
            .where('legal_entity.is_portfolio', 'is distinct from', true)
            .execute();

          const existingInvestorIds = existingInvestments.map((inv) => inv.investor_profile_id);
          const updatedInvestorIds: string[] = [];

          // Process each co-investor in the input array
          for (const coInvestor of input.coInvestors) {
            let coInvestorId = coInvestor.id as LegalEntityId;

            // Create new co-investor if needed
            if (coInvestorId === 'NEW') {
              const newCoInvestor = await ProfileService.create({
                name: coInvestor.name,
                type: coInvestor.type,
                isPrivate: true,
              });

              if (!newCoInvestor?.id) {
                throw new Error('Failed to create co-investor entity');
              }
              coInvestorId = newCoInvestor.id as LegalEntityId;
            }

            updatedInvestorIds.push(coInvestorId);

            // Create co-investor relationship if it doesn't exist
            if (!existingInvestorIds.includes(coInvestorId)) {
              await getValuationsQb(['investment'])
                .insertInto('investment')
                .values({
                  investor_profile_id: coInvestorId,
                  investment_profile_id: input.companyId as LegalEntityId,
                  event_id: input.eventId as EventId,
                  team_id: ctx.user.teamId as TeamId,
                })
                .execute();
            }
          }

          const investorsToRemove = existingInvestorIds.filter(
            (id) => !updatedInvestorIds.includes(id),
          );

          if (investorsToRemove.length > 0) {
            await getValuationsQb(['investment', 'legal_entity'])
              .deleteFrom('investment')
              .using('legal_entity')
              .whereRef('legal_entity.id', '=', 'investment.investor_profile_id')
              .where('legal_entity.is_portfolio', 'is distinct from', true)
              .where('investment.event_id', '=', input.eventId as EventId)
              .where('investment.investment_profile_id', '=', input.companyId as LegalEntityId)
              .where('investment.investor_profile_id', 'in', investorsToRemove)
              .where('investment.team_id', '=', ctx.user.teamId as TeamId)
              .execute();
          }
        } else {
          // If no co-investors provided, remove all co-investor relationships for this event
          await getValuationsQb(['investment', 'legal_entity'])
            .deleteFrom('investment')
            .using('legal_entity')
            .whereRef('legal_entity.id', '=', 'investment.investor_profile_id')
            .where('legal_entity.is_portfolio', 'is distinct from', true)
            .where('investment.event_id', '=', input.eventId as EventId)
            .where('investment.investment_profile_id', '=', input.companyId as LegalEntityId)
            .where('investment.team_id', '=', ctx.user.teamId as TeamId)
            .execute();
        }

        const updateHeadline = `Updated round: ${round.name}`;
        const updateDetails: string[] = [];
        if (input.roundName) updateDetails.push(`Type: ${startCase(input.roundName)}`);
        if (input.amount && input.currency)
          updateDetails.push(`Raised: ${formatCurrency(input.amount, input.currency)}`);
        if (input.valuation && input.currency)
          updateDetails.push(
            `Valuation: ${formatCurrency(input.valuation, input.currency)} ${input.valuationType === 'PRE_MONEY' ? 'pre-money' : 'post-money'}`,
          );
        if (input.pricePerShare && input.pricePerShareCurrency)
          updateDetails.push(
            `Price/share: ${formatCurrency(input.pricePerShare, input.pricePerShareCurrency)}`,
          );
        if (input.coInvestors?.length)
          updateDetails.push(`Co-investors: ${input.coInvestors.map((c) => c.name).join(', ')}`);
        await logFundingChange({
          legalEntityId: input.companyId,
          category: 'Update Round',
          description:
            updateDetails.length > 0
              ? `${updateHeadline}\n${updateDetails.join('\n')}`
              : updateHeadline,
          eventDate: input.date,
        });

        return round;
      }),
    removeEvent: procedure
      .input(
        z.object({
          eventId: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const event = await ctx.prisma.event.findUnique({
          where: { id: input.eventId, teamId: ctx.user.teamId },
          select: { name: true, type: true, date: true, legalEntityId: true },
        });

        await ctx.prisma.event.delete({
          where: {
            id: input.eventId,
            teamId: ctx.user.teamId,
          },
        });

        if (event) {
          await logFundingChange({
            legalEntityId: event.legalEntityId,
            category: 'Remove Event',
            description: `Removed ${event.name ?? event.type}`,
            eventDate: event.date,
          });
        }
      }),
    addAcquisition: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string(),
          valuation: z.number().optional(),
          currency: z.string().optional(),
          pricePerShare: z.number().optional(),
          acquirer: z.object({
            id: z.string(),
            name: z.string(),
          }),
          transactions: z.array(
            z.object({
              fundId: z.string(),
              assetsSold: z.array(
                z.object({
                  id: z.string(),
                  amount: z.number().optional(),
                }),
              ),
              assetsReceived: z.array(
                z.object({
                  assetId: z.string().optional(),
                  amount: z.number(),
                  date: z.string(),
                  type: z.enum(['CASH', 'EQUITY']),
                  shareClass: z.string().optional(),
                  currency: z.string().optional(),
                }),
              ),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        let acquirerId = input.acquirer.id;
        if (acquirerId === 'NEW' && input.acquirer.name) {
          const newEntity = await ProfileService.create({
            name: input.acquirer.name,
            type: LegalEntity.inferLegalEntityType(input.acquirer.name),
            isPrivate: true,
          });

          if (!newEntity?.id) {
            throw new Error('Failed to create new entity');
          }
          acquirerId = newEntity.id;
        }

        const event = await ctx.prisma.event.create({
          data: {
            name: 'Exit',
            type: db.EventType.DISTRIBUTION,
            date: new Date(input.date),
            legalEntityId: input.companyId,
            acquirerId,
            teamId: ctx.user.teamId,
          },
        });

        await ctx.prisma.legalEntity.update({
          where: { id: input.companyId },
          data: {
            acquiredByLegalEntityId: acquirerId,
            acquiredAt: new Date(input.date),
            acquiredEventId: event.id,
            // NOTE: an acquired company is not always dissolved (?)
            // Though if it's not dissolved then presumably it can be sold again
            // which kind of breaks our data model for acquisition
            // status: db.CompanyLegalStatus.DISSOLVED,
          },
        });

        const investments = await ctx.prisma.investment.findMany({
          where: {
            investmentProfileId: input.companyId,
            teamId: ctx.user.teamId,
            legalEntityInvestmentInvestorProfileIdTolegalEntity: {
              isPortfolio: true,
              isDeprecated: false,
            },
          },
        });

        // Mark all the investments as exited
        // business logic decision - the original investment ends at the point of acquisition
        // and any new illiquid assets received are considered a new investment
        for (const investment of investments) {
          await ctx.prisma.investment.update({
            where: {
              id: investment.id,
            },
            data: {
              exitEventId: event.id,
            },
          });
        }

        const holdings = await getInventoryForInvestments({
          investmentIds: investments?.map((i) => i.id) ?? [],
        });
        const mapped = transformHoldings(holdings);

        const newInvestmentsByFund: Record<string, db.Investment> = {};

        for (const inputTransaction of input.transactions) {
          const fundId = inputTransaction.fundId;

          // if we've recieved equity, it's a new investment into the acquirer
          // we want to deduplicate though - if one fund has sold both equity and and SPV stake,
          // it's only one new investment really
          let investmentId: string | null = null;
          if (inputTransaction.assetsReceived.some((a) => a.type === 'EQUITY')) {
            if (!newInvestmentsByFund[fundId]) {
              newInvestmentsByFund[fundId] = await ctx.prisma.investment.create({
                data: {
                  investorProfileId: fundId,
                  investmentProfileId: acquirerId,
                  investedAt: new Date(input.date),
                  eventId: event.id,
                  teamId: ctx.user.teamId,
                },
              });
            }

            investmentId = newInvestmentsByFund[fundId].id;
          }

          const transaction = await ctx.prisma.transaction.create({
            data: {
              closeDate: new Date(input.date),
              eventId: event.id,
              teamId: ctx.user.teamId,
              investmentId,
            },
          });

          for (const assetTransfer of inputTransaction.assetsSold) {
            const holding = mapped.find(
              (h) => h.assetId === assetTransfer.id && h.fundId === fundId,
            );
            if (!holding) {
              throw new Error(`Could not find holding for asset ${assetTransfer.id}`);
            }

            const numAssets = assetTransfer.amount ?? holding.numAssets;

            const remaining = holding.numAssets - numAssets;
            holding.numAssets = remaining;

            await ctx.prisma.assetTransfer.create({
              data: {
                assetId: assetTransfer.id,
                date: new Date(input.date),
                fromLegalEntityId: fundId,
                toLegalEntityId: acquirerId,
                numAssets,
                transactionId: transaction.id,
                teamId: ctx.user.teamId,
              },
            });
          }

          for (const assetTransfer of inputTransaction.assetsReceived) {
            if (assetTransfer.type === 'CASH') {
              // Zero proceeds = no payout — don't book an empty cash transfer.
              if (!assetTransfer.amount) continue;
              if (!assetTransfer.currency) {
                throw new Error('Currency is required for cash transfer');
              }

              const currencyAsset = await getCurrencyAsset(
                assetTransfer.currency as CurrencyIsoCode,
                ctx,
              );

              await ctx.prisma.assetTransfer.create({
                data: {
                  assetId: currencyAsset.id,
                  date: new Date(assetTransfer.date),
                  fromLegalEntityId: acquirerId,
                  toLegalEntityId: fundId,
                  numAssets: assetTransfer.amount,
                  transactionId: transaction.id,
                  teamId: ctx.user.teamId,
                },
              });
            } else if (assetTransfer.type === 'EQUITY') {
              if (!assetTransfer.assetId && !assetTransfer.shareClass) {
                throw new Error('Asset ID or Share Class is required for equity transfer');
              }

              let asset = await ctx.prisma.asset.findFirst({
                where: {
                  OR: [
                    {
                      name: assetTransfer.shareClass,
                    },
                    assetTransfer.assetId
                      ? {
                          id: assetTransfer.assetId,
                        }
                      : null,
                  ].filter(notNull),
                  teamId: ctx.user.teamId,
                  issuedByLegalEntityId: acquirerId,
                },
              });

              if (!asset) {
                if (!assetTransfer.shareClass) {
                  throw new Error('Share class is required for equity transfer of new asset');
                }

                asset = await ctx.prisma.asset.create({
                  data: {
                    name: assetTransfer.shareClass,
                    type: db.AssetType.EQUITY,
                    issuedByLegalEntityId: acquirerId,
                    teamId: ctx.user.teamId,
                    properties: {},
                  },
                });
              }

              await ctx.prisma.assetTransfer.create({
                data: {
                  assetId: asset.id,
                  date: new Date(assetTransfer.date),
                  fromLegalEntityId: acquirerId,
                  toLegalEntityId: fundId,
                  numAssets: assetTransfer.amount,
                  transactionId: transaction.id,
                  teamId: ctx.user.teamId,
                },
              });
            } else {
              throw new Error(`Invalid asset transfer type ${neverAsAny(assetTransfer.type)}`);
            }
          }
        }

        // Transfer any remaining holdings away for nothing
        const remainingHoldings = mapped.filter((holding) => holding.numAssets > 0);
        for (const holding of remainingHoldings) {
          const transaction = await ctx.prisma.transaction.create({
            data: {
              closeDate: new Date(input.date),
              eventId: event.id,
              teamId: ctx.user.teamId,
            },
          });

          await ctx.prisma.assetTransfer.create({
            data: {
              assetId: holding.assetId,
              date: new Date(input.date),
              fromLegalEntityId: holding.fundId,
              toLegalEntityId: acquirerId,
              numAssets: holding.numAssets,
              transactionId: transaction.id,
              teamId: ctx.user.teamId,
            },
          });
        }

        // If a price per share is provided, create a price record
        if (input.pricePerShare) {
          const existingPrice = await ctx.prisma.price.findFirst({
            where: {
              legalEntityId: acquirerId,
              date: new Date(input.date),
              teamId: ctx.user.teamId,
            },
          });
          // Create price record
          if (!existingPrice) {
            await ctx.prisma.price.create({
              data: {
                teamId: ctx.user.teamId,
                date: new Date(input.date),
                price: input.pricePerShare,
                currency: input.currency as CurrencyIsoCode,
                eventId: event.id,
                legalEntityId: acquirerId,
                type: 'FROM_PRICED_ROUND',
              },
            });
          } else {
            await ctx.prisma.price.update({
              where: { id: existingPrice.id },
              data: {
                price: input.pricePerShare,
                currency: input.currency as CurrencyIsoCode,
              },
            });
          }
        }

        const acqHeadline = `Added acquisition by ${input.acquirer.name}`;
        const acqDetails: string[] = [];
        if (input.valuation && input.currency)
          acqDetails.push(`Valuation: ${formatCurrency(input.valuation, input.currency)}`);
        if (input.pricePerShare && input.currency)
          acqDetails.push(`Price/share: ${formatCurrency(input.pricePerShare, input.currency)}`);
        const totalCashReceived = input.transactions.reduce(
          (sum, t) =>
            sum +
            t.assetsReceived.filter((a) => a.type === 'CASH').reduce((s, a) => s + a.amount, 0),
          0,
        );
        if (totalCashReceived > 0 && input.currency)
          acqDetails.push(`Cash received: ${formatCurrency(totalCashReceived, input.currency)}`);
        const hasEquityReceived = input.transactions.some((t) =>
          t.assetsReceived.some((a) => a.type === 'EQUITY'),
        );
        if (hasEquityReceived) acqDetails.push('Includes equity consideration');
        await logFundingChange({
          legalEntityId: input.companyId,
          category: 'Add Acquisition',
          description:
            acqDetails.length > 0 ? `${acqHeadline}\n${acqDetails.join('\n')}` : acqHeadline,
          eventDate: input.date,
        });
      }),
    getAcquisitionTransactions: procedure
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        const query = getValuationsQb([
          'transaction',
          'asset_transfer',
          'asset',
          'currency_asset',
          'legal_entity',
        ])
          .selectFrom('transaction')
          .innerJoin('asset_transfer', 'transaction.id', 'asset_transfer.transaction_id')
          .innerJoin('asset', 'asset_transfer.asset_id', 'asset.id')
          .innerJoin('legal_entity as investor', (join) =>
            join.on(($) =>
              $.and([
                $('investor.is_portfolio', '=', true),
                $.or([
                  $('asset_transfer.from_legal_entity_id', '=', $.ref('investor.id')),
                  $('asset_transfer.to_legal_entity_id', '=', $.ref('investor.id')),
                ]),
              ]),
            ),
          )
          .leftJoin('currency_asset', 'currency_asset.asset_id', 'asset.id')
          .where('transaction.event_id', '=', input.id as EventId)
          .where('transaction.team_id', '=', ctx.user.teamId as TeamId)
          .select(($) => [
            'transaction.id',
            'investor.id as investorId',
            'investor.name as investorName',
            jsonbAgg($, {
              id: 'asset_transfer.id',
              assetId: 'asset.id',
              date: 'asset_transfer.date',
              numAssets: 'asset_transfer.num_assets',
              currency: 'currency_asset.iso_code',
              assetName: 'asset.name',
            })
              .filterWhere('asset_transfer.from_legal_entity_id', '=', $.ref('investor.id'))
              .as('transfers_out'),
            jsonbAgg($, {
              id: 'asset_transfer.id',
              assetId: 'asset.id',
              date: 'asset_transfer.date',
              numAssets: 'asset_transfer.num_assets',
              currency: 'currency_asset.iso_code',
              assetName: 'asset.name',
            })
              .filterWhere('asset_transfer.to_legal_entity_id', '=', $.ref('investor.id'))
              .as('transfers_in'),
          ])
          .groupBy(['transaction.id', 'investor.id']);

        return query.execute();
      }),
    addCashflowsToTransaction: procedure
      .input(
        z.object({
          id: z.string(),
          recipientId: z.string(),
          sourceId: z.string(),
          cashflow: z.object({
            amount: z.number(),
            date: z.string(),
            currency: z.string(),
          }),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const transaction = await ctx.prisma.transaction.findFirstOrThrow({
          where: {
            id: input.id,
            teamId: ctx.user.teamId,
          },
        });

        const currencyAsset = await getCurrencyAsset(
          input.cashflow.currency as CurrencyIsoCode,
          ctx,
        );

        await ctx.prisma.assetTransfer.create({
          data: {
            assetId: currencyAsset.id,
            date: new Date(input.cashflow.date),
            fromLegalEntityId: input.sourceId,
            toLegalEntityId: input.recipientId,
            numAssets: input.cashflow.amount,
            transactionId: transaction.id,
            teamId: ctx.user.teamId,
          },
        });
      }),
    addSecondarySale: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string(),
          currency: z.string(),
          buyer: z.object({
            id: z.string(),
            name: z.string(),
          }),
          transactions: z.array(
            z.object({
              id: z.string().optional(),
              assetId: z.string(),
              numAssets: z.number(),
              pricePerShare: z.number(),
              sellerId: z.string(),
              currency: z.string(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await prismaClient.$transaction(async (tx) => {
          let buyerId = input.buyer.id;
          if (buyerId === 'NEW' && input.buyer.name) {
            const newEntity = await ProfileService.create({
              name: input.buyer.name,
              type: LegalEntity.inferLegalEntityType(input.buyer.name),
              isPrivate: true,
            });

            if (!newEntity?.id) {
              throw new Error('Failed to create new entity');
            }
            buyerId = newEntity.id;
          }
          let event = await tx.event.findFirst({
            where: {
              type: db.EventType.SECONDARY_SALE,
              date: new Date(input.date),
              legalEntityId: input.companyId,
            },
          });

          if (!event) {
            event = await tx.event.create({
              data: {
                name: 'Secondary Sale',
                type: db.EventType.SECONDARY_SALE,
                date: new Date(input.date),
                legalEntityId: input.companyId,
                teamId: ctx.user.teamId,
              },
            });
          }

          for (const transfer of input.transactions) {
            const transaction = await tx.transaction.create({
              data: {
                closeDate: new Date(input.date),
                eventId: event.id,
                teamId: ctx.user.teamId,
              },
            });

            const currencyAsset = await tx.asset.findFirstOrThrow({
              where: {
                type: db.AssetType.CURRENCY,
                currencyAsset: { isoCode: transfer.currency as CurrencyIsoCode },
              },
            });

            await tx.assetTransfer.create({
              data: {
                assetId: currencyAsset.id,
                date: new Date(input.date),
                fromLegalEntityId: buyerId,
                toLegalEntityId: transfer.sellerId,
                numAssets: transfer.numAssets * transfer.pricePerShare,
                transactionId: transaction.id,
                teamId: ctx.user.teamId,
              },
            });

            await tx.assetTransfer.create({
              data: {
                assetId: transfer.assetId,
                date: new Date(input.date),
                fromLegalEntityId: transfer.sellerId,
                toLegalEntityId: buyerId,
                numAssets: transfer.numAssets,
                transactionId: transaction.id,
                teamId: ctx.user.teamId,
              },
            });
          }

          // If all equity transactions share a single (PPS, currency) pair,
          // persist it as a company-wide equity Price (assetId=null).
          const equityAssets = await tx.asset.findMany({
            where: {
              id: { in: input.transactions.map((t) => t.assetId) },
              type: db.AssetType.EQUITY,
            },
            select: { id: true },
          });
          const equityAssetIds = new Set(equityAssets.map((a) => a.id));
          const equityTxs = input.transactions.filter((t) => equityAssetIds.has(t.assetId));
          const distinctPpsPairs = new Set(
            equityTxs.map((t) => `${t.pricePerShare}:${t.currency}`),
          );
          if (equityTxs.length > 0 && distinctPpsPairs.size === 1) {
            const representative = equityTxs[0];
            const existing = await tx.price.findFirst({
              where: { eventId: event.id, assetId: null, legalEntityId: input.companyId },
            });
            if (!existing) {
              await tx.price.create({
                data: {
                  teamId: ctx.user.teamId,
                  date: new Date(input.date),
                  price: representative.pricePerShare,
                  currency: representative.currency as CurrencyIsoCode,
                  assetId: null,
                  legalEntityId: input.companyId,
                  eventId: event.id,
                  type: PriceType.FROM_PRICED_ROUND,
                },
              });
            }
          }
        });

        const totalValue = input.transactions.reduce(
          (sum, t) => sum + t.numAssets * t.pricePerShare,
          0,
        );
        const totalShares = input.transactions.reduce((sum, t) => sum + t.numAssets, 0);
        const secHeadline = `Added secondary sale to ${input.buyer.name} for ${formatCurrency(totalValue, input.currency)}`;
        const secDetails: string[] = [];
        secDetails.push(`Shares transferred: ${totalShares.toLocaleString()}`);
        if (input.transactions.length === 1) {
          secDetails.push(
            `Price/share: ${formatCurrency(input.transactions[0].pricePerShare, input.currency)}`,
          );
        }
        await logFundingChange({
          legalEntityId: input.companyId,
          category: 'Add Secondary Sale',
          description: `${secHeadline}\n${secDetails.join('\n')}`,
          eventDate: input.date,
        });
      }),
    addLiquidation: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string().date(),
          transactions: z.array(
            z.object({
              numAssets: z.number(),
              currency: z.string(),
              investorId: z.string(),
            }),
          ),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const { eventId } = await applyWindDown(input);

        return { eventId };
      }),
    addShareSplit: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string().date(),
          multiple: z.number(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyShareSplit(input);
      }),
    getOutstandingCommitments: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string().date().optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        const investments = await ctx.prisma.investment.findMany({
          where: {
            investmentProfileId: input.companyId,
            teamId: ctx.user.teamId,
            investedAt: { lt: input.date ? new Date(input.date) : new Date() },
            legalEntityInvestmentInvestorProfileIdTolegalEntity: {
              OR: [
                {
                  isPortfolio: true,
                },
                {
                  isOwnInvestingEntity: true,
                },
              ],
            },
          },
        });

        const holdings = await getInventoryForInvestments({
          investmentIds: investments.map((i) => i.id),
          asOfDate: input.date ? new Date(input.date) : new Date(),
        });

        const outstandingCommitmentAssets: `${AssetKey}:${InvestingEntityKey}`[] = [];

        // Iterate through each investing entity (fund)
        holdings.entries().forEach(([investorKey, __, fundData]) => {
          // Iterate through each asset in the fund
          fundData.entries().forEach(([assetKey, assetData]) => {
            const [_, __, assetType] = assetKey.split(':');

            // Calculate total number of assets
            const { fromInvestment: totalAssets } = assetData.sum();

            if (assetType !== 'FUND_OUTSTANDING_COMMITMENT' || totalAssets === 0) {
              return;
            }

            outstandingCommitmentAssets.push(`${assetKey}:${investorKey}`);
          });
        });

        const outstandingCommitmentPrices = await ctx.prisma.price.findMany({
          where: {
            assetId: {
              in: outstandingCommitmentAssets.map((a) => a.split(':')[0]),
            },
            teamId: ctx.user.teamId,
            date: { lt: input.date ? new Date(input.date) : new Date() },
          },
          orderBy: {
            date: 'desc',
          },
        });

        const outstandingCommitmentAssetsWithPrices = outstandingCommitmentAssets
          .map((assetKey) => {
            const [assetId, assetName, _, investorId, investorName] = assetKey.split(':');
            const price = outstandingCommitmentPrices.find((p) => p.assetId === assetId);
            if (!price?.price) {
              return null;
            }

            return {
              assetId,
              assetName,
              investorId,
              investorName,
              price: price.price,
              currency: price.currency as CurrencyIsoCode,
            };
          })
          .filter(notNull);

        return outstandingCommitmentAssetsWithPrices;
      }),
    addFundDrawdown: procedure
      .input(
        z.object({
          fundId: z.string(),
          drawdownAmount: z.number(),
          date: z.string().date(),
          outstandingCommitment: z.object({
            assetId: z.string(),
            investorId: z.string(),
            price: z.number(),
            currency: z.nativeEnum(CurrencyIsoCode),
          }),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyFundDrawdown({
          fundId: input.fundId,
          drawdownAmount: input.drawdownAmount,
          date: input.date,
          assetId: input.outstandingCommitment.assetId,
          investorId: input.outstandingCommitment.investorId,
          price: input.outstandingCommitment.price,
          currency: input.outstandingCommitment.currency,
        });
      }),
    getEventHistory: procedure
      .input(
        z.object({
          companyId: z.string(),
          config: z.object({
            currency: z.enum(currencyOptions).nullish(),
            valuationDate: z.string().datetime().nullish(),
          }),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();

        // get all events
        const baseEvents = await getQb([
          'valuations.event',
          'valuations.legal_entity',
          'valuations.note',
          'core.user',
          'valuations.investment',
        ])
          .selectFrom('valuations.event as event')
          .leftJoin('valuations.legal_entity as acquirer', 'acquirer.id', 'event.acquirer_id')
          .where('event.legal_entity_id', '=', input.companyId as LegalEntityId)
          .where('event.team_id', '=', ctx.user.teamId as TeamId)
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('event.date', '<=', new Date(input.config.valuationDate!)),
          )
          .select(($) => [
            'event.id',
            'event.date',
            'event.name',
            'event.type',
            'event.data',
            'event.valuation',
            'event.valuation_currency',
            'event.valuation_type',
            'event.raised_amount',
            'event.raised_currency',
            'event.investment_round_type',
            $.case()
              .when('acquirer.id', 'is not', null)
              .then(
                jsonbBuildObject($, {
                  id: 'acquirer.id',
                  name: 'acquirer.name',
                  slug: 'acquirer.slug',
                }),
              )
              .else(null)
              .end()
              .as('acquirer'),
            $.selectFrom('valuations.note as note')
              .innerJoin('core.user as user', 'user.id', 'note.created_by')
              .where('note.reference_id', '=', $.ref('event.id'))
              .where('note.note_type', '=', NoteType.EVENT)
              .select(($) =>
                jsonbAgg($, {
                  id: 'note.id',
                  content: 'note.message',
                  creator: 'user.username',
                  createdAt: 'note.created_at',
                  updatedAt: 'note.updated_at',
                }).as('notes'),
              )
              .as('notes'),
            $.selectFrom('valuations.investment as investment')
              .innerJoin(
                'valuations.legal_entity as legal_entity',
                'legal_entity.id',
                'investment.investor_profile_id',
              )
              .where('investment.investment_profile_id', '=', input.companyId as LegalEntityId)
              .where('legal_entity.is_portfolio', 'is distinct from', true)
              .where('legal_entity.is_own_investing_entity', 'is distinct from', true)
              .where(($) =>
                $.or([
                  $('investment.event_id', '=', $.ref('event.id')),
                  $('investment.invested_at', '=', $.ref('event.date')),
                ]),
              )
              .select(($) =>
                jsonbAgg($, {
                  id: 'legal_entity.id',
                  name: 'legal_entity.name',
                  slug: 'legal_entity.slug',
                  personalWebsite: 'legal_entity.personal_website',
                }).as('investors'),
              )
              .as('investors'),
          ])
          .orderBy('event.date', 'desc')
          .execute();

        // get all investments
        const baseInvestments = await getQb([
          'valuations.investment',
          'valuations.event',
          'valuations.transaction',
          'valuations.legal_entity',
          'valuations.note',
          'core.user',
        ])
          .selectFrom('valuations.investment as investment')
          .innerJoin(
            'valuations.legal_entity as legal_entity',
            'legal_entity.id',
            'investment.investor_profile_id',
          )
          .leftJoin('valuations.event as event', 'event.id', 'investment.event_id')
          .leftJoin(
            'valuations.legal_entity as eventLegalEntity',
            'eventLegalEntity.id',
            'event.legal_entity_id',
          )
          .where('investment.investment_profile_id', '=', input.companyId as LegalEntityId)
          .where('investment.team_id', '=', ctx.user.teamId as TeamId)
          // The acquisition event itself still appears above — events belong to
          // the company. What must not appear is a valuation line for the
          // consideration position, whose value the acquired company's history
          // already carries.
          .where(($) => isReportableInvestment($, { event: 'valuations.event' }))
          .where(($) =>
            $.or([
              $('legal_entity.is_portfolio', '=', true),
              $('legal_entity.is_own_investing_entity', '=', true),
            ]),
          )
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where(
              ($) => $.fn.coalesce('event.date', 'investment.invested_at'),
              '<=',
              new Date(input.config.valuationDate!),
            ),
          )
          .select(($) => [
            'investment.id',
            'event.type as eventType',
            'eventLegalEntity.name as eventLegalEntityName',
            'eventLegalEntity.slug as eventLegalEntitySlug',
            $.fn.coalesce('event.date', 'investment.invested_at').as('date'),
            $.selectFrom('valuations.note as note')
              .innerJoin('core.user as user', 'user.id', 'note.created_by')
              .where('note.reference_id', '=', $.ref('investment.id'))
              .where('note.note_type', '=', NoteType.INVESTMENT)
              .select(($) =>
                jsonbAgg($, {
                  id: 'note.id',
                  content: 'note.message',
                  creator: 'user.username',
                  createdAt: 'note.created_at',
                  updatedAt: 'note.updated_at',
                }).as('notes'),
              )
              .as('notes'),
          ])
          .orderBy(($) => $.fn.coalesce('event.date', 'investment.invested_at'), 'desc')
          .execute();

        const basePrices = await getQb([
          'valuations.price',
          'valuations.asset',
          'valuations.note',
          'core.user',
        ])
          .selectFrom('valuations.price as price')
          .leftJoin('valuations.asset as asset', 'asset.id', 'price.asset_id')
          .select(($) => [
            'price.id',
            'price.date',
            'price.price',
            'price.currency',
            'price.event_id',
            'price.asset_id',
            'price.type as priceType',
            'asset.name',
            'asset.type',
            $.selectFrom('valuations.note as note')
              .innerJoin('core.user as user', 'user.id', 'note.created_by')
              .where('note.reference_id', '=', $.ref('price.id'))
              .where('note.note_type', '=', NoteType.PRICE)
              .select(($) =>
                jsonbAgg($, {
                  id: 'note.id',
                  content: 'note.message',
                  creator: 'user.username',
                  createdAt: 'note.created_at',
                  updatedAt: 'note.updated_at',
                }).as('notes'),
              )
              .as('notes'),
          ])
          .where('price.team_id', '=', ctx.user.teamId as TeamId)
          .$if(!!input.config.valuationDate, (qb) =>
            qb.where('price.date', '<=', new Date(input.config.valuationDate!)),
          )
          .where(($) =>
            $.or([
              $('price.legal_entity_id', '=', input.companyId as LegalEntityId),
              $('asset.issued_by_legal_entity_id', '=', input.companyId as LegalEntityId),
              $(
                pathString($, 'asset.properties').key('spv_investment_target_company_id'),
                '=',
                input.companyId,
              ),
              $(pathString($, 'asset.properties').key('target_company_id'), '=', input.companyId),
            ]),
          )
          .orderBy('price.date', 'desc')
          .execute();

        const investmentIds = baseInvestments.map((i) => i.id);
        const baseTransactions = await getClassifiedTransactionFlows({
          investmentIds,
          asOfDate: input.config.valuationDate ? new Date(input.config.valuationDate) : new Date(),
        });

        const transactionNotes = baseTransactions.length
          ? await getQb(['valuations.note', 'core.user'])
              .selectFrom('valuations.note as note')
              .innerJoin('core.user as user', 'user.id', 'note.created_by')
              .where('note.note_type', '=', NoteType.TRANSACTION)
              .where(
                'note.reference_id',
                'in',
                baseTransactions.map((t) => t.transactionId),
              )
              .select([
                'note.id',
                'note.reference_id as transactionId',
                'note.message as content',
                'user.username as creator',
                'note.created_at as createdAt',
                'note.updated_at as updatedAt',
              ])
              .orderBy('note.created_at', 'desc')
              .execute()
          : [];

        const convertibleAssetIds = Array.from(
          new Set(
            baseTransactions.flatMap((t) =>
              t.inflows
                .filter((i) => i.assetType === AssetType.CONVERTIBLE)
                .map((i) => i.assetId as string),
            ),
          ),
        );
        const convertibleAssetRows = convertibleAssetIds.length
          ? await getValuationsQb(['asset'])
              .selectFrom('asset')
              .select([
                'id',
                'name',
                'convertible_type as convertibleType',
                'convertible_amount as convertibleAmount',
                'convertible_currency as convertibleCurrency',
                'issued_at as issuedAt',
                'maturity_date as maturityDate',
                'valuation_cap as valuationCap',
                'discount_rate as discountRate',
                'annualised_interest_rate as annualisedInterestRate',
                'conversion_date as conversionDate',
                'conversion_price as conversionPrice',
                'interest',
              ])
              .where('id', 'in', convertibleAssetIds as AssetId[])
              .execute()
          : [];
        const convertibleAssets = Object.fromEntries(
          convertibleAssetRows.map((row) => [row.id, row]),
        );

        const events = baseEvents.map((event) => {
          return {
            ...event,
            prices: [] as typeof basePrices,
            transactions: [] as ClassifiedTransactionFlow[],
          };
        });

        const investments = baseInvestments.map((investment) => {
          return {
            ...investment,
            notes: investment.notes ?? [],
            transactions: [] as ClassifiedTransactionFlow[],
            totalInvested: 0 as number | null,
            currentValueCurrency: input.config.currency ?? 'USD',
            moic: null as number | null,
            unrealizedValue: 0,
            realizedValue: 0,
            totalValue: 0,
            message: undefined as ProcessMessage[] | undefined,
          };
        });

        await Promise.all(
          investments.map(async (investment) => {
            const messageCollector = new MessageCollector();

            const {
              totalValuationDateValue,
              totalTransactionDateValue,
              retainedValue,
              realizedCashTransactionDateValue,
              investedTransactionDateValue,
            } = await getInvestmentsValuation({
              investments: [investment],
              targetCurrency: (input.config.currency as CurrencyIsoCode) ?? CurrencyIsoCode.USD,
              messageCollector,
              asOfDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
              fxDate: input.config.valuationDate
                ? new Date(input.config.valuationDate)
                : new Date(),
            });
            investment.moic = investedTransactionDateValue
              ? totalValuationDateValue / investedTransactionDateValue
              : null;
            messageCollector.header('MOIC');
            messageCollector.text(
              `Calculated as total value / total invested (${totalValuationDateValue.toFixed(2)} / ${investedTransactionDateValue?.toFixed(2)})`,
            );
            messageCollector.text(`MOIC: ${investment.moic}`);
            messageCollector.header('Movement');
            const totalMovement = investedTransactionDateValue
              ? totalValuationDateValue - investedTransactionDateValue
              : null;
            const fxMovement = totalValuationDateValue - totalTransactionDateValue;
            const fairValueMovement = totalMovement ? totalMovement - fxMovement : null;
            messageCollector.text(
              `Total Movement: ${totalMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `FX Movement: ${fxMovement.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `Fair Value Movement: ${fairValueMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            messageCollector.text(
              `Total Movement: ${totalMovement?.toFixed(2)} ${input.config.currency ?? 'USD'}`,
            );
            investment.totalInvested = investedTransactionDateValue;
            investment.unrealizedValue = retainedValue;
            investment.realizedValue = realizedCashTransactionDateValue;
            investment.totalValue = totalValuationDateValue;

            investment.message = messageCollector.getMessages();
          }),
        );

        const transactions: (ClassifiedTransactionFlow & {
          notes: {
            id: string;
            content: string;
            creator: string;
            createdAt: Date;
            updatedAt: Date;
          }[];
        })[] = [];
        for (const transaction of baseTransactions) {
          const notes = transactionNotes.filter(
            (n) => n.transactionId === transaction.transactionId,
          );
          const matchingInvestment = investments.find((i) => i.id === transaction.investmentId);
          if (matchingInvestment) {
            matchingInvestment.transactions.push(transaction);
            matchingInvestment.notes.push(...notes);
            continue;
          }

          const matchingSecondaryEvent = events.find(
            (e) =>
              e.type === 'SECONDARY_SALE' &&
              e.date.toISOString() === transaction.date.toISOString() &&
              transaction.eventId === e.id,
          );
          if (matchingSecondaryEvent) {
            matchingSecondaryEvent.transactions.push(transaction);
            if (!matchingSecondaryEvent.notes) {
              matchingSecondaryEvent.notes = [];
            }
            matchingSecondaryEvent.notes.push(...notes);
            continue;
          }

          const matchingFundDistributionEvent = events.find(
            (e) =>
              e.type === 'FUND_DISTRIBUTION' &&
              e.date.toISOString() === transaction.date.toISOString() &&
              transaction.eventId === e.id,
          );
          if (matchingFundDistributionEvent) {
            matchingFundDistributionEvent.transactions.push(transaction);
            if (!matchingFundDistributionEvent.notes) {
              matchingFundDistributionEvent.notes = [];
            }
            matchingFundDistributionEvent.notes.push(...notes);
            continue;
          }

          const matchingShareSplitEvent = events.find(
            (e) =>
              e.type === 'SHARE_SPLIT' && e.date.toISOString() === transaction.date.toISOString(),
          );
          if (matchingShareSplitEvent) {
            matchingShareSplitEvent.transactions.push(transaction);
            if (!matchingShareSplitEvent.notes) {
              matchingShareSplitEvent.notes = [];
            }
            matchingShareSplitEvent.notes.push(...notes);
            continue;
          }

          const matchingLiquidationEvent = events.find(
            (e) =>
              e.type === 'LIQUIDATION' && e.date.toISOString() === transaction.date.toISOString(),
          );
          if (matchingLiquidationEvent) {
            matchingLiquidationEvent.transactions.push(transaction);
            if (!matchingLiquidationEvent.notes) {
              matchingLiquidationEvent.notes = [];
            }
            matchingLiquidationEvent.notes.push(...notes);
            continue;
          }

          const matchingAcquisitionEvent = events.find(
            (e) => e.date.toISOString() === transaction.date.toISOString() && e.acquirer !== null,
          );
          if (matchingAcquisitionEvent) {
            matchingAcquisitionEvent.transactions.push(transaction);
            if (!matchingAcquisitionEvent.notes) {
              matchingAcquisitionEvent.notes = [];
            }
            matchingAcquisitionEvent.notes.push(...notes);
            continue;
          }

          transactions.push({
            ...transaction,
            notes,
          });
        }

        const prices = [];
        for (const price of basePrices) {
          prices.push(price);
        }

        return {
          events,
          investments,
          prices,
          transactions,
          convertibleAssets,
        };
      }),
    addMarkdown: procedure
      .input(
        z.object({
          companyId: z.string(),
          date: z.string(),
          percentage: z.number(),
          note: z.string().optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await ctx.enterTransaction();

        const { eventId } = await applyMarkdown(input);

        return { eventId };
      }),
    updateCompanyInfo: procedure
      .input(
        z.object({
          companyId: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          country: z.string().optional(),
          otherNames: z.string().optional(),
          legalName: z.string().optional(),
          website: z.string().optional(),
          status: z.nativeEnum(CompanyLegalStatus).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const company = await ctx.prisma.legalEntity.update({
          where: { id: input.companyId, teamId: ctx.user.teamId },
          data: {
            description: input.description,
            name: input.name,
            country: input.country,
            alsoKnownAs: input.otherNames,
            personalWebsite: input.website,
            legalStatus: input.status,
            legalName: input.legalName,
          },
        });
        return company;
      }),
    addInvestment: procedure
      .input(
        z.object({
          entity: z.string(),
          entityName: z.string().optional(),
          entityType: z.nativeEnum(LegalEntityType).optional(),
          entityWebsite: z.string().optional(),
          investingEntity: z.string(),
          investingEntityName: z.string(),
          roundName: z.string().optional(),
          investmentDate: z.string(),
          investmentAmount: z.string(),
          investmentCurrency: z.nativeEnum(CurrencyIsoCode),
          investmentType: z.enum(['EQUITY', 'CONVERTIBLE', 'SPV', 'SECONDARY']).optional(),
          // Fund details
          committedAmount: z.string().optional(),
          committedCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
          // Equity Details
          pricePerShare: z.string().optional(),
          pricePerShareCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
          numberOfShares: z.string().optional(),
          shareClass: z.string().optional(),
          valuationAmount: z.string().optional(),
          valuationType: z.nativeEnum(ValuationType).optional(),
          valuationCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
          totalRaisedAmount: z.string().optional(),
          totalRaisedCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
          // Convertible Details
          convertibleType: z.nativeEnum(ConvertibleType).optional(),
          convertibleName: z.string().optional(),
          convertibleValuationCap: z.number().optional(),
          convertibleMaturityDate: z.string().optional(),
          convertibleInterestRate: z.number().optional(),
          convertibleDiscountRate: z.number().optional(),
          // SPV Details
          spv: z.string().optional(),
          spvName: z.string().optional(),
          // Secondary Details
          seller: z.string().optional(),
          sellerName: z.string().optional(),
          // price per share as above
          // numberOfShares as above
          // shareClass as above
          // Co-investor Details
          coInvestors: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                type: z.enum(['NATURAL_PERSON', 'FUND']),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const resolved = await resolveInvestmentEntities(input);

        const ctx = currentContext();
        await ctx.enterTransaction();

        const { investmentId } = await applyInvestment(resolved);

        return { success: true, investmentId };
      }),
    addRound: procedure
      .input(
        z.object({
          entity: z.string(),
          roundName: z.string(),
          date: z.string(),
          currency: z.nativeEnum(CurrencyIsoCode).optional(),
          pricePerShare: z.string().optional(),
          valuationAmount: z.string().optional(),
          valuationType: z.nativeEnum(ValuationType).optional(),
          totalRaisedAmount: z.string().optional(),
          coInvestors: z
            .array(
              z.object({
                id: z.string(),
                name: z.string(),
                type: z.enum(['NATURAL_PERSON', 'FUND']),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const resolved = await resolveRoundEntities(input);

        const ctx = currentContext();
        await ctx.enterTransaction();

        await applyRound(resolved);

        return { success: true };
      }),
    getRoundNamesForLegalEntity: procedure
      .input(z.object({ legalEntityId: z.string() }))
      .query(async ({ input: { legalEntityId } }) => {
        const ctx = currentContext();

        const roundNames = await getQb(['valuations.event'])
          .selectFrom('valuations.event as event')
          .select(['name as round_name', 'date'])
          .where('type', '=', EventType.INVESTMENT_ROUND)
          .where('legal_entity_id', '=', legalEntityId as LegalEntityId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .orderBy('date', 'desc')
          .execute();

        return roundNames;
      }),
    getInvestorsSummary: procedure
      .input(z.object({ legalEntityId: z.string() }))
      .query(async ({ input: { legalEntityId } }) => {
        const ctx = currentContext();
        const allRoundsWithInvestors = await getQb([
          'valuations.event',
          'valuations.legal_entity',
          'valuations.investment',
          'valuations.transaction',
          'valuations.note',
          'core.user',
        ])
          .selectFrom('valuations.legal_entity as le')
          .leftJoin('valuations.event as e', 'le.id', 'e.legal_entity_id')
          .leftJoin('valuations.transaction as t', 't.event_id', 'e.id')
          .leftJoin('valuations.note as n', (join) =>
            join.on(($) =>
              $.or([
                $('n.reference_id', '=', $.ref('e.id')),
                $('n.reference_id', '=', $.ref('t.id')),
              ]),
            ),
          )
          .leftJoin('core.user as u', 'u.id', 'n.created_by')
          .leftJoin('valuations.legal_entity as up', 'u.id', 'up.public_profile_id')
          .select(($) => [
            'e.id as event_id',
            'e.name as event_name',
            'e.type as event_type',
            'e.date as event_date',
            'e.raised_amount',
            'e.raised_currency',
            'e.valuation',
            'e.valuation_type',
            'e.valuation_currency',
            'e.data',
            'e.investment_round_type',
            'e.round_type',
            'e.acquirer_id',
            $.fn
              .agg<
                {
                  id: string;
                  message: string;
                  date: Date;
                  creator: {
                    id: string;
                    name: string;
                    slug: string | null | undefined;
                    imageUrl: string | null | undefined;
                  };
                }[]
              >('JSONB_AGG', [
                jsonbBuildObject($, {
                  id: 'n.id',
                  date: 'n.created_at',
                  message: 'n.message',
                  creator: jsonbBuildObject($, {
                    id: 'u.id',
                    name: 'u.username',
                    slug: 'up.slug',
                    imageUrl: 'up.image_url',
                  }),
                }),
              ])
              .distinct()
              .as('notes'),
            jsonbBuildObject($, {
              id: 'le.id',
              name: 'le.name',
              image_url: 'le.image_url',
              slug: 'le.slug',
            }).as('legalEntity'),
            jsonArrayFrom(
              getValuationsQb([
                'transaction',
                'currency_asset',
                'legal_entity',
                'asset_transfer',
                'asset',
              ])
                .selectFrom('transaction as t')
                .innerJoin('asset_transfer as at', 'at.transaction_id', 't.id')
                .innerJoin('legal_entity as fund', (join) =>
                  join.on(($) =>
                    $.and([
                      $('fund.id', '=', $.ref('at.from_legal_entity_id')),
                      $('fund.is_portfolio', '=', true),
                      $('fund.team_id', '=', ctx.user.teamId as TeamId),
                      $('fund.is_deprecated', 'is', false),
                    ]),
                  ),
                )
                .innerJoin('asset as ast', 'ast.id', 'at.asset_id')
                .innerJoin('currency_asset as ca', 'ca.asset_id', 'ast.id')
                .select(($) => [
                  'fund.name',
                  'fund.id',
                  $.fn.sum<number>('at.num_assets').as('amount'),
                  'ca.iso_code',
                ])
                .groupBy(['at.transaction_id', 'fund.id', 'ca.id'])
                .where('fund.is_deprecated', 'is', false)
                .whereRef('t.event_id', '=', sql.ref('e.id')),
            ).as('investment'),
            jsonArrayFrom(
              getValuationsQb(['legal_entity', 'investment'])
                .selectFrom(['investment as i'])
                .innerJoin('legal_entity as le', 'le.id', 'i.investor_profile_id')
                .select(['le.id', 'le.name', 'le.type'])
                .where(($) =>
                  $.and([
                    $('le.is_portfolio', 'is distinct from', true),
                    $('i.investment_profile_id', '=', legalEntityId as LegalEntityId),
                  ]),
                )
                .whereRef('i.event_id', '=', sql.ref('e.id')),
            ).as('private'),
          ])
          .where(($) =>
            $.and([
              $('le.team_id', '=', ctx.user.teamId as TeamId),
              $.or([
                $('e.acquirer_id', '=', legalEntityId as LegalEntityId),
                $('le.id', '=', legalEntityId as LegalEntityId),
              ]),
            ]),
          )
          .groupBy(['e.id', 'le.id'])
          .orderBy('e.date', 'desc')
          .execute();
        const topInvestors = allRoundsWithInvestors
          .map((round) => {
            return [...round.private];
          })
          .flat()
          .sort((a, b) => {
            const aIndex = a.name ? topVcs.indexOf(a.name) : -1;
            const bIndex = b.name ? topVcs.indexOf(b.name) : -1;
            if (aIndex === -1 && bIndex === -1) return 0;
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            return aIndex - bIndex;
          });

        const sortedRounds = await Promise.all(
          allRoundsWithInvestors.map(async (round) => {
            const sharePrice = await ctx.prisma.price.findFirst({
              where: {
                teamId: ctx.user.teamId,
                eventId: round.event_id,
                OR: [
                  {
                    asset: {
                      type: 'EQUITY',
                      issuedByLegalEntityId: legalEntityId,
                    },
                  },
                  {
                    legalEntityId: legalEntityId,
                  },
                ],
              },
              orderBy: { date: 'desc' },
            });
            return {
              ...round,
              pricePerShare: sharePrice ?? null,
              investors: [...round.private].sort((a, b) => {
                const aIndex = a.name ? topVcs.indexOf(a.name) : -1;
                const bIndex = b.name ? topVcs.indexOf(b.name) : -1;
                if (aIndex === -1 && bIndex === -1) return 0;
                if (aIndex === -1) return 1;
                if (bIndex === -1) return -1;
                return aIndex - bIndex;
              }),
            };
          }),
        );

        return {
          rounds: sortedRounds,
          topInvestors: topInvestors,
        };
      }),
    deleteNote: procedure.input(z.object({ noteId: z.string() })).mutation(async ({ input }) => {
      const ctx = currentContext();
      const { noteId } = input;
      await getValuationsQb(['note'])
        .deleteFrom('note')
        .where('id', '=', noteId as NoteId)
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .execute();
      return { success: true };
    }),
    addPriceNote: procedure
      .input(
        z.object({
          priceId: z.string(),
          note: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getValuationsQb(['note'])
          .insertInto('note')
          .values({
            message: input.note,
            reference_id: input.priceId,
            team_id: ctx.user.teamId as TeamId,
            created_by: ctx.user.id as UserId,
            note_type: NoteType.PRICE,
          })
          .execute();
        return { success: true };
      }),
    addEventNote: procedure
      .input(
        z.object({
          eventId: z.string(),
          note: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getValuationsQb(['note'])
          .insertInto('note')
          .values({
            message: input.note,
            reference_id: input.eventId,
            team_id: ctx.user.teamId as TeamId,
            created_by: ctx.user.id as UserId,
            note_type: NoteType.EVENT,
          })
          .execute();
        return { success: true };
      }),
    addInvestmentNote: procedure
      .input(
        z.object({
          investmentId: z.string(),
          note: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getValuationsQb(['note'])
          .insertInto('note')
          .values({
            message: input.note,
            reference_id: input.investmentId,
            team_id: ctx.user.teamId as TeamId,
            created_by: ctx.user.id as UserId,
            note_type: NoteType.INVESTMENT,
          })
          .execute();
        return { success: true };
      }),
    addTransactionNote: procedure
      .input(
        z.object({
          transactionId: z.string(),
          note: z.string(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        await getValuationsQb(['note'])
          .insertInto('note')
          .values({
            message: input.note,
            reference_id: input.transactionId,
            team_id: ctx.user.teamId as TeamId,
            created_by: ctx.user.id as UserId,
            note_type: NoteType.TRANSACTION,
          })
          .execute();
        return { success: true };
      }),
    addInvestorToEvent: procedure
      .input(
        z.object({
          companyId: z.string(),
          eventId: z.string(),
          id: z.string().nullish(),
          name: z.string(),
          type: z.enum(['NATURAL_PERSON', 'FUND']),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        let investorId = input.id;

        // Create new investor if needed
        if (!investorId) {
          const newInvestor = await ProfileService.create({
            name: input.name,
            type: input.type,
            isPrivate: true,
          });

          if (!newInvestor?.id) {
            throw new Error('Failed to create co-investor entity');
          }
          investorId = newInvestor.id;
        }

        const event = await getValuationsQb(['event'])
          .selectFrom('event')
          .select('date')
          .where('id', '=', input.eventId as EventId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .executeTakeFirst();

        if (!event) {
          throw new Error('Event not found');
        }

        // Create investor relationship
        await getValuationsQb(['investment'])
          .insertInto('investment')
          .values({
            investor_profile_id: investorId as LegalEntityId,
            investment_profile_id: input.companyId as LegalEntityId,
            event_id: input.eventId as EventId,
            team_id: ctx.user.teamId as TeamId,
            invested_at: event.date,
          })
          .execute();

        await logFundingChange({
          legalEntityId: input.companyId,
          category: 'Add Co-Investor',
          description: `Added co-investor: ${input.name}`,
          eventDate: event.date,
        });

        return { success: true };
      }),
    removeInvestorFromEvent: procedure
      .input(z.object({ eventId: z.string(), investorId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        const [investor, event] = await Promise.all([
          getValuationsQb(['legal_entity'])
            .selectFrom('legal_entity')
            .select(['name'])
            .where('id', '=', input.investorId as LegalEntityId)
            .executeTakeFirst(),
          getValuationsQb(['event'])
            .selectFrom('event')
            .select(['legal_entity_id', 'date'])
            .where('id', '=', input.eventId as EventId)
            .where('team_id', '=', ctx.user.teamId as TeamId)
            .executeTakeFirst(),
        ]);

        await getValuationsQb(['investment'])
          .deleteFrom('investment')
          .where('event_id', '=', input.eventId as EventId)
          .where('investor_profile_id', '=', input.investorId as LegalEntityId)
          .where('team_id', '=', ctx.user.teamId as TeamId)
          .execute();

        if (event) {
          await logFundingChange({
            legalEntityId: event.legal_entity_id,
            category: 'Remove Co-Investor',
            description: `Removed co-investor: ${investor?.name ?? 'Unknown'}`,
            eventDate: event.date,
          });
        }

        return { success: true };
      }),
    findInvestableEntitiesByName: procedure
      .input(z.object({ name: z.string() }))
      .mutation(async ({ input: { name } }) => {
        const ctx = currentContext();

        const entities = await getValuationsQb(['legal_entity'])
          .selectFrom('legal_entity as le')
          .where(($) =>
            $.and([
              $('le.name', 'ilike', `%${name}%`),
              $('le.type', 'in', [
                LegalEntityType.COMPANY,
                LegalEntityType.PORTFOLIO_COMPANY,
                LegalEntityType.SPV,
                LegalEntityType.FUND,
              ]),
              $('le.is_portfolio', 'is distinct from', true),
              $('le.team_id', '=', ctx.user.teamId as TeamId),
            ]),
          )
          .select(['le.id', 'le.name', 'le.type'])
          .orderBy(($) => $('le.name', 'ilike', `${name}%`), 'desc')
          .orderBy('le.name', 'asc')
          .limit(20)
          .execute();

        return entities;
      }),
    findInvestingEntitiesByName: procedure
      .input(z.object({ name: z.string() }))
      .mutation(async ({ input: { name } }) => {
        const ctx = currentContext();

        // The team's default investing entity is a valuations setting now
        // (D6), so this typeahead no longer joins core's `team` at all.
        const entities = await getValuationsQb(['legal_entity', 'team_settings', 'investment'])
          .selectFrom('legal_entity as le')
          .leftJoin('team_settings as ts', 'ts.team_id', 'le.team_id')
          .leftJoinLateral(
            ($) =>
              $.selectFrom('investment as i')
                .where('i.investor_profile_id', '=', $.ref('le.id'))
                .select(['i.invested_at'])
                .orderBy('i.invested_at', 'desc')
                .limit(1)
                .as('i'),
            (join) => join.onTrue(),
          )
          .where(($) =>
            $.and([
              $('le.name', 'ilike', `%${name}%`),
              $.or([$('le.is_portfolio', '=', true), $('le.is_own_investing_entity', '=', true)]),
              $('le.team_id', '=', ctx.user.teamId as TeamId),
            ]),
          )
          .select(['le.id', 'le.name', 'i.invested_at'])
          .orderBy(($) => $('ts.default_investing_entity_id', '=', $.ref('le.id')), 'desc')
          .orderBy('i.invested_at', sql`desc nulls last`)
          .orderBy('le.name', 'asc')
          .limit(20)
          .execute();

        return entities;
      }),

    getSPVsForEntity: procedure
      .input(z.object({ entityId: z.string() }))
      .mutation(async ({ input }: { input: { entityId: string } }) => {
        const ctx = currentContext();
        const { entityId } = input;

        // Get SPVs that have invested in this entity
        const spvs = await getValuationsQb(['legal_entity', 'asset'])
          .selectFrom('asset')
          .innerJoin('legal_entity', 'legal_entity.id', 'asset.issued_by_legal_entity_id')
          .where(
            ($) => pathString($, 'asset.properties').key('spv_investment_target_company_id'),
            '=',
            entityId,
          )
          .where('legal_entity.type', '=', LegalEntityType.SPV)
          .where('legal_entity.team_id', '=', ctx.user.teamId as TeamId)
          .select(['legal_entity.id', 'legal_entity.name'])
          .groupBy(['legal_entity.id'])
          .execute();

        return spvs;
      }),

    getOtherInvestors: procedure
      .input(z.object({ entityId: z.string().optional(), search: z.string().optional() }))
      .mutation(async ({ input }: { input: { entityId?: string; search?: string } }) => {
        const { entityId, search } = input;
        const ctx = currentContext();

        const shareholders = await getValuationsQb(['legal_entity', 'investment'])
          .selectFrom('legal_entity as le')
          .leftJoin('investment as i', 'i.investor_profile_id', 'le.id')
          .where('le.team_id', '=', ctx.user.teamId as TeamId)
          .where('le.type', 'in', [LegalEntityType.FUND, LegalEntityType.NATURAL_PERSON])
          .$if(!!entityId, (qb) => qb.where('le.id', '<>', entityId as LegalEntityId))
          .$if(!!search, (qb) => qb.where('le.name', 'ilike', `%${search}%`))
          .select(['le.id', 'le.name', 'le.type'])
          .groupBy(['le.id'])
          .orderBy(($) => $.fn.agg('BOOL_OR', [$('i.id', 'is not', null)]), 'desc')
          .orderBy('le.name', 'asc')
          .limit(100)
          .execute();

        return shareholders;
      }),
    getLegalEntities: procedure
      .input(z.object({ entityId: z.string().optional(), search: z.string().optional() }))
      .mutation(async ({ input }: { input: { entityId?: string; search?: string } }) => {
        const { entityId, search } = input;
        const ctx = currentContext();

        const shareholders = await getValuationsQb(['legal_entity', 'investment'])
          .selectFrom('legal_entity as le')
          .leftJoin('investment as i', 'i.investor_profile_id', 'le.id')
          .where('le.team_id', '=', ctx.user.teamId as TeamId)
          .where('le.type', 'in', [
            LegalEntityType.FUND,
            LegalEntityType.NATURAL_PERSON,
            LegalEntityType.COMPANY,
            LegalEntityType.PORTFOLIO_COMPANY,
          ])
          .$if(!!entityId, (qb) => qb.where('le.id', '<>', entityId as LegalEntityId))
          .$if(!!search, (qb) => qb.where('le.name', 'ilike', `%${search}%`))
          .select(['le.id', 'le.name', 'le.type'])
          .groupBy(['le.id'])
          .orderBy(($) => $.fn.agg('BOOL_OR', [$('i.id', 'is not', null)]), 'desc')
          .orderBy('le.name', 'asc')
          .limit(100)
          .execute();

        return shareholders;
      }),
    getFundingChangelog: procedure
      .input(
        z.object({
          legalEntityId: z.string(),
          limit: z.number().optional(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const rows = await getQb(['valuations.funding_changelog', 'core.user'])
          .selectFrom('valuations.funding_changelog as fc')
          .leftJoin('core.user as u', 'u.id', 'fc.user_id')
          .where('fc.team_id', '=', ctx.user.teamId as TeamId)
          .where('fc.legal_entity_id', '=', input.legalEntityId as LegalEntityId)
          .select(['fc.id', 'fc.description', 'fc.event_date', 'fc.created_at', 'u.username'])
          .orderBy('fc.created_at', 'desc')
          .limit(input.limit ?? 100)
          .execute();

        return rows;
      }),
    getChangelogCategories: procedure.query(async () => {
      const ctx = currentContext();
      const rows = await getValuationsQb(['funding_changelog'])
        .selectFrom('funding_changelog')
        .select('category')
        .distinct()
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .where('category', 'is not', null)
        .orderBy('category', 'asc')
        .execute();
      return rows.map((r) => r.category!);
    }),
    getChangelogList: procedure
      .input(
        z.object({
          fromDate: z.string().nullish(),
          toDate: z.string().nullish(),
          fundIds: z.array(z.string()).optional(),
          categories: z.array(z.string()).optional(),
          companyName: z.string().nullish(),
          limit: z.number().optional(),
          cursor: z.string().nullish(),
        }),
      )
      .query(async ({ input }) => {
        const ctx = currentContext();
        const limit = input.limit ?? 100;

        let query = getQb([
          'valuations.funding_changelog',
          'valuations.funding_changelog_fund',
          'valuations.legal_entity',
          'core.user',
        ])
          .selectFrom('valuations.funding_changelog as fc')
          .leftJoin('core.user as u', 'u.id', 'fc.user_id')
          .innerJoin('valuations.legal_entity as le', 'le.id', 'fc.legal_entity_id')
          .where('fc.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'fc.id',
            'fc.description',
            'fc.category',
            'fc.event_date',
            'fc.created_at',
            'fc.legal_entity_id',
            'le.name as company_name',
            'u.username',
            (eb) =>
              jsonArrayFrom(
                eb
                  .selectFrom('valuations.funding_changelog_fund as fcf')
                  .innerJoin('valuations.legal_entity as fund', 'fund.id', 'fcf.fund_id')
                  .whereRef('fcf.changelog_id', '=', 'fc.id')
                  .select(['fund.id', 'fund.name']),
              ).as('funds'),
          ])
          .orderBy('fc.created_at', 'desc')
          .limit(limit + 1);

        if (input.fromDate) {
          query = query.where('fc.created_at', '>=', new Date(input.fromDate));
        }
        if (input.toDate) {
          query = query.where(
            'fc.created_at',
            '<',
            new Date(new Date(input.toDate).getTime() + 86400000),
          );
        }
        if (input.fundIds && input.fundIds.length > 0) {
          query = query.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('valuations.funding_changelog_fund as fcf2')
                .whereRef('fcf2.changelog_id', '=', 'fc.id')
                .where(
                  'fcf2.fund_id',
                  'in',
                  input.fundIds!.map((id) => id as LegalEntityId),
                )
                .select(sql`1`.as('one')),
            ),
          );
        }
        if (input.categories && input.categories.length > 0) {
          query = query.where('fc.category', 'in', input.categories);
        }
        if (input.companyName) {
          query = query.where('le.name', 'ilike', `%${input.companyName}%`);
        }
        if (input.cursor) {
          query = query.where('fc.created_at', '<', new Date(input.cursor));
        }

        const rows = await query.execute();

        const hasMore = rows.length > limit;
        const items = hasMore ? rows.slice(0, limit) : rows;
        const nextCursor = hasMore ? items[items.length - 1].created_at.toISOString() : null;

        return { items, nextCursor };
      }),
    getChangelogCSV: procedure
      .input(
        z.object({
          fromDate: z.string().nullish(),
          toDate: z.string().nullish(),
          fundIds: z.array(z.string()).optional(),
          categories: z.array(z.string()).optional(),
          companyName: z.string().nullish(),
        }),
      )
      .mutation(async ({ input }) => {
        const ctx = currentContext();

        let query = getQb([
          'valuations.funding_changelog',
          'valuations.funding_changelog_fund',
          'valuations.legal_entity',
          'core.user',
        ])
          .selectFrom('valuations.funding_changelog as fc')
          .leftJoin('core.user as u', 'u.id', 'fc.user_id')
          .innerJoin('valuations.legal_entity as le', 'le.id', 'fc.legal_entity_id')
          .where('fc.team_id', '=', ctx.user.teamId as TeamId)
          .select([
            'fc.id',
            'fc.description',
            'fc.category',
            'fc.event_date',
            'fc.created_at',
            'le.name as company_name',
            'u.username',
          ])
          .orderBy('fc.created_at', 'desc');

        if (input.fromDate) {
          query = query.where('fc.created_at', '>=', new Date(input.fromDate));
        }
        if (input.toDate) {
          query = query.where(
            'fc.created_at',
            '<',
            new Date(new Date(input.toDate).getTime() + 86400000),
          );
        }
        if (input.fundIds && input.fundIds.length > 0) {
          query = query.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('valuations.funding_changelog_fund as fcf2')
                .whereRef('fcf2.changelog_id', '=', 'fc.id')
                .where(
                  'fcf2.fund_id',
                  'in',
                  input.fundIds!.map((id) => id as LegalEntityId),
                )
                .select(sql`1`.as('one')),
            ),
          );
        }
        if (input.categories && input.categories.length > 0) {
          query = query.where('fc.category', 'in', input.categories);
        }
        if (input.companyName) {
          query = query.where('le.name', 'ilike', `%${input.companyName}%`);
        }

        const rows = await query.execute();

        // Fetch fund names for each row
        const changelogIds = rows.map((r) => r.id);
        const fundLinks =
          changelogIds.length > 0
            ? await getValuationsQb(['funding_changelog_fund', 'legal_entity'])
                .selectFrom('funding_changelog_fund as fcf')
                .innerJoin('legal_entity as fund', 'fund.id', 'fcf.fund_id')
                .where('fcf.changelog_id', 'in', changelogIds)
                .select(['fcf.changelog_id', 'fund.name as fund_name'])
                .execute()
            : [];

        const fundsByChangelog = new Map<string, string[]>();
        for (const link of fundLinks) {
          const existing = fundsByChangelog.get(link.changelog_id) ?? [];
          existing.push(link.fund_name);
          fundsByChangelog.set(link.changelog_id, existing);
        }

        return rows.map((r) => ({
          date: r.created_at ? formatDate(new Date(r.created_at), 'yyyy-MM-dd HH:mm') : '',
          company: r.company_name,
          category: r.category ?? '',
          description: r.description,
          event_date: r.event_date ? formatDate(new Date(r.event_date), 'yyyy-MM-dd') : '',
          funds: (fundsByChangelog.get(r.id) ?? []).join(', '),
          user: r.username ?? '',
        }));
      }),
  });

export { companyRouter };
