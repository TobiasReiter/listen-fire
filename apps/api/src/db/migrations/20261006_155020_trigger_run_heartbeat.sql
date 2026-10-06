
SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	ADD COLUMN last_heartbeat_at timestamp with time zone;
