
SET search_path = automations, pg_catalog;

ALTER TABLE "work"
	ADD COLUMN lease_token uuid;
