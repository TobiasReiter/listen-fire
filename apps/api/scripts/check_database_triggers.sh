#!/bin/bash

# Exit immediately on failure if any of the commands fail
# https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html
set -e

# Context functions check will throw if these functions don't exist
context_functions=`psql -Atxv ON_ERROR_STOP=ON "$DATABASE_URL" <<-EOSQL
  SELECT
    'set_current_user_id(text)'::regprocedure,
    'current_user_id()'::regprocedure,
    'set_current_team_id(text)'::regprocedure,
    'current_team_id()'::regprocedure,
    'set_current_context_id(text)'::regprocedure,
    'current_context_id()'::regprocedure,
    'set_created_fields()'::regprocedure,
    'audit()'::regprocedure,
    -- valuations audits itself: its own actor GUCs, its own audit function,
    -- its own audit_log (5_valuations.md's audit note + V-17). A unit that
    -- borrows core's audit() does not restore standalone.
    'valuations.set_session_context(text,text,text,text)'::regprocedure,
    'valuations.current_team_id()'::regprocedure,
    'valuations.current_actor_type()'::regprocedure,
    'valuations.current_actor_id()'::regprocedure,
    'valuations.current_context_id()'::regprocedure,
    'valuations.set_created_fields()'::regprocedure,
    'valuations.audit()'::regprocedure,
    -- core audits itself for the same reason, and it is the unit the others
    -- were borrowing FROM: public.audit() stays for automations/knowledge/asks
    -- until Phase 3 gives them their own.
    'core.set_session_context(text,text,text,text)'::regprocedure,
    'core.current_team_id()'::regprocedure,
    'core.current_actor_type()'::regprocedure,
    'core.current_actor_id()'::regprocedure,
    'core.current_context_id()'::regprocedure,
    'core.set_created_fields()'::regprocedure,
    'core.audit()'::regprocedure,
    -- knowledge audits itself too (D37(h)). Its policies read
    -- knowledge.current_team_id(), so a standalone graph both attributes its
    -- writes and tenants its agent reads with no public schema present.
    'knowledge.set_session_context(text,text,text,text)'::regprocedure,
    'knowledge.current_team_id()'::regprocedure,
    'knowledge.current_actor_type()'::regprocedure,
    'knowledge.current_actor_id()'::regprocedure,
    'knowledge.current_context_id()'::regprocedure,
    'knowledge.set_created_fields()'::regprocedure,
    'knowledge.audit()'::regprocedure,
    -- and automations, the last of the four (D43(b)). After this the only
    -- schema without its own audit function is asks, which has no trigger to
    -- need one.
    'automations.set_session_context(text,text,text,text)'::regprocedure,
    'automations.current_team_id()'::regprocedure,
    'automations.current_actor_type()'::regprocedure,
    'automations.current_actor_id()'::regprocedure,
    'automations.current_context_id()'::regprocedure,
    'automations.set_created_fields()'::regprocedure,
    'automations.audit()'::regprocedure;
EOSQL
`

# Audit triggers — every user-modifiable table should carry one. We audit
# what a user can modify or delete (a short trail to recover accidental
# edits), so append-only/event/log/token/runtime tables are excluded below.
# A table is "audited" if ANY of its triggers calls audit() — matched by
# function, not by a name convention, so a non-conventionally-named trigger
# (e.g. user_phone_number_audit) and tables with extra triggers (e.g. a
# _valuations_outbox alongside the _audit) are handled correctly.
#
# The scan covers EVERY unit schema, not just `public` (carve D3): a table that
# moves out of `public` used to leave this gate silently, taking its audit
# guarantee with it. Names are schema-qualified throughout — both in the
# exclusion list and in the trigger lookup, which would otherwise match a
# same-named table in another schema and call it audited.
audit_triggers=`psql -v ON_ERROR_STOP=ON "$DATABASE_URL" <<-EOSQL
  SELECT t.schemaname || '.' || t.tablename AS table
  FROM pg_catalog.pg_tables t
  WHERE t.schemaname in('public', 'asks', 'automations', 'knowledge', 'valuations', 'core')
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.triggers tr
      WHERE tr.event_object_schema = t.schemaname
        AND tr.event_object_table = t.tablename
        AND tr.action_statement ILIKE '%audit()%'
    )
    AND t.schemaname || '.' || t.tablename NOT in(
      'public.change_log', 'public.audit_log',
      'public.ops_event', 'public.run_cost', 'public.user_journey', 'public.team_journey',
      'public.llm_usage', 'public.usage_event', 'public.usage_alert', 'public.wallet_ledger', 'public.context_logs',
      'public.inventory_delta_event', 'public.inventory_delta_holding',
      'public.inbound_payload',
      'public.whatsapp_bot_states',
      'public.interaction_token', 'public.interaction_request',
      'public.auto_recharge_confirm_token',
      'public.alexamdria_api_key', 'public.push_subscription',
      'public.dropped_inbound_email',
      'public.waitlist', 'public.pipeline_input_message_type',
      'public.signup_event',
      'public.integration_suggestion',
      -- core: a pending signup is a short-lived pre-account token (no account
      -- exists yet to have a trail), and audit_log is the trail itself.
      -- Everything else in the unit is audited -- by core.audit(), which the
      -- check below enforces.
      'core.pending_signup', 'core.audit_log',
      'public.early_access_config', 'public.dealflow_pipeline',
      -- valuations: the changelog IS the audit trail for funding edits (and
      -- its join table has no id), the outbox is a transient capture queue,
      -- and audit_log is the trail itself. Everything else in the unit is
      -- audited -- by valuations.audit(), which the check below enforces.
      -- The delivery queue and the worker pulse are machine churn nobody edits
      -- (the same shape as knowledge's outbox); the SUBSCRIPTIONS are audited,
      -- because an operator creates and deletes those and they carry a secret.
      'valuations.funding_changelog', 'valuations.funding_changelog_fund',
      'valuations.valuations_change_outbox', 'valuations.audit_log',
      'valuations.outbound_delivery', 'valuations.worker_heartbeat',
      -- automations: movement and trigger carry the audit (they are what a user
      -- edits). Versions are immutable snapshots, issues are an aggregated
      -- failure ledger, and the story token is a token.
      'automations.movement_version', 'automations.movement_issue', 'automations.movement_story_token',
      -- automations engine runtime: an event receipt, a run ledger, and the
      -- live park machinery a run suspends into — all system-written, none of
      -- it editable, so there is no user mistake for an audit trail to undo.
      -- record_binding and exposed_file are engine bookkeeping likewise.
      -- system_event (the event receipt behind the system adapter poll
      -- source) and deploy_check (the per-release sweep ledger written by
      -- the deploy check) are the same shape: only ever INSERTed, by the
      -- deploy check and the poll source, never edited or deleted by a user.
      'automations.trigger_event', 'automations.trigger_run', 'automations.parked_run',
      'automations.join_pending', 'automations.join_branch_export', 'automations.adapter_await',
      'automations.callback', 'automations.record_binding', 'automations.exposed_file',
      'automations.work',
      -- park_library_source: immutable, content-addressed library texts a park
      -- pins (no id column, never edited or deleted), written only by the engine.
      'automations.park_library_source',
      'automations.system_event', 'automations.deploy_check',
      -- automations vault + channel identity: single-use links and handshake
      -- tokens, a picker's grant records, echo-recognition tokens, and the
      -- append-only send ledger. The credential rows themselves, the phone
      -- links, the routing table and the remote-adapter installs ARE audited
      -- -- a user creates and deletes those. (whatsapp_conversations /
      -- whatsapp_messages DROPPED at Phase 6 close, D57 -- writerless since
      -- the legacy dealflow era.)
      'automations.audit_log',
      'automations.connect_token', 'automations.google_granted_item',
      'automations.platform_owned_token', 'automations.telegram_identity', 'automations.telegram_token',
      'automations.outbound_email',
      -- knowledge: everything is audited except the change log itself, and
      -- audit_log, which IS the trail. The mutation outbox is a transient
      -- delivery queue and the heartbeat is a worker's pulse -- both machine
      -- churn nobody edits (the valuations outbox precedent). The webhook
      -- endpoints ARE audited: an operator creates and deletes those. The
      -- arbitration queue is the same shape as the outbox -- a work item the
      -- write door enqueues and a worker drains, never edited by hand.
      'knowledge.change', 'knowledge.audit_log',
      'knowledge.mutation_outbox', 'knowledge.worker_heartbeat',
      'knowledge.property_arbitration',
      -- raw_text is immutable captured source text, deduped per team by
      -- checksum -- there is no user edit for a trail to undo, and auditing a
      -- content column that size would double the store. It carried this
      -- exclusion as public.raw_text and keeps it after the D48(i) move.
      -- raw_text_part, document and resource ARE audited.
      'knowledge.raw_text',
      -- asks: the record store is written by the ask adapter, not edited by a
      -- user; its lattice transitions are the trail. The delivery queue and the
      -- heartbeat are machine churn nobody edits (the knowledge outbox
      -- precedent).
      'asks.ask', 'asks.ask_webhook_delivery', 'asks.worker_heartbeat');
EOSQL
`

if ! grep -q "(0 rows)" <<<$audit_triggers; then
  printf '%s\n' "Some tables are missing the audit log trigger:" >&2
  printf '%s\n' "$audit_triggers" >&2
  exit 1
fi;

# A unit that owns an audit function must USE it. `%audit()%` above is
# deliberately loose so a table is counted as audited either way; this check is
# what stops a unit's table quietly writing its trail into the ops-residual
# `public.audit_log`, which does not travel with it. Every unit that has a
# trigger at all is checked now (D43(b)); `asks` is absent because it has none.
for unit in valuations core knowledge automations; do
  foreign_audit=`psql -v ON_ERROR_STOP=ON "$DATABASE_URL" <<-EOSQL
    SELECT tr.event_object_schema || '.' || tr.event_object_table AS table
    FROM information_schema.triggers tr
    WHERE tr.event_object_schema = '$unit'
      AND tr.action_statement ILIKE '%audit()%'
      AND tr.action_statement NOT ILIKE '%$unit.audit()%';
EOSQL
`
  if ! grep -q "(0 rows)" <<<"$foreign_audit"; then
    printf '%s\n' "Some $unit tables audit through public.audit() instead of $unit.audit()" >&2
    exit 1
  fi

  # The same failure with the other face: a policy that tenants on another
  # unit's session setting looks right composed and admits nothing standalone,
  # because the function it calls is not in the dump (D35(c)). This is what
  # caught automations still reading `public.current_team_id()` after its
  # schema was declared self-contained.
  foreign_tenant=`psql -v ON_ERROR_STOP=ON "$DATABASE_URL" <<-EOSQL
    SELECT schemaname || '.' || tablename || ' :: ' || policyname AS policy
    FROM pg_policies
    WHERE schemaname = '$unit'
      AND qual ILIKE '%current_team_id()%'
      AND qual NOT ILIKE '%$unit.current_team_id()%';
EOSQL
`
  if ! grep -q "(0 rows)" <<<"$foreign_tenant"; then
    printf '%s\n' "Some $unit policies tenant on another schema's current_team_id()" >&2
    exit 1
  fi
done

# Change log triggers will return (0 rows)
log_triggers=`psql -v ON_ERROR_STOP=ON "$DATABASE_URL" <<-EOSQL
  SELECT DISTINCT tablename, "trigger_name"
  FROM pg_catalog.pg_tables
    LEFT JOIN information_schema.triggers ON tablename = event_object_table
    WHERE schemaname = 'public'
     AND trigger_name != concat(tablename, '_set_created_fields')
     AND tablename in('change_log', 'audit_log');
EOSQL
`
if ! grep -q "(0 rows)" <<<"$log_triggers"; then
  printf '%s\n' "Some log tables are missing the set_created_fields trigger" >&2
  exit 1
fi

# RAW SQL to create audit trigger
# ===============================
# CREATE TRIGGER asset_transfer_audit AFTER INSERT OR UPDATE OR DELETE ON "asset_transfer" FOR EACH ROW EXECUTE PROCEDURE audit();

# RAW SQL to create context functions
# ===================================
#
# CREATE OR REPLACE FUNCTION set_current_user_id(id TEXT) RETURNS TEXT AS $$
#   SELECT set_config('core.current_user_id', id, TRUE);
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION current_user_id() RETURNS TEXT AS $$
#   SELECT NULLIF(current_setting('core.current_user_id', TRUE), '');
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION set_current_team_id(id TEXT) RETURNS TEXT AS $$
#   SELECT set_config('core.current_team_id', id, TRUE);
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION current_team_id() RETURNS TEXT AS $$
#   SELECT NULLIF(current_setting('core.current_team_id', TRUE), '');
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION set_current_context_id(id TEXT) RETURNS TEXT AS $$
#   SELECT set_config('core.current_context_id', id, TRUE);
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION current_context_id() RETURNS TEXT AS $$
#   SELECT NULLIF(current_setting('core.current_context_id', TRUE), '');
# $$ LANGUAGE SQL;
#
# CREATE OR REPLACE FUNCTION set_created_fields() RETURNS TRIGGER AS $$
# BEGIN
#   NEW.created_by = current_user_id();
#   NEW.team_id = current_team_id();
#   NEW.context_id = current_context_id();
#   RETURN NEW;
# END;
# $$ LANGUAGE plpgsql;
#
# CREATE OR REPLACE FUNCTION audit() RETURNS TRIGGER AS $$
# BEGIN
#   INSERT INTO audit_log (
#     "op",
#     "table_name",
#     "old",
#     "new",
#     "model_id"
#   ) VALUES (
#     TG_OP::"NativeDatabaseOperation",
#     TG_TABLE_NAME,
#     CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
#     CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
#     CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
#   );
#   RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
# END;
# $$ LANGUAGE plpgsql;
