
SET search_path = automations, pg_catalog;

CREATE INDEX trigger_run_running_idx ON trigger_run USING btree (id) WHERE (status = 'running'::text);
