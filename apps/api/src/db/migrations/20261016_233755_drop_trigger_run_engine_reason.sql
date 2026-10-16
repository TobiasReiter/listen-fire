
SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	DROP COLUMN IF EXISTS engine_reason;
