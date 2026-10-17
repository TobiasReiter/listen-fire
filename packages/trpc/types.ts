import * as movement_engine_public_adapter from 'movement-engine/public/adapter';
import { CapturedWrite } from 'movement-engine/public/adapter';
import * as story_view_view from 'story-view/view';
import { FieldType, CatalogSnapshot, InstanceSchema, LanguageVersion, Diagnostic } from 'movement-lang';
import * as _shared_expression_types from '@listen-fire/shared/expression/types';
import * as _prisma_client_runtime_library from '@prisma/client/runtime/library';
import * as _trpc_server_observable from '@trpc/server/observable';
import * as movement_engine_public_catalog from 'movement-engine/public/catalog';
import * as _prisma_client from '@prisma/client';
import * as _trpc_server from '@trpc/server';
import * as _trpc_server_dist_error_formatter from '@trpc/server/dist/error/formatter';
import * as _trpc_server_rpc from '@trpc/server/rpc';
import { WebSocketServer } from 'ws';

/** Represents the enum automations.ExternalServiceType */
export const enum ExternalServiceType {
    SLACK = "SLACK",
    AFFINITY = "AFFINITY",
    ATTIO = "ATTIO",
    PIPEDRIVE = "PIPEDRIVE",
    MAILGUN = "MAILGUN",
    TWILIO = "TWILIO",
    AIRTABLE = "AIRTABLE",
    GOOGLE = "GOOGLE",
    GOOGLE_GMAIL = "GOOGLE_GMAIL",
    DROPBOX = "DROPBOX",
    SLACK_QUERY = "SLACK_QUERY",
    GRANOLA = "GRANOLA",
    NATIVE_VALUATIONS = "NATIVE_VALUATIONS",
    NATIVE_KNOWLEDGE = "NATIVE_KNOWLEDGE",
    TELEGRAM = "TELEGRAM",
    REMOTE = "REMOTE",
    EVERTRACE = "EVERTRACE",
    DEALROOM = "DEALROOM"
}

/** Identifier type for automations.external_service_credentials */
export type ExternalServiceCredentialsId = string & {
    __brand: 'automations.external_service_credentials';
};

/** Identifier type for automations.webhook_subscription */
export type WebhookSubscriptionId = string & {
    __brand: 'automations.webhook_subscription';
};

/** `code_sent`: a code is on its way and the link is verified only once it
 *  comes back. `linked`: the link is verified already (the deployment trusts a
 *  signed-in user's claim) and there is no code to ask for. */
export type StartOutcome = {
    ok: true;
    outcome: 'code_sent';
    expiresAt: Date;
} | {
    ok: true;
    outcome: 'linked';
} | {
    ok: false;
    reason: 'cooldown' | 'too_many_sends' | 'number_taken';
};
export type ConfirmOutcome = {
    ok: true;
} | {
    ok: false;
    reason: 'no_active_code' | 'expired' | 'too_many_attempts' | 'invalid_code' | 'no_code_needed';
};

/** Represents the enum valuations.CurrencyIsoCode */
export const enum CurrencyIsoCode {
    CHF = "CHF",
    EUR = "EUR",
    GBP = "GBP",
    NOK = "NOK",
    SEK = "SEK",
    USD = "USD",
    DKK = "DKK"
}

export interface GroupKeyEntity {
    id: string | null;
    name: string | null;
}
export interface ValuationGroupKey {
    company?: GroupKeyEntity;
    investment?: GroupKeyEntity;
    investingEntity?: GroupKeyEntity;
    round?: GroupKeyEntity;
    degree?: number;
    asset?: {
        id: string;
        name: string;
        type: string;
    };
    /** Null on cash lots: a fact has no live exposure. */
    trackedEntity?: GroupKeyEntity | null;
}
export interface ValuationQueryRow {
    groupKey: ValuationGroupKey;
    /** Σ cash out, each lot at the rate on the day it moved. Positive. */
    cashPaid: number;
    /** Σ cash in, each lot at the rate on the day it moved. */
    cashReceived: number;
    /** Σ held positions at the latest price on or before the analysis date,
     *  converted at that date's rate. */
    heldValue: number;
    lotCount: number;
}
export interface ValuationQueryResult {
    currency: CurrencyIsoCode;
    asOfDate: Date;
    rows: ValuationQueryRow[];
    /** Assets we could not value. A missing price is reported, never counted as
     *  zero — an unpriced holding is an unknown, not an empty one. */
    warnings: string[];
}

/** Identifier type for core.team */
export type TeamId = string & {
    __brand: 'core.team';
};

/** Identifier type for core.user */
export type UserId = string & {
    __brand: 'core.user';
};

/** Identifier type for core.user_email */
export type UserEmailId = string & {
    __brand: 'core.user_email';
};

/** Identifier type for core.team_invite */
export type TeamInviteId = string & {
    __brand: 'core.team_invite';
};

/** One would-be write the movement produced under dry-run — the
 *  `CapturedWrite` currency, surfaced verbatim to the UI. */
export type MovementTestRunWrite = CapturedWrite;
export type MovementTestRunResult = {
    ok: true;
    /** The synthetic inbound payload we made up — shown to the author so
     *  they can see what the run was fed (the source-side event). */
    event: Record<string, unknown>;
    /** Would-create / would-update / would-link intents, in program order. */
    writes: MovementTestRunWrite[];
    /** Honest gaps surfaced while assembling the run (catalog notes). */
    notes: string[];
} | {
    ok: false;
    error: string;
};

/** Identifier type for automations.trigger_event */
export type TriggerEventId = string & {
    __brand: 'automations.trigger_event';
};

/**
 * Plain-English status derivation for an automation (automations.trigger +
 * its bound TGs). Shared between the home dashboard (U3) and the
 * automation list/detail (U4) so both surfaces agree on the badge
 * colour and label.
 *
 * Status pill is the user-facing summary of "is this thing working?"
 * per principle 3 of the 2026-05-29 redesign. The set is fixed:
 *
 *   - **live**         — at least one bound TG body has roots AND the
 *                        last run wasn't an error (or there have been
 *                        no errors in the lookback window).
 *   - **setting_up**   — at least one bound TG body is empty/placeholder
 *                        OR no runs ever AND the trigger was created
 *                        recently. The Setup or Translation agent owes
 *                        the user a next step.
 *   - **error**        — the most recent run errored. The user needs to
 *                        know.
 *   - **paused**       — explicit pause flag. Reserved for when we add
 *                        one; today nothing returns this.
 *
 * The thresholds below are intentionally generous; this is a triage
 * heuristic, not a SLA. Edge cases (a trigger that was live yesterday
 * but had a transient error this morning) fall into `error` — the
 * user surfaces the recent error and can investigate.
 *
 */
export type AutomationStatus = 'live' | 'setting_up' | 'paused' | 'error';

export type TriggerRunMode = 'off' | 'dry_run' | 'live';

export type TriggerListItem = {
    id: string;
    name: string;
    kind: string;
    kindLabel: string;
    configSummary: string;
    boundTgCount: number;
    createdAt: Date;
    updatedAt: Date;
};
/**
 * A source a user can start a manual automation from — surfaced in the
 * "Create automation" modal's source picker. `connected` is false when
 * the adapter needs a credential the team hasn't authorised yet; such
 * sources still appear (flagged "connect first") so the picker shows the
 * full menu of what the system supports.
 */
export type CreatableSource = {
    adapterType: string;
    name: string;
    /** Uppercase trigger kind the created `automations.trigger.kind` takes. */
    triggerKind: string;
    needsConnection: boolean;
    connected: boolean;
};
export type TriggerDetail = {
    id: string;
    name: string;
    kind: string;
    kindLabel: string;
    config: unknown;
    credentialsId: string | null;
    provisionedBySetupAgent: boolean;
    createdAt: Date;
    updatedAt: Date;
    /**
     * Retired with the TG storage layer (kill-tg phase 6). Schema types
     * and bound TGs no longer exist; both are kept on the shape (always
     * empty) so the web detail page stays type-stable.
     */
    schemaTypes: Array<{
        id: string;
        name: string;
    }>;
    entries: Array<never>;
};
export interface AutomationRecentEvent {
    id: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    failedAt: Date | null;
    failureReason: string | null;
    /** Total records written across the firing's steps. */
    nodesWritten: number;
    /** True when the firing ran in dry-run mode — it captured writes but
     *  committed nothing. The activity feed badges it as a preview. */
    dryRun: boolean;
    summary: string;
}
export interface AutomationDetail {
    id: string;
    name: string;
    kind: string;
    kindLabel: string;
    summarySentence: string;
    status: AutomationStatus;
    statusLabel: string;
    /** Why the automation is in this status (mainly for "Setting up" /
     *  "Error"); null when the status is self-explanatory. */
    statusDetail: string | null;
    /** Per-automation liveness, READ-ONLY: dry_run (runs but captures writes
     *  instead of committing) or live, both derived from the movement text on
     *  every save. `off` still appears on rows that predate the operator-pause
     *  removal; nothing can set it any more. */
    runMode: TriggerRunMode;
    /** Set when the loop guard has paused this automation (distinct from the
     *  retired run_mode 'off'). The UI offers a "Resume" control and shows why
     *  the guard stepped in. Null when not safety-paused. */
    guardPaused: {
        pausedAt: string;
        reason: string | null;
        signal: string | null;
    } | null;
    /** The orchestration program tree was retired with the TG storage layer
     *  (kill-tg phase 6). Movement-derived triggers render via the movement
     *  link, so this is always null; kept on the shape for web type-stability. */
    program: null;
    /** The trigger's incoming feed (adapter + credentials), used by the
     *  branch editor to resolve condition fields. */
    triggerSource: {
        adapterKind: string;
        credentialsId: string | null;
    };
    /** The source's credential binding. `requiredCredentialType` is null when
     *  the source needs no connection (the UI hides the control then).
     *  Otherwise the UI shows the bound credential (or "not connected") and
     *  lets the user pick from `options` (the team's connections of that type). */
    connection: {
        requiredCredentialType: ExternalServiceType | null;
        credentialsId: string | null;
        credentialName: string | null;
        options: Array<{
            id: string;
            name: string;
        }>;
    };
    /** When the trigger is a listener compiled from a movement script, the
     *  movement it belongs to — the detail page links there instead of
     *  offering the orchestration editor. Null for hand-built automations. */
    movement: {
        id: string;
        name: string;
    } | null;
    recentEvents: AutomationRecentEvent[];
}

/** Represents the enum valuations.LegalEntityType */
export const enum LegalEntityType {
    COMPANY = "COMPANY",
    ESOP = "ESOP",
    FUND = "FUND",
    NATURAL_PERSON = "NATURAL_PERSON",
    PORTFOLIO_COMPANY = "PORTFOLIO_COMPANY",
    SPV = "SPV"
}

/** Represents the enum valuations.CompanyLegalStatus */
export const enum CompanyLegalStatus {
    ACTIVE = "ACTIVE",
    INACTIVE = "INACTIVE",
    DISSOLVED = "DISSOLVED"
}

/** Identifier type for valuations.legal_entity */
export type LegalEntityId = string & {
    __brand: 'valuations.legal_entity';
};

/** Identifier type for valuations.funding_changelog */
export type FundingChangelogId = string & {
    __brand: 'valuations.funding_changelog';
};

/** Represents the enum valuations.EquityRoundType */
export const enum EquityRoundType {
    PRE_PRE_SEED = "PRE_PRE_SEED",
    PRE_SEED = "PRE_SEED",
    SEED = "SEED",
    SEED_EXT = "SEED_EXT",
    SERIES_A = "SERIES_A",
    SERIES_A_EXT = "SERIES_A_EXT",
    SERIES_A2 = "SERIES_A2",
    SERIES_B = "SERIES_B",
    SERIES_B_EXT = "SERIES_B_EXT",
    SERIES_C = "SERIES_C",
    SERIES_C_EXT = "SERIES_C_EXT",
    SERIES_D = "SERIES_D",
    SERIES_E = "SERIES_E",
    SERIES_F = "SERIES_F",
    SERIES_G = "SERIES_G",
    SERIES_H = "SERIES_H",
    SERIES_I = "SERIES_I",
    SERIES_J = "SERIES_J",
    UNKNOWN = "UNKNOWN"
}

/** Represents the enum valuations.ConvertibleType */
export const enum ConvertibleType {
    ASA = "ASA",
    BSA_AIR = "BSA_AIR",
    CONVERTIBLE_NOTE = "CONVERTIBLE_NOTE",
    LOAN = "LOAN",
    POST_MONEY_SAFE = "POST_MONEY_SAFE",
    PRE_MONEY_SAFE = "PRE_MONEY_SAFE",
    SAFT = "SAFT",
    SEEDFAST = "SEEDFAST",
    SEEDNOTE = "SEEDNOTE",
    SLIP = "SLIP"
}

export type InvestingEntityId = string & {
    __brand: 'InvestingEntityId';
};
export type InvestingEntityName = string & {
    __brand: 'InvestingEntityName';
};
export type InvestingEntityKey = `${InvestingEntityId}:${InvestingEntityName}`;
export type AssetId$1 = string & {
    __brand: 'valuations.asset';
};
export type InvesteeEntityId = string & {
    __brand: 'InvesteeEntityId';
};
export type InvesteeEntityName = string & {
    __brand: 'InvesteeEntityName';
};
export type InvesteeEntityKey = `${InvesteeEntityId}:${InvesteeEntityName}`;

export type Flow = {
    assetId: AssetId$1;
    assetName: string;
    assetType: string;
    numAssets: number;
};
export type TransactionFlow = {
    transactionId: string;
    investmentId: string | null;
    inflows: Array<Flow>;
    outflows: Array<Flow>;
};
export type TransactionFlowClassification = 'CASH_INVESTMENT' | 'NON_CASH_INVESTMENT' | 'ASSET_EXCHANGE_FOR_NEW_INVESTMENT' | 'ASSET_EXCHANGE' | 'ASSET_PURCHASE' | 'UNRELATED_ASSET_EXCHANGE' | 'ONE_WAY_TRANSACTION';

/** Represents the enum valuations.InvestmentRoundType */
export const enum InvestmentRoundType {
    EQUITY = "EQUITY",
    CONVERTIBLE = "CONVERTIBLE",
    OTHER = "OTHER"
}

/** Represents the enum valuations.EventType */
export const enum EventType {
    FOUNDER_EQUITY_SPLIT = "FOUNDER_EQUITY_SPLIT",
    INVESTMENT_ROUND = "INVESTMENT_ROUND",
    SHARE_SPLIT = "SHARE_SPLIT",
    SHARE_REVERSE_SPLIT = "SHARE_REVERSE_SPLIT",
    SECONDARY_SALE = "SECONDARY_SALE",
    DISTRIBUTION = "DISTRIBUTION",
    DIVIDEND = "DIVIDEND",
    MARKDOWN = "MARKDOWN",
    FUND_DISTRIBUTION = "FUND_DISTRIBUTION",
    FUND_CLOSE = "FUND_CLOSE",
    SHARE_PRICE = "SHARE_PRICE",
    LIQUIDATION = "LIQUIDATION"
}

export type ProcessMessage = {
    level: 'info' | 'debug' | 'trace';
    timestamp: string;
} & ({
    type: 'text';
    content: string;
} | {
    type: 'header';
    content: string;
} | {
    type: 'table';
    content: TableContent;
});
export interface TableContent {
    headers: string[];
    rows: (string | number)[][];
}

export type ClassifiedTransactionFlow = TransactionFlow & {
    date: Date;
    eventId: string | null;
    convertedToId: string | null;
    dueToRightsFromAssetId: string | null;
    investingEntityKey: InvestingEntityKey;
    investeeEntityKey: InvesteeEntityKey;
    classification: TransactionFlowClassification;
};

/** Identifier type for valuations.note */
export type NoteId = string & {
    __brand: 'valuations.note';
};

/** Represents the enum valuations.PriceType */
export const enum PriceType {
    FROM_PRICED_ROUND = "FROM_PRICED_ROUND",
    FROM_ASSET_HOLDER = "FROM_ASSET_HOLDER",
    CONVERSION = "CONVERSION"
}

/** Represents the enum valuations.AssetType */
export const enum AssetType {
    CONVERTIBLE = "CONVERTIBLE",
    CURRENCY = "CURRENCY",
    EMPLOYEE_STOCK_OPTIONS = "EMPLOYEE_STOCK_OPTIONS",
    EQUITY = "EQUITY",
    EQUITY_UNKNOWN_SHARES = "EQUITY_UNKNOWN_SHARES",
    LP_INTEREST_POINT = "LP_INTEREST_POINT",
    SPV_INTEREST_POINT = "SPV_INTEREST_POINT",
    UNKNOWN = "UNKNOWN",
    FUND_OUTSTANDING_COMMITMENT = "FUND_OUTSTANDING_COMMITMENT",
    ACCRUED_INCOME = "ACCRUED_INCOME"
}

/** Represents the enum valuations.ValuationType */
export const enum ValuationType {
    PRE_MONEY = "PRE_MONEY",
    POST_MONEY = "POST_MONEY"
}

/** Identifier type for valuations.event */
export type EventId = string & {
    __brand: 'valuations.event';
};

/** Identifier type for valuations.asset */
export type AssetId = string & {
    __brand: 'valuations.asset';
};

/** Identifier type for valuations.price */
export type PriceId = string & {
    __brand: 'valuations.price';
};

/** Identifier type for valuations.investment */
export type InvestmentId = string & {
    __brand: 'valuations.investment';
};

/** Identifier type for valuations.transaction */
export type TransactionId = string & {
    __brand: 'valuations.transaction';
};

/** Identifier type for valuations.asset_transfer */
export type AssetTransferId = string & {
    __brand: 'valuations.asset_transfer';
};

export interface Acquisition {
    investmentId: string;
    fund: {
        id: string;
        name: string;
    };
    acquiredCompany: {
        id: string;
        name: string;
        slug: string | null;
    };
    date: string;
    sharesReceived: {
        assetId: string;
        assetName: string;
        quantity: number;
    }[];
    /**
     * What the fund paid for the acquired company in total, in `currency`. The
     * engine keeps no cost per share, so this is not the cost of just the shares
     * handed over in this swap: it equals that only when the swap took the
     * fund's whole holding, which is the usual acquisition.
     */
    acquiredCompanyCost: number | null;
    /** Shares received at the latest price, in `currency`; null if any is unpriced. */
    valueNow: number | null;
    /** Cash paid alongside the shares, at the rate on the day it arrived; null if none. */
    cashReceived: number | null;
    /** (value now + cash received) / acquired company cost. */
    multiple: number | null;
    currency: CurrencyIsoCode;
}

export interface HoldingRow {
    fundId: string;
    fundName: string;
    assetId: string;
    assetName: string;
    assetType: string;
    numAssets: number;
}

export type InvestmentStatus = 'active' | 'realised';

export type PluginCatalogEntry = {
    /** Registry name the engine dispatches on (e.g. `vc-url-retrieval`). */
    pluginName: string;
    /** The name a movement imports: `import { <importName> } from plugins`. */
    importName: string;
    name: string;
    description: string;
    /** Plain-language account of what the plugin adds to the data it runs on. */
    contextAdditions: string;
    params: {
        name: string;
        required: boolean;
        description: string;
    }[];
};

/** Represents the enum public.OpsRunStatus */
export const enum OpsRunStatus {
    running = "running",
    parked = "parked",
    completed = "completed",
    failed = "failed"
}

/** Represents the enum public.OpsEventType */
export const enum OpsEventType {
    PORTFOLIO = "PORTFOLIO",
    DEALFLOW = "DEALFLOW",
    DIRECTORY = "DIRECTORY",
    LIVE_FEED = "LIVE_FEED",
    ONBOARDING = "ONBOARDING",
    SCHEDULED_COMMS = "SCHEDULED_COMMS",
    SUPPORT = "SUPPORT",
    SOCIAL = "SOCIAL",
    METRICS = "METRICS",
    OVI = "OVI",
    AUTOMATION = "AUTOMATION"
}

/** Represents the enum public.OpsSeverity */
export const enum OpsSeverity {
    info = "info",
    notable = "notable",
    warn = "warn",
    critical = "critical"
}

/** Identifier type for public.ops_event */
export type OpsEventId = string & {
    __brand: 'public.ops_event';
};

/** Identifier type for automations.movement_version */
export type MovementVersionId = string & {
    __brand: 'automations.movement_version';
};

/** Identifier type for automations.trigger_run */
export type TriggerRunId = string & {
    __brand: 'automations.trigger_run';
};

/** Which saved version a run executed, against the one that would run
 *  today. A run pins its version at start, so a firing from before the
 *  last save ran OLDER logic than the editor shows — the thing that
 *  otherwise takes a database query to notice. */
export interface ExecutedMovementVersion {
    /** The version this run executed. */
    number: number;
    /** The version a run started now would execute. */
    currentNumber: number;
    isCurrent: boolean;
}

export interface MovementRunNowSuccess {
    ok: true;
    /** The movement the manual listener fires. */
    movementName: string;
    /** Writes were captured, not committed (the listener rehearses). */
    dryRun: boolean;
    /** Writes the run applied — the "records processed" count. */
    recordCount: number;
    /** Per-node evaluation errors surfaced by the engine; empty on a clean run. */
    errors: {
        nodeId: string | null;
        message: string;
    }[];
}
export interface MovementRunNowFailure {
    ok: false;
    errors: string[];
}
export type MovementRunNowResult = MovementRunNowSuccess | MovementRunNowFailure;

export interface WalkedProperty {
    type: FieldType;
    /** Resolved, never inferred by the reader: a field's `readable` defaults
     *  true, its `writable` is stated outright. */
    readable: boolean;
    writable: boolean;
    required: boolean;
    description?: string;
}
/**
 * A node as an edge's LANDING — everything it says about itself except its own
 * onward edges. The omission is the contract: an agent holds the landing's
 * fields, so it can author a write with no further call, while deciding to walk
 * further costs exactly one hop.
 *
 * ...unless the adapter judged describing it too expensive, in which case the
 * landing is a STUB: named, and saying so. An agent reading `stub: true` knows
 * the fields exist and cost one hop; it must never read a stub as a node that
 * happens to have no fields.
 *
 * Mirrors `EdgeTargetNode` on the adapter side.
 */
export type WalkedNodeShape = WalkedDescribedNode | WalkedStubNode;
export interface WalkedDescribedNode {
    name: string;
    description?: string;
    properties: Record<string, WalkedProperty>;
    /** What identifies one of these records: each entry is a combination of
     *  names (properties, or this node's own edges) that the source treats as
     *  unique — a `unique by` candidate. Absent when the source declares none.
     *  A rule naming anything this node cannot spell is left out rather than
     *  half-stated. */
    unique?: string[][];
    stub?: false;
}
/** Named, not described. `properties` is ABSENT rather than empty — an empty
 *  map would claim the node has no fields, which is a different (and false)
 *  statement from "we did not fetch them". */
export interface WalkedStubNode {
    name: string;
    description?: string;
    stub: true;
    /** What to do about it, in the agent's own terms. */
    hint: string;
}
export interface WalkedMember {
    name: string;
    /** The narrowing that reaches this member — echo it as a position. */
    position: string;
}
export interface WalkedEdge {
    name: string;
    description?: string;
    cardinality: 'one' | 'many';
    readable: boolean;
    writable: boolean;
    /** Present only when true: this edge DELIVERS its target (what a listen
     *  subscribes to) rather than letting you fetch it. */
    fires?: true;
    firesOn?: string[];
    /** Present only when true: writing here performs an action and materialises
     *  nothing. */
    ephemeral?: true;
    /** Present only when true: this edge is AWAITED (`await x-[:E]->`), not read —
     *  its promise is a resolution that resumes a parked run, so it is honestly
     *  neither `readable` nor `writable` (asks-as-adapter §A). Surfaced on the
     *  graph-explorer / describe path so the tooling reads it as a promise; the
     *  ENGINE consumption is a later chunk (this is declaration-only for now). */
    awaitable?: true;
    /** Present only when true (and only meaningful with `awaitable`): a resolution
     *  along this edge may carry NO landing (an explicit cancel). */
    resolvesEmpty?: true;
    /** Present only when true (and only meaningful with `awaitable`): the source
     *  DELIVERS an event when this edge resolves, so `await FIRST(…)` waits
     *  without a cadence. Absent means the author states one (`until … every:`). */
    watchable?: true;
    /** The address that walks this edge. Absent when the adapter handed over no
     *  path — the edge is real, but reaching it is by name, not by walking. */
    position?: string;
    /** A polymorphic edge is ONE edge with MANY members (Airtable's bases). The
     *  members ride the edge because that is where the fact is true — which
     *  bases exist is a fact about the hop, not about the workspace. */
    members?: WalkedMember[];
    /** The fields a narrowing predicate may test, drawn from what the adapter
     *  labelled its members with. Without it the names are visible but there is
     *  no way to tell what to write a `WHERE` against. */
    narrowBy?: string[];
    /** What you land on. ABSENT means the target was not hydrated — a different
     *  fact from a landing with no properties, and the reason it is optional. */
    target?: WalkedNodeShape;
    /**
     * The types this ONE edge can land on, when the landing varies per record (an
     * Attio reference allowed on both People and Companies). There is no single
     * `target` to name, and that is the fact — not a missing hydration.
     *
     * Distinct from `members`, which are things you pick between with a `WHERE`
     * at authoring time. These are decided by the DATA: an automation traverses
     * the edge, gets a mixed set, and narrows with an `IS` test per record.
     */
    landsOn?: string[];
}
/** The node you asked about is ALWAYS described — you walked to it, so the
 *  fetch has already happened. Only an edge's target can be a stub. */
export interface WalkedNode extends WalkedDescribedNode {
    /** The address of THIS node — empty at the root. Every edge's address is
     *  built onto it. */
    position: string;
    edges: WalkedEdge[];
}

/** A referenced adapter this catalog could not type — so nothing schema-shaped
 *  about that instance was checked. */
export interface CatalogGap {
    adapter: string;
    detail: string;
}
export interface TeamCatalogSnapshot {
    snapshot: CatalogSnapshot;
    /** Honest gaps hit while assembling (untyped adapters, collisions, …). */
    notes: string[];
    /** Per remote-adapter-install connection status — 'needs-secret' when the
     *  install has no credential yet, 'connected' once its secret is provisioned.
     *  Agent-view only (NOT on the checker's `CatalogSnapshot`): construction is
     *  credential-free, so this is a connection fact, not a type-catalog fact. */
    remoteConnections?: Record<string, 'connected' | 'needs-secret'>;
    /**
     * Referenced adapters that could NOT be typed (introspection failed, or the
     * construction's credential didn't resolve) — the same structured signal
     * `movementCatalogForTeam` reports. Only populated for the source-aware form;
     * the skeleton introspects nothing, so it has nothing to fail at.
     *
     * The editor needs this to tell "this instance is untyped, so I am staying
     * silent about it" apart from "this instance is fine" — the two look
     * identical in the diagnostics, which is why it must be said out loud.
     */
    gaps?: CatalogGap[];
}
export interface DescribedInstance {
    /** Null when the pair can't be introspected — the instance stays
     *  untyped and the checker stays silent for it, by design. */
    schema: InstanceSchema | null;
    notes: string[];
    /**
     * THE WALK'S ANSWER: the node at the requested position (the root when none
     * was given) — what it is, its properties, and every edge leaving it, each
     * edge carrying what it lands on and the address that walks it.
     *
     * This is the shape the contract is converging on: one call, one shape at
     * every depth, and no second mechanism by which a type becomes known. It is
     * present only for adapters that walk (`edgesFrom`); while the rest are
     * Every adapter walks, so this is THE answer — there is no second view of
     * the same graph to disagree with.
     *
     */
    node?: WalkedNode;
    /** The adapter's user-facing one-liner (what it is, what connecting it does). */
    description?: string;
    /** Plain-language truth about what a listener on this adapter fires on —
     *  the agent grounds trigger claims in this rather than inventing them. */
    triggerExpectation?: string;
    /** Movement-authoring tips and caveats for the agent — adapter-specific
     *  guidance that helps it write correct movements. Not surfaced in any
     *  public or user-facing UI; for the authoring agent only. */
    authoringHints?: string;
    /** Who a movement over this system runs AS (the connecting account), and
     *  whose activity triggers a listener on it — derived from the manifest's
     *  credential + registered-actor facts, so the identity idiosyncrasy is
     *  carried by the manifest rather than hand-written prose. Absent for a
     *  system with neither axis (an intrinsic, or a manual/scheduled channel). */
    identity?: string;
    /** What Listen-Fire can and can't do with this system — read/write limits and
     *  whether it can be listened to — derived from its methods + triggers.
     *  Absent when there's nothing limiting to say. */
    capability?: string;
}

export interface AuthoringDiagnostic {
    code: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
    /** 1-based line/col into the source. */
    line: number;
    col: number;
    endLine: number;
    endCol: number;
    /** The offending source line, verbatim — repair context without re-reading. */
    sourceLine: string;
    /** Marks a construct whose meaning changed between the pin and the version
     *  checked, on an upgrade check (the checker's `Diagnostic.upgrade`). */
    upgrade?: true;
    /** The exact rewrite that resolves it (also spelled out in `message`):
     *  replace each 1-based range with `text`; an empty range inserts. `safe`:
     *  it provably keeps the meaning, so an upgrade may apply it unasked. */
    fix?: {
        edits: AuthoringEdit[];
        safe?: true;
    };
}
export interface AuthoringEdit {
    line: number;
    col: number;
    endLine: number;
    endCol: number;
    text: string;
}
export interface MovementValidityAssessment {
    status: MovementValidityStatus;
    /** Structured `validity_reason`: `{ diagnostics }` for invalid,
     *  `{ gaps }` for unverified, `null` for valid. */
    reason: unknown;
}

/** Runtime validity of the CURRENT source against the adapters' CURRENT live
 *  shape. Null = never checked.
 *  See plans/2026-07-13-movement-validity-lifecycle. */
export type MovementValidityStatus = 'valid' | 'invalid' | 'unverified';
export interface MovementRow {
    id: string;
    teamId: string;
    name: string;
    source: string;
    description: string;
    triggerId: string | null;
    /** The version a new run pins (versioning D2/D3); null until the movement's
     *  first clean save mints one. */
    currentVersionId: string | null;
    /** Runtime validity — null until the first check. `validitySourceHash` is the
     *  `movementSourceHash` of the source the status describes; the status is
     *  trustworthy only while it matches the current `source` (version-match rule). */
    validityStatus: MovementValidityStatus | null;
    validityReason: unknown;
    validitySourceHash: string | null;
    validityCheckedAt: Date | null;
    validityConsentedAt: Date | null;
    /** The language version the last validity check ran under; null until the
     *  first check since versioning. */
    validityCheckedAgainst: LanguageVersion | null;
    /** The language version this movement is written against — stamped at first
     *  save, never moved by an edit. Validation and runs of it use this. */
    languageVersion: LanguageVersion;
    /** What stands between this movement and `upgradeCheckedAgainst`: the error
     *  and warning diagnostics validating it under that version found. Null =
     *  nothing recorded (never checked, or already on that version). */
    upgradeDiagnostics: AuthoringDiagnostic[] | null;
    upgradeCheckedAgainst: LanguageVersion | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface MovementFileFacets {
    /** `listen` statements — events fire this file. */
    listenerCount: number;
    /** The file declares a manual-channel listener — "Run now" works. */
    runnableOnDemand: boolean;
    /** Something invokes this file: listeners (the only invoker). */
    isAutomation: boolean;
    /** Movements marked `export` — importable by other files. */
    exportedMovementCount: number;
    /** Node declarations marked `export` — importable by other files. */
    exportedShapeCount: number;
    /** The file explicitly exports (≥1 `export` declaration). */
    isLibrary: boolean;
}
export interface MovementDependent {
    id: string;
    name: string;
    validityStatus: MovementValidityStatus | null;
}
export interface DependentCheckResult {
    id: string;
    name: string;
    /** Would this dependent's own save go live against the current state? */
    ok: boolean;
    /** Error-severity diagnostics found (0 when ok). */
    problemCount: number;
}

export interface ProvisionedListener {
    triggerId: string;
    /** The movement this listener fires. */
    movementName: string;
    /** `automations.trigger.kind` — the source adapter slug (the channel). */
    kind: string;
    credentialsId: string | null;
    config: Record<string, unknown>;
    /** `config.key`, when the listen declares one. */
    configKey: string | null;
    /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
    inboundAddress: string | null;
    /** The one hand-editable listener field (never touched by reconciliation). */
    runMode: TriggerRunMode;
    /** Whether an existing derived row was kept (identity + run history preserved). */
    reused: boolean;
}
export interface ProvisionedMovement {
    ok: true;
    /** The file's primary movement name (the row's name source). */
    movementName: string;
    /** One per `listen` statement, in file order. Empty = library file. */
    listeners: ProvisionedListener[];
    /** Info-severity diagnostics (e.g. MOV_LISTEN_MISSING) — never blocking. */
    infos: Diagnostic[];
    /** Catalog assembly notes (honest gaps — untyped adapters, collisions). */
    catalogNotes: string[];
    /** The save SUCCEEDED, but something about what now runs would surprise the
     *  author — listeners retired by a consented unparseable save, a movement
     *  name another automation already fires. Never blocking; always shown. */
    warnings: string[];
}
export interface ProvisionMovementFailure {
    ok: false;
    /** Parse/check diagnostics, when the check failed. */
    diagnostics?: Diagnostic[];
    /** Unsupported-construct or provisioning errors. */
    errors?: string[];
    catalogNotes: string[];
}
export interface SavedMovement extends ProvisionedMovement {
    movementId: string;
    /** The runtime validity the save shipped at — `valid`, or the consented
     *  non-`valid` state (decision 3b: a consented broken save replaces what
     *  runs and fires-and-fails). */
    validity: MovementValidityAssessment;
}
export interface SaveMovementFailure extends ProvisionMovementFailure {
    /** Absent only when no row could be saved (no derivable name). */
    movementId?: string;
    /** The stored row changed since the editor loaded — nothing was saved.
     *  The caller can show the current version and let the user reload it or
     *  overwrite (re-save with no baseUpdatedAt). */
    conflict?: {
        currentSource: string;
        currentUpdatedAt: string;
        /** Present when the conflict was detected by `expectedRevision` (or
         *  always computable regardless) — the CURRENT content hash, so a caller
         *  that wants to skip a redundant `getMovement` round-trip can re-save
         *  straight off it once it has merged. */
        currentRevision?: string;
    };
    /** The save landed non-`valid` and no consent was given: the source is
     *  persisted (retained artifact) but not shipped live. The caller either
     *  self-repairs off `validity.reason` or re-calls with `acknowledgeErrors`. */
    needsConfirmation?: boolean;
    /** The runtime validity the save was assessed at (present on a
     *  `needsConfirmation` return). */
    validity?: MovementValidityAssessment;
}
export type SaveMovementResult = SavedMovement | SaveMovementFailure;
export interface MovementListenerInfo {
    triggerId: string;
    /** `movement/<file>/<movement>`. */
    name: string;
    /** The channel — source adapter slug. */
    kind: string;
    config: Record<string, unknown>;
    configKey: string | null;
    /** `<local>+<key>@<domain>` for adapters with an inbound routing key, else null. */
    inboundAddress: string | null;
    /** The fired movement (the trigger-name convention's last segment). */
    movementName: string | null;
    /** Derived from the movement text on every save; not settable — see
     *  triggers/run_mode.ts. */
    runMode: TriggerRunMode;
}
export interface MovementListItem {
    id: string;
    name: string;
    /** Runtime validity of the current source (null = never checked) — NOT
     *  whether the file runs on its own. A library checks clean and is
     *  'valid' without anything ever invoking it; see `facets` for what the
     *  file actually is. */
    validityStatus: MovementValidityStatus | null;
    validityCheckedAt: Date | null;
    /** The language version the last validity check ran under. */
    validityCheckedAgainst: LanguageVersion | null;
    /** The language version the movement is written against (its pin). */
    languageVersion: LanguageVersion;
    /** What keeps it off the current language version — the errors and warnings
     *  validating it under that version found (pendingUpgradeDiagnostics). Null
     *  when it is on it, or nothing is recorded. */
    upgradeDiagnostics: AuthoringDiagnostic[] | null;
    /** First listener's channel (null for libraries). */
    kind: string | null;
    /** Derived listeners — one per `listen` statement of the last shipped save. */
    listeners: MovementListenerInfo[];
    /** The source declares a manual-channel listener — "Run now" works. */
    runnable: boolean;
    /** What the file IS, derived from its text: an automation (something
     *  invokes it), a library (others import it), or both. */
    facets: MovementFileFacets;
    createdAt: Date;
    updatedAt: Date;
}
export interface MovementDetail extends MovementRow {
    /** Derived listeners — one per `listen` statement of the last shipped save. */
    listeners: MovementListenerInfo[];
    /** First listener's channel, kept for back-compat with the list shape. */
    kind: string | null;
    /** First listener's inbound address (adapters with an inbound routing key). */
    inboundAddress: string | null;
    /** The source declares a manual-channel listener — "Run now" works. */
    runnable: boolean;
    /** Content hash of the CURRENT `source` (`movementSourceHash`) — an
     *  optimistic-concurrency fingerprint. Pass it back as `expectedRevision` on
     *  a later `saveMovement` to guard against clobbering an edit made by
     *  someone (or something) else in the meantime; a mismatch there is refused
     *  as a conflict instead of silently overwriting. */
    revision: string;
}

export type MovementRunItem = {
    id: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    failedAt: Date | null;
    failureReason: string | null;
    nodesWritten: number;
    dryRun: boolean;
    summary: string;
    /** The lane (trigger name) that produced this run. */
    lane: string;
    /** Model-call cost this run incurred, rolled up from `llm_usage` — zero
     *  when the run made no model calls (or ran before cost tracking). */
    costMicrodollars: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
};
export type MovementEventItem = {
    id: string;
    /** The lane (trigger name) the event arrived on. */
    lane: string;
    /** The channel the event came through — source adapter slug. */
    adapterType: string;
    status: string;
    failureReason: string | null;
    occurredAt: Date;
    createdAt: Date;
};

export interface CypherResult {
    columns: string[];
    data: Record<string, unknown>[];
    meta: {
        rowCount: number;
        timeMs: number;
        generatedSql?: string;
    };
}

/** Identifier type for knowledge.recipe */
export type RecipeId = string & {
    __brand: 'knowledge.recipe';
};

/**
 * Editor-action vocabulary for the live-authoring view (V2).
 *
 * Semantic, name-keyed projections of the translation agent's tool calls —
 * derived at the orchestration seam (see `lib/knowledge/editor_actions.ts`),
 * NOT emitted from inside the agent or its tools. The live-authoring box
 * replays these on the shared `TgGraphView` to render "the agent's cursor":
 * focus a node, settle a finished field value in, flash the completions it
 * chose from, flag a credential it bound.
 *
 * Every reference is a NAME (node path / field name / credential name),
 * never a UUID — the view resolves nothing (N3-N).
 *
 * activity layer
 */
export type EditorActionType = 
/** Move the cursor to a node (select + scroll). */
'focusNode'
/** A field's value was authored — settle the finished expression in. */
 | 'editField'
/** The options a completions lookup surfaced at a field/node. */
 | 'showCompletions'
/** A credential (source/target) was bound to a role. */
 | 'bindCredential';
export type AgentUpdate = {
    sessionId: string;
    type: 'start' | 'tool_call' | 'tool_result' | 'thinking' | 'complete' | 'error' | 'build' | 'draft' | 'plan' | EditorActionType;
    message: string;
    data?: any;
    timestamp: number;
};

/** Identifier type for knowledge.document */
export type DocumentId = string & {
    __brand: 'knowledge.document';
};

/** Represents the enum knowledge.LinkedObjectSource */
export const enum LinkedObjectSource {
    retrieval = "retrieval",
    output = "output",
    manual = "manual",
    input = "input"
}

/** Represents the enum knowledge.change_kind */
export const enum ChangeKind {
    property_set = "property_set",
    property_cleared = "property_cleared",
    edge_created = "edge_created",
    edge_removed = "edge_removed",
    edge_retargeted = "edge_retargeted",
    node_created = "node_created",
    node_removed = "node_removed"
}

/** Represents the enum knowledge.change_source */
export const enum ChangeSource {
    pipeline = "pipeline",
    user_edit = "user_edit",
    agent = "agent",
    api = "api",
    mcp = "mcp"
}

/** Represents the enum knowledge.node_type_category */
export const enum NodeTypeCategory {
    message = "message",
    object = "object",
    scoped_object = "scoped_object"
}

/** Identifier type for knowledge.node_type */
export type NodeTypeId = string & {
    __brand: 'knowledge.node_type';
};

/** Identifier type for knowledge.node */
export type NodeId = string & {
    __brand: 'knowledge.node';
};

/** Identifier type for knowledge.edge_type */
export type EdgeTypeId = string & {
    __brand: 'knowledge.edge_type';
};

/** Identifier type for knowledge.edge */
export type EdgeId = string & {
    __brand: 'knowledge.edge';
};

/** Represents the enum knowledge.property_value_type */
export const enum PropertyValueType {
    text = "text",
    number = "number",
    date = "date",
    boolean = "boolean",
    json = "json"
}

/** Represents the enum knowledge.property_identity */
export const enum PropertyIdentity {
    unique = "unique",
    fuzzy = "fuzzy",
    none = "none"
}

/** Represents the enum knowledge.evaluation_strategy */
export const enum EvaluationStrategy {
    latest = "latest",
    llm = "llm"
}

/** Represents the enum knowledge.property_cardinality */
export const enum PropertyCardinality {
    single = "single",
    multi = "multi"
}

/** Represents the enum knowledge.evidence_type */
export const enum EvidenceType {
    extraction = "extraction",
    user_edit = "user_edit",
    retrieval = "retrieval",
    input_mapping = "input_mapping",
    arbitration = "arbitration"
}

/** Identifier type for knowledge.property_type */
export type PropertyTypeId = string & {
    __brand: 'knowledge.property_type';
};

/** Identifier type for knowledge.property */
export type PropertyId = string & {
    __brand: 'knowledge.property';
};

/** Identifier type for knowledge.linked_object */
export type LinkedObjectId = string & {
    __brand: 'knowledge.linked_object';
};

/** Identifier type for knowledge.evidence */
export type EvidenceId = string & {
    __brand: 'knowledge.evidence';
};

/** Identifier type for knowledge.change */
export type ChangeId = string & {
    __brand: 'knowledge.change';
};

/** Represents the enum knowledge.ResourceType */
export const enum ResourceType {
    URL = "URL",
    EMAIL = "EMAIL",
    WHATSAPP = "WHATSAPP",
    FILE = "FILE",
    TEXT = "TEXT"
}

/** Identifier type for knowledge.resource */
export type ResourceId = string & {
    __brand: 'knowledge.resource';
};

/** Identifier type for knowledge.saved_filter */
export type SavedFilterId = string & {
    __brand: 'knowledge.saved_filter';
};

/** Identifier type for knowledge.extraction_graph_node */
export type ExtractionGraphNodeId = string & {
    __brand: 'knowledge.extraction_graph_node';
};

/** Identifier type for knowledge.extraction_graph */
export type ExtractionGraphId = string & {
    __brand: 'knowledge.extraction_graph';
};

/** Identifier type for knowledge.extraction_graph_edge */
export type ExtractionGraphEdgeId = string & {
    __brand: 'knowledge.extraction_graph_edge';
};

/** Identifier type for knowledge.plugin */
export type PluginId = string & {
    __brand: 'knowledge.plugin';
};

export type MaterializeResult = {
    nodeTypesCreated: number;
    propertyTypesCreated: number;
    edgeTypesCreated: number;
    extractionGraphsCreated: number;
    extractionGraphEdgesCreated: number;
};

/**
 * Tri-state discriminator. Drives which sections the page renders.
 * Keeping the kind on the server avoids the client re-deriving it
 * from row counts and disagreeing with the status pills below.
 */
export type DashboardKind = 'empty' | 'needs_setup' | 'live';
export type DashboardAutomation = {
    id: string;
    name: string;
    description: string;
    status: AutomationStatus;
    statusLabel: string;
    eventsToday: number;
    lastEventAt: Date | null;
    /** The movement this trigger dispatches into, or `null` for a legacy
     *  movement-less trigger. Lets the client link to the movement page
     *  (run history + editing live there now) instead of the trigger's
     *  config-only page. */
    movementId: string | null;
};
export type DashboardEvent = {
    id: string;
    at: Date;
    status: 'success' | 'partial' | 'failed';
    description: string;
    automationId: string | null;
    automationName: string | null;
    /** See `DashboardAutomation.movementId`. */
    movementId: string | null;
    /** True when the firing ran in dry-run (preview) mode — it captured
     *  writes but committed nothing. The feed badges it as a preview. */
    dryRun: boolean;
};
export type DashboardThingWaiting = {
    kind: 'setup_incomplete' | 'error' | 'ask';
    message: string;
    /** The automation this points at, or `null` for an entry that isn't about
     *  one automation (the aggregate unanswered-questions entry). */
    automationId: string | null;
    actionUrl: string;
};
/**
 * The headline counts the page leads with. Each is the subject of a tile that
 * links to where the corresponding action lives.
 */
export type DashboardStats = {
    activeAutomations: number;
    eventsToday: number;
    runs7d: number;
    failures7d: number;
    openAsks: number;
};
export type DashboardPayload = {
    kind: DashboardKind;
    automations: DashboardAutomation[];
    recentEvents: DashboardEvent[];
    thingsWaiting: DashboardThingWaiting[];
    stats: DashboardStats;
};

export type BookStatus = 'available' | 'legacy' | 'coming_soon';
export interface BookChapter {
    id: string;
    title: string;
    content: string;
}
export interface BookIntentEntry {
    intent: string;
    chapter: string;
    section?: string;
}
export interface LibraryBook {
    bookId: string;
    title: string;
    description: string;
    status: BookStatus;
    /** Short note shown next to the status badge (e.g. what superseded a legacy book). */
    statusNote?: string;
    /** External pointer for books that live elsewhere (e.g. a public repo). */
    link?: {
        label: string;
        url: string;
    };
    chapters: BookChapter[];
    intentIndex: BookIntentEntry[];
}

export type GraphExplorerInstance = {
    adapterType: string;
    displayName: string;
    credential: {
        id: string;
        name: string;
        type: string;
    } | null;
    remote: boolean;
};
export type GraphExplorerTeam = {
    id: string;
    name: string;
};
/**
 * One hop's answer. `node` absent with a `note` is the honest shape for "the
 * walk went nowhere" — never a silent fall back to the root, which would answer
 * a different question than the one asked.
 */
export type GraphExplorerHop = {
    node?: WalkedNode;
    note?: string;
    footnote?: string;
    elapsedMs: number;
};

export interface GrantedSpreadsheet {
    spreadsheetId: string;
    name: string | null;
}

/** The lattice states. `open` is the only non-terminal one. */
export type AskState = 'open' | 'answered' | 'expired';

/** One offered option, in the `{ id, label, value }` shape the checklist /
 *  button controls consume. */
export interface AskViewOption {
    id: string;
    label: string;
    value: unknown;
}
/** One editable record offered to a Correct ask, plus a display label. */
export interface AskViewCorrectRow {
    ephemeralId: string;
    fields: Record<string, unknown>;
    label: string;
}
export interface AskViewCorrect {
    columns: string[];
    rows: AskViewCorrectRow[];
}

/** One new-store question, projected for the "your asks" surface. Field names
 *  mirror the legacy `OpenAskSummary` (question / detail / interactionType /
 *  resultType / options / correct) so the same in-place answer control renders
 *  it, plus the terminal fields a settled record shows. */
export interface AskRecordSummary {
    askId: string;
    state: AskState;
    question: string;
    detail: string | null;
    interactionType: string;
    resultType: {
        graph: string;
        position?: string;
    };
    options: AskViewOption[] | null;
    correct: AskViewCorrect | null;
    /** The recorded answer — present once the question is answered. */
    answer: unknown;
    createdAt: Date;
    /** When a run is parked waiting on this question, its automation name — so the
     *  surface can say which workflow is waiting; null in the ask's afterlife
     *  (answerable with no run waiting, F7). */
    awaitingAutomationName: string | null;
}

export interface ParkedRunSummary {
    runId: string;
    /** The automation's user-facing name (`automations.trigger.name`); a sensible
     *  fallback when the trigger is gone. */
    automationName: string;
    /** The source kind the run came in on (the trigger's adapter kind). */
    source: string;
    /** When the run started — drives the "since" age in the UI. */
    startedAt: Date;
    /** How many of this run's asks are still open (waiting on a human). */
    openAskCount: number;
    /** How many distinct fan-out / parallel groups in this run still have ≥2
     *  pending siblings — "waiting on 3 of 5" lives on the ask rows; this is the
     *  run-level hint that the run fanned out. */
    pendingJoinGroups: number;
    /** What this run is waiting on, in plain language — one line per live
     *  await/timer leaf (P22). Covers the new ask store, Slack replies, and
     *  recurring `until` checks; empty when the run's only holds are legacy asks
     *  (surfaced as the ask rows) or engine holds. */
    awaiting: string[];
}
export interface TeamRunSummary {
    runId: string;
    automationName: string;
    status: 'running' | 'parked';
    startedAt: Date;
    /** Why it's waiting, when parked. 'limit' (paused at its cost limit — the
     *  operator can resume it) | 'ask' | 'timer' | null (running). */
    waitingOn: 'limit' | 'ask' | 'timer' | null;
    openAskCount: number;
    cancelRequested: boolean;
}

/**
 * How a credential type is connected through the link, or null if it can't be.
 *   - 'oauth'      → the landing route redirects to the provider's sign-in.
 *   - 'key-entry'  → the landing route renders a browser form for the key.
 *   - 'intrinsic'  → no external auth; the user confirms and the server mints +
 *                    provisions the Listen-Fire-owned credential (e.g. Listen-Fire Valuations).
 *   - 'handshake'  → the credential is secret-less; the submit connects the team
 *                    and hands the user into the adapter's own identity handshake
 *                    (Telegram's `t.me/<bot>?start=<token>` deep link).
 */
export type ConnectKind = 'oauth' | 'key-entry' | 'intrinsic' | 'handshake' | 'item-picker';
/**
 * The connect method the catalog advertises for a type — the SAME live
 * derivation a real connect attempt takes (`connectKindForType`), so the
 * advertisement can never disagree with what `mintConnectLink` will actually
 * do. Falls back to 'app-only' when no link can be minted: either the type
 * genuinely connects in-app, or its OAuth connector isn't wired on this server
 * (missing client-id/secret). In both cases connectSystem can't mint a link, so
 * we must not advertise it as link-connectable — an author must never author
 * toward a connect that would then fail.
 */
export type ConnectMethod = Exclude<ConnectKind, 'item-picker'> | 'app-only';

export type ConnectionsIntegration = {
    id: string;
    name: string;
    type: string;
    reads: boolean;
    writes: boolean;
    automationCount: number;
    /**
     * The names a movement program imports this credential under —
     * `import { <name> } from credentials`. Computed with the movement
     * catalog's own projection (`credentialImportNames`) so the page shows
     * exactly what the language resolves. Usually one entry; several when
     * one credential type serves multiple adapters (e.g. a Google account
     * powering both Sheets and Drive); empty when no adapter can use the
     * credential from a movement.
     */
    importNames: string[];
};
export type ConnectionsSourceChannel = {
    /** Stable key matching the trigger.kind for this built-in receiver. */
    kind: string;
    name: string;
    identifier: string;
    automationCount: number;
};
export type ConnectionsCustomRow = {
    id: string;
    name: string;
    kind: string;
    kindLabel: string;
    configSummary: string;
};
export type ConnectionsPayload = {
    integrations: ConnectionsIntegration[];
    sourceChannels: ConnectionsSourceChannel[];
    custom: ConnectionsCustomRow[];
};
/**
 * Everything that would be affected by deleting one credential — the
 * payload behind the delete-confirmation dialog. Enumerated honestly
 * from the schema and the movement TEXT:
 *
 *   - `movements` — saved movement files whose source imports one of the
 *     credential's import names (`import { <name> } from credentials`).
 *     No FK exists (the TEXT is canonical); re-derived by scanning each
 *     team source, the same posture as movement file dependents. These
 *     break loud: their next check/save/run fails on the unresolved
 *     import.
 *   - `automations` — `automations.trigger` rows with
 *     `credentials_id = <this credential>`. The delete releases them
 *     (the vault's in-schema ON DELETE SET NULL), so the trigger row
 *     survives but stops matching inbound events — silent at the database
 *     layer, which is exactly why the dialog lists them by name before
 *     the user confirms.
 *   - `webhookSubscriptionCount` — `automations.webhook_subscription` rows
 *     (ON DELETE CASCADE: they go away with the credential). The
 *     source-side registration is deregistered best-effort on delete.
 *   - `remoteAdapterCount` — the remaining `credentials_id` FK in the
 *     schema (`remote_adapter`), ON DELETE SET NULL. Surfaced as a count
 *     so the dialog never hides a reference.
 */
export type CredentialDependentsPayload = {
    importNames: string[];
    movements: {
        id: string;
        name: string;
        validityStatus: string | null;
    }[];
    automations: {
        id: string;
        name: string;
    }[];
    webhookSubscriptionCount: number;
    remoteAdapterCount: number;
};

/** Identifier type for public.signup_event */
export type SignupEventId = string & {
    __brand: 'public.signup_event';
};

export interface UsageStatus {
    allowed: boolean;
    used: number;
    weeklyMax: number;
    additional: number;
    effectiveLimit: number;
    remaining: number;
    periodStart: Date;
    periodEnd: Date;
}

/** Identifier type for public.team_usage_config */
export type TeamUsageConfigId = string & {
    __brand: 'public.team_usage_config';
};

/** Identifier type for public.dealflow_pipeline */
export type DealflowPipelineId = string & {
    __brand: 'public.dealflow_pipeline';
};

/** Identifier type for public.agent_conversation */
export type AgentConversationId = string & {
    __brand: 'public.agent_conversation';
};

/** Identifier type for public.llm_usage */
export type LlmUsageId = string & {
    __brand: 'public.llm_usage';
};

export type Access = 'read' | 'write';
export type CreatedMember = {
    id: UserId;
    username: string;
    email: string;
};

/** Identifier type for public.pipeline_configuration */
export type PipelineConfigurationId = string & {
    __brand: 'public.pipeline_configuration';
};

/** Represents the enum automations.OpsDetailLevel */
export const enum OpsDetailLevel {
    low = "low",
    medium = "medium",
    full = "full"
}

export type AdapterCatalogEntry = {
    /** Canonical adapter slug — the engine's routing identity. */
    slug: string;
    name: string;
    description: string;
    /** Movement import name (`import { <name> } from adapters`), or null when
     *  the slug isn't a valid movement identifier. */
    importName: string | null;
    /** Movements can read records out of this system. */
    reads: boolean;
    /** Movements can create/update/delete records in this system. */
    writes: boolean;
    /** Can start a movement when something happens in this system. */
    listensForEvents: boolean;
    /** Credential type the Connect flow creates, or null when none is needed. */
    connectType: string | null;
    /** How many credentials of `connectType` the team already holds. */
    connectedCount: number;
};

declare const trpcRouter: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
    ctx: {
        authorise: () => Promise<void>;
    };
    meta: object;
    errorShape: {
        message: string;
        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
        data: _trpc_server_dist_error_formatter.DefaultErrorData;
    };
    transformer: _trpc_server.DefaultDataTransformer;
}>, {
    models: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
        ctx: {
            authorise: () => Promise<void>;
        };
        meta: object;
        errorShape: {
            message: string;
            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
            data: _trpc_server_dist_error_formatter.DefaultErrorData;
        };
        transformer: _trpc_server.DefaultDataTransformer;
    }>, {
        user: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            context: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
                _meta: object;
            }, {
                id: string;
                email: string;
                secondaryEmails: Array<string>;
                phoneNumber?: string | null;
                username: string;
                isPlatformAdmin: boolean;
                hasAccess: boolean;
                hasCompletedRegistration: boolean;
                defaultTeam: {
                    id: string;
                    name: string;
                    members: Array<{
                        id: string;
                        email: string;
                        username: string;
                        publicProfile?: {
                            __typename?: "Profile";
                            id: string;
                            imageUrl?: string | null;
                        } | null;
                        readonly: boolean;
                        isHomeTeam: boolean;
                    }>;
                };
                teams: Array<{
                    id: string;
                    name: string;
                    members: Array<{
                        id: string;
                        email: string;
                        username: string;
                        publicProfile?: {
                            __typename?: "Profile";
                            id: string;
                            imageUrl?: string | null;
                        } | null;
                        readonly: boolean;
                        isHomeTeam: boolean;
                    }>;
                }>;
                permission: {
                    readonly: boolean;
                    readonlyByTeam: Array<{
                        __typename?: "ReadonlyByTeam";
                        id: string;
                        teamId: string;
                        readonly: boolean;
                    }>;
                };
                publicProfile?: {
                    id: string;
                    fullname: string;
                    imageUrl?: string | null;
                    description: string;
                    linkedin?: string | null;
                    descriptorsGeo: Array<string>;
                    descriptorsInvestorType: Array<string>;
                    descriptorsStage: Array<string>;
                    descriptorsMiscTags: Array<string>;
                    slug?: string | null;
                    roles: Array<{
                        id: string;
                        description?: string | null;
                        entityProfile?: {
                            __typename?: "Profile";
                            id: string;
                            fullname: string;
                            slug?: string | null;
                        } | null;
                    }>;
                } | null;
            }>;
        }>;
    }>;
    views: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
        ctx: {
            authorise: () => Promise<void>;
        };
        meta: object;
        errorShape: {
            message: string;
            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
            data: _trpc_server_dist_error_formatter.DefaultErrorData;
        };
        transformer: _trpc_server.DefaultDataTransformer;
    }>, {
        account: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getPasswordStatus: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                hasPassword: boolean;
            }>;
            setPassword: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    password: string;
                };
                _input_out: {
                    password: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
            changePassword: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    currentPassword: string;
                    newPassword: string;
                };
                _input_out: {
                    currentPassword: string;
                    newPassword: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
            removePassword: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
        adapters: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, AdapterCatalogEntry[]>;
        }>;
        admin: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            legalEntityManager: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getTeams: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                    _meta: object;
                }, {
                    name: string;
                    id: string;
                }[]>;
                getLegalEntitiesWithJargon: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        page?: number | undefined;
                        limit?: number | undefined;
                    };
                    _input_out: {
                        teamId: string;
                        page: number;
                        limit: number;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    entities: {
                        id: LegalEntityId;
                        description: string | null;
                        type: LegalEntityType | null;
                        name: string;
                        slug: string | null;
                        personalWebsite: string | null;
                        createdAt: Date;
                        investments: {
                            id: LegalEntityId;
                            name: string;
                            slug: string | null;
                            personalWebsite: string | null;
                        }[];
                    }[];
                    pagination: {
                        page: number;
                        limit: number;
                        totalCount: number;
                        totalPages: number;
                        hasNextPage: boolean;
                        hasPreviousPage: boolean;
                    };
                }>;
                getPotentialMatches: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entityId: string;
                        teamId: string;
                    };
                    _input_out: {
                        entityId: string;
                        teamId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    selectedEntity: {
                        teamId: string | null;
                        name: string;
                        legalName: string | null;
                    };
                    potentialMatches: {
                        id: LegalEntityId;
                        description: string | null;
                        type: LegalEntityType | null;
                        name: string;
                        slug: string | null;
                        createdAt: Date;
                        investments: {
                            id: LegalEntityId | null;
                            name: string | null;
                            slug: string | null;
                            personalWebsite: string | null;
                        }[];
                    }[];
                }>;
                updateEntity: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entityId: string;
                        teamId: string;
                        name: string;
                        type?: "COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | undefined;
                        personalWebsite?: string | undefined;
                    };
                    _input_out: {
                        entityId: string;
                        teamId: string;
                        name: string;
                        type?: "COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | undefined;
                        personalWebsite?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    type: _prisma_client.$Enums.LegalEntityType | null;
                    name: string;
                    personalWebsite: string | null;
                    id: string;
                }>;
            }>;
            authenticateAs: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                usersByEmailPrefix: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        emailPrefix: string;
                    };
                    _input_out: {
                        emailPrefix: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: string;
                    email: string;
                    token: string;
                    name: string;
                }[]>;
            }>;
            logs: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getLogsUrl: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        requestId: string;
                    };
                    _input_out: {
                        requestId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, string | null>;
            }>;
            userManagement: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getTeams: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                    _meta: object;
                }, {
                    id: TeamId;
                    name: string;
                    ops_detail_level: OpsDetailLevel;
                }[]>;
                setTeamDetailLevel: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        level: OpsDetailLevel;
                    };
                    _input_out: {
                        teamId: string;
                        level: OpsDetailLevel;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    ok: boolean;
                }>;
                searchUsersByEmail: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        emailPrefix: string;
                    };
                    _input_out: {
                        emailPrefix: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: UserId;
                    username: string;
                    teamId: TeamId;
                    team: {
                        name: string;
                    };
                    emails: {
                        email: string;
                    }[];
                }[]>;
                createTeamWithAdmin: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamName: string;
                        users?: {
                            email: string;
                            username: string;
                        }[] | undefined;
                    };
                    _input_out: {
                        teamName: string;
                        users: {
                            email: string;
                            username: string;
                        }[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    team: {
                        id: TeamId;
                        name: string;
                    };
                    pipelineConfiguration: {
                        id: PipelineConfigurationId;
                        name: string;
                    };
                    users: {
                        id: UserId;
                        username: string;
                        email: string;
                    }[];
                }>;
                addUserToTeam: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        access: "read" | "write";
                        email: string;
                        username: string;
                    };
                    _input_out: {
                        teamId: string;
                        access: "read" | "write";
                        email: string;
                        username: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: string;
                    username: string;
                    email: string;
                }>;
                createServiceAccount: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        access: "read" | "write";
                        email: string;
                    };
                    _input_out: {
                        teamId: string;
                        access: "read" | "write";
                        email: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, CreatedMember>;
                grantTeamAccess: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                        teamId: string;
                        access: "read" | "write";
                    };
                    _input_out: {
                        userId: string;
                        teamId: string;
                        access: "read" | "write";
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    username: string;
                    teamName: string;
                    access: "read" | "write";
                }>;
                addEmailToUser: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                        email: string;
                        isPrimary?: boolean | undefined;
                    };
                    _input_out: {
                        userId: string;
                        email: string;
                        isPrimary: boolean;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    username: string;
                    email: string;
                }>;
                addPhoneNumberToUser: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                        phoneNumber: string;
                    };
                    _input_out: {
                        userId: string;
                        phoneNumber: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    username: string;
                    phoneNumber: string;
                }>;
                getUserContactInfo: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                    };
                    _input_out: {
                        userId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    username: string;
                    teamId: string;
                    emails: {
                        id: string;
                        email: string;
                        isPrimary: boolean;
                        isServiceEmail: boolean;
                        acceptsPlusAddressing: boolean;
                    }[];
                    phoneNumber: {
                        phoneNumber: string;
                        id: string;
                    } | null;
                }>;
                updateUsername: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                        username: string;
                    };
                    _input_out: {
                        userId: string;
                        username: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    ok: boolean;
                }>;
                moveUserToTeam: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userEmail: string;
                        newTeamId: string;
                        access: "read" | "write";
                        newUsername?: string | undefined;
                    };
                    _input_out: {
                        userEmail: string;
                        newTeamId: string;
                        access: "read" | "write";
                        newUsername?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: string;
                    username: string;
                    email: string;
                }>;
                listUserMemberships: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userId: string;
                    };
                    _input_out: {
                        userId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    teamId: string;
                    teamName: string;
                    access: string;
                    isPersonal: boolean;
                    isHomeTeam: boolean;
                }[]>;
                removeUserFromTeam: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        userId: string;
                    };
                    _input_out: {
                        teamId: string;
                        userId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    removed: true;
                }>;
            }>;
            llmUsage: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                summary: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _input_out: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    team_id: string;
                    team_name: string;
                    call_count: number;
                    total_input_tokens: number;
                    total_output_tokens: number;
                    total_cache_read_tokens: number;
                    total_cost_microdollars: number;
                }[]>;
                byModel: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _input_out: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    provider: string;
                    model: string;
                    call_count: number;
                    total_input_tokens: number;
                    total_output_tokens: number;
                    total_cost_microdollars: number;
                }[]>;
                byLabel: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _input_out: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    call_type: string;
                    call_count: number;
                    total_input_tokens: number;
                    total_output_tokens: number;
                    total_cost_microdollars: number;
                    label: string;
                }[]>;
                byPipeline: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                        limit?: number | undefined;
                    };
                    _input_out: {
                        startDate: string;
                        endDate: string;
                        limit: number;
                        teamId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    pipeline_id: DealflowPipelineId | null;
                    team_name: string;
                    call_count: number;
                    total_input_tokens: number;
                    total_output_tokens: number;
                    total_cost_microdollars: number;
                    pipeline_created_at: Date;
                }[]>;
                byConversation: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        startDate: string;
                        endDate: string;
                        teamId?: string | undefined;
                        limit?: number | undefined;
                    };
                    _input_out: {
                        startDate: string;
                        endDate: string;
                        limit: number;
                        teamId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    conversation_id: AgentConversationId | null;
                    team_name: string;
                    call_count: number;
                    total_input_tokens: number;
                    total_output_tokens: number;
                    total_cost_microdollars: number;
                    conversation_title: string | null;
                    conversation_created_at: Date;
                }[]>;
                pipelineDetail: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        pipelineId: string;
                    };
                    _input_out: {
                        pipelineId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LlmUsageId;
                    created_at: Date;
                    team_id: string;
                    provider: string;
                    model: string;
                    call_type: string;
                    label: string | null;
                    input_tokens: number;
                    output_tokens: number;
                    cache_read_tokens: number;
                    cache_creation_tokens: number;
                    cost_microdollars: number;
                    duration_ms: number | null;
                    pipeline_id: DealflowPipelineId | null;
                    conversation_id: AgentConversationId | null;
                    trigger_run_id: string | null;
                    preferred_model: string | null;
                }[]>;
                conversationDetail: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LlmUsageId;
                    created_at: Date;
                    team_id: string;
                    provider: string;
                    model: string;
                    call_type: string;
                    label: string | null;
                    input_tokens: number;
                    output_tokens: number;
                    cache_read_tokens: number;
                    cache_creation_tokens: number;
                    cost_microdollars: number;
                    duration_ms: number | null;
                    pipeline_id: DealflowPipelineId | null;
                    conversation_id: AgentConversationId | null;
                    trigger_run_id: string | null;
                    preferred_model: string | null;
                }[]>;
                teams: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                    _meta: object;
                }, {
                    team_id: string;
                    team_name: string;
                }[]>;
            }>;
            usageConfig: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getForTeam: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                    };
                    _input_out: {
                        teamId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: TeamUsageConfigId;
                    created_at: Date;
                    updated_at: Date;
                    team_id: string;
                    max_weekly_pipeline_runs: number;
                    max_weekly_query_inputs: number;
                    additional_pipeline_runs: number;
                    additional_query_inputs: number;
                    alert_threshold_pct: number;
                    week_starts_on: number;
                } | null>;
                upsert: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                        maxWeeklyPipelineRuns: number;
                        maxWeeklyQueryInputs: number;
                        additionalPipelineRuns?: number | undefined;
                        additionalQueryInputs?: number | undefined;
                        alertThresholdPct?: number | undefined;
                        weekStartsOn?: number | undefined;
                    };
                    _input_out: {
                        teamId: string;
                        maxWeeklyPipelineRuns: number;
                        maxWeeklyQueryInputs: number;
                        additionalPipelineRuns: number;
                        additionalQueryInputs: number;
                        alertThresholdPct: number;
                        weekStartsOn: number;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
            }>;
            crossTeamOps: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                listTeams: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        search?: string | undefined;
                        limit?: number | undefined;
                        offset?: number | undefined;
                    };
                    _input_out: {
                        limit: number;
                        offset: number;
                        search?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    items: Array<{
                        id: string;
                        name: string;
                        ops_detail_level: OpsDetailLevel;
                    }>;
                    total: number;
                }>;
                listUsageAcrossTeams: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        search?: string | undefined;
                        limit?: number | undefined;
                        offset?: number | undefined;
                    };
                    _input_out: {
                        limit: number;
                        offset: number;
                        search?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    items: {
                        teamId: string;
                        teamName: string;
                        pipelineRuns: UsageStatus | null;
                        queryInputs: UsageStatus | null;
                        alertThresholdPct: number;
                        weekStartsOn: number;
                    }[];
                    total: number;
                }>;
                getBillingContacts: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        teamId: string;
                    };
                    _input_out: {
                        teamId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    email: string;
                    userId: string;
                }[]>;
                setBillingContact: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        userEmailId: string;
                        isBillingContact: boolean;
                    };
                    _input_out: {
                        userEmailId: string;
                        isBillingContact: boolean;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                listTriggerEvents: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        search?: string | undefined;
                        limit?: number | undefined;
                        offset?: number | undefined;
                        teamId?: string | undefined;
                        triggerId?: string | undefined;
                    };
                    _input_out: {
                        limit: number;
                        offset: number;
                        search?: string | undefined;
                        teamId?: string | undefined;
                        triggerId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    items: {
                        id: string;
                        teamId: string;
                        teamName: string | null;
                        trigger_id: string;
                        adapter_type: string;
                        trigger_type: string;
                        status: string;
                        failure_reason: string | null;
                        occurred_at: Date;
                        created_at: Date;
                    }[];
                    total: number;
                }>;
                replayTriggerEvent: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        eventId: string;
                        dryRun?: boolean | undefined;
                    };
                    _input_out: {
                        eventId: string;
                        dryRun: boolean;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    error?: string | undefined;
                    dryRun: boolean;
                    status: string;
                    droppedReason: "native_echo" | "trigger_not_found" | "no_bound_tgs" | "run_mode_off" | "loop_guard_paused" | "loop_guard_throttled" | "echo_suppressed" | "actor_unregistered" | "no_movement" | null;
                    firingCount: number;
                    writeCount: number;
                    firings: {
                        movementName: string;
                        writes: number;
                        dryRun: boolean;
                    }[];
                }>;
            }>;
            signups: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                list: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        limit?: number | undefined;
                    } | undefined;
                    _input_out: {
                        limit?: number | undefined;
                    } | undefined;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    rows: {
                        id: SignupEventId;
                        created_at: Date;
                        team_id: string;
                        email: string;
                        channel: string;
                        utm_source: string | null;
                        utm_medium: string | null;
                        utm_campaign: string | null;
                        utm_term: string | null;
                        utm_content: string | null;
                        referrer: string | null;
                    }[];
                }>;
            }>;
        }>;
        apiKeys: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
                _meta: object;
            }, {
                name: string;
                id: string;
                createdAt: Date;
                scopes: string[];
                expiresAt: Date | null;
                pipelineInputId: string | null;
                keyPrefix: string;
                lastUsedAt: Date | null;
            }[]>;
            create: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    name: string;
                    scopes?: string[] | undefined;
                    expiresAt?: Date | undefined;
                    pipelineInputId?: string | undefined;
                };
                _input_out: {
                    name: string;
                    scopes?: string[] | undefined;
                    expiresAt?: Date | undefined;
                    pipelineInputId?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                name: string;
                keyPrefix: string;
                key: string;
                scopes: string[];
                expiresAt: Date | null;
                createdAt: Date;
                pipelineInputId: string | null;
            }>;
            revoke: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
        attachments: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getDownloadLinkByDocumentId: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    documentId: string;
                };
                _input_out: {
                    documentId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                name: string;
                url: string;
            }>;
        }>;
        connections: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getAll: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, ConnectionsPayload>;
            credentialDependents: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, CredentialDependentsPayload>;
            connectTelegram: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                url: string;
                token: string;
                expiresAt: Date;
            }>;
            connectTelegramTeam: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                name: string;
                created: boolean;
            }>;
        }>;
        credentials: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getCredentials: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: ExternalServiceCredentialsId;
                name: string;
                type: ExternalServiceType;
            }[]>;
            addCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    name: string;
                } & ({
                    type: ExternalServiceType.AFFINITY;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                        webhookSignatureKey?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.ATTIO;
                    credentials: {
                        accessToken: string;
                        baseUrl?: string | undefined;
                        apiTokenId?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.SLACK;
                    credentials: {
                        accessToken: string;
                        teamId?: string | undefined;
                        enterpriseId?: string | undefined;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.AIRTABLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        accessTokenExpiresAt: string;
                        refreshTokenExpiresAt: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE_GMAIL;
                    credentials: {
                        refreshToken: string;
                        baseUrl?: string | undefined;
                    } | {
                        mailbox: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DROPBOX;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GRANOLA;
                    credentials: {
                        apiKey: string;
                    };
                } | {
                    type: ExternalServiceType.EVERTRACE;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DEALROOM;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.NATIVE_VALUATIONS | ExternalServiceType.NATIVE_KNOWLEDGE;
                    baseUrl?: string | undefined;
                } | {
                    type: ExternalServiceType;
                    claimToken: string;
                });
                _input_out: {
                    name: string;
                } & ({
                    type: ExternalServiceType.AFFINITY;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                        webhookSignatureKey?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.ATTIO;
                    credentials: {
                        accessToken: string;
                        baseUrl?: string | undefined;
                        apiTokenId?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.SLACK;
                    credentials: {
                        accessToken: string;
                        teamId?: string | undefined;
                        enterpriseId?: string | undefined;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.AIRTABLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        accessTokenExpiresAt: string;
                        refreshTokenExpiresAt: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE_GMAIL;
                    credentials: {
                        refreshToken: string;
                        baseUrl?: string | undefined;
                    } | {
                        mailbox: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DROPBOX;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GRANOLA;
                    credentials: {
                        apiKey: string;
                    };
                } | {
                    type: ExternalServiceType.EVERTRACE;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DEALROOM;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.NATIVE_VALUATIONS | ExternalServiceType.NATIVE_KNOWLEDGE;
                    baseUrl?: string | undefined;
                } | {
                    type: ExternalServiceType;
                    claimToken: string;
                });
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, void>;
            updateCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                    name: string;
                } & ({
                    type: ExternalServiceType.AFFINITY;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                        webhookSignatureKey?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.ATTIO;
                    credentials: {
                        accessToken: string;
                        baseUrl?: string | undefined;
                        apiTokenId?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.SLACK;
                    credentials: {
                        accessToken: string;
                        teamId?: string | undefined;
                        enterpriseId?: string | undefined;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.AIRTABLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        accessTokenExpiresAt: string;
                        refreshTokenExpiresAt: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE_GMAIL;
                    credentials: {
                        refreshToken: string;
                        baseUrl?: string | undefined;
                    } | {
                        mailbox: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DROPBOX;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GRANOLA;
                    credentials: {
                        apiKey: string;
                    };
                } | {
                    type: ExternalServiceType.EVERTRACE;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DEALROOM;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.NATIVE_VALUATIONS;
                    baseUrl?: string | undefined;
                } | {
                    type: ExternalServiceType;
                    claimToken: string;
                });
                _input_out: {
                    id: string;
                    name: string;
                } & ({
                    type: ExternalServiceType.AFFINITY;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                        webhookSignatureKey?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.ATTIO;
                    credentials: {
                        accessToken: string;
                        baseUrl?: string | undefined;
                        apiTokenId?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.SLACK;
                    credentials: {
                        accessToken: string;
                        teamId?: string | undefined;
                        enterpriseId?: string | undefined;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.AIRTABLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        accessTokenExpiresAt: string;
                        refreshTokenExpiresAt: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GOOGLE_GMAIL;
                    credentials: {
                        refreshToken: string;
                        baseUrl?: string | undefined;
                    } | {
                        mailbox: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DROPBOX;
                    credentials: {
                        accessToken: string;
                        refreshToken: string;
                        expiresAt: number;
                    };
                } | {
                    type: ExternalServiceType.GRANOLA;
                    credentials: {
                        apiKey: string;
                    };
                } | {
                    type: ExternalServiceType.EVERTRACE;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.DEALROOM;
                    credentials: {
                        apiKey: string;
                        baseUrl?: string | undefined;
                    };
                } | {
                    type: ExternalServiceType.NATIVE_VALUATIONS;
                    baseUrl?: string | undefined;
                } | {
                    type: ExternalServiceType;
                    claimToken: string;
                });
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, void>;
            deleteCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, void>;
            connectMethods: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, Partial<Record<ExternalServiceType, ConnectMethod>>>;
            slackConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            airtableConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            attioConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            googleConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            gmailConnectPolicy: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                method: "oauth" | "delegated";
                signIn: boolean;
            }>;
            gmailConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            dropboxConnectUrl: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | undefined>;
            attioListObjects: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    credentialsId?: string | null | undefined;
                };
                _input_out: {
                    credentialsId?: string | null | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                name: string;
                slug: string | null;
            }[]>;
            listEntryPoints: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    ref: {
                        kind: "knowledge-graph";
                    } | {
                        kind: "adapter";
                        adapterType: string;
                        credentialsId?: string | null | undefined;
                    } | {
                        kind: "generic";
                        shape: {
                            properties: Record<string, unknown>;
                            edges: Record<string, {
                                target: unknown;
                            }>;
                        };
                    } | {
                        kind: "generic_reference";
                        tg_id: unknown;
                    } | {
                        kind: "dynamic";
                        adapterKind: string;
                        credentialsId: string | null;
                        objectType?: string | undefined;
                    } | {
                        kind: "static";
                        schemaTypeId: string;
                    } | {
                        kind: "unset";
                    };
                    credentialsId?: string | undefined;
                };
                _input_out: {
                    ref: {
                        kind: "knowledge-graph";
                    } | {
                        kind: "adapter";
                        adapterType: string;
                        credentialsId?: string | null | undefined;
                    } | {
                        kind: "generic";
                        shape: {
                            properties: Record<string, movement_engine_public_catalog.ExpressionType>;
                            edges: Record<string, {
                                target: movement_engine_public_catalog.ExpressionType;
                            }>;
                        };
                    } | {
                        kind: "generic_reference";
                        tg_id: string & {
                            readonly __brand: "TranslationGraphId";
                        };
                    } | {
                        kind: "dynamic";
                        adapterKind: string;
                        credentialsId: string | null;
                        objectType?: string | undefined;
                    } | {
                        kind: "static";
                        schemaTypeId: string;
                    } | {
                        kind: "unset";
                    };
                    credentialsId?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                entries: never[];
                runtimeCapabilities: null;
                supportedTriggers: never[];
            } | {
                entries: {
                    typeId: string;
                    displayName: string;
                    writable: boolean;
                    readable: boolean;
                    description?: string | undefined;
                    externalId?: string | undefined;
                    scope?: "self-configured" | "inherits-parent-config" | undefined;
                    labelTemplate?: string | undefined;
                    collectionName?: string | undefined;
                    fires?: boolean | undefined;
                    firesOn?: string[] | undefined;
                }[];
                runtimeCapabilities: movement_engine_public_adapter.RuntimeCapabilities;
                supportedTriggers: readonly ("mutation" | "extraction" | "snapshot" | "poll" | "changes-feed" | "webhook")[];
            }>;
            describeTypes: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    ref: {
                        kind: "knowledge-graph";
                    } | {
                        kind: "adapter";
                        adapterType: string;
                        credentialsId?: string | null | undefined;
                    } | {
                        kind: "generic";
                        shape: {
                            properties: Record<string, unknown>;
                            edges: Record<string, {
                                target: unknown;
                            }>;
                        };
                    } | {
                        kind: "generic_reference";
                        tg_id: unknown;
                    } | {
                        kind: "dynamic";
                        adapterKind: string;
                        credentialsId: string | null;
                        objectType?: string | undefined;
                    } | {
                        kind: "static";
                        schemaTypeId: string;
                    } | {
                        kind: "unset";
                    };
                    typeIds: string[];
                    credentialsId?: string | undefined;
                };
                _input_out: {
                    ref: {
                        kind: "knowledge-graph";
                    } | {
                        kind: "adapter";
                        adapterType: string;
                        credentialsId?: string | null | undefined;
                    } | {
                        kind: "generic";
                        shape: {
                            properties: Record<string, movement_engine_public_catalog.ExpressionType>;
                            edges: Record<string, {
                                target: movement_engine_public_catalog.ExpressionType;
                            }>;
                        };
                    } | {
                        kind: "generic_reference";
                        tg_id: string & {
                            readonly __brand: "TranslationGraphId";
                        };
                    } | {
                        kind: "dynamic";
                        adapterKind: string;
                        credentialsId: string | null;
                        objectType?: string | undefined;
                    } | {
                        kind: "static";
                        schemaTypeId: string;
                    } | {
                        kind: "unset";
                    };
                    typeIds: string[];
                    credentialsId?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, Record<string, {
                typeId: string;
                displayName: string;
                fields: {
                    fieldId: string;
                    displayName: string;
                    kind: "string" | "number" | "boolean" | "date" | "file" | "enum" | "json" | "reference";
                    writable: boolean;
                    required: boolean;
                    enumValues?: string[] | undefined;
                    knownValues?: string[] | undefined;
                    knownValuePattern?: string | undefined;
                    referenceTargetType?: string | undefined;
                    readable?: boolean | undefined;
                    anchor?: {
                        kind: "node";
                    } | {
                        kind: "edge";
                        edgeTypeId: string;
                        side: "source" | "target";
                    } | undefined;
                    cardinality?: "one" | "many" | undefined;
                    uiHint?: "string" | "number" | "boolean" | "date" | "select" | "prompt" | "json" | "textarea" | undefined;
                    hideOn?: "root" | "child" | undefined;
                    placeholder?: string | undefined;
                    description?: string | undefined;
                    functions?: {
                        name: string;
                        displayName: string;
                        summary: string;
                        params: {
                            name: string;
                            kind: "string" | "value";
                            doc: string;
                            variadic?: boolean | undefined;
                        }[];
                        returnKind?: "string" | "number" | "boolean" | "date" | "file" | "enum" | "json" | "reference" | undefined;
                        effects?: {
                            reads?: string[] | undefined;
                            writes?: string[] | undefined;
                            ai?: boolean | undefined;
                            now?: boolean | undefined;
                            suspend?: boolean | undefined;
                        } | undefined;
                    }[] | undefined;
                    capability?: {
                        filterOperators?: ("in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "exists" | "within")[] | undefined;
                        orderable?: boolean | undefined;
                    } | undefined;
                }[];
                references: {
                    fieldId: string;
                    targetTypeId: string;
                    cardinality: "one" | "many";
                    targetTypeIds?: string[] | undefined;
                    required?: boolean | undefined;
                    direction?: "outgoing" | "incoming" | undefined;
                    name?: string | undefined;
                    description?: string | undefined;
                    edgeFields?: {
                        fieldId: string;
                        displayName: string;
                        kind: "string" | "number" | "boolean" | "date" | "file" | "enum" | "json" | "reference";
                        writable: boolean;
                        required: boolean;
                        enumValues?: string[] | undefined;
                        knownValues?: string[] | undefined;
                        knownValuePattern?: string | undefined;
                        referenceTargetType?: string | undefined;
                        readable?: boolean | undefined;
                        anchor?: {
                            kind: "node";
                        } | {
                            kind: "edge";
                            edgeTypeId: string;
                            side: "source" | "target";
                        } | undefined;
                        cardinality?: "one" | "many" | undefined;
                        uiHint?: "string" | "number" | "boolean" | "date" | "select" | "prompt" | "json" | "textarea" | undefined;
                        hideOn?: "root" | "child" | undefined;
                        placeholder?: string | undefined;
                        description?: string | undefined;
                        functions?: {
                            name: string;
                            displayName: string;
                            summary: string;
                            params: {
                                name: string;
                                kind: "string" | "value";
                                doc: string;
                                variadic?: boolean | undefined;
                            }[];
                            returnKind?: "string" | "number" | "boolean" | "date" | "file" | "enum" | "json" | "reference" | undefined;
                            effects?: {
                                reads?: string[] | undefined;
                                writes?: string[] | undefined;
                                ai?: boolean | undefined;
                                now?: boolean | undefined;
                                suspend?: boolean | undefined;
                            } | undefined;
                        }[] | undefined;
                        capability?: {
                            filterOperators?: ("in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "exists" | "within")[] | undefined;
                            orderable?: boolean | undefined;
                        } | undefined;
                    }[] | undefined;
                    backingFields?: string[] | undefined;
                    capability?: {
                        supportsLimit: boolean;
                        filter?: "bounded" | "native" | undefined;
                        order?: "bounded" | "native" | undefined;
                        naturalOrder?: {
                            field: string;
                            direction: "asc" | "desc";
                        } | undefined;
                    } | undefined;
                    sequenced?: "document" | "chronological" | "arrival" | undefined;
                    readable?: boolean | undefined;
                    fires?: boolean | undefined;
                    firesOn?: string[] | undefined;
                    subject?: boolean | undefined;
                    writable?: boolean | undefined;
                    linkable?: boolean | undefined;
                    ephemeral?: boolean | undefined;
                    requiresLiveRecord?: boolean | undefined;
                    awaitable?: boolean | undefined;
                    resolvesEmpty?: boolean | undefined;
                    watchable?: boolean | undefined;
                    genericOver?: {
                        field: string;
                        onNonLiteral?: "error" | "warn" | undefined;
                    } | undefined;
                }[];
                description?: string | undefined;
                externalId?: string | undefined;
                labelTemplate?: string | undefined;
                scope?: "self-configured" | "inherits-parent-config" | undefined;
                lazyFields?: boolean | undefined;
                uniquenessConstraints?: {
                    any: {
                        all: {
                            field: string;
                            fuzzy?: boolean | undefined;
                        }[];
                    }[];
                } | undefined;
                supportsFuzzyResolution?: boolean | string[] | undefined;
                uniquenessAuthorable?: boolean | undefined;
                deletable?: boolean | undefined;
                discriminatedWrite?: {
                    discriminant: string;
                    variantTypes: Record<string, string>;
                } | undefined;
                writeUnion?: {
                    variants: {
                        name: string;
                        fields: string[];
                    }[];
                } | undefined;
            }>>;
            getTgRun: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    runId: string;
                };
                _input_out: {
                    runId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                failure_reason: string | null;
                appliedActionPlans: unknown[];
                executedVersion: ExecutedMovementVersion | null;
                costMicrodollars: number;
                calls: number;
                inputTokens: number;
                outputTokens: number;
                id: TriggerRunId;
                created_at: Date;
                team_id: string;
                status: string;
                steps: unknown;
                errors: unknown;
                trigger_id: string;
                trigger_type: string;
                diagnostics: unknown;
                engine: string | null;
                record_id: string | null;
                movement_version_id: MovementVersionId | null;
                trigger_payload: unknown;
                changed_fields: string[] | null;
                nodes_written: number;
                dry_run: boolean;
                started_at: Date;
                completed_at: Date | null;
                failed_at: Date | null;
                cancel_requested_at: Date | null;
                cancel_reason: string | null;
                ops_run_id: string | null;
                limit_pause: unknown;
                cost_cap_baseline_microdollars: string;
                last_heartbeat_at: Date | null;
                trigger_event_id: TriggerEventId | null;
                lease_owner: string | null;
                lease_until: Date | null;
                lease_token: string | null;
            }>;
        }>;
        controlTower: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            listParkedRuns: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, ParkedRunSummary[]>;
            listAskRecords: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, AskRecordSummary[]>;
            answerAskRecord: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    askId: string;
                    answer: unknown;
                };
                _input_out: {
                    askId: string;
                    answer: unknown;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                askId: string;
                state: string;
            }>;
            abortRun: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    runId: string;
                };
                _input_out: {
                    runId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                runId: string;
            }>;
            resumeRun: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    runId: string;
                };
                _input_out: {
                    runId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                runId: string;
                resumed: number;
            }>;
            listRuns: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, TeamRunSummary[]>;
        }>;
        googleSheets: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            pickerToken: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    credentialsId: string;
                } | {
                    credentialName: string;
                };
                _input_out: {
                    credentialsId: string;
                } | {
                    credentialName: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string>;
            grant: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: ({
                    credentialsId: string;
                } | {
                    credentialName: string;
                }) & {
                    spreadsheetId: string;
                    name?: string | undefined;
                };
                _input_out: ({
                    credentialsId: string;
                } | {
                    credentialName: string;
                }) & {
                    spreadsheetId: string;
                    name?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                granted: true;
            }>;
            listGrants: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    credentialsId: string;
                } | {
                    credentialName: string;
                };
                _input_out: {
                    credentialsId: string;
                } | {
                    credentialName: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, GrantedSpreadsheet[]>;
            revoke: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: ({
                    credentialsId: string;
                } | {
                    credentialName: string;
                }) & {
                    spreadsheetId: string;
                };
                _input_out: ({
                    credentialsId: string;
                } | {
                    credentialName: string;
                }) & {
                    spreadsheetId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                revoked: true;
            }>;
        }>;
        graphExplorer: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            listTeams: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, GraphExplorerTeam[]>;
            listInstances: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    teamId?: string | undefined;
                } | undefined;
                _input_out: {
                    teamId?: string | undefined;
                } | undefined;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, GraphExplorerInstance[]>;
            walk: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                    credentialsId?: string | undefined;
                    position?: string | undefined;
                    forceRefresh?: boolean | undefined;
                    teamId?: string | undefined;
                };
                _input_out: {
                    adapterType: string;
                    credentialsId?: string | undefined;
                    position?: string | undefined;
                    forceRefresh?: boolean | undefined;
                    teamId?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, GraphExplorerHop>;
        }>;
        handbook: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getShelf: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                books: LibraryBook[];
            }>;
        }>;
        home: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getDashboard: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, DashboardPayload>;
        }>;
        investments: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getPortfolioInvestments: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                        aggregation?: "investment" | "company" | undefined;
                    };
                    grouping?: "investment_date" | "moic" | "fair_value" | "total_value" | null | undefined;
                    lens?: "investment" | "holdings" | undefined;
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        aggregation: "investment" | "company";
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                    lens: "investment" | "holdings";
                    grouping?: "investment_date" | "moic" | "fair_value" | "total_value" | null | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                items: {
                    totalInvested: number | null;
                    currentValueCurrency: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK";
                    moic: number | null;
                    unrealizedValue: number;
                    realizedValue: number;
                    realizedCash: number;
                    totalValue: number;
                    retainedAll: number;
                    retainedInCompany: number;
                    holdsRetainedAssets: boolean;
                    holdsTrackingAssets: boolean;
                    carriesSwapValue: boolean;
                    name: string;
                    slug: string | null;
                    image_url: string | null;
                    country: string | null;
                    personal_website: string | null;
                    short_description: string | null;
                    acquired_by_legal_entity_id: LegalEntityId | null;
                    legal_entity_id: LegalEntityId;
                    investment_ids: string[];
                    investments: {
                        id: string;
                        date: Date;
                        type: string;
                    }[];
                    is_exited: unknown;
                    first_invested_at: Date | null;
                    point_of_contact: {
                        id: UserId | null;
                        name: string | null;
                        image_url: string | null;
                    };
                    acquirer: {
                        id: LegalEntityId | null;
                        name: string | null;
                        image_url: string | null;
                        slug: string | null;
                    };
                    acquired_by: {
                        id: string;
                        name: string;
                        image_url: string | null;
                        slug: string | null;
                    }[];
                    attributions: {
                        name: string;
                        image_url: string | null;
                    }[];
                    investors: {
                        name: string;
                        image_url: string | null;
                    }[];
                    co_investors: {
                        id: string;
                        name: string;
                    }[] | null;
                    description?: string | null | undefined;
                    themes?: string[] | null | undefined;
                    latest_round?: {
                        date: Date;
                        name: string;
                        raisedAmount: number | null;
                        raisedCurrency: CurrencyIsoCode | null;
                        valuationAmount: number | null;
                        valuationCurrency: CurrencyIsoCode | null;
                        valuationType: ValuationType | null;
                    } | null | undefined;
                    matches_name_filter?: boolean | undefined;
                }[];
                totals: {
                    moic: number | null;
                    currency: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK";
                    totalInvested: number;
                    unrealizedValue: number;
                    realizedValue: number;
                    totalValue: number;
                };
            }>;
            getInvestmentCalculation: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    investments: {
                        id: string;
                        date: unknown;
                    }[];
                    config: {
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                    };
                };
                _input_out: {
                    investments: {
                        id: string;
                        date: Date | null;
                    }[];
                    config: {
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                    };
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                message: ProcessMessage[];
            }>;
            getPortfolioTotals: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        aggregation?: "investment" | "company" | undefined;
                    };
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        aggregation: "investment" | "company";
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                    };
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                totalInvested: number;
                unrealizedValue: number;
                realizedValue: number;
                totalValue: number;
                moic: number | null;
                currency: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK";
            }>;
            updatePointOfContact: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    legalEntityId: string;
                    pointOfContactUserId?: string | null | undefined;
                };
                _input_out: {
                    legalEntityId: string;
                    pointOfContactUserId?: string | null | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, void>;
            getCountryOptions: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string[] | undefined>;
            getYearOptions: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                    scope?: "investment" | "company" | undefined;
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                    scope: "investment" | "company";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string[] | undefined>;
            getCSVExport: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                        aggregation?: "investment" | "company" | null | undefined;
                    };
                    grouping: "investment_date" | "moic" | "fair_value" | "total_value";
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                        aggregation?: "investment" | "company" | null | undefined;
                    };
                    grouping: "investment_date" | "moic" | "fair_value" | "total_value";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, Record<string, string | number | null | undefined>[]>;
            getPerCompanyMovementExport: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                    range: {
                        from: string;
                        to: string;
                    };
                };
                _input_out: {
                    filter: {
                        name?: string | null | undefined;
                        portfolioIds?: string[] | null | undefined;
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        raisedFrom?: string | null | undefined;
                        raisedTo?: string | null | undefined;
                        coInvestors?: string[] | null | undefined;
                        themes?: string[] | null | undefined;
                        geos?: string[] | null | undefined;
                        entityTypes?: ("COMPANY" | "FUND" | "NATURAL_PERSON" | "SPV" | "ESOP" | "PORTFOLIO_COMPANY")[] | null | undefined;
                    };
                    config: {
                        portfolioIds?: string[] | null | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationDate?: string | null | undefined;
                        showDetails?: boolean | null | undefined;
                    };
                    range: {
                        from: string;
                        to: string;
                    };
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, Record<string, string | number | null | undefined>[]>;
        }>;
        journey: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            funnel: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    subject: "user" | "team";
                };
                _input_out: {
                    subject: "user" | "team";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                subject: "user";
                steps: readonly ["signed_up", "mcp_connected", "first_mcp_call", "first_automation_saved"];
                counts: {
                    signed_up: number;
                    mcp_connected: number;
                    first_mcp_call: number;
                    first_automation_saved: number;
                };
                launchAt: Date;
            } | {
                subject: "team";
                steps: readonly ["created", "first_automation_saved", "first_run"];
                counts: {
                    first_automation_saved: number;
                    created: number;
                    first_run: number;
                };
                launchAt: Date;
            }>;
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    subject: "user" | "team";
                    stuckAt?: "created" | "signed_up" | "mcp_connected" | "first_mcp_call" | "first_automation_saved" | "first_run" | null | undefined;
                    limit?: number | undefined;
                    cursor?: string | undefined;
                };
                _input_out: {
                    subject: "user" | "team";
                    limit: number;
                    stuckAt?: "created" | "signed_up" | "mcp_connected" | "first_mcp_call" | "first_automation_saved" | "first_run" | null | undefined;
                    cursor?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                rows: {
                    mcp_connected_at: Date | null;
                    first_mcp_call_at: Date | null;
                    first_mcp_tool: string | null;
                    first_automation_saved_at: Date | null;
                    id: UserId;
                    label: string;
                    created_at: Date;
                }[];
                nextCursor: string | null;
            } | {
                rows: {
                    first_automation_saved_at: Date | null;
                    first_run_at: Date | null;
                    id: TeamId;
                    label: string;
                    created_at: Date;
                }[];
                nextCursor: string | null;
            }>;
        }>;
        knowledge: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            ontology: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                onResourceChange: _trpc_server.BuildProcedure<"subscription", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        kinds?: ("movement" | "ontology" | "kg-data")[] | undefined;
                    };
                    _input_out: {
                        kinds?: ("movement" | "ontology" | "kg-data")[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, _trpc_server_observable.Observable<{
                    kind: "ontology" | "movement" | "kg-data";
                    teamId: string;
                    source: "agent" | "user" | "api" | "pipeline";
                    action: string;
                    resourceId?: string;
                    originId?: string;
                }, unknown>>;
                getNodeTypes: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: NodeTypeId;
                    created_at: Date;
                    updated_at: Date;
                    category: NodeTypeCategory;
                    display_name_template: string | null;
                    display_name_expression: unknown;
                    sort_order: number;
                }[]>;
                getNodeType: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: NodeTypeId;
                    created_at: Date;
                    updated_at: Date;
                    category: NodeTypeCategory;
                    display_name_template: string | null;
                    display_name_expression: unknown;
                }>;
                createNodeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        category: NodeTypeCategory;
                        description?: string | undefined;
                    };
                    _input_out: {
                        name: string;
                        description: string;
                        category: NodeTypeCategory;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: NodeTypeId;
                    category: NodeTypeCategory;
                }>;
                updateNodeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        category?: NodeTypeCategory | undefined;
                        displayNameTemplate?: string | null | undefined;
                        displayNameExpression?: any;
                        uniquenessConstraints?: any;
                    };
                    _input_out: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        category?: NodeTypeCategory | undefined;
                        displayNameTemplate?: string | null | undefined;
                        displayNameExpression?: any;
                        uniquenessConstraints?: any;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: NodeTypeId;
                    category: NodeTypeCategory;
                }>;
                deleteNodeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: NodeTypeId;
                }>;
                getPropertyTypes: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                    };
                    _input_out: {
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    writable_by: string[] | null;
                    description: string;
                    name: string;
                    id: PropertyTypeId;
                    created_at: Date;
                    updated_at: Date;
                    identity: PropertyIdentity;
                    cardinality: PropertyCardinality;
                    sort_order: number;
                    node_type_id: NodeTypeId | null;
                    edge_type_id: EdgeTypeId | null;
                    value_type: PropertyValueType;
                    evaluation_strategy: EvaluationStrategy;
                    enum_values: string[] | null;
                }[]>;
                createPropertyType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        valueType: PropertyValueType;
                        evaluationStrategy: EvaluationStrategy;
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                        description?: string | undefined;
                        identity?: PropertyIdentity | undefined;
                        cardinality?: PropertyCardinality | undefined;
                        enumValues?: string[] | null | undefined;
                        writableBy?: EvidenceType[] | null | undefined;
                    };
                    _input_out: {
                        name: string;
                        description: string;
                        valueType: PropertyValueType;
                        identity: PropertyIdentity;
                        evaluationStrategy: EvaluationStrategy;
                        cardinality: PropertyCardinality;
                        enumValues: string[] | null;
                        writableBy: EvidenceType[] | null;
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: PropertyTypeId;
                    node_type_id: NodeTypeId | null;
                    edge_type_id: EdgeTypeId | null;
                }>;
                updatePropertyType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                        name?: string | undefined;
                        description?: string | undefined;
                        valueType?: PropertyValueType | undefined;
                        identity?: PropertyIdentity | undefined;
                        evaluationStrategy?: EvaluationStrategy | undefined;
                        cardinality?: PropertyCardinality | undefined;
                        enumValues?: string[] | null | undefined;
                        writableBy?: EvidenceType[] | null | undefined;
                    };
                    _input_out: {
                        id: string;
                        nodeTypeId?: string | undefined;
                        edgeTypeId?: string | undefined;
                        name?: string | undefined;
                        description?: string | undefined;
                        valueType?: PropertyValueType | undefined;
                        identity?: PropertyIdentity | undefined;
                        evaluationStrategy?: EvaluationStrategy | undefined;
                        cardinality?: PropertyCardinality | undefined;
                        enumValues?: string[] | null | undefined;
                        writableBy?: EvidenceType[] | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: PropertyTypeId;
                    node_type_id: NodeTypeId | null;
                }>;
                deletePropertyType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: PropertyTypeId;
                }>;
                reorderPropertyTypes: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        ids: string[];
                    };
                    _input_out: {
                        ids: string[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                getEdgeTypes: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    source_node_type_id: NodeTypeId;
                    description: string;
                    id: EdgeTypeId;
                    created_at: Date;
                    updated_at: Date;
                    scopes: boolean;
                    required: boolean;
                    filters: unknown;
                    sort_order: number;
                    outbound_name: string;
                    inbound_name: string;
                    target_node_type_id: NodeTypeId;
                    edge_group: string | null;
                    source_node_type_name: string | null;
                    target_node_type_name: string | null;
                }[]>;
                getEdgeType: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    source_node_type_id: NodeTypeId;
                    description: string;
                    id: EdgeTypeId;
                    created_at: Date;
                    updated_at: Date;
                    scopes: boolean;
                    required: boolean;
                    filters: unknown;
                    outbound_name: string;
                    inbound_name: string;
                    target_node_type_id: NodeTypeId;
                    edge_group: string | null;
                    source_node_type_name: string | null;
                    target_node_type_name: string | null;
                }>;
                createEdgeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        outboundName: string;
                        inboundName: string;
                        sourceNodeTypeId: string;
                        targetNodeTypeId: string;
                        description?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        edgeGroup?: string | null | undefined;
                    };
                    _input_out: {
                        outboundName: string;
                        inboundName: string;
                        description: string;
                        sourceNodeTypeId: string;
                        targetNodeTypeId: string;
                        required: boolean;
                        scopes: boolean;
                        filters: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[];
                        edgeGroup?: string | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeTypeId;
                    outbound_name: string;
                    inbound_name: string;
                }>;
                updateEdgeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        outboundName?: string | undefined;
                        inboundName?: string | undefined;
                        description?: string | undefined;
                        sourceNodeTypeId?: string | undefined;
                        targetNodeTypeId?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        edgeGroup?: string | null | undefined;
                    };
                    _input_out: {
                        id: string;
                        outboundName?: string | undefined;
                        inboundName?: string | undefined;
                        description?: string | undefined;
                        sourceNodeTypeId?: string | undefined;
                        targetNodeTypeId?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        edgeGroup?: string | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeTypeId;
                    outbound_name: string;
                    inbound_name: string;
                }>;
                deleteEdgeType: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeTypeId;
                }>;
                createEdgeGroup: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        sourceNodeTypeId: string;
                        targetNodeTypeIds: string[];
                        description?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                    };
                    _input_out: {
                        name: string;
                        description: string;
                        sourceNodeTypeId: string;
                        targetNodeTypeIds: string[];
                        required: boolean;
                        scopes: boolean;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeTypeId;
                    outbound_name: string;
                    inbound_name: string;
                }[]>;
                updateEdgeGroup: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeGroup: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                        targetNodeTypeIds?: string[] | undefined;
                    };
                    _input_out: {
                        edgeGroup: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        required?: boolean | undefined;
                        scopes?: boolean | undefined;
                        targetNodeTypeIds?: string[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    ok: boolean;
                }>;
                deleteEdgeGroup: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeGroup: string;
                    };
                    _input_out: {
                        edgeGroup: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    deleted: number;
                }>;
                getOntologySummary: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    nodeTypes: {
                        description: string;
                        name: string;
                        id: NodeTypeId;
                        category: NodeTypeCategory;
                        icon_svg: string | null;
                        display_name_template: string | null;
                        display_name_expression: unknown;
                        sort_order: number;
                        uniqueness_constraints: unknown;
                    }[];
                    edgeTypes: {
                        description: string;
                        id: EdgeTypeId;
                        scopes: boolean;
                        required: boolean;
                        filters: unknown;
                        sort_order: number;
                        outbound_name: string;
                        inbound_name: string;
                        source_node_type_id: NodeTypeId;
                        target_node_type_id: NodeTypeId;
                        edge_group: string | null;
                    }[];
                    propertyTypes: {
                        writable_by: string[] | null;
                        description: string;
                        name: string;
                        id: PropertyTypeId;
                        identity: PropertyIdentity;
                        cardinality: PropertyCardinality;
                        sort_order: number;
                        node_type_id: NodeTypeId | null;
                        edge_type_id: EdgeTypeId | null;
                        value_type: PropertyValueType;
                        evaluation_strategy: EvaluationStrategy;
                        enum_values: string[] | null;
                    }[];
                }>;
                getTemplates: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    key: string;
                    name: string;
                    description: string;
                    preview: string[];
                }[]>;
                materializeTemplate: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        templateKey: string;
                    };
                    _input_out: {
                        templateKey: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, MaterializeResult>;
                generateNodeIcon: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                    };
                    _input_out: {
                        nodeTypeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    svg: string;
                }>;
            }>;
            extractionGraph: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getPlugins: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string | null;
                    type: string;
                    name: string;
                    id: PluginId;
                    stages: string[];
                    endpoint: string | null;
                    method: string;
                    auth: unknown;
                    headers: unknown;
                }[]>;
                createPlugin: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        stages: ("content" | "entity")[];
                        description?: string | undefined;
                        type?: "bundled" | "external" | undefined;
                        endpoint?: string | null | undefined;
                        method?: "POST" | "PUT" | "PATCH" | undefined;
                        auth?: {
                            type: "none";
                        } | {
                            type: "bearer";
                            token: string;
                        } | {
                            type: "basic";
                            username: string;
                            password: string;
                        } | {
                            type: "api_key";
                            headerName: string;
                            apiKey: string;
                        } | undefined;
                        headers?: Record<string, string> | undefined;
                    };
                    _input_out: {
                        name: string;
                        type: "bundled" | "external";
                        method: "POST" | "PUT" | "PATCH";
                        stages: ("content" | "entity")[];
                        description?: string | undefined;
                        endpoint?: string | null | undefined;
                        auth?: {
                            type: "none";
                        } | {
                            type: "bearer";
                            token: string;
                        } | {
                            type: "basic";
                            username: string;
                            password: string;
                        } | {
                            type: "api_key";
                            headerName: string;
                            apiKey: string;
                        } | undefined;
                        headers?: Record<string, string> | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: PluginId;
                }>;
                updatePlugin: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        name?: string | undefined;
                        description?: string | null | undefined;
                        endpoint?: string | null | undefined;
                        method?: "POST" | "PUT" | "PATCH" | undefined;
                        auth?: {
                            type: "none";
                        } | {
                            type: "bearer";
                            token: string;
                        } | {
                            type: "basic";
                            username: string;
                            password: string;
                        } | {
                            type: "api_key";
                            headerName: string;
                            apiKey: string;
                        } | null | undefined;
                        headers?: Record<string, string> | null | undefined;
                        stages?: ("content" | "entity")[] | undefined;
                    };
                    _input_out: {
                        id: string;
                        name?: string | undefined;
                        description?: string | null | undefined;
                        endpoint?: string | null | undefined;
                        method?: "POST" | "PUT" | "PATCH" | undefined;
                        auth?: {
                            type: "none";
                        } | {
                            type: "bearer";
                            token: string;
                        } | {
                            type: "basic";
                            username: string;
                            password: string;
                        } | {
                            type: "api_key";
                            headerName: string;
                            apiKey: string;
                        } | null | undefined;
                        headers?: Record<string, string> | null | undefined;
                        stages?: ("content" | "entity")[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: PluginId;
                }>;
                deletePlugin: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: PluginId;
                }>;
                getExtractionGraphs: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    root_node_id: ExtractionGraphNodeId;
                    description: string;
                    name: string;
                    id: ExtractionGraphId;
                    created_at: Date;
                    updated_at: Date;
                    message_node_type_id: NodeTypeId;
                    message_node_type_name: string | null;
                    edge_count: string | number | bigint | null;
                }[]>;
                getExtractionGraphEdgesByMessageType: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        messageNodeTypeId: string;
                    };
                    _input_out: {
                        messageNodeTypeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    target_node_type_name: string;
                    edge_type_id: EdgeTypeId;
                    source_node_type_id: NodeTypeId;
                    edge_type_name: string;
                    target_node_type_id: NodeTypeId;
                }[]>;
                getExtractionGraph: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    nodes: {
                        node_type_id: NodeTypeId;
                        id: ExtractionGraphNodeId;
                        filters: unknown;
                        instructions: string | null;
                        expand: boolean;
                        gather: boolean;
                        sort_order: number;
                        property_overrides: unknown;
                        edge_property_overrides: unknown;
                        content_plugins: unknown;
                        entity_plugins: unknown;
                        default_property_mappings: unknown;
                        node_type_name: string | null;
                        node_type_category: NodeTypeCategory | null;
                    }[];
                    edges: {
                        id: ExtractionGraphEdgeId;
                        edge_type_id: EdgeTypeId;
                        source_node_id: ExtractionGraphNodeId;
                        target_node_id: ExtractionGraphNodeId;
                        edge_type_outbound_name: string | null;
                        edge_type_inbound_name: string | null;
                    }[];
                    propertyTypes: {
                        description: string;
                        name: string;
                        id: PropertyTypeId;
                        identity: PropertyIdentity;
                        node_type_id: NodeTypeId | null;
                        edge_type_id: EdgeTypeId | null;
                        value_type: PropertyValueType;
                    }[];
                    edgePropertyTypes: {
                        description: string;
                        name: string;
                        id: PropertyTypeId;
                        identity: PropertyIdentity;
                        node_type_id: NodeTypeId | null;
                        edge_type_id: EdgeTypeId | null;
                        value_type: PropertyValueType;
                    }[];
                    root_node_id: ExtractionGraphNodeId;
                    description: string;
                    name: string;
                    id: ExtractionGraphId;
                    created_at: Date;
                    updated_at: Date;
                    message_node_type_id: NodeTypeId;
                    message_node_type_name: string | null;
                }>;
                createExtractionGraph: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        messageNodeTypeId: string;
                        description?: string | undefined;
                    };
                    _input_out: {
                        name: string;
                        description: string;
                        messageNodeTypeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: ExtractionGraphId;
                }>;
                updateExtractionGraph: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                    };
                    _input_out: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    name: string;
                    id: ExtractionGraphId;
                }>;
                deleteExtractionGraph: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: ExtractionGraphId;
                }>;
                addExtractionGraphEdge: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        extractionGraphId: string;
                        sourceExtractionNodeId: string;
                        edgeTypeId: string;
                        targetNodeTypeId: string;
                        instructions?: string | null | undefined;
                        gather?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        edgePropertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                    };
                    _input_out: {
                        extractionGraphId: string;
                        sourceExtractionNodeId: string;
                        edgeTypeId: string;
                        targetNodeTypeId: string;
                        instructions?: string | null | undefined;
                        gather?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        edgePropertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: ExtractionGraphEdgeId;
                }>;
                updateExtractionGraphNode: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        propertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                        edgePropertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                        instructions?: string | null | undefined;
                        gather?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        contentPlugins?: {
                            pluginId: string;
                            config?: Record<string, unknown> | undefined;
                        }[] | null | undefined;
                        entityPlugins?: {
                            pluginId: string;
                            config?: Record<string, unknown> | undefined;
                        }[] | null | undefined;
                        defaultPropertyMappings?: {
                            source: {
                                mode: "property";
                                fieldKey: string;
                            } | {
                                mode: "static";
                                value: string;
                            } | {
                                mode: "llm";
                                prompt: string;
                            };
                            targetPropertyTypeId: string;
                            traversal?: {
                                edgeTypeId: string;
                            }[] | undefined;
                        }[] | undefined;
                    };
                    _input_out: {
                        id: string;
                        propertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                        edgePropertyOverrides?: {
                            property_type_id: string;
                            instructions?: string | undefined;
                        }[] | null | undefined;
                        instructions?: string | null | undefined;
                        gather?: boolean | undefined;
                        filters?: {
                            side: "source" | "target";
                            property: string;
                            value: string;
                        }[] | undefined;
                        contentPlugins?: {
                            pluginId: string;
                            config?: Record<string, unknown> | undefined;
                        }[] | null | undefined;
                        entityPlugins?: {
                            pluginId: string;
                            config?: Record<string, unknown> | undefined;
                        }[] | null | undefined;
                        defaultPropertyMappings?: {
                            source: {
                                mode: "property";
                                fieldKey: string;
                            } | {
                                mode: "static";
                                value: string;
                            } | {
                                mode: "llm";
                                prompt: string;
                            };
                            traversal: {
                                edgeTypeId: string;
                            }[];
                            targetPropertyTypeId: string;
                        }[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: ExtractionGraphNodeId;
                }>;
                removeExtractionGraphEdge: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: ExtractionGraphEdgeId;
                }>;
            }>;
            graph: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getNodes: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                        search?: string | undefined;
                        limit?: number | undefined;
                        offset?: number | undefined;
                    };
                    _input_out: {
                        nodeTypeId: string;
                        limit: number;
                        offset: number;
                        search?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    nodes: {
                        display_value: string | null;
                        node_type_name: string | null;
                        node_type_id: NodeTypeId;
                        id: NodeId;
                        created_at: Date;
                        updated_at: Date;
                    }[];
                    total: number;
                }>;
                getNodesTable: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                        search?: string | undefined;
                        filters?: unknown[] | undefined;
                        filterConjunction?: "and" | "or" | undefined;
                        limit?: number | undefined;
                        offset?: number | undefined;
                        sortBy?: string | undefined;
                        sortDirection?: "asc" | "desc" | undefined;
                    };
                    _input_out: {
                        nodeTypeId: string;
                        filterConjunction: "and" | "or";
                        limit: number;
                        offset: number;
                        sortDirection: "asc" | "desc";
                        search?: string | undefined;
                        filters?: ({
                            columnId: string;
                            operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                            value?: string | number | boolean | null | undefined;
                            values?: string[] | undefined;
                            negated?: boolean | undefined;
                        } & {
                            group?: {
                                conjunction: "and" | "or";
                                filters: ({
                                    columnId: string;
                                    operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                                    value?: string | number | boolean | null | undefined;
                                    values?: string[] | undefined;
                                    negated?: boolean | undefined;
                                } & any)[];
                            };
                        })[] | undefined;
                        sortBy?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    columns: {
                        name: string;
                        id: PropertyTypeId;
                        identity: PropertyIdentity;
                        value_type: PropertyValueType;
                        enum_values: string[] | null;
                    }[];
                    rows: {
                        id: NodeId;
                        createdAt: Date;
                        updatedAt: Date;
                        values: Record<string, string | number | boolean | null>;
                        scopingValues: Record<string, {
                            parentName: string;
                            parentNodeId: string;
                        }>;
                        displayName: string | null;
                    }[];
                    total: number;
                    scopingColumns: {
                        edgeTypeId: EdgeTypeId;
                        edgeTypeName: string;
                        targetNodeTypeName: string;
                    }[];
                    propertyIds: Record<string, Record<string, string>>;
                    hasDisplayName: boolean;
                }>;
                parseNaturalLanguageFilter: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        query: string;
                        columns: {
                            id: string;
                            name: string;
                            value_type: string;
                            enum_values?: string[] | null | undefined;
                        }[];
                    };
                    _input_out: {
                        query: string;
                        columns: {
                            id: string;
                            name: string;
                            value_type: string;
                            enum_values?: string[] | null | undefined;
                        }[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    columnId: string;
                    operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                    value?: string | number | boolean | null | undefined;
                    values?: string[] | undefined;
                    negated?: boolean | undefined;
                } & {
                    group?: {
                        conjunction: "and" | "or";
                        filters: ({
                            columnId: string;
                            operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                            value?: string | number | boolean | null | undefined;
                            values?: string[] | undefined;
                            negated?: boolean | undefined;
                        } & any)[];
                    };
                })[]>;
                saveFilter: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                        filters: unknown[];
                        conjunction?: "and" | "or" | undefined;
                    };
                    _input_out: {
                        nodeTypeId: string;
                        filters: ({
                            columnId: string;
                            operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                            value?: string | number | boolean | null | undefined;
                            values?: string[] | undefined;
                            negated?: boolean | undefined;
                        } & {
                            group?: {
                                conjunction: "and" | "or";
                                filters: ({
                                    columnId: string;
                                    operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                                    value?: string | number | boolean | null | undefined;
                                    values?: string[] | undefined;
                                    negated?: boolean | undefined;
                                } & any)[];
                            };
                        })[];
                        conjunction: "and" | "or";
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: SavedFilterId;
                }>;
                getFilter: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: SavedFilterId;
                    nodeTypeId: NodeTypeId;
                    filters: ({
                        columnId: string;
                        operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                        value?: string | number | boolean | null | undefined;
                        values?: string[] | undefined;
                        negated?: boolean | undefined;
                    } & {
                        group?: {
                            conjunction: "and" | "or";
                            filters: ({
                                columnId: string;
                                operator: "in" | "contains" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "not_contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty";
                                value?: string | number | boolean | null | undefined;
                                values?: string[] | undefined;
                                negated?: boolean | undefined;
                            } & any)[];
                        };
                    })[];
                    conjunction: "and" | "or";
                } | null>;
                getNode: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    display_value: string | null;
                    properties: {
                        value_text: string | null;
                        value_number: string | null;
                        value_date: Date | null;
                        value_boolean: boolean | null;
                        value_json: unknown;
                        value_type: PropertyValueType;
                        property_id: PropertyId;
                        property_type_id: PropertyTypeId;
                        property_name: string;
                    }[];
                    outgoingEdges: {
                        target_display_value: string | null;
                        target_node_type_name: string;
                        edge_type_outbound_name: string;
                        edge_type_inbound_name: string;
                        edge_type_id: EdgeTypeId;
                        edge_id: EdgeId;
                        target_node_id: NodeId;
                        target_node_type_id: NodeTypeId;
                    }[];
                    incomingEdges: {
                        source_display_value: string | null;
                        source_node_type_name: string;
                        edge_type_outbound_name: string;
                        edge_type_inbound_name: string;
                        edge_type_id: EdgeTypeId;
                        edge_id: EdgeId;
                        source_node_id: NodeId;
                        source_node_type_id: NodeTypeId;
                    }[];
                    edgeProperties: {
                        edge_id: EdgeId | null;
                        value_text: string | null;
                        value_number: string | null;
                        value_date: Date | null;
                        value_boolean: boolean | null;
                        value_json: unknown;
                        value_type: PropertyValueType;
                        property_id: PropertyId;
                        property_type_id: PropertyTypeId;
                        property_name: string;
                    }[];
                    category: NodeTypeCategory | null;
                    node_type_name: string | null;
                    node_type_id: NodeTypeId;
                    id: NodeId;
                    created_at: Date;
                    updated_at: Date;
                    start_date: Date;
                    end_date: Date;
                }>;
                getPropertyEvidence: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        propertyId: string;
                    };
                    _input_out: {
                        propertyId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    type: EvidenceType;
                    id: EvidenceId;
                    created_at: Date;
                    excerpt: string | null;
                    linked_object_id: LinkedObjectId | null;
                    linked_object_field: string | null;
                    resource_id: string | null;
                }[]>;
                getNodeEvidence: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                    };
                    _input_out: {
                        nodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    target_name: string | null;
                    target_type: "edge" | "property";
                    description: string;
                    type: EvidenceType;
                    id: EvidenceId;
                    created_at: Date;
                    excerpt: string | null;
                    edge_id: EdgeId | null;
                    property_id: PropertyId | null;
                    resource_id: string | null;
                }[]>;
                getEdgeEvidence: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeId: string;
                    };
                    _input_out: {
                        edgeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    type: EvidenceType;
                    id: EvidenceId;
                    created_at: Date;
                    excerpt: string | null;
                    linked_object_id: LinkedObjectId | null;
                    linked_object_field: string | null;
                    resource_id: string | null;
                }[]>;
                getEvidenceSource: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        resourceId: string;
                    };
                    _input_out: {
                        resourceId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: ResourceId;
                    name: string;
                    type: ResourceType;
                    url: string | null;
                    content: string | null;
                }>;
                getNodeChanges: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                        limit?: number | undefined;
                        cursor?: string | undefined;
                    };
                    _input_out: {
                        nodeId: string;
                        limit: number;
                        cursor?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    changes: {
                        created_by_name: string | null;
                        property_id: PropertyId | null;
                        id: ChangeId;
                        created_at: Date;
                        created_by: string | null;
                        request_id: string;
                        source: ChangeSource;
                        kind: ChangeKind;
                        edge_id: EdgeId | null;
                        evidence_id: EvidenceId | null;
                        old_value: unknown;
                        new_value: unknown;
                        property_name: string | null;
                    }[];
                    nextCursor: ChangeId | null;
                }>;
                getEdgeChanges: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeId: string;
                        limit?: number | undefined;
                        cursor?: string | undefined;
                    };
                    _input_out: {
                        edgeId: string;
                        limit: number;
                        cursor?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    changes: {
                        created_by_name: string | null;
                        property_id: PropertyId | null;
                        id: ChangeId;
                        created_at: Date;
                        created_by: string | null;
                        request_id: string;
                        source: ChangeSource;
                        kind: ChangeKind;
                        edge_id: EdgeId | null;
                        evidence_id: EvidenceId | null;
                        old_value: unknown;
                        new_value: unknown;
                        property_name: string | null;
                    }[];
                    nextCursor: ChangeId | null;
                }>;
                getPropertyTimeline: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        propertyId: string;
                    };
                    _input_out: {
                        propertyId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    type: "evidence";
                    id: string;
                    evidenceType: string;
                    description: string | null;
                    excerpt: string | null;
                    resourceId: string | null;
                    context: {
                        adapterLabel: string | null;
                        pipelineInputName: string | null;
                        triggerType: string | null;
                    } | null;
                    createdAt: Date | string;
                } | {
                    type: "change";
                    id: string;
                    source: string;
                    kind: string;
                    oldValue: unknown;
                    newValue: unknown;
                    createdByName: string | null;
                    createdAt: Date | string;
                })[]>;
                createUserEdit: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        propertyId: string;
                        description: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                        valueJson?: unknown;
                    };
                    _input_out: {
                        propertyId: string;
                        description: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                        valueJson?: unknown;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EvidenceId;
                    type: EvidenceType;
                    description: string;
                    created_at: Date;
                } | null>;
                regeneratePropertyValue: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        propertyId: string;
                    };
                    _input_out: {
                        propertyId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                createProperty: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _input_out: {
                        nodeId: string;
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: PropertyId;
                    property_type_id: PropertyTypeId;
                } | null>;
                createNode: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                        properties?: {
                            propertyTypeId: string;
                            valueText?: string | null | undefined;
                            valueNumber?: string | null | undefined;
                            valueDate?: string | null | undefined;
                            valueBoolean?: boolean | null | undefined;
                            valueJson?: unknown;
                        }[] | undefined;
                    };
                    _input_out: {
                        nodeTypeId: string;
                        properties: {
                            propertyTypeId: string;
                            valueText?: string | null | undefined;
                            valueNumber?: string | null | undefined;
                            valueDate?: string | null | undefined;
                            valueBoolean?: boolean | null | undefined;
                            valueJson?: unknown;
                        }[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: NodeId;
                    created_at: Date;
                    updated_at: Date;
                    node_type_id: NodeTypeId;
                }>;
                deleteNode: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: NodeId;
                }>;
                createEdge: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeTypeId: string;
                        sourceNodeId: string;
                        targetNodeId: string;
                    };
                    _input_out: {
                        edgeTypeId: string;
                        sourceNodeId: string;
                        targetNodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeId;
                    edge_type_id: EdgeTypeId;
                    source_node_id: NodeId;
                    target_node_id: NodeId;
                }>;
                deleteEdge: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeId;
                }>;
                bulkDeleteNodes: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        ids: string[];
                    };
                    _input_out: {
                        ids: string[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    deleted: number;
                }>;
                bulkUpdateProperty: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeIds: string[];
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _input_out: {
                        nodeIds: string[];
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    updated: number;
                    created: number;
                }>;
                getEdgeTypesForNode: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                    };
                    _input_out: {
                        nodeTypeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    outgoing: {
                        id: EdgeTypeId;
                        outbound_name: string;
                        inbound_name: string;
                        target_node_type_id: NodeTypeId;
                        target_node_type_name: string;
                    }[];
                    incoming: {
                        source_node_type_id: NodeTypeId;
                        id: EdgeTypeId;
                        outbound_name: string;
                        inbound_name: string;
                        source_node_type_name: string;
                    }[];
                }>;
                searchNodes: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeTypeId: string;
                        search: string;
                        limit?: number | undefined;
                        excludeIds?: string[] | undefined;
                    };
                    _input_out: {
                        nodeTypeId: string;
                        search: string;
                        limit: number;
                        excludeIds: string[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    display_value: string | null;
                    id: NodeId;
                }[]>;
                mergeNodes: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        targetNodeId: string;
                        sourceNodeId: string;
                    };
                    _input_out: {
                        targetNodeId: string;
                        sourceNodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    mergedNodeId: NodeId;
                }>;
                getLinkedObjects: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                    };
                    _input_out: {
                        nodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    data: unknown;
                    id: LinkedObjectId;
                    updated_at: Date;
                    adapter_type: string;
                    source: LinkedObjectSource;
                    external_id: string;
                    external_object_type: string | null;
                    fetched_at: Date | null;
                }[]>;
                createManualLinkedObject: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                        adapterType: string;
                        externalId: string;
                        externalObjectType?: string | undefined;
                    };
                    _input_out: {
                        nodeId: string;
                        adapterType: string;
                        externalId: string;
                        externalObjectType?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                deleteLinkedObject: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                getLinkedResources: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeId: string;
                    };
                    _input_out: {
                        nodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    type: ResourceType;
                    name: string;
                    url: string | null;
                    id: ResourceId;
                    created_at: Date;
                    document_id: DocumentId | null;
                    payload_data: unknown;
                    raw_text: string | null;
                }[]>;
                getEdge: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeId: string;
                    };
                    _input_out: {
                        edgeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    source_display_value: string | null;
                    target_display_value: string | null;
                    properties: {
                        value_text: string | null;
                        value_number: string | null;
                        value_date: Date | null;
                        value_boolean: boolean | null;
                        value_json: unknown;
                        value_type: PropertyValueType;
                        property_id: PropertyId;
                        property_type_id: PropertyTypeId;
                        property_name: string;
                    }[];
                    propertyTypes: {
                        name: string;
                        id: PropertyTypeId;
                        identity: PropertyIdentity;
                        value_type: PropertyValueType;
                        enum_values: string[] | null;
                    }[];
                    duplicates: {
                        id: EdgeId;
                        created_at: Date;
                    }[];
                    id: EdgeId;
                    created_at: Date;
                    outbound_name: string;
                    inbound_name: string;
                    source_node_type_name: string;
                    target_node_type_name: string;
                    edge_type_id: EdgeTypeId;
                    source_node_id: NodeId;
                    target_node_id: NodeId;
                    target_node_type_id: NodeTypeId;
                    source_node_type_id: NodeTypeId;
                }>;
                createEdgeProperty: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeId: string;
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _input_out: {
                        edgeId: string;
                        propertyTypeId: string;
                        valueText?: string | null | undefined;
                        valueNumber?: string | null | undefined;
                        valueDate?: string | null | undefined;
                        valueBoolean?: boolean | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: PropertyId;
                    property_type_id: PropertyTypeId;
                } | null>;
                updateEdgeTarget: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        edgeId: string;
                        direction: "source" | "target";
                        newNodeId: string;
                    };
                    _input_out: {
                        edgeId: string;
                        direction: "source" | "target";
                        newNodeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: EdgeId;
                }>;
                mergeEdge: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        targetEdgeId: string;
                        sourceEdgeId: string;
                    };
                    _input_out: {
                        targetEdgeId: string;
                        sourceEdgeId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    mergedEdgeId: EdgeId;
                }>;
                getNodeDisplayNames: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        nodeIds: string[];
                    };
                    _input_out: {
                        nodeIds: string[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: string;
                    displayName: string | null;
                }[]>;
                globalSearch: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        search: string;
                        limit?: number | undefined;
                    };
                    _input_out: {
                        search: string;
                        limit: number;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    nodeId: string;
                    nodeTypeId: string;
                    nodeTypeName: string;
                    category: string;
                    iconSvg: string | null;
                    displayValue: string | null;
                }[]>;
            }>;
            queryAgent: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                sendMessage: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                        domain?: "query" | "output" | "ontology" | "unified" | "system" | undefined;
                        documentIds?: string[] | undefined;
                        documentMode?: "input" | "collaborating" | undefined;
                        showMode?: boolean | undefined;
                        pageContext?: {
                            page: string;
                            path?: string | undefined;
                            entities?: {
                                kind: string;
                                id?: string | undefined;
                                name?: string | undefined;
                            }[] | undefined;
                            extras?: Record<string, string> | undefined;
                        } | undefined;
                        funnelContext?: {
                            leafSlug: string;
                            pain: string;
                            painShape: string;
                            domain: string;
                            suggestedArc: "integration-first" | "model-first" | null;
                            primer?: string | undefined;
                            templateRef?: string | undefined;
                        } | undefined;
                    };
                    _input_out: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                        domain?: "query" | "output" | "ontology" | "unified" | "system" | undefined;
                        documentIds?: string[] | undefined;
                        documentMode?: "input" | "collaborating" | undefined;
                        showMode?: boolean | undefined;
                        pageContext?: {
                            page: string;
                            path?: string | undefined;
                            entities?: {
                                kind: string;
                                id?: string | undefined;
                                name?: string | undefined;
                            }[] | undefined;
                            extras?: Record<string, string> | undefined;
                        } | undefined;
                        funnelContext?: {
                            leafSlug: string;
                            pain: string;
                            painShape: string;
                            domain: string;
                            suggestedArc: "integration-first" | "model-first" | null;
                            primer?: string | undefined;
                            templateRef?: string | undefined;
                        } | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    conversationId: string;
                }>;
                cancelAgent: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        sessionId: string;
                    };
                    _input_out: {
                        sessionId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    aborted: boolean;
                }>;
                setDocumentMode: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                        mode: "input" | "collaborating";
                    };
                    _input_out: {
                        conversationId: string;
                        mode: "input" | "collaborating";
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                getActiveSession: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    sessionId: string;
                    status: string;
                } | null>;
                getConversation: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                }>;
                listConversations: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                })[]>;
                listAllConversations: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: string;
                    title: string | null;
                    updatedAt: Date;
                    preview: string;
                    legacyDomain: string | null;
                }[]>;
                getWorkingDocument: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    content: string;
                    title: string | null;
                }>;
                updateWorkingDocument: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                        content: string;
                        title?: string | undefined;
                    };
                    _input_out: {
                        conversationId: string;
                        content: string;
                        title?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                discardWorkingDocument: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                getAttachmentUrl: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        objectUri: string;
                    };
                    _input_out: {
                        objectUri: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    downloadUrl: string;
                }>;
                onUpdate: _trpc_server.BuildProcedure<"subscription", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        sessionId: string;
                    };
                    _input_out: {
                        sessionId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, _trpc_server_observable.Observable<AgentUpdate, unknown>>;
            }>;
            ontologyAgent: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                ask: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                        onboarding?: boolean | undefined;
                    };
                    _input_out: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                        onboarding?: boolean | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    conversationId: string;
                }>;
                getConversation: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                }>;
                listConversations: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                })[]>;
                onUpdate: _trpc_server.BuildProcedure<"subscription", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        sessionId: string;
                    };
                    _input_out: {
                        sessionId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, _trpc_server_observable.Observable<AgentUpdate, unknown>>;
            }>;
            outputAgent: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                ask: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        message: string;
                        sessionId: string;
                        currentConfig: unknown;
                        adapterType: string;
                        credentialsId: string | null;
                        conversationId?: string | undefined;
                        outputId?: string | undefined;
                    };
                    _input_out: {
                        message: string;
                        sessionId: string;
                        currentConfig: unknown;
                        adapterType: string;
                        credentialsId: string | null;
                        conversationId?: string | undefined;
                        outputId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    conversationId: string;
                }>;
                getConversation: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                }>;
                listConversations: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                })[]>;
                onUpdate: _trpc_server.BuildProcedure<"subscription", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        sessionId: string;
                    };
                    _input_out: {
                        sessionId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, _trpc_server_observable.Observable<AgentUpdate, unknown>>;
            }>;
            systemAgent: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                ask: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                    };
                    _input_out: {
                        message: string;
                        sessionId: string;
                        conversationId?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    conversationId: string;
                }>;
                getConversation: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        conversationId: string;
                    };
                    _input_out: {
                        conversationId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                }>;
                listConversations: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, ({
                    agentMessages: {
                        context: string | null;
                        id: string;
                        createdAt: Date;
                        conversationId: string;
                        metadata: _prisma_client_runtime_library.JsonValue | null;
                        agent: string | null;
                        content: string;
                        role: string;
                        messageType: string;
                    }[];
                } & {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    userId: string;
                    title: string | null;
                    metadata: _prisma_client_runtime_library.JsonValue;
                    agentType: string;
                    activeAgent: string;
                    handoffDepth: number;
                    workingDocumentUri: string | null;
                    workingDocumentTitle: string | null;
                    documentMode: string;
                    funnelContext: _prisma_client_runtime_library.JsonValue | null;
                    navigationState: _prisma_client_runtime_library.JsonValue;
                    navigationHistory: _prisma_client_runtime_library.JsonValue;
                })[]>;
                onUpdate: _trpc_server.BuildProcedure<"subscription", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        sessionId: string;
                    };
                    _input_out: {
                        sessionId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, _trpc_server_observable.Observable<AgentUpdate, unknown>>;
            }>;
            recipe: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                list: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: RecipeId;
                    created_at: Date;
                    updated_at: Date;
                    instructions: string;
                }[]>;
                get: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: RecipeId;
                    created_at: Date;
                    updated_at: Date;
                    instructions: string;
                }>;
                create: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                        instructions: string;
                        description?: string | undefined;
                    };
                    _input_out: {
                        name: string;
                        description: string;
                        instructions: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: RecipeId;
                    instructions: string;
                }>;
                update: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        instructions?: string | undefined;
                    };
                    _input_out: {
                        id: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        instructions?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string;
                    name: string;
                    id: RecipeId;
                    instructions: string;
                }>;
                delete: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
            }>;
            cypherAgent: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                generate: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        description: string;
                        conversationHistory?: {
                            role: "user" | "assistant";
                            content: string;
                        }[] | undefined;
                    };
                    _input_out: {
                        description: string;
                        conversationHistory?: {
                            role: "user" | "assistant";
                            content: string;
                        }[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    query: null;
                    explanation: string;
                    parseError?: undefined;
                } | {
                    query: string;
                    explanation: string;
                    parseError: string;
                } | {
                    query: string;
                    explanation: string;
                    parseError?: undefined;
                }>;
                getSchemaForDisplay: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    nodeTypes: {
                        name: string;
                        properties: {
                            name: string;
                            type: string;
                            identity: string;
                            enumValues?: string[];
                        }[];
                    }[];
                    edgeTypes: {
                        name: string;
                        source: string;
                        target: string;
                        properties: {
                            name: string;
                            type: string;
                        }[];
                    }[];
                }>;
                execute: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        query: string;
                    };
                    _input_out: {
                        query: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, CypherResult>;
            }>;
            expressionWriter: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                generate: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        intent: string;
                        nodeTypeId: string;
                        targetFieldName?: string | undefined;
                        targetFieldType?: string | undefined;
                        targetFieldOptions?: string[] | undefined;
                    };
                    _input_out: {
                        intent: string;
                        nodeTypeId: string;
                        targetFieldName?: string | undefined;
                        targetFieldType?: string | undefined;
                        targetFieldOptions?: string[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    expression: _shared_expression_types.Expression;
                    formula: string;
                }>;
            }>;
        }>;
        movement: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            catalog: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, TeamCatalogSnapshot>;
            catalogForSource: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    source: string;
                };
                _input_out: {
                    source: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, TeamCatalogSnapshot>;
            describeInstance: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapter: string;
                    credentialName?: string | undefined;
                    types?: string[] | undefined;
                    position?: string | undefined;
                    mentions?: string[] | undefined;
                    forceRefresh?: boolean | undefined;
                };
                _input_out: {
                    adapter: string;
                    credentialName?: string | undefined;
                    types?: string[] | undefined;
                    position?: string | undefined;
                    mentions?: string[] | undefined;
                    forceRefresh?: boolean | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, DescribedInstance>;
            save: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    source: string;
                    id?: string | undefined;
                    name?: string | undefined;
                    baseUpdatedAt?: string | undefined;
                    acknowledgeErrors?: boolean | undefined;
                };
                _input_out: {
                    source: string;
                    id?: string | undefined;
                    name?: string | undefined;
                    baseUpdatedAt?: string | undefined;
                    acknowledgeErrors?: boolean | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, SaveMovementResult & {
                dependentChecks: DependentCheckResult[] | null;
            }>;
            get: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, (MovementDetail & {
                facets: MovementFileFacets;
                dependents: MovementDependent[];
            }) | null>;
            story: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, story_view_view.StoryViewResult | null>;
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, (Omit<MovementListItem, "listeners"> & {
                usedBy: number;
                listeners: (MovementListenerInfo & {
                    lastRun: MovementRunItem | null;
                })[];
            })[]>;
            delete: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                deleted: boolean;
            }>;
            runs: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    movementId: string;
                };
                _input_out: {
                    movementId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, MovementRunItem[]>;
            events: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    movementId: string;
                };
                _input_out: {
                    movementId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, MovementEventItem[]>;
            runNow: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                    text?: string | undefined;
                    files?: {
                        filename: string;
                        contentType: string;
                        contentBase64: string;
                    }[] | undefined;
                };
                _input_out: {
                    id: string;
                    text?: string | undefined;
                    files?: {
                        filename: string;
                        contentType: string;
                        contentBase64: string;
                    }[] | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, MovementRunNowResult>;
        }>;
        note: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            extractNotionpPageContent: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    url: string;
                };
                _input_out: {
                    url: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | null>;
        }>;
        ops: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            vapidPublicKey: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, string | null>;
            registerDevice: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    endpoint: string;
                    keys: {
                        p256dh: string;
                        auth: string;
                    };
                    deviceLabel?: string | undefined;
                };
                _input_out: {
                    endpoint: string;
                    keys: {
                        p256dh: string;
                        auth: string;
                    };
                    deviceLabel?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                ok: boolean;
            }>;
            summary: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                running: number;
                parked: number;
                needsAttention: number;
                teamsActive: number;
                runsToday: number;
            }>;
            listFeed: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    type?: OpsEventType | undefined;
                    severity?: OpsSeverity | undefined;
                    needsAttention?: boolean | undefined;
                    limit?: number | undefined;
                    cursor?: string | undefined;
                };
                _input_out: {
                    limit: number;
                    type?: OpsEventType | undefined;
                    severity?: OpsSeverity | undefined;
                    needsAttention?: boolean | undefined;
                    cursor?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                items: {
                    team_name: string | null;
                    type: OpsEventType;
                    id: OpsEventId;
                    created_at: Date;
                    updated_at: Date | null;
                    team_id: string | null;
                    status: OpsRunStatus | null;
                    request_id: string | null;
                    title: string;
                    severity: OpsSeverity;
                    resolved_at: Date | null;
                }[];
                nextCursor: string | null;
            }>;
            listRunThread: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    runId: string;
                };
                _input_out: {
                    runId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                type: OpsEventType;
                id: OpsEventId;
                created_at: Date;
                title: string;
                detail: unknown;
                severity: OpsSeverity;
            }[]>;
            getEvent: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                type: OpsEventType;
                id: OpsEventId;
                created_at: Date;
                updated_at: Date | null;
                team_id: string | null;
                status: OpsRunStatus | null;
                request_id: string | null;
                title: string;
                detail: unknown;
                severity: OpsSeverity;
                entity_refs: unknown;
                parent_run_id: string | null;
                resolved_at: Date | null;
                team_name: string | null;
            } | undefined>;
            setResolved: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                    resolved: boolean;
                };
                _input_out: {
                    id: string;
                    resolved: boolean;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                resolved_at: Date | null;
            }>;
            translateEvent: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                goal: string;
                friction: string;
            }>;
        }>;
        plugins: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, PluginCatalogEntry[]>;
        }>;
        portfolio: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            company: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
                ctx: {
                    authorise: () => Promise<void>;
                };
                meta: object;
                errorShape: {
                    message: string;
                    code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                    data: _trpc_server_dist_error_formatter.DefaultErrorData;
                };
                transformer: _trpc_server.DefaultDataTransformer;
            }>, {
                getAllPortfolios: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                    _meta: object;
                }, {
                    description: string | null;
                    teamId: string | null;
                    type: _prisma_client.$Enums.LegalEntityType | null;
                    name: string;
                    personalWebsite: string | null;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    slug: string | null;
                    country: string | null;
                    city: string | null;
                    locations: string[];
                    stages: string[];
                    themes: string[];
                    linkedin: string | null;
                    customers: string[];
                    markets: string[];
                    email: string | null;
                    identifiers: string[];
                    sectors: string[];
                    imageUrl: string | null;
                    isPublic: boolean;
                    inferredThesis: string | null;
                    publicProfileId: string | null;
                    operatedByProfileId: string | null;
                    businessModels: string[];
                    shortDescription: string | null;
                    investmentStatus: _prisma_client.$Enums.InvestmentStatus;
                    descriptorsGeos: string[];
                    descriptorsInvestorTypes: string[];
                    descriptorsMiscTags: string[];
                    descriptorsStages: string[];
                    summaryForSimilaritySearch: string | null;
                    marketShort: string | null;
                    linkedinData: _prisma_client_runtime_library.JsonValue | null;
                    isOwnInvestingEntity: boolean | null;
                    companyMetricsId: string | null;
                    companyProfileId: string | null;
                    investingEntityId: string | null;
                    isDeprecated: boolean | null;
                    isPortfolio: boolean | null;
                    legalName: string | null;
                    alsoKnownAs: string | null;
                    acquiredByLegalEntityId: string | null;
                    underlyingCompanyId: string | null;
                    customValues: _prisma_client_runtime_library.JsonValue | null;
                    pointOfContactUserId: string | null;
                    acquiredAt: Date | null;
                    acquiredEventId: string | null;
                    legalStatus: _prisma_client.$Enums.CompanyLegalStatus;
                    otherNames: string[];
                    sentimentScore: number | null;
                    visibilityScore: number | null;
                    invitationCode: string | null;
                    experimentsActives: string[];
                    wordIdentifier: string | null;
                }[]>;
                convertTransaction: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        transactionId: string;
                        assetId: string;
                        conversionDate: string;
                        conversionPrice: string;
                        numShares: string;
                        shareClass: string;
                        currency: string;
                        interest?: string | undefined;
                    };
                    _input_out: {
                        transactionId: string;
                        assetId: string;
                        conversionDate: string;
                        conversionPrice: string;
                        numShares: string;
                        shareClass: string;
                        currency: string;
                        interest?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    teamId: string;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    eventId: string | null;
                    investmentId: string | null;
                    closeDate: Date;
                    convertedToId: string | null;
                    dueToRightsFromAssetId: string | null;
                } & {
                    equityAssetId: string;
                    convertibleAssetId: string;
                    issuingLegalEntityId: string;
                    investorId: string;
                    transfer: _prisma_client.AssetTransfer;
                }>;
                getOverview: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        slug: string;
                        config?: {
                            currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                            valuationDate?: string | null | undefined;
                        } | null | undefined;
                    };
                    _input_out: {
                        slug: string;
                        config?: {
                            currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                            valuationDate?: string | null | undefined;
                        } | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    investingEntities: {
                        id: string;
                        name: string;
                    }[];
                    invested: number | null;
                    value: number;
                    realizedValue: number;
                    status: InvestmentStatus;
                    latestRound: {
                        date: Date | undefined;
                        roundType: _prisma_client.$Enums.EquityRoundType | null | undefined;
                        isConvertible: boolean;
                        valuation: {
                            valuationType: _prisma_client.$Enums.ValuationType | null | undefined;
                            value: number | null;
                        };
                    } | null;
                    totalShares: number;
                    firstInvested: string | null;
                    moic: number | null;
                    holdings: HoldingRow[];
                    acquisitions: Acquisition[];
                    id: LegalEntityId;
                    description: string | null;
                    type: LegalEntityType | null;
                    name: string;
                    slug: string | null;
                    country: string | null;
                    personal_website: string | null;
                    short_description: string | null;
                    legal_name: string | null;
                    legal_status: CompanyLegalStatus;
                    otherNames: string | null;
                    acquirer: {
                        id: LegalEntityId | null;
                        name: string | null;
                        image_url: string | null;
                        slug: string | null;
                    };
                    investments: {
                        id: InvestmentId;
                        date: Date | null;
                    }[];
                } | null>;
                addDividends: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        amount: number;
                        currency: string;
                        fundId: string;
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        amount: number;
                        currency: string;
                        fundId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, boolean>;
                addFundDistribution: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        amount: number;
                        currency: string;
                        fundId: string;
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        amount: number;
                        currency: string;
                        fundId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                removeMarkdown: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, boolean>;
                removePrice: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, boolean>;
                updatePrice: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        date?: string | undefined;
                        price?: number | undefined;
                        currency?: CurrencyIsoCode | undefined;
                    };
                    _input_out: {
                        id: string;
                        date?: string | undefined;
                        price?: number | undefined;
                        currency?: CurrencyIsoCode | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, boolean>;
                addPrice: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        price: number;
                        currency: CurrencyIsoCode;
                        assetId?: string | undefined;
                        date?: string | undefined;
                        note?: string | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        price: number;
                        currency: CurrencyIsoCode;
                        assetId?: string | undefined;
                        date?: string | undefined;
                        note?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                getPriceAssetOptions: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                    };
                    _input_out: {
                        companyId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    value: string;
                    label: string;
                }[]>;
                updateAssetTransfer: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        transferId: string;
                        assetId: string;
                        fundId?: string | undefined;
                        numAssets?: string | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        assetName?: string | undefined;
                        date?: string | undefined;
                        type?: "CONVERTIBLE" | "CURRENCY" | "EMPLOYEE_STOCK_OPTIONS" | "EQUITY" | "EQUITY_UNKNOWN_SHARES" | "LP_INTEREST_POINT" | "SPV_INTEREST_POINT" | "UNKNOWN" | "FUND_OUTSTANDING_COMMITMENT" | "ACCRUED_INCOME" | undefined;
                        convertibleAssetId?: string | undefined;
                        conversionPrice?: string | undefined;
                        interestAmount?: string | undefined;
                        interestRate?: string | undefined;
                        discountRate?: string | undefined;
                        maturityDate?: string | undefined;
                        valuationCapCurrency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationCap?: string | undefined;
                        convertibleType?: "ASA" | "BSA_AIR" | "CONVERTIBLE_NOTE" | "LOAN" | "POST_MONEY_SAFE" | "PRE_MONEY_SAFE" | "SAFT" | "SEEDFAST" | "SEEDNOTE" | "SLIP" | undefined;
                    }[];
                    _input_out: {
                        transferId: string;
                        assetId: string;
                        fundId?: string | undefined;
                        numAssets?: string | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        assetName?: string | undefined;
                        date?: string | undefined;
                        type?: "CONVERTIBLE" | "CURRENCY" | "EMPLOYEE_STOCK_OPTIONS" | "EQUITY" | "EQUITY_UNKNOWN_SHARES" | "LP_INTEREST_POINT" | "SPV_INTEREST_POINT" | "UNKNOWN" | "FUND_OUTSTANDING_COMMITMENT" | "ACCRUED_INCOME" | undefined;
                        convertibleAssetId?: string | undefined;
                        conversionPrice?: string | undefined;
                        interestAmount?: string | undefined;
                        interestRate?: string | undefined;
                        discountRate?: string | undefined;
                        maturityDate?: string | undefined;
                        valuationCapCurrency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                        valuationCap?: string | undefined;
                        convertibleType?: "ASA" | "BSA_AIR" | "CONVERTIBLE_NOTE" | "LOAN" | "POST_MONEY_SAFE" | "PRE_MONEY_SAFE" | "SAFT" | "SEEDFAST" | "SEEDNOTE" | "SLIP" | undefined;
                    }[];
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, boolean>;
                updateRoundInfo: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        eventId: string;
                        date: string;
                        roundName?: "UNKNOWN" | "PRE_PRE_SEED" | "PRE_SEED" | "SEED" | "SEED_EXT" | "SERIES_A" | "SERIES_A_EXT" | "SERIES_A2" | "SERIES_B" | "SERIES_B_EXT" | "SERIES_C" | "SERIES_C_EXT" | "SERIES_D" | "SERIES_E" | "SERIES_F" | "SERIES_G" | "SERIES_H" | "SERIES_I" | "SERIES_J" | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | undefined;
                        amount?: number | undefined;
                        valuation?: number | undefined;
                        valuationType?: "PRE_MONEY" | "POST_MONEY" | undefined;
                        pricePerShare?: number | undefined;
                        pricePerShareCurrency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | undefined;
                        investmentRoundType?: "CONVERTIBLE" | "EQUITY" | "OTHER" | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        eventId: string;
                        date: string;
                        roundName?: "UNKNOWN" | "PRE_PRE_SEED" | "PRE_SEED" | "SEED" | "SEED_EXT" | "SERIES_A" | "SERIES_A_EXT" | "SERIES_A2" | "SERIES_B" | "SERIES_B_EXT" | "SERIES_C" | "SERIES_C_EXT" | "SERIES_D" | "SERIES_E" | "SERIES_F" | "SERIES_G" | "SERIES_H" | "SERIES_I" | "SERIES_J" | undefined;
                        currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | undefined;
                        amount?: number | undefined;
                        valuation?: number | undefined;
                        valuationType?: "PRE_MONEY" | "POST_MONEY" | undefined;
                        pricePerShare?: number | undefined;
                        pricePerShareCurrency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | undefined;
                        investmentRoundType?: "CONVERTIBLE" | "EQUITY" | "OTHER" | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    data: _prisma_client_runtime_library.JsonValue | null;
                    teamId: string | null;
                    type: _prisma_client.$Enums.EventType;
                    name: string;
                    date: Date;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    assetType: _prisma_client.$Enums.AssetType | null;
                    roundType: _prisma_client.$Enums.EquityRoundType | null;
                    valuationType: _prisma_client.$Enums.ValuationType | null;
                    legalEntityId: string;
                    acquirerId: string | null;
                    investmentRoundType: _prisma_client.$Enums.InvestmentRoundType | null;
                    publicRoundId: string | null;
                    raisedAmount: number | null;
                    raisedCurrency: _prisma_client.$Enums.CurrencyIsoCode | null;
                    urlPressRelease: string | null;
                    valuation: number | null;
                    valuationCurrency: _prisma_client.$Enums.CurrencyIsoCode | null;
                }>;
                removeEvent: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        eventId: string;
                    };
                    _input_out: {
                        eventId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                addAcquisition: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        acquirer: {
                            id: string;
                            name: string;
                        };
                        transactions: {
                            fundId: string;
                            assetsSold: {
                                id: string;
                                amount?: number | undefined;
                            }[];
                            assetsReceived: {
                                amount: number;
                                date: string;
                                type: "EQUITY" | "CASH";
                                assetId?: string | undefined;
                                shareClass?: string | undefined;
                                currency?: string | undefined;
                            }[];
                        }[];
                        valuation?: number | undefined;
                        currency?: string | undefined;
                        pricePerShare?: number | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        acquirer: {
                            id: string;
                            name: string;
                        };
                        transactions: {
                            fundId: string;
                            assetsSold: {
                                id: string;
                                amount?: number | undefined;
                            }[];
                            assetsReceived: {
                                amount: number;
                                date: string;
                                type: "EQUITY" | "CASH";
                                assetId?: string | undefined;
                                shareClass?: string | undefined;
                                currency?: string | undefined;
                            }[];
                        }[];
                        valuation?: number | undefined;
                        currency?: string | undefined;
                        pricePerShare?: number | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                getAcquisitionTransactions: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                    };
                    _input_out: {
                        id: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: TransactionId;
                    investorId: LegalEntityId;
                    investorName: string;
                    transfers_out: {
                        id: AssetTransferId;
                        assetId: AssetId;
                        date: Date;
                        numAssets: number | null;
                        currency: CurrencyIsoCode | null;
                        assetName: string;
                    }[];
                    transfers_in: {
                        id: AssetTransferId;
                        assetId: AssetId;
                        date: Date;
                        numAssets: number | null;
                        currency: CurrencyIsoCode | null;
                        assetName: string;
                    }[];
                }[]>;
                addCashflowsToTransaction: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        id: string;
                        recipientId: string;
                        sourceId: string;
                        cashflow: {
                            amount: number;
                            date: string;
                            currency: string;
                        };
                    };
                    _input_out: {
                        id: string;
                        recipientId: string;
                        sourceId: string;
                        cashflow: {
                            amount: number;
                            date: string;
                            currency: string;
                        };
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                addSecondarySale: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        currency: string;
                        buyer: {
                            id: string;
                            name: string;
                        };
                        transactions: {
                            assetId: string;
                            numAssets: number;
                            pricePerShare: number;
                            sellerId: string;
                            currency: string;
                            id?: string | undefined;
                        }[];
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        currency: string;
                        buyer: {
                            id: string;
                            name: string;
                        };
                        transactions: {
                            assetId: string;
                            numAssets: number;
                            pricePerShare: number;
                            sellerId: string;
                            currency: string;
                            id?: string | undefined;
                        }[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                addLiquidation: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        transactions: {
                            numAssets: number;
                            currency: string;
                            investorId: string;
                        }[];
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        transactions: {
                            numAssets: number;
                            currency: string;
                            investorId: string;
                        }[];
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    eventId: string;
                }>;
                addShareSplit: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        multiple: number;
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        multiple: number;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                getOutstandingCommitments: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date?: string | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        date?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    assetId: string;
                    assetName: string;
                    investorId: string;
                    investorName: string;
                    price: number;
                    currency: CurrencyIsoCode;
                }[]>;
                addFundDrawdown: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        fundId: string;
                        drawdownAmount: number;
                        date: string;
                        outstandingCommitment: {
                            assetId: string;
                            investorId: string;
                            price: number;
                            currency: CurrencyIsoCode;
                        };
                    };
                    _input_out: {
                        fundId: string;
                        drawdownAmount: number;
                        date: string;
                        outstandingCommitment: {
                            assetId: string;
                            investorId: string;
                            price: number;
                            currency: CurrencyIsoCode;
                        };
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, void>;
                getEventHistory: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        config: {
                            currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                            valuationDate?: string | null | undefined;
                        };
                    };
                    _input_out: {
                        companyId: string;
                        config: {
                            currency?: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK" | null | undefined;
                            valuationDate?: string | null | undefined;
                        };
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    events: {
                        prices: {
                            type: AssetType | null;
                            name: string | null;
                            asset_id: AssetId | null;
                            date: Date;
                            price: number;
                            id: PriceId;
                            event_id: EventId | null;
                            currency: CurrencyIsoCode;
                            priceType: PriceType;
                            notes: {
                                id: NoteId;
                                content: string;
                                creator: string;
                                createdAt: Date;
                                updatedAt: Date;
                            }[] | null;
                        }[];
                        transactions: ClassifiedTransactionFlow[];
                        data: unknown;
                        type: EventType;
                        name: string;
                        date: Date;
                        id: EventId;
                        valuation: number | null;
                        investment_round_type: InvestmentRoundType | null;
                        raised_amount: number | null;
                        raised_currency: CurrencyIsoCode | null;
                        valuation_currency: CurrencyIsoCode | null;
                        valuation_type: ValuationType | null;
                        acquirer: {
                            id: LegalEntityId | null;
                            name: string | null;
                            slug: string | null;
                        } | null;
                        notes: {
                            id: NoteId;
                            content: string;
                            creator: string;
                            createdAt: Date;
                            updatedAt: Date;
                        }[] | null;
                        investors: {
                            id: LegalEntityId;
                            name: string;
                            slug: string | null;
                            personalWebsite: string | null;
                        }[] | null;
                    }[];
                    investments: {
                        notes: {
                            id: NoteId;
                            content: string;
                            creator: string;
                            createdAt: Date;
                            updatedAt: Date;
                        }[];
                        transactions: ClassifiedTransactionFlow[];
                        totalInvested: number | null;
                        currentValueCurrency: "CHF" | "EUR" | "GBP" | "NOK" | "SEK" | "USD" | "DKK";
                        moic: number | null;
                        unrealizedValue: number;
                        realizedValue: number;
                        totalValue: number;
                        message: ProcessMessage[] | undefined;
                        id: InvestmentId;
                        eventType: EventType | null;
                        eventLegalEntityName: string | null;
                        eventLegalEntitySlug: string | null;
                        date: Date | null;
                    }[];
                    prices: {
                        type: AssetType | null;
                        name: string | null;
                        asset_id: AssetId | null;
                        date: Date;
                        price: number;
                        id: PriceId;
                        event_id: EventId | null;
                        currency: CurrencyIsoCode;
                        priceType: PriceType;
                        notes: {
                            id: NoteId;
                            content: string;
                            creator: string;
                            createdAt: Date;
                            updatedAt: Date;
                        }[] | null;
                    }[];
                    transactions: (TransactionFlow & {
                        date: Date;
                        eventId: string | null;
                        convertedToId: string | null;
                        dueToRightsFromAssetId: string | null;
                        investingEntityKey: InvestingEntityKey;
                        investeeEntityKey: InvesteeEntityKey;
                        classification: TransactionFlowClassification;
                    } & {
                        notes: {
                            id: string;
                            content: string;
                            creator: string;
                            createdAt: Date;
                            updatedAt: Date;
                        }[];
                    })[];
                    convertibleAssets: {
                        [k: string]: {
                            name: string;
                            id: AssetId;
                            interest: number | null;
                            convertibleType: ConvertibleType | null;
                            convertibleAmount: number | null;
                            convertibleCurrency: CurrencyIsoCode | null;
                            issuedAt: Date | null;
                            maturityDate: Date | null;
                            valuationCap: number | null;
                            discountRate: number | null;
                            annualisedInterestRate: number | null;
                            conversionDate: Date | null;
                            conversionPrice: number | null;
                        };
                    };
                }>;
                addMarkdown: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        date: string;
                        percentage: number;
                        note?: string | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        date: string;
                        percentage: number;
                        note?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    eventId: string;
                }>;
                updateCompanyInfo: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        country?: string | undefined;
                        otherNames?: string | undefined;
                        legalName?: string | undefined;
                        website?: string | undefined;
                        status?: CompanyLegalStatus | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        name?: string | undefined;
                        description?: string | undefined;
                        country?: string | undefined;
                        otherNames?: string | undefined;
                        legalName?: string | undefined;
                        website?: string | undefined;
                        status?: CompanyLegalStatus | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    description: string | null;
                    teamId: string | null;
                    type: _prisma_client.$Enums.LegalEntityType | null;
                    name: string;
                    personalWebsite: string | null;
                    id: string;
                    createdAt: Date;
                    updatedAt: Date;
                    slug: string | null;
                    country: string | null;
                    city: string | null;
                    locations: string[];
                    stages: string[];
                    themes: string[];
                    linkedin: string | null;
                    customers: string[];
                    markets: string[];
                    email: string | null;
                    identifiers: string[];
                    sectors: string[];
                    imageUrl: string | null;
                    isPublic: boolean;
                    inferredThesis: string | null;
                    publicProfileId: string | null;
                    operatedByProfileId: string | null;
                    businessModels: string[];
                    shortDescription: string | null;
                    investmentStatus: _prisma_client.$Enums.InvestmentStatus;
                    descriptorsGeos: string[];
                    descriptorsInvestorTypes: string[];
                    descriptorsMiscTags: string[];
                    descriptorsStages: string[];
                    summaryForSimilaritySearch: string | null;
                    marketShort: string | null;
                    linkedinData: _prisma_client_runtime_library.JsonValue | null;
                    isOwnInvestingEntity: boolean | null;
                    companyMetricsId: string | null;
                    companyProfileId: string | null;
                    investingEntityId: string | null;
                    isDeprecated: boolean | null;
                    isPortfolio: boolean | null;
                    legalName: string | null;
                    alsoKnownAs: string | null;
                    acquiredByLegalEntityId: string | null;
                    underlyingCompanyId: string | null;
                    customValues: _prisma_client_runtime_library.JsonValue | null;
                    pointOfContactUserId: string | null;
                    acquiredAt: Date | null;
                    acquiredEventId: string | null;
                    legalStatus: _prisma_client.$Enums.CompanyLegalStatus;
                    otherNames: string[];
                    sentimentScore: number | null;
                    visibilityScore: number | null;
                    invitationCode: string | null;
                    experimentsActives: string[];
                    wordIdentifier: string | null;
                }>;
                addInvestment: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entity: string;
                        investingEntity: string;
                        investingEntityName: string;
                        investmentDate: string;
                        investmentAmount: string;
                        investmentCurrency: CurrencyIsoCode;
                        entityName?: string | undefined;
                        entityType?: LegalEntityType | undefined;
                        entityWebsite?: string | undefined;
                        roundName?: string | undefined;
                        investmentType?: "SPV" | "CONVERTIBLE" | "EQUITY" | "SECONDARY" | undefined;
                        committedAmount?: string | undefined;
                        committedCurrency?: CurrencyIsoCode | undefined;
                        pricePerShare?: string | undefined;
                        pricePerShareCurrency?: CurrencyIsoCode | undefined;
                        numberOfShares?: string | undefined;
                        shareClass?: string | undefined;
                        valuationAmount?: string | undefined;
                        valuationType?: ValuationType | undefined;
                        valuationCurrency?: CurrencyIsoCode | undefined;
                        totalRaisedAmount?: string | undefined;
                        totalRaisedCurrency?: CurrencyIsoCode | undefined;
                        convertibleType?: ConvertibleType | undefined;
                        convertibleName?: string | undefined;
                        convertibleValuationCap?: number | undefined;
                        convertibleMaturityDate?: string | undefined;
                        convertibleInterestRate?: number | undefined;
                        convertibleDiscountRate?: number | undefined;
                        spv?: string | undefined;
                        spvName?: string | undefined;
                        seller?: string | undefined;
                        sellerName?: string | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _input_out: {
                        entity: string;
                        investingEntity: string;
                        investingEntityName: string;
                        investmentDate: string;
                        investmentAmount: string;
                        investmentCurrency: CurrencyIsoCode;
                        entityName?: string | undefined;
                        entityType?: LegalEntityType | undefined;
                        entityWebsite?: string | undefined;
                        roundName?: string | undefined;
                        investmentType?: "SPV" | "CONVERTIBLE" | "EQUITY" | "SECONDARY" | undefined;
                        committedAmount?: string | undefined;
                        committedCurrency?: CurrencyIsoCode | undefined;
                        pricePerShare?: string | undefined;
                        pricePerShareCurrency?: CurrencyIsoCode | undefined;
                        numberOfShares?: string | undefined;
                        shareClass?: string | undefined;
                        valuationAmount?: string | undefined;
                        valuationType?: ValuationType | undefined;
                        valuationCurrency?: CurrencyIsoCode | undefined;
                        totalRaisedAmount?: string | undefined;
                        totalRaisedCurrency?: CurrencyIsoCode | undefined;
                        convertibleType?: ConvertibleType | undefined;
                        convertibleName?: string | undefined;
                        convertibleValuationCap?: number | undefined;
                        convertibleMaturityDate?: string | undefined;
                        convertibleInterestRate?: number | undefined;
                        convertibleDiscountRate?: number | undefined;
                        spv?: string | undefined;
                        spvName?: string | undefined;
                        seller?: string | undefined;
                        sellerName?: string | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                    investmentId: string;
                }>;
                addRound: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entity: string;
                        roundName: string;
                        date: string;
                        currency?: CurrencyIsoCode | undefined;
                        pricePerShare?: string | undefined;
                        valuationAmount?: string | undefined;
                        valuationType?: ValuationType | undefined;
                        totalRaisedAmount?: string | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _input_out: {
                        entity: string;
                        roundName: string;
                        date: string;
                        currency?: CurrencyIsoCode | undefined;
                        pricePerShare?: string | undefined;
                        valuationAmount?: string | undefined;
                        valuationType?: ValuationType | undefined;
                        totalRaisedAmount?: string | undefined;
                        coInvestors?: {
                            id: string;
                            name: string;
                            type: "FUND" | "NATURAL_PERSON";
                        }[] | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                getRoundNamesForLegalEntity: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        legalEntityId: string;
                    };
                    _input_out: {
                        legalEntityId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    date: Date;
                    round_name: string;
                }[]>;
                getInvestorsSummary: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        legalEntityId: string;
                    };
                    _input_out: {
                        legalEntityId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    rounds: {
                        pricePerShare: {
                            teamId: string;
                            type: _prisma_client.$Enums.PriceType;
                            date: Date;
                            price: number;
                            id: string;
                            createdAt: Date;
                            updatedAt: Date;
                            eventId: string | null;
                            assetId: string | null;
                            legalEntityId: string | null;
                            currency: _prisma_client.$Enums.CurrencyIsoCode;
                        } | null;
                        investors: {
                            id: LegalEntityId;
                            type: LegalEntityType | null;
                            name: string;
                        }[];
                        data: unknown;
                        round_type: EquityRoundType | null;
                        valuation: number | null;
                        acquirer_id: LegalEntityId | null;
                        investment_round_type: InvestmentRoundType | null;
                        raised_amount: number | null;
                        raised_currency: CurrencyIsoCode | null;
                        valuation_currency: CurrencyIsoCode | null;
                        valuation_type: ValuationType | null;
                        event_id: EventId | null;
                        event_name: string | null;
                        event_type: EventType | null;
                        event_date: Date | null;
                        notes: {
                            id: string;
                            message: string;
                            date: Date;
                            creator: {
                                id: string;
                                name: string;
                                slug: string | null | undefined;
                                imageUrl: string | null | undefined;
                            };
                        }[];
                        legalEntity: {
                            id: LegalEntityId;
                            name: string;
                            image_url: string | null;
                            slug: string | null;
                        };
                        investment: {
                            name: string;
                            id: LegalEntityId;
                            iso_code: CurrencyIsoCode;
                            amount: number;
                        }[];
                        private: {
                            id: LegalEntityId;
                            type: LegalEntityType | null;
                            name: string;
                        }[];
                    }[];
                    topInvestors: {
                        id: LegalEntityId;
                        type: LegalEntityType | null;
                        name: string;
                    }[];
                }>;
                deleteNote: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        noteId: string;
                    };
                    _input_out: {
                        noteId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                addPriceNote: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        priceId: string;
                        note: string;
                    };
                    _input_out: {
                        priceId: string;
                        note: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                addEventNote: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        eventId: string;
                        note: string;
                    };
                    _input_out: {
                        eventId: string;
                        note: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                addInvestmentNote: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        investmentId: string;
                        note: string;
                    };
                    _input_out: {
                        investmentId: string;
                        note: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                addTransactionNote: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        transactionId: string;
                        note: string;
                    };
                    _input_out: {
                        transactionId: string;
                        note: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                addInvestorToEvent: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        companyId: string;
                        eventId: string;
                        name: string;
                        type: "FUND" | "NATURAL_PERSON";
                        id?: string | null | undefined;
                    };
                    _input_out: {
                        companyId: string;
                        eventId: string;
                        name: string;
                        type: "FUND" | "NATURAL_PERSON";
                        id?: string | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                removeInvestorFromEvent: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        eventId: string;
                        investorId: string;
                    };
                    _input_out: {
                        eventId: string;
                        investorId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    success: boolean;
                }>;
                findInvestableEntitiesByName: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                    };
                    _input_out: {
                        name: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LegalEntityId;
                    type: LegalEntityType | null;
                    name: string;
                }[]>;
                findInvestingEntitiesByName: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        name: string;
                    };
                    _input_out: {
                        name: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LegalEntityId;
                    name: string;
                    invested_at: Date | null;
                }[]>;
                getSPVsForEntity: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entityId: string;
                    };
                    _input_out: {
                        entityId: string;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LegalEntityId;
                    name: string;
                }[]>;
                getOtherInvestors: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entityId?: string | undefined;
                        search?: string | undefined;
                    };
                    _input_out: {
                        entityId?: string | undefined;
                        search?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LegalEntityId;
                    type: LegalEntityType | null;
                    name: string;
                }[]>;
                getLegalEntities: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        entityId?: string | undefined;
                        search?: string | undefined;
                    };
                    _input_out: {
                        entityId?: string | undefined;
                        search?: string | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    id: LegalEntityId;
                    type: LegalEntityType | null;
                    name: string;
                }[]>;
                getFundingChangelog: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        legalEntityId: string;
                        limit?: number | undefined;
                    };
                    _input_out: {
                        legalEntityId: string;
                        limit?: number | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    username: string | null;
                    description: string;
                    id: FundingChangelogId;
                    created_at: Date;
                    event_date: Date | null;
                }[]>;
                getChangelogCategories: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: typeof _trpc_server.unsetMarker;
                    _input_out: typeof _trpc_server.unsetMarker;
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                    _meta: object;
                }, string[]>;
                getChangelogList: _trpc_server.BuildProcedure<"query", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        fundIds?: string[] | undefined;
                        categories?: string[] | undefined;
                        companyName?: string | null | undefined;
                        limit?: number | undefined;
                        cursor?: string | null | undefined;
                    };
                    _input_out: {
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        fundIds?: string[] | undefined;
                        categories?: string[] | undefined;
                        companyName?: string | null | undefined;
                        limit?: number | undefined;
                        cursor?: string | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    items: {
                        username: string | null;
                        description: string;
                        id: FundingChangelogId;
                        created_at: Date;
                        category: string | null;
                        legal_entity_id: LegalEntityId;
                        event_date: Date | null;
                        company_name: string;
                        funds: {
                            name: string;
                            id: LegalEntityId;
                        }[];
                    }[];
                    nextCursor: string | null;
                }>;
                getChangelogCSV: _trpc_server.BuildProcedure<"mutation", {
                    _config: _trpc_server.RootConfig<{
                        ctx: {
                            authorise: () => Promise<void>;
                        };
                        meta: object;
                        errorShape: {
                            message: string;
                            code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                            data: _trpc_server_dist_error_formatter.DefaultErrorData;
                        };
                        transformer: _trpc_server.DefaultDataTransformer;
                    }>;
                    _meta: object;
                    _ctx_out: {
                        authorise: () => Promise<void>;
                    };
                    _input_in: {
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        fundIds?: string[] | undefined;
                        categories?: string[] | undefined;
                        companyName?: string | null | undefined;
                    };
                    _input_out: {
                        fromDate?: string | null | undefined;
                        toDate?: string | null | undefined;
                        fundIds?: string[] | undefined;
                        categories?: string[] | undefined;
                        companyName?: string | null | undefined;
                    };
                    _output_in: typeof _trpc_server.unsetMarker;
                    _output_out: typeof _trpc_server.unsetMarker;
                }, {
                    date: string;
                    company: string;
                    category: string;
                    description: string;
                    event_date: string;
                    funds: string;
                    user: string;
                }[]>;
            }>;
        }>;
        remoteAdapter: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
                _meta: object;
            }, ({
                kind: "invalid";
                id: string;
                adapterType: string;
                reason: string;
                displayName?: undefined;
                description?: undefined;
                supportedTriggers?: undefined;
                methods?: undefined;
                baseUrl?: undefined;
                authStrategy?: undefined;
                credentialsId?: undefined;
                createdAt?: undefined;
                updatedAt?: undefined;
            } | {
                kind: "valid";
                id: string;
                adapterType: string;
                displayName: string | null;
                description: string | null;
                supportedTriggers: string[];
                methods: string[];
                baseUrl: string;
                authStrategy: unknown;
                credentialsId: string | null;
                createdAt: Date;
                updatedAt: Date;
                reason?: undefined;
            })[]>;
            get: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                };
                _input_out: {
                    adapterType: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                runtimeCapabilities: {
                    traversal: {
                        incoming: boolean;
                        edgeProperties: boolean;
                    };
                    resources: boolean;
                };
                methods: string[];
                protocolVersion: 2;
                adapterType: string;
                baseUrl: string;
                authStrategy: {
                    kind: "bearer";
                } | {
                    kind: "shared_secret";
                    header?: string | undefined;
                };
                supportedTriggers: string[];
                webhookEventTypeId?: string | undefined;
                kind?: "plugin" | "core" | "adapter" | undefined;
                slot?: "models" | "files" | "judge" | "store" | undefined;
                settings?: {
                    name: string;
                    label?: string | undefined;
                    secret?: boolean | undefined;
                    optional?: boolean | undefined;
                }[] | undefined;
                hostModels?: boolean | undefined;
                credentials?: ({
                    name: string;
                    kind: "static";
                    fields: {
                        name: string;
                        label?: string | undefined;
                        secret?: boolean | undefined;
                        optional?: boolean | undefined;
                    }[];
                } | {
                    name: string;
                    kind: "oauth2";
                    fields: {
                        name: string;
                        label?: string | undefined;
                        secret?: boolean | undefined;
                        optional?: boolean | undefined;
                    }[];
                    oauth2: {
                        authorizeUrl: string;
                        tokenUrl: string;
                        scopes?: string[] | undefined;
                        clientAuth?: "body" | "basic" | undefined;
                        pkce?: boolean | undefined;
                        authorizeParams?: Record<string, string> | undefined;
                    };
                })[] | undefined;
                inbound?: {
                    providerKey: string;
                    scheme: "hmac_sha256_hex" | "airtable_mac" | "attio" | "affinity_hex_or_b64" | "slack_v0" | "telegram_secret_token" | "remote";
                    signatureHeaders: string[];
                    intercepts?: "slack_url_verification"[] | undefined;
                } | undefined;
                poll?: {
                    intervalSeconds: number;
                } | undefined;
                periodic?: {
                    name: string;
                    intervalSeconds: number;
                }[] | undefined;
                plugins?: {
                    package: string;
                    plugins: {
                        name: string;
                        spec: {
                            args: string[];
                            priced: boolean;
                            argTypes: Record<string, unknown>;
                            requiredArgs?: string[] | undefined;
                            effects?: Record<string, unknown> | undefined;
                            fedArgs?: {
                                name: string;
                                required?: true | undefined;
                            }[] | undefined;
                            fedByExtraction?: true | undefined;
                            output?: Record<string, unknown> | undefined;
                            earlierOutputs?: {
                                before: number;
                                output: Record<string, unknown>;
                            }[] | undefined;
                        };
                    }[];
                } | undefined;
                subscribableEvents?: string[] | undefined;
                defaultSubscribedEvents?: string[] | undefined;
                listenConfig?: {
                    key: string;
                    required?: boolean | undefined;
                    format?: "fields" | "cron" | "timezone" | "strings" | undefined;
                }[] | undefined;
                displayName?: string | undefined;
                description?: string | undefined;
                handbookSection?: {
                    title: string;
                    content: string;
                    engineClaims?: ({
                        construct: string;
                        status: "runs";
                        probe: string;
                    } | {
                        construct: string;
                        status: "pending";
                        probe: string;
                        flag: string;
                    })[] | undefined;
                } | undefined;
                vocabulary?: {
                    icon?: {
                        d: string;
                        fill?: boolean | undefined;
                        viewBox?: string | undefined;
                    } | undefined;
                    eventPhrase?: Record<string, {
                        template: string;
                    }[]> | undefined;
                } | undefined;
                credentialsId?: string | undefined;
            } | null>;
            upsertFromManifest: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    runtimeCapabilities: {
                        traversal: {
                            incoming: boolean;
                            edgeProperties: boolean;
                        };
                        resources: boolean;
                    };
                    methods: string[];
                    adapterType: string;
                    baseUrl: string;
                    authStrategy: {
                        kind: "bearer";
                    } | {
                        kind: "shared_secret";
                        header?: string | undefined;
                    };
                    supportedTriggers: string[];
                    webhookEventTypeId?: string | undefined;
                    kind?: "plugin" | "core" | "adapter" | undefined;
                    slot?: "models" | "files" | "judge" | "store" | undefined;
                    settings?: {
                        name: string;
                        label?: string | undefined;
                        secret?: boolean | undefined;
                        optional?: boolean | undefined;
                    }[] | undefined;
                    hostModels?: boolean | undefined;
                    credentials?: ({
                        name: string;
                        kind: "static";
                        fields: {
                            name: string;
                            label?: string | undefined;
                            secret?: boolean | undefined;
                            optional?: boolean | undefined;
                        }[];
                    } | {
                        name: string;
                        kind: "oauth2";
                        fields: {
                            name: string;
                            label?: string | undefined;
                            secret?: boolean | undefined;
                            optional?: boolean | undefined;
                        }[];
                        oauth2: {
                            authorizeUrl: string;
                            tokenUrl: string;
                            scopes?: string[] | undefined;
                            clientAuth?: "body" | "basic" | undefined;
                            pkce?: boolean | undefined;
                            authorizeParams?: Record<string, string> | undefined;
                        };
                    })[] | undefined;
                    inbound?: {
                        providerKey: string;
                        scheme: "hmac_sha256_hex" | "airtable_mac" | "attio" | "affinity_hex_or_b64" | "slack_v0" | "telegram_secret_token" | "remote";
                        signatureHeaders: string[];
                        intercepts?: "slack_url_verification"[] | undefined;
                    } | undefined;
                    poll?: {
                        intervalSeconds: number;
                    } | undefined;
                    periodic?: {
                        name: string;
                        intervalSeconds: number;
                    }[] | undefined;
                    plugins?: {
                        package: string;
                        plugins: {
                            name: string;
                            spec: {
                                args: string[];
                                priced: boolean;
                                argTypes: Record<string, unknown>;
                                requiredArgs?: string[] | undefined;
                                effects?: Record<string, unknown> | undefined;
                                fedArgs?: {
                                    name: string;
                                    required?: true | undefined;
                                }[] | undefined;
                                fedByExtraction?: true | undefined;
                                output?: Record<string, unknown> | undefined;
                                earlierOutputs?: {
                                    before: number;
                                    output: Record<string, unknown>;
                                }[] | undefined;
                            };
                        }[];
                    } | undefined;
                    subscribableEvents?: string[] | undefined;
                    defaultSubscribedEvents?: string[] | undefined;
                    listenConfig?: {
                        key: string;
                        required?: boolean | undefined;
                        format?: "fields" | "cron" | "timezone" | "strings" | undefined;
                    }[] | undefined;
                    displayName?: string | undefined;
                    description?: string | undefined;
                    handbookSection?: {
                        title: string;
                        content: string;
                        engineClaims?: ({
                            construct: string;
                            status: "runs";
                            probe: string;
                        } | {
                            construct: string;
                            status: "pending";
                            probe: string;
                            flag: string;
                        })[] | undefined;
                    } | undefined;
                    vocabulary?: {
                        icon?: {
                            d: string;
                            fill?: boolean | undefined;
                            viewBox?: string | undefined;
                        } | undefined;
                        eventPhrase?: Record<string, {
                            template: string;
                        }[]> | undefined;
                    } | undefined;
                    credentialsId?: string | undefined;
                    protocolVersion?: 2 | undefined;
                    secret?: string | undefined;
                };
                _input_out: {
                    runtimeCapabilities: {
                        traversal: {
                            incoming: boolean;
                            edgeProperties: boolean;
                        };
                        resources: boolean;
                    };
                    methods: string[];
                    adapterType: string;
                    baseUrl: string;
                    authStrategy: {
                        kind: "bearer";
                    } | {
                        kind: "shared_secret";
                        header?: string | undefined;
                    };
                    supportedTriggers: string[];
                    webhookEventTypeId?: string | undefined;
                    kind?: "plugin" | "core" | "adapter" | undefined;
                    slot?: "models" | "files" | "judge" | "store" | undefined;
                    settings?: {
                        name: string;
                        label?: string | undefined;
                        secret?: boolean | undefined;
                        optional?: boolean | undefined;
                    }[] | undefined;
                    hostModels?: boolean | undefined;
                    credentials?: ({
                        name: string;
                        kind: "static";
                        fields: {
                            name: string;
                            label?: string | undefined;
                            secret?: boolean | undefined;
                            optional?: boolean | undefined;
                        }[];
                    } | {
                        name: string;
                        kind: "oauth2";
                        fields: {
                            name: string;
                            label?: string | undefined;
                            secret?: boolean | undefined;
                            optional?: boolean | undefined;
                        }[];
                        oauth2: {
                            authorizeUrl: string;
                            tokenUrl: string;
                            scopes?: string[] | undefined;
                            clientAuth?: "body" | "basic" | undefined;
                            pkce?: boolean | undefined;
                            authorizeParams?: Record<string, string> | undefined;
                        };
                    })[] | undefined;
                    inbound?: {
                        providerKey: string;
                        scheme: "hmac_sha256_hex" | "airtable_mac" | "attio" | "affinity_hex_or_b64" | "slack_v0" | "telegram_secret_token" | "remote";
                        signatureHeaders: string[];
                        intercepts?: "slack_url_verification"[] | undefined;
                    } | undefined;
                    poll?: {
                        intervalSeconds: number;
                    } | undefined;
                    periodic?: {
                        name: string;
                        intervalSeconds: number;
                    }[] | undefined;
                    plugins?: {
                        package: string;
                        plugins: {
                            name: string;
                            spec: {
                                args: string[];
                                priced: boolean;
                                argTypes: Record<string, unknown>;
                                requiredArgs?: string[] | undefined;
                                effects?: Record<string, unknown> | undefined;
                                fedArgs?: {
                                    name: string;
                                    required?: true | undefined;
                                }[] | undefined;
                                fedByExtraction?: true | undefined;
                                output?: Record<string, unknown> | undefined;
                                earlierOutputs?: {
                                    before: number;
                                    output: Record<string, unknown>;
                                }[] | undefined;
                            };
                        }[];
                    } | undefined;
                    subscribableEvents?: string[] | undefined;
                    defaultSubscribedEvents?: string[] | undefined;
                    listenConfig?: {
                        key: string;
                        required?: boolean | undefined;
                        format?: "fields" | "cron" | "timezone" | "strings" | undefined;
                    }[] | undefined;
                    displayName?: string | undefined;
                    description?: string | undefined;
                    handbookSection?: {
                        title: string;
                        content: string;
                        engineClaims?: ({
                            construct: string;
                            status: "runs";
                            probe: string;
                        } | {
                            construct: string;
                            status: "pending";
                            probe: string;
                            flag: string;
                        })[] | undefined;
                    } | undefined;
                    vocabulary?: {
                        icon?: {
                            d: string;
                            fill?: boolean | undefined;
                            viewBox?: string | undefined;
                        } | undefined;
                        eventPhrase?: Record<string, {
                            template: string;
                        }[]> | undefined;
                    } | undefined;
                    credentialsId?: string | undefined;
                    protocolVersion?: 2 | undefined;
                    secret?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                credentialsId: string | null;
            }>;
            credentials: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                };
                _input_out: {
                    adapterType: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                adapterType: string;
                redirectUri: string;
                declarations: ({
                    kind: "oauth2";
                    signInAvailable: boolean;
                    name: string;
                    fields: {
                        name: string;
                        label: string;
                        secret: boolean;
                        optional: boolean;
                    }[];
                    credentials: {
                        id: string;
                        name: string;
                    }[];
                } | {
                    kind: "static";
                    name: string;
                    fields: {
                        name: string;
                        label: string;
                        secret: boolean;
                        optional: boolean;
                    }[];
                    credentials: {
                        id: string;
                        name: string;
                    }[];
                })[];
            }>;
            createStaticCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                    declaredCredential: string;
                    name: string;
                    fields: Record<string, string>;
                };
                _input_out: {
                    adapterType: string;
                    declaredCredential: string;
                    name: string;
                    fields: Record<string, string>;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                credentialsId: string;
            }>;
            beginOAuthCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                    declaredCredential: string;
                    name: string;
                    fields?: Record<string, string> | undefined;
                };
                _input_out: {
                    adapterType: string;
                    declaredCredential: string;
                    name: string;
                    fields?: Record<string, string> | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                url: string;
            }>;
            delete: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    adapterType: string;
                };
                _input_out: {
                    adapterType: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
        triggers: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            teamHasContent: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                hasContent: boolean;
            }>;
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, TriggerListItem[]>;
            get: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, TriggerDetail>;
            getAutomationDetail: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, AutomationDetail>;
            listTriggerEvents: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                    limit?: number | undefined;
                };
                _input_out: {
                    triggerId: string;
                    limit?: number | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: TriggerEventId;
                created_at: Date;
                status: string;
                trigger_id: string;
                adapter_type: string;
                trigger_type: string;
                dispatched_at: Date | null;
                failure_reason: string | null;
                occurred_at: Date;
            }[]>;
            replayTriggerEvent: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    eventId: string;
                };
                _input_out: {
                    eventId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                replayed: boolean;
            }>;
            onRunActivity: _trpc_server.BuildProcedure<"subscription", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
                _meta: object;
            }, _trpc_server_observable.Observable<{
                teamId: string;
                runId: string;
                triggerId: string;
                phase: "started" | "finished";
            }, unknown>>;
            onRecentActivity: _trpc_server.BuildProcedure<"subscription", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                };
                _input_out: {
                    triggerId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, _trpc_server_observable.Observable<AutomationRecentEvent, unknown>>;
            getTriggerConfig: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                blocks: movement_engine_public_adapter.ConfigBlock[];
                values: Record<string, string>;
            }>;
            updateTriggerConfig: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                    values: Record<string, unknown>;
                };
                _input_out: {
                    id: string;
                    values: Record<string, unknown>;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                values: Record<string, string>;
            }>;
            renameTrigger: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                    name: string;
                };
                _input_out: {
                    triggerId: string;
                    name: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                name: string;
            }>;
            deleteTrigger: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                };
                _input_out: {
                    triggerId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
            }>;
            dryRunTrigger: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                    seed?: string | undefined;
                };
                _input_out: {
                    triggerId: string;
                    seed?: string | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, MovementTestRunResult>;
            resumeGuardPaused: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                };
                _input_out: {
                    triggerId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                resumed: boolean;
            }>;
            setTriggerCredential: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                    credentialsId: string | null;
                };
                _input_out: {
                    triggerId: string;
                    credentialsId: string | null;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                credentialsId: string | null;
            }>;
            listCreatableSources: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, CreatableSource[]>;
            createAutomation: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    name: string;
                    sourceKind: string;
                };
                _input_out: {
                    name: string;
                    sourceKind: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
            }>;
            submitWebEvent: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    triggerId: string;
                    text?: string | undefined;
                    files?: {
                        filename: string;
                        contentType: string;
                        contentBase64: string;
                    }[] | undefined;
                };
                _input_out: {
                    triggerId: string;
                    text?: string | undefined;
                    files?: {
                        filename: string;
                        contentType: string;
                        contentBase64: string;
                    }[] | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                ranCount: number;
                errors: string[];
            }>;
        }>;
        teamMembers: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            overview: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                viewer: {
                    userId: UserId;
                    access: "read" | "write";
                };
                members: {
                    userId: UserId;
                    username: string;
                    email: string | null;
                    emails: {
                        email: string;
                        isPrimary: boolean;
                    }[];
                    phoneNumber: string | null;
                    access: "read" | "write";
                    isServiceAccount: boolean;
                    soleTeam: boolean;
                    platformAdmin: boolean;
                    joinedAt: Date;
                }[];
                invites: {
                    id: TeamInviteId;
                    email: string;
                    createdAt: Date;
                }[];
            }>;
            invite: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    email: string;
                };
                _input_out: {
                    email: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, any>;
            revokeInvite: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    inviteId: string;
                };
                _input_out: {
                    inviteId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                revoked: true;
            }>;
            remove: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userId: string;
                };
                _input_out: {
                    userId: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, any>;
            addMember: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    email: string;
                    username: string;
                    access: "read" | "write";
                };
                _input_out: {
                    email: string;
                    username: string;
                    access: "read" | "write";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: UserId;
                email: string;
            }>;
            createServiceAccount: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    email: string;
                    access: "read" | "write";
                };
                _input_out: {
                    email: string;
                    access: "read" | "write";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, CreatedMember>;
            setAccess: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userId: string;
                    access: "read" | "write";
                };
                _input_out: {
                    userId: string;
                    access: "read" | "write";
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                access: Access;
            }>;
            rename: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userId: string;
                    username: string;
                };
                _input_out: {
                    userId: string;
                    username: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                username: string;
            }>;
            addEmail: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userId: string;
                    email: string;
                    isPrimary?: boolean | undefined;
                };
                _input_out: {
                    userId: string;
                    email: string;
                    isPrimary: boolean;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                email: string;
            }>;
            addPhone: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userId: string;
                    phoneNumber: string;
                };
                _input_out: {
                    userId: string;
                    phoneNumber: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                phoneNumber: string;
            }>;
        }>;
        usage: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getUsageSummary: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                pipelineRuns: UsageStatus | null;
                queryInputs: UsageStatus | null;
                alertThresholdPct: number;
                weekStartsOn: number;
            } | null>;
            getBillingContacts: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: UserEmailId;
                email: string;
                isBillingContact: boolean;
                userId: UserId;
            }[]>;
            setBillingContact: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    userEmailId: string;
                    isBillingContact: boolean;
                };
                _input_out: {
                    userEmailId: string;
                    isBillingContact: boolean;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
        valuations: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            query: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    currency: CurrencyIsoCode;
                    investments?: {
                        ids?: string[] | undefined;
                        investedFrom?: unknown;
                        investedTo?: unknown;
                        roundId?: string | undefined;
                        investingEntityIds?: string[] | undefined;
                        investeeEntityIds?: string[] | undefined;
                    } | undefined;
                    degree?: {
                        eq: number;
                    } | {
                        min?: number | undefined;
                        max?: number | undefined;
                    } | undefined;
                    leafType?: "cash" | "held" | undefined;
                    cashSign?: "paid" | "received" | undefined;
                    factWindow?: {
                        from?: unknown;
                        to?: unknown;
                    } | undefined;
                    asOfDate?: unknown;
                    groupBy?: ("asset" | "investment" | "company" | "degree" | "round" | "investingEntity" | "trackedEntity")[] | undefined;
                    strategy?: "FIFO" | "LIFO" | undefined;
                };
                _input_out: {
                    currency: CurrencyIsoCode;
                    investments?: {
                        ids?: string[] | undefined;
                        investedFrom?: Date | undefined;
                        investedTo?: Date | undefined;
                        roundId?: string | undefined;
                        investingEntityIds?: string[] | undefined;
                        investeeEntityIds?: string[] | undefined;
                    } | undefined;
                    degree?: {
                        eq: number;
                    } | {
                        min?: number | undefined;
                        max?: number | undefined;
                    } | undefined;
                    leafType?: "cash" | "held" | undefined;
                    cashSign?: "paid" | "received" | undefined;
                    factWindow?: {
                        from?: Date | undefined;
                        to?: Date | undefined;
                    } | undefined;
                    asOfDate?: Date | undefined;
                    groupBy?: ("asset" | "investment" | "company" | "degree" | "round" | "investingEntity" | "trackedEntity")[] | undefined;
                    strategy?: "FIFO" | "LIFO" | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, ValuationQueryResult>;
        }>;
        userSettings: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getDeployment: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                version: string;
                whatsappNumber: string | null;
                whatsappLinkVerification: "otp" | "trust";
            }>;
            getPhoneNumber: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                name: string | null;
                phoneNumber: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                wordIdentifier: string | null;
                userId: string | null;
                isTestNumber: boolean;
                emojiCode: string | null;
                verifiedAt: Date | null;
            } | null>;
            updatePhoneNumber: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: string;
                _input_out: string;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                name: string | null;
                phoneNumber: string;
                id: string;
                createdAt: Date;
                updatedAt: Date;
                wordIdentifier: string | null;
                userId: string | null;
                isTestNumber: boolean;
                emojiCode: string | null;
                verifiedAt: Date | null;
            }>;
            startPhoneVerification: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    phoneNumber: string;
                };
                _input_out: {
                    phoneNumber: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, StartOutcome>;
            confirmPhoneVerification: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    phoneNumber: string;
                    code: string;
                };
                _input_out: {
                    phoneNumber: string;
                    code: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, ConfirmOutcome>;
            getAgentStylePreferences: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                preferences: string;
            }>;
            updateAgentStylePreferences: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    preferences: string;
                };
                _input_out: {
                    preferences: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
            getEmails: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: string;
                email: string;
                isPrimary: boolean;
            }[]>;
            updateUsername: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    username: string;
                };
                _input_out: {
                    username: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
        webhookSubscriptions: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            listProviders: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                provider: string;
                canRegisterViaApi: boolean;
                defaultEventTypes: string[];
                setupInstructions: string | null;
            }[]>;
            list: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: WebhookSubscriptionId;
                provider: string;
                credentials_id: ExternalServiceCredentialsId | null;
                external_webhook_id: string | null;
                webhook_secret: string | null;
                status: string;
                subscriptions: unknown;
                created_at: Date;
                targetUrl: string;
                canRegisterViaApi: boolean;
                setupInstructions: string | null;
            }[]>;
            create: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    credentialsId: string;
                    provider: string;
                    eventTypes?: string[] | undefined;
                };
                _input_out: {
                    credentialsId: string;
                    provider: string;
                    eventTypes?: string[] | undefined;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                id: WebhookSubscriptionId;
                targetUrl: string;
                status: string;
                canRegisterViaApi: boolean;
                webhookSecret: string | null;
                setupInstructions: string | null;
            }>;
            delete: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    id: string;
                };
                _input_out: {
                    id: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, void>;
        }>;
        testHarness: _trpc_server.CreateRouterInner<_trpc_server.RootConfig<{
            ctx: {
                authorise: () => Promise<void>;
            };
            meta: object;
            errorShape: {
                message: string;
                code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                data: _trpc_server_dist_error_formatter.DefaultErrorData;
            };
            transformer: _trpc_server.DefaultDataTransformer;
        }>, {
            getStats: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                configured: false;
                teamId?: undefined;
            } | {
                configured: true;
                teamId: string;
            }>;
            listCorpusFiles: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                dir: string;
                files: {
                    name: string;
                    size: number;
                    modifiedAt: string;
                }[];
            }>;
            readCorpusFile: _trpc_server.BuildProcedure<"query", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: {
                    filename: string;
                };
                _input_out: {
                    filename: string;
                };
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                filename: string;
                content: string;
            }>;
            seedFakeCredentials: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                created: string[];
                alreadyExisted: ExternalServiceType[];
            }>;
            resetKnowledgeGraph: _trpc_server.BuildProcedure<"mutation", {
                _config: _trpc_server.RootConfig<{
                    ctx: {
                        authorise: () => Promise<void>;
                    };
                    meta: object;
                    errorShape: {
                        message: string;
                        code: _trpc_server_rpc.TRPC_ERROR_CODE_NUMBER;
                        data: _trpc_server_dist_error_formatter.DefaultErrorData;
                    };
                    transformer: _trpc_server.DefaultDataTransformer;
                }>;
                _meta: object;
                _ctx_out: {
                    authorise: () => Promise<void>;
                };
                _input_in: typeof _trpc_server.unsetMarker;
                _input_out: typeof _trpc_server.unsetMarker;
                _output_in: typeof _trpc_server.unsetMarker;
                _output_out: typeof _trpc_server.unsetMarker;
            }, {
                success: boolean;
            }>;
        }>;
    }>;
}>;
declare function linkTrpcWsServer(wss: WebSocketServer): void;
export type TRPCRouter = typeof trpcRouter;

export { linkTrpcWsServer, trpcRouter };
