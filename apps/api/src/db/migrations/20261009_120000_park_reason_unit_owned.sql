
SET search_path = automations, pg_catalog;

ALTER TABLE parked_run ALTER COLUMN park_reason DROP DEFAULT;

ALTER TABLE parked_run DROP CONSTRAINT parked_run_park_reason_check;

ALTER TABLE parked_run ADD CONSTRAINT parked_run_park_reason_check CHECK (park_reason <> ''::text);
