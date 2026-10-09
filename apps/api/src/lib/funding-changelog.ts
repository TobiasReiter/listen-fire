import type { FundingChangelogId } from '../generated/kysely/valuations/FundingChangelog';
import type { LegalEntityId } from '../generated/kysely/valuations/LegalEntity';
import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';

import { currentContext } from '../services/context';
import { getQb, getValuationsQb } from './kysely';

export async function logFundingChange(options: {
  legalEntityId: string;
  description: string;
  category: string;
  eventDate?: string | Date | null;
}) {
  const ctx = currentContext();

  const [row] = await getValuationsQb(['funding_changelog'])
    .insertInto('funding_changelog')
    .values({
      team_id: ctx.user.teamId as TeamId,
      legal_entity_id: options.legalEntityId as LegalEntityId,
      user_id: (ctx.user.id ?? null) as UserId | null,
      description: options.description,
      category: options.category,
      event_date: options.eventDate ? new Date(options.eventDate) : null,
    })
    .returning('id')
    .execute();

  // Link to all funds (is_portfolio=true) that have invested in this company
  const funds = await getValuationsQb(['investment', 'legal_entity'])
    .selectFrom('investment')
    .innerJoin('legal_entity', 'legal_entity.id', 'investment.investor_profile_id')
    .where('investment.team_id', '=', ctx.user.teamId as TeamId)
    .where('investment.investment_profile_id', '=', options.legalEntityId as LegalEntityId)
    .where((eb) =>
      eb.or([
        eb('legal_entity.is_portfolio', '=', true),
        eb('legal_entity.is_own_investing_entity', '=', true),
      ]),
    )
    .select('legal_entity.id')
    .distinct()
    .execute();

  if (funds.length > 0) {
    await getValuationsQb(['funding_changelog_fund'])
      .insertInto('funding_changelog_fund')
      .values(
        funds.map((f) => ({
          changelog_id: row.id as FundingChangelogId,
          fund_id: f.id as LegalEntityId,
        })),
      )
      .execute();
  }
}

export function formatCurrency(amount: string | number, currency: string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(num)) return `${amount} ${currency}`;

  if (num >= 1_000_000_000) return `${currency} ${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${currency} ${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${currency} ${(num / 1_000).toFixed(0)}K`;
  return `${currency} ${num.toLocaleString()}`;
}
