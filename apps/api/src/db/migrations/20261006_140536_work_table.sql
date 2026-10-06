
SET search_path = automations, pg_catalog;

CREATE TABLE "work" (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid,
	kind text NOT NULL,
	"key" text NOT NULL,
	payload jsonb DEFAULT '{}'::jsonb NOT NULL,
	due_at timestamp with time zone DEFAULT now() NOT NULL,
	interval_ms integer,
	attempts integer DEFAULT 0 NOT NULL,
	lease_owner text,
	lease_until timestamp with time zone,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE "work"
	ADD CONSTRAINT work_pkey PRIMARY KEY (id);

ALTER TABLE "work"
	ADD CONSTRAINT work_key_key UNIQUE (key);

CREATE INDEX work_due_idx ON "work" USING btree (due_at);

CREATE INDEX work_team_idx ON "work" USING btree (team_id) WHERE (team_id IS NOT NULL);
