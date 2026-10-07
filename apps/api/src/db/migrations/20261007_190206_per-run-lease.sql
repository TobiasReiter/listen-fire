
SET search_path = automations, pg_catalog;

ALTER TABLE parked_run
	DROP CONSTRAINT parked_run_status_check;

ALTER TABLE trigger_run
	ADD COLUMN lease_owner text,
	ADD COLUMN lease_until timestamp with time zone,
	ADD COLUMN lease_token uuid;

ALTER TABLE parked_run
	ADD CONSTRAINT parked_run_status_check CHECK ((status = ANY (ARRAY['parked'::text, 'resuming'::text, 'completed'::text])));
