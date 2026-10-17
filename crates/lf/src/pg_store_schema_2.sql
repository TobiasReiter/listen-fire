-- One row per event delivered to a listen with the event's idempotencyKey
-- (the provider's own id for the occurrence): a redelivery's insert does
-- nothing and its listen runs nothing, as the hosted product's
-- trigger_event is unique on its trigger and external event id.
CREATE TABLE lf.event_receipt (
    team_id uuid NOT NULL,
    listen text NOT NULL,
    key text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, listen, key)
);
