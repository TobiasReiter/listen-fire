SET search_path = automations, pg_catalog;

ALTER TABLE external_service_credentials
	ADD COLUMN declared_credential text;
