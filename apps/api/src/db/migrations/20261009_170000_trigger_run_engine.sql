
SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	ADD COLUMN engine text,
	ADD COLUMN engine_reason text;
