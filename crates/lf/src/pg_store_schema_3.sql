-- A run's write to a record of a source that can echo it back, remembered
-- for an hour per writing movement: the record as the write left it
-- (fingerprint). An inbound event naming the record, while it still stands
-- so, is only the write's echo and fires none of that movement's listens.
CREATE TABLE lf.write_echo (
    team_id uuid NOT NULL,
    adapter text NOT NULL,
    external_id text NOT NULL,
    writer text NOT NULL,
    record_type text NOT NULL,
    fingerprint text NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (team_id, adapter, external_id, writer)
);
CREATE INDEX write_echo_expires_at ON lf.write_echo (expires_at);
