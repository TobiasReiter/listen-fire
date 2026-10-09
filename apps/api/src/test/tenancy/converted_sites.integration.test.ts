// The two-team probe for the models CASL used to filter (D49(c,d), phase 5.5).
//
// `ctx.prisma` was once an authorised client: it rewrote every query's WHERE
// from a bound ability, with no per-call opt-in. So deleting that layer did not
// delete its call sites — it removed the filter UNDERNEATH them, and every
// model the ability genuinely filtered (the 5.4 map's third class) had to start
// carrying its own tenant condition. Whether each one does is this file's
// question, and it is a standing one: these are now the only filters there are.
//
// It was written while the layer still stood, and ran EVERY probe twice — once
// under a real user's ability, once with the ability opened all the way up
// (`adminAbilities()`), that second run standing in for the world after the
// deletion. The two had to agree, and did: 11/11 in both states.
//
// That second state is gone because it arrived. The expectations below are
// unchanged from the two-state form, which is what makes the post-deletion run
// comparable to the pre-deletion one — same probes, same answers.
//
// They are load-bearing rather than decorative, and that was checked the only
// way it can be: removing the filter from `upsertCompanyAsset` fails this file
// with `Matched too many assets for issuer …` (team B's identically-named asset
// becomes visible), and removing it from `RawTextService.getPartById` lets the
// cross-team part read succeed.

import { randomUUID } from 'node:crypto';

import * as db from '@prisma/client';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb, getKnowledgeQb, getValuationsQb } from '../../lib/kysely';
import { Context } from '../../services/context';
import { userPrincipal } from '../../services/principal';
import { ProfileService } from '../../services/profiles/profile';
import { ResourceService } from '../../services/resource';
import { RawTextService } from '../../services/raw_text';
import { upsertCompanyAsset } from '../../lib/datasources/asset';
import { upsertAssetTransfer } from '../../lib/datasources/asset_transfer';
import { getOrCreateTransactionByAssetTransfers } from '../../lib/datasources/data_layer';
import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

const tag = randomUUID().slice(0, 8);

/** One tenant's whole converted surface: a company, an equity asset issued by
 *  it, a transaction moving that asset, a price on it, a funding round, a
 *  resource and a piece of raw text. Both tenants get the SAME asset name and
 *  the same issuer id where the probe needs a collision, so "did the scoped
 *  read pick the wrong team's row?" is a question with a visible answer. */
interface Tenant {
  teamId: TeamId;
  userId: UserId;
  companyId: string;
  fundId: string;
  assetId: string;
  transactionId: string;
  transferId: string;
  eventId: string;
  priceId: string;
  resourceId: string;
  rawTextId: string;
  rawTextPartId: string;
}

const SHARED_ASSET_NAME = `probe-series-a-${tag}`;

async function makeTenant(label: string): Promise<Tenant> {
  const t: Tenant = {
    teamId: randomUUID() as TeamId,
    userId: randomUUID() as UserId,
    companyId: randomUUID(),
    fundId: randomUUID(),
    assetId: randomUUID(),
    transactionId: randomUUID(),
    transferId: randomUUID(),
    eventId: randomUUID(),
    priceId: randomUUID(),
    resourceId: randomUUID(),
    rawTextId: randomUUID(),
    rawTextPartId: randomUUID(),
  };

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: t.teamId, name: `casl-probe-${label}-${tag}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(
      anyVals({
        id: t.userId,
        default_team_id: t.teamId,
        username: `casl-probe-${label}-${tag}`,
        granted_access_at: new Date(),
      }),
    )
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values(anyVals({ id: randomUUID(), user_id: t.userId, team_id: t.teamId, access: 'write' }))
    .execute();

  for (const [id, name, isPortfolio] of [
    [t.companyId, `Probe Co ${label} ${tag}`, false],
    [t.fundId, `Probe Fund ${label} ${tag}`, true],
  ] as const) {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(
        anyVals({
          id,
          team_id: t.teamId,
          name,
          slug: `casl-probe-${label}-${id.slice(0, 8)}`,
          type: LegalEntityType.COMPANY,
          is_portfolio: isPortfolio,
        }),
      )
      .execute();
  }

  await getValuationsQb(['asset'])
    .insertInto('asset')
    .values(
      anyVals({
        id: t.assetId,
        team_id: t.teamId,
        // Deliberately identical across tenants, alongside a shared issuer id
        // in the collision probes: same name, same shape, different owner.
        name: SHARED_ASSET_NAME,
        type: db.AssetType.EQUITY,
        issued_by_legal_entity_id: t.companyId,
        properties: {},
      }),
    )
    .execute();

  await getValuationsQb(['event'])
    .insertInto('event')
    .values(
      anyVals({
        id: t.eventId,
        team_id: t.teamId,
        legal_entity_id: t.companyId,
        name: `Probe Round ${label}`,
        type: db.EventType.INVESTMENT_ROUND,
        date: new Date('2026-01-01'),
        asset_type: db.AssetType.EQUITY,
        valuation: 1_000_000,
        valuation_currency: db.CurrencyIsoCode.USD,
      }),
    )
    .execute();

  await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values(
      anyVals({
        id: t.transactionId,
        team_id: t.teamId,
        close_date: new Date('2026-01-01'),
        event_id: t.eventId,
      }),
    )
    .execute();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values(
      anyVals({
        id: t.transferId,
        team_id: t.teamId,
        asset_id: t.assetId,
        transaction_id: t.transactionId,
        from_legal_entity_id: t.companyId,
        to_legal_entity_id: t.fundId,
        num_assets: 100,
        date: new Date('2026-01-01'),
      }),
    )
    .execute();

  await getValuationsQb(['price'])
    .insertInto('price')
    .values(
      anyVals({
        id: t.priceId,
        team_id: t.teamId,
        asset_id: t.assetId,
        legal_entity_id: t.companyId,
        event_id: t.eventId,
        date: new Date('2026-01-01'),
        price: label === 'a' ? 10 : 999,
        currency: db.CurrencyIsoCode.USD,
        type: db.PriceType.FROM_PRICED_ROUND,
      }),
    )
    .execute();

  await getKnowledgeQb(['raw_text'])
    .insertInto('raw_text')
    .values(
      anyVals({
        id: t.rawTextId,
        team_id: t.teamId,
        content: `probe raw text ${label} ${tag}`,
        checksum: `casl-probe-${label}-${tag}`,
      }),
    )
    .execute();

  await getKnowledgeQb(['raw_text_part'])
    .insertInto('raw_text_part')
    .values(
      anyVals({
        id: t.rawTextPartId,
        team_id: t.teamId,
        raw_text_id: t.rawTextId,
        type: db.RawTextPartType.LINE_NUMBER,
        start: 0,
        end: 5,
        compressed_content: `part ${label}`,
      }),
    )
    .execute();

  await getKnowledgeQb(['resource'])
    .insertInto('resource')
    .values(
      anyVals({
        id: t.resourceId,
        team_id: t.teamId,
        type: db.ResourceType.URL,
        name: `probe resource ${label}`,
        url: `https://probe.invalid/${label}/${tag}`,
        metadata: {},
      }),
    )
    .execute();

  return t;
}

async function dropTenant(t: Tenant | undefined): Promise<void> {
  if (!t) return;
  await getKnowledgeQb(['resource']).deleteFrom('resource').where('team_id', '=', t.teamId).execute();
  await getKnowledgeQb(['raw_text_part'])
    .deleteFrom('raw_text_part')
    .where('team_id', '=', t.teamId)
    .execute();
  await getKnowledgeQb(['raw_text']).deleteFrom('raw_text').where('team_id', '=', t.teamId).execute();
  await getValuationsQb(['price']).deleteFrom('price').where('team_id', '=', t.teamId).execute();
  await getValuationsQb(['asset_transfer'])
    .deleteFrom('asset_transfer')
    .where('team_id', '=', t.teamId)
    .execute();
  await getValuationsQb(['transaction'])
    .deleteFrom('transaction')
    .where('team_id', '=', t.teamId)
    .execute();
  await getValuationsQb(['event']).deleteFrom('event').where('team_id', '=', t.teamId).execute();
  await getValuationsQb(['asset']).deleteFrom('asset').where('team_id', '=', t.teamId).execute();
  await getValuationsQb(['legal_entity'])
    .deleteFrom('legal_entity')
    .where('team_id', '=', t.teamId)
    .execute();
  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    .where('user_id', '=', t.userId)
    .execute();
  await getCoreQb(['user']).deleteFrom('user').where('id', '=', t.userId).execute();
  await getCoreQb(['team']).deleteFrom('team').where('id', '=', t.teamId).execute();
}

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  a = await makeTenant('a');
  b = await makeTenant('b');
}, 60_000);

afterAll(async () => {
  await dropTenant(a);
  await dropTenant(b);
}, 60_000);

/** Acting as tenant A's user, with the identity built exactly the way a request
 *  builds it. A fresh Context per call, since the dataloaders memoise per
 *  context and a cached row would answer for the call site rather than the call
 *  site answering for itself. */
async function asTenantA<T>(probe: (ctx: Context) => Promise<T>, expected: T) {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: a.userId, teamId: a.teamId }));
  const actual = await ctx.runAsync(() => probe(ctx));
  expect(actual).toEqual(expected);
}

const outcome = async (fn: () => Promise<unknown>): Promise<'ok' | 'refused'> => {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'refused';
  }
};

describe('the valuations upsert seam — a name collision must not reach the other team', () => {
  it('mints team A its own asset instead of updating team B’s identically-named one', async () => {
    await asTenantA(async (ctx) => {
      const asset = await upsertCompanyAsset(
        {
          assetName: SHARED_ASSET_NAME,
          assetType: db.AssetType.EQUITY,
          assetProperties: {},
          // B's issuer, asked for by A: the sharpest form of the question,
          // because the row B owns matches on every column the read filters on
          // except the one this chunk added.
          issuingLegalEntityId: b.companyId,
        },
        ctx,
      );
      return { teamId: asset.teamId, isTeamBsRow: asset.id === b.assetId };
    }, { teamId: a.teamId, isTeamBsRow: false });
  });

  it('mints team A its own transfer instead of updating team B’s', async () => {
    await asTenantA(async (ctx) => {
      const transfer = await upsertAssetTransfer(
        {
          fromLegalEntityId: b.companyId,
          toLegalEntityId: b.fundId,
          assetId: b.assetId,
          numAssets: 7,
          transactionId: b.transactionId,
          date: new Date('2026-01-01'),
        },
        ctx,
      );
      return { teamId: transfer.teamId, isTeamBsRow: transfer.id === b.transferId };
    }, { teamId: a.teamId, isTeamBsRow: false });
  });

  it('does not hand team B’s transaction back to team A’s get-or-create', async () => {
    await asTenantA(async (ctx) => {
      const transaction = await getOrCreateTransactionByAssetTransfers(
        {
          fromLegalEntityId: b.companyId,
          toLegalEntityId: b.fundId,
          givenAssetId: b.assetId,
          receivedAssetId: b.assetId,
          date: new Date('2026-01-01'),
        },
        ctx,
      );
      return { teamId: transaction.teamId, isTeamBsRow: transaction.id === b.transactionId };
    }, { teamId: a.teamId, isTeamBsRow: false });
  });
});

describe('the portfolio reads — another team’s company answers with nothing, not with its numbers', () => {
  it('values team B’s company at null for team A', async () => {
    await asTenantA(
      async () => ProfileService.getTotalValue(b.companyId),
      null,
    );
  });

  it('finds no priced round on team B’s company for team A', async () => {
    await asTenantA(
      async () => ProfileService.getLatestRoundWithValuation(b.companyId),
      null,
    );
  });

  it('still answers for team A’s OWN company — the filter narrows, it does not blank', async () => {
    await asTenantA(
      async () => (await ProfileService.getLatestRoundWithValuation(a.companyId)) !== null,
      true,
    );
  });
});

describe('the source-material services — `Resource` and `RawTextPart` are row-3 models too', () => {
  it('refuses to update another team’s resource', async () => {
    await asTenantA(
      async () => outcome(() => ResourceService.update(b.resourceId, { isDemo: true })),
      'refused',
    );
  });

  it('updates team A’s own resource', async () => {
    await asTenantA(
      async () => outcome(() => ResourceService.update(a.resourceId, { isDemo: true })),
      'ok',
    );
  });

  it('refuses to read another team’s raw-text part', async () => {
    await asTenantA(
      async () => outcome(() => RawTextService.getPartById(b.rawTextPartId)),
      'refused',
    );
  });

  it('reads team A’s own raw-text part', async () => {
    await asTenantA(
      async () => outcome(() => RawTextService.getPartById(a.rawTextPartId)),
      'ok',
    );
  });

  it('lists no parts of another team’s raw text', async () => {
    await asTenantA(
      async () => (await RawTextService.getParts({ rawTextId: b.rawTextId })).length,
      0,
    );
  });
});
