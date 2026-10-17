-- @lf/postgres-store, migration 1: the run host's tables in lf's own schema.
-- Shapes follow the hosted product's automations tables (apps/api/src/db/
-- schema.sql) column for column where lf uses them, so one contract suite
-- holds both; nothing here references the hosted product's schema.

CREATE TABLE lf.trigger_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL,
    trigger_id text NOT NULL,
    trigger_type text NOT NULL,
    status text NOT NULL,
    record_id text,
    movement_version_id uuid,
    trigger_payload jsonb,
    changed_fields text[],
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
    errors jsonb NOT NULL DEFAULT '[]'::jsonb,
    nodes_written integer NOT NULL DEFAULT 0,
    dry_run boolean NOT NULL DEFAULT false,
    started_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp(3) with time zone,
    failed_at timestamp(3) with time zone,
    failure_reason text,
    cancel_requested_at timestamptz,
    cancel_reason text,
    limit_pause jsonb,
    cost_cap_baseline_microdollars bigint NOT NULL DEFAULT 0,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ops_run_id uuid,
    last_heartbeat_at timestamptz,
    trigger_event_id uuid,
    lease_owner text,
    lease_until timestamptz,
    lease_token uuid,
    engine text
);
CREATE INDEX trigger_run_team_id_idx ON lf.trigger_run (team_id);
CREATE INDEX trigger_run_created_at_idx ON lf.trigger_run (created_at);

CREATE TABLE lf.parked_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    address text NOT NULL,
    status text NOT NULL DEFAULT 'parked',
    state jsonb,
    result jsonb,
    park_reason text NOT NULL CONSTRAINT parked_run_park_reason_check CHECK (park_reason <> ''),
    wake_at timestamptz NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT parked_run_status_check CHECK (status IN ('parked', 'resuming', 'completed')),
    CONSTRAINT parked_run_run_address_unique UNIQUE (run_id, address)
);
CREATE INDEX parked_run_timer_wake_idx ON lf.parked_run (wake_at) WHERE park_reason = 'timer' AND status = 'parked';

CREATE TABLE lf.join_pending (
    run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    frame_address text NOT NULL,
    pending integer NOT NULL,
    closed_by_address text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT join_pending_pending_nonneg CHECK (pending >= 0),
    PRIMARY KEY (run_id, frame_address)
);

CREATE TABLE lf.join_branch_export (
    run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    frame_address text NOT NULL,
    branch_address text NOT NULL,
    branch_index integer NOT NULL,
    exports jsonb NOT NULL,
    decremented boolean DEFAULT false NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (run_id, frame_address, branch_address)
);

CREATE TABLE lf.adapter_await (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    adapter_type text NOT NULL,
    correlation_key text NOT NULL,
    run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    team_id uuid NOT NULL,
    address text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT adapter_await_run_address_unique UNIQUE (run_id, address)
);
CREATE INDEX adapter_await_correlation_idx ON lf.adapter_await (adapter_type, correlation_key, team_id);

CREATE TABLE lf.work (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid,
    kind text NOT NULL,
    key text NOT NULL UNIQUE,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    due_at timestamptz NOT NULL DEFAULT now(),
    interval_ms integer,
    attempts integer NOT NULL DEFAULT 0,
    lease_owner text,
    lease_until timestamptz,
    lease_token uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deferrals integer NOT NULL DEFAULT 0
);
CREATE INDEX work_due_idx ON lf.work (due_at);

CREATE TABLE lf.park_library_source (
    team_id uuid NOT NULL,
    hash text NOT NULL,
    source text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (team_id, hash)
);

CREATE TABLE lf.callback (
    id text PRIMARY KEY,
    team_id uuid NOT NULL,
    run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    address text NOT NULL,
    params jsonb NOT NULL DEFAULT '[]'::jsonb,
    state jsonb NOT NULL,
    calls jsonb NOT NULL DEFAULT '[]'::jsonb,
    single_use boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    status text NOT NULL DEFAULT 'live',
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    fired_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT callback_status_check CHECK (status IN ('live', 'fired', 'revoked'))
);
CREATE INDEX callback_run_id_idx ON lf.callback (run_id);

-- A pull source's cursor, per install and listen (the hosted product keeps
-- it on its webhook subscription row, which lf has no counterpart for).
CREATE TABLE lf.inbound_checkpoint (
    team_id uuid NOT NULL,
    subscription_id text NOT NULL,
    checkpoint jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, subscription_id)
);
