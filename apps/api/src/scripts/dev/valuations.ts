/**
 * Dev-loop NATIVE_VALUATIONS wiring (movement model).
 *
 *   pnpm dev:valuations setup   → idempotently provisions the integration:
 *       • api-key with the `valuations` scope (Bearer token the adapter
 *         authenticates with; also registered in platform_owned_token so loop
 *         suppression recognises our own writes echoed back),
 *       • external_service_credentials of type NATIVE_VALUATIONS holding
 *         {apiKey, apiKeyId, baseUrl} — named `Dev Loop Valuations` for
 *         movement imports. A credential whose stored baseUrl no longer
 *         matches the active stack is healed in place (the ":3000 footgun").
 *       • GBP/USD `currency_asset` rows and a GBP→USD `exchange_rate` row —
 *         global reference data nothing else seeds (only integration tests
 *         insert it ad hoc); without it, any cash leg or cross-currency read
 *         (addInvestment's mutation, the Overview page's default USD view)
 *         throws instead of degrading.
 *   pnpm dev:valuations seed    → seeds a small portfolio through the REAL
 *       REST surface (fund + company + round event + investment + transaction
 *       + share class + transfer + price) so parent-first movement reads have
 *       something to traverse. Idempotent by company name.
 *   pnpm dev:valuations status  → prints what's wired.
 *
 * The predecessor CLI died with the TG teardown (e032ebc61); this is the
 * movement-model reimplementation (coverage-audit #8), scoped to what the
 * adapter's dev-loop verification needs.
 */
import './_profile_loader';

import { randomUUID } from 'node:crypto';

import type { TeamId } from '../../generated/kysely/core/Team';
import type { UserId } from '../../generated/kysely/core/User';
import type { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';
import type { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';

import { mintUniqueSlug } from '../../lib/valuations/slug';
import { encryptToken, decryptToken } from '../../lib/credentials';
import { getAutomationsQb, getCoreQb, getValuationsQb } from '../../lib/kysely';
import ExternalServiceType from '../../generated/kysely/automations/ExternalServiceType';
import AssetType from '../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import { ApiKeyService } from '../../services/api_key';
import { ensureDevLoopTeam } from './_lib';

const ADAPTER_TYPE = 'native-valuations';
const CREDENTIAL_NAME = 'Dev Loop Valuations';
const API_KEY_NAME = 'Dev Loop Valuations Integration';

const API_HOST_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

// Minted through the service rather than by a second copy of its generator.
// The copy that used to live here carried its own hard-coded key prefix, and
// `validateKey` refuses anything that does not start with the current one —
// so the demo's valuations leg authenticated with a key the door threw away.
async function ensureApiKey(teamId: TeamId, userId: UserId): Promise<{
  id: string;
  plaintext: string | null;
  created: boolean;
}> {
  const existing = await getCoreQb(['api_key'])
    .selectFrom('api_key')
    .where('team_id', '=', teamId)
    .where('name', '=', API_KEY_NAME)
    .where('revoked_at', 'is', null)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return { id: existing.id, plaintext: null, created: false };
  const minted = await ApiKeyService.createForOwner({
    name: API_KEY_NAME,
    scopes: ['valuations'],
    teamId,
    createdBy: userId,
  });
  return { id: minted.id, plaintext: minted.key, created: true };
}

interface StoredCreds {
  apiKey: string;
  apiKeyId?: string;
  baseUrl?: string;
}

async function readCredential(teamId: TeamId): Promise<
  { id: string; stored: StoredCreds } | undefined
> {
  const row = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('team_id', '=', teamId)
    .where('type', '=', ExternalServiceType.NATIVE_VALUATIONS)
    .where('name', '=', CREDENTIAL_NAME)
    .select(['id', 'credentials'])
    .executeTakeFirst();
  if (!row) return undefined;
  const decrypted = await decryptToken(row.credentials as Buffer, row.id);
  return { id: row.id, stored: JSON.parse(decrypted) as StoredCreds };
}

async function ensureCredential(input: {
  teamId: TeamId;
  apiKey: { id: string; plaintext: string | null };
}): Promise<{ id: string; healed: boolean; created: boolean }> {
  const qb = getAutomationsQb(['external_service_credentials']);
  const existing = await readCredential(input.teamId);
  if (existing) {
    // Heal a stale baseUrl (a credential minted against another stack) —
    // keep the stored apiKey (its plaintext is unrecoverable elsewhere).
    if (existing.stored.baseUrl !== API_HOST_BASE_URL) {
      const encrypted = await encryptToken(
        JSON.stringify({ ...existing.stored, baseUrl: API_HOST_BASE_URL }),
        existing.id,
      );
      await qb
        .updateTable('external_service_credentials')
        .set({ credentials: encrypted })
        .where('id', '=', existing.id as ExternalServiceCredentialsId)
        .execute();
      return { id: existing.id, healed: true, created: false };
    }
    return { id: existing.id, healed: false, created: false };
  }
  if (input.apiKey.plaintext === null) {
    throw new Error(
      `No ${CREDENTIAL_NAME} credential exists but the api-key '${API_KEY_NAME}' predates it, ` +
        `so its plaintext is unrecoverable. Revoke the api_key row and re-run setup.`,
    );
  }
  const credId = randomUUID() as ExternalServiceCredentialsId;
  const encrypted = await encryptToken(
    JSON.stringify({
      apiKey: input.apiKey.plaintext,
      apiKeyId: input.apiKey.id,
      baseUrl: API_HOST_BASE_URL,
    }),
    credId,
  );
  await qb
    .insertInto('external_service_credentials')
    .values({
      id: credId,
      name: CREDENTIAL_NAME,
      type: ExternalServiceType.NATIVE_VALUATIONS,
      credentials: encrypted,
      team_id: input.teamId,
    } as never)
    .execute();
  return { id: credId, healed: false, created: true };
}

/** `asset`/`currency_asset` are GLOBAL reference rows (no team_id) — every
 *  cash leg (`addCashFlow`) looks one up by iso_code and throws if it's
 *  missing. Nothing in the schema seeds them and no REST route creates them;
 *  only integration tests insert one ad hoc per run. The dev-loop fixture
 *  needs GBP (what it invests in) durably, so `setup` provisions it here
 *  instead of every write-path probe reinventing the same insert. */
const CURRENCIES: { code: CurrencyIsoCode; name: string; symbol: string; pairOrder: number }[] = [
  { code: CurrencyIsoCode.GBP, name: 'British Pound', symbol: '£', pairOrder: 1 },
  { code: CurrencyIsoCode.USD, name: 'US Dollar', symbol: '$', pairOrder: 2 },
];

async function ensureCurrencyAssets(): Promise<string[]> {
  const created: string[] = [];
  for (const { code, name, symbol, pairOrder } of CURRENCIES) {
    const existing = await getValuationsQb(['currency_asset'])
      .selectFrom('currency_asset')
      .where('iso_code', '=', code)
      .select(['id'])
      .executeTakeFirst();
    if (existing) continue;

    const assetId = randomUUID();
    await getValuationsQb(['asset'])
      .insertInto('asset')
      .values({
        id: assetId,
        name,
        type: AssetType.CURRENCY,
        properties: JSON.stringify({}),
      } as never)
      .execute();
    await getValuationsQb(['currency_asset'])
      .insertInto('currency_asset')
      .values({
        id: randomUUID(),
        asset_id: assetId,
        iso_code: code,
        name,
        symbol,
        pair_order: pairOrder,
      } as never)
      .execute();
    created.push(code);
  }
  return created;
}

/** `getFxRate` throws (not degrades) when a pair has no row at all — cross-
 *  currency reads (the UI's default view currency almost never matches an
 *  investment's own currency) 500 without one. Dated well in the past so
 *  every "as of" lookup finds it via the <= match. */
const EXCHANGE_RATES: { from: CurrencyIsoCode; to: CurrencyIsoCode; rate: number }[] = [
  { from: CurrencyIsoCode.GBP, to: CurrencyIsoCode.USD, rate: 1.27 },
];

async function ensureExchangeRates(): Promise<string[]> {
  const created: string[] = [];
  const date = new Date('2025-01-01');
  for (const { from, to, rate } of EXCHANGE_RATES) {
    const existing = await getValuationsQb(['exchange_rate'])
      .selectFrom('exchange_rate')
      .where('from_currency', '=', from)
      .where('to_currency', '=', to)
      .where('date', '=', date)
      .select(['id'])
      .executeTakeFirst();
    if (existing) continue;

    await getValuationsQb(['exchange_rate'])
      .insertInto('exchange_rate')
      .values({
        id: randomUUID(),
        from_currency: from,
        to_currency: to,
        date,
        rate,
      } as never)
      .execute();
    created.push(`${from}/${to}`);
  }
  return created;
}

async function ensurePlatformToken(input: { teamId: TeamId; apiKeyId: string }): Promise<boolean> {
  const qb = getAutomationsQb(['platform_owned_token']);
  const existing = await qb
    .selectFrom('platform_owned_token')
    .where('team_id', '=', input.teamId)
    .where('adapter_type', '=', ADAPTER_TYPE)
    .where('external_token_id', '=', input.apiKeyId)
    .where('revoked_at', 'is', null)
    .select(['id'])
    .executeTakeFirst();
  if (existing) return false;
  await qb
    .insertInto('platform_owned_token')
    .values({
      team_id: input.teamId,
      adapter_type: ADAPTER_TYPE,
      external_token_id: input.apiKeyId,
      description: 'Dev-loop integration api-key for the NATIVE_VALUATIONS adapter',
    } as never)
    .execute();
  return true;
}

// ── REST client (the real surface, Bearer-authenticated) ───────────────────

async function rest<T>(input: {
  apiKey: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}): Promise<T> {
  const url = new URL(`${API_HOST_BASE_URL}${input.path}`);
  for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);
  const response = await fetch(url.toString(), {
    method: input.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `Valuations REST ${input.method} ${input.path} → ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

interface Row {
  id: string;
  [k: string]: unknown;
}
interface ListEnvelope {
  data: Row[];
}
interface RecordEnvelope {
  data: Row;
}

/** The seed's own slug minting, for REPAIRING a company that predates the
 *  create path minting one (`lib/valuations/slug.ts`). A create no longer
 *  needs to pass `slug` at all — the API fills it in. */
async function mintSeedSlug(name: string, excludeId?: string): Promise<string> {
  const slug = await mintUniqueSlug(getValuationsQb(['legal_entity']), name, { excludeId });
  if (slug === undefined) throw new Error(`'${name}' does not slugify to anything`);
  return slug;
}

/** A small but complete portfolio: every parent-first edge has something to
 *  traverse. Idempotent — skips if the company already exists (matched by
 *  name, scoped to the team by the Bearer token). Repairs an existing
 *  company's slug if it's missing. */
async function seed(apiKey: string): Promise<unknown> {
  const existing = await rest<ListEnvelope>({
    apiKey,
    method: 'GET',
    path: '/api/v1/valuations/legal-entities',
    query: { search: 'NewCo' },
  });
  if (existing.data.length > 0) {
    const existingCompany = existing.data[0];
    // Repair slug if missing
    if (!existingCompany.slug) {
      const newSlug = await mintSeedSlug('NewCo', existingCompany.id);
      await rest<RecordEnvelope>({
        apiKey,
        method: 'PATCH',
        path: `/api/v1/valuations/legal-entities/${existingCompany.id}`,
        body: { slug: newSlug },
      });
      return { seeded: false, reason: `'NewCo' already exists (${existingCompany.id}), repaired slug: ${newSlug}` };
    }
    return { seeded: false, reason: `'NewCo' already exists (${existingCompany.id})` };
  }

  const create = (path: string, body: unknown) =>
    rest<RecordEnvelope>({ apiKey, method: 'POST', path, body });

  const fund = await create('/api/v1/valuations/legal-entities', {
    type: 'FUND',
    name: 'Fund I',
    is_own_investing_entity: true,
    is_portfolio: true,
  });
  // `is_deprecated` isn't in the REST create/update schemas (the movement
  // surface never exposes it), so it's patched directly. Prisma's
  // `isDeprecated: false` filter (getInvestingEntities, addAcquisition)
  // excludes NULL, which is what a freshly-created row gets otherwise.
  await getValuationsQb(['legal_entity'])
    .updateTable('legal_entity')
    .set({ is_deprecated: false })
    .where('id', '=', fund.data.id as LegalEntityId)
    .execute();
  const companySlug = await mintSeedSlug('NewCo');
  const company = await create('/api/v1/valuations/legal-entities', {
    type: 'COMPANY',
    name: 'NewCo',
    slug: companySlug,
    // NOT is_portfolio: true — the inventory walk requires an asset's ISSUER
    // to be neither is_portfolio nor is_own_investing_entity (data.ts), so
    // flagging the invested-in company as portfolio hides its holdings.
    description: 'a promising company',
  });
  const event = await create('/api/v1/valuations/events', {
    date: '2026-01-15',
    legal_entity_id: company.data.id,
    type: 'INVESTMENT_ROUND',
    name: 'Seed Round',
    raised_amount: 1_000_000,
    raised_currency: 'GBP',
    valuation: 5_000_000,
    valuation_currency: 'GBP',
    valuation_type: 'PRE_MONEY',
    round_type: 'SEED',
    investment_round_type: 'EQUITY',
  });
  const investment = await create('/api/v1/valuations/investments', {
    investor_profile_id: fund.data.id,
    investment_profile_id: company.data.id,
    round_type: 'SEED',
    type: 'CASH',
    invested_at: '2026-01-20T00:00:00.000Z',
    event_id: event.data.id,
  });
  const transaction = await create('/api/v1/valuations/transactions', {
    close_date: '2026-01-20',
    investment_id: investment.data.id,
    event_id: event.data.id,
  });
  const asset = await create('/api/v1/valuations/assets', {
    type: 'EQUITY',
    name: 'NewCo Ordinary Shares',
    issued_by_legal_entity_id: company.data.id,
  });
  await create('/api/v1/valuations/asset-transfers', {
    asset_id: asset.data.id,
    transaction_id: transaction.data.id,
    date: '2026-01-20',
    from_legal_entity_id: company.data.id,
    to_legal_entity_id: fund.data.id,
    num_assets: 10_000,
  });
  await create('/api/v1/valuations/prices', {
    asset_id: asset.data.id,
    date: '2026-01-20',
    price: 100,
    currency: 'GBP',
    type: 'FROM_PRICED_ROUND',
    legal_entity_id: company.data.id,
    event_id: event.data.id,
  });

  return {
    seeded: true,
    fund: fund.data.id,
    company: company.data.id,
    event: event.data.id,
    investment: investment.data.id,
    transaction: transaction.data.id,
    asset: asset.data.id,
  };
}

async function main() {
  const command = process.argv[2] ?? 'setup';
  const seedResult = await ensureDevLoopTeam();
  const teamId = seedResult.teamId as TeamId;

  if (command === 'setup') {
    const apiKey = await ensureApiKey(teamId, seedResult.userId as UserId);
    const credential = await ensureCredential({ teamId, apiKey });
    const tokenRegistered = await ensurePlatformToken({ teamId, apiKeyId: apiKey.id });
    const currenciesCreated = await ensureCurrencyAssets();
    const exchangeRatesCreated = await ensureExchangeRates();
    console.log(
      JSON.stringify(
        {
          teamId,
          baseUrl: API_HOST_BASE_URL,
          apiKey: { id: apiKey.id, created: apiKey.created },
          credential: { ...credential, name: CREDENTIAL_NAME },
          platformTokenRegistered: tokenRegistered,
          currenciesCreated,
          exchangeRatesCreated,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'seed') {
    const credential = await readCredential(teamId);
    if (!credential) {
      console.error(`No ${CREDENTIAL_NAME} credential — run \`pnpm dev:valuations setup\` first.`);
      process.exit(1);
    }
    console.log(JSON.stringify(await seed(credential.stored.apiKey), null, 2));
    return;
  }

  if (command === 'status') {
    const credential = await readCredential(teamId);
    const apiKey = await getCoreQb(['api_key'])
      .selectFrom('api_key')
      .where('team_id', '=', teamId)
      .where('name', '=', API_KEY_NAME)
      .where('revoked_at', 'is', null)
      .select(['id', 'key_prefix', 'scopes'])
      .executeTakeFirst();
    console.log(
      JSON.stringify(
        {
          teamId,
          baseUrl: API_HOST_BASE_URL,
          apiKey: apiKey ?? null,
          credential: credential
            ? { id: credential.id, baseUrl: credential.stored.baseUrl, name: CREDENTIAL_NAME }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(`Unknown command '${command}'. Use: setup | seed | status`);
  process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
