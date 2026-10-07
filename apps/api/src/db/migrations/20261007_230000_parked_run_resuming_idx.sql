
SET search_path = automations, pg_catalog;

CREATE INDEX parked_run_resuming_idx ON parked_run USING btree (run_id) WHERE (status = 'resuming'::text);
