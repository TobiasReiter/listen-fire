-- # PREAMBLE

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;






-- # EXTENSIONS

CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- # ROLES

-- Role creation is handled by deploy/postgres-init/00-roles.sql, which the dev
-- Postgres image and the self-host compose file run on an empty data directory,
-- apps/api/scripts/restore_db_snapshot.sh runs for a restored snapshot, and
-- apps/api/src/db/migrate.sh runs itself against a managed database that has no
-- init hook. Roles are cluster-global, not database-specific, so they don't
-- belong in schema migrations


-- # TYPES

-- The identity unit's schema and enums. Same reason as valuations below: the
-- file applies top to bottom, so a unit's types exist before anything names
-- them. (`OpsDetailLevel` travelled through here with `team.ops_detail_level`
-- and has since moved on to automations, where its only reader lives.)
CREATE SCHEMA IF NOT EXISTS core;

CREATE TYPE core."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);

-- The valuations unit's enums live here rather than in its own section at the
-- foot of the file, because residual `public` tables still name them
-- (`profile_public_round.round_type`, `inventory_delta_holding.asset_type`)
-- and this file is applied top to bottom.
CREATE SCHEMA IF NOT EXISTS valuations;

CREATE TYPE valuations."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);

CREATE TYPE valuations."AssetType" AS ENUM (
    'CONVERTIBLE',
    'CURRENCY',
    'EMPLOYEE_STOCK_OPTIONS',
    'EQUITY',
    'EQUITY_UNKNOWN_SHARES',
    'LP_INTEREST_POINT',
    'SPV_INTEREST_POINT',
    'UNKNOWN',
    'FUND_OUTSTANDING_COMMITMENT',
    'ACCRUED_INCOME'
);

CREATE TYPE valuations."CurrencyIsoCode" AS ENUM (
    'CHF',
    'EUR',
    'GBP',
    'NOK',
    'SEK',
    'USD',
    'DKK'
);

CREATE TYPE valuations."EquityRoundType" AS ENUM (
    'PRE_PRE_SEED',
    'PRE_SEED',
    'SEED',
    'SEED_EXT',
    'SERIES_A',
    'SERIES_A_EXT',
    'SERIES_A2',
    'SERIES_B',
    'SERIES_B_EXT',
    'SERIES_C',
    'SERIES_C_EXT',
    'SERIES_D',
    'SERIES_E',
    'SERIES_F',
    'SERIES_G',
    'SERIES_H',
    'SERIES_I',
    'SERIES_J',
    'UNKNOWN'
);

CREATE TYPE valuations."ValuationType" AS ENUM (
    'PRE_MONEY',
    'POST_MONEY'
);

CREATE TYPE valuations."LegalEntityType" AS ENUM (
    'COMPANY',
    'ESOP',
    'FUND',
    'NATURAL_PERSON',
    'PORTFOLIO_COMPANY',
    'SPV'
);

CREATE TYPE valuations."InvestmentStatus" AS ENUM (
    'ACTIVE',
    'REALISED',
    'STEALTH'
);

CREATE TYPE valuations."CompanyLegalStatus" AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'DISSOLVED'
);

CREATE TYPE valuations."EventType" AS ENUM (
    'FOUNDER_EQUITY_SPLIT',
    'INVESTMENT_ROUND',
    'SHARE_SPLIT',
    'SHARE_REVERSE_SPLIT',
    'SECONDARY_SALE',
    'DISTRIBUTION',
    'DIVIDEND',
    'MARKDOWN',
    'FUND_DISTRIBUTION',
    'FUND_CLOSE',
    'SHARE_PRICE',
    'LIQUIDATION'
);

CREATE TYPE valuations."InvestmentRoundType" AS ENUM (
    'EQUITY',
    'CONVERTIBLE',
    'OTHER'
);

CREATE TYPE valuations."InvestmentType" AS ENUM (
    'CASH',
    'EQUITY_TRANSFER'
);

CREATE TYPE valuations."ConvertibleType" AS ENUM (
    'ASA',
    'BSA_AIR',
    'CONVERTIBLE_NOTE',
    'LOAN',
    'POST_MONEY_SAFE',
    'PRE_MONEY_SAFE',
    'SAFT',
    'SEEDFAST',
    'SEEDNOTE',
    'SLIP'
);

CREATE TYPE valuations."PriceType" AS ENUM (
    'FROM_PRICED_ROUND',
    'FROM_ASSET_HOLDER',
    'CONVERSION'
);

CREATE TYPE valuations."NoteType" AS ENUM (
    'TRANSACTION',
    'PRICE',
    'EVENT',
    'PROFILE',
    'INVESTMENT'
);



CREATE TYPE public."OpsEventType" AS ENUM (
    'PORTFOLIO', 'DEALFLOW', 'DIRECTORY', 'LIVE_FEED', 'ONBOARDING',
    'SCHEDULED_COMMS', 'SUPPORT', 'SOCIAL', 'METRICS', 'OVI', 'AUTOMATION'
);

CREATE TYPE public."OpsSeverity" AS ENUM (
    'info', 'notable', 'warn', 'critical'
);

CREATE TYPE public."OpsRunStatus" AS ENUM (
    'running', 'parked', 'completed', 'failed'
);

-- (`OpsDetailLevel` moved to the `core` schema with `team.ops_detail_level`.)

-- ENCRYPTION FUNCTIONS (not cryptographically secure)

CREATE FUNCTION public.ascii_rotate_decrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  c text;
  idx int;
  ch_code int;
  K int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    IF ch_code BETWEEN 32 AND 126 THEN
      K := ascii(substring(key_text, ((idx - 1) % key_len) + 1, 1));
      K := (K % 95);
      ch_code := 32 + ((ch_code - 32 - K + 95) % 95);
      out_text := out_text || chr(ch_code);
    ELSE
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


CREATE FUNCTION public.ascii_rotate_encrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  c text;
  kcode int;
  i int := 1;
  idx int;
  ch_code int;
  K int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    -- Only rotate printable ASCII 32..126; keep other chars unchanged
    IF ch_code BETWEEN 32 AND 126 THEN
      K := ascii(substring(key_text, ((idx - 1) % key_len) + 1, 1));
      -- reduce K into 0..94 (printable count) using modulo
      K := (K % 95);
      -- rotate in printable range:
      ch_code := 32 + ((ch_code - 32 + K) % 95);
      out_text := out_text || chr(ch_code);
    ELSE
      -- leave non-printable or non-ASCII unchanged (or handle differently)
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;

CREATE FUNCTION public.class_rotate_decrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  idx int;
  c text;
  ch_code int;
  key_char text;
  k_val int;
  k_mod int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    key_char := substring(key_text, ((idx - 1) % key_len) + 1, 1);

    -- same k_val logic as encrypt
    k_val := get_byte(convert_to(key_char, 'UTF8'), 0);

    IF ch_code BETWEEN 65 AND 90 THEN
      k_mod := k_val % 26;
      out_text := out_text || chr(65 + ((ch_code - 65 - k_mod + 26) % 26));

    ELSIF ch_code BETWEEN 97 AND 122 THEN
      k_mod := k_val % 26;
      out_text := out_text || chr(97 + ((ch_code - 97 - k_mod + 26) % 26));

    ELSIF ch_code BETWEEN 48 AND 57 THEN
      k_mod := k_val % 10;
      out_text := out_text || chr(48 + ((ch_code - 48 - k_mod + 10) % 10));

    ELSE
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


CREATE FUNCTION public.class_rotate_encrypt(input_text text, key_text text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  out_text text := '';
  key_len int := char_length(key_text);
  idx int;
  c text;
  ch_code int;
  key_char text;
  k_val int;
  k_mod int;
BEGIN
  IF key_len = 0 THEN
    RAISE EXCEPTION 'Key must not be empty';
  END IF;

  FOR idx IN 1..char_length(input_text) LOOP
    c := substring(input_text, idx, 1);
    ch_code := ascii(c);
    key_char := substring(key_text, ((idx - 1) % key_len) + 1, 1);

    -- use the first byte of the key char (works predictable for ASCII keys)
    k_val := get_byte(convert_to(key_char, 'UTF8'), 0);

    IF ch_code BETWEEN 65 AND 90 THEN
      -- Uppercase A..Z
      k_mod := k_val % 26;
      out_text := out_text || chr(65 + ((ch_code - 65 + k_mod) % 26));

    ELSIF ch_code BETWEEN 97 AND 122 THEN
      -- Lowercase a..z
      k_mod := k_val % 26;
      out_text := out_text || chr(97 + ((ch_code - 97 + k_mod) % 26));

    ELSIF ch_code BETWEEN 48 AND 57 THEN
      -- Digits 0..9
      k_mod := k_val % 10;
      out_text := out_text || chr(48 + ((ch_code - 48 + k_mod) % 10));

    ELSE
      -- Leave special / non-ASCII chars unchanged
      out_text := out_text || c;
    END IF;
  END LOOP;

  RETURN out_text;
END;
$$;


-- CONTEXT FUNCTIONS


CREATE FUNCTION public.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_context_id', TRUE), '');
$$;


CREATE FUNCTION public.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_team_id', TRUE), '');
$$;


CREATE FUNCTION public.current_user_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_user_id', TRUE), '');
$$;


CREATE FUNCTION public.current_api_key_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.current_api_key_id', TRUE), '');
$$;


CREATE FUNCTION public.set_current_context_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_context_id', id, TRUE);
$$;


CREATE FUNCTION public.set_current_team_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_team_id', id, TRUE);
$$;


CREATE FUNCTION public.set_current_user_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_user_id', id, TRUE);
$$;


CREATE FUNCTION public.set_current_api_key_id(id text) RETURNS text
    LANGUAGE sql
    AS $$
  SELECT set_config('core.current_api_key_id', id, TRUE);
$$;


-- AGENT EXECUTION FUNCTIONS

-- Execute arbitrary SQL with RLS enforcement
-- NOT SECURITY DEFINER - runs as the calling role (agent) with RLS applied
-- The application MUST set team context before calling this
CREATE FUNCTION public.execute_agent_query(query_text text)
RETURNS SETOF json
    LANGUAGE plpgsql
    SECURITY INVOKER  -- Explicit: runs as caller (agent role)
    -- `valuations` is on the path because the NL agent's generated SQL names
    -- `legal_entity`/`investment`/`event` unqualified. That surface is the
    -- dealflow search page and dies with dealflow; until then this is what
    -- keeps it resolving. RLS still gates it, on the unit's own team GUC.
    SET search_path = public, valuations, pg_catalog
    AS $$
BEGIN
    -- Verify context is set
    IF current_team_id() IS NULL THEN
        RAISE EXCEPTION 'Security violation: team context must be set before executing agent queries';
    END IF;

    -- Execute the query with RLS applied (agent role has NOBYPASSRLS)
    -- Wrapping in subquery prevents multiple statements
    RETURN QUERY EXECUTE format('SELECT row_to_json(_r) FROM (%s) _r', query_text);
END;
$$;

-- Only agent can execute
REVOKE EXECUTE ON FUNCTION public.execute_agent_query(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_agent_query(text) TO agent;




-- # TABLES

SET default_tablespace = '';

SET default_table_access_method = heap;





-------------------------------------------------------------------------------------------------------------------------
-- ## Audit
-------------------------------------------------------------------------------------------------------------------------

-- ### Audit Log -------------------------------------------------------------

CREATE TYPE public."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op public."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

-- think this one is unused
CREATE SEQUENCE public.log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
CREATE SEQUENCE public.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.audit_log_version_seq OWNED BY public.audit_log.version;
ALTER TABLE ONLY public.audit_log ALTER COLUMN version SET DEFAULT nextval('public.audit_log_version_seq'::regclass);

CREATE INDEX audit_log_context_id_idx ON public.audit_log USING btree (context_id);
CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at);
CREATE INDEX audit_log_model_id_idx ON public.audit_log USING btree (model_id);
CREATE INDEX audit_log_version_idx ON public.audit_log USING btree (version);

CREATE FUNCTION public.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = current_user_id();
  NEW.team_id = current_team_id();
  NEW.context_id = current_context_id();
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.set_created_fields();

CREATE FUNCTION public.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::"NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;



-- ### Context Logs ----------------------------------------------------------
-- (`valuations_change_outbox` and its `valuations_outbox_capture()` trigger
--  moved to the `valuations` schema — D3/5_valuations.md §1.8.)

CREATE TABLE public.context_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY public.context_logs
    ADD CONSTRAINT context_logs_pkey PRIMARY KEY (id);

CREATE INDEX context_logs_created_at_idx ON public.context_logs USING btree (created_at);
CREATE INDEX context_logs_key_idx ON public.context_logs USING btree (key);
CREATE INDEX context_logs_request_id_idx ON public.context_logs USING btree (request_id);
CREATE INDEX context_logs_team_id_idx ON public.context_logs USING btree (team_id);







-------------------------------------------------------------------------------------------------------------------------
-- ## Core User Model
-------------------------------------------------------------------------------------------------------------------------




-- (The identity family — `team`, `user`, `user_email`, `pending_signup`,
-- `magic_link_token`, `team_membership`, plus `team_invite` and `api_key`
-- from further down — moved to the CORE SCHEMA at the end of this
-- file (3_core.md §1). Every FK that pointed INTO them from here is gone (D3):
-- `team_id` / `user_id` / `created_by` survive as opaque uuids and the
-- application carries the tenant filter. What stayed behind, and why:
--   · `signup_event`   — marketing attribution for the admin app, residual (D36)
--   · `user_settings`  — DELETED in Phase 4.4 (C-2), along with the writes that
--                        existed only to keep its read alive
-- Column surgery on `team`/`user` (lifecycle → residual, style prefs →
-- knowledge, ops detail → automations) landed in Phase 4.4; the `user_email`
-- routing columns and `user.public_profile_id` are deferred to Phase 5 (D44c).)

-- signup_event — one row per NEW account, recording the acquisition channel
-- (auth method) + marketing attribution (utm_* + referrer). Read by the admin
-- app. Captured transiently from the signup URL/referrer (no client cookie).
CREATE TABLE public.signup_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    team_id uuid NOT NULL,
    channel text NOT NULL, -- google | microsoft | password
    utm_source text,
    utm_medium text,
    utm_campaign text,
    utm_term text,
    utm_content text,
    referrer text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.signup_event
    ADD CONSTRAINT signup_event_pkey PRIMARY KEY (id);


CREATE INDEX signup_event_created_at_idx ON public.signup_event USING btree (created_at);




-- (The phone family — `phone_number`, `phone_verification` — moved to the
-- AUTOMATIONS SCHEMA at the end of this file. Which team an inbound WhatsApp
-- message runs as is decided by the sender's verified number, so phone→team is
-- the channel product's own identity table, not core's (C-5/D28); core keeps
-- `user_email` and answers the Directory contract from it. The dealflow-era
-- `legal_entity_id` column did not travel — it is deleted (D6).)



-- ### User Settings --------------------------------------------------

-- (`user_settings` DELETED — C-2. Thirteen deal-feed/deal-notification
-- preferences whose service had no callers and whose only interactive surface,
-- apps/app's Notifications tab, saved through a WHERE that could never match a
-- row. The `ShowHide` enum went with it.)





-------------------------------------------------------------------------------------------------------------------------
-- ## Knowledge
-------------------------------------------------------------------------------------------------------------------------

-- `legal_entity` and the economic-event ledger it anchors — `event`,
-- `investment`, `investment_attribution` — moved to the `valuations` schema (D6: the company/person record belongs to
-- the valuation math). What stays here is dealflow-era and dies with dealflow:
-- `profile_email` still has a service, `profile_role` is still joined by core's
-- user-context resolver (V-9 asks core to unjoin it), and
-- `profile_public_round` is still read by the deal + timeline views. All three
-- keep their uuid columns pointing at `valuations.legal_entity` with no FK.



-- ### Profile Email ----------------------------------------------------

CREATE TABLE public.profile_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    email public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid
);


ALTER TABLE ONLY public.profile_email
    ADD CONSTRAINT profile_email_pkey PRIMARY KEY (id);


CREATE TRIGGER profile_email_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_email FOR EACH ROW EXECUTE FUNCTION public.audit();



-- ### Profile Role ---------------------------------------------------

CREATE TABLE public.profile_role (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    description text,
    entity_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone
);


ALTER TABLE ONLY public.profile_role
    ADD CONSTRAINT profile_role_pkey PRIMARY KEY (id);


CREATE INDEX profile_role_entity_id_idx ON public.profile_role USING btree (entity_id);
CREATE INDEX profile_role_profile_id_idx ON public.profile_role USING btree (profile_id);

CREATE TRIGGER profile_role_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_role FOR EACH ROW EXECUTE FUNCTION public.audit();


-- (RLS moved to the trailing block: the policy reads `valuations.legal_entity`,
--  which this file does not define until after the public tables.)

-- ### Profile Public Round [Deprecated]-------------------------------

CREATE TABLE public.profile_public_round (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    round_type valuations."EquityRoundType" NOT NULL,
    announced_date date,
    announced_amount double precision,
    announced_currency valuations."CurrencyIsoCode",
    announced_valuation double precision,
    valuation_type valuations."ValuationType",
    press_release_url text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    source text,
    lead_investor_id uuid,
    raw_text text
);


ALTER TABLE ONLY public.profile_public_round
    ADD CONSTRAINT profile_public_round_pkey PRIMARY KEY (id);


CREATE INDEX profile_public_round_lead_investor_id_idx ON public.profile_public_round USING btree (lead_investor_id);
CREATE INDEX profile_public_round_profile_id_idx ON public.profile_public_round USING btree (profile_id);

CREATE TRIGGER profile_public_round_audit AFTER INSERT OR DELETE OR UPDATE ON public.profile_public_round FOR EACH ROW EXECUTE FUNCTION public.audit();






-------------------------------------------------------------------------------------------------------------------------
-- ## Valuations
-------------------------------------------------------------------------------------------------------------------------

-- The portfolio ledger — `transaction`, `asset`, `currency_asset`, `price`,
-- `asset_transfer`, `funding_changelog`(+`_fund`), `exchange_rate` — moved to
-- the `valuations` schema. The delta cache below did NOT: V-1 deletes it
-- outright, and until then its two tables still have a reader.




-- ### Inventory Delta Cache ----------------------------------------------
-- Per-investment, per-close-date attribution of holdings. The valuations
-- engine writes one event row per (investment, close_date) on which holdings
-- changed, with child rows giving the resolved asset attribution. The cache
-- exists for API and aggregate read paths; single-legal-entity views should
-- still compute from first principles.

CREATE TABLE public.inventory_delta_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    investment_id uuid NOT NULL,
    close_date date NOT NULL,
    has_non_cash_investment boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.inventory_delta_event
    ADD CONSTRAINT inventory_delta_event_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX inventory_delta_event_investment_id_close_date_key ON public.inventory_delta_event USING btree (investment_id, close_date);
CREATE INDEX inventory_delta_event_team_id_idx ON public.inventory_delta_event USING btree (team_id);


CREATE TABLE public.inventory_delta_holding (
    event_id uuid NOT NULL, -- @DEF: inventory_delta_holding_event_id_fkey
    asset_id uuid NOT NULL,
    asset_type valuations."AssetType" NOT NULL,
    -- Causal degree of the lots summed here: 0 when the asset tracks the company
    -- invested into, otherwise one more than its predecessor's. Cash at degree 1
    -- is what the company itself paid; degree 2+ came out of whatever it turned
    -- into. Without it the cache cannot answer the direct-realised atom at all.
    degree integer NOT NULL,
    -- Which side of the flow this bucket holds. Value is linear in num_assets,
    -- so netting lots inside a bucket is lossless — but the realised/invested
    -- split is taken per flow SIGN, so inflows and outflows must not net
    -- together. Redundant with sign(num_assets) by construction; it is a key
    -- column, not derived state.
    is_inflow boolean NOT NULL,
    num_assets double precision NOT NULL,
    -- Does this held asset still track the value of the company the investment
    -- was made in? A non-cash asset that has stopped tracking the investee (an
    -- acquirer's shares taken in a share-for-share swap, say) is retained in
    -- what the company became rather than in the company itself. Not implied by
    -- degree: an inflow with no predecessor sits at degree 0 whether it tracks
    -- or not.
    tracks_investee boolean DEFAULT true NOT NULL
);

-- One row per (event, asset, degree, tracking, side) — the finest grain the
-- read path's arithmetic can distinguish, and the coarsest that stays exact.
ALTER TABLE ONLY public.inventory_delta_holding
    ADD CONSTRAINT inventory_delta_holding_pkey PRIMARY KEY (event_id, asset_id, degree, tracks_investee, is_inflow);

-- @DEF: inventory_delta_holding_event_id_fkey
ALTER TABLE ONLY public.inventory_delta_holding
    ADD CONSTRAINT inventory_delta_holding_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.inventory_delta_event(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX inventory_delta_holding_asset_id_idx ON public.inventory_delta_holding USING btree (asset_id);



-------------------------------------------------------------------------------------------------------------------------
-- ## Pipeline
-------------------------------------------------------------------------------------------------------------------------

-- ### Pipeline Configuration -------------------------------------------------------

CREATE TABLE public.pipeline_configuration (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone
);


ALTER TABLE ONLY public.pipeline_configuration
    ADD CONSTRAINT pipeline_configuration_pkey PRIMARY KEY (id);



CREATE UNIQUE INDEX pipeline_configuration_team_id_name_key ON public.pipeline_configuration USING btree (team_id, name);

CREATE TRIGGER pipeline_configuration_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_configuration FOR EACH ROW EXECUTE FUNCTION public.audit();



-- (The credentials vault — `external_service_credentials`, its `ExternalServiceType`
-- enum, and the three satellites `connect_token`, `google_granted_item` and
-- `remote_adapter` — moved to the AUTOMATIONS SCHEMA at the end of this file (D7).
-- The satellites' `credentials_id` foreign keys travelled with them and are
-- in-schema; the encrypted bytes were not touched.)



-- ### Pipeline Input -------------------------------------------------------

CREATE TYPE public."PipelineInputContentType" AS ENUM (
    'DEALFLOW',
    'INVESTOR_UPDATE',
    'REQUEST',
    'UNKNOWN',
    'COMPANY_INFO'
);

CREATE TYPE public."PipelineInputType" AS ENUM (
    'MAILGUN',
    'TWILIO',
    'INBOUND_EMAIL',
    'INBOUND_WHATSAPP',
    'API',
    'WEB',
    'SLACK',
    'CUSTOM_EMAIL',
    'WEB_QUESTION',
    'AIRTABLE',
    'CHROME_EXTENSION',
    'GMAIL',
    'GRANOLA',
    -- Structured inputs (per plans/2026-05-07-structured-input-containers/).
    -- These pipeline_input types hold typed translation_graphs[] entries
    -- instead of message-type extraction graphs; configured via the new
    -- input editor page.
    'ATTIO',
    'AFFINITY',
    'PIPEDRIVE',
    'NATIVE_VALUATIONS'
);

CREATE TABLE public.pipeline_input (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_configuration_id uuid NOT NULL, -- @DEF: pipeline_input_pipeline_configuration_id_fkey
    type public."PipelineInputType" NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone,
    content_type public."PipelineInputContentType" NOT NULL,
    credentials_id uuid, -- FK dropped: the vault moved to `automations` (D3); this table dies with dealflow (D17)
    knowledge_enabled boolean NOT NULL DEFAULT false,
    dealflow_enabled boolean NOT NULL DEFAULT true,
    default_for public."PipelineInputType",
    poll_interval_minutes integer,
    poll_checkpoint jsonb,
    poll_enabled boolean NOT NULL DEFAULT false,
    poll_last_at timestamp(3) with time zone,
    poll_consecutive_failures integer NOT NULL DEFAULT 0,
    poll_last_error text,
    -- Event-mode TG body — one canonical NodeMappings + Edges map per
    -- input, shared by every event-mode trigger entry on this input. This
    -- is consumer-level shared configuration (analogous to `config`), NOT
    -- a per-TG body — every event-mode trigger on this input dispatches
    -- against this same map. Per-trigger TG bodies live in
    -- `knowledge.translation_graph` rows keyed by `pipeline_input_id`.
    --
    -- Shape: { nodeMappings: NodeMapping[], edges: TGEdge[] }
    tg_event_body jsonb,
    -- (router_tg_id removed: content routing is now a `branch` at the root
    -- of a trigger's orchestration, not a separate router TG. See
    -- plans/2026-06-04-automation-as-program/3c_substrate-collapse.md.)
    -- V8: provenance marker. True iff this row was minted by
    -- `provisionSync` in the Setup-agent flow. Lets provisionSync's
    -- idempotency check distinguish rows it owns from legacy rows that
    -- happen to share (pipeline_configuration_id, type, knowledge_enabled).
    -- See plans/2026-05-23-onboarding-funnel/_execution/_escalations.md
    -- (2026-05-23 22:55).
    provisioned_by_setup_agent boolean NOT NULL DEFAULT false
);


ALTER TABLE ONLY public.pipeline_input
    ADD CONSTRAINT pipeline_input_pkey PRIMARY KEY (id);

-- At most one default per channel per pipeline configuration
CREATE UNIQUE INDEX pipeline_input_default_for_unique
  ON public.pipeline_input (default_for, pipeline_configuration_id)
  WHERE default_for IS NOT NULL AND deleted_at IS NULL;

-- @DEF: pipeline_input_pipeline_configuration_id_fkey
ALTER TABLE ONLY public.pipeline_input
    ADD CONSTRAINT pipeline_input_pipeline_configuration_id_fkey FOREIGN KEY (pipeline_configuration_id) REFERENCES public.pipeline_configuration(id) ON UPDATE CASCADE ON DELETE RESTRICT;


CREATE TRIGGER pipeline_input_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_input FOR EACH ROW EXECUTE FUNCTION public.audit();


-- ### Pipeline Input Message Type ---------------------------------------------
-- Junction table: which knowledge message types a pipeline input should process.

CREATE TABLE public.pipeline_input_message_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_input_id uuid NOT NULL,
    node_type_id uuid NOT NULL, -- FK to knowledge.node_type, defined in knowledge schema section
    property_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_unique UNIQUE (pipeline_input_id, node_type_id);

ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_pipeline_input_id_fkey FOREIGN KEY (pipeline_input_id) REFERENCES public.pipeline_input(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX pipeline_input_message_type_pipeline_input_id_idx ON public.pipeline_input_message_type USING btree (pipeline_input_id);



-- ### Pipeline Output -------------------------------------------------------

CREATE TYPE public."PipelineOutputMode" AS ENUM (
    'PER_COMPANY',
    'PER_MESSAGE'
);

CREATE TYPE public."PipelineOutputType" AS ENUM (
    'WEBHOOK',
    'INBOUND_EMAIL',
    'INBOUND_WHATSAPP',
    'MAILGUN',
    'TWILIO',
    'ATTIO',
    'AFFINITY',
    'PIPEDRIVE',
    'SLACK',
    'SLACK_REACTION',
    'AIRTABLE',
    'GOOGLE_SHEETS',
    'GOOGLE_DRIVE',
    'DROPBOX',
    'NATIVE',
    'NATIVE_VALUATIONS'
);

CREATE TABLE public.pipeline_output (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_configuration_id uuid NOT NULL, -- @DEF: pipeline_output_pipeline_configuration_id_fkey
    type public."PipelineOutputType" NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) without time zone,
    credentials_id uuid, -- FK dropped: the vault moved to `automations` (D3); this table dies with dealflow (D17)
    mode public."PipelineOutputMode" DEFAULT 'PER_COMPANY'::public."PipelineOutputMode" NOT NULL,
    config_version integer DEFAULT 1 NOT NULL,  -- 1 = legacy modal config, 2 = graph-based config
    run_mode text DEFAULT 'live' NOT NULL,  -- 'off', 'dry_run', 'live'
    -- Knowledge model trigger config
    trigger_node_type_id uuid, -- FK to knowledge.node_type, defined in knowledge schema section
    trigger_event text,
    trigger jsonb,
    position integer DEFAULT 0 NOT NULL,
    -- Event-mode TG body — one canonical NodeMappings + Edges map per
    -- output, shared by every event-mode trigger entry on this output.
    -- Consumer-level shared configuration (not a per-TG body). Per-trigger
    -- TG bodies live in `knowledge.translation_graph` rows keyed by
    -- `pipeline_output_id`. Mirrors pipeline_input.tg_event_body.
    --
    -- Shape: { nodeMappings: NodeMapping[], edges: TGEdge[] }
    tg_event_body jsonb,
    -- V8: provenance marker. True iff this row was minted by
    -- `provisionSync` in the Setup-agent flow. Lets provisionSync's
    -- idempotency check distinguish rows it owns from legacy rows that
    -- happen to share (pipeline_configuration_id, type, credentials_id).
    -- See plans/2026-05-23-onboarding-funnel/_execution/_escalations.md
    -- (2026-05-23 22:55).
    provisioned_by_setup_agent boolean NOT NULL DEFAULT false
);


ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_pkey PRIMARY KEY (id);

-- @DEF: pipeline_output_pipeline_configuration_id_fkey
ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_pipeline_configuration_id_fkey FOREIGN KEY (pipeline_configuration_id) REFERENCES public.pipeline_configuration(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TRIGGER pipeline_output_audit AFTER INSERT OR DELETE OR UPDATE ON public.pipeline_output FOR EACH ROW EXECUTE FUNCTION public.audit();



-- (The engine-runtime tables that used to sit here — `trigger_run`,
-- `adapter_await`, `callback`, `parked_run`, `join_pending`,
-- `join_branch_export`, `record_binding` and `trigger_event` — moved to the
-- AUTOMATIONS SCHEMA at the end of this file. They are the movement engine's
-- own run ledger and park machinery; nothing outside automations writes them.
-- What stayed behind is the ops-residual side of the split: `llm_usage` keeps a
-- `trigger_run_id` COLUMN and lost the constraint (D3/D8) — usage recording is
-- the operating company, not part of the product.)



-- ### Pipeline Mapping -------------------------------------------------------




-- ### Pipeline Retrieval Source ----------------------------------------------






-- (`webhook_subscription` moved to the AUTOMATIONS SCHEMA at the end of this file,
-- with the credential it points at; the listen reconciler is its only writer.)






-- ### Inbound Payload ----------------------------------------------------------

CREATE TABLE public.inbound_payload (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel public."PipelineInputType",
    data jsonb NOT NULL,
    message_type text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    "isContext" boolean,
    "isContextRequest" boolean,
    "isInjection" boolean,
    pipeline_input_id uuid, -- @DEF: inbound_payload_pipeline_input_id_fkey
    dedup_id text
);


ALTER TABLE ONLY public.inbound_payload
    ADD CONSTRAINT inbound_payload_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX inbound_payload_team_dedup_unique
  ON public.inbound_payload (team_id, dedup_id)
  WHERE dedup_id IS NOT NULL;

-- @DEF: inbound_payload_pipeline_input_id_fkey
ALTER TABLE ONLY public.inbound_payload
    ADD CONSTRAINT inbound_payload_pipeline_input_id_fkey FOREIGN KEY (pipeline_input_id) REFERENCES public.pipeline_input(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- TODO: Add audit trigger ?



-- ### Dealflow Pipeline -----------------------------------------------------

CREATE TYPE public."DealflowPipelineStatus" AS ENUM (
    'PROCESSING',
    'COMPLETE',
    'CANCELLED',
    'BLOCKED'
);

CREATE TABLE public.dealflow_pipeline (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    status public."DealflowPipelineStatus" DEFAULT 'PROCESSING'::public."DealflowPipelineStatus" NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    request_id uuid NOT NULL,
    errors jsonb,
    numeric_id bigint NOT NULL,
    final_graph jsonb
);


CREATE SEQUENCE public.dealflow_pipeline_numeric_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.dealflow_pipeline_numeric_id_seq OWNED BY public.dealflow_pipeline.numeric_id;
ALTER TABLE ONLY public.dealflow_pipeline ALTER COLUMN numeric_id SET DEFAULT nextval('public.dealflow_pipeline_numeric_id_seq'::regclass);


ALTER TABLE ONLY public.dealflow_pipeline
    ADD CONSTRAINT dealflow_pipeline_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX dealflow_pipeline_numeric_id_key ON public.dealflow_pipeline USING btree (numeric_id);

-- TODO: Add audit trigger ?



-- ### Dealflow Job -----------------------------------------------------------
-- (`webhook` + `outbound_webhook_request` moved to `valuations` — D18: the
--  valuations outbox is their only live producer. V-16/D24 replaces them with
--  a clean pair inside that unit, so they are transitional lodgers there.)
--
-- `dealflow_job` itself is GONE (phase 6.2). It was the last holder of a FK
-- into `pipeline_output`; its only remaining occurrence in the repo was a
-- type-level one, and that went with it.






-------------------------------------------------------------------------------------------------------------------------
-- ## Presentation
-------------------------------------------------------------------------------------------------------------------------

































-------------------------------------------------------------------------------------------------------------------------
-- ## Data
-------------------------------------------------------------------------------------------------------------------------

-- ### Source material — MOVED OUT to the `knowledge` schema
--
-- `raw_text`, `raw_text_part`, `document` and `resource` (with the
-- `RawTextPartType` and `ResourceType` enums) now live in `knowledge` — D48
-- ratification (i). They were filed here as dealflow residue; the 5.3 re-grep
-- found the opposite. `resource` is written by the KG adapter on every movement
-- write that carries a source, and read by the MCP node-detail tool, two
-- apps/web procedures, the public REST knowledge API and the `#resources`
-- traversal; `raw_text` takes an insert on every file-text resolution;
-- `document` backs a live download. That is knowledge machinery, so it moves
-- rather than drops.
--
-- What stayed behind, and why: the join tables below (`resource_payload`,
-- `resource_source`) are residue awaiting deletion. Their FKs into the moved
-- tables are cross-schema and are dropped per D3 — the columns stay as plain
-- uuids. (Three siblings of the same shape — one for resource segments, one
-- for legal entities, one for investor updates — plus the investor-update
-- table they hung off of, had zero live callers — see ResourceService — and
-- are gone entirely.)




-- ### Resource Payload -----------------------------------------------------

CREATE TABLE public.resource_payload (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    resource_id uuid NOT NULL, -- FK dropped: `resource` moved to the `knowledge` schema (D3)
    inbound_payload_id uuid NOT NULL, -- @DEF: resource_payload_inbound_payload_id_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY public.resource_payload
    ADD CONSTRAINT resource_payload_pkey PRIMARY KEY (id);

-- @DEF: resource_payload_inbound_payload_id_fkey
ALTER TABLE ONLY public.resource_payload
    ADD CONSTRAINT resource_payload_inbound_payload_id_fkey FOREIGN KEY (inbound_payload_id) REFERENCES public.inbound_payload(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX resource_payload_inbound_payload_id_idx ON public.resource_payload USING btree (inbound_payload_id);
CREATE INDEX resource_payload_resource_id_idx ON public.resource_payload USING btree (resource_id);
CREATE INDEX resource_payload_team_id_idx ON public.resource_payload USING btree (team_id);

CREATE TRIGGER resource_payload_audit AFTER INSERT OR DELETE OR UPDATE ON public.resource_payload FOR EACH ROW EXECUTE FUNCTION public.audit();



-- ### Resource Source ------------------------------------------------------

CREATE TABLE public.resource_source (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legal_entity_id uuid NOT NULL,
    resource_id uuid NOT NULL, -- FK dropped: `resource` moved to the `knowledge` schema (D3)
    team_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY public.resource_source
    ADD CONSTRAINT resource_source_pkey PRIMARY KEY (id);


CREATE INDEX resource_source_legal_entity_id_idx ON public.resource_source USING btree (legal_entity_id);
CREATE INDEX resource_source_resource_id_idx ON public.resource_source USING btree (resource_id);
CREATE INDEX resource_source_team_id_idx ON public.resource_source USING btree (team_id);

CREATE TRIGGER resource_source_audit AFTER INSERT OR DELETE OR UPDATE ON public.resource_source FOR EACH ROW EXECUTE FUNCTION public.audit();



























-- (The WhatsApp tables — `whatsapp_conversations`, `whatsapp_messages` and their
-- three enums — moved to the AUTOMATIONS SCHEMA (D18), gained team tenancy
-- (D55(a)), and were then DROPPED entirely (D57): a fresh three-spelling grep
-- at Phase 6 close found the row-creation loop already gone — no
-- INSERT path survives anywhere in the repo — and the only surviving reader,
-- `updateMessageStatus`, already behaves as a no-op against zero rows in
-- production today. The third table of the original migration,
-- `whatsapp_bot_states`, was dead and dropped earlier with the teardown's
-- dead-table sweep.)



-------------------------------------------------------------------------------------------------------------------------
-- ## Misc
-------------------------------------------------------------------------------------------------------------------------


-- ### Notion Token --------------------------------------------------------------

CREATE TABLE public.notion_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    token text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY public.notion_token
    ADD CONSTRAINT notion_token_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX notion_token_token_key ON public.notion_token USING btree (token);

CREATE TRIGGER notion_token_audit AFTER INSERT OR DELETE OR UPDATE ON public.notion_token FOR EACH ROW EXECUTE FUNCTION public.audit();



-- ### Portfolio Company Metric --------------------------------------------------------------

CREATE TABLE public.portfolio_company_metric (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    investor_id uuid NOT NULL,
    company_id uuid NOT NULL,
    owned double precision,
    markdown_date date,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY public.portfolio_company_metric
    ADD CONSTRAINT portfolio_company_metric_pkey PRIMARY KEY (id);



CREATE INDEX portfolio_company_metric_company_id_idx ON public.portfolio_company_metric USING btree (company_id);
CREATE UNIQUE INDEX portfolio_company_metric_investor_id_company_id_key ON public.portfolio_company_metric USING btree (investor_id, company_id);
CREATE INDEX portfolio_company_metric_investor_id_idx ON public.portfolio_company_metric USING btree (investor_id);

CREATE TRIGGER portfolio_company_metric_audit AFTER INSERT OR DELETE OR UPDATE ON public.portfolio_company_metric FOR EACH ROW EXECUTE FUNCTION public.audit();





-- ### Agent Conversation --------------------------------------------------------------

CREATE TABLE public.agent_conversation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    title text,
    agent_type text DEFAULT 'knowledge_query' NOT NULL,
    active_agent text DEFAULT 'query' NOT NULL,
    handoff_depth integer DEFAULT 0 NOT NULL,
    working_document_uri text,
    working_document_title text,
    document_mode text DEFAULT 'collaborating' NOT NULL,
    funnel_context jsonb,
    -- N1: per-conversation navigation state. Carries the pinned named
    -- references an agent is currently working on (e.g. tgName,
    -- destinationName, inboundName). Replaces on `navigateTo`; merges on
    -- `extendNavigation`. Shape is per-purpose; framework + agents share.
    navigation_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- N1: small history of recent navigateTo invocations, used by
    -- resolveByName for recency disambiguation within this conversation.
    -- Append-only array; trimmed to a small N entries by the service.
    -- Each entry: { kind: string, name: string, at: <ISO timestamp> }.
    navigation_history jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- M3: small bag of compaction state — `runningState` (a Haiku-rolled
    -- summary paragraph rewritten between turns) and `compactedThrough`
    -- (the id of the last `agent_message` folded into it). Additive; all
    -- existing readers ignore unknown keys.
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.agent_conversation
    ADD CONSTRAINT agent_conversation_pkey PRIMARY KEY (id);


CREATE INDEX agent_conversation_team_id_idx ON public.agent_conversation USING btree (team_id);
CREATE INDEX agent_conversation_user_id_idx ON public.agent_conversation USING btree (user_id);

CREATE TRIGGER agent_conversation_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_conversation FOR EACH ROW EXECUTE FUNCTION public.audit();



-- ### Agent Message --------------------------------------------------------------

CREATE TABLE public.agent_message (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL, -- @DEF: agent_message_conversation_id_fkey
    role text NOT NULL,
    content text NOT NULL,
    metadata jsonb,
    context text,
    agent text,
    message_type text DEFAULT 'chat' NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.agent_message
    ADD CONSTRAINT agent_message_pkey PRIMARY KEY (id);

-- @DEF: agent_message_conversation_id_fkey
ALTER TABLE ONLY public.agent_message
    ADD CONSTRAINT agent_message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversation(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX agent_message_conversation_id_idx ON public.agent_message USING btree (conversation_id);

CREATE TRIGGER agent_message_audit AFTER INSERT OR DELETE OR UPDATE ON public.agent_message FOR EACH ROW EXECUTE FUNCTION public.audit();



-- ### LLM Usage -------------------------------------------------------------

CREATE TABLE public.llm_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    call_type text NOT NULL,
    label text,
    input_tokens integer NOT NULL DEFAULT 0,
    output_tokens integer NOT NULL DEFAULT 0,
    cache_read_tokens integer NOT NULL DEFAULT 0,
    cache_creation_tokens integer NOT NULL DEFAULT 0,
    cost_microdollars integer NOT NULL DEFAULT 0,
    duration_ms integer,
    pipeline_id uuid, -- @DEF: llm_usage_pipeline_id_fkey
    conversation_id uuid, -- @DEF: llm_usage_conversation_id_fkey
    trigger_run_id uuid, -- opaque automations run id, no foreign key (D3) — per-run LLM cost rollup (billing spec §2.3)
    -- The registry name the caller asked for; `model` is what the model map sent
    -- on the wire in its place. NULL on rows written before the map existed.
    preferred_model text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pkey PRIMARY KEY (id);

-- @DEF: llm_usage_pipeline_id_fkey
ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_pipeline_id_fkey FOREIGN KEY (pipeline_id) REFERENCES public.dealflow_pipeline(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: llm_usage_conversation_id_fkey
ALTER TABLE ONLY public.llm_usage
    ADD CONSTRAINT llm_usage_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversation(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX llm_usage_team_id_idx ON public.llm_usage USING btree (team_id);
CREATE INDEX llm_usage_pipeline_id_idx ON public.llm_usage USING btree (pipeline_id);
CREATE INDEX llm_usage_conversation_id_idx ON public.llm_usage USING btree (conversation_id);
CREATE INDEX llm_usage_created_at_idx ON public.llm_usage USING btree (created_at);
CREATE INDEX llm_usage_trigger_run_id_idx ON public.llm_usage USING btree (trigger_run_id);

-- (No FK on `trigger_run_id`: the run ledger is automations', this table is
-- ops-residual, and D3 forbids the crossing. The column stays; a pruned run
-- leaves it dangling unless the pruner nulls it — services/billing/run_references.ts.)



-------------------------------------------------------------------------------------------------------------------------
-- ## External API
-------------------------------------------------------------------------------------------------------------------------


-- (`api_key` moved to the CORE SCHEMA at the end of this file — it is a
-- credential-to-act, which is core's one job (C-7). `oauth_client` went with
-- it and was then deleted outright (D26). Its
-- `team_id`/`created_by` FKs travelled with it and are in-schema;
-- `api_key.pipeline_input_id` kept its column and lost its FK, since
-- `pipeline_input` is dealflow and dies with it.)

-- Webhook URLs for simple ingest without API key auth.
-- The secret is embedded in the URL itself for simplicity with partially technical users.



-- #############################################################################
-- # KNOWLEDGE SCHEMA
-- #############################################################################
--
-- The knowledge model: an ontology-driven knowledge graph that captures
-- structured information from unstructured communications.
--
-- `team_id` is an opaque tenant id here — the FK into `team` went when the
-- identity family moved to `core` (D3), and the RLS policies below key on the
-- COLUMN, which is why they were unaffected.
--
-- The schema now reaches outside itself in exactly one way, and it is not a
-- coupling: pgvector, for `extraction_fact.embedding` (the last vector column,
-- and it dies with that table). No foreign key leaves the schema, no trigger
-- calls a function outside it, and no policy reads another unit's session
-- setting — `pg_dump --schema=knowledge` restores with extensions and nothing
-- else. D37(h).

CREATE SCHEMA IF NOT EXISTS knowledge;

CREATE TYPE knowledge."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);


-- ## Session context — the unit's own GUCs
--
-- A unit whose triggers and policies read another unit's session settings
-- looks correct in a composed deployment (core sets the old names) and
-- silently attributes every standalone write to nobody (D35(c)). Knowledge
-- reads `knowledge.*`, set from the same Principal at the same transaction
-- entry point core and valuations use.
--
-- The set is deliberately a COPY of theirs rather than a shared helper: these
-- become separate repos, and a session derivation one imports from another is
-- a coupling neither wants (D12).

CREATE FUNCTION knowledge.set_session_context(
    p_team_id text,
    p_actor_type text,
    p_actor_id text,
    p_context_id text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('knowledge.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('knowledge.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('knowledge.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('knowledge.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;

CREATE FUNCTION knowledge.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.team_id', TRUE), '');
$$;

CREATE FUNCTION knowledge.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.actor_type', TRUE), '');
$$;

CREATE FUNCTION knowledge.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.actor_id', TRUE), '');
$$;

CREATE FUNCTION knowledge.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('knowledge.context_id', TRUE), '');
$$;


-- ## Audit log — the unit's own
--
-- Seventeen of this schema's tables are audited, and `public.audit_log` is
-- residual operator-ops (D36) that does not travel with the unit. Who changed an
-- ontology, who deleted a node, when a property type's `writable_by` was
-- widened — that trail is the knowledge unit's own evidence and has to land
-- inside the schema.

CREATE TABLE knowledge.audit_log (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op knowledge."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);

ALTER TABLE ONLY knowledge.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

CREATE SEQUENCE knowledge.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE knowledge.audit_log_version_seq OWNED BY knowledge.audit_log.version;
ALTER TABLE ONLY knowledge.audit_log ALTER COLUMN version SET DEFAULT nextval('knowledge.audit_log_version_seq'::regclass);

CREATE INDEX knowledge_audit_log_context_id_idx ON knowledge.audit_log USING btree (context_id);
CREATE INDEX knowledge_audit_log_created_at_idx ON knowledge.audit_log USING btree (created_at);
CREATE INDEX knowledge_audit_log_model_id_idx ON knowledge.audit_log USING btree (model_id);
CREATE INDEX knowledge_audit_log_version_idx ON knowledge.audit_log USING btree (version);

CREATE FUNCTION knowledge.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = knowledge.current_actor_id();
  NEW.team_id = NULLIF(knowledge.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(knowledge.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON knowledge.audit_log FOR EACH ROW EXECUTE FUNCTION knowledge.set_created_fields();

CREATE FUNCTION knowledge.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO knowledge.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::knowledge."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


-- =============================================================================
-- ONTOLOGY — defines the domain model (what to extract)
-- =============================================================================

-- ## Node Types
-- The types of things that exist: message, object, scoped_object.

CREATE TYPE knowledge.node_type_category AS ENUM (
    'message',
    'object',
    'scoped_object'
);

CREATE TYPE knowledge.property_value_type AS ENUM (
    'text',
    'number',
    'date',
    'boolean',
    'json'
);

CREATE TYPE knowledge.property_identity AS ENUM (
    'unique',
    'fuzzy',
    'none'
);

CREATE TYPE knowledge.evaluation_strategy AS ENUM (
    'latest',
    'llm'
);

CREATE TYPE knowledge.property_cardinality AS ENUM (
    'single',
    'multi'
);

-- Where a property's value came from. The first four are SOURCES — a caller
-- asserting a value, and the currency `writable_by` gates on.
--
-- `arbitration` is not a source: it is the ruling an `evaluation_strategy: llm`
-- property's asynchronous arbitration wrote after reading the sources (D42). It
-- exists as its own value for two structural reasons — the arbiter must be able
-- to exclude its own past rulings from the candidate set it reads (otherwise a
-- verdict becomes evidence for the next verdict), and the gate must let a ruling
-- through on a property whose `writable_by` names only the sources it arbitrates.
CREATE TYPE knowledge.evidence_type AS ENUM (
    'extraction',
    'user_edit',
    'retrieval',
    'input_mapping',
    'arbitration'
);

CREATE TABLE knowledge.node_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    category knowledge.node_type_category NOT NULL,
    icon_svg text,
    icon_metaphor text,
    display_name_template text,
    display_name_expression jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    uniqueness_constraints jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.node_type
    ADD CONSTRAINT node_type_pkey PRIMARY KEY (id);


CREATE INDEX node_type_team_id_idx ON knowledge.node_type USING btree (team_id);
CREATE INDEX node_type_category_idx ON knowledge.node_type USING btree (team_id, category);

CREATE TRIGGER node_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Edge Types
-- How node types connect: has_name, mentions_company, has_funding_round, etc.

CREATE TABLE knowledge.edge_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    outbound_name text NOT NULL,
    inbound_name text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    source_node_type_id uuid NOT NULL,
    target_node_type_id uuid NOT NULL,
    required boolean NOT NULL DEFAULT false,
    scopes boolean NOT NULL DEFAULT false,
    -- Generic property-based filters: [{side, property, value}]
    filters jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- Display grouping: edges sharing the same edge_group are the same semantic relationship
    edge_group text DEFAULT NULL,
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_source_node_type_id_fkey FOREIGN KEY (source_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.edge_type
    ADD CONSTRAINT edge_type_target_node_type_id_fkey FOREIGN KEY (target_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX edge_type_team_id_idx ON knowledge.edge_type USING btree (team_id);
CREATE INDEX edge_type_source_node_type_id_idx ON knowledge.edge_type USING btree (source_node_type_id);
CREATE INDEX edge_type_target_node_type_id_idx ON knowledge.edge_type USING btree (target_node_type_id);

CREATE TRIGGER edge_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.edge_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Property Types
-- Define what properties a node type or edge type can have (name, website, role, etc.)

CREATE TABLE knowledge.property_type (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid,
    edge_type_id uuid,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    value_type knowledge.property_value_type NOT NULL,
    identity knowledge.property_identity NOT NULL,
    evaluation_strategy knowledge.evaluation_strategy NOT NULL,
    cardinality knowledge.property_cardinality NOT NULL DEFAULT 'single',
    enum_values text[],
    writable_by knowledge.evidence_type[],
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.property_type
    ADD CONSTRAINT property_type_owner_check CHECK (
        (node_type_id IS NOT NULL AND edge_type_id IS NULL) OR
        (node_type_id IS NULL AND edge_type_id IS NOT NULL)
    );

CREATE INDEX property_type_team_id_idx ON knowledge.property_type USING btree (team_id);
CREATE INDEX property_type_node_type_id_idx ON knowledge.property_type USING btree (node_type_id);
CREATE INDEX property_type_edge_type_id_idx ON knowledge.property_type USING btree (edge_type_id);

CREATE TRIGGER property_type_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.property_type FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Plugins
-- Registered extraction plugins (bundled or external) that can be called as hooks
-- on extraction graph nodes at content or entity stage.

CREATE TABLE knowledge.plugin (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    name text NOT NULL,
    description text,
    type text NOT NULL DEFAULT 'bundled',
    endpoint text,
    method text NOT NULL DEFAULT 'POST',
    auth jsonb,
    headers jsonb,
    stages text[] NOT NULL DEFAULT '{content,entity}'::text[],
    config_schema jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.plugin
    ADD CONSTRAINT plugin_pkey PRIMARY KEY (id);


CREATE TRIGGER plugin_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.plugin FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Extraction Graphs
-- Curated subsets of the ontology defining what to extract for a given input type.

CREATE TABLE knowledge.extraction_graph (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    root_node_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.extraction_graph
    ADD CONSTRAINT extraction_graph_pkey PRIMARY KEY (id);


CREATE INDEX extraction_graph_team_id_idx ON knowledge.extraction_graph USING btree (team_id);

CREATE TRIGGER extraction_graph_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph FOR EACH ROW EXECUTE FUNCTION knowledge.audit();

-- ── extraction_graph_node ──

CREATE TABLE knowledge.extraction_graph_node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    extraction_graph_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    property_overrides jsonb,
    edge_property_overrides jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    instructions text,
    expand boolean DEFAULT false NOT NULL,
    gather boolean DEFAULT false NOT NULL,
    filters jsonb NOT NULL DEFAULT '[]'::jsonb,
    content_plugins jsonb,
    entity_plugins jsonb,
    default_property_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_extraction_graph_id_fkey FOREIGN KEY (extraction_graph_id) REFERENCES knowledge.extraction_graph(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.extraction_graph_node
    ADD CONSTRAINT extraction_graph_node_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;


CREATE INDEX extraction_graph_node_extraction_graph_id_idx ON knowledge.extraction_graph_node USING btree (extraction_graph_id);
CREATE INDEX extraction_graph_node_team_id_idx ON knowledge.extraction_graph_node USING btree (team_id);

CREATE TRIGGER extraction_graph_node_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph_node FOR EACH ROW EXECUTE FUNCTION knowledge.audit();

-- Deferred FK: extraction_graph → extraction_graph_node (circular dependency)
ALTER TABLE ONLY knowledge.extraction_graph
    ADD CONSTRAINT extraction_graph_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;


-- ## Extraction Graph Edges
-- Which edges to follow during extraction. Each row connects a source extraction
-- node to a target extraction node via an edge type.

CREATE TABLE knowledge.extraction_graph_edge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    extraction_graph_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    edge_type_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_extraction_graph_id_fkey FOREIGN KEY (extraction_graph_id) REFERENCES knowledge.extraction_graph(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES knowledge.extraction_graph_node(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- No duplicate edges within a graph
ALTER TABLE ONLY knowledge.extraction_graph_edge
    ADD CONSTRAINT extraction_graph_edge_unique UNIQUE (extraction_graph_id, source_node_id, edge_type_id, target_node_id);

CREATE INDEX extraction_graph_edge_extraction_graph_id_idx ON knowledge.extraction_graph_edge USING btree (extraction_graph_id);
CREATE INDEX extraction_graph_edge_team_id_idx ON knowledge.extraction_graph_edge USING btree (team_id);

CREATE TRIGGER extraction_graph_edge_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_graph_edge FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- =============================================================================
-- SUBSTRATE — the data layer (what was extracted)
-- =============================================================================

-- ## Nodes
-- Every entity and message is a node (identity anchor).

CREATE TABLE knowledge.node (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    -- Temporal bounds (default to ±infinity)
    start_date timestamp(3) without time zone DEFAULT '-infinity'::timestamp NOT NULL,
    end_date timestamp(3) without time zone DEFAULT 'infinity'::timestamp NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Summarization & search
    summary text,
    summary_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(summary, ''))) STORED
    -- `summary_embedding vector(3072)` was dropped (K-12): written on every KG
    -- write, read by nobody. Its only cost was an embedding call per write.
);

ALTER TABLE ONLY knowledge.node
    ADD CONSTRAINT node_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.node
    ADD CONSTRAINT node_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX node_team_id_idx ON knowledge.node USING btree (team_id);
CREATE INDEX node_node_type_id_idx ON knowledge.node USING btree (node_type_id);
CREATE INDEX node_team_type_idx ON knowledge.node USING btree (team_id, node_type_id);
CREATE INDEX node_summary_tsvector_idx ON knowledge.node USING gin (summary_tsvector);

CREATE TRIGGER node_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Edges
-- Relationships between nodes.

CREATE TABLE knowledge.edge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    edge_type_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_source_node_id_fkey FOREIGN KEY (source_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_target_node_id_fkey FOREIGN KEY (target_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.edge
    ADD CONSTRAINT edge_edge_type_id_fkey FOREIGN KEY (edge_type_id) REFERENCES knowledge.edge_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;


CREATE INDEX edge_source_node_id_idx ON knowledge.edge USING btree (source_node_id);
CREATE INDEX edge_target_node_id_idx ON knowledge.edge USING btree (target_node_id);
CREATE INDEX edge_edge_type_id_idx ON knowledge.edge USING btree (edge_type_id);
CREATE INDEX edge_team_id_idx ON knowledge.edge USING btree (team_id);

CREATE TRIGGER edge_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.edge FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Properties
-- Values attached to nodes (name, website, role, etc.)

CREATE TABLE knowledge.property (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid,
    edge_id uuid,
    property_type_id uuid NOT NULL,
    value_text text,
    value_text_array text[],
    value_number numeric,
    value_date timestamp(3) without time zone,
    value_boolean boolean,
    value_json jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    value_text_search tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(value_text, ''))) STORED
    -- `value_text_embedding vector(3072)` was dropped (K-12) — same story as
    -- `node.summary_embedding`: written every write, never read.
);

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_property_type_id_fkey FOREIGN KEY (property_type_id) REFERENCES knowledge.property_type(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY knowledge.property
    ADD CONSTRAINT property_owner_check CHECK (
        (node_id IS NOT NULL AND edge_id IS NULL) OR
        (node_id IS NULL AND edge_id IS NOT NULL)
    );

CREATE INDEX property_team_id_idx ON knowledge.property USING btree (team_id);
CREATE INDEX property_node_id_idx ON knowledge.property USING btree (node_id);
CREATE INDEX property_edge_id_idx ON knowledge.property USING btree (edge_id);
CREATE INDEX property_property_type_id_idx ON knowledge.property USING btree (property_type_id);
CREATE INDEX property_node_type_idx ON knowledge.property USING btree (node_id, property_type_id);
CREATE INDEX property_value_text_search_idx ON knowledge.property USING gin (value_text_search);
CREATE INDEX property_value_text_trgm_idx ON knowledge.property USING gin (lower(value_text) public.gin_trgm_ops);
CREATE INDEX property_value_text_array_idx ON knowledge.property USING gin (value_text_array);

CREATE TRIGGER property_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.property FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Property helper functions
-- Shorthand for the agent query planner — replaces verbose scalar subselects.
-- Each returns a single value for a (node_id, property_name) pair.

CREATE FUNCTION knowledge.prop(node_id uuid, prop_name text)
RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_text
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$$;

CREATE FUNCTION knowledge.prop_num(node_id uuid, prop_name text)
RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_number
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$$;

CREATE FUNCTION knowledge.prop_bool(node_id uuid, prop_name text)
RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_boolean
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$$;

CREATE FUNCTION knowledge.prop_date(node_id uuid, prop_name text)
RETURNS timestamp(3) without time zone
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_date
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.node_id = $1 AND pt.name = $2
    LIMIT 1
$$;

CREATE FUNCTION knowledge.edge_prop(edge_id uuid, prop_name text)
RETURNS text
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_text
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.edge_id = $1 AND pt.name = $2
    LIMIT 1
$$;

CREATE FUNCTION knowledge.edge_prop_num(edge_id uuid, prop_name text)
RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT p.value_number
    FROM knowledge.property p
    JOIN knowledge.property_type pt ON pt.id = p.property_type_id
    WHERE p.edge_id = $1 AND pt.name = $2
    LIMIT 1
$$;


-- ## Linked Objects
-- External records linked to knowledge nodes. Unified model covering retrieval,
-- output, and manual sources (see plans/2026-02-25-linked-objects).

CREATE TYPE knowledge."LinkedObjectSource" AS ENUM ('retrieval', 'output', 'manual', 'input');

CREATE TABLE knowledge.linked_object (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid NOT NULL,
    source knowledge."LinkedObjectSource" NOT NULL DEFAULT 'retrieval',
    adapter_type text NOT NULL DEFAULT '',
    external_id text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'::jsonb,
    retrieval_source_id uuid,
    output_id uuid,
    action_node_id text,
    external_object_type text,
    fetched_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.linked_object
    ADD CONSTRAINT linked_object_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.linked_object
    ADD CONSTRAINT linked_object_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- `retrieval_source_id` / `output_id` are plain uuids into the `public.pipeline_*`
-- family (D3); both COLUMNS are owed a drop once the v3 output tree that writes
-- them dies (doc 6 §1). The `(node_id, adapter_type, external_id)` unique index
-- below is the bridge contract and stays.


CREATE UNIQUE INDEX linked_object_node_adapter_external_idx ON knowledge.linked_object USING btree (node_id, adapter_type, external_id);
CREATE INDEX linked_object_node_id_idx ON knowledge.linked_object USING btree (node_id);
CREATE INDEX linked_object_retrieval_source_id_idx ON knowledge.linked_object USING btree (retrieval_source_id);
CREATE INDEX linked_object_team_id_idx ON knowledge.linked_object USING btree (team_id);

CREATE TRIGGER linked_object_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.linked_object FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Evidence
-- Every property value and edge is backed by evidence from resources or external systems.

CREATE TABLE knowledge.evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    -- Target: exactly one of (property_id, edge_id) must be set
    property_id uuid,
    edge_id uuid,
    -- Source: an OPAQUE reference to whatever the caller drew the value from
    -- (K-7). The store must be able to describe a source without knowing what
    -- sources are, so this is `{kind, id, uri?, label?}` with a caller-defined
    -- `kind` ('resource' | 'file' | 'message' | 'url' | 'import' | …) rather
    -- than an FK. Rows written before the carve carry `{kind:'resource', id}`,
    -- which is how that history stays readable no matter where the `resource`
    -- table lives — it now lives in this schema, and the reference is still
    -- opaque on purpose.
    source_ref jsonb,
    linked_object_id uuid,
    linked_object_field text,
    type knowledge.evidence_type NOT NULL,
    description text NOT NULL,
    excerpt text,
    -- Structured provenance metadata; see plans/2026-05-04-translation-graphs/3f_mutation_context.md
    -- NULL on rows written before the translation-graphs migration.
    mutation_context jsonb,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_linked_object_id_fkey FOREIGN KEY (linked_object_id) REFERENCES knowledge.linked_object(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Exactly one of (property_id, edge_id) must be set
ALTER TABLE ONLY knowledge.evidence
    ADD CONSTRAINT evidence_target_check CHECK (
        (property_id IS NOT NULL AND edge_id IS NULL) OR
        (property_id IS NULL AND edge_id IS NOT NULL)
    );


CREATE INDEX evidence_property_id_idx ON knowledge.evidence USING btree (property_id);
CREATE INDEX evidence_edge_id_idx ON knowledge.evidence USING btree (edge_id);
CREATE INDEX evidence_source_ref_id_idx ON knowledge.evidence USING btree (((source_ref ->> 'id')));
CREATE INDEX evidence_team_id_idx ON knowledge.evidence USING btree (team_id);
CREATE INDEX evidence_mutation_context_adapter_idx ON knowledge.evidence USING btree ((mutation_context->'source'->>'adapterType'));
CREATE INDEX evidence_mutation_context_translation_graph_idx ON knowledge.evidence USING btree ((mutation_context->'source'->>'translationGraphId'));
CREATE INDEX evidence_mutation_context_linked_object_idx ON knowledge.evidence USING btree ((mutation_context->'source'->>'linkedObjectId'));

CREATE TRIGGER evidence_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.evidence FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Source material — the text a node was extracted FROM
-- `raw_text`, `raw_text_part`, `document` and `resource` moved here from
-- `public` (D48 ratification (i)). They read as dealflow residue and were on
-- the teardown's drop list until the 5.3 re-grep found the opposite: `resource`
-- is WRITTEN by the KG adapter on every movement write carrying a source and
-- read by the MCP node-detail tool, two apps/web procedures, the public REST
-- knowledge API and the `#resources` traversal; `raw_text` takes an insert on
-- every file-text resolution; `document` backs a live download. The dealflow
-- join tables that pointed at them stayed in `public` with their FKs dropped
-- (D3) — see the note where these tables used to sit.

CREATE TABLE knowledge.raw_text (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content text NOT NULL,
    checksum text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid NOT NULL,
    embedding public.vector(3072),
    is_chunked boolean DEFAULT false NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
);


ALTER TABLE ONLY knowledge.raw_text
    ADD CONSTRAINT raw_text_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX raw_text_team_id_checksum_key ON knowledge.raw_text USING btree (team_id, checksum);
CREATE INDEX raw_text_search_vector_idx ON knowledge.raw_text USING gin (search_vector);

-- No audit trigger, and that is deliberate rather than owed: a raw_text row is
-- immutable captured source text (content + checksum, deduped per team), so
-- there is no user edit for a trail to undo, and its `content` is large enough
-- that auditing it would double the store. Excluded by name in
-- `scripts/check_database_triggers.sh`, as it was in `public`.


-- ## Raw Text Part

CREATE TYPE knowledge."RawTextPartType" AS ENUM (
    'LINE_NUMBER',
    'EMBEDDING_CHUNK'
);

CREATE TABLE knowledge.raw_text_part (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- missing FK
    raw_text_id uuid NOT NULL, -- @DEF: raw_text_part_raw_text_id_fkey
    type knowledge."RawTextPartType" NOT NULL,
    start integer NOT NULL,
    "end" integer NOT NULL,
    compressed_content text,
    content text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    classifications text[] DEFAULT ARRAY[]::text[],
    embedding public.vector(3072),
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
);


ALTER TABLE ONLY knowledge.raw_text_part
    ADD CONSTRAINT raw_text_part_pkey PRIMARY KEY (id);

-- @DEF: raw_text_part_raw_text_id_fkey
ALTER TABLE ONLY knowledge.raw_text_part
    ADD CONSTRAINT raw_text_part_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE TRIGGER raw_text_part_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.raw_text_part FOR EACH ROW EXECUTE FUNCTION knowledge.audit();

CREATE INDEX raw_text_part_search_vector_idx ON knowledge.raw_text_part USING gin (search_vector);


-- ## Document

CREATE TABLE knowledge.document (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    description text NOT NULL,
    object_uri text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid,
    checksum text,
    raw_text_id uuid -- @DEF: document_raw_text_id_fkey
);

ALTER TABLE ONLY knowledge.document
    ADD CONSTRAINT document_pkey PRIMARY KEY (id);

-- @DEF: document_raw_text_id_fkey
ALTER TABLE ONLY knowledge.document
    ADD CONSTRAINT document_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX document_checksum_idx ON knowledge.document USING btree (checksum);

CREATE TRIGGER document_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.document FOR EACH ROW EXECUTE FUNCTION knowledge.audit();

-- `document` carries no RLS and no `agent` GRANT, exactly as it did in
-- `public`: the agent reads source TEXT (`raw_text`, `raw_text_part`) and
-- resource metadata, never the object-store pointer. Left as found rather than
-- tightened or loosened in passing.


-- ## Resource

CREATE TYPE knowledge."ResourceType" AS ENUM (
    'URL',
    'EMAIL',
    'WHATSAPP',
    'FILE',
    'TEXT'
);

CREATE TABLE knowledge.resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    type knowledge."ResourceType" NOT NULL,
    url text,
    document_id uuid, -- @DEF: resource_document_id_fkey
    raw_text_id uuid, -- @DEF: resource_raw_text_id_fkey
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    "retrievedAt" timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    name text NOT NULL,
    created_by uuid,
    inbound_payload_id uuid, -- FK dropped: `inbound_payload` sits in `public` (D3)
    external_id text,
    external_adapter_type text
);


ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_pkey PRIMARY KEY (id);

-- @DEF: resource_document_id_fkey
ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_document_id_fkey FOREIGN KEY (document_id) REFERENCES knowledge.document(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: resource_raw_text_id_fkey
ALTER TABLE ONLY knowledge.resource
    ADD CONSTRAINT resource_raw_text_id_fkey FOREIGN KEY (raw_text_id) REFERENCES knowledge.raw_text(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX resource_document_id_idx ON knowledge.resource USING btree (document_id);
CREATE UNIQUE INDEX resource_inbound_payload_id_key ON knowledge.resource USING btree (inbound_payload_id);
CREATE INDEX resource_raw_text_id_idx ON knowledge.resource USING btree (raw_text_id);
CREATE INDEX resource_team_id_idx ON knowledge.resource USING btree (team_id);
-- Idempotent re-delivery lookup: writeKgResource finds an existing row via
-- (team, adapter, externalId) before generating a new UUID. Mirrors the
-- W3-B1 linked_object (team_id, adapter_type, external_id) pattern.
CREATE UNIQUE INDEX resource_team_adapter_external_id_key
    ON knowledge.resource USING btree (team_id, external_adapter_type, external_id)
    WHERE external_id IS NOT NULL;

CREATE TRIGGER resource_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.resource FOR EACH ROW EXECUTE FUNCTION knowledge.audit();



-- ## Node Resource
-- Links nodes to their source context for provenance and backfill.

CREATE TABLE knowledge.node_resource (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_id uuid NOT NULL,
    resource_id uuid NOT NULL,
    start_offset integer,
    end_offset integer,
    excerpt text,                          -- the source text this link points at, COPIED at link time (D43a). See the note below.
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_pkey PRIMARY KEY (id);

ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- @DEF: node_resource_resource_id_fkey
ALTER TABLE ONLY knowledge.node_resource
    ADD CONSTRAINT node_resource_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES knowledge.resource(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- The FK above is RESTORED, not new. It was dropped when knowledge isolated
-- (D3 forbids the crossing) because `resource` still lived in `public`; the
-- move brings both sides into one schema, so the constraint — and the CASCADE
-- that means "a resource's links die with the resource" — comes back with its
-- original semantics.
--
-- `excerpt` is the reason `node.summary` can be composed from knowledge's own
-- tables (D43a). The summariser used to reach BACKWARDS across the carve line
-- into `resource` → `raw_text` to quote the source material a node was
-- extracted from — a cross-schema read at the time, and the coupling D43(a)
-- removed. Those tables are now knowledge's own, which does NOT reinstate the
-- old read: the excerpt stays copied at link time, because the reason was
-- provenance semantics, not schema geography.
-- The trade is stated rather than discovered: an excerpt is a SNAPSHOT. Editing
-- the underlying `raw_text` no longer changes what a node's summary quotes;
-- re-linking is what refreshes it. That is the right way round for provenance —
-- "what this node was extracted from" should not be rewritten by a later edit
-- to the source.


CREATE UNIQUE INDEX node_resource_node_resource_unique ON knowledge.node_resource USING btree (node_id, resource_id);
CREATE INDEX node_resource_node_id_idx ON knowledge.node_resource USING btree (node_id);
CREATE INDEX node_resource_resource_id_idx ON knowledge.node_resource USING btree (resource_id);
CREATE INDEX node_resource_team_id_idx ON knowledge.node_resource USING btree (team_id);

CREATE TRIGGER node_resource_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.node_resource FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Extraction Facts
-- Schema-agnostic (subject, predicate, object) tuples extracted from source text.
-- Cheap insurance: captures everything the document says regardless of ontology,
-- enabling fast backfill when the ontology changes without full re-extraction.

CREATE TABLE knowledge.extraction_fact (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    message_node_id uuid NOT NULL,
    resource_id uuid,
    subject text NOT NULL,
    predicate text NOT NULL,
    object text NOT NULL,
    embedding public.vector(256),
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_message_node_id_fkey FOREIGN KEY (message_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- @DEF: extraction_fact_resource_id_fkey
ALTER TABLE ONLY knowledge.extraction_fact
    ADD CONSTRAINT extraction_fact_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES knowledge.resource(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Restored with the source-material move, same as node_resource's: dropped
-- only because `resource` was across the schema line, back now that it is not.
-- `extraction_fact.embedding` remains the schema's last `vector` column and
-- the table is live (the knowledge agent's fact search), so pgvector stays on
-- this unit's restore prerequisite list — the two `raw_text*` embedding columns
-- the move brings in are pgvector too, so the list is unchanged either way.

CREATE INDEX extraction_fact_team_id_idx ON knowledge.extraction_fact USING btree (team_id);
CREATE INDEX extraction_fact_message_node_id_idx ON knowledge.extraction_fact USING btree (message_node_id);
CREATE INDEX extraction_fact_resource_id_idx ON knowledge.extraction_fact USING btree (resource_id);
CREATE INDEX extraction_fact_subject_idx ON knowledge.extraction_fact USING gin (to_tsvector('english', subject));
CREATE INDEX extraction_fact_predicate_idx ON knowledge.extraction_fact USING gin (to_tsvector('english', predicate));
CREATE INDEX extraction_fact_object_idx ON knowledge.extraction_fact USING gin (to_tsvector('english', object));

CREATE TRIGGER extraction_fact_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.extraction_fact FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- `linked_object_field` and `evidence_source_mapping` were DROPPED here (D9).
-- They described what a dealflow retrieval source returns and which property
-- type each of its fields evidenced; both were tenanted only through
-- `public.pipeline_configuration`, so their row-level security reached across
-- the schema boundary — the one class of cross-schema dependency an FK grep
-- does not find. Neither table had a single application reference left.


-- ## Output Runs
-- Logs each execution of an output action node, independent of link-back.

CREATE TABLE knowledge.output_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    pipeline_output_id uuid NOT NULL,
    action_node_id text NOT NULL,
    context_node_id uuid,
    adapter_type text NOT NULL,
    external_id text,
    external_object_type text,
    status text NOT NULL DEFAULT 'success',
    error text,
    field_values jsonb,
    run_group_id uuid,
    created boolean,
    dealflow_pipeline_id uuid,
    root_node_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_pkey PRIMARY KEY (id);


-- `pipeline_output_id` is a plain uuid into `public.pipeline_output` (D3). The
-- table is owed a DROP (D9) with the rest of the v3 output tree.

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_context_node_id_fkey FOREIGN KEY (context_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.output_run
    ADD CONSTRAINT output_run_root_node_id_fkey FOREIGN KEY (root_node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX output_run_pipeline_output_id_idx ON knowledge.output_run USING btree (pipeline_output_id);
CREATE INDEX output_run_created_at_idx ON knowledge.output_run USING btree (created_at);
CREATE INDEX output_run_run_group_id_idx ON knowledge.output_run USING btree (run_group_id);

CREATE TRIGGER output_run_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.output_run FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Recipes
-- User-defined prompt recipes that teach the ask agent domain-specific patterns.

CREATE TABLE knowledge.recipe (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    instructions text NOT NULL,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.recipe
    ADD CONSTRAINT recipe_pkey PRIMARY KEY (id);



CREATE INDEX recipe_team_id_idx ON knowledge.recipe USING btree (team_id);

CREATE TRIGGER recipe_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.recipe FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- saved_filter — serialised table filter sets, referenced by UUID in query params
CREATE TABLE knowledge.saved_filter (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    node_type_id uuid NOT NULL,
    filters jsonb NOT NULL DEFAULT '[]'::jsonb,
    conjunction text NOT NULL DEFAULT 'and',
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.saved_filter
    ADD CONSTRAINT saved_filter_pkey PRIMARY KEY (id);


ALTER TABLE ONLY knowledge.saved_filter
    ADD CONSTRAINT saved_filter_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX saved_filter_team_id_idx ON knowledge.saved_filter USING btree (team_id);
CREATE INDEX saved_filter_node_type_id_idx ON knowledge.saved_filter USING btree (node_type_id);

CREATE TRIGGER saved_filter_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.saved_filter FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- team_agent_settings — how a team wants its agents to talk. `style_preferences`
-- came off `core.team` (Phase 4.4): the agents that read it are the store's own
-- (and automations' prompts reach it through the knowledge-store dependency,
-- D4), so it belongs with them rather than with identity. Absence of a row —
-- like an empty string — means no preferences.
CREATE TABLE knowledge.team_agent_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    style_preferences text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY knowledge.team_agent_settings
    ADD CONSTRAINT team_agent_settings_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX team_agent_settings_team_id_key ON knowledge.team_agent_settings USING btree (team_id);

CREATE TRIGGER team_agent_settings_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.team_agent_settings FOR EACH ROW EXECUTE FUNCTION knowledge.audit();


-- ## Changes
-- First-class record of every mutation to the knowledge graph.
-- Evidence triggers changes; the change captures old/new values and the actor.

CREATE TYPE knowledge.change_source AS ENUM (
    'pipeline',
    'user_edit',
    'agent',
    'api',
    'mcp'
);

-- `edge_retargeted` is its own kind because an edge that moves one end keeps
-- its id, its properties and its evidence: recording it as a remove plus a
-- create would misdescribe what happened and orphan that history (D38a).
CREATE TYPE knowledge.change_kind AS ENUM (
    'property_set',
    'property_cleared',
    'edge_created',
    'edge_removed',
    'edge_retargeted',
    'node_created',
    'node_removed'
);

CREATE TABLE knowledge.change (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    request_id uuid NOT NULL,
    source knowledge.change_source NOT NULL,
    kind knowledge.change_kind NOT NULL,
    node_id uuid,
    property_id uuid,
    edge_id uuid,
    evidence_id uuid,
    old_value jsonb,
    new_value jsonb,
    created_by uuid,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_pkey PRIMARY KEY (id);



ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_node_id_fkey FOREIGN KEY (node_id) REFERENCES knowledge.node(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_edge_id_fkey FOREIGN KEY (edge_id) REFERENCES knowledge.edge(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY knowledge.change
    ADD CONSTRAINT change_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES knowledge.evidence(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX change_node_id_created_at_idx ON knowledge.change USING btree (node_id, created_at DESC);
CREATE INDEX change_edge_id_created_at_idx ON knowledge.change USING btree (edge_id, created_at DESC);
CREATE INDEX change_request_id_idx ON knowledge.change USING btree (request_id);
CREATE INDEX change_team_id_created_at_idx ON knowledge.change USING btree (team_id, created_at DESC);


-- ## Mutation events — the outbox, its destinations, and the drainer's pulse
-- The only way a graph mutation leaves this unit (D5 as amended by D25, K-29).
-- The write door enqueues one row per event INSIDE the write transaction, so an
-- event exists exactly when the write it describes committed; a drainer signs
-- each payload and POSTs it to every registered destination. There is no
-- in-process variant to fall back to — one path means one set of delivery and
-- ordering semantics to reason about, in every deployment.

CREATE TABLE knowledge.mutation_outbox (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    -- Deliberately no FK to `node`: the row describing a deletion must outlive
    -- the node it describes.
    node_id uuid,
    payload jsonb NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delivered_at timestamptz,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz,
    last_error text
);

ALTER TABLE ONLY knowledge.mutation_outbox
    ADD CONSTRAINT mutation_outbox_pkey PRIMARY KEY (id);

CREATE INDEX mutation_outbox_undelivered_idx ON knowledge.mutation_outbox USING btree (created_at) WHERE delivered_at IS NULL;
CREATE INDEX mutation_outbox_team_id_created_at_idx ON knowledge.mutation_outbox USING btree (team_id, created_at DESC);

-- A destination for mutation events. Idempotent by URL (K-28) — the consumer's
-- reconciler re-registers whenever a listen's event selection changes — and the
-- secret is issued here, at registration, so the signature is knowledge's to
-- verify against.
CREATE TABLE knowledge.webhook_endpoint (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    url text NOT NULL,
    event_types text[] DEFAULT '{}'::text[] NOT NULL,
    secret text NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY knowledge.webhook_endpoint
    ADD CONSTRAINT webhook_endpoint_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX webhook_endpoint_team_id_url_idx ON knowledge.webhook_endpoint USING btree (team_id, url);

CREATE TRIGGER webhook_endpoint_audit AFTER INSERT OR DELETE OR UPDATE ON knowledge.webhook_endpoint FOR EACH ROW EXECUTE FUNCTION knowledge.audit();

-- The drainer is now the sole delivery path for graph-triggered automations, so
-- a stopped drainer is a silent outage: nothing errors, listeners simply never
-- fire. A liveness row makes "when did this worker last run" answerable from
-- outside the process (D30e).
CREATE TABLE knowledge.worker_heartbeat (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamptz,
    last_error text,
    detail jsonb
);

ALTER TABLE ONLY knowledge.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX worker_heartbeat_worker_idx ON knowledge.worker_heartbeat USING btree (worker);


-- ## Property arbitration — the queue a contested property lands in
-- An `evaluation_strategy: llm` property is decided by reading its evidence, and
-- reading it costs a model call. That call used to happen INSIDE the write's
-- transaction, which meant the store held a connection (and, since the upsert
-- lock, a lock) open across a network round trip to a vendor, and meant the
-- behaviour could not survive the write moving behind HTTP — one request is one
-- transaction cannot express "call back into the caller mid-transaction".
--
-- So the write commits the incoming value with its candidates recorded as
-- evidence, and lands a row here; a knowledge-side worker rules afterwards and
-- writes the winner as a second, evidenced, change-logged write. History gains
-- an honest second event rather than a value that changed with no record of who
-- changed it (D37f).
--
-- Pending rows COALESCE by property (the partial unique index): arbitration
-- re-derives from the whole evidence history, so N writes landing before the
-- worker gets there is one question, not N.

CREATE TABLE knowledge.property_arbitration (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    property_id uuid NOT NULL,
    enqueued_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    resolved_at timestamptz,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz,
    last_error text
);

ALTER TABLE ONLY knowledge.property_arbitration
    ADD CONSTRAINT property_arbitration_pkey PRIMARY KEY (id);

-- The property is gone, so the question about it is moot.
ALTER TABLE ONLY knowledge.property_arbitration
    ADD CONSTRAINT property_arbitration_property_id_fkey FOREIGN KEY (property_id) REFERENCES knowledge.property(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE UNIQUE INDEX property_arbitration_pending_idx ON knowledge.property_arbitration USING btree (property_id) WHERE resolved_at IS NULL;
CREATE INDEX property_arbitration_queue_idx ON knowledge.property_arbitration USING btree (enqueued_at) WHERE resolved_at IS NULL;


-- ## Triggers + movements — MOVED OUT to the `automations` schema
-- The five tables that used to live here (`trigger`, `movement`,
-- `movement_version`, `movement_issue`, `movement_story_token`) are the
-- automations product, not the knowledge store: they were only ever in this
-- schema because it was the newest place to put a table. They now live in
-- `-- # AUTOMATIONS SCHEMA` at the end of this file. Nothing in `knowledge`
-- references them any more — that is the point.


-- =============================================================================
-- KNOWLEDGE — Row-Level Security
-- =============================================================================

GRANT USAGE ON SCHEMA knowledge TO agent;

-- node_type
GRANT SELECT ON knowledge.node_type TO agent;
ALTER TABLE knowledge.node_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.node_type FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.node_type FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- property_type
GRANT SELECT ON knowledge.property_type TO agent;
ALTER TABLE knowledge.property_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.property_type FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.property_type FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- edge_type
GRANT SELECT ON knowledge.edge_type TO agent;
ALTER TABLE knowledge.edge_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.edge_type FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.edge_type FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- extraction_graph
GRANT SELECT ON knowledge.extraction_graph TO agent;
ALTER TABLE knowledge.extraction_graph ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.extraction_graph FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.extraction_graph FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- extraction_graph_node
GRANT SELECT ON knowledge.extraction_graph_node TO agent;
ALTER TABLE knowledge.extraction_graph_node ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.extraction_graph_node FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.extraction_graph_node FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- extraction_graph_edge
GRANT SELECT ON knowledge.extraction_graph_edge TO agent;
ALTER TABLE knowledge.extraction_graph_edge ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.extraction_graph_edge FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.extraction_graph_edge FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- node
GRANT SELECT ON knowledge.node TO agent;
ALTER TABLE knowledge.node ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.node FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.node FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- property
GRANT SELECT ON knowledge.property TO agent;
ALTER TABLE knowledge.property ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.property FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.property FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- edge
GRANT SELECT ON knowledge.edge TO agent;
ALTER TABLE knowledge.edge ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.edge FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.edge FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- evidence
GRANT SELECT ON knowledge.evidence TO agent;
ALTER TABLE knowledge.evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.evidence FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.evidence FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- node_resource
GRANT SELECT ON knowledge.node_resource TO agent;
ALTER TABLE knowledge.node_resource ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.node_resource FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.node_resource FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- Source material. These three arrived with the D48(i) move and their policies
-- were re-pointed from `public.current_team_id()` to knowledge's own, so a
-- standalone graph tenants them with no `public` schema present — the same
-- treatment every other table here got in D37(h). `resource` and `raw_text`
-- keep their `team_id IS NULL` allowance verbatim: team-less rows are the
-- demo/seed fixtures, and narrowing that here would be an unrelated behaviour
-- change smuggled into a move. `document` has no policy, as it never did.

-- raw_text
GRANT SELECT ON knowledge.raw_text TO agent;
ALTER TABLE knowledge.raw_text ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.raw_text FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.raw_text FOR SELECT TO agent USING (team_id IS NULL OR team_id::text = knowledge.current_team_id());

-- raw_text_part
GRANT SELECT ON knowledge.raw_text_part TO agent;
ALTER TABLE knowledge.raw_text_part ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.raw_text_part FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.raw_text_part FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- resource
GRANT SELECT ON knowledge.resource TO agent;
ALTER TABLE knowledge.resource ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.resource FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.resource FOR SELECT TO agent USING (team_id IS NULL OR team_id::text = knowledge.current_team_id());

-- linked_object
GRANT SELECT ON knowledge.linked_object TO agent;
ALTER TABLE knowledge.linked_object ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.linked_object FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.linked_object FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- `linked_object_field` and `evidence_source_mapping` had the only two
-- join-based policies here, and both joins left the schema. They went with
-- their tables (D9) — see the note where the tables used to sit.

-- change
GRANT SELECT ON knowledge.change TO agent;
ALTER TABLE knowledge.change ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON knowledge.change FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON knowledge.change FOR SELECT TO agent USING (team_id::text = knowledge.current_team_id());

-- Property helper functions — grant to agent
GRANT EXECUTE ON FUNCTION knowledge.prop(uuid, text) TO agent;
GRANT EXECUTE ON FUNCTION knowledge.prop_num(uuid, text) TO agent;
GRANT EXECUTE ON FUNCTION knowledge.prop_bool(uuid, text) TO agent;
GRANT EXECUTE ON FUNCTION knowledge.prop_date(uuid, text) TO agent;
GRANT EXECUTE ON FUNCTION knowledge.edge_prop(uuid, text) TO agent;
GRANT EXECUTE ON FUNCTION knowledge.edge_prop_num(uuid, text) TO agent;

-- ### Usage Billing --------------------------------------------------------

CREATE TABLE public.team_usage_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    max_weekly_pipeline_runs integer NOT NULL,
    max_weekly_query_inputs integer NOT NULL,
    additional_pipeline_runs integer DEFAULT 0 NOT NULL,
    additional_query_inputs integer DEFAULT 0 NOT NULL,
    alert_threshold_pct integer DEFAULT 80 NOT NULL,
    week_starts_on integer DEFAULT 1 NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.team_usage_config
    ADD CONSTRAINT team_usage_config_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX team_usage_config_team_id_key ON public.team_usage_config USING btree (team_id);



CREATE TABLE public.usage_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    reference_id uuid,
    created_by uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.usage_event
    ADD CONSTRAINT usage_event_pkey PRIMARY KEY (id);



CREATE INDEX idx_usage_event_team_type_date ON public.usage_event USING btree (team_id, event_type, created_at);


CREATE TABLE public.usage_alert (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    alert_kind text NOT NULL,
    period_start timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.usage_alert
    ADD CONSTRAINT usage_alert_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX usage_alert_dedup ON public.usage_alert USING btree (team_id, event_type, alert_kind, period_start);


-- (The self-serve billing tables — `team_lifecycle`, `team_wallet`,
-- `auto_recharge_confirm_token`, `wallet_ledger`, `run_cost`,
-- `team_subscription` — were DROPPED with billing itself. There is no plan, no
-- seat and no balance on this branch, so there is nothing for them to hold.


-- (`waitlist` and `early_access_config` were DROPPED with the self-serve
-- signup they gated: sign-in is invited-only now, so there is no queue to hold
-- and no cap to enforce.)


-- integration_suggestion — demand signal from the public landing page. A
-- visitor names a tool they wish Listen-Fire supported; we persist it (and surface it
-- to ops). email is optional (anonymous suggestions allowed); note is optional.
CREATE TABLE public.integration_suggestion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email public.citext,
    tool_name text NOT NULL,
    note text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY public.integration_suggestion
    ADD CONSTRAINT integration_suggestion_pkey PRIMARY KEY (id);

CREATE INDEX integration_suggestion_created_at_idx ON public.integration_suggestion USING btree (created_at);


-- ### Ops Event ------------------------------------------------------

CREATE TABLE public.ops_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    type public."OpsEventType" NOT NULL,
    severity public."OpsSeverity" DEFAULT 'notable'::public."OpsSeverity" NOT NULL,
    team_id uuid,
    title text NOT NULL,
    detail jsonb,
    entity_refs jsonb,
    request_id text,
    parent_run_id uuid,
    status public."OpsRunStatus",
    updated_at timestamp(3) without time zone,
    -- Operator acknowledgement, deliberately separate from status/severity: a
    -- failed run stays failed once it has been dealt with.
    resolved_at timestamptz
);
ALTER TABLE ONLY public.ops_event ADD CONSTRAINT ops_event_pkey PRIMARY KEY (id);
CREATE INDEX ops_event_created_at_idx ON public.ops_event (created_at);
CREATE INDEX ops_event_parent_run_id_idx ON public.ops_event (parent_run_id);
CREATE INDEX ops_event_roots_created_at_idx ON public.ops_event (created_at) WHERE parent_run_id IS NULL;

-- ### User/Team Journey -------------------------------------------------------
-- Milestone timestamps for the Listen-Fire user journey (MCP connect → first call →
-- first automation saved → first run), read by the admin dashboard. Unaudited
-- by design, like ops_event: keyed on user_id/team_id with no `id` column, so
-- an audit trigger here would break every write (see
-- check_database_triggers.sh's audit-table id requirement).
CREATE TABLE public.user_journey (
    user_id                   uuid PRIMARY KEY,  -- opaque user id; NO foreign key (D3 — `user` lives in the `core` schema)
    mcp_connected_at          timestamp with time zone,
    first_mcp_call_at         timestamp with time zone,
    first_mcp_tool            text,
    first_automation_saved_at timestamp with time zone,
    created_at                timestamp with time zone DEFAULT now() NOT NULL,
    updated_at                timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.team_journey (
    team_id                   uuid PRIMARY KEY,  -- opaque tenant id; NO foreign key (D3 — `team` lives in the `core` schema)
    first_automation_saved_at timestamp with time zone,
    first_run_at              timestamp with time zone,
    created_at                timestamp with time zone DEFAULT now() NOT NULL,
    updated_at                timestamp with time zone DEFAULT now() NOT NULL
);

-- ### Push Subscription ------------------------------------------------------

CREATE TABLE public.push_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    admin_user_id uuid NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    device_label text
);
ALTER TABLE ONLY public.push_subscription ADD CONSTRAINT push_subscription_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX push_subscription_endpoint_idx ON public.push_subscription (endpoint);

-- (`exposed_file` moved to the AUTOMATIONS SCHEMA at the end of this file — it
-- is the adapter file-exposure handle, written only by the movement engine's
-- `exposeFile` and read by the public blob route.)

-- ### Dropped Inbound Email --------------------------------------------------
-- Store-then-drop quarantine for inbound emails the handler can't
-- route and won't feed to the retired knowledge pipeline (the sender's
-- team isn't legacy-enabled — see interfaces/rest/private.ts). The handler used
-- to return 200 and discard the payload, so a team that *should* have been
-- onboarded silently lost its mail with no way to recover it. We now persist the
-- raw Mailgun body here before dropping, so it can be replayed once the team is
-- onboarded (the replay re-POSTs `body` to /api/mailgun/callback, where the
-- content-derived sender auth re-resolves the same team and re-runs routing).
-- `replayed_at` stamps rows already re-fed so replay is idempotent. Append-only
-- runtime quarantine → no audit trigger (excluded in check_database_triggers.sh).
CREATE TABLE public.dropped_inbound_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid NOT NULL,
    request_id text NOT NULL,
    reason text NOT NULL,
    recipients text[] NOT NULL,
    body jsonb NOT NULL,
    replayed_at timestamp(3) without time zone
);
ALTER TABLE ONLY public.dropped_inbound_email ADD CONSTRAINT dropped_inbound_email_pkey PRIMARY KEY (id);
CREATE INDEX dropped_inbound_email_team_pending_idx ON public.dropped_inbound_email (team_id) WHERE replayed_at IS NULL;

-- (`inbound_email_route` and `outbound_email` moved to the AUTOMATIONS SCHEMA at
-- the end of this file — the inbound door's address→team routing and the ledger
-- of every send. `dropped_inbound_email` above stays: it is the legacy inbound
-- quarantine and dies with dealflow (M-6), not with this move.)


-- =============================================================================
-- CROSS-SCHEMA FKs — public tables referencing knowledge.node_type
-- =============================================================================
-- These FK constraints must come after the knowledge schema tables are created.


-- pipeline_input_message_type.node_type_id → knowledge.node_type
ALTER TABLE ONLY public.pipeline_input_message_type
    ADD CONSTRAINT pipeline_input_message_type_node_type_id_fkey FOREIGN KEY (node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- pipeline_output.trigger_node_type_id → knowledge.node_type
ALTER TABLE ONLY public.pipeline_output
    ADD CONSTRAINT pipeline_output_trigger_node_type_id_fkey FOREIGN KEY (trigger_node_type_id) REFERENCES knowledge.node_type(id) ON UPDATE CASCADE ON DELETE SET NULL;


-- (The `adapters` schema is GONE. Its two tables — `telegram_identity` and
-- `telegram_token` — folded into the AUTOMATIONS SCHEMA at the end of this file
-- (M-26): a schema whose whole job was to keep adapter-owned identity out of the
-- core data model stops earning its keep once the automations unit is itself an
-- isolated schema.)


-- #############################################################################
--
-- # ASKS SCHEMA
--
-- The asks unit: one durable record store for "a person was asked something,
-- here is what they answered", plus the capability-token link surface that
-- collects the answer. It owns nothing else and knows nothing else — its only
-- outward reference is `team_id` as an OPAQUE tenant id (no `team` table exists
-- in this schema, deliberately). That is what lets the whole unit leave in one
-- `pg_dump --schema=asks`.

CREATE SCHEMA IF NOT EXISTS asks;


-- ## Ask
-- The asks-as-adapter record store (asks-as-adapter chunk A). The ask adapter
-- writes here. One row per ask; F16 — every write CREATES, so there is
-- deliberately NO uniqueness surface (no UNIQUE(run,address) as the old table
-- carried). The state lattice is `open → answered` and `open → expired`, both
-- terminal, enforced by optimistic `WHERE state = 'open'` guards in the store.
-- The per-ask capability token (long-lived TTL, scoped to this one ask) backs
-- the link surface at /api/asks/<token>.

CREATE TABLE asks.ask (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,                 -- opaque tenant id; NO foreign key (the unit ships without a `team` table)
    family text NOT NULL,                  -- Check | Provide | Choose | Select | Review | Correct | Draft | Form (the position/family; the family fixes the answer's type)
    answer_type text,                      -- Provide only: text | number | date | boolean (the other families fix their own answer shape)
    prompt text NOT NULL,                  -- author-written question (immutable after write)
    detail text,                           -- author-written elaboration (immutable after write)
    options jsonb,                         -- Choose/Select: the offered options; Form: the named fields it collects (immutable) — a JSON array of strings
    rows jsonb,                            -- Correct only: the records offered for review (immutable) — a JSON array of { ephemeralId, fields }
    state text NOT NULL DEFAULT 'open',    -- open | answered | expired (the lattice)
    answer jsonb,                          -- the typed answer payload, once answered
    token text NOT NULL,                   -- per-ask capability token for the link surface (minted at write, `ask_`-prefixed)
    token_expires_at timestamptz NOT NULL, -- login-less window TTL (long-lived; scoped to this one ask)
    provenance jsonb NOT NULL DEFAULT '{}'::jsonb,  -- CALLER-OPAQUE passthrough: whatever jsonb the caller supplied, stored verbatim and echoed back, never parsed by the store. The movement engine puts movement/run/node ids here; a REST caller can put anything. INFO, never identity — so no FK and no index on it (A-3)
    callback_url text,                     -- where to notify when this ask settles, for callers with no in-process notifier (the standalone REST path). NULL for library-embedded callers, who are nudged in-process instead (A-4)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    answered_at timestamptz,               -- set on the open → answered transition
    expired_at timestamptz,                -- set on the open → expired (explicit cancel) transition
    CONSTRAINT ask_state_check CHECK (state IN ('open', 'answered', 'expired')),
    CONSTRAINT ask_family_check CHECK (family IN ('Check', 'Provide', 'Choose', 'Select', 'Review', 'Correct', 'Draft', 'Form')),
    CONSTRAINT ask_answer_type_check CHECK (answer_type IS NULL OR answer_type IN ('text', 'number', 'date', 'boolean'))
);

ALTER TABLE ONLY asks.ask
    ADD CONSTRAINT ask_pkey PRIMARY KEY (id);

ALTER TABLE ONLY asks.ask
    ADD CONSTRAINT ask_token_unique UNIQUE (token);

CREATE INDEX ask_team_id_idx ON asks.ask USING btree (team_id);
CREATE INDEX ask_state_idx ON asks.ask USING btree (state);


-- ## Ask webhook delivery
-- The standalone notification path's retry queue. When an ask carrying a
-- `callback_url` settles, one row lands here and a worker signs and POSTs it,
-- backing off across six attempts before giving up. It is a COURTESY nudge, not
-- the answer: the answer is already durable on `ask.state`/`ask.answer` and
-- readable over `GET /v1/asks/:id`, so a delivery that never succeeds loses a
-- notification and never loses an answer.
-- Composed deployments write nothing here — automations is notified in-process
-- instead, and exactly one of the two paths is active per deployment (A-4, D39c).

CREATE TABLE asks.ask_webhook_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ask_id uuid NOT NULL,                  -- @DEF: ask_webhook_delivery_ask_id_fkey
    url text NOT NULL,                     -- snapshotted from the ask at settle time, so re-pointing an ask cannot re-route a queued delivery
    attempt integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz,
    status text NOT NULL DEFAULT 'pending',-- pending | delivered | failed (terminal)
    last_error text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delivered_at timestamptz,
    CONSTRAINT ask_webhook_delivery_status_check CHECK (status IN ('pending', 'delivered', 'failed'))
);

ALTER TABLE ONLY asks.ask_webhook_delivery
    ADD CONSTRAINT ask_webhook_delivery_pkey PRIMARY KEY (id);

-- @DEF: ask_webhook_delivery_ask_id_fkey
-- In-schema FK only — the one kind D3 still allows, and the one that makes the
-- queue readable without joining anything outside the unit.
ALTER TABLE ONLY asks.ask_webhook_delivery
    ADD CONSTRAINT ask_webhook_delivery_ask_id_fkey FOREIGN KEY (ask_id) REFERENCES asks.ask(id) ON DELETE CASCADE;

CREATE INDEX ask_webhook_delivery_pending_idx ON asks.ask_webhook_delivery USING btree (created_at) WHERE (status = 'pending');
CREATE INDEX ask_webhook_delivery_ask_id_idx ON asks.ask_webhook_delivery USING btree (ask_id);


-- ## Worker heartbeat
-- Same reason knowledge has one: in the standalone deployment this worker is
-- the ONLY thing that carries a settled answer back to whoever asked, so a
-- stopped one is a silent outage rather than an error. A liveness row makes
-- "when did this last run" answerable from outside the process (D30e).

CREATE TABLE asks.worker_heartbeat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamptz,
    last_error text,
    detail jsonb
);

ALTER TABLE ONLY asks.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX asks_worker_heartbeat_worker_idx ON asks.worker_heartbeat USING btree (worker);


-- #############################################################################
--
-- # AUTOMATIONS SCHEMA
--
-- The automations unit, in four layers. The AUTHORED layer: the movement
-- programs, their immutable versions, the issues a failing run aggregates into,
-- the story links they are served on, and the `trigger` rows that are the
-- dispatch index for their `listen` statements. The ENGINE RUNTIME layer: the
-- `trigger_event` receipts a door stores before acking, the `trigger_run`
-- ledger of firings, and the park machinery a run suspends into
-- (`parked_run`, `join_pending`, `join_branch_export`, `adapter_await`,
-- `callback`) plus the engine's two side tables (`record_binding`,
-- `exposed_file`). The CREDENTIALS VAULT: the encrypted connections every
-- adapter runs on, their author-time connect links, Google's per-item grants,
-- remote-adapter installs, the webhook subscriptions a listen registers, and
-- the tokens that make the unit recognise its own writes. And CHANNEL IDENTITY:
-- whose phone, address and Telegram account route to which team. The first
-- layer sat in `knowledge`, the rest in `public` or in a separate `adapters`
-- schema, only because those were the newest places to put a table when they
-- were born — all four are the automations product, and the eviction is what
-- lets each unit leave in one `pg_dump --schema=X`.
--
-- Outward references (`team_id`, `created_by_user_id`, `pipeline_configuration_id`,
-- `ops_run_id`) are OPAQUE uuids with no foreign key, exactly like the `asks`
-- schema above; the in-schema FKs — every park table to its run, the run to the
-- version it pinned, every satellite to the credential it belongs to — are kept
-- and are the reason the eviction is worth doing.
--
-- The schema now reaches outside itself in exactly one way, and it is not a
-- coupling: the `citext` extension `inbound_email_route.address` is typed on.
-- No foreign key leaves the schema, no trigger calls a function outside it, and
-- no policy reads another unit's session setting —
-- `pg_dump --schema=automations` restores with citext and nothing else. D43(b).

CREATE SCHEMA IF NOT EXISTS automations;

CREATE TYPE automations."NativeDatabaseOperation" AS ENUM (
    'DELETE',
    'INSERT',
    'UPDATE'
);

-- How much of a run the ops feed keeps per team. It arrived with
-- `team.ops_detail_level` and lives here now: the engine's run detail is its
-- only reader, and the admin app reads it back through automations.
CREATE TYPE automations."OpsDetailLevel" AS ENUM (
    'low', 'medium', 'full'
);


-- ## Session context — the unit's own GUCs
--
-- The missing sibling of knowledge's and valuations' (D43b). A unit whose
-- triggers and policies read another unit's session settings looks correct in
-- a composed deployment — core sets the old `core.*` names — and silently
-- attributes every standalone write to nobody, while its `agent` policies
-- admit nothing because the function they call is not there (D35(c)).
--
-- The set is deliberately a COPY of the other units' rather than a shared
-- helper: these become separate repos, and a session derivation one imports
-- from another is a coupling none of them wants (D12).

CREATE FUNCTION automations.set_session_context(
    p_team_id text,
    p_actor_type text,
    p_actor_id text,
    p_context_id text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('automations.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('automations.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('automations.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('automations.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;

CREATE FUNCTION automations.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.team_id', TRUE), '');
$$;

CREATE FUNCTION automations.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.actor_type', TRUE), '');
$$;

CREATE FUNCTION automations.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.actor_id', TRUE), '');
$$;

CREATE FUNCTION automations.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('automations.context_id', TRUE), '');
$$;


-- ## Audit log — the unit's own trail
--
-- Nine of this schema's tables are audited, and `public.audit_log` is residual
-- operator-ops (D36) that does not travel with the unit. Who edited a movement,
-- who deleted a trigger, when a credential was rotated — that trail is the
-- automations unit's own evidence and has to land inside the schema.

CREATE TABLE automations.audit_log (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op automations."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);

ALTER TABLE ONLY automations.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

CREATE SEQUENCE automations.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE automations.audit_log_version_seq OWNED BY automations.audit_log.version;
ALTER TABLE ONLY automations.audit_log ALTER COLUMN version SET DEFAULT nextval('automations.audit_log_version_seq'::regclass);

CREATE INDEX automations_audit_log_context_id_idx ON automations.audit_log USING btree (context_id);
CREATE INDEX automations_audit_log_created_at_idx ON automations.audit_log USING btree (created_at);
CREATE INDEX automations_audit_log_model_id_idx ON automations.audit_log USING btree (model_id);
CREATE INDEX automations_audit_log_version_idx ON automations.audit_log USING btree (version);

CREATE FUNCTION automations.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = automations.current_actor_id();
  NEW.team_id = NULLIF(automations.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(automations.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON automations.audit_log FOR EACH ROW EXECUTE FUNCTION automations.set_created_fields();

CREATE FUNCTION automations.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO automations.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::automations."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


-- ## Triggers (first-class)
-- A `trigger` row represents an event source: an adapter (MAILGUN, TWILIO,
-- SLACK, ATTIO, …) or a KG-mutation listener. Each trigger has a `kind`
-- (adapter slug) plus a kind-specific `config` jsonb (routing key,
-- webhook secret, mutation filter, etc.) and optional `credentials_id`.
-- A trigger is purely the dispatch index for a movement's `listen`
-- statement: it carries NO orchestration / object code. EXECUTION reads the
-- canonical movement text (services/movement_engine/run.ts). Liveness is a
-- movement-derivation gate: a trigger is live (eligible to dispatch) iff it
-- is movement-derived (`movement_id IS NOT NULL`) — see
-- services/translation_graph/storage/authored.ts.
--
-- See plans/2026-06-10-data-movement-language/6_engine.md.

CREATE TABLE automations.trigger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,                       -- opaque tenant id; NO foreign key (D3 — the unit ships without a `team` table)
    pipeline_configuration_id uuid NOT NULL,     -- WRITE-ONLY vestige (provision.ts stamps it, nothing branches on it); the FK is gone and the column dies with dealflow (7_automations.md M-2)
    name text NOT NULL,
    kind text NOT NULL,                          -- source adapter slug ('web', 'email', 'attio', …) — the adapter the trigger interprets events with (legacy rows may carry an uppercase routing kind; readers resolve via resolveAdapterSlug)
    config jsonb DEFAULT '{}'::jsonb NOT NULL,   -- kind-specific config
    credentials_id uuid,                         -- optional; the vault credential this trigger reads (in-schema FK below, after automations.external_service_credentials)
    movement_id uuid,                            -- the movement whose `listen` statement derives this trigger (FK below, after automations.movement) — null = legacy/orphan (no longer dispatched)
    fired_movement_name text,                    -- the movement the `listen … fire <name>` clause runs, decoupled from `name` (which is a human-readable `listen as "…"` label when aliased). Dispatch passes this to the engine to pick the movement in a multi-movement file. NULL = legacy/single-movement (engine then requires exactly one declaration)
    run_mode text NOT NULL DEFAULT 'live',       -- 'off' | 'dry_run' | 'live' — mirrors pipeline_output.run_mode; gates dispatch (off = drop, dry_run = run but capture writes, live = commit)
    cron_last_fired_at timestamptz,              -- movement-scheduler checkpoint for kind='cron' rows: occurrences due since this mark fire, then it advances (NULL = not yet established; reconciliation never touches it)
    -- Poll-source checkpoints (plans/2026-06-19-granola-adapter): the platform
    -- half of the PollSource seam. The poll-source worker scans trigger rows
    -- whose `kind` resolves to a registered PollSource, calls getEvents with the
    -- persisted opaque `poll_checkpoint`, dispatches the returned events, and
    -- advances the checkpoint + `poll_last_at`. `poll_checkpoint` is the source's
    -- own opaque progress marker (kept SEPARATE from author `config`); NULL = not
    -- yet polled (first sight).
    poll_checkpoint jsonb,                       -- opaque source progress marker; NULL = first sight
    poll_last_at timestamptz,                    -- when last polled; gates the per-source interval
    -- The listen's FULL resolved address (plans/2026-07-10-adapter-entry-positions/
    -- 8_event_edges.md, "Channel identity is the RESOLVED ADDRESS"): the position's
    -- path + the config's hops, names→ids, resolved by the walk at provisioning.
    -- DERIVED, kept SEPARATE from the authored `config` (authored and derived never
    -- share a bag). Subscription channels key on canonical(resolved address), so an
    -- old config-shaped row re-derives to the same key and the transition costs
    -- nothing. NULL = the adapter declares no address hops, or a legacy row.
    resolved_address jsonb,                      -- { hopKey: resolvedId, … }; NULL = no address hops / legacy
    -- Loop-guard graceful disable (Phase 1, plans/2026-06-14-loop-guard/4_disable_and_notify.md).
    -- A safety pause set by the loop guard on a breach, kept DISTINCT from a human
    -- `run_mode = 'off'` so the dispatcher (and an operator) can tell them apart. When
    -- `guard_paused_at` is non-null the dispatch gate skips the RUN (the inbound receipt
    -- in automations.trigger_event is still stored upstream → replayable; no data is lost).
    -- Manual resume clears these (auto-resume is deliberately NOT the default — the
    -- looping condition usually persists and would oscillate).
    guard_paused_at timestamptz,                 -- NULL = not safety-paused; non-null = paused at this time by the loop guard
    guard_paused_reason text,                    -- plain-language reason recorded on the breach (operator + audit)
    guard_paused_signal text,                    -- which guard signal tripped: 'team_budget' | 'trigger_rate'
    notes text NOT NULL DEFAULT '',              -- agent-authored reasoning about the automation
    provisioned_by_setup_agent boolean NOT NULL DEFAULT false,
    created_by_user_id uuid,                     -- optional, opaque user id (no FK, D3) — fallback "acting user" when adapter.identifyActingUser returns null (T4)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_pkey PRIMARY KEY (id);

CREATE INDEX trigger_team_id_idx ON automations.trigger USING btree (team_id);
CREATE INDEX trigger_kind_config_idx ON automations.trigger USING btree (kind, ((config->>'key'))) WHERE ((config->>'key') IS NOT NULL);

CREATE TRIGGER trigger_audit AFTER INSERT OR DELETE OR UPDATE ON automations.trigger FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- ## Movements (text-canonical data-movement programs)
-- A `movement` row is the canonical persisted artifact for a data-movement
-- program: `source` holds the program text (.mvt). Movements execute on
-- the movement engine (`services/movement_engine/run.ts`) directly from
-- this text — there is no compiled artifact. The derived rows:
--   - one `automations.trigger` row per `listen` statement (the dispatch
--     index, linked back via `trigger.movement_id`);
--   - `trigger_id` on this row is a legacy first-listener convenience.
--
-- See plans/2026-06-10-data-movement-language/6_engine.md.

CREATE TABLE automations.movement (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,                       -- opaque tenant id; NO foreign key (D3)
    name text NOT NULL,
    source text NOT NULL,                        -- the movement program text (.mvt) — canonical
    description text NOT NULL DEFAULT '',
    trigger_id uuid,                             -- legacy first-listener convenience; canonical link is trigger.movement_id
    current_version_id uuid,                     -- FK → movement_version; the version new runs pin (versioning D2/D3, async-interaction P11)
    created_by_user_id uuid,                     -- optional, opaque user id (no FK, D3)
    -- Runtime validity lifecycle (plans/2026-07-13-movement-validity-lifecycle):
    -- whether the CURRENT source is expected to run against the adapters'
    -- CURRENT live shape. Mutable (drifts), and present even when
    -- incompilable (which has no version).
    validity_status text,                        -- 'valid' | 'invalid' | 'unverified' | NULL (never checked)
    validity_reason jsonb,                        -- diagnostics (invalid) | introspection gap (unverified)
    validity_source_hash text,                    -- content hash of the source the status was computed against (version-match rule)
    validity_checked_at timestamptz,
    validity_consented_at timestamptz,            -- set when a non-valid save was shipped on explicit consent
    validity_checked_against integer,             -- the language version the last validation ran under (NULL = never checked)
    -- The language version this movement is written against (packages/movement-lang
    -- language_version.ts). Stamped explicitly at FIRST save with the release's
    -- current version and never moved by an edit or re-save. The default is the
    -- backfill: a row nobody stamped predates versioning, so it is version 1.
    language_version integer DEFAULT 1 NOT NULL,
    -- What stands between this movement and the release's current language
    -- version: the diagnostics (errors AND warnings) the deploy check or an
    -- upgrade attempt found validating it under `upgrade_checked_against`.
    -- NULL = nothing recorded (never checked, or the pin is already current).
    upgrade_diagnostics jsonb,
    upgrade_checked_against integer,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT movement_validity_status_check CHECK (validity_status IN ('valid', 'invalid', 'unverified'))
);

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES automations.trigger(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_team_name_unique UNIQUE (team_id, name);

CREATE INDEX movement_team_id_idx ON automations.movement USING btree (team_id);

CREATE TRIGGER movement_audit AFTER INSERT OR DELETE OR UPDATE ON automations.movement FOR EACH ROW EXECUTE FUNCTION automations.audit();

-- Trigger → movement binding (2026-06-10, "the file declares its listeners"):
-- trigger rows are DERIVED from a movement file's `listen` statements — one
-- row per listen, reconciled on every clean save (kind/credentials/config
-- come from the listen; only `run_mode` stays hand-editable). Declared here
-- (not with the trigger table above) because automations.movement is created
-- later in this file. The old movement.trigger_id link is vestigial.
ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX trigger_movement_id_idx ON automations.trigger USING btree (movement_id);

-- movement_version — immutable source snapshots (versioning prerequisite, P11).
-- Every save whose source differs (by content_hash) mints a new version; a run pins
-- the movement's current_version_id at start, and a parked run resumes by re-parsing
-- THIS version's source (not the live movement.source, which may have drifted).
-- See plans/2026-06-21-movement-versioning/.
CREATE TABLE automations.movement_version (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movement_id uuid NOT NULL,
    team_id uuid NOT NULL,                       -- denormalised for team-scoped queries (mirrors movement)
    version_number integer NOT NULL,             -- monotonic per movement (human-facing; identity/pinning is by id)
    source text NOT NULL,                        -- immutable snapshot of the .mvt program text at this version
    content_hash text NOT NULL,                  -- hash of source; dedups identical re-saves (D1)
    -- The movement's language version when this snapshot was minted. A run pins
    -- the snapshot, so a parked run resumes under the version it STARTED with,
    -- even after the deploy check advances the movement's pin.
    language_version integer NOT NULL,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY automations.movement_version
    ADD CONSTRAINT movement_version_number_unique UNIQUE (movement_id, version_number);

CREATE INDEX movement_version_movement_id_idx ON automations.movement_version USING btree (movement_id);

-- The movement's current version (the one new runs pin). Circular ref with movement is
-- intentional and resolved here, after movement_version exists. Nullable: a movement
-- with no clean compile yet has no version.
ALTER TABLE ONLY automations.movement
    ADD CONSTRAINT movement_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES automations.movement_version(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- movement_issue — Sentry-shaped aggregation of run failures (validity
-- lifecycle layer 2, plans/2026-07-13-movement-validity-lifecycle). One row
-- per (movement, fingerprint); occurrences bump `count`, alerts fire on
-- state TRANSITIONS (new / regression / count crossing the threshold), never
-- per occurrence. A clean run of the movement resolves its open issues.
CREATE TABLE automations.movement_issue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    movement_id uuid NOT NULL,
    fingerprint text NOT NULL,                   -- hash of (failure_class, normalized message)
    failure_class text NOT NULL,                 -- MOVENG_* code, or 'runtime'
    message text NOT NULL,                       -- latest raw sample message
    count integer DEFAULT 1 NOT NULL,            -- cumulative occurrences
    state text NOT NULL DEFAULT 'open',          -- 'open' | 'resolved'
    threshold_alerted boolean DEFAULT false NOT NULL,  -- crossed-N alert sent for this episode
    sample_run_ids jsonb DEFAULT '[]'::jsonb NOT NULL, -- most recent trigger_run ids (capped)
    first_seen_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    resolved_at timestamptz,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT movement_issue_state_check CHECK (state IN ('open', 'resolved'))
);

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY automations.movement_issue
    ADD CONSTRAINT movement_issue_movement_fingerprint_unique UNIQUE (movement_id, fingerprint);

CREATE INDEX movement_issue_movement_id_idx ON automations.movement_issue USING btree (movement_id);
CREATE INDEX movement_issue_team_state_idx ON automations.movement_issue USING btree (team_id, state);

-- system_event — the platform's own events that no other table already
-- records, for the `system` adapter's poll source to deliver (`Validation
-- Issue`, `Deprecated Version`, `Release Applied`, `Run Paused`; `Run Failed` is
-- read from trigger_run). Append-only; written by the deploy check and by a run
-- pausing at a limit. `payload` is the
-- adapter's one record shape (SystemEventPayload).
CREATE TABLE automations.system_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    kind text NOT NULL,                          -- the kind's type id: 'validation_issue' | 'deprecated_version' | 'release_applied' | 'run_paused'
    payload jsonb NOT NULL,
    occurred_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.system_event
    ADD CONSTRAINT system_event_pkey PRIMARY KEY (id);

CREATE INDEX system_event_team_occurred_idx ON automations.system_event USING btree (team_id, occurred_at, id);

-- deploy_check — one row per release the deploy check has swept. Its presence
-- is what makes the check idempotent (a second run on the same release does
-- nothing); `summary` is what `deploy/up.sh` prints (advanced / warned /
-- refused, by automation name).
CREATE TABLE automations.deploy_check (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    release_tag text NOT NULL,                   -- LISTEN_FIRE_VERSION ('dev' for an untagged build)
    language_release text NOT NULL,              -- the release's language versions: current, supported, deprecated
    summary jsonb NOT NULL,
    ran_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.deploy_check
    ADD CONSTRAINT deploy_check_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.deploy_check
    ADD CONSTRAINT deploy_check_release_unique UNIQUE (release_tag, language_release);

-- movement_story_token — the capability link a movement's STORY is served on
-- (`GET /api/story/<token>`, pre-auth: the token is the authorisation, the asks
-- idiom). One durable token per movement, minted lazily the first time someone
-- asks for the link and reused thereafter — so handing the link out twice hands
-- out the same link. No expiry (a picture of what an automation does does not
-- go stale on a clock); revocable by hand, and it dies with the movement.
-- The page it opens is projected at SERVE time, so the token grants a view of
-- whatever the program currently says — never a frozen copy.
-- See plans/movement-renderer-2026-08-03/3_standalone.md.
CREATE TABLE automations.movement_story_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    movement_id uuid NOT NULL,
    team_id uuid NOT NULL,                       -- denormalised for team-scoped queries (mirrors movement)
    token text NOT NULL,                         -- the capability itself (`story_`-prefixed, 24 random bytes)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamptz                       -- set to kill the link without deleting the automation
);

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_movement_id_fkey FOREIGN KEY (movement_id) REFERENCES automations.movement(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY automations.movement_story_token
    ADD CONSTRAINT movement_story_token_token_unique UNIQUE (token);

CREATE INDEX movement_story_token_movement_id_idx ON automations.movement_story_token USING btree (movement_id);


-- (The `trigger_entry` table was removed: its `orchestration`
-- and `execution_mode` moved onto `automations.trigger`, and its adapter
-- `filter` was dropped entirely — routing/narrowing now lives inside the
-- orchestration as `branch`. See
-- plans/2026-06-04-automation-as-program/3c_substrate-collapse.md.
-- The `placeholder` flag was later retired too — liveness is content-
-- derived; provisioning lands automations straight to live.)

-- trigger_run — one row per TRIGGER FIRING (one event x one trigger), the unit
-- of observation. A translation is a reusable building
-- block, not a thing "run" in isolation; the firing is what we observe. Every
-- node written across every orchestration step lands in `steps[].applied_action_plans`,
-- so the detail view shows the whole firing. Keyed by the real trigger id (not
-- the entry id), so Recent Activity queries `WHERE trigger_id = <automation>`.
CREATE TABLE automations.trigger_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; NO foreign key (D3)
    trigger_id text NOT NULL, -- the automations.trigger that fired (text: engine-side id)
    trigger_type text NOT NULL, -- 'webhook' | 'snapshot' | 'mutation' | 'extraction' | 'simulation'
    status text NOT NULL, -- 'running' | 'parked' (live, async-interaction) | 'success' | 'partial' | 'failed' (terminal, aggregate across steps)
    record_id text,
    movement_version_id uuid, -- the pinned movement version this run executes/resumes against (P11); null for legacy/non-movement runs. An IN-SCHEMA FK again (below) now that both sides live in `automations` — it crossed a schema boundary for exactly one chunk (7_automations.md §1b)
    trigger_payload jsonb,
    changed_fields text[],
    steps jsonb NOT NULL DEFAULT '[]'::jsonb, -- per step: {tgId, tgName?, sourceAdapterType, targetAdapterType, status, appliedActionPlans, diagnostics, errors}
    diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb, -- aggregate
    errors jsonb NOT NULL DEFAULT '[]'::jsonb, -- aggregate, each tagged with its step's tgId
    nodes_written integer NOT NULL DEFAULT 0, -- total writes across steps (list-row convenience)
    dry_run boolean NOT NULL DEFAULT false,
    started_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp(3) with time zone,
    failed_at timestamp(3) with time zone,
    failure_reason text,
    -- Explicit user cancellation (runs-and-cancel spec 2026-07-15): stamped by
    -- abortRun for a RUNNING run; the engine stops cooperatively at its next
    -- check and settles as failed with cancel_reason. Parked runs are failed
    -- immediately (no stamp needed) but resume drivers also honor a stamp
    -- (cancel-vs-park race: a stamped run is settled, never resumed).
    cancel_requested_at timestamptz,
    cancel_reason text,
    -- A run PAUSED at a limit (today: the per-run cost cap, MOVEMENT_MAX_RUN_COST_USD).
    -- Non-null while paused: { limit, capMicrodollars, spentMicrodollars, pausedAt }.
    -- The run's status stays 'parked'; its limit-suspended branches are the
    -- parked_run rows with park_reason='limit', and only an explicit resume
    -- (services/movement_engine/limit_pause.ts) clears this and resumes them all.
    limit_pause jsonb,
    -- What the run had spent when it was last resumed from a limit pause. The cap
    -- reads spend SINCE this point: resuming a run paused at its cap resets its usage.
    cost_cap_baseline_microdollars bigint NOT NULL DEFAULT 0,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ops_run_id uuid
);

ALTER TABLE ONLY automations.trigger_run
    ADD CONSTRAINT trigger_run_pkey PRIMARY KEY (id);


CREATE INDEX trigger_run_team_id_idx ON automations.trigger_run USING btree (team_id);
CREATE INDEX trigger_run_trigger_id_idx ON automations.trigger_run USING btree (trigger_id);
CREATE INDEX trigger_run_created_at_idx ON automations.trigger_run USING btree (created_at);

-- The run's version pin, an in-schema FK once more: a run resumes by re-parsing
-- the version it pinned, so a deleted version must not leave a run pointing at
-- nothing (SET NULL is what `interaction/run_failure.ts` reads as "the pinned
-- version is gone"). Declared here rather than with the column because
-- movement_version is created earlier in this section.
ALTER TABLE ONLY automations.trigger_run
    ADD CONSTRAINT trigger_run_movement_version_id_fkey FOREIGN KEY (movement_version_id) REFERENCES automations.movement_version(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Deleting a run no longer touches the ops-residual rows that reference it:
-- `llm_usage` (was ON DELETE SET NULL) lives in `public` and its FK went with
-- D3/D8. The two code paths that delete runs — the retention prune and
-- `dev:seed --reset` — release those references explicitly
-- (`releaseLlmUsageRunReferences`, lib/llm_usage.ts).

-- ── Async user interaction (the ask adapter) ───────────────────────────────
-- A movement run parks at an `await` on an ask's Response for seconds-to-days
-- and resumes when the answer arrives. The durable substrate is the `ask`
-- record store below plus `parked_run` (the await park) and `adapter_await`
-- (the correlation map). The legacy `interaction_request` / `interaction_token`
-- pair was dropped in asks-as-adapter chunk G (the old `ask` statement is gone).

-- The `ask` record store itself lives in its OWN Postgres schema — see the
-- ASKS SCHEMA section above. `adapter_await` below is engine infrastructure and
-- belongs to automations: it correlates a parked run with WHATEVER awaitable
-- adapter it is waiting on, of which `ask` is only one.

-- adapter_await — the GENERIC CORRELATION MAP for the awaitable capability
-- (asks-as-adapter §A duty 1). One row per in-flight `await <head>-[:E]->` park,
-- for ANY awaitable adapter: it maps the adapter's native identity
-- (`adapter_type` + `correlation_key` — the ask id for `ask`, `channel:thread_ts`
-- for `slack`) to the engine's park (`run_id`, `address` — the parked_run leaf).
-- Registered when an await parks; DROPPED on run death / race loss (§A duty 2,
-- F7 — dropping correlation touches no record). Because every awaitable adapter
-- shares this one table keyed on (run_id, address), the terminal-seam drop is
-- adapter-AGNOSTIC by construction: one `DELETE … WHERE run_id = ?` reaps every
-- adapter's correlations at once (no per-adapter fan-out). Correlation, NOT
-- stability — the head is identified by what the adapter can recognise, so no
-- head snapshot is stored here. This is the ADAPTERs' map (P16: a record fact
-- lives with the adapter), never a fourth home.
--
-- Resolvability is per-adapter and lives OUTSIDE this table: the `ask` poll
-- joins these rows (adapter_type='ask') to `ask.state`; `slack` is event-driven
-- (an inbound thread reply looks up its parks by correlation_key). No `ask` FK
-- on correlation_key — it is opaque text, an adapter's own identity string.
CREATE TABLE automations.adapter_await (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    adapter_type text NOT NULL,            -- the awaitable adapter ('ask', 'slack', …)
    correlation_key text NOT NULL,         -- the adapter's native identity (ask id, channel:thread_ts)
    run_id uuid NOT NULL,                  -- the parked run
    team_id uuid NOT NULL,                 -- opaque tenant id; NO foreign key (D3)
    address text NOT NULL,                 -- the parked await leaf's lexical address (matches parked_run.address)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- One correlation per park (idempotent re-registration on a re-parked await).
ALTER TABLE ONLY automations.adapter_await
    ADD CONSTRAINT adapter_await_run_address_unique UNIQUE (run_id, address);

-- Inbound resolution lookup: an event-driven adapter (slack) finds a thread's
-- parks by (adapter_type, correlation_key), team-scoped.
CREATE INDEX adapter_await_correlation_idx ON automations.adapter_await USING btree (adapter_type, correlation_key, team_id);

-- The ask resume scan drives off the awaited ask settling (adapter_type='ask'
-- joined to ask.state); the run index also serves the per-run drain + drop.
CREATE INDEX adapter_await_run_id_idx ON automations.adapter_await USING btree (run_id);

-- callback — the DEFERRED, ADDRESSABLE INVOCATION minted by `callback(…)`.
-- One row per mint. The `id` IS the payload every platform button / tap / BYO
-- webhook carries and IS the authorization: `cb_`-prefixed opaque text, its own
-- namespace so every door picks it out by a PREFIX COMPARISON and never parses
-- it (a discriminant, not a structure).
--
-- Scoping is JS closure semantics (callback-primitive layer 1): a callback lives
-- exactly as long as the run that minted it. `run_id` FKs the owning run;
-- `address` is the callback expression's canonical lexical address in that run's
-- PINNED movement version (engine §4.3) — the entry point a fire resumes at.
-- Stable across re-parse because the run pins its version (P11), and
-- iter/branch steps disambiguate a callback minted inside a fan-out iteration —
-- which an ordinal "n-th callback of the run" could not. NOT unique per
-- (run, address): each fan-out iteration mints its own row, with its own id and
-- its own captured closure.
--
-- `state` is the captured continuation in EXACTLY the parked-run shape
-- (`ParkedScopeState` — the same serializer the park machinery uses), because a
-- callback body IS a parked continuation with a different entry point. It lives
-- HERE rather than in `parked_run` deliberately: a `parked_run` row means "a leaf
-- this run is waiting on", and an outstanding callback is not one — the run's
-- quiescence checks must not see it, or ruling (b) (a run that reaches its end
-- revokes its un-fired callbacks) could never fire.
--
-- `calls` is the append-only CALL LEDGER — what `cb-[:Called]->` reads and what
-- an `await cb-[:Called]->` wakes on. jsonb rather than a child table so the
-- single-use CLAIM and the call APPEND are ONE atomic statement: the CAS
-- (`WHERE status='live'` … RETURNING) is what makes two concurrent taps record
-- exactly once, with no transaction straddling two tables.
CREATE TABLE automations.callback (
    id text NOT NULL,                      -- 'cb_' + 24 random bytes base64url — the opaque payload, COMPARED never parsed
    team_id uuid NOT NULL,                 -- opaque tenant id; NO foreign key (D3)
    run_id uuid NOT NULL,                  -- the owning run: a callback dies with it (closure scoping)
    address text NOT NULL,                 -- the callback expression's canonical lexical address (engine §4.3) — the entry point
    params jsonb NOT NULL DEFAULT '[]'::jsonb,  -- the fire-time signature, declaration order: [{ name, type }] — fire-time validation + the confirm page
    state jsonb NOT NULL,                  -- the captured continuation (ParkedScopeState) — the park serializer's own shape
    calls jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the append-only call ledger: [{ at, values }] — what `Called` sees
    single_use boolean NOT NULL DEFAULT true,   -- `once` defaults TRUE; the engine owns the default, not the AST
    expires_at timestamptz,                -- `ttl` as an absolute instant; null = none. Checked LAZILY at fire (no sweeper needed for correctness)
    status text NOT NULL DEFAULT 'live',   -- live | fired (a single-use claim) | revoked (run settled / cancelled / movement deleted)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    fired_at timestamptz,                  -- set on the live → fired claim (single-use only)
    revoked_at timestamptz,                -- set on the live → revoked flip
    CONSTRAINT callback_status_check CHECK (status IN ('live', 'fired', 'revoked'))
);

ALTER TABLE ONLY automations.callback
    ADD CONSTRAINT callback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.callback
    ADD CONSTRAINT callback_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- The run-lifecycle reap: settle / cancel / movement-delete revokes every one of
-- a run's outstanding callbacks in a single statement.
CREATE INDEX callback_run_id_idx ON automations.callback USING btree (run_id);
CREATE INDEX callback_team_id_idx ON automations.callback USING btree (team_id);

-- parked_run — ONE ROW PER PARK (per parked branch), not per run (§5.2 D3).
-- `parked` = resumable (state holds the branch's frame + local scope chain);
-- `completed` = its ask resolved and the branch ran to its end but its join
-- isn't done (result holds its bindings, retained until the join hoists).
-- Different branches' resumes hit different rows → no hot-row contention.
CREATE TABLE automations.parked_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,                  -- the trigger_run this park belongs to
    address text NOT NULL,                 -- the parked leaf's canonical lexical address (engine §4.3)
    status text NOT NULL DEFAULT 'parked', -- parked | completed (§5.2)
    state jsonb,                           -- the branch's serialized frame + local scope (parked); null when completed
    result jsonb,                          -- the branch's bindings (completed, awaiting its join); null when parked
    -- Which resume driver owns the leaf, so drivers don't cross-drain. 'limit' = an
    -- engine suspension at a run limit (the cost cap): resumed only by an explicit
    -- resume of the whole run, never by a worker.
    park_reason text NOT NULL DEFAULT 'ask' CONSTRAINT parked_run_park_reason_check CHECK (park_reason IN ('ask', 'timer', 'await', 'limit')),
    wake_at timestamptz NULL,              -- absolute wake instant for timer parks; null for all other park_reason values
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT parked_run_status_check CHECK (status IN ('parked', 'completed'))
);

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY automations.parked_run
    ADD CONSTRAINT parked_run_run_address_unique UNIQUE (run_id, address);

CREATE INDEX parked_run_run_id_idx ON automations.parked_run USING btree (run_id);
CREATE INDEX parked_run_timer_wake_idx ON automations.parked_run (wake_at) WHERE park_reason = 'timer' AND status = 'parked';

-- Deferred automations work. One row per unit of work; deleted on completion
-- (or rescheduled when interval_ms is set). The lease is what makes claiming
-- safe across many drainers; a row whose lease has lapsed is re-claimable and
-- its handler's recover path runs instead of run.
CREATE TABLE automations.work (
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
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_due_idx ON automations.work (due_at);
CREATE INDEX work_team_idx ON automations.work (team_id) WHERE team_id IS NOT NULL;

-- join_pending — the per-frame PENDING-COUNT (§5.4): for each parallel / fan-out
-- JOIN frame with ≥1 parked descendant, the number of its child branches still
-- unresolved. "A frame is parked iff pending > 0." Resolving a child is the
-- atomic `UPDATE … SET pending = pending - 1 … RETURNING pending`; the decrement
-- returning 0 is the unique, race-free completer (no read-then-claim, no marker).
-- The completer hoists the join, runs the enclosing sequence forward, and (if
-- that completes the parent frame) decrements ITS join, cascading up. A row is
-- NOT deleted on close — closed_by_address marks the closer for crash-safety
-- (§6.4 / §7): on retry the closer re-reads closed_by_address === itsLeaf and
-- re-runs the continuation; a sibling reads closed_by_address !== itsLeaf and
-- stops. Rows are wiped at run settle alongside join_branch_export. A leaf with
-- no enclosing join (a single linear ask) has NO row — it completes directly.
CREATE TABLE automations.join_pending (
    run_id uuid NOT NULL,                  -- the trigger_run this join belongs to
    frame_address text NOT NULL,           -- the join frame's canonical lexical address (engine §4.3) — the parallel/fan-out STATEMENT's address
    pending integer NOT NULL,              -- count of child branches not yet resolved (parked at firing); 0 ⇒ the frame is closed (row retained)
    closed_by_address text,               -- NULL until the frame closes; set to the leaf address of the unique closer (crash-safety §6.4)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT join_pending_pending_nonneg CHECK (pending >= 0)
);

ALTER TABLE ONLY automations.join_pending
    ADD CONSTRAINT join_pending_pkey PRIMARY KEY (run_id, frame_address);

ALTER TABLE ONLY automations.join_pending
    ADD CONSTRAINT join_pending_run_id_fkey FOREIGN KEY (run_id) REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- join_branch_export — one row per COMPLETED branch of a JOIN frame (§12), holding
-- the bindings that branch hoists to its parent. Written during resume unwind as
-- each branch completes (persist-before-decrement, §12.1); read once by the CLOSER
-- to reconstruct the full parent aggregate (§12.4). Live state, wiped with
-- join_pending at run settle (§12.6) — not history.
CREATE TABLE automations.join_branch_export (
    run_id uuid NOT NULL,               -- the trigger_run this branch belongs to
    frame_address text NOT NULL,        -- the JOIN frame (parallel/fan-out statement) address; = join_pending.frame_address
    branch_address text NOT NULL,       -- this branch's address (childBranch/childIter of the frame)
    branch_index integer NOT NULL,      -- the branch/iteration ordinal — the DETERMINISTIC fold order (§12.4)
    exports jsonb NOT NULL,             -- Record<name, BindingDescriptor>: this branch's hoisted bindings (serializeBinding), hop aliases already excluded for fan-out
    decremented boolean DEFAULT false NOT NULL, -- per-leaf EXACTLY-ONCE decrement claim (§7 residual): set true when this branch takes its join decrement; a re-scanned branch (crash before deleteLeaf) sees it and skips the second decrement. Never reset by re-persist.
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT join_branch_export_pkey PRIMARY KEY (run_id, frame_address, branch_address)
);

ALTER TABLE ONLY automations.join_branch_export
    ADD CONSTRAINT join_branch_export_run_id_fkey FOREIGN KEY (run_id)
    REFERENCES automations.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX join_branch_export_frame_idx
    ON automations.join_branch_export (run_id, frame_address);

-- record_binding — the engine-owned, generic, SYMMETRIC correspondence
-- store. One row binds two fully-qualified record POSITIONS across any
-- pair of systems ("this record IS the counterpart of that one"), declared
-- in the movement language by `write … bind other { … }`. The engine owns
-- storage, lifecycle, and id-based matching; the adapter is
-- correspondence-agnostic. This SUPERSEDES the KG-specific `linked_object`
-- correspondence role (which stays in place, vestigial, for the frozen TG
-- engine + its retrieval/output roles).
--
-- An endpoint is NOT (system, recordId) — that is ambiguous (the same id in
-- a different Airtable base is a different record). Each endpoint encodes a
-- full position identity: (adapter_type, instance_key, type_id, record_id),
-- where instance_key is a canonical encoding of the INSTANCE (credential +
-- normalized construction config) and type_id is the STABLE INTERNAL type id
-- (never the mutable display name). See
-- services/movement_engine/record_binding.ts for the encoder.
--
-- The binding is symmetric: it must be matchable from EITHER endpoint. We
-- store the two endpoints canonically ORDERED (endpoint_a's encoded key
-- <= endpoint_b's) so a binding is one row regardless of which side asked,
-- and the unique index dedupes it. Lookups query both `a = X` and `b = X`.
CREATE TABLE automations.record_binding (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; NO foreign key (D3)
    -- Endpoint A (canonically the lexicographically-smaller endpoint key).
    a_adapter_type text NOT NULL,
    a_instance_key text NOT NULL,
    a_type_id text NOT NULL,
    a_record_id text NOT NULL,
    -- Endpoint B (canonically the lexicographically-larger endpoint key).
    b_adapter_type text NOT NULL,
    b_instance_key text NOT NULL,
    b_type_id text NOT NULL,
    b_record_id text NOT NULL,
    created_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ONLY automations.record_binding
    ADD CONSTRAINT record_binding_pkey PRIMARY KEY (id);


-- One binding per ordered endpoint pair per team — the upsert key.
CREATE UNIQUE INDEX record_binding_pair_idx ON automations.record_binding USING btree (
    team_id,
    a_adapter_type, a_instance_key, a_type_id, a_record_id,
    b_adapter_type, b_instance_key, b_type_id, b_record_id
);
-- Endpoint lookups: match a binding from EITHER side (symmetric reads).
CREATE INDEX record_binding_a_idx ON automations.record_binding USING btree (
    team_id, a_adapter_type, a_instance_key, a_type_id, a_record_id
);
CREATE INDEX record_binding_b_idx ON automations.record_binding USING btree (
    team_id, b_adapter_type, b_instance_key, b_type_id, b_record_id
);

-- trigger_event — every event RECEIVED for a trigger, stored at the door
-- BEFORE any processing: the sender gets an immediate ack, dispatch runs
-- asynchronously from the stored row, and any stored event can be played
-- back. `status` is the dispatch lifecycle ('received' → 'dispatched' |
-- 'failed'); an event stuck at 'received' after a crash is replayable.
CREATE TABLE automations.trigger_event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; NO foreign key (D3)
    trigger_id text NOT NULL, -- the automations.trigger the event was routed to (text: engine-side id)
    adapter_type text NOT NULL,
    trigger_type text NOT NULL, -- 'webhook' | 'manual' | …
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'received', -- 'received' | 'dispatched' | 'failed'
    dispatched_at timestamp(3) with time zone,
    failure_reason text,
    -- Which dispatch gate refused this event while the team was blocked
    -- ('trial_ended' | 'team_on_ice' | 'payment_hold'). The row stays at
    -- status='received' (replayable); this stamp is the cheap index a future
    -- windowed-replay-on-unblock scan will use. No replay behavior today.
    dropped_reason text,
    external_event_id text, -- the source's own per-DELIVERY id (Slack envelope event_id, …); the idempotency key for at-least-once redeliveries. NULL when the source has no stable delivery id.
    occurred_at timestamp(3) with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.trigger_event
    ADD CONSTRAINT trigger_event_pkey PRIMARY KEY (id);


CREATE INDEX trigger_event_team_id_idx ON automations.trigger_event USING btree (team_id);
CREATE INDEX trigger_event_trigger_id_idx ON automations.trigger_event USING btree (trigger_id);
CREATE INDEX trigger_event_created_at_idx ON automations.trigger_event USING btree (created_at);
-- Idempotency: a source's per-delivery id is unique PER TRIGGER, so an
-- at-least-once redelivery (Slack retries an event it didn't get a 200 for in
-- 3s) is a no-op insert rather than a duplicate run. Partial: NULL delivery ids
-- (sources without a stable per-delivery handle) are never deduped.
CREATE UNIQUE INDEX trigger_event_delivery_idempotency_idx ON automations.trigger_event USING btree (trigger_id, external_event_id) WHERE external_event_id IS NOT NULL;

-- ## Exposed File
-- Short-lived public exposure of a file's bytes for adapters whose target needs
-- a *fetchable URL* (Airtable's [{url}] attachment shape, a remote service that
-- can't take bytes over the JSON wire) rather than a byte stream. `exposeFile`
-- buffers a FileRef's bytes to S3 under an isolated temp prefix and records the
-- handle here; the public `GET /api/files/blob/:id` route looks the row up by
-- its unguessable id and 302-redirects to a presigned S3 URL scoped to that
-- prefix. A periodic cleanup poller deletes expired rows and their S3 objects.
-- The id IS the public capability (unguessable + expiring); never logged.
--
-- `team_id` is the OWNER of the bytes, not the reader of them: the route stays
-- unauthenticated (the id is the capability), but a row now says whose file it
-- exposed, so a team's exposures can be counted and purged like every other row
-- this schema holds (D55(a)).
--
-- NULLABLE, and the reason is a finding rather than a compromise: the movement
-- ENGINE establishes no ambient identity. It threads `teamId` as a parameter
-- and never reads a Principal, so a run dispatched by the cron scheduler or a
-- poller has none — and two of `exposeFile`'s four callers are adapters deep
-- inside that run (Airtable's attachment cells, the remote adapter's wire
-- form) with no team in scope to pass. A NOT NULL column would therefore not
-- have made those rows tenanted; it would have made those RUNS CRASH.
--
-- So the stamp is best-effort and explicit about it: the callers that know the
-- team say so, the ones running under an identity have it read for them, and a
-- NULL means "written by a path that had no tenant to name" rather than
-- "nobody's". Every row is one-hour capability state, so the exposure of a
-- NULL is bounded by the hour. The durable fix is for the engine to establish
-- a machine Principal per run — which is what `runInContext`'s own comment says
-- the design intends — and that is a ruling above the chunk that found it.
CREATE TABLE automations.exposed_file (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    object_uri text NOT NULL,
    content_type text,
    filename text,
    expires_at timestamp(3) without time zone NOT NULL
);
ALTER TABLE ONLY automations.exposed_file ADD CONSTRAINT exposed_file_pkey PRIMARY KEY (id);
CREATE INDEX exposed_file_expires_at_idx ON automations.exposed_file (expires_at);
CREATE INDEX exposed_file_team_id_idx ON automations.exposed_file (team_id);



-- =============================================================================
-- AUTOMATIONS — the credentials vault (D7)
-- =============================================================================
--
-- Every live consumer of a stored third-party credential is automations-shaped
-- (the adapters, webhook_sync, the poll-source worker), so the vault ships with
-- this unit rather than as shared platform. The `credentials` bytea moved
-- BYTE-FOR-BYTE: the envelope is AES-256-GCM with the AAD bound to the row uuid
-- and a global master key, and `SET SCHEMA` changes neither, so nothing was
-- re-encrypted and no key material is schema-aware.


-- ### External Service Credentials -------------------------------------------------------

CREATE TYPE automations."ExternalServiceType" AS ENUM (
    'SLACK',
    'AFFINITY',
    'ATTIO',
    'PIPEDRIVE',
    'MAILGUN',
    'TWILIO',
    'AIRTABLE',
    'GOOGLE',
    'GOOGLE_GMAIL',
    'DROPBOX',
    'SLACK_QUERY',
    'GRANOLA',
    'NATIVE_VALUATIONS',
    'NATIVE_KNOWLEDGE',
    'TELEGRAM',
    'REMOTE',
    'EVERTRACE',
    'DEALROOM'
);

CREATE TABLE automations.external_service_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; no foreign key (D3)
    user_id uuid, -- opaque user id; no foreign key (D3)
    type automations."ExternalServiceType" NOT NULL,
    -- NULL means SHELL: the row names a connection that carries no secret. A
    -- per-team export writes shells, because the ciphertext is AAD-bound to a
    -- global master key this deployment does not hand out, and a tier-3
    -- credential authenticates against the EXPORTER's registered third-party
    -- app anyway — it is worthless on the importer's own app (D30(b), ST-4).
    -- The id survives so `trigger.credentials_id` and
    -- `webhook_subscription.credentials_id` still land.
    credentials bytea,
    -- Stamped when the row became a shell. The connect surface renders this;
    -- `decryptToken` refuses a shell by name rather than failing an opaque GCM
    -- check, so a movement that reaches for a migrated connection says what is
    -- wrong instead of erroring in the cipher.
    reconnect_required_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    identifier text,
    -- Which app/bot in the external service this credential grants access
    -- through (a stable Listen-Fire-side shorthand — the real ids live in env and we
    -- branch our own code on this). For Slack: 'legacy' (the old app) vs 'listen-fire'
    -- (the movements app). NULL means legacy/pre-discriminator (treated as the
    -- legacy app). Lets a second app of the same ExternalServiceType be told
    -- apart + filtered without decrypting the credential payload.
    app_id text
);


ALTER TABLE ONLY automations.external_service_credentials
    ADD CONSTRAINT external_service_credentials_pkey PRIMARY KEY (id);


ALTER TABLE ONLY automations.external_service_credentials
    ADD CONSTRAINT external_service_credentials_team_name_key UNIQUE (team_id, name);

CREATE TRIGGER external_service_credentials_audit AFTER INSERT OR DELETE OR UPDATE ON automations.external_service_credentials FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- ### Connect Token ----------------------------------------------------------
-- AUTHOR-TIME credential-connect link (NOT the runtime ask link — the ask
-- adapter mints its own per-ask token). An MCP authoring agent that finds a
-- system unconnected mints one of these, hands the URL to the user, and the
-- user opens `/api/connect/<token>` in ANY browser to complete the real
-- adapter OAuth (no popup, no BroadcastChannel). On success the resulting
-- credential lands in external_service_credentials team-bound under
-- `credential_name`. `consumed_at` enforces single-use; `expires_at` is the TTL.
CREATE TABLE automations.connect_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,                   -- opaque capability token (in the link)
    team_id uuid NOT NULL,                 -- opaque tenant id; no foreign key (D3)
    user_id uuid NOT NULL,                 -- opaque user id; no foreign key (D3)
    adapter_slug text NOT NULL,            -- which adapter to connect (e.g. "attio")
    credential_name text NOT NULL,         -- the name to store the credential under
    credentials_id uuid,                   -- @DEF: connect_token_credentials_id_fkey — set = a GRANT link against an existing credential (e.g. the Sheets picker), not a credential-connect link
    expires_at timestamptz NOT NULL,       -- link TTL
    consumed_at timestamptz,               -- set when the credential lands (single-use)
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_token_unique UNIQUE (token);


-- @DEF: connect_token_credentials_id_fkey
ALTER TABLE ONLY automations.connect_token
    ADD CONSTRAINT connect_token_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX connect_token_team_id_idx ON automations.connect_token USING btree (team_id);
CREATE INDEX connect_token_expires_at_idx ON automations.connect_token USING btree (expires_at);


-- ### Google granted items ----------------------------------------------------
-- Under Google's drive.file scope there is no "list everything" API; access is
-- granted one item at a time through the Drive Picker. Each picked item (a
-- spreadsheet, a file, or a folder) is recorded here against the Google
-- credential, tagged with its real Drive mime_type so each adapter can filter to
-- the items it cares about (Sheets: the spreadsheet mime; Drive: folders vs
-- files). This is the single store behind both the Sheets and Drive pickers.
CREATE TABLE automations.google_granted_item (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    credentials_id uuid NOT NULL, -- @DEF: google_granted_item_credentials_id_fkey
    item_id text NOT NULL,
    mime_type text NOT NULL,
    name text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_pkey PRIMARY KEY (id);

-- One grant per (credential, item): re-picking the same item is a no-op.
ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_credentials_id_item_id_key UNIQUE (credentials_id, item_id);

-- @DEF: google_granted_item_credentials_id_fkey
ALTER TABLE ONLY automations.google_granted_item
    ADD CONSTRAINT google_granted_item_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;


-- ### Remote Adapter ----------------------------------------------------------
-- One install per remote Translation Graph adapter, team-scoped. The whole
-- manifest file round-trips through this row (import writes it, the UI form
-- edits it); the projected scalar columns mirror the manifest for routing and
-- credential resolution. The credential itself stays encrypted in
-- external_service_credentials; only the FK lives here.
CREATE TABLE automations.remote_adapter (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; no foreign key (D3)
    adapter_type text NOT NULL,
    base_url text NOT NULL,
    auth_strategy jsonb NOT NULL,
    credentials_id uuid, -- @DEF: remote_adapter_credentials_id_fkey
    manifest jsonb NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_pkey PRIMARY KEY (id);

-- One install per slug per team
ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_team_id_adapter_type_key UNIQUE (team_id, adapter_type);


-- @DEF: remote_adapter_credentials_id_fkey
ALTER TABLE ONLY automations.remote_adapter
    ADD CONSTRAINT remote_adapter_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE TRIGGER remote_adapter_audit AFTER INSERT OR DELETE OR UPDATE ON automations.remote_adapter FOR EACH ROW EXECUTE FUNCTION automations.audit();

-- The trigger's credential pointer is an in-schema foreign key again — it
-- crossed a schema boundary for exactly two chunks (2B dropped it when
-- `trigger` left `knowledge` ahead of the vault). ON DELETE SET NULL is the
-- behaviour that matters: deleting a credential leaves the trigger row alive
-- and unbound rather than deleting the movement's listen index. Both credential
-- delete paths do this by hand today (2B restored them when the FK went); the
-- constraint makes the database the floor again.
ALTER TABLE ONLY automations.trigger
    ADD CONSTRAINT trigger_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE SET NULL;


-- ### Listen-Fire-owned API Tokens (Layer 14.4 substrate) -----------------------
-- Substrate for actor-based echo recognition (3h §Layer 14.4). When the engine
-- writes to an external system using one of these tokens, the source system
-- later surfaces the change with `actor.id` matching one of these rows; the
-- framework's trigger router drops the event at entry.

CREATE TABLE automations.platform_owned_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- opaque tenant id; no foreign key (D3)
    adapter_type text NOT NULL,
    external_token_id text NOT NULL,
    description text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revoked_at timestamp(3) without time zone
);

ALTER TABLE ONLY automations.platform_owned_token
    ADD CONSTRAINT platform_owned_token_pkey PRIMARY KEY (id);


-- Unique (team, adapter, token) tuple — registering the same token twice is a no-op
CREATE UNIQUE INDEX platform_owned_token_unique_idx ON automations.platform_owned_token (team_id, adapter_type, external_token_id) WHERE revoked_at IS NULL;
CREATE INDEX platform_owned_token_team_adapter_idx ON automations.platform_owned_token USING btree (team_id, adapter_type);


-- ### Webhook Subscriptions ---------------------------------------------------
-- Tracks registered inbound webhooks from external systems (Attio, Affinity, etc.)
-- for keeping linked object data fresh.
-- webhook_subscription table

CREATE TABLE automations.webhook_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    provider text NOT NULL,
    -- NULL for credential-free intrinsic channels (the cron adapter's
    -- platform-scheduler registration) -- external services always carry one.
    credentials_id uuid,
    external_webhook_id text,
    webhook_secret text NOT NULL,
    subscriptions jsonb DEFAULT '[]'::jsonb NOT NULL,
    -- Opaque per-subscription cursor for notify-then-pull sources (Airtable):
    -- the ping carries no records, so `Adapter.preprocessInbound` drains the
    -- source's payload feed from here and writes back the advanced cursor.
    -- NULL for push providers (Attio) that deliver full payloads in the body.
    inbound_checkpoint jsonb,
    -- Per-channel scope for adapters whose subscription identity is richer than
    -- (provider, credential): Airtable webhooks are per-(base, table), so the
    -- (base, table) pair lives here and the listen reconciler matches desired vs
    -- existing channels on it. NULL for unscoped channels (Attio, the cron
    -- intrinsic) -- one row per (provider, credential).
    scope jsonb,
    status text DEFAULT 'active' NOT NULL,
    -- Origin marker: NULL = operator-created (Settings UI); 'movement-listen'
    -- = derived by movement listen reconciliation (the per-(adapter,
    -- credential) subscription rows ensureEventSubscription diff-syncs --
    -- only these are auto-retired when the last listen disappears).
    provisioned_by text,
    deleted_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);


ALTER TABLE ONLY automations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_credentials_id_fkey FOREIGN KEY (credentials_id) REFERENCES automations.external_service_credentials(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX webhook_subscription_team_id_idx ON automations.webhook_subscription USING btree (team_id);
CREATE INDEX webhook_subscription_provider_idx ON automations.webhook_subscription USING btree (provider);

CREATE TRIGGER webhook_subscription_audit AFTER INSERT OR DELETE OR UPDATE ON automations.webhook_subscription FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- =============================================================================
-- AUTOMATIONS — channel identity
-- =============================================================================
--
-- A channel product owns the tables that answer "whose is this address / this
-- number / this bot account, and which team does it route to". Phone→team for
-- WhatsApp, address→team for inbound email, telegram-user→email for Telegram:
-- all three are resolved by reading these tables directly, never by a lookup
-- into core's identity data (D28 — the flat global lookup could not express
-- the gates the live paths depend on, and login identity stays core's).


-- ### Phone Number ---------------------------------------------------

CREATE TABLE automations.phone_number (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid, -- opaque user id; no foreign key (D3)
    phone_number text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_test_number boolean DEFAULT false NOT NULL,
    name text,
    word_identifier text,
    emoji_code text,
    verified_at timestamp(3) without time zone, -- ownership proven via the phone_verification code loop; NULL = unverified, and only verified links route inbound WhatsApp
    CONSTRAINT user_phone_number_phone_number_whitespace_check CHECK ((TRIM(BOTH FROM phone_number) = phone_number))
);

ALTER TABLE ONLY automations.phone_number
    ADD CONSTRAINT phone_number_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX phone_number_emoji_code_key ON automations.phone_number USING btree (emoji_code);
CREATE UNIQUE INDEX phone_number_phone_number_key ON automations.phone_number USING btree (phone_number);
CREATE INDEX phone_number_user_id_idx ON automations.phone_number USING btree (user_id);
CREATE UNIQUE INDEX phone_number_word_identifier_key ON automations.phone_number USING btree (word_identifier);

CREATE TRIGGER user_phone_number_audit AFTER INSERT OR DELETE OR UPDATE ON automations.phone_number FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- ### Phone Verification ---------------------------------------------
-- Short-lived WhatsApp OTP codes: a logged-in user proves a number is theirs
-- before it earns phone_number.verified_at. The code is stored hashed; at most
-- one active (unconsumed) row per (user, number) via the partial unique index.

CREATE TABLE automations.phone_verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL, -- opaque user id; no foreign key (D3)
    phone_number text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp(3) without time zone NOT NULL,
    consumed_at timestamp(3) without time zone,
    attempts integer DEFAULT 0 NOT NULL,
    send_count integer DEFAULT 1 NOT NULL,
    last_sent_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY automations.phone_verification
    ADD CONSTRAINT phone_verification_pkey PRIMARY KEY (id);


CREATE UNIQUE INDEX phone_verification_active_key ON automations.phone_verification USING btree (user_id, phone_number) WHERE (consumed_at IS NULL);
CREATE INDEX phone_verification_phone_number_idx ON automations.phone_verification USING btree (phone_number);

CREATE TRIGGER phone_verification_audit AFTER INSERT OR DELETE OR UPDATE ON automations.phone_verification FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- (`whatsapp_conversations` / `whatsapp_messages` and their three enums
-- (`ConversationStatus`, `MessageDirection`, `MessageStatus`) DROPPED at
-- Phase 6 close (D57) — writerless for a long time, no reader whose
-- behavior depended on the tables existing versus being empty. See
-- decisions.md D57 and the migration's own inline grep.)


-- ## Telegram
-- Folded in from the `adapters` schema, unchanged (M-26). That schema existed
-- to keep adapter-owned identity data out of the core data model — the carve's
-- own rationale — and stops earning a schema of its own once `automations` is
-- itself an isolated unit. The deliberate absence of foreign keys into public
-- identity tables is the point, and survives the fold: `email` and
-- `native_user_id` are BARE values.

-- ## Telegram identity
-- The external-id → email binding. Populated only via the authenticated
-- deep-link handshake (anti-hijack). Reverse lookup is by telegram_user_id.

CREATE TABLE automations.telegram_identity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    telegram_user_id text NOT NULL,
    email text NOT NULL,
    linked_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY automations.telegram_identity
    ADD CONSTRAINT telegram_identity_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.telegram_identity
    ADD CONSTRAINT telegram_identity_team_user_key UNIQUE (team_id, telegram_user_id);

CREATE INDEX telegram_identity_telegram_user_id_idx ON automations.telegram_identity USING btree (telegram_user_id);


-- ## Telegram token
-- The one-time deep-link handshake token. Minted by a logged-in session,
-- consumed by the real Telegram account's `/start <token>`. Random + unique +
-- short-lived + single-use (used_at).

CREATE TABLE automations.telegram_token (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    native_user_id uuid NOT NULL,
    team_id uuid NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY automations.telegram_token
    ADD CONSTRAINT telegram_token_pkey PRIMARY KEY (id);

ALTER TABLE ONLY automations.telegram_token
    ADD CONSTRAINT telegram_token_token_key UNIQUE (token);


-- ### Inbound Email Route ----------------------------------------------------
-- Service-address routing for the inbound email door: which team an address
-- that is not a person's login belongs to (a shared inbox, a forwarding
-- proxy), and whether a `+tag` on it still resolves. These are the routing
-- semantics that used to ride on `user_email.is_service_email` /
-- `.accepts_plus_addressing` / `.associated_team_id`; a channel product owns
-- its own address→team table rather than reading core's identity columns,
-- exactly as the phone family does for WhatsApp (carve M-41/D31/D32).
--
-- Scope is deliberately narrow: SERVICE-ADDRESS semantics, not a sender
-- registry. An ordinary person's login address is not in here — the door
-- resolves those through the Directory, which is where login identity lives.
--
-- `address` is globally unique, mirroring `user_email_email_key`: Mailgun hands
-- us a bare address with no team context, so this table is what supplies one.
-- `team_id` carries no foreign key on purpose — team is core's table, and the
-- carve forbids product→core FKs (a dangling row routes nowhere, which the
-- door already handles as "unrecognised").
CREATE TABLE automations.inbound_email_route (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    address public.citext NOT NULL,
    team_id uuid NOT NULL,
    is_service_email boolean DEFAULT false NOT NULL,
    accepts_plus_addressing boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE ONLY automations.inbound_email_route ADD CONSTRAINT inbound_email_route_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX inbound_email_route_address_key ON automations.inbound_email_route USING btree (address);
CREATE INDEX inbound_email_route_team_id_idx ON automations.inbound_email_route USING btree (team_id);
CREATE TRIGGER inbound_email_route_audit AFTER INSERT OR DELETE OR UPDATE ON automations.inbound_email_route FOR EACH ROW EXECUTE FUNCTION automations.audit();




-- =============================================================================
-- AUTOMATIONS — egress + the team's own model key
-- =============================================================================


-- outbound_email — the db-level record of every email we send. Written by the
-- ledger decorator wrapped around whichever outbound email adapter is
-- registered, so nothing escapes: one row per RECIPIENT per send attempt,
-- carrying the outcome the adapter reported. Before this existed a Mailgun 4xx
-- and a successful send were indistinguishable after the fact.
-- `provider` records WHICH adapter was in play — 'unconfigured' is the
-- production/staging-without-MAILGUN_API_KEY stub, whose sends always fail.
-- Append-only runtime log → no audit trigger (excluded in check_database_triggers.sh).
CREATE TABLE automations.outbound_email (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Nullable: plenty of sends (magic links, signup confirmation) precede any team.
    team_id uuid,
    recipient_email text NOT NULL,
    subject text NOT NULL,
    -- What kind of message this was, when the caller knows ('trial_expiry',
    -- 'out_of_credit', 'spend_cap', 'subscription_confirmation', 'usage_alert', …).
    -- Free text on purpose: an unenumerated send should still be logged.
    kind text,
    provider text NOT NULL CONSTRAINT outbound_email_provider_check CHECK (provider IN ('mailgun', 'fake', 'unconfigured')),
    success boolean NOT NULL,
    error text
);
ALTER TABLE ONLY automations.outbound_email ADD CONSTRAINT outbound_email_pkey PRIMARY KEY (id);
CREATE INDEX outbound_email_created_at_idx ON automations.outbound_email USING btree (created_at);
CREATE INDEX outbound_email_team_id_created_at_idx ON automations.outbound_email USING btree (team_id, created_at);
CREATE INDEX outbound_email_failures_idx ON automations.outbound_email USING btree (created_at) WHERE success = false;

-- (Core sends auth mail through the same ledger decorator today, so its rows
-- land here too. The duplication M-5/D12 calls for — core keeping its own copy
-- for auth mail — is an export-time split, not a behaviour change.)


-- (`team_llm_key` was DROPPED with billing. Bringing your own model key
-- existed to keep the metered LLM line off the wallet; with no wallet the
-- deployment's own provider key is the only key.)


-- ## Team settings — the per-team knobs automations owns
--
-- `ops_detail_level` came off `core.team` (Phase 4.4): how much of a run the
-- ops feed keeps is a setting of the product that produces the runs, not an
-- identity fact. Absence of a row means the global default ('low'), so a team
-- gets a row the first time somebody turns the dial.
CREATE TABLE automations.team_settings (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    ops_detail_level automations."OpsDetailLevel" DEFAULT 'low'::automations."OpsDetailLevel" NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY automations.team_settings
    ADD CONSTRAINT team_settings_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX team_settings_team_id_key ON automations.team_settings USING btree (team_id);

CREATE TRIGGER team_settings_audit AFTER INSERT OR DELETE OR UPDATE ON automations.team_settings FOR EACH ROW EXECUTE FUNCTION automations.audit();


-- =============================================================================
-- AUTOMATIONS — Row-Level Security
-- =============================================================================
--
-- Carried verbatim from `knowledge` (the policies key on `team_id`, which
-- survives D3 as an opaque column). Both still call `public.current_team_id()`
-- and the audit triggers above still call `public.audit()` — the unit's two
-- remaining function dependencies on `public`, which become unit-owned copies
-- when the products actually separate (5_valuations.md's audit note, K-11).
-- Until then a `pg_dump --schema=automations` needs those two functions present
-- plus the `citext` extension; the tables, constraints and indexes need nothing
-- else outside the schema.

GRANT USAGE ON SCHEMA automations TO agent;

-- trigger
GRANT SELECT ON automations.trigger TO agent;
ALTER TABLE automations.trigger ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON automations.trigger FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON automations.trigger FOR SELECT TO agent USING (team_id::text = automations.current_team_id());

-- movement
GRANT SELECT ON automations.movement TO agent;
ALTER TABLE automations.movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY non_agent_full_access ON automations.movement FOR ALL USING (current_user != 'agent');
CREATE POLICY agent_team_isolation ON automations.movement FOR SELECT TO agent USING (team_id::text = automations.current_team_id());


--
-- Audit triggers for user-modifiable tables. The audit log is a short trail
-- of changes a user might have made in error, so we audit data the user can
-- modify or delete — not append-only/event/system tables (those are in the
-- exclude list in scripts/check_database_triggers.sh).

CREATE TRIGGER team_usage_config_audit AFTER INSERT OR DELETE OR UPDATE ON public.team_usage_config FOR EACH ROW EXECUTE FUNCTION public.audit();


-------------------------------------------------------------------------------------------------------------------------
-------------------------------------------------------------------------------------------------------------------------
-- #############################################################################
-- # VALUATIONS SCHEMA
-- #############################################################################
--
-- The portfolio-valuation unit (5_valuations.md). A company/person record
-- (`legal_entity`) and the economic-event ledger built on it
-- (`event` -> `investment` -> `transaction` -> `asset_transfer` -> `asset`/`price`).
--
-- D3: no FK crosses the schema boundary. `team_id`, `user_id`, `created_by`
-- and `point_of_contact_user_id` are opaque uuids here; the queries carry the
-- tenant filter and the Principal resolves the people.
-------------------------------------------------------------------------------------------------------------------------
-------------------------------------------------------------------------------------------------------------------------

-- The schema and its enums are created up in `# TYPES` — dealflow tables that
-- have not died yet still name those enums, and this file applies in order.
--
-- The `agent` role reads this schema under RLS; USAGE is a property of the
-- schema, not of the tables, so it does not travel with `SET SCHEMA`.
GRANT USAGE ON SCHEMA valuations TO agent;

-- ## Session context — the unit's own GUCs (V-17)
--
-- The audit and outbox triggers used to read `core.current_*`, set by core's
-- request wrapper. Under the static-stub Principal there IS no core, so that
-- dependency would silently null every actor. The unit owns its own settings
-- and its own accessors; whoever wraps the request sets them from the
-- Principal.

CREATE FUNCTION valuations.set_session_context(
    p_team_id text,
    p_actor_type text,
    p_actor_id text,
    p_context_id text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('valuations.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('valuations.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('valuations.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('valuations.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;

CREATE FUNCTION valuations.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.team_id', TRUE), '');
$$;

CREATE FUNCTION valuations.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.actor_type', TRUE), '');
$$;

CREATE FUNCTION valuations.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.actor_id', TRUE), '');
$$;

CREATE FUNCTION valuations.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('valuations.context_id', TRUE), '');
$$;


-- ## Audit log — the unit's own
--
-- `public.audit()` writes to `public.audit_log`, which is residual operator-ops
-- (D8) and does not travel with this unit. The trail for a valuations table
-- has to land inside the schema, or the export loses it.

CREATE TABLE valuations.audit_log (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op valuations."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);

ALTER TABLE ONLY valuations.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

CREATE SEQUENCE valuations.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE valuations.audit_log_version_seq OWNED BY valuations.audit_log.version;
ALTER TABLE ONLY valuations.audit_log ALTER COLUMN version SET DEFAULT nextval('valuations.audit_log_version_seq'::regclass);

CREATE INDEX valuations_audit_log_context_id_idx ON valuations.audit_log USING btree (context_id);
CREATE INDEX valuations_audit_log_created_at_idx ON valuations.audit_log USING btree (created_at);
CREATE INDEX valuations_audit_log_model_id_idx ON valuations.audit_log USING btree (model_id);
CREATE INDEX valuations_audit_log_version_idx ON valuations.audit_log USING btree (version);

CREATE FUNCTION valuations.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = valuations.current_actor_id();
  NEW.team_id = NULLIF(valuations.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(valuations.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON valuations.audit_log FOR EACH ROW EXECUTE FUNCTION valuations.set_created_fields();

CREATE FUNCTION valuations.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO valuations.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::valuations."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;






CREATE FUNCTION valuations.legal_entity_search_vector_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.legal_name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.also_known_as, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.other_names, ' '), '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.personal_website, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.country, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'D') ||
    to_tsvector('english', coalesce(array_to_string(ARRAY_CAT(ARRAY_CAT(NEW.business_model, NEW.customers), ARRAY_CAT(NEW.markets,NEW.themes)), ' '), ''));
  RETURN NEW;
END
$$;


-- ### Valuations Change Outbox ----------------------------------------------
-- Captures every INSERT/UPDATE/DELETE on valuations entity tables for webhook
-- delivery. A worker drains rows in occurred_at order and produces
-- OutboundWebhookRequest records via the existing webhook framework.

CREATE TABLE valuations.valuations_change_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity text NOT NULL,
    change_type valuations."NativeDatabaseOperation" NOT NULL,
    row_id uuid NOT NULL,
    team_id uuid NOT NULL,
    actor_type text,
    actor_id uuid,
    context_id text,
    "before" jsonb,
    "after" jsonb,
    occurred_at timestamptz DEFAULT now() NOT NULL,
    processed_at timestamptz
);

ALTER TABLE ONLY valuations.valuations_change_outbox
    ADD CONSTRAINT valuations_change_outbox_pkey PRIMARY KEY (id);

CREATE INDEX valuations_change_outbox_unprocessed_idx ON valuations.valuations_change_outbox (occurred_at) WHERE processed_at IS NULL;
CREATE INDEX valuations_change_outbox_occurred_at_idx ON valuations.valuations_change_outbox USING btree (occurred_at);
CREATE INDEX valuations_change_outbox_team_id_idx ON valuations.valuations_change_outbox USING btree (team_id);

CREATE FUNCTION valuations.valuations_outbox_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_actor_type text;
  v_actor_id uuid;
  v_team_id uuid;
  v_row_id uuid;
BEGIN
  -- V-17: the actor arrives on the unit's own GUCs, set from the Principal.
  -- Absent them (a worker, a migration) the write is the system's.
  v_actor_type := COALESCE(valuations.current_actor_type(), 'system');
  v_actor_id := NULLIF(valuations.current_actor_id(), '')::uuid;

  IF TG_OP = 'DELETE' THEN
    v_team_id := OLD.team_id;
    v_row_id := OLD.id;
  ELSE
    v_team_id := NEW.team_id;
    v_row_id := NEW.id;
  END IF;

  -- Shared rows (team_id IS NULL) have no webhook subscribers, and the outbox
  -- requires a team_id; capturing them would abort the parent write.
  IF v_team_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  INSERT INTO valuations.valuations_change_outbox (
    entity,
    change_type,
    row_id,
    team_id,
    actor_type,
    actor_id,
    context_id,
    "before",
    "after"
  ) VALUES (
    TG_TABLE_NAME,
    TG_OP::valuations."NativeDatabaseOperation",
    v_row_id,
    v_team_id,
    v_actor_type,
    v_actor_id,
    valuations.current_context_id(),
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END
  );

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
-- ### Legal Entity -----------------------------------------------




CREATE TABLE valuations.legal_entity (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text,
    image_url text,
    description text,
    country text,
    city text,
    personal_website text,
    type valuations."LegalEntityType",
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    inferred_thesis text,
    locations text[] DEFAULT ARRAY[]::text[],
    public_profile_id uuid, -- @DEF: legal_entity_public_profile_id_fkey
    stages text[] DEFAULT ARRAY[]::text[],
    team_id uuid,
    themes text[] DEFAULT ARRAY[]::text[],
    linkedin text,
    operated_by_profile_id uuid, -- @DEF: legal_entity_operated_by_profile_id_fkey
    business_model text[] DEFAULT ARRAY[]::text[],
    customers text[] DEFAULT ARRAY[]::text[],
    markets text[] DEFAULT ARRAY[]::text[],
    short_description text,
    investment_status valuations."InvestmentStatus" DEFAULT 'ACTIVE'::valuations."InvestmentStatus" NOT NULL,
    descriptors_geo text[] DEFAULT ARRAY[]::text[],
    descriptors_investor_type text[] DEFAULT ARRAY[]::text[],
    descriptors_misc_tags text[] DEFAULT ARRAY[]::text[],
    descriptors_stage text[] DEFAULT ARRAY[]::text[],
    email text,
    identifiers text[] DEFAULT ARRAY[]::text[],
    summary_for_similarity_search text,
    market_short text,
    linkedin_data jsonb,
    is_own_investing_entity boolean,
    company_metrics_id uuid,
    company_profile_id uuid,
    investing_entity_id uuid, -- @DEF: legal_entity_investing_entity_id_fkey
    is_deprecated boolean,
    is_portfolio boolean,
    legal_name text,
    name text NOT NULL,
    also_known_as text,
    acquired_by_legal_entity_id uuid, -- @DEF: legal_entity_acquired_by_legal_entity_id_fkey
    search_vector tsvector,
    underlying_company_id uuid, -- @DEF: legal_entity_underlying_company_id_fkey
    custom_values jsonb DEFAULT '{}'::jsonb,
    point_of_contact_user_id uuid,
    acquired_at timestamp(3) without time zone,
    acquired_event_id uuid,
    legal_status valuations."CompanyLegalStatus" DEFAULT 'ACTIVE'::valuations."CompanyLegalStatus" NOT NULL,
    other_names text[] DEFAULT ARRAY[]::text[],
    sentiment_score double precision,
    visibility_score double precision,
    invitation_code text,
    sectors text[] DEFAULT ARRAY[]::text[],
    experiments_active text[] DEFAULT ARRAY[]::text[],
    word_identifier text,
    CONSTRAINT investor_profile_slug_whitespace_check CHECK ((TRIM(BOTH FROM slug) = slug))
);

COMMENT ON TABLE valuations.legal_entity IS 'A legal entity represents a company, person, fund, or other organization. "legal_entity" is used interchangeably with "profile" in the application.';
COMMENT ON COLUMN valuations.legal_entity.type IS 'The type of legal entity, such as company, fund, or natural person. See valuations."LegalEntityType" for possible values.';

ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_pkey PRIMARY KEY (id);

-- @DEF: legal_entity_acquired_by_legal_entity_id_fkey
ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_acquired_by_legal_entity_id_fkey FOREIGN KEY (acquired_by_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: legal_entity_investing_entity_id_fkey
ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_investing_entity_id_fkey FOREIGN KEY (investing_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: legal_entity_operated_by_profile_id_fkey
ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_operated_by_profile_id_fkey FOREIGN KEY (operated_by_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: legal_entity_public_profile_id_fkey
ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_public_profile_id_fkey FOREIGN KEY (public_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: legal_entity_underlying_company_id_fkey
ALTER TABLE ONLY valuations.legal_entity
    ADD CONSTRAINT legal_entity_underlying_company_id_fkey FOREIGN KEY (underlying_company_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;



CREATE INDEX legal_entity_acquired_by_legal_entity_id_idx ON valuations.legal_entity USING btree (acquired_by_legal_entity_id);
CREATE UNIQUE INDEX legal_entity_company_metrics_id_key ON valuations.legal_entity USING btree (company_metrics_id);
CREATE INDEX legal_entity_identifiers_idx ON valuations.legal_entity USING gin (identifiers);
CREATE UNIQUE INDEX legal_entity_invitation_code_key ON valuations.legal_entity USING btree (invitation_code);
CREATE INDEX legal_entity_legal_name_trgm_idx ON valuations.legal_entity USING gin (legal_name public.gin_trgm_ops);
CREATE INDEX legal_entity_name_trgm_idx ON valuations.legal_entity USING gin (name public.gin_trgm_ops);
CREATE INDEX legal_entity_search_vector_idx ON valuations.legal_entity USING gin (search_vector);
CREATE UNIQUE INDEX legal_entity_slug_key ON valuations.legal_entity USING btree (slug);
CREATE UNIQUE INDEX legal_entity_word_identifier_key ON valuations.legal_entity USING btree (word_identifier);


CREATE TRIGGER legal_entity_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER legal_entity_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();
CREATE TRIGGER legal_entity_search_vector_update BEFORE INSERT OR UPDATE ON valuations.legal_entity FOR EACH ROW EXECUTE FUNCTION valuations.legal_entity_search_vector_update();


-- ### Row-Level Security Policies -------------------------------------

-- Grant agent role SELECT access (role itself is created by deploy/postgres-init/00-roles.sql)
GRANT SELECT ON valuations.legal_entity TO agent;

ALTER TABLE valuations.legal_entity ENABLE ROW LEVEL SECURITY;

-- Policy for non-agent users: unrestricted access
-- This replaces the need for BYPASSRLS (which isn't available on managed databases)
CREATE POLICY non_agent_full_access ON valuations.legal_entity
    FOR ALL
    USING (current_user != 'agent');

-- Policy for agent role: restrict to team_id when set in context
CREATE POLICY agent_team_isolation ON valuations.legal_entity
    FOR SELECT
    TO agent
    USING (
        -- If team_id is set, only allow access when it matches the current context
        -- If team_id is NULL, allow access (for shared/global data)
        team_id IS NULL OR team_id::text = valuations.current_team_id()
    );

-- ### Event ------------------------------------------------------




CREATE TABLE valuations.event (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    date date NOT NULL,
    legal_entity_id uuid NOT NULL, -- @DEF: event_legal_entity_id_fkey
    name text NOT NULL,
    type valuations."EventType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    data jsonb,
    acquirer_id uuid, -- @DEF: event_acquirer_id_fkey
    asset_type valuations."AssetType",
    investment_round_type valuations."InvestmentRoundType" DEFAULT 'EQUITY'::valuations."InvestmentRoundType",
    public_round_id uuid,
    raised_amount double precision,
    raised_currency valuations."CurrencyIsoCode",
    round_type valuations."EquityRoundType",
    url_press_release text,
    valuation double precision,
    valuation_currency valuations."CurrencyIsoCode",
    valuation_type valuations."ValuationType"
);

ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_pkey PRIMARY KEY (id);

-- @DEF: event_acquirer_id_fkey
ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_acquirer_id_fkey FOREIGN KEY (acquirer_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: event_legal_entity_id_fkey
ALTER TABLE ONLY valuations.event
    ADD CONSTRAINT event_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX event_date_legal_entity_id_type_idx ON valuations.event USING btree (date, legal_entity_id, type);

CREATE TRIGGER event_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.event FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER event_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.event FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();

GRANT SELECT ON valuations.event TO agent;

ALTER TABLE valuations.event ENABLE ROW LEVEL SECURITY;

CREATE POLICY non_agent_full_access ON valuations.event
    FOR ALL
    USING (current_user != 'agent');

CREATE POLICY agent_team_isolation ON valuations.event
    FOR SELECT
    TO agent
    USING (
       team_id IS NULL OR team_id::text = valuations.current_team_id()
    );


-- ### Investment ---------------------------------------------------


CREATE TABLE valuations.investment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    investor_profile_id uuid NOT NULL, -- @DEF: investment_investor_profile_id_fkey
    investment_profile_id uuid NOT NULL, -- @DEF: investment_investment_profile_id_fkey
    round_type valuations."EquityRoundType",
    invested_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    team_id uuid,
    verified boolean DEFAULT false NOT NULL,
    public_round_id uuid,
    event_id uuid, -- @DEF: investment_event_id_fkey
    fully_exited_at timestamp(3) without time zone,
    exit_event_id uuid,
    type valuations."InvestmentType" DEFAULT 'CASH'::valuations."InvestmentType" NOT NULL
);

ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_pkey PRIMARY KEY (id);

-- @DEF: investment_event_id_fkey
ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: investment_investment_profile_id_fkey
ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_investment_profile_id_fkey FOREIGN KEY (investment_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: investment_investor_profile_id_fkey
ALTER TABLE ONLY valuations.investment
    ADD CONSTRAINT investment_investor_profile_id_fkey FOREIGN KEY (investor_profile_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX investment_investment_profile_id_idx ON valuations.investment USING btree (investment_profile_id);
CREATE INDEX investment_investor_profile_id_idx ON valuations.investment USING btree (investor_profile_id);
CREATE INDEX investment_public_round_id_idx ON valuations.investment USING btree (public_round_id);

CREATE TRIGGER investment_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.investment FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER investment_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.investment FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();

GRANT SELECT ON valuations.investment TO agent;

ALTER TABLE valuations.investment ENABLE ROW LEVEL SECURITY;

CREATE POLICY non_agent_full_access ON valuations.investment
    FOR ALL
    USING (current_user != 'agent');

CREATE POLICY agent_team_isolation ON valuations.investment
    FOR SELECT
    TO agent
    USING (
       team_id IS NULL OR team_id::text = valuations.current_team_id()
    );

-- ### Investment Attribution ----------------------------------------

CREATE TABLE valuations.investment_attribution (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    investment_id uuid NOT NULL, -- @DEF: investment_attribution_investment_id_fkey
    legal_entity_id uuid NOT NULL, -- @DEF: investment_attribution_legal_entity_id_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_pkey PRIMARY KEY (id);

-- @DEF: investment_attribution_investment_id_fkey
ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES valuations.investment(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: investment_attribution_legal_entity_id_fkey
ALTER TABLE ONLY valuations.investment_attribution
    ADD CONSTRAINT investment_attribution_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX investment_attribution_investment_id_idx ON valuations.investment_attribution USING btree (investment_id);

CREATE TRIGGER investment_attribution_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.investment_attribution FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE INDEX investment_attribution_legal_entity_id_idx ON valuations.investment_attribution USING btree (legal_entity_id);

-- TODO: missing audit trigger!

GRANT SELECT ON valuations.investment_attribution TO agent;

ALTER TABLE valuations.investment_attribution ENABLE ROW LEVEL SECURITY;

CREATE POLICY non_agent_full_access ON valuations.investment_attribution
    FOR ALL
    USING (current_user != 'agent');

CREATE POLICY agent_team_isolation ON valuations.investment_attribution
    FOR SELECT
    TO agent
    USING (
     EXISTS(
      SELECT 1 FROM valuations.investment i WHERE i.id = investment_id AND (
       team_id IS NULL OR team_id::text = valuations.current_team_id()
      )
     )
    );


-- ### Potential Duplicate Legal Entity -------------------------------




-- ### Transaction -----------------------------------------------------------

CREATE TABLE valuations.transaction (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    close_date date NOT NULL,
    event_id uuid, -- @DEF: transaction_event_id_fkey
    converted_to_id uuid, -- @DEF: transaction_converted_to_id_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    investment_id uuid, -- @DEF: transaction_investment_id_fkey
    due_to_rights_from_asset_id uuid -- @DEF: transaction_due_to_rights_from_asset_id_fkey
);


ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_pkey PRIMARY KEY (id);

-- @DEF: transaction_converted_to_id_fkey
ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_converted_to_id_fkey FOREIGN KEY (converted_to_id) REFERENCES valuations.transaction(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: transaction_event_id_fkey
ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: transaction_investment_id_fkey
ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_investment_id_fkey FOREIGN KEY (investment_id) REFERENCES valuations.investment(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX transaction_close_date_idx ON valuations.transaction USING btree (close_date);
CREATE UNIQUE INDEX transaction_converted_to_id_key ON valuations.transaction USING btree (converted_to_id);
CREATE INDEX transaction_event_id_idx ON valuations.transaction USING btree (event_id);
CREATE INDEX transaction_investment_id_idx ON valuations.transaction USING btree (investment_id);

CREATE TRIGGER transaction_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.transaction FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER transaction_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.transaction FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();



-- ### Asset ---------------------------------------------------------------


CREATE TABLE valuations.asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid,
    issued_by_legal_entity_id uuid, -- @DEF: asset_issued_by_legal_entity_id_fkey
    name text NOT NULL,
    properties jsonb NOT NULL,
    type valuations."AssetType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    annualised_interest_rate double precision,
    conversion_date date,
    conversion_price double precision,
    convertible_amount double precision,
    convertible_currency valuations."CurrencyIsoCode",
    convertible_investor_id uuid, -- @DEF: asset_convertible_investor_id_fkey
    convertible_type valuations."ConvertibleType",
    discount_rate double precision,
    interest double precision,
    issued_at date,
    maturity_date date,
    valuation_cap double precision
);


ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);

-- @DEF: asset_convertible_investor_id_fkey
ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_convertible_investor_id_fkey FOREIGN KEY (convertible_investor_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: asset_issued_by_legal_entity_id_fkey
ALTER TABLE ONLY valuations.asset
    ADD CONSTRAINT asset_issued_by_legal_entity_id_fkey FOREIGN KEY (issued_by_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- @DEF: transaction_due_to_rights_from_asset_id_fkey
ALTER TABLE ONLY valuations.transaction
    ADD CONSTRAINT transaction_due_to_rights_from_asset_id_fkey FOREIGN KEY (due_to_rights_from_asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX asset_issued_by_legal_entity_id_idx ON valuations.asset USING btree (issued_by_legal_entity_id);
CREATE INDEX asset_name_idx ON valuations.asset USING btree (name);
CREATE INDEX asset_type_idx ON valuations.asset USING btree (type);

CREATE TRIGGER asset_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.asset FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER asset_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.asset FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();



-- ### Currency Asset -------------------------------------------------------

CREATE TABLE valuations.currency_asset (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL, -- @DEF: currency_asset_asset_id_fkey
    iso_code valuations."CurrencyIsoCode" NOT NULL,
    name text NOT NULL,
    symbol text NOT NULL,
    pair_order smallint NOT NULL,
    type valuations."AssetType" DEFAULT 'CURRENCY'::valuations."AssetType" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY valuations.currency_asset
    ADD CONSTRAINT currency_asset_pkey PRIMARY KEY (id);

-- @DEF: currency_asset_asset_id_fkey
ALTER TABLE ONLY valuations.currency_asset
    ADD CONSTRAINT currency_asset_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE UNIQUE INDEX currency_asset_asset_id_key ON valuations.currency_asset USING btree (asset_id);
CREATE UNIQUE INDEX currency_asset_iso_code_key ON valuations.currency_asset USING btree (iso_code);

CREATE TRIGGER currency_asset_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.currency_asset FOR EACH ROW EXECUTE FUNCTION valuations.audit();



-- ### Price ---------------------------------------------------------------


CREATE TABLE valuations.price (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    date date NOT NULL,
    price double precision NOT NULL,
    currency valuations."CurrencyIsoCode" NOT NULL,
    asset_id uuid, -- @DEF: price_asset_id_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    event_id uuid, -- @DEF: price_event_id_fkey
    type valuations."PriceType" NOT NULL,
    legal_entity_id uuid -- @DEF: price_legal_entity_id_fkey
);


ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_pkey PRIMARY KEY (id);

-- @DEF: price_asset_id_fkey
ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: price_event_id_fkey
ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_event_id_fkey FOREIGN KEY (event_id) REFERENCES valuations.event(id) ON UPDATE CASCADE ON DELETE SET NULL;
-- @DEF: price_legal_entity_id_fkey
ALTER TABLE ONLY valuations.price
    ADD CONSTRAINT price_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE UNIQUE INDEX price_asset_id_date_key ON valuations.price USING btree (asset_id, date);
CREATE INDEX price_date_idx ON valuations.price USING btree (date);
CREATE INDEX price_legal_entity_id_idx ON valuations.price USING btree (legal_entity_id);

CREATE TRIGGER price_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.price FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER price_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.price FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();



-- ### Asset Transfer -------------------------------------------------------

CREATE TABLE valuations.asset_transfer (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    asset_id uuid NOT NULL, -- @DEF: asset_transfer_asset_id_fkey
    date date NOT NULL,
    from_legal_entity_id uuid NOT NULL, -- @DEF: asset_transfer_from_legal_entity_id_fkey
    num_assets double precision,
    to_legal_entity_id uuid NOT NULL, -- @DEF: asset_transfer_to_legal_entity_id_fkey
    transaction_id uuid NOT NULL, -- @DEF: asset_transfer_transaction_id_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_pkey PRIMARY KEY (id);

-- @DEF: asset_transfer_asset_id_fkey
ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES valuations.asset(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: asset_transfer_from_legal_entity_id_fkey
ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_from_legal_entity_id_fkey FOREIGN KEY (from_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: asset_transfer_to_legal_entity_id_fkey
ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_to_legal_entity_id_fkey FOREIGN KEY (to_legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: asset_transfer_transaction_id_fkey
ALTER TABLE ONLY valuations.asset_transfer
    ADD CONSTRAINT asset_transfer_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES valuations.transaction(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX asset_transfer_asset_id_idx ON valuations.asset_transfer USING btree (asset_id);
CREATE INDEX asset_transfer_date_idx ON valuations.asset_transfer USING btree (date);
CREATE INDEX asset_transfer_from_legal_entity_id_idx ON valuations.asset_transfer USING btree (from_legal_entity_id);
CREATE INDEX asset_transfer_to_legal_entity_id_idx ON valuations.asset_transfer USING btree (to_legal_entity_id);
CREATE INDEX asset_transfer_transaction_id_idx ON valuations.asset_transfer USING btree (transaction_id);

CREATE TRIGGER asset_transfer_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.asset_transfer FOR EACH ROW EXECUTE FUNCTION valuations.audit();
CREATE TRIGGER asset_transfer_valuations_outbox AFTER INSERT OR DELETE OR UPDATE ON valuations.asset_transfer FOR EACH ROW EXECUTE FUNCTION valuations.valuations_outbox_capture();


-- ### Funding Changelog ---------------------------------------------------

CREATE TABLE valuations.funding_changelog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    legal_entity_id uuid NOT NULL,
    user_id uuid,
    description text NOT NULL,
    category text,
    event_date date,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY valuations.funding_changelog
    ADD CONSTRAINT funding_changelog_pkey PRIMARY KEY (id);


ALTER TABLE ONLY valuations.funding_changelog
    ADD CONSTRAINT funding_changelog_legal_entity_id_fkey FOREIGN KEY (legal_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE CASCADE;


CREATE INDEX idx_funding_changelog_team_entity ON valuations.funding_changelog USING btree (team_id, legal_entity_id, created_at DESC);


CREATE TABLE valuations.funding_changelog_fund (
    changelog_id uuid NOT NULL,
    fund_id uuid NOT NULL
);

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_pkey PRIMARY KEY (changelog_id, fund_id);

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_changelog_id_fkey FOREIGN KEY (changelog_id) REFERENCES valuations.funding_changelog(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY valuations.funding_changelog_fund
    ADD CONSTRAINT funding_changelog_fund_fund_id_fkey FOREIGN KEY (fund_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX idx_funding_changelog_fund_fund ON valuations.funding_changelog_fund USING btree (fund_id);


-- ### Exchange Rate -------------------------------------------------------

CREATE TABLE valuations.exchange_rate (
    date date NOT NULL,
    from_currency valuations."CurrencyIsoCode" NOT NULL,
    rate double precision NOT NULL,
    to_currency valuations."CurrencyIsoCode" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


ALTER TABLE ONLY valuations.exchange_rate
    ADD CONSTRAINT exchange_rate_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX exchange_rate_date_from_currency_to_currency_key ON valuations.exchange_rate USING btree (date, from_currency, to_currency);

CREATE TRIGGER exchange_rate_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.exchange_rate FOR EACH ROW EXECUTE FUNCTION valuations.audit();
-- ### Webhook subscription --------------------------------------------------
-- Where this unit's row changes go. The pair below replaces the legacy
-- `webhook` / `outbound_webhook_request` tables, which were built for several
-- producers and only ever had this one (D18) — so the generality (`version`, a
-- per-row `maxRetries`) was paying rent it never earned, and the shape it
-- imposed was shared with a worker in another unit. ~200 LOC and two tables of
-- our own beats a dependency across the carve line (D12, D24, V-16). The public
-- `POST/GET/DELETE /v1/valuations/webhooks` contract is unchanged.

CREATE TABLE valuations.webhook_subscription (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,                 -- opaque tenant id; NO foreign key (D3)
    url text NOT NULL,
    event_type text NOT NULL,              -- valuations:<entity>:<create|update|delete>
    secret text,                           -- HMAC-SHA256 key for outbound signing; NULL means unsigned
    name text NOT NULL,
    disabled_at timestamptz,
    deleted_at timestamptz,                -- soft delete: queued deliveries to a removed destination stop, they do not retry to exhaustion
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY valuations.webhook_subscription
    ADD CONSTRAINT webhook_subscription_pkey PRIMARY KEY (id);

CREATE INDEX webhook_subscription_team_event_idx ON valuations.webhook_subscription USING btree (team_id, event_type) WHERE (deleted_at IS NULL);

CREATE TRIGGER webhook_subscription_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.webhook_subscription FOR EACH ROW EXECUTE FUNCTION valuations.audit();


-- ### Outbound delivery -----------------------------------------------------
-- One row per (change, subscription). The URL and secret are read through the
-- subscription rather than copied, so deleting a destination stops its queued
-- deliveries in the same breath.

CREATE TABLE valuations.outbound_delivery (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subscription_id uuid NOT NULL,         -- @DEF: outbound_delivery_subscription_id_fkey
    team_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamptz,
    delivered_at timestamptz,
    last_error text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY valuations.outbound_delivery
    ADD CONSTRAINT outbound_delivery_pkey PRIMARY KEY (id);

-- @DEF: outbound_delivery_subscription_id_fkey
ALTER TABLE ONLY valuations.outbound_delivery
    ADD CONSTRAINT outbound_delivery_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES valuations.webhook_subscription(id) ON DELETE CASCADE;

CREATE INDEX outbound_delivery_undelivered_idx ON valuations.outbound_delivery USING btree (created_at) WHERE (delivered_at IS NULL);


-- ### Worker heartbeat ------------------------------------------------------
-- The delivery worker is the only thing that carries a valuations change out of
-- the unit, and a stopped one is a silent outage rather than an error. Same
-- liveness row, same reason, as knowledge's and asks' (D30e).

CREATE TABLE valuations.worker_heartbeat (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker text NOT NULL,
    last_beat_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_success_at timestamptz,
    last_error text,
    detail jsonb
);

ALTER TABLE ONLY valuations.worker_heartbeat
    ADD CONSTRAINT worker_heartbeat_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX valuations_worker_heartbeat_worker_idx ON valuations.worker_heartbeat USING btree (worker);
-- ### Note ------------------------------------------------------------------


CREATE TABLE valuations.note (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    message text NOT NULL,
    note_type valuations."NoteType" NOT NULL,
    reference_id uuid NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL,
    updated_by uuid,
    source text
);


ALTER TABLE ONLY valuations.note
    ADD CONSTRAINT note_pkey PRIMARY KEY (id);


CREATE INDEX note_note_type_idx ON valuations.note USING btree (note_type);
CREATE INDEX note_reference_id_idx ON valuations.note USING btree (reference_id);

CREATE TRIGGER note_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.note FOR EACH ROW EXECUTE FUNCTION valuations.audit();


-- ### Team Settings ---------------------------------------------------------
-- D6/V-6: the per-team investing-profile pointers that used to sit on core's
-- `team` (`team_profile_id`, `default_investing_profile_id`). The semantics are
-- valuations' — which entity IS this team, and which of its funds does a new
-- investment default to — so core should not carry them, and a self-hoster
-- running valuations alone still needs them.
--
-- `reporting_currency` is new: the list page's currency selector is
-- querystring-only today, and a per-team default is what an operator expects.
-- `team.auto_add_company_to_portfolio_via_update` is NOT carried over — its
-- only reader is the dealflow pipeline.
--
-- Keyed by `id` rather than by `team_id` (doc 5 sketched the latter) because an
-- audited table must have an `id`: `audit()` stamps `NEW.id` as the model id,
-- and an id-less audited table fails every write.

CREATE TABLE valuations.team_settings (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    own_entity_id uuid,
    default_investing_entity_id uuid,
    reporting_currency valuations."CurrencyIsoCode",
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_pkey PRIMARY KEY (id);
ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_own_entity_id_fkey FOREIGN KEY (own_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;
ALTER TABLE ONLY valuations.team_settings
    ADD CONSTRAINT team_settings_default_investing_entity_id_fkey FOREIGN KEY (default_investing_entity_id) REFERENCES valuations.legal_entity(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE UNIQUE INDEX team_settings_team_id_key ON valuations.team_settings USING btree (team_id);

CREATE TRIGGER team_settings_audit AFTER INSERT OR DELETE OR UPDATE ON valuations.team_settings FOR EACH ROW EXECUTE FUNCTION valuations.audit();


-------------------------------------------------------------------------------------------------------------------------
-- ## Public objects that depend on the valuations schema
-------------------------------------------------------------------------------------------------------------------------
--
-- `profile_role` has no team column of its own, so its agent-isolation policy
-- has to reach through `legal_entity` — which now lives in `valuations`. The
-- dependency points from the DYING side into the unit, which is the direction
-- D3 tolerates; the policy dies with the table (V-9).

GRANT SELECT ON public.profile_role TO agent;

ALTER TABLE public.profile_role ENABLE ROW LEVEL SECURITY;

CREATE POLICY non_agent_full_access ON public.profile_role
    FOR ALL
    USING (current_user != 'agent');

CREATE POLICY agent_team_isolation ON public.profile_role
    FOR SELECT
    TO agent
    USING (
     EXISTS(
      SELECT 1 FROM valuations.legal_entity le WHERE le.id = profile_id AND (
       team_id IS NULL OR team_id::text = valuations.current_team_id()
      )
     )
    );


-- #############################################################################
-- # CORE SCHEMA
-- #############################################################################
--
-- The identity unit (3_core.md). Core's one job is to turn an inbound
-- credential into a Principal — {teamId, userId?, access, scopes} — and to let
-- humans manage the teams, members and credentials behind it. It knows nothing
-- about pipelines, graphs, valuations or wallets.
--
-- D3: no FK crosses the schema boundary, and core is the schema everything else
-- used to point AT. The ~90 `team_id` / `user_id` / `created_by` constraints
-- that reached in here are gone; those columns survive as opaque uuids and the
-- application carries the tenant filter. Only the nine tables below still
-- reference each other, and all of those references are in-schema.
--
-- The schema and its two enums are created up in `# TYPES`, following the
-- valuations precedent: this file is applied top to bottom and a unit's types
-- must exist before anything names them.
-------------------------------------------------------------------------------------------------------------------------
-------------------------------------------------------------------------------------------------------------------------

-- ## Session context — the unit's own GUCs
--
-- `public.set_current_*` / `public.current_*` are core's OWN session settings
-- wearing public's clothes: they were minted here, and every other unit that
-- reads them (knowledge's and automations' RLS, the residual audit trail) is
-- borrowing. The borrowing stays until Phase 3 gives those units their own
-- names; what changes here is that core stops depending on the loan. Its audit
-- trail reads `core.*`, set from the same Principal at the same transaction
-- entry point, so a standalone core attributes its writes correctly with no
-- `public` schema present at all (D35(c)).

CREATE FUNCTION core.set_session_context(
    p_team_id text,
    p_actor_type text,
    p_actor_id text,
    p_context_id text
) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM set_config('core.team_id', COALESCE(p_team_id, ''), TRUE),
          set_config('core.actor_type', COALESCE(p_actor_type, ''), TRUE),
          set_config('core.actor_id', COALESCE(p_actor_id, ''), TRUE),
          set_config('core.context_id', COALESCE(p_context_id, ''), TRUE);
END;
$$;

CREATE FUNCTION core.current_team_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.team_id', TRUE), '');
$$;

CREATE FUNCTION core.current_actor_type() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.actor_type', TRUE), '');
$$;

CREATE FUNCTION core.current_actor_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.actor_id', TRUE), '');
$$;

CREATE FUNCTION core.current_context_id() RETURNS text
    LANGUAGE sql
    AS $$
  SELECT NULLIF(current_setting('core.context_id', TRUE), '');
$$;


-- ## Audit log — the unit's own
--
-- Every one of core's nine tables is audited, and `public.audit_log` is
-- residual operator-ops (D8) that does not travel with the unit. Who changed a
-- membership, who revoked an api key, when an account was activated — that
-- trail is the identity unit's own evidence and has to land inside the schema.
--
-- `public.audit()` STAYS where it is: automations', knowledge's and asks'
-- tables still call it, and their unit-owned audit is Phase 3's work.

CREATE TABLE core.audit_log (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    version bigint NOT NULL,
    model_id uuid,
    team_id uuid,
    context_id uuid,
    op core."NativeDatabaseOperation" NOT NULL,
    table_name text NOT NULL,
    old jsonb,
    new jsonb
);

ALTER TABLE ONLY core.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

CREATE SEQUENCE core.audit_log_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE core.audit_log_version_seq OWNED BY core.audit_log.version;
ALTER TABLE ONLY core.audit_log ALTER COLUMN version SET DEFAULT nextval('core.audit_log_version_seq'::regclass);

CREATE INDEX core_audit_log_context_id_idx ON core.audit_log USING btree (context_id);
CREATE INDEX core_audit_log_created_at_idx ON core.audit_log USING btree (created_at);
CREATE INDEX core_audit_log_model_id_idx ON core.audit_log USING btree (model_id);
CREATE INDEX core_audit_log_version_idx ON core.audit_log USING btree (version);

CREATE FUNCTION core.set_created_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.created_by = core.current_actor_id();
  NEW.team_id = NULLIF(core.current_team_id(), '')::uuid;
  NEW.context_id = NULLIF(core.current_context_id(), '')::uuid;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_set_created_fields BEFORE INSERT ON core.audit_log FOR EACH ROW EXECUTE FUNCTION core.set_created_fields();

CREATE FUNCTION core.audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO core.audit_log (
    "op",
    "table_name",
    "old",
    "new",
    "model_id"
  ) VALUES (
    TG_OP::core."NativeDatabaseOperation",
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE TO_JSONB(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE TO_JSONB(NEW) END,
    CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


-- ### Team ------------------------------------------------------

CREATE TABLE core.team (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    auto_add_company_to_portfolio_via_update boolean DEFAULT true NOT NULL,
    active_pipeline_configuration_id uuid,
    default_user_id uuid, -- @DEF: team_default_user_id_fkey
    domain text
    -- `agent_style_preferences` MOVED OUT to
    -- `knowledge.team_agent_settings.style_preferences` — how the agents talk
    -- belongs with the agents.
    --
    -- `ops_detail_level` (+ its enum) MOVED OUT to
    -- `automations.team_settings` — how loud the ops feed is for a team is an
    -- automations setting, not an identity fact.
    --
    -- The self-serve lifecycle/billing columns (lifecycle_state, iced_at,
    -- trial_started_at, billing_exempt, …) were moved out to a residual table
    -- and then DELETED with billing itself.
);

ALTER TABLE ONLY core.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (id);



CREATE UNIQUE INDEX team_active_pipeline_configuration_id_key ON core.team USING btree (active_pipeline_configuration_id);
CREATE UNIQUE INDEX team_default_user_id_key ON core.team USING btree (default_user_id);
CREATE UNIQUE INDEX team_domain_key ON core.team USING btree (domain);

CREATE TRIGGER team_audit AFTER INSERT OR DELETE OR UPDATE ON core.team FOR EACH ROW EXECUTE FUNCTION core.audit();



-- ### User ------------------------------------------------------

CREATE TABLE core."user" (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    -- A PREFERENCE, not an authorization source: which team the person lands in
    -- when nothing else names one. `team_membership` alone says where they may
    -- act (C-6/D20).
    default_team_id uuid NOT NULL, -- @DEF: user_default_team_id_fkey
    is_platform_admin boolean DEFAULT false NOT NULL,
    username public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    public_profile_id uuid,
    last_reminded_at timestamp(3) without time zone,
    completed_registration_at timestamp(3) without time zone,
    first_opened_connections_at timestamp(3) without time zone,
    granted_access_at timestamp(3) without time zone,
    sent_demo_deck_at timestamp(3) without time zone,
    recommendation_list_active boolean DEFAULT false NOT NULL,
    recommendation_list_dismissed boolean DEFAULT false NOT NULL,
    recommendation_list_dismissed_by_user_at timestamp(3) without time zone,
    is_internal boolean DEFAULT false NOT NULL,
    invitation_code text,
    -- Password auth: scrypt salted hash (social-only users have none). Terms
    -- acceptance is stamped at self-serve provision time (signup checkbox / login
    -- "By continuing" line).
    password_hash text,
    password_updated_at timestamptz,
    terms_accepted_at timestamptz,
    -- Human display name, collected at signup (social: from the OAuth profile;
    -- email+password: a required form field). Distinct from `username` (the
    -- email-local handle). NULL for accounts created before this was captured.
    name text
);

ALTER TABLE ONLY core."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

-- Pending email+password signup — NO account exists until the emailed token is
-- confirmed (email verification before account creation, so no unverified-email
-- accounts / squatting). Single-use hashed token, short expiry.
CREATE TABLE core.pending_signup (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    email public.citext NOT NULL,
    password_hash text NOT NULL,
    terms_accepted boolean DEFAULT true NOT NULL,
    token_hash text NOT NULL,
    source text,
    -- Signup attribution (utm_* + referrer) captured at form submit; carried to
    -- the signup_event at confirm. (plans/2026-07-02-password-auth companion)
    attribution jsonb,
    -- Human display name collected on the signup form; carried to user.name at
    -- confirm.
    name text,
    created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamptz NOT NULL
);

ALTER TABLE ONLY core.pending_signup
    ADD CONSTRAINT pending_signup_pkey PRIMARY KEY (id);

CREATE INDEX pending_signup_token_hash_idx ON core.pending_signup USING btree (token_hash);

-- @DEF: user_default_team_id_fkey
ALTER TABLE ONLY core."user"
    ADD CONSTRAINT user_default_team_id_fkey FOREIGN KEY (default_team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;

-- @DEF: team_default_user_id_fkey
ALTER TABLE ONLY core.team
    ADD CONSTRAINT team_default_user_id_fkey FOREIGN KEY (default_user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE UNIQUE INDEX user_invitation_code_key ON core."user" USING btree (invitation_code);

CREATE TRIGGER user_audit AFTER INSERT OR DELETE OR UPDATE ON core."user" FOR EACH ROW EXECUTE FUNCTION core.audit();

-- ### User Email ----------------------------------------------------

CREATE TABLE core.user_email (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL, -- @DEF: user_email_user_id_fkey
    email public.citext NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_service_email boolean DEFAULT false NOT NULL,
    accepts_plus_addressing boolean DEFAULT false NOT NULL,
    is_billing_contact boolean DEFAULT false NOT NULL,
    CONSTRAINT user_email_email_whitespace_check CHECK ((TRIM(BOTH FROM email) = (email)::text))
);

ALTER TABLE ONLY core.user_email
    ADD CONSTRAINT user_email_pkey PRIMARY KEY (id);

-- @DEF: user_email_user_id_fkey
ALTER TABLE ONLY core.user_email
    ADD CONSTRAINT user_email_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;


CREATE UNIQUE INDEX user_email_email_key ON core.user_email USING btree (email);
CREATE UNIQUE INDEX user_email_email_unique_primary_for_user ON core.user_email USING btree (user_id, is_primary) WHERE (is_primary = true);
CREATE INDEX user_email_user_id_idx ON core.user_email USING btree (user_id);

CREATE TRIGGER user_email_audit AFTER INSERT OR DELETE OR UPDATE ON core.user_email FOR EACH ROW EXECUTE FUNCTION core.audit();


-- ### Magic Link Token ------------------------------------------------------

CREATE TABLE core.magic_link_token (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    token text NOT NULL,
    user_id uuid NOT NULL, -- @DEF: magic_link_token_user_id_fkey
    expires_at timestamp(3) without time zone NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE ONLY core.magic_link_token
    ADD CONSTRAINT magic_link_token_pkey PRIMARY KEY (id);

-- @DEF: magic_link_token_user_id_fkey
ALTER TABLE ONLY core.magic_link_token
    ADD CONSTRAINT magic_link_token_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE UNIQUE INDEX magic_link_token_token_key ON core.magic_link_token USING btree (token);

CREATE TRIGGER magic_link_token_audit AFTER INSERT OR DELETE OR UPDATE ON core.magic_link_token FOR EACH ROW EXECUTE FUNCTION core.audit();


-------------------------------------------------------------------------------------------------------------------------
-- ## Permissions
-------------------------------------------------------------------------------------------------------------------------



-- ### Team Membership -----------------------------------------

-- Flat membership: the single source of "what teams a user can access" and at
-- what level. Replaces the legacy user_role -> role -> role_permission ->
-- permission RBAC chain. access = 'read' (READ) | 'write' (MANAGE).

CREATE TABLE core.team_membership (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL, -- @DEF: team_membership_user_id_fkey
    team_id uuid NOT NULL, -- @DEF: team_membership_team_id_fkey
    access text NOT NULL,
    is_personal boolean DEFAULT false NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_pkey PRIMARY KEY (id);

-- @DEF: team_membership_team_id_fkey
ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: team_membership_user_id_fkey
ALTER TABLE ONLY core.team_membership
    ADD CONSTRAINT team_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE UNIQUE INDEX team_membership_user_id_team_id_key ON core.team_membership USING btree (user_id, team_id);
CREATE INDEX team_membership_team_id_idx ON core.team_membership USING btree (team_id);

CREATE TRIGGER team_membership_audit AFTER INSERT OR DELETE OR UPDATE ON core.team_membership FOR EACH ROW EXECUTE FUNCTION core.audit();



-- API keys for authenticated ingest via external API.
-- Keys are stored as SHA-256 hashes - the plaintext is shown once on creation and cannot be recovered.

CREATE TABLE core.api_key (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid, -- @DEF: api_key_team_id_fkey
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    scopes text[] DEFAULT ARRAY['ingest']::text[] NOT NULL,
    last_used_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone,
    revoked_at timestamp(3) without time zone,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid NOT NULL, -- @DEF: api_key_created_by_fkey
    pipeline_input_id uuid
);

COMMENT ON TABLE core.api_key IS 'API keys for authenticated external API access. Keys are hashed and shown only once on creation.';
COMMENT ON COLUMN core.api_key.key_hash IS 'SHA-256 hash of the full API key';
COMMENT ON COLUMN core.api_key.key_prefix IS 'First 12 characters of the key for identification in UI (e.g., "lf_live_abc1")';
COMMENT ON COLUMN core.api_key.scopes IS 'Permissions granted to this key, e.g., ["ingest"], ["ingest", "ask"]';
COMMENT ON COLUMN core.api_key.pipeline_input_id IS 'Optional link to a specific pipeline input. When set, API requests using this key will be routed to this input instead of the default API input.';

ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_pkey PRIMARY KEY (id);

-- @DEF: api_key_team_id_fkey
ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE RESTRICT;
-- @DEF: api_key_created_by_fkey
ALTER TABLE ONLY core.api_key
    ADD CONSTRAINT api_key_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX api_key_team_id_idx ON core.api_key USING btree (team_id);
CREATE UNIQUE INDEX api_key_key_hash_idx ON core.api_key USING btree (key_hash);
CREATE INDEX api_key_pipeline_input_id_idx ON core.api_key USING btree (pipeline_input_id) WHERE pipeline_input_id IS NOT NULL;

CREATE TRIGGER api_key_audit AFTER INSERT OR DELETE OR UPDATE ON core.api_key FOR EACH ROW EXECUTE FUNCTION core.audit();


-- `oauth_client` (client-services "Login with Listen-Fire" OAuth) was deleted here:
-- the surface it backed is not exported and is retired on carve (D26); the MCP
-- OAuth server is a separate mechanism and keeps its own dynamic registration.


-- team_invite — a PENDING MEMBERSHIP, keyed by email. An admin writes an
-- address down; the next sign-in that verifies that address turns the row into
-- a `team_membership` and deletes it. So the table only ever holds people who
-- may join and haven't yet — there is no accepted/revoked state to read, no
-- token to hold (nothing is emailed) and no expiry (an invitation that goes
-- stale is one an admin withdraws).
CREATE TABLE core.team_invite (
    id uuid DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL, -- @DEF: team_invite_team_id_fkey
    email public.citext NOT NULL,
    invited_by uuid NOT NULL, -- @DEF: team_invite_invited_by_fkey
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_pkey PRIMARY KEY (id);

-- @DEF: team_invite_team_id_fkey
ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_team_id_fkey FOREIGN KEY (team_id) REFERENCES core.team(id) ON UPDATE CASCADE ON DELETE CASCADE;
-- @DEF: team_invite_invited_by_fkey
ALTER TABLE ONLY core.team_invite
    ADD CONSTRAINT team_invite_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES core."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

CREATE INDEX team_invite_team_id_idx ON core.team_invite USING btree (team_id);
-- One invite per (team, email); the claim path reads by email across teams.
CREATE UNIQUE INDEX team_invite_team_id_email_key ON core.team_invite USING btree (team_id, email);
CREATE INDEX team_invite_email_idx ON core.team_invite USING btree (email);

CREATE TRIGGER team_invite_audit AFTER INSERT OR DELETE OR UPDATE ON core.team_invite FOR EACH ROW EXECUTE FUNCTION core.audit();


-------------------------------------------------------------------------------------------------------------------------
-- ## Read-only role: schema USAGE
-------------------------------------------------------------------------------------------------------------------------
--
-- Table GRANTs travel with `ALTER TABLE ... SET SCHEMA`; schema-level USAGE
-- does not (2B's finding, drawn there for `agent`). `readonly` needs it on
-- every unit schema or `prismaReadonlyClient` fails with "permission denied
-- for schema <unit>" the moment an unauthenticated request reads a moved
-- table. Guarded because the role is cluster-global and created outside the
-- migration chain (see `# ROLES`).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly') THEN
    GRANT USAGE ON SCHEMA core        TO readonly;
    GRANT USAGE ON SCHEMA asks        TO readonly;
    GRANT USAGE ON SCHEMA automations TO readonly;
    GRANT USAGE ON SCHEMA knowledge   TO readonly;
    GRANT USAGE ON SCHEMA valuations  TO readonly;

    ALTER DEFAULT PRIVILEGES IN SCHEMA core        GRANT SELECT ON TABLES TO readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA asks        GRANT SELECT ON TABLES TO readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA automations GRANT SELECT ON TABLES TO readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA knowledge   GRANT SELECT ON TABLES TO readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA valuations  GRANT SELECT ON TABLES TO readonly;

    GRANT SELECT ON ALL TABLES IN SCHEMA core        TO readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA asks        TO readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA automations TO readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA knowledge   TO readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA valuations  TO readonly;
  END IF;
END
$$;
