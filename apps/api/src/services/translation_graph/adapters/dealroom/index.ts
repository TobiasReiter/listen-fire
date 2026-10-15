// Dealroom adapter — the market-intelligence database: companies, investors,
// people and funding rounds, and the relationships between them.
//
// Dealroom is READ-ONLY and a POLLED source: there are no webhooks anywhere in
// the API, so event production lives on the PollSource (dealroom/poll.ts). This
// is the read half. The type graph itself is `schema.ts`; the WHERE and ORDER BY
// pushdown is `filter.ts`.

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type {
  Adapter,
  AdapterManifest,
  EdgesFromResult,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  ReadInput,
  RelatedResult,
} from 'movement-engine/services/translation_graph/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/services/translation_graph/types';

import ExternalServiceType from '../../../../generated/kysely/automations/ExternalServiceType';
import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
  positionRecordId,
} from 'movement-engine/services/translation_graph/types';
import { BaseAdapter } from '../base';
import { uniformWalk } from '../hop';
import {
  DealroomApiError,
  DEALROOM_MAX_LIMIT,
  labelsOf,
  parseDealroomInstant,
  type DealroomApiClient,
  type DealroomCompany,
  type DealroomFund,
  type DealroomFundingRound,
  type DealroomInvestor,
  type DealroomLabelList,
  type DealroomPage,
  type DealroomPerson,
  type DealroomRoundInvestor,
  type DealroomSearchRequest,
  type DealroomSubResourceRequest,
  type DealroomTeamMember,
} from '../../../../adapters/dealroom/apiClient';
import { resolveDealroomClient } from './client';
import {
  orderIsPushable,
  searchFromWhere,
  sortFromOrderBy,
  teamRequestFromWhere,
} from './filter';
import {
  DEALROOM_ROOT,
  DEALROOM_SEARCH_FIELDS,
  DEALROOM_DATABASE_DESCRIPTOR,
  describeDealroomType,
  dealroomEntryPoints,
} from './schema';
import {
  DEALROOM_ADAPTER_TYPE,
  DEALROOM_COMPANIES_COLLECTION,
  DEALROOM_COMPANY_DISPLAY_NAME,
  DEALROOM_COMPANY_INVESTORS_EDGE,
  DEALROOM_COMPANY_ROUNDS_EDGE,
  DEALROOM_COMPANY_SIMILAR_EDGE,
  DEALROOM_COMPANY_TEAM_EDGE,
  DEALROOM_COMPANY_TYPE_ID,
  DEALROOM_DATABASE_TYPE_ID,
  DEALROOM_FUNDING_ROUNDS_COLLECTION,
  DEALROOM_FUNDING_ROUND_DISPLAY_NAME,
  DEALROOM_FUNDING_ROUND_EVENT,
  DEALROOM_FUNDING_ROUND_EVENT_TAG,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  DEALROOM_FUND_DISPLAY_NAME,
  DEALROOM_FUND_TYPE_ID,
  DEALROOM_INVESTORS_COLLECTION,
  DEALROOM_INVESTOR_CO_INVESTORS_EDGE,
  DEALROOM_INVESTOR_DISPLAY_NAME,
  DEALROOM_INVESTOR_FUNDS_EDGE,
  DEALROOM_INVESTOR_INVESTMENTS_EDGE,
  DEALROOM_INVESTOR_ROUNDS_EDGE,
  DEALROOM_INVESTOR_TEAM_EDGE,
  DEALROOM_INVESTOR_TYPE_ID,
  DEALROOM_PEOPLE_COLLECTION,
  DEALROOM_PERSON_COMPANIES_EDGE,
  DEALROOM_PERSON_DISPLAY_NAME,
  DEALROOM_PERSON_TYPE_ID,
  DEALROOM_ROUND_COMPANY_EDGE,
  DEALROOM_ROUND_INVESTORS_EDGE,
  DEALROOM_ROUND_INVESTOR_DISPLAY_NAME,
  DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE,
  DEALROOM_ROUND_INVESTOR_TYPE_ID,
  DEALROOM_SUBSCRIBABLE_EVENTS,
  DEALROOM_TEAM_MEMBER_DISPLAY_NAME,
  DEALROOM_TEAM_MEMBER_PERSON_EDGE,
  DEALROOM_TEAM_MEMBER_TYPE_ID,
  decodePairId,
  encodePairId,
} from './types';

export {
  DEALROOM_ADAPTER_TYPE,
  DEALROOM_COMPANY_TYPE_ID,
  DEALROOM_DATABASE_TYPE_ID,
  DEALROOM_FUNDING_ROUND_EVENT_TAG,
  DEALROOM_FUNDING_ROUND_TYPE_ID,
  DEALROOM_INVESTOR_TYPE_ID,
  DEALROOM_PERSON_TYPE_ID,
};

const DEALROOM_HANDBOOK_CONTENT = `Dealroom is a database of \`Companies\`, \`Investors\`, \`People\` and \`Funding Rounds\`, with the links between them. It is read-only: look something up by name or domain, walk out to what it is connected to, and react to new rounds.

### looking something up

\`\`\`
company = FIRST(dealroom-[c:Companies WHERE \`Website\` = "acme.com"]->)
\`\`\`

A domain is the surest way to land on one company; a \`Name\` equality is an exact-name search and \`contains\` is a fuzzy one. Filter on \`Website\`, the domain on its own — \`Website URL\` holds the full URL and is applied after the fetch. Dealroom takes part of the WHERE itself and the rest is applied to what comes back, so the result is the same either way — only the amount fetched changes. What reaches Dealroom on \`Companies\`: \`Name\`, \`Website\`, \`Industries\`, \`Tags\`, \`Growth Stage\`, \`Company Status\`, \`HQ City\`, \`HQ Country\`, \`Total Funding\` and \`Launch Year\` bounds, and lower bounds on \`Last Updated\` and \`Created At\`. \`Investors\` takes \`Name\`, \`Website\`, \`Investor Type\`, \`Investment Stages\`, \`Industry Experience\` and the HQ location; \`People\` takes \`Name\`, \`Website\`, \`Gender\`, \`Backgrounds\`, the HQ location and flags like \`Is Strong Founder\`; \`Funding Rounds\` takes \`Round\`, \`Date\` bounds, \`Amount\` bounds and \`Is Verified\`.

An \`ORDER BY\` on \`Name\`, \`Total Funding\`, \`Last Updated\` or \`Created At\` reaches Dealroom's own sort, so \`LIMIT 5\` is one page rather than a scan. An unbounded walk stops at Dealroom's 10,000-result ceiling with an error rather than a short answer — narrow it or bound it.

### walking out from a company

\`\`\`
company-[r:Funding Rounds]-> { … }
company-[i:Investors]-> { … }
company-[t:Team WHERE \`Is Founder\` = true]-> { … }
\`\`\`

Each of these is the FULL list from its own endpoint, not the five that ride the company record. \`Similar Companies\` is Dealroom's own "companies like this one".

Give every fold over a Dealroom walk — \`JOIN\`, \`FIRST\`, \`LAST\`, \`LIMIT\` — an explicit \`ORDER BY\`, since Dealroom hands a walk back in no inherent order:

\`\`\`
rounds = JOIN(company-[r:\`Funding Rounds\` ORDER BY \`Date\` DESC]->.\`Round\`, ", ")
\`\`\`

\`Team\` lands on a membership rather than the person: \`Titles\`, \`Is Founder\`, \`Is Executive\`, \`Is Partner\`, \`Past\`, \`Start Year\` and \`End Year\` are facts about the pair. \`Person\` from there is the full profile, and costs a fetch.

An \`Investor\` walks to \`Investments\`, \`Funding Rounds\`, \`Co-Investors\`, \`Funds\` and \`Team\` the same way. A person walks to \`Companies\` — that one rides the person's own record, so it costs nothing and carries the summary fields rather than the full company.

### rounds

A round's \`Company\` is who raised. Its \`Investors\` are participations, not backers themselves: \`Lead\` is a fact about the pair, and \`Investor\` from one is the full record. \`Unknown Investors\` are names Dealroom has no record for, so they are NOT on \`Investors\`.

\`Date\` is the round's year and month as a date — Dealroom records no day, so every round in a month reads as the first of it.

### listening — a new round

\`\`\`
listen to dealroom { rounds: ["SERIES A"], hq_locations: ["Europe"] } fire triage
\`\`\`

A listener fires once per round Dealroom RECORDED since the last look. The FIRST look sets the mark and delivers nothing, so going live never replays the back catalogue — walk \`Funding Rounds\` when you want history. \`rounds\`, \`industries\` and \`hq_locations\` narrow delivery; \`pollIntervalSeconds\` overrides the ten-minute default. A round that is corrected afterwards does not fire again: recording is the only "new since" Dealroom offers.

### what is deliberately not here

Universities and alumni, news feeds, traffic and social analytics, the bulk and dump exports, the filter catalogues, the location lookup, the removed-entity and GDPR logs, and the "tell Dealroom about a company it is missing" endpoint are each one endpoint away and not surfaced — say so rather than working around them. Nothing is writable: Dealroom is a database you read.`;

/**
 * Static manifest. A polled source with no write surface at all — Dealroom's
 * only mutating endpoint asks their team to research a company it is missing,
 * which is a support request rather than a record write.
 */
export const DEALROOM_MANIFEST: AdapterManifest = {
  adapterType: DEALROOM_ADAPTER_TYPE,
  displayName: 'Dealroom',
  website: 'https://dealroom.co',
  category: 'CRM',
  description:
    'Dealroom is a database of startups, investors, founders and funding ' +
    'rounds. Look a company or investor up by name or domain, walk to its ' +
    'rounds, backers and team, and run when a new round is recorded.',
  authoringHints:
    'Dealroom is read-only — there is no write surface. Land on one company by ' +
    'Website (the domain on its own) rather than Name; Website URL holds the ' +
    'full URL and filters after the fetch. A root walk with no WHERE covers the ' +
    'corpus and fails at the 10,000-result ceiling, so narrow it or give it a ' +
    'LIMIT. Every fold over a Dealroom walk — JOIN, FIRST, LAST, LIMIT — needs ' +
    'an explicit ORDER BY, as in ORDER BY `Date` DESC. ' +
    'Team memberships and a round’s investors are nodes in their own right ' +
    'because the titles and the lead flag belong to the pair; walk Person or ' +
    'Investor from one for the full record, at the cost of a fetch. A listener ' +
    'fires on rounds Dealroom recorded since the last poll, and the first poll ' +
    'delivers nothing.',
  handbookSection: {
    title: 'Dealroom: companies, investors, rounds',
    content: DEALROOM_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'One kind: `funding_round`. It fires once per round Dealroom RECORDED ' +
    'since the last poll (`created_utc`), narrowed by the `rounds`, ' +
    '`industries` and `hq_locations` listen options, each a Dealroom terms ' +
    'filter. The first poll sets the checkpoint and emits nothing, so going ' +
    'live never replays the back catalogue. A round that is edited afterwards ' +
    'does NOT fire — Dealroom offers no changed-since mark other than ' +
    'recording. Companies, investors and people do not fire at all; the same ' +
    'question is a root walk with a `Created At` lower bound.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'readRecord'],
  requiredCredentialType: ExternalServiceType.DEALROOM,
  // `events` is projected from `subscribableEvents` — Dealroom has no webhook
  // to subscribe to, but the value is what types the listened parameter and
  // what the poll source reads to decide what to fetch.
  subscribableEvents: [...DEALROOM_SUBSCRIBABLE_EVENTS],
  defaultSubscribedEvents: [DEALROOM_FUNDING_ROUND_EVENT],
  listenConfig: [
    { key: 'rounds', required: false },
    { key: 'industries', required: false },
    { key: 'hq_locations', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['DEALROOM'],
  vocabulary: {
    // A stroke "D" — the mark opens with a moveto, as path data must.
    icon: {
      d: 'M8 5 H13 A7 7 0 0 1 13 19 H8 Z',
      fill: false,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [{ template: 'When Dealroom records a new funding round' }],
    },
  },
};

/** Display name → this adapter's internal typeId, for the reads that need to
 *  know WHICH type a position carries (the computed-field table below). */
const TYPE_ID_BY_DISPLAY_NAME: Record<string, string> = {
  [DEALROOM_COMPANY_DISPLAY_NAME]: DEALROOM_COMPANY_TYPE_ID,
  [DEALROOM_INVESTOR_DISPLAY_NAME]: DEALROOM_INVESTOR_TYPE_ID,
  [DEALROOM_PERSON_DISPLAY_NAME]: DEALROOM_PERSON_TYPE_ID,
  [DEALROOM_FUNDING_ROUND_DISPLAY_NAME]: DEALROOM_FUNDING_ROUND_TYPE_ID,
  [DEALROOM_TEAM_MEMBER_DISPLAY_NAME]: DEALROOM_TEAM_MEMBER_TYPE_ID,
  [DEALROOM_ROUND_INVESTOR_DISPLAY_NAME]: DEALROOM_ROUND_INVESTOR_TYPE_ID,
  [DEALROOM_FUND_DISPLAY_NAME]: DEALROOM_FUND_TYPE_ID,
};

/** Taxonomy lists Dealroom spells as `{id,name}` objects or bare strings —
 *  flattened to the names a movement reads. */
const LABEL_FIELDS = new Set([
  'industries',
  'sub_industries',
  'technologies',
  'tags',
  'investment_stages',
  'industry_experience',
  'location_experience',
  'backgrounds',
  'titles',
]);

/** Fields whose stored value is a Dealroom timestamp but whose declared kind is
 *  `date` — read back as an ISO instant so comparisons and formatting behave
 *  like every other adapter's dates. */
const INSTANT_FIELDS = new Set(['last_updated_utc', 'created_utc']);

/** A plain object, narrowed. Position payloads were parsed by the client's zod
 *  schemas on the way in, so the shape is known — this is the read-side
 *  narrowing, not a boundary assertion. */
function objectAt(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringAt(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isoOf(value: unknown): string | null {
  const ms = parseDealroomInstant(value);
  return ms === undefined ? null : new Date(ms).toISOString();
}

/**
 * The host of a URL, scheme and `www.` stripped — what `Website` reads and what
 * Dealroom's own `website_domain` search matches. `Website URL` keeps the URL
 * whole, so the two never have to agree on a spelling.
 */
function hostOf(value: unknown): string | null {
  const url = stringAt(value);
  if (url === null) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/** The logo Dealroom serves at the one size worth surfacing. */
function logoUrl(data: Record<string, unknown>): string | null {
  return stringAt(objectAt(data['images'])?.['100x100']);
}

/**
 * The headquarters city or country. Dealroom carries a list of locations and
 * flags one as the headquarters; where nothing is flagged the first is the best
 * answer available, which beats reading null off a record that has a location.
 */
function headquarters(data: Record<string, unknown>, part: 'city' | 'country'): string | null {
  const raw = data['hq_locations'];
  const locations = (Array.isArray(raw) ? raw : [])
    .map(objectAt)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const chosen = locations.find((entry) => entry['is_headquarters'] === true) ?? locations[0];
  if (chosen === undefined) return null;
  return stringAt(objectAt(chosen[part])?.['name']);
}

/** A round's date. Dealroom records the year and the month and no day, so every
 *  round in a month reads as the first of it — the field's description says so
 *  rather than the value pretending to a precision it has not got. */
function roundDate(data: Record<string, unknown>): string | null {
  const year = data['year'];
  if (typeof year !== 'number') return null;
  const month = data['month'];
  const index = typeof month === 'number' && month >= 1 && month <= 12 ? month - 1 : 0;
  return new Date(Date.UTC(year, index, 1)).toISOString();
}

/** The fields Dealroom does not carry literally — a logo buried in a size map,
 *  a location flagged inside a list, a taxonomy spelled as objects, and the
 *  round date Dealroom splits across two columns. */
function computedField(
  typeId: string,
  fieldId: string,
  data: Record<string, unknown>,
): unknown | undefined {
  if (fieldId === 'logoUrl') return logoUrl(data);
  if (fieldId === 'website') return hostOf(data['website_url']);
  if (fieldId === 'hqCity') return headquarters(data, 'city');
  if (fieldId === 'hqCountry') return headquarters(data, 'country');
  if (LABEL_FIELDS.has(fieldId)) return labelsOf(data[fieldId] as DealroomLabelList);
  if (INSTANT_FIELDS.has(fieldId)) return isoOf(data[fieldId]);
  if (typeId === DEALROOM_FUNDING_ROUND_TYPE_ID && fieldId === 'date') return roundDate(data);
  if (typeId === DEALROOM_FUND_TYPE_ID && fieldId === 'date') {
    return isoOf(data['date_utc']) ?? isoOf(data['date']) ?? stringAt(data['date']);
  }
  return undefined;
}

export class DealroomAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = DEALROOM_ADAPTER_TYPE;
  readonly supportedTriggers = DEALROOM_MANIFEST.supportedTriggers;

  constructor(
    readonly teamId: TeamId,
    readonly credentialsId?: string,
    /** Injectable for tests; production resolves a credentialed client from
     *  `teamId` + `credentialsId` (the same path the poll source rides). */
    private readonly clientOverride?: DealroomApiClient,
  ) {
    super();
  }

  private async client(): Promise<DealroomApiClient> {
    const client =
      this.clientOverride ??
      (await resolveDealroomClient({ teamId: this.teamId, credentialsId: this.credentialsId }));
    if (!client) {
      throw new Error(
        `DealroomAdapter: no usable Dealroom credential for team ${this.teamId} ` +
          `(credentialsId=${this.credentialsId ?? 'unset'}). Connect Dealroom.`,
      );
    }
    return client;
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return dealroomEntryPoints();
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === DEALROOM_DATABASE_TYPE_ID) {
      return DEALROOM_DATABASE_DESCRIPTOR;
    }
    return describeDealroomType(await this.resolveTypeRef(typeRef));
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: DEALROOM_ADAPTER_TYPE,
      at: position,
      root: DEALROOM_ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  // ── 2. Field-level access ──────────────────────────────────────────────

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== DEALROOM_ADAPTER_TYPE) {
      throw new Error(
        `DealroomAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    const fieldId = await this.resolveFieldId(input.position, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const typeId = TYPE_ID_BY_DISPLAY_NAME[input.position.recordType ?? ''] ?? '';

    const computed = computedField(typeId, fieldId, data);
    if (computed !== undefined) return computed;
    return data[fieldId] ?? null;
  }

  // ── 3. Traversal ───────────────────────────────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== DEALROOM_ADAPTER_TYPE) {
      throw new Error(
        `DealroomAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`,
      );
    }
    if (input.direction !== 'outgoing') return [];

    // The root's collection names cross VERBATIM (a meta position carries no
    // type to resolve an edge against), so match them before the per-type edge
    // resolver, which would drift on the typeless meta position.
    if (input.position.recordType === META_RECORD_TYPE) return this.rootCollection(input);

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;
    const parentId = recordIdOf(data);
    const cap = limitWithoutOrder(input);

    switch (edgeId) {
      case DEALROOM_COMPANY_ROUNDS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const rounds = await pageThrough(
          (page) => client.listCompanyFundingRounds(parentId, page),
          cap,
        );
        return rounds.map(fundingRoundPosition);
      }
      case DEALROOM_COMPANY_INVESTORS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const investors = await pageThrough(
          (page) => client.listCompanyInvestors(parentId, page),
          cap,
        );
        return investors.map(investorPosition);
      }
      case DEALROOM_COMPANY_TEAM_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const roles = teamRequestFromWhere(input.where);
        const members = await pageThrough(
          (page) => client.listCompanyTeam(parentId, { ...page, ...roles }),
          cap,
        );
        return members.map((member) => teamMemberPosition(parentId, member));
      }
      case DEALROOM_COMPANY_SIMILAR_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const similar = await pageThrough(
          (page) => client.listSimilarCompanies(parentId, page),
          cap,
        );
        return similar.map(companyPosition);
      }
      case DEALROOM_INVESTOR_INVESTMENTS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const companies = await pageThrough(
          (page) => client.listInvestorInvestments(parentId, page),
          cap,
        );
        return companies.map(companyPosition);
      }
      case DEALROOM_INVESTOR_ROUNDS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const rounds = await pageThrough(
          (page) => client.listInvestorFundingRounds(parentId, page),
          cap,
        );
        return rounds.map(fundingRoundPosition);
      }
      case DEALROOM_INVESTOR_CO_INVESTORS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const investors = await pageThrough(
          (page) => client.listInvestorCoInvestors(parentId, page),
          cap,
        );
        return investors.map(investorPosition);
      }
      case DEALROOM_INVESTOR_FUNDS_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const funds = await pageThrough((page) => client.listInvestorFunds(parentId, page), cap);
        return funds.map((fund) => fundPosition(parentId, fund));
      }
      case DEALROOM_INVESTOR_TEAM_EDGE: {
        if (parentId === undefined) return [];
        const client = await this.client();
        const roles = teamRequestFromWhere(input.where);
        const members = await pageThrough(
          (page) => client.listInvestorTeam(parentId, { ...page, ...roles }),
          cap,
        );
        return members.map((member) => teamMemberPosition(parentId, member));
      }
      case DEALROOM_PERSON_COMPANIES_EDGE: {
        // The one many-edge with no endpoint behind it — the affiliations ride
        // the person's own record, so there is nothing to fetch or page.
        const companies = objectAt(data['companies'])?.['items'];
        const items = Array.isArray(companies) ? companies : [];
        return bounded(items, cap)
          .map(objectAt)
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .map(companyPosition);
      }
      case DEALROOM_TEAM_MEMBER_PERSON_EDGE: {
        // The membership's own id IS the person's, and the composite this node
        // carries keeps the pair apart — so the person is fetched by the half
        // of the pair that names them.
        const personId = decodePairId(positionRecordId(input.position) ?? '')?.childId;
        if (personId === undefined) return [];
        const client = await this.client();
        return [personPosition(await client.getPerson(personId))];
      }
      case DEALROOM_ROUND_COMPANY_EDGE: {
        const company = objectAt(data['company']);
        return company === undefined ? [] : [companyPosition(company)];
      }
      case DEALROOM_ROUND_INVESTORS_EDGE: {
        const roundId = parentId;
        if (roundId === undefined) return [];
        const raw = data['investors'];
        const items = Array.isArray(raw) ? raw : [];
        return bounded(items, cap)
          .map(objectAt)
          .filter((entry): entry is Record<string, unknown> => entry !== undefined)
          .map((investor) => roundInvestorPosition(roundId, investor));
      }
      case DEALROOM_ROUND_INVESTOR_INVESTOR_EDGE: {
        const investorId = decodePairId(positionRecordId(input.position) ?? '')?.childId;
        if (investorId === undefined) return [];
        const client = await this.client();
        return [investorPosition(await client.getInvestor(investorId))];
      }
      default:
        return [];
    }
  }

  /**
   * The meta root's collections. Each is one of Dealroom's four searches: the
   * WHERE reaches its filter body, the ORDER BY its `sort` and the LIMIT its
   * `limit`. What is not pushable is left to the engine, so the result is exact
   * regardless of how much travelled — only the amount fetched changes.
   */
  private async rootCollection(input: GetRelatedInput): Promise<RelatedResult[]> {
    const client = await this.client();
    switch (input.fieldId) {
      case DEALROOM_COMPANIES_COLLECTION: {
        const rows = await this.searchAll(DEALROOM_COMPANY_TYPE_ID, input, (request) =>
          client.searchCompanies(request),
        );
        return rows.map(companyPosition);
      }
      case DEALROOM_INVESTORS_COLLECTION: {
        const rows = await this.searchAll(DEALROOM_INVESTOR_TYPE_ID, input, (request) =>
          client.searchInvestors(request),
        );
        return rows.map(investorPosition);
      }
      case DEALROOM_PEOPLE_COLLECTION: {
        const rows = await this.searchAll(DEALROOM_PERSON_TYPE_ID, input, (request) =>
          client.searchPeople(request),
        );
        return rows.map(personPosition);
      }
      case DEALROOM_FUNDING_ROUNDS_COLLECTION: {
        const rows = await this.searchAll(DEALROOM_FUNDING_ROUND_TYPE_ID, input, (request) =>
          client.searchFundingRounds(request),
        );
        return rows.map(fundingRoundPosition);
      }
      default:
        return [];
    }
  }

  /**
   * Walk one of the searches. The hop's LIMIT rides along only when its ORDER BY
   * did — a limit taken without the sort it came with answers a different
   * question (`GetRelatedInput.limit`). Paging past 10,000 rows throws from the
   * client rather than returning a prefix.
   */
  private async searchAll<T>(
    typeId: string,
    input: GetRelatedInput,
    fetchPage: (request: DealroomSearchRequest) => Promise<DealroomPage<T>>,
  ): Promise<T[]> {
    const base = searchFromWhere(typeId, input.where);
    const sort = sortFromOrderBy(typeId, input.orderBy);
    const cap = orderIsPushable(typeId, input.orderBy) ? input.limit : undefined;
    const fields = DEALROOM_SEARCH_FIELDS[typeId];

    const rows: T[] = [];
    for (let offset = 0; ; offset += DEALROOM_MAX_LIMIT) {
      const size =
        cap === undefined ? DEALROOM_MAX_LIMIT : Math.min(DEALROOM_MAX_LIMIT, cap - rows.length);
      if (size <= 0) break;
      const page = await fetchPage({
        ...base,
        ...(fields !== undefined ? { fields } : {}),
        ...(sort !== undefined ? { sort } : {}),
        limit: size,
        offset,
      });
      rows.push(...page.items);
      if (page.items.length < size) break;
      if (page.total > 0 && rows.length >= page.total) break;
    }
    return bounded(rows, cap);
  }

  // ── 4. Read-back by id ─────────────────────────────────────────────────

  async readRecord(input: ReadInput): Promise<Record<string, unknown> | null> {
    const typeId = await this.resolveTypeRef(input.recordType);
    const client = await this.client();
    try {
      switch (typeId) {
        case DEALROOM_COMPANY_TYPE_ID:
          return { ...(await client.getCompany(input.externalId)) };
        case DEALROOM_INVESTOR_TYPE_ID:
          return { ...(await client.getInvestor(input.externalId)) };
        case DEALROOM_PERSON_TYPE_ID:
          return { ...(await client.getPerson(input.externalId)) };
        default:
          // Rounds, memberships, participations and funds have no fetch-by-id
          // behind them — nothing to read back.
          return null;
      }
    } catch (error) {
      if (error instanceof DealroomApiError && error.status === 404) return null;
      throw error;
    }
  }

  // ── 5. Event typing ────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // The PollSource tags every event it produces, so discrimination is by tag
    // alone — never by sniffing the payload.
    return [
      {
        tag: DEALROOM_FUNDING_ROUND_EVENT_TAG,
        positionType: DEALROOM_FUNDING_ROUND_TYPE_ID,
        match: { path: 'id', equals: [] },
      },
    ];
  }
}

/** Factory matching the registry's AdapterFactory signature. */
export function createDealroomAdapter(input: {
  teamId: TeamId;
  credentialsId?: string;
}): DealroomAdapter {
  return new DealroomAdapter(input.teamId, input.credentialsId);
}

// ── Position minting ────────────────────────────────────────────────────────
// Every Dealroom node has a durable id, so every position is STABLE. A
// membership and a round's participation carry a COMPOSITE id (parent + child)
// because the id the API gives them is the child's — two companies sharing a
// founder would otherwise mint one node for two different positions.

function recordIdOf(data: Record<string, unknown>): string | undefined {
  const id = data['id'];
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function position(
  recordType: string,
  recordId: string,
  data: Record<string, unknown>,
): RelatedResult {
  return {
    position: makeStablePosition({
      adapterType: DEALROOM_ADAPTER_TYPE,
      recordType,
      recordId,
      data,
    }),
  };
}

function companyPosition(company: DealroomCompany | Record<string, unknown>): RelatedResult {
  const data = { ...company };
  return position(DEALROOM_COMPANY_DISPLAY_NAME, recordIdOf(data) ?? '', data);
}

function investorPosition(investor: DealroomInvestor | Record<string, unknown>): RelatedResult {
  const data = { ...investor };
  return position(DEALROOM_INVESTOR_DISPLAY_NAME, recordIdOf(data) ?? '', data);
}

function personPosition(person: DealroomPerson): RelatedResult {
  const data = { ...person };
  return position(DEALROOM_PERSON_DISPLAY_NAME, recordIdOf(data) ?? '', data);
}

function fundingRoundPosition(round: DealroomFundingRound): RelatedResult {
  const data = { ...round };
  return position(DEALROOM_FUNDING_ROUND_DISPLAY_NAME, recordIdOf(data) ?? '', data);
}

function teamMemberPosition(parentId: string, member: DealroomTeamMember): RelatedResult {
  const data = { ...member };
  return position(
    DEALROOM_TEAM_MEMBER_DISPLAY_NAME,
    encodePairId({ parentId, childId: recordIdOf(data) ?? '' }),
    data,
  );
}

function roundInvestorPosition(
  roundId: string,
  investor: DealroomRoundInvestor | Record<string, unknown>,
): RelatedResult {
  const data = { ...investor };
  return position(
    DEALROOM_ROUND_INVESTOR_DISPLAY_NAME,
    encodePairId({ parentId: roundId, childId: recordIdOf(data) ?? '' }),
    data,
  );
}

function fundPosition(investorId: string, fund: DealroomFund): RelatedResult {
  const data = { ...fund };
  return position(
    DEALROOM_FUND_DISPLAY_NAME,
    encodePairId({ parentId: investorId, childId: recordIdOf(data) ?? '' }),
    data,
  );
}

// ── Paging ──────────────────────────────────────────────────────────────────

function bounded<T>(rows: T[], limit: number | undefined): T[] {
  return limit !== undefined && limit >= 0 ? rows.slice(0, limit) : rows;
}

/**
 * The LIMIT a sub-resource fetch may take, per the contract on
 * `GetRelatedInput.limit`: a limit only travels alongside the sort it came with,
 * and Dealroom's sub-resources take no sort at all. A hop that asked for an
 * order therefore fetches the whole list and lets the engine sort and slice it.
 */
function limitWithoutOrder(input: GetRelatedInput): number | undefined {
  return input.orderBy === undefined ? input.limit : undefined;
}

/**
 * Walk a paged Dealroom sub-resource. The envelope carries a `total`, so the
 * walk stops when it has that many — and a SHORT page ends it too, which is the
 * belt to the total's braces. A hop's LIMIT stops it earlier.
 */
async function pageThrough<T>(
  fetchPage: (request: DealroomSubResourceRequest) => Promise<DealroomPage<T>>,
  limit: number | undefined,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += DEALROOM_MAX_LIMIT) {
    const size =
      limit === undefined ? DEALROOM_MAX_LIMIT : Math.min(DEALROOM_MAX_LIMIT, limit - rows.length);
    if (size <= 0) break;
    const page = await fetchPage({ limit: size, offset });
    rows.push(...page.items);
    if (page.items.length < size) break;
    if (page.total > 0 && rows.length >= page.total) break;
  }
  return bounded(rows, limit);
}
