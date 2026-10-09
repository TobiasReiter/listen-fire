// The two-team probe for the five BESPOKE valuations dataloaders (phase 6.2).
//
// These are the loaders that were never under the ability at all. Each one
// takes a `prisma` as a parameter and closes over it, and the `Context` that
// builds them hands over the plain client — so `assetById`, the three price
// loaders, `notesByReferenceIdAndType`, `transactionById` and the two event
// loaders batched by id with no tenant condition whatsoever. Phase 5 recorded
// that rather than fixing it, because narrowing them is a behaviour ruling
// (D50); 6.2 makes the ruling: they carry the acting team's id, read when the
// batch runs (`actingTeamFilter`).
//
// The question this file asks is the same one `converted_sites` and
// `generic_dataloaders` ask, against real rows in a real database: acting as a
// member of team A, which of team B's rows comes back? For a loader the answer
// must be "none, and A's own still come back" — a filter that narrows rather
// than blanks.
//
// The expectations are load-bearing, and that was checked the only way it can
// be: removing `teamId: actingTeamFilter()` from any one loader fails its
// probe here with team B's row in hand.

import { randomUUID } from 'node:crypto';

import * as db from '@prisma/client';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';

import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { Context } from '../../services/context';
import { userPrincipal } from '../../services/principal';
import LegalEntityType from '../../generated/kysely/valuations/LegalEntityType';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyVals = (v: Record<string, unknown>) => v as any;

const tag = randomUUID().slice(0, 8);

const AS_OF = new Date('2026-06-01');

/** One tenant's whole loader-reachable surface: a company, an equity asset it
 *  issued, a funding round, a transaction moving the asset, a price on it and
 *  a note about it. Both tenants get the same shape so every probe below has a
 *  team-B row that would answer if the filter were not there. */
interface Tenant {
  teamId: TeamId;
  userId: UserId;
  companyId: string;
  fundId: string;
  assetId: string;
  eventId: string;
  transactionId: string;
  transferId: string;
  priceId: string;
  noteId: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const t: Tenant = {
    teamId: randomUUID() as TeamId,
    userId: randomUUID() as UserId,
    companyId: randomUUID(),
    fundId: randomUUID(),
    assetId: randomUUID(),
    eventId: randomUUID(),
    transactionId: randomUUID(),
    transferId: randomUUID(),
    priceId: randomUUID(),
    noteId: randomUUID(),
  };

  await getCoreQb(['team'])
    .insertInto('team')
    .values(anyVals({ id: t.teamId, name: `loader-probe-${label}-${tag}` }))
    .execute();
  await getCoreQb(['user'])
    .insertInto('user')
    .values(
      anyVals({
        id: t.userId,
        default_team_id: t.teamId,
        username: `loader-probe-${label}-${tag}`,
        granted_access_at: new Date(),
      }),
    )
    .execute();
  await getCoreQb(['team_membership'])
    .insertInto('team_membership')
    .values(anyVals({ id: randomUUID(), user_id: t.userId, team_id: t.teamId, access: 'write' }))
    .execute();

  for (const [id, name, isPortfolio] of [
    [t.companyId, `Loader Co ${label} ${tag}`, false],
    [t.fundId, `Loader Fund ${label} ${tag}`, true],
  ] as const) {
    await getValuationsQb(['legal_entity'])
      .insertInto('legal_entity')
      .values(
        anyVals({
          id,
          team_id: t.teamId,
          name,
          slug: `loader-probe-${label}-${id.slice(0, 8)}`,
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
        name: `loader-series-a-${tag}`,
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
        name: `Loader Round ${label}`,
        type: db.EventType.DISTRIBUTION,
        date: new Date('2026-01-01'),
        asset_type: db.AssetType.EQUITY,
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

  await getValuationsQb(['note'])
    .insertInto('note')
    .values(
      anyVals({
        id: t.noteId,
        team_id: t.teamId,
        message: `loader note ${label} ${tag}`,
        note_type: db.NoteType.PROFILE,
        reference_id: t.companyId,
        created_by: t.userId,
      }),
    )
    .execute();

  return t;
}

async function dropTenant(t: Tenant | undefined): Promise<void> {
  if (!t) return;
  await getValuationsQb(['note']).deleteFrom('note').where('team_id', '=', t.teamId).execute();
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

/** Run `load` as tenant A's user, with the identity built exactly the way a
 *  request builds it. A fresh Context per call, since the dataloaders memoise
 *  per context and a cached row would answer for the loader rather than the
 *  loader answering for itself. */
async function asTenantA<T>(load: (ctx: Context) => Promise<T>): Promise<T> {
  const ctx = new Context();
  ctx.bindPrincipal(userPrincipal({ userId: a.userId, teamId: a.teamId }));
  return ctx.runAsync(() => load(ctx));
}

describe('assetById — the loader every valuations asset read batches through', () => {
  it('hands back the acting team’s own asset', async () => {
    const asset = await asTenantA((ctx) => ctx.dataloaders.assetById.load(a.assetId));
    expect(asset?.id).toBe(a.assetId);
  });

  it('refuses the other team’s asset', async () => {
    const asset = await asTenantA((ctx) => ctx.dataloaders.assetById.load(b.assetId));
    expect(asset).toBeNull();
  });
});

describe('transactionById — the loader the convertible writes work from', () => {
  it('hands back the acting team’s own transaction', async () => {
    const txn = await asTenantA((ctx) => ctx.dataloaders.transactionById.load(a.transactionId));
    expect(txn?.id).toBe(a.transactionId);
  });

  it('refuses the other team’s transaction', async () => {
    const txn = await asTenantA((ctx) => ctx.dataloaders.transactionById.load(b.transactionId));
    expect(txn).toBeNull();
  });
});

describe('the two event loaders', () => {
  it('hands back the acting team’s own event, by id and by transaction', async () => {
    const [byId, byTxn] = await asTenantA((ctx) =>
      Promise.all([
        ctx.dataloaders.eventWithTransfersById.load(a.eventId),
        ctx.dataloaders.eventByTransactionId.load(a.transactionId),
      ]),
    );
    expect(byId?.id).toBe(a.eventId);
    expect(byTxn?.id).toBe(a.eventId);
  });

  it('refuses the other team’s event, by id and by transaction', async () => {
    const [byId, byTxn] = await asTenantA((ctx) =>
      Promise.all([
        ctx.dataloaders.eventWithTransfersById.load(b.eventId),
        ctx.dataloaders.eventByTransactionId.load(b.transactionId),
      ]),
    );
    expect(byId).toBeNull();
    expect(byTxn).toBeNull();
  });

  it('lists no distributions on the other team’s entity, and its own on its own', async () => {
    const own = await asTenantA((ctx) =>
      ctx.dataloaders.distributionByLegalEntityId.load(a.companyId),
    );
    expect(own.map((e) => e.id)).toEqual([a.eventId]);

    const other = await asTenantA((ctx) =>
      ctx.dataloaders.distributionByLegalEntityId.load(b.companyId),
    );
    expect(other).toEqual([]);
  });
});

describe('the three price loaders', () => {
  it('prices the acting team’s own asset and issuer', async () => {
    const [byAsset, byIssuer, byIssuerAndType] = await asTenantA((ctx) =>
      Promise.all([
        ctx.dataloaders.latestPriceByAssetIdAndDate.load({ assetId: a.assetId, asOfDate: AS_OF }),
        ctx.dataloaders.pricesByIssuerId.load(a.companyId),
        ctx.dataloaders.latestPricesByIssuerAssetTypeAndDate.load({
          issuedByLegalEntityId: a.companyId,
          assetType: db.AssetType.EQUITY,
          asOfDate: AS_OF,
          preferredAssetId: undefined,
        }),
      ]),
    );
    expect(byAsset?.id).toBe(a.priceId);
    expect(byIssuer.map((p) => p.id)).toEqual([a.priceId]);
    expect(byIssuerAndType?.id).toBe(a.priceId);
  });

  it('refuses to price the other team’s asset and issuer', async () => {
    const [byAsset, byIssuer, byIssuerAndType] = await asTenantA((ctx) =>
      Promise.all([
        ctx.dataloaders.latestPriceByAssetIdAndDate.load({ assetId: b.assetId, asOfDate: AS_OF }),
        ctx.dataloaders.pricesByIssuerId.load(b.companyId),
        ctx.dataloaders.latestPricesByIssuerAssetTypeAndDate.load({
          issuedByLegalEntityId: b.companyId,
          assetType: db.AssetType.EQUITY,
          asOfDate: AS_OF,
          preferredAssetId: undefined,
        }),
      ]),
    );
    expect(byAsset).toBeNull();
    expect(byIssuer).toEqual([]);
    expect(byIssuerAndType).toBeNull();
  });
});

describe('notesByReferenceIdAndType', () => {
  it('reads the acting team’s own note on its own company', async () => {
    const notes = await asTenantA((ctx) =>
      ctx.dataloaders.notesByReferenceIdAndType.load({
        referenceId: a.companyId,
        noteType: db.NoteType.PROFILE,
      }),
    );
    expect(notes.map((n) => n.id)).toEqual([a.noteId]);
  });

  it('reads none of the other team’s notes', async () => {
    const notes = await asTenantA((ctx) =>
      ctx.dataloaders.notesByReferenceIdAndType.load({
        referenceId: b.companyId,
        noteType: db.NoteType.PROFILE,
      }),
    );
    expect(notes).toEqual([]);
  });
});

describe('a loader with no identity behind it reads nothing rather than everything', () => {
  it('answers null for a real id when the context has no principal', async () => {
    // The `{ in: [] }` half of `actingTeamFilter`. A background job that
    // forgot to establish an identity must come back empty-handed, not with
    // every tenant's rows.
    const ctx = new Context();
    const asset = await ctx.runAsync(() => ctx.dataloaders.assetById.load(a.assetId));
    expect(asset).toBeNull();
  });
});
