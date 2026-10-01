-- V5: append-only history and the work queue.

-- The audit trail. Append-only: UPDATE, DELETE and TRUNCATE are rejected by triggers, and the
-- application role should not be granted them either. occurred_at is when it happened on the claim;
-- recorded_at is when we wrote it; seq gives a stable order for events at the same instant.
CREATE TABLE history_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    claim_id    uuid NOT NULL REFERENCES claims (id),
    occurred_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    type        text NOT NULL,
    title       text NOT NULL,
    actor_kind  text NOT NULL,
    actor       text NOT NULL,
    detail      text,
    ref         text,
    workflow_id text,
    CONSTRAINT history_type_ck CHECK (type IN ('decision', 'data', 'document', 'communication', 'task', 'access', 'assistant', 'payment')),
    CONSTRAINT history_actor_kind_ck CHECK (actor_kind IN ('user', 'system', 'workflow', 'batch', 'portal'))
);
CREATE INDEX history_claim_idx ON history_events (claim_id, occurred_at DESC, seq DESC);
CREATE TRIGGER history_events_append_only BEFORE UPDATE OR DELETE ON history_events
    FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER history_events_no_truncate BEFORE TRUNCATE ON history_events
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- A person's queue. owner_id is null for a team queue item nobody has picked up.
CREATE TABLE work_items (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id     uuid REFERENCES staff_users (id),
    claim_id     uuid NOT NULL REFERENCES claims (id),
    priority     smallint NOT NULL DEFAULT 2,
    action       text NOT NULL,
    why          text NOT NULL,
    due_on       date NOT NULL,
    waiting_on   text NOT NULL DEFAULT 'You',
    flag         text,
    section      text NOT NULL,
    status       text NOT NULL DEFAULT 'open',
    completed_at timestamptz,
    source_kind  text,
    source_id    uuid,
    dedupe_key   text NOT NULL,
    version      bigint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT work_items_dedupe_unique UNIQUE (dedupe_key),
    CONSTRAINT work_items_priority_ck CHECK (priority BETWEEN 1 AND 3),
    CONSTRAINT work_items_status_ck CHECK (status IN ('open', 'done', 'snoozed')),
    CONSTRAINT work_items_done_ck CHECK ((status = 'done') = (completed_at IS NOT NULL)),
    CONSTRAINT work_items_section_ck CHECK (section IN ('overview', 'workflow', 'policies', 'people', 'requirements', 'documents',
        'contestable', 'medical', 'financials', 'decision', 'payments', 'distributions', 'case-plan', 'communications', 'history')),
    CONSTRAINT work_items_source_ck CHECK (source_kind IS NULL OR source_kind IN ('deadline', 'requirement', 'workflow', 'decision'))
);
CREATE INDEX work_items_queue_idx ON work_items (owner_id, due_on) WHERE status = 'open';
CREATE INDEX work_items_claim_idx ON work_items (claim_id);
CREATE TRIGGER work_items_touch BEFORE UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION touch_row();
