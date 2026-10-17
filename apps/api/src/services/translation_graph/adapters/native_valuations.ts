//
// Listen-Fire Valuations adapter — bridges the translation-graph framework to the
// Listen-Fire Valuations product. Per P1 of the parent plan, Valuations is treated
// as an external third party: this adapter calls the Valuations REST API
// (/api/v1/valuations/...), authenticated with an api-key registered in
// `platform_owned_token` so loop suppression recognizes our own writes.
//
// This is the working starting point. legal_entity is implemented end-to-end
// (read, write, snapshot); the other entities are catalogued in
// `listEntryPoints` and have stub `describe` outputs but throw on writes
// until each is fleshed out.

import { z } from 'zod';

import type { TeamId } from '../../../generated/kysely/core/Team';
import type {
  Adapter,
  AdapterManifest,
  DeleteInput,
  DeleteResult,
  DiscriminableEvent,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  ReadInput,
  RelatedResult,
  SnapshotInput,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
  FilterTranslationResult,
  EnsureEventSubscriptionInput,
  EventSubscriptionRegistration,
  RemoveEventSubscriptionInput,
  EdgesFromResult,
  ResolveEntityInput,
  ResolveEntityResult,
  ExternalRecordRef,
} from 'movement-engine/services/translation_graph/adapter';
import type { TriggerEvent, TriggerType } from 'movement-engine/services/translation_graph/triggers/types';
import type { EdgeSequencing, Expression } from '#shared/expression/types';
import type { ExternalServiceCredentialsId } from '../../../generated/kysely/automations/ExternalServiceCredentials';

import { parseValuationsEvents } from '../../webhook_sync/providers/native_valuations';
import { webhookEventToDiscriminable } from '../../webhook_sync/event_conversion';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import {
  NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS,
  registerValuationsWebhook,
  deregisterValuationsWebhook,
} from './native_valuations_webhook';
import { UPDATE_NOT_FOUND, isHttp404 } from './not_found';
import { naturalName } from 'module-kit/adapter/name_resolution';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  isStablePosition,
  makeStablePosition,
  positionData,
  type SchemaEntryPoint,
  type SchemaReferenceDescriptor,
  type SchemaTypeDescriptor,
  type SourcePosition,
} from 'movement-engine/services/translation_graph/types';
import { writeParentLinks, type ParentLink, type ParentAssociation } from 'movement-engine/services/translation_graph/adapter';
import { logger } from 'movement-engine/services/logger';
import { getAutomationsQb } from '../../../lib/kysely';
import { apiBaseUrl } from '../../../lib/api_base_url';
import { describeError } from 'movement-engine/lib/utils/error';
import { decryptToken } from '../../../lib/credentials';

export const NATIVE_VALUATIONS_ADAPTER_TYPE = 'native-valuations';

/**
 * Stored shape of `external_service_credentials.credentials` for an
 * NATIVE_VALUATIONS integration. The adapter authenticates against the
 * Valuations REST API with a Bearer api-key whose id is also registered
 * in `platform_owned_token` (so loop suppression recognises our own writes
 * echoed back).
 *
 * Fields:
 * - `apiKey` — plaintext Bearer token sent on outbound REST calls. The
 *   `public.api_key` table stores only the hash for inbound auth lookups;
 *   the plaintext lives encrypted-at-rest here so the adapter can replay it.
 * - `apiKeyId` — id of the `api_key` row this token belongs to. Stored so
 *   delete + rotation can find and revoke the underlying row, and so
 *   platform_owned_token (which keys on the id, not the plaintext) can be
 *   unregistered cleanly. Optional for back-compat with manually-wired
 *   integrations (e.g. dev:valuations seed) that don't set it.
 * - `baseUrl` — optional override; defaults per-env when absent.
 */
export const nativeValuationsCredsParser = z.object({
  apiKey: z.string().min(1),
  apiKeyId: z.string().uuid().optional(),
  baseUrl: z.string().url().optional(),
});

// ── Entity catalog ────────────────────────────────────────────────────────
// Every Valuations entity that ships through the outbox / REST. Each has a
// table name (used in webhook event types and DB queries), a URL slug (kebab,
// pluralized) for the REST routes, and the pretty display name that IS its
// framework identity. The `EntityDescriptor` is itself the structured
// identifier the read/write logic routes on — recovered from a position's
// pretty type NAME via the name cache (`ENTITY_BY_DISPLAY_NAME`); the catalog
// is a compile-time constant, so there's no name↔id introspection gap to fetch.

interface EntityDescriptor {
  table: string;
  slug: string;
  displayName: string;
  /**
   * The entity's ROOT promise (rule 7 / rule 0): `'collection'` when
   * workspace-wide enumeration is the genuine surface (a root meta edge,
   * readable + writable); otherwise a REDIRECT — the record is only naturally
   * reached THROUGH its parents, so the entry publishes no root promises
   * (`readable: false, writable: false` — the type stays published for the
   * name resolver, `describe`, and event discrimination; its POSITION derives
   * from edge reachability). A read that still arrives at a retired root
   * fails LOUD with the redirect, never silently empty.
   */
  root: 'collection' | { redirect: string };
}

const ENTITIES: EntityDescriptor[] = [
  // The two anchors. Legal entities are THE workspace-wide surface; assets
  // keep a root because not every asset has a parent — a CURRENCY (cash)
  // asset has no issuer, so `legalEntity-[:Assets]->` cannot reach them all.
  { table: 'legal_entity', slug: 'legal-entities', displayName: 'Legal Entity', root: 'collection' },
  { table: 'asset', slug: 'assets', displayName: 'Asset', root: 'collection' },
  // Everything else navigates through its parents.
  {
    table: 'investment', slug: 'investments', displayName: 'Investment',
    root: {
      redirect:
        'Investments live under their legal entities — read `<legal entity>-[:Investments]->` ' +
        '(into the entity) or `<legal entity>-[:`Investments Made`]->` (by the entity).',
    },
  },
  {
    table: 'transaction', slug: 'transactions', displayName: 'Transaction',
    root: {
      redirect:
        'Transactions live under their investment — hop `<investment>-[:Transactions]->` ' +
        '(or `<event>-[:Transactions]->` for the transactions of a round).',
    },
  },
  {
    table: 'asset_transfer', slug: 'asset-transfers', displayName: 'Asset Transfer',
    root: {
      redirect:
        'Asset transfers live under their transaction or asset — hop ' +
        '`<transaction>-[:`Asset Transfers`]->` or `<asset>-[:Transfers]->` ' +
        '(or an entity\'s `Transfers In` / `Transfers Out`).',
    },
  },
  {
    table: 'price', slug: 'prices', displayName: 'Price',
    root: { redirect: 'Prices live under their asset — hop `<asset>-[:Prices]->`.' },
  },
  {
    table: 'event', slug: 'events', displayName: 'Event',
    root: { redirect: 'Events live under their legal entity — hop `<legal entity>-[:Events]->`.' },
  },
];

/** Name → structured identifier: the pretty display name (a position's
 *  `recordType` / entry `typeId`) → its `EntityDescriptor` (table + REST slug).
 *  The entity catalog is a set of compile-time constants — no introspection —
 *  so this is a plain map, not a fetched cache. */
const ENTITY_BY_DISPLAY_NAME: Record<string, EntityDescriptor> = Object.fromEntries(
  ENTITIES.map((e) => [e.displayName, e]),
);
const ENTITY_BY_TABLE: Record<string, EntityDescriptor> = Object.fromEntries(
  ENTITIES.map((e) => [e.table, e]),
);

// ── Schema descriptors ────────────────────────────────────────────────────
// Per-entity field/reference descriptors driving the editor + the engine's
// expression evaluator. Field shapes mirror the Valuations REST `createSchema`
// / `updateSchema` Zod definitions in interfaces/rest/v1/valuations/resources.ts.
// Enum values match the `kysely/public/<EnumName>` generated values
// exactly — adapter writes go through the REST surface, which validates
// uppercase enum strings.

function commonFields(): SchemaTypeDescriptor['fields'] {
  return [
    { fieldId: 'id', displayName: 'Id', kind: 'string', writable: false, required: true },
    { fieldId: 'created_at', displayName: 'Created At', kind: 'date', writable: false, required: false },
    { fieldId: 'updated_at', displayName: 'Updated At', kind: 'date', writable: false, required: false },
  ];
}

// The framework type identity IS the pretty display name now — descriptors
// stamp it as their `typeId` and reference each other's `targetTypeId` by it;
// the structured routing id (table + slug) lives only in `ENTITY_BY_DISPLAY_NAME`.
const LEGAL_ENTITY_TYPE = 'Legal Entity';
const INVESTMENT_TYPE = 'Investment';
const TRANSACTION_TYPE = 'Transaction';
const ASSET_TYPE = 'Asset';
const ASSET_TRANSFER_TYPE = 'Asset Transfer';
const PRICE_TYPE = 'Price';
const EVENT_TYPE = 'Event';
// The computed valuation type + its edge name. Declared here (before the entity
// descriptors) because LEGAL_ENTITY_DESCRIPTOR / INVESTMENT_DESCRIPTOR call
// `valuationsEdge()` at construction time, which reads these — declaring them
// later would be a temporal-dead-zone crash on module load. See the computed
// valuation node section below for the descriptor + edge.
const VALUATION_TYPE = 'Valuation';
const VALUATIONS_EDGE_FIELD_ID = 'valuations';

const LEGAL_ENTITY_TYPES = ['COMPANY', 'ESOP', 'FUND', 'NATURAL_PERSON', 'PORTFOLIO_COMPANY', 'SPV'];
const INVESTMENT_STATUSES = ['ACTIVE', 'REALISED', 'STEALTH'];
const COMPANY_LEGAL_STATUSES = ['ACTIVE', 'INACTIVE', 'DISSOLVED'];
const ASSET_TYPES = [
  'CONVERTIBLE', 'CURRENCY', 'EMPLOYEE_STOCK_OPTIONS', 'EQUITY', 'EQUITY_UNKNOWN_SHARES',
  'LP_INTEREST_POINT', 'SPV_INTEREST_POINT', 'UNKNOWN', 'FUND_OUTSTANDING_COMMITMENT',
  'ACCRUED_INCOME',
];
const CONVERTIBLE_TYPES = [
  'ASA', 'BSA_AIR', 'CONVERTIBLE_NOTE', 'LOAN', 'POST_MONEY_SAFE', 'PRE_MONEY_SAFE',
  'SAFT', 'SEEDFAST', 'SEEDNOTE', 'SLIP',
];
const CURRENCIES = ['CHF', 'EUR', 'GBP', 'NOK', 'SEK', 'USD', 'DKK'];
const PRICE_TYPES = ['FROM_PRICED_ROUND', 'FROM_ASSET_HOLDER', 'CONVERSION'];
const EVENT_TYPES = [
  'FOUNDER_EQUITY_SPLIT', 'INVESTMENT_ROUND', 'SHARE_SPLIT', 'SHARE_REVERSE_SPLIT',
  'SECONDARY_SALE', 'DISTRIBUTION', 'DIVIDEND', 'MARKDOWN', 'FUND_DISTRIBUTION',
  'FUND_CLOSE', 'SHARE_PRICE', 'LIQUIDATION',
];
const VALUATION_TYPES = ['PRE_MONEY', 'POST_MONEY'];
const EQUITY_ROUND_TYPES = [
  'PRE_PRE_SEED', 'PRE_SEED', 'SEED', 'SEED_EXT', 'SERIES_A', 'SERIES_A_EXT',
  'SERIES_B', 'SERIES_B_EXT', 'SERIES_C', 'SERIES_C_EXT', 'SERIES_D', 'SERIES_E',
  'SERIES_F', 'SERIES_G', 'SERIES_H', 'SERIES_I', 'SERIES_J', 'UNKNOWN',
];
const INVESTMENT_ROUND_TYPES = ['EQUITY', 'CONVERTIBLE', 'OTHER'];
const INVESTMENT_TYPES_VALUES = ['CASH', 'EQUITY_TRANSFER'];

// ── Parent-first navigation (rule 7) ──────────────────────────────────────
// The natural surface: deep records are reached THROUGH their parents, not
// enumerated by id at the root. Each down-edge below is one declaration that
// drives all three mechanics at once:
//
//   - the parent descriptor's reference (name, target, `creatable`),
//   - the scoped READ (GET /valuations/<child slug>?<childFk>=<parent id> —
//     the REST list filters already speak the child's FK column), and
//   - the WRITE currency: a parent link naming this edge injects the parent's
//     id into the child create body as `childFk` (an N-parent create carries
//     one link per required edge — the tuple-path write form).
//
// `childFk` is the FK column on the CHILD — also exactly the REST list query
// param, so there is no separate mapping to drift.
interface DownEdgeDescriptor {
  /** Parent typeId (== its display name). */
  parent: string;
  /** The edge's id on the parent descriptor. */
  fieldId: string;
  /** The natural edge name authors write. */
  name: string;
  /** Child typeId. */
  target: string;
  /** FK column on the child == the REST list query param. */
  childFk: string;
  /**
   * The edge's WRITE promise (layer 13: absent on the projected reference ⇒
   * read-only). `true` is licensed by exactly one code path — `injectParentLink`,
   * which resolves a `ParentLink` to a down-edge and stamps `childFk` onto the
   * create body. That path matches ONLY this table, which is why the down-edges
   * are the adapter's entire writable-edge surface: every other reference is the
   * CHILD-side view of the same relationship (`Investor` is `Investments Made`
   * seen from the investment), a derived cross-reference, or the computed
   * `Valuations` edge — and nothing writes from that side. There is no
   * `linkRecords` here either, so a free-standing link has no path at all.
   */
  writable: boolean;
  /**
   * What this edge's members are inherently ordered BY. Every down-edge read
   * goes through the REST list route, whose handler unconditionally applies
   * `ORDER BY <the resource's defaultSort> DESC` (`v1/valuations/crud.ts`) —
   * and `readDownEdge` never passes `sort`/`order`, so it always gets that
   * default. Which SORT COLUMN the resource declares is what decides the value
   * here: a domain date is `chronological`, a bare `created_at` is only the
   * order the rows were INSERTED, which is `arrival`.
   *
   * Keep this in step with `v1/valuations/resources.ts`'s `defaultSort`.
   */
  sequenced: EdgeSequencing;
  description: string;
}

const DOWN_EDGES: DownEdgeDescriptor[] = [
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'events', name: 'Events',
    target: EVENT_TYPE, childFk: 'legal_entity_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'Company events (rounds, splits, distributions, …) belonging to this entity.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'investments', name: 'Investments',
    target: INVESTMENT_TYPE, childFk: 'investment_profile_id', writable: true,
    // resources.ts defaultSort: 'created_at' — insert order, NOT `invested_at`.
    sequenced: 'arrival',
    description: 'Investments INTO this entity (it is the investee). A create injects this entity as the investee; pair with an `Investments Made` path for the investor.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'investments_made', name: 'Investments Made',
    target: INVESTMENT_TYPE, childFk: 'investor_profile_id', writable: true,
    // resources.ts defaultSort: 'created_at' — insert order, NOT `invested_at`.
    sequenced: 'arrival',
    description: 'Investments BY this entity (it is the investor). A create injects this entity as the investor; pair with an `Investments` path for the investee.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'assets', name: 'Assets',
    target: ASSET_TYPE, childFk: 'issued_by_legal_entity_id', writable: true,
    // resources.ts defaultSort: 'created_at' — insert order.
    sequenced: 'arrival',
    description: 'Assets issued by this entity (share classes, convertibles, options).',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'transfers_out', name: 'Transfers Out',
    target: ASSET_TRANSFER_TYPE, childFk: 'from_legal_entity_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'Asset transfers FROM this entity (disposals). A create injects this entity as the transferor.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'transfers_in', name: 'Transfers In',
    target: ASSET_TRANSFER_TYPE, childFk: 'to_legal_entity_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'Asset transfers TO this entity (acquisitions). A create injects this entity as the transferee.',
  },
  {
    parent: INVESTMENT_TYPE, fieldId: 'transactions', name: 'Transactions',
    target: TRANSACTION_TYPE, childFk: 'investment_id', writable: true,
    // resources.ts defaultSort: 'close_date'.
    sequenced: 'chronological',
    description: 'The money movements of this investment.',
  },
  {
    parent: EVENT_TYPE, fieldId: 'transactions', name: 'Transactions',
    target: TRANSACTION_TYPE, childFk: 'event_id', writable: true,
    // resources.ts defaultSort: 'close_date'.
    sequenced: 'chronological',
    description: 'Transactions that closed as part of this event.',
  },
  {
    parent: TRANSACTION_TYPE, fieldId: 'asset_transfers', name: 'Asset Transfers',
    target: ASSET_TRANSFER_TYPE, childFk: 'transaction_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'The asset legs of this transaction — which assets moved, from whom, to whom.',
  },
  {
    parent: ASSET_TYPE, fieldId: 'transfers', name: 'Transfers',
    target: ASSET_TRANSFER_TYPE, childFk: 'asset_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'The transfer history of this asset.',
  },
  {
    parent: ASSET_TYPE, fieldId: 'prices', name: 'Prices',
    target: PRICE_TYPE, childFk: 'asset_id', writable: true,
    // resources.ts defaultSort: 'date'.
    sequenced: 'chronological',
    description: 'Prices of this asset over time.',
  },
];

/** (parent typeId, edge fieldId) → the down-edge — the READ resolution
 *  (`getRelated` sees the resolved reference fieldId). */
const DOWN_EDGE_BY_PARENT_FIELD = new Map<string, DownEdgeDescriptor>(
  DOWN_EDGES.map((e) => [`${e.parent} ${e.fieldId}`, e]),
);

/** The parent type's down-edge references, spliced into its descriptor. */
function downEdgeRefs(parent: string): SchemaReferenceDescriptor[] {
  return DOWN_EDGES.filter((e) => e.parent === parent).map((e) => ({
    fieldId: e.fieldId,
    targetTypeId: e.target,
    cardinality: 'many' as const,
    direction: 'outgoing' as const,
    name: e.name,
    description: e.description,
    ...(e.writable ? { writable: true } : {}),
    sequenced: e.sequenced,
    // No column on the PARENT backs a down-edge (the FK lives on the child),
    // so a parent-record change never affects it — same as `Valuations`.
    backingFields: [],
  }));
}

// ── Command edges (imperative actions) ────────────────────────────────────
// An action a movement TAKES on a parent, not a record it creates directly —
// writing along it POSTs to a REST *command* endpoint (a monolithic
// operation with its own side effects), not a plain entity create. Parallel
// to DOWN_EDGES; matched by `createRecord`'s command branch.
//
// A command's descriptor (path/fieldMap/result id) is split from its
// PARENT edges: AddMarkdown takes one parent (the company), AddInvestment
// takes two — the investee (role `entity`, via an `AddInvestment` edge) and
// the fund (role `investingEntity`, via an `Investor` edge), both off Legal
// Entity. `createCommandRecord` gathers every COMMAND_EDGES row matching the
// command's target and requires a parent link for each.
const ADD_MARKDOWN_TYPE = 'AddMarkdown';
const ADD_INVESTMENT_TYPE = 'AddInvestment';
const ADD_PRICE_TYPE = 'AddPrice';
const ADD_ROUND_TYPE = 'AddRound';
const ADD_WIND_DOWN_TYPE = 'AddWindDown';
const ADD_SHARE_SPLIT_TYPE = 'AddShareSplit';
const ADD_DIVIDENDS_TYPE = 'AddDividends';
const ADD_FUND_DISTRIBUTION_TYPE = 'AddFundDistribution';
const ADD_FUND_DRAWDOWN_TYPE = 'AddFundDrawdown';

interface CommandDescriptor {
  target: string;      // the command node typeId
  commandPath: string; // REST path segment under /valuations/commands/
  /** action field DISPLAY name → REST body key */
  fieldMap: Record<string, string>;
  /** the response field whose value becomes the write's externalId (the
   *  command's "own id" — the primary record it created) */
  resultId: string;
}

interface CommandEdgeDescriptor {
  parent: string;     // parent typeId (== display name)
  fieldId: string;    // edge id on the parent descriptor
  name: string;       // the natural role/action name authors write
  target: string;      // the command node typeId
  parentRole: string; // REST body key this parent's id maps to
  description: string;
}

const COMMANDS: CommandDescriptor[] = [
  {
    target: ADD_MARKDOWN_TYPE, commandPath: 'add-markdown',
    fieldMap: { Date: 'date', Percentage: 'percentage', Note: 'note' },
    resultId: 'eventId',
  },
  {
    target: ADD_INVESTMENT_TYPE, commandPath: 'add-investment',
    fieldMap: {
      Date: 'investmentDate', Amount: 'investmentAmount', Currency: 'investmentCurrency',
      Type: 'investmentType', 'Round Name': 'roundName',
      'Price Per Share': 'pricePerShare', 'Number Of Shares': 'numberOfShares',
      'Share Class': 'shareClass', Valuation: 'valuationAmount',
      'Valuation Type': 'valuationType', 'Total Raised': 'totalRaisedAmount',
    },
    resultId: 'investmentId',
  },
  {
    target: ADD_PRICE_TYPE, commandPath: 'add-price',
    fieldMap: { Price: 'price', Currency: 'currency', Date: 'date', Note: 'note' },
    resultId: 'priceId',
  },
  {
    target: ADD_ROUND_TYPE, commandPath: 'add-round',
    fieldMap: {
      'Round Name': 'roundName', Date: 'date', Currency: 'currency',
      'Price Per Share': 'pricePerShare', Valuation: 'valuationAmount',
      'Valuation Type': 'valuationType', 'Total Raised': 'totalRaisedAmount',
    },
    resultId: 'eventId',
  },
  {
    target: ADD_WIND_DOWN_TYPE, commandPath: 'add-wind-down',
    fieldMap: { Date: 'date' },
    resultId: 'eventId',
  },
  {
    target: ADD_SHARE_SPLIT_TYPE, commandPath: 'add-share-split',
    fieldMap: { Date: 'date', Multiple: 'multiple' },
    resultId: 'eventId',
  },
  {
    target: ADD_DIVIDENDS_TYPE, commandPath: 'add-dividends',
    fieldMap: { Date: 'date', Amount: 'amount', Currency: 'currency' },
    resultId: 'eventId',
  },
  {
    target: ADD_FUND_DISTRIBUTION_TYPE, commandPath: 'add-fund-distribution',
    fieldMap: { Date: 'date', Amount: 'amount', Currency: 'currency' },
    resultId: 'eventId',
  },
  {
    target: ADD_FUND_DRAWDOWN_TYPE, commandPath: 'add-fund-drawdown',
    fieldMap: { Date: 'date', Amount: 'drawdownAmount', 'Commitment Price': 'price', Currency: 'currency' },
    resultId: 'transactionId',
  },
];

const COMMAND_EDGES: CommandEdgeDescriptor[] = [
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_markdown', name: ADD_MARKDOWN_TYPE,
    target: ADD_MARKDOWN_TYPE, parentRole: 'companyId',
    description: 'Record a markdown on this company — writes the markdown event and the derived holding prices.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_investment', name: ADD_INVESTMENT_TYPE,
    target: ADD_INVESTMENT_TYPE, parentRole: 'entity',
    description: 'Record an investment INTO this company (it is the investee). Pair with an `Investor` path for the fund.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_investment_investor', name: 'Investor',
    target: ADD_INVESTMENT_TYPE, parentRole: 'investingEntity',
    description: 'The fund making the investment (the investor). Pair with an `AddInvestment` path for the investee.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_price', name: ADD_PRICE_TYPE,
    target: ADD_PRICE_TYPE, parentRole: 'companyId',
    description: 'Record a price point for this company.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_round', name: ADD_ROUND_TYPE,
    target: ADD_ROUND_TYPE, parentRole: 'entity',
    description: 'Record a funding round for this company.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_wind_down', name: ADD_WIND_DOWN_TYPE,
    target: ADD_WIND_DOWN_TYPE, parentRole: 'companyId',
    description: 'Wind down this company — marks its holdings to zero and dissolves it.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_share_split', name: ADD_SHARE_SPLIT_TYPE,
    target: ADD_SHARE_SPLIT_TYPE, parentRole: 'companyId',
    description: 'Record a share split for this company — splits every holding by the multiple.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_dividends', name: ADD_DIVIDENDS_TYPE,
    target: ADD_DIVIDENDS_TYPE, parentRole: 'companyId',
    description: 'Pay a dividend from this company. Pair with a `Recipient` path for the fund.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_dividends_recipient', name: 'Recipient',
    target: ADD_DIVIDENDS_TYPE, parentRole: 'fundId',
    description: 'The fund receiving the dividend.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_fund_distribution', name: ADD_FUND_DISTRIBUTION_TYPE,
    target: ADD_FUND_DISTRIBUTION_TYPE, parentRole: 'companyId',
    description: 'Distribute from this fund. Pair with a `Distribution Recipient` path for the investor.',
  },
  {
    // Role-edge names off Legal Entity must be GLOBALLY UNIQUE — the built
    // position keys edges by NAME, so a second `Recipient` (AddDividends already
    // has one) would collide and shadow. Hence the qualified name.
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_fund_distribution_recipient', name: 'Distribution Recipient',
    target: ADD_FUND_DISTRIBUTION_TYPE, parentRole: 'fundId',
    description: 'The investor receiving the distribution.',
  },
  {
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_fund_drawdown', name: ADD_FUND_DRAWDOWN_TYPE,
    target: ADD_FUND_DRAWDOWN_TYPE, parentRole: 'fundId',
    description: 'Record a drawdown by this fund.',
  },
  {
    // Role-edge names off Legal Entity must be GLOBALLY UNIQUE — the built
    // position keys edges by NAME. `Commitment Investor` is distinct from
    // AddDividends' `Recipient` and AddFundDistribution's
    // `Distribution Recipient`.
    parent: LEGAL_ENTITY_TYPE, fieldId: 'add_fund_drawdown_investor', name: 'Commitment Investor',
    target: ADD_FUND_DRAWDOWN_TYPE, parentRole: 'investorId',
    description: 'The investor whose outstanding commitment is drawn down.',
  },
  {
    // The FIRST command edge off a non-Legal-Entity parent — spliced onto
    // ASSET_DESCRIPTOR via `commandEdgeRefs(ASSET_TYPE)` below.
    parent: ASSET_TYPE, fieldId: 'add_fund_drawdown_asset', name: 'Commitment Asset',
    target: ADD_FUND_DRAWDOWN_TYPE, parentRole: 'assetId',
    description: 'The outstanding-commitment asset being drawn down.',
  },
];

const COMMAND_BY_TARGET = new Map<string, CommandDescriptor>(COMMANDS.map((c) => [c.target, c]));

/** The parent type's command-edge references (writable), spliced into its
 *  descriptor alongside downEdgeRefs. */
function commandEdgeRefs(parent: string): SchemaReferenceDescriptor[] {
  return COMMAND_EDGES.filter((c) => c.parent === parent).map((c) => ({
    fieldId: c.fieldId,
    targetTypeId: c.target,
    cardinality: 'many' as const,
    direction: 'outgoing' as const,
    name: c.name,
    description: c.description,
    writable: true,
    backingFields: [],
  }));
}

const LEGAL_ENTITY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: LEGAL_ENTITY_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Legal Entity',
  // `FUZZY` on a name shortlists by similarity (the list route's `search`,
  // whose search vector covers exactly these four) and leaves the call to the
  // engine's judge; see `resolveEntity`. Any other field is exact-only.
  supportsFuzzyResolution: ['name', 'legal_name', 'also_known_as', 'other_names'],
  fields: [
    ...commonFields(),
    { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: true, required: true, enumValues: LEGAL_ENTITY_TYPES },
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'legal_name', displayName: 'Legal Name', kind: 'string', writable: true, required: false },
    { fieldId: 'also_known_as', displayName: 'Also Known As', kind: 'string', writable: true, required: false },
    { fieldId: 'email', displayName: 'Email', kind: 'string', writable: true, required: false },
    { fieldId: 'personal_website', displayName: 'Website', kind: 'string', writable: true, required: false },
    { fieldId: 'linkedin', displayName: 'LinkedIn', kind: 'string', writable: true, required: false },
    { fieldId: 'image_url', displayName: 'Image URL', kind: 'string', writable: true, required: false },
    { fieldId: 'slug', displayName: 'Slug', kind: 'string', writable: true, required: false },
    { fieldId: 'description', displayName: 'Description', kind: 'string', writable: true, required: false },
    { fieldId: 'short_description', displayName: 'Short Description', kind: 'string', writable: true, required: false },
    { fieldId: 'city', displayName: 'City', kind: 'string', writable: true, required: false },
    { fieldId: 'country', displayName: 'Country', kind: 'string', writable: true, required: false },
    { fieldId: 'other_names', displayName: 'Other Names', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'themes', displayName: 'Themes', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'sectors', displayName: 'Sectors', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'markets', displayName: 'Markets', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'customers', displayName: 'Customers', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'business_model', displayName: 'Business Model', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'locations', displayName: 'Locations', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'stages', displayName: 'Stages', kind: 'string', cardinality: 'many', writable: true, required: false },
    { fieldId: 'is_portfolio', displayName: 'Is Portfolio', kind: 'boolean', writable: true, required: false },
    { fieldId: 'is_own_investing_entity', displayName: 'Is Own Investing Entity', kind: 'boolean', writable: true, required: false },
    { fieldId: 'investment_status', displayName: 'Investment Status', kind: 'enum', writable: true, required: false, enumValues: INVESTMENT_STATUSES },
    { fieldId: 'legal_status', displayName: 'Legal Status', kind: 'enum', writable: true, required: false, enumValues: COMPANY_LEGAL_STATUSES },
  ],
  references: [
    { fieldId: 'investing_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Investing Entity' },
    { fieldId: 'underlying_company_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Underlying Company' },
    { fieldId: 'acquired_by_legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Acquired By' },
    // Parent-first navigation: this entity's events, investments (both
    // directions), issued assets and transfer legs hang off it.
    ...downEdgeRefs(LEGAL_ENTITY_TYPE),
    ...commandEdgeRefs(LEGAL_ENTITY_TYPE),
    // Computed: value of this company to its investors, as of a date/currency.
    valuationsEdge(),
  ],
};

const INVESTMENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: INVESTMENT_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Investment',
  fields: [
    ...commonFields(),
    { fieldId: 'round_type', displayName: 'Round Type', kind: 'enum', writable: true, required: false, enumValues: EQUITY_ROUND_TYPES },
    { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: true, required: false, enumValues: INVESTMENT_TYPES_VALUES },
    { fieldId: 'invested_at', displayName: 'Invested At', kind: 'date', writable: true, required: false },
    { fieldId: 'verified', displayName: 'Verified', kind: 'boolean', writable: true, required: false },
    { fieldId: 'fully_exited_at', displayName: 'Fully Exited At', kind: 'date', writable: true, required: false },
  ],
  references: [
    // Both profiles are REQUIRED on create — an investment exists only at the
    // convergence of an investor and an investee, so a create is the tuple
    // write `(investee-[:Investments]->, investor-[:`Investments Made`]->)`.
    { fieldId: 'investor_profile_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Investor', required: true },
    { fieldId: 'investment_profile_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Investee', required: true },
    { fieldId: 'event_id', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event' },
    { fieldId: 'exit_event_id', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Exit Event' },
    ...downEdgeRefs(INVESTMENT_TYPE),
    // Computed: value of this single investment, as of a date/currency.
    valuationsEdge(),
  ],
};

const TRANSACTION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: TRANSACTION_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Transaction',
  fields: [
    ...commonFields(),
    { fieldId: 'close_date', displayName: 'Close Date', kind: 'date', writable: true, required: true },
  ],
  references: [
    { fieldId: 'investment_id', targetTypeId: INVESTMENT_TYPE, cardinality: 'one', name: 'Investment' },
    { fieldId: 'event_id', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event' },
    { fieldId: 'converted_to_id', targetTypeId: TRANSACTION_TYPE, cardinality: 'one', name: 'Converted To' },
    { fieldId: 'due_to_rights_from_asset_id', targetTypeId: ASSET_TYPE, cardinality: 'one', name: 'Due To Rights From Asset' },
    ...downEdgeRefs(TRANSACTION_TYPE),
  ],
};

const ASSET_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ASSET_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Asset',
  fields: [
    ...commonFields(),
    { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: true, required: true, enumValues: ASSET_TYPES },
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'convertible_type', displayName: 'Convertible Type', kind: 'enum', writable: true, required: false, enumValues: CONVERTIBLE_TYPES },
    { fieldId: 'convertible_amount', displayName: 'Convertible Amount', kind: 'number', writable: true, required: false },
    { fieldId: 'convertible_currency', displayName: 'Convertible Currency', kind: 'enum', writable: true, required: false, enumValues: CURRENCIES },
    { fieldId: 'valuation_cap', displayName: 'Valuation Cap', kind: 'number', writable: true, required: false },
    { fieldId: 'discount_rate', displayName: 'Discount Rate', kind: 'number', writable: true, required: false },
    { fieldId: 'interest', displayName: 'Interest', kind: 'number', writable: true, required: false },
    { fieldId: 'annualised_interest_rate', displayName: 'Annualised Interest Rate', kind: 'number', writable: true, required: false },
    { fieldId: 'maturity_date', displayName: 'Maturity Date', kind: 'date', writable: true, required: false },
    { fieldId: 'conversion_date', displayName: 'Conversion Date', kind: 'date', writable: true, required: false },
    { fieldId: 'conversion_price', displayName: 'Conversion Price', kind: 'number', writable: true, required: false },
    // A free-form bag of asset properties — genuinely structured, so an author
    // assembles it with an object literal (`Properties: { tranche: 2 }`) and it
    // rides through verbatim.
    { fieldId: 'properties', displayName: 'Properties', kind: 'json', writable: true, required: false },
  ],
  references: [
    { fieldId: 'issued_by_legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Issuer' },
    { fieldId: 'convertible_investor_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Convertible Investor' },
    ...downEdgeRefs(ASSET_TYPE),
    // The FIRST non-Legal-Entity command edge (AddFundDrawdown's
    // `Commitment Asset` role) — same mechanism as Legal Entity's
    // commandEdgeRefs above, just filtered to this parent type.
    ...commandEdgeRefs(ASSET_TYPE),
  ],
};

const ASSET_TRANSFER_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ASSET_TRANSFER_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Asset Transfer',
  fields: [
    ...commonFields(),
    { fieldId: 'date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'num_assets', displayName: 'Num Assets', kind: 'number', writable: true, required: false },
  ],
  references: [
    // ALL four parents are REQUIRED on create — a transfer is one asset's leg
    // of one transaction between two entities: the 4-parent tuple write
    // `(txn-[:`Asset Transfers`]->, asset-[:Transfers]->,
    //   seller-[:`Transfers Out`]->, buyer-[:`Transfers In`]->)`.
    { fieldId: 'asset_id', targetTypeId: ASSET_TYPE, cardinality: 'one', name: 'Asset', required: true },
    { fieldId: 'transaction_id', targetTypeId: TRANSACTION_TYPE, cardinality: 'one', name: 'Transaction', required: true },
    { fieldId: 'from_legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'From', required: true },
    { fieldId: 'to_legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'To', required: true },
  ],
};

const PRICE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: PRICE_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Price',
  fields: [
    ...commonFields(),
    { fieldId: 'date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'price', displayName: 'Price', kind: 'number', writable: true, required: true },
    { fieldId: 'currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
    { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: true, required: false, enumValues: PRICE_TYPES },
  ],
  references: [
    // The asset is a price's one REQUIRED parent (rule 0's single-parent
    // test): prices are reached and created through `asset-[:Prices]->`.
    { fieldId: 'asset_id', targetTypeId: ASSET_TYPE, cardinality: 'one', name: 'Asset', required: true },
    { fieldId: 'legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Legal Entity' },
    { fieldId: 'event_id', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event' },
  ],
};

const EVENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: EVENT_TYPE,
  // An entity: `deleteRecord` removes it through the REST surface.
  deletable: true,
  displayName: 'Event',
  fields: [
    ...commonFields(),
    { fieldId: 'date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'type', displayName: 'Type', kind: 'enum', writable: true, required: true, enumValues: EVENT_TYPES },
    { fieldId: 'name', displayName: 'Name', kind: 'string', writable: true, required: false },
    { fieldId: 'raised_amount', displayName: 'Raised Amount', kind: 'number', writable: true, required: false },
    { fieldId: 'raised_currency', displayName: 'Raised Currency', kind: 'enum', writable: true, required: false, enumValues: CURRENCIES },
    { fieldId: 'valuation', displayName: 'Valuation', kind: 'number', writable: true, required: false },
    { fieldId: 'valuation_currency', displayName: 'Valuation Currency', kind: 'enum', writable: true, required: false, enumValues: CURRENCIES },
    { fieldId: 'valuation_type', displayName: 'Valuation Type', kind: 'enum', writable: true, required: false, enumValues: VALUATION_TYPES },
    { fieldId: 'round_type', displayName: 'Round Type', kind: 'enum', writable: true, required: false, enumValues: EQUITY_ROUND_TYPES },
    { fieldId: 'investment_round_type', displayName: 'Investment Round Type', kind: 'enum', writable: true, required: false, enumValues: INVESTMENT_ROUND_TYPES },
  ],
  references: [
    // The legal entity is an event's one REQUIRED parent: events are reached
    // and created through `legalEntity-[:Events]->`.
    { fieldId: 'legal_entity_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Legal Entity', required: true },
    { fieldId: 'acquirer_id', targetTypeId: LEGAL_ENTITY_TYPE, cardinality: 'one', name: 'Acquirer' },
    ...downEdgeRefs(EVENT_TYPE),
  ],
};

// ── Command node (AddMarkdown) ─────────────────────────────────────────────
// The action's writable input shape, plus its two READ-ONLY receipt edges.
// NO `commonFields()` — a command is not a CRUD record, it has no
// id/created_at. `fieldId === displayName` — commands bypass the field
// resolver; `COMMAND_EDGES[].fieldMap` above does the REST body mapping.
// `Event`/`Prices` carry NO `writable` — they are read-only receipts resolved
// in `getRelated` from the write's own result data (Layer 4), not columns on
// a stored record. `fieldId === name` (capitalized) so there is no
// natural-name↔fieldId translation ambiguity on the read path.
const ADD_MARKDOWN_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_MARKDOWN_TYPE,
  displayName: ADD_MARKDOWN_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Percentage', displayName: 'Percentage', kind: 'number', writable: true, required: true },
    { fieldId: 'Note', displayName: 'Note', kind: 'string', writable: true, required: false },
  ],
  references: [
    {
      fieldId: 'Event', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event',
      description: 'The markdown event this action created.', backingFields: [],
    },
    {
      fieldId: 'Prices', targetTypeId: PRICE_TYPE, cardinality: 'many', name: 'Prices',
      description: 'The holding prices this markdown derived.', backingFields: [],
    },
  ],
};

// ── Command node (AddInvestment) ───────────────────────────────────────────
// The writable input shape PLUS the three read-only receipt edges
// (Investment/Round/Transaction), resolved in `getRelated` from the write's
// own result data (Layer 4) — mirrors AddMarkdown's `Event`/`Prices` above:
// `fieldId === name` (capitalized), NO `writable`, no FK column backing them.
// Amounts are `string` in the REST/service schema (`applyInvestmentInput`:
// `investmentAmount`/`pricePerShare`/`numberOfShares`/`valuationAmount`/
// `totalRaisedAmount` are `z.string()`), so those fields are declared
// `kind: 'string'` — the author writes strings, the fieldMap renames with NO
// coercion.
const ADD_INVESTMENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_INVESTMENT_TYPE,
  displayName: ADD_INVESTMENT_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Amount', displayName: 'Amount', kind: 'string', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
    { fieldId: 'Type', displayName: 'Type', kind: 'enum', writable: true, required: false, enumValues: ['EQUITY', 'CONVERTIBLE', 'SPV', 'SECONDARY'] },
    { fieldId: 'Round Name', displayName: 'Round Name', kind: 'string', writable: true, required: false },
    { fieldId: 'Price Per Share', displayName: 'Price Per Share', kind: 'string', writable: true, required: false },
    { fieldId: 'Number Of Shares', displayName: 'Number Of Shares', kind: 'string', writable: true, required: false },
    { fieldId: 'Share Class', displayName: 'Share Class', kind: 'string', writable: true, required: false },
    { fieldId: 'Valuation', displayName: 'Valuation', kind: 'string', writable: true, required: false },
    { fieldId: 'Valuation Type', displayName: 'Valuation Type', kind: 'enum', writable: true, required: false, enumValues: VALUATION_TYPES },
    { fieldId: 'Total Raised', displayName: 'Total Raised', kind: 'string', writable: true, required: false },
  ],
  references: [
    {
      fieldId: 'Investment', targetTypeId: INVESTMENT_TYPE, cardinality: 'one', name: 'Investment',
      description: 'The investment this action recorded.', backingFields: [],
    },
    {
      fieldId: 'Round', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Round',
      description: 'The funding round event, if a round name was given.', backingFields: [],
    },
    {
      fieldId: 'Transaction', targetTypeId: TRANSACTION_TYPE, cardinality: 'one', name: 'Transaction',
      description: 'The transaction this investment created.', backingFields: [],
    },
  ],
};

// ── Command node (AddPrice) ────────────────────────────────────────────────
// Single-parent, company-level only (the tab's optional `assetId` is
// deferred — the adapter node exposes no asset parent). NO receipt edge this
// cut — the write-result `externalId` (the price id, `resultId: 'priceId'`)
// is enough to reference the created row, so `references: []`. (A `Price`
// receipt edge would also collide with the `Price` input field name —
// resolve when added.) `fieldId === displayName`, no `writable` on a
// receipt because there isn't one — mirrors AddMarkdown/AddInvestment above.
const ADD_PRICE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_PRICE_TYPE,
  displayName: ADD_PRICE_TYPE,
  fields: [
    { fieldId: 'Price', displayName: 'Price', kind: 'number', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: false },
    { fieldId: 'Note', displayName: 'Note', kind: 'string', writable: true, required: false },
  ],
  references: [],
};

// ── Command node (AddRound) ────────────────────────────────────────────────
// Single-parent, company-level only — mirrors ADD_PRICE_DESCRIPTOR's shape
// but WITH a receipt: `applyRound`'s `{ eventId, priceId }` (Round/Price)
// rides the stable position's data (Layer 4), same as AddMarkdown/
// AddInvestment above. `fieldId === displayName`, NO `writable` on the
// receipt refs, no FK column backing them. Amounts are `string` in the REST
// schema (`applyRoundInput`: `pricePerShare`/`valuationAmount`/
// `totalRaisedAmount` are `z.string()`), so those fields are `kind: 'string'`
// — the author writes strings, the fieldMap renames with NO coercion.
const ADD_ROUND_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_ROUND_TYPE,
  displayName: ADD_ROUND_TYPE,
  fields: [
    { fieldId: 'Round Name', displayName: 'Round Name', kind: 'string', writable: true, required: true },
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: false, enumValues: CURRENCIES },
    { fieldId: 'Price Per Share', displayName: 'Price Per Share', kind: 'string', writable: true, required: false },
    { fieldId: 'Valuation', displayName: 'Valuation', kind: 'string', writable: true, required: false },
    { fieldId: 'Valuation Type', displayName: 'Valuation Type', kind: 'enum', writable: true, required: false, enumValues: VALUATION_TYPES },
    { fieldId: 'Total Raised', displayName: 'Total Raised', kind: 'string', writable: true, required: false },
  ],
  references: [
    {
      fieldId: 'Round', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Round',
      description: 'The round event this action recorded.', backingFields: [],
    },
    {
      fieldId: 'Price', targetTypeId: PRICE_TYPE, cardinality: 'one', name: 'Price',
      description: 'The round price, if a price per share was given.', backingFields: [],
    },
  ],
};

// ── Command node (AddWindDown) ─────────────────────────────────────────────
// Single-parent, ONE field — a design call: wind-down is a single
// write off the Legal Entity carrying just `Date`; its essence is "this
// company wound down". `applyWindDown` marks every EXISTING holding to zero
// and sets the company DISSOLVED itself (no per-row input) — the tab's
// per-investor `transactions[]` payouts are dropped from this surface (kept
// optional in the service for tab parity only; the adapter never sends
// them). Receipt is `Event` ONLY — the derived markdown prices get no
// receipt edge this cut (deferred, same reasoning as AddPrice above).
// `fieldId === displayName`, NO `writable` on the receipt ref, no FK column
// backing it.
const ADD_WIND_DOWN_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_WIND_DOWN_TYPE,
  displayName: ADD_WIND_DOWN_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
  ],
  references: [
    {
      fieldId: 'Event', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event',
      description: 'The wind-down event this action recorded.', backingFields: [],
    },
  ],
};

// ── Command node (AddShareSplit) ───────────────────────────────────────────
// Single-parent, two fields — mirrors ADD_WIND_DOWN_DESCRIPTOR's shape:
// a single write off the Legal Entity, fanning out over EXISTING equity
// holdings (no per-row input, no NEW entities). `applyShareSplit` splits
// every existing equity holder's position by `Multiple` and derives the new
// company price from the latest priced round. Receipt is `Event` ONLY —
// the split asset/price get no receipt edge this cut (deferred, same
// reasoning as AddPrice/AddWindDown above). `fieldId === displayName`, NO
// `writable` on the receipt ref, no FK column backing it.
const ADD_SHARE_SPLIT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_SHARE_SPLIT_TYPE,
  displayName: ADD_SHARE_SPLIT_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Multiple', displayName: 'Multiple', kind: 'number', writable: true, required: true },
  ],
  references: [
    {
      fieldId: 'Event', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event',
      description: 'The share-split event this action recorded.', backingFields: [],
    },
  ],
};

// ── Command node (AddDividends) ────────────────────────────────────────────
// Two-parent, like AddInvestment above: the paying company (role `companyId`,
// via an `AddDividends` edge) and the receiving fund (role `fundId`, via a
// `Recipient` edge), both off Legal Entity. Three fields — mirrors
// ADD_PRICE_DESCRIPTOR's shape but WITH a receipt: `applyDividends`'s
// `{ eventId }` rides the stable position's data (Layer 4), same as
// AddWindDown/AddShareSplit above. `fieldId === displayName`, NO `writable`
// on the receipt ref, no FK column backing it.
const ADD_DIVIDENDS_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_DIVIDENDS_TYPE,
  displayName: ADD_DIVIDENDS_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Amount', displayName: 'Amount', kind: 'number', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
  ],
  references: [
    {
      fieldId: 'Event', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event',
      description: 'The dividend event this action recorded.', backingFields: [],
    },
  ],
};

// ── Command node (AddFundDistribution) ─────────────────────────────────────
// Two-parent, like AddDividends above: the distributing fund (role
// `companyId`, via an `AddFundDistribution` edge) and the receiving investor
// (role `fundId`, via a `Distribution Recipient` edge), both off Legal Entity. Same three
// fields and Event-only receipt shape as AddDividends — `applyFundDistribution`
// delegates its writes to the existing `addFundDistribution` lib helper
// (`lib/import/distributions.ts`) rather than re-implementing them, but the
// adapter surface is identical. `fieldId === displayName`, NO `writable` on
// the receipt ref, no FK column backing it.
const ADD_FUND_DISTRIBUTION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_FUND_DISTRIBUTION_TYPE,
  displayName: ADD_FUND_DISTRIBUTION_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Amount', displayName: 'Amount', kind: 'number', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
  ],
  references: [
    {
      fieldId: 'Event', targetTypeId: EVENT_TYPE, cardinality: 'one', name: 'Event',
      description: 'The distribution event this action recorded.', backingFields: [],
    },
  ],
};

// ── Command node (AddFundDrawdown) ─────────────────────────────────────────
// THREE parents, the most complex command yet: the drawing-down fund (role
// `fundId`, via an `AddFundDrawdown` edge off Legal Entity), the commitment
// investor (role `investorId`, via a `Commitment Investor` edge off Legal
// Entity), and the commitment ASSET (role `assetId`, via a `Commitment
// Asset` edge off ASSET — the first command edge whose parent isn't Legal
// Entity, spliced onto ASSET_DESCRIPTOR via `commandEdgeRefs(ASSET_TYPE)`).
// `applyFundDrawdown` creates NO event — its receipt is
// `{ transactionId, priceId }`, and `resultId: 'transactionId'` makes the
// transaction the command's own id. The amount-input field is named
// `Commitment Price` (not `Price`) so it can't collide with any `Price`
// edge; the receipt is Transaction only this cut. `fieldId === displayName`
// on the input fields, NO `writable` on the receipt ref, no FK column
// backing it.
const ADD_FUND_DRAWDOWN_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADD_FUND_DRAWDOWN_TYPE,
  displayName: ADD_FUND_DRAWDOWN_TYPE,
  fields: [
    { fieldId: 'Date', displayName: 'Date', kind: 'date', writable: true, required: true },
    { fieldId: 'Amount', displayName: 'Amount', kind: 'number', writable: true, required: true },
    { fieldId: 'Commitment Price', displayName: 'Commitment Price', kind: 'number', writable: true, required: true },
    { fieldId: 'Currency', displayName: 'Currency', kind: 'enum', writable: true, required: true, enumValues: CURRENCIES },
  ],
  references: [
    {
      fieldId: 'Transaction', targetTypeId: TRANSACTION_TYPE, cardinality: 'one', name: 'Transaction',
      description: 'The drawdown transaction this action recorded.', backingFields: [],
    },
  ],
};

// ── Computed valuation node ────────────────────────────────────────────────
// A Valuation is NOT a stored Valuations record — it's the value of a Legal
// Entity or Investment COMPUTED as of a date, in a currency, by the backend's
// POST /valuations/compute engine. It is reachable only via the `Valuations`
// edge, and BOTH the date and the currency are supplied by (and pushed down
// from) the traversing hop's WHERE:
//
//   legalEntity-[:valuations WHERE date == "2026-06-30" AND currency == "USD"]->
//
// A hop missing either the date or the currency yields the empty set — there is
// no default date and no default currency (a valuation is only meaningful as of
// a stated date + currency). The node's fields ARE the (aggregated) compute
// response; there's no row to fetch, so `getFieldValue` reads them off the
// inline data. (VALUATION_TYPE / VALUATIONS_EDGE_FIELD_ID are declared above the
// entity descriptors — they're read at descriptor-construction time.)
const VALUATION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: VALUATION_TYPE,
  displayName: 'Valuation',
  fields: [
    // date + currency are the pushed-down inputs — declared filterable so the
    // checker accepts the WHERE across the `native`-filter valuations edge.
    // displayName === fieldId (lowercase) ON PURPOSE: the projected property
    // name IS the displayName (schema_projection), so this is exactly what the
    // author writes in the hop WHERE (`date == "…" AND currency == "…"`) and
    // what parseValuationCriteria and the engine's post-filter re-check key on —
    // one name across checker, engine, and node.
    { fieldId: 'date', displayName: 'date', kind: 'date', writable: false, required: true, capability: { filterOperators: ['eq'] } },
    { fieldId: 'currency', displayName: 'currency', kind: 'enum', writable: false, required: true, enumValues: CURRENCIES, capability: { filterOperators: ['eq'] } },
    // read fields — displayName === fieldId so the node authors uniformly with
    // the filter inputs (`v.total`, `v.moic`, `v.date`), no backticks.
    { fieldId: 'total', displayName: 'total', kind: 'number', writable: false, required: false },
    { fieldId: 'invested', displayName: 'invested', kind: 'number', writable: false, required: false },
    { fieldId: 'unrealized', displayName: 'unrealized', kind: 'number', writable: false, required: false },
    { fieldId: 'realized', displayName: 'realized', kind: 'number', writable: false, required: false },
    { fieldId: 'moic', displayName: 'moic', kind: 'number', writable: false, required: false },
    { fieldId: 'gain', displayName: 'gain', kind: 'number', writable: false, required: false },
    { fieldId: 'gain_pct', displayName: 'gain_pct', kind: 'number', writable: false, required: false },
    { fieldId: 'irr', displayName: 'irr', kind: 'number', writable: false, required: false },
  ],
  references: [],
};

/** The `Valuations` edge, declared identically on Legal Entity and Investment.
 *  `capability.filter: 'native'` opts the checker into accepting (and gating)
 *  the hop WHERE; `backingFields: []` marks it synthetic — no FK column backs
 *  it, so event-mode pruning never treats a record change as affecting it. */
function valuationsEdge(): SchemaReferenceDescriptor {
  return {
    fieldId: VALUATIONS_EDGE_FIELD_ID,
    targetTypeId: VALUATION_TYPE,
    cardinality: 'one',
    direction: 'outgoing',
    name: 'Valuations',
    description: 'The computed valuation as of a date and currency (both supplied via the hop WHERE).',
    capability: { filter: 'native', supportsLimit: false },
    backingFields: [],
  };
}

const WEBHOOK_EVENT_TYPE = 'native-valuations:webhook_event';

// Inbound webhook payload shape — mirrors `eventSchema` in
// services/webhook_sync/providers/native_valuations.ts. Surfaced to the
// trigger filter editor so authors can target an event in terms the
// editor understands (event = "valuations:legal_entity:create", etc.)
// instead of being given Attio's `event_type` / `id.object_id` shape.
//
// The `event` enum is built from the entity catalog × {create, update,
// delete}, matching the outbox-side `actionToEventOp` mapping.
const WEBHOOK_EVENT_OPS = ['create', 'update', 'delete'] as const;
const WEBHOOK_EVENT_VALUES: string[] = ENTITIES.flatMap((e) =>
  WEBHOOK_EVENT_OPS.map((op) => `valuations:${e.table}:${op}`),
);

const WEBHOOK_EVENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: WEBHOOK_EVENT_TYPE,
  displayName: 'Webhook Event',
  fields: [
    { fieldId: 'event', displayName: 'Event', kind: 'enum', writable: false, required: false, enumValues: WEBHOOK_EVENT_VALUES },
    { fieldId: 'timestamp', displayName: 'Timestamp', kind: 'date', writable: false, required: false },
    { fieldId: 'actor.type', displayName: 'Actor Type', kind: 'enum', writable: false, required: false, enumValues: ['user', 'api-token', 'system'] },
    { fieldId: 'actor.id', displayName: 'Actor Id', kind: 'string', writable: false, required: false },
    { fieldId: 'data.id', displayName: 'Record Id', kind: 'string', writable: false, required: false },
  ],
  references: ENTITIES.map((e) => ({
    fieldId: e.displayName,
    targetTypeId: e.displayName,
    cardinality: 'one' as const,
  })),
};

const DESCRIPTORS_BY_DISPLAY_NAME: Record<string, SchemaTypeDescriptor> = {
  [LEGAL_ENTITY_TYPE]: LEGAL_ENTITY_DESCRIPTOR,
  [INVESTMENT_TYPE]: INVESTMENT_DESCRIPTOR,
  [TRANSACTION_TYPE]: TRANSACTION_DESCRIPTOR,
  [ASSET_TYPE]: ASSET_DESCRIPTOR,
  [ASSET_TRANSFER_TYPE]: ASSET_TRANSFER_DESCRIPTOR,
  [PRICE_TYPE]: PRICE_DESCRIPTOR,
  [EVENT_TYPE]: EVENT_DESCRIPTOR,
  // The imperative action node — an ACTION, not a stored entity; describable
  // so authors/describe see its writable input shape.
  [ADD_MARKDOWN_TYPE]: ADD_MARKDOWN_DESCRIPTOR,
  // The multi-parent investment action — investee + investor edges off Legal
  // Entity (COMMAND_EDGES); no receipt references yet (Layer 4).
  [ADD_INVESTMENT_TYPE]: ADD_INVESTMENT_DESCRIPTOR,
  // The single-parent price action — company-level only, no receipt edge
  // this cut (see ADD_PRICE_DESCRIPTOR above).
  [ADD_PRICE_TYPE]: ADD_PRICE_DESCRIPTOR,
  // The single-parent round action — company-level only, WITH a Round/Price
  // receipt (see ADD_ROUND_DESCRIPTOR above).
  [ADD_ROUND_TYPE]: ADD_ROUND_DESCRIPTOR,
  // The single-parent wind-down action — company-level only, one field
  // (Date), WITH an Event-only receipt (see ADD_WIND_DOWN_DESCRIPTOR above).
  [ADD_WIND_DOWN_TYPE]: ADD_WIND_DOWN_DESCRIPTOR,
  // The single-parent share-split action — company-level only, two fields
  // (Date, Multiple), WITH an Event-only receipt (see
  // ADD_SHARE_SPLIT_DESCRIPTOR above).
  [ADD_SHARE_SPLIT_TYPE]: ADD_SHARE_SPLIT_DESCRIPTOR,
  // The two-parent dividends action — paying company + receiving fund edges
  // off Legal Entity (COMMAND_EDGES), WITH an Event-only receipt (see
  // ADD_DIVIDENDS_DESCRIPTOR above).
  [ADD_DIVIDENDS_TYPE]: ADD_DIVIDENDS_DESCRIPTOR,
  // The two-parent fund-distribution action — distributing fund + receiving
  // investor edges off Legal Entity (COMMAND_EDGES), WITH an Event-only
  // receipt (see ADD_FUND_DISTRIBUTION_DESCRIPTOR above).
  [ADD_FUND_DISTRIBUTION_TYPE]: ADD_FUND_DISTRIBUTION_DESCRIPTOR,
  // The THREE-parent fund-drawdown action — fund + commitment investor edges
  // off Legal Entity, plus a commitment asset edge off ASSET (COMMAND_EDGES;
  // the first command edge off a non-Legal-Entity parent), WITH a
  // Transaction-only receipt (see ADD_FUND_DRAWDOWN_DESCRIPTOR above).
  [ADD_FUND_DRAWDOWN_TYPE]: ADD_FUND_DRAWDOWN_DESCRIPTOR,
  // The webhook-event meta type is a FIXED synthetic sentinel (no name↔id gap),
  // keyed by its own constant — resolved before the name cache.
  [WEBHOOK_EVENT_TYPE]: WEBHOOK_EVENT_DESCRIPTOR,
  // The computed valuation type — an edge target only, never a CRUD entity.
  [VALUATION_TYPE]: VALUATION_DESCRIPTOR,
};

// Adapter-root descriptor — ONLY the entities whose root promise is real
// appear as meta edges (the walk and the entry list publish the same root
// edges). Retired roots are reached through their parents; their types stay
// described, just not enumerable from the root.
const META_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: ADAPTER_META_TYPE_ID,
  displayName: 'Listen-Fire Valuations',
  fields: [],
  references: ENTITIES.filter((e) => e.root === 'collection').map<SchemaReferenceDescriptor>(
    (e) => ({
      fieldId: e.displayName,
      targetTypeId: e.displayName,
      cardinality: 'many',
      // The filter above IS the write promise: `root: 'collection'` is the same
      // predicate `listEntryPoints` reads for its `writable`, and a root create
      // needs no parent link (`createRecord` POSTs straight to the entity's
      // collection). Omitting it here made the walk say READ-ONLY while the
      // entry list said writable — the two disagreeing about the same root
      // edges, which the comment above promises they never do.
      writable: true,
    }),
  ),
};

function descriptorFor(displayName: string): SchemaTypeDescriptor | null {
  const raw = DESCRIPTORS_BY_DISPLAY_NAME[displayName];
  if (!raw) return null;
  return withDefaultBackingFields(raw);
}

/**
 * Valuations references are all `*_id` FK fields on the holder; the field
 * id and the backing field are the same. Auto-fill so event-mode pruning
 * works without per-reference annotations. References that explicitly set
 * `backingFields` (e.g. for compound or non-trivial backing) are left
 * untouched.
 */
function withDefaultBackingFields(descriptor: SchemaTypeDescriptor): SchemaTypeDescriptor {
  return {
    ...descriptor,
    references: descriptor.references.map((ref) => ({
      ...ref,
      backingFields: ref.backingFields ?? [ref.fieldId],
    })),
  };
}

// ── HTTP client ───────────────────────────────────────────────────────────

interface ValuationsCredentials {
  apiKey: string;
  baseUrl: string;
}

const valuationsCredsCache = new Map<string, ValuationsCredentials>();

async function loadValuationsCredentials(credentialsId: string): Promise<ValuationsCredentials> {
  const cached = valuationsCredsCache.get(credentialsId);
  if (cached) return cached;
  const cred = await getAutomationsQb(['external_service_credentials'])
    .selectFrom('external_service_credentials')
    .where('id', '=', credentialsId as ExternalServiceCredentialsId)
    .select(['id', 'credentials'])
    .executeTakeFirstOrThrow();
  const decrypted = await decryptToken(cred.credentials as Buffer, credentialsId);
  const parsed = JSON.parse(decrypted) as { apiKey: string; baseUrl?: string };
  // Old-format credentials (minted before the /api/v1 prefix moved onto every
  // request path) stored the prefix IN baseUrl — strip it so today's paths
  // (which already carry /api/v1) don't double it up.
  const storedBaseUrl = parsed.baseUrl?.replace(/\/$/, '').replace(/\/api\/v1$/, '');
  const value: ValuationsCredentials = {
    apiKey: parsed.apiKey,
    baseUrl: storedBaseUrl ?? apiBaseUrl(),
  };
  valuationsCredsCache.set(credentialsId, value);
  return value;
}

interface RestRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

async function valuationsFetch<T>(creds: ValuationsCredentials, req: RestRequest): Promise<T> {
  const url = new URL(`${creds.baseUrl.replace(/\/$/, '')}${req.path}`);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
    });
  } catch (err) {
    // Network-level throw (undici `fetch failed`) — name the operation and
    // unwind `.cause` so the run's failure reason says why, not "fetch failed".
    throw new Error(`Valuations REST ${req.method} ${req.path} failed — ${describeError(err)}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Valuations REST ${req.method} ${req.path} failed: ${response.status} ${text}`);
  }
  if (response.status === 204) return null as unknown as T;
  return (await response.json()) as T;
}

interface ValuationsListResponse<T> {
  data: T[];
  pagination?: { limit: number; offset: number; total?: number };
}

interface ValuationsRecordResponse<T> {
  data: T;
}

// ── Computed valuation (POST /valuations/compute) ──────────────────────────

/** One `/compute` result row (per underlying investment). Only the fields the
 *  adapter reads are typed — the as-of-date / target-currency figures. */
interface ValuationsComputeEntry {
  invested: { valuation_date_value: number | null };
  unrealized: { valuation_date_value: number | null };
  realized: { valuation_date_value: number | null };
  total: { valuation_date_value: number | null };
}

interface ValuationsComputeResponse {
  data: ValuationsComputeEntry[];
}

/** Sum the per-investment compute rows into one entity-level valuation, using
 *  the as-of-date / target-currency figures (`valuation_date_value`). Ratios are
 *  recomputed from the aggregates; IRR is not yet computed by the backend. */
export function aggregateComputeValuation(entries: ValuationsComputeEntry[]): {
  total: number;
  invested: number;
  unrealized: number;
  realized: number;
  moic: number | null;
  gain: number;
  gain_pct: number | null;
  irr: number | null;
} {
  const sum = (
    pick: (e: ValuationsComputeEntry) => { valuation_date_value: number | null },
  ): number => entries.reduce((acc, e) => acc + (pick(e).valuation_date_value ?? 0), 0);
  const invested = sum((e) => e.invested);
  const unrealized = sum((e) => e.unrealized);
  const realized = sum((e) => e.realized);
  const total = sum((e) => e.total);
  const gain = total - invested;
  return {
    total,
    invested,
    unrealized,
    realized,
    gain,
    moic: invested ? total / invested : null,
    gain_pct: invested ? gain / invested : null,
    irr: null,
  };
}

/** Extract the required `date` and `currency` string literals from a hop's
 *  pushed-down WHERE (`date == "…" AND currency == "…"`, either operand order).
 *  Returns null when the WHERE is absent or either input is missing — the caller
 *  treats that as "no valuation to compute" (the empty set). Exported for tests. */
export function parseValuationCriteria(
  where: Expression | undefined,
): { date: string; currency: string } | null {
  if (!where) return null;
  const found: Record<string, string> = {};
  const visit = (e: Expression): void => {
    if (e.type === 'logical' && e.op === 'and') {
      e.operands.forEach(visit);
      return;
    }
    if (e.type === 'compare' && e.op === 'eq') {
      const prop = propertyName(e.left) ?? propertyName(e.right);
      const literal = staticString(e.left) ?? staticString(e.right);
      if (prop !== undefined && literal !== undefined) found[prop] = literal;
    }
  };
  visit(where);
  if (!found.date || !found.currency) return null;
  return { date: found.date, currency: found.currency };
}

function propertyName(e: Expression): string | undefined {
  return e.type === 'property' ? e.propertyTypeId : undefined;
}

function staticString(e: Expression): string | undefined {
  return e.type === 'static' && typeof e.value === 'string' ? e.value : undefined;
}

// ── Adapter implementation ────────────────────────────────────────────────

/**
 * Static manifest — the construction-free declaration the registry exposes via
 * `getAdapterManifest`. `metaRecordType` signals the Manual (meta-rooted) sync;
 * a real `createRecord` makes it a write target.
 *
 */
export const NATIVE_VALUATIONS_MANIFEST: AdapterManifest = {
  adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
  displayName: 'Listen-Fire Valuations',
  description:
    "Listen-Fire's valuations product. Read and write valuation records and react " +
    'when they change.',
  supportedTriggers: ['webhook', 'snapshot', 'mutation'],
  methods: [
    'listEntryPoints', 'describe', 'listEventTypes', 'getFieldValue', 'preprocessInbound',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord',
    'readRecord', 'translateFilter', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  requiredCredentialType: ExternalServiceType.NATIVE_VALUATIONS,
  metaRecordType: META_RECORD_TYPE,
  triggerKinds: ['NATIVE_VALUATIONS'],
  // The Valuations events a `listen to <vals> { events: [...] }` subscribes to —
  // the `events` listen-config vocabulary, folded into the webhook registration.
  // `events` is REQUIRED: a Valuations listen must name what it watches.
  subscribableEvents: [...NATIVE_VALUATIONS_SUBSCRIBABLE_EVENTS],
  listenConfig: [{ key: 'events', required: true }],
  triggerExpectation:
    'Fires when data changes inside Listen-Fire Valuations (its own webhook, ' +
    'managed automatically) — the listen MUST name the events it watches, ' +
    'and only those arrive. Changes made outside Valuations (e.g. in a ' +
    'spreadsheet that feeds it) are not seen until they land in Valuations.',
  vocabulary: {
    // No brand mark — Listen-Fire's own product, not a third-party system.
    eventPhrase: {
      // No per-event phrasing today (the former switch used one generic
      // sentence for every NATIVE_VALUATIONS event) — `default` mirrors that.
      default: [{ template: 'When a valuation report is produced' }],
    },
  },
};

class NativeValuationsAdapter extends BaseAdapter {

  /**
   * THE raw→events seam for Valuations webhook deliveries — the pure
   * `parseValuationsEvents` (the retired provider `parseEvents` logic) +
   * the legacy conversion.
   */
  async preprocessInbound(input: {
    raw: unknown;
    checkpoint?: unknown;
  }): Promise<{ events: DiscriminableEvent[] }> {
    return { events: parseValuationsEvents(input.raw).map(webhookEventToDiscriminable) };
  }
  readonly adapterType = NATIVE_VALUATIONS_ADAPTER_TYPE;
  readonly supportedTriggers = NATIVE_VALUATIONS_MANIFEST.supportedTriggers;
  /** Unstable positions resolve to the Valuations webhook-event type, except
   *  the meta root (`metaRecordType`) which resolves to null. Pure config
   *  consumed by the engine's generic `resolvePositionTypeId`. */
  readonly webhookEventTypeId = WEBHOOK_EVENT_TYPE;
  readonly metaRecordType = META_RECORD_TYPE;
  private readonly fetchCache = new Map<string, SourcePosition>();

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId: string | undefined,
  ) {
    super();
  }

  // ── Event subscriptions (the listen-reconciliation seam) ─────────────────
  // Self-registration with Valuations via /api/v1/valuations/webhooks, shared
  // with the WebhookProvider (native_valuations_webhook.ts). This is what
  // provisions a webhook when a movement `listen`s to the Valuations instance
  // (syncListenSubscriptions drives it). Scope-less: the channel is just
  // (adapter, credential). Valuations has no webhook PATCH, so a changed event
  // set is deregister-then-register.
  async ensureEventSubscription(
    input: EnsureEventSubscriptionInput,
  ): Promise<EventSubscriptionRegistration | undefined> {
    if (this.credentialsId === undefined) return undefined;
    if (input.current?.externalId !== undefined) {
      const unchanged =
        input.current.events.length === input.events.length &&
        input.current.events.every((e) => input.events.includes(e));
      if (unchanged) return undefined;
      await deregisterValuationsWebhook({
        credentialsId: this.credentialsId,
        externalId: input.current.externalId,
      }).catch((err) => {
        logger.warn(
          '[NativeValuationsAdapter] failed to deregister superseded webhook before recreate',
          { error: err instanceof Error ? err.message : String(err) },
        );
      });
    }
    return registerValuationsWebhook({
      credentialsId: this.credentialsId,
      targetUrl: input.callbackUrl,
      eventTypes: input.events,
    });
  }

  async removeEventSubscription(input: RemoveEventSubscriptionInput): Promise<void> {
    if (this.credentialsId === undefined || input.externalId === undefined) return;
    await deregisterValuationsWebhook({
      credentialsId: this.credentialsId,
      externalId: input.externalId,
    });
  }

  // ── Name → structured-identifier cache ───────────────────────────────────
  // The framework names an entity only by its pretty `displayName` — that IS
  // the `recordType` every position carries and the `typeId` `listEntryPoints`
  // / `describe` publish. The REST surface routes on the entity's table + slug.
  // These helpers are the map between them. The entity catalog is a compile-time
  // constant (no introspection), so the "cache" is the plain `ENTITY_BY_DISPLAY_NAME`
  // lookup — every read/write/traverse recovers its `EntityDescriptor` from the
  // recordType NAME here, never by parsing an `native-valuations:<table>` string.

  /** Resolve an entity's pretty NAME to its structured id (`EntityDescriptor`),
   *  or undefined when the name isn't a known entity. */
  private structuredIdFor(name: string): EntityDescriptor | undefined {
    return ENTITY_BY_DISPLAY_NAME[name];
  }

  /** The write variant: a name that doesn't resolve is a hard error (the
   *  movement targets an entity this adapter doesn't expose — drift). */
  private requireStructuredId(name: string, method: string): EntityDescriptor {
    const entity = this.structuredIdFor(name);
    if (!entity) {
      throw new Error(`NativeValuationsAdapter.${method}: unrecognised recordType "${name}".`);
    }
    return entity;
  }

  // ── 1. Schema introspection ──

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return [
      ...ENTITIES.map((e) => ({
        // The framework identity IS the pretty entity name; the table rides
        // `externalId` (and the structured-id map). Root promises come from
        // the entity's `root` declaration: only genuine workspace-wide
        // surfaces (Legal Entity, Asset) mint a root collection; the rest
        // are reached through their parents (readable: false, writable:
        // false — the entry stays published so the name resolver, describe,
        // and event discrimination still know the type, and the POSITION
        // derives from edge reachability).
        typeId: e.displayName,
        displayName: e.displayName,
        externalId: e.table,
        scope: 'self-configured' as const,
        writable: e.root === 'collection',
        readable: e.root === 'collection',
      })),
      // A CHILD type: a Valuation is COMPUTED along the `Valuations` edge from
      // a Legal Entity / Investment (date + currency supplied by the hop's
      // WHERE) — the root cannot enumerate valuations at all. The `readable:
      // true` this entry used to carry minted a root collection whose read was
      // silently empty (`iterateRelatedFromMeta` has no entity for it) and
      // whose snapshot THREW. `readable: false` is the true statement about
      // that one meta edge; the position (and the fields resolving after
      // `-[:valuations]->`) derive from reachability — the entry stays
      // published so the name resolver and `describe` still know the type.
      {
        typeId: VALUATION_TYPE,
        displayName: VALUATION_TYPE,
        externalId: 'valuation',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddMarkdown action node — reached and written through Legal
      // Entity's command edge (createCommandRecord), not a root collection.
      // Published so the name resolver + describe know the type.
      {
        typeId: ADD_MARKDOWN_TYPE,
        displayName: ADD_MARKDOWN_TYPE,
        externalId: 'add_markdown',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddInvestment action node — reached and written through Legal
      // Entity's TWO command edges (investee + investor), not a root
      // collection. Published so the name resolver + describe know the type.
      {
        typeId: ADD_INVESTMENT_TYPE,
        displayName: ADD_INVESTMENT_TYPE,
        externalId: 'add_investment',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddPrice action node — reached and written through Legal
      // Entity's command edge (createCommandRecord), not a root collection.
      // Published so the name resolver + describe know the type.
      {
        typeId: ADD_PRICE_TYPE,
        displayName: ADD_PRICE_TYPE,
        externalId: 'add_price',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddRound action node — reached and written through Legal
      // Entity's command edge (createCommandRecord), not a root collection.
      // Published so the name resolver + describe know the type.
      {
        typeId: ADD_ROUND_TYPE,
        displayName: ADD_ROUND_TYPE,
        externalId: 'add_round',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddWindDown action node — reached and written through Legal
      // Entity's command edge (createCommandRecord), not a root collection.
      // Published so the name resolver + describe know the type.
      {
        typeId: ADD_WIND_DOWN_TYPE,
        displayName: ADD_WIND_DOWN_TYPE,
        externalId: 'add_wind_down',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddShareSplit action node — reached and written through Legal
      // Entity's command edge (createCommandRecord), not a root collection.
      // Published so the name resolver + describe know the type.
      {
        typeId: ADD_SHARE_SPLIT_TYPE,
        displayName: ADD_SHARE_SPLIT_TYPE,
        externalId: 'add_share_split',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddDividends action node — reached and written through Legal
      // Entity's TWO command edges (paying company + receiving fund), not a
      // root collection. Published so the name resolver + describe know the
      // type.
      {
        typeId: ADD_DIVIDENDS_TYPE,
        displayName: ADD_DIVIDENDS_TYPE,
        externalId: 'add_dividends',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddFundDistribution action node — reached and written through
      // Legal Entity's TWO command edges (distributing fund + receiving
      // investor), not a root collection. Published so the name resolver +
      // describe know the type.
      {
        typeId: ADD_FUND_DISTRIBUTION_TYPE,
        displayName: ADD_FUND_DISTRIBUTION_TYPE,
        externalId: 'add_fund_distribution',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
      // The AddFundDrawdown action node — reached and written through THREE
      // command edges (the fund + commitment investor off Legal Entity, the
      // commitment asset off Asset), not a root collection. Published so the
      // name resolver + describe know the type.
      {
        typeId: ADD_FUND_DRAWDOWN_TYPE,
        displayName: ADD_FUND_DRAWDOWN_TYPE,
        externalId: 'add_fund_drawdown',
        scope: 'self-configured' as const,
        writable: false,
        readable: false,
      },
    ];
  }

  /**
   * The root offers only the entities you enter THROUGH — a legal entity, an
   * asset. Everything else (investments, transactions, valuations) is reached
   * by walking from one of those, which is rule 7: navigate through parents,
   * never deep objects by id at the root.
   */
  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      at: position,
      root: META_DESCRIPTOR,
      describe: (typeId) => this.describe(typeId),
    });
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID) return META_DESCRIPTOR;
    // The type is named by its displayName, which IS the entry `typeId` now —
    // `resolveTypeRef` is a pass-through for a known name; `descriptorFor` keys
    // by that name. The synthetic webhook-event id passes through to its own
    // descriptor. An unknown name → null.
    const name = await this.resolveTypeRef(typeRef);
    return descriptorFor(name);
  }

  /**
   * The event-type union: one entry per Valuations entity, recognised by the
   * outbox event name `valuations:<table>:<op>`. The engine discriminates an
   * inbound event against it into a typed entity position — replacing the
   * `native-valuations:webhook_event` meta-type.
   */
  async listEventTypes(): Promise<EventType[]> {
    return ENTITIES.map((e) => ({
      // The discriminated position carries the entity's NAME as its positionType
      // — the engine seeds the inbound root with it directly (no typeId →
      // displayName restamp). The `match` still keys on the outbox event name.
      tag: e.displayName,
      positionType: e.displayName,
      match: {
        path: 'event',
        equals: [
          `valuations:${e.table}:create`,
          `valuations:${e.table}:update`,
          `valuations:${e.table}:delete`,
        ],
      },
    }));
  }

  // ── 2. Entity resolution ──
  // Inbound (V → K): match the Valuations row id against linked_object
  // candidates — BaseAdapter's default, which the override below falls back to.
  //
  // Valuations entities are addressed by Listen-Fire-managed UUIDs, so there is
  // no native uniqueness rule to declare and every identity here is one the
  // author wrote (`unique by (\`Name\`)`). Answering it takes a search: without
  // one the resolve returns nothing, and "find the record or create it" quietly
  // becomes "create it", once per message.

  /**
   * Find the rows an author's `unique by (…)` names.
   *
   * The constraint is an OR of AND-groups over this entity's own field names.
   * Each group is answered with ONE narrow list request, and the equality that
   * decides identity is applied here, to the rows that came back — the list
   * endpoints filter loosely (`search` is a case-insensitive contains), and a
   * loose filter must never be the thing that decides two records are the same.
   * The one exception is a `FUZZY` component on a name-like field: there the
   * similarity search IS the shortlist, and the engine's judge decides.
   */
  async resolveEntity(input: ResolveEntityInput): Promise<ResolveEntityResult> {
    const branches = input.constraints?.any ?? [];
    const entity = this.structuredIdFor(input.recordType);
    if (branches.length === 0 || entity === undefined || this.credentialsId === undefined) {
      return super.resolveEntity(input);
    }

    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    const descriptor = DESCRIPTORS_BY_DISPLAY_NAME[entity.displayName];
    const fuzzyColumns = fuzzyColumnsOf(descriptor);
    const columnOf = (field: string) => resolver.fieldId(type, naturalName(field));

    // The checker admits `FUZZY` only where the descriptor declares it; one
    // that reaches here anyway (an automation saved before that rule) would
    // otherwise be quietly answered by equality, so refuse it before searching.
    for (const entry of branches.flatMap((branch) => branch.all)) {
      if (entry.fuzzy === true && !fuzzyColumns.has(columnOf(entry.field))) {
        throw new Error(`FUZZY on \`${entry.field}\` is not supported by ${input.recordType}`);
      }
    }

    const creds = await this.requireCreds();

    const seen = new Set<string>();
    const candidates: ExternalRecordRef[] = [];

    for (const branch of branches) {
      const wanted = branch.all.map((entry) => ({
        surface: entry.field,
        column: columnOf(entry.field),
        value: input.record[entry.field],
        similar: entry.fuzzy === true,
      }));
      // A group with nothing asserted for one of its fields identifies nothing.
      if (wanted.some((w) => w.value === undefined || w.value === null)) continue;

      // A fuzzy component is answered by the route's similarity
      // search, not by equality: the shortlist comes back in relevance order
      // and the engine's judge decides. Every other component keeps equality.
      const query: Record<string, string | number> = { limit: IDENTITY_SEARCH_LIMIT };
      const bySimilarity = wanted.find((w) => w.similar);
      const byName = bySimilarity ?? wanted.find((w) => w.column === 'name');
      if (byName !== undefined) query.search = String(byName.value);
      const exact = wanted.filter((w) => !w.similar);

      let page: ValuationsListResponse<Record<string, unknown>>;
      try {
        page = await valuationsFetch<ValuationsListResponse<Record<string, unknown>>>(creds, {
          method: 'GET',
          path: `/api/v1/valuations/${entity.slug}`,
          query,
        });
      } catch (err) {
        // A search that cannot be run is not an assertion that nothing matches,
        // but there is nothing else to answer with; say so and fall through to
        // the create the engine would otherwise have made anyway.
        logger.warn('[NativeValuationsAdapter] identity search failed; resolving to no match', {
          recordType: input.recordType,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      for (const row of page.data) {
        const externalId = String(row.id ?? '');
        if (externalId === '' || seen.has(externalId)) continue;
        if (!exact.every((w) => identityFieldAgrees(w.column, w.value, row[w.column]))) continue;
        seen.add(externalId);
        candidates.push({
          adapterType: this.adapterType,
          externalId,
          // Keyed by SURFACE name: arbitration compares this against the
          // asserted record, which is in the write's currency. A similarity
          // hit also carries every name the row answers to, so the judge can
          // see the alias or legal name that put it on the shortlist.
          data: {
            ...(bySimilarity !== undefined ? fuzzyFieldsOf({ row, descriptor, fuzzyColumns }) : {}),
            ...Object.fromEntries(wanted.map((w) => [w.surface, row[w.column]])),
          },
        });
      }
    }

    return { candidates };
  }

  // ── 3. Field-level access ──

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== this.adapterType) {
      throw new Error(
        `NativeValuationsAdapter.getFieldValue expects ${this.adapterType} positions; got ${input.position.adapterType}`,
      );
    }
    const raw = positionData(input.position);
    if (!isStablePosition(input.position) && input.position.recordType === null) {
      // Legacy raw-payload authoring against an UNTYPED position: read dot-paths
      // (`event`, `actor.type`, `data.after.<field>`) off the whole envelope.
      // A discriminated event is typed (recordType set) and takes the path below.
      return readDotPath(raw, input.fieldId);
    }
    // Typed position — a discriminated inbound event or a fetched external
    // record. A discriminated event carries the webhook envelope, so unwrap it
    // to the record's flat row (the `after` snapshot, `before` on delete); a
    // fetched record is already that flat row.
    const data = (webhookEnvelopeRow(raw) ?? raw) as Record<string, unknown> | null | undefined;
    if (!data) return null;
    // `fieldId` is the NATURAL field name and `position.recordType` is the
    // NATURAL type name (the read wrapper stamps it); resolve to the internal
    // field id the payload is keyed by, against that type (Decision #3).
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    return data[fieldId] ?? null;
  }

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        `NativeValuationsAdapter.getRelated only supports outgoing direction.`,
      );
    }

    // adapter-meta → collection. fieldId is the target entity typeId; walk
    // the existing snapshot iterator and yield one external-record per
    // record. Builds on existing primitives — collection iteration isn't
    // a separate API. The streaming variant (`iterateRelated`) is preferred
    // by the engine; this eager collector is kept for fallback callers.
    if (input.position.recordType === META_RECORD_TYPE) {
      // A meta-root hop names a COLLECTION (an entity type) by its NATURAL
      // name; resolve to the entity typeId the snapshot iterator scans by
      // (Decision #3).
      const resolver = await this.resolver();
      const edgeFieldId = resolver.collectionTypeId(naturalName(input.fieldId));
      const results: RelatedResult[] = [];
      for await (const r of this.iterateRelatedFromMeta({
        edgeFieldId,
        nativeFilter: input.nativeFilter,
      })) {
        results.push(r);
      }
      return results;
    }

    // webhook-event → record traversal: the edge name corresponds to the entity
    // type (e.g. `Legal Entity`). The trigger filter pins the entity via
    // `event == 'valuations:<entity>:<op>'`; we infer the entity from the
    // event payload's `event` field. The webhook-event type is not an entry
    // point (no resolver entry), and the reference's natural name IS the
    // entity displayName / typeId — so compare against both directly.
    if (!isStablePosition(input.position)) {
      const data = positionData(input.position) as { event?: string; data?: { id?: string; after?: unknown } };
      if (!data.event || !data.data?.id) return [];
      const entityName = data.event.split(':')[1];
      if (!entityName) return [];
      const entity = ENTITY_BY_TABLE[entityName];
      if (!entity) return [];

      // The edge name is the entity's display name (the reference's natural
      // name on the webhook-event descriptor); pickers resolve it via the
      // schema descriptor's references.
      const targetName = entity.displayName;
      if (input.fieldId !== targetName) {
        return [];
      }

      const cacheKey = `${this.adapterType}:${targetName}:${data.data.id}`;
      const cached = this.fetchCache.get(cacheKey);
      if (cached) return [{ position: cached }];

      // Use `data.after` if present (full snapshot in the webhook payload) so
      // we don't need an extra REST round-trip for steady-state.
      const recordData = (data.data.after ?? null) as Record<string, unknown> | null;
      const position: SourcePosition = recordData
        ? makeStablePosition({
            adapterType: this.adapterType,
            recordId: data.data.id,
            recordType: targetName,
            data: recordData,
          })
        : await this.fetchExternalRecord(targetName, data.data.id);
      this.fetchCache.set(cacheKey, position);
      return [{ position }];
    }

    // AddMarkdown receipt → Event/Prices: the command's write result carried
    // no stored record — `data.eventId` / `data.priceIds` are the receipt the
    // REST command endpoint returned (Layer 3), riding the stable position's
    // data (Layer 4 threads `resultData` in via `graphReadFor`). Resolved
    // here rather than by FK dispatch below because AddMarkdown isn't a
    // stored entity in `ENTITY_BY_DISPLAY_NAME` — a name lookup there would
    // drift-error.
    if (input.position.recordType === ADD_MARKDOWN_TYPE) {
      const receipt = positionData(input.position) as
        | { eventId?: string; priceIds?: string[] }
        | null
        | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Event') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      if (input.fieldId === 'Prices') {
        return Promise.all(
          (receipt.priceIds ?? []).map(async (id) => ({
            position: await this.fetchExternalRecord(PRICE_TYPE, id),
          })),
        );
      }
      return [];
    }

    // AddInvestment receipt → Investment/Round/Transaction: same shape as the
    // AddMarkdown receipt above — `applyInvestment`'s
    // `{ investmentId, eventId, transactionId }` rides the stable position's
    // data (Layer 4). AddInvestment isn't a stored entity either, so it's
    // resolved here rather than by FK dispatch below.
    if (input.position.recordType === ADD_INVESTMENT_TYPE) {
      const receipt = positionData(input.position) as
        | { investmentId?: string; eventId?: string | null; transactionId?: string }
        | null
        | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Investment') {
        return receipt.investmentId
          ? [{ position: await this.fetchExternalRecord(INVESTMENT_TYPE, receipt.investmentId) }]
          : [];
      }
      if (input.fieldId === 'Round') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      if (input.fieldId === 'Transaction') {
        return receipt.transactionId
          ? [{ position: await this.fetchExternalRecord(TRANSACTION_TYPE, receipt.transactionId) }]
          : [];
      }
      return [];
    }

    // AddRound receipt → Round/Price: `applyRound`'s `{ eventId, priceId }`
    // rides the stable position's data (Layer 4), same shape as the
    // AddMarkdown/AddInvestment receipts above. AddRound isn't a stored
    // entity either, so it's resolved here rather than by FK dispatch below.
    if (input.position.recordType === ADD_ROUND_TYPE) {
      const receipt = positionData(input.position) as
        | { eventId?: string | null; priceId?: string | null }
        | null
        | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Round') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      if (input.fieldId === 'Price') {
        return receipt.priceId
          ? [{ position: await this.fetchExternalRecord(PRICE_TYPE, receipt.priceId) }]
          : [];
      }
      return [];
    }

    // AddWindDown receipt → Event: `applyWindDown`'s `{ eventId }` rides the
    // stable position's data (Layer 4), same shape as the receipts above.
    // AddWindDown isn't a stored entity either, so it's resolved here rather
    // than by FK dispatch below. No Prices receipt this cut (deferred, see
    // ADD_WIND_DOWN_DESCRIPTOR above).
    if (input.position.recordType === ADD_WIND_DOWN_TYPE) {
      const receipt = positionData(input.position) as { eventId?: string } | null | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Event') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      return [];
    }

    // AddShareSplit receipt → Event: `applyShareSplit`'s `{ eventId }` rides
    // the stable position's data (Layer 4), same shape as the receipts
    // above. AddShareSplit isn't a stored entity either, so it's resolved
    // here rather than by FK dispatch below.
    if (input.position.recordType === ADD_SHARE_SPLIT_TYPE) {
      const receipt = positionData(input.position) as { eventId?: string } | null | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Event') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      return [];
    }

    // AddDividends receipt → Event: `applyDividends`'s `{ eventId }` rides
    // the stable position's data (Layer 4), same shape as the AddWindDown/
    // AddShareSplit receipts above. AddDividends isn't a stored entity
    // either, so it's resolved here rather than by FK dispatch below.
    if (input.position.recordType === ADD_DIVIDENDS_TYPE) {
      const receipt = positionData(input.position) as { eventId?: string } | null | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Event') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      return [];
    }

    // AddFundDistribution receipt → Event: `applyFundDistribution`'s
    // `{ eventId }` rides the stable position's data (Layer 4), same shape
    // as the AddDividends receipt above. AddFundDistribution isn't a stored
    // entity either, so it's resolved here rather than by FK dispatch below.
    if (input.position.recordType === ADD_FUND_DISTRIBUTION_TYPE) {
      const receipt = positionData(input.position) as { eventId?: string } | null | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Event') {
        return receipt.eventId
          ? [{ position: await this.fetchExternalRecord(EVENT_TYPE, receipt.eventId) }]
          : [];
      }
      return [];
    }

    // AddFundDrawdown receipt → Transaction: `applyFundDrawdown`'s
    // `{ transactionId, priceId }` rides the stable position's data (Layer
    // 4), same shape as the receipts above. No event this time — resultId
    // is `transactionId`, and the receipt exposes only the Transaction this
    // cut. AddFundDrawdown isn't a stored entity either, so it's resolved
    // here rather than by FK dispatch below.
    if (input.position.recordType === ADD_FUND_DRAWDOWN_TYPE) {
      const receipt = positionData(input.position) as
        | { transactionId?: string; priceId?: string }
        | null
        | undefined;
      if (!receipt) return [];
      if (input.fieldId === 'Transaction') {
        return receipt.transactionId
          ? [{ position: await this.fetchExternalRecord(TRANSACTION_TYPE, receipt.transactionId) }]
          : [];
      }
      return [];
    }

    // external-record → external-record traversal (FK fields like
    // legal_entity.investing_entity_id). `input.fieldId` is the NATURAL edge
    // name and `position.recordType` is the NATURAL type name; resolve both to
    // the adapter's internal currency — the reference fieldId is the FK column
    // the payload is keyed by (Decision #3).
    if (input.position.recordType === null) return [];
    const fieldId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);

    // Computed valuation edge: Legal Entity / Investment
    // -[:valuations WHERE date == "…" AND currency == "…"]-> one Valuation node,
    // via POST /valuations/compute. Both inputs come from the pushed-down hop
    // WHERE; either missing → empty set (see computeValuation).
    if (fieldId === VALUATIONS_EDGE_FIELD_ID) {
      return this.computeValuation(input);
    }

    // Parent-first down-edge (rule 7): enumerate the CHILD collection scoped
    // to this record — a REST list filtered by the child's FK column.
    const downEdge = DOWN_EDGE_BY_PARENT_FIELD.get(`${input.position.recordType} ${fieldId}`);
    if (downEdge) {
      return this.readDownEdge(downEdge, input);
    }

    // A discriminated inbound event carries the webhook envelope; unwrap it to
    // the record row so the FK column resolves (a fetched record is already the
    // flat row). Mirrors `getFieldValue`.
    const raw = positionData(input.position);
    const data = (webhookEnvelopeRow(raw) ?? raw) as Record<string, unknown> | null;
    const targetId = data?.[fieldId];
    if (typeof targetId !== 'string') return [];

    // `recordType` is the entity's NATURAL name; `descriptorFor` keys by it and
    // the reference's `targetTypeId` is the target entity's name too (the
    // currency `fetchExternalRecord` resolves to its REST slug).
    const descriptor = descriptorFor(input.position.recordType);
    const ref = descriptor?.references.find((r) => r.fieldId === fieldId);
    if (!ref) return [];

    const cacheKey = `${this.adapterType}:${ref.targetTypeId}:${targetId}`;
    const cached = this.fetchCache.get(cacheKey);
    if (cached) return [{ position: cached }];

    const position = await this.fetchExternalRecord(ref.targetTypeId, targetId);
    this.fetchCache.set(cacheKey, position);
    return [{ position }];
  }

  /**
   * Streaming variant of `getRelated` for the meta-edge case. Yields
   * each record as the snapshot iterator emits it so the engine doesn't
   * have to hold the full collection in memory. Non-meta positions fall
   * through to the eager `getRelated` path.
   */
  async *iterateRelated(input: GetRelatedInput): AsyncIterable<RelatedResult> {
    if (input.direction !== 'outgoing') {
      throw new Error(
        `NativeValuationsAdapter.iterateRelated only supports outgoing direction.`,
      );
    }
    if (input.position.recordType === META_RECORD_TYPE) {
      // Resolve the NATURAL collection name to the entity typeId the snapshot
      // iterator scans by (Decision #3) — same as the eager `getRelated` meta
      // branch.
      const resolver = await this.resolver();
      yield* this.iterateRelatedFromMeta({
        edgeFieldId: resolver.collectionTypeId(naturalName(input.fieldId)),
        nativeFilter: input.nativeFilter,
      });
      return;
    }
    const results = await this.getRelated(input);
    for (const r of results) yield r;
  }

  private async *iterateRelatedFromMeta(input: {
    edgeFieldId: string;
    nativeFilter?: unknown;
  }): AsyncIterable<RelatedResult> {
    const entity = this.structuredIdFor(input.edgeFieldId);
    // The computed `Valuation` type has no root enumeration AT ALL — each
    // valuation is computed per record, per (date, currency). Loud, not
    // silently empty (a movement authored against the old surface must be
    // told where the data went).
    if (!entity) {
      throw new Error(
        `Listen-Fire Valuations cannot enumerate '${input.edgeFieldId}' from the root — a valuation ` +
          'is computed per record: hop `<legal entity or investment>' +
          '-[:valuations WHERE date == "…" AND currency == "…"]->`.',
      );
    }
    // A retired root (rule 0: access lives where access is real). The type is
    // reached through its parents; a read still arriving here points there.
    if (entity.root !== 'collection') {
      throw new Error(`Listen-Fire Valuations: ${entity.root.redirect}`);
    }
    const events = this.snapshot({
      pipelineInputId: '',
      recordType: input.edgeFieldId,
      filter: input.nativeFilter,
    });
    for await (const event of events) {
      // The EXTERNAL id rides `externalRecordRef` (W3-B1); `event.recordId`
      // is a KG NodeId the snapshot never sets — reading it here made every
      // meta-root read silently EMPTY (the silent-degradation class).
      const recordId = event.externalRecordRef?.externalId;
      const data = event.payload as Record<string, unknown> | null | undefined;
      if (!recordId || !data) continue;
      yield {
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordId,
          recordType: input.edgeFieldId,
          data,
        }),
      };
    }
  }

  private async fetchExternalRecord(displayName: string, recordId: string): Promise<SourcePosition> {
    const entity = this.structuredIdFor(displayName);
    if (!entity) {
      throw new Error(`Unknown Valuations entity: ${displayName}`);
    }
    if (!this.credentialsId) {
      throw new Error(
        `NativeValuationsAdapter requires credentialsId; the pipeline_input/output row is missing one.`,
      );
    }
    const creds = await loadValuationsCredentials(this.credentialsId);
    const response = await valuationsFetch<ValuationsRecordResponse<Record<string, unknown>>>(
      creds,
      { method: 'GET', path: `/api/v1/valuations/${entity.slug}/${recordId}` },
    );
    return makeStablePosition({
      adapterType: this.adapterType,
      recordId,
      recordType: displayName,
      data: response.data,
    });
  }

  /**
   * A down-edge read: the child entity's REST list, scoped to the parent by
   * the child's FK column (`?<childFk>=<parent id>`), paged to completion.
   * The child rows come back as ordinary stable positions — the same shape a
   * root enumeration would have minted.
   */
  private async readDownEdge(
    edge: DownEdgeDescriptor,
    input: GetRelatedInput,
  ): Promise<RelatedResult[]> {
    const raw = positionData(input.position);
    const row = (webhookEnvelopeRow(raw) ?? raw) as Record<string, unknown> | null;
    const parentId = row?.id;
    if (typeof parentId !== 'string') return [];

    const entity = this.requireStructuredId(edge.target, 'readDownEdge');
    const creds = await this.requireCreds();
    const limit = 100;
    let offset = 0;
    const results: RelatedResult[] = [];
    for (;;) {
      const page = await valuationsFetch<ValuationsListResponse<Record<string, unknown>>>(creds, {
        method: 'GET',
        path: `/api/v1/valuations/${entity.slug}`,
        query: { [edge.childFk]: parentId, limit, offset },
      });
      for (const record of page.data) {
        const recordId = String(record.id ?? '');
        if (!recordId) continue;
        results.push({
          position: makeStablePosition({
            adapterType: this.adapterType,
            recordId,
            recordType: edge.target,
            data: record,
          }),
        });
      }
      if (page.data.length < limit) break;
      offset += page.data.length;
    }
    return results;
  }

  /**
   * Resolve the `Valuations` edge to ONE computed Valuation node via
   * POST /valuations/compute. The hop's WHERE supplies both `date` and
   * `currency` (pushed down as `input.where`); either missing → empty set.
   * Legal Entity is valued as an investee (`investment_profile_id`); Investment
   * by its own id. `/compute` returns one row per underlying investment,
   * aggregated here into a single node whose fields ARE the valuation. `date`
   * and `currency` are echoed onto the node so the engine's post-filter re-check
   * of the same WHERE keeps it.
   */
  private async computeValuation(input: GetRelatedInput): Promise<RelatedResult[]> {
    const sourceType = input.position.recordType;
    if (sourceType !== LEGAL_ENTITY_TYPE && sourceType !== INVESTMENT_TYPE) return [];

    const criteria = parseValuationCriteria(input.where);
    if (!criteria) return []; // date or currency absent — nothing to compute

    const raw = positionData(input.position);
    const row = (webhookEnvelopeRow(raw) ?? raw) as Record<string, unknown> | null;
    const entityId = row?.id;
    if (typeof entityId !== 'string') return [];

    const creds = await this.requireCreds();
    const selector =
      sourceType === LEGAL_ENTITY_TYPE
        ? { investment_profile_id: entityId }
        : { investment_ids: [entityId] };
    const response = await valuationsFetch<ValuationsComputeResponse>(creds, {
      method: 'POST',
      path: '/api/v1/valuations/compute',
      body: { ...selector, as_of_date: criteria.date, target_currency: criteria.currency },
    });

    const value = aggregateComputeValuation(response.data ?? []);
    return [
      {
        position: makeStablePosition({
          adapterType: this.adapterType,
          recordId: `${entityId}@${criteria.date}@${criteria.currency}`,
          recordType: VALUATION_TYPE,
          data: { date: criteria.date, currency: criteria.currency, ...value },
        }),
      },
    ];
  }

  // ── 4. Trigger implementations ──

  async *snapshot(input: SnapshotInput): AsyncIterable<TriggerEvent> {
    // `recordType` is the entity's NATURAL name (the entry typeId, or the
    // collection name the meta hop resolved); recover its REST slug from the
    // structured-id map.
    const entity = this.structuredIdFor(input.recordType);
    if (!entity) {
      throw new Error(`Unknown Valuations entity for snapshot: ${input.recordType}`);
    }
    // A retired root cannot be snapshot-enumerated either — same redirect the
    // meta read gives (the snapshot fan-out only drives readable entries, so
    // arriving here means a stale trigger config).
    if (entity.root !== 'collection') {
      throw new Error(`Listen-Fire Valuations: ${entity.root.redirect}`);
    }
    if (!this.credentialsId) {
      throw new Error(
        `NativeValuationsAdapter snapshot requires credentialsId; the pipeline_input row is missing one.`,
      );
    }
    const creds = await loadValuationsCredentials(this.credentialsId);

    const limit = 100;
    let offset = 0;
    let total: number | undefined;
    let yielded = 0;
    for (;;) {
      const page = await valuationsFetch<ValuationsListResponse<Record<string, unknown>>>(
        creds,
        { method: 'GET', path: `/api/v1/valuations/${entity.slug}`, query: { limit, offset } },
      );
      total = page.pagination?.total;
      if (page.data.length === 0) break;
      for (const record of page.data) {
        yielded++;
        const recordId = String(record.id ?? '');
        if (!recordId) continue;
        yield {
          pipelineInputId: input.pipelineInputId,
          adapterType: this.adapterType,
          objectType: input.recordType,
          triggerType: 'snapshot',
          // For snapshot triggers, the engine seeds the source position as
          // an `external-record` with `data = payload`. So payload is the
          // bare record, not the webhook-event envelope.
          payload: record,
          // W3-B1 — externalRecordRef carries the external id.
          externalRecordRef: {
            adapterType: this.adapterType,
            externalId: recordId,
            recordType: input.recordType,
          },
          occurredAt: new Date().toISOString(),
          snapshotComplete: total !== undefined && yielded >= total,
        };
      }
      offset += page.data.length;
      if (page.data.length < limit) break;
    }
  }

  // ── 5. Writes ──

  /**
   * Resolve a write's NATURAL type name to the entity (by typeId) and rename
   * its `fields` keys from NATURAL field names to the internal field ids the
   * Valuations REST body expects — the per-method first-line translation
   * (Decision #3). The REST surface keys on the internal `*_id` / snake_case
   * names that `describe`'s `fieldId`s carry.
   */
  private async toInternalWrite(input: { recordType: string; fields: Record<string, unknown> }): Promise<{
    entity: EntityDescriptor;
    fields: Record<string, unknown>;
  }> {
    const resolver = await this.resolver({ types: [input.recordType] });
    const type = naturalName(input.recordType);
    // `recordType` is the entity's NATURAL name — recover its REST slug from the
    // structured-id map; the resolver still maps each field name → internal id.
    const entity = this.requireStructuredId(input.recordType, 'write');
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(input.fields)) {
      fields[resolver.fieldId(type, naturalName(name))] = value;
    }
    return { entity, fields };
  }

  /**
   * Resolve one of the write's parent links to the down-edge it names and
   * inject the parent's id as the child's FK field. `edgeName` arrives in the
   * write currency — the edge's natural name (`Events`, `Investments Made`);
   * the fieldId is tolerated for older saved programs. An N-parent create
   * (the tuple-path write) carries one link per edge: an Investment takes its
   * investee via `Investments` AND its investor via `Investments Made`; an
   * Asset Transfer takes all four parents.
   */
  private injectParentLink(input: {
    link: ParentLink;
    childType: string;
    fields: Record<string, unknown>;
  }): void {
    const { link } = input;
    const edge = DOWN_EDGES.find(
      (e) =>
        e.parent === link.recordType &&
        (e.name === link.edgeName || e.fieldId === link.edgeName),
    );
    if (!edge) {
      throw new Error(
        `NativeValuationsAdapter.createRecord(${input.childType}): '${link.recordType}' has no ` +
          `create edge '${link.edgeName}' — the parent link doesn't name a known down-edge.`,
      );
    }
    if (edge.target !== input.childType) {
      throw new Error(
        `NativeValuationsAdapter.createRecord(${input.childType}): parent edge ` +
          `'${link.recordType}'-[:${edge.name}]-> creates a ${edge.target}, not a ${input.childType}.`,
      );
    }
    input.fields[edge.childFk] = link.externalId;
  }

  /**
   * Route an imperative action's create along its command edge(s): resolve
   * EVERY parent-role edge for this command (a tuple write names them all —
   * AddInvestment needs both its investee and its investor), translate the
   * action's fields to the REST command body, and POST to
   * `/valuations/commands/<commandPath>` — not a plain entity create
   * (Decision: layer 3, command edges).
   */
  private async createCommandRecord(
    input: WriteInput,
    command: CommandDescriptor,
  ): Promise<WriteResult> {
    const links = writeParentLinks(input);
    const body: Record<string, unknown> = {};
    for (const edge of COMMAND_EDGES.filter((e) => e.target === command.target)) {
      const link = links.find(
        (l) => l.recordType === edge.parent && (l.edgeName === edge.name || l.edgeName === edge.fieldId),
      );
      if (!link) {
        throw new Error(
          `NativeValuationsAdapter.createRecord(${command.target}): missing the ` +
            `${edge.parent} parent for role '${edge.name}' — write it via -[:${edge.name}]->.`,
        );
      }
      body[edge.parentRole] = link.externalId;
    }
    for (const [name, value] of Object.entries(input.fields)) {
      const key = command.fieldMap[naturalName(name)] ?? command.fieldMap[name];
      if (key === undefined) {
        throw new Error(
          `NativeValuationsAdapter.createRecord(${input.recordType}): unknown field '${name}'.`,
        );
      }
      if (value !== undefined && value !== null) body[key] = value;
    }
    const creds = await this.requireCreds();
    const response = await valuationsFetch<ValuationsRecordResponse<Record<string, unknown>>>(
      creds,
      { method: 'POST', path: `/api/v1/valuations/commands/${command.commandPath}`, body },
    );
    return {
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      // The command's own id (the markdown event / the investment). Layer 4
      // makes the receipt walkable.
      externalId: String(response.data[command.resultId] ?? ''),
      data: response.data ?? {},
    };
  }

  async createRecord(input: WriteInput): Promise<WriteResult> {
    const command = COMMAND_BY_TARGET.get(input.recordType);
    if (command) return this.createCommandRecord(input, command);
    const { entity, fields } = await this.toInternalWrite(input);
    for (const link of writeParentLinks(input)) {
      this.injectParentLink({ link, childType: entity.displayName, fields });
    }
    const creds = await this.requireCreds();
    const response = await valuationsFetch<ValuationsRecordResponse<Record<string, unknown>>>(
      creds,
      {
        method: 'POST',
        path: `/api/v1/valuations/${entity.slug}`,
        body: withoutEmptyFields(fields),
      },
    );
    return {
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      externalId: String(response.data.id ?? ''),
      data: response.data ?? {},
    };
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    const { entity, fields } = await this.toInternalWrite(input);
    const creds = await this.requireCreds();
    // NOT-FOUND contract (3b): a PATCH to a record the service no longer
    // has 404s — surface the typed signal so bind self-heal re-mints.
    //
    // A parent here is a foreign key COLUMN on the child, stamped when the
    // child is created. Re-pointing it on a matched row would move an existing
    // transaction to a different investment — a destructive re-parenting no
    // author asked for by naming an edge — so the update never writes one. It
    // reports what the row already says instead: `already` when the key
    // already names the parent, `unsupported` when it names something else.
    const path = `/api/v1/valuations/${entity.slug}/${input.externalId}`;
    let response: ValuationsRecordResponse<Record<string, unknown>>;
    try {
      response = await valuationsFetch<ValuationsRecordResponse<Record<string, unknown>>>(
        creds,
        Object.keys(fields).length === 0
          ? { method: 'GET', path }
          : { method: 'PATCH', path, body: fields },
      );
    } catch (e) {
      if (isHttp404(e)) return UPDATE_NOT_FOUND;
      throw e;
    }
    return {
      adapterType: NATIVE_VALUATIONS_ADAPTER_TYPE,
      externalId: input.externalId,
      data: response.data ?? {},
      association: this.parentKeysAlreadySet({
        input,
        childType: entity.displayName,
        record: response.data ?? {},
      }),
    };
  }

  /** Whether every parent the write named is the parent the row's foreign keys
   *  already name. The row comes back from the same call the update already
   *  made, so this costs nothing extra. */
  private parentKeysAlreadySet(args: {
    input: UpdateInput;
    childType: string;
    record: Record<string, unknown>;
  }): ParentAssociation {
    const links = writeParentLinks(args.input);
    if (links.length === 0) return 'none';
    for (const link of links) {
      const edge = DOWN_EDGES.find(
        (e) =>
          e.parent === link.recordType &&
          e.target === args.childType &&
          (e.name === link.edgeName || e.fieldId === link.edgeName),
      );
      if (!edge) return 'unsupported';
      if (String(args.record[edge.childFk] ?? '') !== String(link.externalId)) {
        return 'unsupported';
      }
    }
    return 'already';
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    // `recordType` is the entity's NATURAL name — recover its REST slug from the
    // structured-id map.
    const entity = this.requireStructuredId(input.recordType, 'deleteRecord');
    const creds = await this.requireCreds();
    await valuationsFetch<unknown>(creds, {
      method: 'DELETE',
      path: `/api/v1/valuations/${entity.slug}/${input.externalId}`,
    });
    return {};
  }

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    // `recordType` is the entity's NATURAL name — recover its REST slug from the
    // structured-id map. No-op detection is best-effort, so an unresolved type
    // degrades to null, not a throw.
    const entity = this.structuredIdFor(input.recordType);
    if (!entity) return null;
    if (!this.credentialsId) return null;
    try {
      const creds = await loadValuationsCredentials(this.credentialsId);
      const response = await valuationsFetch<ValuationsRecordResponse<Record<string, unknown>>>(
        creds,
        { method: 'GET', path: `/api/v1/valuations/${entity.slug}/${input.externalId}` },
      );
      // The REST record is keyed by Valuations' own column names; the caller
      // asked in the write's currency (the surface field names it is about to
      // write). Answer in the currency it asked in, or `?:` and no-op
      // suppression compare a value against a key that is never there — which
      // reads as "empty" and overwrites what is already on the record.
      const requested = input.fieldIds ?? [];
      if (requested.length === 0) return response.data;
      const resolver = await this.resolver({ types: [input.recordType] });
      const type = naturalName(input.recordType);
      const current: Record<string, unknown> = {};
      for (const name of requested) {
        current[name] = response.data[resolver.fieldId(type, naturalName(name))];
      }
      return current;
    } catch (err) {
      logger.warn('[NativeValuationsAdapter] readRecord failed; returning null', {
        recordType: input.recordType,
        externalId: input.externalId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── 6b. Filter pushdown — minimal ──

  async translateFilter(_input: {
    expression: Expression;
    entityType: string;
  }): Promise<FilterTranslationResult> {
    // `entityType` arrives as the NATURAL type name. Nothing is pushed down
    // today (snapshot scope is client-side), so no internal typeId is consumed
    // here; the whole expression is returned as residual. Translation becomes
    // load-bearing once per-entity native filters are wired up.
    return { native: undefined, residual: _input.expression };
  }

  // ── Internals ──

  private async requireCreds(): Promise<ValuationsCredentials> {
    if (!this.credentialsId) {
      throw new Error(
        `NativeValuationsAdapter requires credentialsId; the pipeline_output row is missing one. Provision an api-key with the 'valuations' scope and reference it via pipeline_output.credentials_id.`,
      );
    }
    return loadValuationsCredentials(this.credentialsId);
  }
}

export function createNativeValuationsAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): Adapter {
  return new NativeValuationsAdapter(input.teamId, input.credentialsId);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * The record row inside a Valuations webhook envelope. The outbox worker emits
 * `{event, timestamp, actor, data: {id, before, after}}`; the entity's row is
 * the post-change snapshot (`after`), or the pre-change one on delete
 * (`before`). Returns null when `data` isn't that envelope — e.g. a record
 * fetched from the REST API, which is already the flat row.
 */
function webhookEnvelopeRow(data: unknown): Record<string, unknown> | null {
  if (data === null || typeof data !== 'object') return null;
  const envelope = data as { event?: unknown; data?: { after?: unknown; before?: unknown } };
  if (
    typeof envelope.event !== 'string' ||
    envelope.data === null ||
    typeof envelope.data !== 'object'
  ) {
    return null;
  }
  const row = envelope.data.after ?? envelope.data.before ?? null;
  return row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

function readDotPath(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * A create has no existing value to clear, so a field with nothing in it is a
 * field the caller did not set — `Field ?: <something the source didn't have>`
 * is exactly that. The entity create schemas take an absent optional field and
 * refuse an explicit null, so send neither. (The command create path has always
 * done this; see `createCommandRecord`.) An update keeps its nulls: clearing a
 * field there is the point.
 */
function withoutEmptyFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
  );
}

/** How many rows one identity search reads. The list endpoints answer newest
 *  first and `search` already narrows to the name, so a page is a shortlist,
 *  not a scan. */
const IDENTITY_SEARCH_LIMIT = 100;

/** The columns a descriptor lets `FUZZY` name: none, every field, or the
 *  listed ones. */
function fuzzyColumnsOf(descriptor: SchemaTypeDescriptor | undefined): ReadonlySet<string> {
  const declared = descriptor?.supportsFuzzyResolution;
  if (declared === undefined || declared === false) return new Set();
  if (declared === true) return new Set(descriptor?.fields.map((f) => f.fieldId) ?? []);
  return new Set(declared);
}

/** Every fuzzy-matchable value the row carries, under its surface name, so
 *  the judge sees the alias or legal name that put the row on the shortlist. */
function fuzzyFieldsOf(args: {
  row: Record<string, unknown>;
  descriptor: SchemaTypeDescriptor | undefined;
  fuzzyColumns: ReadonlySet<string>;
}): Record<string, unknown> {
  const names: Record<string, unknown> = {};
  for (const field of args.descriptor?.fields ?? []) {
    if (!args.fuzzyColumns.has(field.fieldId)) continue;
    const value = args.row[field.fieldId];
    if (value !== null && value !== undefined) names[field.displayName] = value;
  }
  return names;
}

function identityFieldAgrees(column: string, asserted: unknown, stored: unknown): boolean {
  return column === 'personal_website'
    ? websitesAgree(asserted, stored)
    : valuationsFieldsAgree(asserted, stored);
}

/** The same site written two ways (`https://www.acme.com/` and `acme.com`) is
 *  one identity: compare without scheme, `www.`, trailing slash or case. */
function websitesAgree(asserted: unknown, stored: unknown): boolean {
  if (typeof asserted !== 'string' || typeof stored !== 'string') return false;
  const bare = normaliseWebsite(asserted);
  return bare !== '' && bare === normaliseWebsite(stored);
}

function normaliseWebsite(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** Identity equality as Valuations stores it: text compares case-insensitively
 *  (the list `search` filter already does), and a multi-valued column matches
 *  when the asserted scalar is one of its values. */
function valuationsFieldsAgree(asserted: unknown, stored: unknown): boolean {
  if (asserted === null || asserted === undefined) return false;
  if (stored === null || stored === undefined) return false;
  const target = String(asserted).trim().toLowerCase();
  const pool = Array.isArray(stored) ? stored : [stored];
  return pool.some((v) => v !== null && v !== undefined && String(v).trim().toLowerCase() === target);
}
