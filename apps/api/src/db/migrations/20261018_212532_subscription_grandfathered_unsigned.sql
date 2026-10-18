SET search_path = automations, pg_catalog;

-- Every subscription that exists now is grandfathered; the default flips right
-- after, so only rows inserted later are strict. Adding the column with a true
-- default marks existing rows without an UPDATE (which would write an audit row each).
ALTER TABLE webhook_subscription
	ADD COLUMN grandfathered_unsigned boolean DEFAULT true NOT NULL;

ALTER TABLE webhook_subscription
	ALTER COLUMN grandfathered_unsigned SET DEFAULT false;
