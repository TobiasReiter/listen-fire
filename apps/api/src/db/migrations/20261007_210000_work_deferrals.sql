
SET search_path = automations, pg_catalog;

ALTER TABLE work
	ADD COLUMN deferrals integer DEFAULT 0 NOT NULL;
