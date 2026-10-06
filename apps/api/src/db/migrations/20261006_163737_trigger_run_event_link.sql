
SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	ADD COLUMN trigger_event_id uuid;

ALTER TABLE trigger_run
	ADD CONSTRAINT trigger_run_trigger_event_id_fkey FOREIGN KEY (trigger_event_id) REFERENCES automations.trigger_event(id) ON DELETE SET NULL;

CREATE INDEX trigger_run_trigger_event_id_idx ON trigger_run USING btree (trigger_event_id);
