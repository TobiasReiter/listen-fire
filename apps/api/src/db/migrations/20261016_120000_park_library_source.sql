SET search_path = automations, pg_catalog;

CREATE TABLE park_library_source (
	team_id uuid NOT NULL,
	hash text NOT NULL,
	source text NOT NULL,
	created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE park_library_source
	ADD CONSTRAINT park_library_source_pkey PRIMARY KEY (team_id, hash);
