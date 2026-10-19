-- Files stored before team-prefixed keys get the ownership record the file
-- check reads.
--
-- Earlier releases stored a run's uploads (a Run-now upload, a manual
-- trigger's files) under `<uuid>/<name>` and wrote no document row. The byte
-- read now accepts only a key under `movement-files/<team>/` or a team's
-- `knowledge.document` row naming the object, so a run parked across the
-- upgrade could no longer read its own file. The check stays as strict as it
-- is: this writes the row it already accepts, for the one team that
-- references the object.
--
-- A reference is any JSON string that is exactly an old-format object URI,
-- `s3://<bucket>/<uuid>/<name>`, in a row that carries (or joins to) a team:
-- trigger events, run inputs and steps, parked branches and their join
-- exports, callbacks, queued work, asks, system events, legacy inbound
-- payloads, exposed files and existing document rows. An object referenced by
-- two different teams gets no owner (counted, never named); an object nothing
-- references stays unreadable. Idempotent: a team that already has the row is
-- skipped. Each table is read in block ranges so no statement holds more than
-- one range's references.

CREATE TEMP TABLE file_owner_reference (
    object_uri text NOT NULL,
    team_id uuid NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
    old_object_uri constant text := '^s3://[^/]+/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^/]+$';
    blocks_per_batch constant bigint := 1024;
    source record;
    total_blocks bigint;
    first_block bigint;
    owned bigint;
    ambiguous bigint;
BEGIN
    FOR source IN
        SELECT * FROM (VALUES
            ('automations.trigger_event', 'SELECT t.team_id, t.payload AS doc FROM automations.trigger_event t'),
            ('automations.trigger_run', 'SELECT t.team_id, jsonb_build_array(t.trigger_payload, t.steps) AS doc FROM automations.trigger_run t'),
            ('automations.parked_run', 'SELECT r.team_id, jsonb_build_array(t.state, t.result) AS doc FROM automations.parked_run t JOIN automations.trigger_run r ON r.id = t.run_id'),
            ('automations.join_branch_export', 'SELECT r.team_id, t.exports AS doc FROM automations.join_branch_export t JOIN automations.trigger_run r ON r.id = t.run_id'),
            ('automations.callback', 'SELECT t.team_id, jsonb_build_array(t.state, t.calls) AS doc FROM automations.callback t'),
            ('automations.work', 'SELECT t.team_id, t.payload AS doc FROM automations.work t'),
            ('automations.system_event', 'SELECT t.team_id, t.payload AS doc FROM automations.system_event t'),
            ('automations.exposed_file', 'SELECT t.team_id, to_jsonb(t.object_uri) AS doc FROM automations.exposed_file t'),
            ('asks.ask', 'SELECT t.team_id, jsonb_build_array(t.rows, t.answer, t.provenance) AS doc FROM asks.ask t'),
            ('public.inbound_payload', 'SELECT t.team_id, t.data AS doc FROM public.inbound_payload t'),
            ('knowledge.resource', 'SELECT t.team_id, t.metadata AS doc FROM knowledge.resource t'),
            ('knowledge.document', 'SELECT t.team_id, to_jsonb(t.object_uri) AS doc FROM knowledge.document t')
        ) AS s(relation, rows_sql)
    LOOP
        CONTINUE WHEN to_regclass(source.relation) IS NULL;
        total_blocks := pg_relation_size(source.relation::regclass) / current_setting('block_size')::bigint;
        first_block := 0;
        WHILE first_block <= total_blocks LOOP
            EXECUTE format(
                $sql$
                INSERT INTO file_owner_reference (object_uri, team_id)
                SELECT DISTINCT found.value #>> '{}', src.team_id
                FROM (%s WHERE t.ctid >= %L::tid AND t.ctid < %L::tid) src,
                     LATERAL jsonb_path_query(src.doc, 'strict $.**') AS found(value)
                WHERE src.team_id IS NOT NULL
                  AND src.doc::text LIKE '%%s3://%%'
                  AND jsonb_typeof(found.value) = 'string'
                  AND (found.value #>> '{}') ~ %L
                $sql$,
                source.rows_sql,
                format('(%s,0)', first_block),
                format('(%s,0)', first_block + blocks_per_batch),
                old_object_uri
            );
            first_block := first_block + blocks_per_batch;
        END LOOP;
    END LOOP;

    WITH referenced AS (
        SELECT object_uri, (array_agg(DISTINCT team_id))[1] AS team_id
        FROM file_owner_reference
        GROUP BY object_uri
        HAVING count(DISTINCT team_id) = 1
    ),
    inserted AS (
        INSERT INTO knowledge.document (team_id, description, object_uri)
        SELECT referenced.team_id, regexp_replace(referenced.object_uri, '^.*/', ''), referenced.object_uri
        FROM referenced
        WHERE NOT EXISTS (
            SELECT 1 FROM knowledge.document existing
            WHERE existing.object_uri = referenced.object_uri AND existing.team_id = referenced.team_id
        )
        RETURNING 1
    )
    SELECT count(*) INTO owned FROM inserted;

    SELECT count(*) INTO ambiguous FROM (
        SELECT object_uri FROM file_owner_reference GROUP BY object_uri HAVING count(DISTINCT team_id) > 1
    ) shared;

    RAISE NOTICE 'file ownership backfill: % stored file(s) given their team''s document row; % referenced by more than one team left without an owner',
        owned, ambiguous;
END
$$;
